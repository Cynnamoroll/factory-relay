import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { clickAndCheckText } from './qa-procedure.js';
import { windowSessionCleanupErrors, windowSessionHeartbeat, windowSessionHeartbeatMs, windowSessionPath, windowSessionTaskPath,
  windowSessionRunTasks } from './qa-window-session-contract.js';

async function request(origin, token, route, input, method = input === undefined ? 'GET' : 'POST', options = {}) {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 90000);
  const response = await fetch(origin + route, {
    method, redirect: 'error', signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout,
    headers: { Authorization: `Bearer ${token}`, 'X-QA-Request': '1',
      ...(input !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(input !== undefined ? { body: JSON.stringify(input) } : {}),
  });
  if (!response.ok) {
    const data = await response.json();
    const error = new Error(data.error); error.failure = data.failure; throw error;
  }
  return response.headers.get('content-type') === 'image/jpeg'
    ? { image: Buffer.from(await response.arrayBuffer()), version: response.headers.get('x-qa-frame-version'),
      receivedAt: response.headers.get('x-qa-frame-received-at') } : response.json();
}

export class QAClient {
  constructor(file = fileURLToPath(new URL('../.qa-workspace/agent.json', import.meta.url))) {
    const s = fs.lstatSync(file);
    if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid() || s.mode & 0o077 || s.size > 1024)
      throw new Error('unsafe_credentials');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!/^http:\/\/127\.0\.0\.1:\d{4,5}$/.test(data.origin) || !/^[a-f0-9]{64}$/.test(data.token))
      throw new Error('invalid_credentials');
    this.origin = data.origin;
    this.token = data.token;
  }
  async request(route, input) {
    if (!/^\/api\/(?:status|session|runs|live|command|tasks\/qa_[a-z]+|runs\/[a-f0-9]{32}(?:\/frames\/[a-f0-9]{32})?)$/.test(route))
      throw new Error('invalid_route');
    return request(this.origin, this.token, route, input);
  }
  command(input) { return this.request('/api/command', input); }
  task(name, input = {}) { return this.request('/api/tasks/' + name, input); }
  async openWindowSession(input, { signal } = {}) {
    const origin = this.origin;
    const { token, ...started } = await request(origin, this.token, windowSessionPath, input, 'POST', { signal });
    return new QAWindowSession(origin, token, started);
  }
  openFixtureSession(input = {}, options) {
    return this.openWindowSession({ ...input, managedFixture: true }, options);
  }
}

class QAWindowSession {
  #origin;
  #token;
  #closed;
  #procedureActive = false;
  #heartbeatTimer;
  #heartbeatLife;
  static #schedule(reference) {
    return setTimeout(() => { reference.deref()?.#heartbeat(reference); }, windowSessionHeartbeatMs).unref();
  }

  constructor(origin, token, started) {
    this.#origin = origin;
    this.#token = token;
    this.started = Object.freeze({ ...started, target: Object.freeze(started.target) });
    this.runId = started.runId;
    this.target = this.started.target;
    this.expiresAt = started.expiresAt;
    if (started.managedFixture === true) {
      this.#heartbeatLife = new AbortController();
      this.#heartbeatTimer = QAWindowSession.#schedule(new WeakRef(this));
    }
    Object.freeze(this);
  }
  async #heartbeat(reference) {
    const { signal } = this.#heartbeatLife;
    if (signal.aborted || Date.now() >= this.expiresAt) return;
    try {
      const { active } = await request(this.#origin, this.#token, windowSessionTaskPath + windowSessionHeartbeat, {}, 'POST',
        { signal, timeoutMs: windowSessionHeartbeatMs });
      if (active && !signal.aborted) this.#heartbeatTimer = QAWindowSession.#schedule(reference);
    } catch { /* A lost credential or transport must stop extending ownership. */ }
  }
  #stopHeartbeat() {
    clearTimeout(this.#heartbeatTimer);
    this.#heartbeatLife?.abort();
  }
  #requireIdleProcedure() {
    if (this.#procedureActive) throw Object.assign(new Error('procedure_busy'), { failure: {
      code: 'procedure_busy', category: 'ownership', retrySafe: false, nextAction: 'Wait for the in-flight procedure and inspect its outcome before any input.',
    } });
  }
  async task(name, input = {}) {
    if (['qa_observe', 'qa_act', 'qa_check', 'qa_finish'].includes(name)) this.#requireIdleProcedure();
    return this.#task(name, input);
  }
  async #task(name, input) {
    if (!/^qa_[a-z]+$/.test(name)) throw new Error('invalid_route');
    if (windowSessionRunTasks.includes(name)) {
      if (input?.runId !== undefined && input.runId !== this.runId) throw new Error('run_mismatch');
      input = { ...input, runId: this.runId };
    }
    const compact = input?.compact === true && ['qa_finish', 'qa_report'].includes(name);
    if (compact) delete input.compact;
    try {
      const result = await request(this.#origin, this.#token, windowSessionTaskPath + name, input);
      if (name === 'qa_finish') this.#stopHeartbeat();
      if (compact) {
        const { runId, status, counts, reason, artifacts, sourceArtifact, sourceExport, exportError } = result;
        return { runId, status, counts, reason, replayUrl: `${this.#origin}/#run=${runId}`,
          export: result.export, artifacts, sourceExport, sourceArtifact, ...(exportError && { exportError }) };
      }
      return result;
    } catch (error) {
      if (name === 'qa_finish' && windowSessionCleanupErrors.includes(error.message))
        this.#stopHeartbeat();
      throw error;
    }
  }
  live() { return request(this.#origin, this.#token, windowSessionPath + '/current/live'); }
  observe(input) { return this.task('qa_observe', input); }
  act(input) { return this.task('qa_act', { ...input, completion: 'ack' }); }
  async clickAndCheckText(input) {
    this.#requireIdleProcedure();
    this.#procedureActive = true;
    try {
      return await clickAndCheckText({ runId: this.runId, target: this.target, task: this.#task.bind(this) },
        input, `${this.#origin}/#run=${this.runId}`);
    } finally { this.#procedureActive = false; }
  }
  actAndWait(input, waitFor) {
    if (waitFor === undefined) return Promise.reject(new Error('invalid_arguments'));
    return this.task('qa_act', { ...input, waitFor });
  }
  finish(input) { return this.task('qa_finish', input); }
  close() {
    this.#stopHeartbeat();
    return this.#closed ??= request(this.#origin, this.#token, windowSessionPath + '/current', undefined, 'DELETE');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const client = new QAClient();
    const route = process.argv[2] ?? '/api/status';
    if (route === '/api/live' || route.includes('/frames/')) throw new Error('use_client_api_for_pixels');
    const result = await client.request(route, process.argv[3] ? JSON.parse(process.argv[3]) : undefined);
    // Mutation grants are capabilities. Use the module or MCP for ownership, not terminal logs.
    if (result.grant) console.log(JSON.stringify({ ...result, grant: '[private: use module client]' }));
    else console.log(JSON.stringify(result));
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}

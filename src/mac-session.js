import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { configSchema } from './schema.js';
import { transportCommand } from './transport.js';

export const SESSION_PROTOCOL = 2;
const LINE_LIMIT = 1024 * 1024;
const TRANSPORT_SLACK_MS = 2000;

export const daemonSource = (await Promise.all(['remote.py', 'stream-supervisor.py', 'control-supervisor.py'].map(async name => {
  const source = await readFile(new URL('./' + name, import.meta.url), 'utf8');
  return name === 'control-supervisor.py' ? source : source.replace(/if __name__ == "__main__":\n    \w+\(\)\s*$/, '');
}))).join('\n');

const failure = code => Object.assign(new Error(code), { code });

/**
 * One persistent remote daemon per broker or script. Warm requests reuse the same SSH session and
 * the already running permission-owning app, so no request pays SSH or LaunchServices startup.
 * Mutations are never retried: a lost or late reply surfaces as action_uncertain.
 */
export class MacSession {
  constructor(config, { command, env, maxPending = 32, startupMs = 45000 } = {}) {
    this.env = env;
    this.config = configSchema.parse(config);
    this.command = command ?? transportCommand(this.config, daemonSource);
    this.maxPending = maxPending;
    this.startupMs = startupMs;
    this.pending = new Map();
    this.nextId = 1;
    this.child = null;
    this.warm = false;
    this.closed = false;
    this.starts = 0;
  }

  start() {
    if (this.closed) return Promise.reject(failure('control_closed'));
    if (this.ready) return this.ready;
    const [executable, args] = this.command;
    const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], detached: true, ...(this.env ? { env: this.env } : {}) });
    this.child = child;
    this.starts++;
    this.warm = false;
    let buffer = '', stderrBytes = 0;
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const onExit = () => kill();
    process.once('exit', onExit);
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(failure('transport_unavailable')); kill(); }, this.startupMs);
      child.once('error', () => { clearTimeout(timer); reject(failure('transport_unavailable')); });
      child.once('close', () => { clearTimeout(timer); reject(failure('transport_unavailable')); });
      child.stdout.on('data', chunk => {
        buffer += chunk.toString('utf8');
        if (buffer.length > LINE_LIMIT && !buffer.includes('\n')) { kill(); return; }
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          let message;
          try { message = JSON.parse(line); } catch { continue; }
          if (message?.type === 'ready' && message.protocol === SESSION_PROTOCOL) { clearTimeout(timer); resolve(); }
          else if (message?.type === 'error') { clearTimeout(timer); reject(failure('transport_unavailable')); kill(); }
          else this.settle(message);
        }
      });
    });
    this.ready.catch(() => {});
    child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > 65536) kill(); });
    child.stdin.on('error', () => {});
    child.once('close', () => {
      process.removeListener('exit', onExit);
      if (this.child === child) { this.child = null; this.ready = null; }
      for (const [id, entry] of this.pending) if (entry.child === child) this.fail(id, entry.sent && entry.mutation ? 'action_uncertain' : 'control_closed');
      kill();
    });
    child.stdin.write(JSON.stringify({ type: 'hello', protocol: SESSION_PROTOCOL, workspace: this.config.workspace }) + '\n');
    this.reference();
    return this.ready;
  }

  settle(message) {
    if (!message || !Number.isSafeInteger(message.id)) return;
    const entry = this.pending.get(message.id);
    if (!entry) return; // Late replies after a local deadline stay ignored; the caller already saw uncertainty.
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    entry.cleanup();
    this.reference();
    if (message.ok === true && message.result && typeof message.result === 'object') {
      this.warm = true;
      entry.resolve(message.result);
    } else if (message.ok === false && typeof message.error === 'string' && /^[a-z_]{1,64}$/.test(message.error)) {
      if (!['host_unavailable', 'control_closed'].includes(message.error)) this.warm = true;
      entry.reject(failure(message.error));
    } else entry.reject(failure(entry.mutation ? 'action_uncertain' : 'invalid_control_response'));
  }

  fail(id, code) {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.cleanup();
    this.reference();
    entry.reject(failure(code));
  }

  // Idle sessions must not keep a CLI process alive; in-flight requests must.
  reference() {
    const child = this.child;
    if (!child) return;
    const method = this.pending.size ? 'ref' : 'unref';
    child[method]();
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.[method]?.();
  }

  request(request, { deadlineMs, mutation = false, signal } = {}) {
    if (this.closed) return Promise.reject(failure('control_closed'));
    if (this.pending.size >= this.maxPending) return Promise.reject(failure('busy'));
    if (signal?.aborted) return Promise.reject(failure('control_cancelled'));
    const id = this.nextId++;
    const budget = deadlineMs + (this.warm ? 0 : 12000);
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, mutation, sent: false, child: null, timer: null, cleanup: () => {} };
      this.pending.set(id, entry);
      const abort = () => this.fail(id, entry.sent && mutation ? 'action_uncertain' : 'control_cancelled');
      signal?.addEventListener('abort', abort, { once: true });
      entry.cleanup = () => signal?.removeEventListener('abort', abort);
      this.start().then(() => {
        if (!this.pending.has(id)) return;
        entry.child = this.child;
        entry.sent = true;
        entry.timer = setTimeout(() => this.fail(id, mutation ? 'action_uncertain' : 'control_timeout'), budget + TRANSPORT_SLACK_MS);
        this.child.stdin.write(JSON.stringify({ id, request, deadlineMs: Math.min(30000, budget) }) + '\n');
      }, error => this.fail(id, error.code ?? 'transport_unavailable'));
      this.reference();
    });
  }

  close() {
    this.closed = true;
    for (const [id, entry] of this.pending) this.fail(id, entry.sent && entry.mutation ? 'action_uncertain' : 'control_closed');
    const child = this.child;
    if (!child) return Promise.resolve();
    return new Promise(resolve => {
      const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 2000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
      child.stdin.end();
    });
  }
}

const sessions = new Map();
export function sessionFor(config) {
  config = configSchema.parse(config);
  const key = JSON.stringify([config.transport, config.computer ?? config.host, config.user ?? null, config.port ?? null, config.workspace]);
  let session = sessions.get(key);
  if (!session || session.closed) sessions.set(key, session = new MacSession(config));
  return session;
}
export async function closeSessions() {
  const all = [...sessions.values()];
  sessions.clear();
  await Promise.all(all.map(session => session.close()));
}

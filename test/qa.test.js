import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { RunStore, POLICY, opaque } from '../src/qa-store.js';
import { Broker } from '../src/qa-broker.js';
import { createQAServer } from '../src/qa-server.js';

const target = { windowId: 7, pid: 12, bundleId: 'com.factory.applets.RelayMac' };
const image = Buffer.from([255, 216, 255, 217]);
function fake() {
  let generation = 0, count = 0, callback, active = 0, sequence = 0, stop, valid;
  const calls = [];
  const emit = () => callback?.({ image, header: { type: 'frame', sequence: ++sequence,
    captureTimeSeconds: Date.now() / 1000, ...target } });
  const verify = lease => { if (lease.generation !== generation) throw new Error('stale_lease'); };
  return {
    calls, emit, get active() { return active; },
    disconnect: () => stop?.(),
    externalTakeover: () => { generation++; },
    acquire: async takeover => { calls.push(['acquire', takeover]); return { token: 'a'.repeat(64), generation: ++generation }; },
    release: async lease => { verify(lease); calls.push(['release']); generation++; },
    windows: async () => [target],
    stream: async (lease, selected, signal, consume) => {
      verify(lease); active++; calls.push(['stream']); callback = consume;
      emit();
      await new Promise(resolve => { stop = resolve; signal.addEventListener('abort', resolve, { once: true }); });
      active--; callback = null;
    },
    observe: async lease => {
      verify(lease); calls.push(['observe']); valid = opaque();
      return { observationId: valid, expiresAt: Date.now() / 1000 + 30,
        snapshot: { target, elements: [{ id: 'relay-count', value: `Count: ${count}` }] } };
    },
    press: async (lease, selected, id) => {
      verify(lease);
      if (id !== valid) throw new Error('observation_stale');
      valid = null; count++; calls.push(['press']); emit();
    },
  };
}
function fixture(t, policy) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'applets-qa-test-'));
  const store = new RunStore(root, policy), native = fake(), broker = new Broker(store, native, { frameWaitMs: 25 });
  t.after(async () => { await broker.close(); fs.rmSync(root, { recursive: true }); });
  return { root, store, native, broker };
}
async function start(broker, actor = 'agent') {
  await broker.command(actor, { op: 'connect' });
  await broker.command(actor, { op: 'select', target });
  const { grant } = await broker.command(actor, { op: 'take', takeover: false });
  await new Promise(resolve => setImmediate(resolve));
  const { runId } = await broker.command(actor, { op: 'start', grant, labels: { context: 'test caller label' } });
  return { grant, runId };
}
test('shared run records real adapter observations, pass and deliberate fail, fenced takeover and read-only replay', async t => {
  const { store, native, broker } = fixture(t);
  const { grant, runId } = await start(broker);
  assert.equal(native.active, 1, 'Only one capture stream feeds the shared broker');
  const before = await broker.command('agent', { op: 'observe', grant });
  assert.equal(before.actual, 0);
  const after = await broker.command('agent', { op: 'press', grant, observationId: before.observationId });
  assert.equal(after.actual, 1);
  const pass = await broker.command('agent', { op: 'assert-count', grant, expected: 1 });
  assert.equal(pass.status, 'pass');
  const fail = await broker.command('agent', { op: 'assert-count', grant, expected: 99 });
  assert.equal(fail.status, 'fail');
  assert.equal(fail.actual, 1);
  const observation = store.get(runId).events.find(e => e.seq === fail.observationSeq);
  assert.equal(observation.observationId, fail.observationId);
  assert.equal(observation.stepId, fail.stepId);
  assert.ok(observation.beforeFrameId && observation.afterFrameId);
  const human = await broker.command('human', { op: 'take', takeover: true });
  await assert.rejects(broker.command('agent', { op: 'press', grant, observationId: after.observationId }), /stale_control/);
  await assert.rejects(broker.command('agent', { op: 'take', takeover: true }), /human_takeover_required/);
  const fresh = await broker.command('human', { op: 'observe', grant: human.grant });
  await broker.command('human', { op: 'press', grant: human.grant, observationId: fresh.observationId });
  await assert.rejects(broker.command('human', { op: 'press', grant: human.grant, observationId: fresh.observationId }), /observation_stale/);
  const terminal = await broker.command('human', { op: 'stop', grant: human.grant });
  assert.equal(terminal.status, 'fail', 'A deliberate mismatch cannot be reported as a successful run');
  const calls = native.calls.length;
  const events = store.get(runId).events;
  assert.deepEqual(events.map(e => e.seq), events.map((_, i) => i + 1));
  assert.deepEqual(store.image(runId, events.find(e => e.kind === 'frame').frameId), image);
  assert.equal(native.calls.length, calls, 'Replay does not invoke the native adapter');
  assert.ok(!JSON.stringify(events).includes(grant));
  assert.ok(!JSON.stringify(events).includes('a'.repeat(64)));
});
test('successful assertions produce pass; no assertion is uncertain', async t => {
  const { broker } = fixture(t);
  const { grant } = await start(broker);
  const before = await broker.command('agent', { op: 'observe', grant });
  await broker.command('agent', { op: 'press', grant, observationId: before.observationId });
  await broker.command('agent', { op: 'assert-count', grant, expected: 1 });
  assert.equal((await broker.command('agent', { op: 'stop', grant })).status, 'pass');
  await broker.command('agent', { op: 'start', grant });
  assert.equal((await broker.command('agent', { op: 'stop', grant })).status, 'uncertain');
  await broker.command('agent', { op: 'start', grant });
  await broker.command('agent', { op: 'assert-count', grant, expected: 1 });
  const observed = await broker.command('agent', { op: 'observe', grant });
  await broker.command('agent', { op: 'press', grant, observationId: observed.observationId });
  assert.equal((await broker.command('agent', { op: 'stop', grant })).status, 'uncertain',
    'An assertion before the last input cannot prove that input succeeded');
});
test('agent cannot use stale broker lease to take over an external owner', async t => {
  const { broker, native } = fixture(t);
  await broker.command('agent', { op: 'connect' });
  native.externalTakeover();
  await assert.rejects(broker.command('agent', { op: 'take' }), /stale_lease/);
  assert.equal(native.calls.filter(c => c[0] === 'acquire').length, 1);
});
test('human can explicitly take control before discovery and then start without re-taking on reload', async t => {
  const { broker } = fixture(t);
  await broker.task('human', 'qa_control', { mode: 'take' });
  const started = await broker.task('human', 'qa_start', { title: 'Human-owned run' });
  assert.deepEqual(started.target, target);
  const resumed = await broker.task('human', 'qa_start', { resumeRunId: started.runId });
  assert.equal(resumed.resumed, true);
  const observed = await broker.task('human', 'qa_observe', { runId: started.runId });
  assert.equal(observed.canAct, true);
  await assert.rejects(broker.task('agent', 'qa_start', { resumeRunId: started.runId }), /stale_control/);
});
test('recording fills during admitted input without losing the action result or masking it with run_closed', async t => {
  const { broker, native, store } = fixture(t, { ...POLICY, maxFrames: 2, sampleMs: 0 });
  const { grant, runId } = await start(broker);
  const observed = await broker.command('agent', { op: 'observe', grant });
  const original = native.press;
  native.press = async (...args) => { await original(...args); native.emit(); };
  const result = await broker.command('agent', { op: 'press', grant, observationId: observed.observationId });
  assert.equal(result.actual, 1);
  assert.equal(result.status, 'blocked');
  const events = store.get(runId).events;
  assert.ok(events.some(e => e.kind === 'action-attempt'));
  assert.ok(events.some(e => e.kind === 'action' && e.reason === 'input_acknowledged_requires_assertion'));
  assert.ok(events.some(e => e.kind === 'recording-limit'));
  assert.ok(events.some(e => e.kind === 'observation' && e.actual === 1));
  assert.equal(events.at(-1).reason, 'recording_full');
  assert.equal(native.calls.filter(c => c[0] === 'press').length, 1);
});
test('disconnect closes active run interrupted; frame bound closes it blocked without stopping live viewing', async t => {
  const a = fixture(t, { ...POLICY, maxFrames: 2, sampleMs: 0 });
  const { runId } = await start(a.broker);
  a.native.emit(); a.native.emit();
  assert.equal(a.store.get(runId).events.at(-1).reason, 'recording_full');
  assert.equal(a.store.history()[0].status, 'blocked');
  assert.equal(a.broker.status().connection, 'live');
  const b = fixture(t);
  const second = await start(b.broker);
  b.native.disconnect();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(b.store.get(second.runId).events.at(-1).status, 'interrupted');
  assert.equal(b.broker.latest, null);
});
test('journal survives restart and truncated tail; completed runs remain unchanged; second writer is rejected', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'applets-qa-recovery-'));
  let store;
  try {
    store = new RunStore(root);
    assert.throws(() => new RunStore(root), /qa_workspace_in_use/);
    const completed = store.start(target, {}, 'human');
    store.finish(completed, 'pass', 'test');
    const saved = fs.readFileSync(completed.file);
    const interrupted = store.start(target, {}, 'agent');
    store.append(interrupted, { kind: 'step-start', actor: 'agent' });
    store.close();
    fs.appendFileSync(interrupted.file, '{"partial":');
    store = new RunStore(root);
    assert.deepEqual(fs.readFileSync(completed.file), saved);
    assert.equal(store.get(interrupted.id).events.at(-1).status, 'interrupted');
    assert.equal(store.get(interrupted.id).events.at(-1).seq, 3);
    assert.ok(!fs.readFileSync(interrupted.file, 'utf8').includes('partial'));
  } finally { store?.close(); fs.rmSync(root, { recursive: true }); }
});
test('event/run bounds and opaque artifact paths fail closed', t => {
  const { store } = fixture(t, { ...POLICY, maxEvents: 3, maxRuns: 1 });
  const run = store.start(target, {}, 'human');
  store.append(run, { kind: 'step-start' });
  assert.throws(() => store.append(run, { kind: 'step-end' }), /recording_full/);
  assert.equal(run.events.length, 3);
  assert.equal(run.events.at(-1).status, 'blocked');
  assert.throws(() => store.start(target, {}, 'human'), /recording_full/);
  assert.throws(() => store.get('../config.local.json'), /run_not_found/);
  assert.throws(() => store.image(run.id, '../events.jsonl'), /frame_not_found/);
});
test('empty run creation recovers, storage byte limits are explicit, and recording IO errors fence input', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'applets-qa-empty-'));
  const emptyId = opaque();
  fs.mkdirSync(path.join(root, emptyId), { mode: 0o700 });
  const recovered = new RunStore(root);
  assert.equal(recovered.get(emptyId).events.at(-1).status, 'interrupted');
  recovered.close();
  fs.rmSync(root, { recursive: true });
  const bounded = fixture(t, { ...POLICY, maxTotalBytes: 20000 });
  const run = bounded.store.start(target, {}, 'agent');
  assert.throws(() => bounded.store.frame(run, { image: Buffer.alloc(8000), header: {} }, true), /recording_full/);
  assert.equal(run.events.at(-1).status, 'blocked');
  const { store, broker, native } = fixture(t);
  const { grant, runId } = await start(broker);
  const observation = await broker.command('agent', { op: 'observe', grant });
  const journal = store.get(runId).file;
  fs.renameSync(journal, journal + '.saved');
  fs.mkdirSync(journal, { mode: 0o700 });
  await assert.rejects(broker.command('agent', { op: 'press', grant, observationId: observation.observationId }), /recording_error/);
  assert.equal(native.calls.filter(c => c[0] === 'press').length, 0);
  assert.equal(broker.status().error, 'recording_error');
  assert.equal(store.history()[0].status, 'blocked');
  fs.rmdirSync(journal);
  fs.renameSync(journal + '.saved', journal);
});
test('pending commands are bounded and ownership changes wait behind in-flight native input', async t => {
  const { broker, native } = fixture(t);
  const { grant } = await start(broker);
  const observed = await broker.command('agent', { op: 'observe', grant });
  let unblock;
  const original = native.press;
  native.press = async (...args) => {
    await new Promise(resolve => { unblock = resolve; });
    return original(...args);
  };
  const press = broker.command('agent', { op: 'press', grant, observationId: observed.observationId });
  await new Promise(resolve => setImmediate(resolve));
  const takeover = broker.command('human', { op: 'take', takeover: true });
  const waiting = Array.from({ length: 14 }, () => broker.command('agent', { op: 'observe', grant }).catch(e => e.message));
  await assert.rejects(broker.command('agent', { op: 'observe', grant }), /broker_busy/);
  assert.equal(broker.status().owner, 'agent', 'Takeover must not race the in-flight press');
  unblock();
  await press;
  await takeover;
  assert.deepEqual(await Promise.all(waiting), Array(14).fill('stale_control'));
  assert.equal(broker.status().owner, 'human');
});
test('HTTP capabilities, Host/Origin/CSRF, one-time pairing, bounded requests and offline replay', async t => {
  const { broker, native } = fixture(t);
  const service = createQAServer(broker);
  const origin = await service.listen(0);
  t.after(() => service.close());
  const auth = { Authorization: `Bearer ${service.agentToken}`, 'X-QA-Request': '1' };
  const get = (route, headers = {}) => fetch(origin + route, { headers });
  assert.equal((await get('/api/status')).status, 403);
  assert.equal((await get('/api/status', { 'X-QA-Request': '1' })).status, 401);
  assert.equal((await get('/api/status', { ...auth, Origin: 'https://evil.example' })).status, 403);
  const wrongHost = await new Promise((resolve, reject) => {
    const request = http.get(origin + '/api/status', { headers: { ...auth, Host: 'evil.example' } },
      response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  });
  assert.equal(wrongHost, 403);
  assert.equal((await get('/api/status', auth)).status, 200);
  assert.equal((await get('/api/runs/%2e%2e%2fconfig.local.json', auth)).status, 404);
  const pair = () => fetch(origin + '/session', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-QA-Request': '1', Origin: origin },
    body: JSON.stringify({ code: service.pairingCode }) });
  const paired = await pair(), cookie = paired.headers.get('set-cookie').split(';')[0];
  assert.equal(paired.status, 200);
  assert.ok(paired.headers.get('set-cookie').includes('HttpOnly'));
  const { csrf } = await paired.json();
  assert.equal((await pair()).status, 401);
  const command = (input, extra = {}) => fetch(origin + '/api/command', { method: 'POST',
    headers: { Cookie: cookie, 'X-QA-Request': '1', 'Content-Type': 'application/json', Origin: origin, ...extra },
    body: JSON.stringify(input) });
  assert.equal((await command({ op: 'connect' })).status, 403);
  assert.equal((await command({ op: 'connect' }, { 'X-QA-CSRF': csrf })).status, 200);
  assert.equal((await command({ op: 'connect', padding: 'x'.repeat(9000) }, { 'X-QA-CSRF': csrf })).status, 400);
  const { runId, grant } = await start(broker);
  await broker.command('agent', { op: 'assert-count', grant, expected: 77 });
  await broker.command('agent', { op: 'stop', grant });
  native.disconnect();
  await new Promise(resolve => setImmediate(resolve));
  const count = native.calls.length;
  const replay = await (await get('/api/runs/' + runId, auth)).json();
  assert.equal(replay.find(e => e.kind === 'assertion').status, 'fail');
  const frame = replay.find(e => e.kind === 'frame').frameId;
  assert.equal((await get(`/api/runs/${runId}/frames/${frame}`, auth)).status, 200);
  assert.equal(native.calls.length, count);
});
test('a stalled HTTP frame viewer never waits in the capture consumer', async t => {
  const { broker, native } = fixture(t);
  await start(broker);
  const service = createQAServer(broker);
  const origin = await service.listen(0);
  t.after(() => service.close());
  const req = http.get(origin + '/api/live', { headers: {
    Authorization: `Bearer ${service.agentToken}`, 'X-QA-Request': '1',
  } });
  t.after(() => req.destroy());
  await new Promise((resolve, reject) => {
    req.on('error', reject);
    req.on('response', response => { response.pause(); resolve(); });
  });
  const version = broker.latest.version;
  for (let i = 0; i < 50; i++) native.emit();
  assert.equal(broker.latest.version, version + 50);
  assert.equal(native.active, 1);
});
test('official MCP client joins the same broker, hides grants, returns shared pixels and replays failure', async t => {
  const { broker, native } = fixture(t);
  const service = createQAServer(broker);
  const origin = await service.listen(0);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'applets-qa-mcp-'));
  const credentials = path.join(directory, 'agent.json');
  fs.writeFileSync(credentials, JSON.stringify({ origin, token: service.agentToken }), { mode: 0o600 });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../src/qa-mcp.js', import.meta.url)), credentials], stderr: 'pipe' });
  let client = new Client({ name: 'shared-qa-test', version: '1.0.0' });
  t.after(async () => { await client.close(); await service.close(); fs.rmSync(directory, { recursive: true }); });
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map(t => t.name).sort(),
    ['qa_act', 'qa_check', 'qa_finish', 'qa_observe', 'qa_replay', 'qa_report', 'qa_runs', 'qa_start', 'qa_status']);
  for (const tool of tools) assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual(tools.find(t => t.name === 'qa_act').inputSchema.properties.action.const, 'increment');
  const call = async (name, args = {}) => {
    const reply = await client.callTool({ name, arguments: args });
    assert.ok(!reply.isError, JSON.stringify(reply));
    assert.ok(!JSON.stringify(reply).includes(service.agentToken));
    assert.deepEqual(reply.structuredContent, JSON.parse(reply.content[0].text));
    return JSON.parse(reply.content[0].text);
  };
  const taken = await call('qa_start', { title: 'Named sample checks' });
  assert.equal(taken.controller, 'agent');
  assert.equal(taken.grant, undefined, 'MCP responses must not disclose mutation credentials');
  const { runId } = taken;
  await client.close();
  client = new Client({ name: 'reconnected-agent', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../src/qa-mcp.js', import.meta.url)), credentials], stderr: 'pipe' }));
  assert.equal((await call('qa_start', { resumeRunId: runId })).resumed, true);
  const observed = await call('qa_observe', { runId });
  const acted = await call('qa_act', { runId, action: 'increment', observationId: observed.observationId });
  assert.equal(acted.frameEvidence.status, 'missing', 'An old image must not be called post-action footage');
  await call('qa_check', { runId, title: 'Increment updates count', expected: 1 });
  const failed = await call('qa_check', { runId, title: 'Intentional mismatch for replay', context: 'Deliberate test assertion, not a product defect', expected: 500 });
  assert.equal(failed.status, 'fail');
  const frame = await client.callTool({ name: 'qa_observe', arguments: { runId, includeImage: true } });
  assert.equal(frame.content[1].data, image.toString('base64'));
  assert.equal(native.active, 1);
  const calls = native.calls.length;
  const replay = await call('qa_replay', { runId, filter: 'failures', limit: 1, stepId: failed.stepId });
  assert.equal(replay.items[0].title, 'Intentional mismatch for replay');
  assert.equal(replay.selected.stepId, failed.stepId);
  assert.equal(native.calls.length, calls);
  await broker.command('human', { op: 'take', takeover: true });
  const viewer = await call('qa_observe', { runId });
  assert.equal(viewer.observerOnly, true);
  const stale = await client.callTool({ name: 'qa_act', arguments: { runId, action: 'increment', observationId: observed.observationId } });
  assert.equal(stale.isError, true);
  assert.equal(stale.structuredContent.error.code, 'stale_control');
  assert.equal(stale.structuredContent.error.retrySafe, false);
  const cannotResume = await client.callTool({ name: 'qa_start', arguments: { resumeRunId: runId } });
  assert.equal(cannotResume.isError, true);
  const finished = await broker.task('human', 'qa_finish', { runId });
  assert.equal(finished.status, 'fail');
  assert.match(finished.reportMarkdown, /Intentional mismatch for replay/);
  assert.equal(broker.owner, null);
});

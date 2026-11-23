import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MacSession, daemonSource } from '../src/mac-session.js';
import { control } from '../src/control.js';
import { Broker } from '../src/qa-broker.js';
import { RunStore } from '../src/qa-store.js';
import { QAClient } from '../src/qa-client.js';
import { createQAServer } from '../src/qa-server.js';
import { benchClick, benchConcurrent } from '../scripts/bench-mac.js';

const fakeOpen = fileURLToPath(new URL('./fixtures/fake-open.py', import.meta.url));
const relay = { windowId: 5, pid: 12, bundleId: 'com.factory.applets.RelayMac' };
const other = { windowId: 6, pid: 13, bundleId: 'com.example.App' };
const slow = { windowId: 7, pid: 99, bundleId: 'com.example.Slow' };
const lost = { windowId: 8, pid: 98, bundleId: 'com.example.Lost' };
const desktop = { kind: 'desktop', displayId: 1, displayUUID: 'abcdef12-1234-4234-8234-123456789012' };
const token = c => c.repeat(64);
const proof = (c, generation) => ({ token: token(c), generation });

function environment(t, leases, extra = {}) {
  const home = fs.mkdtempSync('/tmp/frs-');
  const root = path.join(home, '.applets-control');
  fs.mkdirSync(root, { mode: 0o700 });
  const write = list => fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify({ version: 2,
    generation: Math.max(0, ...list.map(l => l.generation)), leases: list }), { mode: 0o600 });
  write(leases);
  const env = { ...process.env, HOME: home, FAKE_HOST_LOG: path.join(home, 'host.log'), ...extra };
  const source = daemonSource.replaceAll('"/usr/bin/open"', JSON.stringify(fakeOpen));
  const sessions = [];
  const open = (options = {}) => {
    const session = new MacSession({ transport: 'factory', computer: 'test-mac', workspace: home, owner: 'agent:a' },
      { command: ['python3', ['-c', source]], env, ...options });
    sessions.push(session);
    return session;
  };
  const log = () => fs.existsSync(env.FAKE_HOST_LOG)
    ? fs.readFileSync(env.FAKE_HOST_LOG, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  t.after(async () => {
    await Promise.all(sessions.map(s => s.close()));
    for (const row of log()) if (row.event === 'launch') { try { process.kill(row.pid, 'SIGKILL'); } catch {} }
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { home, root, open, log, write, config: owner => ({ transport: 'factory', computer: 'test-mac', workspace: home, owner }) };
}
const lease = (owner, c, generation, scope) => ({ owner, token: token(c), generation, expiresAt: Date.now() / 1000 + 600, scope });
const windowLease = (owner, c, generation, target) => lease(owner, c, generation, { kind: 'window', target });

test('public API ack never observes; one device request presses once and checks the effect, including timeout', async t => {
  const env = environment(t, [windowLease('agent:a', 'a', 1, relay)], { FAKE_HOST_DELAY: '0.01' });
  const session = env.open(), lease = proof('a', 1), config = env.config('agent:a');
  const operations = [];
  const invoke = (operation, args) => {
    operations.push(operation);
    return control(config, { operation, ...args }, { session });
  };
  const root = fs.mkdtempSync('/tmp/fr-api-');
  const broker = new Broker(new RunStore(path.join(root, 'runs')), {
    windows: async () => [relay], acquire: async () => lease, release: async () => {},
    stream: async (_, target, signal, push) => {
      push({ header: { type: 'frame', ...target }, image: Buffer.from([255,216,255,217]) });
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    },
    observe: (lease, target) => invoke('observe', { lease, target }),
    press: (lease, target, observationId, waitFor) => invoke('press', { lease, target, observationId,
      elementId: 'relay-increment', ...(waitFor ? { waitFor } : {}) }),
  });
  const server = createQAServer(broker), origin = await server.listen(0);
  t.after(async () => { await server.close(); await broker.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const credentials = path.join(root, 'agent.json');
  fs.writeFileSync(credentials, JSON.stringify({ origin, token: server.agentToken }), { mode: 0o600 });
  const client = new QAClient(credentials);
  const { runId } = await client.task('qa_start', { applicationId: 'relaymac' });
  const observe = () => client.task('qa_observe', { runId });
  const act = (id, extra) => client.task('qa_act', { runId, action: 'increment', observationId: id, ...extra });
  const before = await observe(), reads = env.log().filter(r => r.event === 'observe').length;
  const ack = await act(before.observationId, { completion: 'ack' });
  assert.equal(ack.acknowledged, true); assert.equal(ack.assertion, false);
  assert.equal(ack.observationId, undefined); assert.equal(ack.retrySafe, false);
  assert.equal(env.log().filter(r => r.event === 'observe').length, reads);
  await assert.rejects(act(before.observationId, { completion: 'ack' }), /observation_stale/);
  for (const [equals, expectedStatus] of [[2, 'pass'], [99, 'fail']]) {
    const observed = await observe(), waitFor = { kind: 'count', equals, timeoutMs: 120 };
    await assert.rejects(act(observed.observationId, { completion: 'ack', waitFor }), /invalid_arguments/);
    const start = operations.length;
    const result = await act(observed.observationId, { waitFor });
    assert.deepEqual(operations.slice(start), ['press'], 'No additional network request for confirmation');
    assert.equal(result.effect.actual, expectedStatus === 'pass' ? 2 : 3);
    assert.equal(result.status, expectedStatus);
    assert.equal(result.effect.status, expectedStatus === 'pass' ? 'matched' : 'timed_out');
    const events = broker.store.get(runId).events;
    assert.equal(events.findLast(e => e.kind === 'assertion').status, expectedStatus);
    assert.equal(events.findLast(e => e.kind === 'observation').source, 'device-ax');
    await assert.rejects(act(observed.observationId, { waitFor }), /observation_stale/);
  }
  assert.equal(env.log().filter(r => r.event === 'dispatch').length, 3, 'Timeout polls only the assertion');
  await broker.command('agent', { op: 'stop', grant: broker.owner.grant });
  const replay = await client.task('qa_replay', { runId });
  assert.equal(replay.edit.available, true);
  assert.deepEqual(replay.edit.clips.map(c => c.status), ['pass', 'fail']);
  const miss = replay.edit.clips[1];
  assert.ok(miss.sourceEndMs - miss.sourceStartMs >= 100, 'Clip spans the wait, not just writing the result');
});

test('one persistent session and host serve every warm call without per-call SSH or launch', async t => {
  const env = environment(t, [windowLease('agent:a', 'a', 1, relay)]);
  const session = env.open();
  const a = env.config('agent:a');
  const first = await control(a, { operation: 'observe', lease: proof('a', 1), target: relay }, { session });
  assert.equal(first.snapshot.elements[0].value, 'Count: 0');
  const warm = [];
  for (let i = 0; i < 10; i++) {
    const started = performance.now();
    await control(a, { operation: 'observe', lease: proof('a', 1), target: relay, mode: 'pixels' }, { session });
    warm.push(performance.now() - started);
  }
  const observed = await control(a, { operation: 'observe', lease: proof('a', 1), target: relay }, { session });
  const started = performance.now();
  await control(a, { operation: 'press', lease: proof('a', 1), target: relay, observationId: observed.observationId,
    elementId: 'relay-increment' }, { session });
  const pressMs = performance.now() - started;
  const after = await control(a, { operation: 'observe', lease: proof('a', 1), target: relay }, { session });
  assert.equal(after.snapshot.elements[0].value, 'Count: 1', 'The fresh observation confirms the press effect');
  await assert.rejects(control(a, { operation: 'press', lease: proof('a', 1), target: relay,
    observationId: observed.observationId, elementId: 'relay-increment' }, { session }), /observation_stale/);
  assert.equal(session.starts, 1, 'Warm calls reuse one remote daemon');
  assert.equal(env.log().filter(r => r.event === 'launch').length, 1, 'The host launches once, not per call');
  assert.ok(Math.max(...warm) < 500, `warm observe round trips ${warm.map(Math.round)} ms`);
  assert.ok(pressMs < 500 + 150, `warm press ${Math.round(pressMs)} ms includes a 150 ms fake action`);
});

test('observations are bound per lease and target and never overwrite one another', async t => {
  const env = environment(t, [windowLease('agent:a', 'a', 1, relay), windowLease('agent:b', 'b', 2, other)]);
  const session = env.open();
  const a = env.config('agent:a'), b = env.config('agent:b');
  const click = { kind: 'click', x: 0.5, y: 0.5, button: 'left', count: 1 };
  const [o1, o2, o3] = await Promise.all([
    control(a, { operation: 'observe', lease: proof('a', 1), target: relay, mode: 'pixels' }, { session }),
    control(a, { operation: 'observe', lease: proof('a', 1), target: relay, mode: 'pixels' }, { session }),
    control(b, { operation: 'observe', lease: proof('b', 2), target: other, mode: 'pixels' }, { session }),
  ]);
  assert.equal(new Set([o1, o2, o3].map(o => o.observationId)).size, 3);
  await assert.rejects(control(b, { operation: 'mouse', lease: proof('b', 2), target: relay, observationId: o1.observationId,
    mouse: click }, { session }), /lease_scope/, 'Another agent cannot act on a window it does not lease');
  await assert.rejects(control(a, { operation: 'mouse', lease: proof('a', 1), target: relay, observationId: o3.observationId,
    mouse: click }, { session }), /observation_stale/, 'An observation is bound to its own lease and target');
  for (const [config, p, target, o] of [[a, proof('a', 1), relay, o1], [a, proof('a', 1), relay, o2], [b, proof('b', 2), other, o3]]) {
    const result = await control(config, { operation: 'mouse', lease: p, target, observationId: o.observationId, mouse: click }, { session });
    assert.deepEqual(result, { type: 'mouse-acknowledged', route: 'background-ax-press', focusPreserved: true, cursorPreserved: true });
  }
  await assert.rejects(control(a, { operation: 'mouse', lease: proof('a', 1), target: relay, observationId: o1.observationId,
    mouse: click }, { session }), /observation_stale/);
  const o4 = await control(a, { operation: 'observe', lease: proof('a', 1), target: relay, mode: 'pixels' }, { session });
  await assert.rejects(control(a, { operation: 'mouse', lease: proof('a', 1), target: relay, observationId: o4.observationId,
    mouse: { kind: 'drag', x: 0.1, y: 0.1, toX: 0.5, toY: 0.5, durationMs: 200 } }, { session }), /background_unavailable/);
  assert.equal(fs.existsSync(path.join(env.root, 'fences', 'pid-12')), false, 'A definite refusal clears its fence');
});

test('mutations serialize per process while different processes proceed independently', async t => {
  const env = environment(t, [windowLease('agent:a', 'a', 1, relay), windowLease('agent:b', 'b', 2, other),
    windowLease('agent:c', 'c', 3, { ...relay, windowId: 9 })], { FAKE_HOST_DELAY: '0.3' });
  const session = env.open();
  const click = { kind: 'click', x: 0.5, y: 0.5, button: 'left', count: 1 };
  const second = { ...relay, windowId: 9 };
  const pairs = [['agent:a', 'a', 1, relay], ['agent:c', 'c', 3, second], ['agent:b', 'b', 2, other]];
  const observed = await Promise.all(pairs.map(([owner, c, g, target]) =>
    control(env.config(owner), { operation: 'observe', lease: proof(c, g), target, mode: 'pixels' }, { session })));
  await Promise.all(pairs.map(([owner, c, g, target], i) => control(env.config(owner), { operation: 'mouse', lease: proof(c, g),
    target, observationId: observed[i].observationId, mouse: click }, { session })));
  const mice = env.log().filter(r => r.event === 'mouse');
  const pid12 = mice.filter(r => r.pid === 12).sort((x, y) => x.start - y.start);
  const pid13 = mice.find(r => r.pid === 13);
  assert.equal(pid12.length, 2, 'Two windows of one process both received input');
  assert.ok(pid12[1].start >= pid12[0].end, 'Two windows of one process share one mutation queue');
  assert.ok(pid12.some(r => r.start < pid13.end && pid13.start < r.end), 'A different process is not blocked by that queue');
});

test('lost replies and deadlines fail closed without retry and fence only the affected process', async t => {
  const env = environment(t, [windowLease('agent:a', 'a', 1, relay), windowLease('agent:s', 'c', 2, slow),
    windowLease('agent:l', 'd', 3, lost)]);
  const session = env.open();
  const click = { kind: 'click', x: 0.5, y: 0.5, button: 'left', count: 1 };
  const s = env.config('agent:s'), l = env.config('agent:l'), a = env.config('agent:a');
  const slowObservation = await control(s, { operation: 'observe', lease: proof('c', 2), target: slow, mode: 'pixels' }, { session });
  const lostObservation = await control(l, { operation: 'observe', lease: proof('d', 3), target: lost, mode: 'pixels' }, { session });
  const started = performance.now();
  await assert.rejects(control(s, { operation: 'mouse', lease: proof('c', 2), target: slow,
    observationId: slowObservation.observationId, mouse: click }, { session }), /action_uncertain/);
  assert.ok(performance.now() - started < 7000, 'The remote mutation deadline bounds a hung native action');
  await assert.rejects(control(l, { operation: 'mouse', lease: proof('d', 3), target: lost,
    observationId: lostObservation.observationId, mouse: click }, { session }), /action_uncertain/);
  for (const pid of [98, 99]) assert.ok(fs.existsSync(path.join(env.root, 'fences', 'pid-' + pid)), `pid ${pid} stays fenced`);
  await assert.rejects(control(s, { operation: 'observe', lease: proof('c', 2), target: slow, mode: 'pixels' }, { session }), /busy/);
  await assert.rejects(control(l, { operation: 'mouse', lease: proof('d', 3), target: lost,
    observationId: lostObservation.observationId, mouse: click }, { session }), /busy|observation_stale/);
  assert.equal(env.log().filter(r => r.event === 'dispatch' && r.pid === 98).length, 1, 'Uncertain input is never retried');
  const healthy = await control(a, { operation: 'observe', lease: proof('a', 1), target: relay, mode: 'pixels' }, { session });
  assert.equal(healthy.type, 'observation', 'Other processes continue while one process is fenced');
});

test('every request rereads authority and scopes window, observer and exclusive leases', async t => {
  const env = environment(t, [windowLease('agent:a', 'a', 1, relay), lease('agent:o', 'e', 2, { kind: 'observer' })]);
  const session = env.open();
  const a = env.config('agent:a'), o = env.config('agent:o');
  await control(a, { operation: 'observe', lease: proof('a', 1), target: relay }, { session });
  await assert.rejects(control(a, { operation: 'observe', lease: proof('a', 1), target: desktop, mode: 'pixels' }, { session }), /lease_scope/);
  await assert.rejects(control(a, { operation: 'shutdown', lease: proof('a', 1) }, { session }), /lease_scope/);
  const viewed = await control(o, { operation: 'observe', lease: proof('e', 2), target: relay, mode: 'pixels' }, { session });
  await assert.rejects(control(o, { operation: 'mouse', lease: proof('e', 2), target: relay, observationId: viewed.observationId,
    mouse: { kind: 'click', x: 0.5, y: 0.5, button: 'left', count: 1 } }, { session }), /lease_scope/);
  assert.equal((await control(o, { operation: 'windows', lease: proof('e', 2) }, { session })).windows.length, 1);
  env.write([lease('agent:o', 'e', 2, { kind: 'observer' })]);
  await assert.rejects(control(a, { operation: 'observe', lease: proof('a', 1), target: relay }, { session }), /stale_lease/,
    'Revocation applies to the very next request on the same warm session');
  env.write([lease('agent:x', 'f', 5, { kind: 'exclusive' })]);
  const x = env.config('agent:x');
  const desk = await control(x, { operation: 'observe', lease: proof('f', 5), target: desktop, mode: 'pixels' }, { session });
  const hid = await control(x, { operation: 'mouse', lease: proof('f', 5), target: desktop, observationId: desk.observationId,
    mouse: { kind: 'move', x: 0.1, y: 0.1 } }, { session });
  assert.equal(hid.route, 'foreground-hid', 'Desktop input exists only under an explicit exclusive lease');
  fs.writeFileSync(path.join(env.root, 'inflight'), 'recovery', { mode: 0o600 });
  await assert.rejects(control(x, { operation: 'windows', lease: proof('f', 5) }, { session }), /busy/);
  fs.unlinkSync(path.join(env.root, 'inflight'));
  assert.deepEqual(await control(x, { operation: 'shutdown', lease: proof('f', 5) }, { session }), { type: 'shutdown' });
  assert.equal(session.starts, 1);
});

test('client queue is bounded and deadlines, cancellation and shutdown never report uncertain input as success', async t => {
  const silent = `import sys,json
sys.stdin.readline()
print(json.dumps({"type":"ready","protocol":2,"pid":1}), flush=True)
for line in sys.stdin: pass`;
  const session = new MacSession({ transport: 'factory', computer: 'x', workspace: '/tmp/none', owner: 'agent:a' },
    { command: ['python3', ['-c', silent]], maxPending: 2 });
  t.after(() => session.close());
  await session.start();
  session.warm = true;
  const started = performance.now();
  await assert.rejects(session.request({ operation: 'observe' }, { deadlineMs: 100 }), /control_timeout/);
  assert.ok(performance.now() - started < 3000);
  await assert.rejects(session.request({ operation: 'mouse' }, { deadlineMs: 100, mutation: true }), /action_uncertain/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(session.request({ operation: 'mouse' }, { deadlineMs: 5000, mutation: true, signal: controller.signal }), /control_cancelled/,
    'Input cancelled before it is written was never sent');
  const sentController = new AbortController();
  const sent = session.request({ operation: 'mouse' }, { deadlineMs: 5000, mutation: true, signal: sentController.signal });
  await new Promise(resolve => setTimeout(resolve, 50));
  sentController.abort();
  await assert.rejects(sent, /action_uncertain/, 'Input cancelled after it was written is uncertain');
  const one = session.request({ operation: 'observe' }, { deadlineMs: 5000 });
  const two = session.request({ operation: 'mouse' }, { deadlineMs: 5000, mutation: true });
  await assert.rejects(session.request({ operation: 'observe' }, { deadlineMs: 5000 }), /busy/);
  await new Promise(resolve => setTimeout(resolve, 50));
  const closing = [assert.rejects(one, /control_closed/), assert.rejects(two, /action_uncertain/)];
  await session.close();
  await Promise.all(closing);
});

test('benchmark harness measures warm click effect and concurrent silent clicks over the persistent path', async t => {
  const env = environment(t, [windowLease('agent:a', 'a', 1, relay), windowLease('agent:b', 'b', 2, other)], { FAKE_HOST_DELAY: '0.02' });
  const a = env.config('agent:a'), b = env.config('agent:b');
  const sessions = [env.open(), env.open()];
  const click = await benchClick({ config: a, lease: proof('a', 1), target: relay, iterations: 5, at: [0.5, 0.5], session: sessions[0] });
  assert.equal(click.warmEffectMs.n, 5, 'Every warm click reached a fresh observed effect');
  assert.equal(click.pass, true, JSON.stringify(click.warmEffectMs));
  assert.equal(click.silent, true);
  assert.equal(click.samples[1].route, 'background-ax-press');
  const concurrent = await benchConcurrent({ configs: [a, b], leases: [proof('a', 1), proof('b', 2)], targets: [relay, other],
    points: [[0.5, 0.5], [0.25, 0.75]], iterations: 4, sessions });
  assert.equal(concurrent.clicks, 8);
  assert.ok(concurrent.overlappingClicks > 0, 'Different windows proceed in parallel');
  assert.deepEqual(concurrent.routes, ['background-ax-press']);
  assert.equal(concurrent.pass, true);
});

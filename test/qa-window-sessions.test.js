import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Broker } from '../src/qa-broker.js';
import { QAClient } from '../src/qa-client.js';
import { launchManagedFixture } from '../src/qa-managed-fixture.js';
import { mediaProcess } from '../src/qa-export.js';
import { createQAServer } from '../src/qa-server.js';
import { opaque, POLICY, RunStore } from '../src/qa-store.js';
import { WindowSessions } from '../src/qa-window-sessions.js';
import { sampleBundle, sameTarget } from '../src/window-target.js';

const windows = Array.from({ length: 5 }, (_, i) => ({
  target: { windowId: i + 10, pid: i + 20, bundleId: sampleBundle }, processStartedAt: i + 100,
}));
const desktop = { kind: 'desktop', displayId: 1, displayUUID: '00000000-0000-0000-0000-000000000001',
  main: true, displayConfiguration: { boundsPoints: [0, 0, 10, 10], pixelWidth: 10, pixelHeight: 10, rotation: 0, scaleX: 1, scaleY: 1 } };
const counter = n => `Count: ${n}`;
const deferred = () => Promise.withResolvers();

async function fixture(t, { applications, lifetimeMs, maxRuns = POLICY.maxRuns, encodedFixture = false,
  managed = [], wrongProcess = false, failRelease = false, recording, displayName } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-window-sessions-'));
  let fixtureJPEG;
  const leases = new Map(), streams = new Map(), presses = [], counts = new Map(), observations = new Map(), takeovers = [];
  const acquisitions = [], captured = [];
  const displayCaptures = new Map(), displayCallbacks = [];
  const managedWindows = new Map(), launches = [], discoverable = () => [...windows, ...managedWindows.values()];
  const fake = fileURLToPath(new URL('./fixtures/fake-managed-fixture.py', import.meta.url));
  let owner = 0, generation = 0, hold, broker, server, origin;
  const conflicts = (a, b) => a.kind === 'exclusive' || b.kind === 'exclusive' ||
    (a.kind === 'window' && b.kind === 'window' && a.target.windowId === b.target.windowId && a.target.pid === b.target.pid);
  const adapter = () => {
    const id = ++owner;
    const leaseFor = proof => {
      const lease = leases.get(proof.token);
      if (!lease || lease.generation !== proof.generation || lease.owner !== id) throw new Error('stale_lease');
      return lease;
    };
    return {
      applications,
      launchFixture: options => {
        if (recording) assert.equal(displayCaptures.size, 0, 'Display capture is cancelled before launching another fixture');
        const mode = managed[launches.length] ?? 'healthy';
        const launch = launchManagedFixture({ workspace: root, transport: 'ssh', host: 'mac.test', user: 'test', owner: 'qa' },
          { ...options, command: ['python3', ['-u', fake, mode]] });
        const record = { launch, renewals: 0 };
        launches.push(record);
        launch.ready.then(identity => {
          record.identity = identity;
          managedWindows.set(identity.target.pid, identity);
        }, () => {});
        launch.done.then(() => { if (record.identity) managedWindows.delete(record.identity.target.pid); });
        return { ...launch, renew: () => { record.renewals++; launch.renew(); } };
      },
      acquire: async (takeover, _ttl, scope) => {
        acquisitions.push(scope);
        if (takeover) takeovers.push(scope);
        const blocking = [...leases].filter(([, lease]) => conflicts(lease.scope, scope));
        if (blocking.length && !takeover) throw new Error('lease_held');
        for (const [token, lease] of blocking) { leases.delete(token); streams.get(lease.owner)?.stop('stale_lease'); }
        const token = `${++generation}`.padStart(64, '0');
        leases.set(token, { owner: id, generation, scope });
        return { token, generation };
      },
      release: async proof => {
        const lease = leaseFor(proof);
        leases.delete(proof.token);
        if (failRelease && launches.some(record => record.identity?.target.pid === lease.scope.target?.pid))
          throw new Error('transport_failed');
      },
      windows: async proof => {
        const lease = leaseFor(proof);
        if (lease.scope.kind === 'window' && managedWindows.has(lease.scope.target.pid))
          assert.equal(lease.scope.target.bundleId, sampleBundle);
        return { windows: discoverable().map(window => ({ ...window.target, ...(displayName ? { displayName } : {}), processStartedAt: window.processStartedAt +
          Number(wrongProcess && managedWindows.has(window.target.pid)) })), displays: [desktop] };
      },
      ...(recording ? {
        recordingTargets: async () => { await recording.discovery; return [desktop]; },
        recordingStream: async (proof, selected, signal, receive) => {
          if (recording.error) throw new Error(recording.error);
          leaseFor(proof);
          assert.equal([...leases.values()].filter(l => l.scope.kind === 'window').length, 1);
          const stop = deferred();
          const emit = () => receive({ header: { ...selected, type: 'frame', width: 10, height: 10,
            displayConfiguration: desktop.displayConfiguration, contentRectPixels: [0, 0, 10, 10],
            scaleFactor: 1, contentScale: 1, captureTimeSeconds: 1, sentUptimeSeconds: 1.01 },
          image: Buffer.from([255, 216, 250, 255, 217]) });
          displayCallbacks.push(emit);
          displayCaptures.set(id, { emit });
          const abort = () => { displayCaptures.delete(id); stop.resolve(); };
          signal.addEventListener('abort', abort, { once: true });
          try { if (signal.aborted) return; emit(); await stop.promise; }
          finally { displayCaptures.delete(id); signal.removeEventListener('abort', abort); }
        },
      } : {}),
      stream: async (proof, target, signal, receive) => {
        const lease = leaseFor(proof), JPEG = fixtureJPEG ?? Buffer.from([0xff, 0xd8, target.windowId ?? 0, 0xff, 0xd9]);
        assert(lease.scope.kind !== 'window' || sameTarget(target, lease.scope.target));
        const window = discoverable().find(window => sameTarget(window.target, target)), rect = [0, 0, 10, 10];
        const stopped = deferred();
        const stop = reason => stopped.resolve(reason);
        const abort = () => stop();
        streams.set(id, { target, stop });
        captured.push(target);
        let sequence = 0;
        const header = { ...target, width: 10, height: 10,
          contentRectPixels: rect, initialWindowRectPoints: rect, processStartedAt: window?.processStartedAt,
          ...(recording ? { scaleFactor: 1, contentScale: 1, captureTimeSeconds: 1, sentUptimeSeconds: 1.01 } : {}),
          ...(target.kind === 'desktop' ? { displayConfiguration: desktop.displayConfiguration } : {}) };
        const emit = () => {
          receive({ header: { ...header, type: 'vframe', sequence: ++sequence, keyframe: true }, image: Buffer.from([target.windowId ?? 0]) });
          receive({ header: { ...header, type: 'frame', sequence: ++sequence }, image: JPEG });
        };
        const timer = setInterval(emit, 20);
        signal.addEventListener('abort', abort, { once: true });
        try { emit(); const reason = await stopped.promise; if (reason) throw new Error(reason); }
        finally { clearInterval(timer); signal.removeEventListener('abort', abort); streams.delete(id); }
      },
      observe: async (proof, target) => {
        leaseFor(proof);
        const observationId = opaque();
        observations.set(proof.token, observationId);
        const window = discoverable().find(window => sameTarget(window.target, target));
        return { observationId, expiresAt: Date.now() / 1000 + 30, snapshot: window
          ? { target, processStartedAt: window.processStartedAt, windowRectPoints: [0, 0, 10, 10],
            elements: [{ id: 'relay-count', value: counter(counts.get(target.windowId) ?? 0) }] }
          : { target, displayConfiguration: desktop.displayConfiguration, elements: [] } };
      },
      press: async (proof, target, observationId, waitFor) => {
        const lease = leaseFor(proof);
        assert.equal(lease.scope.kind, 'window');
        assert(sameTarget(lease.scope.target, target));
        assert.equal(observations.get(proof.token), observationId);
        observations.delete(proof.token);
        const actual = (counts.get(target.windowId) ?? 0) + 1;
        counts.set(target.windowId, actual);
        presses.push({ id, target, waitFor });
        if (hold && hold.windowId === target.windowId) { hold.entered.resolve(); await hold.resume.promise; }
        return { route: 'background-ax-press', focusPreserved: true, cursorPreserved: true,
          ...(waitFor && { effect: { status: waitFor.equals === actual ? 'matched' : 'timed_out', actual, dispatchMs: 1, elapsedMs: 2 } }) };
      },
    };
  };
  const file = path.join(root, 'agent.json');
  const launch = async () => {
    broker = new Broker(new RunStore(path.join(root, 'runs'), { ...POLICY, maxRuns }), adapter());
    const manager = new WindowSessions(broker, adapter, { lifetimeMs });
    server = createQAServer(broker, { windowSessions: manager });
    origin = await server.listen(0);
    fs.writeFileSync(file, JSON.stringify({ origin, token: server.agentToken }), { mode: 0o600 });
  };
  const stop = async () => { await server.close(); await broker.close(); };
  await launch();
  const raw = (route, token, input, method = input ? 'POST' : 'GET', extra = {}) => fetch(origin + route, {
    method, headers: { 'X-QA-Request': '1', ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(input ? { 'Content-Type': 'application/json' } : {}), ...extra },
    ...(input ? { body: JSON.stringify(input) } : {}),
  });
  const pair = async () => {
    const paired = await raw('/session', null, { code: server.pairingCode }, 'POST', { Origin: origin });
    const { csrf } = await paired.json();
    return { cookie: paired.headers.get('set-cookie').split(';')[0], 'X-QA-CSRF': csrf, Origin: origin };
  };
  t.after(async () => {
    hold?.resume.resolve();
    try { await stop(); }
    finally { fs.rmSync(root, { recursive: true }); }
  });
  if (encodedFixture) {
    const file = path.join(root, 'fixture.jpg');
    await mediaProcess('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x240',
      '-frames:v', '1', '-threads', '2', file]);
    fixtureJPEG = fs.readFileSync(file);
  }
  return { root, file, get server() { return server; }, get broker() { return broker; }, raw, leases, streams, presses, takeovers, pair,
    acquisitions, captured, launches, managedWindows, leaseAdapter: adapter, stop, displayCaptures, displayCallbacks,
    restart: async () => { await stop(); await launch(); },
    hold: windowId => (hold = { windowId, entered: deferred(), resume: deferred() }) };
}

async function waitScope(session, scope) {
  for (let i = 0; i < 100; i++) {
    const status = await session.task('qa_status');
    if (status.recordingScope.scope === scope) return status;
    await delay(10);
  }
  assert.fail(`Recording did not reach ${scope}`);
}

test('scoped overview and replay share the discovered application and first named check after recovery', async t => {
  const f = await fixture(t, { displayName: 'Nimbus Studio' }), client = new QAClient(f.file);
  const session = await client.openWindowSession(windows[0]);
  assert.equal(session.started.title, 'Nimbus Studio - QA session');
  const human = await f.pair();
  const overview = async () => (await (await f.raw('/api/window-overview', null, null, 'GET',
    { Cookie: human.cookie })).json()).sessions.find(item => item.runId === session.runId);
  assert.equal((await overview()).title, 'Nimbus Studio - QA session');
  await session.task('qa_check', { title: 'Initial total is visible', expected: 0 });
  assert.equal((await overview()).title, 'Nimbus Studio - Initial total is visible');
  assert.equal((await session.task('qa_replay', { filter: 'results' })).title, 'Nimbus Studio - Initial total is visible');
  await session.close();
  await f.restart();
  const pairedAgain = await f.pair();
  const history = await (await f.raw('/api/recordings', null, null, 'GET', { Cookie: pairedAgain.cookie })).json();
  assert.equal(history.runs.find(run => run.runId === session.runId).title, 'Nimbus Studio - Initial total is visible');
});

test('public SDK records one display, fences delayed pixels before a second session, and resumes after finish', async t => {
  const f = await fixture(t, { recording: {} }), client = new QAClient(f.file);
  const a = await client.openWindowSession(windows[0]);
  assert.equal(a.started.recordingScope.scope, 'display', 'Start waits for a durably stored context JPEG');
  const run = f.broker.store.get(a.runId), context = run.events.find(e => e.kind === 'recording-frame');
  assert.ok(context);
  assert.equal(f.broker.store.recordingImage(a.runId, context.frameId)[2], 250);
  assert.throws(() => f.broker.store.image(a.runId, context.frameId), /frame_not_found/);
  assert.equal((await a.live()).image[2], a.target.windowId);
  assert.equal(Buffer.from((await a.observe({ includeImage: true })).image.data, 'base64')[2], a.target.windowId);
  const replay = await a.task('qa_replay', { filter: 'events' });
  assert.ok(replay.items.every(e => e.kind !== 'recording-frame'));
  await assert.rejects(a.task('qa_replay', { frameId: context.frameId }), /frame_not_found/);
  const late = f.displayCallbacks[0];
  const b = await client.openWindowSession(windows[1]);
  assert.equal((await a.task('qa_status')).recordingScope.scope, 'window');
  assert.equal(b.started.recordingScope.scope, 'window');
  assert.equal(f.displayCaptures.size, 0);
  const count = run.events.filter(e => e.kind === 'recording-frame').length;
  late(); await delay(25);
  assert.equal(run.events.filter(e => e.kind === 'recording-frame').length, count, 'Old callbacks cannot store display pixels');
  await b.finish();
  await waitScope(a, 'display');
  assert.equal(f.displayCaptures.size, 1, 'Finished credentials do not count as active work');
  await a.close();
  assert.equal(f.displayCaptures.size, 0);
  assert.ok(run.events.filter(e => e.kind === 'recording-scope').some(e => e.scope === 'window' && e.reason === 'multiple_sessions'));
  assert.ok(f.acquisitions.every(s => s.kind !== 'exclusive'), 'Recording never expands input authority');
  await b.close();
});

test('legacy and scoped recordings share the population and restore display context after a failed pending open', async t => {
  const f = await fixture(t, { recording: {} }), client = new QAClient(f.file);
  const legacy = await client.task('qa_start', { target: windows[0].target });
  assert.equal(legacy.recordingScope.scope, 'display');
  const b = await client.openWindowSession(windows[1]);
  assert.equal((await client.task('qa_status')).recordingScope.scope, 'window');
  assert.equal((await b.task('qa_status')).recordingScope.scope, 'window');
  await b.close();
  for (let i = 0; i < 100 && (await client.task('qa_status')).recordingScope.scope !== 'display'; i++) await delay(10);
  assert.equal((await client.task('qa_status')).recordingScope.scope, 'display');
  await assert.rejects(client.openWindowSession({ ...windows[2], processStartedAt: 999 }), /target_mismatch/);
  for (let i = 0; i < 100 && (await client.task('qa_status')).recordingScope.scope !== 'display'; i++) await delay(10);
  assert.equal((await client.task('qa_status')).recordingScope.scope, 'display');
  const c = await client.openWindowSession(windows[2]);
  await client.task('qa_finish', { runId: legacy.runId });
  await waitScope(c, 'display');
  await c.close();
  assert.equal(f.displayCaptures.size, 0);
});

test('pending managed launch cancels display context before spawn and resumes after HTTP cancellation', async t => {
  const f = await fixture(t, { recording: {}, managed: ['partial'] }), client = new QAClient(f.file);
  const a = await client.openWindowSession(windows[0]), run = f.broker.store.get(a.runId);
  const signal = new AbortController(), late = f.displayCallbacks[0];
  const pending = client.openFixtureSession({}, { signal: signal.signal });
  const aborted = assert.rejects(pending, { name: 'AbortError' });
  await until(() => fs.readdirSync(f.root).some(name => name.startsWith('start.')), 'Pending fixture reached launch');
  assert.equal((await a.task('qa_status')).recordingScope.scope, 'window');
  assert.equal(f.displayCaptures.size, 0);
  const count = run.events.filter(e => e.kind === 'recording-frame').length;
  late(); await delay(20);
  assert.equal(run.events.filter(e => e.kind === 'recording-frame').length, count);
  signal.abort(); await aborted;
  assert.deepEqual(await f.launches[0].launch.done, { reason: 'closed', cleaned: true });
  await waitScope(a, 'display');
  assert.equal(f.broker.store.runs.size, 1, 'Failed pending work creates no synthetic recording');
  await a.close();
});

test('session expiry restores sole-session display capture and broker shutdown closes it', async t => {
  const f = await fixture(t, { recording: {}, lifetimeMs: 2000 }), client = new QAClient(f.file);
  const a = await client.openWindowSession(windows[0]);
  await delay(500);
  const b = await client.openWindowSession(windows[1]);
  assert.equal(b.started.recordingScope.scope, 'window');
  await delay(1550);
  await assert.rejects(a.task('qa_status'), /authentication_required/);
  await waitScope(b, 'display');
  await f.stop();
  assert.equal(f.displayCaptures.size, 0);
  assert.equal(f.leases.size, 0);
  assert.equal(f.broker.store.get(b.runId).events.at(-1).kind, 'run-end');
});

test('recording permission denial and unsupported adapters truthfully retain scoped window evidence', async t => {
  for (const recording of [undefined, { error: 'screen_recording_required' }]) {
    const f = await fixture(t, { recording }), client = new QAClient(f.file);
    const a = await client.openWindowSession(windows[0]);
    const status = await a.task('qa_status');
    assert.equal(status.recordingScope.scope, 'window');
    assert.equal(status.recordingScope.reason, recording ? 'screen_recording_required' : 'recording_context_unsupported');
    assert.equal((await a.live()).image[2], a.target.windowId);
    assert.ok(!f.broker.store.get(a.runId).events.some(e => e.kind === 'recording-frame'));
    await a.close();
  }
});

test('display prewarm has a deadline and cannot revive after a close during discovery', async t => {
  const discovery = deferred(), f = await fixture(t, { recording: { discovery: discovery.promise } });
  const client = new QAClient(f.file);
  const a = await client.openWindowSession(windows[0]);
  assert.equal(a.started.recordingScope.reason, 'recording_context_timeout');
  await a.close();
  discovery.resolve(); await delay(20);
  assert.equal(f.displayCaptures.size, 0);
  assert.equal(f.broker.store.get(a.runId).events.filter(e => e.kind === 'recording-frame').length, 0);
});

test('two QAClient sessions drive distinct windows without sharing queues, frames, observations or authority', { timeout: 8000 }, async t => {
  const f = await fixture(t);
  const client = new QAClient(f.file), other = new QAClient(f.file);
  const [a, b] = await Promise.all([client.openWindowSession(windows[0]), other.openWindowSession(windows[1])]);
  assert.notEqual(a.runId, b.runId);
  assert.equal(f.leases.size, 2);
  assert.equal(f.streams.size, 2);
  assert.deepEqual(f.acquisitions.map(s => s.kind), ['window', 'window']);
  assert.equal(f.captured.length, 2);
  assert.throws(() => { a.target.windowId = b.target.windowId; }, TypeError);
  assert.throws(() => { a.runId = b.runId; }, TypeError);
  assert.equal(Object.hasOwn(a.started, 'token'), false);
  assert.deepEqual((await a.task('qa_targets')).windows.map(w => w.target), [a.target]);
  assert.equal((await a.live()).image[2], a.target.windowId);
  assert.equal((await b.live()).image[2], b.target.windowId);
  await assert.rejects(client.openWindowSession(windows[0]), /lease_held/);
  assert.deepEqual(f.takeovers, []);
  assert.equal(f.streams.size, 2);
  assert.deepEqual(await client.request('/api/runs'), []);
  await assert.rejects(client.task('qa_replay', { runId: a.runId }), /run_not_found/);
  await assert.rejects(a.task('qa_replay', { runId: b.runId }), /run_mismatch/);
  await assert.rejects(a.task('qa_start', { target: b.target }), /invalid_operation/);

  const [oa, ob] = await Promise.all([a.observe({ includeImage: true }), b.observe({ includeImage: true })]);
  assert.equal(Buffer.from(oa.image.data, 'base64')[2], a.target.windowId);
  assert.equal(Buffer.from(ob.image.data, 'base64')[2], b.target.windowId);
  await assert.rejects(a.act({ action: 'increment', observationId: ob.observationId }), /observation_stale/);
  assert.equal(f.presses.length, 0);
  const anew = await a.observe(), hold = f.hold(a.target.windowId);
  const waitFor = { kind: 'count', equals: 1, timeoutMs: 500 };
  const pending = a.actAndWait({ action: 'increment', observationId: anew.observationId }, waitFor);
  await hold.entered.promise;
  const ack = await b.act({ action: 'increment', observationId: ob.observationId });
  assert.equal(ack.status, 'acknowledged');
  assert.equal(ack.assertion, false);
  assert.equal(f.presses[1].waitFor, undefined);
  hold.resume.resolve();
  const matched = await pending;
  assert.equal(matched.status, 'pass');
  assert.equal(matched.assertion, true);
  assert.deepEqual(f.presses[0].waitFor, waitFor);
  assert.notEqual(f.presses[0].id, f.presses[1].id);

  await b.task('qa_check', { title: 'B increment', expected: 1 });
  assert.equal((await b.task('qa_replay', { filter: 'results' })).counts.pass, 1);
  assert.match((await a.task('qa_replay', { filter: 'results' })).checks.items[0].title, /wait for count 1/i);
  const report = await b.task('qa_report', { export: false });
  assert.equal(report.replayUrl, undefined);
  assert.match(report.reportMarkdown, /Use qa_replay/);
  assert.doesNotMatch(report.reportMarkdown, /#run=/);
  const frames = await a.task('qa_replay', { filter: 'frames' });
  const evidence = await a.task('qa_replay', { frameId: frames.items[0].frameId });
  assert.equal(Buffer.from(evidence.image.data, 'base64')[2], a.target.windowId);
  assert.equal((await b.finish()).runId, b.runId);
  assert.equal(f.leases.size, 1);
  assert.equal(f.streams.size, 1);
  const late = await a.observe();
  await a.close();
  await assert.rejects(a.act({ action: 'increment', observationId: late.observationId }), /authentication_required/);
  await assert.rejects(a.live(), /authentication_required/);
  const replacement = await other.openWindowSession(windows[0]);
  await replacement.observe();
  await assert.rejects(replacement.act({ action: 'increment', observationId: late.observationId }), /observation_stale/);
  assert.equal(f.presses.length, 2);
  await Promise.all([replacement.close(), b.close()]);
  assert.equal(f.leases.size, 0);
  assert.equal(f.streams.size, 0);
  assert.equal(f.broker.store.history().length, 3);
});

test('raw scoped authentication rejects shared credentials, retargeting, desktop and disallowed windows', async t => {
  const f = await fixture(t);
  const base = '/api/window-sessions', task = base + '/current/tasks/';
  const human = await f.pair();
  assert.equal((await f.raw(base, null, windows[0], 'POST', human)).status, 401);
  const token = f.server.agentToken;
  assert.equal((await f.raw(base, token, { ...windows[0], target: desktop })).status, 400);
  assert.equal((await f.raw(base, token, { ...windows[0], takeover: true })).status, 400);
  assert.equal((await f.raw(base, token, { ...windows[0], processStartedAt: 999 })).status, 400);
  assert.equal(f.leases.size, 0);
  assert.equal(f.captured.length, 0);
  const started = await (await f.raw(base, token, windows[0])).json();
  assert.equal((await f.raw(task + 'qa_status', token, {})).status, 401);
  assert.equal((await f.raw('/api/tasks/qa_status', started.token, {})).status, 401);
  assert.equal((await f.raw('/api/command', started.token, { op: 'take', takeover: true })).status, 401);
  assert.equal((await f.raw(task + 'qa_control', started.token, { mode: 'take' })).status, 400);
  assert.equal((await f.raw(task + 'qa_observe', started.token, { runId: opaque() })).status, 400);
  assert.equal((await f.raw(task + 'qa_replay', token, { runId: started.runId })).status, 401);
  assert.equal((await f.raw(base, started.token, windows[1])).status, 401);
  assert.equal((await f.raw('/api/live', null, undefined, 'GET', human)).status, 409);
  assert.equal((await f.raw('/api/runs/' + started.runId, null, undefined, 'GET', human)).status, 200);
  assert.equal((await f.raw('/api/runs/' + started.runId, token)).status, 404);

  const humanStart = () => f.raw('/api/tasks/qa_start', null, { target: windows[0].target }, 'POST', human);
  const held = await humanStart();
  assert.equal((await held.json()).error, 'lease_held');
  assert.equal((await f.raw(base + '/current', started.token, undefined, 'DELETE')).status, 200);
  const shared = await (await humanStart()).json();
  assert.equal(f.broker.owner.actor, 'human');
  assert.equal((await f.raw(base, token, windows[0])).status, 409);
  assert.equal((await f.raw('/api/tasks/qa_finish', null, { runId: shared.runId }, 'POST', human)).status, 200);
  assert.deepEqual(f.takeovers, []);

  const denied = await fixture(t, { applications: [] });
  await assert.rejects(new QAClient(denied.file).openWindowSession(windows[0]), /application_not_authorized/);
  assert.equal(denied.leases.size, 0);
  assert.equal(denied.broker.store.history().length, 0);
});

test('explicit legacy human takeover revokes the native lease without letting the scoped agent reacquire it', async t => {
  const f = await fixture(t), client = new QAClient(f.file);
  const human = await f.pair();
  const session = await client.openWindowSession(windows[0]);
  const url = `/api/window-overview/${session.runId}`;
  const stream = (await f.raw(url + '/stream', null, undefined, 'GET', human)).body.getReader();
  const observation = await session.observe();
  assert.equal((await f.broker.task('human', 'qa_control', { mode: 'take' })).owner, 'human');
  await assert.rejects(session.act({ action: 'increment', observationId: observation.observationId }),
    /run_mismatch|stale_control|stale_lease/);
  await assert.rejects(client.openWindowSession(windows[1]), /lease_held/);
  assert.equal(f.presses.length, 0);
  assert.deepEqual(f.takeovers, [{ kind: 'exclusive' }]);
  while (!(await stream.read()).done) { /* Drain bytes sent before revocation. */ }
  assert.equal((await f.raw(url + '/frame', null, undefined, 'GET', human)).status, 404);
  await session.close();
  assert.equal(f.leases.size, 1);
});

test('slot capacity, authority expiry and reuse are bounded', { timeout: 8000 }, async t => {
  const f = await fixture(t, { lifetimeMs: 1500 }), client = new QAClient(f.file);
  const sessions = await Promise.all(windows.slice(0, 4).map(window => client.openWindowSession(window)));
  await assert.rejects(client.openWindowSession(windows[4]), /session_limit/);
  assert.equal(f.streams.size, 4);
  assert.equal(f.leases.size, 4);
  const remaining = Math.max(...sessions.map(s => s.expiresAt)) - Date.now();
  await delay(Math.max(0, remaining) + 50);
  for (const s of sessions) await assert.rejects(s.task('qa_status'), /authentication_required/);
  const deadline = Date.now() + 1000;
  while (f.leases.size && Date.now() < deadline) await delay(10);
  assert.equal(f.leases.size, 0);
  assert.equal(f.streams.size, 0);
  const renewed = await client.openWindowSession(windows[4]);
  assert.equal((await renewed.live()).image[2], windows[4].target.windowId);
  await renewed.close();
  assert.equal(f.broker.store.history().length, 5);
});

async function firstPackets(reader, count) {
  let bytes = Buffer.alloc(0);
  const packets = [];
  while (packets.length < count) {
    let needed = 4;
    if (bytes.length >= 4) {
      needed += bytes.readUInt32BE();
      if (bytes.length >= needed) {
        const header = JSON.parse(bytes.subarray(4, needed));
        if (bytes.length >= needed + header.bytes) {
          packets.push({ header, payload: bytes.subarray(needed, needed + header.bytes) });
          bytes = bytes.subarray(needed + header.bytes);
          continue;
        }
      }
    }
    const data = await reader.read();
    assert(!data.done, 'Viewer must send all expected packets');
    bytes = Buffer.concat([bytes, data.value]);
  }
  return packets;
}

test('four stdio MCP clients, four paired HTTP streams and durable archive survive slot reuse and restart', { timeout: 12000 }, async t => {
  const f = await fixture(t);
  let human = await f.pair();
  const entry = fileURLToPath(new URL('../src/qa-mcp.js', import.meta.url));
  const clients = await Promise.all([0, 1, 2, 3].map(async index => {
    const client = new Client({ name: `window-${index}`, version: '1' });
    t.after(() => client.close());
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry, '--window-session', f.file] }));
    return client;
  }));
  const call = (i, name, args = {}) => clients[i].callTool({ name, arguments: args });
  const names = (await clients[0].listTools()).tools.map(tool => tool.name).sort();
  assert.deepEqual(names, ['qa_act', 'qa_check', 'qa_click_and_check_text', 'qa_finish', 'qa_observe', 'qa_replay', 'qa_report', 'qa_runs', 'qa_start', 'qa_status', 'qa_targets']);
  assert.equal((await call(0, 'qa_status')).structuredContent.connection, 'unbound');
  const { windows: found, displays } = (await call(0, 'qa_targets')).structuredContent;
  assert.deepEqual(displays, []);
  const started = await Promise.all(clients.map((_, i) => call(i, 'qa_start', {
    target: found[i].target, processStartedAt: found[i].processStartedAt, title: `Lane ${i}`,
  })));
  const ids = started.map(reply => {
    assert.equal(reply.isError, undefined, JSON.stringify(reply.structuredContent));
    assert.equal(Object.hasOwn(reply.structuredContent, 'token'), false);
    return reply.structuredContent.runId;
  });
  const observed = await Promise.all(ids.map((runId, i) => call(i, 'qa_observe', { runId, includeImage: true })));
  assert.deepEqual(observed.map(result => Buffer.from(result.content[1].data, 'base64')[2]), windows.slice(0, 4).map(w => w.target.windowId));
  const overview = () => f.raw('/api/window-overview', null, undefined, 'GET', human).then(r => r.json());
  const lanes = (await overview()).sessions;
  assert.deepEqual(new Set(lanes.map(lane => lane.runId)), new Set(ids));
  const media = (i, item, credential = human) => f.raw(`/api/window-overview/${ids[i]}/${item}`, null, undefined, 'GET', credential);
  assert.equal((await f.raw('/api/window-overview', f.server.agentToken)).status, 403);
  assert.equal((await media(0, 'frame', {})).status, 401);
  assert.equal((await media(1, 'frame')).status, 200);
  assert.equal((await media(1, 'frame')).headers.get('content-type'), 'image/jpeg');
  const readers = await Promise.all(ids.map(async (_, i) => {
    const response = await media(i, 'stream');
    assert.equal(response.headers.get('content-type'), 'application/x-qa-frames');
    return response.body.getReader();
  }));
  const packets = await Promise.all(readers.map(reader => firstPackets(reader, 2)));
  packets.forEach(([video, frame], i) => {
    assert.equal(video.header.type, 'vframe');
    assert.equal(video.header.keyframe, true);
    assert.equal(video.payload[0], windows[i].target.windowId);
    assert.equal(frame.header.type, 'frame');
    assert.equal(frame.payload[2], windows[i].target.windowId);
  });
  assert.equal((await call(0, 'qa_replay', { runId: ids[1] })).structuredContent.error.code, 'run_mismatch');
  assert.equal((await call(0, 'qa_report', { runId: ids[1], export: true })).structuredContent.error.code, 'run_mismatch');
  for (let i = 0; i < ids.length; i++) {
    const { structuredContent: page } = await call(i, 'qa_runs');
    assert.equal(page.total, 1);
    assert.deepEqual(page.runs.map(run => run.runId), [ids[i]]);
  }
  await call(0, 'qa_check', { runId: ids[0], title: 'Counter is zero', expected: 0 });
  assert.deepEqual((await overview()).sessions.find(lane => lane.runId === ids[0]).currentCheck, { title: 'Counter is zero', status: 'pass' });
  assert.equal((await call(1, 'qa_act', { runId: ids[1], action: 'increment', completion: 'ack',
    observationId: observed[1].structuredContent.observationId })).structuredContent.status, 'acknowledged');
  await call(1, 'qa_finish', { runId: ids[1] });
  while (!(await readers[1].read()).done) { /* Drain bytes sent before finish. */ }
  assert.equal((await media(1, 'stream')).status, 404);
  await clients[1].close();
  assert.equal(f.streams.size, 3);
  assert.equal(f.leases.size, 3);
  const replacement = await new QAClient(f.file).openWindowSession(windows[4]);
  assert.equal((await replacement.task('qa_runs')).total, 1);
  await replacement.close();
  assert.equal((await call(0, 'qa_observe', { runId: ids[0] })).structuredContent.actual, 0);
  await Promise.all(clients.map(client => client.close()));
  await Promise.all([0, 2, 3].map(async i => {
    while (!(await readers[i].read()).done) { /* Drain bytes sent before close. */ }
  }));
  assert.equal(f.leases.size, 0);
  assert.equal((await overview()).sessions.length, 0);
  const archive = () => f.raw('/api/recordings', null, undefined, 'GET', human).then(r => r.json());
  const archivedIds = [...ids, replacement.runId];
  assert.deepEqual(new Set((await archive()).runs.map(run => run.runId)), new Set(archivedIds));
  await f.restart();
  human = await f.pair();
  assert.deepEqual(new Set((await archive()).runs.map(run => run.runId)), new Set(archivedIds));
  assert.equal((await overview()).sessions.length, 0);
  const replay = await (await f.raw(`/api/runs/${ids[0]}`, null, undefined, 'GET', human)).json();
  assert.equal(replay.at(-1).kind, 'run-end');
  assert.equal(replay.at(-1).status, 'interrupted');
  const frame = replay.find(event => event.kind === 'frame');
  const image = await f.raw(`/api/runs/${ids[0]}/frames/${frame.frameId}`, null, undefined, 'GET', human);
  assert.equal(Buffer.from(await image.arrayBuffer())[2], windows[0].target.windowId);
  assert.equal((await f.raw(`/api/runs/${ids[0]}`, f.server.agentToken)).status, 404);
});

test('the shared archive policy rejects new sessions at capacity without deleting a run', async t => {
  const f = await fixture(t, { maxRuns: 1 }), client = new QAClient(f.file);
  const first = await client.openWindowSession(windows[0]);
  await first.close();
  await assert.rejects(client.openWindowSession(windows[1]), /recording_full/);
  assert.deepEqual(f.broker.store.history().map(run => run.runId), [first.runId]);
  assert.equal(f.acquisitions.length, 1);
});

async function until(check, description, timeout = 2500) {
  const deadline = Date.now() + timeout;
  while (!check() && Date.now() < deadline) await delay(20);
  assert(check(), description);
}

test('four managed and attached lanes keep independent input and controllers, and archive outlives every process', { timeout: 15000 }, async t => {
  const f = await fixture(t), client = new QAClient(f.file);
  const mcp = new Client({ name: 'managed-lane', version: '1' });
  t.after(() => mcp.close());
  await mcp.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../src/qa-mcp.js', import.meta.url)), '--window-session', f.file] }));
  const call = (name, args) => mcp.callTool({ name, arguments: args });
  const [attachedA, attachedB, owned, reply] = await Promise.all([
    client.openWindowSession(windows[0]), client.openWindowSession(windows[1]),
    client.openFixtureSession({ title: 'SDK fixture' }), call('qa_start', { managedFixture: true, title: 'MCP fixture' }),
  ]);
  assert.equal(reply.isError, undefined, JSON.stringify(reply.structuredContent));
  const mcpStarted = reply.structuredContent;
  const started = [attachedA, attachedB, owned, mcpStarted];
  const runIds = started.map(s => s.runId);
  assert.equal(new Set(runIds).size, 4);
  assert.equal(new Set(started.map(s => s.target.pid)).size, 4);
  assert.equal(owned.started.managedFixture, true);
  assert.equal(mcpStarted.managedFixture, true);
  assert.equal(attachedA.started.managedFixture, undefined);
  assert.equal(f.launches.length, 2);
  await assert.rejects(client.openFixtureSession(), /session_limit/);
  assert.equal(f.launches.length, 2, 'The fifth lane must not launch');
  assert.equal(f.leases.size, 4);
  assert(Array.from(f.leases.values()).every(lease => lease.scope.kind === 'window'));
  assert.deepEqual(f.takeovers, []);
  const mcpOwned = f.launches.find(record => record.identity.target.pid === mcpStarted.target.pid);
  const sdkOwned = f.launches.find(record => record.identity.target.pid === owned.target.pid);
  const observation = await owned.observe({ includeImage: true });
  assert.equal(Buffer.from(observation.image.data, 'base64')[2], owned.target.windowId & 255);
  await owned.actAndWait({ action: 'increment', observationId: observation.observationId }, { kind: 'count', equals: 1, timeoutMs: 500 });
  assert.equal((await attachedA.observe()).actual, 0);
  assert.equal((await call('qa_observe', { runId: mcpStarted.runId })).structuredContent.actual, 0);
  assert.equal(await owned.task('qa_heartbeat').then(r => r.active), true);
  await assert.rejects(attachedA.task('qa_heartbeat'), /invalid_operation/);
  await owned.task('qa_check', { title: 'Owned count', expected: 1 });
  await owned.finish();
  await owned.finish();
  assert.deepEqual(await sdkOwned.launch.done, { reason: 'closed', cleaned: true });
  assert(fs.existsSync(path.join(f.root, `exit.${owned.target.pid}`)));
  assert(f.managedWindows.has(mcpStarted.target.pid));
  assert.equal(f.leases.size, 3);
  assert.equal((await owned.task('qa_replay', { filter: 'checks' })).items[0].status, 'pass');
  await owned.close();

  await until(() => mcpOwned.renewals > 0, 'MCP must send a heartbeat authenticated as its own lane', 7500);
  await mcp.close();
  assert.deepEqual(await mcpOwned.launch.done, { reason: 'closed', cleaned: true });
  assert(fs.existsSync(path.join(f.root, `exit.${mcpStarted.target.pid}`)));
  assert.equal((await attachedB.observe()).actual, 0);
  await Promise.all([attachedA.close(), attachedB.close()]);
  assert.equal(f.leases.size, 0);
  for (const attached of [attachedA, attachedB])
    assert(!fs.existsSync(path.join(f.root, `exit.${attached.target.pid}`)));
  await f.restart();
  const human = await f.pair();
  const archive = await (await f.raw('/api/recordings', null, undefined, 'GET', human)).json();
  assert.deepEqual(new Set(archive.runs.map(run => run.runId)), new Set(runIds));
  const replay = await (await f.raw(`/api/runs/${owned.runId}`, null, undefined, 'GET', human)).json();
  assert.equal(replay.at(-1).kind, 'run-end');
  const evidence = replay.find(event => event.kind === 'frame');
  const image = await f.raw(`/api/runs/${owned.runId}/frames/${evidence.frameId}`, null, undefined, 'GET', human);
  assert.equal(Buffer.from(await image.arrayBuffer())[2], owned.target.windowId & 255);
});

test('managed start checks scope and authorization before launching and safely handles a conflicting exclusive lease', async t => {
  const f = await fixture(t);
  const client = new QAClient(f.file);
  await assert.rejects(client.openFixtureSession(windows[0]), /invalid_arguments/);
  await assert.rejects(client.openFixtureSession({ command: 'anything' }), /invalid_arguments/);
  await assert.rejects(client.openFixtureSession({ applicationId: 'desktop' }), /unknown_application/);
  assert.equal(f.launches.length, 0);
  const a = f.leaseAdapter(), proof = await a.acquire(false, 30, { kind: 'exclusive' });
  await assert.rejects(client.openFixtureSession(), /lease_held/);
  assert.equal(f.leases.size, 1, 'Managed startup must not steal or release a pre-existing lease');
  assert.equal(f.launches.length, 0, 'Exclusive control must be refused before spawning');
  assert.deepEqual(f.takeovers, []);
  await a.release(proof);
  const owned = await client.openFixtureSession();
  const before = f.acquisitions.length;
  await assert.rejects(client.openWindowSession(f.launches[0].identity), /lease_held/);
  assert.equal(f.acquisitions.length, before, 'An attached lane cannot bind to an owned fixture');
  await owned.close();
  const denied = await fixture(t, { applications: [] });
  await assert.rejects(new QAClient(denied.file).openFixtureSession(), /application_not_authorized/);
  assert.equal(denied.launches.length, 0);
});

test('failed managed startup and partial HTTP disconnect close the owned fixture without publishing a run', async t => {
  const mismatch = await fixture(t, { wrongProcess: true });
  await assert.rejects(new QAClient(mismatch.file).openFixtureSession(), /target_mismatch/);
  assert.equal(mismatch.leases.size, 0);
  assert.deepEqual(await mismatch.launches[0].launch.done, { reason: 'closed', cleaned: true });
  assert.equal(mismatch.broker.store.runs.size, 0);

  const f = await fixture(t, { managed: ['partial'] });
  const signal = new AbortController();
  const pending = new QAClient(f.file).openFixtureSession({}, { signal: signal.signal });
  const aborted = assert.rejects(pending, { name: 'AbortError' });
  await until(() => fs.readdirSync(f.root).some(name => name.startsWith('start.')), 'Partial fixture should exist before abort');
  signal.abort();
  await aborted;
  assert.deepEqual(await f.launches[0].launch.done, { reason: 'closed', cleaned: true });
  assert.equal(f.leases.size, 0);
  assert.equal(f.broker.store.runs.size, 0);
});

test('partial MCP startup is cancelled on disconnect, and SDK heartbeats do not hold a client process open', { timeout: 8000 }, async t => {
  const f = await fixture(t, { managed: ['partial'] });
  const mcp = new Client({ name: 'interrupted-start', version: '1' });
  t.after(() => mcp.close());
  await mcp.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../src/qa-mcp.js', import.meta.url)), '--window-session', f.file] }));
  const pending = mcp.callTool({ name: 'qa_start', arguments: { managedFixture: true } }).catch(() => {});
  await until(() => fs.readdirSync(f.root).some(name => name.startsWith('start.')), 'Partial MCP fixture should exist before disconnect');
  await mcp.close();
  await pending;
  assert.deepEqual(await f.launches[0].launch.done, { reason: 'closed', cleaned: true });
  assert.equal(f.leases.size, 0);
  assert.equal(f.broker.store.runs.size, 0);

  const clientModule = new URL('../src/qa-client.js', import.meta.url).href;
  const sdkExit = spawn(process.execPath, ['--input-type=module', '-e', `
    import { QAClient } from ${JSON.stringify(clientModule)};
    const session = await new QAClient(${JSON.stringify(f.file)}).openFixtureSession();
    console.log(session.runId);
  `]);
  const exited = once(sdkExit, 'close');
  t.after(async () => { if (sdkExit.exitCode === null && !sdkExit.killed) sdkExit.kill(); await exited; });
  const output = [];
  sdkExit.stdout.on('data', chunk => output.push(chunk));
  let timer;
  try {
    const [code] = await Promise.race([exited, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('SDK heartbeat held the client process open')), 3500);
    })]);
    assert.equal(code, 0);
  } finally { clearTimeout(timer); }
  const runId = Buffer.concat(output).toString().trim();
  assert(f.broker.store.runs.has(runId));
  assert.equal(f.launches[1].renewals, 0);
});

test('cleanup failures remain explicit after startup, finish, and close, and the run stays archived', async t => {
  const setup = await fixture(t, { managed: ['cleanup-denied'], wrongProcess: true });
  await assert.rejects(new QAClient(setup.file).openFixtureSession(), error =>
    error.message === 'fixture_cleanup_failed' && error.failure.retrySafe === false);
  assert.equal(setup.leases.size, 0);
  assert.equal(setup.broker.store.runs.size, 0);
  const f = await fixture(t, { managed: ['cleanup-denied'] });
  const session = await new QAClient(f.file).openFixtureSession();
  await assert.rejects(session.finish(), error => error.message === 'fixture_cleanup_failed' && error.failure.retrySafe === false);
  assert.equal(f.leases.size, 0);
  assert.equal((await session.task('qa_runs')).total, 1);
  await assert.rejects(session.close(), /fixture_cleanup_failed/);
  assert(f.broker.store.runs.has(session.runId));
  const leaseLoss = await fixture(t, { failRelease: true });
  const other = await new QAClient(leaseLoss.file).openFixtureSession();
  await assert.rejects(other.close(), /release_unconfirmed/);
  assert.deepEqual(await leaseLoss.launches[0].launch.done, { reason: 'closed', cleaned: true });
  assert(leaseLoss.broker.store.runs.has(other.runId));
});

test('missing heartbeat, hard expiry, and broker shutdown stop managed fixtures and preserve journals', async t => {
  const f = await fixture(t, { managed: ['client-lost'] });
  const result = await f.raw('/api/window-sessions', f.server.agentToken, { managedFixture: true });
  assert.equal(result.status, 201);
  const abandoned = await result.json();
  const alien = await f.raw('/api/window-sessions/current/tasks/qa_heartbeat', f.server.agentToken, {});
  assert.equal(alien.status, 401);
  assert.deepEqual(await f.launches[0].launch.done, { reason: 'fixture_client_lost', cleaned: true });
  await until(() => f.leases.size === 0, 'Heartbeat loss must release the native lease');
  assert.equal(f.broker.store.get(abandoned.runId).events.at(-1).kind, 'run-end');
  const lost = await f.raw('/api/window-sessions/current/tasks/qa_heartbeat', abandoned.token, {});
  assert.deepEqual(await lost.json(), { active: false });

  const short = await fixture(t, { lifetimeMs: 350 });
  const expired = await new QAClient(short.file).openFixtureSession();
  assert.equal((await short.launches[0].launch.done).cleaned, true);
  await until(() => short.leases.size === 0, 'Hard expiry must release the native lease');
  assert(short.broker.store.runs.has(expired.runId));

  const keeper = await new QAClient(f.file).openFixtureSession();
  const stopped = f.launches.at(-1);
  await f.restart();
  assert.deepEqual(await stopped.launch.done, { reason: 'closed', cleaned: true });
  assert.equal(f.broker.store.get(keeper.runId).events.at(-1).kind, 'run-end');
});

test('closing a lane does not shut down its shared exporter or remove the MP4', { timeout: 18000 }, async t => {
  const f = await fixture(t, { encodedFixture: true });
  const session = await new QAClient(f.file).openWindowSession(windows[0]);
  await delay(250);
  await session.task('qa_check', { expected: 0, title: 'Before restart' });
  await delay(250);
  await session.finish();
  await session.close();
  const state = await f.broker.exports.wait(session.runId, 12000, 'qa');
  assert.equal(state.status, 'ready', JSON.stringify(state));
  const route = `/api/runs/${session.runId}/qa-v5-recording.mp4`;
  const human = await f.pair();
  const response = await f.raw(route, null, undefined, 'GET', human);
  assert.equal(response.headers.get('content-type'), 'video/mp4');
  const original = Buffer.from(await response.arrayBuffer());
  assert(original.length > 1000);
  await f.restart();
  const restartedHuman = await f.pair();
  const restarted = await f.raw(route, null, undefined, 'GET', restartedHuman);
  assert.equal(restarted.status, 200);
  assert.deepEqual(Buffer.from(await restarted.arrayBuffer()), original);
  assert.equal((await f.raw(route, f.server.agentToken)).status, 404);
});

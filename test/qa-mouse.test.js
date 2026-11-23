import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Broker } from '../src/qa-broker.js';
import { RunStore, opaque } from '../src/qa-store.js';
import { createQAServer } from '../src/qa-server.js';
import { frameGeometry } from '../src/qa-geometry.js';
import { controlRequestSchema, controlTargetSchema } from '../src/control.js';
import { tasks } from '../src/qa-contract.js';
import { mediaProcess } from '../src/qa-export.js';
import { qaEditPlan } from '../web/qa-edit.js';

const target = { windowId: 9, pid: 42, bundleId: '' };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-generic-'));
  const state = { windows: [{ ...target, displayName: 'Fixture application', title: 'Fixture',
    processStartedAt: 123, windowRectPoints: [10, 20, 640, 400] }], started: 123,
    rect: [10, 20, 640, 400], image: Buffer.from([255, 216, 255, 217]), calls: [], generation: 0 };
  let receive, sequence = 0, valid;
  const emit = () => receive?.({ image: state.image, header: {
    protocol: 1, type: 'frame', ...target, sequence: ++sequence, width: 640, height: 400,
    contentRectPixels: [0, 0, 640, 400], initialWindowRectPoints: [...state.rect],
    processStartedAt: state.started, captureTimeSeconds: 10, sentUptimeSeconds: 10.01,
    contentScale: 1, scaleFactor: 1,
  } });
  const native = {
    acquire: async takeover => {
      state.calls.push(['acquire', takeover]);
      assert.equal(takeover, false, 'Generic discovery never takes over');
      return { token: 'a'.repeat(64), generation: ++state.generation, owner: 'qa:fixture', expiresAt: Date.now() / 1000 + 30 };
    },
    release: async () => { state.calls.push(['release']); },
    windows: async lease => {
      assert.deepEqual(Object.keys(lease).sort(), ['generation', 'token'],
        'Native stream accepts the lease proof, not acquisition metadata');
      state.calls.push(['windows']);
      if (state.discoveryError) throw new Error('host_unavailable');
      return structuredClone(state.windows);
    },
    stream: async (_lease, selected, signal, consume) => {
      assert.deepEqual(selected, target);
      receive = consume; emit();
      const timer = setInterval(emit, 25);
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      clearInterval(timer); receive = null;
    },
    observe: async () => {
      state.calls.push(['observe']); await delay(15);
      valid = opaque();
      return { observationId: valid, expiresAt: Date.now() / 1000 + 30,
        snapshot: { target, processStartedAt: state.started, windowRectPoints: [...state.rect], elements: [] } };
    },
    mouse: async (_lease, selected, id, mouse) => {
      assert.deepEqual(selected, target);
      assert.equal(id, valid, 'The broker forwards the latest single-use native observation');
      valid = null;
      state.calls.push(['mouse', mouse]);
      if (state.inputError) throw new Error(state.inputError);
      await delay(75);
    },
  };
  const store = new RunStore(path.join(root, 'runs')), broker = new Broker(store, native, { frameWaitMs: 300, ...options });
  t.after(async () => { await broker.close(); fs.rmSync(root, { recursive: true }); });
  return { root, state, broker, store, native };
}
async function start(broker) {
  const targets = await broker.task('agent', 'qa_targets', {});
  assert.deepEqual(targets.windows[0].target, target);
  return broker.task('agent', 'qa_start', { target: targets.windows[0].target, title: 'Generic window QA' });
}
const click = { kind: 'click', x: 0.25, y: 0.5, button: 'left', count: 1 };

test('bare executable runs persist the exact discovered application name and adopt their first named QA check', async t => {
  const { broker, store, state } = fixture(t);
  state.windows[0].displayName = 'Nimbus Studio';
  state.windows[0].title = 'Private document, not the application';
  await broker.task('agent', 'qa_targets', {});
  const { runId } = await broker.task('agent', 'qa_start', { target });
  const original = JSON.stringify(store.get(runId).events[0]);
  assert.equal((await broker.task('agent', 'qa_runs', {})).runs[0].title, 'Nimbus Studio - QA session');
  const observed = await broker.task('agent', 'qa_observe', { runId });
  await broker.task('agent', 'qa_check', { runId, kind: 'visual', title: 'Toolbar remains visible',
    expected: 'Toolbar is visible', actual: 'Toolbar is visible', outcome: 'pass', observationId: observed.observationId });
  const replay = await broker.task('agent', 'qa_replay', { runId });
  assert.equal(replay.title, 'Nimbus Studio - Toolbar remains visible');
  assert.equal(replay.applicationName, 'Nimbus Studio');
  assert.equal(store.history()[0].labels.title, replay.title);
  assert.equal(JSON.stringify(store.get(runId).events[0]), original);
});

test('explicit and contextual QA purposes remain authoritative through named checks', async t => {
  for (const input of [{ title: 'Nimbus Studio - Open preferences' },
    { context: 'Open preferences' + ' '.repeat(580) }]) {
    const { broker, state } = fixture(t);
    state.windows[0].displayName = 'Nimbus Studio';
    await broker.task('agent', 'qa_targets', {});
    const started = await broker.task('agent', 'qa_start', { target, ...input });
    assert.equal(started.title, 'Nimbus Studio - Open preferences');
    const observed = await broker.task('agent', 'qa_observe', { runId: started.runId });
    await broker.task('agent', 'qa_check', { runId: started.runId, kind: 'visual', title: 'Different check',
      expected: 'Visible', actual: 'Visible', outcome: 'pass', observationId: observed.observationId });
    assert.equal((await broker.task('agent', 'qa_replay', { runId: started.runId })).title, started.title);
    assert.equal((await broker.task('agent', 'qa_status', {})).title, started.title);
  }
});

test('generic targets and typed mouse validate bare identities and exact bounded coordinates', () => {
  assert.deepEqual(controlTargetSchema.parse(target), target);
  const request = { operation: 'mouse', target, lease: { token: 'a'.repeat(64), generation: 1 },
    observationId: 'b'.repeat(32), mouse: click };
  for (const mouse of [click, { ...click, button: 'right', count: 2 }, { kind: 'move', x: 0, y: 0.99999 },
    { kind: 'drag', x: 0.1, y: 0.2, toX: 0.9, toY: 0.8, durationMs: 500 },
    { kind: 'scroll', x: 0.5, y: 0.5, deltaX: -600, deltaY: 600 }])
    assert.deepEqual(controlRequestSchema.parse({ ...request, mouse }).mouse, mouse);
  for (const mouse of [{ ...click, x: NaN }, { ...click, x: 1 }, { ...click, y: -0.1 },
    { ...click, button: 'middle' }, { ...click, count: 3 }, { ...click, shell: 'anything' },
    { kind: 'drag', x: 0, y: 0, toX: 1, toY: 0.2, durationMs: 300 },
    { kind: 'drag', x: 0, y: 0, toX: 0.5, toY: 0.2, durationMs: 1001 },
    { kind: 'scroll', x: 0, y: 0, deltaX: 0, deltaY: 601 }])
    assert.equal(controlRequestSchema.safeParse({ ...request, mouse }).success, false);
  for (const bundleId of ['com.factory.applets.host', 'com.apple.iphonesimulator', 'com.apple.dt.Devices',
    'x'.repeat(256), 'com.*', 'bad\nbundle'])
    assert.equal(controlTargetSchema.safeParse({ ...target, bundleId }).success, false);
  assert.equal(tasks.qa_act.safeParse({ runId: 'a'.repeat(32), action: 'increment', observationId: 'b'.repeat(32), mouse: click }).success, false);
  assert.equal(tasks.qa_check.safeParse({ runId: 'a'.repeat(32), title: 'Not a visual variant', expected: 'text' }).success, false);
});

test('discovery is serialized, does not take human control, and always releases temporary leases', async t => {
  const { broker, state } = fixture(t);
  await broker.task('agent', 'qa_status', {});
  assert.deepEqual(state.calls, []);
  await Promise.all([broker.task('agent', 'qa_targets', {}), broker.task('human', 'qa_targets', {})]);
  assert.deepEqual(state.calls.map(c => c[0]), ['acquire', 'windows', 'release', 'acquire', 'windows', 'release']);
  assert.equal(broker.lease, undefined);
  state.windows = [];
  assert.deepEqual((await broker.task('agent', 'qa_targets', {})).windows, []);
  assert.equal(state.calls.at(-1)[0], 'release');
  state.discoveryError = true;
  await assert.rejects(broker.task('agent', 'qa_targets', {}), /host_unavailable/);
  assert.equal(state.calls.at(-1)[0], 'release');
  const denied = fixture(t, { applications: [] });
  assert.deepEqual((await denied.broker.task('agent', 'qa_targets', {})).windows, []);
  await assert.rejects(denied.broker.task('agent', 'qa_start', { target }), /application_unavailable/);
  assert.deepEqual(denied.state.calls, []);
});

test('explicit generic selection is fresh and process-bound, while no-target default never guesses another app', async t => {
  const { broker, state } = fixture(t);
  await assert.rejects(broker.task('agent', 'qa_start', { target }), /target_discovery_required/);
  assert.deepEqual(state.calls, []);
  await assert.rejects(broker.task('agent', 'qa_start', {}), /target_unavailable/);
  assert.equal(broker.lease, null);
  await broker.task('agent', 'qa_targets', {});
  state.windows[0].processStartedAt++;
  await assert.rejects(broker.task('agent', 'qa_start', { target }), /target_mismatch/);
  assert.equal(broker.lease, null);
  state.windows[0].processStartedAt = state.started;
  const { runId, applicationId } = await start(broker);
  assert.equal((await broker.task('agent', 'qa_start', { resumeRunId: runId })).resumed, true);
  assert.equal((await broker.task('agent', 'qa_start', { resumeRunId: runId, applicationId })).resumed, true);
  await assert.rejects(broker.task('agent', 'qa_start', { target: { ...target, windowId: 99 } }), /application_mismatch|target_mismatch/);
  state.started++;
  await assert.rejects(broker.task('agent', 'qa_start', { resumeRunId: runId }), /target_mismatch/);
  await assert.rejects(broker.task('agent', 'qa_observe', { runId }), /frame_geometry_stale/);
});

test('discovery during human ownership shares the lease without takeover or observation authority', async t => {
  const { broker, state } = fixture(t);
  await broker.task('human', 'qa_targets', {});
  const { runId } = await broker.task('human', 'qa_start', { target });
  const count = state.calls.length;
  const grant = broker.owner.grant;
  await broker.task('agent', 'qa_targets', {});
  assert.deepEqual(state.calls.slice(count).map(c => c[0]), ['windows']);
  assert.equal(broker.owner.actor, 'human');
  assert.equal(broker.owner.grant, grant);
  const cached = await broker.task('agent', 'qa_observe', { runId, includeImage: true });
  assert.equal(cached.canAct, false);
  await assert.rejects(broker.task('agent', 'qa_start', { resumeRunId: runId }), /stale_control/);
});

test('explicit Mac allowlists filter discovery and cannot be bypassed by a bare or iOS identity', async t => {
  const configured = { id: 'editor', name: 'Fixture editor', platform: 'macos', bundleId: 'com.example.Editor' };
  const { broker, state } = fixture(t, { applications: [configured] });
  state.windows.push({ ...state.windows[0], windowId: 10, bundleId: configured.bundleId });
  const discovered = await broker.task('agent', 'qa_targets', {});
  assert.deepEqual(discovered.windows.map(w => w.bundleId), [configured.bundleId]);
  const before = state.calls.length;
  await assert.rejects(broker.task('agent', 'qa_start', { target }), /application_unavailable/);
  assert.equal(state.calls.length, before);
  const ios = fixture(t, { applications: [{ ...configured, platform: 'ios-simulator',
    simulatorUdid: 'abcdef12-1234-4234-8234-123456789012' }] });
  assert.deepEqual((await ios.broker.task('agent', 'qa_targets', {})).windows, []);
  await assert.rejects(ios.broker.task('agent', 'qa_start', { applicationId: 'editor',
    target: { ...target, bundleId: configured.bundleId } }), /application_mismatch/);
  assert.deepEqual(ios.state.calls, []);
});

test('raw frame geometry rejects PID reuse, movement, stale capture, padding and oversized mappings', async t => {
  const { broker } = fixture(t);
  const { runId } = await start(broker);
  const observation = await broker.task('agent', 'qa_observe', { runId, includeImage: true });
  assert.equal(observation.actual, null);
  assert.deepEqual(observation.windowRectPoints, [10, 20, 640, 400]);
  assert.deepEqual(observation.imageGeometry.contentRectPixels, [0, 0, 640, 400]);
  const frame = broker.observation.frame, snapshot = broker.observation.snapshot;
  const recorded = broker.store.get(runId).events.find(e => e.kind === 'frame' && e.frameId === observation.frameEvidence.afterFrameId);
  assert.equal(recorded.brokerFrameVersion, observation.image.version, 'Returned pixels and evidence links name the same frame');
  for (const mutate of [
    h => { h.pid++; }, h => { h.windowId++; }, h => { h.bundleId = 'other'; },
    h => { h.processStartedAt++; }, h => { h.initialWindowRectPoints[0]++; },
    h => { h.initialWindowRectPoints[2]++; }, h => { h.width = 9000; },
    h => { h.contentRectPixels[2] = 6410; }, h => { h.contentRectPixels[0] = -1; },
    h => { h.contentRectPixels[3] /= 2; }, h => { h.captureTimeSeconds -= 3; },
  ]) {
    const copy = { ...frame, header: structuredClone(frame.header) };
    mutate(copy.header);
    assert.throws(() => frameGeometry(copy, snapshot, 123), /frame_geometry_stale/);
  }
  assert.throws(() => frameGeometry({ ...frame, receivedMono: performance.now() - 2001 }, snapshot, 123), /frame_geometry_stale/);
});

test('generic mouse consumes observation before dispatch, does not assert success, and fences uncertain replies', async t => {
  const { broker, state, store } = fixture(t);
  const { runId } = await start(broker);
  const initial = await broker.task('agent', 'qa_observe', { runId, includeImage: true });
  const acted = await broker.task('agent', 'qa_act', { runId, action: 'mouse', observationId: initial.observationId, mouse: click });
  assert.equal(acted.acknowledged, true);
  assert.equal(acted.assertion, false);
  assert.equal(acted.actual, null);
  assert.ok(acted.image.data);
  assert.equal(store.get(runId).events.filter(e => e.kind === 'assertion').length, 0);
  await assert.rejects(broker.task('agent', 'qa_act', { runId, action: 'mouse', observationId: initial.observationId, mouse: click }), /observation_stale/);
  assert.equal(state.calls.filter(c => c[0] === 'mouse').length, 1);
  const next = await broker.task('agent', 'qa_observe', { runId });
  state.inputError = 'action_uncertain';
  await assert.rejects(broker.task('agent', 'qa_act', { runId, action: 'mouse', observationId: next.observationId,
    mouse: { kind: 'drag', x: 0.1, y: 0.2, toX: 0.8, toY: 0.2, durationMs: 500 } }), /action_uncertain/);
  assert.equal(broker.observation, null);
  assert.equal(store.get(runId).events.at(-1).status, 'uncertain');
  await assert.rejects(broker.task('agent', 'qa_check', { runId, title: 'Count is unsupported', expected: 1 }), /application_not_supported/);
});

test('real MCP exposes generic discovery, pixels, mouse, caller-assessed checks and actual default MP4 footage', async t => {
  const { root, broker, state, store } = fixture(t);
  const jpeg = path.join(root, 'green.jpg');
  await mediaProcess('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=lime:s=640x400',
    '-frames:v', '1', '-threads', '2', jpeg]);
  state.image = fs.readFileSync(jpeg);
  const service = createQAServer(broker), origin = await service.listen(0);
  const credentials = path.join(root, 'client.json');
  fs.writeFileSync(credentials, JSON.stringify({ origin, token: service.agentToken }), { mode: 0o600 });
  const client = new Client({ name: 'generic-window-test', version: '1' });
  t.after(async () => { await client.close(); await service.close(); });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../src/qa-mcp.js', import.meta.url)), credentials], stderr: 'pipe' }));
  const call = async (name, args = {}) => {
    const reply = await client.callTool({ name, arguments: args });
    assert.ok(!reply.isError, JSON.stringify(reply));
    return reply.structuredContent;
  };
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 10);
  assert.ok(tools.find(t => t.name === 'qa_act').inputSchema.properties.mouse);
  assert.ok(tools.find(t => t.name === 'qa_check').inputSchema.properties.outcome);
  const discovered = await call('qa_targets');
  const { runId } = await call('qa_start', { target: discovered.windows[0].target });
  const initial = await call('qa_observe', { runId, includeImage: true });
  const after = await call('qa_act', { runId, action: 'mouse', observationId: initial.observationId, mouse: click });
  await delay(80);
  const checked = await call('qa_check', { runId, kind: 'visual', observationId: after.observationId,
    title: 'Fixture stays green', expected: 'The window is green', actual: 'The screenshot is green', outcome: 'pass' });
  assert.deepEqual(checked.assessment, { source: 'caller', actor: 'agent', serverVerified: false });
  assert.equal(checked.expected, 'The window is green');
  const second = await call('qa_observe', { runId, includeImage: true });
  const failure = await call('qa_check', { runId, kind: 'visual', observationId: second.observationId,
    title: 'Deliberate visual mismatch', expected: 'The window is blue', actual: 'The screenshot is green', outcome: 'fail' });
  assert.equal(failure.status, 'fail');
  await call('qa_finish', { runId });
  const report = await call('qa_report', { runId, waitMs: 30000 });
  assert.equal(report.export.status, 'ready', JSON.stringify(report));
  assert.deepEqual(report.checks.map(c => c.kind), ['visual', 'visual']);
  assert.ok(report.edit.segments.some(s => s.role === 'preceding-input'), 'Mouse context remains conservatively associated');
  assert.ok(report.edit.segments.some(s => s.role === 'assessed-frame'), 'Assessed raw frame evidence is not replaced by later footage');
  assert.match(report.reportMarkdown, /not server-verified/);
  const mp4 = report.artifacts['qa-v4-recording.mp4'];
  const probe = JSON.parse(await mediaProcess('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', mp4]));
  assert.ok(Number(probe.format.duration) > 0);
  const pixels = path.join(root, 'decoded.rgb');
  await mediaProcess('ffmpeg', ['-v', 'error', '-i', mp4, '-vf', 'crop=2:2:300:200,scale=1:1',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', pixels]);
  const rgb = fs.readFileSync(pixels);
  assert.ok([...rgb].some((v, i) => i % 3 === 1 && v > 180), 'Actual encoded check footage contains the green captured frame');
  const original = store.get(runId).events;
  const mouseStep = original.find(e => e.kind === 'step-start' && e.operation === 'mouse');
  for (const mutate of [
    rows => { rows.find(e => e.kind === 'action' && e.stepId === mouseStep.stepId).status = 'uncertain'; },
    rows => { rows.find(e => e.kind === 'action-attempt' && e.stepId === mouseStep.stepId).actionId = 'f'.repeat(32); },
    rows => { rows.find(e => e.kind === 'observation' && e.stepId === mouseStep.stepId).snapshot.processStartedAt++; },
    rows => { rows.find(e => e.kind === 'observation' && e.stepId === mouseStep.stepId).snapshot.target.pid++; },
    rows => { rows.find(e => e.kind === 'step-end' && e.stepId === mouseStep.stepId).actor = 'human'; },
  ]) {
    const copy = structuredClone(original); mutate(copy);
    const edit = qaEditPlan(copy, copy.at(-1).elapsedMs);
    assert.ok(!edit.available || !edit.segments.some(s => s.role === 'preceding-input'),
      'Uncertain or mismatched generic input must not enter the QA context');
  }
  for (const mutate of [
    e => { e.assessment.serverVerified = true; }, e => { e.afterFrameId = 'f'.repeat(32); },
    e => { e.actual = 99; }, e => { e.assessment.actor = 'human'; },
  ]) {
    const copy = structuredClone(original);
    mutate(copy.find(e => e.kind === 'assertion'));
    assert.equal(qaEditPlan(copy, copy.at(-1).elapsedMs).available, false);
  }
});

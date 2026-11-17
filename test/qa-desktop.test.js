import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Broker, nativeAdapter } from '../src/qa-broker.js';
import { RunStore, opaque } from '../src/qa-store.js';
import { createQAServer } from '../src/qa-server.js';
import { controlTargetSchema, controlRequestSchema } from '../src/control.js';
import { decodeStream, streamTargetSchema } from '../src/stream.js';
import { frameGeometry } from '../src/qa-geometry.js';
import { mediaProcess } from '../src/qa-export.js';
import { qaEditPlan } from '../web/qa-edit.js';
import { sameTarget, targetLabel } from '../web/target-identity.js';

const target = { kind: 'desktop', displayId: 22, displayUUID: 'abcdef12-1234-4234-8234-123456789012' };
const secondary = { ...target, displayId: 11, displayUUID: 'abcdef12-1234-4234-8234-123456789013' };
const configuration = { boundsPoints: [-640, -100, 640, 400], pixelWidth: 1280, pixelHeight: 800,
  rotation: 0, scaleX: 2, scaleY: 2 };
const click = { kind: 'click', x: 0.25, y: 0.5, button: 'left', count: 1 };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-desktop-'));
  const state = { calls: [], configuration: structuredClone(configuration), selected: null,
    displays: [{ ...secondary, main: false, displayConfiguration: structuredClone(configuration) },
      { ...target, main: true, displayConfiguration: structuredClone(configuration) }],
    image: Buffer.from([255, 216, 255, 217]), observeMs: 15, startupMs: 0, idle: false,
    online: true, generation: 0, inputError: null };
  let receive, sequence = 0, valid;
  const snapshot = () => ({ target: state.selected, displayConfiguration: structuredClone(state.configuration), elements: [] });
  const emit = () => receive?.({ image: state.image, header: { protocol: 1, type: 'frame', ...state.selected,
    sequence: ++sequence, width: 640, height: 400, mediaType: 'image/jpeg', bytes: state.image.length,
    contentRectPixels: [0, 0, 320, 200], displayConfiguration: structuredClone(state.configuration),
    captureTimeSeconds: performance.now() / 1000, sentUptimeSeconds: performance.now() / 1000,
    contentScale: 1, scaleFactor: 2, replacedFrames: 0 } });
  const native = {
    acquire: async (takeover, ttlSeconds) => {
      state.calls.push(['acquire', takeover, ttlSeconds]);
      return { token: 'a'.repeat(64), generation: ++state.generation, owner: 'qa:synthetic', expiresAt: Date.now() / 1000 + 3600 };
    },
    release: async proof => {
      assert.deepEqual(Object.keys(proof).sort(), ['generation', 'token']);
      state.calls.push(['release']);
    },
    windows: async proof => {
      assert.deepEqual(Object.keys(proof).sort(), ['generation', 'token']);
      state.calls.push(['discover']);
      return { windows: [], displays: structuredClone(state.displays) };
    },
    stream: async (_proof, selected, signal, consume) => {
      state.calls.push(['stream']);
      state.selected = selected;
      await delay(state.startupMs);
      if (signal.aborted) return;
      receive = consume; emit();
      const timer = setInterval(() => {
        if (!state.idle) emit();
        else consume({ header: { type: 'heartbeat' }, image: Buffer.alloc(0) });
      }, 25);
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      clearInterval(timer); receive = null;
    },
    observe: async (_proof, selected) => {
      state.calls.push(['observe']);
      assert.deepEqual(selected, state.selected);
      const observed = snapshot();
      await delay(state.observeMs);
      state.lastObservedAt = performance.now();
      valid = { id: opaque(), snapshot: observed };
      return { observationId: valid.id, expiresAt: Date.now() / 1000 + 30, snapshot: observed };
    },
    mouse: async (_proof, selected, observationId, mouse) => {
      assert.deepEqual(selected, state.selected);
      assert.equal(observationId, valid?.id);
      const observed = valid; valid = null;
      if (!state.online || JSON.stringify(snapshot()) !== JSON.stringify(observed.snapshot)) throw new Error('observation_stale');
      state.calls.push(['mouse', structuredClone(mouse)]);
      if (state.inputError) throw new Error(state.inputError);
      await delay(30);
    },
  };
  const store = new RunStore(path.join(root, 'runs'));
  const broker = new Broker(store, native, { frameWaitMs: 50, ...options });
  t.after(async () => { await broker.close(); fs.rmSync(root, { recursive: true }); });
  return { root, broker, store, native, state };
}

test('Retina attachment coordinates map the whole captured JPEG, not its top-left quarter', () => {
  const displayConfiguration = { boundsPoints: [0, 0, 1408, 881], pixelWidth: 2816, pixelHeight: 1762,
    rotation: 0, scaleX: 2, scaleY: 2 };
  const snapshot = { target, displayConfiguration, elements: [] };
  const header = { ...target, displayConfiguration, width: 2048, height: 1281,
    contentRectPixels: [0.18161180476732852, 0, 1023.6367763904655, 640.5],
    scaleFactor: 2, contentScale: 0.7270147800445557, captureTimeSeconds: 1, sentUptimeSeconds: 1.01 };
  const { imageGeometry } = frameGeometry({ header, receivedMono: performance.now() }, snapshot);
  const [x, y, width, height] = imageGeometry.contentRectPixels;
  assert.ok(Math.abs(width - 2048) < 1);
  assert.equal(height, 1281);
  assert.ok(Math.abs((1024 - x) / width - 0.5) < 0.001);
  assert.equal((640.5 - y) / height, 0.5);
});

test('desktop target is strict, canonical and distinct from legacy windows at every JS boundary', async () => {
  for (const schema of [controlTargetSchema, streamTargetSchema]) {
    assert.deepEqual(schema.parse(target), target);
    for (const bad of [{ ...target, pid: 0 }, { ...target, windowId: 1 }, { ...target, bundleId: '' },
      { ...target, displayId: 0 }, { ...target, displayId: 2 ** 32 }, { ...target, displayId: true },
      { ...target, displayUUID: target.displayUUID.toUpperCase() }, { ...target, displayUUID: target.displayUUID + '\n' },
      { ...target, displayUUID: 'not-a-uuid' }, { displayId: 22, displayUUID: target.displayUUID }])
      assert.equal(schema.safeParse(bad).success, false, JSON.stringify(bad));
  }
  assert.equal(sameTarget(target, { windowId: 22, pid: 2, bundleId: '' }), false);
  assert.equal(targetLabel({ ...target, main: true }), 'Desktop · Main display 22');
  assert.equal(controlRequestSchema.safeParse({ operation: 'press', target, observationId: 'b'.repeat(32),
    lease: { token: 'a'.repeat(64), generation: 1 }, elementId: 'relay-increment' }).success, false);
  const header = { protocol: 1, type: 'frame', ...target, sequence: 1, mediaType: 'image/jpeg',
    width: 640, height: 400, contentRectPixels: [0, 0, 640, 400], displayConfiguration: configuration,
    captureTimeSeconds: 1, sentUptimeSeconds: 1.01, scaleFactor: 2, contentScale: 1, replacedFrames: 0, bytes: 4 };
  async function decode(h) {
    const json = Buffer.from(JSON.stringify(h)), prefix = Buffer.alloc(4); prefix.writeUInt32BE(json.length);
    return Array.fromAsync(decodeStream([Buffer.concat([prefix, json, Buffer.from([255, 216, 255, 217])])]));
  }
  assert.deepEqual((await decode(header))[0].header, header);
  for (const extra of [{ processStartedAt: 0 }, { initialWindowRectPoints: configuration.boundsPoints }, { pid: 0 }])
    await assert.rejects(decode({ ...header, ...extra }));
});

test('discovery proves lease shape, main selection is not array order, status is read-only', async t => {
  const { broker, state } = fixture(t);
  const status = await broker.task('agent', 'qa_status', {});
  assert.equal(status.desktopAllowed, true);
  assert.deepEqual(status.desktopCapabilities.act, ['mouse']);
  assert.deepEqual(state.calls, []);
  const found = await broker.task('agent', 'qa_targets', {});
  assert.deepEqual(found.displays.map(d => d.main), [false, true]);
  assert.deepEqual(found.displays[1].target, target);
  assert.deepEqual(found.displays[1].displayConfiguration, configuration);
  assert.deepEqual(state.calls.map(c => c[0]), ['acquire', 'discover', 'release']);
  assert.equal(state.calls[0][2], 30);
  const started = await broker.task('agent', 'qa_start', {});
  assert.deepEqual(started.target, target);
  assert.equal(started.applicationId, 'desktop');
  assert.equal(broker.store.get(started.runId).events[0].labels.processStartedAt, undefined);
  assert.equal((await broker.task('agent', 'qa_start', { resumeRunId: started.runId })).resumed, true);
  await assert.rejects(broker.task('agent', 'qa_start', { target: secondary }), /target_mismatch/);
});

test('explicit display requires fresh discovery and no-main discovery never guesses', async t => {
  const { broker } = fixture(t);
  await assert.rejects(broker.task('agent', 'qa_start', { target: secondary }), /target_discovery_required/);
  await broker.task('agent', 'qa_targets', {});
  broker.discoveredAt -= 30001;
  await assert.rejects(broker.task('agent', 'qa_start', { target: secondary }), /target_discovery_required/);
  await broker.task('agent', 'qa_targets', {});
  assert.deepEqual((await broker.task('agent', 'qa_start', { target: secondary })).target, secondary);
  const absent = fixture(t); absent.state.displays.forEach(d => { d.main = false; });
  await assert.rejects(absent.broker.task('agent', 'qa_start', {}), /target_unavailable/);
  assert.equal(absent.broker.lease, null);
});

test('every explicit application array denies desktop without native calls or accidental defaults', async t => {
  for (const applications of [[], [{ id: 'relaymac', name: 'RelayMac', platform: 'macos', bundleId: 'com.factory.applets.RelayMac' }]]) {
    const { broker, state } = fixture(t, { applications });
    assert.equal((await broker.task('agent', 'qa_status', {})).desktopAllowed, false);
    await assert.rejects(broker.task('agent', 'qa_start', { target }), /application_not_authorized/);
    assert.deepEqual(state.calls, []);
    assert.deepEqual((await broker.task('agent', 'qa_targets', {})).displays, []);
    const adapter = nativeAdapter({ transport: 'factory', applications });
    for (const invoke of [() => adapter.stream({}, target, undefined, () => {}),
      () => adapter.observe({}, target), () => adapter.mouse({}, target, 'b'.repeat(32), click)])
      await assert.rejects(invoke, /application_not_authorized/);
  }
});

test('new no-target desktop start uses main display even after an owned secondary selection', async t => {
  const { broker } = fixture(t);
  await broker.command('human', { op: 'connect' });
  await broker.command('human', { op: 'select', target: secondary });
  await broker.command('human', { op: 'take' });
  assert.deepEqual((await broker.task('human', 'qa_start', {})).target, target);
});

test('desktop geometry binds exact identity, origin, size, resolution, scale and rotation without process sentinels', async t => {
  const { broker } = fixture(t);
  const { runId } = await broker.task('agent', 'qa_start', {});
  const result = await broker.task('agent', 'qa_observe', { runId, includeImage: true });
  assert.deepEqual(result.displayConfiguration, configuration);
  assert.equal(result.windowRectPoints, undefined);
  assert.equal(result.processStartedAt, undefined);
  assert.deepEqual(result.target, target);
  const frame = broker.observation.frame, snapshot = broker.observation.snapshot;
  const rect = result.displayConfiguration.boundsPoints;
  assert.deepEqual([rect[0] + click.x * rect[2], rect[1] + click.y * rect[3]], [-480, 100]);
  for (const mutate of [
    h => { h.displayId++; }, h => { h.displayUUID = secondary.displayUUID; },
    h => { h.displayConfiguration.boundsPoints[0]++; }, h => { h.displayConfiguration.boundsPoints[1]++; },
    h => { h.displayConfiguration.boundsPoints[2]++; }, h => { h.displayConfiguration.pixelWidth++; },
    h => { h.displayConfiguration.pixelHeight++; }, h => { h.displayConfiguration.rotation = 90; },
    h => { h.displayConfiguration.scaleX = 1; }, h => { h.displayConfiguration.scaleY = 1; },
    h => { h.captureTimeSeconds -= 3; },
  ]) {
    const copy = { ...frame, header: structuredClone(frame.header) }; mutate(copy.header);
    assert.throws(() => frameGeometry(copy, snapshot), /frame_geometry_stale/);
  }
  assert.throws(() => frameGeometry({ ...frame, receivedMono: performance.now() - 2001 }, snapshot), /frame_geometry_stale/);
});

test('four-second native observation plus idle heartbeats requires genuinely new capture, using startup budget', async t => {
  const { broker, state, store } = fixture(t);
  state.idle = true; state.observeMs = 4100; state.startupMs = 1650;
  const { runId } = await broker.task('agent', 'qa_start', {});
  const initialVersion = broker.latest.version;
  const beforeCalls = state.calls.filter(c => c[0] === 'observe').length;
  const observation = await broker.task('agent', 'qa_observe', { runId, includeImage: true });
  assert.equal(state.calls.filter(c => c[0] === 'observe').length, beforeCalls + 1, 'One observation roundtrip does not age the refreshed screenshot again');
  assert.ok(observation.image.version > initialVersion, 'Heartbeats cannot stand in for a new image');
  assert.ok(observation.image.ageMs < 2000);
  assert.ok(broker.observation.frame.header.captureTimeSeconds * 1000 >= state.lastObservedAt,
    'The refreshed image was captured after the slow native response, not relabeled as fresh');
  assert.ok(store.get(runId).events.some(e => e.kind === 'gap' && e.reason === 'capture_refresh'));
  const after = await broker.task('agent', 'qa_act', { runId, action: 'mouse', observationId: observation.observationId, mouse: click });
  assert.ok(after.image.version > observation.image.version, 'Post-action evidence requires a new capture even on an idle display');
  assert.equal(after.acknowledged, true);
  assert.equal(after.assertion, false);
  assert.equal(state.calls.filter(c => c[0] === 'mouse').length, 1);
  assert.equal(broker.observation.snapshot.processStartedAt, undefined);
});

test('visual checks expire even while native verification is in flight', async t => {
  const { broker, state } = fixture(t);
  const { runId } = await broker.task('agent', 'qa_start', {});
  const observed = await broker.task('agent', 'qa_observe', { runId });
  broker.observation.expires = Date.now() + 30;
  state.observeMs = 80;
  await assert.rejects(broker.task('agent', 'qa_check', { runId, kind: 'visual',
    observationId: observed.observationId, title: 'Expires during verification',
    expected: 'Green', actual: 'Green', outcome: 'pass' }), /observation_stale/);
  assert.equal(broker.observation, null);
});

test('desktop mouse forwarding is typed, single-use, stale/configuration fenced and never retried on uncertainty', async t => {
  const { broker, state, store } = fixture(t);
  const { runId } = await broker.task('agent', 'qa_start', {});
  const commands = [{ kind: 'move', x: 0, y: 0.999 }, click, { ...click, button: 'right', count: 2 },
    { kind: 'drag', x: 0.1, y: 0.2, toX: 0.8, toY: 0.2, durationMs: 1000 },
    { kind: 'scroll', x: 0.5, y: 0.5, deltaX: -600, deltaY: 600 }];
  for (const mouse of commands) {
    const observed = await broker.task('agent', 'qa_observe', { runId });
    await broker.task('agent', 'qa_act', { runId, action: 'mouse', observationId: observed.observationId, mouse });
    assert.deepEqual(state.calls.findLast(c => c[0] === 'mouse')[1], mouse);
    await assert.rejects(broker.task('agent', 'qa_act', { runId, action: 'mouse', observationId: observed.observationId, mouse }), /observation_stale/);
  }
  const expired = await broker.task('agent', 'qa_observe', { runId }); broker.observation.expires = Date.now() - 1;
  await assert.rejects(broker.task('agent', 'qa_act', { runId, action: 'mouse', observationId: expired.observationId, mouse: click }), /observation_stale/);
  for (const mutate of [() => { state.configuration.rotation = 90; }, () => { state.online = false; }]) {
    const observed = await broker.task('agent', 'qa_observe', { runId }); mutate();
    await assert.rejects(broker.task('agent', 'qa_act', { runId, action: 'mouse', observationId: observed.observationId, mouse: click }), /observation_stale/);
    state.configuration = structuredClone(configuration); state.online = true;
  }
  const observed = await broker.task('agent', 'qa_observe', { runId }); state.inputError = 'action_uncertain';
  await assert.rejects(broker.task('agent', 'qa_act', { runId, action: 'mouse', observationId: observed.observationId, mouse: commands[3] }), /action_uncertain/);
  assert.equal(broker.observation, null);
  assert.equal(store.get(runId).events.at(-1).status, 'uncertain');
  assert.equal(state.calls.filter(c => c[0] === 'mouse').length, commands.length + 1);
  assert.equal(store.get(runId).events.filter(e => e.kind === 'assertion').length, 0);
});

test('real MCP desktop default exports caller-assessed synthetic display pixels into an actual MP4', async t => {
  const { root, broker, state, store } = fixture(t);
  const jpeg = path.join(root, 'green.jpg');
  await mediaProcess('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=lime:s=640x400', '-frames:v', '1', '-threads', '2', jpeg]);
  state.image = fs.readFileSync(jpeg);
  const service = createQAServer(broker), origin = await service.listen(0);
  const credentials = path.join(root, 'client.json');
  fs.writeFileSync(credentials, JSON.stringify({ origin, token: service.agentToken }), { mode: 0o600 });
  const client = new Client({ name: 'synthetic-desktop-test', version: '1' });
  t.after(async () => { await client.close(); await service.close(); });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../src/qa-mcp.js', import.meta.url)), credentials], stderr: 'pipe' }));
  const call = async (name, args = {}) => {
    const reply = await client.callTool({ name, arguments: args });
    assert.ok(!reply.isError, JSON.stringify(reply)); return reply.structuredContent;
  };
  assert.equal((await call('qa_status')).desktopAllowed, true);
  assert.deepEqual(state.calls, []);
  assert.equal((await call('qa_targets')).displays.length, 2);
  const started = await call('qa_start', { title: 'Synthetic desktop evidence, not native QA' });
  assert.deepEqual(started.target, target);
  const { runId } = started;
  const observed = await call('qa_observe', { runId, includeImage: true });
  const after = await call('qa_act', { runId, action: 'mouse', observationId: observed.observationId, mouse: click });
  await delay(80);
  const checked = await call('qa_check', { runId, kind: 'visual', observationId: after.observationId,
    title: 'Synthetic display stays green', expected: 'Green display', actual: 'Green pixels in synthetic image', outcome: 'pass' });
  assert.deepEqual(checked.assessment, { source: 'caller', actor: 'agent', serverVerified: false });
  const reused = await client.callTool({ name: 'qa_check', arguments: { runId, kind: 'visual', observationId: after.observationId,
    title: 'Cannot reuse visual evidence', expected: 'Green', actual: 'Green', outcome: 'pass' } });
  assert.equal(reused.isError, true);
  await call('qa_finish', { runId });
  const report = await call('qa_report', { runId, waitMs: 30000 });
  assert.equal(report.export.status, 'ready', JSON.stringify(report));
  assert.match(report.reportMarkdown, /not server-verified/);
  assert.deepEqual(report.target, target);
  assert.ok(report.edit.segments.some(s => s.role === 'assessed-frame'));
  const mp4 = report.artifacts['qa-v3-recording.mp4'];
  const probe = JSON.parse(await mediaProcess('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', mp4]));
  assert.ok(Number(probe.format.duration) > 0);
  const decoded = path.join(root, 'decoded.rgb');
  await mediaProcess('ffmpeg', ['-v', 'error', '-i', mp4, '-vf', 'crop=2:2:300:200,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', decoded]);
  assert.ok([...fs.readFileSync(decoded)].some((v, i) => i % 3 === 1 && v > 180), 'Encoded MP4 contains actual synthetic green pixels');
  for (const mutate of [s => { s.target.displayId++; }, s => { s.displayConfiguration.rotation = 90; },
    s => { s.displayConfiguration.boundsPoints[0]++; }]) {
    const events = fs.readFileSync(store.get(runId).file, 'utf8').trim().split('\n').map(JSON.parse);
    mutate(events.find(e => e.kind === 'observation' && e.afterFrameId === checked.frameId).snapshot);
    const edit = qaEditPlan(events, events.at(-1).elapsedMs);
    assert.ok(!edit.available || !edit.segments.some(s => s.role === 'preceding-input'));
  }
});

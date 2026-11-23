import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { recordingDisplay, RecordingContext, RecordingPopulation } from '../src/qa-recording-context.js';
import { displayCue } from '../src/qa-cursor-export.js';
import { humanRecordingSegments, qaRecordingSegments, Exporter, mediaProcess } from '../src/qa-export.js';
import { actionCues, fitPoint } from '../web/action-cues.js';
import { qaEditPlan } from '../web/qa-edit.js';
import { RunStore, POLICY } from '../src/qa-store.js';

const target = { windowId: 1, pid: 2, bundleId: 'test.target' };
const display = { kind: 'desktop', displayId: 1, displayUUID: '00000000-0000-0000-0000-000000000001',
  displayConfiguration: { boundsPoints: [-1000, 0, 1000, 800], pixelWidth: 2000, pixelHeight: 1600,
    rotation: 0, scaleX: 2, scaleY: 2 } };
const snapshot = { target, processStartedAt: 123, windowRectPoints: [-900, 100, 400, 200], elements: [] };
const windowHeader = { ...target, processStartedAt: 123, initialWindowRectPoints: snapshot.windowRectPoints,
  width: 800, height: 400, contentRectPixels: [0, 0, 400, 200], scaleFactor: 2, contentScale: 1,
  captureTimeSeconds: 1, sentUptimeSeconds: 1.01 };
const displayHeader = { ...display, type: 'frame', width: 1000, height: 800,
  contentRectPixels: [0, 0, 500, 400], scaleFactor: 2, contentScale: 1,
  captureTimeSeconds: 1, sentUptimeSeconds: 1.01 };
const id = n => n.toString(16).padStart(32, '0');

test('default display prewarm accommodates native startup beyond 1.5 seconds', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'context-cold-start-'));
  const store = new RunStore(root), run = store.start(target, {}, 'agent');
  const broker = { store, active: run, target, targetProcessStartedAt: 123, owner: {}, lease: {},
    connection: 'live', latest: { header: windowHeader, receivedMono: performance.now() },
    event: fields => store.append(run, fields), recordingFailed: error => assert.fail(error.message) };
  broker.native = {
    recordingTargets: async () => [display],
    recordingStream: async (_lease, _target, signal, consume) => {
      await delay(1700, undefined, { signal });
      broker.latest.receivedMono = performance.now();
      consume({ header: displayHeader, image: Buffer.from('recording context') });
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    },
  };
  const population = new RecordingPopulation();
  await population.reserve(broker);
  const context = new RecordingContext(broker, population);
  t.after(async () => { await context.close(); store.close(); fs.rmSync(root, { recursive: true }); });
  await context.start();
  assert.equal(context.status().scope, 'display', 'A normal cold native stream must not always time out into window capture');
  assert.equal(run.events.filter(e => e.kind === 'recording-frame').length, 1);
});

function trace() {
  return [
    { kind: 'run-start', elapsedMs: 0, target },
    { kind: 'frame', elapsedMs: 10, frameId: id(1), header: windowHeader },
    { kind: 'observation', elapsedMs: 20, observationId: id(2), afterFrameId: id(1), snapshot,
      frameEvidence: { status: 'available', afterFrameId: id(1) } },
    { kind: 'recording-scope', elapsedMs: 25, scope: 'display', reason: 'sole_window_session', scopeId: id(11),
      target: display, displayConfiguration: display.displayConfiguration },
    { kind: 'step-start', elapsedMs: 30, stepId: id(3), actionId: id(4), operation: 'mouse',
      beforeFrameId: id(1), mouse: { kind: 'click', button: 'left', count: 1, x: .5, y: .5 } },
    { kind: 'recording-frame', elapsedMs: 35, frameId: id(12), header: displayHeader,
      recording: { scopeId: id(11), windowHeader, windowReceivedElapsedMs: 10,
        displayTarget: display, displayConfiguration: structuredClone(display.displayConfiguration) } },
    { kind: 'action-attempt', elapsedMs: 40, stepId: id(3), actionId: id(4), observationId: id(2), status: 'running' },
    { kind: 'action', elapsedMs: 90, stepId: id(3), actionId: id(4), observationId: id(2), beforeFrameId: id(1),
      status: 'pass', reason: 'input_acknowledged_requires_assertion' },
    { kind: 'frame', elapsedMs: 100, frameId: id(5), header: windowHeader },
    { kind: 'observation', elapsedMs: 110, stepId: id(3), actionId: id(4), observationId: id(6), snapshot,
      beforeFrameId: id(1), afterFrameId: id(5), frameEvidence: { status: 'available', beforeFrameId: id(1), afterFrameId: id(5) } },
    { kind: 'step-end', elapsedMs: 120, stepId: id(3), actionId: id(4), status: 'pass' },
    { kind: 'step-start', elapsedMs: 160, stepId: id(7), operation: 'assert-count' },
    { kind: 'observation', elapsedMs: 170, stepId: id(7), observationId: id(8), snapshot, actual: 1 },
    { kind: 'assertion', elapsedMs: 180, stepId: id(7), observationId: id(8), actual: 1, expected: 1, status: 'pass' },
    { kind: 'run-end', elapsedMs: 200 },
  ].map(e => structuredClone({ actor: 'agent', runId: id(99), ...e }));
}

test('display selection uses largest physical overlap, including negative origins, and rejects ambiguous or invalid layouts', () => {
  const right = { ...display, displayId: 2, displayUUID: '00000000-0000-0000-0000-000000000002',
    displayConfiguration: { ...display.displayConfiguration, boundsPoints: [0, 0, 1000, 800] } };
  assert.equal(recordingDisplay([right, display], [-900, 100, 400, 200]).target.displayId, 1);
  assert.equal(recordingDisplay([display, right], [-100, 0, 500, 200]).target.displayId, 2);
  assert.throws(() => recordingDisplay([display, right], [-100, 0, 200, 200]), /ambiguous/);
  assert.throws(() => recordingDisplay([display], [100, 0, 200, 200]), /ambiguous/);
  assert.throws(() => recordingDisplay([{ ...display, displayConfiguration: {} }], snapshot.windowRectPoints), /geometry_unavailable/);
  assert.throws(() => recordingDisplay([display], [NaN, 0, 200, 200]), /geometry_unavailable/);
});

test('display cursor maps exact Retina window pixels through global points and display attachment before letterboxing', () => {
  const events = trace(), cues = actionCues(events), frame = events.find(e => e.kind === 'recording-frame');
  const cue = displayCue(cues, 95, frame);
  assert.deepEqual(cue.point, { x: .3, y: .25 });
  assert.deepEqual(fitPoint(cue.point, 1000, 800, 1280, 720), { x: 460, y: 180 });
  assert.equal(qaEditPlan(events, 200).segments.find(s => s.kind === 'evidence').role, 'preceding-input', 'Presentation records do not sever strict input association');
  for (const mutate of [
    f => { f.recording.windowHeader.pid++; },
    f => { f.recording.windowHeader.initialWindowRectPoints[0]++; },
    f => { f.recording.windowHeader.processStartedAt++; },
    f => { f.header.displayConfiguration.boundsPoints[0] = NaN; },
    f => { f.header.displayId++; },
    f => { f.header.displayConfiguration.boundsPoints[0]++; },
    f => { f.header.contentRectPixels = [0, 0, 2000, 2000]; },
    f => { f.header.scaleFactor = 0; },
    f => { f.recording.windowReceivedElapsedMs = -3000; },
  ]) {
    const changed = structuredClone(frame); mutate(changed);
    assert.equal(displayCue(cues, 95, changed), null, 'Invalid or stale layout cannot place a display cursor');
  }
});

test('human segments choose display context only inside its explicit scope and never reuse buffered pixels after downgrade', () => {
  const events = trace();
  events.splice(-1, 0, { kind: 'recording-scope', elapsedMs: 185, scope: 'window', reason: 'multiple_sessions' },
    { ...events.find(e => e.kind === 'recording-frame'), elapsedMs: 190, frameId: id(13) });
  const segments = humanRecordingSegments(events, 200);
  assert.equal(segments.find(s => s.startMs <= 90 && 90 < s.endMs).frameId, id(12));
  assert.equal(segments.find(s => s.startMs <= 195 && 195 < s.endMs).frameId, id(5));
  assert.ok(!segments.some(s => s.frameId === id(13)), 'A late frame outside a valid scope is excluded');
  const archived = trace().filter(e => !['recording-frame', 'recording-scope'].includes(e.kind));
  assert.ok(humanRecordingSegments(archived, 200).every(s => s.recordingScope === undefined), 'Old journals retain their original plan');
});

test('short checks retain a fresh sampled display frame received immediately before the input interval', () => {
  const events = trace();
  const context = events.splice(events.findIndex(e => e.kind === 'recording-frame'), 1)[0];
  context.elapsedMs = 26;
  events.splice(events.findIndex(e => e.kind === 'step-start'), 0, context);
  const edit = qaEditPlan(events, 200), segments = qaRecordingSegments(events, edit);
  assert.equal(edit.available, true, edit.reason);
  assert.ok(segments.length > 0);
  assert.ok(segments.every(s => s.kind === 'frame' && s.recordingScope === 'display'),
    'A sub-cadence check shows valid held display context instead of inventing a missing-footage card');
  const stale = qaRecordingSegments(events, edit, 1);
  assert.ok(stale.some(s => s.kind === 'gap'), 'The display hold still expires at the capture-gap boundary');
});

test('context frames share write bounds, quotas, recovery accounting, private filenames and confirmed deletion', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'context-storage-'));
  let store = new RunStore(root, { ...POLICY, sampleMs: 0 });
  let exporter = new Exporter(store);
  t.after(async () => { await exporter.close(); store.close(); fs.rmSync(root, { recursive: true }); });
  const run = store.start(target, {}, 'agent'), packet = { image: Buffer.from('context fixture'), header: displayHeader, version: 1 };
  let valid = true;
  const pending = store.frameAsync(run, packet, false, { kind: 'recording-frame', valid: () => valid });
  valid = false;
  assert.equal(await pending, null);
  assert.equal(run.frames, 0);
  assert.equal(fs.readdirSync(run.dir).length, 1, 'Invalidated pending pixels are removed before a transition can complete');
  const frame = await store.frameAsync(run, { ...packet, version: 2 }, true, { kind: 'recording-frame' });
  assert.equal(frame.kind, 'recording-frame');
  assert.throws(() => store.image(run.id, frame.frameId), /frame_not_found/);
  assert.deepEqual(store.recordingImage(run.id, frame.frameId), packet.image);
  assert.equal(fs.statSync(path.join(run.dir, frame.frameId + '.jpg')).mode & 0o077, 0);
  store.finish(run, 'pass', 'test');
  const bytes = run.bytes;
  await exporter.close(); store.close();
  store = new RunStore(root); exporter = new Exporter(store);
  assert.equal(store.get(run.id).frames, 1);
  assert.equal(store.get(run.id).bytes, bytes);
  assert.deepEqual(store.recordingImage(run.id, frame.frameId), packet.image);
  store.deleteRun(run.id, exporter);
  assert.equal(store.totalBytes, 0);
  assert.equal(fs.existsSync(run.dir), false);
  const limited = store.start(target, {}, 'agent');
  store.policy = { ...store.policy, maxFrames: 1 };
  store.frame(limited, packet, true);
  await assert.rejects(store.frameAsync(limited, { ...packet, version: 3 }, true, { kind: 'recording-frame' }), /recording_full/);
  assert.equal(limited.frames, 1, 'Window and context frames consume the same quota');
});

test('decoded QA MP4 contains selected display context and correctly placed cursor without changing raw window evidence', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'context-video-'));
  const store = new RunStore(path.join(root, 'runs')), exporter = new Exporter(store);
  t.after(async () => { await exporter.close(); store.close(); fs.rmSync(root, { recursive: true }); });
  const windowFile = path.join(root, 'window.jpg'), contextFile = path.join(root, 'context.jpg');
  for (const [file, color, size] of [[windowFile, 'red', '800x400'], [contextFile, 'blue', '1000x800']])
    await mediaProcess('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=${size}`,
      '-frames:v', '1', '-threads', '2', file]);
  let clock = 0;
  store.elapsed = () => clock;
  const run = store.start(target, {}, 'agent'), ids = new Map();
  for (const row of trace().slice(1)) {
    clock = row.elapsedMs;
    if (['frame', 'recording-frame'].includes(row.kind)) {
      const packet = { header: row.header, recording: row.recording,
        image: fs.readFileSync(row.kind === 'frame' ? windowFile : contextFile), receivedMono: run.monoStart + clock };
      const event = row.kind === 'frame' ? store.frame(run, packet, true)
        : await store.frameAsync(run, packet, true, { kind: 'recording-frame' });
      ids.set(row.frameId, event.frameId);
    } else if (row.kind === 'run-end') store.finish(run, 'pass', 'test');
    else {
      const value = structuredClone(row); delete value.runId; delete value.elapsedMs;
      for (const key of ['beforeFrameId', 'afterFrameId']) if (value[key]) value[key] = ids.get(value[key]);
      if (value.frameEvidence) for (const key of ['beforeFrameId', 'afterFrameId'])
        if (value.frameEvidence[key]) value.frameEvidence[key] = ids.get(value.frameEvidence[key]);
      store.append(run, value);
    }
  }
  const digest = () => fs.readdirSync(run.dir).sort().map(name => createHash('sha256').update(fs.readFileSync(path.join(run.dir, name))).digest('hex'));
  const before = digest();
  exporter.request(run.id, false, 'qa');
  const state = await exporter.wait(run.id, 30000, 'qa');
  assert.equal(state.status, 'ready', JSON.stringify(state));
  assert.ok(state.durationMs >= 8000);
  const evidence = JSON.parse(fs.readFileSync(exporter.artifact(run.id, 'qa-v5-summary.json').file));
  assert.equal(evidence.sourceFrames.length, 2);
  assert.equal(evidence.recordingFrames.length, 1);
  assert.ok(evidence.segments.some(s => s.recordingScope === 'display'));
  const rgb = path.join(root, 'decoded.rgb');
  await mediaProcess('ffmpeg', ['-v', 'error', '-i', exporter.artifact(run.id, 'qa-v5-recording.mp4').file,
    '-vf', 'fps=100,crop=50:50:450:170', '-f', 'rawvideo', '-pix_fmt', 'rgb24', rgb]);
  const pixels = fs.readFileSync(rgb);
  let blue = 0, cyan = 0;
  for (let i = 0; i < pixels.length; i += 3) {
    if (pixels[i] < 70 && pixels[i + 1] < 70 && pixels[i + 2] > 150) blue++;
    if (pixels[i] < 150 && pixels[i + 1] > 130 && pixels[i + 2] > 140) cyan++;
  }
  assert.ok(blue > 1000, `Decoded pixels must show display context, not the red window: ${blue}`);
  assert.ok(cyan > 100, `Decoded cursor must be at global-to-display point, not normalized-window point: ${cyan}`);
  assert.deepEqual(digest(), before, 'Export never rewrites the raw window, context pixels or journal');
  console.log(`Display artifact: ${state.durationMs}ms; ${blue} blue context pixels; ${cyan} cyan cursor pixels; raw hashes unchanged.`);
});

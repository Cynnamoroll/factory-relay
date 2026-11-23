import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { actionCues, cueAt, fitPoint, cueLabel, cueGeometry } from '../web/action-cues.js';
import { qaEditPlan, sourceToQA, qaToSource } from '../web/qa-edit.js';
import { cursorPresentation } from '../src/qa-cursor-export.js';
import { RunStore } from '../src/qa-store.js';
import { Exporter, mediaProcess } from '../src/qa-export.js';
import { Broker } from '../src/qa-broker.js';
import { createQAServer } from '../src/qa-server.js';

const id = n => n.toString(16).padStart(32, '0');
const target = { windowId: 1, pid: 2, bundleId: 'test.target' };
const snapshot = { target, processStartedAt: 123, windowRectPoints: [20, 30, 960, 600], elements: [] };
const header = { ...target, processStartedAt: 123, initialWindowRectPoints: snapshot.windowRectPoints,
  width: 1920, height: 1200, contentRectPixels: [0, 0, 960, 600], scaleFactor: 2, contentScale: 1,
  sentUptimeSeconds: 1.01, captureTimeSeconds: 1 };
function trace() {
  const rows = [
    { kind: 'run-start', elapsedMs: 0, target },
    { kind: 'frame', elapsedMs: 10, frameId: id(1), header },
    { kind: 'observation', elapsedMs: 20, observationId: id(2), afterFrameId: id(1), snapshot,
      frameEvidence: { status: 'available', afterFrameId: id(1) } },
    { kind: 'step-start', elapsedMs: 30, stepId: id(3), actionId: id(4), operation: 'mouse',
      beforeFrameId: id(1), mouse: { kind: 'click', button: 'left', count: 1, x: .968, y: .926 } },
    { kind: 'action-attempt', elapsedMs: 40, stepId: id(3), actionId: id(4), observationId: id(2), status: 'running' },
    { kind: 'action', elapsedMs: 90, stepId: id(3), actionId: id(4), observationId: id(2), beforeFrameId: id(1),
      status: 'pass', reason: 'input_acknowledged_requires_assertion' },
    { kind: 'frame', elapsedMs: 100, frameId: id(5), header },
    { kind: 'observation', elapsedMs: 110, stepId: id(3), actionId: id(4), observationId: id(6), snapshot,
      beforeFrameId: id(1), afterFrameId: id(5), frameEvidence: { status: 'available', beforeFrameId: id(1), afterFrameId: id(5) } },
    { kind: 'step-end', elapsedMs: 120, stepId: id(3), actionId: id(4), status: 'pass' },
    { kind: 'step-start', elapsedMs: 130, stepId: id(7), operation: 'observe', beforeFrameId: id(5) },
    { kind: 'observation', elapsedMs: 140, stepId: id(7), observationId: id(8), snapshot, afterFrameId: id(5),
      frameEvidence: { status: 'available', afterFrameId: id(5) } },
    { kind: 'step-end', elapsedMs: 150, stepId: id(7), status: 'pass' },
    { kind: 'step-start', elapsedMs: 160, stepId: id(9), operation: 'assert-count' },
    { kind: 'observation', elapsedMs: 170, stepId: id(9), observationId: id(10), snapshot, actual: 1 },
    { kind: 'assertion', elapsedMs: 180, stepId: id(9), observationId: id(10), actual: 1, expected: 1, status: 'pass' },
    { kind: 'run-end', elapsedMs: 200 },
  ];
  return rows.map(e => structuredClone({ actor: 'agent', runId: id(99), ...e }));
}

test('Retina click cues preserve actor, source clock, native ACK semantics and letterboxing', () => {
  const events = trace(), before = JSON.stringify(events), cues = actionCues(events);
  assert.deepEqual(cues.map(c => c.status), ['attempted', 'acknowledged']);
  assert.deepEqual(cues[1].point, { x: .968, y: .926 });
  assert.match(cueLabel(cues[1]), /agent.*native ACK, not assertion/);
  const p = fitPoint(cues[1].point, 1920, 1200, 1280, 720);
  assert.ok(Math.abs(p.x - 1179.136) < .001);
  assert.ok(Math.abs(p.y - 666.72) < .001);
  assert.equal(cueAt(cues, 39, header), null);
  assert.equal(cueAt(cues, 40, header).status, 'attempted');
  assert.equal(cueAt(cues, 90, header).status, 'acknowledged');
  assert.equal(cueAt(cues, 200, header), null, 'Run end removes every marker');
  assert.equal(JSON.stringify(events), before, 'Journal and raw geometry remain unchanged');
});

test('invalid coordinates, snapshot layouts and stale identities never invent a spatial click', () => {
  const mutations = [
    e => { e[3].mouse.x = NaN; }, e => { e[3].mouse.x = 1; },
    e => { delete e[1].header.contentRectPixels; }, e => { e[1].header.scaleFactor = 0; },
    e => { e[1].header.width = 2; }, e => { e[1].header.processStartedAt++; },
    e => { e[2].snapshot.windowRectPoints[0]++; }, e => { e[2].snapshot.target.pid++; },
    e => { e[2].actor = 'human'; }, e => { e[3].operation = 'press'; delete e[3].mouse; },
    e => { e[1].header.sentUptimeSeconds = 9; },
    e => { e[0].labels = { processStartedAt: '999' }; },
    e => { e[2].frameEvidence.status = 'missing'; },
  ];
  for (const mutate of mutations) {
    const events = trace(); mutate(events);
    assert.ok(actionCues(events).every(c => c.point === null), 'Untrusted geometry is a nonspatial action label');
  }
  const cues = actionCues(trace());
  assert.equal(cueAt(cues, 95, { ...header, pid: 5 }), null);
  assert.equal(cueAt(cues, 95, { ...header, initialWindowRectPoints: [21, 30, 960, 600] }), null);
  const changedRun = trace(); changedRun[5].runId = id(200);
  assert.deepEqual(actionCues(changedRun), [], 'Mixed run metadata fails closed');
});

test('attachment padding is mapped before export letterboxing and metadata stays bounded', () => {
  const events = trace();
  for (const e of events.filter(e => e.kind === 'frame'))
    e.header = { ...e.header, width: 2048, height: 1280, contentRectPixels: [32, 20, 960, 600] };
  const point = actionCues(events)[0].point;
  assert.ok(Math.abs(point.x - .93875) < .000001);
  assert.ok(Math.abs(point.y - .899375) < .000001);
  assert.equal(cueGeometry({ ...header, contentRectPixels: [-1, 0, 960, 600] }, snapshot), null);
  const long = trace().slice(0, 9);
  for (let i = 0; i < 400; i++) for (const e of trace().slice(3, 6))
    long.push({ ...e, stepId: id(1000 + i), actionId: id(2000 + i), elapsedMs: e.elapsedMs + 200 + i * 100 });
  assert.equal(actionCues(long).length, 512, 'A long trace cannot create an unbounded cue queue');
  assert.deepEqual(actionCues(Array(12002).fill(events[0])), []);
});

test('blocked and uncertain inputs have no successful spatial marker and concurrent traces stay separate', () => {
  const events = trace();
  events[5].status = 'uncertain'; events[8].status = 'blocked';
  const cues = actionCues(events);
  assert.deepEqual(cues.map(c => c.status), ['attempted', 'uncertain', 'blocked']);
  assert.ok(cues.slice(1).every(c => c.point === null));
  const other = trace().map(e => ({ ...e, runId: id(101), actor: 'human' }));
  assert.ok(actionCues(other).every(c => c.actor === 'human' && c.runId === id(101)));
  assert.ok(actionCues(trace()).every(c => c.actor === 'agent' && c.runId === id(99)));
  const interrupted = trace(); interrupted.splice(5, 0, { kind: 'ownership', elapsedMs: 80, runId: id(99) });
  assert.equal(cueAt(actionCues(interrupted), 95, header), null);
});

test('a valid prior coordinate visibly interpolates, rather than inventing captured movement', () => {
  const events = trace().slice(0, 9);
  const second = trace().slice(3, 6).map(e => ({ ...e, elapsedMs: e.elapsedMs + 100,
    stepId: id(13), actionId: id(14), ...(e.mouse ? { mouse: { ...e.mouse, x: .2 } } : {}) }));
  events.push(...second);
  const cues = actionCues(events);
  const at = cueAt(cues, 180, header);
  assert.ok(at.point.x > .2 && at.point.x < .968, 'Intermediate source time shows a moving synthetic cursor');
  assert.equal(at.point.y, .926);
});

test('recording presentation contains only vector cursors, never text or legends', () => {
  const events = trace();
  const segment = { kind: 'frame', frameId: events.find(e => e.kind === 'frame').frameId,
    startMs: 0, endMs: 200 };
  const presentation = cursorPresentation(events, [segment], 200);
  const drawings = presentation.ass.split('\n').filter(line => line.startsWith('Dialogue:'));
  assert.ok(drawings.length > 0);
  assert.ok(drawings.every(line => line.includes('\\p1}')), 'Every rendered event is a vector arrow');
  assert.doesNotMatch(presentation.ass, /Synthetic input|native ACK|Review pause|Expected:|Observed:/);
});

test('read-only observations retain strict preceding-input context without changing assertion authority or time', () => {
  const events = trace(), plan = qaEditPlan(events, 200);
  assert.equal(plan.available, true, plan.reason);
  assert.equal(plan.evidenceMs, 110);
  assert.equal(plan.durationMs, 8000);
  assert.equal(plan.presentationMs, 7890);
  assert.equal(plan.segments.find(s => s.kind === 'evidence').role, 'preceding-input');
  assert.equal(sourceToQA(plan, 90), 2060);
  assert.equal(qaToSource(plan, 2060), 90);
  for (const change of [
    rows => { rows[10].actor = 'human'; }, rows => { rows[10].snapshot.processStartedAt++; },
    rows => { rows[10].snapshot.windowRectPoints[0]++; },
    rows => { rows[9].operation = 'mouse'; },
    rows => { rows.splice(9, 0, { kind: 'gap', elapsedMs: 125, runId: id(99) }); },
    rows => { rows.splice(9, 0, { kind: 'ownership', elapsedMs: 125, runId: id(99) }); },
  ]) {
    const rows = trace(); change(rows);
    const edit = qaEditPlan(rows, 200);
    assert.equal(edit.available, true, edit.reason);
    assert.ok(!edit.segments.some(s => s.role === 'preceding-input'), 'Unrelated, stale or changed contexts are excluded');
    assert.equal(edit.clips[0].status, 'pass', 'Association is context, never assertion validation');
  }
  const segments = [{ kind: 'frame', frameId: id(1), startMs: 0, endMs: 90, sourceStartMs: 30, sourceEndMs: 120 }];
  const rendered = cursorPresentation(events, segments, 90);
  assert.equal(rendered.packets.reduce((n, p) => n + p.endMs - p.startMs, 0), 90);
  assert.ok(rendered.packets.some(p => p.startMs === 60), 'Native ACK has its own presentation packet in a short evidence interval');
});

test('downloaded short QA MP4 and poster contain independently decoded cursor pixels and raw hashes remain unchanged', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-video-'));
  const store = new RunStore(path.join(root, 'runs')), exporter = new Exporter(store);
  t.after(async () => { await exporter.close(); store.close(); fs.rmSync(root, { recursive: true }); });
  const jpg = path.join(root, 'raw.jpg');
  await mediaProcess('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=1920x1200', '-frames:v', '1', '-threads', '2', jpg]);
  let clock = 0;
  store.elapsed = () => clock;
  const run = store.start(target, {}, 'agent'), raw = fs.readFileSync(jpg);
  const ids = new Map();
  for (const row of trace().slice(1)) {
    clock = row.elapsedMs;
    if (row.kind === 'frame') {
      const frame = store.frame(run, { header: row.header, image: raw, receivedAt: Date.now() }, true);
      ids.set(row.frameId, frame.frameId);
    } else if (row.kind === 'run-end') store.finish(run, 'pass', 'test');
    else {
      const value = structuredClone(row); delete value.runId; delete value.elapsedMs;
      for (const key of ['beforeFrameId', 'afterFrameId']) if (value[key]) value[key] = ids.get(value[key]);
      if (value.frameEvidence) for (const key of ['beforeFrameId', 'afterFrameId'])
        if (value.frameEvidence[key]) value.frameEvidence[key] = ids.get(value.frameEvidence[key]);
      store.append(run, value);
    }
  }
  const files = [run.file, ...run.events.filter(e => e.kind === 'frame').map(e => path.join(run.dir, e.frameId + '.jpg'))];
  const hashes = () => files.map(f => createHash('sha256').update(fs.readFileSync(f)).digest('hex'));
  const before = hashes();
  exporter.request(run.id, false, 'qa');
  const state = await exporter.wait(run.id, 30000, 'qa');
  assert.equal(state.status, 'ready', JSON.stringify(state));
  assert.ok(state.durationMs >= 8000);
  const video = exporter.artifact(run.id, 'qa-v5-recording.mp4').file;
  const rgb = path.join(root, 'cursor.rgb');
  await mediaProcess('ffmpeg', ['-v', 'error', '-i', video, '-vf', 'fps=100,crop=50:50:1160:650',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', rgb]);
  const pixels = fs.readFileSync(rgb);
  let cyan = 0, leftOfPointer = 0;
  for (let i = 0; i < pixels.length; i += 3) if (pixels[i] < 150 && pixels[i + 1] > 130 && pixels[i + 2] > 140) {
    cyan++;
    if ((i / 3) % 50 < 10) leftOfPointer++;
  }
  assert.ok(cyan > 100, `Decoded short MP4 must visibly contain the cyan synthetic cursor, got ${cyan} pixels`);
  assert.equal(leftOfPointer, 0, 'Decoded video must leave UI pixels left of the plain arrow untouched, without click rings');
  const poster = exporter.artifact(run.id, 'qa-v5-poster.jpg').file, posterRGB = path.join(root, 'poster.rgb');
  await mediaProcess('ffmpeg', ['-v', 'error', '-i', poster, '-vf', 'crop=50:50:1160:650', '-f', 'rawvideo', '-pix_fmt', 'rgb24', posterRGB]);
  assert.ok(fs.readFileSync(posterRGB).some(n => n > 150), 'Poster must derive from marked presentation, not a raw JPEG');
  assert.deepEqual(hashes(), before);
  await exporter.close();
  const statePath = path.join(exporter.root, run.id, 'qa-v5-state.json');
  const saved = JSON.parse(fs.readFileSync(statePath)); delete saved.cursorVersion;
  fs.writeFileSync(statePath, JSON.stringify(saved));
  const restarted = new Exporter(store); t.after(() => restarted.close());
  assert.equal(restarted.state(run.id, 'qa').status, 'not_requested', 'Restart never serves stale unmarked ready video');
  console.log(`Cursor artifact: ${state.durationMs}ms receive-clock evidence; ${cyan} independently decoded cyan pixels; raw hashes unchanged.`);
});

test('authenticated live transport delivers scoped cue metadata separately from immutable JPEG payload', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-stream-'));
  const store = new RunStore(root), broker = new Broker(store, {}), service = createQAServer(broker);
  t.after(async () => { await service.close(); await broker.close(); fs.rmSync(root, { recursive: true }); });
  let clock = 0;
  store.elapsed = () => clock;
  const run = store.start(target, {}, 'agent'); broker.active = run;
  const raw = Buffer.from([255, 216, 255, 217]);
  broker.latest = { header, image: raw, version: 1, receivedAt: Date.now() };
  const origin = await service.listen(0);
  const auth = { Authorization: 'Bearer ' + service.agentToken, 'X-QA-Request': '1' };
  assert.equal((await fetch(origin + '/action-cues.js')).status, 200);
  assert.equal((await fetch(origin + '/api/live/stream', { headers: { 'X-QA-Request': '1' } })).status, 401);
  const response = await fetch(origin + '/api/live/stream', { headers: auth, signal: AbortSignal.timeout(5000) });
  const reader = response.body.getReader();
  t.after(() => reader.cancel());
  let buffer = Buffer.alloc(0);
  async function packet() {
    for (;;) {
      if (buffer.length >= 4) {
        const size = buffer.readUInt32BE(0);
        if (buffer.length >= 4 + size) {
          const h = JSON.parse(buffer.subarray(4, 4 + size));
          if (buffer.length >= 4 + size + h.bytes) {
            const image = buffer.subarray(4 + size, 4 + size + h.bytes);
            buffer = buffer.subarray(4 + size + h.bytes);
            return { header: h, image };
          }
        }
      }
      const part = await reader.read(); assert.equal(part.done, false);
      buffer = Buffer.concat([buffer, part.value]);
    }
  }
  assert.deepEqual((await packet()).image, raw);
  for (const row of trace().slice(1, 6)) {
    clock = row.elapsedMs;
    const fields = { ...row }; delete fields.elapsedMs; delete fields.runId;
    broker.event(fields);
  }
  const attempt = await packet(), ack = await packet();
  assert.equal(attempt.header.type, 'cue');
  assert.equal(attempt.header.cue.runId, run.id);
  assert.equal(attempt.header.cue.status, 'attempted');
  assert.equal(ack.header.cue.status, 'acknowledged');
  assert.deepEqual(ack.header.cue.point, { x: .968, y: .926 });
  assert.equal(ack.image.length, 0);
  assert.ok(JSON.stringify(ack.header).length < 2048);
  assert.deepEqual(broker.latest.image, raw);
  await reader.cancel();
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { qaEditPlan, qaClipAt, sourceToQA, qaToSource, qaSegmentAt, QA_EDIT_VERSION, QA_EDIT_POLICY } from '../web/qa-edit.js';
import { RunStore } from '../src/qa-store.js';
import { Exporter, mediaProcess, EXPORT_POLICY } from '../src/qa-export.js';
import { Broker } from '../src/qa-broker.js';
import { createQAServer } from '../src/qa-server.js';

const a = 'a'.repeat(32), b = 'b'.repeat(32), c = 'c'.repeat(32);
const start = (stepId, elapsedMs, operation = 'assert-count') => ({ kind: 'step-start', operation, stepId, elapsedMs });
const outcome = (stepId, elapsedMs, status = 'pass') => ({ kind: 'assertion', stepId, elapsedMs, status });
const wrap = rows => [{ kind: 'run-start', elapsedMs: 0 }, ...rows, { kind: 'run-end', elapsedMs: 10000 }];
const sample = wrap([start(a, 1000), outcome(a, 2000), start(b, 5000), outcome(b, 6500, 'fail'),
  start(c, 8000), outcome(c, 8500, 'blocked')]);

test('real association provenance admits two distinct inputs and omits ambiguous, interrupted or unrelated context', () => {
  const original = JSON.parse(fs.readFileSync(new URL('../fixtures/qa-sequence-evidence.json', import.meta.url))).events;
  const plan = qaEditPlan(original, original.at(-1).elapsedMs);
  assert.equal(plan.available, true);
  assert.ok(Math.abs(plan.durationMs - 34714.331899) < 0.001);
  const input = plan.segments.filter(s => s.role === 'preceding-input');
  assert.equal(input.length, 2);
  assert.equal(new Set(input.map(s => s.operationStepId)).size, 2);
  assert.equal(plan.clips[1].status, 'fail');
  assert.ok(plan.segments.filter(s => s.stepId === plan.clips[1].stepId && s.kind === 'evidence').every(s => s.role === 'assertion'));
  assert.equal(sourceToQA(plan, 14980), null, 'Idle between input completion and assertion is excluded');
  assert.equal(sourceToQA(plan, 52000), null, 'Ownership/setup/idle is not included');
  const inputId = input[0].operationStepId, checkId = plan.clips[0].stepId;
  const mutations = [
    rows => { rows.find(e => e.kind === 'action' && e.stepId === inputId).status = 'uncertain'; },
    rows => { rows.find(e => e.kind === 'step-end' && e.stepId === inputId).status = 'fail'; },
    rows => { rows.find(e => e.kind === 'action-attempt' && e.stepId === inputId).actionId = a; },
    rows => { rows.find(e => e.kind === 'observation' && e.stepId === inputId).frameEvidence.status = 'missing'; },
    rows => { rows.find(e => e.kind === 'observation' && e.stepId === inputId).afterFrameId = a; },
    rows => { rows.find(e => e.kind === 'observation' && e.stepId === checkId).snapshot.target.pid++; },
    rows => { rows.find(e => e.kind === 'step-start' && e.stepId === checkId).actor = 'human'; },
    rows => { rows.find(e => e.kind === 'observation' && e.stepId === checkId).snapshot.processStartedAt++; },
    rows => { rows.splice(rows.findIndex(e => e.kind === 'step-start' && e.stepId === checkId), 0, { kind: 'gap', elapsedMs: 14980 }); },
    rows => { rows.splice(rows.findIndex(e => e.kind === 'step-start' && e.stepId === checkId), 0, { kind: 'ownership', elapsedMs: 14980 }); },
    rows => { rows.splice(rows.findIndex(e => e.kind === 'step-start' && e.stepId === checkId), 0,
      start(a, 14978, 'observe'), { kind: 'step-end', stepId: a, status: 'pass', elapsedMs: 14980 }); },
    rows => { rows.splice(rows.findIndex(e => e.kind === 'step-start' && e.stepId === checkId), 0,
      start(a, 14978), outcome(a, 14980, 'blocked')); },
  ];
  for (const mutate of mutations) {
    const events = structuredClone(original); mutate(events);
    const edit = qaEditPlan(events, events.at(-1).elapsedMs);
    assert.equal(edit.available, true, edit.reason);
    assert.ok(!edit.segments.some(s => s.role === 'preceding-input' && s.stepId === checkId), 'Ambiguous context is omitted, never guessed');
    assert.match(edit.clips[0].evidenceNote, /Assertion observation only/);
  }
});

test('invalid assertion values cannot become QA evidence', () => {
  const bad = structuredClone(sample); bad.find(e => e.kind === 'assertion').actual = 'invented';
  assert.equal(qaEditPlan(bad, 10000).available, false);
});

test('footage-only QA sequences preserve evidence timing with no synthetic dwell', () => {
  const original = JSON.stringify(sample), plan = qaEditPlan(sample, 10000);
  assert.equal(plan.available, true); assert.equal(plan.version, QA_EDIT_VERSION);
  assert.equal(plan.durationMs, 2500); assert.equal(plan.evidenceMs, 2500);
  assert.equal(plan.presentationMs, 0); assert.equal(plan.omittedMs, 7500);
  assert.deepEqual(plan.clips.map(c => [c.status, c.sourceStartMs, c.sourceEndMs, c.startMs, c.endMs]),
    [['pass', 1000, 2000, 0, 1000], ['fail', 5000, 6500, 1000, 2500]]);
  assert.deepEqual(plan.segments.map(s => s.kind), ['evidence', 'evidence']);
  assert.equal(qaClipAt(plan, 1000).stepId, b);
  assert.equal(qaSegmentAt(plan, 1000).kind, 'evidence');
  assert.equal(qaToSource(plan, 1000), 5000);
  assert.equal(qaToSource(plan, 2500), null);
  assert.equal(sourceToQA(plan, 2000), null);
  assert.equal(sourceToQA(plan, 8000, c), null);
  for (let ms = 0; ms < plan.durationMs; ms += 17) {
    const source = qaToSource(plan, ms);
    assert.notEqual(source, null, 'Every playback moment maps to recorded source time');
    assert.equal(sourceToQA(plan, source), ms);
  }
  assert.equal(JSON.stringify(sample), original);
  const adjacent = qaEditPlan(wrap([start(a, 1000), outcome(a, 2000), start(b, 2000), outcome(b, 3000, 'fail')]), 10000);
  assert.equal(qaToSource(adjacent, 1000), 2000);
  assert.equal(sourceToQA(adjacent, 2000), 1000);
  assert.equal(qaEditPlan(sample, 10000, { ...QA_EDIT_POLICY, maxEditedDurationMs: 2000 }).available, false);
  assert.equal(qaEditPlan(sample, 10000, { ...QA_EDIT_POLICY, maxSegments: 1 }).available, false);
});

test('empty, blocked and uncertain checks do not become footage; ambiguous or bounded-invalid input is unavailable', () => {
  const empty = qaEditPlan(wrap([start(a, 1000), outcome(a, 2000, 'blocked'), start(b, 3000), outcome(b, 4000, 'uncertain')]), 10000);
  assert.equal(empty.available, true); assert.equal(empty.durationMs, 0); assert.deepEqual(empty.clips, []);
  for (const events of [
    sample.slice(0, -1),
    wrap([outcome(a, 2000)]),
    wrap([start(a, 1000), start(a, 1500), outcome(a, 2000)]),
    wrap([start(a, 1000), outcome(a, 1000)]),
    wrap([start(a, 1000), outcome(a, 2000), outcome(a, 2500)]),
    wrap([start(a, 1000), start(b, 1500), outcome(a, 2000), outcome(b, 3000)]),
    wrap([start(a, 1000), start(b, 1500, 'press'), outcome(a, 2000)]),
    wrap([start(a, 1000), { kind: 'ownership', elapsedMs: 1500 }, outcome(a, 2000)]),
    wrap([start(a, 2000), outcome(a, 1500)]),
    wrap([{ kind: 'unknown', elapsedMs: 1000 }]),
    wrap([{ kind: 'frame', elapsedMs: 1000, receivedElapsedMs: NaN }]),
  ]) assert.equal(qaEditPlan(events, 10000).available, false, JSON.stringify(events));
  assert.equal(qaEditPlan(sample, 10000, { ...QA_EDIT_POLICY, maxClips: 1 }).available, false);
  assert.equal(qaEditPlan(sample, 10000, { ...QA_EDIT_POLICY, maxEvents: 2 }).available, false);
  assert.equal(qaEditPlan(sample, Infinity).available, false);
});

test('timing-only fixture lacks association provenance and therefore never invents preceding input', () => {
  const events = JSON.parse(fs.readFileSync(new URL('../fixtures/qa-review-timing.json', import.meta.url))).events;
  const plan = qaEditPlan(events, events.at(-1).elapsedMs);
  assert.equal(plan.available, true, plan.reason);
  assert.deepEqual(plan.clips.map(c => c.status), ['pass', 'fail', 'pass']);
  assert.ok(Math.abs(plan.durationMs - 15253) < 2);
  assert.equal(plan.clips[1].sourceStartMs.toFixed(6), '19929.107597');
  assert.equal(plan.clips[1].sourceEndMs.toFixed(6), '25032.181177');
  assert.equal(sourceToQA(plan, 52000), null);
  assert.ok(plan.segments.filter(s => s.kind === 'evidence').every(s => s.role === 'assertion'));
});

test('actual QA MP4 excludes distinct red setup/idle footage, preserves pass/fail and internal gaps, and never overwrites source', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-edit-video-'));
  const store = new RunStore(path.join(root, 'runs')), broker = new Broker(store, {});
  let service;
  t.after(async () => { if (service) await service.close(); await broker.close(); fs.rmSync(root, { recursive: true }); });
  const images = {};
  for (const color of ['red', 'lime', 'blue', 'yellow']) {
    const file = path.join(root, `${color}.jpg`);
    await mediaProcess('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=320x240`, '-frames:v', '1', '-threads', '2', file]);
    images[color] = fs.readFileSync(file);
  }
  const target = { windowId: 1, pid: 2, bundleId: 'fixture' };
  let clock = 0;
  store.elapsed = () => clock;
  const run = store.start(target, { title: 'Distinct synthetic QA edit' }, 'agent');
  run.monoStart = 0;
  const at = ms => { clock = ms; };
  let version = 0;
  const frame = (ms, color) => {
    at(ms); return store.frame(run, { image: images[color], version: ++version, receivedAt: Date.now(),
      receivedMono: run.monoStart + ms, header: { captureTimeSeconds: ms / 1000 } }, true);
  };
  frame(0, 'red');
  at(100); store.append(run, { kind: 'observation', actor: 'agent', observationId: 'pre', snapshot: { target } });
  const beforeFrameId = frame(200, 'yellow').frameId;
  const inputId = 'd'.repeat(32), actionId = 'e'.repeat(32);
  const input = { actor: 'agent', stepId: inputId, actionId };
  at(300); store.append(run, { ...input, kind: 'step-start', operation: 'press', beforeFrameId });
  at(310); store.append(run, { ...input, kind: 'action-attempt', status: 'running', observationId: 'pre' });
  at(450); store.append(run, { ...input, kind: 'action', status: 'pass', reason: 'input_acknowledged_requires_assertion', observationId: 'pre', beforeFrameId });
  const afterFrameId = frame(600, 'yellow').frameId;
  at(700); store.append(run, { ...input, kind: 'observation', snapshot: { target }, beforeFrameId, afterFrameId,
    frameEvidence: { status: 'available', beforeFrameId, afterFrameId } });
  at(800); store.append(run, { ...input, kind: 'step-end', status: 'pass' });
  frame(900, 'red');
  at(1000); store.append(run, { ...start(a, 1000), actor: 'agent', title: 'PASS GREEN' });
  frame(1010, 'lime');
  at(1450); store.append(run, { kind: 'observation', actor: 'agent', stepId: a, observationId: 'check', actual: 1, snapshot: { target } });
  at(1500); store.append(run, { ...outcome(a, 1500), actor: 'agent', observationId: 'check', title: 'PASS GREEN', expected: 1, actual: 1 });
  frame(1600, 'red');
  at(3000); store.append(run, { ...start(b, 3000), title: 'FAIL BLUE' });
  frame(3010, 'blue');
  at(3300); store.append(run, { kind: 'gap', reason: 'fixture_missing_frame' });
  frame(3500, 'blue');
  at(3800.333); store.append(run, { ...outcome(b, 3800, 'fail'), title: 'FAIL BLUE', expected: 2, actual: 1 });
  frame(3900, 'red');
  at(5000); store.finish(run, 'fail', 'fixture_complete');
  broker.exports.request(run.id);
  assert.equal((await broker.exports.wait(run.id, 30000)).status, 'ready');
  const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const sourceFiles = ['recording.mp4', 'poster.jpg', 'summary.json'].map(n => broker.exports.artifact(run.id, n).file);
  const legacy = ['state.json', 'recording.mp4', 'poster.jpg', 'summary.json'].map(name => path.join(broker.exports.root, run.id, 'qa-' + name));
  for (const file of legacy) fs.writeFileSync(file, JSON.stringify({ status: 'ready', durationMs: 1300, version: 1 }), { mode: 0o600 });
  const v2 = ['state.json', 'recording.mp4', 'poster.jpg', 'summary.json', 'video.filter', 'card-title.txt', 'card-0-intro.jpg', 'card-0-result.jpg']
    .map(name => path.join(broker.exports.root, run.id, 'qa-v2-' + name));
  for (const file of v2) fs.writeFileSync(file, JSON.stringify({ status: 'ready', durationMs: 11800, version: 2 }), { mode: 0o600 });
  const migrated = new Exporter(store);
  assert.equal(migrated.state(run.id, 'qa').status, 'not_requested', 'Neither v1 nor v2 ready exports are v3 ready exports');
  assert.equal(migrated.state(run.id, 'qa').version, QA_EDIT_VERSION);
  assert.throws(() => migrated.artifact(run.id, 'qa-recording.mp4'), /export_not_ready/);
  assert.throws(() => migrated.artifact(run.id, 'qa-v2-recording.mp4'), /export_not_ready/);
  await migrated.close();
  const immutable = [run.file, ...run.events.filter(e => e.kind === 'frame').map(e => path.join(run.dir, e.frameId + '.jpg')), ...sourceFiles, ...legacy, ...v2];
  const before = immutable.map(digest);
  assert.equal(broker.exports.state(run.id, 'qa').status, 'not_requested');
  const report = await broker.task('agent', 'qa_report', { runId: run.id, waitMs: 30000 });
  assert.equal(report.export.status, 'ready', JSON.stringify(report.export));
  const qa = broker.exports.artifact(run.id, 'qa-v3-recording.mp4');
  const probe = JSON.parse(await mediaProcess('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', qa.file]));
  const seconds = Number(probe.format.duration);
  assert.ok(Math.abs(seconds - 1.8) < .1, `Independent duration ${seconds} must equal 1.8 seconds of evidence with no presentation dwell`);
  const evidence = JSON.parse(fs.readFileSync(broker.exports.artifact(run.id, 'qa-v3-summary.json').file));
  assert.ok(evidence.segments.some(s => s.kind === 'gap' && s.sourceStartMs > 3290 && s.sourceEndMs < 3520));
  const pixels = path.join(root, 'decoded.rgb');
  await mediaProcess('ffmpeg', ['-v', 'error', '-i', qa.file, '-vf', 'fps=40,crop=2:2:300:200,scale=1:1',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', pixels]);
  const rgb = fs.readFileSync(pixels), samples = Array.from({ length: rgb.length / 3 }, (_, i) => [...rgb.subarray(i * 3, i * 3 + 3)]);
  assert.equal(samples.length, 72, '1.8 seconds of footage decoded at 40 samples per second');
  assert.ok(samples.every(([r, g, b]) => !(r > 150 && g < 60 && b < 60)), 'No decoded sample may contain excluded red setup/idle footage');
  const pixelAt = seconds => samples[Math.floor(seconds * 40)];
  const inputSegment = evidence.edit.segments.find(s => s.role === 'preceding-input');
  assert.ok(inputSegment, 'Completed, identity-matched recorded input belongs to the first check');
  assert.equal(evidence.edit.segments.filter(s => s.role === 'preceding-input').length, 1, 'The next assertion must not reuse that input');
  const yellow = pixelAt((inputSegment.startMs + 200) / 1000);
  assert.ok(yellow[0] > 180 && yellow[1] > 180 && yellow[2] < 60, 'Legitimate yellow input evidence remains in the video');
  const assertionSegments = evidence.edit.segments.filter(s => s.role === 'assertion');
  assert.ok(pixelAt((assertionSegments[0].startMs + 100) / 1000)[1] > 180, 'Passing green assertion evidence remains');
  assert.ok(pixelAt((assertionSegments[1].startMs + 100) / 1000)[2] > 180, 'Failing blue assertion evidence remains');
  assert.ok(pixelAt((assertionSegments[1].startMs + 400) / 1000).every(v => v < 50), 'The internal gap remains explicitly dark');
  assert.ok(evidence.edit.segments.every(s => s.kind === 'evidence'), 'No intro or result intervals are added');
  assert.ok(evidence.segments.every(s => ['frame', 'gap'].includes(s.kind)), 'Only recorded frames and missing-footage gaps are encoded');
  assert.ok(!fs.readdirSync(path.join(broker.exports.root, run.id)).some(name => /^qa-v3-.*(?:card|srt|filter)/.test(name)));
  const top = path.join(root, 'footage-top.rgb');
  await mediaProcess('ffmpeg', ['-v', 'error', '-i', qa.file, '-frames:v', '1',
    '-vf', "fps=40,select='eq(n,8)',crop=600:30:170:6", '-f', 'rawvideo', '-pix_fmt', 'rgb24', top]);
  const topPixels = fs.readFileSync(top);
  assert.equal(topPixels.length, 600 * 30 * 3);
  for (let i = 0; i < topPixels.length; i += 3)
    assert.ok(topPixels[i] > 180 && topPixels[i + 1] > 180 && topPixels[i + 2] < 60, 'No caption obscures the yellow input footage');
  assert.deepEqual(immutable.map(digest), before, 'QA derivation never rewrites source video, poster, summary, journal or JPEGs');
  assert.equal(report.sourceArtifact, sourceFiles[0]);
  service = createQAServer(broker);
  const origin = await service.listen(0), auth = { Authorization: 'Bearer ' + service.agentToken, 'X-QA-Request': '1' };
  for (const name of ['qa-v3-recording.mp4', 'recording.mp4', 'qa-v3-poster.jpg', 'qa-v3-summary.json']) {
    const route = `${origin}/api/runs/${run.id}/${name}`;
    assert.equal((await fetch(route, { headers: { ...auth, Range: 'bytes=0-15' } })).status, 206);
    assert.equal((await fetch(route, { headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 401);
    assert.equal((await fetch(route, { headers: { ...auth, Origin: 'https://evil.test' } })).status, 403);
    assert.equal((await fetch(route, { headers: { ...auth, Range: 'bytes=999999999-' } })).status, 416);
  }
  assert.equal((await fetch(`${origin}/api/runs/${run.id}/qa-v3-state.json`, { headers: auth })).status, 404);
  const pair = await fetch(origin + '/session', { method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', 'X-QA-Request': '1' }, body: JSON.stringify({ code: service.pairingCode }) });
  const cookie = pair.headers.get('set-cookie').split(';')[0], route = `${origin}/api/runs/${run.id}/qa-v3-recording.mp4`;
  assert.equal((await fetch(route, { headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin', Range: 'bytes=-16' } })).status, 206);
  assert.equal((await fetch(route, { headers: { Cookie: cookie, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await fetch(`${origin}/api/runs/${run.id}/qa-v3-card-0-result.jpg`, { headers: auth })).status, 404);
  await broker.exports.close();
  const reopened = new Exporter(store);
  assert.equal(reopened.state(run.id).status, 'ready');
  assert.equal(reopened.state(run.id, 'qa').status, 'ready');
  reopened.save(run.id, { status: 'encoding' }, 'qa'); await reopened.close();
  const recovered = new Exporter(store);
  assert.equal(recovered.state(run.id, 'qa').code, 'export_interrupted');
  assert.equal(recovered.state(run.id).status, 'ready');
  recovered.request(run.id, true, 'qa');
  assert.equal((await recovered.wait(run.id, 30000, 'qa')).status, 'ready');
  assert.deepEqual(immutable.map(digest), before);
  await recovered.close();
  console.log(`QA derivative: ffprobe=${seconds}s, source≈5s, decoded=${samples.length} samples; setup/idle red excluded; legitimate yellow input, green/pass, blue/fail, unobscured footage and gap verified; source hashes unchanged.`);
});

test('source and QA exports share one worker and one bounded queue; empty QA never produces a replacement video', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-edit-queue-'));
  const store = new RunStore(root), exporter = new Exporter(store);
  t.after(async () => { await exporter.close(); store.close(); fs.rmSync(root, { recursive: true }); });
  const run = store.start({}, {}, 'agent'); store.finish(run, 'uncertain', 'empty');
  exporter.request(run.id, false, 'qa');
  const state = await exporter.wait(run.id, 30000, 'qa');
  assert.equal(state.code, 'qa_no_completed_checks');
  assert.equal(exporter.state(run.id).status, 'not_requested');
  assert.throws(() => exporter.artifact(run.id, 'qa-v3-recording.mp4'), /export_not_ready/);
  let active = 0;
  exporter.encode = async (_id, signal) => {
    assert.equal(++active, 1);
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    active--;
  };
  const ids = Array.from({ length: 3 }, () => {
    const r = store.start({}, {}, 'agent'); store.finish(r, 'uncertain', 'queue'); return r.id;
  });
  exporter.request(ids[0]); exporter.request(ids[0], false, 'qa');
  exporter.request(ids[1]); exporter.request(ids[1], false, 'qa');
  exporter.request(ids[2]);
  assert.throws(() => exporter.request(ids[2], false, 'qa'), /export_queue_full/);
  await exporter.close();
  assert.equal(exporter.state(ids[0], 'qa').code, 'export_interrupted');
  assert.equal(exporter.state(ids[1]).code, 'export_interrupted');
  assert.equal(exporter.state(ids[1], 'qa').code, 'export_interrupted');
});

test('QA artifact names retain private-file checks, strict whitelist and combined storage accounting', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-edit-safety-'));
  const store = new RunStore(root), exporter = new Exporter(store);
  t.after(async () => { await exporter.close(); store.close(); fs.rmSync(root, { recursive: true }); });
  const run = store.start({}, {}, 'agent'); store.finish(run, 'uncertain', 'safety fixture');
  exporter.save(run.id, { status: 'ready' }, 'qa');
  const directory = path.join(exporter.root, run.id);
  fs.writeFileSync(path.join(directory, 'qa-v3-summary.json'), 'x'.repeat(4096), { mode: 0o600 });
  assert.ok(exporter.bytes() >= 4096);
  assert.throws(() => new Exporter(store, { ...EXPORT_POLICY, totalBytes: 1024 }), /export_storage_full/);
  assert.throws(() => exporter.artifact(run.id, 'qa-v3-state.json'), /export_not_ready/);
  assert.throws(() => exporter.artifact(run.id, '../qa-v3-summary.json'), /export_not_ready/);
  fs.symlinkSync(run.file, path.join(directory, 'qa-v3-recording.mp4'));
  assert.throws(() => exporter.artifact(run.id, 'qa-v3-recording.mp4'), /unsafe_export_storage/);
  assert.throws(() => new Exporter(store), /unsafe_export_storage/);
});

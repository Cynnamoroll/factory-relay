import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunStore, opaque } from '../src/qa-store.js';
import { Exporter, recordingSegments, mediaProcess, EXPORT_POLICY } from '../src/qa-export.js';
import { Broker } from '../src/qa-broker.js';
import { createQAServer } from '../src/qa-server.js';

test('timestamped JPEG spool exports real variable-timestamp H264, captions, explicit gaps and private range downloads', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-video-test-'));
  const store = new RunStore(path.join(root, 'runs'));
  const broker = new Broker(store, {});
  let service;
  t.after(async () => { if (service) await service.close(); await broker.close(); fs.rmSync(root, { recursive: true }); });
  const images = [];
  for (const color of ['red', 'blue']) {
    const file = path.join(root, color + '.jpg');
    await mediaProcess('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=320x240`,
      '-frames:v', '1', '-threads', '2', file]);
    images.push(fs.readFileSync(file));
  }
  const run = store.start({ windowId: 1, pid: 2, bundleId: 'com.factory.applets.RelayMac' }, { title: 'Generated timestamp evidence' }, 'agent');
  const at = ms => { run.monoStart = performance.now() - ms; };
  let version = 0;
  const frame = (ms, bytes) => {
    at(ms); return store.frame(run, { image: bytes, version: ++version, receivedAt: Date.now(), receivedMono: performance.now(),
      header: { type: 'frame', sequence: version, captureTimeSeconds: 100 + ms / 1000 } }, true);
  };
  frame(0, images[0]); frame(400, images[1]);
  const stepId = opaque();
  at(600); store.append(run, { kind: 'step-start', operation: 'assert-count', title: 'Intentional mismatch', stepId });
  at(800); store.append(run, { kind: 'assertion', title: 'Intentional mismatch', context: 'Generated export test only', stepId, status: 'fail', expected: 5, actual: 1 });
  at(900); store.append(run, { kind: 'gap', reason: 'ownership_change' });
  frame(1800, images[0]);
  at(2600); store.finish(run, 'fail', 'caller_stopped');
  broker.exports.request(run.id);
  const state = await broker.exports.wait(run.id, 30000);
  assert.equal(state.status, 'ready', JSON.stringify(state));
  const artifact = broker.exports.artifact(run.id, 'recording.mp4');
  const probe = JSON.parse(await mediaProcess('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name',
    '-of', 'json', artifact.file]));
  assert.equal(probe.streams[0].codec_name, 'h264');
  assert.ok(Math.abs(Number(probe.format.duration) - 2.6) < 0.1, 'Independent ffprobe must preserve 2.6 seconds, not frame-count/FPS duration');
  const evidence = JSON.parse(fs.readFileSync(broker.exports.artifact(run.id, 'summary.json').file));
  assert.ok(evidence.segments.some(s => s.kind === 'gap' && Math.abs(s.startMs - 900) < 20 && Math.abs(s.endMs - 1800) < 20));
  assert.equal(evidence.checks[0].status, 'fail');
  assert.equal(evidence.checks[0].title, 'Intentional mismatch');
  assert.ok(evidence.sourceFrames.every(f => typeof f.captureTimeSeconds === 'number' && typeof f.receivedElapsedMs === 'number'));
  const timing = JSON.parse(await mediaProcess('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'frame=best_effort_timestamp_time', '-of', 'json', artifact.file])).frames.map(f => Number(f.best_effort_timestamp_time));
  assert.ok(timing.some(x => Math.abs(x - 0.4) < 0.02), 'Second captured image must retain its 400ms presentation time');
  assert.ok(timing.some(x => Math.abs(x - 1.8) < 0.02), 'Capture must resume at 1800ms after the explicit gap');
  const pixelFile = path.join(root, 'gap-pixel.rgb');
  await mediaProcess('ffmpeg', ['-v', 'error', '-i', artifact.file, '-frames:v', '1',
    '-vf', "select='between(t,0.88,0.93)',crop=2:2:640:200,scale=1:1", '-fps_mode', 'vfr', '-f', 'rawvideo', '-pix_fmt', 'rgb24', pixelFile]);
  const gapPixel = fs.readFileSync(pixelFile);
  assert.equal(gapPixel.length, 3);
  assert.ok([...gapPixel].every(channel => channel < 45), 'Gap footage must actually be a dark missing-footage card, not a held red/blue sample');
  service = createQAServer(broker);
  const origin = await service.listen(0);
  const route = `/api/runs/${run.id}/recording.mp4`;
  const auth = { Authorization: 'Bearer ' + service.agentToken, 'X-QA-Request': '1' };
  const partial = await fetch(origin + route, { headers: { ...auth, Range: 'bytes=0-31' } });
  assert.equal(partial.status, 206);
  assert.match(partial.headers.get('content-range'), /^bytes 0-31\/\d+$/);
  assert.equal((await partial.arrayBuffer()).byteLength, 32);
  assert.equal((await fetch(origin + route, { headers: { ...auth, Range: 'bytes=999999999-' } })).status, 416);
  assert.equal((await fetch(origin + route, { headers: { ...auth, Range: 'bytes=0-1,3-4' } })).status, 416);
  assert.equal((await fetch(origin + route, { headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 401);
  assert.equal((await fetch(origin + route, { headers: { ...auth, Origin: 'https://evil.test' } })).status, 403);
  const pair = await fetch(origin + '/session', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-QA-Request': '1' },
    body: JSON.stringify({ code: service.pairingCode }) });
  const cookie = pair.headers.get('set-cookie').split(';')[0];
  const browserMedia = await fetch(origin + route, { headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin', Range: 'bytes=-16' } });
  assert.equal(browserMedia.status, 206, 'Cookie-authorized HTML video Range requests need no custom header');
  assert.equal((await browserMedia.arrayBuffer()).byteLength, 16);
  assert.equal((await fetch(origin + route, { headers: { Cookie: cookie, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await fetch(origin + `/api/runs/${run.id}/%2e%2e%2fstate.json`, { headers: auth })).status, 404);
  const shell = await fetch(origin + '/', { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(shell.status, 200, 'A token-free chat replay link may open the public shell');
  assert.match(shell.headers.get('content-security-policy'), /media-src 'self' blob:/);
  const report = await broker.task('agent', 'qa_report', { runId: run.id, waitMs: 30000 });
  assert.match(report.replayUrl, new RegExp(`#run=${run.id}&step=${stepId}`));
  assert.equal(report.sourceArtifact, artifact.file);
  assert.equal(report.export.status, 'ready', JSON.stringify(report.export));
  assert.match(report.reportMarkdown, /expected 5, observed 1/);
  assert.ok(report.reportMarkdown.includes(`[![QA recording preview](${report.artifacts['qa-v3-poster.jpg']})](${report.replayUrl})`),
    'Chat uses a visible poster linked to replay, not an unsupported inline MP4 image');
  assert.ok(!report.reportMarkdown.includes(`![QA recording](${artifact.file})`));
  assert.ok(report.reportMarkdown.includes(`[Download QA video](${report.artifacts['qa-v3-recording.mp4']})`));
  assert.ok(report.reportMarkdown.includes(`[Full session evidence, separate from QA video](${artifact.file})`));
  assert.ok(!JSON.stringify(report).includes(service.agentToken));
  await broker.exports.close();
  const reopened = new Exporter(store);
  assert.equal(reopened.state(run.id).status, 'ready');
  assert.equal(reopened.artifact(run.id, 'recording.mp4').size, artifact.size);
  await reopened.close();
  fs.writeFileSync(path.join(reopened.root, run.id, 'state.json'), '{"status":', { mode: 0o600 });
  const interruptedExport = new Exporter(store);
  assert.equal(interruptedExport.state(run.id).code, 'export_interrupted');
  assert.equal(interruptedExport.request(run.id).status, 'error', 'A failed export requires explicit read-only retry');
  interruptedExport.request(run.id, true);
  assert.equal((await interruptedExport.wait(run.id, 30000)).status, 'ready', 'Retry must regenerate the video offline without native operations');
  await interruptedExport.close();
  console.log(`Export evidence: duration=${probe.format.duration}s, bytes=${artifact.size}, encode=${state.measuredEncodeMs}ms, explicitGap=900..1800ms`);
});
test('one export worker and four queued jobs are enforced, and shutdown marks queued work interrupted', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-export-queue-'));
  const store = new RunStore(root), exporter = new Exporter(store);
  t.after(async () => { await exporter.close(); store.close(); fs.rmSync(root, { recursive: true }); });
  let running = 0;
  exporter.encode = async (id, signal) => {
    running++; assert.equal(running, 1);
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    running--;
  };
  const ids = Array.from({ length: 6 }, () => {
    const run = store.start({}, {}, 'agent'); store.finish(run, 'interrupted', 'queue test'); return run.id;
  });
  for (const id of ids.slice(0, 5)) exporter.request(id);
  assert.throws(() => exporter.request(ids[5]), /export_queue_full/);
  await exporter.close();
  for (const id of ids.slice(1, 5)) assert.equal(exporter.state(id).code, 'export_interrupted');
});
test('gap model never presents a sample indefinitely; invalid duration and export queue/storage are bounded', async t => {
  assert.deepEqual(recordingSegments([{ kind: 'frame', frameId: 'f', elapsedMs: 0 }], 2500), [
    { startMs: 0, endMs: 1000, kind: 'frame', frameId: 'f' },
    { startMs: 1000, endMs: 2500, kind: 'gap', reason: 'No recorded footage' },
  ]);
  const multiple = recordingSegments([{ kind: 'frame', frameId: 'f', elapsedMs: 0 },
    { kind: 'assertion', elapsedMs: 2000 }, { kind: 'assertion', elapsedMs: 2200 }], 3000);
  assert.equal(multiple.reduce((sum, s) => sum + s.endMs - s.startMs, 0), 3000, 'Multiple captions inside an unknown gap must not duplicate time');
  assert.throws(() => recordingSegments([], 690001), /export_duration_limit/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-export-bound-'));
  const store = new RunStore(root), exporter = new Exporter(store, { ...EXPORT_POLICY, totalBytes: 1000 });
  t.after(async () => { await exporter.close(); store.close(); fs.rmSync(root, { recursive: true }); });
  const run = store.start({}, {}, 'agent'); store.finish(run, 'interrupted', 'test');
  assert.throws(() => exporter.request(run.id), /export_storage_full/);
  assert.throws(() => exporter.artifact(run.id, '../state.json'), /export_not_ready/);
});

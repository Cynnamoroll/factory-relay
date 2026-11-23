import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunStore, opaque } from '../src/qa-store.js';
import http from 'node:http';
import { Broker, leaseScope } from '../src/qa-broker.js';
import { createQAServer } from '../src/qa-server.js';

const target = { windowId: 7, pid: 12, bundleId: 'com.factory.applets.RelayMac' };
const image = Buffer.from([255, 216, 255, 217]);
function tempStore(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'applets-qa-recording-'));
  const store = new RunStore(root);
  t.after(() => { try { store.close(); } catch {} fs.rmSync(root, { recursive: true, force: true }); });
  return store;
}
function fake() {
  let generation = 0, callback, valid, count = 0;
  const calls = [];
  return {
    calls,
    emit: () => callback?.({ image, header: { type: 'frame', ...target } }),
    acquire: async (takeover, ttl, scope) => { calls.push(['acquire', scope]); return { token: 'a'.repeat(64), generation: ++generation }; },
    release: async () => { calls.push(['release']); },
    windows: async () => [target],
    stream: async (lease, selected, signal, consume) => {
      callback = consume; consume({ image, header: { type: 'frame', ...target } });
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      callback = null;
    },
    observe: async () => {
      valid = opaque();
      return { observationId: valid, expiresAt: Date.now() / 1000 + 30,
        snapshot: { target, elements: [{ id: 'relay-count', value: `Count: ${count}` }] } };
    },
    press: async () => { calls.push(['press']); count++; },
  };
}

test('live frame writes run off the capture path, drop background samples beyond the queue and await evidence', async t => {
  const store = tempStore(t);
  const run = store.start(target, {}, 'agent');
  store.policy = { ...store.policy, sampleMs: 0 };
  const pending = [];
  for (let version = 1; version <= 6; version++)
    pending.push(store.frameAsync(run, { image, header: {}, version }));
  assert.equal(run.pendingWrites, store.maxPendingWrites, 'Background samples never queue beyond the bound');
  assert.equal(run.droppedSamples, 4, 'Samples beyond the bound are dropped, not queued');
  const forced = await store.frameAsync(run, { image, header: {}, version: 7 }, true);
  assert.equal(forced.kind, 'frame', 'Evidence frames are written even when samples are dropped');
  await Promise.all(pending);
  await store.flush(run);
  assert.equal(run.events.filter(e => e.kind === 'frame').length, 3);
  for (const e of run.events.filter(e => e.kind === 'frame'))
    assert.deepEqual(store.image(run.id, e.frameId), image, 'Each committed frame event has its durable image');
  assert.equal((await store.frameAsync(run, { image, header: {}, version: 7 }, true)).frameId, forced.frameId,
    'A repeated version reuses the existing evidence frame');
});

test('a failed asynchronous write fences the journal and blocks later input', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'applets-qa-fault-'));
  const native = fake();
  const broker = new Broker(new RunStore(root), native, { frameWaitMs: 25 });
  t.after(async () => { await broker.close().catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); });
  await broker.command('agent', { op: 'connect' });
  assert.deepEqual(native.calls.at(-1), ['acquire', { kind: 'observer' }], 'Viewing takes a non-blocking observer lease');
  await broker.command('agent', { op: 'select', target });
  const { grant } = await broker.command('agent', { op: 'take', takeover: false });
  assert.deepEqual(native.calls.filter(c => c[0] === 'acquire').at(-1), ['acquire', leaseScope(target, true)],
    'Input takes a lease scoped to the selected window');
  const { runId } = await broker.command('agent', { op: 'start', grant, labels: {} });
  const observed = await broker.command('agent', { op: 'observe', grant });
  const run = broker.store.get(runId);
  fs.chmodSync(run.dir, 0o500);
  broker.store.policy = { ...broker.store.policy, sampleMs: 0 };
  broker.latest = { ...broker.latest, version: ++broker.frameVersion };
  try { await assert.rejects(broker.store.frameAsync(run, broker.latest), /recording_error/); }
  finally { fs.chmodSync(run.dir, 0o700); }
  assert.equal(broker.store.fault, true);
  await assert.rejects(broker.command('agent', { op: 'press', grant, observationId: observed.observationId }), /recording_error/);
  assert.ok(!native.calls.some(c => c[0] === 'press'), 'No input is dispatched after a recording fault');
  assert.throws(() => broker.store.append(run, { kind: 'note' }), /recording_error/);
});

test('lease scopes keep desktops exclusive and viewing non-blocking', () => {
  assert.deepEqual(leaseScope(target, false), { kind: 'observer' });
  assert.deepEqual(leaseScope({ kind: 'desktop', displayId: 1, displayUUID: 'x' }, true), { kind: 'exclusive' });
  assert.deepEqual(leaseScope({ kind: 'desktop', displayId: 1, displayUUID: 'x' }, false), { kind: 'exclusive' });
  assert.deepEqual(leaseScope(null, true), { kind: 'exclusive' });
  assert.deepEqual(leaseScope({ ...target, title: 'ignored' }, true), { kind: 'window', target });
});

test('a requested live run is echoed only for its active capture and ends before another target can write', async t => {
  const broker = new Broker(tempStore(t), fake());
  const service = createQAServer(broker);
  const origin = await service.listen(0);
  t.after(async () => { await service.close(); await broker.close().catch(() => {}); });
  await broker.command('agent', { op: 'connect' });
  await broker.command('agent', { op: 'select', target });
  const { grant } = await broker.command('agent', { op: 'take', takeover: false });
  const { runId } = await broker.command('agent', { op: 'start', grant, labels: {} });
  const open = id => fetch(origin + '/api/live/stream', { headers: { 'X-QA-Request': '1',
    Authorization: `Bearer ${service.agentToken}`, 'X-QA-Live-Run': id } });
  const wrong = await open('9'.repeat(32));
  await wrong.body.cancel();
  assert.equal(wrong.status, 409);
  const response = await open(runId);
  assert.equal(response.headers.get('X-QA-Live-Run'), runId);
  const reader = response.body.getReader();
  assert.ok((await reader.read()).value.length > 0);
  broker.target = { ...target, pid: target.pid + 1 };
  for (const push of broker.viewers) push(broker.latest);
  assert.equal((await reader.read()).done, true);
  const changed = await open(runId);
  await changed.body.cancel();
  assert.equal(changed.status, 409);
});

test('the authenticated live push stream drops frames for a stalled viewer and resumes at the newest frame', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'applets-qa-push-'));
  const broker = new Broker(new RunStore(root), fake(), { frameWaitMs: 25 });
  const service = createQAServer(broker);
  const origin = await service.listen(0);
  t.after(async () => { await service.close(); await broker.close().catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); });
  const denied = await fetch(origin + '/api/live/stream', { headers: { 'X-QA-Request': '1' } });
  assert.equal(denied.status, 401, 'The push stream requires the same authentication as every API route');
  const req = http.get(origin + '/api/live/stream', { headers: { Authorization: `Bearer ${service.agentToken}`, 'X-QA-Request': '1' } });
  t.after(() => req.destroy());
  const response = await new Promise((resolve, reject) => { req.on('error', reject); req.on('response', resolve); });
  assert.equal(response.headers['content-type'], 'application/x-qa-frames');
  response.pause();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(broker.viewers.size, 1);
  const big = Buffer.alloc(512 * 1024, 7);
  const started = performance.now();
  for (let version = 1; version <= 100; version++) {
    broker.latest = { image: big, header: { sequence: version }, version, receivedAt: Date.now(), receivedMono: performance.now() };
    for (const push of broker.viewers) push(broker.latest);
  }
  assert.ok(performance.now() - started < 1000, 'Pushing to a stalled viewer never blocks the producer');
  const chunks = [];
  response.on('data', chunk => chunks.push(chunk));
  response.resume();
  const headers = [];
  for (let attempt = 0; attempt < 100; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 20));
    let buffer = Buffer.concat(chunks);
    headers.length = 0;
    while (buffer.length >= 4) {
      const length = buffer.readUInt32BE(0);
      if (buffer.length < 4 + length) break;
      const header = JSON.parse(buffer.subarray(4, 4 + length));
      if (buffer.length < 4 + length + header.bytes) break;
      headers.push(header);
      buffer = buffer.subarray(4 + length + header.bytes);
    }
    if (headers.at(-1)?.version === 100) break;
  }
  assert.equal(headers.at(-1)?.version, 100, 'The viewer resumes at the newest frame');
  assert.ok(headers.length < 100, `A stalled viewer skips intermediate frames (${headers.length} delivered)`);
  assert.ok(headers.at(-1).dropped > 0, 'The stream reports how many frames the server dropped');
});
test('a mid-stream live viewer joins at a keyframe and never receives a delta first', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'applets-qa-join-'));
  const broker = new Broker(new RunStore(root), fake(), { frameWaitMs: 25 });
  const service = createQAServer(broker);
  const origin = await service.listen(0);
  t.after(async () => { await service.close(); await broker.close().catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); });
  const au = Buffer.from([0, 0, 0, 1, 0x65, 0x88]);
  broker.latestVideo = { header: { type: 'vframe', sequence: 8, keyframe: false, captureTimeSeconds: 1.8 }, image: au };
  broker.latestKeyframe = { header: { type: 'vframe', sequence: 6, keyframe: true, captureTimeSeconds: 1.0 }, image: au };
  broker.latest = { image, header: { type: 'frame', sequence: 7, captureTimeSeconds: 1.9 },
    version: 7, receivedAt: Date.now(), receivedMono: performance.now() };
  const req = http.get(origin + '/api/live/stream', { headers: { Authorization: `Bearer ${service.agentToken}`, 'X-QA-Request': '1' } });
  t.after(() => req.destroy());
  const response = await new Promise((resolve, reject) => { req.on('error', reject); req.on('response', resolve); });
  const packets = [];
  let buffer = Buffer.alloc(0);
  response.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 4) return;
      const length = buffer.readUInt32BE(0);
      if (buffer.length < 4 + length) return;
      const header = JSON.parse(buffer.subarray(4, 4 + length));
      if (buffer.length < 4 + length + header.bytes) return;
      packets.push(header);
      buffer = buffer.subarray(4 + length + header.bytes);
    }
  });
  const waitPackets = async count => {
    for (let attempt = 0; attempt < 100 && packets.length < count; attempt++)
      await new Promise(resolve => setTimeout(resolve, 20));
  };
  const emit = packet => { for (const push of broker.viewers) push(packet); };
  await waitPackets(2);
  assert.deepEqual(packets.map(p => [p.type, p.sequence]), [['vframe', 6], ['frame', 7]],
    'A joining viewer first gets the cached keyframe access unit and the newest JPEG snapshot');
  emit({ header: { type: 'vframe', sequence: 9, keyframe: false, captureTimeSeconds: 2.0 }, image: au });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(packets.length, 2, 'Non-key access units are held back until the first live keyframe');
  emit({ header: { type: 'vframe', sequence: 10, keyframe: true, captureTimeSeconds: 2.1 }, image: au });
  await waitPackets(3);
  emit({ header: { type: 'vframe', sequence: 11, keyframe: false, captureTimeSeconds: 2.2 }, image: au });
  await waitPackets(4);
  assert.deepEqual(packets.map(p => [p.type, p.sequence, p.keyframe]),
    [['vframe', 6, true], ['frame', 7, undefined], ['vframe', 10, true], ['vframe', 11, false]],
    'After the first live keyframe, access units flow in order');
  emit({ header: { type: 'vframe', sequence: 1, keyframe: false, captureTimeSeconds: 3.0 }, image: au });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(packets.length, 4, 'A restarted stream sequence re-arms the keyframe gate for deltas');
  emit({ header: { type: 'vframe', sequence: 2, keyframe: true, captureTimeSeconds: 3.1 }, image: au });
  emit({ header: { type: 'vframe', sequence: 3, keyframe: false, captureTimeSeconds: 3.2 }, image: au });
  await waitPackets(6);
  assert.deepEqual(packets.slice(4).map(p => [p.type, p.sequence, p.keyframe]),
    [['vframe', 2, true], ['vframe', 3, false]], 'The viewer rejoins the restarted stream at its keyframe');
});

test('a lost stream reconnects within bounds and records the interruption instead of killing the run', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'applets-qa-reconnect-'));
  let attempts = 0, failNow = false;
  const native = {
    acquire: async () => ({ token: 'a'.repeat(64), generation: 1 }),
    release: async () => {},
    windows: async () => [target],
    stream: async (lease, selected, signal, consume) => {
      attempts++;
      consume({ image, header: { type: 'frame', ...target } });
      while (!failNow && !signal.aborted) await new Promise(resolve => setTimeout(resolve, 5));
      if (failNow) { failNow = false; throw new Error('stream_terminated'); }
    },
    observe: async () => ({ observationId: 'o'.repeat(32), expiresAt: Date.now() / 1000 + 30,
      snapshot: { target, elements: [{ id: 'relay-count', value: 'Count: 0' }] } }),
  };
  const broker = new Broker(new RunStore(root), native, { frameWaitMs: 25, reconnectMs: 1 });
  t.after(async () => { await broker.close().catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); });
  await broker.command('agent', { op: 'connect' });
  await broker.command('agent', { op: 'select', target });
  const { grant } = await broker.command('agent', { op: 'take', takeover: false });
  await broker.command('agent', { op: 'start', grant, labels: {} });
  assert.equal(broker.status().connection, 'live');
  const before = attempts;
  failNow = true;
  for (let wait = 0; wait < 200 && attempts === before; wait++) await new Promise(resolve => setTimeout(resolve, 10));
  for (let wait = 0; wait < 200 && broker.status().connection !== 'live'; wait++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(attempts, before + 1, 'The broker redialed the stream once');
  assert.equal(broker.status().connection, 'live', 'The run continues on the reconnected stream');
  assert.ok(broker.active.events.some(e => e.kind === 'gap' && e.status === 'reconnecting' && e.reason === 'stream_terminated'),
    'The interruption is recorded as a reconnecting gap, not a run end');
  assert.equal(broker.status().runId !== null, true, 'The run is still active');
});

test('a stream that never recovers disconnects after the bounded attempts', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'applets-qa-giveup-'));
  let attempts = 0;
  const native = {
    acquire: async () => ({ token: 'a'.repeat(64), generation: 1 }),
    release: async () => {},
    windows: async () => [target],
    stream: async () => { attempts++; throw new Error('stream_terminated'); },
  };
  const broker = new Broker(new RunStore(root), native, { frameWaitMs: 25, reconnectMs: 1, reconnectAttempts: 2 });
  t.after(async () => { await broker.close().catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); });
  await broker.command('agent', { op: 'connect' });
  await broker.command('agent', { op: 'select', target });
  await broker.stream.done;
  assert.equal(attempts, 3, 'Initial attempt plus the bounded retries, then give up');
  assert.equal(broker.status().error, 'stream_terminated');
});

test('a reconnect invalidates in-flight observations and ignores packets from the old stream', async t => {
  const native = fake(), observe = native.observe;
  const observing = Promise.withResolvers(), resume = Promise.withResolvers(), redial = Promise.withResolvers();
  let fail, oldConsume, pending;
  native.stream = (lease, selected, signal, consume) => {
    const packet = { image, header: { type: 'frame', ...target } };
    if (pending) redial.resolve({ lease, consume: () => consume(packet) });
    else consume(packet);
    oldConsume = () => consume(packet);
    return new Promise((resolve, reject) => {
      fail = () => reject(new Error('stream_terminated'));
      signal.addEventListener('abort', resolve, { once: true });
    });
  };
  native.observe = async () => {
    const result = await observe();
    if (pending) { observing.resolve(); await resume.promise; }
    return result;
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'applets-qa-late-frame-'));
  const broker = new Broker(new RunStore(root), native, { reconnectMs: 1 });
  t.after(async () => { try { await broker.close(); } finally { fs.rmSync(root, { recursive: true, force: true }); } });
  await broker.command('agent', { op: 'connect' });
  await broker.command('agent', { op: 'select', target });
  const { grant } = await broker.command('agent', { op: 'take' });
  await broker.command('agent', { op: 'start', grant });
  const { observationId } = await broker.command('agent', { op: 'observe', grant });
  const oldLease = broker.lease, latePacket = oldConsume;
  pending = true;
  const result = broker.command('agent', { op: 'observe', grant });
  await observing.promise;
  fail();
  const next = await redial.promise;
  latePacket();
  assert.equal(broker.latest, null);
  assert.equal(broker.observation, null);
  assert.equal(broker.connection, 'connecting');
  assert.equal(next.lease, oldLease);
  resume.resolve();
  await assert.rejects(result, /observation_stale/);
  await assert.rejects(broker.command('agent', { op: 'press', grant, observationId }), /live_frame_required/);
  next.consume();
  await assert.rejects(broker.command('agent', { op: 'press', grant, observationId }), /observation_stale/);
  assert.ok(!native.calls.some(([op]) => op === 'press'));
});

test('a permission refusal is terminal; cancelling backoff never redials', async t => {
  for (const reason of ['screen_recording_required', 'stale_lease', 'stream_terminated']) {
    let attempts = 0;
    const native = { ...fake(), stream: async () => { attempts++; throw new Error(reason); } };
    const broker = new Broker(tempStore(t), native, { reconnectMs: 10_000 });
    await broker.command('agent', { op: 'connect' });
    await broker.command('agent', { op: 'select', target });
    assert.equal(broker.status().connection, reason === 'stream_terminated' ? 'connecting' : 'disconnected');
    await broker.close();
    assert.equal(attempts, 1);
  }
});

test('a stalled live viewer never receives a delta whose reference was dropped', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'applets-qa-stall-'));
  const broker = new Broker(new RunStore(root), fake(), { frameWaitMs: 25 });
  const service = createQAServer(broker);
  const origin = await service.listen(0);
  t.after(async () => { await service.close(); await broker.close().catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); });
  const req = http.get(origin + '/api/live/stream', { headers: { Authorization: `Bearer ${service.agentToken}`, 'X-QA-Request': '1' } });
  t.after(() => req.destroy());
  const response = await new Promise((resolve, reject) => { req.on('error', reject); req.on('response', resolve); });
  response.pause();
  await new Promise(resolve => setTimeout(resolve, 50));
  const big = Buffer.alloc(512 * 1024, 7);
  let sequence = 0;
  const emit = (type, keyframe) => {
    const packet = type === 'vframe'
      ? { header: { type, sequence: ++sequence, keyframe }, image: big }
      : { header: { type, sequence: ++sequence }, image: big, version: sequence, receivedAt: Date.now(), receivedMono: performance.now() };
    for (const push of broker.viewers) push(packet);
  };
  emit('vframe', true);
  for (let i = 0; i < 3; i++) emit('vframe', false);
  emit('frame');
  for (let i = 0; i < 40; i++) emit('vframe', false);
  emit('frame');
  const recovery = sequence + 1;
  emit('vframe', true);
  emit('vframe', false);
  const packets = [];
  let buffer = Buffer.alloc(0);
  response.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32BE(0);
      if (buffer.length < 4 + length) break;
      const header = JSON.parse(buffer.subarray(4, 4 + length));
      if (buffer.length < 4 + length + header.bytes) break;
      packets.push(header);
      buffer = buffer.subarray(4 + length + header.bytes);
    }
  });
  response.resume();
  for (let attempt = 0; attempt < 200 && !packets.some(p => p.sequence === recovery + 1); attempt++)
    await new Promise(resolve => setTimeout(resolve, 20));
  const video = packets.filter(p => p.type === 'vframe');
  assert.ok(video.some(p => p.sequence === recovery + 1), 'Video resumes after the next keyframe');
  for (let i = 1; i < video.length; i++) if (!video[i].keyframe)
    assert.equal(video[i].sequence, video[i - 1].sequence + 1, `delta ${video[i].sequence} follows its reference ${video[i - 1].sequence}`);
  assert.ok(video.length < 46, `The stalled backlog was dropped (${video.length} access units delivered)`);
  assert.ok(packets.some(p => p.type === 'frame'), 'JPEG snapshots still reach the viewer');
});

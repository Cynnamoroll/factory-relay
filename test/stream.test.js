import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { decodeStream, HEADER_LIMIT, IMAGE_LIMIT, streamTargetSchema } from '../src/stream.js';

const frame = { protocol: 1, type: 'frame', sequence: 1, windowId: 5, pid: 12,
  bundleId: 'com.factory.applets.RelayMac', mediaType: 'image/jpeg', width: 200, height: 100,
  captureTimeSeconds: 10, sentUptimeSeconds: 10.1, contentRectPixels: [0, 0, 200, 100],
  initialWindowRectPoints: [5, 8, 100, 50], contentScale: 1, scaleFactor: 2, replacedFrames: 0, bytes: 4 };
function packet(header = frame, image = Buffer.from([255, 216, 255, 217])) {
  const json = Buffer.from(JSON.stringify(header)), size = Buffer.alloc(4);
  size.writeUInt32BE(json.length);
  return Buffer.concat([size, json, image]);
}
async function collect(chunks) {
  const rows = [];
  for await (const value of decodeStream(chunks)) rows.push(value);
  return rows;
}

test('binary frames survive every byte boundary and preserve capture metadata', async () => {
  const bytes = packet();
  const result = await collect([...bytes].map(byte => Buffer.from([byte])));
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].header, frame);
  assert.deepEqual(result[0].image, Buffer.from([255, 216, 255, 217]));
});

test('frame decoder rejects length, truncation, image, sequence and geometry violations', async () => {
  const huge = Buffer.alloc(4); huge.writeUInt32BE(HEADER_LIMIT + 1);
  await assert.rejects(collect([huge]), /invalid_stream_header/);
  await assert.rejects(collect([packet().subarray(0, -1)]), /truncated_stream/);
  await assert.rejects(collect([packet({ ...frame, bytes: IMAGE_LIMIT + 1 })]));
  await assert.rejects(collect([packet(frame, Buffer.alloc(4))]), /invalid_stream_frame/);
  await assert.rejects(collect([packet(), packet()]), /invalid_stream_frame/);
  await assert.rejects(collect([packet({ ...frame, width: 2049 })]));
  await assert.rejects(collect([Buffer.alloc(IMAGE_LIMIT + HEADER_LIMIT + 65541)]), /stream_buffer_limit/);
  assert.throws(() => streamTargetSchema.parse({ windowId: 5, pid: 12, bundleId: 'com.apple.finder' }));
});

test('DeviceHub is an explicit window identity, not an application-wide or guessed-device selector', async () => {
  const target = { windowId: 7, pid: 20, bundleId: 'com.apple.dt.Devices' };
  assert.deepEqual(streamTargetSchema.parse(target), target);
  for (const invalid of [
    { bundleId: target.bundleId }, { ...target, windowId: 0 }, { ...target, allWindows: true },
    { ...target, udid: '35BD5396-ABA0-446F-8757-3DA383C1207B' }, { ...target, bundleId: 'com.apple.dt.Xcode' },
  ]) assert.throws(() => streamTargetSchema.parse(invalid));
  assert.equal((await collect([packet({ ...frame, ...target })]))[0].header.bundleId, target.bundleId);
});

test('startup diagnostics preserve AppKit lifecycle and distinguish filter creation failure', async () => {
  const header = { protocol: 1, type: 'diagnostic', bytes: 0, code: 'capture_unavailable',
    bundleId: 'com.factory.applets.host', bundlePath: '/example/Factory Relay.app',
    executablePath: '/example/Factory Relay.app/Contents/MacOS/AppletsHost',
    screenRecording: true, accessibility: false, permissionRequested: false,
    stage: 'creating_filter',
    lifecycle: { appKitInitialized: true, eventLoopRunning: true, launchFinished: true, mainThread: true } };
  assert.deepEqual((await collect([packet(header, Buffer.alloc(0))]))[0].header, header);
  await assert.rejects(collect([packet({ ...header, stage: 'arbitrary-output' }, Buffer.alloc(0))]));
});

test('decoder does not read ahead while consumer holds a frame', async () => {
  let reads = 0;
  async function* source() {
    reads++; yield packet();
    reads++; yield packet({ ...frame, sequence: 2, replacedFrames: 10 });
  }
  const decoder = decodeStream(source());
  assert.equal((await decoder.next()).value.header.sequence, 1);
  assert.equal(reads, 1, 'Consumer acknowledgment gates the next source read');
  assert.equal((await decoder.next()).value.header.replacedFrames, 10);
  await decoder.return();
});

test('permission denial is a bounded machine-readable non-frame result', async () => {
  const header = { protocol: 1, type: 'diagnostic', bytes: 0, code: 'screen_recording_required',
    bundleId: 'com.factory.applets.host', bundlePath: '/example/Factory Relay.app',
    executablePath: '/example/Factory Relay.app/Contents/MacOS/AppletsHost',
    screenRecording: false, accessibility: false, permissionRequested: false };
  assert.deepEqual((await collect([packet(header, Buffer.alloc(0))]))[0].header, header);
});

test('idle heartbeats are not images or new captured frames', async () => {
  const heartbeat = { protocol: 1, type: 'heartbeat', bytes: 0, sentUptimeSeconds: 20 };
  const result = await collect([packet(), packet(heartbeat, Buffer.alloc(0)), packet({ ...frame, sequence: 2 })]);
  assert.deepEqual(result.map(p => p.header.type), ['frame', 'heartbeat', 'frame']);
  assert.equal(result[1].image.length, 0);
});

test('supervisor uses shared fencing, busy markers, acknowledgment bounds and disconnect cleanup', () => {
  const result = spawnSync('python3', ['test/stream-supervisor.py'], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 20000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /shared fencing and cleanup passed/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeStream } from '../scripts/stream-metrics.js';

test('stream evidence separates clock domains, changing images and idle heartbeats', () => {
  const frames = [
    { receivedAfterStartMs: 50, captureTimeSeconds: 1000, sentUptimeSeconds: 5000, bytes: 40, sha256: 'a', replacedFrames: 0 },
    { receivedAfterStartMs: 100, captureTimeSeconds: 1001, sentUptimeSeconds: 5002, bytes: 40, sha256: 'a', replacedFrames: 2 },
    { receivedAfterStartMs: 400, captureTimeSeconds: 1002, sentUptimeSeconds: 5004, bytes: 50, sha256: 'b', replacedFrames: 5 },
  ];
  const result = summarizeStream(frames, 20);
  assert.equal(result.frameCount, 3);
  assert.equal(result.heartbeats, 20);
  assert.equal(result.firstFrameMs, 50);
  assert.equal(result.imageBytes, 130);
  assert.equal(result.uniqueImages, 2);
  assert.equal(result.contentChanges, 1);
  assert.equal(result.replacedFrames, 5);
  assert.deepEqual(result.captureIntervalsSeconds, [1, 1]);
  assert.deepEqual(result.senderIntervalsSeconds, [2, 2]);
  assert.deepEqual(result.receiveIntervalsMs, [50, 300]);
  assert.equal(result.deliveredSourceRateHz, 1);
  assert.equal(result.frameAgeMs, null, 'Uncorrelated clocks cannot establish frame age');
});

test('zero-frame failures and idle-only streams do not manufacture frame rates', () => {
  const result = summarizeStream([], 7);
  assert.equal(result.frameCount, 0);
  assert.equal(result.imageBytes, 0);
  assert.equal(result.firstFrameMs, null);
  assert.equal(result.deliveredSourceRateHz, null);
  assert.equal(result.receivedImageRateHz, null);
});

test('video metrics report access-unit rate, keyframe cadence and throughput', () => {
  const video = [
    { receivedAfterStartMs: 10, captureTimeSeconds: 100, sentUptimeSeconds: 1, bytes: 2000, sha256: 'k', replacedFrames: 0, keyframe: true },
    { receivedAfterStartMs: 43, captureTimeSeconds: 100.033, sentUptimeSeconds: 1.033, bytes: 500, sha256: 'a', replacedFrames: 0, keyframe: false },
    { receivedAfterStartMs: 76, captureTimeSeconds: 100.066, sentUptimeSeconds: 1.066, bytes: 600, sha256: 'b', replacedFrames: 0, keyframe: false },
    { receivedAfterStartMs: 2010, captureTimeSeconds: 102, sentUptimeSeconds: 3, bytes: 2100, sha256: 'c', replacedFrames: 0, keyframe: true },
  ];
  const result = summarizeStream([], 0, video);
  assert.equal(result.videoFrameCount, 4);
  assert.equal(result.videoBytes, 5200);
  assert.equal(result.videoKeyframes, 2);
  assert.deepEqual(result.keyframeIntervalsSeconds, [2]);
  assert.equal(result.keyframeMaxGapSeconds, 2);
  assert.ok(Math.abs(result.receivedVideoRateHz - 1.5) < 1e-9);
  assert.ok(Math.abs(result.videoDeliveredSourceRateHz - 1.5) < 1e-9);
  assert.equal(result.videoBytesPerSecond, 2600);
  const idle = summarizeStream([], 0, []);
  assert.equal(idle.receivedVideoRateHz, null);
  assert.equal(idle.videoBytesPerSecond, null);
  assert.equal(idle.keyframeMaxGapSeconds, null);
});

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

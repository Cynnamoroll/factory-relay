import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReplayEntry } from '../web/replay-entry.js';

class Video extends EventTarget {
  readyState = 0;
  paused = true;
  calls = 0;
  play() {
    this.calls++;
    this.paused = false;
    return Promise.resolve();
  }
}
test('replay link seeks and starts when media metadata becomes available', async () => {
  const video = new Video();
  const entry = new ReplayEntry(video, () => assert.fail('Playback must start'));
  await entry.openMilliseconds(19929);
  assert.equal(video.calls, 0);
  video.readyState = 1;
  video.dispatchEvent(new Event('loadedmetadata'));
  assert.equal(video.currentTime, 19.929);
  assert.equal(video.muted, true);
  assert.equal(video.paused, false);
  assert.equal(video.calls, 1);
  video.dispatchEvent(new Event('loadedmetadata'));
  assert.equal(video.calls, 1, 'Later media events must not restart user-paused playback');
});
test('same loaded recording can open a new check and play without metadata event', async () => {
  const video = new Video(); video.readyState = 4;
  const entry = new ReplayEntry(video, () => assert.fail('Playback must start'));
  await entry.openMilliseconds(3000);
  video.paused = true;
  await entry.openMilliseconds(7000);
  assert.equal(video.currentTime, 7);
  assert.equal(video.paused, false);
});
test('autoplay rejection reveals fallback and cancelling prevents delayed playback', async () => {
  const video = new Video();
  let blocked = 0;
  const entry = new ReplayEntry(video, () => blocked++);
  await entry.openMilliseconds(2000);
  entry.cancel();
  video.readyState = 4;
  video.dispatchEvent(new Event('loadedmetadata'));
  assert.equal(video.calls, 0);
  video.play = async () => { throw new Error('NotAllowedError'); };
  await entry.openMilliseconds(5000);
  assert.equal(blocked, 1);
});

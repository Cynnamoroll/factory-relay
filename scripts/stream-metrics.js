export function summarizeStream(frames, heartbeats, video = []) {
  const intervalsFor = (rows, key) => rows.slice(1).map((row, i) => row[key] - rows[i][key]);
  const intervals = key => intervalsFor(frames, key);
  const captureIntervalsSeconds = intervals('captureTimeSeconds');
  const receiveIntervalsMs = intervals('receivedAfterStartMs');
  const rate = values => {
    const span = values.reduce((sum, value) => sum + value, 0);
    return values.length && span > 0 ? values.length / span : null;
  };
  // Video access units dominate the live stream; JPEG snapshots remain the image evidence.
  const videoCaptureIntervalsSeconds = intervalsFor(video, 'captureTimeSeconds');
  const videoReceiveIntervalsMs = intervalsFor(video, 'receivedAfterStartMs');
  const keyframes = video.filter(frame => frame.keyframe);
  const keyframeIntervalsSeconds = intervalsFor(keyframes, 'captureTimeSeconds');
  const videoBytes = video.reduce((sum, frame) => sum + frame.bytes, 0);
  const videoSpanMs = video.length > 1 ? video.at(-1).receivedAfterStartMs - video[0].receivedAfterStartMs : 0;
  return {
    frameCount: frames.length, heartbeats,
    firstFrameMs: frames[0]?.receivedAfterStartMs ?? null,
    imageBytes: frames.reduce((sum, frame) => sum + frame.bytes, 0),
    uniqueImages: new Set(frames.map(frame => frame.sha256)).size,
    contentChanges: frames.slice(1).filter((frame, i) => frame.sha256 !== frames[i].sha256).length,
    replacedFrames: Math.max(0, ...frames.map(frame => frame.replacedFrames)),
    captureIntervalsSeconds, senderIntervalsSeconds: intervals('sentUptimeSeconds'), receiveIntervalsMs,
    deliveredSourceRateHz: rate(captureIntervalsSeconds),
    receivedImageRateHz: rate(receiveIntervalsMs.map(value => value / 1000)),
    frameAgeMs: null,
    frameAgeStatus: 'unverified: capture PTS and sender uptime clock correspondence is not established',
    videoFrameCount: video.length,
    videoBytes,
    videoKeyframes: keyframes.length,
    videoCaptureIntervalsSeconds, videoReceiveIntervalsMs, keyframeIntervalsSeconds,
    keyframeMaxGapSeconds: keyframeIntervalsSeconds.length ? Math.max(...keyframeIntervalsSeconds) : null,
    videoDeliveredSourceRateHz: rate(videoCaptureIntervalsSeconds),
    receivedVideoRateHz: rate(videoReceiveIntervalsMs.map(value => value / 1000)),
    videoBytesPerSecond: videoSpanMs > 0 ? Math.round(videoBytes * 1000 / videoSpanMs) : null,
  };
}

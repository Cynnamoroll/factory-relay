export function summarizeStream(frames, heartbeats) {
  const intervals = key => frames.slice(1).map((frame, i) => frame[key] - frames[i][key]);
  const captureIntervalsSeconds = intervals('captureTimeSeconds');
  const receiveIntervalsMs = intervals('receivedAfterStartMs');
  const rate = values => {
    const span = values.reduce((sum, value) => sum + value, 0);
    return values.length && span > 0 ? values.length / span : null;
  };
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
  };
}

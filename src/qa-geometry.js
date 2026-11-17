import { sameTarget, isDesktop, sameDisplayConfiguration, displayConfigurationSchema } from './window-target.js';

export function frameGeometry(frame, snapshot, processStartedAt, maxAgeMs = 2000) {
  const h = frame?.header, desktop = isDesktop(snapshot.target);
  const r = desktop ? snapshot.displayConfiguration?.boundsPoints : snapshot.windowRectPoints;
  // The legacy wire name holds ScreenCaptureKit's attachment rect in points.
  // Convert once to JPEG pixels; contentScale is already reflected in that rect.
  const c = h?.contentRectPixels?.map(n => n * h.scaleFactor);
  const identityMatches = desktop
    ? displayConfigurationSchema.safeParse(snapshot.displayConfiguration).success &&
      sameDisplayConfiguration(h?.displayConfiguration, snapshot.displayConfiguration)
    : Number.isFinite(processStartedAt) && snapshot.processStartedAt === processStartedAt &&
      h?.processStartedAt === processStartedAt && r?.every((n, i) => n === h?.initialWindowRectPoints?.[i]);
  if (!frame || performance.now() - frame.receivedMono > maxAgeMs ||
      !sameTarget(h, snapshot.target) || !identityMatches ||
      !Array.isArray(r) || r.length !== 4 || !r.every(Number.isFinite) ||
      r[2] <= 0 || r[3] <= 0 || r[2] > 16384 || r[3] > 16384 ||
      !Array.isArray(c) || c.length !== 4 || !c.every(Number.isFinite) ||
      c[0] < 0 || c[1] < 0 || c[2] <= 0 || c[3] <= 0 ||
      ![h.width, h.height].every(n => Number.isInteger(n) && n > 0 && n <= 2048) ||
      c[0] + c[2] > h.width + 1 || c[1] + c[3] > h.height + 1 ||
      Math.abs(c[2] / c[3] - r[2] / r[3]) > 2 / Math.min(c[2], c[3]) ||
      ![h.scaleFactor, h.contentScale].every(n => Number.isFinite(n) && n > 0 && n <= 16) ||
      !Number.isFinite(h.sentUptimeSeconds - h.captureTimeSeconds) ||
      h.sentUptimeSeconds - h.captureTimeSeconds < 0 || h.sentUptimeSeconds - h.captureTimeSeconds > 2)
    throw new Error('frame_geometry_stale');
  return { target: snapshot.target,
    ...(desktop ? { displayConfiguration: snapshot.displayConfiguration } : { windowRectPoints: r, processStartedAt }),
    imageGeometry: { width: h.width, height: h.height, contentRectPixels: c,
    scaleFactor: h.scaleFactor, contentScale: h.contentScale },
  coordinates: `Normalized [0,1), top-left of selected ${desktop ? 'display' : 'window'}. Raw JPEG pixel (px,py) maps to x=(px-contentRectPixels[0])/contentRectPixels[2], y=(py-contentRectPixels[1])/contentRectPixels[3]. Global points use the selected bounds origin, including negative origins. Export letterboxing is not input geometry.` };
}

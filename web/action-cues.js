import { sameTarget, sameSnapshotIdentity, isDesktop } from './target-identity.js';

export const CURSOR_VERSION = 2;
export const CUE_LIFETIME_MS = 900;
export const CUE_LEGEND = 'Synthetic input visualization · native ACK is not a check';
const rect = r => Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[2] > 0 && r[3] > 0;
const equalRect = (a, b) => rect(a) && rect(b) && a.every((n, i) => n === b[i]);

export function cueGeometry(header, snapshot) {
  const h = header, s = snapshot;
  if (!h || !s || !sameTarget(h, s.target) ||
      ![h.width, h.height].every(n => Number.isInteger(n) && n > 0 && n <= 2048) ||
      ![h.scaleFactor, h.contentScale].every(n => Number.isFinite(n) && n > 0 && n <= 16) ||
      !Number.isFinite(h.sentUptimeSeconds - h.captureTimeSeconds) ||
      h.sentUptimeSeconds - h.captureTimeSeconds < 0 || h.sentUptimeSeconds - h.captureTimeSeconds > 2) return null;
  const bounds = isDesktop(s.target) ? s.displayConfiguration?.boundsPoints : s.windowRectPoints;
  if (!sameSnapshotIdentity(s, { target: h, processStartedAt: h.processStartedAt, displayConfiguration: h.displayConfiguration }) ||
      !isDesktop(s.target) && (!Number.isFinite(s.processStartedAt) || !equalRect(bounds, h.initialWindowRectPoints)) ||
      !rect(bounds) || !rect(h.contentRectPixels)) return null;
  const content = h.contentRectPixels.map(n => n * h.scaleFactor);
  if (content[0] < 0 || content[1] < 0 || content[0] + content[2] > h.width + 1 ||
      content[1] + content[3] > h.height + 1 ||
      Math.abs(content[2] / content[3] - bounds[2] / bounds[3]) > 2 / Math.min(content[2], content[3])) return null;
  return { width: h.width, height: h.height, content, snapshot: {
    target: s.target, processStartedAt: s.processStartedAt, windowRectPoints: s.windowRectPoints,
    displayConfiguration: s.displayConfiguration } };
}

/** Journal-derived presentation metadata only. Never capture pixels or an input authority. */
export function actionCues(events) {
  if (!Array.isArray(events) || events.length > 12001 || events[0]?.kind !== 'run-start' ||
      !/^[a-f0-9]{32}$/.test(events[0].runId ?? '')) return [];
  const run = events[0], frames = new Map(), observations = new Map(), actions = new Map(), cues = [];
  let previous = null, lastMs = 0;
  for (const e of events) {
    if (!Number.isFinite(e.elapsedMs) || e.elapsedMs < lastMs || e.runId !== run.runId) return [];
    lastMs = e.elapsedMs;
    if (['gap', 'ownership', 'run-end'].includes(e.kind)) {
      for (const cue of cues) cue.endMs = Math.min(cue.endMs, e.elapsedMs);
      previous = null; actions.clear();
      frames.clear(); observations.clear();
    }
    if (e.kind === 'frame') frames.set(e.frameId, e);
    if (e.kind === 'observation') {
      if (observations.has(e.observationId)) observations.set(e.observationId, null);
      else observations.set(e.observationId, e);
    }
    if (e.kind === 'step-start' && ['mouse', 'press'].includes(e.inputOperation ?? e.operation) &&
        ['human', 'agent'].includes(e.actor) && e.actionId && !actions.has(e.actionId)) actions.set(e.actionId, { start: e });
    const action = actions.get(e.actionId);
    if (!action || e.stepId !== action.start.stepId || e.actor !== action.start.actor) continue;
    const start = action.start;
    let status;
    if (e.kind === 'action-attempt') {
      action.attempt = e;
      status = 'attempted';
    } else if (e.kind === 'action') status = e.status === 'pass' && e.reason === 'input_acknowledged_requires_assertion'
      && action.attempt?.observationId === e.observationId && e.beforeFrameId === start.beforeFrameId ? 'acknowledged' : 'uncertain';
    else if (e.kind === 'step-end' && ['blocked', 'uncertain', 'fail'].includes(e.status))
      status = e.status === 'blocked' ? 'blocked' : 'uncertain';
    if (!status) continue;
    const observed = observations.get(action.attempt?.observationId), frame = frames.get(start.beforeFrameId);
    const evidenceFrame = frames.get(observed?.afterFrameId);
    const geometry = observed?.actor === start.actor && sameTarget(run.target, observed.snapshot?.target) &&
      observed.frameEvidence?.status === 'available' && observed.frameEvidence.afterFrameId === observed.afterFrameId &&
      (run.labels?.processStartedAt === undefined || Number(run.labels.processStartedAt) === observed.snapshot?.processStartedAt) &&
      observed.elapsedMs < start.elapsedMs && start.elapsedMs - observed.elapsedMs <= 30000 &&
      frame && evidenceFrame && frame.elapsedMs <= start.elapsedMs &&
      evidenceFrame.elapsedMs <= observed.elapsedMs &&
      start.elapsedMs - (frame.receivedElapsedMs ?? frame.elapsedMs) <= 2000 &&
      cueGeometry(evidenceFrame.header, observed.snapshot) && cueGeometry(frame.header, observed.snapshot);
    const mouse = start.mouse;
    const point = geometry && mouse?.kind === 'click' && mouse.button === 'left' && mouse.count === 1 &&
      [mouse.x, mouse.y].every(n => Number.isFinite(n) && n >= 0 && n < 1)
      ? { x: (geometry.content[0] + mouse.x * geometry.content[2]) / geometry.width,
        y: (geometry.content[1] + mouse.y * geometry.content[3]) / geometry.height } : null;
    if (action.cue) action.cue.endMs = e.elapsedMs;
    const cue = { runId: run.runId, target: run.target, actionId: start.actionId, stepId: start.stepId,
      actor: start.actor, operation: start.inputOperation ?? start.operation, status,
      startMs: e.elapsedMs, endMs: e.elapsedMs + CUE_LIFETIME_MS, point,
      geometry: point ? geometry : null,
      from: point && previous?.point && previous.actor === start.actor && previous.actionId !== start.actionId &&
        e.elapsedMs - previous.startMs < 2000 && sameSnapshotIdentity(previous.geometry.snapshot, geometry.snapshot) &&
        equalRect(previous.geometry.content, geometry.content) ? previous.point : null };
    if (status === 'blocked' || status === 'uncertain') cue.point = null;
    cues.push(cue); action.cue = cue;
    if (cue.point) previous = cue;
    if (cues.length > 512) cues.shift();
  }
  return cues;
}

export function cueAt(cues, sourceMs, header) {
  const cue = cues.findLast(c => c.startMs <= sourceMs && sourceMs < c.endMs);
  if (!cue) return null;
  if (!cue.point) return cue;
  const geometry = cueGeometry(header, cue.geometry.snapshot);
  if (!geometry || geometry.width !== cue.geometry.width || geometry.height !== cue.geometry.height ||
      !equalRect(geometry.content, cue.geometry.content)) return null;
  const t = Math.min(1, Math.max(0, (sourceMs - cue.startMs) / 160));
  return { ...cue, point: cue.from ? { x: cue.from.x + (cue.point.x - cue.from.x) * t,
    y: cue.from.y + (cue.point.y - cue.from.y) * t } : cue.point };
}

export function fitPoint(point, imageWidth, imageHeight, width, height) {
  const scale = Math.min(width / imageWidth, height / imageHeight);
  return { x: (width - imageWidth * scale) / 2 + point.x * imageWidth * scale,
    y: (height - imageHeight * scale) / 2 + point.y * imageHeight * scale };
}
export const cueLabel = cue => `${cue.actor} · ${cue.operation} · ${cue.status === 'acknowledged' ? 'native ACK, not assertion' : cue.status}`;

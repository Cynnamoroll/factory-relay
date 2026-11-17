import { sameTarget as targetEquals, isDesktop, sameSnapshotIdentity } from './target-identity.js';

export const QA_EDIT_VERSION = 3;
export const QA_EDIT_POLICY = Object.freeze({ maxEvents: 12001, maxClips: 256, maxSegments: 12001,
  maxDurationMs: 690000, maxEditedDurationMs: 690000 });
const kinds = new Set(['run-start', 'run-end', 'frame', 'gap', 'ownership', 'step-start', 'step-end',
  'action-attempt', 'action', 'observation', 'assertion', 'recording-limit']);
const id = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const text = (value, limit) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, limit);

function precedingInput(events, checkStart, assertion, starts, frames) {
  const index = events.indexOf(checkStart), previous = events.slice(0, index).findLast(e => e.kind !== 'frame');
  if (previous?.kind !== 'step-end' || previous.status !== 'pass') return null;
  const start = starts.get(previous.stepId);
  if (!start || !['press', 'mouse'].includes(start.operation) || !id(start.actionId) || !['agent', 'human'].includes(start.actor) ||
      [previous, checkStart, assertion].some(e => e.actor !== start.actor)) return null;
  const rows = events.slice(events.indexOf(start), index).filter(e => e.kind !== 'frame');
  if (events.some(e => e.actionId === start.actionId && e.stepId !== start.stepId)) return null;
  if (rows.some(e => e.stepId !== start.stepId || e.actor !== start.actor || e.actionId !== start.actionId)) return null;
  if (rows.map(e => e.kind).join(',') !== 'step-start,action-attempt,action,observation,step-end') return null;
  const [, attempt, ack, observed] = rows, evidence = observed.frameEvidence;
  const beforeObservations = events.filter(e => e.kind === 'observation' && e.observationId === attempt.observationId && e.elapsedMs < start.elapsedMs);
  const checkObservations = events.filter(e => e.kind === 'observation' && e.stepId === checkStart.stepId && e.observationId === assertion.observationId);
  if (beforeObservations.length !== 1 || checkObservations.length !== 1) return null;
  const [beforeObservation] = beforeObservations, [checkObservation] = checkObservations;
  if (attempt.status !== 'running' || ack.status !== 'pass' || ack.reason !== 'input_acknowledged_requires_assertion' ||
      ack.observationId !== attempt.observationId || checkObservation.elapsedMs < checkStart.elapsedMs ||
      checkObservation.elapsedMs > assertion.elapsedMs || checkObservation.actual !== assertion.actual ||
      (assertion.observationSeq !== undefined && checkObservation.seq !== assertion.observationSeq) ||
      beforeObservation.actor !== start.actor || checkObservation?.actor !== start.actor ||
      !targetEquals(beforeObservation.snapshot?.target, observed.snapshot?.target) ||
      !targetEquals(events[0].target, observed.snapshot?.target) ||
      !targetEquals(observed.snapshot?.target, checkObservation.snapshot?.target) ||
      !sameSnapshotIdentity(beforeObservation.snapshot, observed.snapshot) ||
      !sameSnapshotIdentity(observed.snapshot, checkObservation.snapshot) ||
      evidence?.status !== 'available' || evidence.beforeFrameId !== start.beforeFrameId ||
      ack.beforeFrameId !== start.beforeFrameId || observed.beforeFrameId !== start.beforeFrameId ||
      observed.afterFrameId !== evidence.afterFrameId) return null;
  const before = frames.get(evidence.beforeFrameId), after = frames.get(evidence.afterFrameId);
  if (!before || !after || before.elapsedMs > start.elapsedMs ||
      (after.receivedElapsedMs ?? after.elapsedMs) < ack.elapsedMs || after.elapsedMs > observed.elapsedMs ||
      previous.elapsedMs <= start.elapsedMs) return null;
  return { operationStepId: start.stepId, sourceStartMs: start.elapsedMs, sourceEndMs: previous.elapsedMs,
    beforeFrameId: evidence.beforeFrameId, afterFrameId: evidence.afterFrameId };
}

/** Only associated input and assertion intervals contribute playback time. */
export function qaEditPlan(events, sourceDurationMs, policy = QA_EDIT_POLICY) {
  const unavailable = reason => ({ version: QA_EDIT_VERSION, available: false, reason, sourceDurationMs, durationMs: 0, clips: [], segments: [] });
  if (!Array.isArray(events) || events.length < 2 || events.length > policy.maxEvents ||
      !Number.isFinite(sourceDurationMs) || sourceDurationMs <= 0 || sourceDurationMs > policy.maxDurationMs ||
      events[0]?.kind !== 'run-start' || events.at(-1)?.kind !== 'run-end' ||
      events.at(-1).elapsedMs !== sourceDurationMs) return unavailable('A complete bounded journal is required for QA video.');
  const starts = new Map(), outcomes = new Set(), frames = new Map(), clips = [], segments = [];
  let last = -1, durationMs = 0, frameCount = 0, evidenceMs = 0;
  for (const [index, e] of events.entries()) {
    if (!e || !kinds.has(e.kind) || !Number.isFinite(e.elapsedMs) || e.elapsedMs < 0 || e.elapsedMs < last || e.elapsedMs > sourceDurationMs ||
        (e.kind === 'run-start' && index !== 0) || (e.kind === 'run-end' && index !== events.length - 1))
      return unavailable('Inconsistent journal timing; QA video unavailable.');
    last = e.elapsedMs;
    if (e.kind === 'frame') {
      if (++frameCount > 3600 || !Number.isFinite(e.receivedElapsedMs ?? e.elapsedMs) ||
          (e.receivedElapsedMs ?? e.elapsedMs) < 0 || (e.receivedElapsedMs ?? e.elapsedMs) > e.elapsedMs ||
          (e.frameId && frames.has(e.frameId))) return unavailable('Invalid recorded frame timing; QA video unavailable.');
      if (e.frameId) frames.set(e.frameId, e);
    }
    if (e.kind === 'step-start') {
      if (!id(e.stepId) || starts.has(e.stepId)) return unavailable('Ambiguous check identity; QA video unavailable.');
      starts.set(e.stepId, e);
    }
    if (e.kind !== 'assertion') continue;
    const start = starts.get(e.stepId);
    if (!start || !['assert-count', 'assert-visual'].includes(start.operation) || outcomes.has(e.stepId) ||
        !['pass', 'fail', 'blocked', 'uncertain'].includes(e.status))
      return unavailable('Unmatched or ambiguous assertion; QA video unavailable.');
    outcomes.add(e.stepId);
    if (!['pass', 'fail'].includes(e.status)) continue;
    const visual = start.operation === 'assert-visual';
    if (visual ? e.checkKind !== 'visual' || e.assessment?.source !== 'caller' || e.assessment?.serverVerified !== false ||
        e.assessment.actor !== e.actor || !['human', 'agent'].includes(e.actor) ||
        [e.expected, e.actual].some(value => typeof value !== 'string' || !value.trim() || value.length > 600) ||
        !frames.has(e.afterFrameId)
      : [e.expected, e.actual].some(value => value !== undefined && value !== null && (!Number.isSafeInteger(value) || value < 0)))
      return unavailable('Invalid assertion values; QA video unavailable.');
    if (e.elapsedMs <= start.elapsedMs || (clips.length && start.elapsedMs < clips.at(-1).sourceEndMs) ||
        clips.length >= policy.maxClips) return unavailable('Overlapping, empty or excessive QA intervals.');
    if (events.some(row => row.elapsedMs >= start.elapsedMs && row.elapsedMs < e.elapsedMs &&
        (row.kind === 'ownership' || ['step-start', 'action-attempt', 'action', 'observation'].includes(row.kind) && row.stepId !== e.stepId)))
      return unavailable('Unrelated operations overlap a QA interval; QA video unavailable.');
    let input = precedingInput(events, start, e, starts, frames);
    let assessed;
    if (visual) {
      const checkObservation = events.find(row => row.kind === 'observation' && row.seq === e.observationSeq && row.stepId === e.stepId);
      const original = events.filter(row => row.kind === 'observation' && row.observationId === e.observationId && row.stepId !== e.stepId);
      const frame = frames.get(e.afterFrameId);
      if (original.length !== 1 || !checkObservation || checkObservation.afterFrameId !== e.afterFrameId ||
          original[0].afterFrameId !== e.afterFrameId || original[0].actor !== e.actor ||
          !targetEquals(original[0].snapshot?.target, checkObservation.snapshot?.target) ||
          !targetEquals(events[0].target, checkObservation.snapshot?.target) ||
          !sameSnapshotIdentity(original[0].snapshot, checkObservation.snapshot) ||
          !isDesktop(checkObservation.snapshot?.target) && !Number.isFinite(checkObservation.snapshot?.processStartedAt) ||
          original[0].elapsedMs >= start.elapsedMs || original[0].elapsedMs <= frame.elapsedMs ||
          e.elapsedMs - original[0].elapsedMs > 30000 ||
          events.some(row => row.elapsedMs > original[0].elapsedMs && row.elapsedMs < start.elapsedMs &&
            (['gap', 'ownership', 'action-attempt', 'action', 'assertion', 'step-start'].includes(row.kind))))
        return unavailable('Visual assessment lacks fresh, unconsumed selected-target evidence.');
      assessed = { role: 'assessed-frame', operationStepId: original[0].stepId,
        sourceStartMs: frame.elapsedMs, sourceEndMs: original[0].elapsedMs, beforeFrameId: frame.frameId };
      if (input) {
        input.sourceEndMs = Math.min(input.sourceEndMs, assessed.sourceStartMs);
        if (input.sourceEndMs <= input.sourceStartMs) input = null;
      }
      if (clips.length && assessed.sourceStartMs < clips.at(-1).sourceEndMs)
        return unavailable('Visual evidence cannot reuse prior check context.');
    }
    const clip = { stepId: e.stepId, status: e.status, title: text(e.title ?? start.title ?? 'Count check', 160),
      context: text(e.context ?? start.context, 600), expected: e.expected ?? null, actual: e.actual ?? null,
      ...(visual ? { kind: 'visual', assessment: e.assessment, frameId: e.afterFrameId } : {}),
      sourceStartMs: start.elapsedMs, sourceEndMs: e.elapsedMs, startMs: durationMs,
      evidenceNote: input ? 'Preceding recorded input; context, not proof of causation.' : 'Assertion observation only; no associated input.' };
    const add = (kind, ms, fields) => {
      segments.push({ kind, stepId: e.stepId, startMs: durationMs, endMs: durationMs + ms, ...fields });
      durationMs += ms;
    };
    for (const interval of [...(input ? [{ ...input, role: 'preceding-input' }] : []),
      ...(assessed ? [assessed] : []),
      { role: 'assertion', operationStepId: e.stepId, sourceStartMs: start.elapsedMs, sourceEndMs: e.elapsedMs,
        beforeFrameId: start.beforeFrameId ?? null }]) {
      const ms = interval.sourceEndMs - interval.sourceStartMs;
      add('evidence', ms, { ...interval, mapping: 'source' }); evidenceMs += ms;
    }
    clip.endMs = durationMs; clips.push(clip);
    if (durationMs > policy.maxEditedDurationMs || segments.length > policy.maxSegments)
      return unavailable('QA footage exceeds edit bounds.');
  }
  return { version: QA_EDIT_VERSION, available: true, sourceDurationMs, durationMs, evidenceMs,
    presentationMs: durationMs - evidenceMs, omittedMs: sourceDurationMs - evidenceMs, clips, segments };
}
export function qaClipAt(plan, editedMs) {
  if (!plan?.available || !Number.isFinite(editedMs)) return null;
  return plan.clips.find(c => c.startMs <= editedMs && editedMs < c.endMs) ?? null;
}
export function qaSegmentAt(plan, editedMs) {
  if (!plan?.available || !Number.isFinite(editedMs)) return null;
  return plan.segments?.find(s => s.startMs <= editedMs && editedMs < s.endMs) ?? null;
}
export function sourceToQA(plan, sourceMs, stepId) {
  if (!plan?.available || !Number.isFinite(sourceMs)) return null;
  const s = plan.segments?.find(s => s.kind === 'evidence' && (!stepId || s.stepId === stepId) &&
    s.sourceStartMs <= sourceMs && sourceMs < s.sourceEndMs);
  return s ? s.startMs + sourceMs - s.sourceStartMs : null;
}
export function qaToSource(plan, editedMs) {
  const s = qaSegmentAt(plan, editedMs);
  return s?.kind === 'evidence' ? s.sourceStartMs + editedMs - s.startMs : null;
}

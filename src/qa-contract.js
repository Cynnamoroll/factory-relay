import { z } from 'zod';
import { controlTargetSchema, countWaitSchema } from './control.js';
import { applicationIdSchema } from './qa-applications.js';
import { mouseSchema, isBackgroundClick } from './mouse.js';
import { recordingName } from '../web/recording-name.js';

export const qaId = z.string().regex(/^[a-f0-9]{32}$/);
const run = { runId: qaId };
const page = { offset: z.number().int().min(0).max(12000).default(0),
  limit: z.number().int().min(1).max(100).default(30) };
export const tasks = {
  qa_status: z.strictObject({}),
  qa_targets: z.strictObject({}),
  qa_start: z.strictObject({ title: z.string().trim().min(1).max(160).optional(),
    applicationId: applicationIdSchema.optional(),
    context: z.string().max(600).optional(), target: controlTargetSchema.optional(), resumeRunId: qaId.optional() }),
  qa_observe: z.strictObject({ ...run, includeImage: z.boolean().default(false), mode: z.enum(['pixels', 'count']).optional() }),
  qa_act: z.strictObject({ ...run, action: z.enum(['increment', 'mouse']), observationId: qaId,
    mouse: mouseSchema.optional(), completion: z.literal('ack').optional(), waitFor: countWaitSchema.optional(),
  }).refine(v => (v.action === 'mouse') === (v.mouse !== undefined) &&
    (!v.waitFor || (!v.completion && (v.action === 'increment' || isBackgroundClick(v.mouse))))),
  qa_check: z.strictObject({ ...run, kind: z.literal('visual').optional(), title: z.string().trim().min(1).max(160),
    expected: z.union([z.number().int().min(0).max(1e9), z.string().trim().min(1).max(600)]),
    actual: z.string().trim().min(1).max(600).optional(), outcome: z.enum(['pass', 'fail']).optional(),
    observationId: qaId.optional(), context: z.string().max(600).optional(),
  }).refine(v => v.kind === 'visual' ? typeof v.expected === 'string' && v.actual !== undefined &&
    v.outcome !== undefined && v.observationId !== undefined
    : typeof v.expected === 'number' && v.actual === undefined && v.outcome === undefined && v.observationId === undefined),
  qa_finish: z.strictObject({ ...run }),
  qa_runs: z.strictObject(page),
  qa_replay: z.strictObject({ ...run, ...page,
    filter: z.enum(['checks', 'failures', 'events', 'frames', 'results']).default('checks'), stepId: qaId.optional(), frameId: qaId.optional() }),
  qa_report: z.strictObject({ ...run, export: z.boolean().default(true), retryExport: z.boolean().default(false),
    waitMs: z.number().int().min(0).max(30000).default(0) }),
  qa_control: z.strictObject({ mode: z.enum(['take', 'release']) }),
};
export const descriptions = {
  qa_status: 'Read desktopAllowed, capabilities, configured applications, shared target, controller and freshness. Capabilities do not assert runtime readiness. Never acquires control, discovers targets, captures or sends input.',
  qa_targets: 'Discover authorized displays with main marker, point/pixel configuration and exact {kind:"desktop",displayId,displayUUID} targets (canonical lowercase UUID), plus restricted {windowId,pid,bundleId} windows and kernel process start. Uses the shared lease or releases its temporary proof in finally. Never takes human control. Bare windows have bundleId "".',
  qa_start: 'Start or resume a window run. Select an application or exact discovered window. Title describes the QA test and is prefixed with the discovered application name. If omitted, meaningful context or the first named check supplies the purpose. Only when whole-display QA is explicitly authorized, pass a discovered display or applicationId:"desktop" for the main display. Explicit application lists never authorize desktop. Never takes over a human.',
  qa_observe: 'Return fresh single-use pixels and honest displayConfiguration or windowRectPoints/processStartedAt plus imageGeometry. includeImage returns the shared raw JPEG. Use mode:"pixels" for any target. RelayMac defaults retain count compatibility. Generic actual is null. Slow transport/idle capture refreshes capture without weakening freshness. Non-owners get cached read-only evidence.',
  qa_act: 'Send bounded mouse move/click/drag/scroll with a single-use observation, or explicit RelayMac increment. Coordinates are normalized [0,1), top-left raw contentRectPixels, not letterboxed exports. Desktop input permits menus, sheets, app switching and Dock/menu bar only on the selected display, including negative origins. Display identity/configuration changes fail closed. Window targets run silently in the background: only a left single click on a pressable accessibility element under the point is sent (AXPress); focus and cursor are untouched, and any other gesture returns background_unavailable without input. Desktop input uses the real cursor and requires exclusive control. No keyboard. Never retry uncertain input. Ack is not an assertion.',
  qa_check: 'Record a count assertion, or kind:"visual" with expected/actual text, outcome pass/fail and a fresh observationId. Visual outcome is explicitly caller/agent assessed, not server-verified. Evidence links refer to the assessed shared frame.',
  qa_finish: 'Finish run, release native control, start bounded asynchronous MP4 export and return check summary plus replay/report links. Safe to repeat for an ended run.',
  qa_runs: 'List recorded runs, bounded and newest first. No native operations.',
  qa_replay: 'Read paginated checks/events/frames or one recorded JPEG. Checks include a versioned footage-only map of associated input and assertion evidence for completed passing/failing checks. Use filter results for QA outcomes and operational errors without frame metadata, even before export. Optional stepId seeks to that check. Never sends native input.',
  qa_report: 'Produce chat-ready Markdown, named checks, failure links and local MP4/summary paths. Optionally wait up to 30s or retry a failed read-only export. No chat attachment API is implied.',
};
descriptions.qa_act += ' Use completion:"ack" to return without waiting for pixels or a new observation. For a RelayMac increment or click, alternatively pass waitFor:{kind:"count",equals:N,timeoutMs:1..2000} to act once and check the AX count on the Mac in one round trip. Neither mode returns a reusable observation; observe before further input.';
export function failure(error, operation = '', actor = 'agent') {
  const code = /^[a-z_]{1,64}$/.test(error.message) ? error.message : 'qa_operation_failed';
  const ownership = /control|takeover|lease/.test(code);
  const uncertain = operation === 'qa_act' && !['stale_control', 'observation_stale', 'invalid_arguments', 'run_mismatch', 'recording_full', 'recording_error', 'application_not_authorized', 'background_unavailable', 'lease_scope'].includes(code);
  const category = uncertain ? 'uncertain' : ownership ? 'ownership'
    : ['background_unavailable', 'screen_recording_required'].includes(code) ? 'unavailable' : /recording|export/.test(code) ? 'storage'
    : /target|frame|stream|transport|accessibility|application_not_supported|application_unavailable|application_not_authorized/.test(code) ? 'unavailable' : 'validation';
  return { code, category, retrySafe: !uncertain && operation !== 'qa_act',
    nextAction: uncertain ? 'Do not repeat input. Observe native state, inspect the run, then decide.'
      : ownership ? actor === 'human' ? 'Take control explicitly in Live before editing this run.'
        : 'View the shared run. Ask the human to release control; do not take over.'
        : code === 'background_unavailable' ? 'Nothing was sent. Background windows accept only a left single click on a pressable control. Use that, or select the desktop target and take exclusive control for other input.'
        : code === 'screen_recording_required' ? 'Open Factory Relay setup on the Mac and enable Screen Recording, then retry.'
        : code === 'application_not_supported' ? 'This operation is not implemented for the selected application or platform. Read qa_status capabilities. Generic Mac windows support pixels, mouse and visual checks; iOS input is unsupported.'
          : ['unknown_application', 'application_ambiguous', 'application_mismatch'].includes(code)
            ? 'Read qa_status.applications, then pass the intended applicationId to qa_start. Resume only the same application.'
          : ['application_unavailable', 'application_not_authorized'].includes(code)
            ? 'No authorized shared QA application matches. Review the private applications configuration and restart the broker before starting a supported app.'
          : ['target_ambiguous', 'target_discovery_required'].includes(code) ? 'Call qa_targets, then pass an explicit target to qa_start within 30 seconds.'
          : /export/.test(code) ? 'Inspect storage/ffmpeg availability, then retry read-only qa_report export.'
            : 'Inspect qa_status and the recorded check. Correct the cause before retrying.' };
}
export function summarize(store, id) {
  const r = store.get(id), end = r.events.at(-1);
  const checks = r.events.filter(e => e.kind === 'assertion').map(e => ({
    stepId: e.stepId, title: e.title ?? 'Count assertion', context: e.context ?? '',
    status: e.status, expected: e.expected, actual: e.actual ?? null, elapsedMs: e.elapsedMs,
    startedMs: r.events.find(s => s.kind === 'step-start' && s.stepId === e.stepId)?.elapsedMs ?? e.elapsedMs,
    observationId: e.observationId, reason: e.reason,
    ...(e.checkKind ? { kind: e.checkKind, assessment: e.assessment, frameId: e.afterFrameId } : {}),
  }));
  const counts = { pass: 0, fail: 0, blocked: 0, uncertain: 0 };
  for (const c of checks) counts[c.status in counts ? c.status : 'uncertain']++;
  return { runId: id, ...recordingName(r.events), context: r.events[0]?.labels?.context ?? '',
    applicationId: r.events[0]?.labels?.applicationId ?? null,
    recordingContextFrames: r.events.filter(e => e.kind === 'recording-frame').length,
    recordingScope: r.events.findLast(e => e.kind === 'recording-scope') ?? null,
    target: r.events[0]?.target, started: r.started, status: end?.kind === 'run-end' ? end.status : store.fault ? 'blocked' : 'running',
    durationMs: end?.elapsedMs ?? 0, counts, checks, frames: r.frames, reason: end?.reason };
}

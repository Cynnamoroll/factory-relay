import { z } from 'zod';
import { controlTargetSchema } from './control.js';

export const qaId = z.string().regex(/^[a-f0-9]{32}$/);
const run = { runId: qaId };
const page = { offset: z.number().int().min(0).max(12000).default(0),
  limit: z.number().int().min(1).max(100).default(30) };
export const tasks = {
  qa_status: z.strictObject({}),
  qa_start: z.strictObject({ title: z.string().trim().min(1).max(160).default('QA run'),
    context: z.string().max(600).optional(), target: controlTargetSchema.optional(), resumeRunId: qaId.optional() }),
  qa_observe: z.strictObject({ ...run, includeImage: z.boolean().default(false) }),
  qa_act: z.strictObject({ ...run, action: z.literal('increment'), observationId: qaId }),
  qa_check: z.strictObject({ ...run, title: z.string().trim().min(1).max(160),
    expected: z.number().int().min(0).max(1e9), context: z.string().max(600).optional() }),
  qa_finish: z.strictObject({ ...run }),
  qa_runs: z.strictObject(page),
  qa_replay: z.strictObject({ ...run, ...page,
    filter: z.enum(['checks', 'failures', 'events', 'frames', 'results']).default('checks'), stepId: qaId.optional(), frameId: qaId.optional() }),
  qa_report: z.strictObject({ ...run, export: z.boolean().default(true), retryExport: z.boolean().default(false),
    waitMs: z.number().int().min(0).max(30000).default(0) }),
  qa_control: z.strictObject({ mode: z.enum(['take', 'release']) }),
};
export const descriptions = {
  qa_status: 'Read shared target, controller, recording and freshness. Never acquires control.',
  qa_start: 'Start or resume one QA run. Discovers the own RelayMac sample, acquires unowned control, and waits up to 15s for real pixels. Choose target only when ambiguous. Never takes over a human.',
  qa_observe: 'Observe native count with a fresh single-use observation, optionally return the shared broker image. Non-owners receive cached read-only evidence, not input authority.',
  qa_act: 'Increment the own RelayMac sample using a fresh observation. Never automatically retry input. AX result and post-action frame availability are separate.',
  qa_check: 'Record a named count assertion, expected vs fresh observed actual, with optional context. A mismatch is a recorded failure, not a transport error.',
  qa_finish: 'Finish run, release native control, start bounded asynchronous MP4 export and return check summary plus replay/report links. Safe to repeat for an ended run.',
  qa_runs: 'List recorded runs, bounded and newest first. No native operations.',
  qa_replay: 'Read paginated checks/events/frames or one recorded JPEG. Checks include a versioned footage-only map of associated input and assertion evidence for completed passing/failing checks. Use filter results for QA outcomes and operational errors without frame metadata, even before export. Optional stepId seeks to that check. Never sends native input.',
  qa_report: 'Produce chat-ready Markdown, named checks, failure links and local MP4/summary paths. Optionally wait up to 30s or retry a failed read-only export. No chat attachment API is implied.',
};
export function failure(error, operation = '', actor = 'agent') {
  const code = /^[a-z_]{1,64}$/.test(error.message) ? error.message : 'qa_operation_failed';
  const ownership = /control|takeover|lease/.test(code);
  const uncertain = operation === 'qa_act' && !['stale_control', 'observation_stale', 'invalid_arguments', 'run_mismatch', 'recording_full'].includes(code);
  const category = uncertain ? 'uncertain' : ownership ? 'ownership' : /recording|export/.test(code) ? 'storage'
    : /target|frame|stream|transport|accessibility/.test(code) ? 'unavailable' : 'validation';
  return { code, category, retrySafe: !uncertain && operation !== 'qa_act',
    nextAction: uncertain ? 'Do not repeat input. Observe native state, inspect the run, then decide.'
      : ownership ? actor === 'human' ? 'Take control explicitly in Live before editing this run.'
        : 'View the shared run. Ask the human to release control; do not take over.'
        : code === 'target_ambiguous' ? 'Read qa_status windows, then pass an explicit target to qa_start.'
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
  }));
  const counts = { pass: 0, fail: 0, blocked: 0, uncertain: 0 };
  for (const c of checks) counts[c.status in counts ? c.status : 'uncertain']++;
  return { runId: id, title: r.events[0]?.labels?.title ?? 'QA run', context: r.events[0]?.labels?.context ?? '',
    target: r.events[0]?.target, started: r.started, status: end?.kind === 'run-end' ? end.status : store.fault ? 'blocked' : 'running',
    durationMs: end?.elapsedMs ?? 0, counts, checks, frames: r.frames, reason: end?.reason };
}

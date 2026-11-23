import { z } from 'zod';
import { configSchema } from './schema.js';
import { sessionFor } from './mac-session.js';
import { windowTargetSchema, desktopTargetSchema, displayConfigurationSchema, macBundleIdSchema, sampleBundle } from './window-target.js';
import { mouseSchema, isBackgroundClick } from './mouse.js';

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const controlWindowSchema = windowTargetSchema.extend({ bundleId: macBundleIdSchema });
export const controlTargetSchema = z.union([controlWindowSchema, desktopTargetSchema]);
const proof = z.strictObject({ token: z.string().regex(/^[a-f0-9]{64}$/), generation: integer });
export const countWaitSchema = z.strictObject({ kind: z.literal('count'), equals: z.number().int().min(0).max(1e9),
  timeoutMs: z.number().int().min(1).max(2000) });
export const controlRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('diagnose'), lease: proof }),
  z.strictObject({ operation: z.literal('windows'), lease: proof }),
  z.strictObject({ operation: z.literal('shutdown'), lease: proof }),
  z.strictObject({ operation: z.literal('observe'), lease: proof, target: controlTargetSchema,
    mode: z.enum(['pixels', 'count']).optional() }),
  z.strictObject({ operation: z.literal('press'), lease: proof,
    target: controlWindowSchema.extend({ bundleId: z.literal(sampleBundle) }),
    observationId: z.string().regex(/^[a-f0-9]{32}$/), elementId: z.literal('relay-increment'), waitFor: countWaitSchema.optional() }),
  z.strictObject({ operation: z.literal('mouse'), lease: proof, target: controlTargetSchema,
    observationId: z.string().regex(/^[a-f0-9]{32}$/), mouse: mouseSchema, waitFor: countWaitSchema.optional(),
  }).refine(v => !v.waitFor || (v.target.bundleId === sampleBundle && isBackgroundClick(v.mouse))),
]);
const element = (id, role) => z.strictObject({
  id: z.literal(id), role: z.literal(role), value: z.string().max(512), enabled: z.boolean(),
});
const rect = z.tuple([z.number().finite(), z.number().finite(), z.number().nonnegative().finite(), z.number().nonnegative().finite()]);
const snapshot = z.union([z.strictObject({
  target: controlWindowSchema,
  windowRectPoints: z.tuple([z.number().finite(), z.number().finite(),
    z.number().positive().max(16384).finite(), z.number().positive().max(16384).finite()]),
  processStartedAt: z.number().finite(),
  elements: z.union([z.tuple([]), z.tuple([element('relay-count', 'AXStaticText'), element('relay-increment', 'AXButton')])]),
}).refine(s => s.elements.length === 0 || s.target.bundleId === sampleBundle),
z.strictObject({ target: desktopTargetSchema, displayConfiguration: displayConfigurationSchema, elements: z.tuple([]) })]);
const lifecycle = z.strictObject({ appKitInitialized: z.literal(true), eventLoopRunning: z.literal(true),
  launchFinished: z.literal(true), mainThread: z.literal(true) });
const effect = z.strictObject({ status: z.enum(['matched', 'timed_out', 'unavailable']), actual: integer.nullable(),
  reason: z.string().regex(/^[a-z_]{1,64}$/).optional(), dispatchMs: z.number().finite().nonnegative(),
  elapsedMs: z.number().finite().nonnegative() }).optional();
const results = {
  diagnose: z.strictObject({
    type: z.literal('diagnostic'), bundleId: z.literal('com.factory.applets.host'),
    bundlePath: z.string().max(4096), executablePath: z.string().max(4096),
    accessibility: z.boolean(), screenRecording: z.boolean(), permissionRequested: z.literal(false),
    launchMode: z.literal('persistent-ipc'), processId: integer.min(1), parentProcessId: integer.min(1),
    lifecycle,
  }),
  windows: z.strictObject({ type: z.literal('windows'),
    displays: z.array(desktopTargetSchema.extend({ main: z.boolean(), displayConfiguration: displayConfigurationSchema })).max(32),
    windows: z.array(windowTargetSchema.extend({ title: z.string().max(1024), windowRectPoints: rect,
      displayName: z.string().max(120).optional(), processStartedAt: z.number().finite().optional() })).max(100) }),
  shutdown: z.strictObject({ type: z.literal('shutdown') }),
  observe: z.strictObject({ type: z.literal('observation'), snapshot,
    observationId: z.string().regex(/^[a-f0-9]{32}$/), expiresAt: z.number().finite() }),
  press: z.strictObject({ type: z.literal('pressed'), elementId: z.literal('relay-increment'),
    effect }),
  mouse: z.strictObject({ type: z.literal('mouse-acknowledged'),
    route: z.enum(['background-ax-press', 'foreground-hid']),
    focusPreserved: z.boolean(), cursorPreserved: z.boolean(), effect }),
};
export const controlErrors = new Set(['busy', 'stale_lease', 'lease_expired', 'lease_scope', 'unsafe_state', 'unsafe_peer',
  'unsupported_host', 'ipc_path_limit', 'invalid_request', 'invalid_stream', 'stream_timeout',
  'stream_closed', 'stream_interrupted', 'host_unavailable', 'accessibility_required',
  'observation_stale', 'target_mismatch', 'element_unavailable', 'action_uncertain',
  'control_timeout', 'control_closed', 'control_cancelled', 'invalid_control_response',
  'background_unavailable', 'screen_recording_required', 'transport_unavailable']);
export const controlDeadlines = { diagnose: 5000, windows: 10000, observe: 3000, press: 3000, mouse: 4000, shutdown: 3000 };
const mutations = new Set(['press', 'mouse']);

/** Bounded native operation over the persistent session for this config. */
export async function control(config, input, { session, signal } = {}) {
  config = configSchema.parse(config);
  const { operation, target = null, ...args } = controlRequestSchema.parse(input);
  session ??= sessionFor(config);
  const mutation = mutations.has(operation);
  let result;
  try {
    result = await session.request({ owner: config.owner, workspace: config.workspace, operation, target, args },
      { deadlineMs: controlDeadlines[operation] + (args.waitFor?.timeoutMs ?? 0), mutation, signal });
  } catch (error) {
    if (controlErrors.has(error.message)) throw new Error(error.message);
    throw new Error(mutation ? 'action_uncertain' : 'invalid_control_response');
  }
  const parsed = results[operation].safeParse(result);
  if (!parsed.success) throw new Error(mutation ? 'action_uncertain' : 'invalid_control_response');
  if (mutation) {
    const e = parsed.data.effect;
    if (!!e !== !!args.waitFor || (e && (e.elapsedMs < e.dispatchMs ||
        (e.status === 'matched') !== (e.actual === args.waitFor.equals) ||
        (e.status === 'unavailable' && e.actual !== null)))) throw new Error('action_uncertain');
  }
  if (operation === 'observe' && JSON.stringify(parsed.data.snapshot.target) !== JSON.stringify(controlTargetSchema.parse(target)))
    throw new Error('invalid_control_response');
  return parsed.data;
}

import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { control, controlTargetSchema, countWaitSchema } from './control.js';
import { consumeHost } from './stream.js';
import { run } from './transport.js';
import { opaque } from './qa-store.js';
import { Exporter } from './qa-export.js';
import { tasks } from './qa-contract.js';
import { executeTask, readTask } from './qa-tasks.js';
import { applicationProfiles, capabilities, nativeAuthorized, requireNativeAuthorization, selectApplication } from './qa-applications.js';
import { mouseSchema, isBackgroundClick } from './mouse.js';
import { sampleBundle, isDesktop, sameTarget, targetIdentity } from './window-target.js';
import { frameGeometry } from './qa-geometry.js';
import { launchManagedFixture } from './qa-managed-fixture.js';
import { RecordingContext } from './qa-recording-context.js';
import { actionCues, cueAt } from '../web/action-cues.js';
import { recordingLabels, recordingName } from '../web/recording-name.js';

const id = z.string().regex(/^[a-f0-9]{32}$/);
const grant = { grant: id };
export const qaCommand = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('connect') }),
  z.strictObject({ op: z.literal('select'), target: controlTargetSchema }),
  z.strictObject({ op: z.literal('take'), takeover: z.boolean().default(false) }),
  z.strictObject({ op: z.literal('release'), ...grant }),
  z.strictObject({ op: z.literal('start'), ...grant,
    labels: z.record(z.string().max(40), z.string().max(600))
      .refine(v => Object.keys(v).length <= 8 && Object.entries(v).every(([key, value]) => key === 'context' || value.length <= 200)).default({}) }),
  z.strictObject({ op: z.literal('stop'), ...grant }),
  z.strictObject({ op: z.literal('observe'), ...grant, mode: z.enum(['pixels', 'count']).optional() }),
  z.strictObject({ op: z.literal('press'), ...grant, observationId: id,
    completion: z.literal('ack').optional(), waitFor: countWaitSchema.optional() }).refine(v => !(v.waitFor && v.completion)),
  z.strictObject({ op: z.literal('mouse'), ...grant, observationId: id, mouse: mouseSchema,
    completion: z.literal('ack').optional(), waitFor: countWaitSchema.optional() }).refine(v => !v.waitFor || (!v.completion && isBackgroundClick(v.mouse))),
  z.strictObject({ op: z.literal('assert-visual'), ...grant, observationId: id,
    expected: z.string().trim().min(1).max(600), actual: z.string().trim().min(1).max(600),
    outcome: z.enum(['pass', 'fail']), title: z.string().trim().min(1).max(160), context: z.string().max(600).optional() }),
  z.strictObject({ op: z.literal('assert-count'), ...grant, expected: z.number().int().min(0).max(1e9),
    title: z.string().min(1).max(160).optional(), context: z.string().max(600).optional() }),
]);

export function nativeAdapter(config) {
  const applications = applicationProfiles(config.applications);
  const owner = { ...config, owner: 'qa:' + opaque() };
  return {
    applications,
    launchFixture: ({ lifetimeMs }) => {
      requireNativeAuthorization(applications, { bundleId: sampleBundle });
      return launchManagedFixture(owner, { lifetimeMs });
    },
    acquire: (takeover, ttlSeconds = 3600, scope = undefined) =>
      run(owner, 'acquire', { ttlSeconds, takeover, ...(scope ? { scope } : {}) }),
    release: lease => run(owner, 'release', { lease }),
    windows: async lease => {
      if (!nativeAuthorized(applications)) return { windows: [], displays: [] };
      const { windows, displays } = await control(owner, { lease, operation: 'windows' });
      return { windows: windows.filter(w => nativeAuthorized(applications, w)),
        displays: displays.filter(d => nativeAuthorized(applications, d)) };
    },
    recordingTargets: async lease => (await control(owner, { lease, operation: 'windows' })).displays,
    recordingStream: (lease, target, signal, consume) => consumeHost(owner, { lease, target, signal, mode: 'recording' }, consume),
    stream: async (lease, target, signal, consume) => {
      requireNativeAuthorization(applications, target);
      return consumeHost(owner, { lease, target, signal }, consume);
    },
    observe: async (lease, target, mode) => {
      requireNativeAuthorization(applications, target);
      return control(owner, { operation: 'observe', lease, target, ...(mode ? { mode } : {}) });
    },
    press: async (lease, target, observationId, waitFor) => {
      requireNativeAuthorization(applications, target);
      return control(owner, { operation: 'press', lease, target, observationId, elementId: 'relay-increment',
        ...(waitFor ? { waitFor } : {}) });
    },
    mouse: async (lease, target, observationId, mouse, waitFor) => {
      requireNativeAuthorization(applications, target);
      return control(owner, { operation: 'mouse', lease, target, observationId, mouse, ...(waitFor ? { waitFor } : {}) });
    },
  };
}

/**
 * Viewing and discovery never block other agents. Input takes a lease scoped to the selected
 * window so agents on different windows proceed in parallel; the whole desktop stays exclusive.
 */
export function leaseScope(target, mutate) {
  if (target && isDesktop(target)) return { kind: 'exclusive' };
  if (!mutate) return { kind: 'observer' };
  if (!target || isDesktop(target)) return { kind: 'exclusive' };
  return { kind: 'window', target: { windowId: target.windowId, pid: target.pid, bundleId: target.bundleId } };
}
const refusals = new Set(['background_unavailable', 'observation_stale', 'target_mismatch', 'element_unavailable',
  'accessibility_required', 'screen_recording_required', 'lease_scope']);
const safeError = e => /^[a-z_]{1,64}$/.test(e.message) ? e.message : 'qa_operation_failed';
export class Broker {
  constructor(store, native, { frameWaitMs = 1500, applications = native.applications,
    reconnectAttempts = 5, reconnectMs = 2000, exports, ownsStore = true, recordingPopulation, recordingKey } = {}) {
    this.reconnectAttempts = reconnectAttempts;
    this.reconnectMs = reconnectMs;
    this.store = store;
    this.native = native;
    this.applications = applicationProfiles(applications);
    this.queue = Promise.resolve();
    this.pending = 0;
    this.connection = 'disconnected';
    this.interruptions = 0;
    this.owner = null;
    this.windows = [];
    this.displays = [];
    this.target = null;
    this.latest = null;
    this.latestVideo = null;
    this.latestKeyframe = null;
    this.active = null;
    this.observation = null;
    this.frameVersion = 0;
    this.frameWaitMs = frameWaitMs;
    this.frameWaiters = new Set();
    this.viewers = new Set();
    this.ownsStore = ownsStore;
    this.ownsExporter = exports == null;
    this.exports = exports ?? new Exporter(store);
    this.recordingContext = new RecordingContext(this, recordingPopulation, recordingKey ?? this);
  }
  status() {
    const runId = this.current()?.id ?? null;
    return { connection: this.connection, error: this.error ?? null, owner: this.owner?.actor ?? 'observer-only',
      target: this.target, windows: this.windows, displays: this.displays, runId,
      ...(runId ? recordingName(this.active.events) : {}),
      desktopAllowed: nativeAuthorized(this.applications, { kind: 'desktop' }),
      desktopCapabilities: nativeAuthorized(this.applications, { kind: 'desktop' })
        ? capabilities({ platform: 'macos', kind: 'desktop' })
        : { sharedQA: false, reason: 'application_not_authorized', observe: [], act: [], check: [], recording: false },
      targetCapabilities: this.target ? capabilities({ platform: 'macos', ...this.target }) : null,
      applications: this.applications.map(app => ({ ...app, capabilities: capabilities(app) })),
      frameVersion: this.latest?.version ?? null, frameReceivedAt: this.latest?.receivedAt ?? null,
      frameAgeMs: this.latest ? Math.round(performance.now() - this.latest.receivedMono) : null,
      currentCheck: this.active?.events.findLast(e => e.kind === 'assertion' || e.kind === 'step-start' && ['assert-count', 'assert-visual'].includes(e.operation)) ?? null,
      recordingScope: this.recordingContext.status(),
      recording: '5 Hz background sampling + action evidence · 10 minute maximum · elapsed-time MP4 with marked gaps' };
  }
  current() {
    if (this.store.fault) {
      const active = this.active;
      this.active = null; this.error = 'recording_error';
      if (active) { this.publishCue(null); this.retireRecording('recording_error'); }
    }
    if (this.active?.events.at(-1)?.kind === 'run-end') {
      this.active = null; this.publishCue(null); this.retireRecording('run_finished');
    }
    return this.active;
  }
  retireRecording(reason) {
    const legacy = this.recordingContext.key === this;
    const lease = legacy && this.connection === 'disconnected' ? this.lease : null;
    if (lease) this.lease = null;
    const previousCleanup = this.leaseCleanup;
    const done = (async () => {
      await previousCleanup;
      await this.recordingContext.stop(reason);
      if (lease) {
        try { await this.native.release(lease); }
        catch { this.error = 'release_unconfirmed'; }
      }
      if (legacy && !this.lease) await this.recordingContext.population.release(this);
      if (!this.active || this.active.events.at(-1)?.kind === 'run-end') this.onRecordingInactive?.();
    })().catch(e => { this.error = safeError(e); });
    if (lease) this.leaseCleanup = done;
  }
  publishCue(cue, sourceMs = 0) {
    for (const push of this.viewers) push({ header: { type: 'cue', cue, sourceMs }, image: Buffer.alloc(0) });
  }
  event(fields) {
    if (!this.current()) return;
    const event = this.store.append(this.active, fields);
    if (['action-attempt', 'action', 'step-end', 'gap', 'ownership'].includes(event.kind)) {
      const cues = actionCues(this.active.events);
      const cue = cueAt(cues, event.elapsedMs, this.latest?.header) ? cues.at(-1) : null;
      this.publishCue(cue, event.elapsedMs);
    }
    return event;
  }
  async recordFrame(force = false) {
    if (!this.current() || !this.latest) return null;
    return (await this.store.frameAsync(this.active, this.latest, force))?.frameId ?? null;
  }
  recordingFailed(e) {
    this.publishCue(null);
    this.error = safeError(e);
    try { if (this.active && this.active.events.at(-1)?.kind !== 'run-end') this.store.finish(this.active, 'blocked', this.error); }
    catch { this.error = 'recording_error'; }
    this.retireRecording(this.error);
  }
  waitFrame(afterVersion, timeoutMs, acceptCurrent = false) {
    const usable = () => this.latest && this.latest.version > afterVersion &&
      (!acceptCurrent || performance.now() - this.latest.receivedMono < 2000);
    if (usable()) return Promise.resolve(this.latest);
    return new Promise(resolve => {
      const finish = value => { clearTimeout(timer); this.frameWaiters.delete(check); resolve(value); };
      const check = () => { if (usable()) finish(this.latest); };
      const timer = setTimeout(() => finish(null), timeoutMs);
      this.frameWaiters.add(check);
    });
  }
  async halt() {
    await this.recordingContext.stop('capture_stopped');
    this.publishCue(null);
    if (this.stream) {
      this.stream.abort.abort();
      await this.stream.done;
      this.stream = null;
    }
    this.latest = null;
    this.latestVideo = null;
    this.latestKeyframe = null;
  }
  launch() {
    if (!this.target || !this.lease) return;
    requireNativeAuthorization(this.applications, this.target);
    const abort = new AbortController();
    const { lease, target } = this;
    this.connection = 'connecting';
    const done = (async () => {
      // Redial only capture on the original lease. Input and authority changes are never retried.
      for (let attempt = 0; ; attempt++) {
        let reason, accepting = true, firstFrameAt;
        try {
          await this.native.stream(lease, target, abort.signal, packet => {
            if (!accepting || abort.signal.aborted) return;
            if (packet.header.type === 'diagnostic') throw new Error(packet.header.code);
            if (['frame', 'vframe'].includes(packet.header.type)) {
              firstFrameAt ??= performance.now();
              if (performance.now() - firstFrameAt >= 10000) attempt = 0;
            }
            this.streamPacket(abort, packet);
          });
          reason = 'stream_ended';
        } catch (e) { reason = safeError(e); } finally { accepting = false; }
        if (abort.signal.aborted) return;
        if (!['stream_timeout', 'stream_terminated', 'stream_closed', 'stream_interrupted'].includes(reason) ||
            attempt >= this.reconnectAttempts) { this.disconnected(reason); return; }
        this.interruptions++;
        await this.recordingContext.stop('capture_reconnecting');
        this.observation = this.latest = this.latestVideo = this.latestKeyframe = null;
        this.connection = 'connecting';
        try { this.event({ kind: 'gap', actor: 'broker', status: 'reconnecting', reason }); }
        catch { this.disconnected('recording_error'); return; }
        try { await delay(this.reconnectMs, undefined, { signal: abort.signal }); }
        catch (e) { if (abort.signal.aborted) return; throw e; }
        if (abort.signal.aborted) return;
      }
    })();
    this.stream = { abort, done };
  }
  streamPacket(abort, packet) {
    if (abort.signal.aborted) return;
    // H.264 access units flow straight to live viewers; recording keeps using JPEG snapshots.
    if (packet.header.type === 'vframe') {
      this.latestVideo = packet;
      if (packet.header.keyframe) this.latestKeyframe = packet;
      this.connection = 'live';
      for (const push of this.viewers) push(packet);
      return;
    }
    if (packet.header.type !== 'frame') return;
    this.latest = { ...packet, version: ++this.frameVersion, receivedAt: Date.now(), receivedMono: performance.now() };
    this.connection = 'live';
    if (this.recordingContext.state.reason === 'capture_reconnecting') this.recordingContext.resume();
    // Background samples never wait on disk; the store drops them when its write queue is full.
    this.recordFrame().catch(e => this.recordingFailed(e));
    for (const ready of this.frameWaiters) ready();
    for (const push of this.viewers) push(this.latest);
  }
  disconnected(reason) {
    this.recordingContext.stop(reason).catch(e => this.recordingFailed(e));
    this.interruptions++;
    this.connection = 'disconnected';
    this.error = reason;
    this.latest = null;
    this.latestVideo = null;
    this.latestKeyframe = null;
    this.observation = null;
    this.owner = null;
    try {
      this.event({ kind: 'gap', actor: 'broker', status: 'blocked', reason });
      if (this.current()) {
        if (this.active.inflight) this.active.pendingEnd = { status: 'interrupted', reason };
        else this.store.finish(this.active, 'interrupted', reason);
      }
    } catch { this.error = 'recording_error'; }
    this.retireRecording(reason);
  }
  requireOwner(actor, args) {
    if (!this.owner || this.owner.actor !== actor || this.owner.grant !== args.grant)
      throw new Error('stale_control');
  }
  command(actor, raw) {
    if (!['human', 'agent'].includes(actor)) return Promise.reject(new Error('invalid_actor'));
    const parsed = qaCommand.safeParse(raw);
    if (!parsed.success) return Promise.reject(new Error('invalid_command'));
    return this.enqueue(() => this.execute(actor, parsed.data));
  }
  deletionInfo(id) {
    const pending = this.store.deletions.get(id);
    if (pending) return { title: pending.title, pending: true, reason: null };
    const run = this.store.get(id);
    let reason = run.inflight || run.events.at(-1)?.kind !== 'run-end' ? 'run_active' : null;
    try { this.exports.requireIdle(id); } catch (e) { reason ??= e.message; }
    return { title: recordingName(run.events).title, pending: false, reason };
  }
  recordings() {
    return this.enqueue(async () => {
      const result = await readTask(this, 'qa_runs', { offset: 0, limit: this.store.policy.maxRuns });
      const runs = result.runs.map(r => ({ ...r, sourceBytes: this.store.get(r.runId).bytes,
        exportBytes: this.exports.usageBytes(r.runId), deletion: this.deletionInfo(r.runId) }));
      for (const d of this.store.deletions.values()) runs.push({ runId: d.id, title: d.title, started: d.started,
        status: 'deletion pending', counts: { pass: 0, fail: 0, blocked: 0, uncertain: 0 },
        export: { status: 'unavailable' }, sourceBytes: this.store.runs.get(d.id)?.bytes ?? 0,
        exportBytes: this.exports.usageBytes(d.id), deletion: this.deletionInfo(d.id) });
      const exportBytes = runs.reduce((sum, r) => sum + r.exportBytes, 0);
      return { total: runs.length, runs, storage: { sourceBytes: this.store.totalBytes, exportBytes,
        totalBytes: this.store.totalBytes + exportBytes, sourceLimitBytes: this.store.policy.maxTotalBytes,
        exportLimitBytes: this.exports.policy.totalBytes, maxRuns: this.store.policy.maxRuns,
        measuringExports: !!this.exports.active } };
    });
  }
  deleteRecording(actor, id) {
    if (actor !== 'human') return Promise.reject(new Error('human_confirmation_required'));
    return this.enqueue(() => {
      if (this.current()?.id === id) throw new Error('run_active');
      return this.store.deleteRun(id, this.exports);
    });
  }
  task(actor, name, raw) {
    if (!['human', 'agent'].includes(actor) || !Object.hasOwn(tasks, name)) return Promise.reject(new Error('invalid_operation'));
    const parsed = tasks[name].safeParse(raw);
    if (!parsed.success) return Promise.reject(new Error('invalid_arguments'));
    if (['qa_status', 'qa_runs', 'qa_replay', 'qa_report'].includes(name)) return readTask(this, name, parsed.data);
    return this.enqueue(() => executeTask(this, actor, name, parsed.data));
  }
  enqueue(work) {
    if (this.pending >= 16 || this.closing) return Promise.reject(new Error('broker_busy'));
    this.pending++;
    const task = this.queue.then(work);
    this.queue = task.catch(() => {}).finally(() => { this.pending--; });
    return task;
  }
  async rotate(takeover, scope = leaseScope(this.target, false)) {
    await this.leaseCleanup;
    await this.halt();
    this.owner = null;
    this.observation = null;
    try {
      if (this.lease) {
        const previous = this.lease;
        this.lease = null;
        await this.native.release(previous);
      }
      const value = await this.native.acquire(takeover, 3600, scope);
      this.lease = { token: value.token, generation: value.generation };
      this.leaseKind = scope.kind;
      this.connection = 'connected';
      this.error = null;
    } catch (e) { this.lease = null; this.disconnected(safeError(e)); throw e; }
  }
  async refreshTargets(lease) {
    const found = await this.native.windows(lease);
    this.windows = (Array.isArray(found) ? found : found.windows).filter(w => nativeAuthorized(this.applications, w));
    this.displays = (Array.isArray(found) ? [] : found.displays).filter(d => nativeAuthorized(this.applications, d));
    this.discoveredAt = Date.now();
  }
  targets() { return [...this.displays, ...this.windows]; }
  async freshGeometry(snapshot, afterVersion = -1) {
    if (this.connection !== 'live') throw new Error('live_frame_required');
    let frame = this.latest;
    if (frame && frame.version > afterVersion) {
      try { return frameGeometry(frame, snapshot, this.targetProcessStartedAt); } catch {}
    }
    const version = this.frameVersion;
    this.event({ kind: 'gap', actor: 'broker', reason: 'capture_refresh', status: 'interrupted' });
    await this.halt();
    this.launch();
    frame = await this.waitFrame(version, 15000);
    if (!frame) throw new Error('live_frame_required');
    this.recordingContext.resume();
    return frameGeometry(frame, snapshot, this.targetProcessStartedAt);
  }
  async discover() {
    if (!nativeAuthorized(this.applications)) { this.windows = []; this.displays = []; return []; }
    let temporary;
    try {
      if (!this.lease) {
        const { token, generation } = await this.native.acquire(false, 30, leaseScope(null, false));
        temporary = { token, generation };
      }
      const lease = this.lease ?? temporary;
      await this.refreshTargets(lease);
      return this.targets().map(w => ({ ...w, target: targetIdentity(w),
        capabilities: capabilities({ platform: 'macos', ...w }) }));
    } finally {
      if (temporary) await this.native.release({ token: temporary.token, generation: temporary.generation });
    }
  }
  async execute(actor, args) {
    if (args.op === 'connect') {
      if (this.current()) throw new Error('run_active');
      if (this.owner) throw new Error('release_control_before_connect');
      requireNativeAuthorization(this.applications);
      if (!this.lease) await this.rotate(false);
      await this.halt();
      try {
        await this.refreshTargets(this.lease);
      }
      catch (e) { this.disconnected(safeError(e)); throw e; }
      this.connection = 'connected';
      this.launch();
      return this.status();
    }
    if (args.op === 'take') {
      if (actor === 'agent' && (args.takeover || this.owner)) throw new Error('human_takeover_required');
      if (this.owner && !args.takeover) throw new Error('control_held');
      requireNativeAuthorization(this.applications, this.target);
      this.event({ kind: 'gap', actor, reason: 'ownership_change', status: 'interrupted' });
      if (this.lease && !args.takeover) {
        await this.halt();
        this.owner = null;
        this.observation = null;
        const lease = this.lease;
        this.lease = null;
        try { await this.native.release(lease); }
        catch (e) { this.disconnected(safeError(e)); throw e; }
      }
      await this.rotate(args.takeover, leaseScope(this.target, true));
      this.owner = { actor, grant: opaque() };
      this.event({ kind: 'ownership', actor, status: 'pass', owner: actor });
      this.launch();
      return { grant: this.owner.grant, ...this.status() };
    }
    if (args.op === 'select') {
      if (this.current() || this.owner) throw new Error('release_control_before_select');
      requireNativeAuthorization(this.applications, args.target);
      if (!this.targets().some(w => sameTarget(w, args.target))) throw new Error('target_unavailable');
      await this.halt();
      const started = this.windows.find(w => sameTarget(w, args.target))?.processStartedAt;
      if (!isDesktop(args.target) && args.target.bundleId !== sampleBundle && !Number.isFinite(started)) throw new Error('target_identity_required');
      this.target = args.target;
      this.targetProcessStartedAt = started;
      this.observation = null;
      const scope = leaseScope(this.target, false);
      if (this.leaseKind !== scope.kind) await this.rotate(false, scope);
      this.launch();
      return this.status();
    }
    this.requireOwner(actor, args);
    if (this.store.fault) throw new Error('recording_error');
    if (args.op === 'release') {
      this.event({ kind: 'gap', actor, reason: 'control_released', status: 'interrupted' });
      this.event({ kind: 'ownership', actor, status: 'pass', owner: 'observer-only' });
      await this.halt();
      this.owner = null;
      this.observation = null;
      const lease = this.lease;
      this.lease = null;
      try {
        await this.native.release(lease);
        await this.rotate(false);
        if (!this.current() && this.recordingContext.key === this) await this.recordingContext.population.release(this);
        this.launch();
      } catch (e) { this.disconnected(safeError(e)); throw e; }
      return this.status();
    }
    if (!this.target) throw new Error('select_target_first');
    if (args.op === 'start') {
      if (this.current()) throw new Error('run_active');
      if (this.connection !== 'live') throw new Error('live_frame_required');
      const application = selectApplication(this.applications, { applicationId: args.labels.applicationId, target: this.target });
      if (this.recordingContext.key === this) await this.recordingContext.population.reserve(this);
      try {
        if (this.target.bundleId !== sampleBundle) {
          const fresh = await this.native.observe(this.lease, this.target, 'pixels');
          await this.freshGeometry(fresh.snapshot);
        } else if (Number.isFinite(this.targetProcessStartedAt) && this.latest?.header.processStartedAt !== this.targetProcessStartedAt)
          throw new Error('target_mismatch');
        const labels = recordingLabels(args.labels, this.target,
          this.windows.find(window => sameTarget(window, this.target)), application);
        this.active = this.store.start(this.target, { ...labels, applicationId: application.id,
          ...(Number.isFinite(this.targetProcessStartedAt) ? { processStartedAt: String(this.targetProcessStartedAt) } : {}) }, actor);
        this.observation = null;
        await this.recordFrame(true);
        await this.recordingContext.start();
        if (!this.current()) throw new Error('recording_error');
        clearTimeout(this.runTimer);
        const captured = this.active;
        this.runTimer = setTimeout(() => {
          if (this.current() !== captured) return;
          if (captured.inflight) captured.limitReached = true;
          else { this.store.finish(captured, 'blocked', 'recording_full'); this.current(); }
        }, this.store.policy.maxDurationMs);
        this.runTimer.unref();
        return { runId: this.active.id, ...recordingName(this.active.events), recordingScope: this.recordingContext.status() };
      } catch (error) {
        if (!this.current() && !this.lease && this.recordingContext.key === this) await this.recordingContext.population.release(this);
        throw error;
      }
    }
    if (args.op === 'stop') {
      await this.recordingContext.stop('run_finished');
      if (!this.current()) throw new Error('no_active_run');
      this.observation = null;
      clearTimeout(this.runTimer);
      await this.store.flush(this.active).catch(() => {});
      if (!this.current()) throw new Error('recording_error');
      const lastAction = this.active.events.findLast(e => ['action', 'action-attempt'].includes(e.kind))?.seq ?? 0;
      const lastAssertion = this.active.events.findLast(e => e.kind === 'assertion')?.seq ?? 0;
      const status = this.active.events.some(e => e.status === 'fail') ? 'fail'
        : this.active.events.some(e => ['uncertain', 'blocked'].includes(e.status)) ? 'uncertain'
          : lastAssertion > lastAction ? 'pass' : 'uncertain';
      this.publishCue(null);
      return this.store.finish(this.active, status, 'caller_stopped');
    }
    if (!this.current()) throw new Error('start_run_first');
    if (this.connection !== 'live') throw new Error('live_frame_required');
    const interruptions = this.interruptions;
    requireNativeAuthorization(this.applications, this.target);
    const generic = this.target.bundleId !== sampleBundle;
    const pixels = generic || args.op === 'mouse' || args.mode === 'pixels';
    const input = ['press', 'mouse'].includes(args.op);
    if (generic && (['press', 'assert-count'].includes(args.op) || args.waitFor || args.mode === 'count')) throw new Error('application_not_supported');
    const recordedRun = this.active;
    this.store.reserveStep(recordedRun);
    const stepId = opaque(), actionId = input ? opaque() : undefined;
    let beforeFrameId, dispatched = false, acknowledgedVersion;
    try {
      beforeFrameId = await this.recordFrame(true);
      if (recordedRun.limitReached) throw new Error('recording_full');
      this.event({ kind: 'step-start', actor, stepId, actionId, operation: args.waitFor ? 'assert-count' : args.op, beforeFrameId,
        title: args.waitFor ? `Act and wait for count ${args.waitFor.equals}` : args.title,
        ...(args.waitFor ? { inputOperation: args.op, waitFor: args.waitFor } : {}),
        context: args.context, ...(args.mouse ? { mouse: args.mouse } : {}) });
      if (args.op === 'assert-visual') {
        const observed = this.observation;
        this.observation = null;
        if (!observed || observed.id !== args.observationId || observed.grant !== args.grant ||
            Date.now() > observed.expires || !observed.frame || !observed.afterFrameId) throw new Error('observation_stale');
        if (recordedRun.events.some(e => e.kind === 'assertion' && e.afterFrameId === observed.afterFrameId))
          throw new Error('observation_stale');
        frameGeometry(observed.frame, observed.snapshot, observed.snapshot.processStartedAt, 30000);
        const current = await this.native.observe(this.lease, this.target, observed.mode);
        if (interruptions !== this.interruptions || Date.now() > observed.expires ||
            JSON.stringify(current.snapshot) !== JSON.stringify(observed.snapshot))
          throw new Error('observation_stale');
        const observation = this.event({ kind: 'observation', actor, stepId, observationId: observed.id,
          snapshot: observed.snapshot, actual: args.actual, beforeFrameId, afterFrameId: observed.afterFrameId,
          frameEvidence: observed.frameEvidence });
        return this.event({ kind: 'assertion', actor, stepId, observationId: observed.id,
          observationSeq: observation.seq, title: args.title, context: args.context ?? '',
          checkKind: 'visual', assessment: { source: 'caller', actor, serverVerified: false },
          expected: args.expected, actual: args.actual, status: args.outcome, afterFrameId: observed.afterFrameId });
      }
      if (input) {
        const observed = this.observation;
        this.observation = null;
        if (!observed || observed.id !== args.observationId || observed.grant !== args.grant ||
            Date.now() > observed.expires) throw new Error('observation_stale');
        if (args.op === 'press' && observed.mode === 'pixels') throw new Error('observation_stale');
        if (args.op === 'mouse')
          frameGeometry(observed.frame, observed.snapshot, observed.snapshot.processStartedAt, 30000);
        this.event({ kind: 'action-attempt', actor, stepId, actionId, status: 'running', observationId: observed.id });
        dispatched = true;
        const reply = args.op === 'mouse'
          ? await this.native.mouse(this.lease, this.target, observed.nativeId, args.mouse, args.waitFor)
          : await this.native.press(this.lease, this.target, observed.nativeId, args.waitFor);
        acknowledgedVersion = this.latest?.version ?? this.frameVersion;
        this.event({ kind: 'action', actor, stepId, actionId, status: 'pass',
          reason: 'input_acknowledged_requires_assertion', observationId: observed.id, beforeFrameId });
        if (args.completion || args.waitFor) {
          if (interruptions !== this.interruptions) throw new Error('action_uncertain');
          const ack = { stepId, actionId, acknowledged: true, assertion: false, retrySafe: false,
            ...(reply?.route ? { route: reply.route, focusPreserved: reply.focusPreserved, cursorPreserved: reply.cursorPreserved } : {}) };
          const effect = reply?.effect;
          if (args.waitFor && !effect) throw new Error('action_uncertain');
          if (!args.waitFor) {
            this.event({ kind: 'step-end', actor, stepId, actionId, status: 'pass' });
            return { ...ack, status: 'acknowledged' };
          }
          const observationId = opaque(), title = `Act and wait for count ${args.waitFor.equals}`;
          const status = effect.status === 'matched' ? 'pass' : effect.actual === null ? 'blocked' : 'fail';
          const sample = this.event({ kind: 'observation', actor, stepId, actionId, observationId,
            actual: effect.actual, source: 'device-ax', dispatchMs: effect.dispatchMs, elapsedDeviceMs: effect.elapsedMs });
          this.event({ kind: 'assertion', actor, stepId, actionId, observationId, observationSeq: sample.seq,
            title, expected: args.waitFor.equals, actual: effect.actual, status, reason: effect.reason ?? effect.status });
          return { ...ack, assertion: true, checkId: stepId, status, expected: args.waitFor.equals, effect };
        }
      }
      const result = await this.native.observe(this.lease, this.target, pixels ? 'pixels' : undefined);
      const value = result.snapshot.elements.find(e => e.id === 'relay-count')?.value;
      if (!pixels && !/^Count: \d+$/.test(value)) throw new Error('invalid_count');
      const actual = pixels ? null : Number(value.slice(7)), observationId = opaque();
      let newer = input ? await this.waitFrame(acknowledgedVersion, this.frameWaitMs) : this.latest;
      let geometry;
      if (pixels) {
        if (interruptions !== this.interruptions) throw new Error(dispatched ? 'action_uncertain' : 'observation_stale');
        geometry = await this.freshGeometry(result.snapshot, input ? acknowledgedVersion : -1);
        newer = this.latest;
      }
      const afterFrameId = newer ? await this.recordFrame(true) : null;
      if (interruptions !== this.interruptions) throw new Error(dispatched ? 'action_uncertain' : 'observation_stale');
      const frameEvidence = { beforeFrameId, afterFrameId, status: afterFrameId ? 'available' : 'missing',
        correlation: generic || args.op === 'mouse' ? 'fresh selected-target pixels; outcome requires caller assessment'
          : args.op === 'press' ? 'newer frame received after input acknowledgement; AX is assertion authority' : 'nearest received sample',
        frameVersion: newer?.version ?? null, ageMs: newer ? Math.round(performance.now() - newer.receivedMono) : null };
      const observation = this.event({ kind: 'observation', actor, stepId, actionId, observationId,
        actual, snapshot: result.snapshot, beforeFrameId, afterFrameId, frameEvidence });
      this.observation = { id: observationId, nativeId: result.observationId, grant: args.grant,
        expires: Math.min(Date.now() + 30000, result.expiresAt * 1000),
        snapshot: result.snapshot, frame: newer, afterFrameId, frameEvidence, mode: pixels ? 'pixels' : undefined };
      if (this.store.fault) throw new Error('recording_error');
      if (args.op === 'assert-count') {
        return this.event({ kind: 'assertion', actor, stepId, observationId,
          title: args.title ?? 'Count assertion', context: args.context ?? '',
          observationSeq: observation.seq, expected: args.expected, actual,
          status: actual === args.expected ? 'pass' : 'fail' });
      }
      this.event({ kind: 'step-end', actor, stepId, actionId, status: 'pass' });
      return { observationId, actual, stepId, actionId, frameEvidence, ...(geometry ?? {}),
        ...(input ? { acknowledged: true, assertion: false } : {}),
        status: recordedRun.limitReached ? 'blocked' : 'pass', retrySafe: !input };
    } catch (e) {
      if (args.op === 'assert-count') this.event({ kind: 'assertion', actor, stepId, title: args.title ?? 'Count assertion',
        context: args.context ?? '', expected: args.expected, actual: null, status: 'blocked', reason: safeError(e) });
      if (args.op === 'assert-visual') this.event({ kind: 'assertion', actor, stepId, title: args.title,
        context: args.context ?? '', expected: args.expected, actual: args.actual, checkKind: 'visual',
        assessment: { source: 'caller', actor, serverVerified: false }, status: 'blocked', reason: safeError(e) });
      // The native layer reports these only when it refused before sending any input.
      const refused = refusals.has(safeError(e));
      this.event({ kind: 'step-end', actor, stepId, actionId,
        status: dispatched && !refused ? 'uncertain' : 'blocked', reason: safeError(e) });
      throw new Error(safeError(e));
    } finally {
      if (!this.store.fault) this.store.endStep(recordedRun);
    }
  }
  async close() {
    this.closing = true;
    await this.queue;
    await this.halt();
    await this.recordingContext.close();
    clearTimeout(this.runTimer);
    try {
      if (this.ownsExporter) await this.exports.close();
      if (this.current()) await this.store.flush(this.active).catch(() => {});
      if (this.current()) this.store.finish(this.active, 'interrupted', 'broker_shutdown');
    } finally {
      if (this.lease) { try { await this.native.release(this.lease); } catch {} }
      await this.leaseCleanup;
      if (this.recordingContext.key === this) await this.recordingContext.population.release(this);
      if (this.ownsStore) this.store.close();
    }
  }
}

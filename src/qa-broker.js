import { z } from 'zod';
import { control, controlTargetSchema } from './control.js';
import { consumeHost } from './stream.js';
import { run } from './transport.js';
import { opaque } from './qa-store.js';
import { Exporter } from './qa-export.js';
import { tasks } from './qa-contract.js';
import { executeTask, readTask } from './qa-tasks.js';

const id = z.string().regex(/^[a-f0-9]{32}$/);
const grant = { grant: id };
export const qaCommand = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('connect') }),
  z.strictObject({ op: z.literal('select'), target: controlTargetSchema }),
  z.strictObject({ op: z.literal('take'), takeover: z.boolean().default(false) }),
  z.strictObject({ op: z.literal('release'), ...grant }),
  z.strictObject({ op: z.literal('start'), ...grant,
    labels: z.record(z.string().max(40), z.string().max(200)).refine(v => Object.keys(v).length <= 8).default({}) }),
  z.strictObject({ op: z.literal('stop'), ...grant }),
  z.strictObject({ op: z.literal('observe'), ...grant }),
  z.strictObject({ op: z.literal('press'), ...grant, observationId: id }),
  z.strictObject({ op: z.literal('assert-count'), ...grant, expected: z.number().int().min(0).max(1e9),
    title: z.string().min(1).max(160).optional(), context: z.string().max(600).optional() }),
]);

export function nativeAdapter(config) {
  if (config.transport !== 'factory') throw new Error('factory_transport_required');
  const owner = { ...config, owner: 'qa:' + opaque() };
  return {
    acquire: takeover => run(owner, 'acquire', { ttlSeconds: 3600, takeover }),
    release: lease => run(owner, 'release', { lease }),
    windows: async lease => {
      let windows = [];
      await consumeHost(owner, { lease, mode: 'windows' }, ({ header }) => {
        if (header.type === 'windows') windows = header.windows;
      });
      return windows.filter(w => w.bundleId === 'com.factory.applets.RelayMac');
    },
    stream: (lease, target, signal, consume) => consumeHost(owner, { lease, target, signal }, consume),
    observe: (lease, target) => control(owner, { operation: 'observe', lease, target }),
    press: (lease, target, observationId) => control(owner, {
      operation: 'press', lease, target, observationId, elementId: 'relay-increment',
    }),
  };
}

const safeError = e => /^[a-z_]{1,64}$/.test(e.message) ? e.message : 'qa_operation_failed';
export class Broker {
  constructor(store, native, { frameWaitMs = 1500 } = {}) {
    this.store = store;
    this.native = native;
    this.queue = Promise.resolve();
    this.pending = 0;
    this.connection = 'disconnected';
    this.owner = null;
    this.windows = [];
    this.target = null;
    this.latest = null;
    this.active = null;
    this.observation = null;
    this.frameVersion = 0;
    this.frameWaitMs = frameWaitMs;
    this.frameWaiters = new Set();
    this.exports = new Exporter(store);
  }
  status() {
    const runId = this.current()?.id ?? null;
    return { connection: this.connection, error: this.error ?? null, owner: this.owner?.actor ?? 'observer-only',
      target: this.target, windows: this.windows, runId,
      frameVersion: this.latest?.version ?? null, frameReceivedAt: this.latest?.receivedAt ?? null,
      frameAgeMs: this.latest ? Math.round(performance.now() - this.latest.receivedMono) : null,
      currentCheck: this.active?.events.findLast(e => e.kind === 'assertion' || e.kind === 'step-start' && e.operation === 'assert-count') ?? null,
      recording: '5 Hz background sampling + action evidence · 10 minute maximum · elapsed-time MP4 with marked gaps' };
  }
  current() {
    if (this.store.fault) { this.active = null; this.error = 'recording_error'; }
    if (this.active?.events.at(-1)?.kind === 'run-end') this.active = null;
    return this.active;
  }
  event(fields) { if (this.current()) return this.store.append(this.active, fields); }
  recordFrame(force = false) {
    if (!this.current() || !this.latest) return null;
    return this.store.frame(this.active, this.latest, force)?.frameId ?? null;
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
    if (this.stream) {
      this.stream.abort.abort();
      await this.stream.done;
      this.stream = null;
    }
    this.latest = null;
  }
  launch() {
    if (!this.target || !this.lease) return;
    const abort = new AbortController();
    this.connection = 'connecting';
    const done = Promise.resolve().then(() => this.native.stream(this.lease, this.target, abort.signal, packet => {
      if (abort.signal.aborted || packet.header.type !== 'frame') return;
      this.latest = { ...packet, version: ++this.frameVersion, receivedAt: Date.now(), receivedMono: performance.now() };
      this.connection = 'live';
      try { this.recordFrame(); }
      catch (e) { this.error = safeError(e); if (this.current()) this.store.finish(this.active, 'blocked', this.error); }
      for (const ready of this.frameWaiters) ready();
    })).then(() => {
      if (!abort.signal.aborted) this.disconnected('stream_ended');
    }, e => {
      if (!abort.signal.aborted) this.disconnected(safeError(e));
    });
    this.stream = { abort, done };
  }
  disconnected(reason) {
    this.connection = 'disconnected';
    this.error = reason;
    this.latest = null;
    this.observation = null;
    this.owner = null;
    try {
      this.event({ kind: 'gap', actor: 'broker', status: 'blocked', reason });
      if (this.current()) {
        if (this.active.inflight) this.active.pendingEnd = { status: 'interrupted', reason };
        else this.store.finish(this.active, 'interrupted', reason);
      }
    } catch { this.error = 'recording_error'; }
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
  async rotate(takeover) {
    await this.halt();
    this.owner = null;
    this.observation = null;
    try {
      const value = await this.native.acquire(takeover);
      this.lease = { token: value.token, generation: value.generation };
      this.connection = 'connected';
      this.error = null;
    } catch (e) { this.lease = null; this.disconnected(safeError(e)); throw e; }
  }
  async execute(actor, args) {
    if (args.op === 'connect') {
      if (this.current()) throw new Error('run_active');
      if (this.owner) throw new Error('release_control_before_connect');
      if (!this.lease) await this.rotate(false);
      await this.halt();
      try { this.windows = await this.native.windows(this.lease); }
      catch (e) { this.disconnected(safeError(e)); throw e; }
      this.connection = 'connected';
      this.launch();
      return this.status();
    }
    if (args.op === 'take') {
      if (actor === 'agent' && (args.takeover || this.owner)) throw new Error('human_takeover_required');
      if (this.owner && !args.takeover) throw new Error('control_held');
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
      await this.rotate(args.takeover);
      this.owner = { actor, grant: opaque() };
      this.event({ kind: 'ownership', actor, status: 'pass', owner: actor });
      this.launch();
      return { grant: this.owner.grant, ...this.status() };
    }
    if (args.op === 'select') {
      if (this.current() || this.owner) throw new Error('release_control_before_select');
      if (!this.windows.some(w => w.windowId === args.target.windowId && w.pid === args.target.pid &&
          w.bundleId === args.target.bundleId)) throw new Error('target_unavailable');
      await this.halt();
      this.target = args.target;
      this.observation = null;
      this.launch();
      return this.status();
    }
    this.requireOwner(actor, args);
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
        this.launch();
      } catch (e) { this.disconnected(safeError(e)); throw e; }
      return this.status();
    }
    if (!this.target) throw new Error('select_target_first');
    if (args.op === 'start') {
      if (this.current()) throw new Error('run_active');
      if (this.connection !== 'live') throw new Error('live_frame_required');
      this.active = this.store.start(this.target, args.labels, actor);
      this.observation = null;
      this.recordFrame(true);
      clearTimeout(this.runTimer);
      const captured = this.active;
      this.runTimer = setTimeout(() => {
        if (this.current() !== captured) return;
        if (captured.inflight) captured.limitReached = true;
        else this.store.finish(captured, 'blocked', 'recording_full');
      }, this.store.policy.maxDurationMs);
      this.runTimer.unref();
      return { runId: this.active.id };
    }
    if (args.op === 'stop') {
      if (!this.current()) throw new Error('no_active_run');
      this.observation = null;
      clearTimeout(this.runTimer);
      const lastAction = this.active.events.findLast(e => ['action', 'action-attempt'].includes(e.kind))?.seq ?? 0;
      const lastAssertion = this.active.events.findLast(e => e.kind === 'assertion')?.seq ?? 0;
      const status = this.active.events.some(e => e.status === 'fail') ? 'fail'
        : this.active.events.some(e => ['uncertain', 'blocked'].includes(e.status)) ? 'uncertain'
          : lastAssertion > lastAction ? 'pass' : 'uncertain';
      return this.store.finish(this.active, status, 'caller_stopped');
    }
    if (!this.current()) throw new Error('start_run_first');
    const recordedRun = this.active;
    this.store.reserveStep(recordedRun);
    const stepId = opaque(), actionId = args.op === 'press' ? opaque() : undefined;
    let beforeFrameId, dispatched = false, acknowledgedVersion;
    try {
      beforeFrameId = this.recordFrame(true);
      if (recordedRun.limitReached) throw new Error('recording_full');
      this.event({ kind: 'step-start', actor, stepId, actionId, operation: args.op, beforeFrameId,
        title: args.title, context: args.context });
      if (args.op === 'press') {
        const observed = this.observation;
        this.observation = null;
        if (!observed || observed.id !== args.observationId || observed.grant !== args.grant ||
            Date.now() > observed.expires) throw new Error('observation_stale');
        this.event({ kind: 'action-attempt', actor, stepId, actionId, status: 'running', observationId: observed.id });
        dispatched = true;
        await this.native.press(this.lease, this.target, observed.nativeId);
        acknowledgedVersion = this.latest?.version ?? this.frameVersion;
        this.event({ kind: 'action', actor, stepId, actionId, status: 'pass',
          reason: 'input_acknowledged_requires_assertion', observationId: observed.id, beforeFrameId });
      }
      const result = await this.native.observe(this.lease, this.target);
      const value = result.snapshot.elements.find(e => e.id === 'relay-count')?.value;
      if (!/^Count: \d+$/.test(value)) throw new Error('invalid_count');
      const actual = Number(value.slice(7)), observationId = opaque();
      this.observation = { id: observationId, nativeId: result.observationId, grant: args.grant,
        expires: Math.min(Date.now() + 30000, result.expiresAt * 1000) };
      const newer = args.op === 'press' ? await this.waitFrame(acknowledgedVersion, this.frameWaitMs) : this.latest;
      const afterFrameId = newer ? this.recordFrame(true) : null;
      const frameEvidence = { beforeFrameId, afterFrameId, status: afterFrameId ? 'available' : 'missing',
        correlation: args.op === 'press' ? 'newer frame received after input acknowledgement; AX is assertion authority' : 'nearest received sample',
        frameVersion: newer?.version ?? null, ageMs: newer ? Math.round(performance.now() - newer.receivedMono) : null };
      const observation = this.event({ kind: 'observation', actor, stepId, actionId, observationId,
        actual, snapshot: result.snapshot, beforeFrameId, afterFrameId, frameEvidence });
      if (this.store.fault) throw new Error('recording_error');
      if (args.op === 'assert-count') {
        return this.event({ kind: 'assertion', actor, stepId, observationId,
          title: args.title ?? 'Count assertion', context: args.context ?? '',
          observationSeq: observation.seq, expected: args.expected, actual,
          status: actual === args.expected ? 'pass' : 'fail' });
      }
      this.event({ kind: 'step-end', actor, stepId, actionId, status: 'pass' });
      return { observationId, actual, stepId, actionId, frameEvidence,
        status: recordedRun.limitReached ? 'blocked' : 'pass', retrySafe: args.op !== 'press' };
    } catch (e) {
      if (args.op === 'assert-count') this.event({ kind: 'assertion', actor, stepId, title: args.title ?? 'Count assertion',
        context: args.context ?? '', expected: args.expected, actual: null, status: 'blocked', reason: safeError(e) });
      this.event({ kind: 'step-end', actor, stepId, actionId,
        status: dispatched ? 'uncertain' : 'blocked', reason: safeError(e) });
      throw new Error(safeError(e));
    } finally {
      if (!this.store.fault) this.store.endStep(recordedRun);
    }
  }
  async close() {
    this.closing = true;
    await this.queue;
    await this.halt();
    clearTimeout(this.runTimer);
    await this.exports.close();
    try {
      if (this.current()) this.store.finish(this.active, 'interrupted', 'broker_shutdown');
    } finally {
      if (this.lease) { try { await this.native.release(this.lease); } catch {} }
      this.store.close();
    }
  }
}

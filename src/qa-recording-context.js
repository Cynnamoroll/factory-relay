import { opaque } from './qa-store.js';
import { desktopTargetSchema, displayConfigurationSchema, sameTarget, sameDisplayConfiguration, isDesktop } from './window-target.js';
import { frameGeometry } from './qa-geometry.js';

const reasonOf = error => /^[a-z_]{1,64}$/.test(error.message) ? error.message : 'recording_context_unavailable';
const rect = value => Array.isArray(value) && value.length === 4 && value.every(Number.isFinite) && value[2] > 0 && value[3] > 0;

export function recordingDisplay(displays, bounds) {
  if (!rect(bounds) || !Array.isArray(displays) || displays.length > 32) throw new Error('recording_geometry_unavailable');
  const candidates = displays.map(display => {
    const target = { kind: display.kind, displayId: display.displayId, displayUUID: display.displayUUID };
    if (!desktopTargetSchema.safeParse(target).success || !displayConfigurationSchema.safeParse(display.displayConfiguration).success)
      throw new Error('recording_geometry_unavailable');
    const b = display.displayConfiguration.boundsPoints;
    const overlap = Math.max(0, Math.min(bounds[0] + bounds[2], b[0] + b[2]) - Math.max(bounds[0], b[0])) *
      Math.max(0, Math.min(bounds[1] + bounds[3], b[1] + b[3]) - Math.max(bounds[1], b[1]));
    return { target, displayConfiguration: display.displayConfiguration, overlap };
  }).sort((a, b) => b.overlap - a.overlap);
  if (!candidates[0]?.overlap || candidates[0].overlap === candidates[1]?.overlap) throw new Error('recording_display_ambiguous');
  return candidates[0];
}

/** Reservations count before fixture launch. Invalidation is synchronous, disk draining is awaited. */
export class RecordingPopulation {
  constructor() { this.members = new Map(); this.controllers = new Set(); }
  sole(key) { return this.members.size === 1 && this.members.has(key); }
  async reserve(key) {
    if (this.members.has(key)) return;
    this.members.set(key, true);
    await Promise.all([...this.controllers].map(controller => controller.stop('multiple_sessions')));
  }
  async release(key) {
    if (!this.members.delete(key)) return;
    await Promise.all([...this.controllers].map(controller => controller.stop('session_population_changed')));
    for (const controller of this.controllers) controller.resume();
  }
}

export class RecordingContext {
  constructor(broker, population = new RecordingPopulation(), key = broker) {
    this.broker = broker; this.population = population; this.key = key;
    this.state = { scope: 'window', reason: 'not_recording' };
    this.epoch = 0; this.version = 0;
    population.controllers.add(this);
  }
  status() { return this.state; }
  transition(scope, reason, selected) {
    const state = { scope, reason, ...(selected ? { target: selected.target, displayConfiguration: selected.displayConfiguration } : {}) };
    if (JSON.stringify(this.state) === JSON.stringify(state)) return;
    this.state = state;
    const run = this.broker.active;
    if (run && run.events.at(-1)?.kind !== 'run-end')
      this.broker.event({ kind: 'recording-scope', actor: 'broker', ...this.state, scopeId: this.scopeId });
  }
  async stop(reason = 'not_recording') {
    ++this.epoch;
    this.abort?.abort();
    this.abort = null;
    clearTimeout(this.prewarmTimer);
    this.ready?.();
    this.transition('window', reason);
    const run = this.broker.active;
    if (run) await this.broker.store.flush(run);
  }
  resume() {
    if (!this.broker.closing && this.broker.active?.events.at(-1)?.kind !== 'run-end' &&
        this.broker.active && this.population.sole(this.key))
      this.start().catch(error => this.broker.recordingFailed(error));
  }
  async start(timeoutMs = 15000) {
    const request = this.epoch + 1;
    await this.stop('preparing_display');
    if (request !== this.epoch) return;
    const b = this.broker, run = b.active;
    if (!run || run.events.at(-1)?.kind === 'run-end') return;
    if (isDesktop(b.target)) { this.transition('display', 'explicit_desktop_target'); return; }
    if (!this.population.sole(this.key)) { this.transition('window', 'multiple_sessions'); return; }
    if (!b.native.recordingTargets || !b.native.recordingStream) { this.transition('window', 'recording_context_unsupported'); return; }
    const epoch = this.epoch, abort = this.abort = new AbortController();
    const valid = () => epoch === this.epoch && !abort.signal.aborted && this.population.sole(this.key) &&
      b.active === run && run.events.at(-1)?.kind !== 'run-end' && b.owner && b.lease && b.connection === 'live';
    let ready;
    const first = new Promise(resolve => { ready = resolve; this.ready = resolve; });
    const fail = reason => {
      if (epoch !== this.epoch) return;
      ++this.epoch; abort.abort(); this.abort = null;
      this.transition('window', reason);
      ready();
    };
    const timer = this.prewarmTimer = setTimeout(() => { fail('recording_context_timeout'); ready(); }, timeoutMs);
    const done = (async () => {
      try {
        const displays = await b.native.recordingTargets(b.lease, abort.signal);
        if (!valid()) return;
        const selected = recordingDisplay(displays, b.latest?.header.initialWindowRectPoints);
        this.scopeId = opaque();
        await b.native.recordingStream(b.lease, selected.target, abort.signal, packet => {
          if (!valid()) return;
          if (packet.header.type === 'diagnostic') throw new Error(packet.header.code);
          if (packet.header.type !== 'frame') return;
          if (!sameTarget(packet.header, selected.target) ||
              !sameDisplayConfiguration(packet.header.displayConfiguration, selected.displayConfiguration))
            throw new Error('recording_geometry_stale');
          const receivedMono = performance.now(), window = b.latest;
          frameGeometry({ ...packet, receivedMono }, { target: selected.target, displayConfiguration: selected.displayConfiguration });
          if (!window || receivedMono - window.receivedMono > 2000 || !sameTarget(window.header, b.target) ||
              !Number.isFinite(b.targetProcessStartedAt) ||
              window.header.processStartedAt !== b.targetProcessStartedAt) throw new Error('recording_geometry_stale');
          frameGeometry(window, { target: b.target, processStartedAt: b.targetProcessStartedAt,
            windowRectPoints: window.header.initialWindowRectPoints }, b.targetProcessStartedAt);
          if (this.state.scope !== 'display') this.transition('display', 'sole_window_session', selected);
          const frame = { ...packet, version: ++this.version, receivedMono, receivedAt: Date.now(),
            recording: { scopeId: this.scopeId, windowHeader: window.header,
              displayTarget: selected.target, displayConfiguration: selected.displayConfiguration,
              windowReceivedElapsedMs: Math.max(0, window.receivedMono - run.monoStart) } };
          b.store.frameAsync(run, frame, false, { kind: 'recording-frame', valid }).then(event => {
            if (event && valid()) { clearTimeout(timer); ready(); }
          }).catch(error => { fail(reasonOf(error)); b.recordingFailed(error); });
        });
        if (valid()) fail('recording_context_ended');
      } catch (error) { if (valid()) fail(reasonOf(error)); }
      finally { clearTimeout(timer); ready(); }
    })();
    // Discovery and capture can be abandoned without holding up session setup.
    this.done = done.catch(error => b.recordingFailed(error));
    await first;
  }
  async close() {
    await this.stop('session_closed');
    this.population.controllers.delete(this);
  }
}

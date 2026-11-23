import { randomBytes } from 'node:crypto';
import { Broker, leaseScope } from './qa-broker.js';
import { applicationProfiles, capabilities, requireNativeAuthorization, selectApplication } from './qa-applications.js';
import { tasks } from './qa-contract.js';
import { opaque } from './qa-store.js';
import { executeTask, readTask } from './qa-tasks.js';
import { sampleBundle, sameTarget } from './window-target.js';
import { windowSessionHeartbeat, windowSessionRunTasks, windowSessionStart } from './qa-window-session-contract.js';
import { recordingName } from '../web/recording-name.js';

const slots = 4;
const defaultLifetimeMs = 12 * 60_000;
export const isWindowRecording = run => run?.events[0]?.labels?.windowSession === 'true';
const leaseRevoked = new Set(['stale_lease', 'lease_expired', 'lease_scope', 'target_mismatch']);

function withoutSharedReplay(result) {
  const { replayUrl, ...data } = result;
  if (data.runs) data.runs = data.runs.map(withoutSharedReplay);
  if (data.checks && Array.isArray(data.checks)) data.checks = data.checks.map(withoutSharedReplay);
  if (data.reportMarkdown) {
    data.reportMarkdown = data.reportMarkdown
      .replace(/\[Open QA review\]\([^)]+\)/, 'Use qa_replay with this window session to review its evidence.')
      .replace(/\[(!\[[^\]]*\]\([^)]+\))\]\([^)]+\)/g, '$1')
      .replace(/\[([^\]]+)\]\(http:\/\/127\.0\.0\.1:\d+\/#run=[a-f0-9]+(?:&step=[a-f0-9]+)?\)/g, '$1');
  }
  return data;
}

export class WindowSessions {
  constructor(archive, createNative, { lifetimeMs = defaultLifetimeMs, onCleanupError = () => {} } = {}) {
    this.archive = archive;
    this.createNative = createNative;
    this.lifetimeMs = lifetimeMs;
    this.onCleanupError = onCleanupError;
    this.entries = new Array(slots).fill(null);
    this.credentials = new Map();
  }

  authenticate(authorization) {
    return /^Bearer [a-f0-9]{64}$/.test(authorization ?? '') ? this.credentials.get(authorization.slice(7)) : undefined;
  }

  async open(input, origin, { signal } = {}) {
    if (this.closing || signal?.aborted) throw new Error('session_closed');
    const parsed = windowSessionStart.safeParse(input);
    if (!parsed.success) throw new Error('invalid_arguments');
    const { target, processStartedAt, managedFixture, ...start } = parsed.data;
    const native = this.createNative();
    const applications = applicationProfiles(native.applications);
    const requestedTarget = managedFixture ? { bundleId: sampleBundle } : target;
    requireNativeAuthorization(applications, requestedTarget);
    const application = selectApplication(applications, { ...start, target: requestedTarget });
    if (managedFixture && typeof native.launchFixture !== 'function') throw new Error('fixture_unavailable');
    const slot = this.entries.indexOf(null);
    if (slot < 0) throw new Error('session_limit');
    const { store } = this.archive;
    if (store.fault) throw new Error('recording_error');
    if (store.runs.size >= store.policy.maxRuns) throw new Error('recording_full');
    const entry = { slot, target: Object.freeze(target), processStartedAt, managedFixture, live: new AbortController(),
      token: randomBytes(32).toString('hex'), pending: new Set() };
    this.entries[slot] = entry;
    entry.opening = this.archive.recordingContext.population.reserve(entry).then(() => this.start(entry, native, start, origin, application));
    const abort = () => { this.closeEntry(entry).catch(this.onCleanupError); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const result = await entry.opening;
      this.assertOpen(entry);
      if (entry.live.signal.aborted) throw new Error(entry.fixtureOutcome?.reason ?? 'stale_control');
      this.credentials.set(entry.token, entry);
      entry.timer = setTimeout(() => { this.closeEntry(entry).catch(this.onCleanupError); }, this.lifetimeMs);
      entry.timer.unref();
      return { ...withoutSharedReplay(result), ...(managedFixture ? { managedFixture: true } : {}),
        token: entry.token, expiresAt: Date.now() + this.lifetimeMs };
    } catch (error) {
      await this.closeEntry(entry);
      throw error;
    } finally { signal?.removeEventListener('abort', abort); }
  }

  async prepareFixture(entry, native) {
    // An observer fence refuses an existing exclusive holder without taking control, before any launch.
    const { token, generation } = await native.acquire(false, 30, { kind: 'observer' });
    try {
      this.assertActive(entry);
      const fixture = entry.fixture = native.launchFixture({ lifetimeMs: this.lifetimeMs });
      fixture.done.then(outcome => {
        entry.fixtureOutcome = outcome;
        if (!entry.stopping) this.stopNative(entry).catch(this.onCleanupError);
      });
      const identity = await fixture.ready;
      if (identity.target.bundleId !== sampleBundle) throw new Error('target_mismatch');
      entry.target = Object.freeze(identity.target);
      entry.processStartedAt = identity.processStartedAt;
      this.assertActive(entry);
    } finally {
      try { await native.release({ token, generation }); }
      catch (error) {
        if (!['stale_lease', 'lease_expired'].includes(error.message)) entry.releaseUnconfirmed = true;
        if (entry.releaseUnconfirmed) throw new Error('release_unconfirmed');
        throw error;
      }
    }
  }

  async start(entry, native, start, origin, application) {
    if (entry.managedFixture) {
      entry.preparing = this.prepareFixture(entry, native);
      await entry.preparing;
    } else if (entry.target.bundleId === sampleBundle) {
      const owned = this.entries.filter(candidate => candidate?.managedFixture);
      // A just-spawned fixture may appear in discovery before its readiness proof arrives.
      await Promise.allSettled(owned.filter(candidate => !candidate.target).map(candidate => candidate.preparing));
      if (owned.some(candidate => sameTarget(candidate.target, entry.target) && candidate.processStartedAt === entry.processStartedAt))
        throw new Error('lease_held');
    }
    this.assertActive(entry);
    const { target, processStartedAt } = entry;
    const matches = selected => sameTarget(selected, target);
    const guard = selected => {
      this.assertActive(entry);
      if (!matches(selected)) throw new Error('target_mismatch');
    };
    const revoke = () => {
      entry.live.abort();
      if (entry.fixture) this.stopNative(entry).catch(this.onCleanupError);
    };
    const checked = async (work, signal) => {
      try { return await work(); }
      catch (error) {
        if (!signal?.aborted && leaseRevoked.has(error.message)) revoke();
        throw error;
      }
    };
    const scopeNative = {
      applications: native.applications,
      recordingTargets: native.recordingTargets ? (lease, signal) => { this.assertActive(entry); return native.recordingTargets(lease, signal); } : undefined,
      recordingStream: native.recordingStream ? (lease, selected, signal, consume) => {
        this.assertActive(entry);
        return native.recordingStream(lease, selected, signal, packet => { if (!entry.live.signal.aborted) consume(packet); });
      } : undefined,
      acquire: (takeover, ttl, scope) => {
        this.assertActive(entry);
        if (takeover || scope?.kind !== 'window' || !matches(scope.target))
          throw new Error('lease_scope');
        return native.acquire(false, Math.min(ttl, Math.ceil(this.lifetimeMs / 1000)), scope);
      },
      release: async lease => {
        try { await native.release(lease); }
        catch (error) {
          if (entry.fixture && !['stale_lease', 'lease_expired'].includes(error.message)) entry.releaseUnconfirmed = true;
          throw error;
        }
      },
      windows: async lease => {
        this.assertActive(entry);
        const found = await native.windows(lease);
        const window = (Array.isArray(found) ? found : found.windows).find(matches);
        if (window && window.processStartedAt !== processStartedAt) throw new Error('target_mismatch');
        if (window) entry.fixture?.assertWindow(window);
        return { windows: window ? [window] : [], displays: [] };
      },
      stream: (lease, selected, signal, consume) => {
        guard(selected);
        return checked(() => native.stream(lease, selected, signal, packet => {
          if (entry.live.signal.aborted) return;
          if (['frame', 'vframe'].includes(packet.header.type) &&
              (!matches(packet.header) || packet.header.processStartedAt !== processStartedAt)) throw new Error('target_mismatch');
          consume(packet);
        }), signal);
      },
      observe: async (lease, selected, mode) => {
        guard(selected);
        return checked(async () => {
          const observed = await native.observe(lease, selected, mode);
          if (!matches(observed.snapshot.target) || observed.snapshot.processStartedAt !== processStartedAt)
            throw new Error('target_mismatch');
          return observed;
        });
      },
      press: (lease, selected, ...args) => { guard(selected); return checked(() => native.press(lease, selected, ...args)); },
      mouse: (lease, selected, ...args) => { guard(selected); return checked(() => native.mouse(lease, selected, ...args)); },
    };
    const { store, exports } = this.archive;
    const broker = entry.broker = new Broker(store, scopeNative, { exports, ownsStore: false, recordingPopulation: this.archive.recordingContext.population, recordingKey: entry });
    broker.onRecordingInactive = () => { this.stopNative(entry).catch(this.onCleanupError); };
    broker.origin = origin;
    // A window lease also authorizes discovery. Validate the process before starting capture.
    await broker.rotate(false, leaseScope(target, true));
    await broker.refreshTargets(broker.lease);
    if (!broker.windows.length) throw new Error('target_unavailable');
    this.assertActive(entry);
    broker.target = target;
    broker.targetProcessStartedAt = processStartedAt;
    broker.owner = { actor: 'agent', grant: opaque() };
    broker.launch();
    if (!await this.firstFrame(entry)) throw new Error(broker.error ?? entry.fixtureOutcome?.reason ?? 'live_frame_required');
    this.assertActive(entry);
    const result = await broker.execute('agent', { op: 'start', grant: broker.owner?.grant,
      labels: { ...(start.title ? { title: start.title } : {}), applicationId: application.id, windowSession: 'true',
        ...(start.context ? { context: start.context } : {}) } });
    entry.runId = result.runId;
    if (!broker.owner || entry.live.signal.aborted) throw new Error('stale_control');
    broker.owner.runId = entry.runId;
    return { runId: entry.runId, ...recordingName(broker.store.get(entry.runId).events),
      applicationId: application.id, application, resumed: false, controller: 'agent', target,
      recordingScope: broker.recordingContext.status(),
      recording: { cadence: '5 Hz background sampling plus action evidence', maxDurationSeconds: store.policy.maxDurationMs / 1000,
        gaps: 'explicitly marked' }, nextAction: 'qa_observe' };
  }

  assertOpen(entry) {
    if (this.closing || entry.closing) throw new Error('stale_control');
  }

  assertActive(entry) {
    this.assertOpen(entry);
    const reason = entry.fixtureOutcome?.reason;
    if (entry.live.signal.aborted) throw new Error(reason && reason !== 'closed' ? reason : 'stale_control');
  }

  firstFrame(entry) {
    const { broker, live: { signal } } = entry;
    if (broker.latest || signal.aborted) return Promise.resolve(broker.latest);
    return new Promise(resolve => {
      const done = frame => {
        clearTimeout(timer);
        broker.frameWaiters.delete(check);
        signal.removeEventListener('abort', abort);
        resolve(frame);
      };
      const abort = () => done(null);
      const check = () => { if (broker.latest) done(broker.latest); };
      const timer = setTimeout(abort, 15000);
      broker.frameWaiters.add(check);
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  liveEntry(runId) {
    const entry = this.entries.find(candidate => candidate?.runId === runId);
    if (!entry || entry.closing || entry.live.signal.aborted || !entry.broker.owner || entry.broker.current()?.id !== runId) return null;
    return entry;
  }

  overview() {
    return this.entries.flatMap(entry => {
      if (!entry?.runId || !this.liveEntry(entry.runId)) return [];
      const { connection, owner, frameVersion, frameAgeMs, currentCheck, recordingScope } = entry.broker.status();
      return [{ runId: entry.runId, ...recordingName(entry.broker.store.get(entry.runId).events), target: entry.target, recordingScope, connection, frameVersion, frameAgeMs, owner,
        currentCheck: currentCheck ? { title: currentCheck.title ?? 'Count assertion', status: currentCheck.status ?? 'running' } : null }];
    });
  }

  async task(entry, name, input) {
    this.assertOpen(entry);
    if (name === windowSessionHeartbeat) {
      if (!entry.fixture) throw new Error('invalid_operation');
      if (!tasks.qa_status.safeParse(input).success) throw new Error('invalid_arguments');
      if (entry.stopping || !entry.broker.owner || !entry.broker.current()) {
        await this.stopNative(entry);
        return { active: false };
      }
      this.assertActive(entry);
      entry.fixture.renew();
      return { active: true };
    }
    if (!Object.hasOwn(tasks, name) || ['qa_start', 'qa_control'].includes(name)) throw new Error('invalid_operation');
    if (windowSessionRunTasks.includes(name) && input?.runId !== entry.runId) throw new Error('run_mismatch');
    if (entry.pending.size >= 8) throw new Error('broker_busy');
    const broker = entry.broker;
    if (['qa_act', 'qa_observe', 'qa_check'].includes(name)) this.assertActive(entry);
    if (entry.stopping && name === 'qa_finish') {
      const parsed = tasks.qa_finish.safeParse(input);
      if (!parsed.success) throw new Error('invalid_arguments');
      await entry.stopping;
      this.assertOpen(entry);
      return withoutSharedReplay(await executeTask(broker, 'agent', name, parsed.data));
    }
    if (name === 'qa_targets') {
      if (!tasks.qa_targets.safeParse(input).success) throw new Error('invalid_arguments');
      const windows = broker.windows.map(w => ({ ...w, target: entry.target, capabilities: capabilities({ platform: 'macos', ...w }) }));
      return { windows, displays: [], discoveredAt: broker.discoveredAt, input: 'Restricted windows use background accessibility actions.' };
    }
    let work;
    if (name === 'qa_runs') {
      const page = tasks.qa_runs.safeParse(input);
      if (!page.success) throw new Error('invalid_arguments');
      const store = { history: () => broker.store.runs.has(entry.runId) && !broker.store.deletions.has(entry.runId) ? [{ runId: entry.runId }] : [],
        get: id => broker.store.get(id), fault: broker.store.fault };
      work = readTask({ store, origin: broker.origin, exports: broker.exports }, name, page.data);
    } else {
      work = broker.task('agent', name, input);
    }
    entry.pending.add(work);
    try {
      const result = await work;
      this.assertOpen(entry);
      if (name === 'qa_status') return { ...result, desktopAllowed: false, desktopCapabilities: null,
        applications: result.applications.filter(app => app.bundleId === entry.target.bundleId && app.platform === 'macos') };
      return withoutSharedReplay(result);
    } finally {
      entry.pending.delete(work);
      if (name === 'qa_finish' && !broker.current()) {
        entry.live.abort();
        await this.stopNative(entry);
      }
    }
  }

  stopNative(entry) {
    if (entry.stopping) return entry.stopping;
    entry.live.abort();
    entry.broker?.recordingContext.stop('session_stopped').catch(this.onCleanupError);
    entry.stopping = (async () => {
      const results = await Promise.allSettled([
        entry.fixture?.close(),
        entry.opening.catch(() => {}).then(() => entry.broker?.close()),
      ]);
      if (entry.broker) {
        Object.assign(entry.broker, { owner: null, lease: null, observation: null, connection: 'disconnected' });
      }
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
      await this.archive.recordingContext.population.release(entry);
      if (entry.releaseUnconfirmed) throw new Error('release_unconfirmed');
    })();
    return entry.stopping;
  }

  closeEntry(entry) {
    if (entry.closing) return entry.closing;
    this.credentials.delete(entry.token);
    clearTimeout(entry.timer);
    entry.live.abort();
    entry.closing = (async () => {
      try { await this.stopNative(entry); }
      finally { await Promise.allSettled(entry.pending); }
    })().finally(() => { this.entries[entry.slot] = null; });
    return entry.closing;
  }

  async close() {
    this.closing = true;
    const results = await Promise.allSettled(this.entries.filter(Boolean).map(entry => this.closeEntry(entry)));
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
}

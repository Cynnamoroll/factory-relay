import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { recordingName } from '../web/recording-name.js';

export const opaque = () => randomBytes(16).toString('hex');
export const isId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
export const POLICY = Object.freeze({
  maxRuns: 64, maxEvents: 12000, maxFrames: 3600, maxRunBytes: 512 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024, maxImageBytes: 4 * 1024 * 1024,
  maxJournalBytes: 8 * 1024 * 1024, sampleMs: 200, maxDurationMs: 600000,
});

function privateEntry(file, directory = false) {
  const s = fs.lstatSync(file);
  if (s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o077) ||
      (directory ? !s.isDirectory() : !s.isFile() || s.nlink !== 1)) throw new Error('unsafe_qa_storage');
  return s;
}

const sourceName = name => name === 'events.jsonl' || /^[a-f0-9]{32}\.jpg$/.test(name);
const identity = s => ({ dev: s.dev, ino: s.ino });
export const sameFile = (a, b) => !!a && !!b && a.dev === b.dev && a.ino === b.ino;
function directory(file) {
  const prior = privateEntry(file, true);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  const opened = fs.fstatSync(fd);
  if (!sameFile(prior, opened)) { fs.closeSync(fd); throw new Error('unsafe_deletion_storage'); }
  return { fd, path: `/proc/self/fd/${fd}`, ...identity(opened) };
}
function validateSnapshot(snapshot, allow) {
  if (snapshot === null) return;
  if (!snapshot || !Number.isSafeInteger(snapshot.dev) || !Number.isSafeInteger(snapshot.ino) ||
      !Array.isArray(snapshot.files) || snapshot.files.length > POLICY.maxFrames + 256 ||
      new Set(snapshot.files.map(f => f.name)).size !== snapshot.files.length ||
      snapshot.files.some(f => !allow(f.name) || !Number.isSafeInteger(f.dev) ||
        !Number.isSafeInteger(f.ino) || !Number.isSafeInteger(f.bytes) || f.bytes < 0))
    throw new Error('unsafe_deletion_intent');
}
/** Descriptor-relative paths keep cleanup inside the inspected Linux directories, even after a rename. */
export function ownedFiles(root, id, allow, expected = undefined, remove = false) {
  if (!isId(id)) throw new Error('run_not_found');
  if (process.platform !== 'linux') throw new Error('deletion_requires_linux');
  if (expected !== undefined) validateSnapshot(expected, allow);
  const parent = directory(root);
  let child;
  try {
    const file = path.join(parent.path, id);
    try { child = directory(file); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    if (expected !== undefined && (!expected || !sameFile(child, expected))) throw new Error('unsafe_deletion_storage');
    const expectedFiles = new Map(expected?.files.map(f => [f.name, f]) ?? []);
    const files = fs.readdirSync(child.path).map(name => {
      if (!allow(name)) throw new Error('unsafe_deletion_storage');
      const stat = privateEntry(path.join(child.path, name));
      const entry = { name, ...identity(stat), bytes: stat.size };
      if (expected !== undefined) {
        const prior = expectedFiles.get(name);
        if (!prior || !sameFile(prior, entry) || prior.bytes !== entry.bytes) throw new Error('unsafe_deletion_storage');
      }
      return entry;
    });
    if (remove) {
      for (const entry of files) {
        const name = path.join(child.path, entry.name);
        if (!sameFile(privateEntry(file, true), child)) throw new Error('unsafe_deletion_storage');
        if (!sameFile(privateEntry(name), entry)) throw new Error('unsafe_deletion_storage');
        fs.unlinkSync(name);
      }
      fs.fsyncSync(child.fd);
      if (!sameFile(privateEntry(file, true), child)) throw new Error('unsafe_deletion_storage');
      fs.rmdirSync(file);
      fs.fsyncSync(parent.fd);
    }
    return { dev: child.dev, ino: child.ino, files };
  } finally {
    if (child) fs.closeSync(child.fd);
    fs.closeSync(parent.fd);
  }
}
export const snapshotBytes = snapshot => snapshot?.files.reduce((sum, f) => sum + f.bytes, 0) ?? 0;

/** A private append-only journal. Only an incomplete final record is truncated on recovery. */
export class RunStore {
  constructor(root, policy = POLICY) {
    this.root = root;
    this.policy = policy;
    this.runs = new Map();
    this.deletions = new Map();
    this.totalBytes = 0;
    this.maxPendingWrites = 2;
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    privateEntry(root, true);
    this.lock = path.join(root, 'writer.lock');
    if (fs.existsSync(this.lock)) {
      privateEntry(this.lock);
      const pid = Number(fs.readFileSync(this.lock, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('unsafe_qa_lock');
      try { process.kill(pid, 0); throw new Error('qa_workspace_in_use'); }
      catch (e) { if (e.code !== 'ESRCH') throw e; }
      fs.unlinkSync(this.lock);
    }
    fs.writeFileSync(this.lock, String(process.pid), { flag: 'wx', mode: 0o600 });
    try {
      for (const name of fs.readdirSync(root)) {
        const match = name.match(/^delete-([a-f0-9]{32})\.(json|tmp)$/);
        if (!match) continue;
        const file = path.join(root, name);
        if (privateEntry(file).size > 1024 * 1024) throw new Error('unsafe_deletion_intent');
        if (match[2] === 'tmp') { fs.unlinkSync(file); continue; }
        const intent = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (intent.version !== 1 || intent.id !== match[1] || typeof intent.title !== 'string' ||
            intent.title.length > 600 || !Number.isFinite(intent.started) ||
            !Object.hasOwn(intent, 'exports')) throw new Error('unsafe_deletion_intent');
        validateSnapshot(intent.source, sourceName);
        if (!intent.source) throw new Error('unsafe_deletion_intent');
        this.deletions.set(intent.id, intent);
      }
      for (const id of fs.readdirSync(root)) {
        if (id === 'writer.lock') continue;
        if (/^delete-[a-f0-9]{32}\.json$/.test(id)) continue;
        if (id === 'exports') { privateEntry(path.join(root, id), true); continue; }
        if (this.deletions.has(id)) {
          this.totalBytes += snapshotBytes(ownedFiles(root, id, sourceName, this.deletions.get(id).source));
          continue;
        }
        if (!isId(id) || this.runs.size >= policy.maxRuns) throw new Error('unsafe_qa_storage');
        const dir = path.join(root, id);
        const dirIdentity = identity(privateEntry(dir, true));
        let bytes = 0;
        for (const name of fs.readdirSync(dir)) {
          if (name !== 'events.jsonl' && !/^[a-f0-9]{32}\.jpg$/.test(name)) throw new Error('unsafe_qa_storage');
          bytes += privateEntry(path.join(dir, name)).size;
        }
        if (bytes > policy.maxRunBytes + 65536) throw new Error('qa_storage_limit');
        this.totalBytes += bytes;
        if (this.totalBytes > policy.maxTotalBytes + 65536 * policy.maxRuns) throw new Error('qa_storage_limit');
        const file = path.join(dir, 'events.jsonl');
        if (!fs.existsSync(file)) fs.writeFileSync(file, '', { flag: 'wx', mode: 0o600 });
        if (privateEntry(file).size > policy.maxJournalBytes + 65536) throw new Error('qa_journal_limit');
        const raw = fs.readFileSync(file);
        const end = raw.lastIndexOf(10) + 1;
        const events = raw.subarray(0, end).toString('utf8').split('\n').filter(Boolean).map(JSON.parse);
        if ((events.length && (events[0].kind !== 'run-start' || events[0].runId !== id)) ||
            events.length > policy.maxEvents + 1 ||
            events.some((e, i) => e.seq !== i + 1 || e.runId !== id)) throw new Error('invalid_qa_journal');
        const run = { id, dir, dirIdentity, file, events, bytes, journalBytes: end, started: events[0]?.at ?? Date.now(),
          frames: events.filter(e => ['frame', 'recording-frame'].includes(e.kind)).length, lastSample: 0 };
        this.runs.set(id, run);
        if (end !== raw.length) {
          fs.truncateSync(file, end);
          run.bytes -= raw.length - end;
          this.totalBytes -= raw.length - end;
        }
        if (!events.length) this.append(run, { kind: 'run-start', actor: 'broker',
          target: null, labels: {}, status: 'interrupted', reason: 'incomplete_run_creation' }, true);
        if (!events.some(e => e.kind === 'run-end')) this.finish(run, 'interrupted', 'broker_restart');
      }
    } catch (e) { this.close(); throw e; }
  }
  close() {
    if (this.lock) { fs.unlinkSync(this.lock); this.lock = null; }
  }
  append(run, fields, terminal = false) {
    if (this.fault) throw new Error('recording_error');
    if (run.events.at(-1)?.kind === 'run-end') throw new Error('run_closed');
    if (!terminal && !run.inflight && (run.events.length >= this.policy.maxEvents - 1 ||
        run.journalBytes >= this.policy.maxJournalBytes - 8192 ||
        run.bytes >= this.policy.maxRunBytes - 8192 || this.totalBytes >= this.policy.maxTotalBytes - 8192)) {
      this.finish(run, 'blocked', 'recording_full');
      throw new Error('recording_full');
    }
    const event = { ...fields, runId: run.id, seq: run.events.length + 1,
      at: Date.now(), elapsedMs: this.elapsed(run) };
    const line = JSON.stringify(event) + '\n';
    if (Buffer.byteLength(line) > 8192) throw new Error('event_too_large');
    try {
      const fd = fs.openSync(run.file, 'a', 0o600);
      try { fs.writeFileSync(fd, line); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } catch { this.fault = true; throw new Error('recording_error'); }
    run.events.push(event);
    run.bytes += Buffer.byteLength(line);
    run.journalBytes += Buffer.byteLength(line);
    this.totalBytes += Buffer.byteLength(line);
    return event;
  }
  start(target, labels, actor) {
    if (this.fault) throw new Error('recording_error');
    if (this.runs.size >= this.policy.maxRuns || this.totalBytes >= this.policy.maxTotalBytes - 16384)
      throw new Error('recording_full');
    const id = opaque(), dir = path.join(this.root, id);
    fs.mkdirSync(dir, { mode: 0o700 });
    const run = { id, dir, dirIdentity: identity(privateEntry(dir, true)), file: path.join(dir, 'events.jsonl'), events: [], bytes: 0, journalBytes: 0,
      started: Date.now(), monoStart: performance.now(), frames: 0, lastSample: -Infinity };
    fs.writeFileSync(run.file, '', { flag: 'wx', mode: 0o600 });
    this.runs.set(id, run);
    this.append(run, { kind: 'run-start', actor, status: 'running', target, labels,
      policy: this.policy, recording: '5 Hz background sampling plus action evidence; elapsed-time MP4; unknown gaps explicitly marked' });
    return run;
  }
  /** Synchronous durable frame; offline fixtures and tools use it. Live capture uses frameAsync. */
  frame(run, packet, force = false) {
    const plan = this.reserveFrame(run, packet, force);
    if (!plan?.file) return plan?.event ?? null;
    try {
      const fd = fs.openSync(plan.file, 'wx', 0o600);
      try { fs.writeFileSync(fd, packet.image); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } catch { this.fault = true; throw new Error('recording_error'); }
    return this.commitFrame(run, packet, plan);
  }
  /**
   * Image write and fsync happen off the capture callback. Background samples are dropped
   * rather than queued beyond maxPendingWrites; forced evidence frames are awaited by callers.
   */
  frameAsync(run, packet, force = false, { kind = 'frame', valid = () => true } = {}) {
    const state = kind === 'frame' ? run : (run.recordingState ??= { lastSample: -Infinity });
    if (packet.version !== undefined && packet.version === state.lastVersion && state.lastFrameWork) return state.lastFrameWork;
    if (!force && (run.pendingWrites ?? 0) >= this.maxPendingWrites) { run.droppedSamples = (run.droppedSamples ?? 0) + 1; return Promise.resolve(null); }
    let plan;
    try { plan = this.reserveFrame(run, packet, force, state); } catch (e) { return Promise.reject(e); }
    if (!plan?.file) return Promise.resolve(plan?.event ?? null);
    run.pendingWrites = (run.pendingWrites ?? 0) + 1;
    const work = (async () => {
      try {
        const handle = await fs.promises.open(plan.file, 'wx', 0o600);
        try { await handle.writeFile(packet.image); await handle.sync(); } finally { await handle.close(); }
      } catch { this.fault = true; throw new Error('recording_error'); }
      finally { run.pendingWrites--; }
      if (!valid() || run.events.at(-1)?.kind === 'run-end') { this.revertFrame(run, plan); return null; }
      return this.commitFrame(run, packet, plan, kind, state);
    })();
    state.lastFrameWork = work;
    run.writes = (run.writes ?? Promise.resolve()).then(() => work.catch(() => {}));
    return work;
  }
  /** Resolves once every queued frame write for the run has completed or failed. */
  async flush(run) {
    await run.writes;
    if (this.fault) throw new Error('recording_error');
  }
  revertFrame(run, plan) {
    try { fs.unlinkSync(plan.file); } catch {}
    run.bytes -= plan.bytes; this.totalBytes -= plan.bytes; run.frames--;
  }
  commitFrame(run, packet, plan, kind = 'frame', state = run) {
    state.lastFrame = this.append(run, { kind, actor: 'broker', frameId: plan.frameId,
      sha256: createHash('sha256').update(packet.image).digest('hex'),
      bytes: packet.image.length, header: packet.header,
      ...(kind === 'recording-frame' ? { recording: packet.recording } : {}),
      brokerFrameVersion: packet.version, receivedAt: packet.receivedAt,
      receivedElapsedMs: packet.receivedMono === undefined ? this.elapsed(run) : Math.max(0, packet.receivedMono - run.monoStart) });
    return state.lastFrame;
  }
  reserveFrame(run, packet, force, state = run) {
    if (this.fault) throw new Error('recording_error');
    if (run.limitReached) return null;
    if (packet.version !== undefined && packet.version === state.lastVersion) return { event: state.lastFrame };
    const now = performance.now();
    if (!force && now - state.lastSample < this.policy.sampleMs) return null;
    if (run.frames >= this.policy.maxFrames || packet.image.length > this.policy.maxImageBytes ||
        this.elapsed(run) >= this.policy.maxDurationMs ||
        run.events.length >= this.policy.maxEvents - 12 ||
        run.journalBytes >= this.policy.maxJournalBytes - 65536 ||
        (run.inflight && (run.bytes + packet.image.length > this.policy.maxRunBytes - 65536 ||
          this.totalBytes + packet.image.length > this.policy.maxTotalBytes - 65536)) ||
        run.bytes + packet.image.length > this.policy.maxRunBytes - 16384 ||
        this.totalBytes + packet.image.length > this.policy.maxTotalBytes - 16384) {
      if (run.inflight) {
        run.limitReached = true;
        this.append(run, { kind: 'recording-limit', actor: 'broker', status: 'blocked', reason: 'recording_full' }, true);
        return null;
      }
      this.finish(run, 'blocked', 'recording_full');
      throw new Error('recording_full');
    }
    const frameId = opaque();
    run.bytes += packet.image.length;
    this.totalBytes += packet.image.length;
    run.frames++;
    state.lastSample = now;
    state.lastVersion = packet.version;
    state.lastFrameWork = null;
    return { frameId, file: path.join(run.dir, frameId + '.jpg'), bytes: packet.image.length };
  }
  elapsed(run) {
    return Math.max(run.events.at(-1)?.elapsedMs ?? 0, run.monoStart === undefined ? 0 : performance.now() - run.monoStart);
  }
  reserveStep(run) {
    if (this.fault) throw new Error('recording_error');
    if (run.events.length > this.policy.maxEvents - 16 || run.journalBytes > this.policy.maxJournalBytes - 65536 ||
        run.bytes > this.policy.maxRunBytes - 65536 || this.totalBytes > this.policy.maxTotalBytes - 65536 ||
        run.frames >= this.policy.maxFrames) {
      this.finish(run, 'blocked', 'recording_full');
      throw new Error('recording_full');
    }
    run.inflight = true;
  }
  endStep(run) {
    run.inflight = false;
    if (run.limitReached) this.finish(run, 'blocked', 'recording_full');
    else if (run.pendingEnd) this.finish(run, run.pendingEnd.status, run.pendingEnd.reason);
  }
  finish(run, status, reason) {
    if (run.events.at(-1)?.kind === 'run-end') return run.events.at(-1);
    return this.append(run, { kind: 'run-end', actor: 'broker', status, reason }, true);
  }
  get(id) {
    if (this.deletions.has(id)) throw new Error('deletion_pending');
    if (!isId(id) || !this.runs.has(id)) throw new Error('run_not_found');
    return this.runs.get(id);
  }
  history() {
    return [...this.runs.values()].filter(r => !this.deletions.has(r.id)).reverse().map(r => ({ runId: r.id, started: r.started,
      target: r.events[0]?.target ?? null, ...recordingName(r.events),
      labels: { ...r.events[0]?.labels, title: recordingName(r.events).title }, events: r.events.length,
      status: r.events.at(-1)?.kind === 'run-end' ? r.events.at(-1).status : this.fault ? 'blocked' : 'running' }));
  }
  image(id, frameId) { return this.readImage(id, frameId, 'frame'); }
  recordingImage(id, frameId) { return this.readImage(id, frameId, 'recording-frame'); }
  readImage(id, frameId, kind) {
    const r = this.get(id);
    if (!isId(frameId) || !r.events.some(e => e.kind === kind && e.frameId === frameId))
      throw new Error('frame_not_found');
    const file = path.join(r.dir, frameId + '.jpg');
    if (privateEntry(file).size > this.policy.maxImageBytes) throw new Error('invalid_frame');
    return fs.readFileSync(file);
  }
  deleteRun(id, exporter) {
    let intent = this.deletions.get(id);
    if (!intent) {
      const run = this.get(id);
      if (run.inflight || run.events.at(-1)?.kind !== 'run-end') throw new Error('run_active');
      exporter.requireIdle(id);
      intent = { version: 1, id, title: recordingName(run.events).title,
        started: run.started, source: ownedFiles(this.root, id, sourceName), exports: exporter.deletionFiles(id) };
      if (!sameFile(intent.source, run.dirIdentity)) throw new Error('unsafe_deletion_storage');
      const temporary = path.join(this.root, `delete-${id}.tmp`);
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(intent)); fs.fsyncSync(fd);
        fs.renameSync(temporary, path.join(this.root, `delete-${id}.json`));
        this.deletions.set(id, intent);
      } finally {
        const stat = fs.fstatSync(fd);
        fs.closeSync(fd);
        if (!this.deletions.has(id) && sameFile(privateEntry(temporary), stat)) fs.unlinkSync(temporary);
      }
      const root = directory(this.root);
      try { fs.fsyncSync(root.fd); } finally { fs.closeSync(root.fd); }
    }
    exporter.requireIdle(id);
    // Validate both ownership boundaries before touching either tree, including on recovery.
    ownedFiles(this.root, id, sourceName, intent.source);
    exporter.deletionFiles(id, intent.exports);
    try {
      exporter.removeFiles(id, intent.exports);
      ownedFiles(this.root, id, sourceName, intent.source, true);
      const file = path.join(this.root, `delete-${id}.json`);
      privateEntry(file);
      fs.unlinkSync(file);
      this.deletions.delete(id);
      this.runs.delete(id);
      // Both media trees are already fsynced. A resurrected intent only repeats bounded cleanup.
    } finally {
      const remaining = snapshotBytes(ownedFiles(this.root, id, sourceName, intent.source));
      const run = this.runs.get(id);
      if (run) run.bytes = remaining;
      this.totalBytes = [...this.runs.values()].reduce((sum, r) => sum + r.bytes, 0)
        + [...this.deletions.values()].filter(d => !this.runs.has(d.id))
          .reduce((sum, d) => sum + snapshotBytes(ownedFiles(this.root, d.id, sourceName, d.source)), 0);
    }
    return { runId: id, deleted: true };
  }
}

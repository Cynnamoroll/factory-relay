import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

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
      (directory ? !s.isDirectory() : !s.isFile())) throw new Error('unsafe_qa_storage');
  return s;
}

/** A private append-only journal. Only an incomplete final record is truncated on recovery. */
export class RunStore {
  constructor(root, policy = POLICY) {
    this.root = root;
    this.policy = policy;
    this.runs = new Map();
    this.totalBytes = 0;
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
      for (const id of fs.readdirSync(root)) {
        if (id === 'writer.lock') continue;
        if (id === 'exports') { privateEntry(path.join(root, id), true); continue; }
        if (!isId(id) || this.runs.size >= policy.maxRuns) throw new Error('unsafe_qa_storage');
        const dir = path.join(root, id);
        privateEntry(dir, true);
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
        const run = { id, dir, file, events, bytes, journalBytes: end, started: events[0]?.at ?? Date.now(),
          frames: events.filter(e => e.kind === 'frame').length, lastSample: 0 };
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
    const run = { id, dir, file: path.join(dir, 'events.jsonl'), events: [], bytes: 0, journalBytes: 0,
      started: Date.now(), monoStart: performance.now(), frames: 0, lastSample: -Infinity };
    fs.writeFileSync(run.file, '', { flag: 'wx', mode: 0o600 });
    this.runs.set(id, run);
    this.append(run, { kind: 'run-start', actor, status: 'running', target, labels,
      policy: this.policy, recording: '5 Hz background sampling plus action evidence; elapsed-time MP4; unknown gaps explicitly marked' });
    return run;
  }
  frame(run, packet, force = false) {
    if (this.fault) throw new Error('recording_error');
    if (run.limitReached) return null;
    if (packet.version !== undefined && packet.version === run.lastVersion) return run.lastFrame;
    const now = performance.now();
    if (!force && now - run.lastSample < this.policy.sampleMs) return null;
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
    try {
      const fd = fs.openSync(path.join(run.dir, frameId + '.jpg'), 'wx', 0o600);
      try { fs.writeFileSync(fd, packet.image); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } catch { this.fault = true; throw new Error('recording_error'); }
    run.bytes += packet.image.length;
    this.totalBytes += packet.image.length;
    run.frames++;
    run.lastSample = now;
    run.lastVersion = packet.version;
    run.lastFrame = this.append(run, { kind: 'frame', actor: 'broker', frameId,
      sha256: createHash('sha256').update(packet.image).digest('hex'),
      bytes: packet.image.length, header: packet.header,
      brokerFrameVersion: packet.version, receivedAt: packet.receivedAt,
      receivedElapsedMs: packet.receivedMono === undefined ? this.elapsed(run) : Math.max(0, packet.receivedMono - run.monoStart) });
    return run.lastFrame;
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
    if (!isId(id) || !this.runs.has(id)) throw new Error('run_not_found');
    return this.runs.get(id);
  }
  history() {
    return [...this.runs.values()].reverse().map(r => ({ runId: r.id, started: r.started,
      target: r.events[0]?.target ?? null, labels: r.events[0]?.labels ?? {}, events: r.events.length,
      status: r.events.at(-1)?.kind === 'run-end' ? r.events.at(-1).status : this.fault ? 'blocked' : 'running' }));
  }
  image(id, frameId) {
    const r = this.get(id);
    if (!isId(frameId) || !r.events.some(e => e.kind === 'frame' && e.frameId === frameId))
      throw new Error('frame_not_found');
    const file = path.join(r.dir, frameId + '.jpg');
    if (privateEntry(file).size > this.policy.maxImageBytes) throw new Error('invalid_frame');
    return fs.readFileSync(file);
  }
}

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isId, ownedFiles, snapshotBytes, sameFile } from './qa-store.js';
import { summarize } from './qa-contract.js';
import { qaEditPlan, QA_EDIT_POLICY, QA_EDIT_VERSION } from '../web/qa-edit.js';
import { CURSOR_VERSION } from '../web/action-cues.js';
import { cursorPresentation } from './qa-cursor-export.js';

const MiB = 1024 * 1024;
export const EXPORT_POLICY = Object.freeze({ maxBytes: 128 * MiB, totalBytes: 512 * MiB,
  timeoutMs: 120000, maxQueued: 4, gapAfterMs: 1000, width: 1280, height: 720 });
const baseNames = ['state.json', 'state.tmp', 'recording.mp4', 'poster.jpg', 'gap.jpg', 'frames.ffconcat', 'checks.srt', 'summary.json', 'cursor.ass'];
const names = new Set([...baseNames, ...baseNames.map(name => 'qa-' + name), ...baseNames.map(name => 'qa-v2-' + name),
  ...baseNames.map(name => 'qa-v3-' + name), ...baseNames.map(name => 'qa-v4-' + name), ...baseNames.map(name => 'qa-v5-' + name),
  ...baseNames.map(name => 'source-v1-' + name), ...baseNames.map(name => 'source-v2-' + name), 'qa-v2-video.filter',
  ...['kicker', 'title', 'status', 'expected', 'actual', 'context', 'footer'].map(name => `qa-v2-card-${name}.txt`),
  ...Array.from({ length: QA_EDIT_POLICY.maxClips }, (_, i) => ['intro', 'result'].map(kind => `qa-v2-card-${i}-${kind}.jpg`)).flat()]);
function variantName(name, variant) {
  if (!['source', 'qa'].includes(variant)) throw new Error('invalid_export_variant');
  return (variant === 'qa' ? 'qa-v5-' : 'source-v2-') + name;
}
const stateKey = (id, variant) => variant === 'qa' ? id + ':qa' : id;
function privateStat(file, directory = false) {
  const s = fs.lstatSync(file);
  if (s.isSymbolicLink() || s.uid !== process.getuid() || s.mode & 0o077 ||
      (directory ? !s.isDirectory() : !s.isFile() || s.nlink !== 1)) throw new Error('unsafe_export_storage');
  return s;
}
function put(file, data) {
  if (fs.existsSync(file)) privateStat(file);
  fs.writeFileSync(file, data, { mode: 0o600 });
}
export function mediaProcess(command, args, { cwd, timeout = EXPORT_POLICY.timeoutMs, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let size = 0, output = '', code;
    const stop = reason => { code = reason; child.kill('SIGKILL'); };
    const abort = () => stop('export_interrupted');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => stop('export_timeout'), timeout);
    child.on('error', () => { code = 'export_tool_unavailable'; });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      size += chunk.length;
      if (size > 65536) stop('export_output_limit');
      else if (stream === child.stdout) output += chunk;
    });
    child.on('close', status => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (code || status !== 0) reject(new Error(code ?? 'export_failed'));
      else resolve(output);
    });
  });
}

/** Receive-clock timing, not a made-up FPS. A held sample is limited to one second. */
export function recordingSegments(events, durationMs, gapAfterMs = EXPORT_POLICY.gapAfterMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > 690000) throw new Error('export_duration_limit');
  const segments = [];
  let time = 0, current = null;
  const addUntil = end => {
    end = Math.min(durationMs, Math.max(time, end));
    if (end <= time) return;
    const visibleUntil = current ? Math.max(time, Math.min(end, current.time + gapAfterMs)) : time;
    if (visibleUntil > time) segments.push({ startMs: time, endMs: visibleUntil, kind: 'frame', frameId: current.id });
    if (end > visibleUntil) segments.push({ startMs: visibleUntil, endMs: end, kind: 'gap', reason: 'No recorded footage' });
    time = end;
  };
  for (const e of events) {
    if (e.kind === 'frame') {
      const received = Math.max(time, Math.min(e.elapsedMs, e.receivedElapsedMs ?? e.elapsedMs));
      addUntil(received);
      current = { id: e.frameId, time: received };
    } else if (e.kind === 'gap') {
      addUntil(e.elapsedMs);
      current = null;
    } else if (e.kind === 'assertion' || e.kind === 'step-start' && e.operation === 'assert-count') addUntil(e.elapsedMs);
  }
  addUntil(durationMs);
  return segments;
}
/** Supplementary display pixels never replace the immutable selected-window evidence. */
export function humanRecordingSegments(events, durationMs, gapAfterMs = EXPORT_POLICY.gapAfterMs) {
  const window = recordingSegments(events, durationMs, gapAfterMs);
  if (!events.some(e => e.kind === 'recording-frame')) return window;
  let scope = null;
  const context = [];
  for (const e of events) {
    if (e.kind === 'recording-scope') {
      scope = e.scope === 'display' && e.reason === 'sole_window_session' ? e : null;
      context.push({ ...e, kind: 'gap' });
    } else if (e.kind === 'gap' || e.kind === 'ownership') {
      scope = null; context.push({ ...e, kind: 'gap' });
    } else if (e.kind === 'recording-frame' && scope && e.recording?.scopeId === scope.scopeId &&
        JSON.stringify(e.header.displayConfiguration) === JSON.stringify(scope.displayConfiguration) &&
        e.header.displayId === scope.target?.displayId && e.header.displayUUID === scope.target?.displayUUID) {
      context.push({ ...e, kind: 'frame', receivedElapsedMs: Math.max(scope.elapsedMs, e.receivedElapsedMs ?? e.elapsedMs) });
    }
  }
  const display = recordingSegments(context, durationMs, gapAfterMs);
  const cuts = [...new Set([...window, ...display].flatMap(s => [s.startMs, s.endMs]))].sort((a, b) => a - b);
  const result = [];
  let wi = 0, di = 0;
  for (let i = 0; i < cuts.length - 1; i++) {
    const startMs = cuts[i], endMs = cuts[i + 1];
    while (window[wi]?.endMs <= startMs) wi++;
    while (display[di]?.endMs <= startMs) di++;
    const selected = display[di]?.kind === 'frame' ? display[di] : window[wi];
    if (selected) result.push({ ...selected, startMs, endMs,
      recordingScope: display[di]?.kind === 'frame' ? 'display' : 'window' });
  }
  return result;
}
export function qaRecordingSegments(events, edit, gapAfterMs = EXPORT_POLICY.gapAfterMs) {
  const source = humanRecordingSegments(events, edit.sourceDurationMs, gapAfterMs);
  const frames = new Map(events.filter(e => ['frame', 'recording-frame'].includes(e.kind)).map(e => [e.frameId, e.receivedElapsedMs ?? e.elapsedMs]));
  const result = [], byInterval = new Map();
  for (const interval of edit.segments) {
    if (interval.kind === 'review-hold') continue;
    const pieces = [];
    byInterval.set(interval, pieces);
    for (const segment of source) {
      const start = Math.max(segment.startMs, interval.sourceStartMs), end = Math.min(segment.endMs, interval.sourceEndMs);
      if (end <= start) continue;
      const frameTime = frames.get(segment.frameId);
      const included = segment.kind === 'frame' &&
        // Display context retains its bounded source-sample hold, not an assertion's window frame ID.
        (segment.recordingScope === 'display' || frameTime >= interval.sourceStartMs && frameTime < interval.sourceEndMs ||
          segment.frameId === interval.beforeFrameId);
      const packet = { startMs: interval.startMs + start - interval.sourceStartMs, endMs: interval.startMs + end - interval.sourceStartMs,
        sourceStartMs: start, sourceEndMs: end, stepId: interval.stepId, role: interval.role,
        ...(included ? { kind: 'frame', frameId: segment.frameId, receivedSourceMs: frameTime, recordingScope: segment.recordingScope ?? 'window' }
          : { kind: 'gap', reason: 'No recorded footage inside this evidence interval' }) };
      result.push(packet); pieces.push(packet);
      if (result.length > QA_EDIT_POLICY.maxSegments) throw new Error('qa_segment_limit');
    }
  }
  return edit.segments.flatMap(interval => {
    // Keep interval identity; recomparing floating-point endpoints can drop packets.
    if (interval.kind !== 'review-hold') return byInterval.get(interval);
    const evidence = result.filter(s => s.stepId === interval.stepId);
    const assessed = interval.frameId && frames.has(interval.frameId) ? {
      kind: 'frame', frameId: interval.frameId, receivedSourceMs: frames.get(interval.frameId), recordingScope: 'window',
    } : null;
    const held = interval.role === 'check-opening' ? evidence[0] : assessed ?? evidence.at(-1);
    return [{ ...(held ?? { kind: 'gap', reason: 'No recorded frame available to review' }),
      startMs: interval.startMs, endMs: interval.endMs, stepId: interval.stepId, role: interval.role,
      sourceStartMs: undefined, sourceEndMs: undefined, reviewHold: true,
      review: interval }];
  });
}
export class Exporter {
  constructor(store, policy = EXPORT_POLICY) {
    this.store = store; this.policy = policy; this.root = path.join(store.root, 'exports');
    this.states = new Map(); this.queue = []; this.active = null;
    this.usage = new Map();
    this.directories = new Map();
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 }); privateStat(this.root, true);
    for (const id of store.deletions.keys()) store.deleteRun(id, this);
    for (const id of fs.readdirSync(this.root)) {
      if (!isId(id) || !store.runs.has(id)) throw new Error('unsafe_export_storage');
      const dir = path.join(this.root, id); this.directories.set(id, privateStat(dir, true));
      for (const name of fs.readdirSync(dir)) {
        if (!names.has(name)) throw new Error('unsafe_export_storage');
        privateStat(path.join(dir, name));
      }
      for (const variant of ['source', 'qa']) {
        const stateFile = path.join(dir, variantName('state.json', variant));
        if (!fs.readdirSync(dir).some(name => name.startsWith(variant === 'qa' ? 'qa-v5-' : 'source-v2-'))) continue;
        let state = { status: 'encoding' };
        if (fs.existsSync(stateFile)) {
          if (privateStat(stateFile).size > 8192) throw new Error('unsafe_export_storage');
          try { state = JSON.parse(fs.readFileSync(stateFile)); } catch {}
        }
        if (!['ready', 'error', 'queued', 'encoding'].includes(state.status)) throw new Error('unsafe_export_storage');
        if (state.status === 'ready' && (state.cursorVersion !== CURSOR_VERSION || variant === 'qa' && state.version !== QA_EDIT_VERSION))
          state = { status: 'not_requested', retrySafe: true, version: QA_EDIT_VERSION, cursorVersion: CURSOR_VERSION };
        this.states.set(stateKey(id, variant), state);
        if (['encoding', 'queued'].includes(state.status))
          this.save(id, { status: 'error', code: 'export_interrupted', retrySafe: true }, variant);
      }
    }
    if (this.bytes() > policy.totalBytes) throw new Error('export_storage_full');
  }
  bytes() {
    let total = 0;
    for (const id of fs.readdirSync(this.root)) {
      if (!isId(id)) throw new Error('unsafe_export_storage');
      privateStat(path.join(this.root, id), true);
      let bytes = 0;
      for (const name of fs.readdirSync(path.join(this.root, id))) {
        if (!names.has(name)) throw new Error('unsafe_export_storage');
        bytes += privateStat(path.join(this.root, id, name)).size;
      }
      this.usage.set(id, bytes);
      total += bytes;
    }
    return total;
  }
  requireIdle(id) {
    if (this.active?.id === id || this.queue.some(job => job.id === id) ||
        ['source', 'qa'].some(variant => ['queued', 'encoding'].includes(this.states.get(stateKey(id, variant))?.status)))
      throw new Error('export_busy');
  }
  deletionFiles(id, expected) {
    const files = ownedFiles(this.root, id, name => names.has(name), expected);
    if (expected === undefined && (files || this.directories.has(id)) && !sameFile(files, this.directories.get(id)))
      throw new Error('unsafe_deletion_storage');
    return files;
  }
  removeFiles(id, expected) {
    try { ownedFiles(this.root, id, name => names.has(name), expected, true); }
    finally { this.usage.set(id, snapshotBytes(this.deletionFiles(id, expected))); }
    this.states.delete(stateKey(id, 'source')); this.states.delete(stateKey(id, 'qa'));
    this.usage.delete(id);
    this.directories.delete(id);
  }
  usageBytes(id) {
    if (!this.usage.has(id) || this.active?.id === id) {
      const dir = path.join(this.root, id);
      let bytes = 0;
      try {
        privateStat(dir, true);
        for (const name of fs.readdirSync(dir)) {
          if (!names.has(name)) throw new Error('unsafe_export_storage');
          bytes += privateStat(path.join(dir, name)).size;
        }
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
      this.usage.set(id, bytes);
    }
    return this.usage.get(id);
  }
  state(id, variant = 'source') { variantName('', variant); this.store.get(id); return this.states.get(stateKey(id, variant)) ?? { status: 'not_requested', retrySafe: true, ...(variant === 'qa' ? { version: QA_EDIT_VERSION } : {}) }; }
  save(id, state, variant = 'source') {
    state = { ...state, cursorVersion: CURSOR_VERSION };
    if (variant === 'qa') state = { ...state, version: QA_EDIT_VERSION };
    const dir = path.join(this.root, id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = privateStat(dir, true);
    if (this.directories.has(id) && !sameFile(stat, this.directories.get(id))) throw new Error('unsafe_export_storage');
    this.directories.set(id, stat);
    const temporary = path.join(dir, variantName('state.tmp', variant));
    put(temporary, JSON.stringify(state) + '\n');
    const fd = fs.openSync(temporary, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const destination = path.join(dir, variantName('state.json', variant));
    if (fs.existsSync(destination)) privateStat(destination);
    fs.renameSync(temporary, destination);
    this.states.set(stateKey(id, variant), state);
    this.usage.delete(id);
  }
  request(id, retry = false, variant = 'source') {
    const r = this.store.get(id), prior = this.state(id, variant);
    if (r.events.at(-1)?.kind !== 'run-end') throw new Error('export_requires_finished_run');
    if (['ready', 'queued', 'encoding'].includes(prior.status) || prior.status === 'error' && !retry) return prior;
    const reject = code => {
      const state = { status: 'error', code, retrySafe: true };
      this.states.set(stateKey(id, variant), state);
      try { this.save(id, state, variant); } catch {}
      throw new Error(code);
    };
    if (this.queue.length >= this.policy.maxQueued || this.closing) reject('export_queue_full');
    if (this.bytes() + this.policy.maxBytes + 16 * MiB > this.policy.totalBytes) reject('export_storage_full');
    this.save(id, { status: 'queued', retrySafe: true }, variant);
    this.queue.push({ id, variant }); this.pump();
    return this.state(id, variant);
  }
  pump() {
    if (this.active || !this.queue.length || this.closing) return;
    const { id, variant } = this.queue.shift(), controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.policy.timeoutMs);
    const promise = this.encode(id, controller.signal, variant).catch(e => {
      const state = { status: 'error', code: /^[a-z_]+$/.test(e.message) ? e.message : 'export_failed', retrySafe: true };
      this.states.set(stateKey(id, variant), state);
      try { this.save(id, state, variant); } catch {}
    }).finally(() => { clearTimeout(timer); this.usage.delete(id); this.active = null; this.pump(); });
    this.active = { id, variant, promise, controller };
  }
  async encode(id, signal, variant = 'source') {
    if (this.bytes() + this.policy.maxBytes + 16 * MiB > this.policy.totalBytes) throw new Error('export_storage_full');
    this.save(id, { status: 'encoding', retrySafe: false }, variant);
    const r = this.store.get(id), summary = summarize(this.store, id);
    const edit = variant === 'qa' ? qaEditPlan(r.events, summary.durationMs) : null;
    if (edit && !edit.available) throw new Error('qa_edit_unavailable');
    if (edit && !edit.clips.length) throw new Error('qa_no_completed_checks');
    const durationMs = edit ? edit.durationMs : Math.max(100, summary.durationMs);
    const segments = edit ? qaRecordingSegments(r.events, edit, this.policy.gapAfterMs)
      : humanRecordingSegments(r.events, durationMs, this.policy.gapAfterMs);
    if (!edit && !segments.some(s => s.kind === 'frame')) throw new Error('export_no_frames');
    const dir = path.join(this.root, id), file = name => path.join(dir, variantName(name, variant));
    for (const e of r.events.filter(e => ['frame', 'recording-frame'].includes(e.kind))) {
      const bytes = e.kind === 'frame' ? this.store.image(id, e.frameId) : this.store.recordingImage(id, e.frameId);
      if (createHash('sha256').update(bytes).digest('hex') !== e.sha256) throw new Error('export_frame_integrity');
      await new Promise(resolve => setImmediate(resolve));
      if (signal.aborted) throw new Error('export_interrupted');
    }
    put(file('gap.jpg'), '');
    await mediaProcess('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x101318:s=1280x720',
      '-frames:v', '1', '-threads', '2', file('gap.jpg')], { signal });
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    const manifest = ['ffconcat version 1.0'];
    const presentation = cursorPresentation(r.events, segments, durationMs);
    put(file('cursor.ass'), presentation.ass);
    const packets = presentation.packets, last = packets.at(-1);
    // MP4 needs a final packet inside the cut, not a sentinel excluded by -t.
    if (last.endMs - last.startMs > 1) packets.splice(-1, 1,
      { ...last, endMs: last.endMs - 1 }, { ...last, startMs: last.endMs - 1 });
    for (const s of packets) {
      manifest.push(`file ${quote(s.kind === 'gap' ? file('gap.jpg') : path.join(r.dir, s.frameId + '.jpg'))}`,
        'option framerate 1000', `duration ${((s.endMs - s.startMs) / 1000).toFixed(6)}`);
    }
    manifest.push(`file ${quote(file('gap.jpg'))}`, 'option framerate 1000');
    put(file('frames.ffconcat'), manifest.join('\n') + '\n');
    put(file('recording.mp4'), '');
    const start = performance.now();
    const filter = 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=0x101318,setsar=1'
      + (presentation.ass.includes('Dialogue:') ? `,subtitles=${variantName('cursor.ass', variant)}` : '');
    await mediaProcess('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-threads', '2', '-filter_threads', '2',
      '-f', 'concat', '-safe', '0', '-i', variantName('frames.ffconcat', variant), '-an',
      '-vf', filter,
      // B-frame reordering gives incorrect MP4 duration for sparse VFR final packets.
      '-c:v', 'libx264', '-bf', '0', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-threads', '2',
      '-fps_mode', 'vfr', '-enc_time_base', '1:1000', '-video_track_timescale', '1000',
      '-t', (durationMs / 1000).toFixed(6), '-fs', String(this.policy.maxBytes),
      '-metadata', `title=${summary.title}`, '-movflags', '+faststart', variantName('recording.mp4', variant)],
    { cwd: dir, signal, timeout: this.policy.timeoutMs });
    const probe = JSON.parse(await mediaProcess('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size',
      '-of', 'json', file('recording.mp4')], { timeout: 10000, signal }));
    const duration = Number(probe.format.duration);
    if (!Number.isFinite(duration) || !Number.isSafeInteger(Number(probe.format.size)) || Number(probe.format.size) <= 0 ||
        Math.abs(duration * 1000 - durationMs) > 100 || Number(probe.format.size) >= this.policy.maxBytes)
      throw new Error('export_duration_or_size_mismatch');
    const posterPacket = packets.find(s => !s.reviewHold && s.kind === 'frame' && presentation.cues.some(c =>
      c.startMs <= (s.sourceStartMs ?? s.startMs) && (s.sourceStartMs ?? s.startMs) < c.endMs)) ?? packets.find(s => s.kind === 'frame');
    put(file('poster.jpg'), '');
    await mediaProcess('ffmpeg', ['-v', 'error', '-y', '-i', file('recording.mp4'),
      '-ss', ((posterPacket?.startMs ?? 0) / 1000).toFixed(6), '-frames:v', '1', '-threads', '2', file('poster.jpg')], { signal });
    const evidence = { ...summary, durationMs, sourceDurationMs: summary.durationMs, ...(edit ? { edit } : {}), segments,
      recordingScopes: r.events.filter(e => e.kind === 'recording-scope'),
      recordingFrames: r.events.filter(e => e.kind === 'recording-frame').map(e => ({
        frameId: e.frameId, sha256: e.sha256, header: e.header, recording: e.recording,
        receivedElapsedMs: e.receivedElapsedMs, recordedElapsedMs: e.elapsedMs })),
      cursor: { version: CURSOR_VERSION, synthetic: true, interpolation: 'Visualization, not captured physical movement',
        acknowledgement: 'Native ACK is not an assertion', cues: presentation.cues }, encoding: {
      codec: 'H.264', timing: edit ? 'Review holds are separate from receive-clock evidence; missing footage remains blank' : 'variable presentation timestamps from monotonic broker receive elapsed time',
      gapAfterMs: this.policy.gapAfterMs, sourceCadence: '5 Hz background sampling plus action evidence; only actually received frames',
      measuredEncodeMs: Math.round(performance.now() - start), measuredDurationSeconds: duration,
    }, sourceFrames: r.events.filter(e => e.kind === 'frame').map(e => ({
      frameId: e.frameId, sha256: e.sha256, captureTimeSeconds: e.header.captureTimeSeconds,
      receivedAt: e.receivedAt, receivedElapsedMs: e.receivedElapsedMs, recordedElapsedMs: e.elapsedMs,
    })) };
    put(file('summary.json'), JSON.stringify(evidence, null, 2));
    if (this.bytes() > this.policy.totalBytes) throw new Error('export_storage_full');
    this.save(id, { status: 'ready', retrySafe: true, durationMs, bytes: privateStat(file('recording.mp4')).size,
      encodedAt: Date.now(), measuredEncodeMs: evidence.encoding.measuredEncodeMs }, variant);
  }
  artifact(id, name) {
    const variant = name.startsWith('qa-') ? 'qa' : 'source';
    if (!['recording.mp4', 'poster.jpg', 'summary.json'].map(n => variant === 'qa' ? variantName(n, variant) : n).includes(name) || this.state(id, variant).status !== 'ready')
      throw new Error('export_not_ready');
    const file = path.join(this.root, id, variant === 'qa' ? name : variantName(name, variant));
    const info = privateStat(file);
    if (info.size > this.policy.maxBytes) throw new Error('export_size_limit');
    return { file, size: info.size };
  }
  async wait(id, ms, variant = 'source') {
    const end = performance.now() + ms;
    while (['encoding', 'queued'].includes(this.state(id, variant).status) && performance.now() < end)
      await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, end - performance.now()))));
    return this.state(id, variant);
  }
  async close() {
    this.closing = true;
    for (const { id, variant } of this.queue) {
      const state = { status: 'error', code: 'export_interrupted', retrySafe: true };
      this.states.set(stateKey(id, variant), state);
      try { this.save(id, state, variant); } catch {}
    }
    this.queue = [];
    if (this.active) { this.active.controller.abort(); await this.active.promise; }
  }
}

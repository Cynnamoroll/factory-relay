import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { failure, tasks } from './qa-contract.js';
import { sameTarget } from './window-target.js';
import { readTask } from './qa-tasks.js';
import { recordingName, recordingDisposition } from '../web/recording-name.js';
import { isWindowRecording } from './qa-window-sessions.js';
import { windowSessionCleanupErrors, windowSessionFailure, windowSessionPath, windowSessionTaskPath } from './qa-window-session-contract.js';

const secret = () => randomBytes(32).toString('hex');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' &&
  Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const web = fileURLToPath(new URL('../web/', import.meta.url));
const safeError = e => /^[a-z_]{1,64}$/.test(e.message) ? e.message : 'request_failed';
const errorStatus = e => ['run_not_found', 'frame_not_found', 'export_not_ready'].includes(e.message) ? 404
  : ['run_active', 'export_busy', 'deletion_pending'].includes(e.message) ? 409 : 400;

export const MAX_LIVE_VIEWERS = 4;
/**
 * One authenticated push stream per viewer, interleaving H.264 access units (vframe) with JPEG
 * snapshots (frame). Each packet is a 4-byte big-endian header length, a JSON header and the
 * payload bytes. A viewer whose socket is not drained keeps only the newest JPEG and a short
 * in-order run of access units, so a slow browser drops frames instead of buffering or delaying
 * the capture consumer. A viewer joining
 * mid-stream gets the most recent keyframe access unit plus the newest JPEG immediately, then
 * waits for the next live keyframe (at most two seconds away) before any non-key access unit,
 * so the browser decoder never sees a delta without its reference frames.
 */
const MAX_PENDING_VIDEO = 4;
function liveViewer(res, broker, { allowed = () => true, signal } = {}) {
  let pending = null, pendingCue = null, waiting = false, sent = 0, dropped = 0, lastWrite = performance.now();
  let needKeyframe = true, lastVideoSequence = null, closed = false;
  // Access units depend on their predecessors, so a slow viewer queues them in order. Overflow
  // drops the whole backlog and waits for the next keyframe instead of skipping a reference.
  const pendingVideo = [];
  const write = item => {
    const image = item?.image ?? Buffer.alloc(0);
    const header = Buffer.from(JSON.stringify(!item
      ? { type: 'heartbeat', bytes: 0, sent, dropped }
      : item.header?.type === 'cue' ? { ...item.header,
        sourceMs: item.header.sourceMs + Math.max(0, performance.now() - item.cueQueuedAt), bytes: 0 }
      : item.header?.type === 'vframe'
        ? { type: 'vframe', sequence: item.header.sequence, keyframe: item.header.keyframe === true,
          captureTimeSeconds: item.header.captureTimeSeconds ?? null,
          width: item.header.width ?? null, height: item.header.height ?? null,
          bytes: image.length, sent: ++sent, dropped }
        : { type: 'frame', version: item.version, receivedAt: item.receivedAt,
          captureGeometry: item.header,
          sequence: item.header.sequence ?? null, captureTimeSeconds: item.header.captureTimeSeconds ?? null,
          bytes: image.length, sent: ++sent, dropped }));
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(header.length);
    lastWrite = performance.now();
    return res.write(Buffer.concat([prefix, header, image]));
  };
  const offer = item => {
    if (!allowed()) return end();
    if (!waiting) { if (!write(item)) waiting = true; return; }
    if (item?.header?.type === 'cue') { pendingCue = item; return; }
    if (item?.header?.type !== 'vframe') { if (pending) dropped++; pending = item; return; }
    if (item.header.keyframe) { dropped += pendingVideo.length; pendingVideo.length = 0; }
    else if (pendingVideo.length >= MAX_PENDING_VIDEO) {
      dropped += pendingVideo.length + 1; pendingVideo.length = 0; needKeyframe = true; return;
    }
    pendingVideo.push(item);
  };
  const push = item => {
    if (item?.header?.type === 'cue') item = { ...item, cueQueuedAt: performance.now() };
    if (item?.header?.type === 'vframe') {
      // A restarted stream (broker reconnect) begins its sequence over; deltas from it may not
      // reference frames this viewer decoded, so it joins again at the next keyframe.
      if (lastVideoSequence !== null && item.header.sequence <= lastVideoSequence) needKeyframe = true;
      lastVideoSequence = item.header.sequence;
      if (needKeyframe) {
        if (!item.header.keyframe) { dropped++; return; }
        needKeyframe = false;
      }
    }
    offer(item);
  };
  const drain = () => {
    if (!allowed()) return end();
    waiting = false;
    if (pendingCue) { const next = pendingCue; pendingCue = null; if (!write(next)) waiting = true; }
    while (!waiting && pendingVideo.length) if (!write(pendingVideo.shift())) waiting = true;
    if (!waiting && pending) { const next = pending; pending = null; if (!write(next)) waiting = true; }
  };
  const heartbeat = setInterval(() => {
    if (!allowed()) end();
    else if (!waiting && performance.now() - lastWrite > 4000) offer(null);
  }, 1000);
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    pending = pendingCue = null; pendingVideo.length = 0;
    broker.viewers.delete(push);
    res.off('drain', drain);
    signal?.removeEventListener('abort', end);
  };
  const end = () => { if (!closed) { cleanup(); res.end(); } };
  res.on('drain', drain);
  broker.viewers.add(push);
  res.once('close', cleanup);
  signal?.addEventListener('abort', end, { once: true });
  // The cached keyframe decodes instantly but is not a join point: needKeyframe stays set until
  // the first live keyframe arrives, keeping every delivered access unit decodable in order.
  if (broker.latestKeyframe) offer(broker.latestKeyframe);
  if (broker.latest) offer(broker.latest);
}

export function createQAServer(broker, { agentToken = secret(), pairingCode = secret(), windowSessions, onWindowRun } = {}) {
  let origin, host, paired = false, session = null, attempts = 0, reset = Date.now(), inflight = 0;
  const confirmations = new Map();
  const assets = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/live-video.js', ['live-video.js', 'text/javascript; charset=utf-8']],
    ['/replay-entry.js', ['replay-entry.js', 'text/javascript; charset=utf-8']],
    ['/qa-edit.js', ['qa-edit.js', 'text/javascript; charset=utf-8']],
    ['/action-cues.js', ['action-cues.js', 'text/javascript; charset=utf-8']],
    ['/target-identity.js', ['target-identity.js', 'text/javascript; charset=utf-8']],
    ['/recording-name.js', ['recording-name.js', 'text/javascript; charset=utf-8']],
    ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ]);
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    res.setTimeout(req.method === 'POST' ? 90000 : 15000, () => res.destroy());
    const send = (code, body, type = 'application/json') => {
      if (res.destroyed) return;
      res.writeHead(code, { 'Content-Type': type });
      res.end(type === 'application/json' ? JSON.stringify(body) : body);
    };
    const liveImage = (selected, missing = 409) => {
      if (!selected.latest) return send(missing, { error: 'no_live_frame' });
      res.setHeader('X-QA-Frame-Version', selected.latest.version);
      res.setHeader('X-QA-Frame-Received-At', selected.latest.receivedAt);
      return send(200, selected.latest.image, 'image/jpeg');
    };
    const liveStream = (selected, options) => {
      if (selected.viewers.size >= MAX_LIVE_VIEWERS) return send(503, { error: 'viewer_limit' });
      res.setTimeout(0);
      res.writeHead(200, { 'Content-Type': 'application/x-qa-frames' });
      res.flushHeaders();
      return liveViewer(res, selected, options);
    };
    if (++inflight > 24) { inflight--; return send(503, { error: 'request_limit' }); }
    let finished = false;
    const finish = () => { if (!finished) { finished = true; inflight--; } };
    res.once('close', finish);
    res.once('finish', finish);
    try {
      if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== origin))
        return send(403, { error: 'origin_rejected' });
      if (req.method === 'GET' && assets.has(req.url)) {
        const [name, type] = assets.get(req.url);
        return send(200, fs.readFileSync(path.join(web, name)), type);
      }
      if (['cross-site', 'same-site'].includes(req.headers['sec-fetch-site'])) return send(403, { error: 'origin_rejected' });
      const artifact = req.url.match(/^\/api\/runs\/([a-f0-9]{32})\/((?:qa-(?:v[234]-)?)?recording\.mp4|(?:qa-(?:v[234]-)?)?poster\.jpg|(?:qa-(?:v[234]-)?)?summary\.json)$/);
      const windowMedia = req.url.match(/^\/api\/window-overview\/([a-f0-9]{32})\/(frame|stream)$/);
      const directMedia = req.method === 'GET' && (artifact || windowMedia) && req.headers['sec-fetch-site'] === 'same-origin';
      if (req.headers['x-qa-request'] !== '1' && !directMedia) return send(403, { error: 'csrf_rejected' });
      const body = async () => {
        if (req.headers['content-type'] !== 'application/json') throw new Error('json_required');
        if (Number(req.headers['content-length']) > 8192) throw new Error('request_too_large');
        let bytes = 0, chunks = [];
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 8192) throw new Error('request_too_large');
          chunks.push(chunk);
        }
        try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { throw new Error('invalid_json'); }
      };
      if (req.url === windowSessionPath || req.url.startsWith(windowSessionPath + '/')) {
        if (!windowSessions) return send(404, { error: 'not_found' });
        if (req.url === windowSessionPath && req.method === 'POST') {
          if (!equal(req.headers.authorization, 'Bearer ' + agentToken))
            return send(401, { error: 'authentication_required' });
          const disconnected = new AbortController();
          res.once('close', () => { if (!res.writableFinished) disconnected.abort(); });
          let result;
          try { result = await windowSessions.open(await body(), origin, { signal: disconnected.signal }); }
          catch (e) {
            return send(e.message === 'lease_held' ? 409 : e.message === 'session_limit' ? 503 : errorStatus(e),
              { error: safeError(e), ...(windowSessionCleanupErrors.includes(e.message) && { failure: windowSessionFailure(e, 'qa_start') }) });
          }
          const entry = windowSessions.authenticate('Bearer ' + result.token);
          if (!entry) return send(401, { error: 'authentication_required' });
          if (res.destroyed) { await windowSessions.closeEntry(entry); return; }
          res.once('close', () => {
            if (!res.writableFinished) windowSessions.closeEntry(entry).catch(() => {});
          });
          if (!paired) onWindowRun?.(entry.target);
          return send(201, result);
        }
        const entry = windowSessions.authenticate(req.headers.authorization);
        if (!entry) return send(401, { error: 'authentication_required' });
        if (req.url === windowSessionPath + '/current/live' && req.method === 'GET') {
          if (!windowSessions.liveEntry(entry.runId)) return send(409, { error: 'no_live_frame' });
          return liveImage(entry.broker);
        }
        if (req.url === windowSessionPath + '/current' && req.method === 'DELETE') {
          try { await windowSessions.closeEntry(entry); }
          catch (e) { return send(errorStatus(e), { error: safeError(e), failure: windowSessionFailure(e) }); }
          return send(200, { closed: true });
        }
        const name = req.url.startsWith(windowSessionTaskPath) && req.url.slice(windowSessionTaskPath.length);
        if (req.method === 'POST' && /^qa_[a-z]+$/.test(name || '')) {
          try { return send(200, await windowSessions.task(entry, name, await body())); }
          catch (e) { return send(errorStatus(e), { error: safeError(e), failure: windowSessionFailure(e, name) }); }
        }
        return send(404, { error: 'not_found' });
      }
      if (req.url === '/session' && req.method === 'POST') {
        if (req.headers.origin !== origin) return send(403, { error: 'origin_required' });
        if (Date.now() - reset > 60000) { attempts = 0; reset = Date.now(); }
        if (++attempts > 16) return send(429, { error: 'pairing_rate_limit' });
        const input = await body();
        if (paired || !equal(input?.code, pairingCode)) return send(401, { error: 'pairing_rejected' });
        paired = true;
        session = { token: secret(), csrf: secret(), expires: Date.now() + 8 * 3600000 };
        res.setHeader('Set-Cookie', `qa_session_${server.address().port}=${session.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
        return send(200, { csrf: session.csrf });
      }
      let actor;
      if (equal(req.headers.authorization, 'Bearer ' + agentToken)) actor = 'agent';
      else {
        const prefix = `qa_session_${server.address().port}=`;
        const cookie = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith(prefix))?.slice(prefix.length);
        if (!session || Date.now() > session.expires || !equal(cookie, session.token))
          return send(401, { error: 'authentication_required' });
        if (req.method !== 'GET' && (!equal(req.headers['x-qa-csrf'], session.csrf) || req.headers.origin !== origin))
          return send(403, { error: 'csrf_rejected' });
        actor = 'human';
      }
      const hidden = id => actor === 'agent' && windowSessions && isWindowRecording(broker.store.runs.get(id));
      const history = () => broker.store.history().filter(run => !hidden(run.runId));
      if (req.method === 'GET') {
        if (req.url === '/api/window-overview' || windowMedia) {
          if (actor !== 'human') return send(403, { error: 'human_session_required' });
          if (!windowMedia) return send(200, { sessions: windowSessions?.overview() ?? [] });
          const entry = windowSessions?.liveEntry(windowMedia[1]);
          if (!entry) return send(404, { error: 'run_not_found' });
          if (windowMedia[2] === 'frame') return liveImage(entry.broker, 404);
          return liveStream(entry.broker, { signal: entry.live.signal,
            allowed: () => Date.now() <= session.expires && windowSessions.liveEntry(entry.runId) === entry });
        }
        if (artifact) {
          if (hidden(artifact[1])) return send(404, { error: 'run_not_found' });
          const { file, size } = broker.exports.artifact(artifact[1], artifact[2]);
          let start = 0, end = size - 1, status = 200;
          if (req.headers.range) {
            const range = req.headers.range.match(/^bytes=(\d*)-(\d*)$/);
            if (!range || (!range[1] && !range[2])) {
              res.setHeader('Content-Range', `bytes */${size}`); return send(416, { error: 'invalid_range' });
            }
            if (!range[1]) start = Math.max(0, size - Number(range[2]));
            else { start = Number(range[1]); if (range[2]) end = Math.min(end, Number(range[2])); }
            if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
              res.setHeader('Content-Range', `bytes */${size}`); return send(416, { error: 'invalid_range' });
            }
            status = 206;
            res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
          }
          res.writeHead(status, { 'Content-Type': artifact[2].endsWith('.mp4') ? 'video/mp4' : artifact[2].endsWith('.jpg') ? 'image/jpeg' : 'application/json',
            'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1,
            'Content-Disposition': recordingDisposition(recordingName(broker.store.get(artifact[1]).events).title, artifact[1], artifact[2]) });
          const stream = fs.createReadStream(file, { start, end, highWaterMark: 65536 });
          res.once('close', () => stream.destroy());
          stream.on('error', () => res.destroy());
          return stream.pipe(res);
        }
        if (req.url === '/api/session') return send(200, { actor, ...(actor === 'human' ? { csrf: session.csrf } : {}) });
        if (req.url === '/api/status') return send(200, broker.status());
        if (req.url === '/api/recordings') {
          const data = await broker.recordings();
          const runs = data.runs.filter(run => !hidden(run.runId));
          return send(200, { ...data, total: runs.length, runs });
        }
        if (req.url === '/api/runs') return send(200, history());
        if (req.url === '/api/live/stream') {
          const id = req.headers['x-qa-live-run'];
          const authenticated = () => actor === 'agent' || Date.now() <= session.expires;
          if (id === undefined) return liveStream(broker, { allowed: authenticated });
          const run = broker.current(), stream = broker.stream, lease = broker.lease;
          const target = run?.events[0]?.target, started = run?.events[0]?.labels?.processStartedAt;
          const allowed = () => authenticated() && run?.id === id && broker.current() === run &&
            sameTarget(broker.target, target) && (started === undefined || Number(started) === broker.targetProcessStartedAt) &&
            stream && !stream.abort.signal.aborted && broker.stream === stream && lease && broker.lease === lease &&
            broker.owner && broker.connection === 'live';
          if (!allowed()) return send(409, { error: 'run_not_live' });
          res.setHeader('X-QA-Live-Run', id);
          return liveStream(broker, { allowed, signal: stream.abort.signal });
        }
        if (req.url === '/api/live') return liveImage(broker);
        const match = req.url.match(/^\/api\/runs\/([a-f0-9]{32})(?:\/frames\/([a-f0-9]{32}))?$/);
        if (match) {
          if (hidden(match[1])) return send(404, { error: 'run_not_found' });
          return match[2] ? send(200, broker.store.image(match[1], match[2]), 'image/jpeg')
            : send(200, broker.store.get(match[1]).events);
        }
      }
      const deletion = req.url.match(/^\/api\/recordings\/([a-f0-9]{32})\/(confirm-delete|delete)$/);
      if (req.method === 'POST' && deletion) {
        if (actor !== 'human') return send(403, { error: 'human_confirmation_required' });
        const input = await body(), id = deletion[1];
        if (broker.store.runs.get(id)?.pendingWrites > 0) throw new Error('run_active');
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_arguments');
        if (deletion[2] === 'confirm-delete') {
          if (Object.keys(input).length) throw new Error('invalid_arguments');
          const info = await broker.enqueue(() => broker.deletionInfo(id));
          if (info.reason) throw new Error(info.reason);
          for (const [token, value] of confirmations) if (value.expires < Date.now()) confirmations.delete(token);
          if (confirmations.size >= 128) throw new Error('confirmation_limit');
          const confirmation = secret();
          confirmations.set(confirmation, { id, expires: Date.now() + 600000, deleted: false });
          return send(200, { runId: id, title: info.title, confirmation });
        }
        if (Object.keys(input).length !== 1 || typeof input.confirmation !== 'string') throw new Error('invalid_arguments');
        const confirmed = confirmations.get(input.confirmation);
        if (!confirmed || confirmed.id !== id || confirmed.expires < Date.now())
          return send(403, { error: 'human_confirmation_required' });
        if (!confirmed.deleted) {
          confirmed.work ??= broker.deleteRecording(actor, id).then(() => { confirmed.deleted = true; })
            .finally(() => { delete confirmed.work; });
          await confirmed.work;
        }
        return send(200, { runId: id, deleted: true });
      }
      if (req.method === 'POST' && req.url === '/api/command')
        return send(200, await broker.command(actor, await body()));
      const task = req.url.match(/^\/api\/tasks\/(qa_[a-z]+)$/);
      if (req.method === 'POST' && task) {
        try {
          const input = await body();
          if (hidden(input?.runId) || hidden(input?.resumeRunId)) throw new Error('run_not_found');
          if (task[1] === 'qa_runs' && actor === 'agent' && windowSessions) {
            const page = tasks.qa_runs.safeParse(input);
            if (!page.success) throw new Error('invalid_arguments');
            const store = { history, get: id => broker.store.get(id), fault: broker.store.fault };
            return send(200, await readTask({ store, exports: broker.exports, origin }, task[1], page.data));
          }
          const result = await broker.task(actor, task[1], input);
          if (task[1] === 'qa_start' && !paired && result.target?.windowId) onWindowRun?.(result.target);
          return send(200, result);
        }
        catch (e) { return send(errorStatus(e), { error: safeError(e), failure: failure(e, task[1], actor) }); }
      }
      return send(404, { error: 'not_found' });
    } catch (e) { if (!res.headersSent) send(errorStatus(e), { error: safeError(e) }); else res.destroy(); }
  });
  server.maxConnections = 32;
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 2000;
  server.maxRequestsPerSocket = 100;
  return {
    server, agentToken, pairingCode,
    listen: (port = 43180) => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        host = `127.0.0.1:${server.address().port}`;
        origin = `http://${host}`;
        broker.origin = origin;
        resolve(origin);
      });
    }),
    close: async () => {
      const stopped = new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      await Promise.all([stopped, windowSessions?.close()]);
    },
  };
}

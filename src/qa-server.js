import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { failure } from './qa-contract.js';

const secret = () => randomBytes(32).toString('hex');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' &&
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const web = fileURLToPath(new URL('../web/', import.meta.url));
const safeError = e => /^[a-z_]{1,64}$/.test(e.message) ? e.message : 'request_failed';

export function createQAServer(broker, { agentToken = secret(), pairingCode = secret() } = {}) {
  let origin, host, paired = false, session = null, attempts = 0, reset = Date.now(), inflight = 0;
  const assets = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/replay-entry.js', ['replay-entry.js', 'text/javascript; charset=utf-8']],
    ['/qa-edit.js', ['qa-edit.js', 'text/javascript; charset=utf-8']],
    ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ]);
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    res.setTimeout(req.method === 'POST' ? 90000 : 15000, () => res.destroy());
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'Content-Type': type });
      res.end(type === 'application/json' ? JSON.stringify(body) : body);
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
      const artifact = req.url.match(/^\/api\/runs\/([a-f0-9]{32})\/((?:qa-(?:v[23]-)?)?recording\.mp4|(?:qa-(?:v[23]-)?)?poster\.jpg|(?:qa-(?:v[23]-)?)?summary\.json)$/);
      const directMedia = req.method === 'GET' && artifact && req.headers['sec-fetch-site'] === 'same-origin';
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
      if (req.url === '/session' && req.method === 'POST') {
        if (req.headers.origin !== origin) return send(403, { error: 'origin_required' });
        if (Date.now() - reset > 60000) { attempts = 0; reset = Date.now(); }
        if (++attempts > 16) return send(429, { error: 'pairing_rate_limit' });
        const input = await body();
        if (paired || !equal(input?.code, pairingCode)) return send(401, { error: 'pairing_rejected' });
        paired = true;
        session = { token: secret(), csrf: secret(), expires: Date.now() + 8 * 3600000 };
        res.setHeader('Set-Cookie', `qa_session=${session.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
        return send(200, { csrf: session.csrf });
      }
      let actor;
      if (equal(req.headers.authorization, 'Bearer ' + agentToken)) actor = 'agent';
      else {
        const cookie = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('qa_session='))?.slice(11);
        if (!session || Date.now() > session.expires || !equal(cookie, session.token))
          return send(401, { error: 'authentication_required' });
        if (req.method !== 'GET' && (!equal(req.headers['x-qa-csrf'], session.csrf) || req.headers.origin !== origin))
          return send(403, { error: 'csrf_rejected' });
        actor = 'human';
      }
      if (req.method === 'GET') {
        if (artifact) {
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
            'Content-Disposition': `inline; filename="qa-${artifact[1]}-${artifact[2]}"` });
          const stream = fs.createReadStream(file, { start, end, highWaterMark: 65536 });
          res.once('close', () => stream.destroy());
          stream.on('error', () => res.destroy());
          return stream.pipe(res);
        }
        if (req.url === '/api/session') return send(200, { actor, ...(actor === 'human' ? { csrf: session.csrf } : {}) });
        if (req.url === '/api/status') return send(200, broker.status());
        if (req.url === '/api/runs') return send(200, broker.store.history());
        if (req.url === '/api/live') {
          if (!broker.latest) return send(409, { error: 'no_live_frame' });
          res.setHeader('X-QA-Frame-Version', broker.latest.version);
          res.setHeader('X-QA-Frame-Received-At', broker.latest.receivedAt);
          return send(200, broker.latest.image, 'image/jpeg');
        }
        const match = req.url.match(/^\/api\/runs\/([a-f0-9]{32})(?:\/frames\/([a-f0-9]{32}))?$/);
        if (match) return match[2]
          ? send(200, broker.store.image(match[1], match[2]), 'image/jpeg')
          : send(200, broker.store.get(match[1]).events);
      }
      if (req.method === 'POST' && req.url === '/api/command')
        return send(200, await broker.command(actor, await body()));
      const task = req.url.match(/^\/api\/tasks\/(qa_[a-z]+)$/);
      if (req.method === 'POST' && task) {
        try { return send(200, await broker.task(actor, task[1], await body())); }
        catch (e) { return send(400, { error: safeError(e), failure: failure(e, task[1], actor) }); }
      }
      return send(404, { error: 'not_found' });
    } catch (e) { if (!res.headersSent) send(400, { error: safeError(e) }); else res.destroy(); }
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
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }),
  };
}

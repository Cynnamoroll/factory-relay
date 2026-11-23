import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Broker } from '../src/qa-broker.js';
import { QAClient } from '../src/qa-client.js';
import { clickAndCheckText, clickAndCheckTextSchema } from '../src/qa-procedure.js';
import { createQAServer } from '../src/qa-server.js';
import { opaque, RunStore } from '../src/qa-store.js';
import { WindowSessions } from '../src/qa-window-sessions.js';

const target = { windowId: 32, pid: 42, bundleId: 'org.example.fixture' }, processStartedAt = 123;
const rect = [0, 0, 640, 360];
const input = { title: 'Open detail', beforeText: 'Library View', expectedText: 'Detail Page', x: 0.3, y: 0.6 };
const mouse = { kind: 'click', button: 'left', count: 1, x: input.x, y: input.y };
const ocr = { skip: !fs.existsSync('/usr/bin/tesseract') && 'local English Tesseract is optional' };
const cache = new Map();
function jpeg(...lines) {
  const key = JSON.stringify(lines);
  if (!cache.has(key)) {
    const draw = lines.map((text, i) => `drawtext=font=DejaVu Sans:text=${text}:fontsize=40:x=40:y=${40 + 76 * i}:fontcolor=black`);
    cache.set(key, execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i',
      ['color=c=white:s=640x360', ...draw].join(','), '-frames:v', '1', '-threads', '1', '-f', 'mjpeg', 'pipe:1']));
  }
  return cache.get(key);
}

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-click-check-'));
  const state = { clicks: [], frame: jpeg('Library View', 'Unrelated label'), next: jpeg('Detail Page', 'Unrelated label') };
  const native = () => {
    let authority;
    return {
      acquire: async (takeover, ttl, scope) => {
        assert.deepEqual(scope, { kind: 'window', target });
        assert.equal(takeover, false);
        return { token: 'f'.repeat(64), generation: 1 };
      },
      release: async () => {},
      windows: async () => [{ ...target, processStartedAt }],
      stream: async (proof, selected, signal, consume) => {
        assert.deepEqual(selected, target);
        let sequence = 0;
        const emit = () => consume({ image: state.frame, header: { type: 'frame', ...target, processStartedAt,
          sequence: ++sequence, width: 640, height: 360, contentScale: 1, scaleFactor: 1,
          contentRectPixels: rect, initialWindowRectPoints: rect, captureTimeSeconds: 10, sentUptimeSeconds: 10.01 } });
        emit();
        const timer = setInterval(emit, 30);
        try { await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); }
        finally { clearInterval(timer); }
      },
      observe: async (proof, selected, mode) => {
        assert.deepEqual(selected, target);
        assert.equal(mode, 'pixels');
        authority = opaque();
        return { observationId: authority, expiresAt: Date.now() / 1000 + 30, snapshot: { target, elements: [],
          processStartedAt: state.replaced && state.clicks.length ? 456 : processStartedAt, windowRectPoints: rect } };
      },
      mouse: async (proof, selected, id, command) => {
        assert.deepEqual(selected, target);
        assert.equal(id, authority);
        authority = null;
        state.clicks.push(command);
        state.frame = state.next;
        if (state.lostAck) throw new Error('transport_failed');
      },
    };
  };
  const store = new RunStore(path.join(root, 'runs')), broker = new Broker(store, native());
  const sessions = new WindowSessions(broker, native);
  const server = createQAServer(broker, { windowSessions: sessions });
  const origin = await server.listen(0);
  const file = path.join(root, 'agent.json');
  fs.writeFileSync(file, JSON.stringify({ origin, token: server.agentToken }), { mode: 0o600 });
  t.after(async () => { await server.close(); await broker.close(); fs.rmSync(root, { recursive: true }); });
  return { state, origin, file, store, open: () => new QAClient(file).openWindowSession({ target, processStartedAt }) };
}

test('scoped MCP records the real OCR transition with one native click and only returns the check', ocr, async t => {
  const { state, origin, file, store } = await fixture(t);
  const client = new Client({ name: 'qa-procedure-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [
    fileURLToPath(new URL('../src/qa-mcp.js', import.meta.url)), '--window-session', file] }));
  try {
    let calls = 0, bytes = 0;
    const call = async (name, args) => {
      const request = { name, arguments: args };
      const response = await client.callTool(request);
      assert(!response.isError, JSON.stringify(response.structuredContent));
      calls++;
      bytes += Buffer.byteLength(JSON.stringify(request)) + Buffer.byteLength(JSON.stringify(response));
      return response;
    };
    const { runId } = (await call('qa_start', { target, processStartedAt })).structuredContent;
    const initial = state.frame;
    calls = bytes = 0;
    const result = await call('qa_click_and_check_text', input);
    const compact = { calls, bytes }, checkId = result.structuredContent.checkId;
    const expectedResult = { status: 'pass', expected: input.expectedText, actual: 'OCR: Detail Page',
      replayUrl: `${origin}/#run=${runId}&step=${checkId}`, checkId };
    assert.match(checkId, /^[0-9a-f]{32}$/, JSON.stringify(result.structuredContent));
    assert.deepEqual(result.structuredContent, expectedResult);
    assert.deepEqual(result.content, [{ type: 'text', text: JSON.stringify(expectedResult) }]);
    assert.deepEqual(state.clicks, [mouse]);
    const run = store.get(runId);
    const check = run.events.find(e => e.kind === 'assertion' && e.stepId === checkId);
    assert.deepEqual(check.assessment, { source: 'caller', actor: 'agent', serverVerified: false });
    assert.match(check.context, /Tesseract OCR/);
    assert.deepEqual(store.image(runId, check.afterFrameId), state.next);
    const action = run.events.find(e => e.kind === 'action');
    assert.deepEqual(store.image(runId, action.beforeFrameId), initial);

    state.frame = initial;
    await new Promise(resolve => setTimeout(resolve, 80));
    calls = bytes = 0;
    const pre = await call('qa_observe', { runId, mode: 'pixels', includeImage: true });
    assert.deepEqual(Buffer.from(pre.content[1].data, 'base64'), initial);
    const post = await call('qa_act', { runId, observationId: pre.structuredContent.observationId, action: 'mouse', mouse });
    assert.deepEqual(Buffer.from(post.content[1].data, 'base64'), state.next);
    await call('qa_check', { runId, kind: 'visual', title: input.title, expected: input.expectedText,
      actual: expectedResult.actual, outcome: 'pass', observationId: post.structuredContent.observationId });
    assert.deepEqual(state.clicks, [mouse, mouse], 'Each independent path sends exactly one click');
    t.diagnostic(JSON.stringify({ metric: 'serialized MCP argument/result UTF-8 bytes', compact, primitives: { calls, bytes } }));
    assert.equal(calls, 3);
    assert.equal(compact.calls, 1);
    assert(compact.bytes < bytes);
    const finished = (await call('qa_finish', { runId, compact: true })).structuredContent;
    assert.equal(finished.counts.pass, 2);
    assert.equal(finished.replayUrl, `${origin}/#run=${runId}`);
    assert(!Object.hasOwn(finished, 'checks'));
    const report = (await call('qa_report', { runId, compact: true, waitMs: 10000 })).structuredContent;
    assert.equal(report.export.status, 'ready', JSON.stringify(report));
    for (const name of ['qa-v4-recording.mp4', 'qa-v4-poster.jpg', 'qa-v4-summary.json'])
      assert(fs.statSync(report.artifacts[name]).size > 0, `Compact report retains ${name}`);
    assert(!Object.hasOwn(report, 'reportMarkdown'));
    const replay = (await call('qa_replay', { runId, stepId: checkId })).structuredContent;
    assert.equal(replay.selected.status, 'pass');
    assert.equal(replay.selected.frameId, check.afterFrameId);
  } finally { await client.close(); }
});

test('SDK records a legible mismatch, not an acknowledgement or substring pass', ocr, async t => {
  const f = await fixture(t);
  f.state.next = jpeg('Detail Page preview');
  const s = await f.open();
  const pending = s.clickAndCheckText(input);
  await assert.rejects(s.clickAndCheckText(input), error => error.message === 'procedure_busy' && !error.failure.retrySafe);
  await assert.rejects(s.observe(), /procedure_busy/);
  const result = await pending;
  assert.equal(result.status, 'fail', JSON.stringify(result));
  assert.match(result.actual, /OCR/);
  assert.match(result.checkId, /^[0-9a-f]{32}$/);
  assert.equal((await s.task('qa_replay', { stepId: result.checkId })).selected.status, 'fail');
  assert.deepEqual(f.state.clicks, [mouse]);
  await s.close();
});

for (const [name, setup, status, clicks] of [
  ['expected line already present', s => { s.frame = jpeg('Library View', 'Detail Page'); }, 'blocked', 0],
  ['precondition is only a substring', s => { s.frame = jpeg('Library View preview'); }, 'blocked', 0],
  ['blank OCR after dispatch', s => { s.next = jpeg(); }, 'uncertain', 1],
  ['process replacement after dispatch', s => { s.replaced = true; }, 'uncertain', 1],
  ['lost acknowledgement after dispatch', s => { s.lostAck = true; }, 'uncertain', 1],
]) test(`SDK: ${name}`, ocr, async t => {
  const f = await fixture(t);
  setup(f.state);
  const session = await f.open();
  const result = await session.clickAndCheckText(input);
  assert.equal(result.status, status, JSON.stringify(result));
  assert.equal(result.retrySafe, clicks === 0);
  assert.equal(result.checkId, null);
  assert.equal(f.state.clicks.length, clicks);
  assert(!f.store.get(session.runId).events.some(e => e.kind === 'assertion' && ['pass', 'fail'].includes(e.status)));
  await session.close();
});

test('procedure rejects extra capabilities, unsafe coordinates and nonliteral line inputs', () => {
  for (const change of [{ x: 1 }, { y: -0.1 }, { x: Infinity }, { y: NaN }, { runId: opaque() },
    { command: 'ls' }, { target }, { expectedText: 'title\ninjected' }, { expectedText: 'z'.repeat(121) },
    { beforeText: ' Detail    Page ' }, { beforeText: ' ' }, { title: '\t' }])
    assert.equal(clickAndCheckTextSchema.safeParse({ ...input, ...change }).success, false);
});

test('invalid or stale frame envelopes never authorize input', async () => {
  const runId = opaque(), runUrl = `/#run=${runId}`;
  const pre = { runId, target, canAct: true, processStartedAt, observationId: opaque(), status: 'pass',
    image: { version: 1, ageMs: 8, receivedAt: Date.now(), mimeType: 'image/jpeg', data: jpeg('Library View').toString('base64') },
    imageGeometry: { width: 640, height: 360 }, frameEvidence: { status: 'available', frameVersion: 1, afterFrameId: opaque() } };
  for (const [change, expected] of [
    [{ image: { ...pre.image, mimeType: 'image/png' } }, 'invalid_scoped_jpeg'],
    [{ image: { ...pre.image, data: 'x'.repeat(6 * 1024 * 1024) } }, 'invalid_scoped_jpeg'],
    [{ imageGeometry: { width: 8, height: 8 } }, 'invalid_scoped_jpeg'],
    [{ image: { ...pre.image, version: 2 } }, 'scoped_frame_unconfirmed'],
    [{ image: { ...pre.image, ageMs: 2010 } }, 'scoped_frame_unconfirmed'],
    [{ target: { ...target, pid: 5 } }, 'scoped_frame_unconfirmed'],
    [{ canAct: false }, 'window_authority_required'],
  ]) {
    let attempted = false;
    const r = await clickAndCheckText({ target, runId, task: async name => {
      if (name === 'qa_observe') return { ...pre, ...change };
      attempted = true;
    } }, input, runUrl);
    assert.equal(r.actual, expected);
    assert.equal(r.status, 'blocked');
    assert.equal(attempted, false);
  }
});

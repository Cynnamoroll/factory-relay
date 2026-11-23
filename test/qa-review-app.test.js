import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { ReplayEntry } from '../web/replay-entry.js';
import { qaClipAt, qaEditPlan, QA_EDIT_VERSION } from '../web/qa-edit.js';
import * as liveVideo from '../web/live-video.js';
import * as cursorModel from '../web/action-cues.js';
import { isDesktop, targetIdentity, targetLabel, sameTarget } from '../web/target-identity.js';
import { recordingFilename } from '../web/recording-name.js';

const runId = '8797e68a6d26b3ee679e28611c8454ee';
const failureId = '0f536356251f5f6b03c837c4408cbed7';
const passId = '8c959fe514b913e37dcc40dd60502cbd';
const failed = { stepId: failureId, title: 'Intentional mismatch', expected: 102, actual: 3,
  status: 'fail', startedMs: 19929.107597, elapsedMs: 25032.181177 };
const passed = { stepId: passId, title: 'Increment', expected: 3, actual: 3,
  status: 'pass', startedMs: 14985.419945, elapsedMs: 18000 };
const recording = { runId, title: 'Saved real-run timing fixture', durationMs: 75584, status: 'failed',
  items: [passed, failed], counts: { pass: 1, fail: 1, blocked: 0, uncertain: 0 },
  export: { status: 'ready', bytes: 161879, version: QA_EDIT_VERSION }, nextOffset: null,
  edit: qaEditPlan([{ kind: 'run-start', elapsedMs: 0 },
    { kind: 'step-start', stepId: passId, operation: 'assert-count', elapsedMs: passed.startedMs },
    { kind: 'assertion', ...passed },
    { kind: 'step-start', stepId: failureId, operation: 'assert-count', elapsedMs: failed.startedMs },
    { kind: 'assertion', ...failed }, { kind: 'run-end', elapsedMs: 75584 }], 75584) };
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };

class Element extends EventTarget {
  constructor(tag = 'div') {
    super(); this.tagName = tag.toUpperCase(); this.children = []; this.style = {}; this.dataset = {};
    this.attributes = {}; this.value = ''; this.hidden = false; this.textContent = '';
    this.classList = { toggle: (name, enabled) => { this.attributes[name] = enabled; },
      remove: name => { delete this.attributes[name]; } };
  }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; if (key === 'src') this.src = ''; }
  append(...children) { for (const child of children) { child.remove(); child.parent = this; this.children.push(child); } }
  remove() { if (this.parent) { this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; } }
  replaceChildren(...children) { this.children = children; }
  add(child) { this.append(child); }
  focus() {}
  setPointerCapture() {}
  getContext() { return { drawImage() {}, clearRect() {} }; }
  getBoundingClientRect() { return { left: 0, width: 1000, height: 700 }; }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatchEvent(new Event('close')); }
  querySelectorAll(tag) { return this.children.flatMap(c => [c, ...c.querySelectorAll(tag)]).filter(c => c.tagName === tag.toUpperCase()); }
  click() { if (!this.disabled) { this.dispatchEvent(new Event('click')); this.onclick?.(); } }
}

async function workspace({ rejectPlay = false, storedMode = null, exportStatus = 'ready', replay, results, runs, deletion, clipboard, unpaired = false, codecs = {}, live, windowApi, sharedStatus, hash } = {}) {
  const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const elements = new Map([...html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"[^>]*>/g)].map(([text, tag, id]) => {
    const element = new Element(tag); element.hidden = /\bhidden\b/.test(text); return [id, element];
  }));
  const $ = id => { assert.ok(elements.has(id), `Real HTML must contain #${id}`); return elements.get(id); };
  if (live) $('live-canvas').getContext = () => ({ drawImage: live.draw, clearRect() {} });
  $('filter').value = 'all'; $('filter').options = ['all', 'fail', 'pass', 'blocked'].map(value => ({ value }));
  $('speed').value = '1';
  const video = $('video');
  Object.assign(video, { currentTime: 0, playbackRate: 1, readyState: 0, paused: true, ended: false, muted: false,
    load() { this.readyState = 0; this.currentTime = 0; this.dispatchEvent(new Event('emptied')); },
    pause() { this.paused = true; this.dispatchEvent(new Event('pause')); },
    async play() {
      if (rejectPlay) throw new Error('NotAllowedError');
      this.paused = false; this.dispatchEvent(new Event('play'));
    } });
  const window = new EventTarget(), document = new EventTarget(), timers = [], requests = [], storageReads = [];
  const location = { pathname: '/', hash: hash ?? (live || windowApi || sharedStatus ? '' : `#run=${runId}&step=${failureId}`) };
  window.scrollTo = () => {};
  window.history = { replaceState: (_state, _title, url) => { location.hash = url.slice(url.indexOf('#')); } };
  Object.assign(document, { getElementById: $, createElement: tag => new Element(tag),
    body: new Element('body'), activeElement: new Element('body'), fullscreenEnabled: false });
  for (const element of elements.values()) element.focus = () => { document.activeElement = element; };
  const response = data => ({ ok: true, headers: { get: () => 'application/json' }, json: async () => data });
  let currentExport = exportStatus;
  const context = vm.createContext({ ReplayEntry, qaClipAt, qaEditPlan, QA_EDIT_VERSION, recordingFilename, isDesktop, targetIdentity, targetLabel, sameTarget, ...liveVideo, ...cursorModel, ...codecs,
    document, window, location, URLSearchParams, URL,
    sessionStorage: { getItem: key => { storageReads.push(key); return storedMode; } },
    performance: live?.clock ?? performance, AbortController, AbortSignal, console, Option: class extends Element {}, navigator: { clipboard },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {}, setInterval() {},
    fetch: async (url, options) => {
      const input = options.body ? JSON.parse(options.body) : null; requests.push({ url, input });
      if (url === '/api/session') return unpaired
        ? { ...response({ error: 'authentication_required' }), ok: false } : response({ csrf: 'test-only' });
      if (url === '/session') { unpaired = false; return response({ csrf: 'test-only' }); }
      if (url === '/api/status') return response(sharedStatus ? sharedStatus() : { windows: [], connection: live ? 'live' : 'disconnected',
        owner: null, ...(live ? { runId, target: { windowId: 99, pid: 800, bundleId: 'fixture.shared' } } : {}) });
      if (url === '/api/live/stream' && live) return { ok: true,
        body: typeof live.stream === 'function' ? live.stream(options.headers['X-QA-Live-Run']) : live.stream,
        headers: new Headers(live.unbound ? {} : { 'X-QA-Live-Run': options.headers['X-QA-Live-Run'] }) };
      if (url.startsWith('/api/window-overview') && windowApi) return windowApi(url, options, response);
      if (url === '/api/window-overview') return response({ sessions: [] });
      if (url === '/api/recordings') return response(runs ? await runs() : { total: 0, runs: [] });
      if (/\/api\/recordings\/.*\/(confirm-delete|delete)$/.test(url)) return response(deletion ? await deletion(url, input)
        : { runId, title: recording.title, confirmation: 'test-consent' });
      if (url.endsWith('qa_report')) return response({ reportMarkdown: '### Saved QA\n\n1 passed · 1 failed\n\nExpected 102, observed 3.' });
      if (url.endsWith('qa_replay')) {
        if (input.filter === 'results') return response(results ? await results(input) : {
          runId, title: recording.title, counts: recording.counts,
          checks: { total: 2, offset: 0, items: [passed, failed] },
          operationalErrors: { total: 0, offset: 0, items: [] }, nextOffset: null,
        });
        if (replay) return response(await replay(input));
        return response({ ...recording, selected: input.stepId === failureId ? failed : input.stepId === passId ? passed : null,
          export: { ...recording.export, status: currentExport } });
      }
      throw new Error(`Unexpected request: ${url}`);
    } });
  const app = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
  vm.runInContext(app, context); await settle();
  return { $, video, document, requests, storageReads, context, hasElement: id => elements.has(id),
    metadata() { video.readyState = 4; video.dispatchEvent(new Event('loadedmetadata')); },
    async navigate(step) { location.hash = `#run=${runId}&step=${step}`; window.dispatchEvent(new Event('hashchange')); await settle(); },
    async poll(ms = 2000) { const timer = timers.findLast(t => t.ms === ms); assert.ok(timer); await timer.fn(); await settle(); },
    readyExport() { currentExport = 'ready'; } };
}

test('successful pairing clears obsolete authentication warning from review', async () => {
  const w = await workspace({ unpaired: true });
  assert.equal(w.$('message').hidden, false);
  assert.match(w.$('message').textContent, /authentication required/);
  w.$('code').value = 'private-test-code';
  w.$('pair-form').dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
  assert.equal(w.$('workspace').hidden, false);
  assert.equal(w.$('message').hidden, true, 'Pairing success must dismiss its earlier auth failure');
});

test('real app entry converts persisted milliseconds, selects failure, and starts after metadata', async () => {
  const w = await workspace();
  assert.equal(w.$('review-title').textContent, recording.title);
  assert.equal(w.document.body.attributes.reviewing, true);
  assert.equal(w.$('selected-title').textContent, failed.title);
  w.metadata(); await settle();
  assert.equal(w.video.currentTime.toFixed(9), '3.014580055');
  assert.equal(w.video.paused, false);
  assert.equal(w.$('selected-result').textContent, 'FAIL');
  assert.equal(w.$('selected-actual').textContent, 3);
  assert.ok(Math.abs(parseFloat(w.$('segments').children[1].style.left) - 37.136101028) < 0.000001);
  assert.equal(w.$('time').textContent, '0:03 / 0:08');
});

test('review download attributes use descriptive names and distinguish QA video from full session', async () => {
  const w = await workspace({ replay: async () => ({ ...recording, title: 'Nimbus Studio - Menu opens',
    sourceExport: { status: 'ready' }, selected: failed }) });
  assert.equal(w.$('review-title').textContent, 'Nimbus Studio - Menu opens');
  assert.equal(w.$('download').download, `Nimbus Studio - Menu opens - QA recording - ${runId}.mp4`);
  assert.equal(w.$('source-download').download, `Nimbus Studio - Menu opens - full-session recording - ${runId}.mp4`);
});

test('video surface and overlay each toggle once; polling preserves user pause and seek', async () => {
  const w = await workspace(); w.metadata(); await settle();
  w.video.click(); await settle(); assert.equal(w.video.paused, true);
  w.video.currentTime = 29; await w.poll();
  assert.equal(w.video.currentTime, 29); assert.equal(w.video.paused, true);
  w.$('replay-play').click(); await settle(); assert.equal(w.video.paused, false);
  w.video.click(); await settle(); assert.equal(w.video.paused, true);
  w.$('checks').querySelectorAll('button')[0].click(); await settle();
  assert.equal(w.video.currentTime, 0);
  assert.equal(w.video.paused, true, 'Selecting evidence preserves pause');
});

test('blocked autoplay leaves selected evidence and a usable play fallback', async () => {
  const w = await workspace({ rejectPlay: true }); w.metadata(); await settle();
  assert.equal(w.video.currentTime.toFixed(9), '3.014580055');
  assert.equal(w.video.paused, true);
  assert.equal(w.$('replay-play').hidden, false);
  assert.match(w.$('message').textContent, /Click Play recording/);
});

test('pending failure entry survives export refresh and close cancels late media playback', async () => {
  const w = await workspace({ exportStatus: 'encoding' });
  w.readyExport(); await w.poll(); w.metadata(); await settle();
  assert.equal(w.video.currentTime.toFixed(9), '3.014580055');
  assert.equal(w.video.paused, false);
  w.$('close-review').click(); await settle(); w.metadata(); await settle();
  assert.equal(w.video.paused, true); assert.equal(w.$('review').hidden, true);
  await w.navigate(failureId); w.metadata(); await settle();
  assert.equal(w.video.currentTime.toFixed(9), '3.014580055'); assert.equal(w.video.paused, false);
});

test('out-of-order replay requests cannot replace newer navigation', async () => {
  let resolveFirst;
  const w = await workspace({ replay: input => input.stepId === failureId
    ? new Promise(resolve => { resolveFirst = resolve; })
    : { ...recording, selected: passed } });
  await w.navigate(passId);
  resolveFirst({ ...recording, selected: failed }); await settle(); w.metadata(); await settle();
  assert.equal(w.video.currentTime, 0);
  assert.equal(w.$('selected-title').textContent, passed.title);
});

test('failed replay load offers recovery, not stale success', async () => {
  const w = await workspace({ replay: async () => { throw new Error('broker unavailable'); } });
  assert.equal(w.$('review-title').textContent, 'Recording unavailable');
  assert.match(w.$('review-summary').textContent, /broker unavailable/);
  assert.equal(w.$('retry-review').hidden, false);
  assert.equal(w.$('act').disabled, true);
});

test('results button opens readable JSON before export and restores paused position and focus', async () => {
  const w = await workspace({ exportStatus: 'encoding' });
  w.$('results-json').click(); await settle();
  assert.equal(w.$('results-dialog').open, true);
  const data = JSON.parse(w.$('dialog-content').textContent);
  assert.equal(data.runId, runId);
  assert.equal(data.checks.items[1].actual, 3);
  assert.equal(data.checks.items[1].expected, 102);
  assert.match(w.$('dialog-status').textContent, /All results included/);
  assert.equal(w.document.activeElement, w.$('dialog-close'));
  assert.ok(w.requests.every(r => !/qa_(act|check|observe|start|control)/.test(r.url)));
  w.$('dialog-close').click(); await settle();
  assert.equal(w.$('results-dialog').open, false);
  assert.equal(w.document.activeElement, w.$('results-json'));
  assert.equal(w.video.paused, true);
});

test('modal pauses playing media and resumes only the previous playing state', async () => {
  const w = await workspace(); w.metadata(); await settle();
  w.video.currentTime = 23.5;
  w.$('results-json').click(); await settle();
  assert.equal(w.video.paused, true);
  await w.poll(); assert.equal(w.video.currentTime, 23.5);
  w.$('results-dialog').close(); await settle();
  assert.equal(w.video.currentTime, 23.5); assert.equal(w.video.paused, false);
  w.video.pause(); w.$('results-json').click(); await settle();
  w.$('dialog-close').click(); await settle();
  assert.equal(w.video.paused, true);
});

test('modal errors retry; pagination explicitly includes later failures and copy is page-scoped', async () => {
  let calls = 0;
  const w = await workspace({ results: async input => {
    if (++calls === 1) throw new Error('offline');
    return { runId, counts: recording.counts,
      checks: { total: 101, offset: input.offset, items: input.offset ? [failed] : [passed] },
      operationalErrors: { total: 0, offset: input.offset, items: [] }, nextOffset: input.offset ? null : 100 };
  } });
  w.$('results-json').click(); await settle();
  assert.match(w.$('dialog-status').textContent, /offline/);
  assert.equal(w.$('dialog-retry').hidden, false);
  assert.equal(w.$('dialog-copy').disabled, true);
  w.$('dialog-retry').click(); await settle();
  assert.match(w.$('dialog-status').textContent, /Other pages may contain failures/);
  assert.equal(w.$('dialog-copy').textContent, 'Copy page JSON');
  w.$('dialog-next').click(); await settle();
  assert.equal(JSON.parse(w.$('dialog-content').textContent).checks.items[0].status, 'fail');
  assert.equal(w.$('dialog-next').hidden, true);
  assert.equal(w.$('dialog-previous').hidden, false);
});

test('closing a loading modal ignores its delayed response and report copy failure remains selectable', async () => {
  let resolve;
  const w = await workspace({ results: () => new Promise(r => { resolve = r; }),
    clipboard: { writeText: async () => { throw new Error('blocked'); } } });
  w.$('results-json').click(); await settle(); w.$('dialog-close').click(); await settle();
  w.$('copy-report').click(); await settle();
  assert.match(w.$('dialog-content').textContent, /Expected 102, observed 3/);
  resolve({ wrong: true }); await settle();
  assert.match(w.$('dialog-content').textContent, /Expected 102, observed 3/);
  w.$('dialog-copy').click(); await settle();
  assert.match(w.$('dialog-status').textContent, /copy the text below manually/);
  assert.equal(w.document.activeElement, w.$('dialog-content'));
});

test('dialog Tab boundaries wrap focus and a loading dialog can restore its enabled opener', async () => {
  const w = await workspace();
  w.$('results-json').click(); await settle();
  const backward = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Tab', shiftKey: true });
  w.$('results-dialog').dispatchEvent(backward);
  assert.equal(backward.defaultPrevented, true);
  assert.equal(w.document.activeElement, w.$('dialog-copy'));
  const forward = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Tab', shiftKey: false });
  w.$('results-dialog').dispatchEvent(forward);
  assert.equal(w.document.activeElement, w.$('dialog-close'));
  assert.notEqual(w.$('results-json').disabled, true);
});

test('QA-only media ignores stale mode preferences and plays edited intervals at normal speed', async () => {
  const w = await workspace({ storedMode: 'full' }); w.metadata(); await settle(); w.video.pause();
  assert.equal(w.hasElement('review-mode'), false);
  assert.deepEqual(w.storageReads, []);
  assert.equal(w.video.src, `/api/runs/${runId}/qa-v4-recording.mp4#export=4-0`);
  assert.equal(w.$('download').href, w.video.src);
  assert.equal(w.video.currentTime.toFixed(9), '3.014580055');
  assert.equal(w.video.playbackRate, 1);
  w.$('seek').value = '5'; w.$('seek').dispatchEvent(new Event('input'));
  w.$('speed').value = '1.5'; w.$('speed').dispatchEvent(new Event('change'));
  assert.equal(w.video.currentTime, 5); assert.equal(w.video.playbackRate, 1.5);
  assert.equal(w.video.paused, true);
});

test('missing or empty QA edit never falls back to a ready full-session video', async () => {
  for (const edit of [undefined, { available: false, reason: 'Invalid journal', clips: [], durationMs: 0 },
    { available: true, clips: [], durationMs: 0 }]) {
    const w = await workspace({ replay: async () => ({ ...recording, edit, selected: failed }) });
    w.metadata(); await settle();
    assert.equal(w.video.hidden, true);
    assert.equal(w.video.paused, true);
    assert.equal(w.$('download').hidden, true);
    assert.equal(w.$('export').hidden, true);
    assert.equal(w.hasElement('review-mode'), false);
  }
});

test('obsolete ready media cannot play; a newly published generation reloads at its own check footage', async () => {
  let generation = 0, version = 2;
  const w = await workspace({ replay: async () => ({ ...recording, selected: failed,
    export: { ...recording.export, version, encodedAt: generation } }) });
  w.metadata(); await settle();
  assert.equal(w.video.hidden, true); assert.equal(w.video.paused, true);
  assert.equal(w.$('download').hidden, true);
  assert.match(w.$('export-message').textContent, /not compatible/);
  version = QA_EDIT_VERSION; generation++;
  await w.navigate(failureId); w.metadata(); await settle();
  assert.equal(w.video.hidden, false);
  assert.match(w.video.src, /qa-v4-recording.mp4#export=4-1$/);
  w.video.currentTime = 12;
  generation++; await w.navigate(failureId);
  assert.equal(w.video.readyState, 0, 'New media publication must not retain the loaded previous generation');
  w.metadata(); await settle();
  assert.equal(w.video.currentTime, recording.edit.clips[1].startMs / 1000);
  assert.match(w.video.src, /#export=4-2$/);
});

test('a check without a QA clip stays inspectable but never seeks or starts unrelated footage', async () => {
  const w = await workspace({ replay: async () => ({ ...recording,
    items: [passed, { ...failed, status: 'blocked' }], selected: { ...failed, status: 'blocked' },
    edit: { ...recording.edit, durationMs: 3014.580055, clips: [recording.edit.clips[0]] } }) });
  w.metadata(); await settle();
  assert.equal(w.video.paused, true);
  assert.match(w.$('selected-result').textContent, /No QA clip/);
  assert.equal(w.$('segments').children.length, 1);
  w.$('checks').querySelectorAll('button')[1].click(); await settle();
  assert.equal(w.video.currentTime, 0);
  assert.equal(w.video.paused, true);
  assert.match(w.$('selected-result').textContent, /BLOCKED.*No QA clip/);
});

test('recording rows preserve long titles and expose only recorded outcomes', async () => {
  const title = 'Long recording title '.repeat(30);
  const w = await workspace({ runs: async () => ({ total: 1, runs: [{
    ...recording, title, started: '2026-01-01T00:00:00Z',
  }] }) });
  const row = w.$('recording-cards').children[0];
  assert.ok(row.querySelectorAll('button').some(button => button.attributes['aria-label'] === `Review ${title}, 1 passed, 1 failed`));
  assert.equal(w.$('review-outcome').textContent, '1 passed · 1 failed');
  assert.ok(!row.querySelectorAll('span').some(element => /^(FAIL|FAILED)$/.test(element.textContent)));
  assert.equal(row.querySelectorAll('h3')[0].textContent, title);
  assert.equal(row.querySelectorAll('img')[0].src, `/api/runs/${runId}/qa-v4-poster.jpg`);
  const outcomes = row.querySelectorAll('p')[0].children.map(c => c.textContent);
  assert.deepEqual(outcomes, ['1 passed', '1 failed']);
  assert.equal(w.$('recordings-empty').hidden, true);
  assert.equal(w.$('library-status').hidden, true);
});

test('library loading and failure do not claim an empty successful library; refresh recovers', async () => {
  let reject, calls = 0;
  const w = await workspace({ runs: () => ++calls === 1
    ? new Promise((_resolve, fail) => { reject = fail; })
    : { total: 0, runs: [] } });
  assert.equal(w.$('library-status').textContent, 'Loading recordings…');
  reject(new Error('offline')); await settle();
  assert.match(w.$('library-status').textContent, /Recordings unavailable.*offline.*Refresh/);
  assert.equal(w.$('recordings-empty').hidden, true);
  w.$('refresh').click(); await settle();
  assert.equal(w.$('library-status').hidden, true);
  assert.equal(w.$('recordings-empty').hidden, false);
});

test('export failure keeps checks and retry available without claiming playable video', async () => {
  const w = await workspace({ replay: async () => ({ ...recording,
    export: { status: 'error', code: 'encoder_failed' }, selected: failed }) });
  assert.match(w.$('export-message').textContent, /encoder failed/);
  assert.equal(w.$('export').hidden, false);
  assert.equal(w.$('download').hidden, true);
  assert.equal(w.$('video').hidden, true);
  assert.equal(w.$('selected-expected').textContent, 102);
  assert.equal(w.$('selected-actual').textContent, 3);
  assert.equal(w.$('checks').querySelectorAll('button').length, 2);
});

test('native panel navigation exposes pressed state and preserves disconnected observer controls', async () => {
  const w = await workspace();
  w.$('close-review').click(); await settle();
  w.$('tab-live').click(); await settle();
  assert.equal(w.$('tab-live').attributes['aria-pressed'], 'true');
  assert.equal(w.$('tab-recordings').attributes['aria-pressed'], 'false');
  assert.equal(w.$('connection').textContent, 'disconnected');
  assert.equal(w.$('owner').textContent, 'Observer only');
  assert.equal(w.$('human-tools').hidden, true);
  assert.equal(w.$('act').disabled, true);
  assert.equal(w.$('recordings-surface').hidden, true);
});

test('compact playback exposes play state through its control without redundant normal status', async () => {
  const w = await workspace(); w.metadata(); await settle();
  assert.equal(w.$('play').attributes['aria-label'], 'Pause recording');
  assert.equal(w.$('play').attributes['data-playing'], 'true');
  assert.equal(w.$('media-state').hidden, true);
  w.video.click(); await settle();
  assert.equal(w.$('play').attributes['aria-label'], 'Play recording');
  assert.equal(w.$('play').attributes['data-playing'], 'false');
  assert.equal(w.$('replay-play').hidden, false);
  assert.equal(w.$('media-state').hidden, true);
  w.video.dispatchEvent(new Event('waiting'));
  assert.equal(w.$('media-state').textContent, 'Buffering…');
  assert.equal(w.$('media-state').hidden, false);
  assert.equal(w.$('review-title').title, recording.title);
});

test('QA cut boundaries select the next check and section seeking preserves pause', async () => {
  const w = await workspace(); w.metadata(); await settle(); w.video.pause();
  w.$('seek').value = String(Math.ceil(recording.edit.clips[1].startMs) / 1000); w.$('seek').dispatchEvent(new Event('input'));
  assert.equal(w.$('selected-title').textContent, failed.title);
  assert.equal(w.video.playbackRate, 1);
  w.$('segments').children[0].click(); await settle();
  assert.equal(w.video.currentTime, 0);
  assert.equal(w.$('selected-title').textContent, passed.title);
  assert.equal(w.video.paused, true);
  w.video.currentTime = Math.floor(recording.edit.clips[1].startMs * 1000) / 1000000;
  w.video.dispatchEvent(new Event('timeupdate'));
  assert.equal(w.$('selected-result').textContent, 'FAIL', 'Browser microsecond rounding must not select the preceding outcome at a cut');
  w.video.currentTime = 8.117653635; w.video.dispatchEvent(new Event('timeupdate'));
  assert.equal(w.$('selected-title').textContent, failed.title);
});

test('one outcome track covers all footage, remains complete when filtered or paginated, and supports dragging', async () => {
  const w = await workspace({ replay: async () => ({ ...recording, items: [passed], selected: null, nextOffset: 1 }) });
  w.metadata(); await settle(); w.video.pause();
  const sections = w.$('segments').children;
  assert.equal(sections.length, 2, 'Every clip has a section even before its checklist page is loaded');
  assert.equal(sections[0].className, 'pass'); assert.equal(sections[1].className, 'fail');
  assert.ok(Math.abs(parseFloat(sections[0].style.width) - 37.136101028) < 0.000001);
  assert.ok(Math.abs(parseFloat(sections[1].style.width) - 62.863898972) < 0.000001);
  assert.equal(sections[1].attributes['aria-label'], 'Seek to Intentional mismatch, fail');
  sections[1].click(); await settle();
  assert.equal(w.video.currentTime.toFixed(9), '3.014580055');
  assert.equal(w.$('selected-expected').textContent, 102);
  w.$('filter').value = 'pass'; w.$('filter').dispatchEvent(new Event('change'));
  assert.equal(w.$('segments').children.length, 2, 'Checklist filtering never hides timeline outcomes');
  const section = w.$('segments').children[0];
  const pointer = (type, clientX) => section.dispatchEvent(Object.assign(new Event(type),
    { pointerId: 1, button: 0, clientX }));
  pointer('pointerdown', 100); pointer('pointermove', 750); pointer('pointerup', 750);
  section.click(); await settle();
  assert.ok(Math.abs(w.video.currentTime - 6.08824022625) < 0.000001, 'Dragging a section scrubs to the pointer, not its start');
  assert.equal(w.$('selected-result').textContent, 'FAIL');
  assert.equal(w.video.paused, true);
  w.$('seek').value = '1.25'; w.$('seek').dispatchEvent(new Event('input'));
  assert.equal(w.video.currentTime, 1.25, 'Native range input still scrubs independently');
});

test('Escape closes playback settings and restores its trigger without changing source position', async () => {
  const w = await workspace(); w.metadata(); await settle(); w.video.pause();
  w.$('playback-settings').open = true;
  const time = w.video.currentTime;
  const escape = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' });
  w.document.dispatchEvent(escape);
  assert.equal(w.$('playback-settings').open, false);
  assert.equal(w.document.activeElement, w.$('playback-settings-toggle'));
  assert.equal(w.video.currentTime, time);
  assert.equal(w.video.paused, true);
});

test('recording deletion names the recording, defaults to Cancel and changes nothing when cancelled', async () => {
  const w = await workspace({ runs: async () => ({ total: 1, runs: [{
    ...recording, sourceBytes: 2048, exportBytes: 1024,
    deletion: { reason: null, pending: false },
  }], storage: { sourceBytes: 2048, exportBytes: 1024, totalBytes: 3072,
    sourceLimitBytes: 2 * 1024 ** 3, exportLimitBytes: 512 * 1024 ** 2, maxRuns: 64 } }) });
  assert.match(w.$('storage-usage').textContent, /3.0 KiB stored.*source 2.0 KiB.*exports 1.0 KiB/);
  const remove = w.$('recording-cards').querySelectorAll('button').find(b => b.textContent === 'Delete');
  remove.click(); await settle();
  assert.equal(w.$('delete-dialog').open, true);
  assert.equal(w.$('delete-name').textContent, recording.title);
  assert.equal(w.document.activeElement, w.$('delete-cancel'));
  assert.match(fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8'),
    /permanently removes this recording’s source frames and journal, and all exported videos, posters and summaries/);
  w.$('delete-cancel').click(); await settle();
  assert.equal(w.$('delete-dialog').open, false);
  assert.equal(w.requests.filter(r => r.url.endsWith('/delete')).length, 0);
  assert.equal(w.$('run-count').textContent, 1);
  assert.equal(w.$('recording-cards').children.length, 1);
});

test('confirmed deletion clears selected playback and details, releases displayed usage, and never requests exports', async () => {
  let deleted = false;
  const w = await workspace({ runs: async () => ({ total: deleted ? 0 : 1,
    runs: deleted ? [] : [recording], storage: { sourceBytes: deleted ? 0 : 1024, exportBytes: 0,
      totalBytes: deleted ? 0 : 1024, sourceLimitBytes: 100000, exportLimitBytes: 100000, maxRuns: 64 } }),
    deletion: async url => {
      if (url.endsWith('/delete')) { deleted = true; return { runId, deleted: true }; }
      return { title: recording.title, confirmation: 'explicit-consent' };
    } });
  w.metadata(); await settle();
  w.$('delete-review').click(); await settle();
  w.$('delete-confirm').click(); await settle();
  assert.equal(deleted, true);
  assert.equal(w.$('review').hidden, true);
  assert.equal(w.video.paused, true);
  assert.equal(w.video.src, '');
  assert.equal(w.$('checks').children.length, 0);
  assert.equal(w.$('review-summary').textContent, '');
  assert.equal(w.$('selected-expected').textContent, '—');
  assert.equal(w.$('selected-actual').textContent, '—');
  assert.equal(w.$('download').hidden, true);
  assert.equal(w.$('source-download').hidden, true);
  assert.equal(w.$('recording-cards').children.length, 0);
  assert.equal(w.$('run-count').textContent, 0);
  assert.match(w.$('storage-usage').textContent, /^0 B stored/);
  assert.equal(w.requests.filter(r => r.url.endsWith('/delete')).length, 1);
  assert.ok(!w.requests.some(r => r.url.endsWith('qa_report')));
  w.metadata(); await w.poll();
  assert.equal(w.video.paused, true, 'Late metadata and polls cannot restore deleted replay');
});

test('deletion failures remain truthful and retry the same confirmed cleanup once without regenerating exports', async () => {
  let attempts = 0;
  const w = await workspace({ deletion: async (url, input) => {
    if (url.endsWith('/confirm-delete')) return { title: recording.title, confirmation: 'same-consent' };
    assert.equal(input.confirmation, 'same-consent');
    if (++attempts === 1) throw new Error('cleanup interrupted');
    return { runId, deleted: true };
  } });
  w.$('delete-review').click(); await settle();
  w.$('delete-confirm').click(); await settle();
  assert.equal(w.$('delete-dialog').open, true);
  assert.equal(w.$('review').hidden, false);
  assert.match(w.$('delete-status').textContent, /not confirmed complete.*cleanup interrupted/);
  assert.equal(w.$('delete-confirm').textContent, 'Retry deletion');
  w.$('delete-confirm').click(); w.$('delete-confirm').click(); await settle();
  assert.equal(attempts, 2);
  assert.equal(w.$('review').hidden, true);
  assert.equal(w.requests.filter(r => r.url.endsWith('/confirm-delete')).length, 1);
  assert.ok(!w.requests.some(r => r.url.endsWith('qa_report')));
});

test('active and exporting row deletion is disabled with a visible explanation', async () => {
  const w = await workspace({ runs: async () => ({ total: 2, runs: [
    { ...recording, deletion: { reason: 'run_active' } },
    { ...recording, runId: passId, deletion: { reason: 'export_busy' } },
  ] }) });
  const buttons = w.$('recording-cards').querySelectorAll('button').filter(b => b.textContent === 'Delete');
  assert.equal(buttons.length, 2);
  for (const b of buttons) { assert.equal(b.disabled, true); b.click(); }
  assert.match(buttons[0].title, /Finish recording/);
  assert.match(buttons[1].title, /queued \/ encoding/);
  assert.equal(w.requests.filter(r => r.url.endsWith('/confirm-delete')).length, 0);
});

const start = [0, 0, 0, 1];
const key = new Uint8Array([...start, 0x67, 0x64, 0x00, 0x28, 0xac, 0xd9, 0x40, 0x78, ...start, 0x68, 0xee, 0x3c, 0x80,
  ...start, 0x65, 0x88, 0x84, 0x21, 0xa0]);
const delta = new Uint8Array([...start, 0x41, 0x9a, 0x22, 0x11]);

test('a decoder backlog drop skips dependent deltas until the next keyframe', async () => {
  const decoded = [];
  let queue = 0;
  class VideoDecoder {
    constructor() { this.state = 'unconfigured'; }
    configure() { this.state = 'configured'; }
    get decodeQueueSize() { return queue; }
    decode(chunk) { decoded.push(chunk.type + ':' + chunk.timestamp); }
    close() { this.state = 'closed'; }
  }
  class EncodedVideoChunk { constructor({ type, timestamp }) { Object.assign(this, { type, timestamp }); } }
  const w = await workspace({ codecs: { VideoDecoder, EncodedVideoChunk } });
  const send = (keyframe, t, backlog = 0) => { queue = backlog; w.context.handleVideo({ keyframe, captureTimeSeconds: t }, keyframe ? key : delta); };
  send(true, 1); send(false, 2);
  send(false, 3, 5);
  send(false, 4); send(false, 5);
  send(true, 6, 5);
  send(false, 7);
  assert.deepEqual(decoded, ['key:1000000', 'delta:2000000', 'key:6000000', 'delta:7000000'],
    'After a dropped delta, later deltas wait for a keyframe, and a keyframe is never dropped');
});

async function livePresentation() {
  const ticks = new Map(), timers = new Map(), drawn = [], frames = [];
  let now = 0, nextTick = 0, activeId = runId;
  const senders = new Map();
  const stream = id => new ReadableStream({ start: controller => { senders.set(id, controller); } });
  class VideoFrame {
    constructor(id) { Object.assign(this, { id, displayWidth: 640, displayHeight: 480, closed: 0 }); }
    close() { this.closed++; }
  }
  class VideoDecoder {
    constructor({ output }) { this.output = output; this.state = 'unconfigured'; this.decodeQueueSize = 0; }
    configure() { this.state = 'configured'; }
    decode(chunk) { const frame = new VideoFrame(chunk.timestamp / 1e6); frames.push(frame); this.output(frame); }
    close() { this.state = 'closed'; }
  }
  const w = await workspace({ live: { stream, clock: { now: () => now }, draw: frame => drawn.push(frame.id) },
    sharedStatus: () => ({ windows: [], connection: 'live', owner: null, runId: activeId,
      target: { windowId: activeId === runId ? 99 : 123, pid: 800, bundleId: 'fixture.shared' } }), codecs: {
    Image: class { async decode() {} }, Blob, TextDecoder, Uint8Array, VideoDecoder, webCodecsVideo: () => true,
    EncodedVideoChunk: class { constructor({ timestamp }) { this.timestamp = timestamp; } },
    requestAnimationFrame: fn => { ticks.set(++nextTick, fn); return nextTick; },
    cancelAnimationFrame: id => ticks.delete(id),
  } });
  w.context.setTimeout = (fn, ms) => { timers.set(++nextTick, { fn, due: now + ms }); return nextTick; };
  w.context.clearTimeout = id => timers.delete(id);
  function send(header, bytes) {
    const json = Buffer.from(JSON.stringify({ ...header, bytes: bytes.length }));
    const length = Buffer.alloc(4); length.writeUInt32BE(json.length);
    senders.get(activeId).enqueue(Buffer.concat([length, json, Buffer.from(bytes)]));
  }
  return { ...w, drawn, frames, send, close: () => { for (const sender of senders.values()) sender.close(); },
    async changeTarget() { activeId = 'a'.repeat(32); await w.poll(750); },
    push(id) { send({ type: 'vframe', keyframe: id === 1, captureTimeSeconds: id }, id === 1 ? key : delta); },
    clockAt(at) { now = at; },
    pending() { return { ticks: ticks.size, timers: timers.size }; },
    cursorTimers() { return [...timers.values()].filter(t => t.fn.name === 'clearCursor').length; },
    async advanceTimers(at) {
      await settle(); now = at;
      for (const [id, { fn, due }] of Array.from(timers))
        if (at >= due && timers.delete(id)) fn();
      await settle();
    },
    async tick(at) {
      await settle(); now = at;
      for (const [id, fn] of Array.from(ticks)) if (ticks.delete(id)) fn(at);
      await settle();
    },
  };
}

test('live synthetic cursor is run-scoped, labeled, letterboxed, bounded and cleared on hide or target change', async () => {
  const w = await livePresentation();
  const cue = { runId, actor: 'agent', operation: 'mouse', status: 'acknowledged',
    startMs: 100, endMs: 1000, point: { x: .968, y: .926 }, geometry: { width: 1920, height: 1200 } };
  const send = value => w.send({ type: 'cue', cue: value, sourceMs: 100 }, []);
  send(cue); await settle();
  assert.equal(w.$('input-cue').hidden, false);
  assert.match(w.$('input-cue').textContent, /Synthetic.*agent.*native ACK, not assertion/);
  assert.equal(w.$('input-marker').hidden, false);
  assert.equal(w.$('input-marker').style.left, '968px');
  assert.ok(Math.abs(parseFloat(w.$('input-marker').style.top) - 616.25) < .001);
  assert.deepEqual(w.drawn, [], 'Metadata never modifies decoded capture pixels');
  await w.advanceTimers(900);
  assert.equal(w.$('input-marker').hidden, true);
  assert.equal(w.pending().timers, 0, 'Expiry leaves no animation or expiry timer');
  send({ ...cue, status: 'blocked', point: null }); await settle();
  assert.equal(w.$('input-marker').hidden, true);
  assert.match(w.$('input-cue').textContent, /blocked/);
  send({ ...cue, runId: 'f'.repeat(32) }); await settle();
  assert.equal(w.$('input-cue').hidden, true, 'A different run cannot appear in this lane');
  send(cue); await settle();
  w.document.hidden = true; w.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(w.$('input-cue').hidden, true);
  assert.equal(w.pending().timers, 0);
  w.document.hidden = false; send(cue); await settle();
  await w.changeTarget();
  assert.equal(w.$('input-marker').hidden, true);
  assert.equal(w.$('input-cue').hidden, true);
  assert.equal(w.cursorTimers(), 0, 'Target changes cancel the cursor timer independently of status polling');
  w.close();
});

test('a bounded decoded burst presents fresh frames in order across display ticks', async () => {
  const w = await livePresentation();
  for (const id of [1, 2, 3, 4]) w.push(id);
  await w.tick(16);
  assert.deepEqual(w.drawn, [2], 'Only the oldest excess frame is discarded; draw once on the first tick');
  await w.tick(32);
  await w.tick(48);
  assert.deepEqual(w.drawn, [2, 3, 4], 'Preserve burst frames that still fit the latency budget');
  w.push(5);
  await w.tick(99);
  assert.deepEqual(w.drawn, [2, 3, 4], 'Do not paint stale frames after a stalled display tick');
  assert.deepEqual(w.frames.map(frame => frame.closed), [1, 1, 1, 1, 1]);
  w.close();
});

test('a retained JPEG replaces an active video canvas after decode failure', async () => {
  const w = await livePresentation();
  w.push(1);
  await w.tick(16);
  assert.equal(w.$('live-canvas').hidden, false);
  w.send({ type: 'frame', version: 2 }, [0xff, 0xd8, 0xff, 0xd9]);
  await w.tick(32);
  assert.equal(w.$('live').hidden, true, 'Video takes priority while healthy');
  w.push(2);
  w.send({ type: 'vframe', keyframe: true }, [42]);
  await settle();
  assert.equal(w.$('live').hidden, false, 'Latest JPEG appears without another packet or animation callback');
  assert.equal(w.$('live-canvas').hidden, true);
  assert.deepEqual(w.drawn, [1], 'A queued video frame cannot replace the fallback');
  assert.deepEqual(w.frames.map(frame => frame.closed), [1, 1]);
  URL.revokeObjectURL(w.$('live').src);
  w.close();
});

test('a visible pane falls back to fresh rate-limited canvas draws and resumes FIFO when animation returns', async () => {
  const w = await livePresentation();
  for (const id of [1, 2, 3, 4]) w.push(id);
  await w.advanceTimers(42);
  assert.deepEqual(w.drawn, [4], 'An indefinitely paused rAF cannot leave a visible pane blank');
  assert.deepEqual(w.pending(), { ticks: 1, timers: 0 });
  w.clockAt(75); w.push(5); await settle();
  assert.deepEqual(w.drawn, [4, 5], 'An overdue rAF must not require the timer event to draw fresh input');
  w.clockAt(76); w.push(6); await settle();
  assert.deepEqual(w.drawn, [4, 5], 'A burst cannot bypass the fallback rate limit');
  assert.deepEqual(w.pending(), { ticks: 1, timers: 1 });
  await w.tick(84); w.push(7); w.push(8);
  await w.tick(100); await w.tick(116);
  assert.deepEqual(w.drawn, [4, 5, 6, 7, 8], 'Recovery restores in-order animation-frame draws');
  await w.advanceTimers(500);
  assert.deepEqual(w.pending(), { ticks: 0, timers: 0 }, 'Media scheduling must stop when input stops');
  assert.ok(w.frames.every(frame => frame.closed === 1));
  assert.equal(w.context.window.qaLiveStats.fallbackCanvasDrawn, 2);
  assert.equal(w.context.window.qaLiveStats.rafCanvasDrawn, 3);
  assert.equal(w.context.window.qaLiveStats.compositorPaints, null, 'Canvas calls do not measure displayed paints');
  w.close();
});

test('late watchdog ticks, hidden panes, and source teardown never draw stale frames', async () => {
  const w = await livePresentation();
  w.push(1);
  await w.advanceTimers(100);
  assert.deepEqual(w.drawn, [], 'A late watchdog cannot make an expired frame visible');
  assert.equal(w.frames[0].closed, 1);
  w.push(2); await settle();
  assert.deepEqual(w.drawn, [2], 'Fresh decode recovers even when both scheduling callbacks were late');
  w.clockAt(101); w.push(3); await settle();
  w.document.hidden = true; w.document.dispatchEvent(new Event('visibilitychange'));
  w.push(4); await w.advanceTimers(200);
  assert.deepEqual(w.pending(), { ticks: 0, timers: 0 });
  assert.deepEqual(w.drawn, [2]);
  w.document.hidden = false; w.document.dispatchEvent(new Event('visibilitychange'));
  w.push(5); await settle();
  assert.deepEqual(w.pending(), { ticks: 1, timers: 1 });
  await w.changeTarget();
  await w.tick(225);
  assert.deepEqual(w.drawn, [2], 'A callback for the former target must not draw its queued frame');
  assert.equal(w.$('live-canvas').hidden, true);
  // The new source starts with a keyframe and must not inherit the previous watchdog deadline.
  w.send({ type: 'vframe', keyframe: true, captureTimeSeconds: 6 }, key);
  await w.advanceTimers(266);
  assert.deepEqual(w.drawn, [2]);
  await w.advanceTimers(267);
  assert.deepEqual(w.drawn, [2, 6]);
  assert.ok(w.frames.every(frame => frame.closed === 1));
  w.close();
});

const lane = (id, title, windowId) => ({ runId: id, title, target: { windowId, pid: 20, bundleId: 'test.app' },
  connection: 'live', owner: 'agent', frameVersion: 1, frameAgeMs: 100, currentCheck: { title: 'Check visible', status: 'pass' } });
const overviewApi = '/api/window-overview';

test('window overview lists parallel sessions, watches only the selected run, and opens ended recordings', async () => {
  const first = lane('1'.repeat(32), 'First window', 1), second = lane(runId, 'Second window', 2);
  const third = lane('3'.repeat(32), 'Third window', 3), fourth = lane('4'.repeat(32), 'Fourth window', 4);
  let sessions = [], resolveFirst, abortedFirst, lateRead;
  const w = await workspace({ windowApi: (url, options, response) => {
    if (url === overviewApi) return response({ sessions });
    if (url.endsWith('/frame')) return new Response(new Blob(['fixture']), { headers: { 'content-type': 'image/jpeg' } });
    if (url === `${overviewApi}/${first.runId}/stream`) {
      abortedFirst = options.signal;
      return new Promise(resolve => { resolveFirst = resolve; });
    }
    if (url === `${overviewApi}/${second.runId}/stream`) return {
      ok: true, body: new ReadableStream({ start(controller) { lateRead = controller; } }),
    };
    throw Error(`Unexpected window request: ${url}`);
  } });
  assert.equal(w.$('live-surface').hidden, false, 'The default shared controls remain the initial view');
  w.$('tab-windows').click(); await settle();
  assert.match(w.$('windows-status').textContent, /No active window sessions/);
  assert.equal(w.$('live-surface').hidden, true);
  sessions = [first]; await w.poll(1000);
  assert.match(w.$('windows-status').textContent, /1 active window session ·/);
  sessions = [first, second, third, fourth]; await w.poll(1000);
  const buttons = () => w.$('window-cards').querySelectorAll('button');
  assert.equal(buttons().length, 4);
  assert.equal(w.$('window-cards').querySelectorAll('img').filter(img => !img.hidden).length, 4);
  assert.ok(!w.requests.some(r => r.url.endsWith('/stream')), 'The overview has no streaming requests');
  buttons()[0].click(); await settle();
  assert.equal(w.$('watch-title').textContent, first.title);
  buttons()[1].click(); await settle();
  assert.equal(abortedFirst.aborted, true);
  assert.equal(w.$('watch-title').textContent, second.title);
  assert.equal(buttons()[1].attributes['aria-pressed'], 'true');
  assert.ok(lateRead);
  let abandoned = false;
  resolveFirst({ ok: true, body: new ReadableStream({ cancel() { abandoned = true; } }) }); await settle();
  assert.equal(abandoned, true, 'A late response from the old selection is never read');
  assert.equal(w.$('watch-title').textContent, second.title);
  assert.ok(!w.requests.some(r => r.input), 'Watching, switching, and polling did not send any task');
  sessions = [first, third, fourth]; await w.poll(1000);
  assert.equal(buttons().length, 3);
  assert.match(w.$('watch-status').textContent, /no longer active/);
  assert.equal(w.$('window-viewer').hidden, true);
  assert.equal(w.$('watch-recording').hidden, false);
  w.$('watch-recording').click(); await settle();
  assert.equal(w.$('recordings-surface').hidden, false);
  assert.equal(w.requests.find(r => r.url.endsWith('qa_replay')).input.runId, second.runId);
  await settle();
});

test('in-flight JPEG decode is discarded on window switch and a disappeared run cannot reopen', async () => {
  const first = lane('1'.repeat(32), 'First window', 1), second = lane('2'.repeat(32), 'Second window', 2);
  let resolveDecode, sessions = [];
  const w = await workspace({ codecs: { Blob, TextDecoder, Uint8Array, Image: class {
    decode() { return new Promise(resolve => { resolveDecode = resolve; }); }
  }, requestAnimationFrame: fn => setImmediate(fn) }, windowApi: (url, _options, response) => {
    if (url === overviewApi) return response({ sessions });
    if (url.endsWith('/frame')) return { ok: false, status: 404 };
    if (url.includes(second.runId)) return { ok: false, status: 404 };
    const header = Buffer.from(JSON.stringify({ type: 'frame', bytes: 1 }));
    const len = Buffer.alloc(4); len.writeUInt32BE(header.length);
    return { ok: true, body: new ReadableStream({ start(controller) { controller.enqueue(Buffer.concat([len, header, Buffer.from([0])])); } }) };
  } });
  sessions = [first, second]; w.$('tab-windows').click(); await settle();
  const buttons = w.$('window-cards').querySelectorAll('button');
  buttons[0].click(); await settle();
  assert.equal(typeof resolveDecode, 'function');
  buttons[1].click(); await settle();
  resolveDecode(); await settle();
  assert.equal(w.$('live').hidden, true);
  assert.equal(w.$('live').src, '');
  assert.match(w.$('watch-status').textContent, /stream not ready/);
  sessions = [first];
  await w.poll(1000);
  assert.match(w.$('watch-status').textContent, /no longer active/);
  assert.equal(w.requests.filter(r => r.url === `${overviewApi}/${second.runId}/stream`).length, 1);
  w.$('tab-live').click(); await settle();
  assert.equal(w.$('live-surface').hidden, false);
  assert.equal(w.$('tab-windows').attributes['aria-pressed'], 'false');
});

test('an ended window and a closed overview cannot receive late thumbnails or status', async () => {
  const first = lane('1'.repeat(32), 'First window', 1);
  let sessions = [], thumbnail, delayedOverview;
  const w = await workspace({ windowApi: (url, _options, response) => {
    if (url === overviewApi) return sessions === null
      ? new Promise(resolve => { delayedOverview = resolve; }) : response({ sessions });
    return new Promise(resolve => { thumbnail = resolve; });
  } });
  sessions = [first]; w.$('tab-windows').click(); await settle();
  const image = w.$('window-cards').querySelectorAll('img')[0];
  sessions = []; await w.poll(1000);
  thumbnail(new Response(new Blob(['fixture']), { headers: { 'content-type': 'image/jpeg' } })); await settle();
  assert.equal(image.hidden, true);
  assert.equal(w.$('window-cards').children.length, 0);
  sessions = null;
  const oldPoll = w.poll(1000); await settle();
  sessions = []; w.$('tab-live').click(); await settle();
  w.$('tab-windows').click(); await settle();
  delayedOverview(Response.json({ sessions: [first] })); await oldPoll;
  assert.match(w.$('windows-status').textContent, /No active window sessions/);
  assert.equal(w.$('window-cards').children.length, 0);
});

const finishedLane = (lane, status, stepId) => ({ ...lane, status,
  counts: { pass: 0, fail: 0, blocked: 0, uncertain: 0, [status]: 1 },
  edit: { clips: stepId ? [{ status, stepId }] : [] }, export: { status: 'queued' } });

test('Live follows four scoped windows through partial results and confirms group completion before review', async () => {
  const a = lane('1'.repeat(32), 'First', 1), b = lane('2'.repeat(32), 'Second', 2),
    c = lane('3'.repeat(32), 'Third', 3), d = lane('4'.repeat(32), 'Fourth', 4);
  let sessions = [a, b, c, d], saved = [];
  const w = await workspace({
    windowApi: (url, _options, response) => {
      if (url === overviewApi) return sessions ? response({ sessions }) : { ok: false, status: 503 };
      if (url.endsWith('/frame')) return new Response(new Blob(['fixture']), { headers: { 'content-type': 'image/jpeg' } });
      return { ok: true, body: new ReadableStream() };
    },
    runs: () => ({ total: saved.length, runs: saved }),
  });
  const shown = () => w.$('tab-live').attributes['aria-pressed'] === 'true';
  const streams = () => w.requests.filter(r => r.url.endsWith('/stream')).map(r => r.url);
  assert.ok(shown());
  assert.equal(w.$('shared-session').hidden, true);
  assert.equal(w.$('watch-title').textContent, 'First');
  assert.equal(streams().length, 1);
  assert.equal(w.requests.filter(r => r.url.endsWith('/frame')).length, 3);
  sessions = [b, c, d]; saved = [finishedLane(a, 'fail', failureId)]; await w.poll(1000);
  assert.ok(shown());
  assert.equal(w.$('watch-title').textContent, 'Second');
  assert.match(w.$('follow-counts').textContent, /^1 recording .*1 failed/);
  sessions = [d]; saved.push(finishedLane(b, 'pass'), finishedLane(c, 'blocked')); await w.poll(1000);
  assert.ok(shown());
  assert.equal(w.$('watch-title').textContent, 'Fourth');
  assert.equal(w.$('follow-cards').children.length, 3);
  sessions = []; await w.poll(1000);
  assert.ok(shown(), 'An empty active list does not prove a durable finish');
  assert.match(w.$('windows-status').textContent, /Waiting to confirm/);
  saved.push(finishedLane(d, 'uncertain')); await w.poll(1000);
  assert.ok(shown(), 'A fresh empty snapshot must be confirmed');
  sessions = null; await w.poll(1000);
  sessions = []; await w.poll(1000);
  assert.ok(shown(), 'A transient overview error resets completion confirmation');
  await w.poll(1000);
  assert.equal(w.$('tab-recordings').attributes['aria-pressed'], 'true');
  assert.equal(w.$('follow-title').textContent, 'QA results');
  assert.match(w.$('follow-counts').textContent, /1 passed · 1 failed · 1 blocked · 1 uncertain/);
  assert.deepEqual(streams(), [a, b, d].map(s => `${overviewApi}/${s.runId}/stream`));
  assert.ok(!w.requests.some(r => r.input), 'Automatic following only reads');
  w.$('follow-cards').querySelectorAll('button')[0].click(); await settle();
  assert.deepEqual(w.requests.find(r => r.url.endsWith('qa_replay')).input, {
    runId: a.runId, stepId: failureId, filter: 'checks', limit: 100,
  });
});

test('paired Live distinguishes display recording context from its unchanged window-only preview and input', async () => {
  const first = { ...lane(runId, 'Window', 1), recordingScope: { scope: 'display', reason: 'sole_window_session' } };
  let sessions = [first];
  const w = await workspace({ windowApi: (url, _options, response) => url === overviewApi
    ? response({ sessions }) : { ok: true, body: new ReadableStream() } });
  assert.match(w.$('watch-target').textContent, /Recording: whole selected display/);
  assert.match(w.$('watch-target').textContent, /preview and input: selected window/);
  assert.equal(w.requests.filter(r => r.url.endsWith('/stream'))[0].url, `${overviewApi}/${runId}/stream`);
  sessions = [{ ...first, recordingScope: { scope: 'window', reason: 'multiple_sessions' } }, lane('2'.repeat(32), 'Second', 2)];
  await w.poll(1000);
  assert.match(w.$('watch-target').textContent, /Recording: selected window \(multiple sessions\)/);
  sessions = [{ ...first, recordingScope: { scope: 'window', reason: 'screen_recording_required' } }];
  await w.poll(1000);
  assert.match(w.$('watch-target').textContent, /screen recording required/);
  assert.ok(!w.requests.some(r => r.input), 'Scope changes never send input, retarget or request desktop preview');
});

test('a single scoped window opens immediately, then opens only its matching recording on final completion', async () => {
  const first = lane(runId, 'Only window', 1);
  let sessions = [first], saved = [];
  const w = await workspace({
    runs: () => ({ total: saved.length, runs: saved }),
    windowApi: (url, _options, response) => url === overviewApi ? response({ sessions })
      : { ok: true, body: new ReadableStream() },
  });
  assert.equal(w.$('watch-title').textContent, first.title);
  assert.equal(w.$('window-cards').querySelectorAll('button')[0].hidden, true);
  assert.equal(w.$('tab-live').attributes['aria-pressed'], 'true');
  sessions = []; saved = [finishedLane(first, 'fail', failureId)]; await w.poll(1000); await w.poll(1000);
  assert.equal(w.$('review-title').textContent, recording.title);
  assert.equal(w.context.location.hash, '', 'Automatic review does not become a manual deep link on reload');
  assert.equal(w.requests.find(r => r.url.endsWith('qa_replay')).input.runId, first.runId);
  const next = lane('2'.repeat(32), 'Next window', 2);
  sessions = [next]; await w.poll(1000);
  assert.equal(w.$('tab-live').attributes['aria-pressed'], 'true', 'Automatic review keeps following future recordings');
  assert.equal(w.$('watch-title').textContent, next.title);
  assert.equal(w.$('follow-results').hidden, true, 'A new recording does not inherit the previous group');
  assert.ok(w.requests.some(r => r.url === `${overviewApi}/${next.runId}/stream`));
});

test('manual recording deep links take priority over automatic Live following', async () => {
  const first = lane('1'.repeat(32), 'First', 1);
  const w = await workspace({ hash: `#run=${runId}&step=${failureId}`,
    windowApi: (_url, _options, response) => response({ sessions: [first] }),
  });
  assert.equal(w.$('tab-recordings').attributes['aria-pressed'], 'true');
  assert.equal(w.$('selected-title').textContent, failed.title);
  assert.ok(!w.requests.some(r => r.url.endsWith('/stream')), 'Intentional review never opens a stream in the background');
  assert.match(w.$('recording-live-status').textContent, /1 window recording is active/);
  w.$('resume-live').click(); await settle();
  assert.equal(w.$('tab-live').attributes['aria-pressed'], 'true');
  assert.equal(w.$('watch-title').textContent, first.title);
});

test('a connecting window opens when live and retries a transient scoped stream outage', async () => {
  const first = lane('1'.repeat(32), 'First', 1);
  let sessions = [{ ...first, connection: 'connecting' }], attempts = 0;
  const w = await workspace({
    windowApi: (url, _options, response) => {
      if (url === overviewApi) return response({ sessions });
      if (url.endsWith('/frame')) return { status: 404 };
      if (++attempts === 1) return { ok: false, status: 404 };
      if (attempts === 2) return { ok: false, status: 503 };
      return { ok: true, body: new ReadableStream() };
    },
  });
  assert.equal(w.$('watch-title').textContent, first.title);
  assert.equal(attempts, 0);
  sessions = [first]; await w.poll(1000);
  assert.equal(attempts, 1);
  await w.poll(750);
  assert.equal(attempts, 1, 'Do not retry 404 until the scoped roster reconfirms the run');
  await w.poll(1000);
  assert.equal(attempts, 2);
  await w.poll(1000);
  assert.equal(attempts, 3);
  assert.equal(w.$('window-viewer').hidden, false);
  sessions = []; await w.poll(1000); await w.poll(1000);
  assert.equal(attempts, 3, 'A disappeared window cannot reopen a stream');
});

test('manually selecting Recordings during automatic review keeps it selected when another run starts', async () => {
  const first = lane(runId, 'Only window', 1), second = lane('2'.repeat(32), 'New window', 2);
  let sessions = [first], saved = [];
  const w = await workspace({
    runs: () => ({ total: saved.length, runs: saved }),
    windowApi: (url, _options, response) => url === overviewApi ? response({ sessions })
      : { ok: true, body: new ReadableStream() },
  });
  sessions = []; saved = [finishedLane(first, 'pass')]; await w.poll(1000); await w.poll(1000);
  w.$('tab-recordings').click(); await settle();
  sessions = [second]; await w.poll(1000);
  assert.equal(w.$('tab-recordings').attributes['aria-pressed'], 'true');
  assert.equal(w.$('recording-live').hidden, false);
  assert.ok(!w.requests.some(r => r.url === `${overviewApi}/${second.runId}/stream`));
});

test('opening an intermediate result and returning to Live does not hide the final group review', async () => {
  const a = lane(runId, 'First', 1), b = lane('2'.repeat(32), 'Second', 2);
  let sessions = [a, b], saved = [];
  const w = await workspace({
    windowApi: (url, _options, response) => url === overviewApi ? response({ sessions })
      : { ok: true, body: new ReadableStream() },
    runs: () => ({ total: saved.length, runs: saved }),
  });
  sessions = [b]; saved = [finishedLane(a, 'fail', failureId)]; await w.poll(1000);
  w.$('follow-cards').querySelectorAll('button')[0].click(); await settle();
  assert.equal(w.$('review').hidden, false);
  w.$('tab-live').click(); await settle();
  assert.equal(w.$('watch-title').textContent, b.title);
  sessions = []; saved.push(finishedLane(b, 'pass')); await w.poll(1000); await w.poll(1000);
  assert.equal(w.$('review').hidden, true);
  assert.equal(w.$('follow-results').hidden, false);
  assert.equal(w.$('follow-title').textContent, 'QA results');
});

test('an available desktop is neither selected nor streamed without an explicit choice', async () => {
  const desktop = { kind: 'desktop', displayId: 11, displayUUID: 'fixture-display' };
  let status = { connection: 'live', runId, target: desktop, owner: 'agent', desktopAllowed: true,
    windows: [], displays: [desktop] };
  const w = await workspace({ sharedStatus: () => status });
  assert.equal(w.$('watch-display').hidden, false);
  assert.equal(w.$('shared-controls').hidden, true);
  assert.equal(w.$('targets').value, '');
  assert.ok(!w.requests.some(r => r.url.endsWith('/stream')));
  w.$('watch-display').click(); await settle();
  assert.equal(w.$('shared-controls').hidden, false);
  assert.equal(w.requests.filter(r => r.url === '/api/live/stream').length, 1);
  status = { ...status, runId: 'a'.repeat(32) }; await w.poll(750);
  assert.equal(w.$('live-canvas').hidden, true, 'Explicit consent does not carry across runs');
  assert.equal(w.requests.filter(r => r.url === '/api/live/stream').length, 1);
});

test('legacy shared window playback fails closed if the server does not acknowledge run binding', async () => {
  let cancelled = false;
  const w = await workspace({ live: { unbound: true, draw: () => assert.fail('Unbound video must not draw'),
    stream: new ReadableStream({ cancel() { cancelled = true; } }) } });
  assert.equal(w.$('shared-session').hidden, false);
  assert.equal(w.$('live-canvas').hidden, true);
  assert.match(w.$('live-mode').textContent, /bound to this run/);
  assert.equal(cancelled, true);
});

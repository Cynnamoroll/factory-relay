import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { ReplayEntry } from '../web/replay-entry.js';
import { qaClipAt, qaEditPlan, QA_EDIT_VERSION } from '../web/qa-edit.js';

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
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  add(child) { this.append(child); }
  focus() {}
  setPointerCapture() {}
  getBoundingClientRect() { return { left: 0, width: 1000 }; }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatchEvent(new Event('close')); }
  querySelectorAll(tag) { return this.children.flatMap(c => [c, ...c.querySelectorAll(tag)]).filter(c => c.tagName === tag.toUpperCase()); }
  click() { this.dispatchEvent(new Event('click')); this.onclick?.(); }
}

async function workspace({ rejectPlay = false, storedMode = null, exportStatus = 'ready', replay, results, runs, clipboard, unpaired = false } = {}) {
  const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const elements = new Map([...html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"[^>]*>/g)].map(([text, tag, id]) => {
    const element = new Element(tag); element.hidden = /\bhidden\b/.test(text); return [id, element];
  }));
  const $ = id => { assert.ok(elements.has(id), `Real HTML must contain #${id}`); return elements.get(id); };
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
  const location = { pathname: '/', hash: `#run=${runId}&step=${failureId}` };
  window.scrollTo = () => {};
  window.history = { replaceState: (_state, _title, url) => { location.hash = url.slice(url.indexOf('#')); } };
  Object.assign(document, { getElementById: $, createElement: tag => new Element(tag),
    body: new Element('body'), activeElement: new Element('body'), fullscreenEnabled: false });
  for (const element of elements.values()) element.focus = () => { document.activeElement = element; };
  const response = data => ({ ok: true, headers: { get: () => 'application/json' }, json: async () => data });
  let currentExport = exportStatus;
  const context = vm.createContext({ ReplayEntry, qaClipAt, qaEditPlan, QA_EDIT_VERSION,
    document, window, location, URLSearchParams, URL,
    sessionStorage: { getItem: key => { storageReads.push(key); return storedMode; } },
    performance, AbortSignal, console, Option: class extends Element {}, navigator: { clipboard },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {}, setInterval() {},
    fetch: async (url, options) => {
      const input = options.body ? JSON.parse(options.body) : null; requests.push({ url, input });
      if (url === '/api/session') return unpaired
        ? { ...response({ error: 'authentication_required' }), ok: false } : response({ csrf: 'test-only' });
      if (url === '/session') { unpaired = false; return response({ csrf: 'test-only' }); }
      if (url === '/api/status') return response({ windows: [], connection: 'disconnected', owner: null });
      if (url.endsWith('qa_runs')) return response(runs ? await runs() : { total: 0, runs: [] });
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
  return { $, video, document, requests, storageReads, hasElement: id => elements.has(id),
    metadata() { video.readyState = 4; video.dispatchEvent(new Event('loadedmetadata')); },
    async navigate(step) { location.hash = `#run=${runId}&step=${step}`; window.dispatchEvent(new Event('hashchange')); await settle(); },
    async poll() { const timer = timers.findLast(t => t.ms === 2000); assert.ok(timer); await timer.fn(); await settle(); },
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
  assert.equal(w.video.src, `/api/runs/${runId}/qa-v3-recording.mp4#export=3-0`);
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
  assert.match(w.video.src, /qa-v3-recording.mp4#export=3-1$/);
  w.video.currentTime = 12;
  generation++; await w.navigate(failureId);
  assert.equal(w.video.readyState, 0, 'New media publication must not retain the loaded previous generation');
  w.metadata(); await settle();
  assert.equal(w.video.currentTime, recording.edit.clips[1].startMs / 1000);
  assert.match(w.video.src, /#export=3-2$/);
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
  assert.equal(row.attributes['aria-label'], `Review ${title}, 1 passed, 1 failed`);
  assert.equal(w.$('review-outcome').textContent, '1 passed · 1 failed');
  assert.ok(!row.querySelectorAll('span').some(element => /^(FAIL|FAILED)$/.test(element.textContent)));
  assert.equal(row.querySelectorAll('h3')[0].textContent, title);
  assert.equal(row.querySelectorAll('img')[0].src, `/api/runs/${runId}/qa-v3-poster.jpg`);
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

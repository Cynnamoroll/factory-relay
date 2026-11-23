import { ReplayEntry } from './replay-entry.js';
import { parseAnnexB, annexbToAvcc, avccDescription, codecString, parameterSets, equalBytes, webCodecsVideo } from './live-video.js';
import { qaClipAt, qaSegmentAt, QA_EDIT_VERSION } from './qa-edit.js';
import { isDesktop, targetIdentity, targetLabel, sameTarget } from './target-identity.js';
import { fitPoint, cueLabel, CUE_LEGEND, cueAt } from './action-cues.js';
import { recordingFilename } from './recording-name.js';

const $ = id => document.getElementById(id);
const validId = value => /^[a-f0-9]{32}$/.test(value ?? '');
let csrf, state, observationId, selectedRun, selectedStep, checks = [], run, pageOffset, liveURL;
let tab = 'live', enteredOnce = false, lastStatusAt = 0, loadedVideo, toastTimer, reviewGeneration = 0, navigating = false;
const windowRoute = '/api/window-overview';
let windowView = null;
let recordingPresence = null, followLive = true, lastAutomaticGroup = new Set();
let follow = { seen: new Set(), finished: new Map() }, groupReview = null, chosenDisplay = null;
const sharedStream = '/api/live/stream';
const isWindow = t => Boolean(t && !isDesktop(t) && Number.isInteger(t.windowId) && t.windowId > 0 &&
  Number.isInteger(t.pid) && t.pid > 0 && typeof t.bundleId === 'string');
const video = $('video');
let dialogState = null;
let deletionState = null, libraryGeneration = 0;
const clipFor = stepId => run?.edit?.clips.find(c => c.stepId === stepId);
const replayEntry = new ReplayEntry(video, () => {
  $('replay-play').hidden = false;
  tell('Recording ready at the selected check. Click Play recording to begin.', true);
});
function tell(message, sticky = false) {
  $('message').textContent = message; $('message').hidden = false;
  clearTimeout(toastTimer);
  if (!sticky) toastTimer = setTimeout(() => { $('message').hidden = true; }, 7000);
}
async function api(route, input) {
  const response = await fetch(route, { method: input === undefined ? 'GET' : 'POST',
    signal: AbortSignal.timeout(input === undefined ? 10000 : 90000),
    headers: { 'X-QA-Request': '1', ...(input === undefined ? {} : { 'Content-Type': 'application/json', 'X-QA-CSRF': csrf ?? '' }) },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
  if (!response.ok) {
    const data = await response.json();
    const error = new Error(data.failure ? `${data.failure.code.replaceAll('_', ' ')}. ${data.failure.nextAction}` : data.error.replaceAll('_', ' '));
    error.code = data.error;
    throw error;
  }
  return response.headers.get('content-type') === 'image/jpeg' ? response.blob() : response.json();
}
const task = (name, args = {}) => api('/api/tasks/' + name, args);
function bind(id, fn) {
  $(id).addEventListener('click', async () => {
    if ((tab !== 'live' || $('shared-session').hidden) && $(id).closest?.('.control-panel')) return;
    $(id).disabled = true;
    try { await fn(); } catch (e) { tell(e.message, true); }
    finally { $(id).disabled = false; updateControls(); }
  });
}
function surface(name) {
  if (name !== 'recordings') { replayEntry.cancel(); video.pause(); }
  const changed = name !== tab;
  if (changed) {
    setLiveSource(null);
    if (windowView) closeWindowOverview();
    if (recordingPresence) {
      recordingPresence.controller.abort();
      clearTimeout(recordingPresence.timer);
      recordingPresence = null;
    }
  }
  tab = name;
  document.body.classList.toggle('reviewing', name === 'recordings' && !$('review').hidden);
  for (const n of ['live', 'windows', 'recordings']) {
    if (n !== 'windows' || name !== 'live') $(n + '-surface').hidden = n !== name;
    $('tab-' + n).setAttribute('aria-pressed', String(n === name));
  }
  if (name === 'live') {
    if (!windowView) openWindowOverview(true);
    else syncLiveSurface();
  }
  if (changed && name === 'windows') openWindowOverview(false);
  if (name === 'recordings') {
    renderFollowResults();
    if (!recordingPresence && enteredOnce) {
      $('recording-live').hidden = true;
      recordingPresence = { controller: new AbortController() };
      void refreshRecordingPresence(recordingPresence);
    }
  }
}
function followLiveNow() {
  followLive = true;
  historyReplace('');
  surface('live');
}
bind('tab-live', async () => followLiveNow());
bind('resume-live', async () => followLiveNow());
bind('tab-windows', async () => { followLive = false; surface('windows'); });
bind('tab-recordings', async () => { followLive = false; groupReview = null; surface('recordings'); await history(); });
function activeRun() {
  if (!state?.runId) throw new Error('Start a QA run first.');
  return state.runId;
}
async function entered(session) {
  if (enteredOnce) return;
  enteredOnce = true; csrf = session.csrf; $('pair').hidden = true; $('workspace').hidden = false;
  clearTimeout(toastTimer); $('message').hidden = true; $('message').textContent = '';
  readHash();
  if (selectedRun) {
    try { await loadRun(selectedRun, selectedStep); } catch (e) { tell(e.message, true); }
  } else surface('live');
  history().catch(e => tell(`Run library unavailable. ${e.message}`, true));
  pollStatus(); pollReview();
}
$('pair-form').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const session = await api('/session', { code: $('code').value.trim() });
    $('code').value = ''; await entered(session);
  } catch (error) { tell(error.message, true); }
});
function readHash() {
  selectedRun = null; selectedStep = null;
  const params = new URLSearchParams(location.hash.slice(1));
  if (validId(params.get('run'))) {
    followLive = false;
    selectedRun = params.get('run'); selectedStep = validId(params.get('step')) ? params.get('step') : null;
    surface('recordings');
  }
}
window.addEventListener('hashchange', () => {
  readHash();
  if (enteredOnce && selectedRun) loadRun(selectedRun, selectedStep).catch(e => tell(e.message, true));
  else if (enteredOnce) closeReview();
});
function deepLink(id, step) { historyReplace(`#run=${id}${step ? '&step=' + step : ''}`); }
function historyReplace(hash) { window.history.replaceState(null, '', location.pathname + hash); }
bind('discover', async () => {
  await task('qa_targets'); await updateStatus();
  tell('Choose an authorized window. Sharing a whole display is optional and requires an explicit selection.');
});
bind('start', async () => {
  const selected = $('targets').value;
  if (!selectableTargets().some(t => targetValue(t) === selected)) throw new Error('Choose an authorized target first.');
  const target = JSON.parse(selected);
  const title = $('run-title').value.trim();
  const result = await task('qa_start', { ...(title ? { title } : {}), target });
  if (isDesktop(target)) chosenDisplay = { runId: result.runId, target };
  tell(result.resumed ? 'Rejoined the current recording.' : 'QA is recording. Observe before input.');
  await updateStatus(); await history();
});
$('targets').addEventListener('change', updateControls);
bind('watch-display', async () => {
  if (state?.desktopAllowed && isDesktop(state.target) && validId(state.runId)) {
    chosenDisplay = { runId: state.runId, target: targetIdentity(state.target) };
    syncLiveSurface();
  }
});
bind('take', async () => {
  await task('qa_control', { mode: 'take' }); observationId = undefined;
  tell('You have control. The same run continues; the capture transition is recorded.');
  await updateStatus();
});
bind('release', async () => {
  await task('qa_control', { mode: 'release' }); observationId = undefined;
  tell('Control released. Both viewers remain authorized.'); await updateStatus();
});
function observed(result) {
  observationId = result.canAct === false ? undefined : result.observationId;
  $('count').textContent = result.actual ?? '—';
  updateControls();
  $('observation-state').textContent = result.canAct === false ? 'Cached · observer only' : 'Fresh native observation · input expires within 30s';
}
bind('observe', async () => observed(await task('qa_observe', { runId: activeRun() })));
bind('act', async () => {
  if (!observationId) throw new Error('Observe first to authorize a single increment.');
  const id = observationId; observationId = undefined;
  const result = await task('qa_act', { runId: activeRun(), action: 'increment', observationId: id });
  observed(result);
  tell(result.frameEvidence.status === 'missing' ? 'Native state observed after input. No newer post-action image arrived within the deadline.' : 'Input acknowledged. Use a named check to verify the expected count.');
});
bind('check', async () => {
  const result = await task('qa_check', { runId: activeRun(), title: $('check-title').value.trim(),
    expected: Number($('expected').value), ...($('context').value ? { context: $('context').value } : {}) });
  $('count').textContent = result.actual; observationId = undefined;
  tell(`${result.title}: ${result.status.toUpperCase()} · expected ${result.expected}, observed ${result.actual}.`);
  await updateStatus();
});
bind('finish', async () => {
  const result = await task('qa_finish', { runId: activeRun() });
  observationId = undefined;
  follow.seen.add(result.runId);
  tell('Run saved. The video is being prepared; you can already review the checks.');
  await updateStatus(); await history();
});
function formatTime(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
function node(tag, className, text) {
  const n = document.createElement(tag); if (className) n.className = className;
  if (text !== undefined) n.textContent = text; return n;
}
function openWindowOverview(automatic) {
  windowView = { controller: new AbortController(), cards: new Map(), watched: null, automatic };
  const section = $('windows-surface');
  (automatic ? $('live-windows') : $('windows-tab')).append(section);
  section.hidden = false;
  $('shared-session').hidden = true;
  $('windows-status').textContent = 'Loading window sessions…';
  $('window-watch').hidden = true;
  $('watch-back').hidden = automatic;
  if (automatic) renderFollowResults();
  refreshWindows(windowView);
}
function closeWindowOverview() {
  windowView.controller.abort();
  clearTimeout(windowView.timer);
  clearWindowCards(windowView);
  windowView = null;
}
function clearWindowCards(view) {
  for (const card of view.cards.values()) clearWindowPreview(card);
  view.cards.clear();
  $('window-cards').replaceChildren();
}
function clearWindowPreview(card) {
  if (card.url) URL.revokeObjectURL(card.url);
  card.url = null; card.version = null;
  card.image.removeAttribute('src'); card.image.hidden = true;
}
const windowRequest = (path, signal) => fetch(path, {
  headers: { 'X-QA-Request': '1' }, cache: 'no-store',
  signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
});
async function activeWindowLanes(signal) {
  const response = await windowRequest(windowRoute, signal);
  if (!response.ok) throw new Error('overview unavailable');
  const { sessions } = await response.json();
  // Malformed or mis-scoped snapshots are not evidence of completion.
  if (!Array.isArray(sessions) || sessions.some(l => !validId(l?.runId) || !isWindow(l.target)))
    throw new Error('invalid overview');
  return new Map(sessions.map(l => [l.runId, l]));
}
async function refreshRecordingPresence(presence) {
  try {
    const lanes = await activeWindowLanes(presence.controller.signal);
    if (recordingPresence !== presence) return;
    const legacy = isWindow(state?.target) && performance.now() - lastStatusAt <= 2500 ? sharedRun() : null;
    const ids = new Set(lanes.keys());
    if (legacy) ids.add(legacy);
    if (followLive && [...ids].some(id => !lastAutomaticGroup.has(id))) {
      groupReview = null;
      if (!$('review').hidden) closeReview(false);
      followLiveNow();
      return;
    }
    $('recording-live').hidden = !ids.size;
    $('recording-live-status').textContent = ids.size === 1
      ? '1 window recording is active' : `${ids.size} window recordings are active`;
  } catch {
    if (recordingPresence === presence) $('recording-live').hidden = true;
  } finally {
    if (recordingPresence === presence)
      presence.timer = setTimeout(() => refreshRecordingPresence(presence), 1000);
  }
}
function windowCard(view, id) {
  const button = node('button', 'window-card'), preview = node('span', 'window-preview');
  const image = node('img'), placeholder = node('span', 'fine', 'No screenshot');
  image.alt = ''; image.hidden = true; preview.append(placeholder, image);
  const title = node('strong'), target = node('span', 'muted'), status = node('span', 'fine'), check = node('span', 'fine');
  button.append(preview, title, target, status, check, node('span', 'window-card-action', 'Watch window'));
  button.onclick = () => watchWindow(view, id);
  $('window-cards').append(button);
  return { button, image, title, target, status, check };
}
function latestCaptureAge(lane, receivedAt) {
  return Number.isFinite(lane?.frameAgeMs) && lane.frameAgeMs >= 0
    ? lane.frameAgeMs + performance.now() - receivedAt : Infinity;
}
function captureStatus(lane, receivedAt) {
  const age = latestCaptureAge(lane, receivedAt);
  return Number.isFinite(age)
    ? `Latest capture reported ${age < 1000 ? 'under 1' : Math.floor(age / 1000)}s ago` : 'No capture reported';
}
const windowLabel = lane => lane?.target ? targetLabel(lane.target) : 'Application window';
const connectionLabel = lane => lane.connection === 'live' ? 'Connected'
  : lane.connection === 'disconnected' ? 'Disconnected' : 'Waiting for connection';
const checkLabel = lane => lane.currentCheck
  ? `${lane.currentCheck.title}${lane.currentCheck.status ? ` · ${lane.currentCheck.status}` : ''}` : 'No current check';
async function refreshWindowPreview(view, card, id) {
  const version = card.lane.frameVersion;
  if (card.loading || !version || card.version === version || card.lane.connection !== 'live') return;
  const token = card.loading = {};
  const valid = () => windowView === view && view.cards.get(id) === card &&
    card.lane.connection === 'live' && card.loading === token;
  try {
    const response = await windowRequest(`${windowRoute}/${id}/frame`, view.controller.signal);
    if (!valid()) return;
    if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== 'image/jpeg') {
      clearWindowPreview(card); return;
    }
    const blob = await response.blob();
    if (!valid()) return;
    if (card.url) URL.revokeObjectURL(card.url);
    card.url = URL.createObjectURL(blob); card.version = version;
    card.image.src = card.url; card.image.hidden = false;
  } catch {
    if (valid()) clearWindowPreview(card);
  } finally {
    if (card.loading === token) card.loading = null;
  }
}
async function refreshWindows(view) {
  try {
    const lanes = await activeWindowLanes(view.controller.signal);
    if (windowView !== view) return;
    for (const [id, card] of view.cards) {
      if (lanes.has(id)) continue;
      clearWindowPreview(card); card.button.remove(); view.cards.delete(id);
    }
    view.receivedAt = performance.now();
    for (const [id, lane] of lanes) {
      const card = view.cards.get(id) ?? windowCard(view, id);
      view.cards.set(id, card);
      if (card.lane && !sameTarget(lane.target, card.lane.target)) {
        card.loading = null; clearWindowPreview(card);
        if (view.watched?.id === id) setLiveSource(null);
      }
      // A scoped stream rejection is retried only after a fresh overview still lists it as live.
      if (view.watched?.id === id && lane.connection === 'live') view.watched.streamStatus = null;
      card.lane = lane;
      card.title.textContent = lane.title || 'Window recording';
      card.target.textContent = windowLabel(lane);
      card.button.setAttribute('aria-label', `Watch ${card.title.textContent}, ${card.target.textContent}`);
      const owner = lane.owner === 'agent' ? 'Agent controls' : lane.owner === 'human' ? 'Human controls' : 'No controller';
      card.status.textContent = `${connectionLabel(lane)} · ${owner} · ${captureStatus(lane, view.receivedAt)}`;
      card.check.textContent = checkLabel(lane);
      if (lane.connection !== 'live' || !lane.frameVersion) { card.loading = null; clearWindowPreview(card); }
      else if (!view.automatic) void refreshWindowPreview(view, card, id);
    }
    $('windows-status').textContent = lanes.size
      ? `${lanes.size} active window ${lanes.size === 1 ? 'session' : 'sessions'} · Sampled screenshots`
      : 'No active window sessions. Completed runs are in Recordings.';
    view.ready = true;
    if (view.automatic) {
      for (const id of lanes.keys()) follow.seen.add(id);
      syncLiveSurface();
      await reconcileFollow(view);
    } else updateWindowWatch(view, true);
  } catch {
    if (windowView !== view) return;
    clearWindowCards(view);
    view.ready = false; view.confirmedEmpty = false;
    $('windows-status').textContent = 'Window sessions unavailable. Retrying…';
    if (view.automatic) syncLiveSurface();
    else updateWindowWatch(view, false);
  } finally {
    if (windowView === view) view.timer = setTimeout(() => refreshWindows(view), 1000);
  }
}
function watchWindow(view, id, focus = true) {
  const card = view === windowView && view.cards.get(id);
  if (!card) return;
  view.watched = { id, title: card.title.textContent };
  $('watch-display').hidden = true;
  $('window-viewer').append($('live-viewer'));
  $('window-watch').hidden = false;
  updateWindowWatch(view, true);
  if (focus) $('watch-title').focus();
}
function syncLiveSurface() {
  const view = windowView;
  if (tab !== 'live' || !view?.automatic) return;
  const shared = view.ready && !view.cards.size && (!follow.seen.size || sharedRun());
  $('windows-surface').hidden = Boolean(shared); $('shared-session').hidden = !shared;
  if (!shared) {
    const watched = view.cards.get(view.watched?.id);
    if (view.ready && (!watched || watched.lane.connection !== 'live')) {
      const next = [...view.cards.values()].find(c => c.lane.connection === 'live' && c !== watched)
        ?? (watched ? null : view.cards.values().next().value);
      if (next) watchWindow(view, next.lane.runId, false);
    }
    updateWindowWatch(view, view.ready);
    for (const [id, card] of view.cards) {
      card.button.hidden = view.cards.size === 1;
      if (id === view.watched?.id && !view.watched.streamStatus) {
        card.loading = null; clearWindowPreview(card);
      } else void refreshWindowPreview(view, card, id);
    }
    return;
  }
  const id = sharedRun();
  if (id) follow.seen.add(id);
  $('shared-viewer').append($('live-viewer'));
  const display = isDesktop(state?.target);
  $('watch-display').hidden = !display || !state.desktopAllowed || !validId(state.runId) || id === state.runId;
  if (id && state.connection === 'live') setLiveSource(sharedStream, id);
  else {
    setLiveSource(null);
    $('live-empty-title').textContent = display ? 'Whole display not being shared here' : 'Waiting for an authorized window';
    $('live-empty-detail').textContent = display ? 'Watching a whole display requires your explicit choice.'
      : 'When a scoped recording starts, its window appears automatically.';
  }
}
function sharedRun() {
  return validId(state?.runId) && (isWindow(state.target) ||
    isDesktop(state.target) && state.desktopAllowed && state.runId === chosenDisplay?.runId &&
      sameTarget(state.target, chosenDisplay.target)) ? state.runId : null;
}
const terminalResults = ['pass', 'fail', 'passed', 'failed', 'blocked', 'uncertain', 'interrupted'];
async function reconcileFollow(view) {
  const missing = [...follow.seen].filter(id => !follow.finished.has(id) && !view.cards.has(id) && id !== sharedRun());
  if (missing.length) {
    let saved;
    try {
      const response = await windowRequest('/api/recordings', view.controller.signal);
      if (response.ok) saved = await response.json();
    } catch { /* Retry without assuming a completion. */ }
    if (view !== windowView) return;
    for (const r of Array.isArray(saved?.runs) ? saved.runs : []) {
      if (missing.includes(r.runId) && terminalResults.includes(r.status) && !r.deletion?.pending && r.deletion?.reason !== 'run_active')
        follow.finished.set(r.runId, r);
    }
    if (!saved) view.confirmedEmpty = false;
  }
  renderFollowResults();
  const allFinished = follow.seen.size && follow.finished.size === follow.seen.size && !view.cards.size && !sharedRun();
  if (!allFinished) {
    view.confirmedEmpty = false;
    if (follow.seen.size && !view.cards.size && !sharedRun())
      $('windows-status').textContent = 'Waiting to confirm that the remaining recordings have ended…';
    return;
  }
  if (!view.confirmedEmpty) {
    view.confirmedEmpty = true;
    $('windows-status').textContent = 'All known recordings saved. Confirming no windows are still recording…';
    return;
  }
  const finished = [...follow.finished.values()];
  follow = { seen: new Set(), finished: new Map() };
  lastAutomaticGroup = new Set(finished.map(r => r.runId));
  if (finished.length === 1) {
    groupReview = null;
    surface('recordings');
    await loadRun(finished[0].runId, reviewStep(finished[0]), false, true).catch(e => tell(e.message, true));
  } else {
    groupReview = finished;
    if (!$('review').hidden) closeReview();
    surface('recordings');
    $('follow-title').focus();
  }
  history().catch(() => {});
}
const reviewStep = r => r.edit?.clips?.find(c => c.status === 'fail' && validId(c.stepId))?.stepId;
async function openFollowRecording(result) {
  followLive = false;
  const origin = tab, view = windowView, group = groupReview;
  let step = reviewStep(result);
  if (!step && result.counts?.fail) {
    try {
      const data = await task('qa_replay', { runId: result.runId, filter: 'failures', limit: 100 });
      step = data.items.find(c => c.status === 'fail' && validId(c.stepId))?.stepId;
    } catch { /* Recording review remains available without a resolved failure. */ }
  }
  if (tab === origin && view === windowView && group === groupReview) await loadRun(result.runId, step);
}
function renderFollowResults() {
  const final = tab === 'recordings' && groupReview && $('review').hidden;
  const rows = tab === 'live' ? [...follow.finished.values()] : final ? groupReview : [];
  const section = $('follow-results');
  section.hidden = !rows.length;
  document.body.classList.toggle('reviewing-group', Boolean(final));
  if (!rows.length) return;
  (final ? $('recording-group') : $('live-results')).append(section);
  $('follow-title').textContent = final ? 'QA results' : 'Finished recordings';
  $('all-recordings').hidden = !final;
  const outcomes = { pass: 'passed', fail: 'failed', blocked: 'blocked', uncertain: 'uncertain' };
  const counts = rows => Object.keys(outcomes).map(key => `${rows.reduce((n, r) => n + (r.counts?.[key] ?? 0), 0)} ${outcomes[key]}`).join(' · ');
  $('follow-counts').textContent = `${rows.length} ${rows.length === 1 ? 'recording' : 'recordings'} · Checks: ${counts(rows)}`;
  const cards = $('follow-cards');
  if (cards.dataset.runs === rows.map(r => r.runId).join(',')) return;
  cards.dataset.runs = rows.map(r => r.runId).join(',');
  cards.replaceChildren();
  for (const r of rows) {
    const row = node('li', 'follow-card');
    const outcome = node('strong', r.status, outcomes[r.status] ?? r.status);
    const button = node('button', '', r.counts?.fail ? 'Review failure' : 'Review checks');
    button.setAttribute('aria-label', `${button.textContent}: ${r.title}`);
    button.onclick = () => openFollowRecording(r).catch(e => tell(e.message, true));
    row.append(node('h2', '', r.title), outcome, node('p', 'muted', counts([r])), button);
    cards.append(row);
  }
}
bind('all-recordings', async () => {
  followLive = false;
  groupReview = null;
  renderFollowResults();
  await history();
});
function updateWindowWatch(view, available) {
  const watch = view.watched;
  for (const [id, card] of view.cards) card.button.setAttribute('aria-pressed', String(id === watch?.id));
  if (!watch) return;
  const lane = view.cards.get(watch.id)?.lane;
  if (lane) watch.title = lane.title || 'Window recording';
  const ended = available && !lane;
  const canStream = lane?.connection === 'live' && !watch.streamStatus;
  const status = !available ? 'Window status unavailable. Retrying…'
    : ended && view.automatic && !follow.finished.has(watch.id) ? 'Window not listed. Waiting for its recording status.'
    : ended ? 'This window session is no longer active.'
    : watch.streamStatus === 404 ? 'Window stream not ready. Retrying…'
    : watch.streamStatus ? 'Window stream access unavailable. Retrying…'
    : !canStream ? connectionLabel(lane) : '';
  $('watch-title').textContent = watch.title;
  $('watch-target').textContent = lane ? windowLabel(lane) + recordingScopeLabel(lane.recordingScope) : '';
  $('watch-check').textContent = lane ? checkLabel(lane) : '';
  $('watch-status').textContent = status; $('watch-status').hidden = !status;
  $('watch-recording').hidden = view.automatic || !ended;
  $('window-viewer').hidden = !canStream;
  setLiveSource(canStream ? `${windowRoute}/${watch.id}/stream` : null);
}
function recordingScopeLabel(scope) {
  if (!scope) return '';
  return scope.scope === 'display'
    ? ' · Recording: whole selected display' + (scope.reason === 'sole_window_session' ? ' · preview and input: selected window' : '')
    : ` · Recording: selected window (${scope.reason.replaceAll('_', ' ')})`;
}
bind('watch-back', async () => {
  const view = windowView;
  if (!view?.watched) return;
  const card = view.cards.get(view.watched.id);
  view.watched = null;
  $('window-watch').hidden = true;
  updateWindowWatch(view, true);
  setLiveSource(null);
  (card?.button ?? $('windows-title')).focus();
});
bind('watch-recording', async () => {
  if (windowView?.watched) await loadRun(windowView.watched.id);
});
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const unit = bytes < 1024 ** 2 ? 'KiB' : bytes < 1024 ** 3 ? 'MiB' : 'GiB';
  return `${(bytes / 1024 ** ({ KiB: 1, MiB: 2, GiB: 3 }[unit])).toFixed(1)} ${unit}`;
}
async function history() {
  const generation = ++libraryGeneration;
  $('library-status').hidden = false;
  $('library-status').textContent = 'Loading recordings…';
  $('recordings-empty').hidden = true;
  let result;
  try {
    result = await api('/api/recordings');
  } catch (error) {
    if (generation !== libraryGeneration) return;
    $('recordings-empty').hidden = true;
    $('library-status').textContent = `Recordings unavailable. ${error.message}. Use Refresh to retry.`;
    throw error;
  }
  if (generation !== libraryGeneration) return;
  $('library-status').hidden = true;
  $('run-count').textContent = result.total;
  if (result.storage) {
    const s = result.storage;
    $('storage-usage').textContent = `${formatBytes(s.totalBytes)} stored · source ${formatBytes(s.sourceBytes)} / ${formatBytes(s.sourceLimitBytes)} · exports ${formatBytes(s.exportBytes)} / ${formatBytes(s.exportLimitBytes)} · ${result.total} / ${s.maxRuns} recordings${s.measuringExports ? ' · export size changing' : ''}`;
    $('storage-usage').title = `${s.totalBytes.toLocaleString()} file-content bytes. Includes source frames, journals and all generated export files. Excludes filesystem metadata and allocation overhead. Refresh updates sizes.`;
  }
  $('recordings-empty').hidden = result.total !== 0;
  $('recording-cards').replaceChildren();
  for (const r of result.runs) {
    const row = node('div', 'recording-row');
    const card = node('button', 'recording-card'), poster = node('div', 'card-poster');
    card.setAttribute('aria-label', `Review ${r.title}, ${r.counts.pass} passed, ${r.counts.fail} failed`);
    if (r.export.status === 'ready' && r.export.version === QA_EDIT_VERSION) {
      const img = node('img'); img.src = `/api/runs/${r.runId}/qa-v5-poster.jpg`; img.alt = ''; poster.append(img);
    }
    poster.append(node('span', 'card-play', r.status === 'running' ? 'Recording' : 'Review'));
    const body = node('div', 'card-body'), title = node('h3', '', r.title);
    title.title = r.title; body.append(title);
    const outcomes = node('p');
    outcomes.append(node('span', r.counts.pass ? 'pass' : '', `${r.counts.pass} passed`),
      node('span', r.counts.fail ? 'fail' : '', `${r.counts.fail} failed`));
    if (r.counts.blocked + r.counts.uncertain)
      outcomes.append(node('span', 'uncertain', `${r.counts.blocked + r.counts.uncertain} blocked / uncertain`));
    body.append(outcomes);
    const meta = node('div', 'card-meta');
    if (!['pass', 'fail', 'passed', 'failed'].includes(r.status))
      meta.append(node('span', r.status, r.status));
    meta.append(node('span', '', `${formatTime(r.edit?.durationMs ?? 0)} QA · ${new Date(r.started).toLocaleDateString()}`));
    const size = node('span', '', formatBytes((r.sourceBytes ?? 0) + (r.exportBytes ?? 0)));
    size.title = `Source ${formatBytes(r.sourceBytes ?? 0)} · exports ${formatBytes(r.exportBytes ?? 0)}`;
    meta.append(size);
    body.append(meta); card.append(poster, body);
    card.disabled = !!r.deletion?.pending;
    card.onclick = () => loadRun(r.runId).catch(e => tell(e.message));
    const actions = node('div', 'recording-actions'), remove = node('button', 'delete-recording', r.deletion?.pending ? 'Retry deletion' : 'Delete');
    remove.setAttribute('aria-label', `Delete recording ${r.title}`);
    remove.disabled = !!r.deletion?.reason;
    const reason = r.deletion?.reason === 'run_active' ? 'Finish recording first'
      : r.deletion?.reason === 'export_busy' ? 'Wait for queued / encoding exports' : '';
    remove.title = reason || `Permanently delete ${r.title}`;
    remove.onclick = () => openDeletion(r, remove);
    actions.append(remove);
    if (reason) actions.append(node('span', 'fine', reason));
    if (r.deletion?.pending) actions.append(node('span', 'fine', 'Deletion incomplete · retry cleanup'));
    row.append(card, actions);
    $('recording-cards').append(row);
  }
}
bind('refresh', history);
function closeReview(restoreFocus = true) {
  dismissDialog();
  replayEntry.cancel();
  video.pause(); $('review').hidden = true; selectedRun = null; selectedStep = null; reviewGeneration++;
  historyReplace(''); loadedVideo = null; video.removeAttribute('src'); video.load();
  video.removeAttribute('poster'); $('preview').removeAttribute('src'); $('preview').hidden = true;
  run = null; checks = []; pageOffset = null;
  $('checks').replaceChildren(); $('segments').replaceChildren(); $('totals').replaceChildren();
  for (const id of ['download', 'source-download']) { $(id).removeAttribute('href'); $(id).hidden = true; }
  for (const id of ['review-title', 'review-outcome', 'review-summary', 'findings', 'selected-title', 'selected-result', 'selected-context']) $(id).textContent = '';
  for (const id of ['selected-expected', 'selected-actual']) $(id).textContent = '—';
  $('review-title').title = ''; $('review').setAttribute('aria-busy', 'false');
  $('review-details').open = false; $('playback-settings').open = false;
  navigating = false; document.body.classList.remove('reviewing');
  renderFollowResults();
  if (restoreFocus) (groupReview ? $('follow-title') : $('recording-cards')).focus();
}
bind('close-review', async () => { followLive = false; closeReview(); });
async function prepareDeletion(current) {
  $('delete-confirm').disabled = true; $('delete-retry').hidden = true;
  $('delete-status').textContent = 'Checking recording…';
  try {
    const result = await api(`/api/recordings/${current.runId}/confirm-delete`, {});
    if (deletionState !== current) return;
    current.confirmation = result.confirmation;
    $('delete-name').textContent = result.title;
    $('delete-status').textContent = 'This cannot be undone.';
    $('delete-confirm').disabled = false;
  } catch (e) {
    if (deletionState !== current) return;
    $('delete-status').textContent = `Cannot delete yet: ${e.message}.`;
    $('delete-retry').hidden = false;
  }
}
function openDeletion(recording, opener) {
  deletionState = { runId: recording.runId, opener, busy: false };
  $('delete-name').textContent = recording.title;
  $('delete-confirm').textContent = 'Delete permanently';
  $('delete-cancel').disabled = false;
  $('delete-dialog').showModal(); $('delete-cancel').focus();
  prepareDeletion(deletionState);
}
bind('delete-review', async () => openDeletion({ runId: selectedRun, title: run.title }, $('delete-review')));
$('delete-cancel').addEventListener('click', () => { if (!deletionState?.busy) $('delete-dialog').close(); });
$('delete-dialog').addEventListener('cancel', e => { if (deletionState?.busy) e.preventDefault(); });
$('delete-dialog').addEventListener('close', () => {
  const previous = deletionState; deletionState = null;
  if (previous?.opener?.isConnected) previous.opener.focus();
  else $('recording-cards').focus();
});
$('delete-retry').addEventListener('click', () => { if (deletionState) prepareDeletion(deletionState); });
$('delete-confirm').addEventListener('click', async () => {
  const current = deletionState;
  if (!current?.confirmation || current.busy) return;
  current.busy = true; $('delete-confirm').disabled = true; $('delete-cancel').disabled = true;
  $('delete-status').textContent = 'Deleting source and exports…';
  try {
    await api(`/api/recordings/${current.runId}/delete`, { confirmation: current.confirmation });
  } catch (e) {
    current.busy = false; $('delete-confirm').disabled = false; $('delete-cancel').disabled = false;
    $('delete-confirm').textContent = 'Retry deletion';
    $('delete-status').textContent = `Deletion is not confirmed complete: ${e.message}. Retry resumes only this recording’s cleanup.`;
    if (e.code === 'human_confirmation_required') {
      current.confirmation = null; $('delete-confirm').disabled = true; $('delete-retry').hidden = false;
      $('delete-status').textContent = 'Confirmation expired. Retry check, then confirm this recording again.';
    }
    return;
  }
  $('delete-dialog').close();
  if (selectedRun === current.runId) closeReview();
  tell('Recording permanently deleted.');
  try { await history(); } catch (e) { tell(`Recording deleted. Refresh the list to update storage. ${e.message}`, true); }
  $('recording-cards').focus();
});
async function loadRun(id, step, refresh = false, automatic = false) {
  if (refresh && navigating) return;
  if (!refresh) {
    if (!automatic) followLive = false;
    dismissDialog();
    replayEntry.cancel(); video.pause(); navigating = true;
    selectedRun = id; selectedStep = step ?? null;
    $('review').hidden = false; surface('recordings');
    $('review-content').hidden = true;
    $('review-title').textContent = 'Opening recording…';
    $('review-title').title = '';
    $('review-outcome').textContent = '';
    $('review-details').open = false;
    $('review').setAttribute('aria-busy', 'true');
    if (!automatic) deepLink(id, step);
  }
  const generation = refresh ? reviewGeneration : ++reviewGeneration;
  let result;
  try { result = await task('qa_replay', { runId: id, filter: 'checks', limit: 100, ...(step ? { stepId: step } : {}) }); }
  catch (error) {
    if (generation !== reviewGeneration) return;
    if (generation === reviewGeneration) {
      navigating = false; $('review').setAttribute('aria-busy', 'false');
      $('review-title').textContent = 'Recording unavailable';
      $('review-summary').textContent = `${error.message}. Check the local broker, then retry or return to recordings.`;
      $('review-details').open = true;
      $('retry-review').hidden = false;
    }
    throw error;
  }
  if (generation !== reviewGeneration) return;
  navigating = false; $('review').setAttribute('aria-busy', 'false'); $('retry-review').hidden = true;
  $('review-content').hidden = false;
  const changed = run?.runId !== id;
  selectedRun = id; run = result; checks = result.items; pageOffset = result.nextOffset;
  configureReview();
  $('review').hidden = false;
  $('review-title').textContent = result.title;
  $('review-title').title = result.title;
  $('review-outcome').textContent = `${result.counts.pass} passed · ${result.counts.fail} failed`;
  $('review-outcome').className = 'muted';
  $('failure').hidden = !result.counts.fail;
  $('review-summary').textContent = `${['pass', 'fail', 'passed', 'failed'].includes(result.status) ? '' : result.status + ' · '}QA review ${formatTime(result.edit?.durationMs ?? 0)} · source ${formatTime(result.durationMs)} · ${result.context || 'Selected application window'}${result.recordingContextFrames ? ' · Includes whole-display recording context during sole-session intervals' : ''}`;
  $('seek').max = Math.max(0.1, (result.edit?.durationMs ?? 0) / 1000);
  $('source-download').href = `/api/runs/${id}/recording.mp4`;
  $('source-download').download = recordingFilename(result.title, id, 'recording.mp4');
  $('source-download').hidden = result.sourceExport?.status !== 'ready';
  $('delete-review').disabled = result.status === 'running' ||
    [result.export?.status, result.sourceExport?.status].some(s => ['queued', 'encoding'].includes(s));
  $('delete-review').title = $('delete-review').disabled ? 'Finish recording and wait for all exports before deleting' : 'Permanently delete this recording';
  $('more-checks').hidden = pageOffset === null;
  $('totals').replaceChildren();
  for (const status of ['pass', 'fail', 'blocked', 'uncertain']) {
    if (result.counts[status]) $('totals').append(node('span', status, `${result.counts[status]} ${status === 'pass' ? 'passed' : status === 'fail' ? 'failed' : status}`));
  }
  const failed = checks.find(c => c.status !== 'pass');
  $('findings').textContent = failed ? `${failed.title}: expected ${failed.expected}, observed ${failed.actual ?? 'unavailable'}. ${failed.context || 'Inspect the evidence before deciding what to change.'}`
    : checks.length ? 'Recorded assertions passed. Review the evidence and the overall run outcome before drawing broader conclusions.' : 'No completed checks yet. Actions alone do not prove an application outcome.';
  renderChecks();
  if (result.export.status === 'ready' && result.export.version === QA_EDIT_VERSION && result.edit?.version === QA_EDIT_VERSION && result.edit?.available && result.edit.clips.length) {
    $('player-empty').hidden = true; video.hidden = false; $('preview').hidden = true;
    const src = `/api/runs/${id}/qa-v5-recording.mp4#export=${result.export.version}-${result.export.encodedAt ?? 0}`;
    if (loadedVideo !== src) {
      video.pause(); video.src = src; loadedVideo = src; video.load();
    }
    $('download').href = src; $('download').hidden = false;
    $('download').download = recordingFilename(result.title, id, `qa-v${QA_EDIT_VERSION}-recording.mp4`);
    $('export-status').textContent = `Portable H.264 MP4 · ${(result.export.bytes / 1024 / 1024).toFixed(1)} MiB · clean recorded frames and cursor only; review pauses and gaps are documented separately.`;
  } else {
    video.pause(); video.hidden = true; loadedVideo = null; video.removeAttribute('src'); video.load();
    $('player-empty').hidden = false; $('download').hidden = true;
    $('export-message').textContent = !result.edit?.available ? result.edit?.reason || 'QA edit metadata unavailable. Update the broker; full-session video is never substituted.'
      : !result.edit.clips.length ? 'No completed passing or failing QA checks. No QA video was created.'
      : result.export.status === 'ready' && (result.export.version !== QA_EDIT_VERSION || result.edit.version !== QA_EDIT_VERSION)
      ? 'Saved video presentation is not compatible. Refresh the workspace and prepare the current video.'
      : result.export.status === 'error'
      ? `Export needs attention: ${result.export.code.replaceAll('_', ' ')}. Native input is not repeated by retrying.`
      : result.status === 'running' ? 'This run is still recording. Finish it to prepare the portable video.'
        : ['queued', 'encoding'].includes(result.export.status) ? 'Preparing the QA-only video. The checklist is ready to inspect.' : 'Prepare a QA-only video from the saved journal.';
    $('export').hidden = !result.edit?.available || !result.edit.clips.length || result.status === 'running' || ['queued', 'encoding'].includes(result.export.status);
    $('export-status').textContent = `Export: ${result.export.status}. No live Mac connection is needed to export a finished run.`;
  }
  if (!refresh && step && result.selected) {
    if (!checks.some(c => c.stepId === step)) checks.push(result.selected);
    selectedStep = step;
    const target = clipFor(step)?.startMs ?? null;
    if (target !== null) seek(target, false);
    showCheck(result.selected); renderChecks();
  } else if (!refresh && changed) { selectedStep = null; seek(0, false); }
  if (!refresh && tab === 'recordings') {
    if (!automatic) deepLink(id, step);
    window.scrollTo(0, 0);
    const target = result.selected ? (clipFor(result.selected.stepId)?.startMs ?? null) : 0;
    if (target !== null && result.edit?.available && result.edit.clips.length &&
        result.edit.version === QA_EDIT_VERSION && result.export.version === QA_EDIT_VERSION) await replayEntry.openMilliseconds(target);
  }
}
bind('retry-review', async () => loadRun(selectedRun, selectedStep));
function selectCheck(check) {
  followLive = false;
  replayEntry.cancel();
  selectedStep = check.stepId;
  const clip = clipFor(check.stepId);
  if (clip) seek(clip.startMs, false); else video.pause();
  showCheck(check);
  deepLink(selectedRun, selectedStep); renderChecks();
}
function renderChecks() {
  const filter = $('filter').value;
  $('checks').replaceChildren(); $('segments').replaceChildren();
  for (const clip of run.edit?.clips ?? []) {
    const c = checks.find(c => c.stepId === clip.stepId) ?? clip;
    const segment = node('button', clip.status); segment.title = `${clip.title}: ${clip.status}`;
    segment.style.left = `${100 * clip.startMs / run.edit.durationMs}%`;
    segment.style.width = `${100 * (clip.endMs - clip.startMs) / run.edit.durationMs}%`;
    segment.setAttribute('aria-label', `Seek to ${clip.title}, ${clip.status}`);
    let origin = null, dragged = false;
    segment.addEventListener('pointerdown', event => {
      if (event.button !== 0 || $('seek').disabled) return;
      origin = event.clientX; dragged = false; segment.setPointerCapture(event.pointerId);
    });
    segment.addEventListener('pointermove', event => {
      if (origin === null) return;
      if (Math.abs(event.clientX - origin) >= 3) dragged = true;
      if (!dragged) return;
      const bounds = $('segments').getBoundingClientRect();
      replayEntry.cancel(); seek((event.clientX - bounds.left) / bounds.width * run.edit.durationMs);
    });
    segment.addEventListener('pointerup', () => { origin = null; });
    segment.addEventListener('pointercancel', () => { origin = null; dragged = true; });
    segment.onclick = event => {
      if (!dragged || event?.detail === 0) selectCheck(c);
      dragged = false;
    };
    $('segments').append(segment);
  }
  for (const c of checks) {
    const clip = clipFor(c.stepId);
    if (filter !== 'all' && !(filter === 'blocked' ? ['blocked', 'uncertain'].includes(c.status) : c.status === filter)) continue;
    const li = node('li'), button = node('button', `check ${c.status}${c.stepId === selectedStep ? ' selected' : ''}`);
    button.dataset.step = c.stepId; button.setAttribute('aria-current', String(c.stepId === selectedStep));
    button.append(node('span', 'check-icon', c.status === 'pass' ? '✓' : c.status === 'fail' ? '×' : '!'));
    button.setAttribute('aria-label', `${c.title}, ${c.status}, ${clip ? 'video ' + formatTime(clip.startMs) : 'no QA clip'}`);
    button.title = c.title;
    const content = node('span', 'check-content'); content.append(node('span', 'check-name', c.title),
      node('span', 'check-value', clip ? formatTime(clip.startMs) : 'No QA clip'));
    button.append(content); button.onclick = () => selectCheck(c); li.append(button); $('checks').append(li);
  }
  if (!$('checks').children.length) $('checks').append(node('li', 'empty', 'No checks match this filter.'));
  for (const option of $('filter').options) {
    const count = option.value === 'all' ? Object.values(run.counts).reduce((a, b) => a + b, 0)
      : option.value === 'blocked' ? run.counts.blocked + run.counts.uncertain : run.counts[option.value];
    option.textContent = `${{ all: 'All checks', pass: 'Passed', fail: 'Failed', blocked: 'Blocked / uncertain' }[option.value]} (${count})`;
  }
}
$('filter').addEventListener('change', renderChecks);
bind('more-checks', async () => {
  if (pageOffset === null) return;
  const generation = reviewGeneration;
  const result = await task('qa_replay', { runId: selectedRun, offset: pageOffset, filter: 'checks', limit: 100 });
  if (generation !== reviewGeneration) return;
  checks = [...new Map([...checks, ...result.items].map(c => [c.stepId, c])).values()].sort((a, b) => a.startedMs - b.startedMs);
  pageOffset = result.nextOffset; $('more-checks').hidden = pageOffset === null; renderChecks();
});
function seek(ms, updateHash = false) {
  const seconds = Math.max(0, Math.min(ms / 1000, run?.edit?.durationMs / 1000 || 0));
  if (selectedStep && !clipFor(selectedStep)) selectedStep = null;
  if (loadedVideo && video.readyState > 0) video.currentTime = seconds;
  else replayEntry.openMilliseconds(seconds * 1000, false);
  $('seek').value = seconds; synchronize(seconds);
  if (updateHash && selectedRun) deepLink(selectedRun, selectedStep);
}
function showCheck(c) {
  const clip = c ? clipFor(c.stepId) : null;
  $('selected-title').textContent = c?.title ?? 'QA check';
  $('selected-context').textContent = `${c?.kind === 'visual' ? `Visual assessment by ${c.assessment.actor}; not server-verified. ` : ''}${clip ? `Assertion source ${formatTime(clip.sourceStartMs)}–${formatTime(clip.sourceEndMs)}. ${clip.evidenceNote ?? ''} ` : ''}${c?.context || c?.reason?.replaceAll('_', ' ') || ''}`;
  $('selected-result').textContent = c ? `${c.status.toUpperCase()}${clip ? '' : ' · No QA clip'}` : 'No loaded check';
  $('selected-result').className = c?.status ?? 'muted';
  $('selected-expected').textContent = c?.expected ?? '—';
  $('selected-actual').textContent = c ? c.actual ?? 'Unavailable' : '—';
}
function synchronize(seconds) {
  $('seek').value = seconds;
  $('time').textContent = `${formatTime(seconds * 1000)} / ${formatTime(run?.edit?.durationMs ?? 0)}`;
  const segment = qaSegmentAt(run?.edit, Math.min(seconds * 1000, Math.max(0, (run?.edit?.durationMs ?? 0) - 0.001)));
  $('pacing-state').textContent = segment?.kind === 'review-hold' ? 'Review pause' : 'Recorded interval';
  $('pacing-state').title = segment?.kind === 'review-hold'
    ? 'Time to inspect a held recorded frame, not continued capture. Check details remain below the video.'
    : 'Original recorded timing. Missing footage remains blank and is identified in the provenance.';
  if (video.paused && selectedStep && !clipFor(selectedStep)) return;
  // Chromium truncates media time to microseconds; keep a cut on its new check.
  const clip = qaClipAt(run?.edit, Math.min(seconds * 1000 + 0.001, Math.max(0, (run?.edit?.durationMs ?? 0) - 0.001)));
  const c = checks.find(c => c.stepId === clip?.stepId) ?? clip;
  showCheck(c);
  if ((c?.stepId ?? null) !== selectedStep) {
    selectedStep = c?.stepId ?? null;
    for (const button of $('checks').querySelectorAll('button')) {
      const selected = button.dataset.step === selectedStep; button.classList.toggle('selected', selected); button.setAttribute('aria-current', String(selected));
    }

  }
}
video.addEventListener('timeupdate', () => synchronize(video.currentTime));
function playbackState(label) {
  const ready = Boolean(loadedVideo && video.readyState > 0 && !video.error);
  $('pacing-state').hidden = !ready;
  $('play').disabled = !ready; $('seek').disabled = !ready; $('speed').disabled = !ready;
  $('play').setAttribute('data-playing', String(!video.paused));
  $('play').setAttribute('aria-label', video.paused ? 'Play recording' : 'Pause recording');
  video.setAttribute('aria-label', video.paused ? 'Recording. Click or press Space to play' : 'Recording. Click or press Space to pause');
  $('replay-play').hidden = !ready || !video.paused;
  $('replay-play').setAttribute('aria-label', video.ended ? 'Replay recording' : 'Play recording');
  $('media-state').textContent = label ?? (!ready && loadedVideo ? 'Loading…' : '');
  $('media-state').hidden = !$('media-state').textContent;
}
for (const event of ['play', 'pause', 'ended', 'loadedmetadata', 'canplay', 'emptied'])
  video.addEventListener(event, () => playbackState());
video.addEventListener('waiting', () => playbackState('Buffering…'));
video.addEventListener('seeking', () => playbackState('Seeking…'));
video.addEventListener('seeked', () => playbackState());
video.addEventListener('playing', () => {
  playbackState();
  if ($('message').textContent.startsWith('Recording ready at the selected check.')) $('message').hidden = true;
});
video.addEventListener('error', () => {
  playbackState('Video unavailable');
  tell('The recording could not load. Retry opening it, or check broker access and download the MP4.', true);
  $('retry-review').hidden = false; loadedVideo = null;
});
video.addEventListener('click', () => togglePlay().catch(error => tell(error.message, true)));
$('fullscreen').hidden = !document.fullscreenEnabled;
playbackState();
$('seek').addEventListener('input', () => { replayEntry.cancel(); seek(Number($('seek').value) * 1000); });
function configureReview() {
  video.playbackRate = Number($('speed').value) || 1;
  $('review-estimate').textContent = `${formatTime(run?.edit?.durationMs ?? 0)} QA review · ${formatTime(run?.edit?.presentationMs ?? 0)} reading pauses · ${formatTime(run?.durationMs ?? 0)} source. At least 8 seconds per check at 1×.`;
}
$('speed').addEventListener('change', configureReview);
async function togglePlay() {
  replayEntry.cancel();
  if (!loadedVideo || video.readyState < 1) throw new Error('The video must finish exporting before playback.');
  if (video.paused) { if (video.ended) video.currentTime = 0; await video.play(); } else video.pause();
}
function adjacent(direction) {
  if (!checks.length) return;
  const index = checks.findIndex(c => c.stepId === selectedStep);
  selectCheck(checks[Math.max(0, Math.min(checks.length - 1, index + direction))]);
}
bind('play', togglePlay);
bind('replay-play', togglePlay);
bind('previous', async () => adjacent(-1));
bind('next', async () => adjacent(1));
bind('failure', async () => {
  const failed = checks.filter(c => c.status === 'fail');
  if (!failed.length) return tell('No failed check in the loaded checklist. Load more checks if available.');
  selectCheck(failed.find(c => (clipFor(c.stepId)?.startMs ?? -1) > video.currentTime * 1000 + 1) ?? failed[0]);
});
bind('fullscreen', async () => {
  if (!$('player-shell').requestFullscreen) throw new Error('Fullscreen is unavailable in this browser pane.');
  await $('player-shell').requestFullscreen();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('results-dialog').open && !$('delete-dialog').open) {
    for (const id of ['review-details', 'playback-settings']) {
      if ($(id).open) { $(id).open = false; $(id + '-toggle').focus(); e.preventDefault(); return; }
    }
  }
  if ($('results-dialog').open || $('delete-dialog').open || tab !== 'recordings' || $('review').hidden || /INPUT|TEXTAREA|SELECT|BUTTON/.test(document.activeElement.tagName) || document.activeElement.isContentEditable || e.ctrlKey || e.metaKey || e.altKey) return;
  if ([' ', 'ArrowLeft', 'ArrowRight', '[', ']', 'f'].includes(e.key)) e.preventDefault();
  if (e.key === ' ') togglePlay().catch(error => tell(error.message));
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') seek(video.currentTime * 1000 + (e.key === 'ArrowLeft' ? -5000 : 5000));
  if (e.key === '[' || e.key === ']') adjacent(e.key === '[' ? -1 : 1);
  if (e.key === 'f') $('fullscreen').click();
});
for (const id of ['review-details', 'playback-settings']) {
  document.addEventListener('click', event => {
    if ($(id).open && !$(id).contains(event.target)) $(id).open = false;
  });
}
bind('export', async () => {
  await task('qa_report', { runId: selectedRun, export: true, retryExport: true }); await loadRun(selectedRun, selectedStep, true);
});
function dismissDialog() {
  dialogState = null;
  if ($('results-dialog').open) $('results-dialog').close();
}
function openDialog(kind, opener) {
  replayEntry.cancel();
  const resume = !video.paused;
  video.pause();
  dialogState = { kind, opener, runId: selectedRun, generation: reviewGeneration,
    time: video.currentTime, resume, offset: 0, nextOffset: null, request: 0, text: '' };
  $('dialog-title').textContent = kind === 'results' ? 'QA results JSON' : 'Chat report preview';
  $('dialog-subtitle').textContent = run?.title ?? '';
  $('dialog-content').setAttribute('aria-label', kind === 'results' ? 'QA results JSON' : 'Chat report');
  $('results-dialog').showModal();
  $('dialog-close').focus();
  return loadDialog();
}
async function loadDialog(offset = dialogState?.offset ?? 0) {
  const current = dialogState;
  if (!current) return;
  const request = ++current.request; current.offset = offset; current.text = '';
  $('dialog-status').textContent = 'Loading recorded QA outcomes…';
  $('dialog-content').textContent = '';
  $('dialog-retry').hidden = true; $('dialog-copy').disabled = true;
  $('dialog-previous').hidden = true; $('dialog-next').hidden = true;
  try {
    const result = current.kind === 'results'
      ? await task('qa_replay', { runId: current.runId, filter: 'results', offset, limit: 100 })
      : await task('qa_report', { runId: current.runId, export: false });
    if (dialogState !== current || current.request !== request) return;
    if (current.kind === 'results') {
      current.nextOffset = result.nextOffset;
      current.text = JSON.stringify(result, null, 2);
      const c = result.checks, e = result.operationalErrors;
      const partial = c.total > c.items.length || e.total > e.items.length;
      $('dialog-status').textContent = `${result.counts.pass} passed · ${result.counts.fail} failed · ${result.counts.blocked} blocked · ${result.counts.uncertain} uncertain. `
        + `Showing ${c.items.length} of ${c.total} checks and ${e.items.length} of ${e.total} operational errors`
        + (partial ? ` (page ${Math.floor(offset / 100) + 1}). Other pages may contain failures. Copy includes this page only.` : '. All results included.');
      $('dialog-previous').hidden = offset === 0;
      $('dialog-next').hidden = result.nextOffset === null;
      $('dialog-copy').textContent = partial ? 'Copy page JSON' : 'Copy JSON';
    } else {
      current.text = result.reportMarkdown;
      $('dialog-status').textContent = 'Review before copying. Nothing is sent automatically. Links open check footage. Outcomes are shown in the playback bar and checklist.';
      $('dialog-copy').textContent = 'Copy report';
    }
    $('dialog-content').textContent = current.text;
    $('dialog-copy').disabled = false;
  } catch (error) {
    if (dialogState !== current || current.request !== request) return;
    $('dialog-status').textContent = `Results unavailable: ${error.message}. Check the local broker and retry.`;
    $('dialog-retry').hidden = false;
  }
}
$('dialog-close').addEventListener('click', () => $('results-dialog').close());
$('results-dialog').addEventListener('keydown', event => {
  if (event.key !== 'Tab') return;
  const focusable = ['dialog-close', 'dialog-content', 'dialog-retry', 'dialog-previous', 'dialog-next', 'dialog-copy']
    .map($).filter(element => !element.hidden && !element.disabled);
  if (event.shiftKey && document.activeElement === focusable[0]) {
    event.preventDefault(); focusable.at(-1).focus();
  } else if (!event.shiftKey && document.activeElement === focusable.at(-1)) {
    event.preventDefault(); focusable[0].focus();
  }
});
$('results-dialog').addEventListener('close', () => {
  const previous = dialogState; dialogState = null;
  if (!previous) return;
  previous.opener.focus();
  if (previous.runId === selectedRun && previous.generation === reviewGeneration) {
    if (loadedVideo && video.readyState > 0 && video.currentTime !== previous.time) seek(previous.time * 1000);
    if (previous.resume && loadedVideo) video.play().catch(() => tell('Playback paused. Click Play to resume.', true));
  }
});
$('results-json').addEventListener('click', () => openDialog('results', $('results-json')));
$('copy-report').addEventListener('click', () => openDialog('report', $('copy-report')));
bind('dialog-retry', async () => loadDialog());
bind('dialog-previous', async () => loadDialog(Math.max(0, dialogState.offset - 100)));
bind('dialog-next', async () => loadDialog(dialogState.nextOffset));
bind('dialog-copy', async () => {
  if (!dialogState?.text) return;
  const current = dialogState;
  try {
    await navigator.clipboard.writeText(current.text);
    if (dialogState === current) $('dialog-status').textContent = 'Copied. Nothing has been sent automatically.';
  } catch {
    if (dialogState !== current) return;
    $('dialog-status').textContent = 'Clipboard unavailable. Select and copy the text below manually.';
    $('dialog-content').focus();
  }
});
function selectableTargets() {
  return [...(state?.windows ?? []).filter(isWindow),
    ...(state?.desktopAllowed ? (state.displays ?? []).filter(isDesktop) : [])];
}
const targetValue = target => JSON.stringify(targetIdentity(target));
function updateControls() {
  const active = Boolean(state?.runId), human = state?.owner === 'human';
  $('shared-controls').hidden = active && isDesktop(state.target) && !sharedRun();
  const count = !state?.target || state.target.bundleId === 'com.factory.applets.RelayMac';
  $('start').hidden = active; $('run-setup').hidden = active;
  $('start').disabled = !selectableTargets().some(t => targetValue(t) === $('targets').value);
  $('finish').disabled = !active || !human;
  $('take').hidden = !active || human;
  $('release').hidden = !active || !human;
  $('human-tools').hidden = !active || !human;
  $('observe').disabled = !active || !human;
  $('act').disabled = !active || !human || !observationId || !count;
  $('check').disabled = !active || !human || !count;
  $('control-hint').textContent = !active ? 'Start a recording, or open a saved run in Recordings.'
    : human ? count ? 'You control this run. Observe before each input.'
      : 'You control this run. Generic mouse and visual checks use the shared QA API; sample count controls are disabled.'
      : 'Watching the agent. Take control to interact without starting a new recording.';
}
updateControls();
async function updateStatus() {
  state = await api('/api/status'); lastStatusAt = performance.now();
  $('service').textContent = 'Local broker connected';
  $('connection').textContent = state.connection === 'live' ? 'Connected' : state.connection;
  const targets = [...(state.displays ?? []), ...state.windows];
  $('target-name').textContent = state.target ? targetLabel(targets.find(t => sameTarget(t, state.target)) ?? state.target)
    + (state.runId ? recordingScopeLabel(state.recordingScope) : '') : 'Target not selected';
  $('owner').textContent = state.owner === 'human' ? 'You' : state.owner === 'agent' ? 'Agent' : 'Observer only';
  $('recording').textContent = state.runId ? 'Recording' : 'Not recording';
  $('recording').className = state.runId ? 'pass' : '';
  if (state.currentCheck) {
    $('current-check').textContent = state.currentCheck.title || 'Count check';
    $('check-result').textContent = state.currentCheck.kind === 'assertion' ? `${state.currentCheck.status.toUpperCase()} · expected ${state.currentCheck.expected}, observed ${state.currentCheck.actual ?? 'unavailable'}` : 'Checking native state…';
    $('check-result').className = state.currentCheck.status ?? '';
  }
  if (state.owner !== 'human') observationId = undefined;
  const previous = $('targets').value;
  const available = selectableTargets();
  $('targets').replaceChildren(new Option('Choose an authorized target', ''));
  for (const target of available) $('targets').add(new Option(targetLabel(target), targetValue(target)));
  const windows = available.filter(isWindow);
  $('targets').value = available.some(t => targetValue(t) === previous) ? previous
    : windows.length === 1 ? targetValue(windows[0]) : '';
  updateControls();
  syncLiveSurface();
  if (state.error) $('service').textContent = state.error.replaceAll('_', ' ');
}
// `presented` remains the aggregate of canvas draws and JPEG swaps for older diagnostics.
// Neither those operations nor an animation callback report what reached the compositor.
const liveStats = { received: 0, presented: 0, replaced: 0, dropped: 0, serverDropped: 0, fps: 0,
  videoReceived: 0, decodeSkipped: 0, decoded: 0, paintReplaced: 0, paintExpired: 0, firstPresentedMs: null,
  canvasDrawn: 0, rafCanvasDrawn: 0, fallbackCanvasDrawn: 0, jpegSwaps: 0, compositorPaints: null,
  mode: 'starting', windowStart: performance.now(), windowPresented: 0 };
window.qaLiveStats = liveStats;
let liveSource = null, liveNext = null, livePresenting = false;
let videoDecoder = null, videoDescription = null, videoCodec = null, videoBroken = false, canvasActive = false;
let videoAwaitKey = false;
const liveCanvas = $('live-canvas');
const liveContext = liveCanvas.getContext('2d');
let cursorTimer = null, liveCue = null;
function clearCursor() {
  clearTimeout(cursorTimer); cursorTimer = null; liveCue = null;
  $('input-cue').hidden = true;
  $('input-marker').hidden = true;
}
function showCursor(header, source) {
  clearCursor();
  const cue = header.cue, id = source.runId ?? source.path.match(/[a-f0-9]{32}/)?.[0];
  if (document.hidden || !cue || cue.runId !== id || !['agent', 'human'].includes(cue.actor) ||
      !Number.isFinite(header.sourceMs) || cue.endMs <= header.sourceMs) return;
  liveCue = cue;
  $('input-cue').textContent = `${CUE_LEGEND} · ${cueLabel(cue)}`;
  $('input-cue').hidden = false;
  const marker = $('input-marker');
  if (cue.point && cue.geometry && [cue.point.x, cue.point.y].every(n => Number.isFinite(n) && n >= 0 && n <= 1)) {
    const box = $('live-screen').getBoundingClientRect();
    const width = box.width, height = box.height;
    if (width > 0 && height > 0) {
      const set = point => {
        const p = fitPoint(point, cue.geometry.width, cue.geometry.height, width, height);
        marker.style.left = `${p.x}px`; marker.style.top = `${p.y}px`;
      };
      marker.dataset.actor = cue.actor; marker.dataset.status = cue.status;
      marker.hidden = false;
      set(cue.from ?? cue.point);
      if (cue.from) {
        marker.getBoundingClientRect();
        set(cue.point);
      }
    }
  }
  cursorTimer = setTimeout(clearCursor, Math.min(900, cue.endMs - header.sourceMs));
}
document.addEventListener('visibilitychange', () => { if (document.hidden) clearCursor(); });
window.addEventListener('resize', clearCursor);
// Absorb a small decode burst without replaying old frames after a slow display tick.
const maxPaintFrames = 3, maxPaintAgeMs = 50;
const rafGraceMs = 42, fallbackIntervalMs = 33;
const paintFrames = [];
let paintTurn = null, lastCanvasDrawAt = -Infinity;
function setLiveSource(path, runId) {
  if ((liveSource?.path ?? null) !== path || liveSource?.runId !== runId) {
    liveSource?.controller.abort();
    clearCursor();
    videoClose();
    liveSource = path ? { path, runId, controller: new AbortController(), lastFrameAt: null } : null;
    liveNext = null; livePresenting = false; canvasActive = false;
    liveCanvas.hidden = true; $('live').hidden = true; $('live-empty').hidden = false; $('stale').hidden = true;
    liveContext?.clearRect(0, 0, liveCanvas.width, liveCanvas.height);
    if (liveURL) URL.revokeObjectURL(liveURL);
    liveURL = null; $('live').removeAttribute('src');
    $('live-mode').textContent = '';
    liveStats.fps = 0; liveStats.windowPresented = 0; liveStats.windowStart = performance.now();
  }
  const source = liveSource;
  if (!source || source.busy) return;
  const watch = path !== sharedStream;
  $('live-empty-title').textContent = watch ? 'Waiting for window capture' : 'No shared frame';
  $('live-empty-detail').textContent = watch ? 'Only the selected window appears here.'
    : 'Only the selected target appears here.';
  $('frame-age').textContent = 'Waiting for capture';
  source.busy = true;
  streamLive(source).catch(() => {}).finally(() => {
    source.busy = false;
    if (liveSource === source && watch) $('live-mode').textContent = 'Window stream interrupted · retrying';
  });
}
function noteUpdate() {
  liveStats.presented++; liveStats.windowPresented++;
  const now = performance.now();
  if (liveSource) liveSource.lastFrameAt = now;
  liveStats.firstPresentedMs ??= now;
  if (now - liveStats.windowStart >= 1000) {
    liveStats.fps = liveStats.windowPresented * 1000 / (now - liveStats.windowStart);
    liveStats.windowStart = now; liveStats.windowPresented = 0;
  }
}
function discardPaintFrame(reason) {
  paintFrames.shift().frame.close();
  liveStats.dropped++;
  if (reason) liveStats[reason]++;
}
function clearPaintFrames() {
  if (paintTurn) {
    cancelAnimationFrame(paintTurn.raf);
    clearTimeout(paintTurn.timer);
    paintTurn = null;
  }
  while (paintFrames.length) discardPaintFrame();
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearPaintFrames();
  else presentLive();
});
function videoClose() {
  const decoder = videoDecoder;
  videoDecoder = null; videoDescription = null; videoCodec = null;
  if (decoder && decoder.state !== 'closed') decoder.close();
  clearPaintFrames();
}
/** Fail closed to the JPEG snapshot path and say so visibly; no partial video state remains. */
function videoFail(note) {
  videoClose();
  videoBroken = true;
  liveStats.mode = 'jpeg';
  $('live-mode').textContent = note;
  presentLive();
}
function onVideoFrame(frame) {
  liveStats.decoded++;
  if (document.hidden) { frame.close(); liveStats.dropped++; return; }
  const now = performance.now();
  expirePaintFrames(now);
  if (paintFrames.length === maxPaintFrames) discardPaintFrame('paintReplaced');
  paintFrames.push({ frame, at: now });
  schedulePaint(now);
}
function expirePaintFrames(now) {
  while (paintFrames.length && now - paintFrames[0].at > maxPaintAgeMs) discardPaintFrame('paintExpired');
}
function schedulePaint(now) {
  if (!paintFrames.length || document.hidden) return;
  if (!paintTurn) {
    const turn = paintTurn = { deadline: now + rafGraceMs, timer: null };
    turn.raf = requestAnimationFrame(() => {
      if (paintTurn !== turn) return;
      clearTimeout(turn.timer);
      paintTurn = null;
      if (document.hidden) { clearPaintFrames(); return; }
      drawVideo(false, performance.now());
      schedulePaint(performance.now());
    });
  }
  const turn = paintTurn;
  const due = Math.max(turn.deadline, lastCanvasDrawAt + fallbackIntervalMs);
  if (now >= due) {
    clearTimeout(turn.timer);
    turn.timer = null;
    // Keep one rAF pending to detect recovery. Decode also checks this deadline if the timer stalls.
    drawVideo(true, now);
  } else if (turn.timer === null) {
    turn.timer = setTimeout(() => {
      if (paintTurn !== turn) return;
      turn.timer = null;
      if (document.hidden) { clearPaintFrames(); return; }
      schedulePaint(performance.now());
    }, Math.ceil(due - now));
  }
}
function drawVideo(fallback, now) {
  expirePaintFrames(now);
  if (!paintFrames.length) return;
  if (fallback) while (paintFrames.length > 1) discardPaintFrame('paintReplaced');
  const { frame } = paintFrames.shift();
  try {
    if (liveCanvas.width !== frame.displayWidth) liveCanvas.width = frame.displayWidth;
    if (liveCanvas.height !== frame.displayHeight) liveCanvas.height = frame.displayHeight;
    liveContext.drawImage(frame, 0, 0);
  } catch {
    liveStats.dropped++;
    videoFail('H.264 presentation failed · showing JPEG snapshots');
    return;
  } finally {
    frame.close();
  }
  canvasActive = true;
  liveCanvas.hidden = false; $('live').hidden = true; $('live-empty').hidden = true;
  lastCanvasDrawAt = now;
  liveStats.canvasDrawn++;
  liveStats[fallback ? 'fallbackCanvasDrawn' : 'rafCanvasDrawn']++;
  noteUpdate();
}
function handleVideo(header, image) {
  try {
    const nals = parseAnnexB(image);
    if (header.keyframe) {
      const { sps, pps } = parameterSets(image, nals);
      const description = avccDescription(sps, pps);
      const codec = codecString(sps);
      if (!videoDecoder || videoCodec !== codec || !equalBytes(videoDescription, description)) {
        videoClose();
        const decoder = new VideoDecoder({
          output: frame => { if (videoDecoder === decoder) onVideoFrame(frame); else frame.close(); },
          error: () => {
            if (videoDecoder === decoder) videoFail('H.264 decode failed · showing JPEG snapshots');
          },
        });
        videoDecoder = decoder;
        decoder.configure({ codec, description, optimizeForLatency: true });
        videoCodec = codec; videoDescription = description;
      }
    }
    if (!videoDecoder || videoDecoder.state !== 'configured') return;
    // Later deltas reference a dropped one, so decoding resumes only at the next keyframe.
    if (header.keyframe) videoAwaitKey = false;
    else if (videoAwaitKey || videoDecoder.decodeQueueSize > 4) { videoAwaitKey = true; liveStats.dropped++; liveStats.decodeSkipped++; return; }
    videoDecoder.decode(new EncodedVideoChunk({ type: header.keyframe ? 'key' : 'delta',
      timestamp: Math.max(0, Math.round((header.captureTimeSeconds ?? 0) * 1e6)),
      data: annexbToAvcc(image, nals) }));
  } catch {
    videoFail('H.264 decode failed · showing JPEG snapshots');
  }
}
const videoOwnsSurface = () => canvasActive && !videoBroken;
async function presentLive() {
  if (livePresenting || videoOwnsSurface() || document.hidden) return;
  const source = liveSource;
  livePresenting = true;
  while (liveNext && !videoOwnsSurface()) {
    const snapshot = liveNext;
    liveNext = null;
    const url = URL.createObjectURL(new Blob([snapshot], { type: 'image/jpeg' }));
    const decoded = new Image();
    decoded.src = url;
    try { await decoded.decode(); } catch {
      URL.revokeObjectURL(url);
      if (source !== liveSource) return;
      continue;
    }
    if (source !== liveSource) { URL.revokeObjectURL(url); return; }
    if (videoOwnsSurface() || document.hidden) {
      liveNext ??= snapshot;
      URL.revokeObjectURL(url);
      break;
    }
    if (liveURL) URL.revokeObjectURL(liveURL);
    canvasActive = false; liveCanvas.hidden = true;
    liveURL = url; $('live').src = url;
    $('live').hidden = false; $('live-empty').hidden = true;
    liveStats.jpegSwaps++;
    noteUpdate();
  }
  livePresenting = false;
}
async function streamLive(source) {
  videoBroken = !webCodecsVideo();
  videoAwaitKey = false;
  liveStats.mode = videoBroken ? 'jpeg' : 'h264';
  $('live-mode').textContent = videoBroken ? 'H.264 video unsupported in this browser · showing JPEG snapshots' : '';
  let reader;
  try {
    const response = await fetch(source.path, { signal: source.controller.signal, headers: { 'X-QA-Request': '1',
      ...(source.runId ? { 'X-QA-Live-Run': source.runId } : {}) } });
    if (liveSource !== source) { await response.body?.cancel(); return; }
    if (source.runId && response.headers?.get('X-QA-Live-Run') !== source.runId) {
      $('live-mode').textContent = 'Waiting for a stream bound to this run';
      await response.body?.cancel();
      return;
    }
    if ([401, 403, 404].includes(response.status) && windowView?.watched && source.path.startsWith(windowRoute)) {
      windowView.watched.streamStatus = response.status;
      updateWindowWatch(windowView, true);
      return;
    }
    if (!response.ok || !response.body) return;
    reader = response.body.getReader();
    let buffer = new Uint8Array(0);
    for (;;) {
      const { value, done } = await reader.read();
      if (done || liveSource !== source) return;
      const joined = new Uint8Array(buffer.length + value.length);
      joined.set(buffer); joined.set(value, buffer.length); buffer = joined;
      for (;;) {
        if (buffer.length < 4) break;
        const length = new DataView(buffer.buffer, buffer.byteOffset).getUint32(0);
        if (length > 8192) { await reader.cancel(); return; }
        if (buffer.length < 4 + length) break;
        const header = JSON.parse(new TextDecoder().decode(buffer.subarray(4, 4 + length)));
        if (!Number.isSafeInteger(header.bytes) || header.bytes < 0 || header.bytes > 4 * 1024 * 1024) { await reader.cancel(); return; }
        if (buffer.length < 4 + length + header.bytes) break;
        const image = buffer.slice(4 + length, 4 + length + header.bytes);
        buffer = buffer.slice(4 + length + header.bytes);
        liveStats.serverDropped = header.dropped ?? liveStats.serverDropped;
        if (header.type === 'cue') { showCursor(header, source); continue; }
        if (header.type === 'frame' && liveCue?.point &&
            !cueAt([liveCue], liveCue.startMs, header.captureGeometry)) clearCursor();
        if (header.type === 'vframe') {
          liveStats.received++; liveStats.videoReceived++;
          if (videoBroken) continue;
          handleVideo(header, image);
          continue;
        }
        if (header.type !== 'frame') continue;
        liveStats.received++;
        if (liveNext) liveStats.replaced++;
        liveNext = image;
        presentLive();
      }
    }
  } finally {
    if (liveSource === source) { videoClose(); clearCursor(); }
    reader?.cancel().catch(() => {});
  }
}
async function pollStatus() {
  try { await updateStatus(); } catch {
    $('service').textContent = 'Broker unavailable · replay is read-only';
    if (windowView?.automatic) windowView.confirmedEmpty = false;
  }
  setTimeout(pollStatus, 750);
}
async function pollReview() {
  try {
    if (tab === 'recordings' && !deletionState && selectedRun && run && (run.status === 'running' || ['queued', 'encoding'].includes(run.export.status)))
      await loadRun(selectedRun, null, true);
  } catch (e) { $('export-status').textContent = `Refresh unavailable. Loaded video playback is independent. ${e.message}`; }
  setTimeout(pollReview, 2000);
}
// Native video time drives replay. Network status work never gates this clock or stale-frame indication.
setInterval(() => {
  if (tab === 'windows' || (tab === 'live' && $('shared-session').hidden)) {
    const lane = windowView?.cards.get(windowView.watched?.id)?.lane;
    if (!$('window-viewer').hidden && lane) {
      const now = performance.now();
      const staleStatus = now - windowView.receivedAt > 3000;
      const staleImage = now - (liveSource?.lastFrameAt ?? now) > 2000;
      const staleCapture = latestCaptureAge(lane, windowView.receivedAt) > 2000;
      $('stale').hidden = !(liveURL || canvasActive) || !(staleImage || staleStatus || staleCapture);
      $('stale').textContent = staleStatus ? 'STATUS NOT CURRENT · LAST IMAGE' : 'STALE · LAST IMAGE';
      $('frame-age').textContent = staleStatus ? 'Window status not current' : captureStatus(lane, windowView.receivedAt);
    }
    return;
  }
  if (tab !== 'live') return;
  const statusAge = performance.now() - lastStatusAt;
  const age = state?.frameAgeMs === null || !state ? Infinity : state.frameAgeMs + statusAge;
  const stale = age > 2000 || statusAge > 3000 || state?.connection !== 'live';
  $('stale').hidden = !(liveURL || canvasActive) || !stale;
  $('stale').textContent = statusAge > 3000 || state?.connection === 'disconnected' ? 'DISCONNECTED · LAST RECEIVED FRAME' : 'STALE · NO NEW FRAME';
  $('frame-age').textContent = Number.isFinite(age) ? `Frame ${state.frameVersion} · ${(age / 1000).toFixed(1)}s old${liveStats.fps ? ` · ${liveStats.fps.toFixed(0)} updates/s` : ''}` : 'No shared frame';
}, 250);
api('/api/session').then(entered).catch(error => {
  if (!enteredOnce) tell(`Workspace access unavailable. ${error.message}. Run npm run qa:open to pair with the local broker.`, true);
});

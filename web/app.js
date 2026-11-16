import { ReplayEntry } from './replay-entry.js';
import { qaClipAt, QA_EDIT_VERSION } from './qa-edit.js';

const $ = id => document.getElementById(id);
const validId = value => /^[a-f0-9]{32}$/.test(value ?? '');
let csrf, state, observationId, selectedRun, selectedStep, checks = [], run, pageOffset, liveVersion, liveURL;
let tab = 'live', enteredOnce = false, lastStatusAt = 0, loadedVideo, toastTimer, reviewGeneration = 0, navigating = false;
const video = $('video');
let dialogState = null;
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
    throw new Error(data.failure ? `${data.failure.code.replaceAll('_', ' ')}. ${data.failure.nextAction}` : data.error.replaceAll('_', ' '));
  }
  return response.headers.get('content-type') === 'image/jpeg' ? response.blob() : response.json();
}
const task = (name, args = {}) => api('/api/tasks/' + name, args);
function bind(id, fn) {
  $(id).addEventListener('click', async () => {
    $(id).disabled = true;
    try { await fn(); } catch (e) { tell(e.message, true); }
    finally { $(id).disabled = false; updateControls(); }
  });
}
function surface(name) {
  if (name === 'live') { replayEntry.cancel(); video.pause(); }
  tab = name;
  $('live-surface').hidden = name !== 'live'; $('recordings-surface').hidden = name !== 'recordings';
  document.body.classList.toggle('reviewing', name === 'recordings' && !$('review').hidden);
  for (const n of ['live', 'recordings']) $('tab-' + n).setAttribute('aria-pressed', String(n === name));
}
bind('tab-live', async () => { surface('live'); });
bind('tab-recordings', async () => { surface('recordings'); await history(); });
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
  }
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
  await api('/api/command', { op: 'connect' }); await updateStatus();
  tell('Select a target only if more than one sample is available.');
});
bind('start', async () => {
  const w = state?.windows.find(w => String(w.windowId) === $('targets').value);
  const result = await task('qa_start', { title: $('run-title').value.trim() || 'QA run',
    ...(w ? { target: { windowId: w.windowId, pid: w.pid, bundleId: w.bundleId } } : {}) });
  tell(result.resumed ? 'Rejoined the current recording.' : 'QA is recording. Observe the count before input.');
  await updateStatus(); await history();
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
  observationId = undefined; surface('recordings');
  await history(); await loadRun(result.runId);
  tell('Run saved. The video is being prepared; you can already review the checks.');
  await updateStatus();
});
function formatTime(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
function node(tag, className, text) {
  const n = document.createElement(tag); if (className) n.className = className;
  if (text !== undefined) n.textContent = text; return n;
}
async function history() {
  $('library-status').hidden = false;
  $('library-status').textContent = 'Loading recordings…';
  $('recordings-empty').hidden = true;
  let result;
  try {
    result = await task('qa_runs', { limit: 64 });
  } catch (error) {
    $('recordings-empty').hidden = true;
    $('library-status').textContent = `Recordings unavailable. ${error.message}. Use Refresh to retry.`;
    throw error;
  }
  $('library-status').hidden = true;
  $('run-count').textContent = result.total;
  $('recordings-empty').hidden = result.total !== 0;
  $('recording-cards').replaceChildren();
  for (const r of result.runs) {
    const card = node('button', 'recording-card'), poster = node('div', 'card-poster');
    card.setAttribute('aria-label', `Review ${r.title}, ${r.counts.pass} passed, ${r.counts.fail} failed`);
    if (r.export.status === 'ready' && r.export.version === QA_EDIT_VERSION) {
      const img = node('img'); img.src = `/api/runs/${r.runId}/qa-v3-poster.jpg`; img.alt = ''; poster.append(img);
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
    body.append(meta); card.append(poster, body);
    card.onclick = () => loadRun(r.runId).catch(e => tell(e.message));
    $('recording-cards').append(card);
  }
}
bind('refresh', history);
function closeReview() {
  dismissDialog();
  replayEntry.cancel();
  video.pause(); $('review').hidden = true; selectedRun = null; selectedStep = null; reviewGeneration++;
  historyReplace(''); loadedVideo = null; video.removeAttribute('src'); video.load();
  navigating = false; document.body.classList.remove('reviewing');
  $('recording-cards').focus();
}
bind('close-review', async () => closeReview());
async function loadRun(id, step, refresh = false) {
  if (refresh && navigating) return;
  if (!refresh) {
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
    deepLink(id, step);
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
  $('review').hidden = false; surface('recordings');
  $('review-title').textContent = result.title;
  $('review-title').title = result.title;
  $('review-outcome').textContent = `${result.counts.pass} passed · ${result.counts.fail} failed`;
  $('review-outcome').className = 'muted';
  $('failure').hidden = !result.counts.fail;
  $('review-summary').textContent = `${['pass', 'fail', 'passed', 'failed'].includes(result.status) ? '' : result.status + ' · '}QA review ${formatTime(result.edit?.durationMs ?? 0)} · source ${formatTime(result.durationMs)} · ${result.context || 'Own RelayMac sample'}`;
  $('seek').max = Math.max(0.1, (result.edit?.durationMs ?? 0) / 1000);
  $('source-download').href = `/api/runs/${id}/recording.mp4`;
  $('source-download').hidden = result.sourceExport?.status !== 'ready';
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
    const src = `/api/runs/${id}/qa-v3-recording.mp4#export=${result.export.version}-${result.export.encodedAt ?? 0}`;
    if (loadedVideo !== src) {
      video.pause(); video.src = src; loadedVideo = src; video.load();
    }
    $('download').href = src; $('download').hidden = false;
    $('export-status').textContent = `Portable H.264 MP4 · ${(result.export.bytes / 1024 / 1024).toFixed(1)} MiB · recorded check footage only; missing footage is marked.`;
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
  if (!refresh) {
    deepLink(id, step); window.scrollTo(0, 0);
    const target = result.selected ? (clipFor(result.selected.stepId)?.startMs ?? null) : 0;
    if (target !== null && result.edit?.available && result.edit.clips.length &&
        result.edit.version === QA_EDIT_VERSION && result.export.version === QA_EDIT_VERSION) await replayEntry.openMilliseconds(target);
  }
}
bind('retry-review', async () => loadRun(selectedRun, selectedStep));
function selectCheck(check) {
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
  $('selected-context').textContent = `${clip ? `Assertion source ${formatTime(clip.sourceStartMs)}–${formatTime(clip.sourceEndMs)}. ${clip.evidenceNote ?? ''} ` : ''}${c?.context || c?.reason?.replaceAll('_', ' ') || ''}`;
  $('selected-result').textContent = c ? `${c.status.toUpperCase()}${clip ? '' : ' · No QA clip'}` : 'No loaded check';
  $('selected-result').className = c?.status ?? 'muted';
  $('selected-expected').textContent = c?.expected ?? '—';
  $('selected-actual').textContent = c ? c.actual ?? 'Unavailable' : '—';
}
function synchronize(seconds) {
  $('seek').value = seconds;
  $('time').textContent = `${formatTime(seconds * 1000)} / ${formatTime(run?.edit?.durationMs ?? 0)}`;
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
  $('review-estimate').textContent = `${formatTime(run?.edit?.durationMs ?? 0)} QA video · ${formatTime(run?.durationMs ?? 0)} source`;
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
  if (e.key === 'Escape' && !$('results-dialog').open) {
    for (const id of ['review-details', 'playback-settings']) {
      if ($(id).open) { $(id).open = false; $(id + '-toggle').focus(); e.preventDefault(); return; }
    }
  }
  if ($('results-dialog').open || tab !== 'recordings' || $('review').hidden || /INPUT|TEXTAREA|SELECT|BUTTON/.test(document.activeElement.tagName) || document.activeElement.isContentEditable || e.ctrlKey || e.metaKey || e.altKey) return;
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
function updateControls() {
  const active = Boolean(state?.runId), human = state?.owner === 'human';
  $('start').hidden = active; $('run-setup').hidden = active;
  $('finish').disabled = !active || !human;
  $('take').hidden = !active || human;
  $('release').hidden = !active || !human;
  $('human-tools').hidden = !active || !human;
  $('observe').disabled = !active || !human;
  $('act').disabled = !active || !human || !observationId;
  $('check').disabled = !active || !human;
  $('control-hint').textContent = !active ? 'Start a recording, or open a saved run in Recordings.'
    : human ? 'You control this run. Observe before each input.' : 'Watching the agent. Take control to interact without starting a new recording.';
}
updateControls();
async function updateStatus() {
  state = await api('/api/status'); lastStatusAt = performance.now();
  $('service').textContent = 'Local broker connected';
  $('connection').textContent = state.connection === 'live' ? 'Connected' : state.connection;
  $('target-name').textContent = state.target ? `RelayMac · ${state.target.windowId}` : 'Own sample not selected';
  $('owner').textContent = state.owner === 'human' ? 'You' : state.owner === 'agent' ? 'Agent' : 'Observer only';
  $('recording').textContent = state.runId ? 'Recording' : 'Not recording';
  $('recording').className = state.runId ? 'pass' : '';
  if (state.currentCheck) {
    $('current-check').textContent = state.currentCheck.title || 'Count check';
    $('check-result').textContent = state.currentCheck.kind === 'assertion' ? `${state.currentCheck.status.toUpperCase()} · expected ${state.currentCheck.expected}, observed ${state.currentCheck.actual ?? 'unavailable'}` : 'Checking native state…';
    $('check-result').className = state.currentCheck.status ?? '';
  }
  if (state.owner !== 'human') observationId = undefined;
  updateControls();
  const previous = $('targets').value;
  $('targets').replaceChildren(new Option('Auto-select the only sample', ''));
  for (const w of state.windows) $('targets').add(new Option(`${w.title || 'RelayMac'} · ${w.windowId}`, String(w.windowId)));
  $('targets').value = previous;
  if (state.frameVersion && state.frameVersion !== liveVersion && tab === 'live') {
    const blob = await api('/api/live');
    if (liveURL) URL.revokeObjectURL(liveURL);
    liveURL = URL.createObjectURL(blob); liveVersion = state.frameVersion; $('live').src = liveURL;
    $('live').hidden = false; $('live-empty').hidden = true;
  }
  if (!state.frameVersion && !liveURL) { $('live').hidden = true; $('live-empty').hidden = false; }
  if (state.error) $('service').textContent = state.error.replaceAll('_', ' ');
}
async function pollStatus() {
  try { await updateStatus(); } catch { $('service').textContent = 'Broker unavailable · replay is read-only'; }
  setTimeout(pollStatus, 750);
}
async function pollReview() {
  try {
    if (selectedRun && run && (run.status === 'running' || ['queued', 'encoding'].includes(run.export.status)))
      await loadRun(selectedRun, null, true);
  } catch (e) { $('export-status').textContent = `Refresh unavailable. Loaded video playback is independent. ${e.message}`; }
  setTimeout(pollReview, 2000);
}
// Native video time drives replay. Network status work never gates this clock or stale-frame indication.
setInterval(() => {
  const statusAge = performance.now() - lastStatusAt;
  const age = state?.frameAgeMs === null || !state ? Infinity : state.frameAgeMs + statusAge;
  const stale = age > 2000 || statusAge > 3000 || state?.connection !== 'live';
  $('stale').hidden = !liveURL || !stale;
  $('stale').textContent = statusAge > 3000 || state?.connection === 'disconnected' ? 'DISCONNECTED · LAST RECEIVED FRAME' : 'STALE · NO NEW FRAME';
  $('frame-age').textContent = Number.isFinite(age) ? `Frame ${state.frameVersion} · ${(age / 1000).toFixed(1)}s old` : 'No shared frame';
}, 250);
api('/api/session').then(entered).catch(error => {
  if (!enteredOnce) tell(`Workspace access unavailable. ${error.message}. Run npm run qa:open to pair with the local broker.`, true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordingLabels, recordingName, recordingFilename, recordingDisposition } from '../web/recording-name.js';
import { RunStore, opaque } from '../src/qa-store.js';
import { summarize } from '../src/qa-contract.js';
import { Broker } from '../src/qa-broker.js';
import { createQAServer } from '../src/qa-server.js';
import { mediaProcess } from '../src/qa-export.js';

const target = { windowId: 7, pid: 23, bundleId: '' };
const discovered = { ...target, displayName: 'Nimbus Studio', title: 'Private document title' };
const application = { name: 'Window 7' };
const labels = input => recordingLabels(input, target, discovered, application);

test('discovered process names and caller purposes produce canonical titles without document names or duplicate prefixes', () => {
  for (const title of ['Open settings', 'Nimbus Studio - Open settings', 'nimbus studio - Open settings'])
    assert.equal(labels({ title }).title, 'Nimbus Studio - Open settings');
  assert.equal(labels({ context: 'Verify navigation' }).title, 'Nimbus Studio - Verify navigation');
  assert.equal(labels({ title: 'QA run' }).title, 'Nimbus Studio - QA session');
  assert.equal(recordingLabels({}, { kind: 'desktop' }, {}, {}).title, 'Shared display - QA session');
  assert.equal(recordingLabels({}, target, {}, { name: 'Orchid Editor' }).applicationName, 'Orchid Editor');
  assert.equal(recordingLabels({}, target, { title: 'Private document' }, application).applicationName, 'Application (PID 23)');
  assert.equal(recordingLabels({}, { ...target, bundleId: 'org.example.opaque' }, discovered, application).applicationName, 'Nimbus Studio');
  assert.equal(labels({ title: 'Open settings', context: 'Other context' }).testDescription, 'Open settings');
});

test('first named check supplies a durable purpose without changing original journal records or legacy names', () => {
  const events = [{ kind: 'run-start', labels: labels({}) }], original = JSON.stringify(events[0]);
  assert.equal(recordingName(events).title, 'Nimbus Studio - QA session');
  events.push({ kind: 'step-start', operation: 'observe', title: 'Not a test' },
    { kind: 'assertion', title: 'Count assertion' },
    { kind: 'step-start', operation: 'assert-visual', title: 'Settings remain visible' },
    { kind: 'assertion', title: 'A later check' });
  assert.deepEqual(recordingName(events), { title: 'Nimbus Studio - Settings remain visible',
    applicationName: 'Nimbus Studio', testDescription: 'Settings remain visible' });
  assert.equal(JSON.stringify(events[0]), original);
  for (const input of [{ title: 'Explicit purpose' }, { context: 'Context purpose' }]) {
    const start = { kind: 'run-start', labels: labels(input) };
    assert.equal(recordingName([start, ...events.slice(1)]).title, start.labels.title);
  }
  assert.equal(recordingName([{ labels: { title: 'Legacy title' } }]).title, 'Legacy title');
});

test('download names preserve Unicode, run identity, extension and variant without unsafe characters or header injection', () => {
  const runId = 'a'.repeat(32), title = '雲 Studio - Check "menu"/path\\name\r\nInjected: yes\u0000';
  for (const [artifact, suffix] of [['qa-v5-recording.mp4', 'QA recording'], ['recording.mp4', 'full-session recording'],
    ['qa-v5-poster.jpg', 'QA poster'], ['summary.json', 'full-session summary']]) {
    const name = recordingFilename(title, runId, artifact);
    assert.match(name, /^雲 Studio - Check menu path name Injected yes - /);
    assert.ok(name.endsWith(`${suffix} - ${runId}.${artifact.split('.').at(-1)}`));
    assert.doesNotMatch(name, /[\p{Cc}\p{Cf}<>:"/\\|?*]/u);
    const disposition = recordingDisposition(title, runId, artifact);
    assert.doesNotMatch(disposition, /[\r\n]/);
    assert.equal(decodeURIComponent(disposition.split("filename*=UTF-8''")[1]), name);
    assert.match(disposition, /^inline; filename="[ -~]+"; filename\*=UTF-8''/);
  }
  assert.ok(Buffer.byteLength(recordingFilename('🧪'.repeat(160), runId, 'qa-v5-recording.mp4')) <= 255);
  const longName = recordingFilename(`雲${'🧪'.repeat(119)} - Menu opens`, runId, 'recording.mp4');
  assert.ok(Buffer.byteLength(longName) <= 255);
  assert.match(longName, /^雲.*Menu opens - full-session recording/u);
  assert.doesNotThrow(() => recordingDisposition('\ud800', runId, 'recording.mp4'));
});

test('recorded names survive recovery and reach results, exported MP4 metadata and authenticated download headers', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recording-name-'));
  let store = new RunStore(path.join(root, 'runs')), broker, service;
  t.after(async () => {
    if (service) await service.close();
    if (broker) await broker.close(); else store.close();
    fs.rmSync(root, { recursive: true });
  });
  const imageFile = path.join(root, 'frame.jpg');
  await mediaProcess('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x100',
    '-frames:v', '1', '-threads', '2', imageFile]);
  const run = store.start(target, labels({}), 'agent'), stepId = opaque();
  const at = ms => { run.monoStart = performance.now() - ms; };
  at(0); store.frame(run, { image: fs.readFileSync(imageFile), header: { type: 'frame' } }, true);
  at(100); store.append(run, { kind: 'step-start', operation: 'assert-count', stepId, title: 'Menu opens' });
  at(400); store.append(run, { kind: 'assertion', stepId, title: 'Menu opens', expected: 1, actual: 1, status: 'pass' });
  at(600); store.finish(run, 'pass', 'caller_stopped');
  const raw = fs.readFileSync(run.file);
  store.close(); store = new RunStore(path.join(root, 'runs'));
  assert.equal(summarize(store, run.id).title, 'Nimbus Studio - Menu opens');
  assert.equal(store.history()[0].labels.title, 'Nimbus Studio - Menu opens');
  assert.deepEqual(fs.readFileSync(run.file), raw, 'Naming leaves the original journal byte-for-byte unchanged after recovery');
  broker = new Broker(store, {});
  service = createQAServer(broker);
  const origin = await service.listen(0), auth = { Authorization: `Bearer ${service.agentToken}`, 'X-QA-Request': '1' };
  for (const variant of ['source', 'qa']) {
    broker.exports.request(run.id, false, variant);
    const state = await broker.exports.wait(run.id, 30000, variant);
    assert.equal(state.status, 'ready', JSON.stringify({ variant, ...state }));
    const prefix = variant === 'qa' ? 'qa-v5-' : '';
    const summary = JSON.parse(fs.readFileSync(broker.exports.artifact(run.id, prefix + 'summary.json').file));
    assert.equal(summary.title, 'Nimbus Studio - Menu opens');
    assert.equal(summary.applicationName, 'Nimbus Studio');
    assert.equal(summary.testDescription, 'Menu opens');
    const video = broker.exports.artifact(run.id, prefix + 'recording.mp4').file;
    const metadata = JSON.parse(await mediaProcess('ffprobe', ['-v', 'error', '-show_entries', 'format_tags=title', '-of', 'json', video]));
    assert.equal(metadata.format.tags.title, 'Nimbus Studio - Menu opens');
    for (const artifact of ['recording.mp4', 'poster.jpg', 'summary.json']) {
      const response = await fetch(`${origin}/api/runs/${run.id}/${prefix}${artifact}`, { headers: auth });
      assert.equal(response.status, 200);
      assert.equal(decodeURIComponent(response.headers.get('content-disposition').split("filename*=UTF-8''")[1]),
        `Nimbus Studio - Menu opens - ${variant === 'qa' ? 'QA' : 'full-session'} ${artifact === 'recording.mp4' ? 'recording' : artifact === 'poster.jpg' ? 'poster' : 'summary'} - ${run.id}.${artifact.split('.').at(-1)}`);
      await response.arrayBuffer();
    }
  }
  assert.deepEqual(fs.readFileSync(run.file), raw, 'Exports and downloads do not rewrite source evidence');
});

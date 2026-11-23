import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunStore, POLICY, opaque } from '../src/qa-store.js';
import { Broker } from '../src/qa-broker.js';
import { createQAServer } from '../src/qa-server.js';
import { mediaProcess } from '../src/qa-export.js';

function fixture(t, policy) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-deletion-'));
  let broker = new Broker(new RunStore(root, policy), {});
  t.after(async () => { await broker.close(); fs.rmSync(root, { recursive: true }); });
  return { root, get broker() { return broker; }, async restart() {
    await broker.close();
    broker = new Broker(new RunStore(root, policy), {});
    return broker;
  } };
}
function recording(broker, title = 'Disposable recording', finish = true) {
  const run = broker.store.start({}, { title }, 'human');
  broker.store.frame(run, { image: Buffer.from('disposable JPEG fixture'), header: {}, version: 1 }, true);
  if (finish) broker.store.finish(run, 'pass', 'test');
  return run;
}
function exportsFor(broker, id) {
  broker.exports.save(id, { status: 'ready' });
  const dir = path.join(broker.exports.root, id);
  for (const name of ['recording.mp4', 'poster.jpg', 'summary.json', 'qa-recording.mp4', 'qa-v2-poster.jpg', 'qa-v4-summary.json'])
    fs.writeFileSync(path.join(dir, name), Buffer.alloc(24), { mode: 0o600 });
  return dir;
}
const bytes = dir => fs.readdirSync(dir).reduce((n, name) => n + fs.statSync(path.join(dir, name)).size, 0);

test('confirmed deletion removes both owned trees, releases bytes and capacity, and persists without changing other journals', async t => {
  const f = fixture(t, { ...POLICY, maxRuns: 2 });
  const a = recording(f.broker), b = recording(f.broker, 'Keep this');
  const exportDir = exportsFor(f.broker, a.id), saved = fs.readFileSync(b.file);
  const before = await f.broker.recordings();
  const row = before.runs.find(r => r.runId === a.id);
  assert.equal(row.sourceBytes, bytes(a.dir));
  assert.equal(row.exportBytes, bytes(exportDir));
  assert.equal(before.storage.totalBytes, bytes(a.dir) + bytes(b.dir) + bytes(exportDir));
  assert.throws(() => f.broker.store.start({}, {}, 'human'), /recording_full/);
  await assert.rejects(f.broker.deleteRecording('agent', a.id), /human_confirmation_required/);
  assert.deepEqual(await f.broker.deleteRecording('human', a.id), { runId: a.id, deleted: true });
  assert.equal(fs.existsSync(a.dir), false);
  assert.equal(fs.existsSync(exportDir), false);
  assert.deepEqual(fs.readFileSync(b.file), saved);
  const after = await f.broker.recordings();
  assert.equal(after.total, 1);
  assert.equal(after.storage.totalBytes, bytes(b.dir));
  assert.equal(f.broker.exports.bytes(), 0);
  assert.throws(() => f.broker.store.image(a.id, a.lastFrame.frameId), /run_not_found/);
  assert.throws(() => f.broker.exports.request(a.id), /run_not_found/);
  await f.restart();
  assert.equal(f.broker.store.history().length, 1);
  assert.deepEqual(fs.readFileSync(b.file), saved);
  recording(f.broker, 'New slot');
  assert.equal(f.broker.store.history().length, 2);
});

test('active, in-flight, encoding and queued recordings refuse deletion without writing intent', async t => {
  const { broker, root } = fixture(t);
  const live = recording(broker, 'Live', false);
  await assert.rejects(broker.deleteRecording('human', live.id), /run_active/);
  broker.store.finish(live, 'pass', 'test');
  live.inflight = true;
  await assert.rejects(broker.deleteRecording('human', live.id), /run_active/);
  live.inflight = false;
  broker.exports.encode = async (_id, signal) => new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  const queued = recording(broker, 'Queued');
  broker.exports.request(live.id);
  broker.exports.request(queued.id);
  for (const r of [live, queued]) {
    await assert.rejects(broker.deleteRecording('human', r.id), /export_busy/);
    assert.equal(fs.existsSync(path.join(root, `delete-${r.id}.json`)), false);
    assert.equal((await broker.recordings()).runs.find(row => row.runId === r.id).deletion.reason, 'export_busy');
  }
});

test('unknown entries, symlinks, hardlinks, replaced directories and traversal refuse before source or export mutation', async t => {
  for (const attack of ['unknown-source', 'unknown-export', 'source-link', 'export-link', 'hardlink', 'directory-link', 'traversal']) {
    await t.test(attack, async t => {
      const { broker, root } = fixture(t);
      const run = recording(broker), dir = exportsFor(broker, run.id), source = fs.readFileSync(run.file);
      const outside = path.join(root, 'outside');
      fs.writeFileSync(outside, 'untouched', { mode: 0o600 });
      let cleanup;
      if (attack === 'unknown-source' || attack === 'unknown-export') {
        const file = path.join(attack === 'unknown-source' ? run.dir : dir, 'unrecognized.txt');
        fs.writeFileSync(file, 'untouched', { mode: 0o600 }); cleanup = () => fs.unlinkSync(file);
      } else if (attack === 'source-link' || attack === 'hardlink') {
        const file = path.join(run.dir, opaque() + '.jpg');
        fs[attack === 'hardlink' ? 'linkSync' : 'symlinkSync'](outside, file); cleanup = () => fs.unlinkSync(file);
      } else if (attack === 'export-link') {
        const file = path.join(dir, 'gap.jpg'); fs.symlinkSync(outside, file); cleanup = () => fs.unlinkSync(file);
      } else if (attack === 'directory-link') {
        fs.renameSync(dir, dir + '-moved'); fs.symlinkSync(dir + '-moved', dir);
        cleanup = () => { fs.unlinkSync(dir); fs.renameSync(dir + '-moved', dir); };
      }
      try {
        await assert.rejects(broker.deleteRecording('human', attack === 'traversal' ? '../' + run.id : run.id),
          /unsafe_|run_not_found/);
        assert.deepEqual(fs.readFileSync(run.file), source);
        assert.equal(fs.readFileSync(outside, 'utf8'), 'untouched');
        assert.equal(fs.existsSync(path.join(dir, 'recording.mp4')), true);
        assert.equal(fs.existsSync(path.join(root, `delete-${run.id}.json`)), false);
      } finally { cleanup?.(); fs.unlinkSync(outside); }
    });
  }
});

test('partial cleanup remains visibly pending, blocks replay and export regeneration, and retries only its intent', async t => {
  const f = fixture(t), run = recording(f.broker), other = recording(f.broker, 'Keep');
  const dir = exportsFor(f.broker, run.id), saved = fs.readFileSync(other.file);
  const unlink = fs.unlinkSync;
  let removed = 0;
  fs.unlinkSync = file => {
    if (String(file).endsWith('recording.mp4') && !String(file).endsWith('qa-recording.mp4')) throw new Error('test_io_failure');
    removed++; return unlink(file);
  };
  try { await assert.rejects(f.broker.deleteRecording('human', run.id), /test_io_failure/); }
  finally { fs.unlinkSync = unlink; }
  assert.ok(removed > 0, 'The failure must follow actual partial cleanup');
  assert.equal(fs.existsSync(path.join(f.root, `delete-${run.id}.json`)), true);
  assert.throws(() => f.broker.store.get(run.id), /deletion_pending/);
  assert.throws(() => f.broker.exports.request(run.id, true), /deletion_pending/);
  const list = await f.broker.recordings(), pending = list.runs.find(r => r.runId === run.id);
  assert.equal(pending.deletion.pending, true);
  assert.equal(pending.sourceBytes + pending.exportBytes, bytes(run.dir) + bytes(dir));
  await f.broker.deleteRecording('human', run.id);
  assert.equal(fs.existsSync(dir), false);
  assert.deepEqual(fs.readFileSync(other.file), saved);
});

test('restart resumes a confirmed cleanup after exports were removed and the journal was already unlinked', async t => {
  const f = fixture(t), run = recording(f.broker), other = recording(f.broker, 'Keep');
  exportsFor(f.broker, run.id);
  const saved = fs.readFileSync(other.file), rmdir = fs.rmdirSync;
  fs.rmdirSync = file => {
    if (String(file).endsWith('/' + run.id) && fs.realpathSync(path.dirname(file)) === f.root) throw new Error('test_io_failure');
    return rmdir(file);
  };
  try { await assert.rejects(f.broker.deleteRecording('human', run.id), /test_io_failure/); }
  finally { fs.rmdirSync = rmdir; }
  assert.equal(fs.existsSync(run.file), false);
  await f.restart();
  assert.equal(fs.existsSync(run.dir), false);
  assert.equal(fs.existsSync(path.join(f.root, `delete-${run.id}.json`)), false);
  assert.deepEqual(fs.readFileSync(other.file), saved);
  assert.deepEqual(f.broker.store.history().map(r => r.runId), [other.id]);
});

test('retry refuses new entries and substituted inodes, without deleting either replacement or unrelated data', async t => {
  const { broker } = fixture(t), run = recording(broker);
  const dir = exportsFor(broker, run.id), remove = broker.exports.removeFiles;
  broker.exports.removeFiles = () => { throw new Error('test_io_failure'); };
  await assert.rejects(broker.deleteRecording('human', run.id), /test_io_failure/);
  broker.exports.removeFiles = remove;
  const extra = path.join(dir, 'gap.jpg');
  fs.writeFileSync(extra, 'not in intent', { mode: 0o600 });
  await assert.rejects(broker.deleteRecording('human', run.id), /unsafe_deletion_storage/);
  assert.equal(fs.readFileSync(extra, 'utf8'), 'not in intent');
  fs.unlinkSync(extra);
  const original = path.join(dir, 'recording.mp4');
  fs.renameSync(original, path.join(dir, 'moved'));
  fs.writeFileSync(original, Buffer.alloc(24), { mode: 0o600 });
  fs.unlinkSync(path.join(dir, 'moved'));
  await assert.rejects(broker.deleteRecording('human', run.id), /unsafe_deletion_storage/);
  assert.equal(fs.existsSync(run.file), true);
  assert.equal(fs.existsSync(original), true);
});

test('paired HTTP confirmation, CSRF and actor boundaries protect deletion; real encoded media and stale links disappear', async t => {
  const { broker, root } = fixture(t);
  const jpeg = path.join(root, 'fixture.jpg');
  await mediaProcess('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x200',
    '-frames:v', '1', '-threads', '2', jpeg]);
  const run = broker.store.start({}, { title: 'Disposable encoded recording' }, 'human');
  broker.store.frame(run, { image: fs.readFileSync(jpeg), header: {}, version: 1 }, true);
  fs.unlinkSync(jpeg);
  run.monoStart = performance.now() - 250;
  broker.store.finish(run, 'pass', 'test');
  broker.exports.request(run.id);
  assert.equal((await broker.exports.wait(run.id, 30000)).status, 'ready');
  const service = createQAServer(broker), origin = await service.listen(0);
  t.after(() => service.close());
  const agent = { Authorization: 'Bearer ' + service.agentToken, 'X-QA-Request': '1' };
  const post = (route, input, headers = {}) => fetch(origin + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-QA-Request': '1', Origin: origin, ...headers },
    body: JSON.stringify(input),
  });
  const base = `/api/recordings/${run.id}`, artifact = `/api/runs/${run.id}/recording.mp4`;
  assert.equal((await post(base + '/confirm-delete', {}, agent)).status, 403);
  assert.equal((await post(base + '/delete', { confirmation: 'fake' }, agent)).status, 403);
  assert.equal((await post(base + '/confirm-delete', {})).status, 401);
  const paired = await post('/session', { code: service.pairingCode });
  const cookie = paired.headers.get('set-cookie').split(';')[0], { csrf } = await paired.json();
  const human = { Cookie: cookie, 'X-QA-CSRF': csrf };
  assert.equal((await post(base + '/confirm-delete', {}, { ...human, 'X-QA-Request': '0' })).status, 403);
  assert.equal((await post(base + '/confirm-delete', {}, { Cookie: cookie })).status, 403);
  assert.equal((await post(base + '/confirm-delete', {}, { ...human, Origin: 'https://evil.test' })).status, 403);
  assert.equal((await post(base + '/delete', { confirmation: 'fake' }, human)).status, 403);
  const confirm = await post(base + '/confirm-delete', {}, human), consent = await confirm.json();
  assert.equal(consent.title, 'Disposable encoded recording');
  assert.equal(fs.existsSync(run.file), true, 'Preparing or cancelling confirmation must not delete anything');
  const before = await (await fetch(origin + '/api/recordings', { headers: agent })).json();
  assert.ok(before.storage.exportBytes > 0);
  const media = await fetch(origin + artifact, { headers: agent });
  assert.equal(media.status, 200); assert.ok((await media.arrayBuffer()).byteLength > 1000);
  assert.equal((await post(`/api/recordings/${opaque()}/delete`, { confirmation: consent.confirmation }, human)).status, 403);
  broker.exports.queue.push({ id: run.id, variant: 'qa' });
  assert.equal((await post(base + '/delete', { confirmation: consent.confirmation }, human)).status, 409,
    'Export work queued after confirmation must still block deletion');
  broker.exports.queue.pop();
  const [deletion, duplicate] = await Promise.all([
    post(base + '/delete', { confirmation: consent.confirmation }, human),
    post(base + '/delete', { confirmation: consent.confirmation }, human),
  ]);
  assert.equal(duplicate.status, 200);
  assert.equal(deletion.status, 200);
  assert.deepEqual(await deletion.json(), { runId: run.id, deleted: true });
  assert.equal((await post(base + '/delete', { confirmation: consent.confirmation }, human)).status, 200, 'A lost response can safely retry the same consent');
  for (const route of [artifact, `/api/runs/${run.id}/poster.jpg`, `/api/runs/${run.id}/summary.json`,
    `/api/runs/${run.id}`, `/api/runs/${run.id}/frames/${run.lastFrame.frameId}`])
    assert.equal((await fetch(origin + route, { headers: agent })).status, 404, route);
  assert.equal((await post('/api/tasks/qa_replay', { runId: run.id }, agent)).status, 404);
  const after = await (await fetch(origin + '/api/recordings', { headers: agent })).json();
  assert.equal(after.total, 0);
  assert.equal(after.storage.totalBytes, 0);
  assert.equal(fs.existsSync(run.dir), false);
  assert.equal(fs.existsSync(path.join(broker.exports.root, run.id)), false);
  console.log(`Deletion HTTP evidence: real MP4 removed; source+exports ${before.storage.totalBytes} -> ${after.storage.totalBytes} bytes; stale artifacts/replay 404; repeated consent 200`);
});

test('replaced source and export directories are not adopted as owned deletion targets', async t => {
  for (const kind of ['source', 'exports']) await t.test(kind, async t => {
    const { broker, root } = fixture(t), run = recording(broker);
    const exportDir = exportsFor(broker, run.id), dir = kind === 'source' ? run.dir : exportDir;
    const moved = dir + '-moved';
    fs.renameSync(dir, moved);
    fs.mkdirSync(dir, { mode: 0o700 });
    const file = path.join(dir, kind === 'source' ? 'events.jsonl' : 'recording.mp4');
    fs.writeFileSync(file, 'replacement must survive', { mode: 0o600 });
    await assert.rejects(broker.deleteRecording('human', run.id), /unsafe_deletion_storage/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'replacement must survive');
    assert.equal(fs.existsSync(path.join(root, `delete-${run.id}.json`)), false);
    fs.unlinkSync(file); fs.rmdirSync(dir); fs.renameSync(moved, dir);
  });
});

test('a directory swap during cleanup cannot redirect descriptor-relative unlink to another recording', async t => {
  const { broker } = fixture(t), run = recording(broker), other = recording(broker, 'Unrelated');
  const dir = exportsFor(broker, run.id), otherDir = exportsFor(broker, other.id);
  const saved = fs.readFileSync(path.join(otherDir, 'recording.mp4')), unlink = fs.unlinkSync;
  let swapped = false;
  fs.unlinkSync = file => {
    if (!swapped && String(file).startsWith('/proc/self/fd/') && fs.realpathSync(path.dirname(file)) === dir) {
      swapped = true;
      fs.renameSync(dir, dir + '-moved');
      fs.symlinkSync(otherDir, dir);
    }
    return unlink(file);
  };
  try { await assert.rejects(broker.deleteRecording('human', run.id), /unsafe_/); }
  finally { fs.unlinkSync = unlink; }
  assert.equal(swapped, true);
  assert.deepEqual(fs.readFileSync(path.join(otherDir, 'recording.mp4')), saved);
  assert.equal(fs.existsSync(other.file), true);
  fs.unlinkSync(dir); fs.renameSync(dir + '-moved', dir);
  await broker.deleteRecording('human', run.id);
  assert.deepEqual(fs.readFileSync(path.join(otherDir, 'recording.mp4')), saved);
});

test('failure before durable intent publication leaves source and exports intact and permits retry', async t => {
  const { broker, root } = fixture(t), run = recording(broker), dir = exportsFor(broker, run.id);
  const saved = fs.readFileSync(run.file), rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (String(to).endsWith(`delete-${run.id}.json`)) throw new Error('test_io_failure');
    return rename(from, to);
  };
  try { await assert.rejects(broker.deleteRecording('human', run.id), /test_io_failure/); }
  finally { fs.renameSync = rename; }
  assert.deepEqual(fs.readFileSync(run.file), saved);
  assert.equal(fs.existsSync(path.join(dir, 'recording.mp4')), true);
  assert.equal(fs.existsSync(path.join(root, `delete-${run.id}.tmp`)), false);
  assert.equal(fs.existsSync(path.join(root, `delete-${run.id}.json`)), false);
  await broker.deleteRecording('human', run.id);
  assert.equal(fs.existsSync(run.dir), false);
});

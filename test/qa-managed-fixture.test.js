import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { launchManagedFixture } from '../src/qa-managed-fixture.js';

const fake = fileURLToPath(new URL('./fixtures/fake-managed-fixture.py', import.meta.url));
const helperURL = new URL('../src/qa-managed-fixture.js', import.meta.url).href;
const python = 'python3';
const config = workspace => ({ workspace, transport: 'ssh', host: 'mac.test', user: 'test', owner: 'qa' });
const command = mode => [python, ['-u', fake, mode]];
const call = (workspace, mode = 'healthy', lifetimeMs = 10_000, options = {}) =>
  launchManagedFixture(config(workspace), { lifetimeMs, command: command(mode), ...options });

async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), 'relay-managed-fixture-'));
  return { directory, remove: () => rm(directory, { recursive: true, force: true }) };
}

async function waitForExit(directory, pid) {
  for (let i = 0; i < 125; i++) {
    try { return await access(join(directory, `exit.${pid}`)); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await sleep(20);
  }
  assert.fail(`Fixture ${pid} never acknowledged EOF`);
}

async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('missing fixture acknowledgement')), 4000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

test('lease discovery must corroborate the exact independently reported window and OS start', async t => {
  const { directory, remove } = await workspace();
  t.after(remove);
  const fixture = call(directory);
  t.after(() => fixture.close());
  assert.throws(() => fixture.assertWindow({}), /target_mismatch/);
  const { target, processStartedAt } = await fixture.ready;
  assert.equal(processStartedAt, 123.5);
  const row = { ...target, processStartedAt, title: 'RelayMac' };
  assert.doesNotThrow(() => fixture.assertWindow(row));
  for (const changed of [{ pid: row.pid + 1 }, { processStartedAt: row.processStartedAt + 1 },
    { windowId: row.windowId + 1 }, { bundleId: 'com.google.Chrome' }])
    assert.throws(() => fixture.assertWindow({ ...row, ...changed }), /target_mismatch/);
  await fixture.close();
  await fixture.close();
  assert.deepEqual(await fixture.done, { reason: 'closed', cleaned: true });
  await waitForExit(directory, target.pid);
  assert.throws(() => fixture.assertWindow(row), /target_mismatch/);
});

test('closing one fixture leaves other ownership lanes, an existing unrelated process and recordings alone', async t => {
  const { directory, remove } = await workspace();
  t.after(remove);
  const recording = join(directory, 'recording.json');
  await writeFile(recording, '{"keep":true}');
  const existing = spawn(python, ['-c', 'import sys; sys.stdin.buffer.read()']);
  const existingClosed = once(existing, 'close');
  t.after(async () => { existing.stdin.end(); await existingClosed; });
  const a = call(directory), b = call(directory);
  t.after(() => Promise.all([a.close(), b.close()]));
  const [left, right] = await Promise.all([a.ready, b.ready]);
  assert.notEqual(left.target.pid, right.target.pid);
  assert.throws(() => a.assertWindow({ ...right.target, processStartedAt: right.processStartedAt }), /target_mismatch/);
  await a.close();
  await waitForExit(directory, left.target.pid);
  assert.equal(existing.exitCode, null);
  assert.doesNotThrow(() => b.assertWindow({ ...right.target, processStartedAt: right.processStartedAt }));
  await assert.rejects(access(join(directory, `exit.${right.target.pid}`)), { code: 'ENOENT' });
  assert.equal(await readFile(recording, 'utf8'), '{"keep":true}');
  await b.close();
  await waitForExit(directory, right.target.pid);
});

for (const [mode, error] of [
  ['partial', 'fixture_start_timeout'], ['wrong-marker', 'fixture_ownership_unproven'],
  ['wrong-pid', 'fixture_ownership_unproven'], ['wrong-parent', 'fixture_ownership_unproven'],
  ['corrupt-helper', 'fixture_ownership_unproven'],
]) {
  test(`${mode}: a failed start never publishes a usable target and reaps its own child`, async t => {
    const { directory, remove } = await workspace();
    t.after(remove);
    const fixture = call(directory, mode);
    t.after(() => fixture.close());
    await assert.rejects(fixture.ready, { message: error });
    await fixture.close();
    const files = await readdir(directory);
    assert.equal(files.filter(name => name.startsWith('start.')).length, 1);
    const pid = Number(files.find(name => name.startsWith('start.')).split('.')[1]);
    await waitForExit(directory, pid);
  });
}

test('abort during launch closes the transport and does not assume readiness', async t => {
  const { directory, remove } = await workspace();
  t.after(remove);
  const signal = new AbortController();
  const fixture = call(directory, 'partial', 10_000, { signal: signal.signal });
  signal.abort();
  await assert.rejects(fixture.ready, { message: 'fixture_closed' });
  await fixture.close();
  for (const file of await readdir(directory)) {
    if (file.startsWith('start.')) await waitForExit(directory, Number(file.split('.')[1]));
  }
});

for (const [mode, lifetime, reason] of [
  ['healthy', 200, 'fixture_expired'],
  ['client-lost', 10_000, 'fixture_client_lost'],
]) {
  test(`reaps on ${reason} independently of a return to the broker`, async t => {
    const { directory, remove } = await workspace();
    t.after(remove);
    const fixture = call(directory, mode, lifetime);
    t.after(() => fixture.close());
    const { target } = await fixture.ready;
    fixture.renew();
    assert.deepEqual(await bounded(fixture.done), { reason, cleaned: true });
    await waitForExit(directory, target.pid);
  });
}

test('cleanup failure is explicit and never retries against a replacement target', async t => {
  const { directory, remove } = await workspace();
  t.after(remove);
  const fixture = call(directory, 'cleanup-denied');
  const { target } = await fixture.ready;
  await assert.rejects(fixture.close(), { message: 'fixture_cleanup_failed' });
  await assert.rejects(fixture.close(), { message: 'fixture_cleanup_failed' });
  await waitForExit(directory, target.pid);
});

test('broker death closes the transport, and sudden supervisor death closes the private watchdog pipe', async t => {
  const { directory, remove } = await workspace();
  t.after(remove);
  const body = `import { launchManagedFixture } from ${JSON.stringify(helperURL)};
    const f = launchManagedFixture(${JSON.stringify(config(directory))},
      {lifetimeMs: 10000, command: ${JSON.stringify(command('healthy'))}});
    console.log(JSON.stringify(await f.ready));
    setInterval(() => f.renew(), 5000);`;
  const broker = spawn(process.execPath, ['--input-type=module', '-e', body]);
  const closed = once(broker, 'close');
  t.after(async () => { if (broker.exitCode === null && !broker.killed) broker.kill(); await closed; });
  const ready = await bounded(once(broker.stdout, 'data'));
  const pid = JSON.parse(ready[0]).target.pid;
  broker.kill('SIGKILL');
  await closed;
  await waitForExit(directory, pid);

  const [file, argv] = command('healthy');
  const supervisor = spawn(file, argv);
  const stopped = once(supervisor, 'close');
  t.after(async () => { if (supervisor.exitCode === null && !supervisor.killed) supervisor.kill(); await stopped; });
  supervisor.stdin.write(JSON.stringify({
    type: 'start', marker: 'a'.repeat(64), workspace: directory, lifetimeMs: 10000,
  }) + '\n');
  const response = await bounded(once(supervisor.stdout, 'data'));
  const identity = JSON.parse(response[0]).target;
  supervisor.kill('SIGKILL');
  await stopped;
  await waitForExit(directory, identity.pid);
});

test('a lost transport is not a cleanup acknowledgement even when the watchdog exits', async t => {
  const { directory, remove } = await workspace();
  t.after(remove);
  const fixture = call(directory, 'transport-lost');
  const { target } = await fixture.ready;
  assert.deepEqual(await bounded(fixture.done), { reason: 'fixture_cleanup_uncertain', cleaned: false });
  await assert.rejects(fixture.close(), { message: 'fixture_cleanup_uncertain' });
  await waitForExit(directory, target.pid);
});

test('supervisor refuses unproven artifacts and does not signal after reaping or mask permission failures', async () => {
  const checker = fileURLToPath(new URL('./managed-fixture-supervisor.py', import.meta.url));
  const process = spawn(python, [checker]);
  const output = [];
  process.stdout.on('data', data => output.push(data));
  const [code] = await bounded(once(process, 'close'));
  assert.equal(code, 0, Buffer.concat(output).toString());
});

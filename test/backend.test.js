import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, chmod, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { configSchema, parseOperation } from '../src/schema.js';
import { saveFrame } from '../src/frames.js';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixtures = path.join(root, 'test/fixtures');
const udid = '12345678-1234-4234-8234-123456789012';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function child(argv, env) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, argv, { env, cwd: root });
    let stdout = '', stderr = '';
    proc.stdout.on('data', data => { stdout += data; });
    proc.stderr.on('data', data => { stderr += data; });
    proc.on('error', reject);
    proc.on('close', code => resolve({ code, stdout, stderr }));
  });
}

async function setup(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'applets-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const workspace = path.join(home, "workspace with ' quote;$(no-command)");
  await mkdir(workspace);
  await mkdir(path.join(workspace, "Demo's App.xcodeproj"));
  await mkdir(path.join(workspace, 'Demo.xcworkspace'));
  await mkdir(path.join(workspace, 'Demo.app'));
  const config = { transport: 'ssh', host: 'mac.example.test', user: 'tester', workspace, localWorkspace: home, owner: 'human:alice', timeoutSeconds: 5 };
  const file = path.join(home, 'config.json');
  await writeFile(file, JSON.stringify(config));
  await chmod(path.join(fixtures, 'ssh'), 0o755);
  await chmod(path.join(fixtures, 'droid'), 0o755);
  const env = { ...process.env, PATH: fixtures + ':' + process.env.PATH, HOME: home, TMPDIR: home,
    FAKE_SSH_LOG: path.join(home, 'ssh.jsonl'), FAKE_APPLE_LOG: path.join(home, 'apple.jsonl') };
  const cli = (op, args = {}, overrides = {}) => child(['src/cli.js', file, op, JSON.stringify(args)], { ...env, ...overrides });
  const ok = async (op, args = {}, overrides = {}) => {
    const result = await cli(op, args, overrides);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.ok(!result.stdout.includes('SECRET'), 'Raw process logs must not reach callers');
    return JSON.parse(result.stdout);
  };
  const fail = async (op, args, expected, overrides = {}) => {
    const result = await cli(op, args, overrides);
    assert.equal(result.code, 1, result.stdout);
    assert.equal(result.stdout, '', 'Failures must not publish results or artifacts');
    assert.deepEqual(JSON.parse(result.stderr), { error: expected,
      ...(overrides.FAKE_APPLE_MODE === 'failure' ? { warnings: ['remote_stderr_present'] } : {}) });
  };
  const acquire = async (ttlSeconds = 10) => {
    const { token, generation } = await ok('acquire', { ttlSeconds });
    return { token, generation };
  };
  return { home, workspace, config, file, env, cli, ok, fail, acquire };
}

test('real CLI preflight and simulator listing use bounded fixed SSH and filter private fields', async t => {
  const s = await setup(t);
  assert.deepEqual(await s.ok('preflight'), { appleToolsReady: true, workspaceReady: true, pythonReady: true });
  const { devices } = await s.ok('simulators');
  assert.deepEqual(devices, [{ udid, name: 'Fake iPhone', state: 'Shutdown', available: true,
    runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-18-0' }]);
  const calls = (await readFile(s.env.FAKE_SSH_LOG, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(calls[0].includes('StrictHostKeyChecking=yes'));
  assert.ok(calls[0].includes('ForwardAgent=no'));
  assert.deepEqual(calls[0].slice(0, 3), ['-F', '/dev/null', '-T']);
  await s.fail('simulators', {}, 'invalid_remote_output', { FAKE_APPLE_MODE: 'invalid' });
});

test('Xcode destinations are a closed platform union', () => {
  const args = { lease: { token: 'a'.repeat(64), generation: 1 },
    target: { kind: 'project', path: 'Demo.xcodeproj' }, scheme: 'Demo' };
  for (const operation of ['build', 'test']) {
    for (const destination of [{ platform: 'macOS' }, { platform: 'iOS Simulator', id: udid }]) {
      assert.deepEqual(parseOperation(operation, { ...args, destination }).destination, destination);
    }
    for (const destination of [{ platform: 'macOS', id: udid }, { platform: 'macOS', arch: 'arm64' },
      { platform: 'iOS Simulator' }, { platform: 'iOS', id: udid }, { platform: 'macOS,arch=x86_64' }]) {
      assert.throws(() => parseOperation(operation, { ...args, destination }), /invalid_arguments/);
    }
  }
});

test('official SDK discovery lists only relevant contracts and never invokes a bridge tool', async t => {
  const s = await setup(t);
  await writeFile(s.file, JSON.stringify({ computer: 'fake-mac', workspace: s.workspace, owner: 'test' }));
  const env = { ...s.env, FAKE_BRIDGE_LOG: path.join(s.home, 'bridge.jsonl') };
  const result = await child(['scripts/discover-xcode.js', s.file], env);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(!result.stdout.includes('SECRET'), 'Unrelated tools must not be published');
  const discovered = JSON.parse(result.stdout);
  assert.equal(discovered.toolCount, 1);
  assert.equal(discovered.tools[0].name, 'DeviceInteractionSynthesize');
  assert.deepEqual(discovered.tools[0].inputSchema.required, ['interactSessionKey']);
  const requests = (await readFile(env.FAKE_BRIDGE_LOG, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(requests.filter(x => x.id !== undefined).map(x => x.method), ['initialize', 'tools/list']);
  for (const mode of ['bridge-error', 'bridge-overflow']) {
    const failed = await child(['scripts/discover-xcode.js', s.file], { ...env, FAKE_APPLE_MODE: mode });
    assert.equal(failed.code, 1);
    assert.equal(failed.stdout, '');
    assert.deepEqual(JSON.parse(failed.stderr), { error: 'xcode_bridge_discovery_failed' });
  }
});

test('fixture upload is idempotent and refuses unknown edits before writing any file', async t => {
  const s = await setup(t);
  await writeFile(s.file, JSON.stringify({ computer: 'fake-mac', workspace: s.workspace, owner: 'test' }));
  const upload = () => child(['scripts/upload-fixture.js', s.file], s.env);
  assert.equal((await upload()).code, 0);
  const app = path.join(s.workspace, 'fixtures/RelayDemo/App.swift');
  const mac = path.join(s.workspace, 'fixtures/RelayMac/App.swift');
  assert.equal(await readFile(app, 'utf8'), await readFile(path.join(root, 'fixtures/RelayDemo/App.swift'), 'utf8'));
  assert.equal((await upload()).code, 0, 'Identical authored fixtures can be uploaded repeatedly');
  await writeFile(mac, 'User-owned modification\n');
  await rm(app);
  const rejected = await upload();
  assert.equal(rejected.code, 1);
  assert.match(rejected.stderr, /Refusing to overwrite an existing differing fixture/);
  assert.equal(await readFile(mac, 'utf8'), 'User-owned modification\n');
  await assert.rejects(readFile(app), { code: 'ENOENT' }, 'Validation completes before any missing fixture is created');
});

for (const mode of ['probe-success', 'probe-approval', 'probe-denied', 'probe-mismatch', 'probe-overflow', 'probe-end-failure']) {
  test(`guarded fixed bridge experiment: ${mode}`, async t => {
    const s = await setup(t);
    await mkdir(path.join(s.workspace, 'fixtures/RelayDemo/RelayDemo.xcodeproj'), { recursive: true });
    await writeFile(s.file, JSON.stringify({ computer: 'fake-mac', workspace: s.workspace, owner: 'test' }));
    const env = { ...s.env, FAKE_BRIDGE_LOG: path.join(s.home, 'bridge.jsonl'), FAKE_APPLE_MODE: mode };
    const result = await child(['scripts/probe-live-bridge.js', s.file], env);
    assert.equal(result.code, mode === 'probe-success' ? 0 : 1, result.stderr);
    assert.ok(!result.stdout.includes('SECRET'), 'Session capabilities and raw errors stay private');
    assert.ok(!result.stderr.includes('SECRET'), 'Errors do not disclose bridge logs');
    const calls = (await readFile(env.FAKE_BRIDGE_LOG, 'utf8')).trim().split('\n').map(JSON.parse)
      .filter(x => x.method === 'tools/call').map(x => x.params.name);
    if (['probe-approval', 'probe-overflow'].includes(mode)) {
      assert.deepEqual(calls, ['XcodeOpenWorkspace']);
    } else if (mode === 'probe-denied') {
      assert.deepEqual(calls, ['XcodeOpenWorkspace', 'DeviceInteractionStartSession']);
    } else if (mode === 'probe-mismatch') {
      assert.deepEqual(calls, ['XcodeOpenWorkspace', 'DeviceInteractionStartSession', 'DeviceInteractionEndSession'],
        'A mismatched target is closed without app activation or input');
    } else {
      assert.deepEqual(calls, ['XcodeOpenWorkspace', 'DeviceInteractionStartSession',
        'DeviceInteractionSynthesize', 'DeviceInteractionEndSession']);
    }
    const state = JSON.parse(await readFile(path.join(s.home, '.applets-control/state.json'), 'utf8'));
    if (mode === 'probe-end-failure') {
      assert.equal(state.leases.length, 1, 'An unconfirmed bridge cleanup keeps the lease');
      assert.equal(JSON.parse(result.stderr).releaseError, 'busy');
      assert.ok((await stat(path.join(s.home, '.applets-control/bridge-session.json'))).isFile());
      assert.ok((await stat(path.join(s.home, '.applets-control/inflight'))).isFile());
    } else {
      assert.deepEqual(state.leases, [], 'Known cleanup completes before release');
      await assert.rejects(stat(path.join(s.home, '.applets-control/inflight')), { code: 'ENOENT' });
    }
  });
}

test('guarded bridge experiment holds the shared lease lock through tool execution', async t => {
  const s = await setup(t);
  await mkdir(path.join(s.workspace, 'fixtures/RelayDemo/RelayDemo.xcodeproj'), { recursive: true });
  await writeFile(s.file, JSON.stringify({ computer: 'fake-mac', workspace: s.workspace, owner: 'test' }));
  const env = { ...s.env, FAKE_BRIDGE_LOG: path.join(s.home, 'bridge.jsonl'), FAKE_APPLE_MODE: 'probe-slow' };
  const active = child(['scripts/probe-live-bridge.js', s.file], env);
  let started = false;
  for (let i = 0; i < 100; i++) {
    try { started = (await readFile(env.FAKE_BRIDGE_LOG, 'utf8')).includes('XcodeOpenWorkspace'); } catch {}
    if (started) break;
    await delay(20);
  }
  assert.ok(started);
  await s.fail('acquire', { ttlSeconds: 60, takeover: true }, 'busy');
  assert.equal((await active).code, 0);
});

test('CLI macOS builds and tests use the host destination and retain lease fencing', async t => {
  const s = await setup(t);
  const lease = await s.acquire();
  const args = { lease, target: { kind: 'project', path: "Demo's App.xcodeproj" },
    scheme: 'Demo', destination: { platform: 'macOS' } };
  for (const operation of ['build', 'test']) {
    assert.deepEqual(await s.ok(operation, args), { completed: operation });
  }
  const calls = (await readFile(s.env.FAKE_APPLE_LOG, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 2);
  for (const call of calls) assert.equal(call[call.indexOf('-destination') + 1], 'platform=macOS');
  await s.fail('build', { ...args, destination: { platform: 'macOS', id: udid } }, 'invalid_arguments');
  await s.ok('release', { lease });
  await s.fail('test', args, 'stale_lease');
});

test('real CLI typed operations preserve quoted paths and publish only successful private screenshots', async t => {
  const s = await setup(t);
  const lease = await s.acquire();
  for (const operation of ['boot', 'install', 'launch']) {
    const args = { lease, udid, ...(operation === 'install' ? { app: 'Demo.app' } : {}),
      ...(operation === 'launch' ? { bundleId: 'com.example.Demo' } : {}) };
    assert.deepEqual(await s.ok(operation, args), { completed: operation });
  }
  for (const operation of ['build', 'test']) {
    const target = operation === 'build' ? { kind: 'project', path: "Demo's App.xcodeproj" }
      : { kind: 'workspace', path: 'Demo.xcworkspace' };
    assert.deepEqual(await s.ok(operation, { lease, target, scheme: "Demo's App;$(ignored)",
      destination: { platform: 'iOS Simulator', id: udid } }), { completed: operation });
  }
  const calls = (await readFile(s.env.FAKE_APPLE_LOG, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls[3], ['/usr/bin/xcodebuild', '-project', path.join(s.workspace, "Demo's App.xcodeproj"),
    '-scheme', "Demo's App;$(ignored)", '-destination', `platform=iOS Simulator,id=${udid}`,
    '-derivedDataPath', path.join(s.workspace, '.applets-build'), '-quiet',
    '-disableAutomaticPackageResolution', 'build']);
  const screenshot = await s.ok('screenshot', { lease, udid });
  assert.equal(screenshot.artifact.mediaType, 'image/png');
  assert.equal((await stat(screenshot.artifact.remotePath)).mode & 0o777, 0o600);
  const before = await readdir(path.dirname(screenshot.artifact.remotePath));
  await s.fail('screenshot', { lease, udid }, 'command_failed', { FAKE_APPLE_MODE: 'failure' });
  assert.deepEqual(await readdir(path.dirname(screenshot.artifact.remotePath)), before, 'Failed screenshot must be removed');
});

test('CLI validation rejects arbitrary shell, owner spoofing, traversal and invalid destinations before SSH', async t => {
  const s = await setup(t);
  const lease = { token: 'a'.repeat(64), generation: 1 };
  for (const [op, args] of [
    ['shell', { command: 'id' }], ['preflight', { owner: 'other' }],
    ['boot', { lease, udid: 'booted; id' }], ['install', { lease, udid, app: '../Demo.app' }],
    ['build', { lease, target: { kind: 'project', path: 'Demo.xcodeproj' }, scheme: 'Demo',
      destination: { platform: 'iOS Simulator', id: 'booted' } }],
  ]) await s.fail(op, args, op === 'shell' ? 'invalid_operation' : 'invalid_arguments');
  await assert.rejects(readFile(s.env.FAKE_SSH_LOG), { code: 'ENOENT' });
  for (const host of ['-oProxyCommand=id', 'mac;id', 'mac\nid']) assert.equal(configSchema.safeParse({ ...s.config, host }).success, false);
  await symlink('/tmp', path.join(s.workspace, 'escape.app'));
  const actualLease = await s.acquire();
  await s.fail('install', { lease: actualLease, udid, app: 'escape.app' }, 'workspace_unavailable');
});

test('host/account leases serialize concurrent clients and fence owner, takeover, release, and expiry', async t => {
  const s = await setup(t);
  const results = await Promise.all(Array.from({ length: 6 }, () => s.cli('acquire', { ttlSeconds: 10 })));
  assert.equal(results.filter(r => r.code === 0).length, 1, 'Exactly one concurrent acquirer wins');
  for (const result of results.filter(r => r.code !== 0)) assert.deepEqual(JSON.parse(result.stderr), { error: 'lease_held' });
  const first = JSON.parse(results.find(r => r.code === 0).stdout);
  const lease = { token: first.token, generation: first.generation };
  await writeFile(s.file, JSON.stringify({ ...s.config, owner: 'agent:bob', host: 'alias.example.test' }));
  await s.fail('boot', { lease, udid }, 'stale_lease');
  const next = await s.ok('acquire', { ttlSeconds: 2, takeover: true });
  assert.ok(next.generation > lease.generation);
  await s.fail('release', { lease }, 'stale_lease');
  const fresh = { token: next.token, generation: next.generation };
  await s.fail('boot', { lease: { ...fresh, generation: lease.generation }, udid }, 'stale_lease');
  await s.fail('boot', { lease: { ...fresh, token: lease.token }, udid }, 'stale_lease');
  await delay(2100);
  await s.fail('boot', { lease: fresh, udid }, 'lease_expired');
  const final = await s.acquire();
  assert.ok(final.generation > fresh.generation);
  await s.ok('release', { lease: final });
  await s.fail('boot', { lease: final, udid }, 'stale_lease');
});

test('command output, transport failures and lease deadline fail closed without secret output', async t => {
  const s = await setup(t);
  await s.fail('preflight', {}, 'transport_failed', { FAKE_SSH_MODE: 'failure' });
  await s.fail('preflight', {}, 'transport_output_limit', { FAKE_SSH_MODE: 'overflow' });
  await s.fail('preflight', {}, 'command_output_limit', { FAKE_APPLE_MODE: 'overflow' });
  const lease = await s.acquire(1);
  await s.fail('screenshot', { lease, udid }, 'command_timeout', { FAKE_APPLE_MODE: 'hang' });
  assert.deepEqual(await readdir(path.join(s.home, '.applets-control/artifacts')), []);
  await s.acquire();
});

test('active commands hold fencing lock and takeover cannot overlap them', async t => {
  const s = await setup(t);
  const lease = await s.acquire(5);
  const active = s.cli('boot', { lease, udid }, { FAKE_APPLE_MODE: 'hang' });
  for (let i = 0; i < 100; i++) {
    try { await stat(s.env.FAKE_APPLE_LOG); break; } catch { await delay(20); }
  }
  await s.fail('acquire', { ttlSeconds: 10, takeover: true }, 'busy');
  const result = await active;
  assert.deepEqual(JSON.parse(result.stderr), { error: 'command_timeout' });
  await s.acquire();
});

test('abrupt helper death leaves fencing fail-closed after the OS releases its lock', async t => {
  const s = await setup(t);
  const lease = await s.acquire();
  await s.fail('boot', { lease, udid }, 'transport_failed', { FAKE_APPLE_MODE: 'helper-crash' });
  await s.fail('acquire', { ttlSeconds: 10, takeover: true }, 'busy');
  assert.ok((await stat(path.join(s.home, '.applets-control/inflight'))).isFile());
});

test('corrupt and permissive lease storage fails closed', async t => {
  const s = await setup(t);
  await s.acquire();
  const state = path.join(s.home, '.applets-control/state.json');
  await writeFile(state, '{"generation":"bad"}');
  await s.fail('acquire', { ttlSeconds: 10, takeover: true }, 'unsafe_state');
  await chmod(path.dirname(state), 0o755);
  await s.fail('preflight', {}, 'unsafe_state');
});

test('configured deadline bounds commands even with a longer lease', async t => {
  const s = await setup(t);
  await writeFile(s.file, JSON.stringify({ ...s.config, timeoutSeconds: 1 }));
  const lease = await s.acquire();
  await s.fail('boot', { lease, udid }, 'command_timeout', { FAKE_APPLE_MODE: 'hang' });
  await s.ok('boot', { lease, udid });
});

test('official MCP stdio client drives actual server tools and cannot supply owner or shell', async t => {
  const s = await setup(t);
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(root, 'src/mcp.js'), s.file], env: s.env, stderr: 'pipe' });
  const client = new Client({ name: 'applets-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(x => x.name).sort(), ['acquire', 'boot', 'build', 'install', 'launch',
    'preflight', 'release', 'screenshot', 'simulators', 'test', 'observe', 'tap', 'frame'].map(x => 'factory_relay_' + x).sort());
  const listed = await client.callTool({ name: 'factory_relay_simulators', arguments: {} });
  assert.equal(JSON.parse(listed.content[0].text).devices[0].name, 'Fake iPhone');
  const acquired = await client.callTool({ name: 'factory_relay_acquire', arguments: { ttlSeconds: 10 } });
  const { token, generation, owner } = JSON.parse(acquired.content[0].text);
  assert.equal(owner, 'human:alice');
  const boot = await client.callTool({ name: 'factory_relay_boot', arguments: { lease: { token, generation }, udid } });
  assert.deepEqual(JSON.parse(boot.content[0].text), { completed: 'boot' });
  for (const operation of ['build', 'test']) {
    const args = { lease: { token, generation }, target: { kind: 'project', path: "Demo's App.xcodeproj" },
      scheme: 'Demo', destination: { platform: 'macOS' } };
    const result = await client.callTool({ name: 'factory_relay_' + operation, arguments: args });
    assert.deepEqual(JSON.parse(result.content[0].text), { completed: operation });
    const invalid = await client.callTool({ name: 'factory_relay_' + operation,
      arguments: { ...args, destination: { platform: 'macOS', id: udid } } });
    assert.equal(invalid.isError, true);
  }
  const bad = await client.callTool({ name: 'factory_relay_acquire', arguments: { ttlSeconds: 10, owner: 'spoof' } });
  assert.equal(bad.isError, true);
  const stale = await client.callTool({ name: 'factory_relay_boot', arguments: { lease: { token: 'b'.repeat(64), generation }, udid } });
  assert.equal(stale.isError, true);
  assert.deepEqual(JSON.parse(stale.content[0].text), { error: 'stale_lease' });
});

test('default Factory relay forwards stdin and isolates stderr banners while reporting Apple warnings', async t => {
  const s = await setup(t);
  const config = { computer: 'fake-mac', workspace: s.workspace, owner: 'droid:relay-test', timeoutSeconds: 5 };
  await writeFile(s.file, JSON.stringify(config));
  assert.equal(configSchema.parse(config).transport, 'factory');
  assert.deepEqual(await s.ok('preflight'), { appleToolsReady: true, workspaceReady: true, pythonReady: true });
  const listed = await s.ok('simulators', {}, { FAKE_APPLE_MODE: 'authorization' });
  assert.equal(listed.devices[0].udid, udid);
  assert.deepEqual(listed.warnings, ['apple_package_authorization_required', 'remote_stderr_present']);
  const preflight = await s.ok('preflight', {}, { FAKE_APPLE_MODE: 'authorization' });
  assert.equal(preflight.appleToolsReady, false);
  const log = path.join(s.home, '.applets-control/diagnostics/preflight.json');
  assert.equal((await stat(log)).mode & 0o777, 0o600);
  assert.match((JSON.parse(await readFile(log, 'utf8'))).stderrTail, /Authorization is required/);
  const lease = await s.acquire();
  await s.ok('boot', { lease, udid });
  await s.ok('release', { lease });
});

test('Factory relay watchdog kills its local child process group', { timeout: 25000 }, async t => {
  const s = await setup(t);
  await writeFile(s.file, JSON.stringify({ computer: 'fake-mac', workspace: s.workspace, owner: 'test', timeoutSeconds: 1 }));
  const pidFile = path.join(s.home, 'relay-child.pid');
  await s.fail('preflight', {}, 'transport_timeout', { FAKE_RELAY_MODE: 'hang', FAKE_RELAY_PID: pidFile });
  const pid = Number(await readFile(pidFile, 'utf8'));
  try {
    const status = await readFile(`/proc/${pid}/status`, 'utf8');
    assert.match(status, /State:\s+Z/, 'Relay descendant must not remain running');
  } catch (error) {
    assert.equal(error.code, 'ENOENT');
  }
});

test('remote termination kills its foreground process and clears only its own in-flight marker', async t => {
  const s = await setup(t);
  const lease = await s.acquire();
  await s.fail('boot', { lease, udid }, 'command_interrupted', { FAKE_APPLE_MODE: 'helper-term' });
  const log = JSON.parse(await readFile(path.join(s.home, '.applets-control/diagnostics/boot.json'), 'utf8'));
  assert.equal(log.exitCode, -9);
  assert.throws(() => process.kill(log.pid, 0), { code: 'ESRCH' });
  await s.ok('boot', { lease, udid });
});

test('framework failures report safe categories and preserve bounded private evidence', async t => {
  const s = await setup(t);
  const result = await s.cli('preflight', {}, { FAKE_APPLE_MODE: 'framework' });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.deepEqual(JSON.parse(result.stderr), { error: 'command_failed',
    warnings: ['apple_coredevice_framework_incompatible', 'apple_simulator_framework_incompatible', 'remote_stderr_present'] });
  const logPath = path.join(s.home, '.applets-control/diagnostics/preflight.json');
  const log = JSON.parse(await readFile(logPath, 'utf8'));
  assert.equal(log.exitCode, 70);
  assert.match(log.stderrTail, /1051\.55\.0/);
  assert.ok((await stat(logPath)).size < 200000);
  assert.equal((await stat(logPath)).mode & 0o777, 0o600);
});

async function visualSetup(t) {
  const s = await setup(t);
  await writeFile(s.file, JSON.stringify({ ...s.config, timeoutSeconds: 30 }));
  s.env.FAKE_APPLE_MODE = 'visual-success';
  s.env.FAKE_BRIDGE_LOG = path.join(s.home, 'visual.jsonl');
  const lease = await s.acquire(120);
  const scope = { lease, udid, target: { kind: 'project', path: "Demo's App.xcodeproj" },
    bundleId: 'com.factory.applets.RelayDemo' };
  return { ...s, lease, scope };
}

test('real CLI observes, taps only a fresh identifier and downloads an authorized private PNG', async t => {
  const s = await visualSetup(t);
  const first = await s.ok('observe', s.scope);
  assert.equal(first.evidenceKind, 'observation');
  assert.equal(first.elements.find(e => e.id === 'relay-count').label, 'Count: 0');
  const frame = await s.ok('frame', { lease: s.lease, observationId: first.observationId });
  assert.equal(frame.mediaType, 'image/png');
  assert.equal(frame.bytes, (await stat(frame.localPath)).size);
  assert.equal((await stat(frame.localPath)).mode & 0o777, 0o600);
  assert.ok(frame.localPath.startsWith(path.join(s.home, '.applets-artifacts/')));
  assert.equal(frame.base64, undefined, 'CLI publishes a private local artifact, not unbounded bytes');
  await s.fail('frame', { lease: s.lease, observationId: first.observationId, remotePath: '/etc/passwd' }, 'invalid_arguments');
  await s.fail('tap', { ...s.scope, observationId: first.observationId, elementId: 'relay-increment',
    interactionCommand: 'arbitrary' }, 'invalid_arguments');
  await s.fail('tap', { ...s.scope, udid: '06ae5b11-c1c9-4456-b08e-c4e78c1f4247',
    observationId: first.observationId, elementId: 'relay-increment' }, 'target_mismatch');
  const second = await s.ok('tap', { ...s.scope, observationId: first.observationId, elementId: 'relay-increment' });
  assert.equal(second.elements.find(e => e.id === 'relay-count').label, 'Count: 1');
  await s.fail('tap', { ...s.scope, observationId: first.observationId, elementId: 'relay-increment' }, 'observation_stale');
  const third = await s.ok('tap', { ...s.scope, observationId: second.observationId, elementId: 'relay-increment' });
  assert.equal(third.elements.find(e => e.id === 'relay-count').label, 'Count: 2');
  await s.ok('acquire', { ttlSeconds: 120, takeover: true });
  await s.fail('tap', { ...s.scope, observationId: third.observationId, elementId: 'relay-increment' }, 'stale_lease');
  await s.fail('frame', { lease: s.lease, observationId: third.observationId }, 'stale_lease');
});

test('visual actions reject changed hierarchy and expired observations without input', async t => {
  const s = await visualSetup(t);
  const first = await s.ok('observe', s.scope);
  await s.fail('tap', { ...s.scope, observationId: first.observationId, elementId: 'relay-increment' },
    'observation_stale', { FAKE_APPLE_MODE: 'visual-drift' });
  assert.equal(await readFile(path.join(s.home, 'counter'), 'utf8').catch(() => '0'), '0');
  const fresh = await s.ok('observe', s.scope);
  const recordPath = path.join(s.home, '.applets-control/observation.json');
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  await writeFile(recordPath, JSON.stringify({ ...record, createdAt: record.createdAt - 121 }));
  await s.fail('frame', { lease: s.lease, observationId: fresh.observationId }, 'observation_stale');
});

for (const [mode, error] of [['visual-mismatch', 'target_mismatch'], ['visual-other-app', 'application_mismatch'],
  ['visual-outside', 'invalid_visual_artifact'], ['visual-corrupt-png', 'invalid_visual_artifact'],
  ['visual-disconnect', 'bridge_closed'], ['visual-timeout', 'command_timeout']]) {
  test(`visual boundary rejects ${mode} and cleans up`, async t => {
    const s = await visualSetup(t);
    if (mode === 'visual-timeout') await writeFile(s.file, JSON.stringify({ ...s.config, timeoutSeconds: 16 }));
    await s.fail('observe', s.scope, error, { FAKE_APPLE_MODE: mode });
    await assert.rejects(stat(path.join(s.home, '.applets-control/inflight')), { code: 'ENOENT' });
    await assert.rejects(stat(path.join(s.home, '.applets-control/bridge-session.json')), { code: 'ENOENT' });
    assert.deepEqual(await readdir(path.join(s.home, '.applets-control/artifacts')), []);
    await s.ok('release', { lease: s.lease });
  });
}

test('actual MCP exposes visual observation, bounded tap and image retrieval', async t => {
  const s = await visualSetup(t);
  const client = new Client({ name: 'visual-test', version: '1' });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [path.join(root, 'src/mcp.js'), s.file], env: s.env, stderr: 'pipe' }));
  const observed = await client.callTool({ name: 'factory_relay_observe', arguments: s.scope });
  assert.ok(!observed.isError, JSON.stringify(observed));
  const first = JSON.parse(observed.content[0].text);
  const tapped = await client.callTool({ name: 'factory_relay_tap',
    arguments: { ...s.scope, observationId: first.observationId, elementId: 'relay-increment' } });
  assert.ok(!tapped.isError, JSON.stringify(tapped));
  const second = JSON.parse(tapped.content[0].text);
  assert.equal(second.elements.find(e => e.id === 'relay-count').label, 'Count: 1');
  const frame = await client.callTool({ name: 'factory_relay_frame',
    arguments: { lease: s.lease, observationId: second.observationId } });
  assert.ok(!frame.isError, JSON.stringify(frame));
  assert.equal(frame.content[1].type, 'image');
  assert.equal(frame.content[1].mimeType, 'image/png');
  assert.equal(Buffer.from(frame.content[1].data, 'base64').length, JSON.parse(frame.content[0].text).bytes);
});

test('disconnect after session creation retains owned recovery state and blocks mutations', async t => {
  const s = await visualSetup(t);
  await s.fail('observe', s.scope, 'bridge_closed', { FAKE_APPLE_MODE: 'visual-disconnect-after-start' });
  assert.ok((await stat(path.join(s.home, '.applets-control/bridge-session.json'))).isFile());
  await s.fail('acquire', { ttlSeconds: 60, takeover: true }, 'busy');
  await assert.rejects(stat(path.join(s.home, '.applets-control/observation.json')), { code: 'ENOENT' });
});

test('frame boundary rejects oversized, corrupt, mismatched and redirected local artifacts', async t => {
  const s = await visualSetup(t);
  const observed = await s.ok('observe', s.scope);
  const downloaded = await s.ok('frame', { lease: s.lease, observationId: observed.observationId });
  const bytes = await readFile(downloaded.localPath);
  const valid = { ...downloaded, base64: bytes.toString('base64') };
  const corrupted = Buffer.from(bytes);
  corrupted[corrupted.length - 1] ^= 1;
  for (const invalid of [{ ...valid, base64: 'A'.repeat(699056) }, { ...valid, observationId: '0'.repeat(32) },
    { ...valid, width: 9000 }, { ...valid, mediaType: 'text/plain' },
    { ...valid, base64: corrupted.toString('base64'), sha256: createHash('sha256').update(corrupted).digest('hex') }]) {
    await assert.rejects(saveFrame({ localWorkspace: s.home }, observed.observationId, invalid), /invalid_frame_response/);
  }
  assert.equal((await readdir(path.join(s.home, '.applets-artifacts'))).length, 1, 'Rejected frames create no files');
  const other = path.join(s.home, 'other');
  await mkdir(other);
  await symlink(path.join(s.home, '.applets-artifacts'), path.join(other, '.applets-artifacts'));
  await assert.rejects(saveFrame({ localWorkspace: other }, observed.observationId, valid), /invalid_frame_response/);
});

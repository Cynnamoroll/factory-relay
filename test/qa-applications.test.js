import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configSchema } from '../src/schema.js';
import { loadConfig } from '../src/transport.js';
import { Broker, nativeAdapter } from '../src/qa-broker.js';
import { RunStore } from '../src/qa-store.js';
import { failure } from '../src/qa-contract.js';

const config = { computer: 'test-mac', workspace: '/Users/test/work', owner: 'private-owner' };
const mac = { id: 'relaymac', name: 'RelayMac', platform: 'macos', bundleId: 'com.factory.applets.RelayMac' };
const ios = { id: 'demo-ios', name: 'Demo iOS', platform: 'ios-simulator', bundleId: 'com.example.Demo',
  simulatorUdid: 'ABCDEF12-1234-4234-8234-123456789012' };

test('profile configuration distinguishes omitted, empty and explicit replacement without changing default config JSON', () => {
  assert.equal(Object.hasOwn(configSchema.parse(config), 'applications'), false);
  assert.deepEqual(configSchema.parse({ ...config, applications: [] }).applications, []);
  assert.deepEqual(configSchema.parse({ ...config, applications: [mac] }).applications, [mac]);
  const profiles = configSchema.parse({ ...config, applications: [
    { ...ios, name: '  Demo iOS  ' },
    { ...ios, id: 'other-device', simulatorUdid: 'ABCDEF12-1234-4234-8234-123456789013' },
    { id: 'demo-mac', name: 'Demo Mac', platform: 'macos', bundleId: ios.bundleId },
  ] }).applications;
  assert.equal(profiles.length, 3, 'Cross-platform identities and separate simulators remain distinct');
  assert.equal(profiles[0].name, 'Demo iOS');
  assert.equal(profiles[0].simulatorUdid, ios.simulatorUdid.toLowerCase());
});

test('profile validation rejects malformed, unknown, duplicate and unbounded authorization', () => {
  const invalidProfiles = [
    { ...mac, id: '../sample' }, { ...mac, id: '-sample' }, { ...mac, id: 'a'.repeat(65) },
    { ...mac, name: ' ' }, { ...mac, name: 'a'.repeat(121) }, { ...mac, name: '\nRelayMac' },
    { ...mac, name: 'Relay\u0085Mac' }, { ...mac, owner: 'spoof' },
    { ...mac, bundleId: '*' }, { ...mac, bundleId: 'com.example.*' }, { ...mac, bundleId: 'com..example' },
    { ...mac, bundleId: '.com.example' }, { ...mac, bundleId: '-com.example' },
    { ...mac, bundleId: 'com/example' }, { ...mac, bundleId: 'com.example.' },
    { ...mac, bundleId: 'a'.repeat(256) }, { ...mac, platform: 'ios' },
    { ...mac, simulatorUdid: ios.simulatorUdid }, { ...ios, simulatorUdid: 'booted' },
    { ...ios, simulatorUdid: undefined }, { ...ios, path: '/private/project' },
  ];
  for (const profile of invalidProfiles)
    assert.equal(configSchema.safeParse({ ...config, applications: [profile] }).success, false, JSON.stringify(profile));
  for (const applications of [null, {}, [mac, { ...ios, id: mac.id }],
    [mac, { ...mac, id: 'alias' }], [ios, { ...ios, id: 'alias', simulatorUdid: ios.simulatorUdid.toLowerCase() }],
    Array.from({ length: 33 }, (_, i) => ({ ...mac, id: `app-${i}`, bundleId: `com.example.App${i}` }))])
    assert.equal(configSchema.safeParse({ ...config, applications }).success, false, JSON.stringify(applications));
});

test('private config loader preserves empty authorization and its existing size bound', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-app-config-'));
  t.after(() => fs.rmSync(root, { recursive: true }));
  const file = path.join(root, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ ...config, applications: [] }), { mode: 0o600 });
  assert.deepEqual((await loadConfig(file)).applications, []);
  fs.writeFileSync(file, JSON.stringify(config) + ' '.repeat(16384));
  await assert.rejects(loadConfig(file), /invalid_config/);
});

test('native adapter cannot enumerate, capture, observe or press an unauthorized sample through legacy methods', async () => {
  const target = { windowId: 7, pid: 12, bundleId: mac.bundleId };
  const lease = { token: 'a'.repeat(64), generation: 1 };
  for (const applications of [[], [ios], [{ ...mac, bundleId: 'com.example.Other' }],
    [{ ...ios, bundleId: mac.bundleId }]]) {
    const adapter = nativeAdapter({ transport: 'factory', applications });
    if (!applications.some(app => app.platform === 'macos'))
      assert.deepEqual(await adapter.windows(lease), { windows: [], displays: [] }, 'Denied enumeration needs no remote configuration or call');
    for (const call of [
      () => adapter.stream(lease, target, new AbortController().signal, () => assert.fail('No frames allowed')),
      () => adapter.observe(lease, target), () => adapter.press(lease, target, 'b'.repeat(32)),
    ]) await assert.rejects(async () => call(), /application_not_authorized/);
  }
  const adapter = nativeAdapter({ transport: 'factory', applications: [mac] });
  await assert.rejects(async () => adapter.observe(lease, { ...target, bundleId: ios.bundleId }), /application_not_authorized/);
});

test('application errors distinguish unsupported drivers, unknown IDs and required selection', () => {
  assert.equal(failure(new Error('application_not_supported'), 'qa_start').category, 'unavailable');
  assert.match(failure(new Error('application_not_supported'), 'qa_start').nextAction, /driver|implemented/i);
  assert.equal(failure(new Error('unknown_application'), 'qa_start').category, 'validation');
  assert.match(failure(new Error('application_ambiguous'), 'qa_start').nextAction, /qa_status.*applicationId/);
  assert.equal(failure(new Error('application_unavailable'), 'qa_start').category, 'unavailable');
  assert.equal(failure(new Error('application_not_authorized'), 'qa_act').retrySafe, false);
});

test('broker inherits the adapter authorization snapshot without exposing private config or inventing runtime readiness', async t => {
  for (const [applications, expected] of [
    [undefined, [mac]], [[], []], [[mac], [mac]], [[ios], [{ ...ios, simulatorUdid: ios.simulatorUdid.toLowerCase() }]],
  ]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-profile-inheritance-'));
    const input = configSchema.parse({ ...config, ...(applications === undefined ? {} : { applications }) });
    const before = JSON.stringify(input);
    const adapter = nativeAdapter(input);
    for (const name of ['acquire', 'release', 'windows', 'stream', 'observe', 'press'])
      t.mock.method(adapter, name, () => assert.fail(`Status must not invoke native ${name}`));
    const broker = new Broker(new RunStore(root), adapter);
    const filesBefore = fs.readdirSync(root, { recursive: true });
    try {
      const status = await broker.task('agent', 'qa_status', {});
      assert.deepEqual(status.applications.map(({ capabilities, ...p }) => p), expected);
      assert.equal(status.connection, 'disconnected');
      assert.deepEqual(status.windows, []);
      for (const value of Object.values(config)) assert.ok(!JSON.stringify(status).includes(value));
      assert.equal(JSON.stringify(input), before, 'Status and profile defaults leave parsed config unchanged');
      assert.deepEqual(fs.readdirSync(root, { recursive: true }), filesBefore, 'Status writes no additional files');
      assert.deepEqual(broker.store.history(), [], 'Status creates no run journals or recordings');
    } finally { await broker.close(); fs.rmSync(root, { recursive: true }); }
  }
});

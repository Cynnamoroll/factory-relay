import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { controlRequestSchema, controlTargetSchema, control } from '../src/control.js';

test('native control admits only exact own-window observations and identifier presses', async () => {
  const target = { windowId: 5, pid: 12, bundleId: 'com.factory.applets.RelayMac' };
  const lease = { token: 'a'.repeat(64), generation: 1 };
  const request = { operation: 'press', target, lease, observationId: 'b'.repeat(32), elementId: 'relay-increment' };
  assert.deepEqual(controlRequestSchema.parse(request), request);
  for (const input of [
    { ...request, operation: 'keyboard', text: 'hello' },
    { ...request, elementId: 'close-window' },
    { ...request, x: 20, y: 40 },
    { ...request, target: { ...target, bundleId: 'com.apple.dt.Devices' } },
    { ...request, target: { ...target, windowId: 0 } },
    { ...request, target: { ...target, pid: 0 } },
    { ...request, observationId: '' },
    { operation: 'observe', lease },
  ]) assert.throws(() => controlRequestSchema.parse(input));
  assert.throws(() => controlTargetSchema.parse({ ...target, udid: 'guessed' }));
  await assert.rejects(control({ transport: 'factory', computer: 'mac', workspace: '/tmp/test',
    owner: 'test', timeoutSeconds: 30 }, { ...request, elementId: 'arbitrary' }));
});

test('native control shares authority, consumes observations once, and fails closed on uncertain effects', () => {
  const result = spawnSync('python3', ['test/control-supervisor.py'], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /lease scopes, legacy migration, scoped takeover, exclusive fencing and expiry passed/);
});

test('a mouse count wait is confined to one background left click on the RelayMac fixture', () => {
  const input = { operation: 'mouse', observationId: 'b'.repeat(32), lease: { token: 'a'.repeat(64), generation: 1 },
    target: { windowId: 5, pid: 12, bundleId: 'com.factory.applets.RelayMac' }, waitFor: { kind: 'count', equals: 1, timeoutMs: 250 },
    mouse: { kind: 'click', x: 0.4, y: 0.5, count: 1, button: 'left' } };
  assert.ok(controlRequestSchema.safeParse(input).success);
  for (const change of [{ mouse: { ...input.mouse, count: 2 } }, { mouse: { ...input.mouse, button: 'right' } },
    { target: { ...input.target, bundleId: 'com.example.App' } },
    { target: { kind: 'desktop', displayId: 1, displayUUID: 'abcdef12-1234-4234-8234-123456789012' } }])
    assert.equal(controlRequestSchema.safeParse({ ...input, ...change }).success, false);
});

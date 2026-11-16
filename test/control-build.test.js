import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { controlBuildSource } from '../scripts/build-control.js';
import { hostBuildSource } from '../scripts/build-host.js';

test('legacy control build entry point builds only the unified host', () => {
  assert.equal(controlBuildSource, hostBuildSource);
  assert.doesNotMatch(controlBuildSource, /applets-native-control|Applets Control\.app/);
  const launcher = readFileSync(new URL('../src/stream-supervisor.py', import.meta.url), 'utf8');
  assert.doesNotMatch(launcher, /applets-native-control|Applets Control\.app/);
  assert.match(launcher, /\.applets-host\/Factory Relay\.app/);
});

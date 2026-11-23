import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildCandidate } from '../scripts/build-host-candidate.js';

test('candidate packaging uses a new directory, hashes exact sources and never launches or replaces a host', async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-candidate-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'candidate');
  const result = await buildCandidate(root, { sourcesOnly: true });
  assert.equal(result.compiled, false);
  assert.equal(result.launched, false);
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'candidate-manifest.json'), 'utf8'));
  assert.equal(manifest.bundleId, 'com.factory.applets.host');
  assert.equal(manifest.candidateOnly, true);
  for (const [name, digest] of Object.entries(manifest.authored))
    assert.equal(createHash('sha256').update(await fs.readFile(path.join(root, name))).digest('hex'), digest);
  assert.deepEqual(await fs.readdir(path.join(result.app, 'Contents/MacOS')), []);
  await assert.rejects(buildCandidate(root, { sourcesOnly: true }), { code: 'EEXIST' },
    'An existing directory cannot be overwritten even when it contains an earlier candidate');
  await assert.rejects(buildCandidate(path.join(parent, '.applets-host'), { sourcesOnly: true }), /installed_host_path_refused/);
  await assert.rejects(buildCandidate('relative-candidate', { sourcesOnly: true }), /candidate_path_must_be_absolute/);
});

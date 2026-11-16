import { spawn } from 'node:child_process';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadConfig } from '../src/transport.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const configPath = process.argv[2];
const config = await loadConfig(configPath);
const udid = process.argv[3];
if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(udid ?? ''))
  throw new Error('Usage: node scripts/verify-visual.js CONFIG SIMULATOR_UDID');
const scope = { target: { kind: 'project', path: 'fixtures/RelayDemo/RelayDemo.xcodeproj' },
  udid, bundleId: 'com.factory.applets.RelayDemo' };
const directory = root + '.applets-artifacts';
await mkdir(directory, { recursive: true, mode: 0o700 });
const humanPath = directory + '/human-' + randomBytes(8).toString('hex') + '.json';
await writeFile(humanPath, JSON.stringify({ ...config, owner: 'human:visual-verification' }), { flag: 'wx', mode: 0o600 });
const client = new Client({ name: 'factory-relay-visual-verification', version: '1' });
let active;
const proof = ({ token, generation }) => ({ token, generation });
const count = result => result.elements.find(e => e.id === 'relay-count')?.label;
function report(surface, operation, value, elapsedMs) {
  const { token, ...safe } = value;
  console.log(JSON.stringify({ surface, operation, elapsedMs: Math.round(elapsedMs), result: safe }));
}
async function cli(file, operation, args = {}, expectedError) {
  const start = performance.now();
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [root + 'src/cli.js', file, operation, JSON.stringify(args)], { cwd: root });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
  const value = JSON.parse(result.code === 0 ? result.stdout : result.stderr);
  report(file === humanPath ? 'human-cli' : 'agent-cli', operation, value, performance.now() - start);
  if (expectedError) assert.equal(value.error, expectedError);
  else assert.equal(result.code, 0, JSON.stringify(value));
  return value;
}
async function mcp(operation, args) {
  const start = performance.now();
  const response = await client.callTool({ name: 'factory_relay_' + operation, arguments: args }, undefined, { timeout: 150000 });
  assert.ok(!response.isError, JSON.stringify(response));
  const value = JSON.parse(response.content[0].text);
  report('agent-mcp', operation, value, performance.now() - start);
  if (operation === 'frame') assert.equal(response.content[1].type, 'image');
  return value;
}
try {
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [root + 'src/mcp.js', configPath], env: process.env, stderr: 'pipe' }));
  const agent = proof(await cli(configPath, 'acquire', { ttlSeconds: 900 }));
  active = { file: configPath, lease: agent };
  const zero = await cli(configPath, 'observe', { ...scope, lease: agent });
  assert.equal(count(zero), 'Count: 0', 'Run against a freshly launched sample');
  await cli(configPath, 'frame', { lease: agent, observationId: zero.observationId });
  const one = await mcp('tap', { ...scope, lease: agent, observationId: zero.observationId, elementId: 'relay-increment' });
  assert.equal(count(one), 'Count: 1');
  await mcp('frame', { lease: agent, observationId: one.observationId });
  const human = proof(await cli(humanPath, 'acquire', { ttlSeconds: 900, takeover: true }));
  active = { file: humanPath, lease: human };
  await cli(configPath, 'tap', { ...scope, lease: agent, observationId: one.observationId,
    elementId: 'relay-increment' }, 'stale_lease');
  const fresh = await cli(humanPath, 'observe', { ...scope, lease: human });
  assert.equal(count(fresh), 'Count: 1', 'Rejected stale action must not increment');
  const two = await cli(humanPath, 'tap', { ...scope, lease: human, observationId: fresh.observationId,
    elementId: 'relay-increment' });
  assert.equal(count(two), 'Count: 2');
  await cli(humanPath, 'frame', { lease: human, observationId: two.observationId });
  console.log(JSON.stringify({ verifiedCounts: [0, 1, 2], takeoverRejectedStaleAction: true }));
} finally {
  try { if (active) await cli(active.file, 'release', { lease: active.lease }); }
  finally { await client.close(); await unlink(humanPath); }
}

import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const [config, udid, phase = 'core'] = process.argv.slice(2);
if (!config || !udid || !['core', 'mcp', 'fixture', 'test', 'mac', 'mcp-mac'].includes(phase)) {
  throw new Error('Usage: node scripts/verify-live.js CONFIG UDID core|mcp|fixture|test|mac|mcp-mac');
}
const proof = ({ token, generation }) => ({ token, generation });
async function cli(operation, args = {}, expectedError) {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [root + 'src/cli.js', config, operation, JSON.stringify(args)],
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
  const value = JSON.parse(result.code === 0 ? result.stdout : result.stderr);
  const { token, ...safe } = value;
  console.log(JSON.stringify({ surface: 'real-cli', operation, exitCode: result.code,
    result: value.devices ? { selectedDevice: value.devices.find(d => d.udid.toLowerCase() === udid.toLowerCase()),
      deviceCount: value.devices.length, warnings: value.warnings } : safe }));
  if (expectedError) assert.equal(value.error, expectedError);
  else assert.equal(result.code, 0, JSON.stringify(value));
  return value;
}

if (phase === 'mcp' || phase === 'mcp-mac') {
  const client = new Client({ name: 'factory-relay-live-verifier', version: '1.0.0' });
  let lease;
  async function call(name, args = {}) {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 1850000 });
    assert.ok(!result.isError, JSON.stringify(result));
    const value = JSON.parse(result.content[0].text);
    const { token, ...safe } = value;
    console.log(JSON.stringify({ surface: 'real-mcp', operation: name, result: safe }));
    return value;
  }
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [root + 'src/mcp.js', config], env: process.env, stderr: 'pipe' }));
    for (const name of ['factory_relay_preflight', 'factory_relay_simulators']) {
      const result = await client.callTool({ name, arguments: {} }, undefined, { timeout: 90000 });
      assert.ok(!result.isError, JSON.stringify(result));
      const value = JSON.parse(result.content[0].text);
      console.log(JSON.stringify({ surface: 'real-mcp', operation: name,
        result: value.devices ? { deviceCount: value.devices.length,
          selectedDevice: value.devices.find(d => d.udid.toLowerCase() === udid.toLowerCase()), warnings: value.warnings } : value }));
    }
    if (phase === 'mcp-mac') {
      lease = proof(await call('factory_relay_acquire', { ttlSeconds: 1800 }));
      const args = { lease, target: { kind: 'project', path: 'fixtures/RelayMac/RelayMac.xcodeproj' },
        scheme: 'RelayMac', destination: { platform: 'macOS' } };
      await call('factory_relay_build', args);
      await call('factory_relay_test', args);
    }
  } finally {
    try { if (lease) await call('factory_relay_release', { lease }); }
    finally { await client.close(); }
  }
} else {
  let lease;
  try {
    if (phase === 'core') {
      await cli('preflight');
      const listed = await cli('simulators');
      assert.ok(listed.devices.some(d => d.udid.toLowerCase() === udid.toLowerCase() && d.available));
      lease = proof(await cli('acquire', { ttlSeconds: 1 }));
      await new Promise(resolve => setTimeout(resolve, 1100));
      await cli('boot', { lease, udid }, 'lease_expired');
      lease = proof(await cli('acquire', { ttlSeconds: 1200 }));
      await cli('acquire', { ttlSeconds: 1200 }, 'lease_held');
      const old = lease;
      lease = proof(await cli('acquire', { ttlSeconds: 1200, takeover: true }));
      assert.ok(lease.generation > old.generation);
      await cli('boot', { lease: old, udid }, 'stale_lease');
      if (listed.devices.find(d => d.udid.toLowerCase() === udid.toLowerCase()).state !== 'Booted') {
        await cli('boot', { lease, udid });
      }
      await cli('simulators');
      await cli('screenshot', { lease, udid });
    } else {
      lease = proof(await cli('acquire', { ttlSeconds: 1800 }));
      const xcode = { lease, target: { kind: 'project', path: 'fixtures/RelayDemo/RelayDemo.xcodeproj' },
        scheme: 'RelayDemo', destination: { platform: 'iOS Simulator', id: udid } };
      if (phase === 'mac') {
        xcode.target.path = 'fixtures/RelayMac/RelayMac.xcodeproj';
        xcode.scheme = 'RelayMac';
        xcode.destination = { platform: 'macOS' };
        await cli('build', xcode);
      }
      if (phase === 'fixture') {
        await cli('build', xcode);
        await cli('install', { lease, udid, app: '.applets-build/Build/Products/Debug-iphonesimulator/RelayDemo.app' });
        await cli('launch', { lease, udid, bundleId: 'com.factory.applets.RelayDemo' });
        await cli('screenshot', { lease, udid });
      }
      await cli('test', xcode);
    }
  } finally {
    if (lease) {
      const released = lease;
      await cli('release', { lease });
      await cli('boot', { lease: released, udid }, 'stale_lease');
    }
  }
}

import { loadConfig, run } from '../src/transport.js';
import { consumeHost } from '../src/stream.js';
import assert from 'node:assert/strict';

// Test-only diagnostic harness. Does not request permissions or capture pixels.
const config = await loadConfig(process.argv[2]);
const { token, generation } = await run(config, 'acquire', { ttlSeconds: 60 });
const lease = { token, generation };
try {
  const pids = new Set();
  for (let attempt = 0; attempt < 2; attempt++) {
    await consumeHost(config, { lease, mode: 'diagnose' }, ({ header }) => {
      assert.equal(header.type, 'diagnostic');
      assert.equal(header.bundleId, 'com.factory.applets.host');
      assert.equal(header.bundlePath, config.workspace + '/.applets-host/Factory Relay.app');
      assert.equal(header.executablePath, header.bundlePath + '/Contents/MacOS/AppletsHost');
      assert.equal(header.launchMode, 'launchservices-ipc');
      assert.equal(header.permissionRequested, false);
      assert.equal(header.stage, 'app_ready');
      assert.deepEqual(header.lifecycle, {
        appKitInitialized: true, eventLoopRunning: true, launchFinished: true, mainThread: true,
      }, 'The permission probe must run inside the initialized AppKit event loop');
      pids.add(header.processId);
      console.log(JSON.stringify(header));
    });
  }
  assert.equal(pids.size, 2, 'Reconnect must launch a fresh helper with the same app identity');
} finally {
  await run(config, 'release', { lease });
}

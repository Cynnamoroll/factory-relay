#!/usr/bin/env node
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './transport.js';
import { RunStore } from './qa-store.js';
import { Broker, nativeAdapter } from './qa-broker.js';
import { createQAServer } from './qa-server.js';
import { WindowSessions } from './qa-window-sessions.js';
import { autoOpenWindowPane } from './qa-pane.js';
import { closeSessions } from './mac-session.js';

const reportCleanupError = error => {
  console.error(/^[a-z_]{1,64}$/.test(error.message) ? error.message : 'session_cleanup_unconfirmed');
};

let broker, service;
try {
  if (process.argv.length < 3 || process.argv.length > 4) throw new Error('usage: node src/qa.js CONFIG [PORT]');
  const port = Number(process.argv[3] ?? 43180);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('invalid_port');
  const config = await loadConfig(process.argv[2]);
  const root = fileURLToPath(new URL('../.qa-workspace/', import.meta.url));
  fs.mkdirSync(root, { mode: 0o700, recursive: true });
  const rootInfo = fs.lstatSync(root.slice(0, -1));
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || rootInfo.uid !== process.getuid() || rootInfo.mode & 0o077)
    throw new Error('unsafe_credentials');
  const adapter = nativeAdapter(config);
  broker = new Broker(new RunStore(root + 'runs'), adapter);
  service = createQAServer(broker, { windowSessions: new WindowSessions(broker, () => nativeAdapter(config),
    { onCleanupError: reportCleanupError }),
    onWindowRun: autoOpenWindowPane(root + 'agent.json') });
  const origin = await service.listen(port);
  // Credentials live outside journals and are replaced only by this workspace launcher.
  for (const [name, body] of [
    ['agent.json', JSON.stringify({ origin, token: service.agentToken }) + '\n'],
    ['browser-code', service.pairingCode + '\n'],
  ]) {
    const file = root + name;
    if (fs.existsSync(file)) {
      const s = fs.lstatSync(file);
      if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid() || s.mode & 0o077)
        throw new Error('unsafe_credentials');
    }
    fs.writeFileSync(file, body, { mode: 0o600 });
  }
  console.log(`factory-relay: ${origin}\nThe first window run opens the assigned Factory pane. To pair manually, run npm run qa:open. No Mac action occurs until you start QA.`);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    try { await service.close(); }
    finally { try { await broker.close(); } finally { await closeSessions(); } }
  };
  const onSignal = () => {
    close().catch(error => {
      reportCleanupError(error);
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
} catch (e) {
  console.error(/^[a-z_]+$/.test(e.message) ? e.message : 'qa_start_failed');
  if (service) await service.close().catch(() => {});
  if (broker) await broker.close().catch(() => {});
  await closeSessions();
  process.exitCode = 1;
}

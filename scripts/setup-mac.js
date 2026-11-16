import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildHost } from './build-host.js';
import { loadConfig, quote, run } from '../src/transport.js';

const base = (await readFile(new URL('../src/remote.py', import.meta.url), 'utf8'))
  .replace('if __name__ == "__main__":\n    main()', '');
export const launchSampleSource = base + `
data=json.load(sys.stdin)
root=private_directory(Path.home()/".applets-control")
with private_open(root/"lock") as lock:
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    if (root/"inflight").exists() or (root/"bridge-session.json").exists(): raise Failure("busy")
    lease=verify_lease(read_state(root),data)
    app=workspace_path(data["workspace"],".applets-build/Build/Products/Debug/RelayMac.app")
    deadline=min(time.monotonic()+20,time.monotonic()+lease["expiresAt"]-time.time())
    execute(["/usr/bin/open",app],deadline)
    host=workspace_path(data["workspace"],".applets-host/Factory Relay.app")
    execute(["/usr/bin/open",host,"--args","--setup"],deadline)
    print(json.dumps({"launched":"RelayMac","permissionSetupOpened":True}))
`;

export async function setupMac(configPath = 'config.local.json') {
  const config = await loadConfig(configPath);
  if (config.transport !== 'factory') throw new Error('setup:mac requires Factory Remote Control.');
  const ready = await run(config, 'preflight', {});
  if (!ready.appleToolsReady || !ready.workspaceReady || !ready.pythonReady)
    throw new Error('Prepare Xcode and create the remote workspace first. See README.md.');
  if (!await buildHost(configPath, { onlyIfAbsent: true })) throw new Error('Host setup failed; existing helper was not intentionally rebuilt.');
  const { token, generation } = await run(config, 'acquire', { ttlSeconds: Math.min(3600, config.timeoutSeconds + 120) });
  const lease = { token, generation };
  try {
    const upload = spawnSync(process.execPath, [fileURLToPath(new URL('./upload-fixture.js', import.meta.url)), configPath],
      { encoding: 'utf8', timeout: 70000, maxBuffer: 1024 * 1024 });
    if (upload.status !== 0) throw new Error('Fixture upload failed; check for differing remote fixture files.');
    await run(config, 'build', { lease, target: { kind: 'project', path: 'fixtures/RelayMac/RelayMac.xcodeproj' },
      scheme: 'RelayMac', destination: { platform: 'macOS' } });
    const launch = spawnSync('droid', ['computer', 'ssh', config.computer, '--', `/usr/bin/python3 -c ${quote(launchSampleSource)}`],
      { input: JSON.stringify({ workspace: config.workspace, owner: config.owner, args: { lease } }),
        encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
    if (launch.status !== 0) throw new Error('Sample launch failed. Keep the Mac desktop logged in and unlocked.');
  } finally {
    await run(config, 'release', { lease });
  }
  console.log('Factory Relay Mac setup complete. Use the Factory Relay setup window on the Mac to request screen recording and control, then approve the macOS prompts.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length > 3) throw new Error('Usage: npm run setup:mac -- [config.local.json]');
    await setupMac(process.argv[2]);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

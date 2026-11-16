import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, mkdir, lstat, writeFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadConfig, quote, run } from '../src/transport.js';
import { consumeHost } from '../src/stream.js';
import { summarizeStream } from './stream-metrics.js';

const config = await loadConfig(process.argv[2]);
const mode = process.argv[3] ?? 'list';
assert.ok(['prepare', 'list', 'capture', 'takeover', 'backpressure'].includes(mode));
assert.equal(config.transport, 'factory');
const workspace = fileURLToPath(new URL('../', import.meta.url));
const root = workspace + '.applets-artifacts';
try { await mkdir(root, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
const info = await lstat(root);
assert.ok(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid() && !(info.mode & 0o077));
assert.ok((await readdir(root)).length < 100, 'Private evidence-directory quota');
const directory = root + '/stream-' + randomBytes(8).toString('hex');
await mkdir(directory, { mode: 0o700 });
const evidence = { mode, startedAt: new Date().toISOString(), directory, runs: [], errors: [],
  measurementScope: 'Bounded single-run observation, not a capacity benchmark. Heartbeats are not frames.' };
const proof = ({ token, generation }) => ({ token, generation });
let lease, ownerConfig = config;

const remoteBase = (await readFile(new URL('../src/remote.py', import.meta.url), 'utf8'))
  .replace('if __name__ == "__main__":\n    main()', '');
const inspectSource = `
import hashlib,plistlib
request=json.loads(sys.stdin.read())
root=private_directory(Path.home()/".applets-control")
app=Path(request["workspace"])/".applets-host/Factory Relay.app"
exe=app/"Contents/MacOS/AppletsHost"
with private_open(root/"lock") as lock:
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    if (root/"inflight").exists() or (root/"bridge-session.json").exists(): raise Failure("busy")
    state=read_state(root)
    verify_lease(state,request)
    preparation={}
    if request["prepare"]:
        sample=Path(request["workspace"])/".applets-build/Build/Products/Debug/RelayMac.app"
        with (sample/"Contents/Info.plist").open("rb") as f:
            if plistlib.load(f)["CFBundleIdentifier"]!="com.factory.applets.RelayMac": raise Failure("target_mismatch")
        with private_open(root/"inflight") as marker:
            marker.write(str(os.getpid()));marker.flush();os.fsync(marker.fileno())
        try:
            execute(["/usr/bin/open",str(sample)],time.monotonic()+10)
            preparation["nativeSampleOpened"]=True
        finally:
            (root/"inflight").unlink()
    commands=subprocess.check_output(["/bin/ps","-axo","command="],text=True).splitlines()
    signature=subprocess.run(["/usr/bin/codesign","--verify","--strict",str(app)],capture_output=True)
    print(json.dumps({"preparation":preparation,"helperSHA256":hashlib.sha256(exe.read_bytes()).hexdigest(),
        "signatureVerified":signature.returncode==0,"generation":state["generation"],
        "inflight":(root/"inflight").exists(),"bridgeSession":(root/"bridge-session.json").exists(),
        "hostProcesses":sum(c.strip().startswith(str(exe)) for c in commands),
        "rendezvousDirectories":len(list(root.glob("s-*"))),
        "uptime":subprocess.check_output(["/usr/bin/uptime"],text=True).strip(),
        "logicalCPUs":int(subprocess.check_output(["/usr/sbin/sysctl","-n","hw.logicalcpu"],text=True))}))
`;
async function inspect(prepare = false) {
  const source = remoteBase + '\n' + inspectSource;
  return new Promise((resolve, reject) => {
    const child = spawn('droid', ['computer', 'ssh', config.computer, '--', `/usr/bin/python3 -c ${quote(source)}`],
      { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let output = '', bytes = 0, failed;
    const stop = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const timer = setTimeout(() => { failed = new Error('inspection_timeout'); stop(); }, 45000);
    child.stdin.on('error', () => {});
    child.on('error', error => { failed = error; });
    for (const [stream, capture] of [[child.stdout, true], [child.stderr, false]]) {
      stream.on('data', data => {
        bytes += data.length;
        if (bytes > 65536) { failed = new Error('inspection_output_limit'); stop(); }
        else if (capture) output += data;
      });
    }
    child.on('close', code => {
      clearTimeout(timer);
      if (failed || code !== 0) reject(failed ?? new Error('inspection_failed'));
      else { try { resolve(JSON.parse(output)); } catch (error) { reject(error); } }
    });
    child.stdin.end(JSON.stringify({ workspace: config.workspace, owner: ownerConfig.owner, args: { lease }, prepare }));
  });
}
async function windows() {
  let result;
  await consumeHost(ownerConfig, { lease, mode: 'windows' }, ({ header }) => {
    assert.equal(header.type, 'windows', JSON.stringify(header));
    result = header.windows;
  });
  return result;
}

async function capture(target, label, action) {
  const controller = new AbortController();
  const start = performance.now();
  const result = { label, target, frames: [], heartbeats: 0, savedFrames: [], expectedStop: 'stream_cancelled' };
  evidence.runs.push(result);
  let firstAt, actionDone = false, stoppedAt;
  const timer = setTimeout(() => { stoppedAt = performance.now(); controller.abort(); }, 35000);
  try {
    await consumeHost(ownerConfig, { lease, target, signal: controller.signal }, async ({ header, image }) => {
      const at = performance.now();
      if (header.type === 'heartbeat') { result.heartbeats++; return; }
      assert.equal(header.type, 'frame', JSON.stringify(header));
      firstAt ??= at;
      assert.ok(result.frames.length < 500, 'Verification frame-count bound');
      const sha256 = createHash('sha256').update(image).digest('hex');
      const record = { ...header, receivedAfterStartMs: at - start, sha256 };
      result.frames.push(record);
      if (!result.savedFrames.some(f => f.sha256 === sha256) && result.savedFrames.length < 12) {
        const path = directory + '/' + label + '-' + header.sequence + '.jpg';
        await writeFile(path, image, { mode: 0o600, flag: 'wx' });
        result.savedFrames.push({ path, sha256, sequence: header.sequence });
      }
      if (!actionDone && action) {
        actionDone = true;
        const began = performance.now();
        await action(result);
        result.actionDurationMs = performance.now() - began;
        result.actionCompletedAfterStartMs = performance.now() - start;
      }
      if (mode === 'backpressure' && label === 'first' && result.frames.length <= 5) {
        const began = performance.now();
        await new Promise(resolve => setTimeout(resolve, 2000));
        record.consumerHoldMs = performance.now() - began;
      }
      if (at - firstAt > 12000 && result.frames.length >= 3 && mode !== 'takeover') {
        stoppedAt = performance.now();
        controller.abort();
      }
    });
    result.stop = 'normal_eof';
  } catch (error) {
    result.stop = error.message;
    if (!['stream_cancelled', 'stale_lease'].includes(error.message)) throw error;
  } finally {
    clearTimeout(timer);
    result.elapsedMs = performance.now() - start;
    if (stoppedAt) result.cancelToCloseMs = performance.now() - stoppedAt;
    Object.assign(result, summarizeStream(result.frames, result.heartbeats));
  }
  assert.ok(result.frames.length > 0, 'The actual stream must deliver an image');
  assert.equal(result.stop, result.expectedStop, 'The run must reach its expected bounded stop');
  return result;
}

try {
  lease = proof(await run(config, 'acquire', { ttlSeconds: 600 }));
  evidence.before = await inspect(mode === 'prepare');
  assert.ok(evidence.before.signatureVerified);
  evidence.windows = await windows();
  if (['capture', 'takeover', 'backpressure'].includes(mode)) {
    const id = Number(process.argv[4]);
    assert.ok(Number.isSafeInteger(id) && id > 0, 'Pass an explicitly listed window ID');
    const selected = evidence.windows.find(w => w.windowId === id);
    assert.ok(selected, 'The exact requested window must still be available');
    const { windowId, pid, bundleId } = selected;
    const target = { windowId, pid, bundleId };
    await capture(target, 'first', mode === 'takeover' ? async result => {
      const human = { ...config, owner: 'human:stream-verification' };
      const acquired = await run(human, 'acquire', { ttlSeconds: 600, takeover: true });
      ownerConfig = human;
      lease = proof(acquired);
      result.expectedStop = 'stale_lease';
    } : undefined);
    if (mode === 'takeover') assert.equal(evidence.runs[0].stop, 'stale_lease');
    evidence.afterFirst = await inspect();
    assert.equal(evidence.afterFirst.hostProcesses, 0);
    assert.equal(evidence.afterFirst.rendezvousDirectories, 0);
    const relisted = await windows();
    assert.ok(relisted.some(w => w.windowId === windowId && w.pid === pid && w.bundleId === bundleId));
    await capture(target, 'reconnect');
  }
} catch (error) {
  evidence.errors.push(error.message);
  process.exitCode = 1;
} finally {
  if (lease) {
    try {
      evidence.after = await inspect();
      if (evidence.before) assert.equal(evidence.before.helperSHA256, evidence.after.helperSHA256, 'The authorized helper binary must not change');
      assert.equal(evidence.after.hostProcesses, 0);
      assert.equal(evidence.after.rendezvousDirectories, 0);
    } catch (error) { evidence.errors.push('cleanup:' + error.message); process.exitCode = 1; }
    try { evidence.release = await run(ownerConfig, 'release', { lease }); }
    catch (error) { evidence.errors.push('release:' + error.message); process.exitCode = 1; }
  }
  await writeFile(directory + '/evidence.json', JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ evidence: directory + '/evidence.json', ...evidence }));
}

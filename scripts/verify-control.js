import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, lstat, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadConfig, quote, run } from '../src/transport.js';
import { control } from '../src/control.js';
import { consumeHost } from '../src/stream.js';


const config = await loadConfig(process.argv[2]);
const mode = process.argv[3] ?? 'diagnose';
assert.ok(['diagnose', 'live'].includes(mode));
const root = fileURLToPath(new URL('../.applets-artifacts', import.meta.url));
await mkdir(root, { recursive: true, mode: 0o700 });
const info = await lstat(root);
assert.ok(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid() && !(info.mode & 0o077));
const directory = root + '/control-' + randomBytes(8).toString('hex');
await mkdir(directory, { mode: 0o700 });
const evidence = { mode, directory, diagnostics: [], streams: [], actions: [], errors: [] };
const base = (await readFile(new URL('../src/remote.py', import.meta.url), 'utf8')).replace('if __name__ == "__main__":\n    main()', '');
const auditSource = base + `
import hashlib,plistlib
request=json.load(sys.stdin)
root=private_directory(Path.home()/".applets-control")
with private_open(root/"lock") as lock:
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    state=read_state(root)
    verify_lease(state,request)
    result={"generation":state["generation"],"inflight":(root/"inflight").exists(),
        "bridgeSession":(root/"bridge-session.json").exists(),"rendezvousDirectories":len(list(root.glob("s-*")))+len(list(root.glob("c-*")))}
    commands=subprocess.check_output(["/bin/ps","-axo","command="],text=True).splitlines()
    for kind,relative,name in [("host",".applets-host","Factory Relay")]:
        directory=Path(request["workspace"])/relative
        app=directory/(name+".app")
        exe=app/"Contents/MacOS/AppletsHost"
        with (app/"Contents/Info.plist").open("rb") as handle:
            plist=plistlib.load(handle)
        signature=subprocess.run(["/usr/bin/codesign","--verify","--strict",str(app)],capture_output=True)
        details=subprocess.run(["/usr/bin/codesign","-d","-r-","--verbose=2",str(app)],capture_output=True,text=True,check=True)
        snapshot={}
        for p in directory.rglob("*"):
            if p.is_symlink(): raise Failure("unsafe_state")
            if p.is_file() and p.name not in ("authored-sha256.json",".DS_Store"):
                snapshot[str(p.relative_to(directory))]=hashlib.sha256(p.read_bytes()).hexdigest()
        result[kind]={"sha256":hashlib.sha256(exe.read_bytes()).hexdigest(),
            "bundleName":plist["CFBundleName"],"displayName":plist["CFBundleDisplayName"],
            "bundleId":plist["CFBundleIdentifier"],"executable":plist["CFBundleExecutable"],
            "packagedExecutables":sorted(p.name for p in exe.parent.iterdir()),
            "signatureVerified":signature.returncode==0,"signature":details.stdout+details.stderr,
            "processes":sum(c.strip().startswith(str(exe)) for c in commands),
            "manifestMatches":snapshot==json.loads((directory/"authored-sha256.json").read_text()),
            "sourcesMatch":all(snapshot[k]==v for k,v in request["hashes"][kind].items())}
    workspace=Path(request["workspace"])
    result["stagingDirectories"]=len(list(workspace.glob(".applets-stage-*")))
    legacy=workspace/".applets-native-control"
    if legacy.exists():
        manifest=json.loads((legacy/"authored-sha256.json").read_text())
        actual={}
        for p in legacy.rglob("*"):
            if p.is_symlink(): raise Failure("unsafe_state")
            if p.is_file() and str(p.relative_to(legacy)) not in ("authored-sha256.json",".DS_Store"):
                actual[str(p.relative_to(legacy))]=hashlib.sha256(p.read_bytes()).hexdigest()
        oldExe=legacy/"Applets Control.app/Contents/MacOS/AppletsControl"
        result["legacy"]={"manifestMatches":actual==manifest,
            "sha256":hashlib.sha256(oldExe.read_bytes()).hexdigest(),
            "processes":sum(c.strip().startswith(str(oldExe)) for c in commands)}
    print(json.dumps(result))
`;
const hashes = { host: {} };
for (const name of ['AppletsHost.swift', 'HostLifecycle.swift', 'AppletsControl.swift', 'Info.plist']) {
  const folder = name === 'AppletsControl.swift' ? 'control' : 'host';
  hashes.host[name === 'Info.plist' ? 'Factory Relay.app/Contents/Info.plist' : name] =
    createHash('sha256').update(await readFile(new URL('../' + folder + '/' + name, import.meta.url))).digest('hex');
}
let owner = config, lease;
const proof = ({ token, generation }) => ({ token, generation });
async function audit() {
  const result = spawnSync('droid', ['computer', 'ssh', config.computer, '--', `/usr/bin/python3 -c ${quote(auditSource)}`],
    { input: JSON.stringify({ workspace: config.workspace, owner: owner.owner, args: { lease }, hashes }),
      encoding: 'utf8', timeout: 45000, maxBuffer: 65536 });
  assert.equal(result.status, 0, 'Read-only helper audit must complete');
  const value = JSON.parse(result.stdout);
  assert.equal(value.host.bundleName, 'Factory Relay');
  assert.equal(value.host.displayName, 'Factory Relay');
  assert.equal(value.host.bundleId, 'com.factory.applets.host');
  assert.equal(value.host.executable, 'AppletsHost');
  assert.deepEqual(value.host.packagedExecutables, ['AppletsHost']);
  for (const kind of ['host']) {
    assert.equal(value[kind].signatureVerified, true);
    assert.equal(value[kind].sourcesMatch, true);
    assert.equal(value[kind].manifestMatches, true);
    assert.equal(value[kind].processes, 0);
  }
  assert.equal(value.stagingDirectories, 0);
  if (value.legacy) {
    assert.equal(value.legacy.manifestMatches, true);
    assert.equal(value.legacy.processes, 0);
  }
  assert.equal(value.inflight, false);
  assert.equal(value.bridgeSession, false);
  assert.equal(value.rendezvousDirectories, 0);
  return value;
}
const active = [];
function stream(target, label) {
  const controller = new AbortController();
  const result = { label, frames: 0, heartbeats: 0, images: [] };
  evidence.streams.push(result);
  let ready;
  const first = new Promise(resolve => { ready = resolve; });
  const timer = setTimeout(() => controller.abort(), 90000);
  const done = consumeHost(owner, { lease, target, signal: controller.signal }, async ({ header, image }) => {
    if (header.type === 'heartbeat') { result.heartbeats++; return; }
    assert.equal(header.type, 'frame');
    result.frames++;
    const hash = createHash('sha256').update(image).digest('hex');
    result.latestSHA256 = hash;
    if (result.images.length < 12 && !result.images.some(row => row.sha256 === hash)) {
      const path = directory + '/' + label + '-' + header.sequence + '.jpg';
      await writeFile(path, image, { flag: 'wx', mode: 0o600 });
      result.images.push({ path, sha256: hash, sequence: header.sequence, captureTimeSeconds: header.captureTimeSeconds });
    }
    ready(true);
  }).then(() => { result.stop = 'normal_eof'; }, error => { result.stop = error.message; })
    .finally(() => { clearTimeout(timer); ready(false); });
  active.push({ controller, done });
  return { first, done, result, controller };
}
const count = observation => {
  const value = observation.snapshot.elements.find(e => e.id === 'relay-count').value;
  assert.match(value, /^Count: \d+$/);
  return Number(value.slice(7));
};
async function observe(target) {
  return control(owner, { operation: 'observe', lease, target });
}
async function press(target, observation) {
  const result = await control(owner, { operation: 'press', lease, target,
    observationId: observation.observationId, elementId: 'relay-increment' });
  evidence.actions.push({ owner: owner.owner, result });
}
async function changedImage(connection, previous) {
  const end = performance.now() + 3000;
  while (connection.result.latestSHA256 === previous && !connection.result.stop && performance.now() < end)
    await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(connection.result.stop, undefined, 'Short native action must not terminate its live stream');
  assert.notEqual(connection.result.latestSHA256, previous, 'Changed count must accompany a changed streamed image');
  evidence.actions.at(-1).imageChange = { before: previous, after: connection.result.latestSHA256 };
}
try {
  lease = proof(await run(config, 'acquire', { ttlSeconds: 600 }));
  evidence.before = await audit();
  for (let i = 0; i < 2; i++) evidence.diagnostics.push(await control(config, { operation: 'diagnose', lease }));
  assert.notEqual(evidence.diagnostics[0].processId, evidence.diagnostics[1].processId);
  await consumeHost(config, { lease, mode: 'diagnose' }, ({ header }) => { evidence.captureDiagnostic = header; });
  for (const diagnostic of evidence.diagnostics) {
    assert.equal(diagnostic.bundleId, 'com.factory.applets.host');
    assert.equal(diagnostic.bundlePath, config.workspace + '/.applets-host/Factory Relay.app');
    assert.equal(diagnostic.executablePath, diagnostic.bundlePath + '/Contents/MacOS/AppletsHost');
    for (const field of ['bundleId', 'bundlePath', 'executablePath', 'screenRecording', 'accessibility'])
      assert.equal(diagnostic[field], evidence.captureDiagnostic[field], 'Both clients must use the same permission identity');
  }
  if (evidence.diagnostics.some(d => !d.accessibility)) {
    evidence.blocked = 'accessibility_required';
    if (mode === 'live') process.exitCode = 2;
  } else if (!evidence.captureDiagnostic.screenRecording) {
    evidence.blocked = 'screen_recording_required';
    if (mode === 'live') process.exitCode = 2;
  } else if (mode === 'live') {
    let windows;
    await consumeHost(owner, { lease, mode: 'windows' }, ({ header }) => { windows = header.windows; });
    const selected = windows?.find(w => w.windowId === Number(process.argv[4]) && w.bundleId === 'com.factory.applets.RelayMac');
    assert.ok(selected, 'Pass a freshly enumerated own RelayMac window ID');
    const { windowId, pid, bundleId } = selected;
    const target = { windowId, pid, bundleId };
    evidence.target = target;
    const agentStream = stream(target, 'agent');
    assert.equal(await agentStream.first, true, 'Agent stream must produce real pixels before input');
    const zero = await observe(target);
    const initial = count(zero);
    const zeroImage = agentStream.result.latestSHA256;
    await press(target, zero);
    const one = await observe(target);
    assert.equal(count(one), initial + 1, 'Fresh AX observation must confirm the agent press');
    await changedImage(agentStream, zeroImage);
    const oldLease = lease;
    const human = { ...config, owner: 'human:native-control-verification' };
    const humanLease = await run(human, 'acquire', { ttlSeconds: 600, takeover: true });
    owner = human;
    lease = proof(humanLease);
    await agentStream.done;
    assert.equal(agentStream.result.stop, 'stale_lease', 'Takeover must fence the old stream');
    await assert.rejects(control(config, { operation: 'press', lease: oldLease, target,
      observationId: one.observationId, elementId: 'relay-increment' }), /stale_lease/);
    evidence.staleLeaseRejected = true;
    const humanStream = stream(target, 'human');
    assert.equal(await humanStream.first, true, 'The human owner must reconnect');
    const fresh = await observe(target);
    assert.equal(count(fresh), initial + 1, 'Rejected stale input must not mutate count');
    const oneImage = humanStream.result.latestSHA256;
    await press(target, fresh);
    const two = await observe(target);
    assert.equal(count(two), initial + 2, 'Fresh observation must confirm the human press');
    await changedImage(humanStream, oneImage);
    await assert.rejects(press(target, fresh), /observation_stale/);
    assert.equal(count(await observe(target)), initial + 2, 'Replayed observation must not press again');
    evidence.staleObservationRejected = true;
    evidence.verifiedCounts = [initial, count(one), count(two)];
    humanStream.controller.abort();
    await humanStream.done;
    assert.equal(humanStream.result.stop, 'stream_cancelled');
  }
} catch (error) {
  evidence.errors.push(error.message);
  process.exitCode = 1;
} finally {
  for (const item of active) item.controller.abort();
  await Promise.all(active.map(item => item.done));
  if (lease) {
    try { evidence.after = await audit();
      assert.equal(evidence.after.host.sha256, evidence.before.host.sha256, 'Verification must not rebuild the helper');
      assert.deepEqual(evidence.after.legacy, evidence.before.legacy, 'Legacy rollback material must remain untouched'); }
    catch (error) { evidence.errors.push('cleanup:' + error.message); process.exitCode = 1; }
    try { evidence.release = await run(owner, 'release', { lease }); }
    catch (error) { evidence.errors.push('release:' + error.message); process.exitCode = 1; }
  }
  await writeFile(directory + '/evidence.json', JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(evidence));
}

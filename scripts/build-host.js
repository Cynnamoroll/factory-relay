import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { loadConfig, quote, run } from '../src/transport.js';
import { appIconIcns } from './app-icon.js';

export const hostSourceNames = ['AppletsHost.swift', 'HostLifecycle.swift', 'AppletsControl.swift', 'Info.plist', 'AppIcon.icns'];
/** Text sources are read from the repository; the icon is rendered from scripts/app-icon.js and sent as base64. */
export async function hostFiles() {
  return Object.fromEntries(await Promise.all(hostSourceNames.map(async name => [name, name === 'AppIcon.icns'
    ? appIconIcns().toString('base64')
    : await readFile(new URL((name === 'AppletsControl.swift' ? '../control/' : '../host/') + name, import.meta.url), 'utf8')])));
}
const base = (await readFile(new URL('../src/remote.py', import.meta.url), 'utf8'))
  .replace('if __name__ == "__main__":\n    main()', '');
export const hostBuildSource = base + `
import base64,hashlib,socket,tempfile,zipfile
os.umask(0o077)
data=json.load(sys.stdin)
workspace=Path(data["workspace"])
root=workspace/".applets-host"
authority=private_directory(Path.home()/".applets-control")
def snapshot(directory):
    result={}
    for p in directory.rglob("*"):
        if p.is_symlink(): raise RuntimeError("symlink in helper files")
        if p.is_file() and str(p.relative_to(directory)) not in ("authored-sha256.json",".DS_Store"):
            result[str(p.relative_to(directory))]=hashlib.sha256(p.read_bytes()).hexdigest()
    return result
def validate():
    if root.is_symlink() or not root.resolve().is_relative_to(workspace.resolve()):
        raise RuntimeError("unsafe host path")
    if root.exists():
        manifest=root/"authored-sha256.json"
        if not manifest.is_file() or manifest.is_symlink() or snapshot(root)!=json.loads(manifest.read_text()):
            raise RuntimeError("Refusing unknown or changed helper-owned files")
def stop_serving():
    # The persistent host would keep the old executable running; ask it to exit under the exclusive lease.
    endpoint=authority/"host"/"relay.sock"
    if not endpoint.is_socket(): return
    try:
        with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as connection:
            connection.settimeout(3)
            connection.connect(str(endpoint))
            connection.recv(1024)
            connection.sendall(b'{"type":"control"}\\n{"id":1,"operation":"shutdown"}\\n')
            connection.recv(1024)
    except OSError:
        pass
    for _ in range(50):
        if not endpoint.exists(): return
        time.sleep(0.1)
def idle(allow_serving=False):
    if (authority/"inflight").exists() or (authority/"bridge-session.json").exists(): raise Failure("busy")
    if verify_lease(read_state(authority),data)["scope"]["kind"]!="exclusive": raise Failure("lease_scope")
    commands=subprocess.check_output(["/bin/ps","-axo","command="],text=True).splitlines()
    executables=tuple(str(root/name/"Contents/MacOS/AppletsHost") for name in ("Applets Host.app","Factory Relay.app"))
    # Reusing an approved host changes nothing, so a running background host may keep serving.
    if any(c.strip().startswith(executables) and not (allow_serving and " serve " in c) for c in commands): raise Failure("busy")
with private_open(authority/"lock") as lock:
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    if (authority/"inflight").exists() or (authority/"bridge-session.json").exists(): raise Failure("busy")
    if verify_lease(read_state(authority),data)["scope"]["kind"]!="exclusive": raise Failure("lease_scope")
    validate()
    if not data.get("onlyIfAbsent"): stop_serving()
    idle(allow_serving=bool(data.get("onlyIfAbsent")))
    if data.get("onlyIfAbsent") and root.exists():
        if (root/"Applets Host.app").exists():
            raise RuntimeError("Existing Applets Host requires an intentional upgrade to Factory Relay; run node scripts/build-host.js <config.json> first. Setup will not rebuild an approved host.")
        for name,body in data["files"].items():
            relative="Factory Relay.app/Contents/Info.plist" if name=="Info.plist" else "Factory Relay.app/Contents/Resources/AppIcon.icns" if name=="AppIcon.icns" else name
            expected=base64.b64decode(body) if name=="AppIcon.icns" else body.encode()
            if not (root/relative).is_file() or (root/relative).read_bytes()!=expected:
                raise RuntimeError("Existing host sources differ; setup will not rebuild an approved host")
        app=root/"Factory Relay.app"
        if sorted(p.name for p in (app/"Contents/MacOS").iterdir())!=["AppletsHost"]:
            raise RuntimeError("Expected one packaged executable")
        subprocess.run(["/usr/bin/codesign","--verify","--strict",str(app)],check=True)
        print(json.dumps({"reusedApp":str(app),"rebuilt":False}))
        sys.exit(0)
    original=snapshot(root)
    with tempfile.TemporaryDirectory(prefix=".applets-stage-",dir=workspace) as temporary:
        stage=Path(temporary)/"candidate"
        app=stage/"Factory Relay.app"
        exe=app/"Contents/MacOS/AppletsHost"
        exe.parent.mkdir(parents=True)
        for name in ("AppletsHost.swift","HostLifecycle.swift","AppletsControl.swift"):
            (stage/name).write_text(data["files"][name])
        (app/"Contents/Info.plist").write_text(data["files"]["Info.plist"])
        (app/"Contents/Resources").mkdir()
        (app/"Contents/Resources/AppIcon.icns").write_bytes(base64.b64decode(data["files"]["AppIcon.icns"],validate=True))
        subprocess.run(["/usr/bin/xcrun","swiftc","-parse-as-library","-swift-version","5",
            "-target","arm64-apple-macos14.0","-O",
            *[str(stage/name) for name in ("AppletsHost.swift","HostLifecycle.swift","AppletsControl.swift")],
            "-o",str(exe)],check=True)
        subprocess.run(["/usr/bin/codesign","--force","--sign","-","--identifier","com.factory.applets.host",str(app)],check=True)
        subprocess.run(["/usr/bin/codesign","--verify","--strict",str(app)],check=True)
        signature=subprocess.run(["/usr/bin/codesign","-d","-r-","--verbose=2",str(app)],capture_output=True,text=True,check=True)
        if sorted(p.name for p in exe.parent.iterdir())!=["AppletsHost"]:
            raise RuntimeError("Expected one packaged executable")
        idle()
        validate()
        if snapshot(root)!=original: raise RuntimeError("Helper changed during build")
        backup=None
        previous=Path(temporary)/"previous"
        if root.exists():
            backup=workspace/(".applets-host-backup-"+secrets.token_hex(8)+".zip")
            with zipfile.ZipFile(backup,"x",compression=zipfile.ZIP_DEFLATED) as archive:
                for p in root.rglob("*"):
                    if p.is_file(): archive.write(p,str(p.relative_to(root)))
            os.chmod(backup,0o600)
            if (root/".DS_Store").exists():
                (stage/".DS_Store").write_bytes((root/".DS_Store").read_bytes())
        (stage/"authored-sha256.json").write_text(json.dumps(snapshot(stage),sort_keys=True))
        if root.exists(): root.rename(previous)
        try:
            stage.rename(root)
        except BaseException:
            if previous.exists(): previous.rename(root)
            raise
        print(json.dumps({"builtApp":str(root/"Factory Relay.app"),"bundleId":"com.factory.applets.host",
            "sha256":hashlib.sha256((root/"Factory Relay.app/Contents/MacOS/AppletsHost").read_bytes()).hexdigest(),
            "signature":signature.stdout+signature.stderr,"backup":str(backup) if backup else None,
            "packagedExecutables":["AppletsHost"]}))
`;

export async function buildHost(configPath, { onlyIfAbsent = false } = {}) {
  const config = await loadConfig(configPath);
  if (config.transport !== 'factory') throw new Error('Factory relay required');
  const files = await hostFiles();
  const { token, generation } = await run(config, 'acquire', { ttlSeconds: 240 });
  const lease = { token, generation };
  try {
    const result = spawnSync('droid', ['computer', 'ssh', config.computer, '--', `/usr/bin/python3 -c ${quote(hostBuildSource)}`],
      { input: JSON.stringify({ workspace: config.workspace, owner: config.owner, args: { lease }, files, onlyIfAbsent }),
        encoding: 'utf8', timeout: 180000, maxBuffer: 1024 * 1024 });
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    process.exitCode = result.status ?? 1;
    return result.status === 0;
  } finally {
    console.log(JSON.stringify({ release: await run(config, 'release', { lease }) }));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await buildHost(process.argv[2]);

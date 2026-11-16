import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { hostBuildSource, hostSourceNames } from '../scripts/build-host.js';

test('legacy host migration backs up the old app, refuses busy or implicit upgrades, and preserves failed builds', () => {
  assert.deepEqual(hostSourceNames, ['AppletsHost.swift', 'HostLifecycle.swift', 'AppletsControl.swift', 'Info.plist']);
  const harness = `
import contextlib,hashlib,io,json,pathlib,subprocess,sys,tempfile,time,zipfile
from unittest.mock import patch
source=json.load(sys.stdin)["source"]
with tempfile.TemporaryDirectory() as temporary:
    workspace=pathlib.Path(temporary)
    authority=workspace/".applets-control"
    authority.mkdir(mode=0o700)
    state=authority/"state.json"
    state.write_text(json.dumps({"generation":1,"lease":{"owner":"test","token":"a"*64,"expiresAt":time.time()+120}}))
    state.chmod(0o600)
    root=workspace/".applets-host"
    app=root/"Applets Host.app"
    exe=app/"Contents/MacOS/AppletsHost"
    exe.parent.mkdir(parents=True)
    exe.write_bytes(b"previous authored executable")
    (root/"AppletsHost.swift").write_text("previous authored source")
    (app/"Contents/Info.plist").write_text("previous authored plist")
    manifest=root/"authored-sha256.json"
    def snapshot():
        return {str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest()
                for p in root.rglob("*") if p.is_file() and p!=manifest and p!=root/".DS_Store"}
    manifest.write_text(json.dumps(snapshot()))
    (root/".DS_Store").write_text("Finder metadata belongs to the user")
    files={"AppletsHost.swift":"new capture source","HostLifecycle.swift":"new AppKit lifecycle source","AppletsControl.swift":"new AX source","Info.plist":"new plist"}
    legacy=workspace/".applets-native-control/Applets Control.app/Contents/MacOS/AppletsControl"
    legacy.parent.mkdir(parents=True)
    legacy.write_bytes(b"legacy rollback")
    calls=[]
    failing=None
    def fake_run(argv,**options):
        calls.append(argv)
        if failing and failing in argv:
            raise subprocess.CalledProcessError(1,argv)
        if argv[0]=="/usr/bin/xcrun":
            assert {pathlib.Path(a).name for a in argv if a.endswith(".swift")}=={"AppletsHost.swift","HostLifecycle.swift","AppletsControl.swift"}
            assert not str(pathlib.Path(argv[argv.index("-o")+1])).startswith(str(root))
            pathlib.Path(argv[argv.index("-o")+1]).write_bytes(b"compiled test executable")
        return subprocess.CompletedProcess(argv,0,stdout="signature",stderr="")
    def build(only_if_absent=False,processes=("", "")):
        data=json.dumps({"workspace":str(workspace),"files":files,"owner":"test","args":{"lease":{"token":"a"*64,"generation":1}},"onlyIfAbsent":only_if_absent})
        output=io.StringIO()
        with patch("pathlib.Path.home",return_value=workspace),patch("subprocess.check_output",side_effect=processes),patch("subprocess.run",fake_run),patch("sys.stdin",io.StringIO(data)),contextlib.redirect_stdout(output):
            exec(source,{"__name__":"__main__"})
        return json.loads(output.getvalue())
    before={str(p):p.read_bytes() for p in root.rglob("*") if p.is_file()}
    try:
        build(only_if_absent=True)
        raise AssertionError("setup must not silently migrate an approved legacy app")
    except RuntimeError as error:
        assert "intentional upgrade to Factory Relay" in str(error)
        assert "node scripts/build-host.js <config.json>" in str(error)
    assert not calls, "implicit migration must not compile or sign"
    assert before=={str(p):p.read_bytes() for p in root.rglob("*") if p.is_file()}
    for name in ("Applets Host.app","Factory Relay.app"):
        running=str(root/name/"Contents/MacOS/AppletsHost")+" --setup"
        for processes in ((running,""),("",running)):
            count=len(calls)
            try:
                build(processes=processes)
                raise AssertionError("a running old or new app must prevent replacement")
            except Exception as error:
                assert type(error).__name__=="Failure", type(error)
                assert str(error)=="busy", str(error)
            if processes[0]: assert len(calls)==count, "busy apps must prevent compilation"
            assert before=={str(p):p.read_bytes() for p in root.rglob("*") if p.is_file()}
            assert not list(workspace.glob(".applets-stage-*"))
            assert not list(workspace.glob(".applets-host-backup-*.zip"))
    for failing in ("swiftc","--sign","--verify"):
        try:
            build()
            raise AssertionError("failed build accepted")
        except subprocess.CalledProcessError:
            pass
        assert before=={str(p):p.read_bytes() for p in root.rglob("*") if p.is_file()}
        assert not list(workspace.glob(".applets-stage-*"))
        assert not list(workspace.glob(".applets-host-backup-*.zip"))
    failing=None
    calls.clear()
    extra=root/"operator-notes.txt"
    extra.write_text("do not overwrite")
    try:
        build()
        raise AssertionError("unknown legacy files must block migration")
    except RuntimeError as error:
        assert "Refusing unknown or changed" in str(error)
    assert not calls
    assert extra.read_text()=="do not overwrite"
    extra.unlink()
    assert before=={str(p):p.read_bytes() for p in root.rglob("*") if p.is_file()}
    result=build()
    new_app=root/"Factory Relay.app"
    assert result["builtApp"]==str(new_app)
    assert result["bundleId"]=="com.factory.applets.host"
    assert result["packagedExecutables"]==["AppletsHost"]
    assert (new_app/"Contents/MacOS/AppletsHost").read_bytes()==b"compiled test executable"
    assert not app.exists(), "successful migration must replace the legacy app, not leave a second launch target"
    backups=list(workspace.glob(".applets-host-backup-*.zip"))
    assert len(backups)==1
    assert result["backup"]==str(backups[0])
    assert backups[0].stat().st_mode&0o777==0o600
    with zipfile.ZipFile(backups[0]) as archive:
        assert archive.read("Applets Host.app/Contents/MacOS/AppletsHost")==b"previous authored executable"
        assert {str(root/name):archive.read(name) for name in archive.namelist()}==before
    assert (root/"HostLifecycle.swift").read_text()==files["HostLifecycle.swift"]
    assert json.loads(manifest.read_text())==snapshot()
    assert (root/".DS_Store").read_text()=="Finder metadata belongs to the user"
    assert legacy.read_bytes()==b"legacy rollback"
    assert len(calls)==4
    build()
    assert json.loads(manifest.read_text())==snapshot()
    def refuse_without_writing():
        before={str(p):p.read_bytes() for p in root.rglob("*") if p.is_file()}
        count=len(calls)
        try:
            build()
            raise AssertionError("unknown remote work was overwritten")
        except RuntimeError as error:
            assert "Refusing unknown or changed" in str(error)
        assert len(calls)==count
        assert before=={str(p):p.read_bytes() for p in root.rglob("*") if p.is_file()}
    extra=root/"operator-notes.txt"
    extra.write_text("do not overwrite")
    refuse_without_writing()
    extra.unlink()
    (root/"AppletsHost.swift").write_text("unrecorded operator edit")
    refuse_without_writing()
print("legacy-to-Factory Relay migration, backup, old/new process fencing, compile/sign rollback and unknown-work refusal passed")
`;
  const result = spawnSync('python3', ['-c', harness], {
    input: JSON.stringify({ source: hostBuildSource }), encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /legacy-to-Factory Relay migration, backup, old\/new process fencing, compile\/sign rollback and unknown-work refusal passed/);
});

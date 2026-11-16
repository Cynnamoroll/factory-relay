import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('..', import.meta.url));
const fakeDroid = `#!/usr/bin/env python3
import io,json,os,pathlib,shlex,subprocess,sys
from unittest.mock import patch
root=pathlib.Path(os.environ["TEST_REMOTE"])
data=json.load(sys.stdin)
source=shlex.split(sys.argv[-1])[2]
def log(value):
    with (root/"calls").open("a") as f: f.write(value+"\\n")
kind=data.get("operation") or ("host" if "onlyIfAbsent" in data else "upload" if "files" in data else "launch")
log(kind)
if os.environ.get("TEST_FAIL")==kind and kind in ("upload","launch"): sys.exit(1)
real_popen=subprocess.Popen
def popen(argv,**kwargs):
    if argv[0].startswith("/usr/bin/"):
        if argv[0]=="/usr/bin/open":
            if "--setup" in argv: assert argv[1]==str(root/"workspace with spaces"/".applets-host/Factory Relay.app")
            log("open:permissions" if "--setup" in argv else "open:sample")
        log(pathlib.Path(argv[0]).name+":"+("build" if "build" in argv else "probe"))
        if "build" in argv:
            if os.environ.get("TEST_FAIL")=="build": return real_popen([sys.executable,"-c","raise SystemExit(1)"],**kwargs)
            app=root/"workspace with spaces"/".applets-build/Build/Products/Debug/RelayMac.app"
            app.mkdir(parents=True,exist_ok=True)
        return real_popen([sys.executable,"-c","print('{}')"],**kwargs)
    return real_popen(argv,**kwargs)
def native_run(argv,**kwargs):
    log("native:"+("swiftc" if "swiftc" in argv else "sign" if "--sign" in argv else "verify" if "--verify" in argv else "details"))
    if "swiftc" in argv:
        if os.environ.get("TEST_FAIL")=="host": raise subprocess.CalledProcessError(1,argv)
        pathlib.Path(argv[argv.index("-o")+1]).write_bytes(b"fake approved host")
    return subprocess.CompletedProcess(argv,0,stdout="signature",stderr="")
stdin=io.TextIOWrapper(io.BytesIO(json.dumps(data).encode()))
with patch("pathlib.Path.home",return_value=root),patch("sys.stdin",stdin),patch("subprocess.Popen",popen),patch("subprocess.run",native_run),patch("subprocess.check_output",return_value=""):
    exec(source,{"__name__":"__main__"})
`;

function machine(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory relay mac ' "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'bin'));
  fs.mkdirSync(path.join(root, 'workspace with spaces'));
  fs.writeFileSync(path.join(root, 'bin/droid'), fakeDroid, { mode: 0o700 });
  const config = path.join(root, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ transport: 'factory', computer: 'test-mac',
    workspace: path.join(root, 'workspace with spaces'), owner: 'test:setup', timeoutSeconds: 30 }));
  return { root, config, host: path.join(root, 'workspace with spaces/.applets-host'),
    run(fail = '') {
      return spawnSync(process.execPath, [path.join(project, 'scripts/setup-mac.js'), config], {
        cwd: project, env: { ...process.env, PATH: path.join(root, 'bin') + ':' + process.env.PATH,
          TEST_REMOTE: root, TEST_FAIL: fail }, encoding: 'utf8', timeout: 30000,
      });
    },
    calls() { return fs.readFileSync(path.join(root, 'calls'), 'utf8').trim().split('\n'); },
    state() { return JSON.parse(fs.readFileSync(path.join(root, '.applets-control/state.json'))); },
  };
}

test('setup:mac builds once, opens the sample, reuses approved host and releases leases', t => {
  const m = machine(t), first = m.run();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Factory Relay Mac setup complete/);
  assert.equal(m.state().lease, null);
  assert.equal(m.calls().filter(x => x === 'native:swiftc').length, 1);
  assert.ok(m.calls().includes('upload'));
  assert.ok(m.calls().includes('build'));
  assert.ok(m.calls().includes('launch'));
  assert.ok(m.calls().includes('open:permissions'));
  assert.ok(m.calls().includes('open:sample'));
  const exe = path.join(m.host, 'Factory Relay.app/Contents/MacOS/AppletsHost');
  const before = { bytes: fs.readFileSync(exe), mtime: fs.statSync(exe).mtimeMs };
  const second = m.run();
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /"rebuilt": false/);
  assert.deepEqual({ bytes: fs.readFileSync(exe), mtime: fs.statSync(exe).mtimeMs }, before);
  assert.equal(m.calls().filter(x => x === 'native:swiftc').length, 1, 'Repeat setup must not compile the approved host');
  assert.equal(m.state().lease, null);
  assert.equal(fs.existsSync(path.join(m.root, '.applets-control/inflight')), false);
  assert.equal(fs.readdirSync(path.dirname(m.host)).some(n => n.startsWith('.applets-host-backup-')), false);
  assert.doesNotMatch(first.stdout + first.stderr + second.stdout + second.stderr, /"token"\s*:/);
});

test('setup:mac releases its lease on host, upload, build and launch errors', t => {
  for (const failure of ['host', 'upload', 'build', 'launch']) {
    const m = machine(t), result = m.run(failure);
    assert.equal(result.status, 1, failure);
    assert.equal(m.state().lease, null, failure + ' must release the lease');
    assert.equal(fs.existsSync(path.join(m.root, '.applets-control/inflight')), false);
    if (failure !== 'launch') assert.equal(m.calls().includes('launch'), false);
    assert.doesNotMatch(result.stdout + result.stderr, /"token"\s*:/);
  }
});

test('setup:mac refuses another owner without stealing its lease or changing the host', t => {
  const m = machine(t);
  assert.equal(m.run().status, 0);
  const stateFile = path.join(m.root, '.applets-control/state.json');
  const state = { generation: 50, lease: { owner: 'human:other', token: 'a'.repeat(64), expiresAt: Date.now() / 1000 + 600 } };
  fs.writeFileSync(stateFile, JSON.stringify(state));
  const before = m.calls().length;
  const result = m.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /lease_held/);
  assert.deepEqual(m.state(), state);
  assert.deepEqual(m.calls().slice(before).filter(x => ['host', 'upload', 'build', 'launch'].includes(x)), []);
});

test('setup:mac refuses changed host files and recognized but outdated host sources', t => {
  const m = machine(t);
  assert.equal(m.run().status, 0);
  const source = path.join(m.host, 'AppletsHost.swift');
  fs.appendFileSync(source, '\nchanged source\n');
  const before = m.calls().length;
  let result = m.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Refusing unknown or changed/);
  assert.equal(m.state().lease, null);
  assert.equal(m.calls().slice(before).includes('native:swiftc'), false);
  const manifest = path.join(m.host, 'authored-sha256.json');
  const update = spawnSync('python3', ['-c', 'import hashlib,json,pathlib,sys; p=pathlib.Path(sys.argv[1]); m=json.loads(p.read_text()); m["AppletsHost.swift"]=hashlib.sha256((p.parent/"AppletsHost.swift").read_bytes()).hexdigest(); p.write_text(json.dumps(m))', manifest], { encoding: 'utf8' });
  assert.equal(update.status, 0, update.stderr);
  result = m.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /setup will not rebuild an approved host/);
  assert.equal(m.state().lease, null);
  assert.equal(m.calls().slice(before).includes('native:swiftc'), false);
});

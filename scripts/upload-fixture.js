import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { loadConfig, quote } from '../src/transport.js';

const config = await loadConfig(process.argv[2]);
if (config.transport !== 'factory') throw new Error('This explicit fixture setup uses Factory relay');
const names = ['App.swift', 'RelayModel.swift', 'RelayDemoTests.swift', 'RelayDemo.xcodeproj/project.pbxproj',
  'RelayDemo.xcodeproj/xcshareddata/xcschemes/RelayDemo.xcscheme'];
const paths = [...names, 'RelayDemoUITests.swift'].map(name => 'RelayDemo/' + name)
  .concat([...names, 'RelayDemoUITests.swift'].map(name => 'RelayMac/' + name.replaceAll('RelayDemo', 'RelayMac')));
const files = Object.fromEntries(await Promise.all(paths.map(async name =>
  [name, await readFile(new URL('../fixtures/' + name, import.meta.url), 'utf8')])));
const previous = JSON.parse(await readFile(
  new URL('../fixtures/previous-sha256.json', import.meta.url), 'utf8'));
const source = `
import hashlib,json,pathlib,sys
data=json.load(sys.stdin)
root=pathlib.Path(data["workspace"])/"fixtures"
for name,body in data["files"].items():
    path=root/name
    if not path.resolve().is_relative_to(pathlib.Path(data["workspace"]).resolve()):
        raise RuntimeError("Refusing a path outside the workspace")
    if path.exists() and (path.is_symlink() or (path.read_text()!=body and
            hashlib.sha256(path.read_bytes()).hexdigest() not in data["previous"].get(name,[]))):
        raise RuntimeError("Refusing to overwrite an existing differing fixture: "+name)
for name,body in data["files"].items():
    path=root/name
    path.parent.mkdir(parents=True,exist_ok=True)
    if not path.exists():
        with path.open("x") as f: f.write(body)
    elif path.read_text()!=body:
        path.write_text(body)
print(json.dumps({"uploadedFiles":len(data["files"]),"remoteRoot":str(root)}))
`;
const result = spawnSync('droid', ['computer', 'ssh', config.computer, '--', `/usr/bin/python3 -c ${quote(source)}`],
  { input: JSON.stringify({ workspace: config.workspace, files, previous }), encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 });
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
process.exitCode = result.status ?? 1;

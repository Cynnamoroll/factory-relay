import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('observation publication replaces a longer private record without trailing bytes', () => {
  const source = `
import ast,json,pathlib,tempfile
ns={"__name__":"test"}
exec(pathlib.Path("src/remote.py").read_text(),ns)
tree=ast.parse(pathlib.Path("src/visual.py").read_text())
fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=="perform_visual")
statement=next(n for n in fn.body if isinstance(n,ast.With) and "observation.json" in ast.unparse(n.items[0]))
with tempfile.TemporaryDirectory() as temp:
    root=pathlib.Path(temp)
    record={"id":"short"}
    (root/"observation.json").write_text(json.dumps({"id":"x"*500}))
    (root/"observation.json").chmod(0o600)
    ns.update(root=root,record=record)
    exec(compile(ast.Module(body=[statement],type_ignores=[]),"<publication>","exec"),ns)
    assert json.loads((root/"observation.json").read_text())==record
print("shorter observation JSON remains readable")
`;
  const result = spawnSync('python3', ['-c', source], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /remains readable/);
});

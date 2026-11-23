import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunStore, opaque } from '../src/qa-store.js';
import { Broker } from '../src/qa-broker.js';
import { createQAServer } from '../src/qa-server.js';
import { mediaProcess } from '../src/qa-export.js';

const artifacts = fileURLToPath(new URL('../.applets-artifacts/', import.meta.url));
const mode = process.argv[2];
if (!['--prepare', '--serve'].includes(mode)) throw new Error('usage: --prepare or --serve GENERATED_FIXTURE_DIRECTORY');
let root;
if (mode === '--prepare') {
  root = path.join(artifacts, 'qa-ui-' + opaque());
  fs.mkdirSync(root, { mode: 0o700 });
} else {
  root = process.argv[3];
  if (!root || path.dirname(root) !== artifacts.slice(0, -1) || !/^qa-ui-[a-f0-9]{32}$/.test(path.basename(root)))
    throw new Error('invalid_fixture_directory');
}
const info = fs.lstatSync(root);
if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || info.mode & 0o077) throw new Error('unsafe_fixture_directory');
const store = new RunStore(path.join(root, 'runs'));
const blocked = async () => { throw new Error('generated_fixture_has_no_native_target'); };
const broker = new Broker(store, { acquire: blocked, release: blocked, stream: blocked, windows: blocked, observe: blocked, press: blocked });
if (mode === '--prepare') {
  try {
    const imageFile = path.join(root, 'generated.jpg');
    fs.writeFileSync(imageFile, '', { mode: 0o600 });
    await mediaProcess('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x182535:s=960x600',
      '-vf', "drawtext=text='GENERATED LOCAL UI TEST':fontcolor=white:fontsize=34:x=(w-text_w)/2:y=240,drawtext=text='Not a Mac capture or product QA result':fontcolor=white:fontsize=20:x=(w-text_w)/2:y=300",
      '-frames:v', '1', '-threads', '2', imageFile]);
    const bytes = fs.readFileSync(imageFile);
    const r = store.start(null, { title: 'Generated local UI test · not Mac QA',
      context: 'Synthetic evidence to verify player, checks, gaps and authenticated media routes only' }, 'test-fixture');
    let version = 0;
    const passStep = opaque(), failStep = opaque();
    const at = ms => { r.monoStart = performance.now() - ms; };
    for (let ms = 0; ms < 8000; ms += 200) {
      at(ms);
      if (ms === 2000) { store.append(r, { kind: 'gap', reason: 'generated_missing_footage_interval' }); }
      if (ms < 2000 || ms >= 3400) store.frame(r, { image: bytes, version: ++version,
        receivedAt: Date.now(), receivedMono: performance.now(), header: { type: 'frame', sequence: version, captureTimeSeconds: ms / 1000 } }, true);
      if ([1000, 4400].includes(ms)) {
        const failed = ms === 4400, stepId = failed ? failStep : passStep;
        store.append(r, { kind: 'step-start', stepId, operation: 'assert-count', title: failed ? 'Intentional generated mismatch' : 'Generated matching count' });
      }
      if ([1800, 5400].includes(ms)) {
        const failed = ms === 5400, stepId = failed ? failStep : passStep;
        store.append(r, { kind: 'assertion', stepId, title: failed ? 'Intentional generated mismatch' : 'Generated matching count',
          context: 'Synthetic UI test only. Not a claim about the remote application.', expected: failed ? 5 : 1, actual: 1, status: failed ? 'fail' : 'pass' });
      }
    }
    at(8000); store.finish(r, 'fail', 'generated_ui_fixture');
    broker.exports.request(r.id, false, 'qa');
    const exportState = await broker.exports.wait(r.id, 30000, 'qa');
    if (exportState.status !== 'ready') throw new Error(exportState.code ?? 'fixture_export_not_ready');
    console.log(JSON.stringify({ directory: root, runId: r.id, failureStepId: r.events.find(e => e.kind === 'assertion' && e.status === 'fail').stepId,
      video: broker.exports.artifact(r.id, 'qa-v4-recording.mp4').file, durationMs: exportState.durationMs }));
  } finally { await broker.close(); }
} else {
  const service = createQAServer(broker);
  const origin = await service.listen(43181);
  fs.writeFileSync(path.join(root, 'agent.json'), JSON.stringify({ origin, token: service.agentToken }), { mode: 0o600 });
  fs.writeFileSync(path.join(root, 'browser-code'), service.pairingCode, { mode: 0o600 });
  console.log(JSON.stringify({ origin, credentialsFile: path.join(root, 'agent.json'), purpose: 'Generated UI test only; no native adapter' }));
  let closing = false;
  const stop = async () => { if (closing) return; closing = true; await service.close(); await broker.close(); };
  process.once('SIGINT', () => { stop().catch(() => { process.exitCode = 1; }); });
  process.once('SIGTERM', () => { stop().catch(() => { process.exitCode = 1; }); });
}

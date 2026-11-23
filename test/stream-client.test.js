import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { consumeHost } from '../src/stream.js';

test('consumer validates mode, terminal packets, safe errors and cancellation through transport', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'applets-stream-client-'));
  const oldPath = process.env.PATH, oldMode = process.env.APPLETS_CLIENT_TEST;
  t.after(async () => {
    process.env.PATH = oldPath;
    if (oldMode === undefined) delete process.env.APPLETS_CLIENT_TEST;
    else process.env.APPLETS_CLIENT_TEST = oldMode;
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(path.join(dir, 'droid'), `#!${process.execPath}
let input = '';
process.stdin.once('data', data => {
  input += data;
  const mode = process.env.APPLETS_CLIENT_TEST;
  function emit(header, image = Buffer.alloc(0)) {
    const body = Buffer.from(JSON.stringify(header)), size = Buffer.alloc(4);
    size.writeUInt32BE(body.length);
    process.stdout.write(Buffer.concat([size, body, image]));
  }
  const diagnostic = {protocol:1,type:'diagnostic',bytes:0,code:'permission_preflight',
    bundleId:'com.factory.applets.host',bundlePath:'/sample/Factory Relay.app',executablePath:'/sample/Factory Relay.app/Contents/MacOS/AppletsHost',
    screenRecording:false,accessibility:false,permissionRequested:false,launchMode:'launchservices-ipc',
    processId:123,parentProcessId:1};
  if (mode === 'busy') {
    process.stderr.write('relay banner\\nAPPLETS_STREAM_ERROR:busy\\n');
    process.exitCode = 1;
  } else if (mode === 'unexpected') emit({protocol:1,type:'windows',bytes:0,windows:[]});
  else if (mode === 'duplicate') { emit(diagnostic); emit(diagnostic); }
  else if (mode === 'diagnostic') emit(diagnostic);
  else if (mode === 'stream') {
    emit({protocol:1,type:'frame',sequence:1,windowId:5,pid:12,bundleId:'com.factory.applets.RelayMac',
      mediaType:'image/jpeg',width:2,height:2,captureTimeSeconds:10,sentUptimeSeconds:10.1,
      contentRectPixels:[0,0,2,2],initialWindowRectPoints:[0,0,1,1],contentScale:1,scaleFactor:2,
      replacedFrames:0,bytes:4},Buffer.from([255,216,255,217]));
    return;
  }
  process.stdin.destroy();
});
`, { mode: 0o700 });
  process.env.PATH = dir + ':' + oldPath;
  const config = { transport: 'factory', computer: 'test-mac', workspace: dir, owner: 'test', timeoutSeconds: 5 };
  const lease = { token: 'a'.repeat(64), generation: 1 };
  for (const [mode, expected] of [['empty', 'empty_stream'], ['unexpected', 'invalid_stream_response'],
    ['duplicate', 'invalid_stream_response'], ['busy', 'busy']]) {
    process.env.APPLETS_CLIENT_TEST = mode;
    await assert.rejects(consumeHost(config, { lease, mode: 'diagnose' }, () => {}), new RegExp(expected));
  }
  process.env.APPLETS_CLIENT_TEST = 'diagnostic';
  let result;
  assert.deepEqual(await consumeHost(config, { lease, mode: 'diagnose' }, packet => { result = packet.header; }), { frames: 0, video: 0 });
  assert.equal(result.launchMode, 'launchservices-ipc');
  process.env.APPLETS_CLIENT_TEST = 'stream';
  const controller = new AbortController();
  await assert.rejects(consumeHost(config, { lease, target: { windowId: 5, pid: 12, bundleId: 'com.factory.applets.RelayMac' },
    signal: controller.signal }, () => controller.abort()), /stream_cancelled/);
});

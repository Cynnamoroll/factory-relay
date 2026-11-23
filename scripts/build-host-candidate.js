import { mkdir, realpath, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { hostFiles } from './build-host.js';
import { appIconSvg } from './app-icon.js';

export async function buildCandidate(output, { sourcesOnly = false } = {}) {
  if (!path.isAbsolute(output)) throw new Error('candidate_path_must_be_absolute');
  if (!sourcesOnly && process.platform !== 'darwin') throw new Error('macos_build_required');
  const parent = await realpath(path.dirname(output));
  const root = path.join(parent, path.basename(output));
  if (root.split(path.sep).some(part => ['.applets-host', '.applets-control'].includes(part)))
    throw new Error('installed_host_path_refused');
  // Exclusive creation prevents the candidate path from replacing an approved bundle or user files.
  await mkdir(root, { mode: 0o700 });
  const app = path.join(root, 'Factory Relay.app');
  const contents = path.join(app, 'Contents');
  await mkdir(path.join(contents, 'MacOS'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(contents, 'Resources'), { mode: 0o700 });
  const files = await hostFiles();
  const authored = {};
  const put = async (relative, body) => {
    await writeFile(path.join(root, relative), body, { flag: 'wx', mode: 0o600 });
    authored[relative] = createHash('sha256').update(body).digest('hex');
  };
  for (const [name, body] of Object.entries(files)) {
    const relative = name === 'Info.plist' ? 'Factory Relay.app/Contents/Info.plist'
      : name === 'AppIcon.icns' ? 'Factory Relay.app/Contents/Resources/AppIcon.icns' : name;
    await put(relative, name === 'AppIcon.icns' ? Buffer.from(body, 'base64') : body);
  }
  await put('AppIcon.svg', appIconSvg());
  const executable = path.join(contents, 'MacOS', 'AppletsHost');
  if (!sourcesOnly) {
    const invoke = (command, args) => {
      const result = spawnSync(command, args, { stdio: 'inherit' });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error('candidate_build_failed');
    };
    invoke('/usr/bin/xcrun', ['swiftc', '-parse-as-library', '-swift-version', '5',
      '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos14.0`, '-O',
      ...['AppletsHost.swift', 'HostLifecycle.swift', 'AppletsControl.swift'].map(name => path.join(root, name)),
      '-o', executable]);
    invoke('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'com.factory.applets.host', app]);
    invoke('/usr/bin/codesign', ['--verify', '--strict', app]);
    authored['Factory Relay.app/Contents/MacOS/AppletsHost'] =
      createHash('sha256').update(await readFile(executable)).digest('hex');
  }
  await writeFile(path.join(root, 'candidate-manifest.json'), JSON.stringify({
    candidateOnly: true, compiled: !sourcesOnly, bundleId: 'com.factory.applets.host', authored,
  }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { candidateRoot: root, app, compiled: !sourcesOnly, launched: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [output, option, ...rest] = process.argv.slice(2);
  if (!output || rest.length || (option && option !== '--sources-only'))
    throw new Error('Usage: build-host-candidate.js ABSOLUTE_NEW_DIRECTORY [--sources-only]');
  console.log(JSON.stringify(await buildCandidate(output, { sourcesOnly: option === '--sources-only' }), null, 2));
}

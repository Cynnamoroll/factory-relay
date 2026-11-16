import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { loadConfig, quote, run } from '../src/transport.js';
import { parseOperation } from '../src/schema.js';

const config = await loadConfig(process.argv[2]);
const udid = process.argv[3] ?? '06AE5B11-C1C9-4456-B08E-C4E78C1F4247';
parseOperation('boot', { lease: { token: '0'.repeat(64), generation: 1 }, udid });
if (config.transport !== 'factory') throw new Error('Factory relay required');
const helper = (await readFile(new URL('../src/remote.py', import.meta.url), 'utf8'))
  .replace('if __name__ == "__main__":\n    main()', '');
const probe = await readFile(new URL('./bridge-probe.py', import.meta.url), 'utf8');
const bridge = await readFile(new URL('../src/bridge.py', import.meta.url), 'utf8');
const acquired = await run(config, 'acquire', { ttlSeconds: 240 });
const lease = { token: acquired.token, generation: acquired.generation };
try {
  const result = await new Promise((resolve, reject) => {
    const child = spawn('droid', ['computer', 'ssh', config.computer, '--',
      `/usr/bin/python3 -c ${quote(helper + '\n' + bridge + '\n' + probe)}`], { detached: true });
    let output = '', size = 0;
    const stop = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    const timer = setTimeout(stop, 150000);
    for (const [stream, capture] of [[child.stdout, true], [child.stderr, false]]) {
      stream.on('data', chunk => {
        size += chunk.length;
        if (size > 1024 * 1024) stop();
        else if (capture) output += chunk;
      });
    }
    child.on('error', reject);
    child.stdin.on('error', () => {});
    child.on('close', code => {
      clearTimeout(timer);
      process.removeListener('SIGTERM', stop);
      process.removeListener('SIGINT', stop);
      stop();
      resolve({ code, output });
    });
    child.stdin.end(JSON.stringify({ owner: config.owner, workspace: config.workspace, timeout: 120,
      args: { lease, udid } }));
  });
  console.log(result.output.trim());
  if (result.code !== 0) process.exitCode = 1;
} finally {
  try {
    console.log(JSON.stringify(await run(config, 'release', { lease })));
  } catch (error) {
    console.error(JSON.stringify({ releaseError: error.message, recoveryRequired: true }));
    process.exitCode = 1;
  }
}

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { QAClient } from '../src/qa-client.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

try {
  const env = { ...process.env };
  let endpoint;
  try { endpoint = new URL(env.AGENT_BROWSER_CDP); } catch {}
  if (endpoint?.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' ||
      !endpoint.port || endpoint.port !== env.FACTORY_DESKTOP_CDP_PORT ||
      endpoint.username || endpoint.password || endpoint.hash ||
      !/^\/devtools\/browser\/[\w-]+$/.test(endpoint.pathname) || !endpoint.searchParams.get('session') ||
      ['AGENT_BROWSER_PROFILE', 'AGENT_BROWSER_EXECUTABLE_PATH', 'AGENT_BROWSER_AUTO_CONNECT',
        'AGENT_BROWSER_ARGS', 'AGENT_BROWSER_PROVIDER'].some(key => env[key]))
    throw new Error('factory_browser_endpoint_required');
  const credentials = process.argv[2] ?? fileURLToPath(new URL('../.qa-workspace/agent.json', import.meta.url));
  const client = new QAClient(credentials);
  const file = path.join(path.dirname(credentials), 'browser-code');
  const s = fs.lstatSync(file);
  if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid() || s.mode & 0o077 || s.size > 100) throw new Error('unsafe_pairing_file');
  const code = fs.readFileSync(file, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(code)) throw new Error('invalid_pairing_code');
  if (!env.AGENT_BROWSER_SESSION) {
    const session = spawnSync('agent-browser', ['session', 'id', '--scope', 'worktree', '--prefix', 'factory-relay'],
      { encoding: 'utf8', timeout: 10000 });
    if (session.status !== 0) throw new Error('browser_session_unavailable');
    env.AGENT_BROWSER_SESSION = session.stdout.trim();
  }
  const args = ['--cdp', env.AGENT_BROWSER_CDP];
  const fragment = process.argv[3] ?? '';
  if (fragment && !/^#run=[a-f0-9]{32}(&step=[a-f0-9]{32})?$/.test(fragment)) throw new Error('invalid_replay_fragment');
  const open = spawnSync('agent-browser', [...args, 'open', client.origin + '/' + fragment], { env, encoding: 'utf8', timeout: 30000 });
  if (open.status !== 0) throw new Error('factory_browser_open_failed');
  const input = `(async () => { if (location.origin !== ${JSON.stringify(client.origin)}) throw Error('wrong_origin'); const session = await fetch('/api/session', {headers:{'X-QA-Request':'1'}}); if (session.ok) return 'already paired'; document.getElementById('code').value=${JSON.stringify(code)}; document.getElementById('pair-form').requestSubmit(); return 'pairing submitted'; })()`;
  const pair = spawnSync('agent-browser', [...args, 'eval', '--stdin'], { env, input, encoding: 'utf8', timeout: 30000 });
  if (pair.status !== 0) throw new Error('factory_browser_pair_failed');
  const ready = spawnSync('agent-browser', [...args, 'wait', '--fn', "!document.getElementById('workspace').hidden"],
    { env, encoding: 'utf8', timeout: 30000 });
  if (ready.status !== 0) throw new Error('factory_browser_pair_failed');
  console.log('Opened and paired Factory browser pane. No Mac actions were requested.');
} catch (e) { console.error(/^[a-z_]+$/.test(e.message) ? e.message : 'qa_open_failed'); process.exitCode = 1; }

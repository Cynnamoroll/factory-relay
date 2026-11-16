import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Agents and future panels use the same broker, never another native capture session. */
export class QAClient {
  constructor(file = fileURLToPath(new URL('../.qa-workspace/agent.json', import.meta.url))) {
    const s = fs.lstatSync(file);
    if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid() || s.mode & 0o077 || s.size > 1024)
      throw new Error('unsafe_credentials');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!/^http:\/\/127\.0\.0\.1:\d{4,5}$/.test(data.origin) || !/^[a-f0-9]{64}$/.test(data.token))
      throw new Error('invalid_credentials');
    this.origin = data.origin;
    this.token = data.token;
  }
  async request(route, input) {
    if (!/^\/api\/(?:status|session|runs|live|command|tasks\/qa_[a-z]+|runs\/[a-f0-9]{32}(?:\/frames\/[a-f0-9]{32})?)$/.test(route))
      throw new Error('invalid_route');
    const response = await fetch(this.origin + route, {
      method: input ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(90000),
      headers: { Authorization: `Bearer ${this.token}`, 'X-QA-Request': '1',
        ...(input ? { 'Content-Type': 'application/json' } : {}) },
      ...(input ? { body: JSON.stringify(input) } : {}),
    });
    if (!response.ok) {
      const data = await response.json();
      const error = new Error(data.error); error.failure = data.failure; throw error;
    }
    return response.headers.get('content-type') === 'image/jpeg'
      ? { image: Buffer.from(await response.arrayBuffer()), version: response.headers.get('x-qa-frame-version'),
        receivedAt: response.headers.get('x-qa-frame-received-at') } : response.json();
  }
  command(input) { return this.request('/api/command', input); }
  task(name, input = {}) { return this.request('/api/tasks/' + name, input); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const client = new QAClient();
    const route = process.argv[2] ?? '/api/status';
    if (route === '/api/live' || route.includes('/frames/')) throw new Error('use_client_api_for_pixels');
    const result = await client.request(route, process.argv[3] ? JSON.parse(process.argv[3]) : undefined);
    // Mutation grants are capabilities. Use the module or MCP for ownership, not terminal logs.
    if (result.grant) console.log(JSON.stringify({ ...result, grant: '[private: use module client]' }));
    else console.log(JSON.stringify(result));
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadConfig, quote } from '../src/transport.js';

const config = await loadConfig(process.argv[2]);
if (config.transport !== 'factory') throw new Error('Discovery requires Factory relay');
const wrapper = `
import os,selectors,signal,subprocess,time
def interrupted(_signal,_frame):
    raise SystemExit(1)
for signum in (signal.SIGHUP,signal.SIGTERM,signal.SIGINT):
    signal.signal(signum,interrupted)
p=subprocess.Popen(["/usr/bin/xcrun","mcpbridge"],stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
try:
    deadline=time.monotonic()+45
    size=0
    with selectors.DefaultSelector() as selector:
        selector.register(p.stdout,selectors.EVENT_READ,True)
        selector.register(p.stderr,selectors.EVENT_READ,False)
        while selector.get_map() or p.poll() is None:
            if time.monotonic()>=deadline: raise SystemExit(1)
            for key,_ in selector.select(0.1):
                chunk=os.read(key.fileobj.fileno(),65536)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                size+=len(chunk)
                if size>1024*1024: raise SystemExit(1)
                if key.data:
                    view=memoryview(chunk)
                    while view: view=view[os.write(1,view):]
finally:
    try: os.killpg(p.pid,signal.SIGKILL)
    except ProcessLookupError: pass
    p.wait()
`;
const client = new Client({ name: 'factory-relay-xcode-discovery', version: '1.0.0' });
const relevant = new Set(['DeviceInteractionStartSession', 'DeviceInteractionStartWorkspaceSession',
  'DeviceInteractionInstallAndRun', 'DeviceInteractionSynthesize', 'DeviceInteractionEndSession',
  'XcodeListRunDestinations', 'XcodeOpenWorkspace']);
try {
  await client.connect(new StdioClientTransport({
    command: 'droid',
    args: ['computer', 'ssh', config.computer, '--', `/usr/bin/python3 -c ${quote(wrapper)}`],
    env: process.env, stderr: 'pipe',
  }), { timeout: 30000 });
  const tools = [];
  let cursor;
  let pageCount = 0;
  do {
    if (++pageCount > 32) throw new Error('Discovery page limit exceeded');
    const page = await client.listTools(cursor ? { cursor } : {}, { timeout: 10000 });
    tools.push(...page.tools.filter(tool => relevant.has(tool.name)));
    cursor = page.nextCursor;
    if (tools.length > 256) throw new Error('Discovery tool limit exceeded');
  } while (cursor);
  console.log(JSON.stringify({ surface: 'official-xcode-mcpbridge', toolCount: tools.length, tools }));
} catch {
  console.error(JSON.stringify({ error: 'xcode_bridge_discovery_failed' }));
  process.exitCode = 1;
} finally {
  await client.close();
}

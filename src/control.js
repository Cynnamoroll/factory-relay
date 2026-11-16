import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { configSchema } from './schema.js';
import { quote } from './transport.js';

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const controlTargetSchema = z.strictObject({
  windowId: integer.min(1).max(0xffffffff), pid: integer.min(1).max(0x7fffffff),
  bundleId: z.literal('com.factory.applets.RelayMac'),
});
const proof = z.strictObject({ token: z.string().regex(/^[a-f0-9]{64}$/), generation: integer });
export const controlRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('diagnose'), lease: proof }),
  z.strictObject({ operation: z.literal('observe'), lease: proof, target: controlTargetSchema }),
  z.strictObject({ operation: z.literal('press'), lease: proof, target: controlTargetSchema,
    observationId: z.string().regex(/^[a-f0-9]{32}$/), elementId: z.literal('relay-increment') }),
]);
const element = (id, role) => z.strictObject({
  id: z.literal(id), role: z.literal(role), value: z.string().max(512), enabled: z.boolean(),
});
const snapshot = z.strictObject({
  target: controlTargetSchema,
  windowRectPoints: z.tuple([z.number().finite(), z.number().finite(), z.number().positive().finite(), z.number().positive().finite()]),
  processStartedAt: z.number().finite(),
  elements: z.tuple([element('relay-count', 'AXStaticText'), element('relay-increment', 'AXButton')]),
});
const results = {
  diagnose: z.strictObject({
    type: z.literal('diagnostic'), bundleId: z.literal('com.factory.applets.host'),
    bundlePath: z.string().max(4096), executablePath: z.string().max(4096),
    accessibility: z.boolean(), screenRecording: z.boolean(), permissionRequested: z.literal(false),
    launchMode: z.literal('launchservices-ipc'), processId: integer.min(1), parentProcessId: integer.min(1),
    lifecycle: z.strictObject({ appKitInitialized: z.literal(true), eventLoopRunning: z.literal(true),
      launchFinished: z.literal(true), mainThread: z.literal(true) }),
  }),
  observe: z.strictObject({ type: z.literal('observation'), snapshot,
    observationId: z.string().regex(/^[a-f0-9]{32}$/), expiresAt: z.number().finite() }),
  press: z.strictObject({ type: z.literal('pressed'), elementId: z.literal('relay-increment') }),
};
const errors = new Set(['busy', 'stale_lease', 'lease_expired', 'unsafe_state', 'unsafe_peer',
  'unsupported_host', 'ipc_path_limit', 'invalid_request', 'invalid_stream', 'stream_timeout',
  'stream_closed', 'stream_interrupted', 'host_unavailable', 'accessibility_required',
  'observation_stale', 'target_mismatch', 'element_unavailable', 'action_uncertain',
  'control_timeout', 'control_closed', 'invalid_control_response']);
const supervisor = (await Promise.all(['remote.py', 'stream-supervisor.py', 'control-supervisor.py'].map(async name => {
  let source = await readFile(new URL('./' + name, import.meta.url), 'utf8');
  if (name !== 'control-supervisor.py') source = source.replace(/if __name__ == "__main__":\n    \w+\(\)\s*$/, '');
  return source;
}))).join('\n');

export async function control(config, input) {
  config = configSchema.parse(config);
  if (config.transport !== 'factory') throw new Error('factory_transport_required');
  const { operation, target = null, ...args } = controlRequestSchema.parse(input);
  const child = spawn('droid', ['computer', 'ssh', config.computer, '--', `/usr/bin/python3 -c ${quote(supervisor)}`],
    { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  return new Promise((resolve, reject) => {
    let bytes = 0, output = '', failure;
    const stop = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } };
    const cancel = () => { failure = 'control_interrupted'; stop(); };
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    const timer = setTimeout(() => { failure = 'control_timeout'; stop(); }, 30000);
    for (const [stream, capture] of [[child.stdout, true], [child.stderr, false]]) stream.on('data', data => {
      bytes += data.length;
      if (bytes > 65536) { failure = 'control_output_limit'; stop(); }
      else if (capture) output += data;
    });
    child.stdin.on('error', () => {});
    child.on('error', () => { failure = 'transport_unavailable'; });
    child.on('close', code => {
      clearTimeout(timer);
      process.removeListener('SIGINT', cancel);
      process.removeListener('SIGTERM', cancel);
      stop();
      if (failure || code !== 0) return reject(new Error(failure ?? 'transport_failed'));
      try {
        const response = JSON.parse(output);
        if (response.ok === false && errors.has(response.error)) return reject(new Error(response.error));
        if (response.ok !== true) throw new Error();
        const result = results[operation].parse(response.result);
        if (operation === 'observe' && JSON.stringify(result.snapshot.target) !== JSON.stringify(controlTargetSchema.parse(target)))
          throw new Error();
        resolve(result);
      } catch { reject(new Error('invalid_control_response')); }
    });
    child.stdin.end(JSON.stringify({ owner: config.owner, workspace: config.workspace, operation, target, args }));
  });
}

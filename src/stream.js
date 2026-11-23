import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { configSchema } from './schema.js';
import { transportCommand } from './transport.js';
import { windowTargetSchema, desktopTargetSchema, targetSchema, displayConfigurationSchema, sameTarget } from './window-target.js';
import { parseAnnexB } from '../web/live-video.js';

export const HEADER_LIMIT = 8192;
export const IMAGE_LIMIT = 4 * 1024 * 1024;
// Credits return over the SSH round trip (about 80-100 ms), so the window bounds the frame rate.
export const STREAM_WINDOW = 8;
const STREAM_ERRORS = new Set(['busy', 'stale_lease', 'lease_expired', 'lease_scope', 'unsafe_state', 'unsafe_peer',
  'unsupported_host', 'ipc_path_limit', 'invalid_request', 'invalid_stream',
  'stream_timeout', 'stream_closed', 'stream_interrupted', 'host_unavailable']);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const rect = z.tuple([z.number().finite(), z.number().finite(), z.number().nonnegative().finite(), z.number().nonnegative().finite()]);
export const streamTargetSchema = targetSchema;
const frameFields = {
  protocol: z.literal(1), type: z.literal('frame'), sequence: integer.min(1),
  mediaType: z.literal('image/jpeg'),
  width: integer.min(1).max(2048), height: integer.min(1).max(2048),
  captureTimeSeconds: z.number().nonnegative().finite(), sentUptimeSeconds: z.number().nonnegative().finite(),
  contentRectPixels: rect,
  contentScale: z.number().positive().finite(), scaleFactor: z.number().positive().finite(),
  replacedFrames: integer, bytes: integer.min(1).max(IMAGE_LIMIT),
};
const frameSchema = z.union([
  z.strictObject({ ...frameFields, ...windowTargetSchema.shape, initialWindowRectPoints: rect,
    processStartedAt: z.number().finite().optional() }),
  z.strictObject({ ...frameFields, ...desktopTargetSchema.shape, displayConfiguration: displayConfigurationSchema }),
]);
/**
 * One H.264 access unit. Annex B on the wire: 4-byte start codes, keyframes prefixed with
 * in-band SPS + PPS so a viewer can join at any keyframe (at most two seconds away).
 */
const vframeFields = {
  protocol: z.literal(1), type: z.literal('vframe'), sequence: integer.min(1),
  codec: z.literal('h264'), format: z.literal('annexb'), keyframe: z.boolean(),
  width: integer.min(1).max(2048), height: integer.min(1).max(2048),
  captureTimeSeconds: z.number().nonnegative().finite(), sentUptimeSeconds: z.number().nonnegative().finite(),
  contentRectPixels: rect,
  contentScale: z.number().positive().finite(), scaleFactor: z.number().positive().finite(),
  replacedFrames: integer, bytes: integer.min(1).max(IMAGE_LIMIT),
};
const vframeSchema = z.union([
  z.strictObject({ ...vframeFields, ...windowTargetSchema.shape, initialWindowRectPoints: rect,
    processStartedAt: z.number().finite().optional() }),
  z.strictObject({ ...vframeFields, ...desktopTargetSchema.shape, displayConfiguration: displayConfigurationSchema }),
]);
const diagnosticSchema = z.strictObject({
  protocol: z.literal(1), type: z.literal('diagnostic'), bytes: z.literal(0),
  code: z.enum(['permission_preflight', 'screen_recording_required', 'capture_unavailable']),
  bundleId: z.literal('com.factory.applets.host'), bundlePath: z.string().max(4096),
  executablePath: z.string().max(4096), screenRecording: z.boolean(),
  accessibility: z.boolean(), permissionRequested: z.literal(false),
  launchMode: z.enum(['stdio', 'launchservices-ipc', 'persistent-ipc']).optional(),
  processId: integer.min(1).optional(), parentProcessId: integer.min(1).optional(),
  lifecycle: z.strictObject({
    appKitInitialized: z.boolean(), eventLoopRunning: z.boolean(),
    launchFinished: z.boolean(), mainThread: z.boolean(),
  }).optional(),
  stage: z.enum(['app_ready', 'enumerating', 'windows_ready', 'creating_filter',
    'filter_ready', 'starting_capture', 'capturing', 'stopping_capture']).optional(),
});
const windowsSchema = z.strictObject({
  protocol: z.literal(1), type: z.literal('windows'), bytes: z.literal(0),
  displays: z.array(desktopTargetSchema.extend({ main: z.boolean(), displayConfiguration: displayConfigurationSchema })).max(32).default([]),
  windows: z.array(windowTargetSchema.extend({ title: z.string().max(1024), windowRectPoints: rect,
    displayName: z.string().max(120).optional(), processStartedAt: z.number().finite().optional() })).max(100),
});
const heartbeatSchema = z.strictObject({
  protocol: z.literal(1), type: z.literal('heartbeat'), bytes: z.literal(0),
  sentUptimeSeconds: z.number().nonnegative().finite(),
});
const headerSchema = z.union([frameSchema, vframeSchema, diagnosticSchema, windowsSchema, heartbeatSchema]);

/** Structure check shared with the browser: NAL boundaries, header bits and keyframe contents. */
function validVideoAccessUnit(image, keyframe) {
  let nals;
  try { nals = parseAnnexB(image); } catch { return false; }
  const types = new Set(nals.map(nal => nal.type));
  if (!nals.some(nal => nal.type >= 1 && nal.type <= 5)) return false;
  return !keyframe || (types.has(7) && types.has(8) && types.has(5));
}

/** Bounded packet buffering; consumer completion gates each credit returned to the host. */
export async function* decodeStream(readable) {
  let buffer = Buffer.alloc(0), header, headerBytes = 0, sequence = 0;
  for await (const chunk of readable) {
    if (!Buffer.isBuffer(chunk) || buffer.length + chunk.length > IMAGE_LIMIT + HEADER_LIMIT + 65540)
      throw new Error('stream_buffer_limit');
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      if (!header) {
        if (buffer.length < 4) break;
        headerBytes = buffer.readUInt32BE();
        if (headerBytes < 1 || headerBytes > HEADER_LIMIT) throw new Error('invalid_stream_header');
        if (buffer.length < 4 + headerBytes) break;
        header = headerSchema.parse(JSON.parse(buffer.subarray(4, 4 + headerBytes).toString('utf8')));
        buffer = buffer.subarray(4 + headerBytes);
      }
      if (buffer.length < header.bytes) break;
      const image = Buffer.from(buffer.subarray(0, header.bytes));
      buffer = buffer.subarray(header.bytes);
      if (header.type === 'frame') {
        if (header.sequence <= sequence || image.length < 4 ||
            image.readUInt16BE(0) !== 0xffd8 || image.readUInt16BE(image.length - 2) !== 0xffd9)
          throw new Error('invalid_stream_frame');
        sequence = header.sequence;
      }
      if (header.type === 'vframe') {
        if (header.sequence <= sequence || !validVideoAccessUnit(image, header.keyframe))
          throw new Error('invalid_stream_frame');
        sequence = header.sequence;
      }
      yield { header, image };
      header = undefined;
    }
  }
  if (buffer.length || header) throw new Error('truncated_stream');
}

const proofSchema = z.strictObject({ token: z.string().regex(/^[a-f0-9]{64}$/), generation: integer });
const supervisor = (await readFile(new URL('./remote.py', import.meta.url), 'utf8'))
  .replace('if __name__ == "__main__":\n    main()', '') + '\n' +
  await readFile(new URL('./stream-supervisor.py', import.meta.url), 'utf8');

/**
 * Media connection, separate from the control session so frames never delay input replies.
 * Up to `window` packets are in flight; the host keeps only the latest capture while waiting.
 */
export async function consumeHost(config, { lease, mode = 'stream', target = null, signal, window = STREAM_WINDOW }, consume) {
  config = configSchema.parse(config);
  lease = proofSchema.parse(lease);
  window = z.number().int().min(1).max(8).parse(window);
  mode = z.enum(['diagnose', 'windows', 'stream', 'recording']).parse(mode);
  target = mode === 'recording' ? desktopTargetSchema.parse(target)
    : mode === 'stream' ? streamTargetSchema.parse(target) : z.null().parse(target);
  if (signal?.aborted) throw new Error('stream_cancelled');
  const [executable, transportArgs] = transportCommand(config, supervisor);
  const child = spawn(executable, transportArgs, { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  let stderrBytes = 0, stderr = '', failure, frames = 0, video = 0, packets = 0, terminal = false;
  const stop = () => {
    if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; } }
  };
  const cancel = () => { failure = new Error('stream_cancelled'); stop(); };
  const done = new Promise(resolve => {
    child.on('error', () => { failure = new Error('transport_unavailable'); });
    child.on('close', resolve);
  });
  child.stderr.on('data', chunk => {
    stderrBytes += chunk.length;
    if (stderrBytes > 65536) { failure = new Error('transport_output_limit'); stop(); }
    else {
      stderr += chunk.toString('utf8');
      const code = stderr.match(/^APPLETS_STREAM_ERROR:([a-z_]+)\r?$/m)?.[1];
      if (STREAM_ERRORS.has(code)) failure ??= new Error(code);
    }
  });
  child.stdin.on('error', () => {});
  signal?.addEventListener('abort', cancel, { once: true });
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  const timer = setTimeout(() => { failure = new Error('stream_timeout'); stop(); }, (config.timeoutSeconds + 15) * 1000);
  child.stdin.write(JSON.stringify({ owner: config.owner, workspace: config.workspace, args: { lease },
    mode, target, timeout: config.timeoutSeconds, window }) + '\n');
  try {
    for await (const packet of decodeStream(child.stdout)) {
      const kind = packet.header.type;
      if (terminal || (kind !== 'diagnostic' && !(
        (mode === 'windows' && kind === 'windows') || (['stream', 'recording'].includes(mode) && ['frame', 'vframe', 'heartbeat'].includes(kind))
      ))) throw new Error('invalid_stream_response');
      packets++;
      terminal = ['diagnostic', 'windows'].includes(kind);
      if (['frame', 'vframe'].includes(packet.header.type)) {
        if (!sameTarget(packet.header, target)) throw new Error('stream_target_mismatch');
        if (packet.header.type === 'frame') frames++; else video++;
      }
      const streaming = ['frame', 'vframe', 'heartbeat'].includes(packet.header.type);
      await new Promise((resolve, reject) => {
        const finish = error => {
          clearTimeout(deadline);
          child.removeListener('close', closed);
          if (error) reject(error); else resolve();
        };
        const closed = code => {
          if (streaming || failure || code !== 0) finish(failure ?? new Error('stream_terminated'));
        };
        const deadline = setTimeout(() => finish(new Error('stream_consumer_timeout')), 10000);
        child.once('close', closed);
        Promise.resolve().then(() => consume(packet)).then(() => finish(), finish);
      });
      if (streaming) child.stdin.write(Buffer.from([6]));
    }
    const code = await done;
    if (failure) throw failure;
    if (code !== 0) throw new Error('stream_terminated');
    if (!packets) throw new Error('empty_stream');
    return { frames, video };
  } catch (error) {
    throw failure ?? error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    stop();
    await done;
  }
}

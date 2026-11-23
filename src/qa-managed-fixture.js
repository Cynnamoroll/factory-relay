import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { configSchema } from './schema.js';
import { transportCommand } from './transport.js';
import { sampleBundle, sameTarget, windowTargetSchema } from './window-target.js';

const source = await readFile(new URL('./managed-fixture-supervisor.py', import.meta.url), 'utf8');
const controlLineLimit = 2048;
const cleanupMs = 5000;
const startupMs = 35_000;

const readyMessage = z.strictObject({
  type: z.literal('ready'),
  marker: z.string(),
  target: windowTargetSchema.extend({ bundleId: z.literal(sampleBundle) }),
  processStartedAt: z.number().finite().positive(),
});
const doneMessage = z.strictObject({
  type: z.literal('done'),
  reason: z.enum(['closed', 'fixture_unsupported_host', 'fixture_build_required', 'fixture_launch_failed',
    'fixture_ownership_unproven', 'fixture_protocol_error', 'fixture_start_timeout', 'fixture_expired',
    'fixture_client_lost', 'fixture_exited', 'fixture_supervisor_failed', 'fixture_cleanup_failed']),
  cleaned: z.boolean(),
}).refine(row => row.cleaned === (row.reason !== 'fixture_cleanup_failed'));

// The private handle owns only this transport pipe. No operation accepts a PID to stop.
export function launchManagedFixture(config, { lifetimeMs, signal, command } = {}) {
  config = configSchema.parse(config);
  if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1 || lifetimeMs > 3_600_000)
    throw new Error('invalid_arguments');
  if (signal?.aborted) throw new Error('fixture_closed');
  const marker = randomBytes(32).toString('hex');
  const [file, args] = command ?? transportCommand(config, source);
  const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const stdin = child.stdin;
  let resolveReady, rejectReady, resolveDone, identity, outcome, stopping, stopTimer;
  let lastRenewal = 0, partial = '', outputBytes = 0, stderrBytes = 0;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  ready.catch(() => {});
  const done = new Promise(resolve => { resolveDone = resolve; });

  function reference(ref) {
    const method = ref ? 'ref' : 'unref';
    child[method]();
    for (const stream of [stdin, child.stdout, child.stderr]) stream[method]?.();
  }

  function finish(reason, cleaned, startError = reason) {
    if (outcome) return;
    outcome = Object.freeze({ reason, cleaned });
    clearTimeout(waitTimer);
    clearTimeout(stopTimer);
    signal?.removeEventListener('abort', abort);
    rejectReady(new Error(startError === 'closed' ? 'fixture_closed' : startError));
    resolveDone(outcome);
    stdin.end();
    reference(false);
  }

  function stop(reason) {
    if (outcome || stopping) return;
    stopping = true;
    clearTimeout(waitTimer);
    rejectReady(new Error(reason));
    reference(true);
    stdin.end();
    // A broken transport is not a cleanup acknowledgement. The remote watchdog still applies.
    stopTimer = setTimeout(() => {
      child.kill('SIGKILL');
      finish('fixture_cleanup_uncertain', false);
    }, cleanupMs);
  }

  const abort = () => stop('fixture_closed');
  const waitTimer = setTimeout(() => stop('fixture_start_timeout'), startupMs);
  signal?.addEventListener('abort', abort, { once: true });
  child.once('error', () => {
    if (child.pid === undefined) finish('fixture_transport_unavailable', true);
    else finish('fixture_cleanup_uncertain', false, 'fixture_transport_unavailable');
  });
  child.once('close', () => finish('fixture_cleanup_uncertain', false, 'fixture_transport_unavailable'));
  stdin.on('error', () => stop('fixture_transport_unavailable'));
  child.stderr.on('data', chunk => {
    stderrBytes += chunk.length;
    if (stderrBytes > 65_536) stop('fixture_protocol_error');
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    if (outcome) return;
    outputBytes += Buffer.byteLength(chunk);
    if (outputBytes > 8192) return stop('fixture_protocol_error');
    const lines = (partial + chunk).split('\n');
    partial = lines.pop();
    if (partial.length > controlLineLimit) return stop('fixture_protocol_error');
    for (const line of lines) {
      if (line.length > controlLineLimit) return stop('fixture_protocol_error');
      let message;
      try { message = JSON.parse(line); } catch { return stop('fixture_protocol_error'); }
      if (message?.type === 'ready') {
        if (stopping) continue;
        const parsed = readyMessage.safeParse(message);
        if (identity || !parsed.success || parsed.data.marker !== marker) return stop('fixture_ownership_unproven');
        const { target, processStartedAt } = parsed.data;
        identity = Object.freeze({ target: Object.freeze(target), processStartedAt });
        clearTimeout(waitTimer);
        reference(false);
        resolveReady(identity);
      } else {
        const parsed = doneMessage.safeParse(message);
        if (!parsed.success) return stop('fixture_protocol_error');
        finish(parsed.data.reason, parsed.data.cleaned);
        return;
      }
    }
  });
  stdin.write(JSON.stringify({ type: 'start', marker, workspace: config.workspace, lifetimeMs }) + '\n');

  return Object.freeze({
    ready,
    done,
    assertWindow(window) {
      if (outcome || stopping || !identity || !sameTarget(window, identity.target) ||
          window.processStartedAt !== identity.processStartedAt) throw new Error('target_mismatch');
    },
    renew() {
      if (outcome || stopping || !identity) return;
      const now = performance.now();
      if ((lastRenewal && now - lastRenewal < 1000) || stdin.writableNeedDrain) return;
      lastRenewal = now;
      stdin.write('{"type":"renew"}\n');
    },
    async close() {
      stop('fixture_closed');
      const result = await done;
      if (!result.cleaned) throw new Error(result.reason);
    },
  });
}

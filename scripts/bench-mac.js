#!/usr/bin/env node
// Mac performance and isolation benchmarks over the real persistent relay path.
//   node scripts/bench-mac.js CONFIG click WINDOW_ID [ITERATIONS] [X,Y]
//   node scripts/bench-mac.js CONFIG stream WINDOW_ID [SECONDS]
//   node scripts/bench-mac.js CONFIG concurrent WINDOW_A X,Y WINDOW_B X,Y [ITERATIONS]
// Browser presentation rate is read separately from window.qaLiveStats in the QA page.
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { sampleBundle } from '../src/window-target.js';
import { loadConfig, run } from '../src/transport.js';
import { control } from '../src/control.js';
import { consumeHost } from '../src/stream.js';
import { closeSessions } from '../src/mac-session.js';
import { summarizeStream } from './stream-metrics.js';

export const CLICK_GATE_MS = 500;
export const FPS_GATE = 30;
const proof = ({ token, generation }) => ({ token, generation });
const countOf = observation => {
  const value = observation.snapshot.elements.find(e => e.id === 'relay-count')?.value;
  return /^Count: \d+$/.test(value ?? '') ? Number(value.slice(7)) : null;
};
export function stats(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const at = q => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null;
  return { n: sorted.length, missing: values.length - sorted.length, min: sorted[0] ?? null, p50: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? null };
}

/**
 * Dispatch is the control round trip; effect is dispatch start until a fresh AX observation shows
 * the incremented count. The first sample is reported separately as the cold call.
 */
export async function benchClick({ config, lease, target, iterations = 20, at, session }) {
  const samples = [];
  for (let i = 0; i <= iterations; i++) {
    const before = await control(config, { operation: 'observe', lease, target }, { session });
    const count = countOf(before);
    if (count === null) throw new Error('relay_count_required');
    const started = performance.now();
    const result = at
      ? await control(config, { operation: 'mouse', lease, target, observationId: before.observationId,
        mouse: { kind: 'click', x: at[0], y: at[1], button: 'left', count: 1 } }, { session })
      : await control(config, { operation: 'press', lease, target, observationId: before.observationId,
        elementId: 'relay-increment' }, { session });
    const dispatchMs = performance.now() - started;
    let effectMs = null;
    while (performance.now() - started < 3000) {
      if (countOf(await control(config, { operation: 'observe', lease, target }, { session })) === count + 1) {
        effectMs = performance.now() - started;
        break;
      }
    }
    samples.push({ dispatchMs, effectMs, route: result.route ?? 'ax-press',
      focusPreserved: result.focusPreserved ?? null, cursorPreserved: result.cursorPreserved ?? null });
  }
  const [cold, ...warm] = samples;
  return { cold, warmDispatchMs: stats(warm.map(s => s.dispatchMs)), warmEffectMs: stats(warm.map(s => s.effectMs)),
    gateMs: CLICK_GATE_MS, pass: warm.length > 0 && warm.every(s => s.effectMs !== null && s.effectMs < CLICK_GATE_MS),
    silent: samples.every(s => s.route !== 'foreground-hid' && s.focusPreserved !== false && s.cursorPreserved !== false),
    samples };
}

/**
 * Delivered rate uses capture timestamps; received rate uses local arrival. Needs a changing target.
 * The video access-unit stream is the rate gate; the 2 Hz JPEG snapshots are reported separately.
 * Browser-presented fps is read separately from window.qaLiveStats in the QA page, unchanged.
 */
export async function benchStream({ config, lease, target, seconds = 10 }) {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 300) throw new Error('invalid_measurement_duration');
  const frames = [];
  const video = [];
  let heartbeats = 0;
  const controller = new AbortController();
  const start = performance.now();
  let timer = setTimeout(() => controller.abort(), 30000), warmAt, firstPacketMs;
  try {
    await consumeHost(config, { lease, target, signal: controller.signal }, ({ header, image }) => {
      const now = performance.now();
      if (header.type === 'heartbeat') { heartbeats++; return; }
      if (!['frame', 'vframe'].includes(header.type)) throw new Error('capture_unavailable');
      if (warmAt === undefined) {
        firstPacketMs = now - start;
        warmAt = now + 1000;
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(), 1000 + seconds * 1000);
      }
      if (now < warmAt) return;
      if (now >= warmAt + seconds * 1000) { controller.abort(); return; }
      const record = { ...header, receivedAfterStartMs: now - start, bytes: image.length };
      if (header.type === 'vframe') video.push(record);
      else frames.push({ ...record, sha256: createHash('sha256').update(image).digest('hex') });
    });
  } catch (error) { if (error.message !== 'stream_cancelled') throw error; }
  finally { clearTimeout(timer); }
  const summary = summarizeStream(frames, heartbeats, video);
  const { captureIntervalsSeconds, senderIntervalsSeconds, receiveIntervalsMs,
    videoCaptureIntervalsSeconds, videoReceiveIntervalsMs, keyframeIntervalsSeconds, ...rest } = summary;
  const measuredFps = video.length / seconds;
  return { ...rest, seconds, firstPacketMs: firstPacketMs ?? null, receivedFpsOverFullWindow: measuredFps, gateFps: FPS_GATE,
    keyframeIntervalSeconds: stats(keyframeIntervalsSeconds),
    pass: measuredFps >= FPS_GATE && (summary.videoDeliveredSourceRateHz ?? 0) >= FPS_GATE,
    receiveIntervalMs: stats(videoReceiveIntervalsMs) };
}

/** Two agents click two windows at once under separate window leases; every click must stay silent. */
export async function benchConcurrent({ configs, leases, targets, points, iterations = 10, sessions = [] }) {
  const lane = async index => {
    const rows = [];
    for (let i = 0; i < iterations; i++) {
      const before = await control(configs[index], { operation: 'observe', lease: leases[index], target: targets[index], mode: 'pixels' },
        { session: sessions[index] });
      const started = performance.now();
      const result = await control(configs[index], { operation: 'mouse', lease: leases[index], target: targets[index],
        observationId: before.observationId, mouse: { kind: 'click', x: points[index][0], y: points[index][1], button: 'left', count: 1 } },
        { session: sessions[index] });
      rows.push({ started, ended: performance.now(), ...result });
    }
    return rows;
  };
  const lanes = await Promise.all(targets.map((_, index) => lane(index)));
  const all = lanes.flat();
  const overlaps = lanes[0].filter(a => lanes[1].some(b => a.started < b.ended && b.started < a.ended)).length;
  return { clicks: all.length, overlappingClicks: overlaps, latencyMs: stats(all.map(r => r.ended - r.started)),
    routes: [...new Set(all.map(r => r.route))], focusLeaks: all.filter(r => !r.focusPreserved).length,
    cursorLeaks: all.filter(r => !r.cursorPreserved).length,
    pass: all.every(r => r.route === 'background-ax-press' && r.focusPreserved && r.cursorPreserved) };
}

async function windowTarget(config, lease, id) {
  let windows = [];
  await consumeHost(config, { lease, mode: 'windows' }, ({ header }) => { windows = header.windows; });
  const found = windows.find(w => w.windowId === id);
  if (!found) throw new Error('target_unavailable');
  if (found.bundleId !== sampleBundle) throw new Error('relaymac_fixture_required');
  return { windowId: found.windowId, pid: found.pid, bundleId: found.bundleId };
}
const point = text => { const [x, y] = String(text).split(',').map(Number); return [x, y]; };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [configPath, mode, ...args] = process.argv.slice(2);
  const config = await loadConfig(configPath);
  const held = [];
  const acquire = async (owner, scope) => {
    const value = proof(await run(owner, 'acquire', { ttlSeconds: 600, scope }));
    held.push([owner, value]);
    return value;
  };
  try {
    const observer = await acquire(config, { kind: 'observer' });
    let result;
    if (mode === 'click' || mode === 'stream') {
      const target = await windowTarget(config, observer, Number(args[0]));
      if (mode === 'click') {
        const owner = { ...config, owner: config.owner + ':bench-click' };
        const lease = await acquire(owner, { kind: 'window', target });
        result = await benchClick({ config: owner, lease, target, iterations: Number(args[1] ?? 20), at: args[2] ? point(args[2]) : undefined });
      } else result = await benchStream({ config, lease: observer, target, seconds: Number(args[1] ?? 10) });
    } else if (mode === 'concurrent') {
      const targets = [await windowTarget(config, observer, Number(args[0])), await windowTarget(config, observer, Number(args[2]))];
      const configs = targets.map((_, i) => ({ ...config, owner: `${config.owner}:bench-agent-${i}` }));
      const leases = [];
      for (let i = 0; i < 2; i++) leases.push(await acquire(configs[i], { kind: 'window', target: targets[i] }));
      result = await benchConcurrent({ configs, leases, targets, points: [point(args[1]), point(args[3])], iterations: Number(args[4] ?? 10) });
    } else throw new Error('Usage: bench-mac.js CONFIG click|stream|concurrent ...');
    console.log(JSON.stringify({ mode, measuredAt: new Date().toISOString(), ...result }, null, 2));
    if (!result.pass) process.exitCode = 1;
  } finally {
    for (const [owner, lease] of held.reverse()) { try { await run(owner, 'release', { lease }); } catch {} }
    await closeSessions();
  }
}

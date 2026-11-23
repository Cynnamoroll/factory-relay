// Against an already running QA broker; only explicitly selected RelayMac fixture windows.
// node scripts/bench-four-windows.js CREDENTIALS WINDOW_ID,WINDOW_ID,WINDOW_ID,WINDOW_ID [ROUNDS] [X,Y]
import { pathToFileURL } from 'node:url';
import { QAClient } from '../src/qa-client.js';
import { sampleBundle } from '../src/window-target.js';
import { CLICK_GATE_MS, stats } from './bench-mac.js';

export async function benchFourWindows(client, ids, rounds = 12, point) {
  if (point && (point.length !== 2 || point.some(n => !Number.isFinite(n) || n < 0 || n >= 1))) throw new Error('invalid_point');
  if (ids.length !== 4 || new Set(ids).size !== 4 || ids.some(id => !Number.isSafeInteger(id) || id <= 0) ||
      !Number.isInteger(rounds) || rounds < 2 || rounds > 50) throw new Error('invalid_four_window_benchmark');
  const { windows } = await client.task('qa_targets');
  const lanes = ids.map((id, index) => {
    const found = windows.find(w => w.windowId === id && w.bundleId === sampleBundle);
    if (!found || !Number.isFinite(found.processStartedAt)) throw new Error('relaymac_fixture_required');
    return { index, found, samples: [] };
  });
  if (new Set(lanes.map(l => l.found.pid)).size !== 4) throw new Error('four_fixture_processes_required');
  const all = async jobs => {
    const outcomes = await Promise.allSettled(jobs);
    const error = outcomes.find(r => r.status === 'rejected');
    if (error) throw error.reason;
    return outcomes.map(r => r.value);
  };
  const started = performance.now();
  try {
    await all(lanes.map(async l => {
      l.session = await client.openWindowSession({ title: `Four-window fixture ${l.index + 1}`,
        applicationId: 'relaymac', target: l.found.target, processStartedAt: l.found.processStartedAt });
      l.observed = await l.session.observe();
      if (!Number.isInteger(l.observed.actual)) throw new Error('relay_count_required');
      l.initial = l.observed.actual;
    }));
    const setupMs = performance.now() - started;
    await all(lanes.map(async l => {
      // Different counts on each overlapping window expose misdirected actions.
      for (let n = 1; n <= rounds + l.index; n++) {
        const start = performance.now();
        const expected = l.initial + n;
        const action = point ? { action: 'mouse', mouse: { kind: 'click', x: point[0], y: point[1], button: 'left', count: 1 } }
          : { action: 'increment' };
        const ack = await l.session.actAndWait({ ...action, observationId: l.observed.observationId },
          { kind: 'count', equals: expected, timeoutMs: 1000 });
        const end = performance.now();
        if (ack.status !== 'pass' || ack.effect.actual !== expected) throw new Error('count_not_confirmed');
        if (point && (ack.route !== 'background-ax-press' || !ack.focusPreserved || !ack.cursorPreserved))
          throw new Error('silent_click_not_confirmed');
        l.samples.push({ start, end, elapsedMs: end - start, deviceMs: ack.effect.elapsedMs });
        l.observed = await l.session.observe();
        if (l.observed.actual !== expected) throw new Error('window_count_mismatch');
      }
    }));
    const warm = lanes.flatMap(l => l.samples.slice(1));
    const peak = Math.max(...warm.map(row => lanes.filter(l => l.samples.some(r => r.start <= row.start && row.start < r.end)).length));
    return { setupMs, input: point ? 'background-ax-press' : 'element-press', peakOverlappingCalls: peak, warmConfirmedMs: stats(warm.map(r => r.elapsedMs)),
      warmDeviceMs: stats(warm.map(r => r.deviceMs)), overGate: warm.filter(r => r.elapsedMs >= CLICK_GATE_MS).length,
      windows: lanes.map(l => ({ windowId: l.found.windowId, runId: l.session.runId, initial: l.initial,
        final: l.observed.actual, coldMs: l.samples[0].elapsedMs, actions: l.samples.length })),
      pass: peak === 4 && warm.every(r => r.elapsedMs < CLICK_GATE_MS) };
  } finally {
    await all(lanes.filter(l => l.session).map(async l => {
      try { await l.session.finish(); } finally { await l.session.close(); }
    }));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [file, ids, n, at] = process.argv.slice(2);
    const result = await benchFourWindows(new QAClient(file), ids.split(',').map(Number), Number(n ?? 12), at?.split(',').map(Number));
    console.log(JSON.stringify(result, null, 2)); if (!result.pass) process.exitCode = 1;
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}

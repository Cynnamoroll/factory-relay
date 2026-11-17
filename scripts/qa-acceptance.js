import assert from 'node:assert/strict';
import { QAClient } from '../src/qa-client.js';

const client = new QAClient();
let runId;
async function waitFor(check, seconds) {
  const end = performance.now() + seconds * 1000;
  while (performance.now() < end) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('acceptance_timeout');
}
try {
  let target;
  if (process.argv[2]) {
    const discovered = await client.command({ op: 'connect' });
    const selected = discovered.windows.find(w => w.windowId === Number(process.argv[2]));
    assert.ok(selected, 'Explicit window must be a freshly discovered own RelayMac target');
    const { windowId, pid, bundleId } = selected; target = { windowId, pid, bundleId };
  }
  ({ runId } = await client.task('qa_start', { applicationId: 'relaymac', title: 'Shared human and agent QA acceptance',
    context: 'Operator acceptance; includes an explicitly intentional assertion mismatch', ...(target ? { target } : {}) }));
  const before = await client.task('qa_observe', { runId });
  const after = await client.task('qa_act', { runId, action: 'increment', observationId: before.observationId });
  const passed = await client.task('qa_check', { runId, title: 'Agent increment updates native count', expected: before.actual + 1 });
  assert.equal(passed.status, 'pass');
  const failed = await client.task('qa_check', { runId, title: 'Intentional mismatch validates replay',
    context: 'Deliberate acceptance test failure, not a claim of a product defect', expected: before.actual + 100 });
  assert.equal(failed.status, 'fail'); assert.equal(failed.actual, before.actual + 1);
  console.log(JSON.stringify({ runId, initial: before.actual, observed: after.actual,
    passingCheck: passed.title, deliberateFailure: { title: failed.title, expected: failed.expected, actual: failed.actual },
    replayUrl: failed.replayUrl }));
  console.log(`In Factory's Live pane: Take control, Observe, Increment, check expected ${before.actual + 2} with a descriptive title, then Finish. Complete within 120 seconds.`);
  await waitFor(async () => (await client.task('qa_status')).owner === 'human', 60);
  await assert.rejects(client.task('qa_act', { runId, action: 'increment', observationId: after.observationId }), /stale_control/);
  await waitFor(async () => (await client.task('qa_replay', { runId })).status !== 'running', 60);
  const report = await client.task('qa_report', { runId, waitMs: 30000 });
  assert.equal(report.status, 'fail', 'Deliberate mismatch must remain a failed assertion and run');
  assert.ok(report.checks.some(c => c.status === 'pass' && c.actual === before.actual + 2));
  console.log(JSON.stringify({ runId, staleAgentRejected: true, counts: report.counts, export: report.export, artifacts: report.artifacts }));
  console.log(report.reportMarkdown);
  console.log('Operator follow-up: if export is still pending, request qa_report again. Render the ready MP4 and report in chat. Open the failure link, seek/play, then restart the broker and replay without connecting to the Mac.');
} catch (e) {
  console.error(e.message); process.exitCode = 1;
} finally {
  if (runId) {
    try {
      const state = await client.task('qa_status');
      if (state.owner === 'agent' && state.runId === runId) await client.task('qa_finish', { runId });
    } catch { console.error('Operator cleanup needed; no takeover or input retry attempted.'); }
  }
}

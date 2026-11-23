import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qaEditPlan, qaToSource, sourceToQA, QA_EDIT_POLICY } from '../web/qa-edit.js';
import { qaRecordingSegments } from '../src/qa-export.js';
import { cursorPresentation } from '../src/qa-cursor-export.js';

const id = 'a'.repeat(32);
const events = [
  { kind: 'run-start', elapsedMs: 0 },
  { kind: 'step-start', operation: 'assert-count', stepId: id, elapsedMs: 1000 },
  { kind: 'assertion', stepId: id, elapsedMs: 1100, status: 'pass',
    title: 'Verify the updated count', expected: 1, actual: 1 },
  { kind: 'run-end', elapsedMs: 2000 },
];

test('default QA pacing gives a brief check eight seconds without fabricating evidence or captions', () => {
  const original = JSON.stringify(events), plan = qaEditPlan(events, 2000);
  assert.equal(plan.available, true);
  assert.equal(plan.evidenceMs, 100);
  assert.ok(plan.durationMs >= 8000);
  assert.equal(plan.presentationMs, plan.durationMs - 100);
  assert.equal(plan.omittedMs, 1900);
  assert.deepEqual(plan.segments.map(s => s.kind), ['review-hold', 'evidence', 'review-hold']);
  assert.equal(qaToSource(plan, 500), null, 'A review pause is not elapsed capture time');
  const evidence = plan.segments.find(s => s.kind === 'evidence');
  assert.equal(qaToSource(plan, evidence.startMs + 50), 1050);
  assert.equal(sourceToQA(plan, 1050), evidence.startMs + 50);
  assert.equal(JSON.stringify(events), original);
  const packets = qaRecordingSegments(events, plan);
  assert.ok(packets.every(p => p.kind === 'gap'), 'No frame is invented when evidence is missing');
  const presentation = cursorPresentation(events, packets, plan.durationMs);
  assert.doesNotMatch(presentation.ass, /Dialogue:/, 'Missing footage never acquires burned-in captions');
});

test('long descriptions receive more reading time; genuine long evidence is not accelerated', () => {
  const longer = structuredClone(events);
  longer[2].title = 'Read '.repeat(40);
  const short = qaEditPlan(events, 2000), long = qaEditPlan(longer, 2000);
  assert.ok(long.presentationMs > short.presentationMs);
  const real = structuredClone(events);
  real[2].elapsedMs = 16000; real[3].elapsedMs = 17000;
  assert.equal(qaEditPlan(real, 17000).evidenceMs, 15000);
});

test('maximum check count retains bounded, readable pauses', () => {
  const rows = [{ kind: 'run-start', elapsedMs: 0 }];
  for (let i = 0; i < QA_EDIT_POLICY.maxClips; i++) {
    const stepId = (i + 1).toString(16).padStart(32, '0');
    rows.push({ ...events[1], stepId, elapsedMs: i * 100 + 1 },
      { ...events[2], stepId, elapsedMs: i * 100 + 2, title: 'Read '.repeat(40) });
  }
  rows.push({ kind: 'run-end', elapsedMs: 30000 });
  const plan = qaEditPlan(rows, 30000);
  assert.equal(plan.available, true);
  assert.equal(plan.clips.length, QA_EDIT_POLICY.maxClips);
  assert.ok(plan.clips.every(c => c.endMs - c.startMs >= 8000));
  assert.ok(plan.durationMs <= QA_EDIT_POLICY.maxReviewDurationMs);
});

test('fractional source clocks cannot drop evidence packets at review boundaries', () => {
  for (let i = 1; i <= 257; i++) {
    const rows = structuredClone(events);
    rows[1].elapsedMs = 100 + i * .001;
    rows[2].elapsedMs = 400 + i * .002;
    rows[3].elapsedMs = 600;
    rows.splice(1, 0, { kind: 'frame', elapsedMs: 0, frameId: 'b'.repeat(32) });
    const plan = qaEditPlan(rows, 600);
    assert.equal(plan.available, true);
    const packets = qaRecordingSegments(rows, plan);
    const encodedMs = packets.reduce((sum, packet) => sum + packet.endMs - packet.startMs, 0);
    assert.ok(Math.abs(encodedMs - plan.durationMs) < .000001,
      `Every admitted packet survives presentation mapping: case ${i}, ${encodedMs} versus ${plan.durationMs}`);
  }
});

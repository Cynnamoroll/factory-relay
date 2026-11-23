import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readTask, report } from '../src/qa-tasks.js';
import { tasks } from '../src/qa-contract.js';

const events = JSON.parse(fs.readFileSync(new URL('../fixtures/qa-review-timing.json', import.meta.url))).events;
const duration = events.at(-1).elapsedMs;
const runId = '8797e68a6d26b3ee679e28611c8454ee';
const broker = {
  origin: 'http://127.0.0.1:43180',
  store: { get: () => ({ events, started: 1794858908762, frames: events.filter(e => e.kind === 'frame').length }) },
  exports: { state: () => ({ status: 'none' }), request: () => assert.fail('Read-only review must not export') },
};

test('results contract returns all real successes and failure without exporting or frame internals', async () => {
  const data = await readTask(broker, 'qa_replay', tasks.qa_replay.parse({ runId, filter: 'results', limit: 100 }));
  assert.deepEqual(data.counts, { pass: 2, fail: 1, blocked: 0, uncertain: 0 });
  assert.equal(data.checks.items.length, 3); assert.equal(data.nextOffset, null);
  assert.equal(data.checks.items[1].expected, 102); assert.equal(data.checks.items[1].actual, 3);
  assert.equal(data.operationalErrors.items[0].reason, 'ownership_change');
  assert.doesNotMatch(JSON.stringify(data), /frameId|sha256|snapshot|observationId/);
  const page = await readTask(broker, 'qa_replay', tasks.qa_replay.parse({ runId, filter: 'results', limit: 1 }));
  assert.equal(page.nextOffset, 1);
  assert.equal(page.checks.total, 3);
  const next = await readTask(broker, 'qa_replay', tasks.qa_replay.parse({ runId, filter: 'results', limit: 1, offset: 1 }));
  assert.equal(next.checks.items[0].status, 'fail');
});

test('agent report supplies failure-first links, source context and honest download semantics', () => {
  const data = report(broker, runId);
  assert.equal(data.checks[0].status, 'fail');
  assert.equal(data.checks[0].clip.sourceStartMs.toFixed(6), '19929.107597');
  assert.match(data.checks[0].replayUrl, /&step=0f536356251f5f6b03c837c4408cbed7$/);
  assert.match(data.reportMarkdown, /review pauses/);
  assert.match(data.reportMarkdown, /no text is burned into the MP4/);
  assert.match(data.reportMarkdown, /idle between operations are omitted/);
  assert.ok(data.edit.evidenceMs > 15000 && data.edit.evidenceMs < 16000);
  assert.ok(data.edit.durationMs > data.edit.evidenceMs);
});

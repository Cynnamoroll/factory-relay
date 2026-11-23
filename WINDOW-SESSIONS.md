# Isolated agent window sessions

Use a window session when agents need to run QA on different Mac windows at the same time. One to four sessions use the same QA launcher.

Window sessions accept only an authorized Mac **window**, not a desktop display. Attach with both `target` and `processStartedAt` from `qa_targets`, or opt in to a newly launched RelayMac fixture with `managedFixture: true` and neither field. The broker checks the process identity again before starting capture. A held window or desktop lease can reject a start with `lease_held`. Agents never take over or reacquire control automatically. An explicit legacy human takeover still obeys the Mac's lease rules.

## Human recording context

One active window session records the whole selected physical display by default
when record-only capture is supported. The display with the largest validated
window overlap is selected, including negative display origins. Ambiguous or
unavailable geometry retains window recording with an explicit reason.

Another session reserves its slot and cancels and flushes existing display
context before setup or managed launch. With two or more active or opening
sessions, recordings are window-only. Returning to one active session resumes
display context. Legacy shared runs participate in the same population.
Closing, finishing, failed setup, expiry, and revoked authority stop owned
capture. No display capture is used to acquire an exclusive lease or to change
input authority.

Inspect `session.started.recordingScope` and
`await session.task('qa_status')` for the current scope and reason. Start waits
up to 15 seconds for a durable first display JPEG before proceeding or recording
an explicit fallback. The paired pane shows recording scope separately from
window-only preview and input. `session.live()`, observation images, OCR and
`qa_replay` frame lookup remain window-only.

Downloaded recordings can contain other visible apps. Their provenance identifies
scope transitions and separately hashed display context frames. Raw selected-window
evidence is never replaced or rewritten, and missing footage is not filled.
The supplementary images share recording quotas, private storage, crash recovery
and confirmed deletion with the original evidence.

## Node SDK

```js
import { QAClient } from './src/qa-client.js';

const qa = new QAClient();
const { windows } = await qa.task('qa_targets');
const { target, processStartedAt } = windows.find(w => w.target.bundleId === 'com.factory.applets.RelayMac');
const session = await qa.openWindowSession({ target, processStartedAt, title: 'Counter QA' });
try {
  const { observationId, actual } = await session.observe();
  const result = await session.actAndWait(
    { action: 'increment', observationId },
    { kind: 'count', equals: actual + 1, timeoutMs: 1000 },
  );
  console.log(result.status, result.effect);
  await session.finish();
  const evidence = await session.task('qa_replay', { filter: 'results' });
  console.log(evidence);
} finally {
  await session.close();
}
```

Use `await qa.openFixtureSession({ title: 'Counter QA' })` instead of discovery and `openWindowSession` to own a fresh RelayMac fixture. Managed launch requires the [updated fixture build](MANAGED-FIXTURE.md). It does not support other applications or an arbitrary command.

- `session.runId` and `session.target` are immutable. `session.task(name, input)` supplies the bound `runId` to run tools and rejects a different ID.
- `session.live()` returns the latest scoped JPEG as a `Buffer`. It does not issue an observation or enable input. `session.observe({ includeImage: true })` returns an observation and optionally its JPEG. Obtain a new observation before another action.
- `session.act(input)` sets `completion: 'ack'`. An acknowledgement is not an assertion and must not be retried as if nothing happened. `session.actAndWait(input, waitFor)` sends `qa_act` with a device-side count condition for a RelayMac increment or click. `timeoutMs` is 1–2000. Other supported windows use background left single clicks on pressable accessibility elements and visual checks.
- `session.finish()` ends the run and releases capture and the native lease. For a managed session it also closes the fixture. The session bearer can still read that run with `qa_replay` or `qa_report` until close or expiry.
- `session.close()` revokes the credential, stops capture, and releases the lease. It closes only an owned fixture, never an attached app. Closing cannot undo input already dispatched. The launcher expires credentials after 12 minutes and allows up to four sessions, including finished sessions whose credentials remain open.
- The SDK sends heartbeats only while a managed session is reachable by the client, active, and unexpired. Heartbeats do not keep the Node process alive. Prefer `finish()` and `close()` in normal use, so cleanup failures reach the caller. If the client disappears, the watchdog closes its fixture.
- A paired human can review these runs in the normal Recordings view after close, expiry, slot reuse, or broker restart. Window runs use the existing shared recording and export budgets. When the archive is full, the broker rejects new recordings. Only explicit human deletion removes evidence.

Recordings in older per-session storage directories are left in place and are not automatically imported.

## MCP

Run one MCP process per window with `npm run qa:mcp -- --window-session`. An optional credentials file path follows `--window-session`; the default is the launcher's workspace `agent.json`.

1. Call `qa_targets`, then `qa_start` with the chosen window's `target` and `processStartedAt`. Or call `qa_start` with `{ "managedFixture": true }` to own a new RelayMac. Do not combine these forms.
2. Use the returned `runId` with `qa_observe`, `qa_act`, `qa_check`, `qa_finish`, `qa_replay`, and `qa_report`. Pass `completion: "ack"` or the RelayMac `waitFor` object on `qa_act` as needed.
3. Finish the run and close the MCP connection. This closes its window session but keeps its evidence in Recordings. To select a different window, start another MCP process.

The opt-in process exposes the ten shared QA tool names plus
[`qa_click_and_check_text`](QA-PROCEDURE.md), a bounded visual procedure.
Before `qa_start`, it offers window discovery without shared-run access.
After `qa_start`, even discovery and run lists are restricted to the bound window
and run. Use `compact:true` on scoped finish/report calls to keep full check
lists and report prose out of routine agent context.

## Loopback HTTP

Send `X-QA-Request: 1` on every request and `Content-Type: application/json` on POST. The launcher's agent bearer token can mint a session with `POST /api/window-sessions` using `{ target, processStartedAt, title?, applicationId?, context? }` or `{ managedFixture: true, title?, applicationId?, context? }`. The response includes a distinct session bearer token, `runId`, and `expiresAt`. Keep that bearer private.

Use the **session bearer**, not the launcher bearer or a browser cookie, for:

- `POST /api/window-sessions/current/tasks/qa_*` with the existing QA task arguments. `qa_start` and `qa_control` are not allowed after binding.
- For managed sessions only, `POST /api/window-sessions/current/tasks/qa_heartbeat` with `{}` every 5 seconds while the fixture is needed. Stop on `active: false`, close, or a terminal error. A managed fixture is reaped after 30 seconds without renewal, and heartbeats cannot extend its hard deadline.
- `GET /api/window-sessions/current/live` for a read-only JPEG.
- `DELETE /api/window-sessions/current` to close and revoke the session.

A run ID is not a credential. Session bearers cannot mint sessions, send legacy commands, access shared evidence, or access another session. The bootstrap credential can still use the legacy agent interface, but it cannot read archived window runs. Do not distribute it as a window-scoped credential.

The paired browser uses three read-only routes:

- `GET /api/window-overview` returns `{ sessions }`. Each lane has `runId`, `title`, `target: { pid, windowId, bundleId }`, `recordingScope`, `connection`, `frameVersion`, `frameAgeMs`, `owner`, and `currentCheck` (`{ title, status }` or `null`).
- `GET /api/window-overview/<runId>/frame` returns the current JPEG or `404`.
- `GET /api/window-overview/<runId>/stream` returns the usual binary live stream with JPEG and H.264 packets. The stream ends when its lane finishes, closes, or loses native authority.

Neither bearer token grants access to these routes. The browser must be paired.

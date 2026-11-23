# One-call window text check

Use `qa_click_and_check_text` on the opt-in `--window-session` MCP after `qa_start` has bound an authorized native Mac window. The check is for **newly visible text**, not whether a button accepted a click. It runs on the same recording as the other scoped tools.

Calibrate the point and the two literal English lines on the intended app and layout first. Use the raw window JPEG, not a scaled replay or a desktop screenshot. For raw pixel `(px, py)` and `imageGeometry.contentRectPixels = [left, top, width, height]`, pass `x = (px-left)/width` and `y = (py-top)/height`. Both coordinates must be in `[0,1)`. The precondition is a state guard, not a way of locating the button. Do not use a guessed point or a line that is already visible in the starting state.

```js
// Example labels and point from the generated test fixture, not a real app calibration.
const check = await session.clickAndCheckText({
  title: 'Open detail', beforeText: 'Library View', expectedText: 'Detail Page',
  x: 0.3, y: 0.6,
});
```

The MCP tool takes the same five required arguments. It accepts no run/target override, tool chain, script, OCR command, or arbitrary input gesture. There is no corresponding shared-desktop or HTTP procedure. Each client uses its existing scoped bearer for the primitive tasks.

1. `qa_observe` requests fresh window pixels and single-use authority. Local Tesseract must recognize the entire `beforeText` line confidently. If it reads `expectedText` anywhere as a whole line, **even at low confidence**, it blocks without input. Matching uses NFC, trimmed/collapsed whitespace, and otherwise literal, case-sensitive equality. Labels are single lines of at most 120 characters.
2. `qa_act` consumes that observation for **one** background left single click at the calibrated point. The device still enforces the lease, process identity, window geometry, and accessibility action. The procedure does not focus the window, move the cursor, take control, or fall back to a display. It uses the pixel-returning form of `qa_act`, not `completion:"ack"`: the broker requires a newer frame after acknowledgement.
3. The procedure compares scoped OCR lines internally. A confident new expected line passes. On a nonmatch it waits 2.1 seconds, past the broker's 2-second cached-frame window, and takes one more **read-only** observation. A fail requires two fresh, legible nonmatches, not an empty image, timeout, or stale frame. Legible means every recognized word scored at least 80/100 and the reading contains a three-character letter/digit sequence. A positive match requires every word in the matched line to score at least 80. This is a check at the sampled times, not an indefinite wait for the app.
4. `qa_check` records a named `kind:"visual"` pass/fail using the assessed observation and frame. The native broker validates authority, not the OCR verdict. No OCR engine can establish that unrecognized text is absent, or that the click caused the change. Keep the replay as the source for human review.

The procedure pipes a validated JPEG into `/usr/bin/tesseract` on the SDK/MCP workstation. It needs the English trained data. No shell, network OCR, user-specified executable, filesystem screenshot, or installation step is used. Input is limited to 4 MiB and 2048 pixels per side; OCR stdout and stderr are bounded to 256 KiB each, and each process has a 5-second deadline. Missing OCR blocks before input. Partial evidence after an attempted click is **uncertain**. Do not repeat input on that basis. Close/authority loss does not trigger recovery clicks.

## Result and recording

For one active window session, the human recording includes whole-display
context when available. Parallel or opening sessions switch to separate window
recordings. Inspect `qa_status.recordingScope` for the actual scope and fallback
reason. OCR and all procedure input continue to use only raw selected-window
pixels and geometry. Recording context grants no additional input authority.

The recorded coordinate click has a plain scoped synthetic cursor in Live and
downloaded videos when snapshot and frame geometry match, without click animations.
These are presentation cues, not physical cursor capture or OCR evidence.
Attempts, blocked actions, and uncertain outcomes do not receive a successful
click marker. The extra read-only observation used by this procedure can retain
preceding-input context only with the same actor, target, process start, and
layout, and no intervening mutation, gap, or ownership change. Association never
asserts causation or changes the visual-check rules. Raw JPEGs remain unmarked.

| Status | Meaning |
| --- | --- |
| `pass` or `fail` | A recorded OCR visual check. `actual` contains the recognized expected line or a bounded mismatch description. `checkId` selects the recorded step. |
| `blocked`, `retrySafe:true` | The procedure did not attempt input. Correct the precondition, calibration, authority, or local OCR problem first. |
| `uncertain`, `retrySafe:false` | A click was attempted, but no conclusive check was confirmed. Inspect the recording and current state. Never automatically retry. |

Only `status`, `expected`, `actual`, `replayUrl`, `checkId` and, for inconclusive results, `retrySafe` are returned. An inconclusive result uses `checkId:null` and the run URL. The URL is for an authenticated local human review session; it contains no session credential. The scoped agent can use `qa_replay` on its own run. The tool returns no image or full OCR text. The recording still contains the scoped images, input attempts, and broker events. An OCR blocker before `qa_check` is a procedure result, not a fabricated recorded assertion. Do not substitute an aggregate run status for the procedure result.

Continue using the session or finish it normally. Scoped MCP `qa_finish` and `qa_report` accept optional `compact:true`. The SDK supports the same projection. It omits check lists, edits, and Markdown, retaining the run outcome, counts, replay link, artifact paths, and export state/errors:

```js
try {
  const result = await session.clickAndCheckText(calibratedInput);
  const finished = await session.finish({ compact: true });
  const report = await session.task('qa_report', { compact: true, waitMs: 10000 });
  console.log(JSON.stringify({ result, finishExportError: finished.exportError, report }));
} finally {
  await session.close();
}
```

`qa_finish`, `qa_report`, `qa_replay`, raw frames, and artifact retention have not been replaced. A pending or unavailable export is not a ready MP4. Obtain the full report separately if needed.

## Measuring model-facing cost

Run `node --test test/qa-procedure.test.js`. The stdio MCP test sends the procedure request, resets the fixture to the same initial JPEG, and runs `qa_observe(includeImage:true)`, pixel-returning `qa_act`, and `qa_check` against the same transition. It checks the two raw JPEGs and the named check in the run. It counts calls and sums `Buffer.byteLength(JSON.stringify(request)) + Buffer.byteLength(JSON.stringify(response))` for each. `request` is the MCP `{name, arguments}` object; `response` is the full tool result, including base64 image content and duplicate structured/text fields when present.

This measures serialized UTF-8 **payload bytes**, not provider tokens, billed cost, network traffic to the Mac, OCR CPU, or end-to-end model latency. The baseline test identifies its known generated frames; no model is invoked. Both paths exclude identical startup, calibration, tool discovery, reporting, and teardown. For a whole-workflow comparison include those stages and any extra observations or retries. For token or cost claims, run both workflows with the same provider/model and image settings, and compare its reported text, image, cache and output usage. Do not divide base64 or JSON byte counts by a guessed characters-per-token factor.

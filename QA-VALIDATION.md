# Validating native application QA

Validate the application through its real window and the public Relay interface.
Mock adapters and generated images are useful regression checks, not native
application qualification.

## Prepare a repeatable case

- Record the application version, host version and supported capabilities.
- Use a disposable test library, account or workspace. Verify isolation rather
  than assuming an environment variable redirects every application store.
- Inspect the selected window's raw pixels. Calibrate controls in that layout.
- State the initial condition, single action and expected visible result before
  sending input. Avoid workflows that depend on personal data.

An input acknowledgement is not a passing check. Use fresh selected-window
evidence to assess the result. Attribute an OCR check to OCR and a caller visual
assessment to the caller; neither establishes native application state.

## Compare primitive and procedural paths

Run the same transition from the same verified initial state through both paths.
Include any read-only observations needed for delayed UI updates. Do not replay
uncertain input or change expectations to make a run pass.

For each path, retain:

- Requests, results, tool calls, image blocks and application effects.
- Named checks, exact-check replay links and the durable QA recording.
- Startup, calibration, execution, export and teardown costs separately.
- Negative cases: already-completed state, mismatch, stale authority and
  unavailable evidence.

Use compact results for normal agent operation and obtain full evidence only
when needed. Do not remove evidence to reduce model context.

## Measure tokens honestly

Prefer the provider's reported usage for the same model and image configuration.
Count input, output, images, cache effects and retries per successfully completed
task. Include tool schemas, discovery and reporting for a whole-workflow claim.

Local tokenization of tool JSON can compare text payloads, but it is not billed
model usage. State the tokenizer and what was excluded. Serialized bytes are
another proxy, not a token count. Do not estimate image tokens from base64 size.
Repeat paired runs before treating a single comparison as a stable saving.

## Verify the human result

Open the existing Factory pane and verify that:

1. An authorized recording appears live without whole-display fallback.
2. Additional recordings and independent agents retain their own windows.
3. Finished checks are accessible while other recordings continue.
4. The last recording transitions to review, and a later recording resumes
   automatic Live. Manual review and deep links remain selected with a live
   recording notice.
5. Transient stream loss does not leave a still-authorized window permanently
   blank or show another window's frames.

Decode the exported MP4 independently and inspect the expected result. Confirm
the exact-check replay, results and artifact paths agree. Sampled evidence and
marked gaps must not be described as continuous video.

For frame-rate claims, distinguish capture, transport, decoding, canvas drawing
and compositor presentation. A canvas counter does not measure display cadence.
For a latency limit, report the worst case and each miss, not just the median.

## Cleanup and limits

Finish and close owned sessions in `finally`. Terminate only processes the test
owns and verify their exit. Never close attached applications, the Factory pane,
or another agent's resources. Keep recordings after cleanup.

Store application-specific transcripts, screenshots, measurements and incident
details in private ignored evidence, not in generalized project documentation.
Report unsupported operations and unverified platforms explicitly. A passing
fixture or mock does not qualify a different native application or operating
system.

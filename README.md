# factory-relay

Shared Mac desktop QA in Factory's embedded browser, with named checks and recordings.
Live follows authorized test windows, never the whole display by default. With
several runs, select a window to watch while the others show previews. Finished
results are available immediately. Live moves to review after the last tracked
recording ends. Manual replay links still open the requested recording or check.
Window input uses background accessibility actions. Explicit whole-display QA
uses an exclusive lease and foreground mouse input; its recordings can contain
private content from any visible app.
**iOS input and keyboard/type input are not supported by this slice.**

### Recording scope is not input scope

A sole active window session records the entire physical display with the
largest overlap with its selected window. This is the default when the backend
supports record-only display capture. It can include private content from other
apps. Review recordings locally before sharing them.

Opening another session first cancels display recording and drains pending
image writes, before discovery, fixture launch, or capture for that session.
Both recordings then use their own windows. When only one active session remains,
display context resumes. Pending openings and legacy shared runs count too.
Finished credentials do not count as active sessions.

Live previews, agent observations, raw evidence JPEGs, OCR, normalized input
coordinates, and accessibility authority remain scoped to the selected window.
No exclusive lease, focus change, physical cursor movement, or foreground-input
fallback is added. Display capture is supplementary human recording context.
It records the visible desktop without raising the selected window; other
windows can cover a background application in that context footage.

`qa_start`, scoped session start, `qa_status`, and the paired pane show
`recordingScope` with its scope and reason. Display discovery, permission, geometry,
or prewarm failures explicitly retain window recording. Initial display prewarm
waits at most 15 seconds, matching the native first-frame budget. Missing footage
remains a marked gap, not invented video.
Export provenance separately lists `recordingScopes`, `recordingFrames`, and the
original hashed `sourceFrames`. Ordinary frame lookup and replay event/frame
pages do not return supplementary display images.

### Visible input in Live and recordings

Live viewing, QA videos, full-session exports, and their posters show synthetic
input cues. Agent and human inputs have distinct colors. A coordinate left single
click shows a plain cursor only when matching run, target, process,
snapshot layout, and capture geometry establish a point. Element presses without
coordinates remain labeled nonspatial actions. Attempts, native acknowledgement,
blocked input, and uncertain input are distinct. An ACK is not a passing check.

Cursor travel between known points is a visualization, not captured physical
movement. The overlay never moves the operating-system cursor, changes focus, or
modifies raw JPEGs, agent images, or OCR input. Missing or stale geometry suppresses
spatial markers. There are no click rings or click animations. Reduced-motion
preferences disable live travel. Cues expire and are cleared when their view or run changes.
For display-context recordings, markers map validated window snapshot points
through global display bounds, capture attachment geometry, and export
letterboxing. Window-normalized coordinates are never treated as desktop input.

Downloaded MP4s include the same labeled visualization. Presentation samples
subdivide existing receive-clock evidence intervals without adding dwell time or
filling missing footage. Read-only observations can connect a recorded input to a
later check only when actor, target, process, and layout still match, with no
intervening mutation, ownership change, or recording gap. This is context, not
proof of causation. Assertion validation is unchanged.

QA edit version 4 and source overlay generation 1 use new export filenames.
Previously stored journals, raw frames, and older export generations remain
intact. Preparing a recording again derives the current marked video locally.

### Descriptive recording names

Recordings use `Application name - QA test description` in Live, review,
history, results JSON, and new export metadata. The application name comes from
the exact discovered process display name, not its document or window title.
Configured application names are a fallback when discovery has no display name.
Whole-display runs use `Shared display`.

Pass the test purpose as the start title. An already application-prefixed title
is not prefixed twice. Without a meaningful title, context supplies the purpose.
otherwise the first named check supplies it from the durable journal. Before
that check, the honest fallback is `Application name - QA session`. Naming never
reads personal files or private application data.

Downloads retain the descriptive title, a run discriminator, the correct
extension, and a QA or full-session marker. Unsafe filename characters are
removed and Unicode names use UTF-8 download headers. Existing artifact URLs,
raw frames, journals, and older recordings remain unchanged and readable.

## Requirements

### Local computer

- Node.js **22+**, npm, Git, and Python **3.9+** (for tests).
- Factory app with its embedded browser, authenticated Droid CLI, and `agent-browser`
  executable. Open this repository as a Factory project.
- Local `ffmpeg` and `ffprobe` on `PATH`, with H.264 encoder `libx264`,
  `drawtext` and `subtitles` filters, and a usable font.
- Project skills **`factory-relay-setup`** and **`factory-relay`**, plus Factory's
  built-in **`agent-browser`** skill. These are automatically discovered in the
  project session. No additional skill or plugin installation is needed.

### Remote Mac

- **Apple Silicon (arm64), macOS 14+**, with a logged-in, unlocked desktop and
  `/usr/bin/python3` **3.9+**.
- Full Xcode, with first-launch setup and license acceptance completed. Select it
  in **Xcode → Settings → Locations → Command Line Tools**.
- Install **iOS Simulator runtimes for the iOS versions you want to test** in
  **Xcode → Settings → Components**. RelayMac itself needs no booted iOS simulator.
- Enable **macOS System Settings → General → Sharing → Remote Management**.
- Separately, sign into Factory with the **same account** as the local computer
  and enable **App Settings → Droid Computers → Remote Control**, or run
  `droid daemon --remote-control`. Use that Mac's registered computer name below.

macOS Remote Management and Factory Remote Control are separate requirements.
Commands use Factory's transport; setup does not change macOS permissions or
network settings for you. **No Node, npm, or second repository clone is needed
on the Mac.** Create its workspace there before continuing:

```sh
mkdir -p "$HOME/Projects/factory-relay"
```

## Setup

To have Droid guide setup, paste this into a local Factory session:

```text
Set up https://github.com/Cynnamoroll/factory-relay using its README and
factory-relay-setup skill. Reuse an existing checkout or clone a new one.
Confirm my registered Mac and workspace, check prerequisites, and preserve
existing configuration and approved hosts. Ask before system changes or license
acceptance. Guide me through the Mac approvals, then open the embedded QA pane.
Use factory-relay to record one RelayMac check and give me its recording.
```

Or run locally, replacing `YOUR_REGISTERED_MAC` and the Mac username `you`:

```sh
git clone https://github.com/Cynnamoroll/factory-relay.git
cd factory-relay
npm ci
npm run setup -- --computer YOUR_REGISTERED_MAC --workspace /Users/you/Projects/factory-relay
npm run setup:mac
```

`setup` creates private `config.local.json` and project `.factory/mcp.json`,
preserving unrelated MCP servers and refusing conflicting configuration.
`setup:mac` installs a missing host, builds RelayMac, and opens both apps.
It reuses an intact, matching host and refuses to automatically overwrite or
rebuild an existing approved host.

### Approve Factory Relay on the Mac

In **Factory Relay**, click **Enable screen recording** and **Enable control**,
then approve the macOS prompts for this exact app:

```text
<remote workspace>/.applets-host/Factory Relay.app
```

In **System Settings → Privacy & Security**, grant **Screen Recording** (or
**Screen & System Audio Recording**) and **Device Control and Data Access**
on macOS 27+, or **Accessibility** on earlier versions. Use **Command-Shift-G**
in the file picker to reach the hidden `.applets-host` folder.
If screen status stays stale after approval, click **Check again**, then **Done**.
The app may briefly reopen to refresh macOS permission status.

Approval needs a person at the Mac. Do not grant Terminal or other helpers these
permissions, grant Full Disk Access, reset TCC, or bypass consent.

For an intentional host upgrade only: stop QA, quit Factory Relay, review the
changes, then run `node scripts/build-host.js config.local.json` locally.
This guarded upgrade is separate from setup. Ad-hoc signing means a rebuild
may require permission approval again. Do not rebuild to troubleshoot permissions.
If approvals still refer to an older build, remove only Factory Relay from the
two privacy lists, then add and approve the current app again.

## Daily launch

In the local Factory project, start the broker and keep it running:

```sh
npm run qa -- config.local.json
```

Start the broker inside the Factory project session to open its assigned browser
pane automatically on the first agent window run. For manual pairing:

```sh
npm run qa:open
```

This pairs Factory's existing embedded browser pane, not an external browser.
For parallel QA use [window sessions](WINDOW-SESSIONS.md): up to four agents
can operate separate authorized windows, each with its own grant, checks and recording.
For a disposable RelayMac, use a [managed fixture](MANAGED-FIXTURE.md) and
close the session when finished. Attaching to an existing app never grants
permission to terminate it. Closing a session does not remove its recordings.
For calibrated, repeatable native UI checks, use the
[one-call text transition procedure](QA-PROCEDURE.md) instead of sending each
observation and image through the model. Use `compact:true` on scoped finish and
report calls. Full checks, recordings and exports remain available on demand.
See [how to validate native QA and token costs](QA-VALIDATION.md).
If the assigned pane endpoint is missing or rejected, stop. Do not launch a
browser, substitute a Chrome debugging port, or create, inspect or clean up a
browser profile. Use RelayMac fixtures, not personal browsers, for Mac tests.
Optionally run `droid mcp list` to check `factory-relay` and its ten QA tools.
If missing, reload project MCP servers or reopen the project after setup.

Keep RelayMac visible on the unlocked Mac. Ask Droid:
“Use factory-relay with `qa_start({applicationId:"relaymac"})` to check that Increment adds one to the current count,
finish the run, and give me the recording.” Do not assume the count starts at zero.

Configuration, credentials, recordings (`.qa-workspace/`), and artifacts are
private and Git-ignored. Review recordings before sharing. Keep the broker local;
do not expose it through a tunnel or public listener.

## Optional application profiles

Keep `config.local.json` private. Add an optional `applications` array to register
up to 32 apps, then restart the local broker when no run is active. For example:

```json
{
  "applications": [
    {"id":"relaymac","name":"RelayMac","platform":"macos","bundleId":"com.factory.applets.RelayMac"},
    {"id":"editor","name":"My Editor","platform":"macos","bundleId":"com.example.Editor"},
    {"id":"demo-ios","name":"Demo iOS","platform":"ios-simulator","bundleId":"com.example.Demo","simulatorUdid":"abcdef12-1234-4234-8234-123456789012"}
  ]
}
```

Merge this field into your existing config, preserving its transport settings.
Profiles identify an app/device; they contain no app-specific automation.
Omitting it permits, but does not select, whole-display control. Only explicitly
request `qa_start({applicationId:"desktop"})` to select the actual main display.
A start without a target or profile never falls back to the display. Other displays
and restricted windows can be selected explicitly. No per-app profile is needed for generic QA, including
bare executables whose bundle ID is empty. An explicit array is an allowlist;
`[]` authorizes no targets. Any explicit array disables desktop authority. IDs must be unique safe identifiers; profile bundle IDs
cannot contain wildcards. iOS profiles require an exact simulator UUID.

Read `qa_status.applications` for profile shortcuts, or call `qa_targets` for
displays (including `main`, point bounds and stable UUID) and visible authorized
Mac windows. Pass an exact `target` to `qa_start` within 30 seconds of discovery.
Capabilities describe implemented support, not permissions, running apps or device
discovery. Mac profiles use the same generic window driver. RelayMac additionally
supports count observation, increment and integer checks. iOS profiles remain
unsupported and cannot authorize Mac input through a matching bundle identity.

## Generic mouse QA

Use only the existing broker and approved Factory Relay host. The default desktop
target is `{kind:"desktop",displayId,displayUUID}` with a canonical lowercase UUID.
A desktop run permits ordinary cross-app interaction on that display only.
Display disconnect, identity, origin, resolution, scale or rotation changes fail
closed. No keyboard, permission bypass or protected-surface control is provided.

Restricted targets are `{windowId,pid,bundleId}`. A left single click on a
pressable accessibility control can run silently even behind another window.
Unsupported gestures fail with `background_unavailable`; there is no fallback
to the real cursor. Process identity uses kernel start time, including for bare
binaries with empty bundle IDs. Window mode rejects other windows and popovers.
Observation requests a process-local accessibility tree when an application
advertises that opt-in. This does not change its profile, grant operating-system
permissions, activate the application, or send an input action.

Calls below use IDs returned by preceding calls, not guessed IDs:

```text
qa_targets({})
qa_start({title: "Main desktop interaction checks"})
// Or choose a discovered display: target: {kind:"desktop",displayId:DISPLAY_ID,displayUUID:DISPLAY_UUID}
qa_observe({runId: RUN_ID, mode: "pixels", includeImage: true})
qa_act({runId: RUN_ID, action: "mouse", observationId: OBSERVATION_ID,
  mouse: {kind: "click", x: 0.25, y: 0.5, button: "left", count: 1}})
qa_check({runId: RUN_ID, kind: "visual", observationId: RETURNED_OBSERVATION_ID,
  title: "Expected view is visible", expected: "Describe the intended view",
  actual: "Describe the screenshot you inspected", outcome: "pass"})
qa_observe({runId: RUN_ID, mode: "pixels", includeImage: true})
qa_act({runId: RUN_ID, action: "mouse", observationId: OBSERVATION_ID,
  mouse: {kind: "drag", x: 0.2, y: 0.6, toX: 0.7, toY: 0.6, durationMs: 500}})
qa_check({runId: RUN_ID, kind: "visual", observationId: RETURNED_OBSERVATION_ID,
  title: "Drag result", expected: "Describe the intended final position",
  actual: "Describe the post-drag screenshot", outcome: "pass"})
qa_finish({runId: RUN_ID})
qa_report({runId: RUN_ID, waitMs: 30000})
```

Use `button:"right"` for a right click and `count:2` for a double click.
Other mouse commands are `{kind:"move",x,y}` and
`{kind:"scroll",x,y,deltaX,deltaY}`. Scroll deltas are signed integer pixels,
bounded to ±600 on each axis. Drag duration is 100–1000 ms with bounded steps.
Always inspect the returned post-action image and record a check after input.
Choose the outcome from the inspected screenshot. The example text and coordinates
are illustrative, not app-specific assertions or control locations.

Coordinates are normalized **[0,1)**, with the selected target's top-left at
`(0,0)`. Desktop `displayConfiguration.boundsPoints` includes negative origins,
with exact pixel dimensions, scale and rotation. Restricted windows retain
`windowRectPoints` and `processStartedAt`. For a raw JPEG
pixel `(px,py)`, use
`x=(px-contentRectPixels[0])/contentRectPixels[2]` and
`y=(py-contentRectPixels[1])/contentRectPixels[3]`.
Use `imageGeometry` from the same observation. Do not divide by a browser's
letterboxed rectangle or the exported 1280×720 video dimensions.

`qa_observe` binds fresh pixels to display identity/configuration or window geometry
and process start. Slow native observation and idle capture trigger a fresh capture
within the bounded startup budget, without relaxing the two-second frame-age limit.
Generic `actual` is null. Observations expire within 30 seconds and are consumed
before input. Acknowledgement is separate from an assertion. Never automatically
retry uncertain mouse input. Native drag cleanup releases a held button on
validation failure or IPC interruption; uncertain replies retain recovery fencing.

Visual checks require a fresh, unconsumed observation and bounded expected/actual
text. The recorded outcome is the caller's screenshot assessment, explicitly
`serverVerified:false`, not a server-computed fact. Checks retain frame links and
recorded footage in the default QA MP4, with conservative preceding-input context
and marked gaps. Existing journals and ready exports are not rewritten.

Live keeps the same shared image and ownership controls. Count controls are
disabled for desktop and generic windows. Human pointer interaction in the Live image is not
implemented; generic input uses `qa_act`, not a second native bridge.

The Live transport is H.264 video plus JPEG evidence on one credit-gated stream.
The host encodes captures with hardware VideoToolbox (real-time, no B-frames,
targeting 4 Mbps and 30 fps, not a guaranteed presentation rate) and relays one access unit per `vframe` packet. The wire
format is Annex B: every NAL unit carries a 4-byte start code, and each keyframe
access unit is prefixed with in-band SPS and PPS so a decoder can join at any
keyframe; keyframes arrive at least every two seconds. A 2 Hz JPEG snapshot
(`frame` packet, unchanged schema) feeds recording, poster and compatibility
viewing. The browser decodes with WebCodecs onto a canvas and falls back to the
JPEG snapshots with a visible compatibility note when WebCodecs is unavailable
or decoding fails. A viewer joining mid-stream first receives the newest JPEG
and the most recent keyframe, then live access units starting at the next
keyframe. Sequence numbers are monotonic across both packet types, and malformed
or oversized access units fail the stream closed.

### Recording storage and deletion

Recording deletion currently requires the local broker to run on Linux.

Recordings shows file-content sizes for source JPEGs/journals and all generated
exports, plus separate source (2 GiB) and export (512 MiB) limits and the 64-run
limit. Binary units exclude filesystem metadata/allocation overhead. Completed
export sizes are cached; Refresh updates the library and in-progress sizes.

Use a row's **Delete** action or **Delete recording…** in replay details. The
paired browser requires a named, permanent-deletion confirmation; Cancel removes
nothing. Active recordings and queued/encoding exports cannot be deleted. Wait
for completion, then refresh. No destructive MCP tool or automatic retention
purge is provided. Deletion releases the run slot and its source/export capacity.

The Linux broker records a durable, exact-file deletion intent before cleanup.
Failed deletion stays pending and cannot replay or regenerate exports. Retry
resumes only that confirmed recording; restart also resumes confirmed cleanup.
Unknown files, links or changed file identities stop cleanup rather than deleting
unrecognized data. Source and export directories are checked independently.

## License

[MIT](LICENSE). Copyright (c) 2026 Cynthia Toporowski.

# factory-relay

Shared Mac sample QA in Factory's embedded browser, with named checks and recordings.
**Current end-to-end input supports only the RelayMac sample's Increment button,
not arbitrary Mac or iOS apps.**

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

From another terminal or agent command **inside the same Factory project session**:

```sh
npm run qa:open
```

This pairs Factory's existing embedded browser pane, not an external browser.
Optionally run `droid mcp list` to check `factory-relay` and its nine QA tools.
If missing, reload project MCP servers or reopen the project after setup.

Keep RelayMac visible on the unlocked Mac. Ask Droid:
“Use factory-relay to check that Increment adds one to the current count,
finish the run, and give me the recording.” Do not assume the count starts at zero.

Configuration, credentials, recordings (`.qa-workspace/`), and artifacts are
private and Git-ignored. Review recordings before sharing. Keep the broker local;
do not expose it through a tunnel or public listener.

## License

[MIT](LICENSE). Copyright (c) 2026 Cynthia Toporowski.

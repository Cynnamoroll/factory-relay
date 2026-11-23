# Managed RelayMac fixture ownership

A managed session opts into a new RelayMac fixture process and one background window. An attached session has no ownership handle and never closes the target app. The launch path accepts neither an executable nor a PID from the caller. It refuses old RelayMac builds, non-Mac hosts, and builds outside the fixed workspace artifact path.

The remote supervisor executes the managed entry point directly, without a shell or LaunchServices reuse. The entry point sets accessory activation policy and creates a nonactivating AppKit panel. It reports its private marker, PID, parent PID, window number, and OS start stamp over the inherited pipe. The supervisor checks this proof against its unreaped direct child. The broker must also see the same window ID, PID, bundle and start stamp through the native host under the non-takeover window lease. Neither cleanup nor authorization searches by process name or window title.

Use `qa.openFixtureSession()` in the [Node SDK](WINDOW-SESSIONS.md), or pass `managedFixture: true` to scoped MCP `qa_start` or `POST /api/window-sessions`. Do not provide a `target` or `processStartedAt` for a managed launch.

The broker reserves a slot and checks RelayMac authorization before launch. A short, non-takeover observer lease refuses an existing exclusive holder before launch. The broker uses no discovery or input on that lease. It releases the observer lease and acquires a non-takeover lease for the fixture's exact window before recording or accepting input. An attached session cannot bind to a fixture already owned in the same launcher.

The SDK and scoped MCP send a heartbeat every 5 seconds using the session credential. For HTTP clients, send `POST /api/window-sessions/current/tasks/qa_heartbeat` with `{}`. The supervisor stops after 30 seconds without renewal. Heartbeats cannot extend the hard deadline.

Finish and close both clean up the fixture and preserve the recording. Finish leaves read-only replay available until the session credential expires or closes. An unexpected process exit interrupts the run and releases native control without deleting evidence. `fixture_cleanup_failed`, `fixture_cleanup_uncertain`, or `release_unconfirmed` mean cleanup could not be verified. Do not launch another fixture to retry an unconfirmed cleanup.

Normal close and broker/transport death close the supervisor's input. The supervisor closes the direct child's watchdog pipe and allows a grace period before signaling only its own still-unreaped child. A supervisor crash closes that watchdog pipe directly. The app has a separate absolute timer if the pipe remains open. There is no machine-wide scan, persistent ownership file, installed host shutdown, or recording deletion.

An authorized Mac operator must deploy the updated RelayMac sources and build the Debug fixture at `.applets-build/Build/Products/Debug/RelayMac.app` in the configured remote workspace. An older fixture returns `fixture_build_required`; managed launch does not build, install, or replace it. It does not replace the installed relay host.

`node --test test/qa-managed-fixture.test.js test/qa-window-sessions.test.js` checks process death and scoped HTTP/MCP behavior with fake Mac processes. Verify focus preservation, ScreenCaptureKit visibility, and Accessibility on a separately authorized Mac with the rebuilt fixture before relying on managed launch there.

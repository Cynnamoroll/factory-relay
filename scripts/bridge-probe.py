"""Fixed, lease-fenced experiment for the already-booted authored sample only."""

TARGET = "06ae5b11-c1c9-4456-b08e-c4e78c1f4247"
BUNDLE = "com.factory.applets.RelayDemo"



def probe():
    global DIAGNOSTIC_ROOT, DIAGNOSTIC_OPERATION, TARGET
    os.umask(0o077)
    request = json.loads(sys.stdin.buffer.read(16385))
    TARGET = str(uuid.UUID(request["args"]["udid"]))
    assert request["timeout"] == 120
    root = private_directory(Path.home() / ".applets-control")
    DIAGNOSTIC_ROOT = private_directory(root / "diagnostics")
    DIAGNOSTIC_OPERATION = "bridge-probe"
    with private_open(root / "lock") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Failure("busy")
        if (root / "inflight").exists() or (root / "bridge-session.json").exists():
            raise Failure("busy")
        state = read_state(root)
        lease = verify_lease(state, request)
        deadline = min(time.monotonic() + 120, time.monotonic() + lease["expiresAt"] - time.time())
        if deadline - time.monotonic() < 60:
            raise Failure("lease_expired")
        action_deadline = deadline - 30
        before = simulator_list(execute([APPLE["xcrun"], "simctl", "list", "devices", "--json"], action_deadline))["devices"]
        selected = next(d for d in before if d["udid"] == TARGET)
        if not selected["available"] or selected["state"] != "Booted":
            raise Failure("target_not_booted")
        with private_open(root / "inflight") as marker:
            marker.write(str(os.getpid()))
            marker.flush()
            os.fsync(marker.fileno())
        bridge = None
        key = None
        start_pending = False
        events = [{"step": "before", "devices": [{"udid": d["udid"], "state": d["state"]} for d in before]}]
        try:
            bridge = Bridge(deadline)
            bridge.rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {},
                                     "clientInfo": {"name": "applets-guarded-probe", "version": "1"}}, action_deadline)
            bridge.send({"jsonrpc": "2.0", "method": "notifications/initialized"})
            project = workspace_path(request["workspace"], "fixtures/RelayDemo/RelayDemo.xcodeproj")
            bridge.tool("XcodeOpenWorkspace", {"path": project}, action_deadline)
            events.append({"step": "workspace", "path": project})
            start_pending = True
            try:
                started = bridge.tool("DeviceInteractionStartSession",
                                      {"deviceIdentifier": TARGET, "sessionIdentifier": "Factory Sample Verification " + secrets.token_hex(8)},
                                      action_deadline)
            except Failure as error:
                if str(error) in ("bridge_approval_required", "target_unavailable", "session_identifier_conflict"):
                    start_pending = False
                raise
            key = started["interactionSessionKey"]
            with private_open(root / "bridge-session.json") as handle:
                json.dump({"key": key, "udid": TARGET, "generation": state["generation"]}, handle)
                handle.flush()
                os.fsync(handle.fileno())
            start_pending = False
            events.append({"step": "start", "deviceUUID": started["deviceUUID"],
                           "deviceIsSimulator": started["deviceIsSimulator"]})
            if str(uuid.UUID(started["deviceUUID"])) != TARGET or started["deviceIsSimulator"] is not True:
                raise Failure("target_mismatch")
            verify_lease(state, request)
            observation = bridge.tool("DeviceInteractionSynthesize",
                                     {"interactSessionKey": key, "activationBundleId": BUNDLE}, action_deadline)
            events.append({"step": "observe", **{k: observation[k] for k in
                           ("applicationState", "hierarchyPath", "screenshotPath")}})
        finally:
            try:
                if bridge and key:
                    bridge.tool("DeviceInteractionEndSession", {"interactionSessionKey": key}, deadline)
                    (root / "bridge-session.json").unlink()
                    events.append({"step": "end", "ownedSessionClosed": True})
                    key = None
            finally:
                if bridge:
                    bridge.close()
                if key is None and not start_pending:
                    (root / "inflight").unlink(missing_ok=True)
                try:
                    after = simulator_list(execute([APPLE["xcrun"], "simctl", "list", "devices", "--json"], deadline))["devices"]
                    events.append({"step": "after", "devices": [{"udid": d["udid"], "state": d["state"]} for d in after]})
                finally:
                    with private_open(DIAGNOSTIC_ROOT / "bridge-probe-events.json") as handle:
                        handle.seek(0)
                        json.dump(events, handle)
                        handle.truncate()
        before_states = {d["udid"]: d["state"] for d in before}
        after_states = {d["udid"]: d["state"] for d in after}
        changes = [{"udid": udid, "before": before_states.get(udid), "after": after_states.get(udid)}
                   for udid in sorted(before_states.keys() | after_states.keys())
                   if before_states.get(udid) != after_states.get(udid)]
        verify_lease(state, request)
        print(json.dumps({"events": events, "deviceStateChanges": changes}))


def interrupted(_signal, _frame):
    raise Failure("command_interrupted")


for signum in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT):
    signal.signal(signum, interrupted)
try:
    probe()
except Exception as error:
    print(json.dumps({"error": str(error) if isinstance(error, Failure) else "probe_failed"}))
    sys.exit(1)

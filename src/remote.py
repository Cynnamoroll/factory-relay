"""Ephemeral SSH helper. No listening service or installed remote agent."""
import fcntl
import json
import os
from pathlib import Path
import re
import secrets
import selectors
import signal
import stat
import subprocess
import sys
import time
import uuid
from contextlib import contextmanager

LIMIT = 1024 * 1024
APPLE = {"xcrun": "/usr/bin/xcrun", "xcodebuild": "/usr/bin/xcodebuild"}
WARNINGS = set()
DIAGNOSTIC_ROOT = None
DIAGNOSTIC_OPERATION = None


class Failure(Exception):
    pass


def private_directory(path):
    try:
        path.mkdir(mode=0o700)
    except FileExistsError:
        pass
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise Failure("unsafe_state")
    return path


def private_open(path):
    fd = os.open(str(path), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_nlink != 1:
        os.close(fd)
        raise Failure("unsafe_state")
    return os.fdopen(fd, "r+")


MAX_LEASES = 64
STATE_LIMIT = 65536


def valid_window_target(target):
    return (type(target) is dict and set(target) == {"windowId", "pid", "bundleId"}
            and type(target["windowId"]) is int and 0 < target["windowId"] < 2**32
            and type(target["pid"]) is int and 0 < target["pid"] < 2**31
            and isinstance(target["bundleId"], str) and len(target["bundleId"]) <= 255
            and re.fullmatch(r"[A-Za-z0-9._-]*", target["bundleId"]) is not None
            and target["bundleId"] not in ("com.factory.applets.host", "com.apple.iphonesimulator", "com.apple.dt.Devices"))


def valid_scope(scope):
    if type(scope) is not dict or scope.get("kind") not in ("exclusive", "observer", "window"):
        return False
    if scope["kind"] == "window":
        return set(scope) == {"kind", "target"} and valid_window_target(scope["target"])
    return set(scope) == {"kind"}


def valid_lease(lease):
    return (type(lease) is dict and set(lease) == {"owner", "token", "expiresAt", "generation", "scope"}
            and isinstance(lease["owner"], str) and isinstance(lease["token"], str)
            and re.fullmatch("[a-f0-9]{64}", lease["token"]) is not None
            and type(lease["expiresAt"]) in (float, int) and type(lease["generation"]) is int
            and 0 < lease["generation"] < 2**53 - 1 and valid_scope(lease["scope"]))


def read_state(root):
    """Version 1 held one global lease. It migrates to one exclusive lease with the same proof."""
    with private_open(root / "state.json") as handle:
        raw = handle.read(STATE_LIMIT + 1)
    if not raw:
        return {"version": 2, "generation": 0, "leases": []}
    try:
        assert len(raw) <= STATE_LIMIT
        state = json.loads(raw)
        assert type(state) is dict
        if set(state) == {"generation", "lease"}:
            assert type(state["generation"]) is int and 0 <= state["generation"] < 2**53 - 1
            lease = state["lease"]
            leases = []
            if lease is not None:
                assert set(lease) == {"owner", "token", "expiresAt"}
                leases.append(dict(lease, generation=state["generation"], scope={"kind": "exclusive"}))
            state = {"version": 2, "generation": state["generation"], "leases": leases}
        assert set(state) == {"version", "generation", "leases"} and state["version"] == 2
        assert type(state["generation"]) is int and 0 <= state["generation"] < 2**53 - 1
        assert type(state["leases"]) is list and len(state["leases"]) <= MAX_LEASES
        assert all(valid_lease(lease) and lease["generation"] <= state["generation"] for lease in state["leases"])
        assert len({lease["token"] for lease in state["leases"]}) == len(state["leases"])
        return state
    except (ValueError, AssertionError, TypeError, KeyError):
        raise Failure("unsafe_state")


def same_window(a, b):
    return a["windowId"] == b["windowId"] and a["pid"] == b["pid"]


def conflicts(scope, other):
    """Window leases coexist only for distinct targets; exclusive leases fence everything else."""
    if scope["kind"] == "exclusive" or other["kind"] == "exclusive":
        return True
    if scope["kind"] == "window" and other["kind"] == "window":
        return same_window(scope["target"], other["target"])
    return False


def lease_allows(lease, target, access):
    """access: discover, read (pixels/AX), or mutate (input)."""
    scope = lease["scope"]
    if scope["kind"] == "exclusive" or access == "discover":
        return True
    if target is None or target.get("kind") == "desktop":
        return False
    if scope["kind"] == "window":
        return same_window(scope["target"], target) and scope["target"]["bundleId"] == target.get("bundleId")
    return access == "read"


def require_access(lease, target, access):
    if not lease_allows(lease, target, access):
        raise Failure("lease_scope")
    return lease


@contextmanager
def state_lock(root, shared=False, wait=2):
    with private_open(root / "lock") as lock:
        until = time.monotonic() + wait
        while True:
            try:
                fcntl.flock(lock, (fcntl.LOCK_SH if shared else fcntl.LOCK_EX) | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= until:
                    raise Failure("busy")
                time.sleep(0.01)
        yield lock


def write_state(root, state):
    temp = root / ("state-" + secrets.token_hex(16))
    try:
        with temp.open("x", encoding="utf8") as handle:
            os.chmod(temp, 0o600)
            json.dump(state, handle)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, root / "state.json")
        fd = os.open(str(root), os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        temp.unlink(missing_ok=True)


def verify_lease(state, request):
    proof = request["args"]["lease"]
    found = None
    for lease in state["leases"]:
        # Compare every token so timing does not reveal which lease matched.
        if secrets.compare_digest(proof["token"], lease["token"]):
            found = lease
    if found is None or proof["generation"] != found["generation"] or request["owner"] != found["owner"]:
        raise Failure("stale_lease")
    if found["expiresAt"] <= time.time():
        raise Failure("lease_expired")
    return found


def execute(argv, deadline, cwd=None):
    if time.monotonic() >= deadline:
        raise Failure("command_timeout")
    try:
        proc = subprocess.Popen(argv, cwd=cwd, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                start_new_session=True)
    except OSError:
        raise Failure("command_failed")
    output = bytearray()
    errors = bytearray()
    size = 0
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(proc.stdout, selectors.EVENT_READ, True)
            selector.register(proc.stderr, selectors.EVENT_READ, False)
            while selector.get_map() or proc.poll() is None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise Failure("command_timeout")
                for key, _ in selector.select(min(remaining, 0.1)):
                    chunk = os.read(key.fileobj.fileno(), 65536)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    size += len(chunk)
                    if size > LIMIT:
                        raise Failure("command_output_limit")
                    if key.data:
                        output.extend(chunk)
                    else:
                        errors.extend(chunk)
            if proc.wait() != 0:
                raise Failure("command_failed")
        return bytes(output)
    finally:
        # Kill descendants too: a tool may exit while a child still owns a pipe.
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait()
        proc.stdout.close()
        proc.stderr.close()
        if errors:
            WARNINGS.add("remote_stderr_present")
            if re.search(rb"authorization (?:is )?required to install (?:the )?packages", errors.lower()):
                WARNINGS.add("apple_package_authorization_required")
            if b"coresimulator is out of date" in errors.lower():
                WARNINGS.add("apple_simulator_framework_incompatible")
            if b"Symbol not found" in errors and b"CoreDevice" in errors:
                WARNINGS.add("apple_coredevice_framework_incompatible")
        if DIAGNOSTIC_ROOT is not None:
            with private_open(DIAGNOSTIC_ROOT / (DIAGNOSTIC_OPERATION + ".json")) as log:
                log.seek(0)
                json.dump({"executable": argv[0], "pid": proc.pid, "processGroup": proc.pid, "exitCode": proc.returncode,
                           "outputBytes": size, "stdoutTail": output[-16384:].decode("utf8", "replace"),
                           "stderrTail": errors[-16384:].decode("utf8", "replace")}, log)
                log.truncate()


def workspace_path(workspace, relative):
    root = Path(workspace).resolve(strict=True)
    value = (root / relative).resolve(strict=True)
    if not value.is_relative_to(root):
        raise Failure("workspace_unavailable")
    return str(value)


def simulator_list(raw):
    try:
        devices = json.loads(raw)["devices"]
        result = []
        assert isinstance(devices, dict)
        for runtime, entries in devices.items():
            assert isinstance(runtime, str) and len(runtime) <= 256
            for entry in entries:
                assert isinstance(entry["name"], str) and 0 < len(entry["name"]) <= 256
                assert not any(ord(c) < 32 or ord(c) == 127 for c in entry["name"] + runtime)
                assert entry["state"] in ("Booted", "Shutdown", "Creating", "Booting", "Shutting Down")
                assert type(entry["isAvailable"]) is bool
                result.append({"udid": str(uuid.UUID(entry["udid"])), "name": entry["name"],
                               "runtime": runtime, "state": entry["state"], "available": entry["isAvailable"]})
        return {"devices": result}
    except (ValueError, KeyError, TypeError, AssertionError, AttributeError):
        raise Failure("invalid_remote_output")


def perform(request, root, state):
    operation, args = request["operation"], request["args"]
    deadline = time.monotonic() + request["timeout"]
    if operation == "acquire":
        scope = args.get("scope", {"kind": "exclusive"})
        if not valid_scope(scope):
            raise Failure("invalid_request")
        now = time.time()
        live = [lease for lease in state["leases"] if lease["expiresAt"] > now]
        blocking = [lease for lease in live if conflicts(scope, lease["scope"])]
        if blocking and not args["takeover"]:
            raise Failure("lease_held")
        live = [lease for lease in live if not conflicts(scope, lease["scope"])]
        if len(live) >= MAX_LEASES:
            raise Failure("busy")
        state["generation"] += 1
        lease = {"owner": request["owner"], "token": secrets.token_hex(32), "expiresAt": now + args["ttlSeconds"],
                 "generation": state["generation"], "scope": scope}
        state["leases"] = live + [lease]
        write_state(root, state)
        return dict(lease)
    if operation == "release":
        lease = verify_lease(state, request)
        state["generation"] += 1
        state["leases"] = [item for item in state["leases"]
                           if item is not lease and item["expiresAt"] > time.time()]
        write_state(root, state)
        return {"released": True, "generation": state["generation"]}
    if operation == "preflight":
        for command in [
            ["/usr/bin/uname", "-s"], ["/usr/bin/sw_vers", "-productVersion"],
            ["/usr/bin/xcode-select", "-p"], [APPLE["xcrun"], "--find", "simctl"],
            [APPLE["xcodebuild"], "-version"],
            [APPLE["xcrun"], "simctl", "list", "devices", "--json"],
        ]:
            execute(command, deadline)
        return {"appleToolsReady": "apple_package_authorization_required" not in WARNINGS,
                "workspaceReady": Path(request["workspace"]).is_dir(),
                "pythonReady": True}
    if operation == "simulators":
        return simulator_list(execute([APPLE["xcrun"], "simctl", "list", "devices", "--json"], deadline))

    lease = require_access(verify_lease(state, request), None, "mutate")
    deadline = min(deadline, time.monotonic() + lease["expiresAt"] - time.time())
    workspace = request["workspace"]
    if operation in ("observe", "tap", "frame"):
        return perform_visual(request, root, state, deadline)
    artifact = None
    if operation in ("build", "test"):
        target = args["target"]
        destination = args["destination"]
        destination_arg = ("platform=macOS" if destination["platform"] == "macOS"
                           else "platform=iOS Simulator,id=" + destination["id"])
        argv = [APPLE["xcodebuild"], "-" + target["kind"], workspace_path(workspace, target["path"]),
                "-scheme", args["scheme"], "-destination", destination_arg,
                "-derivedDataPath", str(Path(workspace) / ".applets-build"),
                "-quiet", "-disableAutomaticPackageResolution", operation]
    else:
        argv = [APPLE["xcrun"], "simctl"]
        if operation == "boot":
            argv += ["boot", args["udid"]]
        elif operation == "install":
            argv += ["install", args["udid"], workspace_path(workspace, args["app"])]
        elif operation == "launch":
            argv += ["launch", args["udid"], args["bundleId"]]
        elif operation == "screenshot":
            artifact = private_directory(root / "artifacts") / (secrets.token_hex(16) + ".png")
            argv += ["io", args["udid"], "screenshot", "--type=png", str(artifact)]
        else:
            raise Failure("invalid_request")
    with private_open(root / "inflight") as marker:
        marker.write(str(os.getpid()))
        marker.flush()
        os.fsync(marker.fileno())
    try:
        execute(argv, deadline, cwd=workspace if operation in ("build", "test") else None)
        verify_lease(state, request)
        if artifact:
            with artifact.open("rb") as handle:
                if handle.read(8) != b"\x89PNG\r\n\x1a\n":
                    raise Failure("invalid_remote_output")
            os.chmod(artifact, 0o600)
            return {"completed": operation, "artifact": {"remotePath": str(artifact), "mediaType": "image/png"}}
        return {"completed": operation}
    except BaseException:
        if artifact:
            artifact.unlink(missing_ok=True)
        raise
    finally:
        (root / "inflight").unlink(missing_ok=True)


def main():
    global DIAGNOSTIC_ROOT, DIAGNOSTIC_OPERATION
    os.umask(0o077)
    def interrupted(_signal, _frame):
        raise Failure("command_interrupted")
    for signum in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, interrupted)
    try:
        request = json.loads(sys.stdin.buffer.read(16385))
        if (set(request) != {"operation", "args", "owner", "workspace", "timeout"}
                or request["operation"] not in ("acquire", "release", "preflight", "simulators", "boot", "install", "launch", "screenshot", "build", "test", "observe", "tap", "frame")
                or type(request["timeout"]) is not int or not 1 <= request["timeout"] <= 1800):
            raise Failure("invalid_request")
        root = private_directory(Path.home() / ".applets-control")
        DIAGNOSTIC_ROOT = private_directory(root / "diagnostics")
        DIAGNOSTIC_OPERATION = request["operation"]
        with state_lock(root):
            if (root / "inflight").exists() or (root / "bridge-session.json").exists():
                raise Failure("busy")
            result = perform(request, root, read_state(root))
        response = {"ok": True, "result": result}
        if WARNINGS:
            response["result"]["warnings"] = sorted(WARNINGS)
    except Failure as error:
        response = {"ok": False, "error": str(error)}
        if WARNINGS:
            response["warnings"] = sorted(WARNINGS)
    except (ValueError, KeyError, TypeError):
        response = {"ok": False, "error": "invalid_request"}
    except Exception:
        response = {"ok": False, "error": "internal_error"}
    print(json.dumps(response))


if __name__ == "__main__":
    main()

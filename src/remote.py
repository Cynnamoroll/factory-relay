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


def read_state(root):
    with private_open(root / "state.json") as handle:
        raw = handle.read(16385)
    if not raw:
        return {"generation": 0, "lease": None}
    try:
        state = json.loads(raw)
        assert set(state) == {"generation", "lease"}
        assert type(state["generation"]) is int and 0 <= state["generation"] < 2**53 - 1
        lease = state["lease"]
        if lease is not None:
            assert set(lease) == {"owner", "token", "expiresAt"}
            assert isinstance(lease["owner"], str)
            assert re.fullmatch("[a-f0-9]{64}", lease["token"])
            assert isinstance(lease["expiresAt"], (float, int))
        return state
    except (ValueError, AssertionError, TypeError, KeyError):
        raise Failure("unsafe_state")


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
    lease = state["lease"]
    proof = request["args"]["lease"]
    if (lease is None or proof["generation"] != state["generation"]
            or request["owner"] != lease["owner"]
            or not secrets.compare_digest(proof["token"], lease["token"])):
        raise Failure("stale_lease")
    if lease["expiresAt"] <= time.time():
        raise Failure("lease_expired")
    return lease


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
        current = state["lease"]
        if current and current["expiresAt"] > time.time() and not args["takeover"]:
            raise Failure("lease_held")
        state["generation"] += 1
        state["lease"] = {"owner": request["owner"], "token": secrets.token_hex(32),
                          "expiresAt": time.time() + args["ttlSeconds"]}
        write_state(root, state)
        return dict(state["lease"], generation=state["generation"])
    if operation == "release":
        verify_lease(state, request)
        state["generation"] += 1
        state["lease"] = None
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

    lease = verify_lease(state, request)
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
        with private_open(root / "lock") as lock:
            until = time.monotonic() + 2
            while True:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= until:
                        raise Failure("busy")
                    time.sleep(0.025)
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

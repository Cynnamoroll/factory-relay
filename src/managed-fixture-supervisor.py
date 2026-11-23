import json
import mmap
import os
from pathlib import Path
import plistlib
import re
import select
import signal
import stat
import subprocess
import sys
import time


BUNDLE = "com.factory.applets.RelayMac"
MODE = "--relaymac-managed-nonactivating-v1"
ARTIFACT = ".applets-build/Build/Products/Debug/RelayMac.app/Contents"
STARTUP_SECONDS = 20
RENEWAL_SECONDS = 30
MAX_LIFETIME_MS = 3600000
LINE_LIMIT = 2048


class Refusal(Exception):
    pass


class Lines:
    def __init__(self, fd):
        self.fd = fd
        self.buffer = b""

    def read(self):
        data = os.read(self.fd, LINE_LIMIT + 1)
        if not data:
            if self.buffer:
                raise Refusal("fixture_protocol_error")
            return None
        lines = (self.buffer + data).split(b"\n")
        self.buffer = lines.pop()
        if any(len(line) > LINE_LIMIT for line in [*lines, self.buffer]):
            raise Refusal("fixture_protocol_error")
        try:
            return [json.loads(line) for line in lines]
        except (ValueError, RecursionError):
            raise Refusal("fixture_protocol_error") from None


def artifact(workspace):
    if sys.platform != "darwin":
        raise Refusal("fixture_unsupported_host")
    try:
        root = Path(workspace).resolve(strict=True)
        contents = root / ARTIFACT
        info = contents / "Info.plist"
        executable = contents / "MacOS/RelayMac"
        for path in [info, executable]:
            if path.resolve(strict=True) != path:
                raise ValueError()
            metadata = path.stat()
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid() or metadata.st_mode & 0o022:
                raise ValueError()
        with info.open("rb") as f:
            if info.stat().st_size > 65536:
                raise ValueError()
            settings = plistlib.load(f)
        if settings.get("CFBundleIdentifier") != BUNDLE or settings.get("CFBundleExecutable") != "RelayMac":
            raise ValueError()
        # Do not execute an older build that might ignore the opt-in and activate a normal window.
        if not os.access(executable, os.X_OK) or not 0 < executable.stat().st_size <= 32 * 1024 * 1024:
            raise ValueError()
        with executable.open("rb") as f, mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ) as binary:
            if binary[:4] not in (b"\xcf\xfa\xed\xfe", b"\xca\xfe\xba\xbe", b"\xca\xfe\xba\xbf"):
                raise ValueError()
            if binary.find(MODE.encode("ascii")) < 0:
                raise ValueError()
        return executable
    except (OSError, RuntimeError, ValueError, AttributeError):
        raise Refusal("fixture_build_required") from None


def launch(workspace, marker, lifetime_ms):
    executable = artifact(workspace)
    try:
        return subprocess.Popen(
            [str(executable), MODE, marker, str(os.getpid()), str(lifetime_ms)], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True,
            cwd=str(executable.parent), env={"PATH": "/usr/bin:/bin", "HOME": str(Path.home())},
        )
    except OSError:
        raise Refusal("fixture_launch_failed") from None


def readiness(value, child, marker):
    exact = {"marker", "pid", "parentPid", "windowId", "startSeconds", "startMicroseconds"}
    if (type(value) is not dict or set(value) != exact or value.get("marker") != marker
            or any(type(value[field]) is not int for field in exact - {"marker"})
            or value["pid"] != child.pid or value["parentPid"] != os.getpid()
            or not 1 <= value["windowId"] <= 0xffffffff
            or not 1 <= value["startSeconds"] < 10**10
            or not 0 <= value["startMicroseconds"] < 1000000 or child.poll() is not None):
        raise Refusal("fixture_ownership_unproven")
    return {
        "target": {"pid": child.pid, "windowId": value["windowId"], "bundleId": BUNDLE},
        "processStartedAt": value["startSeconds"] + value["startMicroseconds"] / 1000000,
    }


def cleanup(child, grace=0.75):
    if child is None:
        return True
    # EOF is an in-process watchdog. The only signal fallback is to our unreaped direct child.
    # This module is the sole waiter; an exited child cannot reuse its PID until we reap it.
    try:
        child.stdin.close()
    except OSError:
        pass
    for action in (None, child.terminate, child.kill):
        if child.poll() is not None:
            return True
        try:
            if action is not None:
                action()
            child.wait(timeout=grace)
            return True
        except ProcessLookupError:
            continue
        except (OSError, subprocess.TimeoutExpired):
            continue
    return child.poll() is not None


def supervisor(control, emit, stopped, start=launch, clock=time.monotonic,
               startup=STARTUP_SECONDS, renewal=RENEWAL_SECONDS, reap=cleanup):
    child = None
    reason = "closed"
    deadline = clock() + startup
    try:
        request = None
        while not stopped() and clock() < deadline:
            if select.select([control.fd], [], [], min(0.2, max(0, deadline - clock())))[0]:
                rows = control.read()
                if rows is None:
                    return
                if rows:
                    if len(rows) != 1 or control.buffer:
                        raise Refusal("fixture_protocol_error")
                    request = rows[0]
                    break
        if stopped():
            return
        if request is None:
            raise Refusal("fixture_start_timeout")
        if (type(request) is not dict or set(request) != {"type", "marker", "lifetimeMs", "workspace"}
                or request["type"] != "start" or type(request["lifetimeMs"]) is not int
                or not 1 <= request["lifetimeMs"] <= MAX_LIFETIME_MS
                or type(request["marker"]) is not str or not re.fullmatch("[a-f0-9]{64}", request["marker"])
                or type(request["workspace"]) is not str or not request["workspace"].startswith("/")
                or len(request["workspace"]) > 256 or not request["workspace"].isprintable()):
            raise Refusal("fixture_protocol_error")
        marker = request["marker"]
        child = start(request["workspace"], marker, request["lifetimeMs"])
        output = Lines(child.stdout.fileno())
        ready = False
        hard_deadline = deadline
        idle_deadline = deadline
        while not stopped():
            now = clock()
            if now >= min(hard_deadline, idle_deadline):
                reason = ("fixture_start_timeout" if not ready else
                          "fixture_expired" if now >= hard_deadline else "fixture_client_lost")
                break
            pending = select.select([control.fd, output.fd], [], [], min(0.2, hard_deadline-now, idle_deadline-now))[0]
            if control.fd in pending:
                rows = control.read()
                if rows is None or stopped():
                    break
                for row in rows:
                    if row != {"type": "renew"}:
                        raise Refusal("fixture_protocol_error")
                    if ready:
                        idle_deadline = clock() + renewal
            if output.fd in pending and not stopped():
                rows = output.read()
                if rows is None:
                    reason = "fixture_exited" if ready else "fixture_launch_failed"
                    break
                if not rows:
                    continue
                if ready or len(rows) != 1 or output.buffer:
                    raise Refusal("fixture_protocol_error")
                target = readiness(rows[0], child, marker)
                now = clock()
                hard_deadline = now + request["lifetimeMs"] / 1000
                idle_deadline = now + renewal
                emit({"type": "ready", "marker": marker, **target})
                ready = True
    except Refusal as e:
        reason = str(e)
    except (BrokenPipeError, ConnectionResetError):
        reason = "closed"
    except (OSError, ValueError):
        reason = "fixture_supervisor_failed"
    finally:
        cleaned = reap(child)
        if child is not None:
            child.stdout.close()
        emit({"type": "done", "reason": reason if cleaned else "fixture_cleanup_failed", "cleaned": cleaned})


def main():
    stopped = False

    def stop(*_):
        nonlocal stopped
        stopped = True

    for sig in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, stop)
    # Explicit SIG_IGN would auto-reap children and invalidate the PID-reuse guarantee.
    signal.signal(signal.SIGCHLD, signal.SIG_DFL)
    try:
        supervisor(Lines(0), lambda message: print(json.dumps(message), flush=True), lambda: stopped)
    except (BrokenPipeError, ConnectionResetError):
        pass


if __name__ == "__main__":
    main()

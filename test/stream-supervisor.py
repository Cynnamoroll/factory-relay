import json
from contextlib import ExitStack
import os
from pathlib import Path
import select
import socket
import struct
import subprocess
import sys
import tempfile
import time

remote = Path("src/remote.py").read_text().replace('if __name__ == "__main__":\n    main()', '')
supervisor = Path("src/stream-supervisor.py").read_text()
fake_open = str(Path("test/fixtures/fake-open.py").resolve())
ns = {"__name__": "test"}
exec(remote + "\n" + supervisor, ns)
source = (remote + "\n" + supervisor).replace('"/usr/bin/open"', repr(fake_open))
TARGET = {"windowId": 5, "pid": 12, "bundleId": "com.factory.applets.RelayMac"}

receiver, sender = socket.socketpair()
with receiver, sender:
    reader = ns["LineReader"](receiver.fileno())
    sender.sendall(b"first\nsecond\n12345678\n")
    for expected in (b"first", b"second", b"12345678"):
        assert reader.read(8, time.monotonic() + 1) == expected
    sender.sendall(b"123456789\n")
    try:
        reader.read(8, time.monotonic() + 1)
    except ns["Failure"] as e:
        assert str(e) == "invalid_stream"
    else:
        raise AssertionError("oversized control line accepted")

with tempfile.TemporaryDirectory(dir="/tmp", prefix="frss-") as temp, ExitStack() as cleanup:
    home = Path(temp)
    root = ns["private_directory"](home / ".applets-control")
    peer, other = socket.socketpair()
    with peer, other:
        assert ns["peer_uid"](peer) == os.getuid(), "IPC identity must come from the kernel"
    env = dict(os.environ, HOME=temp, FAKE_HOST_LOG=str(home / "host.log"), FAKE_HOST_FRAMES="12")

    def kill_hosts():
        log = home / "host.log"
        if not log.exists():
            return
        executable = str(Path("test/fixtures/fake-host.py").resolve()).encode()
        endpoint = str(root / "host/relay.sock").encode()
        for row in [json.loads(line) for line in log.read_text().splitlines()]:
            if row["event"] == "launch":
                try:
                    if sys.platform == "linux":
                        args = Path(f"/proc/{row['pid']}/cmdline").read_bytes().split(b"\0")
                        owned = executable in args and endpoint in args
                    else:
                        command = subprocess.check_output(["/bin/ps", "-p", str(row["pid"]), "-o", "command="])
                        owned = executable in command and endpoint in command
                    if owned:
                        os.kill(row["pid"], 9)
                except FileNotFoundError:
                    pass
                except ProcessLookupError:
                    pass
                except subprocess.CalledProcessError:
                    pass
        time.sleep(0.2)

    cleanup.callback(kill_hosts)

    def write(leases):
        ns["write_state"](root, {"version": 2, "generation": 9, "leases": leases})

    window = {"owner": "agent:a", "token": "a" * 64, "generation": 7, "expiresAt": time.time() + 120,
              "scope": {"kind": "window", "target": TARGET}}
    write([window])

    def start(window_size=3, target=TARGET, mode="stream", token="a", generation=7, owner="agent:a", env=env):
        proc = subprocess.Popen([sys.executable, "-c", source], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, env=env)
        request = {"owner": owner, "workspace": temp, "args": {"lease": {"token": token * 64, "generation": generation}},
                   "mode": mode, "target": target, "timeout": 30, "window": window_size}
        proc.stdin.write(json.dumps(request).encode() + b"\n")
        proc.stdin.flush()
        return proc

    def packet(proc, timeout=5):
        def read(size):
            data = b""
            end = time.monotonic() + timeout
            while len(data) < size:
                ready, _, _ = select.select([proc.stdout], [], [], max(0, end - time.monotonic()))
                if not ready:
                    return None
                chunk = os.read(proc.stdout.fileno(), size - len(data))
                if not chunk:
                    return None
                data += chunk
            return data
        prefix = read(4)
        if prefix is None:
            return None
        header = json.loads(read(struct.unpack(">I", prefix)[0]))
        image = read(header["bytes"]) if header["bytes"] else b""
        return header, image

    def error(proc):
        proc.wait(timeout=10)
        return proc.stderr.read().decode()

    # Pipelining: exactly window packets in flight, then one more per credit.
    proc = start()
    frames = [packet(proc) for _ in range(3)]
    assert all(f and f[0]["type"] == "frame" for f in frames), frames
    assert packet(proc, timeout=0.5) is None, "relay must not exceed the credit window"
    proc.stdin.write(b"\x06")
    proc.stdin.flush()
    assert packet(proc)[0]["sequence"] == 4, "one credit releases exactly one more frame"
    received = 4
    while received < 12:
        proc.stdin.write(b"\x06")
        proc.stdin.flush()
        if packet(proc) is None:
            break
        received += 1
    assert received == 12, received
    proc.stdin.write(b"\x06" * 3)
    proc.stdin.flush()
    assert "APPLETS_STREAM_ERROR:stream_closed" in error(proc)
    rows = [json.loads(line) for line in (home / "host.log").read_text().splitlines()]
    end = [r for r in rows if r["event"] == "stream-end"][-1]
    assert end["peak"] == 3 and end["window"] == 3 and end["sent"] == 12, end
    assert sum(r["event"] == "launch" for r in rows) == 1

    # A client cannot grant credits for packets it never received.
    proc = start(window_size=2)
    assert packet(proc) and packet(proc)
    proc.stdin.write(b"\x06\x06\x06")
    proc.stdin.flush()
    assert "APPLETS_STREAM_ERROR:invalid_stream" in error(proc)

    # Revocation applies to the next packet of a running stream.
    proc = start(window_size=1)
    assert packet(proc)[0]["sequence"] == 1
    write([])
    proc.stdin.write(b"\x06")
    proc.stdin.flush()
    assert "APPLETS_STREAM_ERROR:stale_lease" in error(proc)
    write([window])

    # Desktop pixels need an exclusive lease; global recovery fences every stream.
    desktop = {"kind": "desktop", "displayId": 1, "displayUUID": "abcdef12-1234-4234-8234-123456789012"}
    assert "APPLETS_STREAM_ERROR:lease_scope" in error(start(target=desktop))

    # Recording is read-only context for a sole window holder, not desktop input authority.
    assert not ns["lease_allows"](window, desktop, "read")
    assert not ns["lease_allows"](window, desktop, "mutate")
    proc = start(window_size=1, mode="recording", target=desktop)
    first = packet(proc)
    assert first and first[0]["kind"] == "desktop", "one window agent must be able to record its display"
    second = dict(window, owner="agent:b", token="b" * 64, generation=8,
                  scope={"kind": "window", "target": dict(TARGET, windowId=6, pid=13)})
    write([window, second])
    proc.stdin.write(b"\x06")
    proc.stdin.flush()
    assert "APPLETS_STREAM_ERROR:lease_scope" in error(proc), "second agent must fence the very next display packet"
    assert "APPLETS_STREAM_ERROR:lease_scope" in error(start(mode="recording", target=desktop))
    write([window])
    proc = start(window_size=1, mode="recording", target=desktop)
    assert packet(proc), "display recording must resume after the second holder leaves"
    ns["write_state"](root, {"version": 2, "generation": 10, "leases": [window]})
    proc.stdin.write(b"\x06")
    proc.stdin.flush()
    assert "APPLETS_STREAM_ERROR:lease_scope" in error(proc), "an authority epoch change must reject buffered display frames"
    write([window])
    assert "APPLETS_STREAM_ERROR:invalid_request" in error(start(mode="recording"))

    (root / "inflight").write_text("recovery")
    os.chmod(root / "inflight", 0o600)
    assert "APPLETS_STREAM_ERROR:busy" in error(start())
    (root / "inflight").unlink()
    assert "APPLETS_STREAM_ERROR:invalid_request" in error(start(window_size=9))

    # Discovery uses the persistent control connection and any current lease.
    write([window, {"owner": "viewer", "token": "e" * 64, "generation": 9, "expiresAt": time.time() + 60,
                    "scope": {"kind": "observer"}}])
    proc = start(mode="windows", target=None, token="e", generation=9, owner="viewer")
    header, _ = packet(proc)
    assert header["type"] == "windows" and header["windows"][0]["pid"] == 12 and header["bytes"] == 0
    assert proc.wait(timeout=10) == 0

    # H.264 access units share the credit window and pass through untouched.
    kill_hosts()
    proc = start(env=dict(env, FAKE_HOST_VIDEO="1", FAKE_HOST_FRAMES="6"))
    kinds = [packet(proc)[0]["type"] for _ in range(3)]
    assert kinds == ["frame", "vframe", "frame"], kinds
    assert packet(proc, timeout=0.5) is None, "video packets consume the same credit window"
    proc.stdin.write(b"\x06" * 3)
    proc.stdin.flush()
    rest = []
    while len(rest) < 3:
        got = packet(proc, timeout=2)
        assert got is not None
        rest.append(got)
    vframes = [got for got in rest if got[0]["type"] == "vframe"]
    assert len(vframes) == 2, rest
    for header, image in vframes:
        assert header["codec"] == "h264" and header["format"] == "annexb" and header["keyframe"] is True
        assert image.startswith(b"\x00\x00\x00\x01"), "access units stay Annex B end to end"
    assert packet(proc, timeout=2) is None
    assert "APPLETS_STREAM_ERROR:stream_closed" in error(proc)

    # An unknown packet kind is rejected before a single byte is relayed.
    kill_hosts()
    proc = start(env=dict(env, FAKE_HOST_VIDEO="badkind", FAKE_HOST_FRAMES="6"))
    assert "APPLETS_STREAM_ERROR:invalid_stream" in error(proc)
    kill_hosts()
print("pipelined credits, revocation, scope, busy fencing, discovery and video relay passed")

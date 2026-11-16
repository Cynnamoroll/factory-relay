import json
import os
from pathlib import Path
import select
import socket
import subprocess
import sys
import tempfile
import time
from unittest.mock import patch

remote = Path("src/remote.py").read_text().replace('if __name__ == "__main__":\n    main()', '')
supervisor = Path("src/stream-supervisor.py").read_text()
ns = {"__name__": "test"}
exec(remote + "\n" + supervisor, ns)

with tempfile.TemporaryDirectory() as temp:
    home = Path(temp)
    root = ns["private_directory"](home / ".applets-control")
    state = {"generation": 4, "lease": {"owner": "test", "token": "a" * 64, "expiresAt": time.time() + 30}}
    ns["write_state"](root, state)
    peer, other = socket.socketpair()
    with peer, other:
        assert ns["peer_uid"](peer) == os.getuid(), "IPC identity must come from the kernel"
    request = {"owner": "test", "workspace": str(home), "args": {"lease": {"token": "a" * 64, "generation": 4}},
               "mode": "stream", "target": {"windowId": 5, "pid": 12, "bundleId": "com.factory.applets.RelayMac"}, "timeout": 15}
    ns["authorize_stream"](root, request)
    def rejected(code):
        try:
            ns["authorize_stream"](root, request)
            raise AssertionError("admitted invalid stream")
        except ns["Failure"] as error:
            assert str(error) == code, str(error)
    for marker in ("inflight", "bridge-session.json"):
        (root / marker).write_text("recovery")
        rejected("busy")
        (root / marker).unlink()
    with ns["private_open"](root / "lock") as lock:
        ns["fcntl"].flock(lock, ns["fcntl"].LOCK_EX | ns["fcntl"].LOCK_NB)
        rejected("busy")
    state["generation"] = 5
    ns["write_state"](root, state)
    rejected("stale_lease")
    state["generation"] = 4
    state["lease"]["expiresAt"] = time.time() - 1
    ns["write_state"](root, state)
    rejected("lease_expired")
    state["lease"]["expiresAt"] = time.time() + 30
    ns["write_state"](root, state)
    exe = home / ".applets-host/Factory Relay.app/Contents/MacOS/AppletsHost"
    exe.parent.mkdir(parents=True)
    exe.write_text("#!" + sys.executable + """
import json,os,pathlib,socket,stat,struct,sys
pathlib.Path(os.environ["HOME"],"helper.pid").write_text(str(os.getpid()))
endpoint=pathlib.Path(sys.argv[-1])
assert stat.S_IMODE(endpoint.stat().st_mode)==0o600
assert stat.S_IMODE(endpoint.parent.stat().st_mode)==0o700
assert endpoint.stat().st_uid==os.getuid()
connection=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
connection.connect(str(endpoint))
if os.environ.get("FAKE_HOST_PACKET")=="hello":
    connection.sendall(b"[]\\n")
    connection.recv(1)
    sys.exit(0)
connection.sendall(json.dumps({"protocol":1,"type":"hello","pid":os.getpid()}).encode()+b"\\n")
request=b""
while not request.endswith(b"\\n"):
    value=connection.recv(1)
    if not value: sys.exit(0)
    request+=value
arguments=json.loads(request)
assert arguments[:3]==["stream","5","12"]
assert arguments[3] in ("com.factory.applets.RelayMac","com.apple.dt.Devices")
bad=os.environ.get("FAKE_HOST_PACKET")
if bad:
    payload={"oversized":struct.pack(">I",8193),"array":struct.pack(">I",2)+b"[]"}[bad]
    connection.sendall(payload)
    connection.recv(1)
    sys.exit(0)
header=json.dumps({"type":"frame","bytes":4}).encode()
while True:
    connection.sendall(struct.pack(">I",len(header))+header+b"jpeg")
    if connection.recv(1)!=b"\\x06": break
""")
    exe.chmod(0o700)
    launcher = home / "fake-open"
    launcher.write_text("#!" + sys.executable + '\nimport os,sys\nassert sys.argv[4].endswith(".applets-host/Factory Relay.app")\nos.execv(' + repr(str(exe)) +
                        ",[" + repr(str(exe)) + ', "connect", sys.argv[-1]])\n')
    launcher.chmod(0o700)
    test_supervisor = supervisor.replace('["/usr/bin/open",', "[" + repr(str(launcher)) + ",")
    def start(read_frame=True, fake_packet=""):
        proc = subprocess.Popen([sys.executable, "-c", remote + "\n" + test_supervisor],
                                env={**os.environ, "HOME": temp, "FAKE_HOST_PACKET": fake_packet}, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE)
        proc.stdin.write(json.dumps(request).encode() + b"\n")
        proc.stdin.flush()
        if read_frame:
            deadline = time.monotonic() + 5
            prefix = ns["stream_read"](proc.stdout.fileno(), 4, deadline)
            length = ns["struct"].unpack(">I", prefix)[0]
            ns["stream_read"](proc.stdout.fileno(), length + 4, deadline)
        return proc
    proc = start()
    assert not select.select([proc.stdout], [], [], 0.05)[0], "no second packet before acknowledgment"
    # Taking the lock after a frame proves that stream lifetime does not own it.
    with ns["private_open"](root / "lock") as lock:
        ns["fcntl"].flock(lock, ns["fcntl"].LOCK_EX | ns["fcntl"].LOCK_NB)
        state["generation"] = 5
        ns["write_state"](root, state)
    proc.stdin.write(b"\x06")
    proc.stdin.flush()
    assert proc.wait(timeout=3) == 1
    assert proc.stdout.read() == b"", "no frame after takeover"
    assert proc.stderr.read() == b"APPLETS_STREAM_ERROR:stale_lease\n", "fencing failure must be actionable without raw output"
    pid = int((home / "helper.pid").read_text())
    try:
        os.kill(pid, 0)
        raise AssertionError("orphaned helper after takeover")
    except ProcessLookupError:
        pass
    assert not list(root.glob("s-*")), "takeover must remove only its private rendezvous"
    state["generation"] = 4
    ns["write_state"](root, state)
    request["timeout"] = 1
    proc = start()
    assert proc.wait(timeout=3) == 1, "a missing acknowledgment must not leave a live stream"
    assert proc.stderr.read() == b"APPLETS_STREAM_ERROR:stream_timeout\n"
    pid = int((home / "helper.pid").read_text())
    try:
        os.kill(pid, 0)
        raise AssertionError("orphaned helper after acknowledgment timeout")
    except ProcessLookupError:
        pass
    proc = start()
    (root / "inflight").write_text("mutation")
    proc.stdin.write(b"\x06")
    proc.stdin.flush()
    assert proc.wait(timeout=3) == 1
    assert proc.stderr.read() == b"APPLETS_STREAM_ERROR:busy\n"
    assert (root / "inflight").read_text() == "mutation", "stream must not clear mutation recovery state"
    (root / "inflight").unlink()
    for bad in ("hello", "oversized", "array"):
        proc = start(read_frame=False, fake_packet=bad)
        assert proc.wait(timeout=3) == 1
        assert proc.stdout.read() == b"", "invalid IPC must never reach consumers"
        assert proc.stderr.read() == b"APPLETS_STREAM_ERROR:invalid_stream\n"
        assert not list(root.glob("s-*")), "invalid peers must not leave rendezvous files"
    foreign = {"__name__": "test"}
    exec(remote + "\n" + test_supervisor, foreign)
    foreign["peer_uid"] = lambda connection: os.getuid() + 1
    with patch.dict(os.environ, {"HOME": temp}):
        try:
            with foreign["launch_host"](root, request, ["stream"], time.monotonic() + 2):
                raise AssertionError("foreign UID admitted")
        except foreign["Failure"] as error:
            assert str(error) == "unsafe_peer"
    state["generation"] = 4
    ns["write_state"](root, state)
    proc = start()
    proc.stdin.close()
    assert proc.wait(timeout=3) == 1
    pid = int((home / "helper.pid").read_text())
    try:
        os.kill(pid, 0)
        raise AssertionError("orphaned helper after disconnect")
    except ProcessLookupError:
        pass
    assert not (root / "inflight").exists(), "read-only capture must not replace mutation recovery state"
    assert not list(root.glob("s-*")), "reconnect, timeout and disconnect must clean their rendezvous"
    request["target"]["bundleId"]="com.apple.dt.Devices"
    proc=start()
    proc.stdin.close()
    assert proc.wait(timeout=3)==1
    assert proc.stderr.read()==b"APPLETS_STREAM_ERROR:stream_closed\n"
    assert not list(root.glob("s-*")), "DeviceHub uses the same per-window IPC cleanup"
    for target in ({"bundleId":"com.apple.dt.Devices"},
                   {"windowId":5,"pid":12,"bundleId":"com.apple.dt.Devices","allWindows":True}):
        request["target"]=target
        proc=start(read_frame=False)
        assert proc.wait(timeout=3)==1
        assert proc.stdout.read()==b""
        assert proc.stderr.read()==b"APPLETS_STREAM_ERROR:invalid_request\n"
print("shared fencing and cleanup passed")

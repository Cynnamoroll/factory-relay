import copy
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
from unittest.mock import patch

remote = Path("src/remote.py").read_text().replace('if __name__ == "__main__":\n    main()', '')
stream = Path("src/stream-supervisor.py").read_text().replace('if __name__ == "__main__":\n    stream_main()', '')
control = Path("src/control-supervisor.py").read_text()
ns = {"__name__": "test"}
exec(remote + "\n" + stream + "\n" + control, ns)

with tempfile.TemporaryDirectory() as temp:
    home = Path(temp)
    root = ns["private_directory"](home / ".applets-control")
    state = {"generation": 1, "lease": {"owner": "agent:test", "token": "a" * 64, "expiresAt": time.time() + 120}}
    ns["write_state"](root, state)
    target = {"windowId": 5, "pid": 12, "bundleId": "com.factory.applets.RelayMac"}
    request = {"owner": "agent:test", "workspace": temp, "operation": "observe", "target": target,
               "args": {"lease": {"token": "a" * 64, "generation": 1}}}
    snapshot = {"target": target, "windowRectPoints": [0, 0, 900, 450], "processStartedAt": 123.5,
                "elements": [{"id": "relay-count", "role": "AXStaticText", "value": "Count: 0", "enabled": True},
                             {"id": "relay-increment", "role": "AXButton", "value": "Increment", "enabled": True}]}
    def action(req, result=None, delay=0):
        errors = []
        received = []
        a, b = socket.socketpair()
        def helper():
            with b:
                body = b""
                while not body.endswith(b"\n"):
                    value = b.recv(1)
                    if not value:
                        return
                    body += value
                received.append(json.loads(body))
                try:
                    with ns["private_open"](root / "lock") as lock:
                        ns["fcntl"].flock(lock, ns["fcntl"].LOCK_EX | ns["fcntl"].LOCK_NB)
                    errors.append("mutation did not own the shared lease lock")
                except BlockingIOError:
                    pass
                assert (root / "inflight").exists()
                time.sleep(delay)
                if result is not None:
                    b.sendall(json.dumps(result).encode() + b"\n")
        worker = threading.Thread(target=helper)
        worker.start()
        try:
            with a:
                ns["validate_control"](req)
                return ns["control_action"](a.fileno(), root, req)
        finally:
            worker.join(timeout=4)
            assert not worker.is_alive()
            assert not errors, errors

    def failure(code, req, result=None):
        try:
            action(req, result)
            raise AssertionError("invalid action was admitted")
        except ns["Failure"] as error:
            assert str(error) == code, str(error)

    diagnostic = {**request, "operation": "diagnose", "target": None}
    failure("invalid_control_response", diagnostic,
            {"ok": True, "result": {"type": "diagnostic", "bundleId": "com.factory.applets.control"}})
    assert action(diagnostic, {"ok": True, "result": {"type": "diagnostic",
                  "bundleId": "com.factory.applets.host"}})["bundleId"] == "com.factory.applets.host"

    observed = action(request, {"ok": True, "result": {"type": "observation", "snapshot": snapshot}})
    assert observed["snapshot"]["elements"][0]["value"] == "Count: 0"
    press = copy.deepcopy(request)
    press["operation"] = "press"
    press["args"].update(observationId=observed["observationId"], elementId="relay-increment")
    assert action(press, {"ok": True, "result": {"type": "pressed", "elementId": "relay-increment"}})["type"] == "pressed"
    assert not (root / "inflight").exists()
    failure("observation_stale", press)
    for bad in [
        {**request, "target": {**target, "bundleId": "com.apple.finder"}},
        {**request, "target": {**target, "allWindows": True}},
        {**request, "operation": "shell"},
        {**press, "args": {**press["args"], "elementId": "other"}},
    ]:
        failure("invalid_request", bad)

    observed = action(request, {"ok": True, "result": {"type": "observation", "snapshot": snapshot}})
    press["args"]["observationId"] = observed["observationId"]
    state["generation"] = 2
    ns["write_state"](root, state)
    failure("stale_lease", press)
    state["generation"] = 1
    ns["write_state"](root, state)
    changed = copy.deepcopy(press)
    changed["target"]["windowId"] = 6
    failure("invalid_control_response", changed)
    with ns["private_open"](root / "control-observation.json") as handle:
        record = json.load(handle)
        record["createdAt"] -= 31
        handle.seek(0)
        json.dump(record, handle)
        handle.truncate()
    failure("observation_stale", press)
    failure("accessibility_required", request, {"ok": False, "error": "accessibility_required"})
    assert not (root / "inflight").exists()

    for response in [None, {"ok": False, "error": "action_uncertain"}, {"ok": True, "result": {"type": "wrong"}}]:
        observed = action(request, {"ok": True, "result": {"type": "observation", "snapshot": snapshot}})
        press["args"]["observationId"] = observed["observationId"]
        try:
            action(press, response)
            raise AssertionError("an ambiguous press must not be reported successful")
        except ns["Failure"]:
            pass
        assert (root / "inflight").exists(), "uncertain input retains fail-closed recovery"
        failure("busy", request)
        assert not (root / "control-observation.json").exists(), "uncertain input must never reuse the observation"
        (root / "inflight").unlink()

    for takeover in [False, True]:
        held = threading.Event()
        def hold():
            with ns["private_open"](root / "lock") as lock:
                ns["fcntl"].flock(lock, ns["fcntl"].LOCK_EX)
                held.set()
                time.sleep(0.15)
                if takeover:
                    state["generation"] = 2
                    ns["write_state"](root, state)
        worker = threading.Thread(target=hold)
        worker.start()
        assert held.wait(timeout=2)
        try:
            ns["authorize_stream"](root, request)
            assert not takeover, "stream must reread authority after waiting"
        except ns["Failure"] as error:
            assert takeover and str(error) == "stale_lease"
        worker.join()
    state["generation"] = 1
    ns["write_state"](root, state)

    launcher = home / "fake-open"
    launcher.write_text("#!" + sys.executable + """
import json,os,pathlib,socket,sys
assert sys.argv[4].endswith(".applets-host/Factory Relay.app")
assert sys.argv[-2]=="control"
endpoint=pathlib.Path(sys.argv[-1])
assert endpoint.parent.name.startswith("c-")
assert endpoint.stat().st_mode&0o777==0o600
sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
sock.connect(str(endpoint))
sock.sendall(json.dumps({"protocol":1,"type":"hello","pid":os.getpid()}).encode()+b"\\n")
body=b""
while not body.endswith(b"\\n"):
    value=sock.recv(1)
    if not value: sys.exit(0)
    body+=value
request=json.loads(body)
assert "lease" not in request and "owner" not in request
sock.sendall(json.dumps({"ok":False,"error":"accessibility_required"}).encode()+b"\\n")
sock.close()
""")
    launcher.chmod(0o700)
    combined = remote + "\n" + stream.replace('["/usr/bin/open",', "[" + repr(str(launcher)) + ",") + "\n" + control
    proc = subprocess.run([sys.executable, "-c", combined], input=json.dumps(request), text=True,
                          capture_output=True, timeout=10, env={**os.environ, "HOME": temp})
    assert proc.returncode == 0, proc.stderr
    assert json.loads(proc.stdout) == {"ok": False, "error": "accessibility_required"}, proc.stdout
    assert not list(root.glob("c-*")), "control launch cleans its private socket directory"
    assert not (root / "inflight").exists()
print("native control fencing, stale/replayed observations, uncertain input, IPC and short-lock coexistence passed")

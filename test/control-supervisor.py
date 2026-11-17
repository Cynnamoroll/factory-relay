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
                if req["operation"] == "mouse":
                    assert not (root / "control-observation.json").exists(), "Mouse authority is consumed before native dispatch"
                    assert received[-1]["expected"]["target"] == req["target"]
                    assert received[-1]["mouse"] == req["args"]["mouse"]
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
        {**request, "target": {**target, "bundleId": "com.factory.applets.host"}},
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

    bare = {**target, "bundleId": ""}
    pixels = {**snapshot, "target": bare, "elements": []}
    observe_pixels = {**request, "target": bare, "args": {**request["args"], "mode": "pixels"}}
    def mouse_request(command):
        observed = action(observe_pixels, {"ok": True, "result": {"type": "observation", "snapshot": pixels}})
        return {**request, "operation": "mouse", "target": bare,
                "args": {**request["args"], "observationId": observed["observationId"], "mouse": command}}
    commands = [
        {"kind": "move", "x": 0, "y": 0.999},
        {"kind": "click", "x": 0.2, "y": 0.3, "button": "left", "count": 1},
        {"kind": "click", "x": 0.2, "y": 0.3, "button": "right", "count": 2},
        {"kind": "drag", "x": 0.2, "y": 0.3, "toX": 0.8, "toY": 0.3, "durationMs": 500},
        {"kind": "scroll", "x": 0.2, "y": 0.3, "deltaX": -600, "deltaY": 600},
    ]
    for command in commands:
        mouse = mouse_request(command)
        assert action(mouse, {"ok": True, "result": {"type": "mouse-acknowledged"}})["type"] == "mouse-acknowledged"
        failure("observation_stale", mouse)
        assert not (root / "inflight").exists()
    for command in [
        {**commands[0], "x": float("nan")}, {**commands[0], "x": True},
        {**commands[0], "y": 1}, {**commands[0], "x": -0.01},
        {**commands[1], "button": "middle"}, {**commands[1], "count": 3},
        {**commands[3], "durationMs": 1001}, {**commands[3], "toX": 1},
        {**commands[4], "deltaX": 601}, {**commands[4], "shell": "invalid"},
    ]:
        bad = {**mouse, "args": {**mouse["args"], "mouse": command}}
        failure("invalid_request", bad)
    for field, value in [("owner", "agent:other"), ("workspace", "/other")]:
        mouse = mouse_request(commands[0])
        with ns["private_open"](root / "control-observation.json") as handle:
            record = json.load(handle)
            record[field] = value
            handle.seek(0); json.dump(record, handle); handle.truncate()
        failure("observation_stale", mouse)
    for code in ["target_mismatch", "observation_stale"]:
        mouse = mouse_request(commands[3])
        failure(code, mouse, {"ok": False, "error": code})
        assert not (root / "inflight").exists()
        assert not (root / "control-observation.json").exists()
    for response in [None, {"ok": False, "error": "action_uncertain"},
                     {"ok": False, "error": "control_timeout"},
                     {"ok": True, "result": {"type": "wrong"}}]:
        mouse = mouse_request(commands[3])
        try:
            action(mouse, response)
            raise AssertionError("uncertain mouse cannot be acknowledged")
        except ns["Failure"]:
            pass
        assert (root / "inflight").exists(), "Mouse and drag uncertainty retain recovery fencing"
        failure("busy", observe_pixels)
        assert not (root / "control-observation.json").exists()
        (root / "inflight").unlink()

    desktop = {"kind": "desktop", "displayId": 22, "displayUUID": "abcdef12-1234-4234-8234-123456789012"}
    display_config = {"boundsPoints": [-640, -100, 640, 400], "pixelWidth": 1280, "pixelHeight": 800,
                      "rotation": 0, "scaleX": 2, "scaleY": 2}
    bare = desktop
    pixels = {"target": desktop, "displayConfiguration": display_config, "elements": []}
    observe_pixels = {**request, "target": desktop, "args": {**request["args"], "mode": "pixels"}}
    for command in commands:
        mouse = mouse_request(command)
        assert action(mouse, {"ok": True, "result": {"type": "mouse-acknowledged"}})["type"] == "mouse-acknowledged"
        failure("observation_stale", mouse)
    for invalid in [
        {**desktop, "pid": 0}, {**desktop, "windowId": 1}, {**desktop, "bundleId": ""},
        {**desktop, "displayId": True}, {**desktop, "displayId": 0}, {**desktop, "displayId": 2**32},
        {**desktop, "displayUUID": desktop["displayUUID"].upper()},
        {**desktop, "displayUUID": desktop["displayUUID"] + "\n"},
        {**desktop, "displayUUID": "invalid"},
    ]:
        assert not ns["valid_target"](invalid)
        failure("invalid_request", {**observe_pixels, "target": invalid})
    failure("invalid_request", {**observe_pixels, "args": {**request["args"], "mode": "count"}})
    failure("invalid_request", {**mouse, "operation": "press",
            "args": {**request["args"], "observationId": "b" * 32, "elementId": "relay-increment"}})
    for invalid in [
        {**pixels, "processStartedAt": 0}, {**pixels, "windowRectPoints": [0, 0, 640, 400]},
        {**pixels, "displayConfiguration": {**display_config, "pixelWidth": True}},
        {**pixels, "displayConfiguration": {**display_config, "rotation": 360}},
        {**pixels, "displayConfiguration": {**display_config, "boundsPoints": [0, 0, 0, 400]}},
    ]:
        failure("invalid_control_response", observe_pixels,
                {"ok": True, "result": {"type": "observation", "snapshot": invalid}})
    for response in [None, {"ok": False, "error": "action_uncertain"}, {"ok": False, "error": "control_timeout"}]:
        mouse = mouse_request(commands[3])
        try:
            action(mouse, response)
            raise AssertionError("uncertain desktop mouse cannot be acknowledged")
        except ns["Failure"]:
            pass
        assert (root / "inflight").exists(), "Desktop uncertainty preserves the same recovery fence"
        assert not (root / "control-observation.json").exists(), "Desktop observations remain single-use"
        failure("busy", observe_pixels)
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
print("native control fencing, generic mouse validation, stale/replayed observations, uncertain input, IPC and short-lock coexistence passed")

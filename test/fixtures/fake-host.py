#!/usr/bin/env python3
"""Test-only persistent host speaking the relay protocol 3 over the private socket."""
import json
import os
import socket
import struct
import sys
import threading
import time

endpoint = sys.argv[1]
log_path = os.environ["FAKE_HOST_LOG"]
mutation_delay = float(os.environ.get("FAKE_HOST_DELAY", "0.15"))
frames_total = int(os.environ.get("FAKE_HOST_FRAMES", "24"))
lock = threading.Lock()
counts = {}


def record(**fields):
    with lock, open(log_path, "a") as log:
        log.write(json.dumps(fields) + "\n")


def readline(connection):
    data = b""
    while not data.endswith(b"\n"):
        value = connection.recv(1)
        if not value:
            return None
        data += value
    return data


def snapshot(target, mode):
    if target.get("kind") == "desktop":
        return {"target": target, "displayConfiguration": {"boundsPoints": [0, 0, 1440, 900], "pixelWidth": 2880,
                "pixelHeight": 1800, "rotation": 0, "scaleX": 2, "scaleY": 2}, "elements": []}
    elements = []
    if target["bundleId"] == "com.factory.applets.RelayMac" and mode != "pixels":
        elements = [{"id": "relay-count", "role": "AXStaticText", "value": "Count: %d" % counts.get(target["pid"], 0), "enabled": True},
                    {"id": "relay-increment", "role": "AXButton", "value": "Increment", "enabled": True}]
    return {"target": target, "windowRectPoints": [10, 20, 900, 450], "processStartedAt": 123.5, "elements": elements}


def control(connection):
    while True:
        line = readline(connection)
        if line is None:
            return
        message = json.loads(line)
        operation, target = message["operation"], message.get("target")
        pid = target.get("pid") if target else None
        start = time.monotonic()
        reply = {"id": message["id"], "ok": True}
        if operation == "observe":
            reply["result"] = {"type": "observation", "snapshot": snapshot(target, message.get("mode"))}
        elif operation in ("press", "mouse"):
            assert message["expected"]["target"] == target
            record(event="dispatch", operation=operation, pid=pid, start=start)
            if pid == 98:
                connection.close()
                return
            time.sleep(8 if pid == 99 else mutation_delay)
            if operation == "press":
                counts[pid] = counts.get(pid, 0) + 1
                reply["result"] = {"type": "pressed", "elementId": "relay-increment"}
            elif target.get("kind") == "desktop":
                reply["result"] = {"type": "mouse-acknowledged", "route": "foreground-hid", "focusPreserved": False, "cursorPreserved": False}
            elif message["mouse"]["kind"] != "click" or message["mouse"]["count"] != 1 or message["mouse"]["button"] != "left":
                reply = {"id": message["id"], "ok": False, "error": "background_unavailable"}
            else:
                counts[pid] = counts.get(pid, 0) + 1
                reply["result"] = {"type": "mouse-acknowledged", "route": "background-ax-press", "focusPreserved": True, "cursorPreserved": True}
        elif operation == "windows":
            reply["result"] = {"type": "windows", "displays": [], "windows": [
                {"windowId": 5, "pid": 12, "bundleId": "com.factory.applets.RelayMac", "title": "RelayMac", "displayName": "RelayMac",
                 "processStartedAt": 123.5, "windowRectPoints": [10, 20, 900, 450]}]}
        elif operation == "diagnose":
            reply["result"] = {"type": "diagnostic", "bundleId": "com.factory.applets.host", "bundlePath": "/x/Factory Relay.app",
                               "executablePath": "/x/Factory Relay.app/Contents/MacOS/AppletsHost", "accessibility": True,
                               "screenRecording": True, "permissionRequested": False, "launchMode": "persistent-ipc",
                               "processId": os.getpid(), "parentProcessId": 1,
                               "lifecycle": {"appKitInitialized": True, "eventLoopRunning": True, "launchFinished": True, "mainThread": True}}
        elif operation == "shutdown":
            connection.sendall(json.dumps({"id": message["id"], "ok": True, "result": {"type": "shutdown"}}).encode() + b"\n")
            os.unlink(endpoint)
            os._exit(0)
        record(event=operation, pid=pid, start=start, end=time.monotonic())
        connection.sendall(json.dumps(reply).encode() + b"\n")


VIDEO_AU = (b"\x00\x00\x00\x01\x67\x64\x00\x1f\xac\xd9\x40\x78"
            b"\x00\x00\x00\x01\x68\xee\x3c\x80"
            b"\x00\x00\x00\x01\x65\x88\x84\x21\xa0")


def stream(connection, hello):
    window, outstanding, sent, peak = hello["window"], 0, 0, 0
    target = hello["target"]
    video = os.environ.get("FAKE_HOST_VIDEO", "")
    connection.settimeout(10)
    while sent < frames_total:
        if outstanding < window:
            sent += 1
            if video == "badkind":
                header = dict(target, protocol=1, type="video", sequence=sent, bytes=4)
                payload = b"\x00\x00\x00\x01"
            elif video and sent % 2 == 0:
                header = dict(target, protocol=1, type="vframe", sequence=sent, codec="h264", format="annexb",
                              keyframe=True, width=2, height=2, captureTimeSeconds=time.monotonic(),
                              sentUptimeSeconds=time.monotonic(), contentRectPixels=[0, 0, 1, 1], contentScale=1,
                              scaleFactor=2, replacedFrames=0, bytes=len(VIDEO_AU),
                              initialWindowRectPoints=[10, 20, 900, 450], processStartedAt=123.5)
                payload = VIDEO_AU
            else:
                header = dict(target, protocol=1, type="frame", sequence=sent, mediaType="image/jpeg", width=2, height=2,
                              captureTimeSeconds=time.monotonic(), sentUptimeSeconds=time.monotonic(),
                              contentRectPixels=[0, 0, 1, 1], contentScale=1, scaleFactor=2, replacedFrames=0, bytes=4,
                              initialWindowRectPoints=[10, 20, 900, 450], processStartedAt=123.5)
                payload = b"\xff\xd8\xff\xd9"
            raw = json.dumps(header).encode()
            connection.sendall(struct.pack(">I", len(raw)) + raw + payload)
            outstanding += 1
            peak = max(peak, outstanding)
        else:
            value = connection.recv(1)
            if value != b"\x06":
                break
            outstanding -= 1
    record(event="stream-end", sent=sent, peak=peak, window=window)
    connection.close()


def serve(connection):
    try:
        connection.sendall(json.dumps({"protocol": 3, "type": "hello", "pid": os.getpid()}).encode() + b"\n")
        hello = json.loads(readline(connection))
        record(event="connection", kind=hello["type"])
        if hello["type"] == "control":
            control(connection)
        else:
            stream(connection, hello)
    except (OSError, TypeError, ValueError):
        pass


server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
server.bind(endpoint)
os.chmod(endpoint, 0o600)
server.listen(16)
record(event="launch", pid=os.getpid())
while True:
    client, _ = server.accept()
    threading.Thread(target=serve, args=(client,), daemon=True).start()

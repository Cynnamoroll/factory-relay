import json
import os
import signal
from pathlib import Path
import sys
import time
import tempfile
import struct
import zlib

args = sys.argv[1:]
with open(os.environ["FAKE_APPLE_LOG"], "a") as log:
    log.write(json.dumps(args) + "\n")
mode = os.environ.get("FAKE_APPLE_MODE", "")
if args[1:] == ["mcpbridge"]:
    for line in sys.stdin:
        message = json.loads(line)
        with open(os.environ["FAKE_BRIDGE_LOG"], "a") as log:
            log.write(json.dumps(message) + "\n")
        if "id" not in message:
            continue
        if message["method"] == "initialize":
            result = {"protocolVersion": message["params"]["protocolVersion"],
                      "capabilities": {"tools": {}}, "serverInfo": {"name": "fake-xcode", "version": "1"}}
        elif message["method"] == "tools/list":
            if mode == "bridge-error":
                print(json.dumps({"jsonrpc": "2.0", "id": message["id"],
                                  "error": {"code": -32603, "message": "SECRET_BRIDGE_DIAGNOSTIC"}}), flush=True)
                continue
            if mode == "bridge-overflow":
                print("SECRET" * 200000, flush=True)
                continue
            result = {"tools": [
                {"name": "DeviceInteractionSynthesize", "description": "Test public interaction description",
                 "inputSchema": {"type": "object", "properties": {"interactSessionKey": {"type": "string"}},
                                 "required": ["interactSessionKey"]}},
                {"name": "UnrelatedTool", "description": "SECRET_UNRELATED", "inputSchema": {"type": "object"}}]}
        elif message["method"] == "tools/call" and mode.startswith("visual-"):
            name, arguments = message["params"]["name"], message["params"]["arguments"]
            data = {}
            if name == "XcodeOpenWorkspace":
                if mode == "visual-disconnect":
                    sys.exit(0)
                if mode == "visual-timeout":
                    time.sleep(25)
                data = {"workspaceIdentifier": "workspace1"}
            elif name == "DeviceInteractionStartSession":
                assert arguments["deviceIdentifier"] == "12345678-1234-4234-8234-123456789012"
                names_file = Path.home() / "session-names.json"
                names = json.loads(names_file.read_text()) if names_file.exists() else []
                assert arguments["sessionIdentifier"] not in names, "Xcode disallows recently used session names"
                names_file.write_text(json.dumps(names + [arguments["sessionIdentifier"]]))
                data = {"interactionSessionKey": "SECRET_SESSION_KEY", "deviceIsSimulator": True,
                        "deviceUUID": "06ae5b11-c1c9-4456-b08e-c4e78c1f4247" if mode == "visual-mismatch"
                        else arguments["deviceIdentifier"]}
            elif name == "DeviceInteractionSynthesize":
                assert arguments["interactSessionKey"] == "SECRET_SESSION_KEY"
                if mode == "visual-disconnect-after-start":
                    sys.exit(0)
                count_file = Path.home() / "counter"
                count = int(count_file.read_text()) if count_file.exists() else 0
                if "interactionCommand" in arguments:
                    assert arguments["interactionCommand"] == "t 10 20"
                    count += 1
                    count_file.write_text(str(count))
                else:
                    assert arguments["activationBundleId"] == "com.factory.applets.RelayDemo"
                if mode == "visual-drift":
                    count += 50
                folder = Path(tempfile.gettempdir()) / "ActionArtifacts"
                folder.mkdir(exist_ok=True)
                hierarchy = folder / "hierarchy.txt"
                bundle = "com.other.app" if mode == "visual-other-app" else "com.factory.applets.RelayDemo"
                hierarchy.write_text("Application bundle identifier: " + bundle +
                    "\nStaticText, identifier: 'relay-count', label: 'Count: " + str(count) +
                    "', hitPoint: {10, 10}\nButton, identifier: 'relay-increment', label: 'Increment', hitPoint: {10, 20}\n")
                def chunk(kind, payload):
                    return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload) & 0xffffffff)
                png = folder / "screenshot.png"
                png.write_bytes(b"\x89PNG\r\n\x1a\n" +
                    chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0)) +
                    chunk(b"IDAT", zlib.compress(b"\x00\x00\x00\x00\xff")) + chunk(b"IEND", b""))
                if mode == "visual-corrupt-png":
                    png.write_bytes(b"not a PNG")
                data = {"hierarchyPath": str(hierarchy), "screenshotPath":
                        str(Path.home() / "private-file") if mode == "visual-outside" else str(png)}
            elif name == "DeviceInteractionEndSession":
                assert arguments == {"interactionSessionKey": "SECRET_SESSION_KEY"}
                data = {"userMessage": "Closed"}
            else:
                raise RuntimeError("Unexpected visual tool")
            result = {"structuredContent": data, "content": [{"type": "text", "text": json.dumps(data)}]}
        elif message["method"] == "tools/call" and mode.startswith("probe-"):
            name = message["params"]["name"]
            data = {}
            if name == "XcodeOpenWorkspace":
                assert message["params"]["arguments"]["path"].endswith("/fixtures/RelayDemo/RelayDemo.xcodeproj")
                if mode == "probe-overflow":
                    print("SECRET" * 200000, flush=True)
                    continue
                if mode == "probe-slow":
                    time.sleep(3)
                data = {"workspaceIdentifier": "workspace1"}
            elif name == "DeviceInteractionStartSession":
                assert message["params"]["arguments"]["deviceIdentifier"] == "06ae5b11-c1c9-4456-b08e-c4e78c1f4247"
                data = {"interactionSessionKey": "SECRET_SESSION_KEY", "deviceIsSimulator": True,
                        "deviceUUID": "12345678-1234-4234-8234-123456789012" if mode == "probe-mismatch"
                        else "06ae5b11-c1c9-4456-b08e-c4e78c1f4247"}
            elif name == "DeviceInteractionSynthesize":
                assert message["params"]["arguments"] == {
                    "interactSessionKey": "SECRET_SESSION_KEY", "activationBundleId": "com.factory.applets.RelayDemo"}
                data = {"applicationState": "Running", "hierarchyPath": "/tmp/fake-hierarchy.json",
                        "screenshotPath": "/tmp/fake-screenshot.png"}
            elif name == "DeviceInteractionEndSession":
                assert message["params"]["arguments"] == {"interactionSessionKey": "SECRET_SESSION_KEY"}
                data = {"userMessage": "Closed"}
            else:
                raise RuntimeError("Unexpected probe tool")
            if mode == "probe-approval" and name == "XcodeOpenWorkspace":
                result = {"isError": True, "content": [{"type": "text", "text": "SECRET_APPROVAL_DIAGNOSTIC"}]}
            elif mode == "probe-denied" and name == "DeviceInteractionStartSession":
                result = {"isError": True, "content": [{"type": "text",
                          "text": "This agent isn't approved to use Xcode's tools yet."}]}
            elif mode == "probe-end-failure" and name == "DeviceInteractionEndSession":
                result = {"isError": True, "content": [{"type": "text", "text": "SECRET_END_FAILURE"}]}
            else:
                result = {"structuredContent": data, "content": [{"type": "text", "text": json.dumps(data)}]}
        else:
            raise RuntimeError("Discovery must never invoke a tool")
        print(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": result}), flush=True)
    sys.exit(0)
if mode == "authorization":
    print("Install Started\nInstall Failed: Authorization is required to install the packages.", file=sys.stderr)
if mode == "helper-crash":
    os.kill(os.getppid(), signal.SIGKILL)
    sys.exit(0)
if mode == "helper-term":
    os.kill(os.getppid(), signal.SIGTERM)
    time.sleep(30)
if mode == "framework":
    print("CoreSimulator is out of date. Current version (1051.55.0) is older than build version (1174.21.0).", file=sys.stderr)
    print("CoreDevice: Symbol not found", file=sys.stderr)
    sys.exit(70)
if "screenshot" in args:
    Path(args[-1]).write_bytes(b"\x89PNG\r\n\x1a\nFAKE_TEST_PIXELS")
if mode == "failure":
    print("SECRET_BUILD_LOG")
    print("SECRET_STDERR", file=sys.stderr)
    sys.exit(42)
if mode == "overflow":
    sys.stdout.write("SECRET" * 300000)
    sys.stdout.flush()
if mode == "hang":
    time.sleep(30)
if args[1:4] == ["simctl", "list", "devices"]:
    if mode == "invalid":
        print('{"devices": "SECRET"}')
    else:
        print(json.dumps({"devices": {"com.apple.CoreSimulator.SimRuntime.iOS-18-0": [{
            "udid": "06ae5b11-c1c9-4456-b08e-c4e78c1f4247" if mode.startswith("probe-") else "12345678-1234-4234-8234-123456789012",
            "name": "Fake iPhone",
            "state": "Booted" if mode.startswith(("probe-", "visual-")) else "Shutdown",
            "isAvailable": True,
            "logPath": "SECRET_PRIVATE_PATH",
        }]}}))
else:
    print("SECRET_SUCCESS_LOG")

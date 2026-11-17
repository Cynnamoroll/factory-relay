"""Composed with remote.py and stream-supervisor.py, without their entry points."""
import math

CONTROL_ERRORS = STREAM_ERRORS | {
    "accessibility_required", "observation_stale", "target_mismatch", "element_unavailable",
    "action_uncertain", "control_timeout", "control_closed", "invalid_control_response",
}


def validate_control(request):
    if set(request) != {"owner", "workspace", "args", "operation", "target"}:
        raise Failure("invalid_request")
    operation, args, target = request["operation"], request["args"], request["target"]
    if operation not in ("diagnose", "observe", "press", "mouse") or type(args) is not dict:
        raise Failure("invalid_request")
    fields = {"lease", "observationId", "elementId"} if operation == "press" else (
        {"lease", "observationId", "mouse"} if operation == "mouse" else {"lease"})
    if operation == "observe" and "mode" in args:
        fields = fields | {"mode"}
        if args["mode"] not in ("pixels", "count"):
            raise Failure("invalid_request")
    if set(args) != fields:
        raise Failure("invalid_request")
    if operation == "diagnose":
        if target is not None:
            raise Failure("invalid_request")
    elif (not valid_target(target)
          or target.get("bundleId") in ("com.factory.applets.host", "com.apple.iphonesimulator", "com.apple.dt.Devices")):
        raise Failure("invalid_request")
    if operation == "observe" and args.get("mode") == "count" and target.get("bundleId") != "com.factory.applets.RelayMac":
        raise Failure("invalid_request")
    if operation == "press" and (args["elementId"] != "relay-increment" or target.get("bundleId") != "com.factory.applets.RelayMac"):
        raise Failure("invalid_request")
    if operation in ("press", "mouse") and (not isinstance(args["observationId"], str)
            or not re.fullmatch("[a-f0-9]{32}", args["observationId"])):
        raise Failure("invalid_request")
    if operation == "mouse":
        validate_mouse(args["mouse"])
    proof = args["lease"]
    if (type(proof) is not dict or set(proof) != {"token", "generation"}
            or not isinstance(proof["token"], str) or not re.fullmatch("[a-f0-9]{64}", proof["token"])
            or type(proof["generation"]) is not int or not 0 <= proof["generation"] < 2**53):
        raise Failure("invalid_request")

def validate_mouse(value):
    if type(value) is not dict:
        raise Failure("invalid_request")
    fields = {"move": set(), "click": {"button", "count"}, "drag": {"toX", "toY", "durationMs"},
              "scroll": {"deltaX", "deltaY"}}
    kind = value.get("kind")
    if type(kind) is not str or kind not in fields or set(value) != {"kind", "x", "y"} | fields[kind]:
        raise Failure("invalid_request")
    for key in (("x", "y", "toX", "toY") if kind == "drag" else ("x", "y")):
        if type(value[key]) not in (float, int) or not math.isfinite(value[key]) or not 0 <= value[key] < 1:
            raise Failure("invalid_request")
    if kind == "click" and (value["button"] not in ("left", "right") or type(value["count"]) is not int or not 1 <= value["count"] <= 2):
        raise Failure("invalid_request")
    if kind == "drag" and (type(value["durationMs"]) is not int or not 100 <= value["durationMs"] <= 1000):
        raise Failure("invalid_request")
    if kind == "scroll" and any(type(value[k]) is not int or not -600 <= value[k] <= 600 for k in ("deltaX", "deltaY")):
        raise Failure("invalid_request")


def control_snapshot(value, target):
    if target.get("kind") == "desktop":
        if (type(value) is not dict or set(value) != {"target", "displayConfiguration", "elements"}
                or value["target"] != target or value["elements"] != []):
            raise Failure("invalid_control_response")
        config = value["displayConfiguration"]
        if (type(config) is not dict or set(config) != {"boundsPoints", "pixelWidth", "pixelHeight", "rotation", "scaleX", "scaleY"}
                or type(config["boundsPoints"]) is not list or len(config["boundsPoints"]) != 4
                or not all(type(n) in (float, int) and math.isfinite(n) for n in config["boundsPoints"])
                or not all(0 < n <= 16384 for n in config["boundsPoints"][2:])
                or not all(type(config[k]) is int and 0 < config[k] <= 32768 for k in ("pixelWidth", "pixelHeight"))
                or not all(type(config[k]) in (float, int) and math.isfinite(config[k]) and 0 < config[k] <= 16 for k in ("scaleX", "scaleY"))
                or type(config["rotation"]) not in (float, int) or not math.isfinite(config["rotation"]) or not 0 <= config["rotation"] < 360):
            raise Failure("invalid_control_response")
        return value
    if (type(value) is not dict or set(value) != {"target", "windowRectPoints", "processStartedAt", "elements"}
            or value["target"] != target or type(value["windowRectPoints"]) is not list
            or len(value["windowRectPoints"]) != 4
            or not all(type(n) in (float, int) and math.isfinite(n) for n in value["windowRectPoints"])
            or not all(0 < n <= 16384 for n in value["windowRectPoints"][2:])
            or type(value["processStartedAt"]) not in (float, int) or not math.isfinite(value["processStartedAt"])
            or type(value["elements"]) is not list or len(value["elements"]) not in (0, 2)
            or (value["elements"] and target["bundleId"] != "com.factory.applets.RelayMac")):
        raise Failure("invalid_control_response")
    for element, identifier, role in zip(value["elements"], ("relay-count", "relay-increment"), ("AXStaticText", "AXButton")):
        if (type(element) is not dict or set(element) != {"id", "role", "value", "enabled"}
                or element["id"] != identifier or element["role"] != role
                or type(element["enabled"]) is not bool or not isinstance(element["value"], str)
                or len(element["value"].encode()) > 512):
            raise Failure("invalid_control_response")
    return value


def control_observation(root, request):
    try:
        with private_open(root / "control-observation.json") as handle:
            record = json.loads(handle.read(16385))
        if (record["id"] != request["args"]["observationId"] or record["owner"] != request["owner"]
                or record["generation"] != request["args"]["lease"]["generation"]
                or record["workspace"] != request["workspace"]
                or not 0 <= time.time() - record["createdAt"] <= 30):
            raise Failure("observation_stale")
        return control_snapshot(record["snapshot"], request["target"])
    except (ValueError, KeyError, TypeError):
        raise Failure("observation_stale")


def control_action(fd, root, request):
    operation = request["operation"]
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
        lease = verify_lease(read_state(root), request)
        if lease["expiresAt"] - time.time() < 4:
            raise Failure("lease_expired")
        message = {"operation": operation, "target": request["target"]}
        if operation == "observe" and "mode" in request["args"]:
            message["mode"] = request["args"]["mode"]
        if operation in ("press", "mouse"):
            message.update(expected=control_observation(root, request))
            if operation == "press":
                if len(message["expected"]["elements"]) != 2:
                    raise Failure("observation_stale")
                message["elementId"] = request["args"]["elementId"]
            else:
                message["mouse"] = request["args"]["mouse"]
            (root / "control-observation.json").unlink()
        with private_open(root / "inflight") as marker:
            marker.write(str(os.getpid()))
            marker.flush()
            os.fsync(marker.fileno())
        completed = False
        try:
            deadline = time.monotonic() + 2.5
            stream_write(fd, json.dumps(message).encode() + b"\n", deadline)
            response = json.loads(stream_line(fd, 16384, deadline))
            if type(response) is not dict:
                raise Failure("invalid_control_response")
            if response.get("ok") is False:
                if set(response) != {"ok", "error"} or response["error"] not in CONTROL_ERRORS:
                    raise Failure("invalid_control_response")
                completed = response["error"] not in ("action_uncertain", "control_timeout", "control_closed")
                raise Failure(response["error"])
            if set(response) != {"ok", "result"} or response["ok"] is not True or type(response["result"]) is not dict:
                raise Failure("invalid_control_response")
            result = response["result"]
            if operation == "observe":
                if set(result) != {"type", "snapshot"} or result["type"] != "observation":
                    raise Failure("invalid_control_response")
                control_snapshot(result["snapshot"], request["target"])
                record = {"id": secrets.token_hex(16), "owner": request["owner"], "workspace": request["workspace"],
                          "generation": request["args"]["lease"]["generation"], "createdAt": time.time(),
                          "snapshot": result["snapshot"]}
                with private_open(root / "control-observation.json") as handle:
                    handle.seek(0)
                    json.dump(record, handle)
                    handle.truncate()
                    handle.flush()
                    os.fsync(handle.fileno())
                result.update(observationId=record["id"], expiresAt=record["createdAt"] + 30)
            elif operation == "press":
                if result != {"type": "pressed", "elementId": "relay-increment"}:
                    raise Failure("invalid_control_response")
            elif operation == "mouse":
                if result != {"type": "mouse-acknowledged"}:
                    raise Failure("invalid_control_response")
            elif result.get("type") != "diagnostic" or result.get("bundleId") != "com.factory.applets.host":
                raise Failure("invalid_control_response")
            completed = True
            return result
        finally:
            # A lost press reply may represent an applied action. Recovery must remain fail-closed.
            if completed or operation not in ("press", "mouse"):
                (root / "inflight").unlink()


def control_main():
    os.umask(0o077)
    def interrupted(_signal, _frame):
        raise Failure("stream_interrupted")
    for signum in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, interrupted)
    try:
        request = json.loads(sys.stdin.buffer.read(16385))
        validate_control(request)
        root = private_directory(Path.home() / ".applets-control")
        authorize_stream(root, request)
        with launch_host(root, request, None, time.monotonic() + 15, control=True) as fd:
            result = control_action(fd, root, request)
        response = {"ok": True, "result": result}
    except (Failure, ValueError, KeyError, TypeError, OSError) as error:
        code = str(error) if isinstance(error, Failure) else "invalid_control_response"
        response = {"ok": False, "error": code if code in CONTROL_ERRORS else "invalid_control_response"}
    print(json.dumps(response))


if __name__ == "__main__":
    control_main()

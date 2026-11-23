"""Composed with remote.py and stream-supervisor.py, without their entry points.

A persistent per-client daemon: one SSH session carries many bounded control requests. Every
request rereads the authoritative lease; nothing is authorized for the connection lifetime.
"""
import hashlib
import math
import concurrent.futures

CONTROL_ERRORS = STREAM_ERRORS | {
    "accessibility_required", "observation_stale", "target_mismatch", "element_unavailable",
    "action_uncertain", "control_timeout", "control_closed", "invalid_control_response",
    "background_unavailable", "lease_scope", "screen_recording_required",
}
# A lost reply after dispatch may mean the input happened; these never clear a fence.
UNCERTAIN_ERRORS = {"action_uncertain", "control_timeout", "control_closed"}
OPERATIONS = ("diagnose", "windows", "observe", "press", "mouse", "shutdown")
MUTATIONS = ("press", "mouse")
OBSERVATION_SECONDS = 30
OBSERVATION_LIMIT = 256
DAEMON_WORKERS = 8
DAEMON_PENDING = 32
DEADLINES = {"diagnose": 5, "windows": 10, "observe": 3, "press": 3, "mouse": 4, "shutdown": 3}
# Client-to-daemon handshake; versioned independently of HOST_PROTOCOL (daemon-to-app).
SESSION_PROTOCOL = 2


def validate_control(request):
    if set(request) != {"owner", "workspace", "args", "operation", "target"}:
        raise Failure("invalid_request")
    operation, args, target = request["operation"], request["args"], request["target"]
    if operation not in OPERATIONS or type(args) is not dict:
        raise Failure("invalid_request")
    fields = {"lease", "observationId", "elementId"} if operation == "press" else (
        {"lease", "observationId", "mouse"} if operation == "mouse" else {"lease"})
    if operation == "observe" and "mode" in args:
        fields = fields | {"mode"}
        if args["mode"] not in ("pixels", "count"):
            raise Failure("invalid_request")
    if operation in MUTATIONS and "waitFor" in args:
        fields |= {"waitFor"}
        wait = args["waitFor"]
        if (type(wait) is not dict or set(wait) != {"kind", "equals", "timeoutMs"} or wait["kind"] != "count"
                or type(wait["equals"]) is not int or not 0 <= wait["equals"] <= 10**9
                or type(wait["timeoutMs"]) is not int or not 1 <= wait["timeoutMs"] <= 2000):
            raise Failure("invalid_request")
    if set(args) != fields:
        raise Failure("invalid_request")
    if operation in ("diagnose", "windows", "shutdown"):
        if target is not None:
            raise Failure("invalid_request")
    elif (not valid_target(target)
          or target.get("bundleId") in ("com.factory.applets.host", "com.apple.iphonesimulator", "com.apple.dt.Devices")):
        raise Failure("invalid_request")
    if operation == "observe" and args.get("mode") == "count" and target.get("bundleId") != "com.factory.applets.RelayMac":
        raise Failure("invalid_request")
    if operation == "press" and (args["elementId"] != "relay-increment" or target.get("bundleId") != "com.factory.applets.RelayMac"):
        raise Failure("invalid_request")
    if operation in MUTATIONS and (not isinstance(args["observationId"], str)
            or not re.fullmatch("[a-f0-9]{32}", args["observationId"])):
        raise Failure("invalid_request")
    if operation == "mouse":
        validate_mouse(args["mouse"])
        if "waitFor" in args and (target.get("bundleId") != "com.factory.applets.RelayMac"
                or args["mouse"]["kind"] != "click" or args["mouse"]["button"] != "left" or args["mouse"]["count"] != 1):
            raise Failure("invalid_request")
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


def token_digest(token):
    return hashlib.sha256(token.encode()).hexdigest()


def fence_path(root, target):
    """Window input fences one process; desktop input keeps the global recovery fence."""
    if target.get("kind") == "desktop":
        return root / "inflight"
    return private_directory(root / "fences") / ("pid-%d" % target["pid"])


@contextmanager
def pid_lock(root, target, deadline):
    """Serializes mutations per target process across every daemon; other processes proceed."""
    if target is None or target.get("kind") == "desktop":
        yield
        return
    with private_open(private_directory(root / "pids") / ("pid-%d.lock" % target["pid"])) as lock:
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise Failure("busy")
                time.sleep(0.005)
        yield


def store_observation(root, request, lease, snapshot):
    directory = private_directory(root / "observations")
    now = time.time()
    entries = []
    for path in directory.glob("*.json"):
        try:
            age = now - path.stat().st_mtime
        except FileNotFoundError:
            continue
        if not 0 <= age <= OBSERVATION_SECONDS + 5:
            path.unlink(missing_ok=True)
        else:
            entries.append((age, path))
    for _, path in sorted(entries, reverse=True)[:max(0, len(entries) - OBSERVATION_LIMIT + 1)]:
        path.unlink(missing_ok=True)
    record = {"id": secrets.token_hex(16), "owner": request["owner"], "workspace": request["workspace"],
              "lease": token_digest(lease["token"]), "generation": lease["generation"],
              "target": request["target"], "createdAt": now, "snapshot": snapshot}
    temporary = directory / ("tmp-" + secrets.token_hex(8))
    fd = os.open(str(temporary), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "w") as handle:
            json.dump(record, handle)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, directory / (record["id"] + ".json"))
    finally:
        temporary.unlink(missing_ok=True)
    return record


def consume_observation(root, request, lease):
    """Single-use: the record is removed before dispatch, so a lost reply cannot replay it."""
    path = private_directory(root / "observations") / (request["args"]["observationId"] + ".json")
    try:
        with private_open(path) as handle:
            record = json.loads(handle.read(65537))
    except FileNotFoundError:
        raise Failure("observation_stale")
    except (ValueError, OSError):
        path.unlink(missing_ok=True)
        raise Failure("observation_stale")
    try:
        # A mismatched caller must not be able to burn another lease's observation.
        if (record["id"] != request["args"]["observationId"] or record["owner"] != request["owner"]
                or record["workspace"] != request["workspace"]
                or not secrets.compare_digest(record["lease"], token_digest(lease["token"]))
                or record["generation"] != lease["generation"]
                or record["target"] != request["target"]):
            raise Failure("observation_stale")
        if not 0 <= time.time() - record["createdAt"] <= OBSERVATION_SECONDS:
            path.unlink(missing_ok=True)
            raise Failure("observation_stale")
        snapshot = control_snapshot(record["snapshot"], request["target"])
    except (KeyError, TypeError):
        raise Failure("observation_stale")
    try:
        path.unlink()
    except FileNotFoundError:
        raise Failure("observation_stale")  # A concurrent consumer won the single use.
    return snapshot


def write_fence(path, request):
    with private_open(path) as marker:
        marker.seek(0)
        marker.write(json.dumps({"pid": os.getpid(), "owner": request["owner"], "target": request["target"],
                                 "createdAt": time.time()}))
        marker.truncate()
        marker.flush()
        os.fsync(marker.fileno())


def check_result(operation, result, request):
    if operation == "observe":
        if set(result) != {"type", "snapshot"} or result["type"] != "observation":
            raise Failure("invalid_control_response")
        control_snapshot(result["snapshot"], request["target"])
    elif operation == "press":
        if result != {"type": "pressed", "elementId": "relay-increment"}:
            raise Failure("invalid_control_response")
    elif operation == "mouse":
        if (set(result) != {"type", "route", "focusPreserved", "cursorPreserved"}
                or result["type"] != "mouse-acknowledged"
                or result["route"] not in ("background-ax-press", "foreground-hid")
                or (result["route"] == "foreground-hid") != (request["target"].get("kind") == "desktop")
                or type(result["focusPreserved"]) is not bool or type(result["cursorPreserved"]) is not bool):
            raise Failure("invalid_control_response")
    elif operation == "windows":
        if result.get("type") != "windows" or type(result.get("windows")) is not list or type(result.get("displays")) is not list:
            raise Failure("invalid_control_response")
    elif operation == "shutdown":
        if result != {"type": "shutdown"}:
            raise Failure("invalid_control_response")
    elif result.get("type") != "diagnostic" or result.get("bundleId") != "com.factory.applets.host":
        raise Failure("invalid_control_response")


def access_for(operation):
    return "mutate" if operation in MUTATIONS else "read" if operation == "observe" else "discover"


def control_action(host, root, request, deadline, *, identity=None, save_observation=True):
    """host() returns a live connection to the persistent app; called only after authorization."""
    operation, target = request["operation"], request["target"]
    with pid_lock(root, target if operation in MUTATIONS else None, deadline):
        # Holding the shared lock across dispatch makes takeover wait for in-flight input.
        with state_lock(root, shared=True, wait=max(0.01, min(2, deadline - time.monotonic()))):
            if (root / "inflight").exists() or (root / "bridge-session.json").exists():
                raise Failure("busy")
            if target is not None and target.get("kind") != "desktop" and fence_path(root, target).exists():
                raise Failure("busy")
            lease = require_access(verify_lease(read_state(root), request), target, access_for(operation))
            if operation == "shutdown" and lease["scope"]["kind"] != "exclusive":
                raise Failure("lease_scope")
            if lease["expiresAt"] - time.time() < 4:
                raise Failure("lease_expired")
            message = {"id": secrets.randbelow(2**31), "operation": operation, "target": target}
            if operation == "observe" and "mode" in request["args"]:
                message["mode"] = request["args"]["mode"]
            fence = None
            if operation in MUTATIONS:
                message["expected"] = consume_observation(root, request, lease)
                if identity is not None:
                    identity["processStartedAt"] = message["expected"]["processStartedAt"]
                if operation == "press":
                    if len(message["expected"]["elements"]) != 2:
                        raise Failure("observation_stale")
                    message["elementId"] = request["args"]["elementId"]
                else:
                    message["mouse"] = request["args"]["mouse"]
                fence = fence_path(root, target)
                connection = host()
                write_fence(fence, request)
            else:
                connection = host()
            completed = False
            try:
                try:
                    response = host_request(connection, message, deadline)
                except (Failure, OSError, ValueError):
                    if operation in MUTATIONS:
                        raise Failure("action_uncertain")
                    raise
                if response.get("ok") is False:
                    if set(response) != {"ok", "error"} or response["error"] not in CONTROL_ERRORS:
                        raise Failure("invalid_control_response")
                    completed = response["error"] not in UNCERTAIN_ERRORS
                    raise Failure(response["error"])
                if set(response) != {"ok", "result"} or response["ok"] is not True or type(response["result"]) is not dict:
                    raise Failure("invalid_control_response")
                result = response["result"]
                check_result(operation, result, request)
                if operation == "observe" and save_observation:
                    record = store_observation(root, request, lease, result["snapshot"])
                    result.update(observationId=record["id"], expiresAt=record["createdAt"] + OBSERVATION_SECONDS)
                completed = True
                return result
            finally:
                if fence is not None and completed:
                    fence.unlink()


class HostConnections:
    """One host connection per worker thread; a connection is never shared by two requests."""
    def __init__(self, root, workspace):
        self.root, self.workspace = root, workspace
        self.local = threading.local()

    def get(self, deadline):
        connection = getattr(self.local, "connection", None)
        if connection is not None:
            try:
                connection.setblocking(False)
                if connection.recv(1, socket.MSG_PEEK) == b"":
                    raise OSError()
                raise OSError()  # Unsolicited bytes mean the protocol is out of step.
            except BlockingIOError:
                return connection
            except OSError:
                connection.close()
                self.local.connection = None
        connection = connect_host(self.root, self.workspace, deadline, {"type": "control"})
        self.local.connection = connection
        return connection

    def drop(self):
        connection = getattr(self.local, "connection", None)
        if connection is not None:
            connection.close()
            self.local.connection = None


def act_and_wait(connections, root, request, deadline):
    """Exactly one mutation. Poll read-only AX state locally without holding a lease lock between reads."""
    start = time.monotonic()
    condition = request["args"]["waitFor"]
    identity = {}
    dispatch_deadline = min(deadline, start + DEADLINES[request["operation"]])
    result = control_action(lambda: connections.get(dispatch_deadline), root, request, dispatch_deadline, identity=identity)
    ack = time.monotonic()
    until = min(deadline, ack + condition["timeoutMs"] / 1000)
    read = {**request, "operation": "observe", "args": {"lease": request["args"]["lease"], "mode": "count"}}
    effect = {"status": "timed_out", "actual": None, "dispatchMs": (ack - start) * 1000}
    while time.monotonic() < until:
        try:
            sample = control_action(lambda: connections.get(until), root, read, until, save_observation=False)["snapshot"]
            if sample["processStartedAt"] != identity["processStartedAt"]:
                raise Failure("target_mismatch")
            count = re.fullmatch(r"Count: ([0-9]{1,15})", sample["elements"][0]["value"]) if sample["elements"] else None
            if not count:
                raise Failure("invalid_control_response")
            if time.monotonic() >= until:
                break
            effect["actual"] = int(count[1])
            if effect["actual"] == condition["equals"]:
                effect["status"] = "matched"
                break
        except (Failure, OSError, ValueError) as exc:
            connections.drop()  # A read that times out can still have a reply in flight.
            if time.monotonic() < until:
                effect.update(status="unavailable", actual=None, reason=str(exc) if str(exc) in CONTROL_ERRORS else "control_closed")
            break
        time.sleep(min(0.025, max(0, until - time.monotonic())))
    return {**result, "effect": {**effect, "elapsedMs": (time.monotonic() - start) * 1000}}


def handle(connections, root, envelope):
    request_id = envelope.get("id") if type(envelope) is dict else None
    try:
        if (type(envelope) is not dict or set(envelope) != {"id", "request", "deadlineMs"}
                or type(request_id) is not int or not 0 < request_id < 2**53
                or type(envelope["deadlineMs"]) is not int or not 1 <= envelope["deadlineMs"] <= 30000):
            raise Failure("invalid_request")
        request = envelope["request"]
        if type(request) is not dict:
            raise Failure("invalid_request")
        validate_control(request)
        if request["workspace"] != connections.workspace:
            raise Failure("invalid_request")
        deadline = time.monotonic() + min(envelope["deadlineMs"] / 1000, DEADLINES[request["operation"]] + 12)
        try:
            if "waitFor" in request["args"]:
                result = act_and_wait(connections, root, request, deadline)
            else:
                result = control_action(lambda: connections.get(deadline), root, request, deadline)
        except Failure as error:
            if str(error) in ("action_uncertain", "stream_timeout", "stream_closed", "invalid_stream", "invalid_control_response"):
                connections.drop()
            raise
        except BaseException:
            connections.drop()
            raise
        if request["operation"] == "shutdown":
            connections.drop()
        return {"id": request_id, "ok": True, "result": result}
    except (Failure, ValueError, KeyError, TypeError, OSError) as error:
        code = str(error) if isinstance(error, Failure) else (
            "control_closed" if isinstance(error, OSError) else "invalid_control_response")
        return {"id": request_id, "ok": False, "error": code if code in CONTROL_ERRORS else "invalid_control_response"}


def daemon_main():
    os.umask(0o077)
    output = threading.Lock()
    def emit(value):
        data = json.dumps(value).encode() + b"\n"
        with output:
            stream_write(1, data, time.monotonic() + 10)
    def stop(_signal, _frame):
        os._exit(0)
    for signum in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, stop)
    try:
        reader = LineReader(0)
        hello = json.loads(reader.read(16384, time.monotonic() + 30))
        if (type(hello) is not dict or set(hello) != {"type", "protocol", "workspace"} or hello["type"] != "hello"
                or hello["protocol"] != SESSION_PROTOCOL or not isinstance(hello["workspace"], str)):
            raise Failure("invalid_request")
        root = private_directory(Path.home() / ".applets-control")
    except (Failure, ValueError, OSError) as error:
        print(json.dumps({"type": "error", "error": str(error) if isinstance(error, Failure) else "invalid_request"}))
        return
    connections = HostConnections(root, hello["workspace"])
    pending = threading.BoundedSemaphore(DAEMON_PENDING)
    emit({"type": "ready", "protocol": SESSION_PROTOCOL, "pid": os.getpid()})
    with concurrent.futures.ThreadPoolExecutor(max_workers=DAEMON_WORKERS) as pool:
        while True:
            try:
                line = reader.read(16384, time.monotonic() + 86400)
            except Failure:
                break
            try:
                envelope = json.loads(line)
            except ValueError:
                emit({"id": None, "ok": False, "error": "invalid_request"})
                continue
            if not pending.acquire(blocking=False):
                emit({"id": envelope.get("id") if type(envelope) is dict else None, "ok": False, "error": "busy"})
                continue
            def work(envelope=envelope):
                try:
                    emit(handle(connections, root, envelope))
                finally:
                    pending.release()
            pool.submit(work)


if __name__ == "__main__":
    daemon_main()

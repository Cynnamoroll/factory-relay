"""Appended to remote.py without main(); shares its storage and lease authority.

The permission-owning app runs persistently and listens on ~/.applets-control/host/relay.sock.
Each SSH-side helper opens its own connection per use, so clients never share descriptors.
"""
import struct
import socket
import threading
import ctypes

STREAM_HEADER_LIMIT = 8192
STREAM_IMAGE_LIMIT = 4 * 1024 * 1024
STREAM_WINDOW_LIMIT = 8
HOST_PROTOCOL = 3
STREAM_ERRORS = {"busy", "stale_lease", "lease_expired", "lease_scope", "unsafe_state", "unsafe_peer",
                 "unsupported_host", "ipc_path_limit", "invalid_request", "invalid_stream",
                 "stream_timeout", "stream_closed", "stream_interrupted", "host_unavailable"}


def valid_bundle(value):
    return isinstance(value, str) and len(value) <= 255 and re.fullmatch(r"[A-Za-z0-9._-]*", value) is not None


def valid_target(target):
    if type(target) is not dict:
        return False
    if target.get("kind") == "desktop":
        return (set(target) == {"kind", "displayId", "displayUUID"}
                and type(target["displayId"]) is int and 0 < target["displayId"] < 2**32
                and isinstance(target["displayUUID"], str)
                and re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", target["displayUUID"]) is not None)
    return (set(target) == {"windowId", "pid", "bundleId"}
            and type(target["windowId"]) is int and 0 < target["windowId"] < 2**32
            and type(target["pid"]) is int and 0 < target["pid"] < 2**31
            and valid_bundle(target["bundleId"]) and target["bundleId"] != "com.factory.applets.host")


def peer_uid(connection):
    if sys.platform == "darwin":
        uid, gid = ctypes.c_uint(), ctypes.c_uint()
        if ctypes.CDLL(None, use_errno=True).getpeereid(connection.fileno(), ctypes.byref(uid), ctypes.byref(gid)) != 0:
            raise Failure("unsafe_peer")
        return uid.value
    if sys.platform == "linux":
        return struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))[1]
    raise Failure("unsupported_host")


def stream_read(fd, size, deadline):
    result = bytearray()
    with selectors.DefaultSelector() as selector:
        selector.register(fd, selectors.EVENT_READ)
        while len(result) < size:
            if time.monotonic() >= deadline:
                raise Failure("stream_timeout")
            if not selector.select(min(0.1, max(0, deadline - time.monotonic()))):
                continue
            try:
                chunk = os.read(fd, size - len(result))
            except BlockingIOError:
                continue
            if not chunk:
                raise Failure("stream_closed")
            result.extend(chunk)
    return bytes(result)


def stream_line(fd, limit, deadline):
    line = bytearray()
    while len(line) <= limit:
        value = stream_read(fd, 1, deadline)
        if value == b"\n":
            return bytes(line)
        line.extend(value)
    raise Failure("invalid_stream")


class LineReader:
    """Bounded control-only channel; preserve coalesced request lines for the daemon."""
    def __init__(self, fd):
        self.fd = fd
        self.pending = bytearray()

    def read(self, limit, deadline):
        with selectors.DefaultSelector() as selector:
            selector.register(self.fd, selectors.EVENT_READ)
            while time.monotonic() < deadline:
                end = self.pending.find(b"\n")
                if end > limit or (end < 0 and len(self.pending) > limit):
                    raise Failure("invalid_stream")
                if end >= 0:
                    line = bytes(self.pending[:end])
                    del self.pending[:end + 1]
                    return line
                if not selector.select(max(0, deadline - time.monotonic())):
                    continue
                try:
                    chunk = os.read(self.fd, min(16384, limit + 1 - len(self.pending)))
                except BlockingIOError:
                    continue
                if not chunk:
                    raise Failure("stream_closed")
                self.pending.extend(chunk)
        raise Failure("stream_timeout")


def stream_write(fd, data, deadline):
    os.set_blocking(fd, False)
    with selectors.DefaultSelector() as selector:
        selector.register(fd, selectors.EVENT_WRITE)
        view = memoryview(data)
        while view:
            if time.monotonic() >= deadline:
                raise Failure("stream_timeout")
            if not selector.select(min(0.1, max(0, deadline - time.monotonic()))):
                continue
            try:
                count = os.write(fd, view)
                if count <= 0:
                    raise Failure("stream_closed")
                view = view[count:]
            except BlockingIOError:
                pass


def host_endpoint(root):
    endpoint = private_directory(root / "host") / "relay.sock"
    if len(os.fsencode(endpoint)) >= 104:
        raise Failure("ipc_path_limit")
    return endpoint


def dial(endpoint):
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        connection.connect(str(endpoint))
        return connection
    except OSError:
        connection.close()
        raise


def connect_host(root, workspace, deadline, hello):
    """Connect to the running host, launching it once through LaunchServices if needed.

    Callers authorize the request first, so an unauthorized client never starts the app.
    """
    endpoint = host_endpoint(root)
    connection = None
    try:
        connection = dial(endpoint)
    except (FileNotFoundError, ConnectionRefusedError):
        with private_open(endpoint.parent / "launch.lock") as lock:
            while True:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise Failure("host_unavailable")
                    time.sleep(0.02)
            try:
                connection = dial(endpoint)
            except (FileNotFoundError, ConnectionRefusedError):
                if endpoint.is_socket():
                    endpoint.unlink()
                elif endpoint.exists() or endpoint.is_symlink():
                    raise Failure("unsafe_state")
                app = Path(workspace) / ".applets-host/Factory Relay.app"
                execute(["/usr/bin/open", "-n", "-g", str(app), "--args", "serve", str(endpoint)],
                        min(deadline, time.monotonic() + 10))
                while connection is None:
                    if time.monotonic() >= deadline:
                        raise Failure("host_unavailable")
                    try:
                        connection = dial(endpoint)
                    except (FileNotFoundError, ConnectionRefusedError):
                        time.sleep(0.05)
    try:
        if peer_uid(connection) != os.getuid():
            raise Failure("unsafe_peer")
        greeting = json.loads(stream_line(connection.fileno(), 1024, deadline))
        if (type(greeting) is not dict or set(greeting) != {"protocol", "type", "pid"}
                or greeting["protocol"] != HOST_PROTOCOL or greeting["type"] != "hello"
                or type(greeting["pid"]) is not int or greeting["pid"] <= 0):
            raise Failure("invalid_stream")
        stream_write(connection.fileno(), json.dumps(hello).encode() + b"\n", deadline)
        return connection
    except BaseException:
        connection.close()
        raise


def authorize_stream(root, request, access="read", target=None):
    with state_lock(root, shared=True, wait=3):
        if (root / "inflight").exists() or (root / "bridge-session.json").exists():
            raise Failure("busy")
        state = read_state(root)
        lease = verify_lease(state, request)
        if request.get("mode") == "recording":
            if target is None or target.get("kind") != "desktop" or lease["scope"]["kind"] != "window":
                raise Failure("lease_scope")
            holders = [item for item in state["leases"] if item["expiresAt"] > time.time()
                       and item["scope"]["kind"] != "observer"]
            if len(holders) != 1 or holders[0] is not lease:
                raise Failure("lease_scope")
            # A holder may join and leave while media waits for credit. Never release
            # those buffered full-display pixels into a later single-holder epoch.
            epoch = request.setdefault("_recording_generation", state["generation"])
            if epoch != state["generation"]:
                raise Failure("lease_scope")
            return lease
        return require_access(lease, target, access)


def read_packet(fd, deadline):
    prefix = stream_read(fd, 4, deadline)
    length = struct.unpack(">I", prefix)[0]
    if not 0 < length <= STREAM_HEADER_LIMIT:
        raise Failure("invalid_stream")
    raw = stream_read(fd, length, deadline)
    header = json.loads(raw)
    if type(header) is not dict:
        raise Failure("invalid_stream")
    size = header.get("bytes")
    kind = header.get("type")
    if type(size) is not int or not ((kind in ("frame", "vframe") and 0 < size <= STREAM_IMAGE_LIMIT)
                                     or (kind in ("heartbeat", "diagnostic", "windows") and size == 0)):
        raise Failure("invalid_stream")
    return header, raw, stream_read(fd, size, deadline)


class Credits:
    """Counts unacknowledged packets so a client can never grant more than it received."""
    def __init__(self, window):
        self.lock = threading.Lock()
        self.window = window
        self.outstanding = 0
        self.failure = None

    def sent(self):
        with self.lock:
            self.outstanding += 1
            if self.outstanding > self.window:
                raise Failure("invalid_stream")

    def acknowledged(self):
        with self.lock:
            if self.outstanding <= 0:
                raise Failure("invalid_stream")
            self.outstanding -= 1


def forward_credits(connection, credits, end):
    try:
        while True:
            value = stream_read(0, 1, end)
            if value != b"\x06":
                raise Failure("invalid_stream")
            credits.acknowledged()
            stream_write(connection.fileno(), value, min(end, time.monotonic() + 1))
    except Failure as error:
        credits.failure = str(error)
    except OSError:
        credits.failure = "stream_closed"
    finally:
        try:
            connection.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass


def relay_host(connection, root, request, end, window):
    """Pipelined relay: up to window packets in flight, lease rechecked for every packet."""
    credits = Credits(window)
    worker = threading.Thread(target=forward_credits, args=(connection, credits, end), daemon=True)
    worker.start()
    fd = connection.fileno()
    while True:
        try:
            header, raw, image = read_packet(fd, min(end, time.monotonic() + 10))
        except Failure:
            if credits.failure:
                raise Failure(credits.failure if credits.failure in STREAM_ERRORS else "invalid_stream")
            raise
        authorize_stream(root, request, "read", request["target"])
        if header["type"] in ("frame", "vframe", "heartbeat"):
            credits.sent()
        stream_write(1, struct.pack(">I", len(raw)) + raw + image, min(end, time.monotonic() + 10))
        if header["type"] not in ("frame", "vframe", "heartbeat"):
            return


def host_request(connection, message, deadline, limit=65536):
    stream_write(connection.fileno(), json.dumps(message).encode() + b"\n", deadline)
    reader = LineReader(connection.fileno())
    response = json.loads(reader.read(limit, deadline))
    if reader.pending:  # One request in flight per host connection.
        raise Failure("invalid_control_response")
    if type(response) is not dict or response.get("id") != message["id"]:
        raise Failure("invalid_control_response")
    del response["id"]
    return response


def stream_main():
    os.umask(0o077)
    def interrupted(_signal, _frame):
        raise Failure("stream_interrupted")
    for signum in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, interrupted)
    try:
        # The request is one line; later bytes are credit acknowledgments.
        line = bytearray()
        deadline = time.monotonic() + 10
        while len(line) <= 16384:
            value = stream_read(0, 1, deadline)
            if value == b"\n":
                break
            line.extend(value)
        else:
            raise Failure("invalid_request")
        request = json.loads(line)
        if (set(request) - {"window"} != {"owner", "workspace", "args", "mode", "target", "timeout"}
                or request["mode"] not in ("diagnose", "windows", "stream", "recording")
                or type(request["timeout"]) is not int or not 1 <= request["timeout"] <= 1800):
            raise Failure("invalid_request")
        window = request.get("window", 1)
        if type(window) is not int or not 1 <= window <= STREAM_WINDOW_LIMIT:
            raise Failure("invalid_request")
        root = private_directory(Path.home() / ".applets-control")
        end = time.monotonic() + request["timeout"]
        if request["mode"] in ("stream", "recording"):
            if not valid_target(request["target"]):
                raise Failure("invalid_request")
            if request["mode"] == "recording" and request["target"].get("kind") != "desktop":
                raise Failure("invalid_request")
            authorize_stream(root, request, "read", request["target"])
            connection = connect_host(root, request["workspace"], min(end, time.monotonic() + 15),
                                      {"type": "stream", "target": request["target"], "window": window})
            with connection:
                relay_host(connection, root, request, end, window)
            return
        if request["target"] is not None:
            raise Failure("invalid_request")
        authorize_stream(root, request, "discover")
        deadline = min(end, time.monotonic() + 15)
        with connect_host(root, request["workspace"], deadline, {"type": "control"}) as connection:
            response = host_request(connection, {"id": 1, "operation": request["mode"]}, deadline)
        if response.get("ok") is not True or type(response.get("result")) is not dict:
            raise Failure("host_unavailable")
        header = dict(response["result"], protocol=1, bytes=0)
        header["type"] = "windows" if request["mode"] == "windows" else "diagnostic"
        if request["mode"] == "diagnose":
            header["code"] = "permission_preflight"
            header["stage"] = "app_ready"
        raw = json.dumps(header).encode()
        if len(raw) > STREAM_HEADER_LIMIT:
            raise Failure("invalid_stream")
        authorize_stream(root, request, "discover")
        stream_write(1, struct.pack(">I", len(raw)) + raw, end)
    except (Failure, OSError, ValueError, KeyError, TypeError) as error:
        code = (str(error) if isinstance(error, Failure) else
                "stream_timeout" if isinstance(error, TimeoutError) else
                "host_unavailable" if isinstance(error, OSError) else "invalid_stream")
        if code not in STREAM_ERRORS:
            code = "invalid_stream"
        print("APPLETS_STREAM_ERROR:" + code, file=sys.stderr, flush=True)
        sys.exit(1)


if __name__ == "__main__":
    stream_main()

"""Appended to remote.py without main(); shares its storage and lease authority."""
import struct
import socket
import tempfile
import ctypes
from contextlib import contextmanager

STREAM_HEADER_LIMIT = 8192
STREAM_IMAGE_LIMIT = 4 * 1024 * 1024
STREAM_ERRORS = {"busy", "stale_lease", "lease_expired", "unsafe_state", "unsafe_peer",
                 "unsupported_host", "ipc_path_limit", "invalid_request", "invalid_stream",
                 "stream_timeout", "stream_closed", "stream_interrupted", "host_unavailable"}


def peer_uid(connection):
    if sys.platform == "darwin":
        uid, gid = ctypes.c_uint(), ctypes.c_uint()
        if ctypes.CDLL(None, use_errno=True).getpeereid(connection.fileno(), ctypes.byref(uid), ctypes.byref(gid)) != 0:
            raise Failure("unsafe_peer")
        return uid.value
    if sys.platform == "linux":
        return struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))[1]
    raise Failure("unsupported_host")


def stream_line(fd, limit, deadline):
    line = bytearray()
    while len(line) <= limit:
        value = stream_read(fd, 1, deadline)
        if value == b"\n":
            return bytes(line)
        line.extend(value)
    raise Failure("invalid_stream")


@contextmanager
def launch_host(root, request, arguments, end, control=False):
    proc = connection = None
    with tempfile.TemporaryDirectory(prefix="c-" if control else "s-", dir=str(root)) as directory:
        endpoint = Path(directory) / "io"
        if len(os.fsencode(endpoint)) >= 104:
            raise Failure("ipc_path_limit")
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
            listener.bind(str(endpoint))
            os.chmod(endpoint, 0o600)
            listener.listen(1)
            listener.settimeout(max(0.001, min(10, end - time.monotonic())))
            app = Path(request["workspace"]) / ".applets-host/Factory Relay.app"
            try:
                proc = subprocess.Popen(["/usr/bin/open", "-n", "-g", "-W", str(app),
                                         "--args", "control" if control else "connect", str(endpoint)],
                                        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                        stderr=subprocess.DEVNULL, start_new_session=True)
                connection, _ = listener.accept()
                if peer_uid(connection) != os.getuid():
                    raise Failure("unsafe_peer")
                listener.close()
                deadline = min(end, time.monotonic() + 10)
                hello = json.loads(stream_line(connection.fileno(), 1024, deadline))
                if (type(hello) is not dict or set(hello) != {"protocol", "type", "pid"} or hello["protocol"] != 1
                        or hello["type"] != "hello" or type(hello["pid"]) is not int or hello["pid"] <= 0):
                    raise Failure("invalid_stream")
                authorize_stream(root, request)
                if arguments is not None:
                    stream_write(connection.fileno(), json.dumps(arguments).encode() + b"\n", deadline)
                yield connection.fileno()
            finally:
                if connection:
                    try:
                        connection.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass
                    connection.close()
                if proc:
                    try:
                        proc.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        os.killpg(proc.pid, signal.SIGKILL)
                        proc.wait()


def authorize_stream(root, request):
    with private_open(root / "lock") as lock:
        until = time.monotonic() + 3
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
        return verify_lease(read_state(root), request)


def stream_read(fd, size, deadline):
    result = bytearray()
    with selectors.DefaultSelector() as selector:
        selector.register(fd, selectors.EVENT_READ)
        while len(result) < size:
            if time.monotonic() >= deadline:
                raise Failure("stream_timeout")
            if not selector.select(min(0.1, max(0, deadline - time.monotonic()))):
                continue
            chunk = os.read(fd, size - len(result))
            if not chunk:
                raise Failure("stream_closed")
            result.extend(chunk)
    return bytes(result)


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


def stream_main():
    os.umask(0o077)
    def interrupted(_signal, _frame):
        raise Failure("stream_interrupted")
    for signum in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, interrupted)
    try:
        # The request is one line; later bytes are individual frame acknowledgments.
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
        if (set(request) != {"owner", "workspace", "args", "mode", "target", "timeout"}
                or request["mode"] not in ("diagnose", "windows", "stream")
                or type(request["timeout"]) is not int or not 1 <= request["timeout"] <= 1800):
            raise Failure("invalid_request")
        root = private_directory(Path.home() / ".applets-control")
        authorize_stream(root, request)
        argv = [request["mode"]]
        if request["mode"] == "stream":
            target = request["target"]
            if (set(target) != {"windowId", "pid", "bundleId"}
                    or type(target["windowId"]) is not int or not 0 < target["windowId"] < 2**32
                    or type(target["pid"]) is not int or not 0 < target["pid"] < 2**31
                    or target["bundleId"] not in ("com.apple.iphonesimulator", "com.apple.dt.Devices", "com.factory.applets.RelayMac")):
                raise Failure("invalid_request")
            argv += [str(target["windowId"]), str(target["pid"]), target["bundleId"]]
        elif request["target"] is not None:
            raise Failure("invalid_request")
        end = time.monotonic() + request["timeout"]
        with launch_host(root, request, argv, end) as fd:
            relay_host(fd, root, request, end)
    except (Failure, OSError, ValueError, KeyError, TypeError) as error:
        code = (str(error) if isinstance(error, Failure) else
                "stream_timeout" if isinstance(error, TimeoutError) else
                "host_unavailable" if isinstance(error, OSError) else "invalid_stream")
        if code not in STREAM_ERRORS:
            code = "invalid_stream"
        print("APPLETS_STREAM_ERROR:" + code, file=sys.stderr, flush=True)
        sys.exit(1)


def relay_host(fd, root, request, end):
    while True:
        deadline = min(end, time.monotonic() + 10)
        prefix = stream_read(fd, 4, deadline)
        if prefix.startswith(b"{"):
            raw = bytearray(prefix)
            while len(raw) <= STREAM_HEADER_LIMIT and not raw.endswith(b"\n"):
                raw.extend(stream_read(fd, 1, deadline))
            header = json.loads(raw)
            if type(header) is not dict or header.get("type") not in ("diagnostic", "windows"):
                raise Failure("invalid_stream")
            header["bytes"] = 0
            raw = json.dumps(header).encode()
            image = b""
        else:
            length = struct.unpack(">I", prefix)[0]
            if not 0 < length <= STREAM_HEADER_LIMIT:
                raise Failure("invalid_stream")
            raw = stream_read(fd, length, deadline)
            header = json.loads(raw)
            if type(header) is not dict:
                raise Failure("invalid_stream")
            size = header["bytes"]
            if type(size) is not int or not (
                    (header.get("type") == "frame" and 0 < size <= STREAM_IMAGE_LIMIT)
                    or (header.get("type") == "heartbeat" and size == 0)):
                raise Failure("invalid_stream")
            image = stream_read(fd, size, deadline)
        if len(raw) > STREAM_HEADER_LIMIT:
            raise Failure("invalid_stream")
        authorize_stream(root, request)
        stream_write(1, struct.pack(">I", len(raw)) + raw + image, deadline)
        if header["type"] not in ("frame", "heartbeat"):
            return
        ack = stream_read(0, 1, min(end, time.monotonic() + 10))
        if ack != b"\x06":
            raise Failure("invalid_stream")
        authorize_stream(root, request)
        stream_write(fd, ack, min(end, time.monotonic() + 1))


if __name__ == "__main__":
    stream_main()

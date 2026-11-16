class Bridge:
    def __init__(self, deadline):
        self.deadline = deadline
        self.proc = subprocess.Popen(
            ["/usr/bin/xcrun", "mcpbridge"], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.proc.stdout, selectors.EVENT_READ, True)
        self.selector.register(self.proc.stderr, selectors.EVENT_READ, False)
        self.buffer = b""
        self.size = 0
        self.sequence = 0

    def send(self, value):
        try:
            self.proc.stdin.write((json.dumps(value) + "\n").encode())
            self.proc.stdin.flush()
        except OSError:
            raise Failure("bridge_closed")

    def rpc(self, method, params, deadline=None):
        deadline = min(deadline or self.deadline, self.deadline)
        if time.monotonic() >= deadline:
            raise Failure("command_timeout")
        self.sequence += 1
        sequence = self.sequence
        self.send({"jsonrpc": "2.0", "id": sequence, "method": method, "params": params})
        while time.monotonic() < deadline:
            while b"\n" in self.buffer:
                line, self.buffer = self.buffer.split(b"\n", 1)
                message = json.loads(line)
                if message.get("id") != sequence:
                    continue
                if "error" in message:
                    raise Failure("bridge_protocol_error")
                return message["result"]
            for key, _ in self.selector.select(0.1):
                chunk = os.read(key.fileobj.fileno(), 65536)
                if not chunk:
                    raise Failure("bridge_closed")
                self.size += len(chunk)
                if self.size > LIMIT:
                    raise Failure("command_output_limit")
                if key.data:
                    self.buffer += chunk
        raise Failure("command_timeout")

    def tool(self, name, arguments, deadline):
        result = self.rpc("tools/call", {"name": name, "arguments": arguments}, deadline)
        if result.get("isError"):
            with private_open(DIAGNOSTIC_ROOT / (DIAGNOSTIC_OPERATION + "-error.json")) as handle:
                handle.seek(0)
                json.dump(result, handle)
                handle.truncate()
            if any(item.get("type") == "text" and item.get("text", "").startswith(
                    "This agent isn't approved to use Xcode's tools yet.") for item in result.get("content", [])):
                raise Failure("bridge_approval_required")
            for item in result.get("content", []):
                if item.get("type") == "text":
                    try:
                        detail = json.loads(item["text"])
                        if detail.get("type") == "error" and detail.get("data", "").startswith("Cannot select specified device."):
                            raise Failure("target_unavailable")
                        if detail.get("type") == "error" and detail.get("data", "").startswith(
                                "This session identifier is currently in use or was recently used."):
                            raise Failure("session_identifier_conflict")
                    except (ValueError, AttributeError):
                        pass
            raise Failure("bridge_tool_error")
        if "structuredContent" in result:
            return result["structuredContent"]
        return json.loads(next(item["text"] for item in result["content"] if item["type"] == "text"))

    def close(self):
        try:
            os.killpg(self.proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        self.proc.wait()
        self.selector.close()
        for stream in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
            try:
                stream.close()
            except OSError:
                pass

import base64
import hashlib
import math
import struct
import tempfile
import zlib

FRAME_LIMIT = 512 * 1024
OBSERVATION_TTL = 120


def read_bounded_file(path, limit):
    fd = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or not 0 < info.st_size <= limit:
            raise Failure("invalid_visual_artifact")
        data = handle.read(limit + 1)
    if len(data) > limit:
        raise Failure("invalid_visual_artifact")
    return data


def bridge_artifact(path, limit):
    value = Path(path)
    allowed = Path(tempfile.gettempdir()).resolve() / "ActionArtifacts"
    if not value.is_absolute() or not value.resolve().is_relative_to(allowed):
        raise Failure("invalid_visual_artifact")
    return read_bounded_file(value, limit)


def png_dimensions(data):
    if not data.startswith(b"\x89PNG\r\n\x1a\n") or data[12:16] != b"IHDR":
        raise Failure("invalid_visual_artifact")
    offset = 8
    width = height = 0
    data_seen = False
    while offset + 12 <= len(data):
        size = struct.unpack(">I", data[offset:offset + 4])[0]
        end = offset + 12 + size
        if end > len(data):
            raise Failure("invalid_visual_artifact")
        kind = data[offset + 4:offset + 8]
        chunk = data[offset + 4:offset + 8 + size]
        checksum = struct.unpack(">I", data[offset + 8 + size:end])[0]
        if zlib.crc32(chunk) & 0xffffffff != checksum:
            raise Failure("invalid_visual_artifact")
        if offset == 8:
            if size != 13:
                raise Failure("invalid_visual_artifact")
            width, height = struct.unpack(">II", data[offset + 8:offset + 16])
            if not 0 < width <= 8192 or not 0 < height <= 8192 or width * height > 32000000:
                raise Failure("invalid_visual_artifact")
        if kind == b"IDAT" and size > 0:
            data_seen = True
        if kind == b"IEND":
            if size != 0 or end != len(data) or not data_seen:
                raise Failure("invalid_visual_artifact")
            return width, height
        offset = end
    raise Failure("invalid_visual_artifact")


def parse_hierarchy(raw, bundle):
    body = raw.decode("utf8")
    if not re.search(r"^Application bundle identifier: " + re.escape(bundle) + r"$", body, re.M):
        raise Failure("application_mismatch")
    elements = []
    for line in body.splitlines():
        kind = re.match(r"^\s*(Button|StaticText),", line)
        identifier = re.search(r"identifier: '([^'\r\n]{1,128})'", line)
        point = re.search(r"hitPoint: \{([0-9.]+), ([0-9.]+)\}", line)
        if not kind or not identifier or not point:
            continue
        x, y = map(float, point.groups())
        if not all(math.isfinite(v) and 0 <= v <= 8192 for v in (x, y)):
            raise Failure("invalid_remote_output")
        label = re.search(r"label: '([^'\r\n]{0,256})'", line)
        elements.append({"id": identifier[1], "type": kind[1], "label": label[1] if label else "",
                         "hitPoint": {"x": x, "y": y}})
    if len(elements) > 256:
        raise Failure("invalid_remote_output")
    return elements


def visual_scope(args):
    return {"udid": str(uuid.UUID(args["udid"])), "bundleId": args["bundleId"], "target": args["target"]}


def current_observation(root, request):
    try:
        data = json.loads(read_bounded_file(root / "observation.json", 65536))
        if (data["id"] != request["args"]["observationId"] or data["owner"] != request["owner"]
                or data["generation"] != request["args"]["lease"]["generation"]
                or data["workspace"] != request["workspace"]
                or not 0 <= time.time() - data["createdAt"] <= OBSERVATION_TTL):
            raise Failure("observation_stale")
        return data
    except (FileNotFoundError, ValueError, KeyError):
        raise Failure("observation_stale")


def perform_visual(request, root, state, deadline):
    operation, args = request["operation"], request["args"]
    verify_lease(state, request)
    if operation == "frame":
        record = current_observation(root, request)
        data = read_bounded_file(root / "artifacts" / (record["id"] + ".png"), FRAME_LIMIT)
        width, height = png_dimensions(data)
        digest = hashlib.sha256(data).hexdigest()
        if digest != record["sha256"]:
            raise Failure("invalid_visual_artifact")
        if time.monotonic() >= deadline:
            raise Failure("command_timeout")
        verify_lease(state, request)
        return {"observationId": record["id"], "mediaType": "image/png", "base64": base64.b64encode(data).decode(),
                "sha256": digest, "width": width, "height": height, "bytes": len(data)}
    deadline = min(deadline, time.monotonic() + 120)
    if deadline - time.monotonic() < 15:
        raise Failure("command_timeout")
    action_deadline = deadline - 10
    artifacts = private_directory(root / "artifacts")
    if len(list(artifacts.glob("*.png"))) >= 100:
        raise Failure("artifact_limit")
    scope = visual_scope(args)
    previous = None
    if operation == "tap":
        previous = current_observation(root, request)
        if previous["scope"] != scope:
            raise Failure("target_mismatch")
    project = workspace_path(request["workspace"], args["target"]["path"])
    listed = simulator_list(execute([APPLE["xcrun"], "simctl", "list", "devices", "--json"], action_deadline))["devices"]
    if not any(d["udid"] == scope["udid"] and d["available"] and d["state"] == "Booted" for d in listed):
        raise Failure("target_not_booted")
    (root / "observation.json").unlink(missing_ok=True)
    with private_open(root / "inflight") as marker:
        marker.write(str(os.getpid()))
        marker.flush()
        os.fsync(marker.fileno())
    bridge = None
    key = None
    pending = False
    captured = None
    started_at = time.monotonic()
    try:
        bridge = Bridge(deadline)
        bridge.rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {},
                                 "clientInfo": {"name": "applets-guarded-probe", "version": "1"}}, action_deadline)
        bridge.send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        bridge.tool("XcodeOpenWorkspace", {"path": project}, action_deadline)
        pending = True
        try:
            selected = bridge.tool("DeviceInteractionStartSession",
                                   {"deviceIdentifier": scope["udid"], "sessionIdentifier": "Factory Visual QA " + secrets.token_hex(8)},
                                   action_deadline)
        except Failure as error:
            if str(error) in ("bridge_approval_required", "target_unavailable", "session_identifier_conflict"):
                pending = False
            raise
        key = selected["interactionSessionKey"]
        if not isinstance(key, str) or not 0 < len(key) <= 1024:
            raise Failure("invalid_remote_output")
        with private_open(root / "bridge-session.json") as handle:
            json.dump({"key": key, "udid": scope["udid"], "generation": state["generation"]}, handle)
            handle.flush()
            os.fsync(handle.fileno())
        pending = False
        if str(uuid.UUID(selected["deviceUUID"])) != scope["udid"] or selected["deviceIsSimulator"] is not True:
            raise Failure("target_mismatch")
        verify_lease(state, request)
        observed = bridge.tool("DeviceInteractionSynthesize",
                               {"interactSessionKey": key, "activationBundleId": scope["bundleId"]}, action_deadline)
        hierarchy = bridge_artifact(observed["hierarchyPath"], 131072)
        elements = parse_hierarchy(hierarchy, scope["bundleId"])
        if previous:
            if hashlib.sha256(hierarchy).hexdigest() != previous["hierarchyHash"]:
                raise Failure("observation_stale")
            choices = [e for e in elements if e["id"] == args["elementId"] and e["type"] == "Button"]
            if len(choices) != 1:
                raise Failure("element_unavailable")
            point = choices[0]["hitPoint"]
            verify_lease(state, request)
            observed = bridge.tool("DeviceInteractionSynthesize",
                                   {"interactSessionKey": key,
                                    "interactionCommand": "t {:g} {:g}".format(point["x"], point["y"])}, action_deadline)
            hierarchy = bridge_artifact(observed["hierarchyPath"], 131072)
            elements = parse_hierarchy(hierarchy, scope["bundleId"])
        png = bridge_artifact(observed["screenshotPath"], FRAME_LIMIT)
        width, height = png_dimensions(png)
        captured = {"png": png, "hierarchy": hierarchy, "elements": elements, "width": width, "height": height}
    finally:
        try:
            if bridge and key:
                bridge.tool("DeviceInteractionEndSession", {"interactionSessionKey": key}, deadline)
                (root / "bridge-session.json").unlink()
                key = None
        finally:
            if bridge:
                bridge.close()
            if key is None and not pending:
                (root / "inflight").unlink(missing_ok=True)
    verify_lease(state, request)
    identifier = secrets.token_hex(16)
    artifacts = private_directory(root / "artifacts")
    png = captured.pop("png")
    hierarchy = captured.pop("hierarchy")
    artifact = artifacts / (identifier + ".png")
    fd = os.open(str(artifact), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as handle:
        handle.write(png)
    record = {"id": identifier, "owner": request["owner"], "generation": state["generation"],
              "workspace": request["workspace"], "scope": scope, "createdAt": time.time(),
              "sha256": hashlib.sha256(png).hexdigest(), "hierarchyHash": hashlib.sha256(hierarchy).hexdigest()}
    with private_open(root / "observation.json") as handle:
        handle.seek(0)
        json.dump(record, handle)
        handle.truncate()
        handle.flush()
        os.fsync(handle.fileno())
    verify_lease(state, request)
    return {"observationId": identifier, "scope": scope, "expiresAt": record["createdAt"] + OBSERVATION_TTL,
            "evidenceKind": "observation", **captured, "remoteElapsedMs": round((time.monotonic() - started_at) * 1000)}

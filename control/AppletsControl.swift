import AppKit
import ApplicationServices
import Darwin

enum ControlError: String, Error {
    case invalidRequest = "invalid_request", inaccessible = "accessibility_required"
    case targetMismatch = "target_mismatch", stale = "observation_stale"
    case unavailable = "element_unavailable", uncertain = "action_uncertain"
    case timeout = "control_timeout", disconnected = "control_closed"
}

struct ControlTarget: Codable, Equatable {
    let windowId: UInt32
    let pid: Int32
    let bundleId: String
}
struct ControlElement: Codable, Equatable {
    let id: String
    let role: String
    let value: String
    let enabled: Bool
}
struct ControlSnapshot: Codable, Equatable {
    let target: ControlTarget
    let windowRectPoints: [Double]
    let processStartedAt: Double
    let elements: [ControlElement]
}
struct ControlRequest: Decodable {
    let operation: String
    let target: ControlTarget?
    let expected: ControlSnapshot?
    let elementId: String?
}

func controlWriteJSON(_ value: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) + Data([10])
    guard data.count <= 16384 else { throw ControlError.invalidRequest }
    try data.withUnsafeBytes { bytes in
        var offset = 0
        while offset < bytes.count {
            let count = Darwin.write(STDOUT_FILENO, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
            guard count > 0 else { throw ControlError.disconnected }
            offset += count
        }
    }
}

func controlConnect(_ path: String) throws {
    let url = URL(fileURLWithPath: path)
    let directory = url.deletingLastPathComponent()
    let root = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".applets-control")
    guard url.lastPathComponent == "io", directory.deletingLastPathComponent().path == root.path,
          directory.lastPathComponent.hasPrefix("c-"), path.utf8.count < 104 else {
        throw ControlError.invalidRequest
    }
    for (item, kind, mode) in [(root.path, S_IFDIR, 0o700),
                               (directory.path, S_IFDIR, 0o700), (path, S_IFSOCK, 0o600)] {
        var info = stat()
        guard lstat(item, &info) == 0, info.st_uid == geteuid(),
              info.st_mode & S_IFMT == kind, info.st_mode & 0o777 == mode else {
            throw ControlError.invalidRequest
        }
    }
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { throw ControlError.disconnected }
    defer { close(fd) }
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    withUnsafeMutableBytes(of: &address.sun_path) { destination in
        path.utf8CString.withUnsafeBytes { destination.copyBytes(from: $0) }
    }
    let connected = withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
        }
    }
    var uid: uid_t = 0
    var gid: gid_t = 0
    guard connected == 0, getpeereid(fd, &uid, &gid) == 0, uid == geteuid(),
          dup2(fd, STDIN_FILENO) >= 0, dup2(fd, STDOUT_FILENO) >= 0 else {
        throw ControlError.disconnected
    }
    try controlWriteJSON(["protocol": 1, "type": "hello", "pid": getpid()])
}

func controlReadRequest() throws -> ControlRequest {
    var data = Data()
    let end = ProcessInfo.processInfo.systemUptime + 10
    while data.count <= 16384 && ProcessInfo.processInfo.systemUptime < end {
        var item = pollfd(fd: STDIN_FILENO, events: Int16(POLLIN), revents: 0)
        guard poll(&item, 1, 100) >= 0 else { throw ControlError.disconnected }
        if item.revents & Int16(POLLIN) != 0 {
            var byte: UInt8 = 0
            guard Darwin.read(STDIN_FILENO, &byte, 1) == 1 else { throw ControlError.disconnected }
            if byte == 10 { return try JSONDecoder().decode(ControlRequest.self, from: data) }
            data.append(byte)
        } else if item.revents & Int16(POLLHUP | POLLERR) != 0 { throw ControlError.disconnected }
    }
    throw ControlError.timeout
}

@MainActor
enum Control {
    static func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
        return value
    }

    static func geometry(_ element: AXUIElement) -> CGRect? {
        guard let p = attribute(element, kAXPositionAttribute), CFGetTypeID(p) == AXValueGetTypeID(),
              let s = attribute(element, kAXSizeAttribute), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
        var point = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(p as! AXValue, .cgPoint, &point),
              AXValueGetValue(s as! AXValue, .cgSize, &size) else { return nil }
        return CGRect(origin: point, size: size)
    }

    static func snapshot(_ target: ControlTarget, until: Double) throws -> (ControlSnapshot, AXUIElement) {
        guard target.bundleId == "com.factory.applets.RelayMac", target.pid > 0, target.windowId > 0,
              let app = NSRunningApplication(processIdentifier: target.pid),
              app.bundleIdentifier == target.bundleId, !app.isTerminated,
              let started = app.launchDate,
              let rows = CGWindowListCopyWindowInfo(.optionIncludingWindow, target.windowId) as? [[String: Any]],
              rows.count == 1, let row = rows.first,
              row[kCGWindowNumber as String] as? UInt32 == target.windowId,
              row[kCGWindowOwnerPID as String] as? Int32 == target.pid,
              row[kCGWindowLayer as String] as? Int == 0,
              row[kCGWindowIsOnscreen as String] as? Bool == true,
              let bounds = row[kCGWindowBounds as String] as? NSDictionary,
              let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary),
              rect.width > 0, rect.height > 0 else { throw ControlError.targetMismatch }
        let application = AXUIElementCreateApplication(target.pid)
        AXUIElementSetMessagingTimeout(application, 0.15)
        guard let windows = attribute(application, kAXWindowsAttribute) as? [AXUIElement],
              windows.count <= 32 else { throw ControlError.targetMismatch }
        // Public AX has no documented CGWindowID attribute. Ambiguous geometry is rejected.
        let matches = windows.filter { geometry($0) == rect }
        guard matches.count == 1 else { throw ControlError.targetMismatch }
        let window = matches[0]
        var elements: [ControlElement] = []
        var button: AXUIElement?
        var queue: [(AXUIElement, Int)] = [(window, 0)]
        var visited = 0
        while !queue.isEmpty {
            guard ProcessInfo.processInfo.systemUptime < until, visited < 128 else { throw ControlError.timeout }
            let (node, depth) = queue.removeFirst()
            visited += 1
            var pid: pid_t = 0
            guard AXUIElementGetPid(node, &pid) == .success, pid == target.pid else { throw ControlError.targetMismatch }
            let id = attribute(node, kAXIdentifierAttribute) as? String ?? ""
            if ["relay-count", "relay-increment"].contains(id) {
                guard let role = attribute(node, kAXRoleAttribute) as? String else { throw ControlError.unavailable }
                let value = (attribute(node, kAXValueAttribute) as? String)
                    ?? (attribute(node, kAXTitleAttribute) as? String) ?? ""
                guard value.utf8.count <= 512 else { throw ControlError.unavailable }
                elements.append(ControlElement(id: id, role: role, value: value,
                    enabled: attribute(node, kAXEnabledAttribute) as? Bool ?? false))
                if id == "relay-increment" { button = node }
            }
            if let children = attribute(node, kAXChildrenAttribute) as? [AXUIElement], !children.isEmpty {
                guard depth < 12, queue.count + children.count + visited <= 128 else { throw ControlError.unavailable }
                queue += children.map { ($0, depth + 1) }
            }
        }
        guard elements.count == 2,
              elements.filter({ $0.id == "relay-count" && $0.role == kAXStaticTextRole }).count == 1,
              elements.filter({ $0.id == "relay-increment" && $0.role == kAXButtonRole && $0.enabled }).count == 1,
              let button else { throw ControlError.unavailable }
        return (ControlSnapshot(target: target, windowRectPoints: [rect.minX, rect.minY, rect.width, rect.height],
                         processStartedAt: started.timeIntervalSince1970,
                         elements: elements.sorted { $0.id < $1.id }), button)
    }

    static func perform(_ request: ControlRequest) throws -> [String: Any] {
        guard ["diagnose", "observe", "press"].contains(request.operation) else { throw ControlError.invalidRequest }
        if request.operation == "diagnose" {
            guard request.target == nil, request.expected == nil, request.elementId == nil else { throw ControlError.invalidRequest }
            return ["type": "diagnostic", "bundleId": Bundle.main.bundleIdentifier ?? "",
                    "bundlePath": Bundle.main.bundlePath, "executablePath": Bundle.main.executablePath ?? "",
                    "accessibility": AXIsProcessTrusted(), "screenRecording": CGPreflightScreenCaptureAccess(),
                    "permissionRequested": false,
                    "launchMode": "launchservices-ipc", "processId": getpid(), "parentProcessId": getppid(),
                    "lifecycle": HostLifecycle.diagnostics]
        }
        guard AXIsProcessTrusted() else { throw ControlError.inaccessible }
        guard let target = request.target else { throw ControlError.invalidRequest }
        let until = ProcessInfo.processInfo.systemUptime + 1.5
        let (current, button) = try snapshot(target, until: until)
        if request.operation == "observe" {
            guard request.expected == nil, request.elementId == nil else { throw ControlError.invalidRequest }
            return ["type": "observation", "snapshot": try JSONSerialization.jsonObject(with: JSONEncoder().encode(current))]
        }
        guard request.elementId == "relay-increment", request.expected == current else { throw ControlError.stale }
        guard let owningWindow = attribute(button, kAXWindowAttribute),
              CFGetTypeID(owningWindow) == AXUIElementGetTypeID(),
              geometry(owningWindow as! AXUIElement)
                == CGRect(x: current.windowRectPoints[0], y: current.windowRectPoints[1],
                          width: current.windowRectPoints[2], height: current.windowRectPoints[3]),
              ProcessInfo.processInfo.systemUptime < until else { throw ControlError.stale }
        // A messaging timeout can mean the action happened. Never retry an uncertain press.
        guard AXUIElementPerformAction(button, kAXPressAction as CFString) == .success else { throw ControlError.uncertain }
        return ["type": "pressed", "elementId": "relay-increment"]
    }

    static func run() async {
        let args = Array(CommandLine.arguments.dropFirst())
        guard args.count == 2, args[0] == "control" else { return }
        do {
            try await Task.detached { try controlConnect(args[1]) }.value
            let watchdog = DispatchSource.makeTimerSource(queue: .global())
            let end = ProcessInfo.processInfo.systemUptime + 15
            watchdog.schedule(deadline: .now(), repeating: .milliseconds(100))
            watchdog.setEventHandler {
                var byte: UInt8 = 0
                let count = recv(STDIN_FILENO, &byte, 1, MSG_PEEK | MSG_DONTWAIT)
                if count == 0 || (count < 0 && errno != EAGAIN && errno != EINTR)
                    || ProcessInfo.processInfo.systemUptime > end { exit(0) }
            }
            watchdog.resume()
            defer { watchdog.cancel() }
            let request = try await Task.detached { try controlReadRequest() }.value
            do { try controlWriteJSON(["ok": true, "result": try perform(request)]) }
            catch { try controlWriteJSON(["ok": false, "error": (error as? ControlError)?.rawValue ?? "invalid_request"]) }
        } catch {}
    }
}

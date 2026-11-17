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
    let windowId: UInt32?
    let pid: Int32?
    let bundleId: String?
    let kind: String?
    let displayId: UInt32?
    let displayUUID: String?
    var isDesktop: Bool { kind == "desktop" }

    init(windowId: UInt32, pid: Int32, bundleId: String) {
        self.windowId = windowId; self.pid = pid; self.bundleId = bundleId
        kind = nil; displayId = nil; displayUUID = nil
    }
    init(displayId: UInt32, displayUUID: String) {
        windowId = nil; pid = nil; bundleId = nil
        kind = "desktop"; self.displayId = displayId; self.displayUUID = displayUUID
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: TargetKey.self)
        let keys = Set(c.allKeys.map(\.stringValue))
        if keys == Set(["kind", "displayId", "displayUUID"]) {
            let kind = try c.decode(String.self, forKey: TargetKey("kind"))
            let id = try c.decode(UInt32.self, forKey: TargetKey("displayId"))
            let uuid = try c.decode(String.self, forKey: TargetKey("displayUUID"))
            guard kind == "desktop", id > 0, validDisplayUUID(uuid) else { throw ControlError.invalidRequest }
            self.init(displayId: id, displayUUID: uuid)
        } else {
            guard keys == Set(["windowId", "pid", "bundleId"]) else { throw ControlError.invalidRequest }
            let id = try c.decode(UInt32.self, forKey: TargetKey("windowId"))
            let pid = try c.decode(Int32.self, forKey: TargetKey("pid"))
            let bundle = try c.decode(String.self, forKey: TargetKey("bundleId"))
            guard id > 0, pid > 0, bundle.utf8.count <= 255,
                  bundle.range(of: "^[A-Za-z0-9._-]*$", options: .regularExpression) != nil else { throw ControlError.invalidRequest }
            self.init(windowId: id, pid: pid, bundleId: bundle)
        }
    }
}
struct TargetKey: CodingKey {
    let stringValue: String
    let intValue: Int? = nil
    init(_ value: String) { stringValue = value }
    init?(stringValue: String) { self.init(stringValue) }
    init?(intValue: Int) { return nil }
}
func validDisplayUUID(_ value: String) -> Bool {
    value.utf8.count == 36 && value.range(of: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", options: .regularExpression) != nil
}
func processStartTime(_ pid: Int32) -> Double? {
    var info = proc_bsdinfo()
    let size = Int32(MemoryLayout<proc_bsdinfo>.size)
    guard pid > 0, proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size,
          info.pbi_start_tvsec > 0 else { return nil }
    return Double(info.pbi_start_tvsec) + Double(info.pbi_start_tvusec) / 1_000_000
}
struct DisplayConfiguration: Codable, Equatable {
    let boundsPoints: [Double]
    let pixelWidth: Int
    let pixelHeight: Int
    let rotation: Double
    let scaleX: Double
    let scaleY: Double

    static func identity(_ id: UInt32) throws -> String {
        guard id > 0, CGDisplayIsOnline(id) != 0, CGDisplayIsActive(id) != 0,
              let uuid = CGDisplayCreateUUIDFromDisplayID(id)?.takeRetainedValue() else { throw ControlError.targetMismatch }
        return (CFUUIDCreateString(nil, uuid)! as String).lowercased()
    }
    static func current(_ target: ControlTarget) throws -> DisplayConfiguration {
        guard target.isDesktop, let id = target.displayId, let uuid = target.displayUUID,
              validDisplayUUID(uuid), try identity(id) == uuid,
              let mode = CGDisplayCopyDisplayMode(id) else { throw ControlError.targetMismatch }
        let r = CGDisplayBounds(id), rotation = CGDisplayRotation(id)
        guard [r.minX, r.minY, r.width, r.height, rotation].allSatisfy({ $0.isFinite }),
              r.width > 0, r.height > 0, r.width <= 16384, r.height <= 16384,
              mode.pixelWidth > 0, mode.pixelHeight > 0, mode.pixelWidth <= 32768, mode.pixelHeight <= 32768,
              rotation >= 0, rotation < 360 else { throw ControlError.targetMismatch }
        let sx = Double(mode.pixelWidth) / r.width, sy = Double(mode.pixelHeight) / r.height
        guard sx > 0, sy > 0, sx <= 16, sy <= 16 else { throw ControlError.targetMismatch }
        return DisplayConfiguration(boundsPoints: [r.minX, r.minY, r.width, r.height],
            pixelWidth: mode.pixelWidth, pixelHeight: mode.pixelHeight, rotation: rotation, scaleX: sx, scaleY: sy)
    }
}
struct ControlElement: Codable, Equatable {
    let id: String
    let role: String
    let value: String
    let enabled: Bool
}
struct ControlSnapshot: Codable, Equatable {
    let target: ControlTarget
    var windowRectPoints: [Double]? = nil
    var processStartedAt: Double? = nil
    var displayConfiguration: DisplayConfiguration? = nil
    let elements: [ControlElement]
    var rectPoints: [Double] { displayConfiguration?.boundsPoints ?? windowRectPoints ?? [] }
}
struct ControlRequest: Decodable {
    let operation: String
    let target: ControlTarget?
    let expected: ControlSnapshot?
    let elementId: String?
    let mouse: MouseCommand?
    let mode: String?
}

struct MouseCommand: Decodable {
    let kind: String
    let x: Double
    let y: Double
    let button: String?
    let count: Int?
    let toX: Double?
    let toY: Double?
    let durationMs: Int?
    let deltaX: Int?
    let deltaY: Int?
}

// The watchdog must release a held button even when the IPC peer disappears.
final class MouseRelease: @unchecked Sendable {
    static let shared = MouseRelease()
    private let lock = NSLock()
    private var held: CGEvent?
    private var cancelled = false
    func down(_ point: CGPoint, _ button: CGMouseButton, count: Int64 = 1) throws {
        lock.lock()
        defer { lock.unlock() }
        guard !cancelled else { throw ControlError.disconnected }
        guard let event = CGEvent(mouseEventSource: nil,
            mouseType: button == .left ? .leftMouseDown : .rightMouseDown,
            mouseCursorPosition: point, mouseButton: button),
              let release = CGEvent(mouseEventSource: nil,
                mouseType: button == .left ? .leftMouseUp : .rightMouseUp,
                mouseCursorPosition: point, mouseButton: button) else { throw ControlError.uncertain }
        held = release
        event.setIntegerValueField(.mouseEventClickState, value: count)
        event.post(tap: .cghidEventTap)
    }
    func post(_ event: CGEvent, at point: CGPoint) throws {
        lock.lock()
        defer { lock.unlock() }
        guard !cancelled else { throw ControlError.disconnected }
        held?.location = point
        event.post(tap: .cghidEventTap)
    }
    func release(count: Int64 = 1, cancel: Bool = false) {
        lock.lock()
        defer { lock.unlock() }
        if cancel { cancelled = true }
        guard let event = held else { return }
        event.setIntegerValueField(.mouseEventClickState, value: count)
        event.post(tap: .cghidEventTap)
        held = nil
    }
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

    static func identitySnapshot(_ target: ControlTarget) throws -> ControlSnapshot {
        if target.isDesktop {
            return ControlSnapshot(target: target, displayConfiguration: try DisplayConfiguration.current(target), elements: [])
        }
        guard let bundleId = target.bundleId, let pid = target.pid, let windowId = target.windowId,
              bundleId.utf8.count <= 255,
              bundleId.range(of: "^[A-Za-z0-9._-]*$", options: .regularExpression) != nil,
              !["com.factory.applets.host", "com.apple.iphonesimulator", "com.apple.dt.Devices"].contains(bundleId),
              pid > 0, windowId > 0,
              let app = NSRunningApplication(processIdentifier: pid),
              (app.bundleIdentifier ?? "") == bundleId, !app.isTerminated,
              let started = processStartTime(pid),
              let rows = CGWindowListCopyWindowInfo(.optionIncludingWindow, windowId) as? [[String: Any]],
              rows.count == 1, let row = rows.first,
              row[kCGWindowNumber as String] as? UInt32 == target.windowId,
              row[kCGWindowOwnerPID as String] as? Int32 == target.pid,
              row[kCGWindowLayer as String] as? Int == 0,
              row[kCGWindowIsOnscreen as String] as? Bool == true,
              let bounds = row[kCGWindowBounds as String] as? NSDictionary,
              let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary),
              [rect.minX, rect.minY, rect.width, rect.height].allSatisfy({ $0.isFinite }),
              rect.width > 0, rect.height > 0, rect.width <= 16384, rect.height <= 16384 else { throw ControlError.targetMismatch }
        return ControlSnapshot(target: target, windowRectPoints: [rect.minX, rect.minY, rect.width, rect.height],
            processStartedAt: started, elements: [])
    }

    static func snapshot(_ target: ControlTarget, until: Double) throws -> (ControlSnapshot, AXUIElement?) {
        let identity = try identitySnapshot(target)
        if target.bundleId != "com.factory.applets.RelayMac" { return (identity, nil) }
        let r = identity.rectPoints
        let rect = CGRect(x: r[0], y: r[1], width: r[2], height: r[3])
        guard let pid = target.pid else { throw ControlError.targetMismatch }
        let application = AXUIElementCreateApplication(pid)
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
                         processStartedAt: identity.processStartedAt,
                         elements: elements.sorted { $0.id < $1.id }), button)
    }

    static func mouse(_ command: MouseCommand, expected: ControlSnapshot) throws {
        let coordinate: (Double) -> Bool = { $0.isFinite && $0 >= 0 && $0 < 1 }
        guard coordinate(command.x), coordinate(command.y),
              ["move", "click", "drag", "scroll"].contains(command.kind) else { throw ControlError.invalidRequest }
        switch command.kind {
        case "click":
            guard ["left", "right"].contains(command.button ?? ""), (1...2).contains(command.count ?? 0) else { throw ControlError.invalidRequest }
        case "drag":
            guard let x = command.toX, let y = command.toY, coordinate(x), coordinate(y),
                  (100...1000).contains(command.durationMs ?? 0) else { throw ControlError.invalidRequest }
        case "scroll":
            guard let dx = command.deltaX, let dy = command.deltaY,
                  (-600...600).contains(dx), (-600...600).contains(dy) else { throw ControlError.invalidRequest }
        default: break
        }
        let r = expected.rectPoints
        guard r.count == 4 else { throw ControlError.stale }
        func point(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: r[0] + x * r[2], y: r[1] + y * r[3]) }
        let until = ProcessInfo.processInfo.systemUptime + 1.8
        let system = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(system, 0.1)
        func validate(_ point: CGPoint) throws {
            let current = try identitySnapshot(expected.target)
            guard current.windowRectPoints == expected.windowRectPoints,
                  current.processStartedAt == expected.processStartedAt,
                  current.displayConfiguration == expected.displayConfiguration,
                  ProcessInfo.processInfo.systemUptime < until else { throw ControlError.stale }
            var displays = [CGDirectDisplayID](repeating: 0, count: 32)
            var displayCount: UInt32 = 0
            guard CGGetActiveDisplayList(32, &displays, &displayCount) == .success,
                  displays.prefix(Int(displayCount)).contains(where: { CGDisplayBounds($0).contains(point) })
                else { throw ControlError.targetMismatch }
            var byte: UInt8 = 0
            let count = recv(STDIN_FILENO, &byte, 1, MSG_PEEK | MSG_DONTWAIT)
            guard count != 0, count >= 0 || errno == EAGAIN || errno == EINTR else { throw ControlError.disconnected }
            if expected.target.isDesktop {
                guard CGPreflightScreenCaptureAccess(), CGPreflightPostEventAccess(),
                      let session = CGSessionCopyCurrentDictionary() as? [String: Any],
                      session[kCGSessionOnConsoleKey as String] as? Bool == true,
                      session[kCGSessionLoginDoneKey as String] as? Bool == true,
                      CGRect(x: r[0], y: r[1], width: r[2], height: r[3]).contains(point) else { throw ControlError.inaccessible }
                return
            }
            guard NSWorkspace.shared.frontmostApplication?.processIdentifier == expected.target.pid else { throw ControlError.stale }
            guard let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]],
                  let top = rows.first(where: { row in
                      guard (row[kCGWindowAlpha as String] as? Double ?? 1) > 0,
                            let bounds = row[kCGWindowBounds as String] as? NSDictionary,
                            let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary) else { return false }
                      return rect.contains(point)
                  }),
                  top[kCGWindowNumber as String] as? UInt32 == expected.target.windowId,
                  top[kCGWindowOwnerPID as String] as? Int32 == expected.target.pid else { throw ControlError.targetMismatch }
            var hit: AXUIElement?
            var hitPID: pid_t = 0
            guard AXUIElementCopyElementAtPosition(system, Float(point.x), Float(point.y), &hit) == .success,
                  let hit, AXUIElementGetPid(hit, &hitPID) == .success,
                  hitPID == expected.target.pid else { throw ControlError.targetMismatch }
        }
        let start = point(command.x, command.y)
        try validate(start)
        var dispatched = false
        defer { MouseRelease.shared.release() }
        func post(_ type: CGEventType, _ point: CGPoint) throws {
            try validate(point)
            guard let event = CGEvent(mouseEventSource: nil, mouseType: type,
                mouseCursorPosition: point, mouseButton: .left) else { throw ControlError.uncertain }
            dispatched = true
            try MouseRelease.shared.post(event, at: point)
        }
        do {
            try post(.mouseMoved, start)
            switch command.kind {
            case "click":
                for index in 1...(command.count ?? 1) {
                    try validate(start)
                    try MouseRelease.shared.down(start, command.button == "right" ? .right : .left, count: Int64(index))
                    Thread.sleep(forTimeInterval: 0.03)
                    // Mouse-down may open a menu. Releasing the held button must still complete.
                    MouseRelease.shared.release(count: Int64(index))
                    if index < (command.count ?? 1) { Thread.sleep(forTimeInterval: 0.06) }
                }
            case "drag":
                try validate(start)
                try MouseRelease.shared.down(start, .left)
                let steps = max(2, (command.durationMs ?? 100) / 20)
                for index in 1...steps {
                    Thread.sleep(forTimeInterval: Double(command.durationMs ?? 100) / Double(steps) / 1000)
                    let t = Double(index) / Double(steps)
                    try post(.leftMouseDragged, point(command.x + (command.toX! - command.x) * t,
                        command.y + (command.toY! - command.y) * t))
                }
                MouseRelease.shared.release()
            case "scroll":
                try validate(start)
                guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2,
                    wheel1: Int32(command.deltaY ?? 0), wheel2: Int32(command.deltaX ?? 0), wheel3: 0) else { throw ControlError.uncertain }
                event.location = start
                try MouseRelease.shared.post(event, at: start)
            default: break
            }
        } catch {
            if dispatched { throw ControlError.uncertain }
            throw error
        }
    }

    static func perform(_ request: ControlRequest) throws -> [String: Any] {
        guard ["diagnose", "observe", "press", "mouse"].contains(request.operation) else { throw ControlError.invalidRequest }
        if request.operation == "diagnose" {
            guard request.target == nil, request.expected == nil, request.elementId == nil,
                  request.mouse == nil, request.mode == nil else { throw ControlError.invalidRequest }
            return ["type": "diagnostic", "bundleId": Bundle.main.bundleIdentifier ?? "",
                    "bundlePath": Bundle.main.bundlePath, "executablePath": Bundle.main.executablePath ?? "",
                    "accessibility": AXIsProcessTrusted(), "screenRecording": CGPreflightScreenCaptureAccess(),
                    "permissionRequested": false,
                    "launchMode": "launchservices-ipc", "processId": getpid(), "parentProcessId": getppid(),
                    "lifecycle": HostLifecycle.diagnostics]
        }
        guard AXIsProcessTrusted() else { throw ControlError.inaccessible }
        guard let target = request.target else { throw ControlError.invalidRequest }
        if let mode = request.mode {
            guard request.operation == "observe", ["pixels", "count"].contains(mode),
                  mode != "count" || target.bundleId == "com.factory.applets.RelayMac" else { throw ControlError.invalidRequest }
        }
        let until = ProcessInfo.processInfo.systemUptime + 1.5
        if request.operation == "mouse" {
            guard let command = request.mouse, let expected = request.expected, expected.target == target,
                  request.elementId == nil else { throw ControlError.invalidRequest }
            let identity = try identitySnapshot(target)
            guard expected.windowRectPoints == identity.windowRectPoints,
                  expected.processStartedAt == identity.processStartedAt,
                  expected.displayConfiguration == identity.displayConfiguration else { throw ControlError.stale }
            try mouse(command, expected: expected)
            return ["type": "mouse-acknowledged"]
        }
        let pair: (ControlSnapshot, AXUIElement?)
        if request.mode == "pixels" { pair = (try identitySnapshot(target), nil) }
        else { pair = try snapshot(target, until: until) }
        let (current, button) = pair
        if request.operation == "observe" {
            guard request.expected == nil, request.elementId == nil, request.mouse == nil else { throw ControlError.invalidRequest }
            return ["type": "observation", "snapshot": try JSONSerialization.jsonObject(with: JSONEncoder().encode(current))]
        }
        guard request.elementId == "relay-increment", request.expected == current,
              request.mouse == nil, let button else { throw ControlError.stale }
        guard let owningWindow = attribute(button, kAXWindowAttribute),
              CFGetTypeID(owningWindow) == AXUIElementGetTypeID(),
              geometry(owningWindow as! AXUIElement)
                == CGRect(x: current.rectPoints[0], y: current.rectPoints[1],
                          width: current.rectPoints[2], height: current.rectPoints[3]),
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
                    || ProcessInfo.processInfo.systemUptime > end {
                    MouseRelease.shared.release(cancel: true)
                    exit(0)
                }
            }
            watchdog.resume()
            defer { watchdog.cancel() }
            let request = try await Task.detached { try controlReadRequest() }.value
            do { try controlWriteJSON(["ok": true, "result": try perform(request)]) }
            catch { try controlWriteJSON(["ok": false, "error": (error as? ControlError)?.rawValue ?? "invalid_request"]) }
        } catch {}
    }
}

import AppKit
import ApplicationServices
import Darwin

enum ControlError: String, Error {
    case invalidRequest = "invalid_request", inaccessible = "accessibility_required"
    case targetMismatch = "target_mismatch", stale = "observation_stale"
    case unavailable = "element_unavailable", uncertain = "action_uncertain"
    case timeout = "control_timeout", disconnected = "control_closed"
    case screenRecording = "screen_recording_required", backgroundUnavailable = "background_unavailable"
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

// A held button is always released, including when the requesting connection disappears mid-gesture.
final class MouseRelease: @unchecked Sendable {
    static let shared = MouseRelease()
    private let lock = NSLock()
    private var held: CGEvent?
    func down(_ point: CGPoint, _ button: CGMouseButton, count: Int64 = 1) throws {
        lock.lock()
        defer { lock.unlock() }
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
        held?.location = point
        event.post(tap: .cghidEventTap)
    }
    func release(count: Int64 = 1) {
        lock.lock()
        defer { lock.unlock() }
        guard let event = held else { return }
        event.setIntegerValueField(.mouseEventClickState, value: count)
        event.post(tap: .cghidEventTap)
        held = nil
    }
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

    static func prepareAccessibility(_ expected: ControlSnapshot, alive: () -> Bool) throws {
        guard !expected.target.isDesktop, let pid = expected.target.pid else { return }
        let application = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(application, 0.15)
        // Web-backed apps may withhold their control tree until assistive technology requests it.
        // This is process-local, not a permission prompt, profile change, or input action.
        guard let enabled = attribute(application, "AXManualAccessibility") as? Bool, !enabled else { return }
        var settable: DarwinBoolean = false
        guard AXUIElementIsAttributeSettable(application, "AXManualAccessibility" as CFString, &settable) == .success,
              settable.boolValue else { return }
        let current = try identitySnapshot(expected.target)
        guard current.processStartedAt == expected.processStartedAt,
              current.windowRectPoints == expected.windowRectPoints, alive() else { throw ControlError.stale }
        _ = AXUIElementSetAttributeValue(application, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    }

    /// Foreground HID input for a whole display. Callers reach this only under an exclusive desktop lease.
    static func mouse(_ command: MouseCommand, expected: ControlSnapshot, alive: () -> Bool) throws {
        let coordinate: (Double) -> Bool = { $0.isFinite && $0 >= 0 && $0 < 1 }
        guard expected.target.isDesktop else { throw ControlError.backgroundUnavailable }
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
        func validate(_ point: CGPoint) throws {
            let current = try identitySnapshot(expected.target)
            guard current.displayConfiguration == expected.displayConfiguration,
                  ProcessInfo.processInfo.systemUptime < until else { throw ControlError.stale }
            var displays = [CGDirectDisplayID](repeating: 0, count: 32)
            var displayCount: UInt32 = 0
            guard CGGetActiveDisplayList(32, &displays, &displayCount) == .success,
                  displays.prefix(Int(displayCount)).contains(where: { CGDisplayBounds($0).contains(point) })
                else { throw ControlError.targetMismatch }
            guard alive() else { throw ControlError.disconnected }
            guard CGPreflightScreenCaptureAccess(), CGPreflightPostEventAccess(),
                  let session = CGSessionCopyCurrentDictionary() as? [String: Any],
                  session[kCGSessionOnConsoleKey as String] as? Bool == true,
                  session[kCGSessionLoginDoneKey as String] as? Bool == true,
                  CGRect(x: r[0], y: r[1], width: r[2], height: r[3]).contains(point) else { throw ControlError.inaccessible }
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

    static func perform(_ request: ControlRequest, alive: () -> Bool) throws -> [String: Any] {
        guard ["diagnose", "observe", "press", "mouse"].contains(request.operation) else { throw ControlError.invalidRequest }
        if request.operation == "diagnose" {
            guard request.target == nil, request.expected == nil, request.elementId == nil,
                  request.mouse == nil, request.mode == nil else { throw ControlError.invalidRequest }
            return ["type": "diagnostic", "bundleId": Bundle.main.bundleIdentifier ?? "",
                    "bundlePath": Bundle.main.bundlePath, "executablePath": Bundle.main.executablePath ?? "",
                    "accessibility": AXIsProcessTrusted(), "screenRecording": CGPreflightScreenCaptureAccess(),
                    "permissionRequested": false,
                    "launchMode": "persistent-ipc", "processId": getpid(), "parentProcessId": getppid(),
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
            if target.isDesktop {
                try mouse(command, expected: expected, alive: alive)
                return ["type": "mouse-acknowledged", "route": "foreground-hid", "focusPreserved": false, "cursorPreserved": false]
            }
            return try backgroundClick(command, expected: expected, alive: alive)
        }
        let pair: (ControlSnapshot, AXUIElement?)
        if request.mode == "pixels" {
            guard request.expected == nil, request.elementId == nil, request.mouse == nil else { throw ControlError.invalidRequest }
            let current = try identitySnapshot(target)
            try prepareAccessibility(current, alive: alive)
            pair = (current, nil)
        }
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
              ProcessInfo.processInfo.systemUptime < until, alive() else { throw ControlError.stale }
        // A messaging timeout can mean the action happened. Never retry an uncertain press.
        guard AXUIElementPerformAction(button, kAXPressAction as CFString) == .success else { throw ControlError.uncertain }
        return ["type": "pressed", "elementId": "relay-increment"]
    }

    /// Silent window input: a left single click becomes AXPress on the pressable element under the point.
    /// No event is posted, so focus, cursor and other windows are untouched. Anything that cannot be
    /// expressed this way is refused with background_unavailable instead of falling back to HID.
    static func backgroundClick(_ command: MouseCommand, expected: ControlSnapshot, alive: () -> Bool) throws -> [String: Any] {
        guard command.kind == "click", command.button == "left", command.count == 1,
              command.x.isFinite, command.y.isFinite, (0..<1).contains(command.x), (0..<1).contains(command.y)
            else { throw ControlError.backgroundUnavailable }
        let r = expected.rectPoints
        guard r.count == 4, let pid = expected.target.pid else { throw ControlError.stale }
        let windowRect = CGRect(x: r[0], y: r[1], width: r[2], height: r[3])
        let point = CGPoint(x: r[0] + command.x * r[2], y: r[1] + command.y * r[3])
        let application = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(application, 0.15)
        guard let windows = attribute(application, kAXWindowsAttribute) as? [AXUIElement],
              windows.count <= 32 else { throw ControlError.backgroundUnavailable }
        let matches = windows.filter { geometry($0) == windowRect }
        guard matches.count == 1 else { throw ControlError.backgroundUnavailable }
        var hit: AXUIElement?
        guard AXUIElementCopyElementAtPosition(application, Float(point.x), Float(point.y), &hit) == .success,
              var element = hit else { throw ControlError.backgroundUnavailable }
        var pressable: AXUIElement?
        for _ in 0..<8 {
            var hitPID: pid_t = 0
            // A different owner means another window covers the point; never press through it.
            guard AXUIElementGetPid(element, &hitPID) == .success, hitPID == pid else { throw ControlError.backgroundUnavailable }
            var names: CFArray?
            if AXUIElementCopyActionNames(element, &names) == .success,
               let actions = names as? [String], actions.contains(kAXPressAction as String) {
                pressable = element
                break
            }
            guard let parent = attribute(element, kAXParentAttribute),
                  CFGetTypeID(parent) == AXUIElementGetTypeID() else { break }
            element = parent as! AXUIElement
        }
        guard let pressable, let owningWindow = attribute(pressable, kAXWindowAttribute),
              CFGetTypeID(owningWindow) == AXUIElementGetTypeID(),
              CFEqual(owningWindow, matches[0]),
              geometry(owningWindow as! AXUIElement) == windowRect,
              attribute(pressable, kAXEnabledAttribute) as? Bool == true,
              let frame = geometry(pressable), frame.contains(point) else { throw ControlError.backgroundUnavailable }
        let current = try identitySnapshot(expected.target)
        guard current.windowRectPoints == expected.windowRectPoints,
              current.processStartedAt == expected.processStartedAt, alive() else { throw ControlError.stale }
        let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
        let cursor = CGEvent(source: nil)?.location
        // A messaging timeout can mean the press happened. The supervisor fences and never retries.
        guard AXUIElementPerformAction(pressable, kAXPressAction as CFString) == .success else { throw ControlError.uncertain }
        return ["type": "mouse-acknowledged", "route": "background-ax-press",
                "focusPreserved": NSWorkspace.shared.frontmostApplication?.processIdentifier == front,
                "cursorPreserved": CGEvent(source: nil)?.location == cursor]
    }
}

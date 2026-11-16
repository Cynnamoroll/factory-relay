import AppKit
import ScreenCaptureKit
import CoreImage
import Darwin

let allowedBundles = ["com.apple.iphonesimulator", "com.apple.dt.Devices", "com.factory.applets.RelayMac"]
let maxImageBytes = 4 * 1024 * 1024

enum HostError: Error { case invalidTarget, disconnected, timeout, oversized }
@MainActor var launchMode = "stdio"

func json(_ value: [String: Any]) throws -> Data {
    try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
}

@MainActor func diagnostic(_ code: String) {
    let body: [String: Any] = [
        "protocol": 1, "type": "diagnostic", "code": code,
        "bundleId": Bundle.main.bundleIdentifier ?? "unknown",
        "bundlePath": Bundle.main.bundlePath,
        "executablePath": Bundle.main.executablePath ?? "unknown",
        "screenRecording": CGPreflightScreenCaptureAccess(),
        "accessibility": AXIsProcessTrusted(),
        "permissionRequested": false,
        "launchMode": launchMode,
        "processId": getpid(),
        "parentProcessId": getppid(),
        "lifecycle": HostLifecycle.diagnostics,
        "stage": HostSession.stage.rawValue
    ]
    if let data = try? json(body) {
        FileHandle.standardOutput.write(data + Data([10]))
    }
}

func rendezvous(_ path: String) throws -> [String] {
    let url = URL(fileURLWithPath: path)
    let directory = url.deletingLastPathComponent()
    let root = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".applets-control")
    guard url.lastPathComponent == "io", directory.deletingLastPathComponent().path == root.path,
          directory.lastPathComponent.hasPrefix("s-"), path.utf8.count < 104 else { throw HostError.invalidTarget }
    for (item, kind, mode) in [(root.path, S_IFDIR, 0o700),
                               (directory.path, S_IFDIR, 0o700), (path, S_IFSOCK, 0o600)] {
        var info = stat()
        guard lstat(item, &info) == 0, info.st_uid == geteuid(),
              info.st_mode & S_IFMT == kind, info.st_mode & 0o777 == mode else { throw HostError.invalidTarget }
    }
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { throw HostError.disconnected }
    defer { close(fd) }
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    withUnsafeMutableBytes(of: &address.sun_path) { destination in
        path.utf8CString.withUnsafeBytes { source in
            destination.copyBytes(from: source)
        }
    }
    let connected = withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
        }
    }
    var uid: uid_t = 0
    var gid: gid_t = 0
    guard connected == 0, getpeereid(fd, &uid, &gid) == 0, uid == geteuid(),
          dup2(fd, STDIN_FILENO) >= 0, dup2(fd, STDOUT_FILENO) >= 0 else { throw HostError.disconnected }
    _ = fcntl(fd, F_SETFL, O_NONBLOCK)
    try writePacket(json(["protocol": 1, "type": "hello", "pid": getpid()]) + Data([10]))
    var request = Data()
    let deadline = ProcessInfo.processInfo.systemUptime + 10
    while request.count <= 4096 {
        try waitFD(STDIN_FILENO, Int16(POLLIN), until: deadline)
        var byte: UInt8 = 0
        guard Darwin.read(STDIN_FILENO, &byte, 1) == 1 else { throw HostError.disconnected }
        if byte == 10 {
            guard let args = try JSONSerialization.jsonObject(with: request) as? [String] else {
                throw HostError.invalidTarget
            }
            return args
        }
        request.append(byte)
    }
    throw HostError.oversized
}

func waitFD(_ fd: Int32, _ events: Int16, until: TimeInterval) throws {
    while ProcessInfo.processInfo.systemUptime < until {
        var item = pollfd(fd: fd, events: events, revents: 0)
        let result = poll(&item, 1, 100)
        if result < 0 && errno == EINTR { continue }
        if result < 0 || item.revents & Int16(POLLERR | POLLNVAL) != 0 {
            throw HostError.disconnected
        }
        if item.revents & events != 0 { return }
        if item.revents & Int16(POLLHUP) != 0 { throw HostError.disconnected }
    }
    throw HostError.timeout
}

func writePacket(_ data: Data) throws {
    let until = ProcessInfo.processInfo.systemUptime + 10
    try data.withUnsafeBytes { bytes in
        var offset = 0
        while offset < bytes.count {
            try waitFD(STDOUT_FILENO, Int16(POLLOUT), until: until)
            let count = Darwin.write(STDOUT_FILENO, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
            if count < 0 && (errno == EAGAIN || errno == EINTR) { continue }
            guard count > 0 else { throw HostError.disconnected }
            offset += count
        }
    }
}

func send(_ header: Data, image: Data = Data()) throws {
    guard header.count <= 8192 else { throw HostError.oversized }
    var length = UInt32(header.count).bigEndian
    var packet = Data(bytes: &length, count: 4)
    packet.append(header)
    packet.append(image)
    try writePacket(packet)
    try waitFD(STDIN_FILENO, Int16(POLLIN), until: ProcessInfo.processInfo.systemUptime + 10)
    var ack: UInt8 = 0
    guard Darwin.read(STDIN_FILENO, &ack, 1) == 1, ack == 6 else { throw HostError.disconnected }
}

final class Capture: NSObject, SCStreamOutput, SCStreamDelegate {
    let condition = NSCondition()
    var latest: CMSampleBuffer?
    var stopped = false
    var replaced: UInt64 = 0

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        condition.lock()
        stopped = true
        condition.broadcast()
        condition.unlock()
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
                of outputType: SCStreamOutputType) {
        guard outputType == .screen, sampleBuffer.isValid,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false)
                as? [[SCStreamFrameInfo: Any]],
              attachments.first?[.status] as? Int == SCFrameStatus.complete.rawValue,
              sampleBuffer.imageBuffer != nil else { return }
        condition.lock()
        if latest != nil { replaced += 1 }
        latest = sampleBuffer
        condition.signal()
        condition.unlock()
    }

    func take() throws -> (CMSampleBuffer, UInt64)? {
        let until = Date(timeIntervalSinceNow: 2)
        condition.lock()
        defer { condition.unlock() }
        while latest == nil && !stopped {
            if !condition.wait(until: until) { return nil }
        }
        guard !stopped, let sample = latest else { throw HostError.disconnected }
        latest = nil
        return (sample, replaced)
    }
}

@MainActor
enum HostSession {
    enum Stage: String {
        case appReady = "app_ready"
        case enumerating
        case windowsReady = "windows_ready"
        case creatingFilter = "creating_filter"
        case filterReady = "filter_ready"
        case startingCapture = "starting_capture"
        case capturing
        case stoppingCapture = "stopping_capture"
    }
    static var stage = Stage.appReady

    static func run() async {
        var args = Array(CommandLine.arguments.dropFirst())
        if args.count == 2 && args[0] == "control" {
            await Control.run()
            return
        }
        var watchdog: DispatchSourceTimer?
        defer { watchdog?.cancel() }
        if args.count == 2 && args[0] == "connect" {
            let endpoint = args[1]
            do { args = try await Task.detached { try rendezvous(endpoint) }.value } catch { return }
            launchMode = "launchservices-ipc"
            let timer = DispatchSource.makeTimerSource(queue: .global())
            let end = ProcessInfo.processInfo.systemUptime + 1800
            timer.schedule(deadline: .now(), repeating: 1)
            timer.setEventHandler {
                var byte: UInt8 = 0
                let count = recv(STDIN_FILENO, &byte, 1, MSG_PEEK | MSG_DONTWAIT)
                if count == 0 || (count < 0 && errno != EAGAIN && errno != EINTR) ||
                    ProcessInfo.processInfo.systemUptime >= end { exit(0) }
            }
            timer.resume()
            watchdog = timer
        }
        if args == ["diagnose"] || args.isEmpty {
            diagnostic("permission_preflight")
            return
        }
        // Do not call shareable-content APIs before explicit user consent exists.
        guard CGPreflightScreenCaptureAccess() else {
            diagnostic("screen_recording_required")
            return
        }
        do {
            guard args == ["windows"] || (args.count == 4 && args[0] == "stream") else {
                throw HostError.invalidTarget
            }
            stage = .enumerating
            let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
            stage = .windowsReady
            let windows = content.windows.filter {
                allowedBundles.contains($0.owningApplication?.bundleIdentifier ?? "") && $0.windowLayer == 0
            }
            if args == ["windows"] {
                let rows: [[String: Any]] = windows.map {
                    ["windowId": $0.windowID, "pid": $0.owningApplication!.processID,
                     "bundleId": $0.owningApplication!.bundleIdentifier,
                     "title": $0.title ?? "",
                     "windowRectPoints": [$0.frame.minX, $0.frame.minY, $0.frame.width, $0.frame.height]]
                }
                FileHandle.standardOutput.write(try json(["protocol": 1, "type": "windows", "windows": rows]) + Data([10]))
                return
            }
            guard let id = UInt32(args[1]), let pid = Int32(args[2]),
                  let window = windows.first(where: {
                      $0.windowID == id && $0.owningApplication?.processID == pid &&
                      $0.owningApplication?.bundleIdentifier == args[3]
                  }), window.frame.width > 0, window.frame.height > 0 else { throw HostError.invalidTarget }
            stage = .creatingFilter
            let filter = SCContentFilter(desktopIndependentWindow: window)
            stage = .filterReady
            let config = SCStreamConfiguration()
            let ratio = min(1, 2048 / max(window.frame.width * 2, window.frame.height * 2))
            config.width = max(1, Int(window.frame.width * 2 * ratio))
            config.height = max(1, Int(window.frame.height * 2 * ratio))
            config.minimumFrameInterval = CMTime(value: 1, timescale: 15)
            config.queueDepth = 3
            config.pixelFormat = kCVPixelFormatType_32BGRA
            config.capturesAudio = false
            config.showsCursor = false
            let capture = Capture()
            let stream = SCStream(filter: filter, configuration: config, delegate: capture)
            try stream.addStreamOutput(capture, type: .screen,
                                       sampleHandlerQueue: DispatchQueue(label: "com.factory.applets.capture"))
            stage = .startingCapture
            try await stream.startCapture()
            stage = .capturing
            do {
                try await Task.detached {
                    let context = CIContext()
                    let colorSpace = CGColorSpaceCreateDeviceRGB()
                    _ = fcntl(STDOUT_FILENO, F_SETFL, O_NONBLOCK)
                    var sequence: UInt64 = 0
                    let end = ProcessInfo.processInfo.systemUptime + 1800
                    while ProcessInfo.processInfo.systemUptime < end {
                        guard let (sample, dropped) = try capture.take() else {
                            try send(json(["protocol": 1, "type": "heartbeat", "bytes": 0,
                                           "sentUptimeSeconds": ProcessInfo.processInfo.systemUptime]))
                            continue
                        }
                        guard let pixels = sample.imageBuffer,
                              let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false)
                                as? [[SCStreamFrameInfo: Any]], let info = attachments.first,
                              let rectDict = info[.contentRect] as? NSDictionary,
                              let rect = CGRect(dictionaryRepresentation: rectDict as CFDictionary) else { continue }
                        let image = CIImage(cvPixelBuffer: pixels)
                        guard let jpeg = context.jpegRepresentation(of: image, colorSpace: colorSpace,
                            options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.7]),
                              jpeg.count <= maxImageBytes else { throw HostError.oversized }
                        sequence += 1
                        let header = try json([
                            "protocol": 1, "type": "frame", "sequence": sequence,
                            "windowId": id, "pid": pid, "bundleId": args[3], "mediaType": "image/jpeg",
                            "width": CVPixelBufferGetWidth(pixels), "height": CVPixelBufferGetHeight(pixels),
                            "captureTimeSeconds": CMTimeGetSeconds(sample.presentationTimeStamp),
                            "sentUptimeSeconds": ProcessInfo.processInfo.systemUptime,
                            "contentRectPixels": [rect.minX, rect.minY, rect.width, rect.height],
                            "initialWindowRectPoints": [window.frame.minX, window.frame.minY, window.frame.width, window.frame.height],
                            "contentScale": info[.contentScale] as? CGFloat ?? 1,
                            "scaleFactor": info[.scaleFactor] as? CGFloat ?? 1,
                            "replacedFrames": dropped, "bytes": jpeg.count
                        ])
                        try send(header, image: jpeg)
                    }
                }.value
            } catch {
                stage = .stoppingCapture
                try? await stream.stopCapture()
                return
            }
            stage = .stoppingCapture
            try await stream.stopCapture()
        } catch {
            // Raw Apple errors can include unrelated window or account information.
            diagnostic("capture_unavailable")
        }
    }
}

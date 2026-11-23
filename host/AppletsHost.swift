import AppKit
import ScreenCaptureKit
import CoreImage
import VideoToolbox
import Darwin

let maxImageBytes = 4 * 1024 * 1024
let hostProtocol = 3

enum HostError: Error { case invalidTarget, disconnected, timeout, oversized, encoderUnavailable }

func json(_ value: [String: Any]) throws -> Data {
    try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
}

final class ResultBox<T>: @unchecked Sendable { var value: Result<T, Error>? }

/// Runs async ScreenCaptureKit work from a connection thread without touching the main thread.
func blocking<T>(_ work: @escaping @Sendable () async throws -> T) throws -> T {
    let semaphore = DispatchSemaphore(value: 0)
    let box = ResultBox<T>()
    Task.detached {
        do { box.value = .success(try await work()) } catch { box.value = .failure(error) }
        semaphore.signal()
    }
    semaphore.wait()
    return try box.value!.get()
}

/// One accepted client. Every read and write uses this descriptor only; no process-wide stdio is rebound.
final class HostConnection: @unchecked Sendable {
    let fd: Int32
    private var buffer = Data()

    init(fd: Int32) {
        self.fd = fd
        _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
        var one: Int32 = 1
        _ = setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
    }
    deinit { close(fd) }

    var alive: Bool {
        var byte: UInt8 = 0
        let count = recv(fd, &byte, 1, MSG_PEEK | MSG_DONTWAIT)
        return count > 0 || (count < 0 && (errno == EAGAIN || errno == EINTR))
    }

    func wait(_ events: Int16, until: TimeInterval) throws {
        while ProcessInfo.processInfo.systemUptime < until {
            var item = pollfd(fd: fd, events: events, revents: 0)
            let result = poll(&item, 1, 100)
            if result < 0 && errno == EINTR { continue }
            if result < 0 || item.revents & Int16(POLLERR | POLLNVAL) != 0 { throw HostError.disconnected }
            if item.revents & events != 0 { return }
            if item.revents & Int16(POLLHUP) != 0 { throw HostError.disconnected }
        }
        throw HostError.timeout
    }

    func write(_ data: Data, seconds: TimeInterval = 10) throws {
        let until = ProcessInfo.processInfo.systemUptime + seconds
        try data.withUnsafeBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                try wait(Int16(POLLOUT), until: until)
                let count = Darwin.write(fd, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                if count < 0 && (errno == EAGAIN || errno == EINTR) { continue }
                guard count > 0 else { throw HostError.disconnected }
                offset += count
            }
        }
    }

    func readLine(limit: Int, seconds: TimeInterval) throws -> Data {
        let until = ProcessInfo.processInfo.systemUptime + seconds
        while true {
            if let newline = buffer.firstIndex(of: 10) {
                let line = buffer[buffer.startIndex..<newline]
                buffer = Data(buffer[(newline + 1)...])
                return Data(line)
            }
            guard buffer.count <= limit else { throw HostError.oversized }
            try wait(Int16(POLLIN), until: until)
            var chunk = [UInt8](repeating: 0, count: 4096)
            let count = Darwin.read(fd, &chunk, chunk.count)
            if count < 0 && (errno == EAGAIN || errno == EINTR) { continue }
            guard count > 0 else { throw HostError.disconnected }
            buffer.append(contentsOf: chunk[0..<count])
        }
    }

    /// Returns the number of acknowledgement bytes read; any other byte is a protocol violation.
    func readAcks() throws -> Int {
        var chunk = [UInt8](repeating: 0, count: 64)
        let count = Darwin.read(fd, &chunk, chunk.count)
        if count < 0 && (errno == EAGAIN || errno == EINTR) { return 0 }
        guard count > 0, chunk[0..<count].allSatisfy({ $0 == 6 }) else { throw HostError.disconnected }
        return count
    }
}

/// Holds only the newest complete sample. Older samples are replaced, never queued.
final class Capture: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
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

    func take(timeout: TimeInterval) throws -> (CMSampleBuffer, UInt64)? {
        let until = Date(timeIntervalSinceNow: timeout)
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

/// Capture metadata carried through VideoToolbox by pointer, so encoded output can never be
/// misaligned with its capture even when the encoder drops or delays frames.
struct VideoPending {
    let captureTimeSeconds: Double
    let replacedFrames: UInt64
    let contentRect: CGRect
    let contentScale: CGFloat
    let scaleFactor: CGFloat
    let width: Int
    let height: Int
}

final class VideoPendingBox {
    let value: VideoPending
    init(_ value: VideoPending) { self.value = value }
}

/// Hardware H.264 encoder for the live view. The send loop drains finished access units through
/// next(); VideoToolbox delivers them on its own queue thread into a small bounded buffer.
/// Wire format is Annex B: every NAL unit has a 4-byte start code, and each keyframe access unit
/// is prefixed with in-band SPS and PPS so a decoder can join at any keyframe.
final class VideoEncoder: @unchecked Sendable {
    struct AccessUnit {
        let pending: VideoPending
        let keyframe: Bool
        let annexb: Data
    }
    /// About 270 ms at 30 fps. A deeper backlog would only replay stale video; dropping it and
    /// forcing a keyframe keeps the live view current.
    static let maxQueuedUnits = 8
    private var session: VTCompressionSession?
    private let lock = NSLock()
    private var ready: [AccessUnit] = []
    /// Set when output was lost or malformed; only keyframes are queued again until one arrives.
    private var resync = false

    init(width: Int, height: Int) throws {
        session = nil
        var created: VTCompressionSession?
        let status = VTCompressionSessionCreate(allocator: kCFAllocatorDefault, width: Int32(width), height: Int32(height),
            codecType: kCMVideoCodecType_H264, encoderSpecification: nil, imageBufferAttributes: nil,
            compressedDataAllocator: nil, outputCallback: videoEncoderOutput,
            refcon: Unmanaged.passUnretained(self).toOpaque(), compressionSessionOut: &created)
        guard status == noErr, let created = created else { throw HostError.encoderUnavailable }
        session = created
        let properties: [(CFString, CFTypeRef)] = [
            (kVTCompressionPropertyKey_RealTime, kCFBooleanTrue),
            (kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_High_AutoLevel),
            (kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse),
            (kVTCompressionPropertyKey_MaxKeyFrameInterval, 60 as CFNumber),
            (kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, 2 as CFNumber),
            (kVTCompressionPropertyKey_ExpectedFrameRate, 30 as CFNumber),
            (kVTCompressionPropertyKey_AverageBitRate, 4_000_000 as CFNumber),
            (kVTCompressionPropertyKey_DataRateLimits, [4_000_000 / 8, 1] as CFArray),
        ]
        for (key, value) in properties { VTSessionSetProperty(created, key: key, value: value) }
        guard VTCompressionSessionPrepareToEncodeFrames(created) == noErr else {
            VTCompressionSessionInvalidate(created)
            session = nil
            throw HostError.encoderUnavailable
        }
    }

    deinit { if let session = session { VTCompressionSessionInvalidate(session) } }

    /// Submits one capture. The retained pending box always returns through the output callback,
    /// or is released here when the session refuses the frame.
    func encode(_ pixelBuffer: CVPixelBuffer, pending: VideoPending, presentationTimeStamp: CMTime) {
        let box = Unmanaged.passRetained(VideoPendingBox(pending)).toOpaque()
        lock.lock()
        let damaged = resync
        lock.unlock()
        guard let session = session else {
            Unmanaged<VideoPendingBox>.fromOpaque(box).release()
            return
        }
        var properties: CFDictionary?
        if damaged {
            properties = [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue] as CFDictionary
        }
        let status = VTCompressionSessionEncodeFrame(session, imageBuffer: pixelBuffer,
            presentationTimeStamp: presentationTimeStamp, duration: .invalid,
            frameProperties: properties, sourceFrameRefcon: box, infoFlagsOut: nil)
        if status != noErr {
            Unmanaged<VideoPendingBox>.fromOpaque(box).release()
            resyncNeeded()
        }
    }

    func next() -> AccessUnit? {
        lock.lock()
        defer { lock.unlock() }
        return ready.isEmpty ? nil : ready.removeFirst()
    }

    func finish() {
        guard let session = session else { return }
        VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
        VTCompressionSessionInvalidate(session)
        self.session = nil
    }

    fileprivate func resyncNeeded() {
        lock.lock()
        resync = true
        lock.unlock()
    }

    fileprivate func deliver(_ unit: AccessUnit) {
        lock.lock()
        if ready.count >= VideoEncoder.maxQueuedUnits {
            // The transport stalled; drop the backlog and resynchronize from a fresh keyframe.
            ready.removeAll()
            resync = true
        }
        if unit.keyframe {
            resync = false
            ready.append(unit)
        } else if !resync {
            ready.append(unit)
        }
        lock.unlock()
    }

    static func isKeyframe(_ sampleBuffer: CMSampleBuffer) -> Bool {
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false)
            as? [[CFString: Any]], let first = attachments.first else { return false }
        return !(first[kCMSampleAttachmentKey_NotSync] as? Bool ?? false)
    }

    /// SPS and PPS from the format description, start-code prefixed for in-band delivery.
    static func parameterSets(_ format: CMFormatDescription) -> Data? {
        var count = 0
        guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: 0,
            parameterSetPointerOut: nil, parameterSetSizeOut: nil,
            parameterSetCountOut: &count, nalUnitHeaderLengthOut: nil) == noErr,
              count >= 2, count <= 8 else { return nil }
        var output = Data()
        for index in 0..<count {
            var pointer: UnsafePointer<UInt8>?
            var size = 0
            guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: index,
                parameterSetPointerOut: &pointer, parameterSetSizeOut: &size,
                parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil) == noErr,
                  let bytes = pointer, size > 0, size <= 1024 else { return nil }
            output.append(contentsOf: [0, 0, 0, 1])
            output.append(bytes, count: size)
        }
        return output
    }

    /// One access unit as Annex B: 4-byte start codes, with SPS + PPS prefixed on keyframes.
    static func annexB(_ sampleBuffer: CMSampleBuffer) -> Data? {
        guard let block = CMSampleBufferGetDataBuffer(sampleBuffer),
              let format = CMSampleBufferGetFormatDescription(sampleBuffer) else { return nil }
        var headerLength = Int32(4)
        guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: 0,
            parameterSetPointerOut: nil, parameterSetSizeOut: nil,
            parameterSetCountOut: nil, nalUnitHeaderLengthOut: &headerLength) == noErr,
              (1...4).contains(Int(headerLength)) else { return nil }
        let total = CMBlockBufferGetDataLength(block)
        guard total > 0, total <= maxImageBytes else { return nil }
        var raw = [UInt8](repeating: 0, count: total)
        let copied = raw.withUnsafeMutableBytes { destination in
            CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: total, destination: destination.baseAddress!)
        }
        guard copied == noErr else { return nil }
        var output = Data()
        output.reserveCapacity(total + 256)
        if isKeyframe(sampleBuffer) {
            guard let sets = parameterSets(format) else { return nil }
            output.append(sets)
        }
        let step = Int(headerLength)
        var offset = 0
        while offset + step <= total {
            var nalLength = 0
            for index in 0..<step { nalLength = (nalLength << 8) | Int(raw[offset + index]) }
            guard nalLength > 0, offset + step + nalLength <= total else { return nil }
            output.append(contentsOf: [0, 0, 0, 1])
            output.append(contentsOf: raw[(offset + step)..<(offset + step + nalLength)])
            offset += step + nalLength
        }
        guard offset == total, !output.isEmpty else { return nil }
        return output
    }
}

/// VideoToolbox output callback; runs on the encoder's queue thread.
private func videoEncoderOutput(refcon: UnsafeMutableRawPointer?, sourceFrameRefcon: UnsafeMutableRawPointer?,
                                status: OSStatus, infoFlags: VTEncodeInfoFlags, sampleBuffer: CMSampleBuffer?) {
    guard let refcon = refcon, let sourceFrameRefcon = sourceFrameRefcon else { return }
    let encoder = Unmanaged<VideoEncoder>.fromOpaque(refcon).takeUnretainedValue()
    let pending = Unmanaged<VideoPendingBox>.fromOpaque(sourceFrameRefcon).takeRetainedValue().value
    guard status == noErr, let sampleBuffer = sampleBuffer, CMSampleBufferDataIsReady(sampleBuffer),
          let annexb = VideoEncoder.annexB(sampleBuffer) else {
        // A lost or malformed access unit corrupts decoding until the next keyframe; force one.
        encoder.resyncNeeded()
        return
    }
    encoder.deliver(VideoEncoder.AccessUnit(pending: pending, keyframe: VideoEncoder.isKeyframe(sampleBuffer), annexb: annexb))
}

enum HostCapture {
    static func eligibleWindows(_ content: SCShareableContent) -> [SCWindow] {
        content.windows.filter {
            guard let owner = $0.owningApplication,
                  let app = NSRunningApplication(processIdentifier: owner.processID) else { return false }
            let bundle = app.bundleIdentifier ?? ""
            return bundle != "com.factory.applets.host" && !app.isTerminated && processStartTime(owner.processID) != nil &&
                bundle.utf8.count <= 255 && bundle.range(of: "^[A-Za-z0-9._-]*$", options: .regularExpression) != nil &&
                $0.windowLayer == 0 && $0.isOnScreen && $0.frame.width > 0 && $0.frame.height > 0 &&
                $0.frame.width <= 16384 && $0.frame.height <= 16384
        }
    }

    static func windows() async throws -> [String: Any] {
        guard CGPreflightScreenCaptureAccess() else { throw ControlError.screenRecording }
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        var displays: [[String: Any]] = []
        for display in content.displays.prefix(32) {
            let target = ControlTarget(displayId: display.displayID, displayUUID: try DisplayConfiguration.identity(display.displayID))
            let configuration = try DisplayConfiguration.current(target)
            var row = try JSONSerialization.jsonObject(with: JSONEncoder().encode(target)) as! [String: Any]
            row["main"] = display.displayID == CGMainDisplayID()
            row["displayConfiguration"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(configuration))
            displays.append(row)
        }
        var rows: [[String: Any]] = []
        for window in eligibleWindows(content).prefix(100) {
            guard let owner = window.owningApplication,
                  let app = NSRunningApplication(processIdentifier: owner.processID),
                  let started = processStartTime(owner.processID) else { continue }
            let displayName = String(decoding: (app.localizedName ?? "Application").utf16.prefix(80), as: UTF16.self)
            let row: [String: Any] = ["windowId": window.windowID, "pid": owner.processID,
                "bundleId": app.bundleIdentifier ?? "", "title": displayName,
                "displayName": displayName,
                "processStartedAt": started,
                "windowRectPoints": [window.frame.minX, window.frame.minY, window.frame.width, window.frame.height]]
            guard try json(["type": "windows", "displays": displays, "windows": rows + [row]]).count < 7000 else { break }
            rows.append(row)
        }
        return ["type": "windows", "displays": displays, "windows": rows]
    }

    static func identity(_ target: ControlTarget) async throws -> ControlSnapshot {
        try await MainActor.run { try Control.identitySnapshot(target) }
    }

    /// Streams the selected target until the client leaves. Capture, encoding and sending overlap:
    /// up to `window` frames may be unacknowledged, and only the newest sample is ever encoded.
    static func stream(_ connection: HostConnection, target: ControlTarget, window: Int) async throws {
        guard CGPreflightScreenCaptureAccess() else { throw ControlError.screenRecording }
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        let filter: SCContentFilter
        let initial = try await identity(target)
        if target.isDesktop {
            guard let display = content.displays.first(where: { $0.displayID == target.displayId }) else { throw HostError.invalidTarget }
            filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
        } else {
            guard let window = eligibleWindows(content).first(where: {
                      $0.windowID == target.windowId && $0.owningApplication?.processID == target.pid &&
                      NSRunningApplication(processIdentifier: target.pid!).map { ($0.bundleIdentifier ?? "") == target.bundleId } == true
                  }) else { throw HostError.invalidTarget }
            guard initial.rectPoints == [window.frame.minX, window.frame.minY, window.frame.width, window.frame.height] else { throw HostError.invalidTarget }
            filter = SCContentFilter(desktopIndependentWindow: window)
        }
        let config = SCStreamConfiguration()
        let r = initial.rectPoints
        let captureScale = target.isDesktop ? Double(filter.pointPixelScale) : 2
        let ratio = min(1, 1920 / max(r[2] * captureScale, r[3] * captureScale))
        config.width = max(1, Int(r[2] * captureScale * ratio))
        config.height = max(1, Int(r[3] * captureScale * ratio))
        // Let ScreenCaptureKit pace capture. A second wall-clock gate skips valid frames
        // whenever two callbacks for consecutive display frames land slightly under 33 ms apart.
        config.minimumFrameInterval = CMTime(value: 1, timescale: 30)
        config.queueDepth = 5
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.capturesAudio = false
        config.showsCursor = true
        config.ignoreShadowsSingleWindow = true
        let capture = Capture()
        let stream = SCStream(filter: filter, configuration: config, delegate: capture)
        try stream.addStreamOutput(capture, type: .screen,
                                   sampleHandlerQueue: DispatchQueue(label: "com.factory.applets.capture", qos: .userInteractive))
        try await stream.startCapture()
        defer { Task { try? await stream.stopCapture() } }
        let context = CIContext(options: [.cacheIntermediates: false])
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        var sequence: UInt64 = 0
        var outstanding = 0
        var lastSend = ProcessInfo.processInfo.systemUptime
        var lastIdentity = 0.0
        var lastSnapshot = 0.0
        var encoder: VideoEncoder?
        defer { encoder?.finish() }
        func send(_ header: [String: Any], _ image: Data = Data()) throws {
            let body = try json(header)
            guard body.count <= 8192 else { throw HostError.oversized }
            var length = UInt32(body.count).bigEndian
            var packet = Data(bytes: &length, count: 4)
            packet.append(body)
            packet.append(image)
            try connection.write(packet)
            outstanding += 1
            lastSend = ProcessInfo.processInfo.systemUptime
        }
        func targetHeader() throws -> [String: Any] {
            var header = try JSONSerialization.jsonObject(with: JSONEncoder().encode(target)) as! [String: Any]
            if let configuration = initial.displayConfiguration {
                header["displayConfiguration"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(configuration))
            } else {
                header["processStartedAt"] = initial.processStartedAt
                header["initialWindowRectPoints"] = initial.windowRectPoints
            }
            return header
        }
        while true {
            outstanding -= try connection.readAcks()
            while outstanding >= window {
                try connection.wait(Int16(POLLIN), until: ProcessInfo.processInfo.systemUptime + 10)
                outstanding -= try connection.readAcks()
            }
            guard outstanding >= 0 else { throw HostError.disconnected }
            // Finished access units leave before any new capture work; encoding never blocks sending.
            if let unit = encoder?.next() {
                sequence += 1
                let meta = unit.pending
                var header = try targetHeader()
                header.merge([
                    "protocol": 1, "type": "vframe", "sequence": sequence,
                    "codec": "h264", "format": "annexb", "keyframe": unit.keyframe,
                    "width": meta.width, "height": meta.height,
                    "captureTimeSeconds": meta.captureTimeSeconds,
                    "sentUptimeSeconds": ProcessInfo.processInfo.systemUptime,
                    "contentRectPixels": [meta.contentRect.minX, meta.contentRect.minY,
                                          meta.contentRect.width, meta.contentRect.height],
                    "contentScale": meta.contentScale, "scaleFactor": meta.scaleFactor,
                    "replacedFrames": meta.replacedFrames, "bytes": unit.annexb.count
                ], uniquingKeysWith: { _, new in new })
                try send(header, unit.annexb)
                continue
            }
            // Identity checks hop to the main thread, so they run at 4 Hz rather than per frame.
            if ProcessInfo.processInfo.systemUptime - lastIdentity >= 0.25 {
                guard try await identity(target) == initial else { throw HostError.invalidTarget }
                lastIdentity = ProcessInfo.processInfo.systemUptime
            }
            guard let (sample, dropped) = try capture.take(timeout: 0.5) else {
                guard connection.alive else { throw HostError.disconnected }
                if ProcessInfo.processInfo.systemUptime - lastSend >= 2 {
                    try send(["protocol": 1, "type": "heartbeat", "bytes": 0,
                              "sentUptimeSeconds": ProcessInfo.processInfo.systemUptime])
                }
                continue
            }
            guard let pixels = sample.imageBuffer,
                  let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false)
                    as? [[SCStreamFrameInfo: Any]], let info = attachments.first,
                  let rectDict = info[.contentRect] as? NSDictionary,
                  let rect = CGRect(dictionaryRepresentation: rectDict as CFDictionary) else { continue }
            let presentation = sample.presentationTimeStamp
            if encoder == nil {
                encoder = try VideoEncoder(width: CVPixelBufferGetWidth(pixels), height: CVPixelBufferGetHeight(pixels))
            }
            let now = ProcessInfo.processInfo.systemUptime
            encoder?.encode(pixels, pending: VideoPending(
                    captureTimeSeconds: CMTimeGetSeconds(presentation), replacedFrames: dropped,
                    contentRect: rect, contentScale: info[.contentScale] as? CGFloat ?? 1,
                    scaleFactor: info[.scaleFactor] as? CGFloat ?? 1,
                    width: CVPixelBufferGetWidth(pixels), height: CVPixelBufferGetHeight(pixels)),
                    presentationTimeStamp: presentation)
            // Recording, poster and compatibility viewers keep a 2 Hz JPEG snapshot packet.
            if now - lastSnapshot >= 0.5 {
                lastSnapshot = now
                guard let jpeg = context.jpegRepresentation(of: CIImage(cvPixelBuffer: pixels), colorSpace: colorSpace,
                    options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.6]),
                      jpeg.count <= maxImageBytes else { throw HostError.oversized }
                sequence += 1
                var header = try targetHeader()
                header.merge([
                    "protocol": 1, "type": "frame", "sequence": sequence,
                    "mediaType": "image/jpeg",
                    "width": CVPixelBufferGetWidth(pixels), "height": CVPixelBufferGetHeight(pixels),
                    "captureTimeSeconds": CMTimeGetSeconds(presentation),
                    "sentUptimeSeconds": ProcessInfo.processInfo.systemUptime,
                    "contentRectPixels": [rect.minX, rect.minY, rect.width, rect.height],
                    "contentScale": info[.contentScale] as? CGFloat ?? 1,
                    "scaleFactor": info[.scaleFactor] as? CGFloat ?? 1,
                    "replacedFrames": dropped, "bytes": jpeg.count
                ], uniquingKeysWith: { _, new in new })
                try send(header, jpeg)
            }
        }
    }
}

/// The persistent permission-owning server. Each client gets its own descriptor and thread.
enum HostServer {
    static let maxClients = 64
    static let clients = NSLock()
    nonisolated(unsafe) static var active = 0
    nonisolated(unsafe) static var endpoint = ""

    static func validate(_ path: String) throws {
        let url = URL(fileURLWithPath: path)
        let directory = url.deletingLastPathComponent()
        let root = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".applets-control")
        guard url.lastPathComponent == "relay.sock", directory.lastPathComponent == "host",
              directory.deletingLastPathComponent().path == root.path, path.utf8.count < 104 else { throw HostError.invalidTarget }
        for item in [root.path, directory.path] {
            var info = stat()
            guard lstat(item, &info) == 0, info.st_uid == geteuid(),
                  info.st_mode & S_IFMT == S_IFDIR, info.st_mode & 0o777 == 0o700 else { throw HostError.invalidTarget }
        }
        var info = stat()
        if lstat(path, &info) == 0 {
            guard info.st_uid == geteuid(), info.st_mode & S_IFMT == S_IFSOCK, unlink(path) == 0 else { throw HostError.invalidTarget }
        }
    }

    static func start(_ path: String) throws {
        try validate(path)
        endpoint = path
        let listener = socket(AF_UNIX, SOCK_STREAM, 0)
        guard listener >= 0 else { throw HostError.disconnected }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        withUnsafeMutableBytes(of: &address.sun_path) { destination in
            path.utf8CString.withUnsafeBytes { destination.copyBytes(from: $0) }
        }
        // The socket is created private, so no other account can connect between bind and chmod.
        let previous = umask(0o077)
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(listener, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        umask(previous)
        guard bound == 0, chmod(path, 0o600) == 0, listen(listener, 16) == 0 else {
            close(listener)
            throw HostError.disconnected
        }
        Thread.detachNewThread { acceptLoop(listener) }
    }

    /// Asks a running background host to exit so the next relay request starts one that sees newly
    /// granted permissions. macOS applies Screen Recording approval only to newly launched processes.
    static func stopRunning() {
        let path = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".applets-control/host/relay.sock").path
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        withUnsafeMutableBytes(of: &address.sun_path) { destination in
            path.utf8CString.withUnsafeBytes { destination.copyBytes(from: $0) }
        }
        let connected = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        var uid: uid_t = 0
        var gid: gid_t = 0
        guard connected == 0, getpeereid(fd, &uid, &gid) == 0, uid == geteuid() else { close(fd); return }
        let connection = HostConnection(fd: fd)
        _ = try? connection.readLine(limit: 1024, seconds: 2)
        try? connection.write(Data("{\"type\":\"control\"}\n{\"id\":1,\"operation\":\"shutdown\"}\n".utf8), seconds: 2)
        _ = try? connection.readLine(limit: 1024, seconds: 2)
    }

    static func acceptLoop(_ listener: Int32) {
        while true {
            let client = accept(listener, nil, nil)
            if client < 0 { if errno == EINTR { continue }; exit(1) }
            var uid: uid_t = 0
            var gid: gid_t = 0
            clients.lock()
            let admitted = getpeereid(client, &uid, &gid) == 0 && uid == geteuid() && active < maxClients
            if admitted { active += 1 }
            clients.unlock()
            guard admitted else { close(client); continue }
            Thread.detachNewThread {
                serve(HostConnection(fd: client))
                clients.lock(); active -= 1; clients.unlock()
            }
        }
    }

    static func serve(_ connection: HostConnection) {
        do {
            try connection.write(json(["protocol": hostProtocol, "type": "hello", "pid": Int(getpid())]) + Data([10]))
            guard let hello = try JSONSerialization.jsonObject(with: connection.readLine(limit: 16384, seconds: 10)) as? [String: Any]
                else { return }
            if hello["type"] as? String == "control", hello.count == 1 {
                try control(connection)
            } else if hello["type"] as? String == "stream", Set(hello.keys) == ["type", "target", "window"],
                      let window = hello["window"] as? Int, (1...8).contains(window), let raw = hello["target"] {
                let target = try JSONDecoder().decode(ControlTarget.self, from: JSONSerialization.data(withJSONObject: raw))
                try blocking { try await HostCapture.stream(connection, target: target, window: window) }
            }
        } catch {}
    }

    static func control(_ connection: HostConnection) throws {
        while true {
            // Persistent clients idle between requests; only EOF or an error ends the connection.
            let line = try connection.readLine(limit: 16384, seconds: 86400)
            guard let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
                  let id = object["id"] as? Int else { throw HostError.invalidTarget }
            var reply: [String: Any] = ["id": id]
            do {
                let request = try JSONDecoder().decode(ControlRequest.self, from: line)
                switch request.operation {
                case "windows":
                    guard request.target == nil else { throw ControlError.invalidRequest }
                    reply["result"] = try blocking { try await HostCapture.windows() }
                case "shutdown":
                    guard request.target == nil else { throw ControlError.invalidRequest }
                    try connection.write(json(["id": id, "ok": true, "result": ["type": "shutdown"]]) + Data([10]))
                    unlink(endpoint)
                    exit(0)
                default:
                    reply["result"] = try DispatchQueue.main.sync {
                        try MainActor.assumeIsolated { try Control.perform(request, alive: { connection.alive }) }
                    }
                }
                reply["ok"] = true
            } catch {
                reply["ok"] = false
                reply["error"] = (error as? ControlError)?.rawValue ?? "invalid_request"
            }
            try connection.write(json(reply) + Data([10]))
        }
    }
}

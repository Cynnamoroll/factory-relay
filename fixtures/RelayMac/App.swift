import AppKit
import Darwin
import SwiftUI

@main
enum RelayMacEntry {
    private static let managedMode: StaticString = "--relaymac-managed-nonactivating-v1"

    @MainActor
    static func main() {
        let args = CommandLine.arguments
        guard args.count > 1,
              managedMode.withUTF8Buffer({ args[1].utf8.elementsEqual($0) }) else {
            RelayMacApp.main()
            return
        }
        guard args.count == 5, args[2].utf8.count == 64,
              args[2].range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              let parent = Int32(args[3]), parent > 1, getppid() == parent,
              let lifetimeMs = Int(args[4]), (1...3_600_000).contains(lifetimeMs) else { _exit(2) }

        // This pipe exists only for this instance. Supervisor death closes the writer.
        DispatchQueue.global(qos: .utility).async {
            var byte: UInt8 = 0
            while Darwin.read(STDIN_FILENO, &byte, 1) < 0 && errno == EINTR {}
            _exit(0)
        }
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + .milliseconds(lifetimeMs + 20_000)) {
            _exit(0)
        }

        let app = NSApplication.shared
        guard app.setActivationPolicy(.accessory) else { _exit(2) }
        let panel = NSPanel(contentRect: NSRect(x: 100, y: 100, width: 420, height: 300),
                            styleMask: [.titled, .closable, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.title = "RelayMac QA"
        panel.isFloatingPanel = false
        panel.level = .normal
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.isReleasedWhenClosed = false
        panel.isRestorable = false
        panel.contentView = NSHostingView(rootView: RelayMacContent())
        let lifecycle = ManagedPanelLifecycle()
        panel.delegate = lifecycle

        DispatchQueue.main.async {
            panel.center()
            panel.orderBack(nil)
            var info = proc_bsdinfo()
            let size = Int32(MemoryLayout<proc_bsdinfo>.size)
            let pid = getpid()
            guard getppid() == parent, panel.isVisible, panel.windowNumber > 0, !app.isActive,
                  proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size, info.pbi_start_tvsec > 0 else { _exit(2) }
            let proof: [String: Any] = ["marker": args[2], "pid": pid, "parentPid": parent, "windowId": panel.windowNumber,
                                        "startSeconds": info.pbi_start_tvsec, "startMicroseconds": info.pbi_start_tvusec]
            guard var row = try? JSONSerialization.data(withJSONObject: proof) else { _exit(2) }
            row.append(10)
            FileHandle.standardOutput.write(row)
        }
        withExtendedLifetime((panel, lifecycle)) { app.run() }
    }
}

private final class ManagedPanelLifecycle: NSObject, NSWindowDelegate {
    func windowWillClose(_ notification: Notification) { _exit(0) }
}

struct RelayMacApp: App {
    var body: some Scene {
        WindowGroup { RelayMacContent() }
    }
}

private struct RelayMacContent: View {
    @State private var count = 0
    // Opt-in benchmark mode: launch with --qa-animate to change pixels every display frame.
    private let animate = CommandLine.arguments.contains("--qa-animate")

    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 72))
                .foregroundStyle(.green)
            Text(RelayModel.greeting)
                .font(.title)
                .accessibilityIdentifier("relay-greeting")
            Text("Count: \(count)")
                .accessibilityIdentifier("relay-count")
            Button("Increment") { count += 1 }
                .accessibilityIdentifier("relay-increment")
            Text("Built and launched through Factory relay")
                .font(.subheadline)
            if animate {
                TimelineView(.animation) { context in
                    let seconds = context.date.timeIntervalSinceReferenceDate
                    HStack(spacing: 16) {
                        Circle()
                            .fill(.orange)
                            .frame(width: 24, height: 24)
                            .offset(x: CGFloat(sin(seconds * 2 * .pi) * 80))
                        Text("Frame \(Int(seconds * 60) % 100000)")
                            .monospacedDigit()
                    }
                    .frame(width: 260, height: 32)
                }
                // Kept out of the accessibility tree so AX observations stay identical to the default app.
                .accessibilityHidden(true)
            }
        }
        .padding()
    }
}

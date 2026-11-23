import AppKit
import ApplicationServices
import CoreGraphics
import Darwin

@MainActor
enum HostLifecycle {
    static let supportsPermissionSetup = true
    static var launchFinished = false

    static var diagnostics: [String: Bool] {
        ["appKitInitialized": NSApp != nil,
         "eventLoopRunning": NSApp?.isRunning ?? false,
         "launchFinished": launchFinished,
         "mainThread": Thread.isMainThread]
    }
}

@MainActor
final class PermissionSetupController: NSWindowController, NSWindowDelegate {
    private let screenStatus = NSTextField(labelWithString: "")
    private let controlStatus = NSTextField(labelWithString: "")
    private let readyStatus = NSTextField(labelWithString: "")
    private let launchPermissions = (screen: CGPreflightScreenCaptureAccess(), control: AXIsProcessTrusted())
    private let screenButton = NSButton(title: "Enable screen recording", target: nil, action: nil)
    private let controlButton = NSButton(title: "Enable control", target: nil, action: nil)
    private let refreshButton = NSButton(title: "Check again", target: nil, action: nil)

    private var controlPermissionName: String {
        if #available(macOS 27.0, *) {
            return "Device Control and Data Access"
        }
        return "Accessibility"
    }

    init() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 600, height: 560),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered, defer: false
        )
        window.title = "Factory Relay"
        window.isReleasedWhenClosed = false
        super.init(window: window)
        window.delegate = self

        let heading = NSTextField(labelWithString: "Allow Factory Relay to see and control this Mac")
        heading.font = .boldSystemFont(ofSize: 18)
        let icon = NSImageView(image: NSApplication.shared.applicationIconImage)
        icon.imageScaling = .scaleProportionallyUpOrDown
        icon.widthAnchor.constraint(equalToConstant: 56).isActive = true
        icon.heightAnchor.constraint(equalToConstant: 56).isActive = true
        let header = NSStackView(views: [icon, heading])
        header.orientation = .horizontal
        header.spacing = 14
        readyStatus.font = .systemFont(ofSize: 13, weight: .semibold)
        let introduction = NSTextField(wrappingLabelWithString:
            "Choose each permission below. macOS requires your approval for Factory Relay. Opening this window does not request access."
        )
        let instructions = NSTextField(wrappingLabelWithString:
            "If access is denied, open System Settings > Privacy & Security and enable Factory Relay under Screen Recording (also called Screen & System Audio Recording) and \(controlPermissionName)."
        )
        let restartNotice = NSTextField(wrappingLabelWithString:
            "After approval, click Check again if the status has not updated. Factory Relay may briefly reopen to refresh macOS permission status. Permissions are checked, not requested, during normal QA."
        )

        screenButton.target = self
        screenButton.action = #selector(requestScreenRecording)
        controlButton.target = self
        controlButton.action = #selector(requestControl)
        refreshButton.target = self
        refreshButton.action = #selector(recheckPermissions)
        let settingsButton = NSButton(title: "Open System Settings", target: self, action: #selector(openSettings))
        let doneButton = NSButton(title: "Done", target: self, action: #selector(done))
        doneButton.keyEquivalent = "\r"
        let actions = NSStackView(views: [settingsButton, refreshButton, doneButton])
        actions.orientation = .horizontal
        actions.spacing = 12
        let content = NSStackView(views: [
            header, introduction, screenStatus, screenButton, controlStatus, controlButton,
            readyStatus, instructions, restartNotice, actions
        ])
        content.orientation = .vertical
        content.alignment = .leading
        content.spacing = 14
        content.translatesAutoresizingMaskIntoConstraints = false
        let root = window.contentView!
        root.addSubview(content)
        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 24),
            content.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -24),
            content.topAnchor.constraint(equalTo: root.topAnchor, constant: 24),
            content.bottomAnchor.constraint(lessThanOrEqualTo: root.bottomAnchor, constant: -24),
            introduction.widthAnchor.constraint(equalTo: content.widthAnchor),
            instructions.widthAnchor.constraint(equalTo: content.widthAnchor),
            restartNotice.widthAnchor.constraint(equalTo: content.widthAnchor)
        ])
        window.center()
    }

    required init?(coder: NSCoder) {
        fatalError("Permission setup is created programmatically")
    }

    func showSetup() {
        refreshStatus()
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    @objc func refreshStatus() {
        let screenGranted = CGPreflightScreenCaptureAccess()
        let controlGranted = AXIsProcessTrusted()
        screenStatus.stringValue = "Screen Recording: " + (screenGranted ? "Enabled" : "Not available yet; after approval, click Check again")
        controlStatus.stringValue = controlPermissionName + ": " + (controlGranted ? "Enabled" : "Not enabled")
        screenButton.isEnabled = !screenGranted
        controlButton.isEnabled = !controlGranted
        readyStatus.stringValue = screenGranted && controlGranted
            ? "Factory Relay is ready. You can close this window; QA agents work in the background."
            : "Factory Relay needs both permissions before agents can see or act on windows."
    }

    @objc private func requestScreenRecording() {
        if !CGPreflightScreenCaptureAccess() {
            _ = CGRequestScreenCaptureAccess()
        }
        refreshStatus()
    }

    @objc private func requestControl() {
        if !AXIsProcessTrusted() {
            let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            _ = AXIsProcessTrustedWithOptions(options)
        }
        refreshStatus()
    }

    @objc private func openSettings() {
        NSWorkspace.shared.open(URL(fileURLWithPath: "/System/Applications/System Settings.app"))
    }

    @objc private func recheckPermissions() {
        guard refreshButton.isEnabled else { return }
        guard !CGPreflightScreenCaptureAccess() else {
            refreshStatus()
            return
        }
        refreshButton.isEnabled = false
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.createsNewApplicationInstance = true
        configuration.arguments = ["--setup"]
        Task { @MainActor in
            do {
                _ = try await NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: configuration)
                // A running background host also caches the old Screen Recording decision.
                HostServer.stopRunning()
                NSApplication.shared.terminate(nil)
            } catch {
                refreshButton.isEnabled = true
                let alert = NSAlert()
                alert.messageText = "Could not restart Factory Relay"
                alert.informativeText = "Click Done, then reopen Factory Relay setup."
                alert.runModal()
            }
        }
    }

    private func restartHostIfPermissionsChanged() {
        if CGPreflightScreenCaptureAccess() != launchPermissions.screen || AXIsProcessTrusted() != launchPermissions.control {
            HostServer.stopRunning()
        }
    }

    @objc private func done() {
        restartHostIfPermissionsChanged()
        NSApplication.shared.terminate(nil)
    }

    func windowWillClose(_ notification: Notification) {
        restartHostIfPermissionsChanged()
        NSApplication.shared.terminate(nil)
    }
}

@MainActor
final class HostApplicationDelegate: NSObject, NSApplicationDelegate {
    private var permissionSetup: PermissionSetupController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        HostLifecycle.launchFinished = true
        // Opening the app from Finder (no arguments) shows setup rather than exiting silently.
        if CommandLine.arguments.contains("--setup") || CommandLine.arguments.count == 1 {
            NSApplication.shared.setActivationPolicy(.regular)
            let controller = PermissionSetupController()
            permissionSetup = controller
            controller.showSetup()
            return
        }
        // The background host serves every relay client from one long-lived process, so permission
        // checks, ScreenCaptureKit state and AX connections stay warm between requests.
        let args = Array(CommandLine.arguments.dropFirst())
        guard args.count == 2, args[0] == "serve" else {
            NSApplication.shared.terminate(nil)
            return
        }
        do { try HostServer.start(args[1]) } catch { NSApplication.shared.terminate(nil) }
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        permissionSetup?.refreshStatus()
    }
}

@main
@MainActor
enum AppletsHost {
    static func main() {
        signal(SIGPIPE, SIG_IGN)
        // NSApplication.shared establishes the display and WindowServer connection.
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        application.disableRelaunchOnLogin()
        let delegate = HostApplicationDelegate()
        application.delegate = delegate
        withExtendedLifetime(delegate) {
            application.run()
        }
    }
}

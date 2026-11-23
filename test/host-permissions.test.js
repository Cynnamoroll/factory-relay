import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sourceFile = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const lifecycle = sourceFile('host/HostLifecycle.swift');

function bodyAfter(source, signature) {
  const signatureIndex = source.indexOf(signature);
  assert.notEqual(signatureIndex, -1, `Expected source declaration: ${signature}`);
  const start = source.indexOf('{', signatureIndex);
  let depth = 1;
  let end = start + 1;
  for (; depth && end < source.length; end++) {
    if (source[end] === '{') depth++;
    if (source[end] === '}') depth--;
  }
  assert.equal(depth, 0, `Expected balanced declaration: ${signature}`);
  return source.slice(start + 1, end - 1);
}

const requests = /CGRequestScreenCaptureAccess|AXIsProcessTrustedWithOptions|kAXTrustedCheckOptionPrompt/;

test('static contract: setup is explicit and returns before the normal session starts', () => {
  assert.match(lifecycle, /static let supportsPermissionSetup = true/);
  const launch = bodyAfter(lifecycle, 'func applicationDidFinishLaunching');
  const setup = bodyAfter(launch, 'if CommandLine.arguments.contains("--setup")');
  assert.match(setup, /setActivationPolicy\(\.regular\)/);
  assert.match(setup, /permissionSetup = controller/);
  assert.match(setup, /controller\.showSetup\(\)\s+return/);
  assert.ok(launch.indexOf('return') < launch.indexOf('HostServer.start('));
  assert.doesNotMatch(setup, /HostServer\.start|CGRequest|AXIsProcessTrustedWithOptions/);
  assert.match(lifecycle, /private var permissionSetup: PermissionSetupController\?/);
  assert.match(lifecycle, /withExtendedLifetime\(delegate\)/);
  assert.match(lifecycle, /enum AppletsHost/);
});

test('static contract: permission requests occur only in user-click handlers', () => {
  const screen = bodyAfter(lifecycle, '@objc private func requestScreenRecording()');
  const control = bodyAfter(lifecycle, '@objc private func requestControl()');
  assert.match(screen, /if !CGPreflightScreenCaptureAccess\(\)/);
  assert.match(screen, /CGRequestScreenCaptureAccess\(\)/);
  assert.match(control, /if !AXIsProcessTrusted\(\)/);
  assert.match(control, /kAXTrustedCheckOptionPrompt\.takeUnretainedValue\(\) as String: true\] as CFDictionary/);
  assert.match(control, /AXIsProcessTrustedWithOptions\(options\)/);
  for (const handler of [screen, control]) assert.match(handler, /refreshStatus\(\)/);
  assert.doesNotMatch(lifecycle.replace(screen, '').replace(control, ''), requests);
  assert.match(lifecycle, /screenButton\.action = #selector\(requestScreenRecording\)/);
  assert.match(lifecycle, /controlButton\.action = #selector\(requestControl\)/);
  for (const path of ['host/AppletsHost.swift', 'control/AppletsControl.swift']) {
    assert.doesNotMatch(sourceFile(path), requests, `${path} must not request permissions`);
  }
});

test('static contract: status checks disable granted actions without polling or relaunching', () => {
  const refresh = bodyAfter(lifecycle, '@objc func refreshStatus()');
  assert.match(refresh, /let screenGranted = CGPreflightScreenCaptureAccess\(\)/);
  assert.match(refresh, /let controlGranted = AXIsProcessTrusted\(\)/);
  assert.match(refresh, /screenButton\.isEnabled = !screenGranted/);
  assert.match(refresh, /controlButton\.isEnabled = !controlGranted/);
  assert.doesNotMatch(refresh, requests);
  assert.match(bodyAfter(lifecycle, 'func applicationDidBecomeActive'), /permissionSetup\?\.refreshStatus\(\)/);
  assert.match(lifecycle, /refreshButton\.action = #selector\(recheckPermissions\)/);
  assert.doesNotMatch(lifecycle, /Timer|scheduledTimer|asyncAfter|Process\(\)|x-apple\.systempreferences/);
});

test('static contract: setup explains OS approval, settings names, and permission rechecking', () => {
  for (const label of [
    'Factory Relay', 'Enable screen recording', 'Enable control',
    'macOS requires your approval for Factory Relay',
    'enable Factory Relay under Screen Recording',
    'System Settings > Privacy & Security', 'Screen & System Audio Recording',
    'Factory Relay may briefly reopen to refresh macOS permission status',
  ]) assert.ok(lifecycle.includes(label), `Setup must display: ${label}`);
  assert.match(lifecycle, /window\.title = "Factory Relay"/);
  assert.doesNotMatch(lifecycle, /Applets Host|factory-relay/);
  const plist = sourceFile('host/Info.plist');
  for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
    assert.ok(plist.includes(`<key>${key}</key><string>Factory Relay</string>`), `${key} must display Factory Relay`);
  }
  assert.match(plist, /<key>CFBundleIdentifier<\/key><string>com\.factory\.applets\.host<\/string>/);
  assert.match(plist, /<key>CFBundleExecutable<\/key><string>AppletsHost<\/string>/);
  assert.match(lifecycle, /if #available\(macOS 27\.0, \*\) \{\s+return "Device Control and Data Access"\s+\}\s+return "Accessibility"/);
  assert.match(lifecycle, /URL\(fileURLWithPath: "\/System\/Applications\/System Settings\.app"\)/);
  assert.match(lifecycle, /window\.isReleasedWhenClosed = false/);
  assert.match(lifecycle, /window\.delegate = self/);
  const show = bodyAfter(lifecycle, 'func showSetup()');
  assert.match(show, /refreshStatus\(\)/);
  assert.match(show, /makeKeyAndOrderFront/);
  assert.match(show, /activate\(ignoringOtherApps: true\)/);
  for (const signature of ['@objc private func done()', 'func windowWillClose']) {
    assert.match(bodyAfter(lifecycle, signature), /NSApplication\.shared\.terminate\(nil\)/);
  }
});

test('static contract: normal lifecycle diagnostics remain unchanged', () => {
  const diagnostics = bodyAfter(lifecycle, 'static var diagnostics: [String: Bool]');
  assert.equal(diagnostics.trim(), `["appKitInitialized": NSApp != nil,
         "eventLoopRunning": NSApp?.isRunning ?? false,
         "launchFinished": launchFinished,
         "mainThread": Thread.isMainThread]`);
});

test('static contract: Check again refreshes cached screen status without a separate restart button', () => {
  assert.match(lifecycle, /NSButton\(title: "Check again"/);
  assert.doesNotMatch(lifecycle, /Restart setup|restartButton/);
  assert.match(lifecycle, /refreshButton\.action = #selector\(recheckPermissions\)/);
  assert.match(lifecycle, /Not available yet; after approval, click Check again/);
  const restart = bodyAfter(lifecycle, '@objc private func recheckPermissions()');
  assert.match(restart, /guard !CGPreflightScreenCaptureAccess\(\) else \{\s+refreshStatus\(\)\s+return/);
  assert.match(restart, /configuration\.createsNewApplicationInstance = true/);
  assert.match(restart, /configuration\.arguments = \["--setup"\]/);
  assert.match(restart, /openApplication\(at: Bundle\.main\.bundleURL/);
  assert.ok(restart.indexOf('try await') < restart.indexOf('terminate(nil)'));
  assert.match(restart, /catch/);
  assert.match(restart, /refreshButton\.isEnabled = true/);
  assert.doesNotMatch(restart, requests);
  assert.doesNotMatch(lifecycle.replace(restart, ''), /openApplication\(/);
});

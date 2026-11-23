import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const control = readFileSync(new URL('../control/AppletsControl.swift', import.meta.url), 'utf8');
const host = readFileSync(new URL('../host/AppletsHost.swift', import.meta.url), 'utf8');
const between = (source, start, end) => {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `Expected source declaration: ${start}`);
  const to = end ? source.indexOf(end, from) : source.length;
  assert.notEqual(to, -1, `Expected source declaration: ${end}`);
  return source.slice(from, to);
};

test('static native safety contract keeps target identity strict and HID input desktop-only', () => {
  const mouse = between(control, 'static func mouse(', 'static func perform(');
  assert.match(control, /\(app\.bundleIdentifier \?\? ""\) == bundleId/);
  assert.match(control, /let started = processStartTime\(pid\)/);
  assert.match(control, /proc_pidinfo\(pid, PROC_PIDTBSDINFO/);
  assert.doesNotMatch(control + host, /\.launchDate/);
  assert.match(control, /row\[kCGWindowOwnerPID as String\] as\? Int32 == target\.pid/);
  assert.match(control, /row\[kCGWindowLayer as String\] as\? Int == 0/);
  assert.match(mouse, /guard expected\.target\.isDesktop else \{ throw ControlError\.backgroundUnavailable \}/,
    'Posted HID events never reach a window target');
  assert.match(mouse, /CGDisplayBounds\(\$0\)\.contains\(point\)/);
  assert.match(mouse, /current\.displayConfiguration == expected\.displayConfiguration/);
  assert.match(mouse, /CGPreflightPostEventAccess/);
  assert.match(mouse, /guard alive\(\) else \{ throw ControlError\.disconnected \}/);
  assert.match(mouse, /defer \{ MouseRelease\.shared\.release\(\) \}/);
  assert.match(mouse, /try post\(\.leftMouseDragged/);
  assert.match(mouse, /if dispatched \{ throw ControlError\.uncertain \}/);
  assert.match(mouse, /Thread\.sleep\(forTimeInterval: 0\.03\)\s+\/\/[^\n]+\n\s+MouseRelease\.shared\.release\(count: Int64\(index\)\)/,
    'A menu opened by mouse-down must not prevent button-up or poison input fencing');
  assert.doesNotMatch(mouse, /AXUIElementPerformAction|relay-count|relay-increment|AppleScript|System Events|Process\(/);
  assert.match(control, /CGDisplayCreateUUIDFromDisplayID/);
  assert.match(control, /CGDisplayIsOnline\(id\)/);
  assert.match(control, /CGDisplayIsActive\(id\)/);
  assert.doesNotMatch(control + host, /CGRequestScreenCaptureAccess|AXIsProcessTrustedWithOptions/);
});

test('static background contract presses only an owned element in the exact window and refuses everything else', () => {
  const perform = between(control, 'static func perform(', 'static func backgroundClick(');
  const background = between(control, 'static func backgroundClick(');
  assert.match(perform, /if target\.isDesktop \{\s+try mouse\(command, expected: expected, alive: alive\)\s+return \["type": "mouse-acknowledged", "route": "foreground-hid"/);
  assert.match(perform, /return try backgroundClick\(command, expected: expected, alive: alive\)/);
  assert.match(background, /guard command\.kind == "click", command\.button == "left", command\.count == 1/);
  assert.match(background, /else \{ throw ControlError\.backgroundUnavailable \}/);
  assert.match(background, /AXUIElementCopyElementAtPosition\(application,/, 'Hit testing is scoped to the target application');
  assert.match(background, /hitPID == pid else \{ throw ControlError\.backgroundUnavailable \}/, 'An occluding owner is refused');
  assert.match(background, /geometry\(owningWindow as! AXUIElement\) == windowRect/, 'The element must belong to the exact window');
  assert.match(background, /frame\.contains\(point\)/);
  assert.match(background, /current\.processStartedAt == expected\.processStartedAt/);
  assert.match(background, /AXUIElementPerformAction\(pressable, kAXPressAction/);
  assert.match(background, /"route": "background-ax-press"/);
  assert.doesNotMatch(background, /CGEvent\(mouseEventSource|\.post\(tap|CGWarpMouseCursorPosition|activate\(|SetFrontProcess/,
    'Background input never posts events, moves the cursor or activates an app');
});

test('static window observation contract prepares a supported process-local accessibility tree before input', () => {
  const prepare = between(control, 'static func prepareAccessibility(', 'static func mouse(');
  const perform = between(control, 'static func perform(', 'static func backgroundClick(');
  assert.match(prepare, /guard !expected\.target\.isDesktop, let pid = expected\.target\.pid else \{ return \}/);
  assert.match(prepare, /attribute\(application, "AXManualAccessibility"\) as\? Bool, !enabled/);
  assert.match(prepare, /AXUIElementIsAttributeSettable/);
  assert.match(prepare, /settable\.boolValue/);
  assert.ok(prepare.indexOf('current.processStartedAt == expected.processStartedAt') <
    prepare.indexOf('AXUIElementSetAttributeValue('), 'Revalidate exact process identity before enabling its accessibility tree');
  assert.match(prepare, /AXUIElementSetAttributeValue\(application, "AXManualAccessibility" as CFString, kCFBooleanTrue\)/);
  assert.doesNotMatch(prepare, /AXUIElementPerformAction|activate\(|CGEvent|com\.electron|System Events/);
  assert.match(perform, /if request\.mode == "pixels" \{[\s\S]*request\.expected == nil[\s\S]*let current = try identitySnapshot\(target\)[\s\S]*try prepareAccessibility\(current, alive: alive\)[\s\S]*pair = \(current, nil\)/);
});

test('static persistent host contract uses per-connection descriptors, peer checks and pipelined capture', () => {
  assert.doesNotMatch(host + control, /dup2|STDIN_FILENO|STDOUT_FILENO/, 'No process-wide stdio is rebound per client');
  assert.match(host, /getpeereid\(client, &uid, &gid\) == 0 && uid == geteuid\(\)/);
  assert.match(host, /let previous = umask\(0o077\)/);
  assert.match(host, /chmod\(path, 0o600\)/);
  assert.match(host, /url\.lastPathComponent == "relay\.sock", directory\.lastPathComponent == "host"/);
  assert.match(host, /info\.st_mode & 0o777 == 0o700/);
  assert.match(host, /Thread\.detachNewThread \{\s+serve\(HostConnection\(fd: client\)\)/);
  assert.match(host, /"protocol": hostProtocol, "type": "hello"/);
  assert.match(host, /\(1\.\.\.8\)\.contains\(window\)/);
  assert.match(host, /while outstanding >= window/, 'Frames are pipelined up to the credit window, not stop-and-wait');
  assert.match(host, /config\.minimumFrameInterval = CMTime\(value: 1, timescale: 30\)/);
  assert.doesNotMatch(host, /lastSubmit/, 'CaptureKit is the only submission-rate limiter');
  assert.match(host, /SCContentFilter\(desktopIndependentWindow: window\)/);
  assert.match(host, /SCContentFilter\(display: display, excludingApplications: \[\], exceptingWindows: \[\]\)/);
  assert.match(host, /guard try await identity\(target\) == initial/);
  assert.match(host, /config\.ignoreShadowsSingleWindow = true/);
  assert.match(host, /config\.showsCursor = true/);
  assert.doesNotMatch(host, /window\.title/, 'Discovery must not disclose document titles from unselected apps');
});

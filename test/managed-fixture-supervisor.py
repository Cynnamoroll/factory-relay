import io
from pathlib import Path
import plistlib
import runpy
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


module = runpy.run_path(str(Path(__file__).resolve().parents[1] / "src/managed-fixture-supervisor.py"))
cleanup = module["cleanup"]
artifact = module["artifact"]
Refusal = module["Refusal"]


class OwnedChild:
    pid = 9

    def __init__(self, reaped_after_wait=False):
        self.stdin = io.BytesIO()
        self.reaped_after_wait = reaped_after_wait
        self.reaped = False
        self.signals = []

    def poll(self):
        return 0 if self.reaped else None

    def wait(self, timeout):
        assert self.stdin.closed, "Private watchdog must run before any signal fallback"
        self.reaped = self.reaped_after_wait
        raise subprocess.TimeoutExpired("fixture", timeout)

    def terminate(self):
        self.signals.append("TERM")
        raise PermissionError()

    def kill(self):
        self.signals.append("KILL")
        raise PermissionError()


class ManagedSupervisorTests(unittest.TestCase):
    def test_reaped_child_pid_may_have_been_reused(self):
        for already_reaped in [False, True]:
            child = OwnedChild(reaped_after_wait=True)
            child.reaped = already_reaped
            self.assertTrue(cleanup(child))
            self.assertEqual(child.signals, [])

    def test_permission_denied_is_not_an_ack(self):
        child = OwnedChild()
        self.assertFalse(cleanup(child))
        self.assertEqual(child.signals, ["TERM", "KILL"])

    def test_missing_old_mismatched_symlink_or_writable_artifact_is_refused(self):
        with tempfile.TemporaryDirectory() as workspace, patch.object(sys, "platform", "darwin"):
            contents = Path(workspace) / module["ARTIFACT"]
            executable = contents / "MacOS/RelayMac"
            info = contents / "Info.plist"
            executable.parent.mkdir(parents=True)
            info.write_bytes(plistlib.dumps({"CFBundleIdentifier": module["BUNDLE"], "CFBundleExecutable": "RelayMac"}))
            with self.assertRaisesRegex(Refusal, "fixture_build_required"):
                artifact(workspace)
            executable.write_bytes(b"\xcf\xfa\xed\xfe" + b"old-fixture")
            executable.chmod(0o755)
            with patch.object(subprocess, "Popen") as spawn:
                with self.assertRaisesRegex(Refusal, "fixture_build_required"):
                    module["launch"](workspace, "a" * 64, 1000)
                spawn.assert_not_called()
            executable.write_bytes(b"\xcf\xfa\xed\xfe" + module["MODE"].encode("ascii"))
            self.assertEqual(artifact(workspace), executable.resolve())
            executable.chmod(0o775)
            with self.assertRaisesRegex(Refusal, "fixture_build_required"):
                artifact(workspace)
            executable.chmod(0o755)
            info.write_bytes(plistlib.dumps({"CFBundleIdentifier": "com.google.Chrome", "CFBundleExecutable": "RelayMac"}))
            with self.assertRaisesRegex(Refusal, "fixture_build_required"):
                artifact(workspace)
            info.write_bytes(plistlib.dumps({"CFBundleIdentifier": module["BUNDLE"], "CFBundleExecutable": "RelayMac"}))
            outside = Path(workspace) / "unrelated"
            executable.rename(outside)
            executable.symlink_to(outside)
            with self.assertRaisesRegex(Refusal, "fixture_build_required"):
                artifact(workspace)


if __name__ == "__main__":
    unittest.main()

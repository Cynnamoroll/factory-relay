#!/usr/bin/env python3
"""Test-only replacement for /usr/bin/open: detach the fake host like LaunchServices would."""
import os
import subprocess
import sys
from pathlib import Path

assert sys.argv[1:3] == ["-n", "-g"] and sys.argv[3].endswith(".applets-host/Factory Relay.app")
assert sys.argv[4:6] == ["--args", "serve"]
subprocess.Popen([sys.executable, str(Path(__file__).with_name("fake-host.py")), sys.argv[6]],
                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                 start_new_session=True, env=os.environ)

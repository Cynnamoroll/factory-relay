import json
import os
from pathlib import Path
import runpy
import subprocess
import sys


mode, *args = sys.argv[1:]
if mode == "fixture":
    workspace, behavior, marker = args
    pid = os.getpid()
    root = Path(workspace)
    (root / f"start.{pid}").touch()
    if behavior != "partial":
        row = {
            "marker": marker if behavior != "wrong-marker" else "f" * 64,
            "pid": pid if behavior != "wrong-pid" else pid + 1,
            "parentPid": os.getppid() if behavior != "wrong-parent" else 1,
            "windowId": pid,
            "startSeconds": 123,
            "startMicroseconds": 500000,
        }
        print(json.dumps(row), flush=True)
    sys.stdin.buffer.read()
    (root / f"exit.{pid}").touch()
    sys.exit(0)

source = Path(__file__).resolve().parents[2] / "src/managed-fixture-supervisor.py"
module = runpy.run_path(str(source))


def start(workspace, marker, _lifetime):
    return subprocess.Popen(
        [sys.executable, __file__, "fixture", workspace, mode, marker],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, start_new_session=True,
    )


def reap(child):
    cleaned = module["cleanup"](child)
    return cleaned and mode != "cleanup-denied"


def emit(row):
    if mode == "corrupt-helper" and row["type"] == "ready":
        row["marker"] = "f" * 64
    print(json.dumps(row), flush=True)
    if mode == "transport-lost" and row["type"] == "ready":
        os._exit(0)


module["supervisor"](
    module["Lines"](0), emit, lambda: False, start=start, startup=1.5,
    renewal=0.25 if mode == "client-lost" else 10, reap=reap,
)

import json
import os
from pathlib import Path
import tempfile
import time

remote = Path("src/remote.py").read_text().replace('if __name__ == "__main__":\n    main()', '')
stream = Path("src/stream-supervisor.py").read_text().replace('if __name__ == "__main__":\n    stream_main()', '')
control = Path("src/control-supervisor.py").read_text().replace('if __name__ == "__main__":\n    daemon_main()', '')
ns = {"__name__": "test"}
exec(remote + "\n" + stream + "\n" + control, ns)
Failure = ns["Failure"]

A = {"windowId": 5, "pid": 12, "bundleId": "com.factory.applets.RelayMac"}
B = {"windowId": 6, "pid": 13, "bundleId": "com.example.App"}
A2 = {"windowId": 9, "pid": 12, "bundleId": "com.factory.applets.RelayMac"}


def rejected(code, function, *args):
    try:
        function(*args)
    except Failure as error:
        assert str(error) == code, (code, str(error))
        return
    raise AssertionError("expected " + code)


with tempfile.TemporaryDirectory() as temp:
    root = ns["private_directory"](Path(temp) / ".applets-control")

    # Version 1 state migrates to one exclusive lease with the same proof.
    (root / "state.json").write_text(json.dumps({"generation": 4, "lease": {"owner": "cli", "token": "a" * 64,
                                                 "expiresAt": time.time() + 60}}))
    os.chmod(root / "state.json", 0o600)
    state = ns["read_state"](root)
    assert state["version"] == 2 and state["leases"][0]["scope"] == {"kind": "exclusive"}
    legacy = {"owner": "cli", "workspace": temp, "args": {"lease": {"token": "a" * 64, "generation": 4}}}
    assert ns["verify_lease"](state, legacy)["generation"] == 4
    assert ns["lease_allows"](state["leases"][0], {"kind": "desktop", "displayId": 1, "displayUUID": "x"}, "mutate")

    def perform(owner, args, operation="acquire"):
        request = {"operation": operation, "owner": owner, "workspace": temp, "timeout": 30,
                   "args": dict(args)}
        return ns["perform"](request, root, ns["read_state"](root))

    def acquire(owner, scope=None, takeover=False):
        return perform(owner, {"ttlSeconds": 60, "takeover": takeover, **({"scope": scope} if scope else {})})

    rejected("lease_held", acquire, "agent:a", {"kind": "window", "target": A})
    perform("cli", {"lease": {"token": "a" * 64, "generation": 4}}, "release")
    a = acquire("agent:a", {"kind": "window", "target": A})
    b = acquire("agent:b", {"kind": "window", "target": B})
    a2 = acquire("agent:c", {"kind": "window", "target": A2})
    viewer = acquire("viewer", {"kind": "observer"})
    assert len({a["token"], b["token"], a2["token"]}) == 3, "distinct targets coexist, including two windows of one process"
    rejected("lease_held", acquire, "agent:d", {"kind": "window", "target": A})
    rejected("lease_held", acquire, "cli")
    rejected("invalid_request", acquire, "agent:d", {"kind": "window", "target": {**A, "bundleId": "com.factory.applets.host"}})
    rejected("invalid_request", acquire, "agent:d", {"kind": "desktop"})

    def proof(lease, owner):
        return {"owner": owner, "workspace": temp, "args": {"lease": {"token": lease["token"], "generation": lease["generation"]}}}

    state = ns["read_state"](root)
    lease_a = ns["verify_lease"](state, proof(a, "agent:a"))
    assert ns["lease_allows"](lease_a, A, "mutate") and not ns["lease_allows"](lease_a, A2, "mutate")
    assert not ns["lease_allows"](lease_a, {"kind": "desktop", "displayId": 1, "displayUUID": "u"}, "read")
    lease_v = ns["verify_lease"](state, proof(viewer, "viewer"))
    assert ns["lease_allows"](lease_v, B, "read") and not ns["lease_allows"](lease_v, B, "mutate")
    rejected("stale_lease", ns["verify_lease"], state, proof(a, "agent:b"))
    rejected("lease_scope", ns["require_access"], lease_a, None, "mutate")

    # Human takeover of one window revokes only that window's lease.
    human = acquire("human", {"kind": "window", "target": A}, takeover=True)
    state = ns["read_state"](root)
    rejected("stale_lease", ns["verify_lease"], state, proof(a, "agent:a"))
    for lease, owner in ((b, "agent:b"), (a2, "agent:c"), (viewer, "viewer")):
        ns["verify_lease"](state, proof(lease, owner))
    # Exclusive takeover fences every window and observer session.
    exclusive = acquire("cli", takeover=True)
    state = ns["read_state"](root)
    for lease, owner in ((human, "human"), (b, "agent:b"), (a2, "agent:c"), (viewer, "viewer")):
        rejected("stale_lease", ns["verify_lease"], state, proof(lease, owner))
    assert ns["verify_lease"](state, proof(exclusive, "cli"))["scope"] == {"kind": "exclusive"}
    rejected("lease_held", acquire, "viewer", {"kind": "observer"})
    perform("cli", {"lease": {"token": exclusive["token"], "generation": exclusive["generation"]}}, "release")
    win = acquire("agent:a", {"kind": "window", "target": A})
    # Build, simulator and visual operations require the exclusive lease.
    rejected("lease_scope", perform, "agent:a", {"lease": {"token": win["token"], "generation": win["generation"]},
                                                 "udid": "35bd5396-aba0-446f-8757-3da383c1207b"}, "boot")
    # Expired leases neither block nor authorize.
    state = ns["read_state"](root)
    state["leases"][0]["expiresAt"] = time.time() - 1
    ns["write_state"](root, state)
    rejected("lease_expired", ns["verify_lease"], ns["read_state"](root), proof(win, "agent:a"))
    acquire("agent:z", {"kind": "window", "target": A})
    for corrupt in ({"version": 2, "generation": 1, "leases": [{"owner": "x"}]},
                    {"version": 3, "generation": 1, "leases": []}, []):
        (root / "state.json").write_text(json.dumps(corrupt))
        rejected("unsafe_state", ns["read_state"], root)
print("lease scopes, legacy migration, scoped takeover, exclusive fencing and expiry passed")

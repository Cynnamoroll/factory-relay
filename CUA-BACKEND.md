# Native input reuse: Cua Driver

**Decision:** retain Relay's window leases, single-use observations, human
takeover, stream and QA journal. Before adding a new native input route or a
Windows backend, evaluate Cua Driver as the implementation *under* those
controls. Do not run a second, directly agent-accessible driver beside Relay.
No Cua runtime is bundled today.

## Why not a wholesale port?

The [driver README](https://github.com/trycua/cua/blob/04b60eafc3d278190e4b0e583e0e0d9ea8fb9c9a/libs/cua-driver/README.md)
and [native C ABI](https://github.com/trycua/cua/blob/04b60eafc3d278190e4b0e583e0e0d9ea8fb9c9a/libs/cua-driver/rust/include/cua_driver_abi.h)
provide an embedding path. The code is available under the
[MIT license](https://github.com/trycua/cua/blob/04b60eafc3d278190e4b0e583e0e0d9ea8fb9c9a/LICENSE.md).
If redistributed, preserve the upstream notice, audit the packaged dependencies
and **exclude the optional perception extension**; its detector is not MIT.

The [driver contract](https://cua.ai/docs/cua-driver/concepts/how-cua-driver-works)
selects a target per call. That is not a Relay lease. Its platform backends offer
AX or UI Automation and other background routes; some apps refuse them. Its
foreground and CDP escalation paths are inappropriate for a window-scoped run.
On Windows the runtime needs an interactive login. On macOS, changing which
process hosts it can change which identity needs Accessibility and Screen Recording.

## Acceptance before enabling a backend

1. Embed a pinned runtime in the permission-owning host, not in the agent.
   Expose only reviewed window operations; no arbitrary tool invocation, browser
   profile attachment, global cursor, implicit foreground retry or broad capture.
2. Bind Cua capture/element tokens to Relay's run, lease generation, exact
   window and process start. Reject mismatches before dispatch. Verify a real
   app effect when possible; an acknowledged event is not a passing check.
3. Keep one capture timeline per target. The action response and replay should
   refer to that timeline; don't require four agents to scrape a video wall or
   start a second recorder. An agent disconnect must release owned native
   resources without deleting recorded evidence.
4. On **each OS**, test four overlapping sessions through the public API with
   changing fixture windows. Check per-window outcomes, cursor and focus,
   capture isolation, lease revocation, cleanup, worst warm action time and
   actual presented fps. A Linux mock is not a Windows or Mac qualification.

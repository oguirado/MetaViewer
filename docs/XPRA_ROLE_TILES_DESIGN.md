# XPRA role tiles

Roles are immutable per admitted identity profile. `MV_SRF_PROFILES` accepts an additive `role` property (`agent` by default, or `human`). Add capsule chooses the role and an available configured identity; it cannot reinterpret an existing capsule. Human profiles require 1280×900 [TARGET]. Provisioned Chromium profile directories must be private and owned by the native capsule UID; identity provisioning remains an operator prerequisite. The adapter creates them with human ownership, before publishing the surface. The core records human-owned creation as an immutable human role and refuses proposals as Policy at the existing ownership gate. Emergency Control/Release on agent-created surfaces keeps its existing fences.

Electron resolves the capsule and socket through private adapter binding records under `MV_SRF_STATE_DIR/human-bindings`; renderer IPC carries surface ids and bounds only. A token stays in Electron main and is injected into child requests by session hooks. The bridge listens on loopback only, strips credentials before the Unix-socket upstream, and destroys HTTP and upgraded WebSocket connections on close. No tokenless native view listener is used. Debian clients missing the jquery symlink use the public host asset `/usr/share/javascript/jquery/jquery.js`, with an optional host-only `MV_XPRA_JQUERY` override.

Human tiles mount a sandboxed native xpra child view; the canvas input path is absent. Agent tiles retain DISPLAY and verified frames. Their optional watch view has both a server-side readonly acknowledgement and main-process input suppression. Agent emergency control first closes a watch overlay; its existing canvas input path remains intact.

Human input is appended immediately to a private JSONL file in the existing `MV_RECORDING_DESTINATION` directory. Missing destination refuses the human view. Printable keys are redacted before IPC; main redacts again. Trace failure closes the child and bridge. Geometry uses the fixed capsule coordinate space, with tile coordinates recorded separately. Tile removal, hiding, capsule loss and window teardown revoke the overlay.

## Verification gates

- Lock isolation: isolated HOME and XDG_CONFIG_HOME under the authorized temporary root; reject SINGLE_INSTANCE or BOOT_REFUSED, never retry against the operator profile.
- Ownership: human creation yields human control and Policy for agent proposals; contrast: bypass role protection must fail tests.
- View lifecycle: human mounts native writable view and agent watch acknowledges readonly before mounting; contrast: forwarded key/click must fail.
- Trace: event lines exist before close and sensitive keys are absent; contrast: retain a printable key or delay flushing until close must fail.
- Cleanup: closing tile destroys bridge and upgraded sockets; contrast: leave a WebSocket open must fail.
- Existing emergency tests and frozen contract checks must remain green; no tests are weakened.

The execution header permits one own capsule, so live work must use at most one own capsule and cannot perform the later requested simultaneous pair. The requested design filename was AUSENTE; this file is the selected design artifact. Scope is limited to the supplied worktrees and authorized isolated runtime.

# ARM64 MicroVM command capsule

This candidate extends the fixed-job ARM64 MicroVM with sequential shell commands. It uses a separate `guest_command_* /v0.2` contract family; the earlier `headless_*` fixed-job path remains available in its own mode.

The intended interaction is **Add capsule → MicroVM — ARM64 → enter a command → Run → inspect stdout/stderr and exit status → Stop capsule**. Cancel is available after the guest has accepted a running command. The command panel is not an interactive PTY or an SSH client.

## Evidence and remaining integration

A real, bounded backend episode executed commands as guest UID 10000, wrote and read a file across separate jobs, returned stderr and exit code 7, handled cancellation and timeout, executed subsequent jobs, and powered off. The native process, its runtime files and its cgroup were then observed absent. The earlier fixed-job capsule also has an independently reviewed UI create/result/stop episode.

The general-command path still requires its own packaged UI and SDK acceptance. A backend test, a compiled panel or a successful source test does not establish that a currently installed MetaViewer package exposes this feature. The release integrator must include the candidate and supply an admitted host profile before the option becomes available.

## Authority and lifecycle

The host profile pins Firecracker, the guest kernel, the static guest broker and BusyBox. The renderer and AI caller supply a guest command and relative guest working directory, not host executable paths, images, process IDs, credentials or resource overrides. The authenticated core binds the owner, reserves capacity before creation and keeps ownership when an outcome is unknown.

The SDK entry is `metaviewer_agents.guest_command.GuestCommandSession.claim(entered_tool_client)`. It owns that authenticated client's I/O until closed. `create()`, `start()`/`run()`, `cancel()` and `stop()` use the core protocol; they do not invoke a host shell. A job handle exposes acceptance and its final result. Closing the SDK connection does not itself prove that a VM has stopped.

Files remain in the guest workspace between jobs. Each job gets a new shell and an explicit working directory, so shell variables and `cd` do not implicitly carry to the next job. Stop destroys the guest's disposable state. Output is treated as bytes/text and cannot execute terminal control actions on the host.

The first profile keeps a bounded guest lifetime and the existing external service limits. It is suited to short disposable automation and tests. Long-running services, networking, arbitrary image import, graphical MicroVMs and x64 support are separate work. Do not infer them from this command capsule.

## Deployment mode

The explicit command-only mode uses `MV_GUEST_COMMAND_ONLY=1`, a protected `MV_GUEST_COMMAND_PROFILE`, and its matching `MV_GUEST_COMMAND_AGENT_INSTANCE`. The old `MV_HEADLESS_ONLY` variable must be absent. The outer profile is `mv-guest-command-host/v1`; its controller configuration is `guest-command-host-config/v1`.

This mode deliberately avoids automatic graphical backend startup. The ordinary graphical VM profile is a separate configured path. The broader unified architecture/image/mode picker remains the goal in the [VM and MicroVM roadmap](../VM_MICROVM_ROADMAP.md).

# Go surface daemon bridge
Future bridge between the Rust authority and the OpenSuperficies daemon.
Implements envelope, surface_request, surface_event, surface and frame_ref.
Translates capsule metadata and isolated RGB RAM capture without using lossy transport frames.
No application code is present.

The configured dispatch seam is `daemon.NewHandler(manager, publisher)`, passed to
`ipc.Serve` with an explicit authority policy. The CLI entry point still refuses
startup without that policy. The handler accepts the authenticated hello, routes
surface requests to the manager, and publishes an initial frame after create
[TARGET, unit decision]. Continuous capture uses the separate subscription service.

Transport configuration requires separate `HelloTimeout` and `ReadTimeout` values:
hello is capped at 5 seconds [CITED: contracts/v0.2/README.md transport table],
subsequent idle reads at 30 seconds [CITED: same table]. Shorter explicit values
are accepted; missing values refuse startup.

`TestConfiguredDaemonLifecycle` drives a Unix socket through fake CLI processes
and checks created, frame_ready (including published RGB bytes and hash),
input_applied, then state_changed/destroyed. Its disconnected-handler twin must
fail the same lifecycle oracle. The IPC tests cover individual admission refusals
and outbound failures; Wrap failure occurs after handler execution by design.
All test policies use in-memory replay state and are not production authorities.

The runtime reads `MV_SRF_STATE_DIR` from its own environment. Before every
`srf-identity-surface` invocation the process runner checks that this is a
current-uid directory with mode `0700` [TARGET] and appends `--state-dir`.
A missing final directory is created privately; its parent must already exist.
Unset configuration, wrong ownership or permissions, symlinks and caller-supplied
state flags return a typed configuration fault before spawning the CLI. The
surface handler converts this fault to a correlated `surface_event.error`.
`MV_SRF_STATE_DIR` is adapter configuration and is removed from the child
environment. `SRF_IDENTITY_STORE_ROOT` and `SRF_PROXY_REGISTRY` pass through
when set; no identity environment files are read.

`NewProcessRunner` takes an explicit trusted environment snapshot; include
`MV_SRF_STATE_DIR` there when constructing it directly. `NewRuntime` collects it
automatically. Live identity tests use the same setting. Holdings argv remains
unchanged: PACK_OS_CLI and its corrections do not document `--state-dir` for it.

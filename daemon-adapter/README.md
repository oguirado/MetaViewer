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

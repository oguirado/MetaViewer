# Hosted slice and real-process LIVE runner

`node tests/e2e/e2e1_slice/index.js` runs the hosted Authority slice.
`node tests/e2e/e2e1_slice/index.js --live` runs the actual core, adapter and
OpenSuperficies browser. A partial LIVE result exits nonzero with structured
assertions, wire evidence, process logs, commands and return codes on stdout.
No report is written inside the repository.

[TARGET, unit decision] The agent lane uses the production `CoreClient` and
v0.2 envelopes. A minimal test UI socket sends the shipped v0.2 UI contract:
the agents package's frozen UI schema predates take/release. The real core
closed-decodes every request. Only our adapter is paused with SIGSTOP to make
the pending takeover and current-frame readmission deterministic; SIGCONT is
guaranteed before teardown. Readmission observes the core after pausing because
subscription fan-out can already have a newer generation queued.
Daemon events, frames, dispatch and receipts always come from real binaries.

Build offline with tools resolved from PATH or `CARGO`/`GO`:

```sh
"${CARGO:-cargo}" build --offline --manifest-path core/Cargo.toml --bins
"${GO:-go}" -C daemon-adapter build -o "$MV_E2E_ADAPTER_BIN" ./cmd/mv-daemon-adapter
MV_E2E_LIVE=1 node tests/e2e/e2e1_slice/index.js --live
```

Supply `CARGO_TARGET_DIR` for every Cargo invocation and absolute binary paths
in `MV_E2E_CORE_BIN`, `MV_E2E_ADAPTER_BIN` and `MV_E2E_REPLAY_BIN`.
Supply the operator's admitted `MV_SRF_BIN_DIR`, `MV_SRF_LIVE_PROFILE`,
`MV_SRF_LIVE_RAM_ROOT`, `MV_SRF_STATE_DIR`, `SRF_IDENTITY_STORE_ROOT` and
`SRF_PROXY_REGISTRY`. Only the explicitly admitted `mv-live-1` profile is
accepted. Provide `MV_E2E_ELECTRON_BIN` pointing at a local Electron binary
and `xvfb-run` on PATH to exercise `ui/electron/authorityWire.js` without
network access. The relay probe never downgrades the actual frame schema or
claims that delivery alone proves a rendered product tile.

The runner creates temporary pinned core registration for UI, agent and daemon,
then verifies capsule creation, UI frame fan-out, bytes and retained witness;
observe/propose/receipt; stale refusal with unchanged domain state and budget;
pending cancellation, human refusal and release; and fresh-frame readmission.
It pauses the owned adapter, completes an observe barrier, and pauses the owned
core before comparing repeated `mv-replay` results with the matching server
snapshot. The intact journal and checkpoint remain unchanged. Both processes
resume before teardown. A corrupted copy in private archive directories must fail.
The first measured failure stops scenario execution; cleanup always runs.
The LIVE aggregate requires every assertion and cleanup to pass.

The headless relay loads the unchanged product preload and renderer authority
adapter, transfers the real frame through the authority MessagePort, and draws
it with the product frame tile scheduler. The canvas RGB digest must equal the
published frame digest, the projection must admit the generation, and no host
path may reach the renderer. The local test host uses context isolation with an
sandboxed bundled product preload; renderer Node integration is disabled.

Cleanup first requests native destroy through the core. Native control-state
JSON binds opaque container names to the admitted profile: names need not
contain `mv-live-1`. Before launch any existing profile allocation refuses the
run. Fallback stop is limited to names bound to that profile and absent from
the initial Docker inventory, using the explicit native state directory.
Final inventory and profile-state checks must both pass. Identity env files
are never read; unrelated containers are never stopped. Temporary core state
and archives are removed after reporting.

The relay uses the served `app://metaviewer` origin and the product preload.
Its scheduler budget matches the flat numeric budget constructed in `App.vue`
and is frozen before tile creation, as required by the product validator.

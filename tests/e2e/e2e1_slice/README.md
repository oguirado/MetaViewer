# Hosted slice and real-process LIVE runner

## Live stack

`python3 tests/e2e/e2e1_slice/stack.py start --ttl 45m` runs the real core,
adapter, one `mv-live-1` browser capsule, and the shipped Electron entry with
its default `hostBindings.js`. The UI must already be built (`ui/dist/renderer`
and `ui/dist/preload`). Supply the same admitted live environment listed below,
including `MV_E2E_LIVE=1`, `MV_E2E_ELECTRON_BIN` and an owner-only
`XDG_RUNTIME_DIR`. The replay binary is not needed for this stack.

Use `MV_E2E_CORE_BIN` and `MV_E2E_ADAPTER_BIN` for existing executable builds.
Otherwise the supervisor builds offline using `CARGO`/`GO` or tools on PATH;
`CARGO_TARGET_DIR` must be an absolute, worktree-exclusive target directory.
The adapter build sets `GOPROXY=off` and `GOSUMDB=off`.

The stack creates a dedicated authenticated Xvfb display with geometry
`1600x1000x24` [TARGET]. Xauthority and state are owner-only mode `0600`
[TARGET]. TCP listening is disabled. No CDP endpoint or debug flag is used.
The readiness line is:

```text
LIVE_STACK_READY display=:N xauthority=/runtime/metaviewer-live-stack/run-ID/Xauthority capsule=NAME
```

Use the printed `DISPLAY` and `XAUTHORITY` values with the vision tools; for
example `DISPLAY=:N XAUTHORITY=PATH xdpyinfo` or a screenshot/X input tool.
The supervisor confirms an authenticated display and the shipped app window
before creating the capsule through the same core request as `live.py`.
It waits for an ownership-proven capsule and a real frame before READY.

`python3 tests/e2e/e2e1_slice/stack.py stop` requests supervisor cleanup and
waits for its proof. The watchdog also runs cleanup at the TTL, measured from
READY using monotonic time. State under
`$XDG_RUNTIME_DIR/metaviewer-live-stack/state.json` includes process birth
identities, capsule ownership, display, Xauthority and wall-clock expiry.
The supervisor holds the exclusive lock, drains the agent connection, and
records descendants before signaling individual recorded PIDs. Existing
profile allocations, another stack, a running G-W1 probe, missing environment
and host-binding overrides refuse launch. No identity env files are read.
The Electron child receives a cleaned environment excluding the shipped
launcher's loader/runtime injection variables (including inherited
`LD_PRELOAD`); retail admission and sandbox checks remain active.

Cleanup requests native destroy, falls back only to capsules bound to this
profile and absent from the initial inventory, terminates recorded processes
after checking birth identities, removes newly owned native RAM allocations,
and checks published RAM, display sockets and the private runtime tree.
Success removes the state receipt; an uncertain cleanup keeps it and refuses
another start. If the supervisor was externally killed, stop retains the
receipt for operator recovery instead of guessing ownership.
The private `supervisor.log` records startup errors and the verified cleanup
receipt, including recorded process identities; it contains no identity secrets.

[TARGET, unit decision] This detached supervisor is test infrastructure, not
a product launcher API. The mandate is limited to this repository's admitted
live runner, shipped UI and explicitly supplied OpenSuperficies environment.

## Admission runner

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

[TARGET, unit decision] The admitted positive action uses F6 and a full-frame
`changed_region` expectation: the native input must produce a visible browser
focus change, and the real core `wait_verify` verdict must contain
`status: verified` and `receipt.verified: true`, with matching focus, input time,
proposal and frame witnesses. Delivery alone does not pass this assertion.
The frozen `wait_verify` call accepts only proposal ID and timeout, so the
negative comparison uses a test-only Rust helper calling the public core
`verify_receipt` on the same live receipt and retained pixel artifacts. Its
unmodified baseline must verify; changing the comparison proposal's surface
or generation must return `verified: false`. These are verifier binding
controls, not extra wire arguments or synthetic daemon receipts. The runner
compiles the helper offline in a disposable tree and removes it on exit.

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

## Component integration and golden state

[TARGET, unit decision] The separate `tests/e2e/e2e6_slice.test.js` scenario
runs through `tests/e2e/run.py` with its required live flag. A test-owned line
protocol joins the real adapter capsule manager, native process runner and
immutable frame publisher to the real Rust Authority. Chromium renders the
published RGB bytes through the production tileScheduler and checks canvas
pixels before admission. The scenario exercises generation-bound actions,
stale refusal with an identical domain snapshot and unchanged budget,
takeover cancellation, blocked release until drain, fresh-frame readmission,
real adapter input and durable replay. Cross-routing and an absent live flag
are refusing negative controls. Only the native OpenSuperficies CLI boundary
is deterministic; this is component integration, not a qualification of a host
capsule or the production socket/agent UI bridge. The separate LIVE runner
above supplies its own deployment evidence.

The golden fixture declares the expected state independently of the reducer.
Its digest is Python hashlib SHA-256 over sorted compact JSON. The same fixture
is consumed on every architecture; cross-architecture execution requires CI.
The initial frame is included in create; connect is the first journal event.

# Developer demo runbook

Use this runbook to rehearse the live developer harness from a source checkout.
Judges installing the release should use [JUDGE_QUICKSTART.md](JUDGE_QUICKSTART.md).
No live pass or performance result is claimed here.

## What does this harness start?

`stack.py` supervises the source-built core, daemon adapter, shipped Electron UI
and a provisioned browser test capsule. It owns their lifecycle and retains
recovery state when cleanup cannot be proved.

Answers: developer stack; demo scope; supervised lifecycle

The implementation is [stack.py](../tests/e2e/e2e1_slice/stack.py). Its `preflight`
requires a live test profile and built UI; `supervise` starts the components;
`stop_stack` verifies shutdown. This harness is not the release installer and
cannot supply missing private runtime assets.

## What are the prerequisites?

Prepare the pinned UI kit, build the production UI and provision the dedicated
native test identity before starting the harness.

Answers: demo prerequisites; source build; native runtime; display

Follow [INSTALL.md](INSTALL.md) for source-build requirements and
[NOTICE-EVALUATION.md](../NOTICE-EVALUATION.md) for external component access.
Then, from the repository root with `CAPSULE_UI_KIT_REPO` set to the pinned kit:

```sh
node tools/sync_kit.mjs "$CAPSULE_UI_KIT_REPO"
(cd ui && npm ci --offline && npm run build)
```

[stack.py](../tests/e2e/e2e1_slice/stack.py), in `preflight`, requires Docker,
`xdpyinfo` and `xwininfo`; private-display mode also requires Xvfb and `xauth`.
Visible mode needs a reachable current display. The selected identity must be
free, with no existing stack or competing live-slice run. Leave
`MV_CORE_BOOTSTRAP` unset so the shipped host bindings are used.

## Which environment does the harness require?

Set the following variables to existing, verified local resources. Do not copy
another user's runtime directory or browser profile.

Answers: stack environment; identity paths; Electron binary; build directory

| Variable | Required value |
| --- | --- |
| `MV_E2E_LIVE` | Explicit live opt-in, `1` [CITED: stack.py `preflight`] |
| `XDG_RUNTIME_DIR` | Current user's private runtime directory |
| `MV_SRF_BIN_DIR` | Existing directory with the provisioned native runtime executables |
| `MV_SRF_LIVE_PROFILE` | Dedicated test identity; use `mv-live-1` for the documented fixture |
| `MV_SRF_LIVE_RAM_ROOT` | Existing RAM frame-publication directory for that profile |
| `MV_SRF_STATE_DIR` | Existing private native-runtime state directory |
| `SRF_IDENTITY_STORE_ROOT` | Provisioned identity store |
| `SRF_PROXY_REGISTRY` | Provisioned registry file |
| `MV_E2E_ELECTRON_BIN` | Executable local Electron matching [ui/package.json](../ui/package.json) |
| `CARGO_TARGET_DIR` | Absolute build directory dedicated to this checkout |

The list is defined by `REQUIRED`, `preflight` and `binaries` in
[stack.py](../tests/e2e/e2e1_slice/stack.py). A default live start builds the core
in release mode and builds the adapter from the checkout. Prefer that path;
explicit binary overrides must pass the harness's provenance checks.

The [agent-drive script](DEMO_AGENT_SCRIPT.md) additionally needs `VQA_VE_ROOT`
and `MV_WENDER_ROOT` matching [deps.lock](../deps.lock).

## How do I start the stack and recognize readiness?

Start it in a memory-limited user scope, then require `LIVE_STACK_READY` before
interacting with the capsule.

Answers: stack start; readiness marker; private display; visible display

The resource limits below are rehearsal limits [TARGET]: memory high `6G`,
memory maximum `8G`, swap maximum `0`. The time-to-live is `45m`
[CITED: stack.py `parser`].

For a private Xvfb display:

```sh
systemd-run --user --scope -p MemoryHigh=6G -p MemoryMax=8G -p MemorySwapMax=0 \
  python3 tests/e2e/e2e1_slice/stack.py start --ttl 45m --display private
```

For the current desktop display:

```sh
systemd-run --user --scope -p MemoryHigh=6G -p MemoryMax=8G -p MemorySwapMax=0 \
  python3 tests/e2e/e2e1_slice/stack.py start --ttl 45m --display visible
```

The readiness line identifies the selected display, capsule, profile and surface.
A launched process or visible empty wall is not equivalent to readiness.
The harness state for `mv-live-1` is under
`$XDG_RUNTIME_DIR/metaviewer-live-stack`; inspect its `state.json` and run
logs if startup reports `LIVE_STACK_BLOCKED`.
[CITED: ../tests/e2e/e2e1_slice/stack.py, `state_root`, `start`]

## How do I record a rehearsal?

Pass `--record` at stack start with a new MP4 path outside the repository.
This records the selected display, not the application's per-capsule capture.

Answers: rehearsal video; MP4; display recording versus capsule recording

Set `DEMO_MP4` to the desired file path. Its parent directory must exist, the
file must not already exist and `ffmpeg` must be available:

```sh
systemd-run --user --scope -p MemoryHigh=6G -p MemoryMax=8G -p MemorySwapMax=0 \
  python3 tests/e2e/e2e1_slice/stack.py start --display visible --record "$DEMO_MP4"
```

`validate_record_path` checks these conditions and `start_recorder` captures the
stack display. Use [USER_GUIDE.md](USER_GUIDE.md) for per-capsule screenshots and
recordings, or [AUTOMATE_FROM_DEMO.md](AUTOMATE_FROM_DEMO.md) for an operator
recording used to author a workflow.

## What should a rehearsal prove?

Choose a bounded scenario and keep the evidence for each claimed outcome.
For the supplied agent fixture, follow [DEMO_AGENT_SCRIPT.md](DEMO_AGENT_SCRIPT.md).

Answers: demo scenario; what to verify; evidence boundaries

| Observation | Evidence to retain |
| --- | --- |
| Capsule is live | Ready marker, selected surface and a current presented frame |
| Agent action succeeds | Admitted proposal, matching receipt and post-action state |
| Stale evidence is refused | The expected refusal and unchanged protected state |
| Human takes control | Ownership change and refusal of subsequent unauthorized agent input |
| Session is replayable | Successful replay of the preserved journal and witnesses |
| Rehearsal is finished | Confirmed stack cleanup |

The supplied fixtures define their own assertions. Do not present a recording,
a successful launch or a fixture-only pass as release-wide validation. See
[EVIDENCE.md](EVIDENCE.md) and [TESTING.md](TESTING.md).

## How do I stop and handle incomplete cleanup?

Use the supervisor's stop command and require its cleanup result before starting
another run with the same identity.

Answers: stop demo; cleanup; stale supervisor; recovery state

```sh
python3 tests/e2e/e2e1_slice/stack.py stop
```

A completed stop prints `LIVE_STACK_STOPPED` with the resources reported absent.
If state was already absent, the marker says `already_absent=true`; that is not
fresh evidence that an earlier run cleaned up. If the supervisor identity has
changed, the harness retains private recovery state and refuses to signal it.
Do not delete that state just to unblock the next start.
[CITED: ../tests/e2e/e2e1_slice/stack.py, `stop_stack`]

| Condition | Status and next step |
| --- | --- |
| `LIVE_STACK_BLOCKED` at startup | A prerequisite failed; inspect the detail and repair that prerequisite |
| Identity already allocated | Wait for its owning run to finish or recover that run; do not take another holder's lease |
| `LIVE_CAPSULE_LOST` | Capsule loss; default supervision tears down, while explicit tolerance changes that behavior |
| Cleanup deadline or supervisor mismatch | Unconfirmed cleanup; preserve logs and recovery state for inspection |

A successful cleanup result applies to the owned resources of that run. The
harness leaves its persistent configuration until an explicit `reset-config`;
use that command only when intentionally discarding the harness settings.

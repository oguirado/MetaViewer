# MetaViewer

I build MetaViewer as a Linux-first desktop wall of live, isolated application surfaces. I fold, unfold, move, tab, float, hide, show, and take control of surfaces through closed intents admitted and journaled by a Rust authority core (`core/`, [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)), while `pin` stays a UI-local presentation state and an agent observes, proposes, and verifies actions through the same core; the Electron renderer paints frames and submits intents, and never injects input directly. Live evidence to date covers `1` [MEASURED] browser capsule (`1280x900` [MEASURED]) streaming at `2.71` [MEASURED] fps (`192` [MEASURED] `PRESENTED` deliveries, `0` [MEASURED] refused, core frame processing `52.11` [MEASURED] ms p50 per `1280x900` frame); multi-capsule soak to `>= 4` [TARGET] capsules at `>= 10` [TARGET] fps for `10` [TARGET] min remains a target.

## Status

`VERSION` is **0.1.2** [MEASURED: `cat VERSION`; CITED: `VERSION`]. The repository is at commit `a768a684` [MEASURED: `git rev-parse --short HEAD`] (`769` commits on the branch [MEASURED: `git rev-list --count HEAD`]), integrating toward **v0.2.0** [TARGET].

Current gate and suite status on this tree:

- **Offline gate (`tools/gate.sh`).** All `11` legs pass (`PASS aggregate`) [MEASURED: `bash tools/gate.sh`], and the `30`-test gate harness self-test passes (`PASS self-test`, `PASS aggregate`) [MEASURED: `bash tools/gate.sh --self-test`]:
  - `manifests`: `PASS` [MEASURED: `bash tools/gate.sh --leg manifests`]
  - `laws`: `PASS` [MEASURED: `bash tools/gate.sh --leg laws`]
  - `contracts`: `PASS` over `10` v0.1 schemas [MEASURED: `ls -1 contracts/v0.1/*.schema.json | wc -l`] and `21` v0.2 schemas [MEASURED: `ls -1 contracts/v0.2/*.schema.json | wc -l`] with `20` v0.1 fixtures [MEASURED: `ls -1 contracts/examples/*.json | wc -l`] and `488` v0.2 fixtures [MEASURED: `ls -1 contracts/examples/v0.2/*.json | wc -l`] [MEASURED: `bash tools/gate.sh --leg contracts`]
  - `unit`: `408` tests, `OK` [MEASURED: `bash tools/gate.sh --leg unit`]
  - `agents`: `584` tests, `OK` (plus the mutant injection matrix) [MEASURED: `bash tools/gate.sh --leg agents`]
  - `js`: `PASS` against `capsule-ui-kit` `0.2.1` [MEASURED: `bash tools/gate.sh --leg js`; CITED: `ui/kit.lock.json`]
  - `rust`: `256` passed, `0` failed across `42` test binaries [MEASURED: `bash tools/gate.sh --leg rust`]
  - `go`: `7` packages `ok` on native `go test -race -count=1 ./...` plus `7` cross-architecture `GOARCH=amd64` compile/vet checks (`14` `ok` package lines total) [MEASURED: `bash tools/gate.sh --leg go`]
  - `ui`: `2,829` tests across `291` suites (`2,828` pass, `0` fail, `1` skipped) and `430` Vite modules transformed [MEASURED: `bash tools/gate.sh --leg ui`]
  - `ui-smoke`: `2` markers witnessed (`METAVIEWER_SMOKE_OK` and `METAVIEWER_MAIN_SMOKE_OK`) [MEASURED: `bash tools/gate.sh --leg ui-smoke`]
  - `perf`: `PASS` (`10` Python budget tests, `6` `G-PERF` offline matrix cases, and `2` Node process attribution tests) [MEASURED: `bash tools/gate.sh --leg perf`]
- **End-to-end journeys (`tests/e2e/`).** `35` Node journey test files [MEASURED: `ls -1 tests/e2e/*.test.js | wc -l`] and `2` Python E2E test suites [MEASURED: `ls -1 tests/e2e/test_*.py | wc -l`]. Running `tests/e2e/run.py` under `xvfb-run` executes `246` tests across `21` suites (`246` pass, `0` fail, `0` skipped, `0` todo) plus `1` cross-routing negative control [MEASURED: `xvfb-run -a -s "-screen 0 1280x900x24" python3 tests/e2e/run.py`], and the production frame path journey passes `5` of `5` tests (`0` fail, `0` todo) when `MV_E2E_STRICT_RENDERER=1` is set [MEASURED: `MV_E2E_STRICT_RENDERER=1 xvfb-run -a -s "-screen 0 1280x900x24" node --test tests/e2e/e2e25_production_frames.test.js`].
- **CI workflows (`.github/workflows/`).** `5` workflow files [MEASURED: `ls -1 .github/workflows/*.yml | wc -l`] define `26` job keys [MEASURED: `grep -E '^  [a-z0-9-]+:$' .github/workflows/*.yml | wc -l`], with `15` job keys in `.github/workflows/ci.yml` [MEASURED: `grep -E '^  [a-z0-9-]+:$' .github/workflows/ci.yml | wc -l`] where `ci-required` aggregates `10` required `needs` jobs across `x64` (`ubuntu-24.04`) and `arm64` (`ubuntu-24.04-arm`) [CITED: `.github/workflows/ci.yml`]. See [docs/TESTING.md](docs/TESTING.md) for the full job matrix and local commands.

## Features

- **Renderer frame painting through the frame port (`frame_port/v1`, `frame_ack/v0.2`).** When the main process announces a surface stream on the live wall, the preload forwards the stream's `MessagePort` once per stream to the renderer with a closed `frame_port/v1` notice (`type`, `schema`, `surface_id`, `surface_generation`) (`ui/electron/preload.js`). The renderer (`ui/src/frames/framePortRouter.js`, `ui/src/surfaces/SurfaceCanvas.vue`, `ui/src/surfaces/tileScheduler.js`) validates each delivery's closed shape, byte length, and SHA-256 digest, attaches the tile canvas with the registered delivery identity, retains the last painted frame across generation ticks, paints RGB24 pixels onto the canvas, and replies with exactly one `frame_ack/v0.2` (`PRESENTED`, `SUPERSEDED`, `FOLD_DRAIN`, `HIDDEN`, `CONTEXT_LOST`, `SURFACE_DESTROYED`, or `REFUSED`) [CITED: `ui/src/frames/framePortRouter.js`, `ui/electron/framePort.js`]. On the live `mv-live-1` stack, `192` [MEASURED] deliveries over `61.0` [MEASURED] s (`2.71` [MEASURED] fps, `52.11` [MEASURED] ms core p50 per `1280x900` frame) all settle `PRESENTED` with `0` [MEASURED] `REFUSED` or `SUPERSEDED`, and `34/34` [MEASURED] sampled deliveries arrive with `isTrusted=true` and `utilityVerified=true` ([docs/DEMO_RUNBOOK.md](docs/DEMO_RUNBOOK.md)). Optional frame diagnostics (`MV_FRAME_DIAG=1`, `ui/electron/frameDiag.js`) and live QA anchor collection (`MV_QA_ANCHORS=1`, `ui/electron/qaAnchors.js`, `ui/src/qa/anchorCollector.js`) are off by default and refused in packaged retail runs [CITED: `ui/electron/frameDiag.js`, `ui/electron/qaAnchors.js`].
- **Wall layout, fold, and nested depth.** I fold, unfold, move, tab, float, hide, and show tiles through closed `ui_intent/v0.2` layout intents (`7` [MEASURED] operations) admitted and journaled by the Rust core (`core/src/serve/layout.rs`, `ui/electron/authorityWire.js`, `ui/src/wall/SurfacePanel.vue`); `pin` stays a UI-local presentation state. Folding a tile stops canvas draw submissions while capture continues behind it; fold/unfold of a hidden surface is refused rather than dropped, float honours the committed placement echo, and dock-back after float returns the tile to its previous group and position [CITED: `ui/src/App.vue`, `ui/src/wall/WallWorkspace.vue`, `ui/src/wall/SurfacePanel.vue`]. For nested capsules (AC-17), `surface_request/v0.2` `create` carries an optional `nested_depth` of `0` or `1`, admitted only for the `metaviewer-nested` program entry at depth `1` and refused at depth `>= 2` or for non-program kinds [CITED: `contracts/v0.2/surface_request.schema.json`, `core/src/catalog/mod.rs`, `daemon-adapter/internal/capsule/manager.go`].
- **Human and agent control.** I take and release control of any surface through `take_control` and `release_control` (`ui_intent/v0.2`). Human takeover cancels pending agent proposals for that surface with `SURFACE_NOT_AGENT_CONTROLLED` and blocks new agent admission until `release_control` and a fresh frame generation [CITED: `core/src/admission/mod.rs`, `core/src/serve/mod.rs`]. Tile titles use `profile_id` when present (`ui/src/core/hostAdapters.js`), and agent-controlled tiles display `"Agent acting"` only when there is live evidence of an acting agent (`"Agent ready"` otherwise) [CITED: `ui/src/wall/SurfacePanel.vue`, `ui/src/wall/tileStates.js`]. The agent loop (`agents/metaviewer_agents/verify.py`, `agents/metaviewer_agents/wender_bridge.py`, `agents/metaviewer_agents/planner.py`) can use `wender-agent` as planner via `MV_WENDER_PLANNER_CMD`, resolving the checkout through `deps.lock` (`resolve_locked_component("wender-agent")`) and refusing `commit_mismatch` before spawn [CITED: `agents/metaviewer_agents/verify.py`, `agents/metaviewer_agents/wender_bridge.py`, `agents/metaviewer_agents/planner.py`]. On the live `mv-live-1` stack, takeover and release display a `"Request sent."` toast while keeping tile canvas height stable at `307` [MEASURED] px, human typing bursts at `80` [MEASURED] and `20` [MEASURED] ms/key pass with `0` [MEASURED] lost characters and `0` [MEASURED] refusals, `READ` mode clicks cause no scroll and `0` [MEASURED] input operations, the narrated agent loop (`observe` → `propose` → `admit` → `act` → `verify`, `tests/e2e/e2e1_slice/demo_agent_drive.py`) passes `8/8` [MEASURED] checkpoints across repeated runs (including `24` [MEASURED] perceived vision marks and a `STALE_FRAME` refusal negative control) using the external `vision-engine` (`v0.2.0`) and `wender-agent` (`v0.3.0`) pins in `deps.lock`, and every live run ends `LIVE_STACK_STOPPED` with `processes=absent capsule=absent sockets=absent ram=absent state=absent` [CITED: `deps.lock`, `tools/gate_g_ai.py`, `docs/DEMO_RUNBOOK.md`, `docs/DEMO_AGENT_SCRIPT.md`].
- **Capture, recording list, and disk export.** The `metaviewer.capture` namespace provides per-tile screenshot capture and RAM-first recording (`idle` → `starting` → `recording` → `stopping` → `sealed` / `error`) with RAM and journal accounting, reactive per-tile recording chrome on the wall, coalesced per-surface recording list refresh in the UI (`listRecordings` on mount, after `sealed`, `stopped`, and `screenshot` events, and on capsule switch), and write-ahead journaled disk export (`capture_request/v1`) of sealed recordings as deterministic PNG tars under `MV_RECORDING_DESTINATION` (`core/src/serve/capture.rs`, `core/src/record/capture/export.rs`, `ui/src/capture/capturePort.js`, `ui/src/recording/MvRecordingPanel.vue`). Separate from the live wall stream rate (`2.71` [MEASURED] fps on `mv-live-1`), recordings default to `3` [CITED] fps, accept `max_fps` `1..120` [CITED] with values above `60` [CITED] refused as `BUDGET_EXCEEDED`, keep one frame per `1000/fps` [CITED] ms, and journal `dropped_frames` (`core/src/record/capture.rs`, `core/src/serve/capture.rs`, `contracts/v0.2/record_request.schema.json`, `contracts/v0.2/record_event.schema.json`).
- **Multislot and built-in side terminal.** I open a selected surface in the multislot view (`ui/src/multislot/MultislotHost.vue`) with a closed `read` / `write` operator input mode (`read` by default; `read` blocks keystrokes, `write` forwards them) and embedded recording controls. The side terminal overlay (`@xterm/xterm` `6.0.0` and `node-pty` `1.1.0` [CITED: `ui/package.json`]) runs over a dedicated `MessagePort` byte plane (`ui/src/terminal/SideTerminalOverlay.vue`, `ui/electron/terminalHost.js`, `ui/electron/ptyBroker.js`, `ui/electron/ptyUtility.js`) with PTY sizes capped at `500x300` [CITED] (`MAX_COLS = 500`, `MAX_ROWS = 300`) and fixpoint descendant reaping; the overlay, broker, and PTY utility are wired in code while live login-shell session proof remains open.
- **Journal and replay (`mv-replay`).** The Rust core records every admitted or refused session event in a hash-chained JSONL journal (`metaviewer.journal/v1`); `mv-replay` verifies the chain and reproduces the state digest (`rc 0`), refusing corrupted input (`rc 2`), duplicate records (`rc 3`), and witness mismatches (`rc 4`) [CITED: `core/src/bin/mv-replay.rs`].
- **Theme and settings.** XDG settings are closed and validated (`ui/src/settings/settingsModel.js`, `ui/src/settings/settingsHost.js`), switching between `mv-light` and `mv-dark` with AA contrast checked and zero bundled fonts (`tests/test_theme.py`).
- **Contracts first.** `21` versioned JSON schemas [MEASURED: `ls -1 contracts/v0.2/*.schema.json | wc -l`] in `contracts/v0.2/` and `10` closed schemas [MEASURED: `ls -1 contracts/v0.1/*.schema.json | wc -l`] in `contracts/v0.1/`; a new message type requires its schema and valid/invalid examples before any producer or consumer code [CITED: `LAWS.md` L3].
- **Not available yet.** Features not wired end to end report explicit refusal states rather than faking behavior:
  - The Storyboard / creative screen (`ui/src/creative/CreativeCapsule.vue`) has no wire schema yet and reports `Creative service unavailable.` (`CREATIVE_SERVICE_UNAVAILABLE`) [CITED: `ui/src/App.vue`].
  - Catalog management in the UI beyond the closed `4`-kind launcher set (`identity-browser`, `program`, `holdings-app`, `desktop`) is not available yet [CITED: `ui/src/catalog/CatalogLauncher.vue`].
  - Legacy `mvctl observe` without `--v02` is not available and exits with `unsupported_operation` (rc `2`; use `mvctl --v02 observe`) [CITED: `agents/metaviewer_agents/mvctl.py`].
  - Direct agent `observation` envelope intake on the core (outside `mv_tool_call`) is not available yet and returns a journaled `POLICY` verdict [CITED: `docs/ARCHITECTURE.md`].
  - The `100,000`-case nightly property entrypoint in `.github/workflows/volume.yml` and the `G-NOVAC` meta-oracle interface in `.github/workflows/ci.yml` are not available yet (`ABSENT — do not invent`) and emit `BLOCKED` / `NOT_APPLICABLE` receipts [CITED: `.github/workflows/volume.yml`, `.github/workflows/ci.yml`].
  - OS-level desktop installers (`.deb`, `.rpm`, Flatpak, AppImage) and macOS/Windows builds are not available [CITED: `docs/INSTALL.md`, `.github/workflows/ci.yml`].

## Platform

I build Linux-first: I develop and test on Linux [CITED: `docs/USER_GUIDE.md`]. The packaged product targets **`linux-arm64`** (`aarch64`) as primary and supports **`linux-x64`** (`x86_64`) [CITED: `ui/tools/package.js`, `.github/workflows/ci.yml`]. macOS and Windows are **not supported**: `build-macos` and `build-windows` in `.github/workflows/ci.yml` only emit `NOT_APPLICABLE` receipts and are never required statuses [CITED: `.github/workflows/ci.yml`].

## Architecture

```text
Electron wall + terminal          Rust authority core           Go daemon adapter
(snapshots in, intents out)       (admits, journals, serves)    (capsule bridge)
        |                                  |                            |
        +--- envelope/v0.2 over NDJSON ----+--- surface_request/event --+
        |     core.sock + frame_port/v1    |        core.sock           |
        |                                  |                            v
        |                                  |                    OpenSuperficies
        |                                  |                    capsules (rgb24,
        |                                  |                     /dev/shm ramws)
        |                                  |
        |                          Python agents (observe/propose/verify)
        |                          vision-engine + wender-agent behind core admission
```

Electron renders state and submits intents; it never injects input [CITED: `docs/ARCHITECTURE.md`]. I can take control from an agent at any time; every action is admitted by the core and journaled.

## Quickstart

### Prerequisites

| Tool | Required | Installed on reference host |
| --- | --- | --- |
| Rust | `1.97` [CITED: `Cargo.toml` `rust-version`] | `rustc 1.97.0` [MEASURED: `rustc --version`] |
| Rust formatter | `1.92.0` [CITED: `tools/gate.sh`] | `rustfmt 1.8.0-stable` [MEASURED: `rustup run 1.92.0 cargo fmt --version`] |
| Go | `1.26.0` [CITED: `daemon-adapter/go.mod`] | `go1.26.4 linux/arm64` [MEASURED: `go version`] |
| Node | `>=24` [CITED: `ui/package.json` `engines.node`] | `v24.14.0` [MEASURED: `node --version`] |
| Python | `>=3.11` [CITED: `agents/pyproject.toml`] | `Python 3.12.3` [MEASURED: `python3 --version`] |
| Capsule UI kit | `0.2.1` (`bf31bc201987206d16dbd88d93102f9d5ce026f9`) [MEASURED: `python3 -c 'import json; print(json.load(open("ui/kit.lock.json"))["version"])'`; CITED: `ui/kit.lock.json`] | via `CAPSULE_UI_KIT_REPO` |
| Electron dist | `44.9.2` local files [CITED: `ui/package.json`] | via `ELECTRON_OVERRIDE_DIST_PATH` |

External components stay in their own repositories, pinned in `deps.lock` (`3` components [MEASURED: `python3 -c 'import json; print(len(json.load(open("deps.lock"))["components"]))'`]) and never copied: `vision-engine` `v0.2.0` (`9bbb49f220837388e1ab90c34ae0eedee27a66eb`), `wender-agent` `v0.3.0` (`7648b258d1d04953bacffe8627de5acd7c75d817`), and `opensuperficies` `os-cu-w9-mv1` (`a9ac1ac8543872b428990ea23fa2629cd0a6d1d5`) [CITED: `deps.lock`].

See [docs/INSTALL.md](docs/INSTALL.md) for the full Linux (`arm64` and `x64`) installation, deterministic tarball packaging (`scripts/bootstrap.sh` and `ui/tools/package.js`), and troubleshooting guide.

### Build

```sh
export CARGO_TARGET_DIR=$HOME/.cache/cargo-target/metaviewer
cargo build --offline -p metaviewer-core
go -C daemon-adapter build ./...
node tools/sync_kit.mjs "$CAPSULE_UI_KIT_REPO"
cd ui && npm ci --offline && npm test && npm run check && npm run build
```

### Run

```sh
# Core: config + runtime dir are mandatory (see core/src/bin/metaviewer-core.rs)
MV_CORE_CONFIG=/path/to/core.json XDG_RUNTIME_DIR=/run/user/$UID "$CARGO_TARGET_DIR/debug/metaviewer-core"
# Adapter: takes no arguments; configuration comes from the environment
go -C daemon-adapter run ./cmd/mv-daemon-adapter
# UI smoke (needs ELECTRON_OVERRIDE_DIST_PATH + xvfb-run)
cd ui && npm run smoke
# CLI probe (legacy v0.1 envelope in FILE, or pass --v02 for the v0.2 tool protocol)
python3 agents/metaviewer_agents/mvctl.py propose --json-arg FILE --timeout-ms 5000 \
  --max-line-bytes 65536 --max-reply-bytes 65536
# Hosted slice (no devices needed); --live needs the admitted capsule profile + env in tests/e2e/e2e1_slice/README.md
node tests/e2e/e2e1_slice/index.js
```

### Checks

```sh
python3 tools/check_laws.py
python3 tools/check_laws.py --version
python3 tools/check_contracts.py
python3 -m unittest discover -s tests -v
bash tools/gate.sh                   # all 11 legs: manifests, laws, contracts, unit, agents, js, rust, go, ui, ui-smoke, perf
bash tools/gate.sh --leg contracts   # single leg
bash tools/gate.sh --self-test       # 30 harness self-tests
```

Secret scanning runs in `.github/workflows/secrets.yml` (pinned `gitleaks` `v8.18.4` history scan plus controls).

Enable the local commit hook before contributing:

```sh
git config core.hooksPath .githooks
```

## Repo map

| Path | Purpose |
| --- | --- |
| `README.md` | Project overview and quickstart (this file) |
| `LAWS.md`, [docs/COMMIT_LAWS.md](docs/COMMIT_LAWS.md) | Repository and commit policy |
| `VERSION`, `CHANGELOG.md`, `deps.lock` | Release identity and external component pins |
| [contracts/v0.2/](contracts/v0.2/) | `21` versioned v0.2 JSON wire schemas [MEASURED: `ls -1 contracts/v0.2/*.schema.json | wc -l`] |
| `contracts/v0.1/`, `contracts/examples/` | `10` closed v0.1 schemas [MEASURED: `ls -1 contracts/v0.1/*.schema.json | wc -l`] and valid/invalid fixtures |
| `core/` | Rust authority core (`metaviewer-core`, `mv-replay`) |
| `daemon-adapter/` | Go surface-daemon bridge (`mv-daemon-adapter`) |
| `agents/` | Python agent adapters, `mvctl`, MCP server |
| `ui/` | Electron `44.9.2` + Vue `3.5.43` wall, frame port router, terminal, multislot, capture |
| `tests/e2e/` | `35` Node E2E journeys [MEASURED: `ls -1 tests/e2e/*.test.js | wc -l`], `2` Python E2E suites [MEASURED: `ls -1 tests/e2e/test_*.py | wc -l`], and `e2e1_slice/` |
| `tools/gate.sh` | Unified `11`-leg offline gate and `30`-test self-test [MEASURED: `bash tools/gate.sh --self-test`] |
| `tools/`, `tests/`, `.githooks/` | Checkers, unit suites, budget gate (`tools/budget_gate.py`), commit hook |
| `.github/workflows/` | `5` CI workflow files (`ci.yml`, `secrets.yml`, `package.yml`, `build-other.yml`, `volume.yml`) [MEASURED: `ls -1 .github/workflows/*.yml | wc -l`] |
| `scripts/bootstrap.sh` | Deterministic Linux packaging bootstrap |
| [docs/INSTALL.md](docs/INSTALL.md) | Linux (`arm64` and `x64`) installation, packaging, and troubleshooting guide |
| [docs/USER_GUIDE.md](docs/USER_GUIDE.md) | Operator guide for the wall, control handoff, multislot, recording, `mvctl`, and replay |
| [docs/DEMO_RUNBOOK.md](docs/DEMO_RUNBOOK.md) | Live demo launch, screen recording, stop and known issues |
| [docs/TESTING.md](docs/TESTING.md) | Gate legs, live gates, E2E journeys, CI job table, hosted-like checks, and mutation proofs |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Authority, IPC, capture, and replay design |
| [docs/UI_ARCHITECTURE.md](docs/UI_ARCHITECTURE.md) | Shared capsule visual architecture |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Hackathon day-by-day plan and gates |
| [docs/PREEXISTING.md](docs/PREEXISTING.md) | Pre-existing work declaration |
| [META_AI_USAGE.md](META_AI_USAGE.md) | Meta model usage ledger (`377` lanes across `112` rooms [MEASURED: `python3 -c 'import json; d=json.load(open("docs/meta-ai/muse_lanes.json")); print(len(d["lanes"]), len({x["room"] for x in d["lanes"]}))'`]) |

## Contributing

Set both author and committer to the maintainer identity in [docs/COMMIT_LAWS.md](docs/COMMIT_LAWS.md) before committing. CI repeats the checks independently of the local hook. Components talk only through versioned JSON contracts: a new message type needs its schema before the code that sends or reads it [CITED: `LAWS.md` L3].

## Pre-existing vs built during the event

Everything runnable in this repository is built during the event; the v0.1 scaffold, design notes, and external private components predate it. See [docs/PREEXISTING.md](docs/PREEXISTING.md) for the item-by-item declaration.

## License

MetaViewer is licensed under the [PolyForm Strict License 1.0.0](LICENSE). The external components it integrates (`wender-agent`, `vision-engine`, `OpenSuperficies`, and `capsule-ui-kit`) are proprietary and are not covered by this license.

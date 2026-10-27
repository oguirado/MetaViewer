# MetaViewer

I built MetaViewer as a wall of live, isolated application surfaces. I fold, unfold, pin and take control of surfaces while an agent keeps observing, acting and verifying outcomes, including on hidden surfaces [TARGET]. I designed perception and reasoning to use Meta models through the Meta Model API [TARGET], with vision-engine for capture analysis and wender-agent for input execution [CITED: docs/ARCHITECTURE.md]; the built-in terminal also accepts any provider CLI I choose [TARGET].

## Status

I am an indie developer building MetaViewer, a Linux-first desktop wall of live capsules, during the hackathon build period [CITED: docs/ROADMAP.md]. `VERSION` reads **0.1.2** [CITED: VERSION]. The public repository integrates toward **v0.2.0** [TARGET] on `bridge/integration` (head `2015cbfc`, 38 green integrations on day 2 and 142 integrations total [MEASURED]).

What is proven on the real stack today:

- Live gate G-W1 passes 11/11 assertions on two consecutive runs on head `f92edd6c` [MEASURED], with the agent receipt `verified: true` by pixel verification (`"frame-bound witness matched"`).
- Live gate G-AI passes 8/8 assertions (`A1`–`A8`) on two consecutive runs on base `9055b82d` with `receipt_verified: true` and 19/19 negative controls [MEASURED]: `vision-engine` and `wender-agent` drive a real capsule through core admission.
- The full 10-leg offline gate (`tools/gate.sh`) and its 25-test harness self-test (`tools/gate.sh --self-test`) pass on the integration head [MEASURED: docs/TESTING.md].

Hosted CI on GitHub Actions is fully green on both Linux architectures (20 of 20 jobs on the v0.1.2 commit `b8ec7413`) [MEASURED]. Still ahead for **v0.2.0** [TARGET]: a 10-minute wall soak, visual QA polish, and the demo video finish. The product is about 70% toward the v0.2.0 milestone [TARGET].

## Features

- **Wall of live capsules.** I watch real browsers and apps running in isolated OpenSuperficies containers as tiles on one wall (4 tiles at 24.93 fps measured telemetry [MEASURED]). I fold, unfold, pin, move, tab, float, hide and show tiles through closed `ui_intent/v0.2` layout intents admitted and journaled by the Rust core (`core/src/serve/layout.rs`, `ui/electron/authorityWire.js`).
- **Human control first.** I take control from the agent at any time; every action is admitted by the Rust core and journaled [CITED: docs/ARCHITECTURE.md]. Human takeover, pending proposal cancellation (`SURFACE_NOT_AGENT_CONTROLLED`), human refusal, release, and fresh-frame readmission pass live in G-W1 (11/11 twice [MEASURED]).
- **AI agent acts on real capsules, with verified receipts.** The agent loop (`observe` → `propose` → `admit` → `act` → `verify`) runs against a live capsule: G-AI passes 8/8 twice with `receipt_verified: true` [MEASURED], and G-W1 passes 11/11 twice with `verified: true` [MEASURED]. Perception uses `vision-engine` and input execution uses `wender-agent`, both external and pinned in `deps.lock` (`vision-engine v0.2.0 @ 9bbb49f`, `wender-agent v0.3.0 @ 7648b25`, verified at runtime in the live receipts [CITED: deps.lock; MEASURED]).
- **Journal and replay integrity.** The core keeps a hash-chained journal; `mv-replay` reproduces the snapshot digest on repeated replay (rc `0` [MEASURED]) and refuses corrupted journals (`Corrupt`, rc `2` [MEASURED]).
- **Recording in RAM and disk export, per tile.** The `metaviewer.capture` namespace provides per-tile screenshot capture and record-for-AI with RAM and journal accounting, per-tile recording chrome in the UI, and write-ahead journaled disk export (`capture_request/v1`) of sealed captures as deterministic PNG tars under `MV_RECORDING_DESTINATION` (`core/src/record/capture/export.rs`, `ui/electron/captureBridge.js`).
- **Theme and settings.** XDG settings are closed and validated, and the theme gate checks AA contrast with no bundled fonts [MEASURED].
- **Contracts first.** 20 versioned JSON schemas [MEASURED: `ls contracts/v0.2/*.schema.json | wc -l`] in `contracts/v0.2/` (plus 10 closed schemas in `contracts/v0.1/` [MEASURED]); a new message type needs its schema before the code that sends or reads it [CITED: LAWS.md L3].
- **Built-in terminal.** The wall shell includes a built-in terminal (`@xterm/xterm` 6.0.0 and `node-pty` 1.1.0 [CITED: ui/package.json]) that also accepts any provider CLI I choose [TARGET].

## Platform

I build Linux-first: I develop and test on Linux [CITED: docs/USER_GUIDE.md]. The packaged product targets **linux-arm64** as primary [TARGET] [CITED: docs/ROADMAP.md], and the hosted CI matrix runs `ubuntu-24.04` on both **arm64 and x64** [CITED: .github/workflows/ci.yml], so **linux-x64** is supported. macOS and Windows are **not supported**: `build-macos` and `build-windows` in `.github/workflows/ci.yml` only report platform applicability and are never required statuses [CITED: .github/workflows/ci.yml].

## Architecture

```text
Electron wall + terminal          Rust authority core           Go daemon adapter
(snapshots in, intents out)       (admits, journals, serves)    (capsule bridge)
        |                                  |                            |
        +--- envelope/v0.2 over NDJSON ----+--- surface_request/event --+
        |          core.sock               |        surfaces.sock       |
        |                                  |                            v
        |                                  |                    OpenSuperficies
        |                                  |                    capsules (rgb24,
        |                                  |                     /dev/shm ramws)
        |                                  |
        |                          Python agents (observe/propose/verify)
        |                          vision-engine + wender-agent behind core admission
```

Electron renders state and submits intents; it never injects input [CITED: docs/ARCHITECTURE.md]. I can take control from an agent at any time; every action is admitted by the core and journaled.

## Quickstart

### Prerequisites

| Tool | Required | Installed here [MEASURED] |
| --- | --- | --- |
| Rust | 1.97 [CITED: Cargo.toml `rust-version`] | 1.97.0 (`rustc --version`) |
| Go | 1.26.0 [CITED: daemon-adapter/go.mod] | go1.26.4 (`go version`) |
| Node | >= 24 [CITED: ui/package.json `engines`] | v24.14.0 (`node --version`) |
| Python | >= 3.11 [CITED: agents/pyproject.toml; tools/gate.sh uses `tomllib`] | 3.12.3 (`python3 --version`) |
| Capsule UI kit | Checkout pinned by ui/kit.lock.json (v0.2.0) | via `CAPSULE_UI_KIT_REPO` |
| Electron dist | 44.9.2 local files [CITED: ui/package.json] | via `ELECTRON_OVERRIDE_DIST_PATH` |

External components stay in their own repositories, pinned in deps.lock and never copied: vision-engine v0.2.0, wender-agent v0.3.0, OpenSuperficies os-cu-w9-mv1 [CITED: deps.lock].

I build and run from source (below). A deterministic Linux package build exists (314.8 MB, byte-identical across two builds [MEASURED]) with clean-install checks via `scripts/bootstrap.sh` (needs `MV_PKG_OUT`, `CAPSULE_UI_KIT_REPO`, and local Electron files via `MV_ELECTRON_ZIP_DIR` or `ELECTRON_OVERRIDE_DIST_PATH` [CITED: scripts/bootstrap.sh]) and `npm run package` in `ui/` [CITED: ui/package.json]; while hosted CI package runs complete, building from source stays the primary documented path [CITED: docs/USER_GUIDE.md].

### Build

```sh
export CARGO_TARGET_DIR=$HOME/.cache/cargo-target/metaviewer
cargo build --offline -p metaviewer-core
go -C daemon-adapter build ./...
node tools/sync_kit.mjs "$CAPSULE_UI_KIT_REPO"   # from repo root
cd ui && npm ci --offline && npm test && npm run check && npm run build
```

### Run

```sh
# Core: config + runtime dir are mandatory (see core/src/bin/metaviewer-core.rs)
# Binary lands under $CARGO_TARGET_DIR/debug/ when CARGO_TARGET_DIR is set
MV_CORE_CONFIG=/path/to/core.json XDG_RUNTIME_DIR=/run/user/$UID $CARGO_TARGET_DIR/debug/metaviewer-core
# Adapter: takes no arguments; configuration comes from the environment
go -C daemon-adapter run ./cmd/mv-daemon-adapter
# UI smoke (needs ELECTRON_OVERRIDE_DIST_PATH + xvfb-run)
cd ui && npm run smoke
# CLI probe (legacy v0.1 envelope in FILE)
python3 agents/metaviewer_agents/mvctl.py propose --json-arg FILE --timeout-ms 5000 \
  --max-line-bytes 65536 --max-reply-bytes 65536
# Hosted slice (no devices needed); --live needs the admitted capsule profile + env in tests/e2e/e2e1_slice/README.md
node tests/e2e/e2e1_slice/index.js
```

### Checks

No package installation is required for the standard-library checks:

```sh
python3 tools/check_laws.py
python3 tools/check_laws.py --version
python3 tools/check_contracts.py
python3 -m unittest discover -s tests -v
tools/gate.sh                        # all legs: manifests, laws, contracts, unit, js, rust, ui
tools/gate.sh --leg contracts        # single leg; PASS [MEASURED: rc 0]
```

Secret scanning is scoped to its own workflow (`.github/workflows/secrets.yml`: pinned gitleaks history scan plus controls), not to `tools/gate.sh`.

Enable the local hook when preparing to contribute:

```sh
git config core.hooksPath .githooks
```

## Repo map

| Path | Purpose |
| --- | --- |
| `README.md` | Project overview and quickstart (this file) |
| `LAWS.md`, `docs/COMMIT_LAWS.md` | Repository and commit policy |
| `VERSION`, `CHANGELOG.md`, `deps.lock` | Release identity and component pins |
| `contracts/v0.2/` | Versioned JSON wire schemas |
| `contracts/v0.1/`, `contracts/examples/` | Closed schemas and valid/invalid fixtures |
| `core/` | Rust authority core (`metaviewer-core`, `mv-replay`) |
| `daemon-adapter/` | Go surface-daemon bridge |
| `agents/` | Python agent adapters, `mvctl`, MCP server |
| `ui/` | Electron 44 + Vue wall, terminal, multislot |
| `tests/e2e/e2e1_slice/` | Hosted slice + live core/adapter/capsule runner |
| `tools/gate.sh` | Unified offline gate (all legs) |
| `tools/`, `tests/`, `.githooks/` | Checkers, suites, commit hook |
| `.github/workflows/ci.yml` | Unified CI matrix (ubuntu-24.04 x64 + arm64) |
| `.github/workflows/secrets.yml` | Secret scanning (gitleaks + controls) |
| `scripts/bootstrap.sh` | Packaging bootstrap (needs `MV_PKG_OUT`, kit checkout, Electron files) |
| `docs/ARCHITECTURE.md` | Authority, IPC, capture and replay design |
| `docs/UI_ARCHITECTURE.md` | Shared capsule visual architecture |
| `docs/ROADMAP.md` | Hackathon day-by-day plan and gates |
| `docs/PREEXISTING.md` | Pre-existing declaration: what predates the event |
| `META_AI_USAGE.md` | Meta AI usage ledger |

USER_GUIDE and TESTING guides are planned for v0.2.0.

## Meta AI usage

I build MetaViewer with Meta Muse Spark 1.3 as my default context feeder and parallel generator [CITED: META_AI_USAGE.md]: I cut work into rooms (one shared byte-identical prefix, N independent lanes at effort `max`), verify every lane by gates before integrating, and design prompts cache-first so lanes after the first read the shared prefix from the provider cache [CITED: META_AI_USAGE.md]. Lanes cover API research, architecture audits, context packs, wire contracts, subsystem code, adversarial review, tests, fixes, and hand-off quizzes, under two orchestrators (product conductor and UI orchestrator) [CITED: META_AI_USAGE.md].

Totals to date [CITED: META_AI_USAGE.md]: 285 lanes launched (55 pre-event design, 230 build period), 285 finished OK, 14,739 agent steps, 37.3 lane-hours of agent work, 95.6% prompt cache hit (1,362,121,089 cache-read input tokens vs 61,975,714 fresh input tokens), $11.572 total cost ($0.0406 per lane), across 61 rooms with a peak of 24 concurrent lanes [MEASURED from lane start/end, CITED: META_AI_USAGE.md]. The ledger regenerates from raw run records after every batch; per-lane data lives in `docs/meta-ai/muse_lanes.json` and the full ledger is in `META_AI_USAGE.md` [CITED: META_AI_USAGE.md].

## Contributing

Set both author and committer to the identity in `docs/COMMIT_LAWS.md` before committing. CI repeats the checks independently of the local hook. Components talk only through versioned JSON contracts: a new message type needs its schema before the code that sends or reads it [CITED: LAWS.md L3].

## Pre-existing vs built during the event

Everything runnable here is built during the event; the v0.1 scaffold, design notes and external private components predate it. See docs/PREEXISTING.md for the item-by-item declaration.

## License

MetaViewer is licensed under the [PolyForm Strict License 1.0.0](LICENSE). The external components it integrates (wender-agent, vision-engine, OpenSuperficies and the capsule UI kit) are proprietary and are not covered by this license.

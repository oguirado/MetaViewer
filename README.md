# MetaViewer

I built MetaViewer as a wall of live, isolated application surfaces. I fold, unfold, pin and take control of surfaces while an agent keeps observing, acting and verifying outcomes, including on hidden surfaces [TARGET]. I designed perception and reasoning to use Meta models through the Meta Model API [TARGET], with vision-engine for capture analysis and wender-agent for input execution [CITED: docs/ARCHITECTURE.md]; the built-in terminal also accepts any provider CLI I choose [TARGET].

`VERSION` reads **0.1.1** [CITED: VERSION]. This tree is past the 0.1.1 documentation-only snapshot: the Rust core, Go adapter, Python agents and Electron UI below are real code under integration toward **v0.2.0** [TARGET].

## What works today vs planned for v0.2.0

| Area | Today | Planned for v0.2.0 |
| --- | --- | --- |
| Contracts | `contracts/v0.2/`: 20 schemas [MEASURED: `ls contracts/v0.2/*.schema.json \| wc -l`]; v0.1 closed with 10 schemas. `ui_intent` covers fold/unfold/hide/show/pin/move/tab/float, `layout_save`/`layout_load`, `take_control`/`release_control` | New message types via L3 (schema + examples first) |
| Rust core | Admission, hash-chained journal, replay (`mv-replay`), supervisor, serve router, plus record, catalog, control and verify modules; bins `metaviewer-core`, `mv-replay` [MEASURED: `cargo metadata --offline --no-deps`] | Seal + capacity measurements |
| Go adapter | Lifecycle/input/frame-subscription/record routing; refuses startup without an explicit authority policy [CITED: daemon-adapter/internal/daemon/run.go]; unconfigured backend returns a typed `configuration` fault [CITED: daemon-adapter/internal/capsule/capsule.go] | Live backend ops (every route returns the typed config refusal until native config lands) |
| Python agents | Envelope v0.1/v0.2 codec, `mvctl propose` CLI (legacy v0.1), MCP server, tools API (`observe`/`propose`/`wait_verify`), agent loop modules (`observe.py`, `executor.py`, `verify.py`, `vision.py`, `client.py`) that treat the core receipt as the only success [CITED: agents/metaviewer_agents/] | `mvctl observe` (reserved skeleton entry [CITED: agents/metaviewer_agents/mvctl.py]) |
| UI wall | Electron 44.9.2 + Vue 3.5.43 shell, tiles, terminal, multislot sources; production host bindings (`ui/electron/authorityWire.js`: propose/intent lanes, frame subscribe, side-terminal; `frameReader`/`framePort`, `terminalHost`, `coreLauncher`); smoke runner loads the bundled app [CITED: ui/README.md] | Production startup (still refuses until the core transport and layout contract are connected); recording/catalog/popout integration |
| AI loop | Stale-frame / replay / bounds refusals in the core; live gate G-W1 passes 8/8 assertions on consecutive runs [MEASURED: `node tests/e2e/e2e1_slice/index.js --live`, see `tests/e2e/e2e1_slice/README.md`]: capsule frames to an Electron tile (canvas SHA equals frame SHA), observe → admit → receipt, stale refusal, takeover/release/readmission, replay equality + corruption refusal | Verified Holdings + browser tasks (AC-05), packaging for linux-arm64 |

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

## Contributing

Set both author and committer to the identity in `docs/COMMIT_LAWS.md` before committing. CI repeats the checks independently of the local hook. Components talk only through versioned JSON contracts: a new message type needs its schema before the code that sends or reads it [CITED: LAWS.md L3].

## Pre-existing vs built during the event

Everything runnable here is built during the event; the v0.1 scaffold, design notes and external private components predate it. See docs/PREEXISTING.md for the item-by-item declaration.

## License

MetaViewer is licensed under the [PolyForm Strict License 1.0.0](LICENSE). The external components it integrates (wender-agent, vision-engine, OpenSuperficies and the capsule UI kit) are proprietary and are not covered by this license.

# MetaViewer User Guide

MetaViewer is a Linux desktop wall of isolated application capsules. The Rust core
admits and journals actions; the Electron wall paints frames and sends typed intents.
Multiple capsules share host RAM admission; current live performance is not measured
by this documentation update. Historical results are scoped in the [README](../README.md#historical-live-evidence).

This guide covers the `0.2.0` candidate and subsequent unreleased features
[CITED: `../VERSION`, `../CHANGELOG.md`]. See [INSTALL.md](INSTALL.md) for host
setup and [TESTING.md](TESTING.md) for verification.

---

## 1. Install and launch

I develop, package, and test on Linux (`x86_64` and `aarch64`). You can either build and run each component from this checkout or build a self-contained Linux tarball (`$MV_PKG_OUT/MetaViewer-linux-<x64|arm64>.tar` and `.sha256`) with `bash scripts/bootstrap.sh` (or `node ui/tools/package.js --arch <x64|arm64>` after building the binaries).

### Prerequisites

| Tool | Pinned / required version | Measured on current host | Where I pin it |
| :--- | :--- | :--- | :--- |
| Rust | `1.97.0` (`rust-version = "1.97"` in `Cargo.toml`; `rustup run 1.92.0 cargo fmt --all --check` in `tools/gate.sh`) | `cargo 1.97.0` `[MEASURED: cargo --version]` | `Cargo.toml`, `deps.lock` |
| Go | `1.26.0` (`go 1.26.0`) | `go1.26.4` `[MEASURED: go version]` | `daemon-adapter/go.mod`, `deps.lock` |
| Node.js | `>= 24` (`24.14.0` in `deps.lock`) | `v24.14.0` `[MEASURED: node --version]` | `ui/package.json` (`engines.node`), `deps.lock` |
| npm | bundled with Node 24 | `11.9.0` `[MEASURED: npm --version]` | `ui/package-lock.json` |
| Python | `>= 3.11` (stdlib-only) | `Python 3.12.3` `[MEASURED: python3 --version]` | `agents/pyproject.toml` (`0` `[MEASURED]` third-party dependencies) |
| Electron | `44.9.2` | `44.9.2` `[MEASURED: python3 -c 'import json; print(json.load(open("ui/package.json"))["dependencies"]["electron"])']` | `ui/package.json` (`dependencies.electron`), `ui/electron/main.js` (`ELECTRON_PIN`) |
| Capsule UI kit | `0.2.1` | `0.2.1` `[MEASURED: python3 -c 'import json; print(json.load(open("ui/kit.lock.json"))["version"])']` | `ui/kit.lock.json` |

### Build from source

```sh
# 1. Stage the exact pinned capsule-ui-kit checkout, then install, test, type-check, and build ui/dist:
node tools/sync_kit.mjs "$CAPSULE_UI_KIT_REPO"
(cd ui && npm ci --offline && npm test && npm run check && npm run build)

# 2. Build the Rust authority core and replay tool:
cargo build --offline

# 3. Build the Go daemon adapter:
(cd daemon-adapter && go build -o mv-daemon-adapter ./cmd/mv-daemon-adapter)
```

I run the full `11`-leg `[MEASURED: bash tools/gate.sh]` verification gate (`manifests`, `laws`, `contracts`, `unit`, `agents`, `js`, `rust`, `go`, `ui`, `ui-smoke`, `perf`) with `bash tools/gate.sh` and its `30`-test `[MEASURED: bash tools/gate.sh --self-test]` harness check with `bash tools/gate.sh --self-test` (see [TESTING.md](TESTING.md)).

### Launch the stack

1. **Start `metaviewer-core`:** requires `MV_CORE_CONFIG` pointing at a JSON configuration file (`session_id`, one `core` registration, and `peers` containing one `agent` and one `daemon` registration, each carrying a `hello/v0.2` matching component version `0.2.0` [CITED: `../VERSION`]) and `XDG_RUNTIME_DIR` for `$XDG_RUNTIME_DIR/metaviewer/core.sock`:

   ```sh
   MV_CORE_CONFIG=/absolute/path/to/core-config.json \
   XDG_RUNTIME_DIR=/run/user/$(id -u) \
     ./target/debug/metaviewer-core
   ```

2. **Start `mv-daemon-adapter`:** configured via environment variables (`MV_SRF_BIN_DIR`, `MV_SRF_STATE_DIR` with mode `0700`, `SRF_IDENTITY_STORE_ROOT`, `SRF_PROXY_REGISTRY`, `XDG_RUNTIME_DIR`, `MV_SESSION_ID`, `MV_CORE_INSTANCE`, `MV_DAEMON_INSTANCE`, plus either `MV_SRF_PROFILES` or `MV_SRF_LIVE_PROFILE` + `MV_SRF_LIVE_RAM_ROOT`; `MV_CONTRACT_DIR` defaults to `contracts/v0.2`):

   ```sh
   MV_SRF_BIN_DIR=/absolute/path/to/srf-bin \
   MV_SRF_STATE_DIR=/absolute/path/to/srf-state \
   SRF_IDENTITY_STORE_ROOT=/absolute/path/to/identity-store \
   SRF_PROXY_REGISTRY=/absolute/path/to/proxy-registry \
   MV_SRF_LIVE_PROFILE=/absolute/profile-id \
   MV_SRF_LIVE_RAM_ROOT=/absolute/path/to/ram-root \
   MV_CONTRACT_DIR=/absolute/path/to/contracts/v0.2 \
   XDG_RUNTIME_DIR=/run/user/$(id -u) \
   MV_SESSION_ID=my-session MV_CORE_INSTANCE=core MV_DAEMON_INSTANCE=daemon \
     ./daemon-adapter/mv-daemon-adapter
   ```

3. **Launch the Electron desktop wall:**

   ```sh
   (cd ui && npx electron .)
   ```

   By default, `ui/electron/main.js` loads the built-in production host bindings in `ui/electron/hostBindings.js` (`createProductionHostBindings`), which wire the core bridge, live `frame_port/v1` pipeline, and in-RAM capture bridge (`ui/electron/captureBridge.js`) automatically. Setting `MV_CORE_BOOTSTRAP` to an external bootstrap module is optional and used only when overriding the default bindings in custom harnesses.

   To run the headless smoke check under `xvfb-run`:

   ```sh
   export ELECTRON_OVERRIDE_DIST_PATH="/absolute/path/to/local/electron/dist"
   (cd ui && npm run smoke)
   ```

---

## 2. Window layout

The window is a kit shell with a top bar, a navigation rail, the capsule wall, a side terminal, an activity strip, and a status bar:

- **Top bar:** renders `MvTopbar` (`ui/src/App.vue`) with `MetaViewer`, an `Add capsule` button (`@new-capsule="launcherOpen = true"`), a `Find a capsule…` search field, and `4` `[MEASURED]` top-bar actions (`Storyboard`, `Settings`, `Open in multislot`, and `Terminal` in `topbarActions` at `ui/src/App.vue`).
- **Rail:** a collapsible overlay sidebar with one `Workspace` group (`Add capsule` plus one entry per connected surface).
- **Wall:** a dockview tile workspace with one panel per capsule (`240x200` `[TARGET]` minimum tile size in `ui/src/wall/WallWorkspace.vue`), supporting tabs, splits, and floating panels.
- **Side terminal:** a right-side resizable `xterm.js` overlay toggled with `Terminal`.
- **Activity strip:** above the status bar, lists up to `8` `[MEASURED: grep -c 'ACTIVITY_LIMIT = 8' ui/src/App.vue]` recent outcome entries (`ACTIVITY_LIMIT = 8` in `ui/src/App.vue` and `MV_ACTIVITY_LIMIT = 8` in `ui/src/activity/activityModel.js`) alongside the total live event count (`showing 8 of N`) in closed human sentences; raw reason codes never appear as visible text.
- **Status bar:** shows the current view crumb (`Main wall`), `Core connected` / `Core not connected`, and the active capsule count.
- **Settings:** switches the window between `Light` (`mv-light`, default) and `Dark` themes live.

---

## 3. Opening a capsule surface and nested depth (`AC-17`)

I launch a capsule from the `Add capsule` button in the top bar or workspace rail, which opens `CatalogLauncher.vue` with `4` `[MEASURED: grep -c "kind:" ui/src/catalog/catalogModel.js]` catalog kinds (`identity-browser`, `program`, `holdings-app`, `desktop` in `ui/src/catalog/catalogModel.js`), or through a `surface_request/v0.2` (`action: "create"`) request.

Each tile header displays the capsule's human label alongside its lifecycle state and control badge (`SurfacePanel.vue`).

### Nested MetaViewer capsules (`nested_depth`)

Spawning a nested MetaViewer capsule (`program: "metaviewer-nested"`) sends `surface_request/v0.2` (`action: "create"`) with `nested_depth: 1` from an outer wall running at `nested_depth: 0` (`1` `[MEASURED: grep -c 'nested_depth' contracts/v0.2/surface_request.schema.json]` property definition in `contracts/v0.2/surface_request.schema.json`, `minimum: 0` `[TARGET]`, `maximum: 1` `[TARGET]`). Any attempt to spawn a capsule at `nested_depth >= 2` is deterministically refused by the contract validator and core (`nested_depth_exceeded` / `NESTED_DEPTH`).

---

## 4. Live frame painting (`frame_port/v1`) and watching an agent act

For canvas capsules, the Electron preload bridge transfers a `MessagePort` to the renderer via `window.postMessage` (`type: "metaviewer:frame-port"`, `schema: "frame_port/v1"`, `surface_id`, `surface_generation` in `ui/src/frames/framePortRouter.js`). Each live frame arrives on the port as a `frame_delivery/v0.2` message with `surface_id`, `surface_generation`, `frame_id`, `seq`, `width`, `height`, `format: "rgb24"`, `byteLength`, `sha256`, `pixelSpec`, and packed `rgb24` `bytes` (plus `utilityVerified: true` when pre-verified by the utility process on a trusted port event; in `live21`, `34` of `34` `[MEASURED]` deliveries arrived with `isTrusted=true` and `utilityVerified=true`, so renderer SHA-256 fallback ran `0` `[MEASURED]` times). The bound tile scheduler (`ui/src/surfaces/tileScheduler.js`) converts and paints the frame via `putImageData` onto `<canvas>` inside `ui/src/surfaces/SurfaceCanvas.vue` and posts a `frame_ack/v0.2` message on the port carrying one of `7` `[MEASURED]` terminal outcomes defined in `FRAME_OUTCOMES` (`ui/src/frames/framePortRouter.js`):

- `PRESENTED` — painted to the renderer `<canvas>` and witnessed.
- `SUPERSEDED` — dropped because a newer `seq` arrived before presentation.
- `FOLD_DRAIN` — drained while the surface is folded.
- `HIDDEN` — acknowledged without painting while the surface is locally hidden.
- `CONTEXT_LOST` — canvas 2D context unavailable or lost.
- `SURFACE_DESTROYED` — surface removed before presentation completed.
- `REFUSED` — malformed frame envelope or mismatched generation/dimensions/digest refused.

### Agent status badge (`Agent acting` vs `Agent ready`)

When a capsule is under agent control (`control === "agent-acting"` in `ui/src/wall/SurfacePanel.vue`):

- The tile badge displays **"Agent acting"** while an agent action is actively executing (`isAgentActingRow(current)` is true: `agentActing === true` or `control_session_state === "ACTIVE"`).
- The tile badge displays **"Agent ready"** when the surface is agent-controlled and idle between actions.

---

## 5. Take control, release control, and local view toggles

- **Take control (`take_control`):** clicking **Take over** sends `ui_intent/v0.2` `take_control` (or `control_request/v0.1` `takeover`) to the core, which immediately closes agent admission for that surface, drains or cancels any in-flight agent proposal (`SURFACE_NOT_AGENT_CONTROLLED` / `human_active`), and switches the tile to `human-control`.
- **Release control (`release_control`):** hands ownership back so agent observation and proposals can resume on a fresh frame generation.
- **Fold / Unfold (`AC-03`):** folding collapses the tile presentation and drains in-flight frames with `FOLD_DRAIN` while the capsule container keeps running; unfolding resumes live frame presentation on a new generation.
- **Local `read` / `write` and hide / show toggles:** switching a surface between `read` and `write` input modes or hiding/showing a tile updates local renderer state without mutating or resetting the capsule's authority state in `metaviewer-core`.

### Human input in WRITE mode (`surface_input/v0.2`)

While I hold human control on an active surface (`control === "human"`), set the tile input mode to `WRITE`, and focus the `<canvas>`, the renderer forwards keyboard and pointer batches through `window.metaviewer.input.send(batch)`. The contract schema is `surface_input/v0.2` (`contracts/v0.2/surface_input.schema.json`), while the renderer input port (`ui/src/input/inputPort.js`) emits `schema: "surface_input/v1"` and the Electron preload/main boundary (`ui/electron/preload.js`, `ui/electron/authorityWire.js`) accepts both `"surface_input/v0.2"` and `"surface_input/v1"`. Each batch carries `surface_id`, the bound stream's `stream_id`, a strictly increasing `seq` (`>= 1` `[TARGET]`), and `1..32` `[TARGET]` events from the closed set (`click`, `key` with `1..8` `[TARGET]` keysym tokens, `type` up to `1024` `[TARGET]` characters, and `scroll` with `dx`, `dy`, `x`, `y`), capped in `INPUT_LIMITS` (`ui/src/input/inputPort.js`) at `60` `[TARGET]` batches/s per surface and `16` `[TARGET]` KiB (`16384` B `[TARGET]`) per batch. Pressing `Escape` releases canvas focus locally without forwarding the key, and the host maps admitted events to `surface_request/v0.2` (`op: "input"`) or returns a typed refusal (`NOT_IN_CONTROL`, `SURFACE_UNKNOWN`, `STALE_STREAM`, `LIMIT`, `NESTED_DISPLAY_ONLY`, `SCHEMA`, `CORE_UNAVAILABLE`).

---

## 6. Stale-frame and refusal indicators

Tile status labels include `Live`, `Stale`, `Connecting`, `Waiting`, `Destroyed`, `Lost`, and `Surface update unavailable`. Refusal codes travel in `data-error-code` and the journaled verdict (`STALE_FRAME`, `SURFACE_NOT_AGENT_CONTROLLED`, `LOCKED_BY_OTHER`, `BUDGET_EXCEEDED`, `OUT_OF_BOUNDS`, `POLICY`), never as raw visible text in the banner.

---

## 7. Replay of a session journal (`mv-replay`)

The core appends every admitted record to a hash-chained journal at `<state-dir>/sessions/<session-id>/journal.jsonl` (`$XDG_STATE_HOME/metaviewer` or `$HOME/.local/state/metaviewer`). Replay and verify a journal offline with `mv-replay`:

```sh
./target/debug/mv-replay --journal <state-dir>/sessions/<session-id>/journal.jsonl \
  --witness-root <witness-root>
```

Pass `--verify-only` to check the hash chain without printing the state hash, or `--anchor` to replay from a pinned anchor file. Exit codes: `0` `[TARGET]` on verified replay, `2` `[TARGET]` on invalid or corrupt input, `3` `[TARGET]` on duplicate record, `4` `[TARGET]` on witness mismatch.

---

## 8. `mvctl` basics

`mvctl` (`agents/metaviewer_agents/mvctl.py`) is the command-line client for core admission. With `--v02`, it speaks the v0.2 protocol (`observe`, `propose`, `wait-verify`) over `--socket` (default `$XDG_RUNTIME_DIR/metaviewer/core.sock`):

```sh
python3 -m metaviewer_agents.mvctl --v02 observe \
  --socket /absolute/path/to/core.sock \
  --session-id my-session --agent-instance agent --core-instance core \
  --surface-id surface-1 \
  --timeout-ms 5000 --max-line-bytes 65536 --max-reply-bytes 65536
```

Refusals print one JSON record to `stderr` (`{"verdict":"refuse","code":"…","error":"…"}`) and leave `stdout` empty.

---

## 9. Multislot screen and RAM-first recording (`MvRecordingPanel.vue`)

I open the multislot screen with **Open in multislot** and return with **Back to wall**. Multislot input defaults to `read` (keystrokes are not forwarded) and switches to `write` when I explicitly toggle it.

Capture is RAM-first (`AC-07`, `ui/src/recording/MvRecordingPanel.vue`, `ui/electron/captureBridge.js`, `core/src/record/capture/export.rs`): while `idle`, zero bytes are written to disk. `MvRecordingPanel.vue` drives the per-capsule in-RAM capture state machine (`idle` -> `starting` -> `recording` -> `stopping` -> `sealed`, bounded at `16` MiB `[TARGET]` and `4096` `[TARGET]` frames in RAM) and in-RAM PNG screenshots (**Take screenshot**). Exporting to disk (**Save recording**, which writes a `ustar` archive of PNG frames to `MV_RECORDING_DESTINATION`) is only enabled after a recording reaches `sealed` and `MV_RECORDING_DESTINATION` is configured; live surfaces render through `ui/src/surfaces/SurfaceCanvas.vue`.

`MvRecordingPanel.vue` queries `captureState.refresh(capsuleId)` (`ui/src/capture/capturePort.js` and `ui/src/recording/recordingModel.js`, backed by `window.metaviewer.capture.status(capsuleId)`) on initial mount, whenever the selected `capsuleId` or `captureState` store changes, and after each capture action (`start`, `stop`, `screenshot`, `exportRecording`, `discard`).

The top-bar **Storyboard** button opens the Storyboard screen, where creative service operations are not wired yet and report `Creative service unavailable.`

---

## 10. Diagnostics and troubleshooting

### Environment flags

| Variable | Default | Effect |
| :--- | :--- | :--- |
| `MV_CORE_BOOTSTRAP` | unset (loads `ui/electron/hostBindings.js`) | Optional path to a custom bootstrap module exporting `createMainBindings`. |
| `MV_FRAME_DIAG` | `0` (off) | When `1` in non-packaged, non-nested runs (`ui/electron/frameDiag.js`), writes bounded `frame_diag/v1` snapshots atomically (`0600`) to `frame-diag.json` in `MV_FRAME_DIAG_DIR` (or `MV_QA_RUN_DIR` / `MV_E2E_RUN_DIR` / `XDG_RUNTIME_DIR`). Refused with `RETAIL_ENV` when `app.isPackaged` is true. |
| `MV_E2E_LIVE` | `0` (off) | When `1` in non-packaged, non-nested runs (`ui/electron/qaAnchors.js`), writes `qa_anchors/v1` DOM geometry snapshots (`0600`) to `qa-anchors.json` in `MV_QA_RUN_DIR` / `MV_E2E_RUN_DIR` / `XDG_RUNTIME_DIR`. Refused with `RETAIL_ENV` when `app.isPackaged` is true. |
| `MV_RECORDING_DESTINATION` | unset | Optional directory path enabling disk export of `sealed` recordings from `MvRecordingPanel.vue`. |
| `ELECTRON_OVERRIDE_DIST_PATH` | unset | Path to a local unpacked Electron `44.9.2` distribution for offline smoke and E2E runs. |
| `CAPSULE_UI_KIT_REPO` | unset | Path to the local `capsule-ui-kit` `0.2.1` `[MEASURED: python3 -c 'import json; print(json.load(open("ui/kit.lock.json"))["version"])']` checkout. |

### Troubleshooting

| Symptom | What I check |
| :--- | :--- |
| Status bar says `Core not connected` | Start `metaviewer-core` first and confirm `$XDG_RUNTIME_DIR/metaviewer/core.sock` exists with owner-only permissions. |
| `This request is unavailable. Please try again.` banner | The host refused the last intent (`data-error-code` on the tile carries the typed code); the tile preserves its state. |
| Nested capsule creation refused | `metaviewer-nested` is allowed at `nested_depth: 1` from an outer wall at `nested_depth: 0`; `nested_depth >= 2` is refused (`nested_depth_exceeded`). |
| Keystrokes do nothing in multislot | Input mode defaults to `read`; toggle the surface input mode to `write`. |
| `Creative service unavailable.` | Storyboard wire schemas are not available yet (see [ROADMAP.md](ROADMAP.md)). |
| `npm run smoke` fails early | Set `ELECTRON_OVERRIDE_DIST_PATH` to a local Electron `44.9.2` distribution, run `npm run build` in `ui/` first, and run under `xvfb-run`. |
| `mv-replay` exits `2`, `3`, or `4` | Invalid/corrupt journal (`2`), duplicate record (`3`), or witness mismatch (`4`). |

---

## Accounts and automation

### Identities and login

Open **Identities** in the top bar to list accounts, create an identity with an id,
account label and comma-separated domains, or delete an identity after confirmation.
Several accounts may share a site's domains; choose a distinct id and label for each.
**Log in** opens the operator's loopback login view. Type credentials only there,
complete login yourself and close the view before automation. Native reservation
refuses agent input while login is open. The menu reports authentication as unknown;
login history is not proof that the session is currently authenticated.
[CITED: `../ui/src/identities/IdentitiesDialog.vue`, `../tools/mv_identity.py`]

### Capsule Network

Open **Network** on the chosen capsule, select a mode, and press **Save network**.
Restart the capsule for the change to take effect. The policy belongs to the admitted
profile, so capsules sharing that profile also share its policy.

| Choice or status | Behavior |
| --- | --- |
| **Open (default)** | Public internet with LAN and host services blocked. Requires identity image `0.2.0` [CITED: `INSTALL.md#capsule-network`], the operator firewall witness and the final Open-ready native pin. |
| **Dedicated proxy with allowlist** | Explicit opt-in. Enter exact hostnames on separate lines. Native proxied support and the proxy binary are required; unsupported policy is refused. |
| **legacy** | Effective mode shown when startup capabilities lack Open. The interim pinned OpenSuperficies is not Open-ready; this status does not establish public-only egress. |

`NET_OPEN_PREREQ` means the deployment cannot start Open; an explicit Open refusal
is never retried or downgraded. See [Capsule network](INSTALL.md#capsule-network)
for installation prerequisites and allowlist rules.
[CITED: `../ui/src/netmode/NetworkPanel.vue`, `INSTALL.md`]

### Use MetaViewer

Click **Use MetaViewer** to copy the text fenced prompt from
[AGENT_ENTRY.md](AGENT_ENTRY.md), verbatim including its final newline. **Copied**
confirms clipboard completion; the button launches no workflow. Give the prompt
to your chosen agent with the operator present. It selects a stored workflow and
runs `python3 -m metaviewer_agents.mw_run` from the agents directory against an
already running browser identity. It neither starts a browser nor types credentials.
Read the JSON result and its private receipt/report before accepting success;
slot values must not contain secrets because process arguments expose them.
[CITED: `../ui/electron/buttonBridge.js`, `AGENT_ENTRY.md`]

### Automate from a demo

Open **Automate from a demo**, choose an existing running identity, and enter a
**Demo id** and **Site name**. Log in yourself before recording and use dummy data:
frames can reveal field contents, although recorded text events retain lengths only.

- **Start** runs the host `tools/mv_demo.py record` command and provides a loopback
  viewer URL. Open it and demonstrate manually.
- **Stop** ends recording and waits for sealed private evidence and read-only restoration.
- **Copy prompt** runs `tools/mv_demo.py prompt` for the sealed demo, then copies its
  authoring prompt with the admitted evidence and site destination substituted.
- **Check site** runs `tools/mv_demo.py check`. It validates through a temporary
  MemoryWeb checkout copy and never runs the authored workflow. Review before replay.

Configure `MV_MEMORYWEB_REPO` for the existing authoring checkout. Packaged demos
also require `MV_OPERATOR_REPO` pointing to an operator-owned MetaViewer checkout.
Evidence is under `$XDG_STATE_HOME/metaviewer/demos/<demo>` (fallback
`$HOME/.local/state/metaviewer/demos/<demo>`), outside the site home.
[CITED: `AUTOMATE_FROM_DEMO.md`, `../ui/src/demo/DemoDialog.vue`, `../ui/tools/package.js`]

### CAPTCHA and bot checks

Execution stops on a CAPTCHA, bot check or login wall with `HUMAN_HANDOFF`.
The notice “CAPTCHA or bot check: solve it in the capsule, then re-run” remains
visible until **Acknowledge** is durably saved; it has no automatic timeout.
Use **Take control**, solve the challenge yourself, then acknowledge the notice.
Release control and explicitly re-run when ready. Acknowledgement only dismisses
the notice: it does not resume, retry or authorize agent CAPTCHA solving.
[CITED: `../ui/src/handoff/HandoffNotice.vue`, `AGENT_ENTRY.md`, `INSTALL.md`]

### Multiple capsules, RAM admission, and private site data

Use **Add capsule** for additional configured profiles. Separate profiles need
nonoverlapping RAM roots; separate live stacks also need distinct runtime/display
allocations. Admission preserves a floor of `min(20 GiB, MemTotal / 4)` plus
`512 MiB` per incumbent capsule [TARGET; CITED: `INSTALL.md#concurrent-identities-and-ram-admission`].
Unknown memory state refuses admission. A failed new capsule never evicts siblings.
Crash reservations remain counted until the operator proves cleanup:

```sh
python3 tools/mv_ram_admission.py reclaim --dry-run
python3 tools/mv_ram_admission.py reclaim --apply
```

Inspect the dry run before applying. Reclaim requires a dead owner and a local
Docker inventory proving native containers absent; unknown inventories keep records.
Use the same `MV_RAM_ADMISSION_DIR` as the daemons if overriding the runtime default.

The default `memoryweb/` home beneath the checkout is private and gitignored.
`MV_MW_HOME` may select an absolute admitted home. Store sites and workflows there,
never browser profiles, cookies or credential databases. The native identity store
must stay outside both this home and the repository. Home admission refuses unsafe
permissions, symlinks and profile content; it does not repair them silently.
Use `python3 tools/mw_home_check.py --repo .` to check admission before authoring or running.
[CITED: `../tools/mv_ram_admission.py`, `../tools/mw_home_check.py`,
`../agents/metaviewer_agents/mw_home.py`, `INSTALL.md`]

## Further reading

- [Project overview](../README.md)
- [Install and offline packaging](INSTALL.md)
- [How MetaViewer is tested](TESTING.md)
- [Architecture](ARCHITECTURE.md)
- [UI architecture](UI_ARCHITECTURE.md)
- [Roadmap](ROADMAP.md)
- [Pre-existing work declaration](PREEXISTING.md)
- [Contracts v0.2](../contracts/v0.2/README.md)
- [Electron shell notes](../ui/README.md)
- [Python adapters](../agents/README.md)
- [License](../LICENSE)

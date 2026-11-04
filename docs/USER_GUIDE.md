# MetaViewer User Guide

MetaViewer is a Linux desktop wall of application capsules; Host program and Desktop window are not isolated. The Rust core
admits and journals actions; the Electron wall paints frames and sends typed intents.
`wender-agent`, `vision-engine` and `OpenSuperficies` are fully private.
Multiple capsules share host RAM admission; current live performance is not measured
by this documentation update. Historical results are scoped in the [README](../README.md#historical-live-evidence).

This guide covers the current checkout and changes intended for `0.2.6` [TARGET], while VERSION remains the release authority
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

1. **Start `metaviewer-core`:** requires `MV_CORE_CONFIG` pointing at a JSON configuration file (`session_id`, one `core` registration, and `peers` containing one `agent` and one `daemon` registration, each carrying a `hello/v0.2` with its declared component version [CITED: `../core/src/serve/mod.rs`]) and `XDG_RUNTIME_DIR` for `$XDG_RUNTIME_DIR/metaviewer/core.sock`:

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

The shell has three columns [CITED: `ui/src/App.vue`]: the left working tree, the center capsule wall, and the paired terminal dock. A top bar, activity strip and status bar provide controls and feedback:

- **Navigation:** the left working tree groups Humans and Agents, then desktops and their capsules. Desktop cards show real capsule counts; selecting a capsule switches to its desktop and restores its tile. The collapsed rail retains view counts and a pending-handoff indicator. The center row offers Find a capsule, compact grid presets and Add capsule. Preset tooltips give full names; Custom grid (⋯) sets Rows and Columns for Control-drag snapping. New floating tiles take the next free cell where possible.
- **Left tree:** expand or collapse navigation to select Humans, Agents, desktops and capsules.
- **Wall:** a dockview tile workspace with one panel per capsule (`240x200` `[TARGET]` minimum tile size in `ui/src/wall/WallWorkspace.vue`), supporting tabs, splits, and floating panels.
- **Paired terminal dock and drawer:** open Terminal on the right or the capsule terminal control. A paired terminal can appear in the capsule drawer. A package built without native terminal support (no `node-pty` in the package) cannot open a session: the terminal and the launch controls report `TERMINAL_UNAVAILABLE: terminal support is not bundled in this package` (`ui/electron/terminalHost.js`, `ui/src/terminal/BrokerLaunchControls.vue`) instead of a blank terminal.
- **Activity strip:** in the left navigation above the status bar, lists up to `8` `[MEASURED: grep -c 'ACTIVITY_LIMIT = 8' ui/src/App.vue]` recent outcome entries (`ACTIVITY_LIMIT = 8` in `ui/src/App.vue` and `MV_ACTIVITY_LIMIT = 8` in `ui/src/activity/activityModel.js`) alongside the total live event count (`showing 8 of N`) in closed human sentences; raw reason codes never appear as visible text.
- **Status bar:** shows the current view crumb (`Main wall`), `Core connected` / `Core not connected`, and the active capsule count.
- **Settings:** switches the window between `Dark` (`mv-dark`, default) and `Light` themes live. An existing saved theme remains selected.

---

## 3. Opening a capsule surface and nested depth (`AC-17`)

I launch a capsule from the `Add capsule` button in the top bar or left tree, which opens `CatalogLauncher.vue` with the catalog kinds (`identity-browser`, `program`, `host-program`, `desktop-window` in `ui/src/catalog/catalogModel.js`), or through a `surface_request/v0.2` (`action: "create"`) request. Host program and Desktop window run on the computer and are not isolated.

The compact capsule header displays the capsule's human label alongside its lifecycle state and control badge (`SurfacePanel.vue`).

The catalog lists installed host apps and recent apps as well as capsule kinds. These app entries launch Host program and are not isolated.
[CITED: `../ui/src/catalog/CatalogLauncher.vue`]

ARM64 VM, MicroVM and rewind require [developer setup](ARM64_CAPSULE_SETUP.md) and local verified assets; this is not a judge install. VM and MicroVM are arm64 only; x64 VM and MicroVM are not in this release. Windows 10 WSL has no nested KVM. Availability is checked by the host; a missing capability hides the catalog entry.

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

- **Take control (`take_control`):** clicking **Take control (emergency)** sends `ui_intent/v0.2` `take_control` (or `control_request/v0.1` `takeover`) to the core, which immediately closes agent admission for that surface, drains or cancels any in-flight agent proposal (`SURFACE_NOT_AGENT_CONTROLLED` / `human_active`), and switches the tile to `human-control`.
- **Release control (`release_control`):** **Release** in the input strip hands ownership back so agent observation and proposals can resume on a fresh frame generation.
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

`MvRecordingPanel.vue` queries `captureState.refresh(capsuleId)` (`ui/src/capture/capturePort.js` and `ui/src/recording/recordingModel.js`, backed by `window.metaviewer.capture.list()`) on initial mount, whenever the selected `capsuleId` or `captureState` store changes, after a screenshot, after a stop, and when a `sealed` capture event arrives. The capture facade has exactly six members: `screenshot`, `recordStart`, `recordStop`, `export`, `list` and `subscribe` (`ui/electron/preload.js`); there is no `status` member, so calling `window.metaviewer.capture.status(...)` in the developer tools throws a `TypeError`.

Settings has a **Recording** card for frame rate, recording and screenshot folders, and **Keep in RAM** or **Save to disk when recording stops**. Recording folder changes apply at the next app start; host environment settings take priority. Screenshot folder changes apply immediately. Automatic saving waits for an active recording folder; if export fails the RAM capture remains available.
[CITED: `../ui/src/settings/MvSettingsPanel.vue`]

#### Frame rate and what a recording holds

The panel has a **Frame rate (fps)** field next to **Record for AI**. Leave it empty to use the host default (the `recordingFps` setting, `3` `[CITED: core/src/record/capture.rs DEFAULT_FPS]` by default) or enter a whole number from `1` to `60` `[CITED: core/src/record/capture.rs MAX_FPS]`. Anything else disables **Record for AI** with the reason `Frame rate must be a whole number from 1 to 60`; a running recording is never blocked from stopping, and the field is locked while it records.

The rate is an upper bound, not a promise: frames are recorded up to the source rate. The live source stream delivered about `2.7` fps `[MEASURED: operator sweep, W1 judge brief]`, so a choice above that does not add frames; a lower choice keeps fewer. When you stop, the panel shows `Sealed N frames, M dropped.` where `M` is the count the core sealed with the recording (`dropped_frames`).

Frames reach the recording only while a live frame is arriving: **Record for AI** and **Take screenshot** are refused until the first frame lands. **Automate from a demo** records through its own command (`tools/mv_demo.py record`, see below), not through this panel; its sampling rate is `ABSENT — do not invent`.

#### When a capture is refused

A refused **Record for AI**, stop or **Take screenshot** now shows one line under the controls (role `status`, the typed code on its `data-error-code` attribute) instead of doing nothing, and the host connection stays up:

| Code | Line shown | What to do |
| :--- | :--- | :--- |
| `CAPTURE_UNAVAILABLE` | `Capture is unavailable: no frame has arrived yet, or the host did not answer. Try again in a moment.` | Wait for the first frame of the capsule, then retry. |
| `ALREADY_RECORDING` / `NOT_RECORDING` | A recording is already running / no recording is running for this capsule. | Stop the running recording, or start one. |
| `SURFACE_UNKNOWN` | `The recorder does not know this capsule.` | Reopen the capsule. |
| `LIMIT` | `Capture limit reached. Stop a recording or free memory, then try again.` | The core keeps at most `64` `[CITED: core/src/record/capture.rs]` captures and `8` `[CITED: core/src/record/capture.rs]` active recordings. |
| `BUDGET_EXCEEDED` | `The host refused: the memory or frame-rate budget is exceeded. Lower the frame rate or stop another recording.` | Choose a lower rate or stop another recording. |
| `POLICY` | `The host refused this capture by policy.` | None from the panel. |
| `NESTED_DISPLAY_ONLY` | `Capture is not available in a nested display.` | Use the outer wall. |

The tile buttons on the wall do not show this line yet `[TARGET, owned by the wall unit]`; the panel does.

Storyboard is not available in release 0.2.6 because its creative service is unavailable. Its implementation and diagnostic fixtures remain in the repository; the live sidebar and rail do not expose an entry.

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
| **Record for AI** does nothing visible, or a red line appears under the controls | The line carries the typed refusal; see [When a capture is refused](#when-a-capture-is-refused). |
| `Creative service unavailable.` | Storyboard wire schemas are not available yet (see [ROADMAP.md](ROADMAP.md)). |
| `npm run smoke` fails early | Set `ELECTRON_OVERRIDE_DIST_PATH` to a local Electron `44.9.2` distribution, run `npm run build` in `ui/` first, and run under `xvfb-run`. |
| `mv-replay` exits `2`, `3`, or `4` | Invalid/corrupt journal (`2`), duplicate record (`3`), or witness mismatch (`4`). |

---

## Accounts and automation

### Identities and login

Open **Identities** in the left navigation to list accounts, create an identity with an id,
account label and comma-separated domains, or delete an identity after confirmation.
For an identity held by a previous session, **Release** requests verified stale-session cleanup. A live session is not stopped and saved browser data is retained; missing ownership evidence refuses release.
Several accounts may share a site's domains; choose a distinct id and label for each.
**Log in** opens the operator's loopback login view. Type credentials only there,
complete login yourself and close the view before automation. Native reservation
refuses agent input while login is open. The menu reports authentication as unknown;
login history is not proof that the session is currently authenticated.
[CITED: `../ui/src/identities/IdentitiesDialog.vue`, `../tools/mv_identity.py`]

### Stored-data slots

Select **Stored data** for an identity. Stop its capsule and close its login view first; protected or foreign profiles cannot manage slots. **Save** creates a named slot, **Overwrite** replaces it, **Load** replaces that identity's stored data, **Copy to a new capsule** copies into a new identity, and **Delete slot** removes only the saved slot. Load preserves identity metadata and allowed sites. Slots store data, not open tabs; signed-in sessions travel with the copy, as the confirmation warns. Review that warning before continuing.

Keep MetaViewer open while an operation finishes. If verification fails, saved data is retained for recovery; if recovery is required, close and reopen MetaViewer before retrying. **Refresh slots** reloads the list.
[CITED: `../ui/src/identities/StoredDataSlots.vue`]

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

### Prepare a task for your agent CLI

Use **Create automation** to teach by demonstrating steps, **Run automation** to use a saved workflow, or **Direct task** to work without a saved workflow. Each prepares a prompt whose final line is `Task: `; type your task there.

The prompt is copied to the clipboard. When a terminal is paired with a capsule, its actual identity is filled in. Paste the text into your agent CLI, never at a shell prompt; add your task and submit it when ready. Pairing does not identify the foreground process, so these buttons do not insert text or send Enter into the terminal. Automatic insertion remains unavailable until the host can attest an agent input target.

Open **＋ New terminal** to choose an installed CLI profile or **Custom CLI**, then **Launch**. The paired session starts as a host shell; pairing alone does not launch an agent. Review terminal errors rather than treating a copied prompt as proof of launch.
[CITED: `../ui/src/terminal/TerminalDeckView.vue`, `../ui/src/terminal/pairedTerminals.js`]

### Automate from a demo

The live navigation exposes no **Automate from a demo** menu action. The retained
developer dialog and CLI are documented in [AUTOMATE_FROM_DEMO.md](AUTOMATE_FROM_DEMO.md).
The dialog uses an existing running identity, a **Demo id** and **Site name**. Log in yourself before recording and use dummy data:
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

### More than one capsule

### Multiple capsules, RAM admission, and private site data

Use **Add capsule** for additional configured profiles (up to `16` [CITED: `../ui/electron/profilePicker.js`, `../daemon-adapter/internal/daemon/environment.go`] live capsules, with `MV_SRF_LIVE_PROFILE=mv-live-1`). Create one identity per extra profile in **Identities** (`mv-live-2`..`mv-live-4`), and configure `MV_SRF_PROFILES`. The following example uses four browser profiles sharing the canonical `/dev/shm/vqa-ramws/opensuperficies/os-cu-0` `RAMRoot` and distinct displays (`:100` to `:103`):

```json
{
  "mv-live-1": {
    "Kind": "browser", "NativeKind": "browser",
    "RAMRoot": "/dev/shm/vqa-ramws/opensuperficies/os-cu-0",
    "Display": ":100", "Width": 1280, "Height": 900, "text_input": "paste"
  },
  "mv-live-2": {
    "Kind": "browser", "NativeKind": "browser",
    "RAMRoot": "/dev/shm/vqa-ramws/opensuperficies/os-cu-0",
    "Display": ":101", "Width": 1280, "Height": 900, "text_input": "paste"
  },
  "mv-live-3": {
    "Kind": "browser", "NativeKind": "browser",
    "RAMRoot": "/dev/shm/vqa-ramws/opensuperficies/os-cu-0",
    "Display": ":102", "Width": 1280, "Height": 900, "text_input": "paste"
  },
  "mv-live-4": {
    "Kind": "browser", "NativeKind": "browser",
    "RAMRoot": "/dev/shm/vqa-ramws/opensuperficies/os-cu-0",
    "Display": ":103", "Width": 1280, "Height": 900, "text_input": "paste"
  }
}
```

Separate live stacks also need distinct runtime/display
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

## Known limits

The pinned Wender perceives only chassis roles. On real sites, plain paragraphs,
table cells and unnamed status text are absent from the Wender state. Agents must
read this content through AX (srf) or vision. Adding StaticText/cell support is a
v0.3 request to the wender-agent owner. The web fixtures explicitly name chassis
roles from the same source as their visible text.

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

Wide capsule headers keep Record, Screenshot and Copy ID available as icon buttons. Narrow tiles reveal them on header hover or focus. Recording state stays in the header; hover does not resize the capsule view.

Add capsule lists capsule kinds first, followed by Recent and locally installed desktop applications. Each app section shows its Host program isolation warning once. Search matches app names and binaries. Recent contains only successful Host program launches made by MetaViewer. Applications run as Host programs, not isolated; choose Human or Agent before starting. Desktop launch arguments and field codes are not forwarded. Hidden, unavailable and terminal-only entries are omitted. The Host program binary field remains available as a fallback; isolated Program requires the executable in its own image.

Settings → Recording chooses the recordings and screenshot export folders through native folder dialogs. The recordings folder is applied on the next application start; an explicit `MV_RECORDING_DESTINATION` remains authoritative. The default is Keep in RAM until I export. Save to disk when recording stops exports the sealed recording through the existing host grant; a failed export leaves the RAM capture available. Folder free space and available RAM are shown only when the host can read them. In disk mode, screenshots export when captured. Screenshot exports remain PNG-frame `.tar` archives; when a separate screenshot folder is selected, main copies the verified archive there, preserving the original journaled export in the recording grant.

### Working tree names

Double-click a desktop or capsule name, or focus it and press F2, to edit its display name. Enter saves and Escape cancels. Names are stored with the host layout; capsule identity and Copy ID do not change. Program icons come from the installed-app inventory when known, browser identities use a browser symbol, and unknown programs keep a generic mark. Live Host program and Desktop window isolation warnings remain visible while editing.

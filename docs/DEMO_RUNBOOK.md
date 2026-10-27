# MetaViewer Live Demo Runbook

I use `tests/e2e/e2e1_slice/stack.py` as the single launcher to boot the real MetaViewer stack (`metaviewer-core`, `mv-daemon-adapter`, a live `mv-live-1` browser capsule, and the shipped Electron wall) for interactive operator demonstrations and optional whole-screen MP4 recording [CITED: tests/e2e/e2e1_slice/stack.py]. I never start Electron, the authority core, or the capsule container by hand.

## 1. Prerequisites

Before I run `stack.py start`, preflight verifies every prerequisite and fails closed if any check is unsatisfied:

- **Tools on `PATH`**:
  - `--display private` (default): `docker`, `Xvfb`, `xauth`, `xdpyinfo`, `xwininfo`.
  - `--display visible`: `docker`, `xdpyinfo`, `xwininfo` (uses my existing desktop `$DISPLAY` and `$XAUTHORITY`).
  - `--record <path.mp4>`: `ffmpeg` on `PATH` (checked before any process or container starts).
  - Optional automation/probe helpers: `xdotool`, `python3` (`>=3.11` [CITED: agents/pyproject.toml]) with Pillow.
- **Staged `capsule-ui-kit` and prebuilt shipped UI in `<clone>`**:
  - `<clone>/ui/.kit/capsule-ui-kit` is git-ignored (`ui/.kit/` in `.gitignore`) and absent on a fresh clone. Before running `npm ci --offline` or `npm run build` in `<clone>/ui`, I stage the pinned `capsule-ui-kit` package with `node tools/sync_kit.mjs <capsule-ui-kit-checkout>` (or by setting `MV_KIT_CHECKOUT` / `CAPSULE_UI_KIT_REPO`) and verify the materialized tree with `node tools/sync_kit.mjs --check` [CITED: tools/sync_kit.mjs].
  - `tools/sync_kit.mjs` requires the local `capsule-ui-kit` git checkout (either the repository root or `<checkout>/packages/capsule-ui-kit`) to match every pin in `ui/kit.lock.json`: `git remote get-url origin` must equal `https://github.com/oguirado/capsule-ui-kit.git` [CITED: ui/kit.lock.json], `git rev-parse HEAD` must equal `bf31bc201987206d16dbd88d93102f9d5ce026f9` [CITED: ui/kit.lock.json], `version` must equal `0.2.1` [CITED: ui/kit.lock.json], and the length-framed SHA-256 tree digest (`contentHash`) must equal `1bee78c76a0a2a41d085beed918ca6ca791beaf53b952d4a9367dad660fd6dc2` [CITED: ui/kit.lock.json].
  - `<clone>/ui/dist/renderer/index.html` and `<clone>/ui/dist/preload/preload.cjs` must exist on disk (produced by `npm ci --offline` followed by `npm run build` inside `<clone>/ui`).
- **Authority core and adapter binaries**:
  - Rust toolchain (`1.97` [CITED: Cargo.toml]) for `metaviewer-core` unless `MV_E2E_CORE_BIN` points to an existing executable. When building, `stack.py` runs `cargo build --offline --manifest-path core/Cargo.toml --bin metaviewer-core` using an absolute per-worktree `CARGO_TARGET_DIR`.
  - Go toolchain (`1.26.0` [CITED: daemon-adapter/go.mod]) for `mv-daemon-adapter` unless `MV_E2E_ADAPTER_BIN` points to an existing executable. When building, `stack.py` runs `go build -o <work>/mv-daemon-adapter ./cmd/mv-daemon-adapter` with `GOPROXY=off` and `GOSUMDB=off`.
- **OpenSuperficies runtime and `mv-live-1` identity**:
  - `MV_SRF_BIN_DIR` contains executable `srf-identity-surface`.
  - `SRF_IDENTITY_STORE_ROOT` and `SRF_PROXY_REGISTRY` point to the provisioned identity store and registry for `mv-live-1`. I never read `identity.env`, tokens, cookies, or private keys.
- **Clean session state**:
  - `MV_CORE_BOOTSTRAP` must be unset so the shipped `ui/electron/hostBindings.js` runs unmodified.
  - Profile `mv-live-1` must be free: no running or stopped Docker container allocated to `mv-live-1`, and no active `state.json` under `$XDG_RUNTIME_DIR/metaviewer-live-stack`.

## 2. Environment Variables

I export absolute paths using `$HOME`-relative, `<clone>`, or `/dev/shm` locations (never hard-coding personal host paths in tracked files):

```bash
export MV_E2E_LIVE=1
export MV_E2E_ELECTRON_BIN="$ELECTRON_OVERRIDE_DIST_PATH/electron"
export CARGO_TARGET_DIR="$HOME/.cache/cargo-target/metaviewer-demo"
export MV_SRF_BIN_DIR="<opensuperficies-clone>/build/bin"
export MV_SRF_LIVE_PROFILE="mv-live-1"
export MV_SRF_LIVE_RAM_ROOT="/dev/shm/metaviewer-ramws/opensuperficies"
export MV_SRF_STATE_DIR="/dev/shm/metaviewer-ramws/identity-state"
export SRF_IDENTITY_STORE_ROOT="$HOME/.local/share/opensuperficies/identities"
export SRF_PROXY_REGISTRY="$HOME/.local/state/opensuperficies/identity/registry/registry.json"
export MV_RECORDING_DESTINATION="/tmp/metaviewer-recordings"
# XDG_RUNTIME_DIR is inherited from the login session (mode 0700);
# stack state is stored at $XDG_RUNTIME_DIR/metaviewer-live-stack/state.json
```

| Variable | Role |
| --- | --- |
| `MV_E2E_LIVE` | Must be `1`; enables live stack admission and writes `qa-anchors.json` into the run directory |
| `MV_E2E_ELECTRON_BIN` | Absolute path to the local Electron `44.9.2` binary [CITED: ui/package.json] |
| `CARGO_TARGET_DIR` | Absolute per-worktree Cargo build directory (required when `MV_E2E_CORE_BIN` is unset) |
| `MV_E2E_CORE_BIN` | Optional prebuilt `metaviewer-core` binary path |
| `MV_E2E_ADAPTER_BIN` | Optional prebuilt `mv-daemon-adapter` binary path |
| `MV_SRF_BIN_DIR` | Directory containing `srf-identity-surface` |
| `MV_SRF_LIVE_PROFILE` | Must be `mv-live-1` |
| `MV_SRF_LIVE_RAM_ROOT` | `/dev/shm` root where live capsule RGB frames are published in RAM |
| `MV_SRF_STATE_DIR` | Dedicated per-lane OpenSuperficies identity state directory in `/dev/shm` |
| `SRF_IDENTITY_STORE_ROOT` | Provisioned OpenSuperficies identity store root (`$HOME/.local/share/opensuperficies/identities`) |
| `SRF_PROXY_REGISTRY` | Provisioned OpenSuperficies proxy registry JSON (`$HOME/.local/state/opensuperficies/identity/registry/registry.json`) |
| `MV_RECORDING_DESTINATION` | Destination directory outside `<clone>` for exported per-tile capture `.tar` archives |
| `MV_KIT_CHECKOUT` / `CAPSULE_UI_KIT_REPO` | Optional local `capsule-ui-kit` git checkout path read by `tools/sync_kit.mjs` when no positional `[kit-repo]` argument is passed [CITED: tools/sync_kit.mjs] |

## 3. Capped Start (`systemd-run --user --scope`)

### Stage `capsule-ui-kit` and build `ui/` on a fresh clone

On a fresh clone, `<clone>/ui/.kit/capsule-ui-kit` is git-ignored and absent. Before running `npm ci --offline` and `npm run build` in `<clone>/ui`, I stage the pinned `capsule-ui-kit` tree from a local checkout at commit `bf31bc201987206d16dbd88d93102f9d5ce026f9` [CITED: ui/kit.lock.json] whose `origin` remote URL (`git remote get-url origin`) equals `https://github.com/oguirado/capsule-ui-kit.git` [CITED: ui/kit.lock.json]:

```bash
cd /path/to/metaviewer
node tools/sync_kit.mjs <capsule-ui-kit-checkout>
node tools/sync_kit.mjs --check
cd ui
npm ci --offline
npm run build
cd ..
```

`tools/sync_kit.mjs` resolves the checkout path from its positional `[kit-repo]` argument, or from `MV_KIT_CHECKOUT`, or from `CAPSULE_UI_KIT_REPO` (`node tools/sync_kit.mjs [kit-repo] [--check]` [CITED: tools/sync_kit.mjs]). Running `node tools/sync_kit.mjs --check` verifies the materialized `ui/.kit/capsule-ui-kit` directory (`version: "0.2.1"`, `contentHash: "1bee78c76a0a2a41d085beed918ca6ca791beaf53b952d4a9367dad660fd6dc2"` [CITED: ui/kit.lock.json]) against `ui/kit.lock.json`.

I always launch the stack inside a memory-capped `systemd-run --user --scope` unit (`MemoryMax=8G`, `MemoryHigh=6G`, `MemorySwapMax=0`, `RuntimeMaxSec=2700` [TARGET]) rather than bare in the desktop scope.

### Interactive desktop window (`--display visible`)

When I drive the demo live on my desktop display, I pass `--display visible` so `stack.py` uses my existing `$DISPLAY` and `$XAUTHORITY` instead of starting `Xvfb`:

```bash
cd /path/to/metaviewer
systemd-run --user --scope --unit mv-demo -p MemoryMax=8G -p MemoryHigh=6G -p MemorySwapMax=0 \
  -p AllowedCPUs=0-9,15-19 -p RuntimeMaxSec=2700 -- \
  python3 tests/e2e/e2e1_slice/stack.py start --ttl 45m --display visible
```

### Dedicated headless Xvfb display (`--display private`, default)

When I run an isolated display (`1600x1000x24` [TARGET] on a free high display `:91`..`:65535` [TARGET]), I omit `--display` or pass `--display private`:

```bash
cd /path/to/metaviewer
systemd-run --user --scope --unit mv-demo -p MemoryMax=8G -p MemoryHigh=6G -p MemorySwapMax=0 \
  -p AllowedCPUs=0-9,15-19 -p RuntimeMaxSec=2700 -- \
  python3 tests/e2e/e2e1_slice/stack.py start --ttl 45m
```

### Startup sequence and readiness receipt

`stack.py start` spawns a detached supervisor holding an exclusive flock on `$XDG_RUNTIME_DIR/metaviewer-live-stack/lock` and executes:

1. Validates preflight, display reachability (`xdpyinfo`), and any `--record` path/tool constraints before starting processes.
2. Builds or resolves `metaviewer-core` and `mv-daemon-adapter`, then writes `core-config.json` in `$XDG_RUNTIME_DIR/metaviewer-live-stack/run-<id>/`.
3. Starts `metaviewer-core` and waits for `core.sock`; starts `mv-daemon-adapter` and waits for the initial handshake event (`events/1.json`).
4. In `private` mode, allocates a free high display (`:91+` [TARGET]), writes an owner-only `0600` [TARGET] `Xauthority` cookie, and boots `Xvfb :NN -screen 0 1600x1000x24 -auth <run>/Xauthority -nolisten tcp`. In `visible` mode, binds the caller's `$DISPLAY` and `$XAUTHORITY` and verifies reachability with `xdpyinfo`.
5. Launches the shipped Electron entry (`$MV_E2E_ELECTRON_BIN <clone>/ui --user-data-dir=<run>/electron-profile --ozone-platform=x11`) with loader injection variables (`LD_*`, `NODE_*`, `ELECTRON_*`, `PYTHON*`) stripped, and waits until `"MetaViewer"` appears in `xwininfo -root -tree`.
6. Connects as the agent peer, completes `hello/v0.2`, and sends `surface_request/v0.2` `create` (`{kind: "browser", geometry: {w: 1280, h: 900}, profile_id: "mv-live-1"}` [TARGET]), verifying ownership of the single `srf-id-<hash>` capsule container.
7. Waits for the first `frame_ready` event (frames published under `$MV_SRF_LIVE_RAM_ROOT/srf-id-<hash>/frames/w1/`).
8. If `--record <path.mp4>` was passed, starts `ffmpeg -f x11grab` against the stack display and records its birth-verified PID in `state.json`.
9. Prints the readiness line and continues draining agent fan-out with a `10` s [TARGET] `list` heartbeat until `--ttl` expires or `stack.py stop` is invoked:

```text
LIVE_STACK_READY display=:91 xauthority=/run/user/1000/metaviewer-live-stack/run-xxxx/Xauthority capsule=srf-id-xxxxxxxx
```

## 4. Demo Story Steps in the App

Once `LIVE_STACK_READY` is printed, I drive the following walkthrough in the MetaViewer window (`1280x720` window [TARGET]):

1. **Wall with live browser capsule tile**:
   - I observe the `mv-live-1` browser capsule tile rendering live `rgb24` frames on the wall (first paint `0.7` s after `LIVE_STACK_READY` [MEASURED], with `0` scale jitter over `30` s [MEASURED]).
2. **Per-tile record (`Record for AI`)**:
   - I click the **Record** control in the browser tile header chrome to start a bounded in-RAM capture segment (`metaviewer.capture`), let several frame generations accumulate, and click **Stop** to seal the capture in RAM and the session journal.
3. **Per-tile screenshot**:
   - I click the **Screenshot** control in the tile chrome to capture an immediate frame witness into the capture store and verify the updated capture badge.
4. **Human ↔ agent control handoff**:
   - I click **Take control** on the browser tile (`ui_intent/v0.2` takeover). The Rust core immediately cancels any pending agent proposal with `SURFACE_NOT_AGENT_CONTROLLED` and transfers input authority to me [CITED: docs/ARCHITECTURE.md].
   - I interact with the live browser surface directly, then click **Release control**. The core holds agent admission closed until a fresh post-release frame generation arrives.
5. **Fold and unfold**:
   - I click **Fold** on the tile header to collapse the tile to compact status chrome while the capsule continues running and publishing frames in the background, then click **Unfold** to restore the live canvas [MEASURED].
6. **Multislot layout**:
   - I switch from the wall to the **Multislot** view and back (`wall -> multislot -> wall`) to show multi-surface workspace slots alongside the wall; on the real app, the multislot round trip (`wall -> multislot -> wall`) painted correctly `3` times, with first paint `0.7` s after `LIVE_STACK_READY` [MEASURED].
7. **Recordings list and disk export**:
   - I open the **Recordings** panel to review the sealed per-tile recordings and screenshots, inspect their frame counts and RAM footprint, and trigger write-ahead journaled export (`capture_request/v1`) as a deterministic PNG `.tar` under `MV_RECORDING_DESTINATION`.

## 5. Whole-Screen Demo Recording (`--record <path.mp4>`)

To record the entire stack display automatically into an H.264 `.mp4` video starting right after the first `frame_ready`, I pass `--record <path.mp4>` with a destination path **outside** `<clone>` that does not yet exist:

```bash
cd /path/to/metaviewer
systemd-run --user --scope --unit mv-demo -p MemoryMax=8G -p MemoryHigh=6G -p MemorySwapMax=0 \
  -p AllowedCPUs=0-9,15-19 -p RuntimeMaxSec=2700 -- \
  python3 tests/e2e/e2e1_slice/stack.py start --ttl 45m --display visible --record /tmp/metaviewer-demo.mp4
```

- **Recorder invocation**: After the first `frame_ready`, `stack.py` queries `xdpyinfo` on the active stack display for `dimensions: <W>x<H> pixels` and spawns:
  `ffmpeg -f x11grab -video_size <W>x<H> -framerate 30 -i <display> -c:v libx264 -preset veryfast -pix_fmt yuv420p <path.mp4>` (`30` fps [TARGET]).
- **PID tracking**: `stack.py` stores `{"pid": <int>, "identity": "<proc_stat_starttime>"}` in `$XDG_RUNTIME_DIR/metaviewer-live-stack/state.json` under `recorder` (and in `pids`).
- **Pre-launch refusals**: `stack.py` refuses `--record` before starting any process if the path resolves inside `<clone>`, if the target file or symlink already exists, if the filename does not end with `.mp4` or its parent directory is absent, or if `ffmpeg` is missing from `PATH`.

## 6. Stop and Post-Checks

When I finish the demo, I stop the stack from `<clone>` with the same environment variables set:

```bash
cd /path/to/metaviewer
python3 tests/e2e/e2e1_slice/stack.py stop
```

Expected output:

```text
LIVE_STACK_STOPPED processes=absent capsule=absent sockets=absent ram=absent state=absent
```

### Ordered cleanup inside `stop`

`stack.py` never uses process-name killers; `state.json` is the single source of truth and every signal verifies birth identity in `/proc/<pid>/stat`:

1. **Finalize recording first**: If `state.json` records a live `recorder` PID, `stop` sends `SIGINT` to that recorded PID first and waits up to `10` s [TARGET] for `ffmpeg` to flush and finalize the MP4 container while the display and window are still intact.
2. **Destroy capsule**: Sends `surface_request/v0.2` `destroy` to the core and runs `srf-identity-surface stop --container srf-id-<hash> --state-dir "$MV_SRF_STATE_DIR"`.
3. **Terminate stack processes**: Sends `SIGTERM` and then `SIGKILL` (with a `5` s poll window [TARGET]) in reverse spawn order to the remaining birth-verified PIDs in `state.json`.
4. **Verify RAM, sockets, and state removal**: Removes owned capsule directories under `$MV_SRF_LIVE_RAM_ROOT`, deletes the private `run-<id>` directory, verifies `/tmp/.X11-unix/X<NN>` is absent (when `--display private`), and unlinks `state.json`.

### Post-checks I run after `stop`

- `systemctl --user is-active mv-demo.scope` reports `inactive`.
- For `--display private`, `/tmp/.X11-unix/X<NN>` is absent.
- `docker ps -a --format '{{.Names}}'` and `ls "$MV_SRF_LIVE_RAM_ROOT"` contain no leftover `srf-id-*` entries from the run.
- When `--record /tmp/metaviewer-demo.mp4` was used, `ls -lh /tmp/metaviewer-demo.mp4` shows a non-empty finalized MP4 file.

## 7. Known Issues

- **Chromium `"Restore pages?"` prompt after stop (`L2-9`, capsule owner scope)**:
  - Stopping the capsule container via `srf-identity-surface stop` terminates Chromium inside the container, so the persistent profile records an unclean exit and displays `"Restore pages?"` on subsequent launches (observed across live verification runs through `f256bc40` [MEASURED]).
  - This behavior lives inside the OpenSuperficies capsule runtime (out of scope for `stack.py`) and is tracked for the capsule owner (either closing Chromium gracefully before container stop or passing `--hide-crash-restore-bubble` / `--disable-session-crashed-bubble` in the capsule entrypoint). During a live demo, I dismiss the bubble or click takeover and close it once.

## 8. Troubleshooting (`tools/sync_kit.mjs` and `stack.py` Typed Errors)

### `tools/sync_kit.mjs` typed errors

When staging or verifying `ui/.kit/capsule-ui-kit` fails, `node tools/sync_kit.mjs` exits with return code `1` [CITED: tools/sync_kit.mjs] and prints `ERROR: <message>` to `stderr`:

| Error prefix / message | Cause | Resolution |
| --- | --- | --- |
| `ERROR: Usage: node tools/sync_kit.mjs [kit-repo] [--check] (or MV_KIT_CHECKOUT / CAPSULE_UI_KIT_REPO); --check alone verifies ui/.kit against the lock` | Missing `[kit-repo]` (with `MV_KIT_CHECKOUT` and `CAPSULE_UI_KIT_REPO` unset) when `--check` is not passed, duplicate `--check`, multiple positional arguments, or unknown flags | Run `node tools/sync_kit.mjs <capsule-ui-kit-checkout>` (or set `MV_KIT_CHECKOUT` / `CAPSULE_UI_KIT_REPO`) followed by `node tools/sync_kit.mjs --check` |
| `ERROR: kit absent: <dest> is not materialised; run node tools/sync_kit.mjs from the pinned checkout` | `node tools/sync_kit.mjs --check` ran without a source checkout while `ui/.kit/capsule-ui-kit` is missing | Stage the kit first with `node tools/sync_kit.mjs <capsule-ui-kit-checkout>` |
| `ERROR: Kit repository/commit mismatch` | Source checkout `git rev-parse HEAD` does not equal `bf31bc201987206d16dbd88d93102f9d5ce026f9` or `git remote get-url origin` does not equal `https://github.com/oguirado/capsule-ui-kit.git` [CITED: ui/kit.lock.json] | Check out commit `bf31bc201987206d16dbd88d93102f9d5ce026f9` in the `capsule-ui-kit` clone and ensure its `origin` remote URL is `https://github.com/oguirado/capsule-ui-kit.git` |
| `ERROR: Kit metadata/pin/hash mismatch` | `KIT_SOURCE.json`, `package.json` (`name: "capsule-ui-kit"`, `version: "0.2.1"`), or the length-framed SHA-256 `contentHash` (`1bee78c76a0a2a41d085beed918ca6ca791beaf53b952d4a9367dad660fd6dc2`) does not match `ui/kit.lock.json` | Clean any local modifications in the `capsule-ui-kit` checkout and re-run `node tools/sync_kit.mjs <capsule-ui-kit-checkout>` |
| `ERROR: Invalid kit lock` | `ui/kit.lock.json` is malformed or missing `repo`, `commit` (`40` hex chars [CITED: tools/sync_kit.mjs]), `version`, or `contentHash` (`64` hex chars [CITED: tools/sync_kit.mjs]) | Restore the tracked `ui/kit.lock.json` file |
| `ERROR: Expected kit repo or package` | The supplied `[kit-repo]` path is neither the `capsule-ui-kit` git top-level nor `<repo>/packages/capsule-ui-kit` | Pass the root of the `capsule-ui-kit` checkout or `<checkout>/packages/capsule-ui-kit` |
| `ERROR: Source ancestors must not be symlinks` / `ERROR: Destination ancestors must not be symlinks` / `ERROR: Symlink rejected: <name>` | A symlink exists in the source ancestor path, destination ancestor path, or inside the kit tree | Use a real directory path without symlinks for both the checkout and `<clone>` |
| `ERROR: Source and destination overlap` | Source checkout and `<clone>/ui/.kit/capsule-ui-kit` overlap on disk | Keep the `capsule-ui-kit` checkout outside `<clone>/ui/.kit` |
| `ERROR: Expected kit directory` / `ERROR: Expected regular JSON file` / `ERROR: Expected destination directory` / `ERROR: Unsupported entry: <name>` | Required kit directory or JSON metadata file is not a regular directory/file, or the tree contains special filesystem entries | Restore a clean `capsule-ui-kit` checkout and remove any corrupted `ui/.kit` path |
| `ERROR: Activation and restoration failed; preserved backup: <backup>` | Atomic rename into `ui/.kit/capsule-ui-kit` and rollback both failed | Inspect the preserved `.kit-sync-*.previous` backup under `ui/.kit/` and re-run `node tools/sync_kit.mjs <capsule-ui-kit-checkout>` |

### `stack.py` typed errors

When a preflight, display, recording, or cleanup check fails, `stack.py` exits with return code `1` [MEASURED] and prints `LIVE_STACK_BLOCKED <message>` to `stderr`:

| Error prefix / message | Cause | Resolution |
| --- | --- | --- |
| `DISPLAY_MODE_INVALID: ...` | `--display` received a value other than `private` or `visible` | Pass `--display private` or `--display visible` |
| `DISPLAY_UNSET: DISPLAY AUSENTE for --display visible` | `--display visible` was requested with `$DISPLAY` unset or empty | Export a valid desktop `DISPLAY` (for example `:0`) or use `--display private` |
| `DISPLAY_UNREACHABLE: ...` | `xdpyinfo` is missing or failed to connect to `$DISPLAY` in `--display visible` mode | Verify `DISPLAY` and `XAUTHORITY` with `xdpyinfo` before starting |
| `DISPLAY_SIZE_UNAVAILABLE: ...` | `xdpyinfo` output did not report `dimensions: <W>x<H> pixels` for `--record` | Ensure the target X11 screen reports standard pixel dimensions via `xdpyinfo` |
| `RECORD_PATH_INVALID: ...` | `--record` path does not end with `.mp4` or its parent directory does not exist | Supply a `.mp4` file path inside an existing directory outside `<clone>` |
| `RECORD_PATH_IN_REPO: ...` | `--record` path resolves inside `<clone>` | Write recordings outside the repository tree (for example `/tmp/demo.mp4`) |
| `RECORD_PATH_EXISTS: ...` | `--record` target file, directory, or symlink already exists | Choose a fresh filename or remove the previous recording file before `start` |
| `FFMPEG_MISSING: tool AUSENTE: ffmpeg` | `--record` was requested but `ffmpeg` is not on `PATH` | Install `ffmpeg` or add its directory to `PATH` |
| `another live stack or G-W1 run is active; refusing` | `$XDG_RUNTIME_DIR/metaviewer-live-stack/state.json` exists or `live.py` / `index.js --live` is running | Run `python3 tests/e2e/e2e1_slice/stack.py stop` or inspect retained recovery state |
| `live env AUSENTE: <keys>` | One or more required environment variables in Section 2 are unset | Export all required variables from Section 2 |
| `explicit MV_E2E_LIVE=1 and mv-live-1 required` | `MV_E2E_LIVE` is not `1` or `MV_SRF_LIVE_PROFILE` is not `mv-live-1` | Set `MV_E2E_LIVE=1` and `MV_SRF_LIVE_PROFILE=mv-live-1` |
| `live path AUSENTE: <key>` | A required path variable is relative or does not exist on disk | Create the directory (such as `$MV_SRF_LIVE_RAM_ROOT` and `$MV_SRF_STATE_DIR`) and use absolute paths |
| `tool AUSENTE: <tool>` | Required host tool (`docker`, `Xvfb`, `xauth`, `xdpyinfo`, or `xwininfo`) is missing from `PATH` | Ensure all required X11 and container tools are on `PATH` |
| `shipped host bindings require MV_CORE_BOOTSTRAP unset` | `MV_CORE_BOOTSTRAP` is set in the environment | Run `unset MV_CORE_BOOTSTRAP` |
| `profile already allocated; refusing` | A container or lease for `mv-live-1` already exists | Stop the existing capsule or wait for the active session to release `mv-live-1` |
| `shipped UI build AUSENTE: <path>` | `ui/dist/renderer/index.html` or `ui/dist/preload/preload.cjs` is missing | Stage the kit (`node tools/sync_kit.mjs <capsule-ui-kit-checkout> && node tools/sync_kit.mjs --check`) and build the UI (`cd ui && npm ci --offline && npm run build`) before launching the live stack |
| `supervisor absent; private recovery state retained for review` | `stop` found `state.json` whose supervisor PID is no longer alive | Inspect `$XDG_RUNTIME_DIR/metaviewer-live-stack/supervisor.log` and `state.json`, verify no capsule or RAM allocation remains, then remove stale `state.json` |

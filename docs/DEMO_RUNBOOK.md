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
  - Rust toolchain (`1.97` [CITED: Cargo.toml]) for `metaviewer-core`: `stack.py` runs `cargo build --offline --manifest-path core/Cargo.toml --bin metaviewer-core` using an absolute per-worktree `CARGO_TARGET_DIR`. Do not set `MV_E2E_CORE_BIN` for live or demo runs because prebuilt overrides risk stale binaries.
  - Go toolchain (`1.26.0` [CITED: daemon-adapter/go.mod]) for `mv-daemon-adapter`: `stack.py` runs `go build -o <work>/mv-daemon-adapter ./cmd/mv-daemon-adapter` with `GOPROXY=off` and `GOSUMDB=off`. Do not set `MV_E2E_ADAPTER_BIN` for live or demo runs because prebuilt overrides risk stale binaries.
- **OpenSuperficies runtime and `mv-live-1` identity**:
  - `MV_SRF_BIN_DIR` contains executable `srf-identity-surface`.
  - `SRF_IDENTITY_STORE_ROOT` and `SRF_PROXY_REGISTRY` point to the provisioned identity store and registry for `mv-live-1`. I never read `identity.env`, tokens, cookies, or private keys.
- **Clean session state**:
  - `MV_CORE_BOOTSTRAP` must be unset so the shipped `ui/electron/hostBindings.js` runs unmodified.
  - Profile `mv-live-1` must be free: no running or stopped Docker container allocated to `mv-live-1`, and no active `state.json` under `$XDG_RUNTIME_DIR/metaviewer-live-stack`.

## 2. Environment Variables

I export absolute paths using `$HOME`-relative, `<clone>`, or `/dev/shm` locations (never hard-coding personal host paths in tracked files). Because `stack.py` preflight rejects a missing `MV_SRF_LIVE_RAM_ROOT` or `MV_SRF_STATE_DIR` with `"live path AUSENTE"` [CITED: tests/e2e/e2e1_slice/stack.py], I run `mkdir -p` to create both directories first; both paths are per lane (one RAM root and one state dir per live lane). `MV_RECORDING_DESTINATION` also enables the **Export** control in the UI: without it, the **Export** control is disabled (`"No export destination advertised by the host"` [CITED: ui/src/recording/recordingModel.js]); with it, **Export** writes a `.tar` archive there, and the destination directory must exist (`mkdir -p`):

```bash
export MV_E2E_LIVE=1
export ELECTRON_OVERRIDE_DIST_PATH="<directory holding electron 44.9.2>"
export MV_E2E_ELECTRON_BIN="$ELECTRON_OVERRIDE_DIST_PATH/electron"
export CARGO_TARGET_DIR="$HOME/.cache/cargo-target/metaviewer-demo"
export MV_SRF_BIN_DIR="<opensuperficies-clone>/build/bin"
export MV_SRF_LIVE_PROFILE="mv-live-1"
export MV_SRF_LIVE_RAM_ROOT="/dev/shm/metaviewer-ramws/opensuperficies"
export MV_SRF_STATE_DIR="/dev/shm/metaviewer-ramws/identity-state"
export SRF_IDENTITY_STORE_ROOT="$HOME/.local/share/opensuperficies/identities"
export SRF_PROXY_REGISTRY="$HOME/.local/state/opensuperficies/identity/registry/registry.json"
export MV_RECORDING_DESTINATION="/tmp/metaviewer-recordings"
mkdir -p "$MV_SRF_LIVE_RAM_ROOT" "$MV_SRF_STATE_DIR" "$MV_RECORDING_DESTINATION"
# XDG_RUNTIME_DIR is inherited from the login session (mode 0700);
# stack state is stored at $XDG_RUNTIME_DIR/metaviewer-live-stack/state.json
```

| Variable | Role |
| --- | --- |
| `MV_E2E_LIVE` | Must be `1`; enables live stack admission and writes `qa-anchors.json` into the run directory |
| `ELECTRON_OVERRIDE_DIST_PATH` | `<directory holding electron 44.9.2>` [CITED: ui/package.json], used to derive `MV_E2E_ELECTRON_BIN` (and honored by `tools/gate.sh`) |
| `MV_E2E_ELECTRON_BIN` | Absolute path to the local Electron `44.9.2` binary (`$ELECTRON_OVERRIDE_DIST_PATH/electron`), read directly by `stack.py` [CITED: tests/e2e/e2e1_slice/stack.py, ui/package.json] |
| `CARGO_TARGET_DIR` | Absolute per-worktree Cargo build directory used by `stack.py` to build `metaviewer-core` |
| `MV_E2E_CORE_BIN` | Internal test-only `metaviewer-core` binary override; leave unset for live/demo runs so `stack.py` never uses a stale binary |
| `MV_E2E_ADAPTER_BIN` | Internal test-only `mv-daemon-adapter` binary override; leave unset for live/demo runs so `stack.py` never uses a stale binary |
| `MV_SRF_BIN_DIR` | Directory containing `srf-identity-surface` |
| `MV_SRF_LIVE_PROFILE` | Must be `mv-live-1` |
| `MV_SRF_LIVE_RAM_ROOT` | Per-lane `/dev/shm` root where live capsule RGB frames are published in RAM (one RAM root per live lane; must be created first with `mkdir -p`, or preflight rejects it with `"live path AUSENTE"`) |
| `MV_SRF_STATE_DIR` | Dedicated per-lane OpenSuperficies identity state directory in `/dev/shm` (one state dir per live lane; must be created first with `mkdir -p`, or preflight rejects it with `"live path AUSENTE"`) |
| `SRF_IDENTITY_STORE_ROOT` | Provisioned OpenSuperficies identity store root (`$HOME/.local/share/opensuperficies/identities`) |
| `SRF_PROXY_REGISTRY` | Provisioned OpenSuperficies proxy registry JSON (`$HOME/.local/state/opensuperficies/identity/registry/registry.json`) |
| `MV_RECORDING_DESTINATION` | Existing destination directory outside `<clone>` (`mkdir -p`) for exported per-tile capture `.tar` archives; also enables the **Export** control in the UI (without it, **Export** is disabled with `"No export destination advertised by the host"` [CITED: ui/src/recording/recordingModel.js]) |
| `MV_KIT_CHECKOUT` / `CAPSULE_UI_KIT_REPO` | Optional local `capsule-ui-kit` git checkout path read by `tools/sync_kit.mjs` when no positional `[kit-repo]` argument is passed [CITED: tools/sync_kit.mjs] |

## 3. Capped Start (`systemd-run --user --scope`)

### Stage `capsule-ui-kit` and build `ui/` on a fresh clone

On a fresh clone, `<clone>/ui/.kit/capsule-ui-kit` is git-ignored and absent. Before running `npm ci --offline` and `npm run build` in `<clone>/ui`, I stage the pinned `capsule-ui-kit` tree from a local checkout at commit `bf31bc201987206d16dbd88d93102f9d5ce026f9` [CITED: ui/kit.lock.json] whose `origin` remote URL (`git remote get-url origin`) equals `https://github.com/oguirado/capsule-ui-kit.git` [CITED: ui/kit.lock.json].

To obtain an offline kit checkout `<dir>` from a local `capsule-ui-kit` clone whose `origin` remote URL equals the lock URL in `ui/kit.lock.json`:

```bash
git clone --local --no-checkout <local capsule-ui-kit clone> <dir> && git -C <dir> checkout <commit from ui/kit.lock.json> && git -C <dir> remote set-url origin <url from ui/kit.lock.json>
```

I run `tools/sync_kit.mjs`, `npm ci --offline`, and `npm run build` inside a memory-capped `systemd-run --user --scope` unit (`MemoryMax=8G`, `MemoryHigh=6G`, `MemorySwapMax=0` [TARGET]) too:

```bash
cd /path/to/metaviewer
systemd-run --user --scope -p MemoryMax=8G -p MemoryHigh=6G -p MemorySwapMax=0 -- bash -c '
  node tools/sync_kit.mjs <dir>
  node tools/sync_kit.mjs --check
  cd ui
  npm ci --offline
  npm run build
'
```

`tools/sync_kit.mjs` resolves the checkout path from its positional `[kit-repo]` argument, or from `MV_KIT_CHECKOUT`, or from `CAPSULE_UI_KIT_REPO` (`node tools/sync_kit.mjs [kit-repo] [--check]` [CITED: tools/sync_kit.mjs]). Running `node tools/sync_kit.mjs --check` verifies the materialized `ui/.kit/capsule-ui-kit` directory (`version: "0.2.1"`, `contentHash: "1bee78c76a0a2a41d085beed918ca6ca791beaf53b952d4a9367dad660fd6dc2"` [CITED: ui/kit.lock.json]) against `ui/kit.lock.json`.

I always launch the stack inside a memory-capped `systemd-run --user --scope` unit (`MemoryMax=8G`, `MemoryHigh=6G`, `MemorySwapMax=0`, `RuntimeMaxSec=2700` [TARGET]) rather than bare in the desktop scope. Each `systemd-run --user --scope` command below relies on the Section 2 exports being inherited (a `--scope` unit keeps the caller environment).

### Interactive desktop window (`--display visible`)

When I drive the demo live on my desktop display, I pass `--display visible` so `stack.py` uses my existing `$DISPLAY` and `$XAUTHORITY` instead of starting `Xvfb` (relying on the Section 2 exports being inherited by the `--scope` unit from the caller environment):

```bash
cd /path/to/metaviewer
systemd-run --user --scope --unit mv-demo -p MemoryMax=8G -p MemoryHigh=6G -p MemorySwapMax=0 \
  -p AllowedCPUs=0-9,15-19 -p RuntimeMaxSec=2700 -- \
  python3 tests/e2e/e2e1_slice/stack.py start --ttl 45m --display visible
```

### Dedicated headless Xvfb display (`--display private`, default)

When I run an isolated display (`1600x1000x24` [TARGET] on a free high display `:91`..`:65535` [TARGET]), I omit `--display` or pass `--display private` (relying on the Section 2 exports being inherited by the `--scope` unit from the caller environment):

```bash
cd /path/to/metaviewer
systemd-run --user --scope --unit mv-demo -p MemoryMax=8G -p MemoryHigh=6G -p MemorySwapMax=0 \
  -p AllowedCPUs=0-9,15-19 -p RuntimeMaxSec=2700 -- \
  python3 tests/e2e/e2e1_slice/stack.py start --ttl 45m
```

- `--agent-tick-page` (default off): opt-in agent-driven ticking `data:text/html` page (`TICK_URL`, percent-encoded with `urllib.parse.quote` so `#` color literals are never truncated as URL fragments) after the first `frame_ready` (`LIVE_STACK_TICK step=N outcome=...`, fail-open); for test/QA only, not for the demo recording [CITED: tests/e2e/e2e1_slice/stack.py].

### Startup sequence and readiness receipt

`stack.py start` spawns a detached supervisor holding an exclusive flock on `$XDG_RUNTIME_DIR/metaviewer-live-stack/lock` and executes:

1. Validates preflight, display reachability (`xdpyinfo`), and any `--record` path/tool constraints before starting processes.
2. Builds or resolves `metaviewer-core` and `mv-daemon-adapter`, then writes `core-config.json` in `$XDG_RUNTIME_DIR/metaviewer-live-stack/run-<id>/`.
3. Starts `metaviewer-core` and waits for `core.sock`; starts `mv-daemon-adapter` and waits for the initial handshake event (`events/1.json`).
4. In `private` mode, allocates a free high display (`:91+` [TARGET]), writes an owner-only `0600` [TARGET] `Xauthority` cookie, and boots `Xvfb :NN -screen 0 1600x1000x24 -auth <run>/Xauthority -nolisten tcp`. In `visible` mode, binds the caller's `$DISPLAY` and `$XAUTHORITY` and verifies reachability with `xdpyinfo`.
5. Launches the shipped Electron entry (`$MV_E2E_ELECTRON_BIN <clone>/ui --user-data-dir=<run>/electron-profile --ozone-platform=x11`) with loader injection variables (`LD_*`, `NODE_*`, `ELECTRON_*`, `PYTHON*`) stripped, and waits until `"MetaViewer"` appears in `xwininfo -root -tree`.
6. Connects as the agent peer, opens the owner-only `0600` [CITED: tests/e2e/e2e1_slice/stack.py] control socket at `$XDG_RUNTIME_DIR/metaviewer-live-stack/control.sock`, completes `hello/v0.2`, and sends `surface_request/v0.2` `create` (`{kind: "browser", geometry: {w: 1280, h: 900}, profile_id: "mv-live-1"}` [TARGET]), verifying ownership of the single `srf-id-<hash>` capsule container.
7. Waits for the first `frame_ready` event (frames published under `$MV_SRF_LIVE_RAM_ROOT/srf-id-<hash>/frames/w1/`).
8. If `--record <path.mp4>` was passed, starts `ffmpeg -f x11grab` against the stack display and records its birth-verified PID in `state.json`.
9. Prints the readiness line and continues draining agent fan-out with a `10` s [TARGET] `list` heartbeat (until a same-UID `handoff-agent` request on `control.sock` transfers the agent connection fd via `SCM_RIGHTS` or `--ttl` expires / `stack.py stop` is invoked):

```text
LIVE_STACK_READY display=:91 xauthority=/run/user/1000/metaviewer-live-stack/run-xxxx/Xauthority capsule=srf-id-xxxxxxxx
```

## 4. Demo Story Steps in the App

Once `LIVE_STACK_READY` is printed, I drive the following walkthrough in the MetaViewer window (`1280x720` window [TARGET]):

1. **Wall with live browser capsule tile**:
   - I observe the `mv-live-1` browser capsule tile rendering live `rgb24` frames on the wall.
2. **Per-tile record (`Record` / `Stop`)**:
   - I click the **Record** control in the browser tile header chrome to start a bounded in-RAM capture segment (`metaviewer.capture`), let several frame generations accumulate, and click **Stop** to seal the capture in RAM and the session journal.
3. **Per-tile screenshot**:
   - I click the **Screenshot** control in the tile chrome to capture an immediate frame witness into the capture store and verify the updated capture badge.
4. **Human ↔ agent control handoff**:
   - There is one **Control** button per tile (accessible name `"Take control of <surface>"`); the tile badge flips between `"Agent acting"` and `"Human control"` (there are no separate Take/Release buttons).
   - I click **Control** on the browser tile (`ui_intent/v0.2` takeover): the badge flips from `"Agent acting"` to `"Human control"`, and the Rust core immediately cancels any pending agent proposal with `SURFACE_NOT_AGENT_CONTROLLED` and transfers input authority to me [CITED: docs/ARCHITECTURE.md].
   - I interact with the live browser surface directly, then click **Control** again to return control to the agent: the badge flips back to `"Agent acting"`, and the core holds agent admission closed until a fresh post-release frame generation arrives.
5. **Fold and unfold**:
   - I click **Fold** on the tile header: the tile body blanks and the label becomes **Unfold** while the tile keeps its height and the capsule continues running and publishing frames in the background; I then click **Unfold** to restore the live canvas.
6. **Multislot layout**:
   - I click **Open in multislot** in the top bar to switch from the wall to the multislot view, and click **Back to wall** to return to the wall (`wall -> multislot -> wall`) [CITED: ui/src/App.vue].
7. **Recording and Screenshots tables and disk export**:
   - There is no separate `"Recordings"` panel: the **Recording** and **Screenshots** tables are rendered at the bottom of the multislot view (scroll down), and **Export** is there (`MvRecordingPanel` [CITED: ui/src/App.vue]).
   - I scroll to the bottom of the multislot view to review the sealed per-tile recordings and screenshots (frame counts and RAM footprint) and click **Export** to trigger write-ahead journaled export (`capture_request/v1`) as a deterministic PNG `.tar` under `MV_RECORDING_DESTINATION` (when `MV_RECORDING_DESTINATION` is set; without it, **Export** is disabled with `"No export destination advertised by the host"` [CITED: ui/src/recording/recordingModel.js]).

## 5. Whole-Screen Demo Recording (`--record <path.mp4>`)

To record the entire stack display automatically into an H.264 `.mp4` video starting right after the first `frame_ready`, I pass `--record <path.mp4>` with a destination path **outside** `<clone>` that does not yet exist (this `systemd-run --user --scope` command relies on the Section 2 exports being inherited, as a `--scope` unit keeps the caller environment):

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
- When `--record /tmp/metaviewer-demo.mp4` was used, I run `ffprobe -v error -show_entries format=duration,size:stream=codec_name -of json /tmp/metaviewer-demo.mp4` as the finalization check (the file is `~48` bytes [MEASURED] until the recorder is stopped; after `stop`, `ffprobe` confirms the finalized `h264` stream, duration, and byte size).

## 7. Known Issues

- **Wall tile may stay black until the first multislot round trip (`L8-1`, under investigation)**:
  - On initial startup, the wall tile may stay black until the first multislot round trip (**Open in multislot** followed by **Back to wall**).
- **Tile rescales slightly when an Activity row appears (`L7-1`)**:
  - The wall tile rescales slightly when an Activity row appears in the activity strip.
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
| `live path AUSENTE: <key>` | A required path variable is relative or does not exist on disk | Create the directory (`mkdir -p "$MV_SRF_LIVE_RAM_ROOT" "$MV_SRF_STATE_DIR"`) and use absolute paths |
| `tool AUSENTE: <tool>` | Required host tool (`docker`, `Xvfb`, `xauth`, `xdpyinfo`, or `xwininfo`) is missing from `PATH` | Ensure all required X11 and container tools are on `PATH` |
| `shipped host bindings require MV_CORE_BOOTSTRAP unset` | `MV_CORE_BOOTSTRAP` is set in the environment | Run `unset MV_CORE_BOOTSTRAP` |
| `profile already allocated; refusing` | A container or lease for `mv-live-1` already exists | Stop the existing capsule or wait for the active session to release `mv-live-1` |
| `shipped UI build AUSENTE: <path>` | `ui/dist/renderer/index.html` or `ui/dist/preload/preload.cjs` is missing | Stage the kit and build the UI inside a capped scope (`systemd-run --user --scope -p MemoryMax=8G -p MemoryHigh=6G -p MemorySwapMax=0 -- bash -c 'node tools/sync_kit.mjs <dir> && node tools/sync_kit.mjs --check && cd ui && npm ci --offline && npm run build'`) before launching the live stack |
| `supervisor absent; private recovery state retained for review` | `stop` found `state.json` whose supervisor PID is no longer alive | Inspect `$XDG_RUNTIME_DIR/metaviewer-live-stack/supervisor.log` and `state.json`, verify no capsule or RAM allocation remains, then remove stale `state.json` |

## 9. Agent-Drive Demo Runner (`demo_agent_drive.py`)

`tests/e2e/e2e1_slice/demo_agent_drive.py` drives the narrated `8`-checkpoint [MEASURED] agent loop against an already-running `stack.py` session (`LIVE_STACK_READY` in `$XDG_RUNTIME_DIR/metaviewer-live-stack/state.json`), working alongside `--display private|visible` and `--record <mp4>` without starting or stopping the stack itself unless `--start-stack` is explicitly supplied. On attach, the runner connects to the supervisor's owner-only `0600` [CITED: tests/e2e/e2e1_slice/stack.py] `$XDG_RUNTIME_DIR/metaviewer-live-stack/control.sock`, passes the `SO_PEERCRED` same-UID check, sends `{"op": "handoff-agent"}`, receives the open agent `core.sock` file descriptor via `SCM_RIGHTS` (with `agent_handoff` recorded in `state.json` and any second handoff refused with `ALREADY_HANDED_OFF`), continues the existing agent session with uninterrupted `seq` continuity, and closes the descriptor cleanly on exit. See `docs/DEMO_AGENT_SCRIPT.md` for the full checkpoint transcript schema and narration script.

### Prerequisites for perception and Wender state

In addition to the live stack environment in Section 2, export the locked sibling checkouts required by `resolve_locked_component` (`deps.lock`):

```bash
export VQA_VE_ROOT="<vision-engine-checkout>"
export MV_WENDER_ROOT="<wender-agent-checkout>"
# Optional: override local:custody_click/v1 with an external Wender subprocess planner
# export MV_WENDER_PLANNER_CMD='["python3", "-m", "wender.planner_cli"]'
```

### Running alongside an active `stack.py` session

1. Start the live stack (private or visible display, with optional `.mp4` recording outside `<clone>`):

   ```bash
   rm -f /tmp/metaviewer-agent-demo.mp4 /tmp/metaviewer-agent-receipt.json
   systemd-run --user --scope --unit=mv-demo \
     -p MemoryMax=8G -p MemoryHigh=6G -p MemorySwapMax=0 -- \
     python3 tests/e2e/e2e1_slice/stack.py start --ttl 10m --display private --record /tmp/metaviewer-agent-demo.mp4
   ```

2. Run `demo_agent_drive.py` against the ready stack:

   ```bash
   python3 tests/e2e/e2e1_slice/demo_agent_drive.py --receipt-out /tmp/metaviewer-agent-receipt.json
   ```

   - The runner emits `8` [MEASURED] JSON transcript lines (`schema: "metaviewer.demo-agent-checkpoint/v1"`) to `stdout` in strict order:
     `LIVE_STACK_READY` (`1` [MEASURED]) -> `observe` (`2` [MEASURED]) -> `navigate` (`3` [MEASURED], composed via `3` [MEASURED] actions: `ctrl+l`, `type` local `data:text/html,...`, `Return`; `navigate` wire verb is `ABSENT — do not invent` by decision) -> `read` (`4` [MEASURED], printing `vision_marks` and `vqa.element-table/v1`) -> `stale_negative_control` (`5` [MEASURED], deliberately stale `based_on_frame` refused with `STALE_FRAME`, run continues) -> `custody_click` (`6` [MEASURED], `local:custody_click/v1` default or `configured:MV_WENDER_PLANNER_CMD`) -> `wait_verify` (`7` [MEASURED], `verified: true`, `focus_verified: true`) -> `post_state_change` (`8` [MEASURED], `pre_frame_sha256 != post_frame_sha256` and `pre_state_sha256 != post_state_sha256`).
   - Transient live `STALE_FRAME` refusals during `navigate` and `custody_click` settle the newest `frame_ready` and retry up to `TICK_MAX_ATTEMPTS = 3` [CITED: tests/e2e/e2e1_slice/stack.py] attempts with a fresh `proposal_id` and refreshed frame pin.

3. Stop the stack and finalize the recording:

   ```bash
   python3 tests/e2e/e2e1_slice/stack.py stop
   ```

### Offline self-test (injected peer)

To verify the ordered checkpoints, `STALE_FRAME` negative control, transient retry loop (`3` [MEASURED] max attempts), `MV_WENDER_PLANNER_CMD` subprocess path, transcript schema validator, `SCM_RIGHTS` `control.sock` handoff, and session state guards without live containers (`7` [MEASURED] unit tests in `test_demo_agent_drive.py` and `16` [MEASURED] unit tests in `test_stack_demo.py`):

```bash
python3 tests/e2e/e2e1_slice/demo_agent_drive.py --self-test
```

# Installing and Building MetaViewer on Linux (`arm64` and `x64`)

I build and test MetaViewer on Linux as a desktop shell for isolated application surfaces governed by a Rust admission and journaling core (multi-capsule acceptance remains [TARGET]; current-pin live wall fps and latency are unmeasured). I distinguish the earlier debug-core live21 and release-core live22 results in [historical live evidence](../README.md#historical-live-evidence). This guide covers platform and toolchain requirements, installing and verifying the deterministic Linux release tarball, building from source and running the offline gate, resolving optional pinned external components, the RAM-first capture policy and XDG storage layout, uninstallation, and troubleshooting with exact gate and package error codes.

## 1. Platform and Requirements

MetaViewer is Linux-first: **`linux-arm64` (`aarch64`) is the primary target** and **`linux-x64` (`x86_64`) is supported** [CITED: `ui/tools/package.js`, `.github/workflows/ci.yml`, `.github/workflows/package.yml`].

macOS and Windows are **not supported**. In `ui/tools/package.js`, `packageArchitecture()` rejects any architecture other than `arm64` and `x64` with `PKG_ARCH_UNSUPPORTED` (checking ELF machine `183` for `arm64` and `62` for `x64`) [CITED: `ui/tools/package.js`]. In `.github/workflows/ci.yml`, the `build-macos` and `build-windows` jobs are non-blocking (`continue-on-error: true`), excluded from `ci-required.needs`, and emit `NOT_APPLICABLE` gate receipts [CITED: `.github/workflows/ci.yml`].

### Required Toolchains and Pins

| Component | Required Version / Pin | Source of Truth | Notes |
| --- | --- | --- | --- |
| Release version | `0.1.2` [CITED] | `VERSION`, `Cargo.toml`, `agents/pyproject.toml`, `ui/package.json` | Enforced for parity by the `manifests` and `laws` gate legs (`tools/gate.sh`). |
| Node.js | `>=24` [CITED] | `ui/package.json` (`engines.node`) | Checked by `ui/tools/package.js` and `tools/gate.sh`; hosted CI runs Node `24` (`.github/workflows/ci.yml`). |
| Electron | `44.9.2` [CITED] | `ui/package.json`, `ui/electron/main.js` (`ELECTRON_PIN`) | Supplied from local disk via `ELECTRON_OVERRIDE_DIST_PATH` or `MV_ELECTRON_ZIP_DIR`; network downloads are disabled (`ELECTRON_SKIP_BINARY_DOWNLOAD=1`). |
| Rust compiler & Clippy | `1.97` (`1.97.0` in CI) [CITED] | `Cargo.toml` (`rust-version`) | Used to compile `metaviewer-core` and `mv-replay` (`core/Cargo.toml`) and run `cargo clippy --offline`. |
| Rust formatter | `1.92.0` [CITED] | `tools/gate.sh`, `.github/workflows/ci.yml` | Invoked as `rustup run 1.92.0 cargo fmt --all --check`. |
| Go | `1.26.0` [CITED] | `daemon-adapter/go.mod` | Builds `mv-daemon-adapter` offline with `GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local`. |
| Python | `>=3.11` (`3.12` in CI) [CITED] | `agents/pyproject.toml` (`requires-python`) | Standard library only (`dependencies = []`); `tools/gate.sh` requires Python's `tomllib`. |
| Capsule UI Kit | `0.2.1` (`bf31bc201987206d16dbd88d93102f9d5ce026f9`) [CITED] | `ui/kit.lock.json` | Content hash `1bee78c76a0a2a41d085beed918ca6ca791beaf53b952d4a9367dad660fd6dc2`, staged from a local checkout via `CAPSULE_UI_KIT_REPO` or `MV_KIT_CHECKOUT`. |

### Headless Display and Host Utilities

For headless UI smoke tests (`ui-smoke` leg in `tools/gate.sh`) and clean-install package verification (`--smoke` in `ui/tools/package.js`), the host must provide:

- `xvfb-run` (required by `tools/gate.sh` for `ui/test/smoke.mjs` and `ui/test/smoke-main.mjs`, and by `ui/tools/package.js` for `--smoke`) [CITED: `tools/gate.sh`, `ui/tools/package.js`].
- `tar`, `zip`, `strace`, `git`, `sha256sum`, `timeout`, and `mktemp` (used by `tools/gate.sh`, `tools/sync_kit.mjs`, and `ui/tools/package.js`) [CITED: `tools/gate.sh`, `ui/tools/package.js`, `.github/workflows/package.yml`].

Distribution-specific package manager commands (`apt`, `dnf`, `pacman`) for installing system packages are not documented yet.

RAM admission serializes native creates across daemons and reserves 512 MiB per incumbent above a host `MemAvailable` floor of min(20 GiB, 25 percent of `MemTotal`) [TARGET, conductor decision; CITED: `daemon-adapter/internal/daemon/ram_admission.go`]. Reservations live in the uid-owned `0700` directory `$MV_RAM_ADMISSION_DIR`, or `$XDG_RUNTIME_DIR/metaviewer/ram-admission` when the override is unset; all daemons for the uid must share it. PID death alone never releases a reservation. Run `python3 tools/mv_ram_admission.py reclaim --dry-run` as the operator to print each proposed removal and its proof, then explicitly use `--apply` after review. The command holds the admission lock, checks owner death, and reads the local Docker inventory (including stopped containers); because reservation hashes cannot identify random native run IDs, any `srf-` container or unknown/remote inventory keeps the reservations [TARGET, unit decision]. Only proven global native absence permits removal of a valid stale record. Reclaim is never automatic; run it with the same Docker context and admission directory as the daemon. Offline tests use private admission directories and never reclaim host records.

## Identities

Browser sessions are credentials: the operator logs in by hand inside the native
capsule view. MetaViewer has no password vault and agents never type credentials.
Distinct identity ids may use the same domains for separate accounts.

The operator-only host tool is `python3 tools/mv_identity.py`. Configure absolute
`MV_SRF_BIN_DIR`, `SRF_IDENTITY_STORE_ROOT`, `MV_SRF_STATE_DIR` and the native
`SRF_PROXY_REGISTRY`. Set `MV_MW_HOME` to the MemoryWeb home (or supply
`--memoryweb-home` before the verb). This explicit home declaration is required
even when MemoryWeb is unused; choose a separate reserved home directory.
The identity store must be outside both the repository and MemoryWeb home;
overlapping paths, including symlink aliases, are refused as
`MUT-PROFILE-IN-REPO`. Control directories must be private to the current user.
Host identity ids are limited to a suffix of at most 40 characters [TARGET],
so an explicit `srf-id-<identity>` fits native `capsuleRE` [CITED:
OpenSuperficies `a9ac1ac8`, `src/browserid/surface/surface.go:184`].
Login requests that explicit capsule on start and uses the validated native reply;
an active lease may instead name any native-valid capsule, including a random
`srf-id-<hex>` capsule started elsewhere.

Before a real start, the operator must provision `profiles/<identity>` as a
private directory with mode `0700` and owner uid `10001` [CITED: OpenSuperficies
`a9ac1ac8`, `src/browserid/surface/surface.go:392-393`]. Native admin creation
alone does not satisfy this ownership prerequisite; arrange it with the native
profile-management permissions before running login. Keep metadata, locks and
state directories owned by the calling operator.

```bash
python3 tools/mv_identity.py create --id account-main --label 'Main account' --domains example.com
python3 tools/mv_identity.py list
python3 tools/mv_identity.py show --id account-main
python3 tools/mv_identity.py login --id account-main
python3 tools/mv_identity.py delete --id account-main
```

Each invocation emits a single JSON line with schema `metaviewer.identity/v1`.
Login reuses an active identity capsule or starts it, prints the native loopback
view URL to stderr, and waits for the operator to close the native session using
Ctrl+C or native `view-stop`. Closing a browser tab alone does not stop the native
view. Native teardown restores read-only mode; capsule stop/start keeps the same
profile directory. The tool does not inspect cookies, Local Storage or any
profile payload and does not assert that authentication succeeded.

[TARGET, unit decision] The pinned native admin exposes only create/show, so
list enumerates metadata names and obtains native show replies. Delete removes
only the exact validated identity while holding the native per-id guard; an
active or malformed lease refuses deletion. Deletion never releases another
identity's lease and leaves other identities' metadata and profiles untouched.
It may require the operator's existing native profile-removal permissions.

During a registered login view, the adapter refuses agent-origin input with
`LOGIN_ACTIVE`, including while login opens or teardown is uncertain. Human
input retains the existing `take_control` requirement. Native registration is
`views/<container>.pid` under the state directory (OpenSuperficies
`src/browserid/surface/viewstop.go:20-31`); the host also reserves a pending marker
before launching login. If a crash leaves `views/<container>.login-pending`,
first stop the native login view and verify that no login process is still
opening or holding that capsule. Set `container` to the exact validated capsule
name from the native start reply or active lease. Run
`"$MV_SRF_BIN_DIR/srf-identity-surface" view-stop --container "$container" --state-dir "$MV_SRF_STATE_DIR" --store-root "$SRF_IDENTITY_STORE_ROOT"`.
Only after verified teardown (or native confirmation that no view exists),
remove the stale reservation:

```bash
rm -- "$MV_SRF_STATE_DIR/views/$container.login-pending"
```

An absent view registration alone is insufficient while a login is opening.
Wire contracts remain unchanged. UI integration should
provide an identities menu (create, log in, list, delete) and a human-control
banner during login; all credential entry remains in the capsule view.

## 2. Installing from the Release Package Tarball

The packaging pipeline (`scripts/bootstrap.sh` and `ui/tools/package.js`) produces a deterministic GNU tar archive outside the repository at `$MV_PKG_OUT/MetaViewer-linux-<arch>.tar` (`MetaViewer-linux-arm64.tar` on `arm64`, `MetaViewer-linux-x64.tar` on `x64`) alongside `$MV_PKG_OUT/MetaViewer-linux-<arch>.sha256` [CITED: `ui/tools/package.js`].

Each release archive contains:

- `MetaViewer-linux-<arch>/metaviewer` — the Electron `44.9.2` main executable with security fuses patched and verified [CITED: `ui/tools/package.js`].
- `MetaViewer-linux-<arch>/resources/bin/metaviewer-core` — the release-mode Rust authority core binary [CITED: `ui/tools/package.js`].
- `MetaViewer-linux-<arch>/resources/bin/mv-daemon-adapter` — the stripped Go daemon adapter binary [CITED: `ui/tools/package.js`].
- `MetaViewer-linux-<arch>/resources/app.asar` — the sealed ASAR bundle (`PACKAGED_ASSET_DIGESTS` embedded into `electron/main.js`, `electron/nesting.js` production entry, and `electron/package-pin.json`) [CITED: `ui/tools/package.js`].
- `MetaViewer-linux-<arch>/resources/contracts/v0.2` — the `21` `[MEASURED: ls -1 contracts/v0.2/*.schema.json | wc -l]` versioned v0.2 JSON wire schemas [CITED: `ui/tools/package.js`].
- `MetaViewer-linux-<arch>/resources/deps.lock` and `MetaViewer-linux-<arch>/resources/kit.lock.json` — the external component and UI kit lockfiles [CITED: `ui/tools/package.js`].
- `MetaViewer-linux-<arch>/INSTALL.md` — the bundled launch and manifest verification note [CITED: `ui/tools/package.js`].
- `MetaViewer-linux-<arch>.sha256` — the SHA-256 manifest covering every regular file in `MetaViewer-linux-<arch>/` [CITED: `ui/tools/package.js`].

OS-level desktop installers (`.deb`, `.rpm`, Flatpak, AppImage, or `.desktop` file registration) are not available.

### Extract and Verify the SHA-256 Manifest

Extract the tarball into an installation directory and check the SHA-256 manifest from inside the extracted `MetaViewer-linux-<arch>` directory (`arm64` shown; replace `arm64` with `x64` on `x86_64`) [CITED: `ui/tools/package.js`]:

```bash
mkdir -p /path/to/install-root
tar --no-same-owner -xf /path/to/MetaViewer-linux-arm64.tar -C /path/to/install-root
cd /path/to/install-root/MetaViewer-linux-arm64
sha256sum -c ../MetaViewer-linux-arm64.sha256
```

### Verify the Installation (`--verify-install` and `--smoke`)

When a repository checkout is available, I run the closed package verifiers in `ui/tools/package.js` [CITED: `ui/tools/package.js`, `.github/workflows/package.yml`]:

```bash
node ui/tools/package.js --verify-install /path/to/install-root/MetaViewer-linux-arm64
node ui/tools/package.js --smoke /path/to/MetaViewer-linux-arm64.tar
```

- `--verify-install` checks that `metaviewer`, `resources/bin/metaviewer-core`, and `resources/bin/mv-daemon-adapter` are regular executables matching the target ELF architecture (`183` for `arm64`, `62` for `x64`), validates every entry against `<root>.sha256` (refusing symlinks, extra files, or missing files), rejects any bundled font files across the directory and `resources/app.asar`, and verifies Electron fuses and sealed ASAR renderer asset digests [CITED: `ui/tools/package.js`].
- `--smoke` extracts the `.tar` archive into an isolated temporary directory, runs three negative controls (`PKG_MANIFEST_MISMATCH`, `PKG_FONT_FORBIDDEN`, and `PKG_BINARY_MISSING`), launches `metaviewer` under `xvfb-run -a` and `strace -f -e trace=file` to verify `METAVIEWER_MAIN_SMOKE_OK`, adapter handshake/reaping, and zero file accesses back to the source repository, and confirms that retail launch refuses `--remote-debugging-port=9222` [CITED: `ui/tools/package.js`].

### Run the Packaged Application

From the extracted `MetaViewer-linux-<arch>` directory [CITED: `ui/tools/package.js`]:

```bash
cd /path/to/install-root/MetaViewer-linux-arm64
./metaviewer
```

On launch, the packaged entry creates an isolated `0700` temporary runtime directory (`mv-pkg-*`), writes a per-session core registration, spawns `resources/bin/metaviewer-core`, waits for `metaviewer/core.sock`, and starts the UI [CITED: `ui/tools/package.js`]:

- **With OpenSuperficies configured (`MV_SRF_BIN_DIR`)**: when `MV_SRF_BIN_DIR` points to the directory containing the pinned OpenSuperficies binaries (`srf-identity-surface` and `srf-holdings-capsule`), the main process supervises `resources/bin/mv-daemon-adapter` alongside `metaviewer-core` [CITED: `ui/tools/package.js`, `docs/ARCHITECTURE.md`].
- **Without `MV_SRF_BIN_DIR`**: the packaged app starts `metaviewer-core` in a core-only degraded state [CITED: `ui/tools/package.js`].
- **Nested display-only mode**: pass `--nested-depth=1` (`./metaviewer --nested-depth=1`) only for the separate display-only view [CITED: `ui/tools/package.js`].

## 3. Building from Source and Running the Gate

All source builds and tests run offline against pre-populated local caches (`--offline` for Cargo and npm, `GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local` for Go) [CITED: `tools/gate.sh`, `ui/tools/package.js`].

### Stage the UI Kit and Build Individual Components

From the repository root [CITED: `README.md`, `tools/gate.sh`, `ui/package.json`]:

```bash
export CAPSULE_UI_KIT_REPO=/path/to/capsule-ui-kit
export ELECTRON_OVERRIDE_DIST_PATH=/path/to/electron-dist
export CARGO_TARGET_DIR=/path/to/cargo-target

node tools/sync_kit.mjs "$CAPSULE_UI_KIT_REPO"
node tools/sync_kit.mjs --check

cargo build --offline -p metaviewer-core
rustup run 1.92.0 cargo fmt --all --check
cargo clippy --offline --all-targets -- -D warnings
cargo test --offline

go -C daemon-adapter vet ./...
go -C daemon-adapter test -race -count=1 ./...
go -C daemon-adapter build -o mv-daemon-adapter ./cmd/mv-daemon-adapter

cd ui
npm ci --offline
npm test
npm run check
npm run build
npm run smoke
cd ..
```

### Build the Release Package Tarball (`scripts/bootstrap.sh`)

`scripts/bootstrap.sh` validates `ui/test/nesting.test.js` and invokes `ui/tools/package.js` (also mapped to `npm run package` in `ui/package.json`) [CITED: `scripts/bootstrap.sh`, `ui/package.json`]. It requires:

- `MV_PKG_OUT`: an absolute path to an external output directory outside the repository that does not already contain `MetaViewer-linux-<arch>` or `MetaViewer-linux-<arch>.sha256` [CITED: `scripts/bootstrap.sh`, `ui/tools/package.js`].
- `CAPSULE_UI_KIT_REPO`: path to the local `capsule-ui-kit` checkout matching `ui/kit.lock.json` [CITED: `scripts/bootstrap.sh`, `ui/kit.lock.json`].
- `CARGO_TARGET_DIR`: an absolute directory path for the Cargo release build [CITED: `ui/tools/package.js`].
- `ELECTRON_OVERRIDE_DIST_PATH` or `MV_ELECTRON_ZIP_DIR`: local Electron `44.9.2` distribution directory or zip cache containing `electron-v44.9.2-linux-<arch>.zip` [CITED: `scripts/bootstrap.sh`, `ui/tools/package.js`].

```bash
export MV_PKG_OUT=/path/to/external-pkg-out
export CAPSULE_UI_KIT_REPO=/path/to/capsule-ui-kit
export ELECTRON_OVERRIDE_DIST_PATH=/path/to/electron-dist
export CARGO_TARGET_DIR=/path/to/cargo-target

bash scripts/bootstrap.sh
```

### Run the Offline Gate (`tools/gate.sh`)

`tools/gate.sh` executes all `11` `[MEASURED: bash tools/gate.sh]` local verification legs (`manifests`, `laws`, `contracts`, `unit`, `agents`, `js`, `rust`, `go`, `ui`, `ui-smoke`, `perf`) inside a private `0700` environment (`TMPDIR`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `XDG_DATA_HOME`, `XDG_RUNTIME_DIR`; setting `MV_GATE_PERF_LIVE=1` additionally enables the live Electron RSS probe in the `perf` leg) [CITED: `tools/gate.sh`, `docs/TESTING.md`]:

```bash
export CAPSULE_UI_KIT_REPO=/path/to/capsule-ui-kit
export ELECTRON_OVERRIDE_DIST_PATH=/path/to/electron-dist
export CARGO_TARGET_DIR=/path/to/cargo-target

bash tools/gate.sh
bash tools/gate.sh --leg manifests
bash tools/gate.sh --self-test
```

You can also run the standalone standard-library checkers directly [CITED: `README.md`, `tools/gate.sh`]:

```bash
python3 tools/check_laws.py
python3 tools/check_laws.py --version
python3 tools/check_contracts.py
python3 -m unittest discover -s tests -v
python3 -m unittest discover -s agents/tests -v
```

### What Hosted CI Proves on `arm64` and `x64`

Hosted CI runs on both `ubuntu-24.04` (`x64` / `x86_64`) and `ubuntu-24.04-arm` (`arm64` / `aarch64`) inside an unprivileged offline network namespace (`.github/workflows/offline.sh`) after priming toolchains and caches [CITED: `.github/workflows/ci.yml`, `.github/workflows/package.yml`]:

- `.github/workflows/ci.yml` runs `ci-policy`, `laws-contracts`, `router`, and per-architecture matrix jobs (`rust`, `go`, `python`, `js`, `e2e`, `package`), plus `novac` and the `ci-required` aggregator, which rebuilds and verifies independent per-architecture package bytes via `python3 tests/ci/test_package_identity.py --build` and `python3 tests/ci/test_package_identity.py --distribution` [CITED: `.github/workflows/ci.yml`, `tests/ci/test_package_identity.py`].
- `.github/workflows/package.yml` runs `bash scripts/bootstrap.sh`, `node ui/tools/package.js --verify-install`, and `node ui/tools/package.js --smoke` on both `x64` and `arm64` [CITED: `.github/workflows/package.yml`].

## 4. Optional Pinned Components and Resolution (`deps.lock`)

External runtime components are pinned in `deps.lock` by component name, kind, repository, version, and full 40-character lowercase Git commit SHA. Under Law L2 and Law L5, they stay in their own repositories and are **never vendored** into this tree [CITED: `LAWS.md`, `deps.lock`, `tools/gate.sh`]:

| Component | Kind | Repository | Version | Pinned Commit (`deps.lock`) | Runtime Environment Variable |
| --- | --- | --- | --- | --- | --- |
| `vision-engine` | `python_package` | `oguirado/vision-engine` | `v0.2.0` [CITED] | `3bb54835db8a2e545311cfcc45185a0dfbd9313a` [CITED] | `VQA_VE_ROOT` [CITED: `agents/metaviewer_agents/perception/deps_lock.py`] |
| `wender-agent` | `python_package` | `oguirado/wender-agent` | `v0.3.0` [CITED] | `96120967b435b72fc6d29635f3844dae140388a9` [CITED] | `MV_WENDER_ROOT` [CITED: `agents/metaviewer_agents/perception/deps_lock.py`] |
| `opensuperficies` | `go_binary` | `oguirado/OpenSuperficies` | `os-cu-w9-mv1` [CITED] | `a9ac1ac8543872b428990ea23fa2629cd0a6d1d5` [CITED] | `MV_SRF_BIN_DIR` [CITED: `daemon-adapter/internal/daemon/environment.go`] |

I keep MetaViewer, OpenSuperficies, vision-engine, and wender-agent in their own repositories. I use the exact commit column as checkout authority; version fields are release labels [CITED: `deps.lock`]. I use persistent `vadapt.vserve` when its raw-frame handshake succeeds (including a typed `ring` capability), with one-shot `vadapt.cu_describe` fallback. I use `wender.plan.cli` over the pipe-only planner boundary; MetaViewer retains action admission and execution [CITED: `agents/metaviewer_agents/perception/vcore.py`, `agents/metaviewer_agents/wender_bridge.py`]. Assembly CI runs that boundary with `--require-planner` [CITED: `.github/workflows/assembly.yml`].

I leave `MV_CAPTURE_RING` unset until the OpenSuperficies ring pin and host mount are ready; `MV_CAPTURE_RING=1` opts into the validated resident reader [CITED: `daemon-adapter/internal/frames/ringsource.go`].
I use `MV_LIVE_WEB=1` only for the opt-in live web runner and leave it unset in hosted CI [CITED: `tests/e2e/e2e1_slice/asm_web_live.py`].

### Python Agent Component Resolution (`agents/metaviewer_agents/perception/deps_lock.py`)

`resolve_locked_component(name, *, lock_path=None)` in `agents/metaviewer_agents/perception/deps_lock.py` resolves `vision-engine` (`VQA_VE_ROOT`) and `wender-agent` (`MV_WENDER_ROOT`) against `deps.lock` before importing any private package [CITED: `agents/metaviewer_agents/perception/deps_lock.py`]:

1. **Git checkout mode**: if `<root>/.git` exists, it runs `git -c core.fsmonitor=false -C <root>` in a scrubbed environment (`HOME=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`) to verify that `HEAD` equals the 40-character commit in `deps.lock` and that `git status --porcelain --untracked-files=no` is empty [CITED: `agents/metaviewer_agents/perception/deps_lock.py`].
2. **Wheel / venv / `.dist-info` mode**: if `<root>/.git` is absent, it locates the single `<distribution>-*.dist-info/direct_url.json` (under `<root>`, `<root>/lib/python*/site-packages`, or `<root>/Lib/site-packages`) and verifies PEP 610 Git provenance (`vcs_info.vcs == "git"` and `vcs_info.commit_id` matching `deps.lock`) [CITED: `agents/metaviewer_agents/perception/deps_lock.py`].
3. **Fail-closed errors**: missing environment variables, non-directories, ambiguous metadata, dirty tracked trees, or mismatched commits raise `DependencyLockError` with code `unavailable`, `commit_mismatch`, `dirty_tree`, or `bad_lockfile` [CITED: `agents/metaviewer_agents/perception/deps_lock.py`].

### OpenSuperficies Resolution (`MV_SRF_BIN_DIR`)

The Go daemon adapter (`daemon-adapter/internal/daemon/environment.go`) and packaged launcher (`ui/tools/package.js`) resolve the capsule CLIs (`srf-identity-surface` and `srf-holdings-capsule`) from `MV_SRF_BIN_DIR` [CITED: `daemon-adapter/internal/daemon/environment.go`, `docs/ARCHITECTURE.md`, `ui/tools/package.js`]:

- When running the packaged app (`./metaviewer`), setting `MV_SRF_BIN_DIR` enables automatic supervision of `resources/bin/mv-daemon-adapter`; omitting it starts `metaviewer-core` in a core-only degraded state [CITED: `ui/tools/package.js`].
- When running `mv-daemon-adapter` directly from a source build, `MV_SRF_BIN_DIR`, `MV_SRF_STATE_DIR` (existing or newly created `0700` directory owned by current UID), `SRF_IDENTITY_STORE_ROOT`, `SRF_PROXY_REGISTRY`, and `XDG_RUNTIME_DIR` must all be absolute paths, paired with `MV_SESSION_ID`, `MV_CORE_INSTANCE`, `MV_DAEMON_INSTANCE`, and either `MV_SRF_PROFILES` or `MV_SRF_LIVE_PROFILE` + `MV_SRF_LIVE_RAM_ROOT` [CITED: `daemon-adapter/internal/daemon/environment.go`, `docs/USER_GUIDE.md`].

## 5. RAM-First Data Policy and XDG Locations

### RAM-First Capture and Recording Export

I designed frame transport and surface recording to be strictly RAM-first [CITED: `docs/ARCHITECTURE.md`, `core/src/record/capture/export.rs`, `ui/electron/captureBridge.js`]:

- **Live capsule frame buffers (`/dev/shm`)**: the adapter frame publisher requires a `/dev/shm` (`tmpfs`) RAM root owned by the current UID, writes immutable `0600` frame files with `O_NOFOLLOW`/`O_EXCL`, and verifies the SHA-256 digest before publishing `frame_ref/v0.2` (`daemon-adapter/internal/frames/publisher.go`, `core/src/serve/mod.rs`, `ui/electron/frameReader.js`). Up to `64 MiB` per frame and 16 surfaces are supported; frame file paths never cross Electron IPC to the renderer [CITED: `docs/ARCHITECTURE.md`, `daemon-adapter/internal/daemon/environment.go`].
- **In-memory screenshots and AI recordings (`metaviewer.capture`)**: per-tile screenshots and recordings (`idle` → `starting` → `recording` → `stopping` → `sealed`) accumulate in RAM (`core/src/record/capture/export.rs`, `ui/electron/captureBridge.js`). No disk access occurs before RAM validation [CITED: `core/src/record/capture/export.rs`].
- **Explicit disk export (`MV_RECORDING_DESTINATION`)**: recordings reach disk only when a recording is `sealed` and the operator has set `MV_RECORDING_DESTINATION` to an absolute directory path outside the source repository (`ui/electron/authorityWire.js`, `core/src/record/capture/export.rs`). Export writes a deterministic `ustar` archive (`frames/00000000.png` ..., mode `0600`, zeroed timestamps/owners, capped at `16 MiB`, `4096` frames, and `4096` pixels per axis) via an exclusive temporary file and no-clobber link after the core journals the export receipt [CITED: `core/src/record/capture/export.rs`, `ui/electron/captureBridge.js`].

### XDG Storage Layout

| Purpose | Environment Variable | Default / Fallback Path | Permissions & Rules |
| --- | --- | --- | --- |
| UI settings | `XDG_CONFIG_HOME` | `$XDG_CONFIG_HOME/metaviewer/settings.json` (fallback `$HOME/.config/metaviewer/settings.json`) | Directory mode `0700`, file mode `0600`, max `262144` bytes (`WIRE_MAX_BYTES`), closed `{scheme, density}` JSON (`mv-light` / `mv-dark`, `compact`), atomic temp write + `fsync` + rename (`ui/electron/authorityWire.js`). |
| Session journals & state | `XDG_STATE_HOME` | `$XDG_STATE_HOME/metaviewer/sessions/<session_id>/journal.jsonl` (fallback `$HOME/.local/state/metaviewer/...`) | Directory mode `0700`; hash-chained append-only JSONL journal (`core/src/journal/mod.rs`, `docs/USER_GUIDE.md`). |
| Runtime IPC socket | `XDG_RUNTIME_DIR` | `$XDG_RUNTIME_DIR/metaviewer/core.sock` | Directory mode `0700`, socket mode `0600`, `SO_PEERCRED` UID check (`docs/ARCHITECTURE.md`). |
| Packaged retail runtime | `TMPDIR` (via `os.tmpdir()`) | `<tmpdir>/mv-pkg-<random>/` | Created mode `0700` on packaged `./metaviewer` startup to isolate `XDG_RUNTIME_DIR`, `XDG_STATE_HOME`, and `XDG_CONFIG_HOME`; removed automatically when the app exits (`ui/tools/package.js`). |

## 6. Uninstall

MetaViewer installs no system-wide daemons, privileged helpers, or root-owned files [CITED: `ui/tools/package.js`, `ui/electron/authorityWire.js`].

To remove an installed release bundle and all user state:

```bash
rm -rf /path/to/install-root/MetaViewer-linux-arm64 \
       /path/to/MetaViewer-linux-arm64.sha256 \
       /path/to/MetaViewer-linux-arm64.tar

rm -rf "${XDG_CONFIG_HOME:-$HOME/.config}/metaviewer" \
       "${XDG_STATE_HOME:-$HOME/.local/state}/metaviewer" \
       "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/metaviewer"
```

If you built from source, also remove your external `MV_PKG_OUT` and `CARGO_TARGET_DIR` directories, any exported capture archives under `MV_RECORDING_DESTINATION`, and the repository checkout.

## 7. Troubleshooting Gate and Package Failures

### Packaging, `--verify-install`, and `--smoke` Error Codes (`ui/tools/package.js`)

| Error Code / Message | Cause and Resolution |
| --- | --- |
| `PKG_ARCH_UNSUPPORTED` | Target or host architecture is not `arm64` or `x64`. Run on Linux `arm64` (`aarch64`) or `x64` (`x86_64`) [CITED: `ui/tools/package.js`]. |
| `PKG_ARCH_MISMATCH: <binary>` | `metaviewer`, `metaviewer-core`, or `mv-daemon-adapter` is not a 64-bit little-endian ELF executable or its ELF machine field does not match the target architecture (`183` for `arm64`, `62` for `x64`). Rebuild with the native toolchain for the target architecture [CITED: `ui/tools/package.js`]. |
| `PKG_BINARY_MISSING: <binary>` | One of `metaviewer`, `resources/bin/metaviewer-core`, or `resources/bin/mv-daemon-adapter` is missing, is a symlink, or lacks executable permissions (`0o111`) [CITED: `ui/tools/package.js`]. |
| `PKG_MANIFEST_INVALID` | `<package>.sha256` has a malformed line, relative path traversal (`.` or `..`), backslash, or duplicate file entry [CITED: `ui/tools/package.js`]. |
| `PKG_MANIFEST_MISMATCH: <file>` | A file in `MetaViewer-linux-<arch>/` has been modified or an extra unlisted file was added after packaging. Re-extract from the clean `.tar` archive [CITED: `ui/tools/package.js`]. |
| `PKG_MANIFEST_MISSING` | One or more files listed in `<package>.sha256` are absent from `MetaViewer-linux-<arch>/` [CITED: `ui/tools/package.js`]. |
| `PKG_ALIAS_FORBIDDEN` / `PKG_ENTRY_INVALID` | A symlink or special file (FIFO/socket/device) exists inside `MetaViewer-linux-<arch>/`. Only regular files and directories are admitted [CITED: `ui/tools/package.js`]. |
| `PKG_FONT_FORBIDDEN: <name>` | A font file (`.woff`, `.woff2`, `.ttf`, `.otf`, `.ttc`, `.eot`, `.pfa`, `.pfb`, or font magic header) was found in the package tree or `resources/app.asar`. Bundled fonts are forbidden by policy [CITED: `ui/tools/package.js`]. |
| `PKG_ELECTRON_PIN` | `ELECTRON_OVERRIDE_DIST_PATH/version` is not `44.9.2`. Point `ELECTRON_OVERRIDE_DIST_PATH` to an Electron `44.9.2` distribution [CITED: `ui/tools/package.js`]. |
| `PKG_ELECTRON_CHECKSUM` | `MV_ELECTRON_ZIP_DIR/electron-v44.9.2-linux-<arch>.zip` does not match the installed Electron package's `checksums.json` [CITED: `ui/tools/package.js`]. |
| `PKG_CARGO_TARGET_REQUIRED` | `CARGO_TARGET_DIR` is unset or relative when running `ui/tools/package.js`. Export an absolute `CARGO_TARGET_DIR` [CITED: `ui/tools/package.js`]. |
| `PKG_REVISION_INVALID` | `git rev-parse HEAD` did not return a 40-character lowercase hex SHA [CITED: `ui/tools/package.js`]. |
| `PKG_CORE_START_FAILED` | Packaged `resources/bin/metaviewer-core` exited early or did not bind `metaviewer/core.sock` within 10 seconds [CITED: `ui/tools/package.js`]. |
| `PKG_ADAPTER_START_FAILED` | `MV_SRF_BIN_DIR` was set during `MV_PACKAGE_SMOKE=1`, but the supervised adapter did not reach `availability: 'live'` with `handshakeSeen: true` [CITED: `ui/tools/package.js`]. |
| `PKG_SMOKE_MARKER_MISSING` | Clean-install smoke under `xvfb-run` did not emit `METAVIEWER_MAIN_SMOKE_OK` on stdout [CITED: `ui/tools/package.js`]. |
| `PKG_SMOKE_ADAPTER_RECEIPT_MISSING` / `PKG_SMOKE_ADAPTER_PID_INVALID` / `PKG_SMOKE_ADAPTER_HANDSHAKE_MISSING` / `PKG_SMOKE_ADAPTER_ENV_MISMATCH` / `PKG_SMOKE_ADAPTER_NOT_REAPED` / `PKG_SMOKE_ADAPTER_STILL_ALIVE` | Clean-install smoke adapter supervision or SIGTERM reaping check failed [CITED: `ui/tools/package.js`]. |
| `PKG_ARCHIVE_ALIAS` / `PKG_ARCHIVE_INVALID` | The `.tar` archive contains symlinks/non-regular entries or paths outside `MetaViewer-linux-<arch>/` and `MetaViewer-linux-<arch>.sha256` [CITED: `ui/tools/package.js`]. |
| `PKG_SOURCE_ACCESS` | During `--smoke`, `strace` observed the packaged executable accessing paths inside the source repository checkout [CITED: `ui/tools/package.js`]. |
| `PKG_RETAIL_REFUSAL_MISSING` | Packaged binary failed to reject forbidden retail debug flags (`--remote-debugging-port=9222`) with `RETAIL_FLAG` [CITED: `ui/tools/package.js`]. |

### Gate (`tools/gate.sh`), Kit Sync, Settings, and Dependency Resolver Errors

| Error Code / Diagnostic | Source | Cause and Resolution |
| --- | --- | --- |
| `kit absent` / `Kit repository/commit mismatch` / `Kit metadata/pin/hash mismatch` | `tools/sync_kit.mjs`, `tools/gate.sh` (`js` leg) | Set `CAPSULE_UI_KIT_REPO` (or `MV_KIT_CHECKOUT`) to a clean Git checkout of `capsule-ui-kit` at commit `bf31bc201987206d16dbd88d93102f9d5ce026f9` (`v0.2.1`) and run `node tools/sync_kit.mjs "$CAPSULE_UI_KIT_REPO"` [CITED: `tools/sync_kit.mjs`, `ui/kit.lock.json`]. |
| `ui: Node >=24 required` | `tools/gate.sh` (`ui` leg), `ui/tools/package.js` | Ensure `node --version` on `PATH` (or `NODE`) is major version `24` or newer [CITED: `tools/gate.sh`, `ui/tools/package.js`]. |
| `rust: pinned formatter unavailable` / `rust: clippy toolchain unavailable` | `tools/gate.sh` (`rust` leg) | Install the pinned Rust formatter (`rustup toolchain install 1.92.0 --profile minimal --component rustfmt`) and Rust `1.97.0` with `clippy` (`rustup toolchain install 1.97.0 --profile minimal --component clippy`) [CITED: `tools/gate.sh`, `.github/workflows/ci.yml`]. |
| `ui-smoke: no executable local Electron; set ELECTRON_OVERRIDE_DIST_PATH or install its local binary` | `tools/gate.sh` (`ui-smoke` leg) | Export `ELECTRON_OVERRIDE_DIST_PATH` pointing to a directory containing an executable `electron` `44.9.2` binary [CITED: `tools/gate.sh`]. |
| `ui-smoke: no display harness: missing xvfb-run` | `tools/gate.sh` (`ui-smoke` leg) | Install `xvfb-run` on `PATH` before running `ui-smoke` or package `--smoke` [CITED: `tools/gate.sh`]. |
| `DependencyLockError` (`unavailable`, `commit_mismatch`, `dirty_tree`, `bad_lockfile`) | `agents/metaviewer_agents/perception/deps_lock.py` | Set `VQA_VE_ROOT` (`vision-engine` at `3bb54835db8a2e545311cfcc45185a0dfbd9313a`) and `MV_WENDER_ROOT` (`wender-agent` at `96120967b435b72fc6d29635f3844dae140388a9`) to clean checkouts or PEP 610 wheels matching `deps.lock` [CITED: `agents/metaviewer_agents/perception/deps_lock.py`, `deps.lock`]. |
| `CONFIG_PATH` / `SETTINGS_DIRECTORY` / `SETTINGS_FILE` / `SETTINGS_IN_REPO` / `SETTINGS_DESTINATION` | `ui/electron/authorityWire.js` | `XDG_CONFIG_HOME` and `MV_RECORDING_DESTINATION` must be absolute paths outside the repository, with `$XDG_CONFIG_HOME/metaviewer` owned by the current UID at mode `0700` and `settings.json` at mode `0600` [CITED: `ui/electron/authorityWire.js`]. |
| `DESTINATION_UNSET` / `NOT_SEALED` / `DESTINATION_UNAVAILABLE` / `DESTINATION_EXISTS` / `LIMIT` / `CAPTURE_UNAVAILABLE` | `ui/electron/captureBridge.js`, `core/src/record/capture/export.rs` | Recording export requires a `sealed` recording, `MV_RECORDING_DESTINATION` set to an existing writable directory outside the repository, and an archive size within `16 MiB` (`4096` frames max) [CITED: `ui/electron/captureBridge.js`, `core/src/record/capture/export.rs`]. |

## Capsule network

OpenSuperficies is pinned to `3cb86d752f38457b6730eefd235d4da4c4039721`
[CITED: `deps.lock`]. This is the interim net-modes pin, not the final open-ready
pin. Legacy and proxied remain usable. Browser capsules use `--net open` by
default when the deployed binary advertises `open`.

[TARGET, unit decision] The Electron launcher probes
`$MV_SRF_BIN_DIR/srf-identity-surface capabilities` once before spawning the
adapter. It copies the capabilities v1 `net_modes=…` token into the child-only
`MV_SRF_NET_MODES` JSON array. Parent environment declarations are ignored.
Missing tokens, unavailable binaries and invalid or failed replies leave it
unset, retaining legacy behavior. The adapter reads this snapshot at startup.

Open means public internet only, with no LAN access or host services. Open
requires the operator-built `opensuperficies-identity-browser-arm64:0.2.0` image
[CITED: os-cu-0 `net_open_step0_v1.md`] with an entrypoint supporting
`SRF_NET_MODE=open`, the subsequent native pin enabling `openImageReady`, and
the installed native DOCKER-USER/INPUT firewall with a matching root-owned
witness. At this interim pin, native `start --net open` still returns exit code
`3` [CITED: os-cu-0 `net_open_step0_v1.md`] by design even with the firewall
installed. The adapter reports `NET_OPEN_PREREQ`, naming the image and firewall
prerequisites; it never retries or downgrades that refusal. Legacy remains
available when explicitly selected, and proxied remains usable with its policy
and proxy binary. Open mode passes no egress proxy environment variable.
Capsule isolation remains the native runtime's responsibility.

An operator may opt a capsule into a dedicated proxy with an exact domain
allowlist. The adapter reads
`$MV_SRF_STATE_DIR/egress/<profile_id>.json`, keyed by the admitted identity:

```json
{"schema":"metaviewer.capsule_egress/v1","mode":"allowlisted","domains":["example.com","docs.example.com"]}
```

The directory must be private (`0700`) and records private (`0600`), owned by the
current user, with no symlink components. Documents are bounded to 64 KiB;
allowlists contain 1–256 unique lowercase ASCII hostnames. Unicode names must
already be encoded as ASCII IDNA labels. Wildcards, IP addresses, ports, URLs,
empty lists, single-label names, localhost, and names ending in `.localhost`,
`.local`, `.internal`, `.lan` or `.home.arpa` are refused, as are trailing dots. The Go `StoreEgress` helper validates
and atomically stores records. Missing records mean open. An explicit `open`
record has an empty `domains` array. Invalid records never fall back to open.
The network mode is the one declared before the capsule started; change it,
then restart the capsule.

Only browser kinds receive network flags; program/vm retain legacy argv even
with an open record. For allowlisted mode the adapter generates `<profile_id>.policy.json` alongside
the record, using `browserid.proxy-policy/v1`, with the capsule's exact hosts in
`approved` and an empty `denied` array. It requests native `--net proxied --policy <file> --proxy-bin <absolute executable>`
and never passes `--audit`, starts or names the shared proxy container, or requests
proxy audit logs. The accepted native names are `--net legacy|open|proxied`;
`--policy <file>` and `--proxy-bin` are required for proxied. The proxy executable
is `$MV_SRF_BIN_DIR/srf-egress-proxy`, the same binary used by native `net up`;
native start owns one proxy container per capsule. An absent or non-executable
proxy binary refuses with `NET_EGRESS_INVALID` before quarantine or spawn.
Legacy omits all network flags entirely.

The accepted os-cu-0 v1 native flag interface is isolated in the adapter's
`networkStartArgs` function. Absent startup capability knowledge keeps the prior
start argv and environment. Legacy behavior may still require the pin's shared proxy.
Opting into an allowlist on such a pin or an injected runner refuses with
`NET_PROXIED_UNSUPPORTED`; it never silently starts open. After policy publication
the adapter re-loads the record and refuses `NET_EGRESS_CHANGED` on mismatch.
Created events retain the frozen surface-only shape for every mode. The adapter atomically publishes the private, owner-readable (`0400`)
`egress/<profile_id>.started.json` start witness after verified readiness,
replacing it on every start and removing it on verified stop. Its schema is
`metaviewer.capsule_egress_started/v1`: `capsule_id`, `effective_mode`
(`open`, `proxied`, or `legacy`, exactly as passed to native start),
`record_sha256` (SHA-256 of the pre-start record bytes or `absent`),
`start_mono_ns` and `start_wall_ns` (adapter clocks sampled before native start).
The agent entry requires that witness and matching current record bytes; it
reports the witness's effective mode and refuses changed settings with a restart
message. Capabilities are not probed again by the backend: only the adapter's
startup snapshot determines the argv used for that capsule. These adapter-local settings do not change the frozen contracts.
The hosted web runner retains its explicit offline barrier.

### Concurrent identities and RAM admission

[TARGET, unit decision] Configure `MV_SRF_PROFILES` with separate browser profile
IDs and existing, canonical, nonoverlapping `/dev/shm/` RAMRoot directories.
Each entry uses the existing Profile fields (`Kind`, `NativeKind`, `RAMRoot`,
`Display`, `Width`, `Height`). Use separate Display values for the pair.
One daemon/core connection multiplexes both surface IDs; the existing surface
capacity remains 16 [CITED: daemon configuration].

For separate live-stack instances, set `MV_SRF_LIVE_PROFILE` and
`MV_SRF_LIVE_RAM_ROOT` to the selected entry before each invocation. Each profile
gets its own stack lock, runtime, display, Electron user-data directory, and
workflow run. Nondefault identities require the explicit profile map. Preserve
that environment for status/stop; cleanup uses the saved identity and allocation.
The legacy default retains its existing stack directory. No live launch is needed
for the hosted fake-native tests in `ram_admission_test.go`.

Before each native create and again after initial capture, RAM admission requires
`MemAvailable_kB >= ramFloorKB + ramReserveKB * live_capsules`, counting incumbent
capsules across daemon processes conservatively, including lost bindings and
unbound quarantined profiles. A uid-owned `0700` admission directory is locked
with `flock` throughout read/check/start/initial capture. Reservations are written
before native start and released only after verified cleanup. The floor is the smaller of
20 GiB and 25 percent of host `MemTotal` [TARGET, conductor decision]; the reserve
is 512 MiB per incumbent [TARGET, unit decision], matching the configured shared
frame budget. Unreadable or malformed
meminfo refuses with `RAM_ADMISSION_REFUSED`. A failed post-check removes only the
new surface; sibling allocations are never reclaimed to make admission pass.

[TARGET, unit decision] The shared directory defaults to
`$XDG_RUNTIME_DIR/metaviewer/ram-admission`. `MV_RAM_ADMISSION_DIR` selects the
same canonical directory for daemons with private IPC runtime directories; live
stacks preserve the parent runtime admission directory through this variable.
All MetaViewer daemons of the uid must use the same admission directory.
Records from crashed daemons remain counted: a dead PID does not prove that its
native container is gone. Run `python3 tools/mv_ram_admission.py reclaim --dry-run` to inspect records,
then explicitly choose `reclaim --apply` to remove verified stale records. The
command requires both a dead owner PID and a read-only local Docker inventory
proving all native `srf-*` containers absent (including stopped containers);
present or unknown inventories keep reservations. Reclamation is never automatic.

The **Identities** menu manages public account labels and domains; several
accounts for the same site are supported. Use **Log in** to open the operator's
loopback login view, and enter credentials only there. Agent input remains
refused by the native identity reservation while that view is open. Current
authentication is shown as unknown because the native tool exposes login history
without a current-session witness.

Each capsule's **Network** action edits its admitted profile's adapter egress
record for the next start: **Open (default)** or **Dedicated proxy with allowlist**
(exact hostnames, one per line). Profiles shared by capsules share this policy.
An unset `MV_SRF_NET_MODES` displays **legacy**. Dedicated proxy requires the
`proxied` capability; Open requires identity image `0.2.0` [CITED] and the
operator-installed firewall witness. Network is separate from global settings.

[TARGET, unit decision] The trusted launcher supplies `MV_HANDOFF_PATHS`, a JSON
array of owner handoff paths (`output.with_suffix('.handoff.json')`), to Electron.
The host watches only these private files; paths never cross renderer IPC.
The persistent activity row says “CAPTCHA or bot check: solve it in the capsule,
then re-run”. **Take control** uses the existing control intent. **Acknowledge**
saves a private adjacent `.ack.json` record before hiding the row; failed
persistence leaves it visible. Acknowledgement does not resume an agent run.

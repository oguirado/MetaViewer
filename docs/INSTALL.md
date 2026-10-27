# Installing and Building MetaViewer on Linux (`arm64` and `x64`)

I build and test MetaViewer on Linux as a wall of live, isolated application surfaces governed by a Rust admission and journaling core [CITED: `docs/ARCHITECTURE.md`]. This guide covers platform and toolchain requirements, installing and verifying the deterministic Linux release tarball, building from source and running the offline gate, resolving optional pinned external components, the RAM-first capture policy and XDG storage layout, uninstallation, and troubleshooting with exact gate and package error codes.

## 1. Platform and Requirements

MetaViewer is Linux-first: **`linux-arm64` (`aarch64`) is the primary target** and **`linux-x64` (`x86_64`) is supported** [CITED: `ui/tools/package.js`, `.github/workflows/ci.yml`, `.github/workflows/package.yml`].

macOS and Windows are **not supported**. In `ui/tools/package.js`, `packageArchitecture()` rejects any architecture other than `arm64` and `x64` with `PKG_ARCH_UNSUPPORTED` (checking ELF machine `183` for `arm64` and `62` for `x64`) [CITED: `ui/tools/package.js`]. In `.github/workflows/ci.yml`, the `build-macos` and `build-windows` jobs only emit `NOT_APPLICABLE` receipts and are never required branch-protection statuses [CITED: `.github/workflows/ci.yml`].

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

## 2. Installing from the Release Package Tarball

The packaging pipeline (`scripts/bootstrap.sh` and `ui/tools/package.js`) produces a deterministic GNU tar archive outside the repository at `$MV_PKG_OUT/MetaViewer-linux-<arch>.tar` (`MetaViewer-linux-arm64.tar` on `arm64`, `MetaViewer-linux-x64.tar` on `x64`) alongside `$MV_PKG_OUT/MetaViewer-linux-<arch>.sha256` [CITED: `ui/tools/package.js`].

Each release archive contains:

- `MetaViewer-linux-<arch>/metaviewer` — the Electron `44.9.2` main executable with security fuses patched and verified [CITED: `ui/tools/package.js`].
- `MetaViewer-linux-<arch>/resources/bin/metaviewer-core` — the release-mode Rust authority core binary [CITED: `ui/tools/package.js`].
- `MetaViewer-linux-<arch>/resources/bin/mv-daemon-adapter` — the stripped Go daemon adapter binary [CITED: `ui/tools/package.js`].
- `MetaViewer-linux-<arch>/resources/app.asar` — the sealed ASAR bundle (`PACKAGED_ASSET_DIGESTS` embedded into `electron/main.js`, `electron/nesting.js` production entry, and `electron/package-pin.json`) [CITED: `ui/tools/package.js`].
- `MetaViewer-linux-<arch>/resources/contracts/v0.2` — the 20 versioned v0.2 JSON wire schemas [CITED: `ui/tools/package.js`, `README.md`].
- `MetaViewer-linux-<arch>/resources/deps.lock` and `MetaViewer-linux-<arch>/resources/kit.lock.json` — the external component and UI kit lockfiles [CITED: `ui/tools/package.js`].
- `MetaViewer-linux-<arch>/INSTALL.md` — the bundled launch and manifest verification note [CITED: `ui/tools/package.js`].
- `MetaViewer-linux-<arch>.sha256` — the SHA-256 manifest covering every regular file in `MetaViewer-linux-<arch>/` [CITED: `ui/tools/package.js`].

OS-level desktop installers (`.deb`, `.rpm`, Flatpak, AppImage, or `.desktop` file registration) are not documented yet.

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

`tools/gate.sh` executes all 10 local verification legs (`manifests`, `laws`, `contracts`, `unit`, `agents`, `js`, `rust`, `go`, `ui`, `ui-smoke`) inside a private `0700` environment (`TMPDIR`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `XDG_DATA_HOME`, `XDG_RUNTIME_DIR`) [CITED: `tools/gate.sh`, `docs/TESTING.md`]:

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
| `vision-engine` | `python_package` | `oguirado/vision-engine` | `v0.2.0` [CITED] | `9bbb49f220837388e1ab90c34ae0eedee27a66eb` [CITED] | `VQA_VE_ROOT` [CITED: `agents/metaviewer_agents/perception/deps_lock.py`] |
| `wender-agent` | `python_package` | `oguirado/wender-agent` | `v0.3.0` [CITED] | `7648b258d1d04953bacffe8627de5acd7c75d817` [CITED] | `MV_WENDER_ROOT` [CITED: `agents/metaviewer_agents/perception/deps_lock.py`] |
| `opensuperficies` | `go_binary` | `oguirado/OpenSuperficies` | `os-cu-w9-mv1` [CITED] | `a9ac1ac8543872b428990ea23fa2629cd0a6d1d5` [CITED] | `MV_SRF_BIN_DIR` [CITED: `daemon-adapter/internal/daemon/environment.go`] |

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
| `DependencyLockError` (`unavailable`, `commit_mismatch`, `dirty_tree`, `bad_lockfile`) | `agents/metaviewer_agents/perception/deps_lock.py` | Set `VQA_VE_ROOT` (`vision-engine` at `9bbb49f220837388e1ab90c34ae0eedee27a66eb`) and `MV_WENDER_ROOT` (`wender-agent` at `7648b258d1d04953bacffe8627de5acd7c75d817`) to clean checkouts or PEP 610 wheels matching `deps.lock` [CITED: `agents/metaviewer_agents/perception/deps_lock.py`, `deps.lock`]. |
| `CONFIG_PATH` / `SETTINGS_DIRECTORY` / `SETTINGS_FILE` / `SETTINGS_IN_REPO` / `SETTINGS_DESTINATION` | `ui/electron/authorityWire.js` | `XDG_CONFIG_HOME` and `MV_RECORDING_DESTINATION` must be absolute paths outside the repository, with `$XDG_CONFIG_HOME/metaviewer` owned by the current UID at mode `0700` and `settings.json` at mode `0600` [CITED: `ui/electron/authorityWire.js`]. |
| `DESTINATION_UNSET` / `NOT_SEALED` / `DESTINATION_UNAVAILABLE` / `DESTINATION_EXISTS` / `LIMIT` / `CAPTURE_UNAVAILABLE` | `ui/electron/captureBridge.js`, `core/src/record/capture/export.rs` | Recording export requires a `sealed` recording, `MV_RECORDING_DESTINATION` set to an existing writable directory outside the repository, and an archive size within `16 MiB` (`4096` frames max) [CITED: `ui/electron/captureBridge.js`, `core/src/record/capture/export.rs`]. |

# MetaViewer — Judge Quickstart

For refusal codes and source-backed next steps, see [Judge troubleshooting](JUDGE_TROUBLESHOOTING.md).

After installation, follow the [Judge tour](JUDGE_TOUR.md) with your AI.

This page installs the app-only wall (T1) or the live capsule kit (T2) on Linux x64.
Live capsules need local rootful Docker Engine. A source clone alone contains
neither the packaged application nor the private compiled runtimes.

- **Point your own AI at [AI_OPERATOR_GUIDE.md](AI_OPERATOR_GUIDE.md)**: a single,
  self-contained guide that lets your AI install, configure, verify, and explain
  the supported judge flows (left tree, desktops, tile presets, browser/program/X11
  capsules, human/agent hand-off, paired terminals, identities,
  and MemoryWeb / `mw_run` automation).
- Full build and environment reference: [INSTALL.md](INSTALL.md).
- Operator walkthrough: [USER_GUIDE.md](USER_GUIDE.md).

Supported architecture: Linux `x86_64` (`x64`) or `aarch64` (`arm64`); the release
recipes below target x64; arm64 requires a source build ([Path E](#path-e-linux-arm64)). The verified
host is Ubuntu 24.04 LTS. Debian 12/13 is a candidate platform and emits an
unverified-host warning. Windows 11 uses WSL2 + WSLg with rootful Docker Engine
inside the Ubuntu distro (Docker Desktop is not supported). macOS is not supported.
No GPU or CPU pinning is required. Minimums: see [Hardware](#hardware).
Hub and requirement table: [JUDGES.md](JUDGES.md).

## Judge paths by platform and tier

Answers: how do I install, install steps, which commands, expected output, install on Ubuntu, install on WSL, install on arm64, headless install

Choose a path for your platform and intended tier. Run as your normal user,
never with `sudo` in front of the launcher. Before the commands below, verify
that the [matching release](https://github.com/oguirado/MetaViewer/releases/tag/v0.2.6)
exists and supplies the required assets and the independent `SHA256SUMS` digest.
The checkout targets `0.2.6` [CITED: VERSION]; publication of that release is a
prerequisite, not a result proved by this source tree. If the tag, assets or digest
are missing, stop: `ABSENT — do not invent`. Never use an older package with these
instructions. For an unattended agent, use the [authorized paste block](JUDGES.md#what-do-i-paste-into-my-own-ai).

| Platform | Tier | Path |
| --- | --- | --- |
| Ubuntu 24.04 x64 desktop | T1 app only, no Docker | [Path A](#path-a-x64-desktop-app-only-t1) |
| Ubuntu 24.04 x64 desktop | T2 live capsules | [Path B](#path-b-x64-desktop-with-capsules-t2) |
| Headless x64 server | install and smoke only | [Path C](#path-c-headless-x64-install-check) |
| Windows 11 | T1 or T2 | [Path D](#path-d-windows-11-through-wsl2) |
| Linux arm64 | none from the release | [Path E](#path-e-linux-arm64) |
| macOS, Windows without WSL2 | none | Unsupported |

### Path A: x64 desktop, app only (T1)

Answers: install without docker, app only, T1 commands

Gives the wall, core and adapter; no live capsule ([tiers](JUDGES.md#which-capsules-does-each-tier-give)).
Assign the `SHA256SUMS` digest from the v0.2.6 release notes before fetching:

```bash
SHA256SUMS_DIGEST='<paste the SHA256SUMS digest from the v0.2.6 release notes>'
```

| Step | Command | Success marker | If it fails |
| --- | --- | --- | --- |
| 1 Clone | `git clone --branch v0.2.6 --depth 1 https://github.com/oguirado/MetaViewer.git && cd MetaViewer` | `git describe --tags` prints `v0.2.6` | Network or tag error: check the [release page](https://github.com/oguirado/MetaViewer/releases/tag/v0.2.6) |
| 2 Check host | `bash scripts/judge/metaviewer-judge.sh doctor --before-install` | `JUDGE_DOCTOR_OK tier=T1 phase=before-install (installed runtime not checked)` | Each `JUDGE_<CODE>:` line: [troubleshooting](JUDGE_TROUBLESHOOTING.md#kit-install-and-run) |
| 3 Fetch | `python3 scripts/judge/fetch_assets.py --source https://github.com/oguirado/MetaViewer/releases/download/v0.2.6 --sums-sha256 "$SHA256SUMS_DIGEST"` | `JUDGE_FETCH_OK arch=x64 tier=T1` | `JUDGE_ASSET` or `JUDGE_USAGE`: wrong digest, missing asset or no network |
| 4 Install | `bash scripts/judge/metaviewer-judge.sh install` | `METAVIEWER_MAIN_SMOKE_OK`, then `JUDGE_INSTALL_OK tier=T1 network=legacy receipt=…` | `JUDGE_SUDO` if you declined a package step; `JUDGE_SMOKE` for the smoke; see the table |
| 5 Full check | `bash scripts/judge/metaviewer-judge.sh doctor` | `JUDGE_DOCTOR_OK tier=T1` | Same table |
| 6 Run | `bash scripts/judge/metaviewer-judge.sh run` | Terminal shows `METAVIEWER_RENDERER_READY` and `METAVIEWER_MAIN_READY`; the wall opens | `JUDGE_NOT_INSTALLED`, `JUDGE_RUNNING`; `METAVIEWER_ADAPTER_DEGRADED` is expected in T1 |
| 7 Stop (second terminal) | `bash scripts/judge/metaviewer-judge.sh stop` | `stopped pid <n>` then `JUDGE_STOP_CLEAN` | `JUDGE_STOP_LEAK`, `JUDGE_STOP_TIMEOUT`: [stop table](JUDGE_TROUBLESHOOTING.md#stop) |

Install asks before each administrator step and prints the exact command; on a
fresh Ubuntu it asks to install missing packages such as `x11-utils`. Answer `y`,
or run the printed `sudo apt-get install -y …` yourself and rerun install.

### Path B: x64 desktop with capsules (T2)

Answers: install with docker, live capsules, T2 commands, browser capsules

Before step 2, make Docker Engine work for your user: `docker info` must succeed
without sudo ([Docker](#docker-tier-t2-only)). Then use Path A with `--capsules`
on doctor, fetch and install. Run and stop use no tier flag:

| Step | Command | Success marker |
| --- | --- | --- |
| 2 Check host | `bash scripts/judge/metaviewer-judge.sh doctor --capsules --before-install` | `JUDGE_DOCTOR_OK tier=T2 phase=before-install (installed runtime not checked)` |
| 3 Fetch | `python3 scripts/judge/fetch_assets.py --source https://github.com/oguirado/MetaViewer/releases/download/v0.2.6 --capsules --sums-sha256 "$SHA256SUMS_DIGEST"` | `JUDGE_FETCH_OK arch=x64 tier=T2` |
| 4 Install | `bash scripts/judge/metaviewer-judge.sh install --capsules` | `METAVIEWER_MAIN_SMOKE_OK`, then `JUDGE_INSTALL_OK tier=T2 network=<open\|legacy> receipt=…` |
| 5 Full check | `bash scripts/judge/metaviewer-judge.sh doctor --capsules` | `JUDGE_DOCTOR_OK tier=T2` |
| 6 Run | `bash scripts/judge/metaviewer-judge.sh run` | The wall opens and reports **Core connected**; continue with the [tour](JUDGE_TOUR.md) |
| 7 Stop | `bash scripts/judge/metaviewer-judge.sh stop` | `JUDGE_STOP_CLEAN` |

`run` and `stop` take no `--capsules`: run reads the tier from the install receipt
[CITED: scripts/judge/metaviewer-judge.sh:809]. Install offers one firewall step
for the Open network; declining it gives `network=legacy`, which reaches no public
site ([capsule network](#capsule-network-tier-t2-only)).

### Path C: headless x64 install check

Answers: no display, server, CI, xvfb

Proves install and smoke only; no visible wall. Use Path A or B commands, wrapping
install and doctor with `xvfb-run -a` (see [Headless installation](#headless-installation)).
Success: `JUDGE_INSTALL_OK`. Without a display, doctor refuses `JUDGE_DISPLAY`.

### Path D: Windows 11 through WSL2

Answers: windows, WSL, WSLg

Prepare Ubuntu 24.04 in WSL2 with systemd and WSLg as in [Windows (WSL2)](#windows-wsl2),
then follow Path A or Path B inside Ubuntu. Docker Desktop refuses
`JUDGE_DOCKER_DESKTOP`; install Docker Engine inside the distro. Without systemd,
doctor refuses `JUDGE_XDG_RUNTIME`.

### Path E: Linux arm64

Answers: arm64, aarch64, raspberry, ARM laptop, VM, MicroVM

No public arm64 compiled asset set is established here: do not fetch the x64 kit
or rename its files. [INSTALL.md](INSTALL.md#3-building-from-source-and-running-the-gate)
describes a source build with pinned toolchains, cached dependencies, the matching
UI kit and local Electron. Those prerequisites are not supplied by a source clone.
A public source build does not supply the private capsule runtimes; if their
matching arm64 assets are unavailable, stop at the app build. ARM64 VM, MicroVM
and rewind additionally need [developer setup](ARM64_CAPSULE_SETUP.md), KVM and
verified local assets. None is promised by the judge kit.

### What did the maintainer run on this checkout?

Answers: was this tested, verification of these instructions

A prior maintainer report describes host-doctor refusals and an app-only
pre-install check. Its raw receipt is not public, so it does not establish a
successful install on your host. The parser and documentation checks in
`tests/test_install_docs.py` and `tests/test_judge_tour_docs.py` validate command
syntax and source references; they do not run a live installation. Require the
markers above on your machine [CITED: tests/test_install_docs.py,
tests/test_judge_tour_docs.py].

## 0. Licence

Answers: licence, license, may I redistribute, AGPL, private components permission

MetaViewer source may be used, modified and redistributed under AGPL-3.0-only
([LICENSE](../LICENSE)). The separate proprietary programs `wender-agent`,
`vision-engine` and `OpenSuperficies` are fully private; `capsule-ui-kit` is a separate public repository under `AGPL-3.0-only`. The licensor permits hackathon judges to install, run and evaluate the
supplied compiled external components for judging, as stated in
[NOTICE-EVALUATION.md](../NOTICE-EVALUATION.md). Do not redistribute the compiled
external components in the kit; this restriction does not prevent redistribution
of MetaViewer source under the AGPL.

## 1. Release assets and verification

Answers: release assets, download, SHA256SUMS, checksum, which files, asset names

The judge kit uses the release assets in `assets/` (verified against
`assets/SHA256SUMS` before anything is unpacked):

| Asset | Tier | Purpose |
| --- | --- | --- |
| `SHA256SUMS` | T1 & T2 | Authoritative SHA-256 digests for every release asset |
| `metaviewer-linux-<x64\|arm64>.tar.gz` | T1 & T2 | Packaged `MetaViewer-linux-<arch>/` bundle and `MetaViewer-linux-<arch>.sha256` [CITED: `docs/INSTALL.md`] |
| `node-linux-<x64\|arm64>.tar.xz` | T1 & T2 | Node.js `>= 24` runtime (`*/bin/node` plus npm when included), extracted only when host `node` is missing or `< 24` |
| `opensuperficies-linux-<x64\|arm64>.tar.gz` | T2 | `opensuperficies/bin/srf*` binaries and `opensuperficies/firewall/` |
| `images-linux-<x64\|arm64>.tar` | T2 | `docker save` archive whose default tags are `opensuperficies-identity-browser-<arch>:0.1.1`, `opensuperficies-program-host-<arch>:0.1.0` and `opensuperficies-desktop-<arch>:1.1.0`. These defaults do not establish the presence of Open browser `:0.2.0` or additional program images; verify the supplied archive before relying on those tags [CITED: `tools/build_release_assets.py` (line 440)] |
| `vision-engine.tar.gz` | T2 | `vision-engine/` at the commit pinned in `deps.lock` |
| `wender-agent.tar.gz` | T2 | `wender-agent/` at the commit pinned in `deps.lock` |

From a fresh clone, fetch the assets in one command (Python is required):

Obtain the judge kit from the public repository at the tag of the same release
as the assets: set `RELEASE_TAG` to that published tag, run
`git clone --branch "$RELEASE_TAG" --depth 1 https://github.com/oguirado/MetaViewer.git`,
then `cd MetaViewer` and run `scripts/judge/fetch_assets.py` as shown below.

Set these variables from the maintainer's matching release notes before fetching.
The [v0.2.6 release](https://github.com/oguirado/MetaViewer/releases/tag/v0.2.6)
is the target release. Once published, its x64 assets must carry the names the
launcher expects (`metaviewer-linux-x64.tar.gz`, `node-linux-x64.tar.xz`,
`opensuperficies-linux-x64.tar.gz`, `images-linux-x64.tar`, `vision-engine.tar.gz`,
`wender-agent.tar.gz`, `SHA256SUMS`) [CITED: scripts/judge/metaviewer-judge.sh:25].
Set `RELEASE_TAG=v0.2.6`. The launcher defaults its download URL to the checkout's `VERSION`, but local
assets and URL overrides are also accepted. Keep the tag, notes and asset set
matched yourself; the URL default alone does not prove they match
[CITED: scripts/judge/metaviewer-judge.sh]. The matching asset base URL is:

```bash
export RELEASE_ASSET_URL=https://github.com/oguirado/MetaViewer/releases/download/v0.2.6
SHA256SUMS_DIGEST='<paste the SHA256SUMS digest from the v0.2.6 release notes>'
python3 scripts/judge/fetch_assets.py --source "$RELEASE_ASSET_URL" --capsules --sums-sha256 "$SHA256SUMS_DIGEST"
```

That release has no ARM64 compiled assets. The generic
architecture names below describe the packaging contract, not an available arm64
download. Source builds and later release sets require their own matching assets.
For a local release directory, use `--source "$RELEASE_ASSET_DIRECTORY"` instead.
Do not assume that a GitHub Actions artifact is a published release. Fetch refuses
incomplete or corrupt sets. Checksums protect integrity, not publisher authenticity.
The explicit fetch command authorizes the transfer; install still asks before
downloading missing assets unless `--yes` is supplied. Fetch verifies the entire
selected set before publishing it into the destination. Install separately checks
each archive before use; it can perform prerequisite work before discovering a
later missing asset [CITED: scripts/judge/fetch_assets.py, scripts/judge/metaviewer-judge.sh].

Fetch maps the architecture printed by `uname -m` (`aarch64` to `arm64`,
`x86_64` to `x64`) and writes verified files into `assets/`. A kit for the wrong architecture is
refused (`JUDGE_BUNDLE_ARCH` / `PKG_ARCH_MISMATCH`). Maintainers building the release
assets from local artifacts run `python3 tools/build_release_assets.py --out-dir ./assets ...`
(see [AI_OPERATOR_GUIDE.md](AI_OPERATOR_GUIDE.md#3-release-assets-and-building-them-locally)).
For a release build, supply `--node-tarball` with the official Node runtime archive
meeting the required major version [CITED: `../ui/package.json`]; the local-binary
builder does not verify its version before naming the archive.

You can also verify the unpacked application bundle manifest by hand:

```text
cd MetaViewer-linux-<arch>
sha256sum -c ../MetaViewer-linux-<arch>.sha256
```

Start in the directory containing the extracted tree; replace `<arch>` with `x64`
or `arm64`. The checksum command runs inside the bundle, as described in
[INSTALL.md](INSTALL.md#extract-and-verify-the-sha-256-manifest).

## Before you start

Answers: prerequisites, run as root, sudo, XDG_RUNTIME_DIR, asset directory, MV_JUDGE_HOME

- Run as a normal user. Electron refuses root without disabling its sandbox;
  do not run the launcher with `sudo` or add `--no-sandbox` to bypass it.
  Preflight refuses `JUDGE_ROOT` before installation; install requests its own
  administrator steps [CITED: `scripts/judge/preflight.sh`, `scripts/judge/metaviewer-judge.sh`].
- Use a desktop/logind session with an existing, user-owned `XDG_RUNTIME_DIR`.
  On WSL2, enable systemd and use WSLg. A display alone does not supply the runtime
  directory [CITED: `scripts/judge/preflight.sh`].
- `install --yes` accepts downloads and administrator steps, including package
  installation, AppArmor and the compatible Open firewall. It does not supply a
  sudo password. Omit `--yes` to review each request. Package-tool dependencies
  may be fetched with `npm ci --ignore-scripts` without a separate prompt
  [CITED: `scripts/judge/metaviewer-judge.sh`].
- To keep downloads outside the checkout, set `MV_JUDGE_ASSET_DIR` to an absolute
  writable directory and pass `--dest "$MV_JUDGE_ASSET_DIR"` to fetch. Fetch does
  not read that variable itself. `MV_JUDGE_HOME` selects a separate absolute
  installation/state directory without whitespace; its default is `$XDG_DATA_HOME/metaviewer-judge`
  (home fallback). Keep these variables set for doctor, install, run and stop
  [CITED: `scripts/judge/fetch_assets.py`, `scripts/judge/metaviewer-judge.sh`].
- Without Docker or private-runtime access, use [the app-only route](JUDGE_NO_DOCKER.md).

## 2. Check your machine (no changes made)

Answers: doctor, preflight, check my machine, before install

```bash
bash scripts/judge/preflight.sh --tier T2 --phase static
```

This host-only check is also available as
`bash scripts/judge/metaviewer-judge.sh doctor --capsules --before-install`.

The direct preflight prints `JUDGE_PREFLIGHT_OK tier=T2 phase=static` on success;
the doctor wrapper then prints
`JUDGE_DOCTOR_OK tier=T2 phase=before-install (installed runtime not checked)`
[CITED: scripts/judge/preflight.sh, scripts/judge/metaviewer-judge.sh].

Every refusal is printed as `JUDGE_<CODE>: <problem> -- fix: <command>` and exits
with code `2` [CITED: scripts/judge/preflight.sh]. Unknown shell subcommands or
options exit `64`; invalid `MV_JUDGE_HOME` values instead exit `2`
[CITED: scripts/judge/metaviewer-judge.sh]. Fetch argument errors exit `2`
[CITED: scripts/judge/fetch_assets.py]. Non-fatal resource advisories on smaller laptops are printed as
`JUDGE_NOTE: warning (JUDGE_<CODE>): ...` without blocking execution. Fix any
host refusals and re-run. `--before-install` checks host requirements only and does
not require installed images, profiles or proxy state. Missing tools are installed by
`install`; Docker access, host resources and session ownership still need attention.
After installation run `bash scripts/judge/metaviewer-judge.sh doctor --capsules`
(or omit `--capsules` for T1). Full doctor checks the installed runtime and should then
print `JUDGE_DOCTOR_OK tier=<T1|T2>`. T0 uses the separate fixture below.

| Tier | What you get |
| --- | --- |
| T0 | Offline conversation fixture only; no display or Docker, but requires the local private `wender-agent` checkout in `MV_MW_WENDER_ROOT`; not part of the public judge kit ([JUDGES.md](JUDGES.md)) |
| T1 | The packaged app: wall, core and adapter. Creating a capsule fails with a clear, correlated error: expected |
| T2 | T1 plus live browser and Linux program capsules; the default browser pool has 4 slots [CITED: scripts/judge/metaviewer-judge.sh]. Available memory gates every launch. |

## 3. Install (asks before every sudo step)

Answers: what does install do, install order, sudo steps, receipt

```bash
# App only (tier T1)
bash scripts/judge/metaviewer-judge.sh install
# Adds capsule images, network, and 4 profile slots (tier T2)
bash scripts/judge/metaviewer-judge.sh install --capsules
```

`install` stops at the first refusal and never runs `sudo` without printing the exact
command and asking first (`--yes` answers for you in non-interactive runs). In order:

1. Runs static preflight checks, including T1 RAM and disk floors.
2. Installs any missing Ubuntu/Debian system packages after your confirmation.
3. Checks the display before app extraction; then extracts `metaviewer-linux-<arch>.tar.gz` with `tar --no-same-owner`, loads the
   AppArmor userns profile only if Ubuntu restricts unprivileged user namespaces, and
   runs `--verify-install` and `--smoke` (ending with `METAVIEWER_MAIN_SMOKE_OK`).
4. With `--capsules` (Tier 2): extracts `opensuperficies`, `vision-engine`, and
   `wender-agent`; loads `images-linux-<arch>.tar` into Docker; then optionally
   installs the open-mode egress firewall when the compatible browser image is
   available (or falls back to the `sudo`-free legacy Docker network `srf-idnet`
   if unavailable, declined, or passed `--no-firewall`); and provisions the
   profile directories (`judge` and `mv-live-1..mv-live-4`, mode `0700`, UID `10001`)
   **without `sudo`** via a local Docker bind-mount.
5. Writes `judge_receipt.json` (architecture, core count, memory, versions, digests;
   never host paths or identity-store contents) and prints `JUDGE_INSTALL_OK`.

### System packages

Answers: apt packages, missing tools, x11-utils, xvfb

A clean Ubuntu/Debian host needs the system packages checked by `scripts/judge/preflight.sh` (`tar` plus):

```text
sudo apt-get install -y xvfb x11-utils xauth zip unzip strace git coreutils python3 python3-pip
```

Tier T2 (`--capsules`) additionally requires `docker.io` (or `docker-ce`, rootful Docker Engine) [CITED: `scripts/judge/preflight.sh`]. Building the Linux package from source (`scripts/bootstrap.sh` / `ui/tools/package.js`) additionally requires Node 24 (`>=24` [CITED: `ui/package.json`]), Go (`1.26.0` [CITED: `daemon-adapter/go.mod`]) and Rust (`1.97.0` compiler and Clippy, `1.92.0` formatter [CITED: `Cargo.toml`, `.github/workflows/ci.yml`]) per the CI pins in [INSTALL.md](INSTALL.md#required-toolchains-and-pins).

### Docker (tier T2 only)

Answers: docker group, rootless docker, Docker Desktop, docker permission denied

Docker must be rootful Docker Engine, reachable by your user through the `docker` group.
Rootless Docker and Docker Desktop are not supported: the adapter talks to the local
rootful socket and refuses `DOCKER_HOST` / `DOCKER_CONTEXT`.

```text
sudo usermod -aG docker "$USER"
```

Log out and back in, then re-run `doctor --capsules --before-install`. On WSL, close the distro, run `wsl --shutdown` from Windows and reopen it.

### Capsule network (tier T2 only)

Answers: open network, legacy network, firewall, public websites unreachable, srf-idnet

The installer loads the shipped image archive before offering the Open firewall step.
Open requires the actual `opensuperficies-identity-browser-<arch>:0.2.0` image
[CITED: `scripts/judge/preflight.sh`]; retagging the legacy image is not sufficient.
If that image is unavailable, the installer selects legacy and does not install a
firewall. An existing active Open witness with no matching image refuses with
`JUDGE_IMAGE`; obtain a compatible kit. With the Open image present, install offers
the exact administrator script; declining it or passing `--no-firewall` retains the
legacy fallback unless an Open firewall witness already exists.

**The legacy network reaches no public site today.** The shipped empty policy grants
no destinations. A running browser capsule is not evidence of working public browsing.
Arbitrary public browsing requires a compatible Open image and firewall; this kit does
not invent wildcard approvals or silently change proxy policy.

The reported release-package x64 WSL2 evaluation [CITED: maintainer evaluation; raw receipt absent]
verified Open network **with its firewall step**: a public site returned
HTTP 200 [CITED: maintainer evaluation; raw receipt absent]; local network and Docker bridge access were blocked. This
result does not certify a legacy kit or an install that declined the firewall.

### Headless installation

Answers: headless, xvfb-run, no DISPLAY

The install smoke needs an X server. On a headless host, install the display tools and
wrap the entire install (retain `--capsules` only for T2):

```text
sudo apt-get install -y xvfb xauth x11-utils
```

```bash
xvfb-run -a bash scripts/judge/metaviewer-judge.sh install --capsules
xvfb-run -a bash scripts/judge/metaviewer-judge.sh doctor --capsules
```

For interactive judging, run from a reachable desktop DISPLAY, XWayland or WSLg.
Xvfb supplies a virtual display; it does not provide a visible remote desktop.
The source checkout's package verifier may also need `npm ci` in `ui`; the official
Node archive contains npm, and the launcher preserves it. A Node-only asset or host
Node without npm refuses `JUDGE_NPM` when those dependencies are needed. The fetch
command itself does not install npm packages.

## 4. Run

Answers: run the app, what will I see, wall, profile pool, Add capsule

```bash
bash scripts/judge/metaviewer-judge.sh run
```

The UI described below is the source at the v0.2.6 tag, which the v0.2.6 package
is built from [TARGET]. The older `v0.2.5` package has a light shell without the
left Humans/Agents tree [CITED: maintainer evaluation; raw receipt absent]; if you
evaluate that binary, use its own tag and instructions and do not combine it with
these UI expectations.

The current source shell defaults to Dark unless a saved theme overrides it. Its three columns
[CITED: `../ui/src/App.vue`, `../ui/src/settings/settingsModel.js`] hold the left tree,
center wall and paired terminal dock. Storyboard is not available in live navigation.
The launcher shows installed host apps. Custom grid (⋯) sets snapping rows and columns; newly
floating tiles use the next free cell where possible.

T2 provides a default 4-slot browser profile pool [CITED: scripts/judge/metaviewer-judge.sh] (`judge` on `:100`, `mv-live-2` on
`:101`, `mv-live-3` on `:102`, `mv-live-4` on `:103`):

- Use the left **`Humans`** / **`Agents`** tree to select desktops and capsules, create virtual
  desktops with `+` and switch between existing desktops with `Ctrl+1..9`, and test tile layouts (`1` — one tile, `2` — two side by side,
  `2×2`, `3×2`, `Focus` — focus + strip, `Float` — floating layout). The compact
  controls retain descriptive accessible names and tooltips.
- Click **`＋ Add capsule`** to launch an **`Identity browser`**, a Linux **`Program`**
  (inside `opensuperficies-program-host-<arch>:0.1.0`), **`Host program`**, or an X11
  **`Desktop window`**. Host program and Desktop window run on your computer and
  are not isolated. Replace `<arch>` with `x64` or `arm64` for the installed image.
- Log into a site in human mode and click **`Mark as logged in`** to save its login
  status. Then choose **`Switch to agent mode`** separately to hand the capsule to
  the agent; watch live read-only, or click **`Take control (emergency)`**.
- Open the paired terminal dock or capsule drawer. Use **`＋ New terminal`** to select
  an installed agent profile, or enter **`Custom CLI`** and **`Launch`**. Pairing starts a
  host shell; it does not by itself launch an agent. **`Create automation`**,
  **`Run automation`**, and **`Direct task`** prepare prompts ending in `Task: ` with
  the paired identity. With an installed agent ready at its input prompt, the prompt is
  pasted without Enter; type the task and submit it. Plain shells stay copy only.
  These controls do not execute workflows.
- Record a workflow and run `mw_run` from the terminal. There is no
  **`Automate from a demo`** menu action.
  Full step-by-step instructions: [AI_OPERATOR_GUIDE.md](AI_OPERATOR_GUIDE.md).

In **Identities**, **Stored data** manages saved slots (including signed-in sessions,
not open tabs); stop the capsule and close login before using them. **Release**
clears a verified previous-session hold without stopping a live session or deleting
saved browser data. Settings has a **Recording** card for frame rate, storage mode
and destination folders; review its next-start and host-override notices.
See [USER_GUIDE.md](USER_GUIDE.md#stored-data-slots).

## 5. Stop

Answers: stop the app, cleanup, JUDGE_STOP_CLEAN

```bash
bash scripts/judge/metaviewer-judge.sh stop
```

Stops the MetaViewer process and scoped capsules and checks stale RAM admission
reservations. The shared `srf-egress-proxy` remains running; `JUDGE_STOP_CLEAN`
excludes that proxy. Other capsule, socket or RAM leftovers are reported.

## Windows (WSL2)

Answers: windows, WSL2 setup, wsl.conf, .wslconfig

1. From Windows: `wsl --install -d Ubuntu-24.04`.
2. In Ubuntu, add `[boot]` and `systemd=true` to `/etc/wsl.conf`, then run `wsl --shutdown`
   from Windows and reopen Ubuntu.
3. Install Docker Engine (`docker-ce`) inside Ubuntu and add yourself to the `docker` group.
   Do not use Docker Desktop.
4. In `%UserProfile%\.wslconfig` give WSL at least 12 GB memory and 4 processors
   [TARGET; not a measured minimum].
5. Follow steps 1–5 above.

Windows needs WSLg for the display. Without systemd the runtime directory is missing and
the launcher refuses to start. Windows itself is not a supported host
([INSTALL.md](INSTALL.md#1-platform-and-requirements)).

## Hardware

Answers: hardware, minimum RAM, CPU, shared memory, disk

Full table and sources: [INSTALL.md](INSTALL.md#hardware). Designed for a standard
8-core, 16 GiB RAM x64 Linux laptop (release assets are x64 only):

- **App only (T1)**: 2+ cores, `floor + 512 MiB` available RAM (`floor = min(MemTotal/4, 20 GiB)`), `512 MiB` `/dev/shm` `tmpfs`, `2 GB` free disk [TARGET].
- **Live capsules (T2)**: 8 logical CPUs recommended (no CPU pinning required; `MV_JUDGE_REQUIRE_CPUSET` defaults to `none`), 16 GiB RAM (`MemAvailable >= floor + 512 MiB` install/doctor minimum, i.e. `4.5 GiB` on a 16 GiB machine [TARGET]; each **Add capsule** also needs at least `6` GiB MemAvailable or refuses with `RAM_ADMISSION_REFUSED` [CITED: `ui/electron/profilePicker.js`]; warns below `floor + 4 GiB`, i.e. `8 GiB` [TARGET]), `>= 1 GiB` `/dev/shm` `tmpfs` (`>= 2.5 GiB` recommended [TARGET]), `>= 15 GB` free disk (`>= 30 GB` recommended [TARGET]), rootful Docker Engine.
- VM capsules are not part of judging.

## Troubleshooting

Answers: compiled kit, wender-runtime, vision-runtime, Host program tools, PKG codes

The app includes public Python agents, tools, dependency locks and contracts in
`resources/operator` [CITED: `ui/tools/package.js`]. Python remains a host prerequisite.
`MV_OPERATOR_REPO` optionally selects a developer checkout; an installed runtime
uses sealed public files and keeps MemoryWeb data outside the app directory.

For the source-free Linux x64 kit, the judge launcher sets
`MV_WENDER_EXECUTABLE` to `deps/wender-agent/wender-runtime` and
`MV_VISION_EXECUTABLE` to `deps/vision-engine/vision-runtime` under its install
directory. These paths are also exported in the app attachment environment.
The public compiled lock pins every binary, shared library and schema and binds
the distribution to the source commit in `deps.lock`. Missing files, modified
hashes and unpinned additions refuse before execution. Checkout mode retains
the existing `MV_WENDER_ROOT` / `VQA_VE_ROOT` provenance verification.

The pinned Linux x64 compiled export supports program planning, perception and
browser goals with rules or Muse. Stored browser workflows still need private
APIs from a verified checkout and refuse `MW_COMPILED_WORKFLOW_UNAVAILABLE`
in compiled mode. Live results are limited to the architecture table in
[Judge tour](JUDGE_TOUR.md#architecture-support-at-this-snapshot).
The reported release-package x64 WSL2 checks [CITED: maintainer evaluation; raw receipt absent]
reported browser rules goals 10 of 10 [CITED: maintainer evaluation; raw receipt absent], Agent `gnome-calculator` in
both Host program and isolated Program, Desktop window `gedit` attach, type,
resize and closed message, login wall `HUMAN_HANDOFF`, and clean stop.
Calculator text `2+3` was sent with rc 0 [CITED: maintainer evaluation; raw receipt absent] and verdict
`PROGRAM_TEXT_UNCERTIFIED_NOT_READABLE`: exact readback and arithmetic are
uncertified. Human Program `gedit` closed its window with `XPRA_MODE_REFUSED`.
A closed Desktop window tile can retain a reused X11 id; if **Add** refuses,
press **Stop** on that tile. Muse on x64 and real mouse drag under a window
manager remain unverified. See the [tour](JUDGE_TOUR.md) for the arm64 column.

Arm64 compiled private assets are absent.
The version labels in `deps.lock` are retained even where release tags disagree.

Host program is optional and requires `xpra`, `Xvfb`, `xauth`, and `xdotool`.
Install the missing tools with `sudo apt-get install -y xpra xvfb xauth xdotool`,
then retry. Browser capsules and programs inside containers remain available.
The kit never installs these optional host packages automatically.

| Code | Meaning and fix |
| --- | --- |
| `PKG_ARCH_MISMATCH` | Use assets built for the host architecture; if no matching set is published, follow Path E or stop. Renaming an archive does not convert it. |
| `RAM_ADMISSION_REFUSED` | Free memory, or run `python3 tools/mv_ram_admission.py reclaim --dry-run` to review stale reservations |
| `NET_OPEN_PREREQ` | Restore the compatible Open image, runtime and firewall prerequisites before retrying. Legacy can open a local capsule but grants no public destinations. |
| `TERMINAL_UNAVAILABLE` | The paired terminal dock and drawer cannot open a session in this build; the rest of the wall is unaffected |

Codes are [CITED: `ui/tools/package.js`, `daemon-adapter/internal/daemon/ram_admission.go`,
`daemon-adapter/internal/capsule/egress_policy.go`, `ui/electron/terminalHost.js`].

### Legacy kit proxy setup

Answers: proxy, policy.json, egress proxy, net up

The sudo-free fallback calls the kit's `srf-identity-surface net up` with
`--proxy-bin` pointing to the kit's `srf-egress-proxy`. The launcher selects the
proxy entrypoint, internal network and bridge attachment. It refuses if
`srf-identity-surface net up` fails; it does not replace an existing incompatible proxy.
Private metadata lives under `$MV_JUDGE_HOME/network`: separate `policy/`,
`registry/` and `audit/` directories (mode `0700`), with policy and registry files
at `0600`. The x64 source runs the proxy with the CLI caller's UID/GID, so these
files stay owned by the judge user. Profile directories still use Docker to
provision the browser UID separately. Run passes this same registry to capsules.

The initial `policy/policy.json` uses `browserid.proxy-policy/v1` with empty
`approved`, `denied` and `connect_ports` collections. It grants no destinations.
Existing policy files are retained. This upstream schema supports exact capsule
IDs and normalized hosts only: public browsing requires explicit `approved`
entries and HTTPS `connect_ports` entries for each capsule and host. Leave
`private_targets` absent to retain LAN/host blocking. Arbitrary public browsing
is not available through this policy schema; no wildcard policy is implied.

A legacy x64 kit with browser image `0.1.1` does not inherit the measured Open result. If a binary advertises Open and the
firewall witness is present, preflight requires `0.2.0` and refuses that image set.
The installer detects this before offering a new firewall. Retagging `0.1.1` would not establish Open support; the upstream source disables
Open for its default image. Use a legacy-only kit without an active Open witness, or obtain a compatible Open kit.

## ARM64 developer setup

Answers: arm64 VM, MicroVM, rewind, KVM

ARM64 VM, MicroVM and rewind require developer setup on arm64 with KVM and verified local assets; they are not a judge installation route. x64 VM and MicroVM are not in this release. Windows 10 WSL has no nested KVM. See [local ARM64 setup](ARM64_CAPSULE_SETUP.md) and the [VM roadmap](../VM_MICROVM_ROADMAP.md) for prerequisites and evidence limits.

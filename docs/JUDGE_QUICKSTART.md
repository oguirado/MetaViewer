# MetaViewer — Judge Quickstart

For refusal codes and source-backed next steps, see [Judge troubleshooting](JUDGE_TROUBLESHOOTING.md).

After installation, follow the [Judge tour](JUDGE_TOUR.md) with your AI.

This page takes a hackathon judge from a clean Linux machine (such as an 8-core,
16 GiB RAM x64 laptop) to a running MetaViewer wall with live browser and program
capsules.

- **Point your own AI at [AI_OPERATOR_GUIDE.md](AI_OPERATOR_GUIDE.md)**: a single,
  self-contained guide that lets your AI install, configure, verify, and explain
  every feature of MetaViewer (views, desktops, tile presets, browser/program/X11
  capsules, human/agent hand-off, terminals, `Bootstrap`, identities, `Use MetaViewer`,
  and MemoryWeb / `mw_run` automation).
- Full build and environment reference: [INSTALL.md](INSTALL.md).
- Operator walkthrough: [USER_GUIDE.md](USER_GUIDE.md).

Supported architecture: Linux `x86_64` (`x64`) or `aarch64` (`arm64`). The verified
host is Ubuntu 24.04 LTS. Debian 12/13 is a candidate platform and emits an
unverified-host warning. Windows 11 uses WSL2 + WSLg with rootful Docker Engine
inside the Ubuntu distro (Docker Desktop is not supported). macOS is not supported.
No GPU or CPU pinning is required. Minimums: see [Hardware](#hardware).

## 0. Licence

MetaViewer source may be used, modified and redistributed under AGPL-3.0-only
([LICENSE](../LICENSE)). The separate proprietary programs `wender-agent`,
`vision-engine` and `OpenSuperficies` are fully private; `capsule-ui-kit` is a separate public repository under `AGPL-3.0-only`. The licensor permits hackathon judges to install, run and evaluate the
supplied compiled external components for judging, as stated in
[NOTICE-EVALUATION.md](../NOTICE-EVALUATION.md). Do not redistribute the compiled
external components in the kit; this restriction does not prevent redistribution
of MetaViewer source under the AGPL.

## 1. Release assets and verification

The judge kit uses the release assets in `assets/` (verified against
`assets/SHA256SUMS` before anything is unpacked):

| Asset | Tier | Purpose |
| --- | --- | --- |
| `SHA256SUMS` | T1 & T2 | Authoritative SHA-256 digests for every release asset |
| `metaviewer-linux-<x64\|arm64>.tar.gz` | T1 & T2 | Packaged `MetaViewer-linux-<arch>/` bundle and `MetaViewer-linux-<arch>.sha256` [CITED: `docs/INSTALL.md`] |
| `node-linux-<x64\|arm64>.tar.xz` | T1 & T2 | Node.js `>= 24` runtime (`*/bin/node` plus npm when included), extracted only when host `node` is missing or `< 24` |
| `opensuperficies-linux-<x64\|arm64>.tar.gz` | T2 | `opensuperficies/bin/srf*` binaries and `opensuperficies/firewall/` |
| `images-linux-<x64\|arm64>.tar` | T2 | `docker save` archive containing `opensuperficies-identity-browser-<arch>:0.1.1`, `opensuperficies-program-host-<arch>:0.1.0`, and `opensuperficies-desktop-<arch>:1.1.0` |
| `vision-engine.tar.gz` | T2 | `vision-engine/` at the commit pinned in `deps.lock` |
| `wender-agent.tar.gz` | T2 | `wender-agent/` at the commit pinned in `deps.lock` |

From a fresh clone, fetch the assets in one command (Python is required):

Obtain the judge kit from the public repository at the tag of the same release
as the assets: set `RELEASE_TAG` to that published tag, run
`git clone --branch "$RELEASE_TAG" --depth 1 https://github.com/oguirado/MetaViewer.git`,
then `cd MetaViewer` and fetch below.

```bash
# Complete directory supplied by the release maintainer; add --capsules for T2.
python3 scripts/judge/fetch_assets.py --source "$RELEASE_ASSET_DIRECTORY" --capsules
# Or an explicit HTTPS release asset base URL with an independently obtained digest:
python3 scripts/judge/fetch_assets.py --source "$RELEASE_ASSET_URL" --capsules --sums-sha256 "$SHA256SUMS_DIGEST"
```

Set these variables to the actual directory or published release URL and manifest digest
supplied by the maintainer. A publicly accessible complete release has not been established
by the supplied evaluation evidence; the command refuses incomplete or corrupt sets. Do not assume
that a GitHub Actions artifact is a published release. CI currently exports app and Node
assets with `SHA256SUMS` for T1 only; T2 also needs the private component and image assets
built by the maintainer. Checksums protect integrity, not publisher authenticity.
The explicit fetch command authorizes the transfer; install still asks before downloading
missing assets. No install begins until the fetch command has verified the selected set.

Fetch maps the architecture printed by `uname -m` (`aarch64` to `arm64`,
`x86_64` to `x64`) and writes verified files into `assets/`. A kit for the wrong architecture is
refused (`JUDGE_BUNDLE_ARCH` / `PKG_ARCH_MISMATCH`). Maintainers building the release
assets from local artifacts run `python3 tools/build_release_assets.py --out-dir ./assets ...`
(see [AI_OPERATOR_GUIDE.md](AI_OPERATOR_GUIDE.md#3-release-assets-and-building-them-locally)).

You can also verify the unpacked application bundle manifest by hand:

```text
cd MetaViewer-linux-<arch>
sha256sum -c ../MetaViewer-linux-<arch>.sha256
```

Start in the directory containing the extracted tree; replace `<arch>` with `x64`
or `arm64`. The checksum command runs inside the bundle, as described in
[INSTALL.md](INSTALL.md#extract-and-verify-the-sha-256-manifest).

## 2. Check your machine (no changes made)

```bash
bash scripts/judge/preflight.sh --tier T2 --phase static
```

This host-only check is also available as
`bash scripts/judge/metaviewer-judge.sh doctor --capsules --before-install`.

Every refusal is printed as `JUDGE_<CODE>: <problem> -- fix: <command>` and exits
with code `2`. Non-fatal resource advisories on smaller laptops are printed as
`JUDGE_NOTE: warning (JUDGE_<CODE>): ...` without blocking execution. Fix any
host refusals and re-run. `--before-install` checks host requirements only and does
not require installed images, profiles or proxy state. Missing tools are installed by
`install`; Docker access, host resources and session ownership still need attention.
After installation run `bash scripts/judge/metaviewer-judge.sh doctor --capsules`
(or omit `--capsules` for T1). Full doctor checks the installed runtime and should then
print `JUDGE_DOCTOR_OK tier=<T1|T2>`. T0 uses the separate fixture below.

| Tier | What you get |
| --- | --- |
| T0 | Offline conversation fixture only; no display, no Docker ([JUDGES.md](JUDGES.md)) |
| T1 | The packaged app: wall, core and adapter. Creating a capsule fails with a clear, correlated error: expected |
| T2 | T1 plus up to 4 concurrent live browser and Linux program capsules (Docker, images, network, sudo-free profiles) |

## 3. Install (asks before every sudo step)

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

A clean Ubuntu/Debian host needs the system packages checked by `scripts/judge/preflight.sh` (`tar` plus):

```text
sudo apt-get install -y xvfb x11-utils xauth zip unzip strace git coreutils python3 python3-pip
```

Tier T2 (`--capsules`) additionally requires `docker.io` (or `docker-ce`, rootful Docker Engine) [CITED: `scripts/judge/preflight.sh`]. Building the Linux package from source (`scripts/bootstrap.sh` / `ui/tools/package.js`) additionally requires Node 24 (`>=24` [CITED: `ui/package.json`]), Go (`1.26.0` [CITED: `daemon-adapter/go.mod`]) and Rust (`1.97.0` compiler and Clippy, `1.92.0` formatter [CITED: `Cargo.toml`, `.github/workflows/ci.yml`]) per the CI pins in [INSTALL.md](INSTALL.md#required-toolchains-and-pins).

### Docker (tier T2 only)

Docker must be rootful Docker Engine, reachable by your user through the `docker` group.
Rootless Docker and Docker Desktop are not supported: the adapter talks to the local
rootful socket and refuses `DOCKER_HOST` / `DOCKER_CONTEXT`.

```text
sudo usermod -aG docker "$USER"
```

Log out and back in, then re-run `doctor --capsules --before-install`. On WSL, close the distro, run `wsl --shutdown` from Windows and reopen it.

### Capsule network (tier T2 only)

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

### Headless installation

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

```bash
bash scripts/judge/metaviewer-judge.sh run
```

The wall opens with a 4-capsule profile pool (`judge` on `:100`, `mv-live-2` on
`:101`, `mv-live-3` on `:102`, `mv-live-4` on `:103`):

- Switch between **`Humans`** and **`Agents`** views (`Ctrl+Tab`), create virtual
  desktops (`+`, `Ctrl+1..9`), and test tile layouts (`1 tile`, `2 side by side`,
  `2×2`, `Focus + strip`, `Floating layout`).
- Click **`＋ Add capsule`** to launch an **`Identity browser`**, a Linux **`Program`**
  (inside `opensuperficies-program-host-<arch>:0.1.0`), **`Host program`**, or an X11
  **`Desktop window`**. Host program and Desktop window run on your computer and
  are not isolated. Replace `<arch>` with `x64` or `arm64` for the installed image.
- Log into a site in human mode and click **`Mark as logged in`** to save its login
  status. Then choose **`Switch to agent mode`** separately to hand the capsule to
  the agent; watch live read-only, or click **`Take control (emergency)`**.
- Click **`ID`** (**`Copy ID for AI`**), open **`More ▾ -> Terminal`**, click
  **`🚀 Bootstrap`**, or click the top-bar **`Use MetaViewer`** button to connect an AI CLI.
- Record a workflow and run `mw_run` from the terminal. There is no
  **`Automate from a demo`** menu action.
  Full step-by-step instructions: [AI_OPERATOR_GUIDE.md](AI_OPERATOR_GUIDE.md).

## 5. Stop

```bash
bash scripts/judge/metaviewer-judge.sh stop
```

Stops the MetaViewer process and scoped capsules and checks stale RAM admission
reservations. The shared `srf-egress-proxy` remains running; `JUDGE_STOP_CLEAN`
excludes that proxy. Other capsule, socket or RAM leftovers are reported.

## Windows (WSL2)

1. From Windows: `wsl --install -d Ubuntu-24.04`.
2. In Ubuntu, add `[boot]` and `systemd=true` to `/etc/wsl.conf`, then run `wsl --shutdown`
   from Windows and reopen Ubuntu.
3. Install Docker Engine (`docker-ce`) inside Ubuntu and add yourself to the `docker` group.
   Do not use Docker Desktop.
4. In `%UserProfile%\.wslconfig` give WSL at least 12 GB memory and 4 processors
   [TARGET; no WSL2 host has been measured].
5. Follow steps 1–5 above.

Windows needs WSLg for the display. Without systemd the runtime directory is missing and
the launcher refuses to start. Windows itself is not a supported host
([INSTALL.md](INSTALL.md#1-platform-and-requirements)).

## Hardware

Full table and sources: [INSTALL.md](INSTALL.md#hardware). Designed for a standard
8-core, 16 GiB RAM x64 or arm64 Linux laptop:

- **App only (T1)**: 2+ cores, `floor + 512 MiB` available RAM (`floor = min(MemTotal/4, 20 GiB)`), `512 MiB` `/dev/shm` `tmpfs`, `2 GB` free disk [TARGET].
- **Live capsules (T2)**: 8 logical CPUs recommended (no CPU pinning required; `MV_JUDGE_REQUIRE_CPUSET` defaults to `none`), 16 GiB RAM (`MemAvailable >= floor + 512 MiB` hard minimum, i.e. `4.5 GiB` on a 16 GiB machine [MEASURED]; warns below `floor + 4 GiB`, i.e. `8 GiB` [TARGET]), `>= 1 GiB` `/dev/shm` `tmpfs` (`>= 2.5 GiB` recommended [TARGET]), `>= 15 GB` free disk (`>= 30 GB` recommended [TARGET]), rootful Docker Engine.
- VM capsules are not part of judging.

## Troubleshooting

The app includes public Python agents, tools, dependency locks and contracts in
`resources/operator` [TARGET, unit decision]. Python remains a host prerequisite.
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
Arm64 compiled private assets are absent.
The version labels in `deps.lock` are retained even where release tags disagree.

Host program is optional and requires `xpra`, `Xvfb`, `xauth`, and `xdotool`.
Install the missing tools with `sudo apt-get install -y xpra xvfb xauth xdotool`,
then retry. Browser capsules and programs inside containers remain available.
The kit never installs these optional host packages automatically.

| Code | Meaning and fix |
| --- | --- |
| `PKG_ARCH_MISMATCH` | Kit for the wrong architecture; download the other one |
| `RAM_ADMISSION_REFUSED` | Free memory, or run `python3 tools/mv_ram_admission.py reclaim --dry-run` to review stale reservations |
| `NET_OPEN_PREREQ` | Open network prerequisites are missing; the firewall step was declined or the build is not Open-ready; use legacy |
| `TERMINAL_UNAVAILABLE` | The side terminal is not packaged in this build; the rest of the wall is unaffected |

Codes are [CITED: `ui/tools/package.js`, `daemon-adapter/internal/daemon/ram_admission.go`,
`daemon-adapter/internal/capsule/egress_policy.go`, `ui/electron/terminalHost.js`].

### Legacy kit proxy setup

The sudo-free fallback calls the kit's `srf-identity-surface net up` with
`--proxy-bin` pointing to the kit's `srf-egress-proxy`. The launcher selects the
proxy entrypoint, internal network and bridge attachment and verifies
`EGRESS_PROXY_READY`; it refuses an existing incompatible proxy without replacing it.
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

The x64 kit supplies browser image `0.1.1`. If a binary advertises Open and the
firewall witness is present, preflight requires `0.2.0` and refuses that image set.
The installer detects this before offering a new firewall. Retagging `0.1.1` would not establish Open support; the upstream source disables
Open for its default image. Use a legacy-only kit without an active Open witness, or obtain a compatible Open kit.

## ARM64 VM preview

The ARM64 Linux VM capsule is a preview for ARM64 hosts with KVM and a configured template. It is not offered on x64; judges on x64 lose nothing from the supported judging flow. See [VM roadmap](../VM_MICROVM_ROADMAP.md) for the current scope and evidence limits.

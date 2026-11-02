# MetaViewer — Judge Quickstart

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

Supported: Linux `x86_64` (`x64`) or `aarch64` (`arm64`) — Ubuntu 24.04 LTS or
Debian 12/13 recommended; Windows 11 through WSL2 + WSLg with rootful Docker Engine
inside the Ubuntu distro (Docker Desktop is not supported). macOS is not supported.
No GPU or CPU pinning is required. Minimums: see [Hardware](#hardware).

## 0. Licence

MetaViewer is licensed under the PolyForm Strict License 1.0.0 ([LICENSE](../LICENSE)),
which does not permit distribution or modification. The licensor permits hackathon
judges to install and evaluate MetaViewer for judging, as stated in
[NOTICE-EVALUATION.md](../NOTICE-EVALUATION.md). Do not redistribute the kit.

## 1. Release assets and verification

The judge kit uses the release assets in `assets/` (verified against
`assets/SHA256SUMS` before anything is unpacked):

| Asset | Tier | Purpose |
| --- | --- | --- |
| `SHA256SUMS` | T1 & T2 | Authoritative SHA-256 digests for every release asset |
| `metaviewer-linux-<x64\|arm64>.tar.gz` | T1 & T2 | Packaged `MetaViewer-linux-<arch>/` bundle and `MetaViewer-linux-<arch>.sha256` [CITED: `docs/INSTALL.md`] |
| `node-linux-<x64\|arm64>.tar.xz` | T1 & T2 | Node.js `>= 24` runtime (`*/bin/node`), extracted only when host `node` is missing or `< 24` |
| `opensuperficies-linux-<x64\|arm64>.tar.gz` | T2 | `opensuperficies/bin/srf*` binaries and `opensuperficies/firewall/` |
| `images-linux-<x64\|arm64>.tar` | T2 | `docker save` archive containing `opensuperficies-identity-browser-<arch>:0.1.1`, `opensuperficies-program-host-<arch>:0.1.0`, and `opensuperficies-desktop-<arch>:1.1.0` |
| `vision-engine.tar.gz` | T2 | `vision-engine/` at the commit pinned in `deps.lock` |
| `wender-agent.tar.gz` | T2 | `wender-agent/` at the commit pinned in `deps.lock` |

Download or place the assets for the architecture printed by `uname -m` (`aarch64` is
`arm64`, `x86_64` is `x64`) into `assets/`. A kit for the wrong architecture is
refused (`JUDGE_BUNDLE_ARCH` / `PKG_ARCH_MISMATCH`). Maintainers building the release
assets from local artifacts run `python3 tools/build_release_assets.py --out-dir ./assets ...`
(see [AI_OPERATOR_GUIDE.md](AI_OPERATOR_GUIDE.md#3-release-assets-and-building-them-locally)).

You can also verify the unpacked application bundle manifest by hand:

```text
sha256sum -c MetaViewer-linux-<arch>.sha256
```

(run from the directory that contains the extracted `MetaViewer-linux-<arch>/` tree, as
described in [INSTALL.md](INSTALL.md#extract-and-verify-the-sha-256-manifest)).

## 2. Check your machine (no changes made)

```bash
bash scripts/judge/metaviewer-judge.sh doctor
bash scripts/judge/metaviewer-judge.sh doctor --capsules
```

Every refusal is printed as `JUDGE_<CODE>: <problem> -- fix: <command>` and exits
with code `2`. Non-fatal resource advisories on smaller laptops are printed as
`JUDGE_NOTE: warning (JUDGE_<CODE>): ...` without blocking execution. Fix any
refusals and re-run until `doctor` prints `JUDGE_DOCTOR_OK tier=<T1|T2>`.

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

1. Runs static preflight checks.
2. Installs any missing Ubuntu/Debian system packages after your confirmation.
3. Extracts `metaviewer-linux-<arch>.tar.gz` with `tar --no-same-owner`, loads the
   AppArmor userns profile only if Ubuntu restricts unprivileged user namespaces, and
   runs `--verify-install` and `--smoke` (ending with `METAVIEWER_MAIN_SMOKE_OK`).
4. With `--capsules` (Tier 2): extracts `opensuperficies`, `vision-engine`, and
   `wender-agent`; optionally installs the open-mode egress firewall (or falls back
   to the `sudo`-free legacy Docker network `srf-idnet` if declined or passed
   `--no-firewall`); loads `images-linux-<arch>.tar` into Docker; and provisions the
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

Log out and back in, then re-run `doctor --capsules`.

### Capsule network (tier T2 only)

The default capsule network mode is **Open**: public internet only, with no LAN access
and no host services. Open needs one host firewall step (`srf-open-egress.service`)
that requires root. `install --capsules` shows the exact firewall script and runs it
with `sudo` only after you confirm once. If you decline, pass `--no-firewall`, or run
with the `0.1.1` offline browser image, `install --capsules` automatically falls back
to the **legacy** Docker bridge network (`srf-idnet`) with zero `sudo` steps. Details:
[INSTALL.md](INSTALL.md#capsule-network).

## 4. Run

```bash
bash scripts/judge/metaviewer-judge.sh run
```

The wall opens with a 4-capsule profile pool (`judge` on `:100`, `mv-live-2` on
`:101`, `mv-live-3` on `:102`, `mv-live-4` on `:103`):

- Switch between **`Humans`** and **`Agents`** views (`Ctrl+Tab`), create virtual
  desktops (`+`, `Ctrl+1..9`), and test tile layouts (`Single`, `Side by side`,
  `Grid`, `Focus + strip`, `Floating`).
- Click **`＋ Add capsule`** to launch an **`Identity browser`**, a Linux **`Program`**
  (inside `opensuperficies-program-host:0.1.0`), or capture an X11 **`Desktop window`**.
- Log into a site in human mode, click **`Mark as logged in`** to hand the capsule to
  agent mode, watch live read-only, or click **`Take control (emergency)`**.
- Click **`ID`** (**`Copy ID for AI`**), open **`More ▾ -> Terminal`**, click
  **`🚀 Bootstrap`**, or open **`More ▾ -> Use MetaViewer`** to connect an AI CLI.
- Record a workflow and run **`More ▾ -> Automate from a demo`** (or `mw_run`).
  Full step-by-step instructions: [AI_OPERATOR_GUIDE.md](AI_OPERATOR_GUIDE.md).

## 5. Stop

```bash
bash scripts/judge/metaviewer-judge.sh stop
```

Stops the MetaViewer process and any running `srf-*` capsules, reclaims stale RAM
admission reservations, and prints `JUDGE_STOP_CLEAN` only if no `srf-*` container,
socket, or RAM directory is left behind.

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

| Code | Meaning and fix |
| --- | --- |
| `PKG_ARCH_MISMATCH` | Kit for the wrong architecture; download the other one |
| `RAM_ADMISSION_REFUSED` | Free memory, or run `python3 tools/mv_ram_admission.py reclaim --dry-run` to review stale reservations |
| `NET_OPEN_PREREQ` | Open network prerequisites are missing; the firewall step was declined or the build is not Open-ready; use legacy |
| `TERMINAL_UNAVAILABLE` | The side terminal is not packaged in this build; the rest of the wall is unaffected |

Codes are [CITED: `ui/tools/package.js`, `daemon-adapter/internal/daemon/ram_admission.go`,
`daemon-adapter/internal/capsule/egress_policy.go`, `ui/electron/terminalHost.js`].

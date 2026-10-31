# MetaViewer — Judge Quickstart

This page takes a hackathon judge from a clean machine to a running MetaViewer wall.
It describes the judge path; the full reference is [INSTALL.md](INSTALL.md) and the
operator guide is [USER_GUIDE.md](USER_GUIDE.md).

Supported: Linux x86_64 or aarch64 (Ubuntu 24.04 recommended); Windows 11 through WSL2 +
WSLg with Docker Engine inside the Ubuntu distro (Docker Desktop is not supported).
macOS is not supported. No GPU is required. Minimums: see [Hardware](#hardware).

Status of this page: the judge script `scripts/judge/metaviewer-judge.sh` and the
release assets it consumes are being finished by separate units. Command names below
(`doctor`, `install`, `run`, `stop`) are the documented interface. The flags `--capsules`
and `--yes`, the `JUDGE_*` codes and the `JUDGE_DOCTOR_OK` / `JUDGE_STOP_CLEAN` markers
are [TARGET, unit decision]. Exact release asset file names: ABSENT — do not invent.

## 0. Licence

MetaViewer is licensed under the PolyForm Strict License 1.0.0 ([LICENSE](../LICENSE)),
which does not permit distribution or modification. The licensor permits hackathon
judges to install and evaluate MetaViewer for judging, as stated in
[NOTICE-EVALUATION.md](../NOTICE-EVALUATION.md). Do not redistribute the kit.

## 1. Get the kit and verify it

The kit consists of release assets, one set per architecture [TARGET, decision D3]:

- the MetaViewer tarball for your architecture, `MetaViewer-linux-arm64.tar` or
  `MetaViewer-linux-x64.tar`, with its `.sha256` manifest [CITED: `docs/INSTALL.md`];
- the pinned-dependency tarballs for the external components listed in `deps.lock`, each
  with a published `sha256`;
- the judge scripts.

Download the assets for the architecture printed by `uname -m` (`aarch64` is `arm64`,
`x86_64` is `x64`). A kit for the wrong architecture is refused (`PKG_ARCH_MISMATCH`).
The install step runs `sha256sum -c` on every tarball and refuses a mismatch before
anything is extracted. You can also check by hand:

```text
sha256sum -c MetaViewer-linux-<arch>.sha256
```

(run from the directory that contains the extracted `MetaViewer-linux-<arch>/` tree, as
described in [INSTALL.md](INSTALL.md#extract-and-verify-the-sha-256-manifest)).

## 2. Check your machine (no changes made)

```text
bash scripts/judge/metaviewer-judge.sh doctor
```

Every problem is printed as `JUDGE_<CODE>: <problem> — fix: <command>` and the command
exits with code 2. Fix the problem and re-run until it prints
`JUDGE_DOCTOR_OK tier=<T0|T1|T2>` [TARGET, unit decision].

| Tier | What you get |
| --- | --- |
| T0 | Offline conversation fixture only; no display, no Docker ([JUDGES.md](JUDGES.md)) |
| T1 | The packaged app: wall, core and adapter. Creating a capsule fails with a clear, correlated error: expected |
| T2 | T1 plus live browser capsules (Docker, images, network, profile) |

## 3. Install (asks before every sudo step)

```text
bash scripts/judge/metaviewer-judge.sh install              # app only (tier T1)
bash scripts/judge/metaviewer-judge.sh install --capsules   # adds capsule images, network, profile (tier T2)
```

`install` stops at the first refusal and never runs `sudo` without asking. It does, in
order [TARGET, unit decision]: preflight; install the Ubuntu packages listed in
[INSTALL.md](INSTALL.md#ubuntu-packages) after your confirmation (`--yes` answers for you
in non-interactive runs); extract the tarball with `tar --no-same-owner`; verify digests;
run the package checks `--verify-install` and `--smoke`. Success ends with
`METAVIEWER_MAIN_SMOKE_OK` [CITED: `docs/INSTALL.md`] and writes `judge_receipt.json`
(architecture, core count, memory, versions, digests; never identity-store contents).

### Docker (tier T2 only)

Docker must be rootful Docker Engine, reachable by your user through the `docker` group
(decision D2). Rootless Docker is not supported: the adapter does not forward
`DOCKER_HOST`, so a rootless daemon is invisible to it. Leave `DOCKER_HOST` unset.

```text
sudo usermod -aG docker "$USER"
```

Log out and back in, then re-run `doctor`.

### Capsule network (tier T2 only)

The default capsule network mode is **Open**: public internet only, with no LAN access
and no host services. Open needs one host firewall step that requires root. `install
--capsules` shows the exact firewall change and runs it with `sudo` only after you
confirm once (decision D5). If you decline, or if Open is not yet available on this
build (it also needs the operator-built identity image `0.2.0` and the final Open-ready
native pin [CITED: `docs/INSTALL.md`]), the capsule falls back to **legacy** mode and
`NET_OPEN_PREREQ` names what is missing; it never downgrades silently. Details:
[INSTALL.md](INSTALL.md#capsule-network).

## 4. Run

```text
bash scripts/judge/metaviewer-judge.sh run
```

The wall opens. Without capsules, "create surface" fails with a clear, correlated
error: that is expected. With capsules, create a browser capsule and log in by hand
inside the capsule view (agents never type credentials). Then try:

- hide and show a tile while the agent works;
- copy the capsule id for an external agent (**Use MetaViewer**);
- record a demo and use **Automate from a demo** ([USER_GUIDE.md](USER_GUIDE.md#accounts-and-automation));
- record for yourself (frame rate `1..60` fps [CITED: `README.md`]).

A CAPTCHA or bot check stops execution; solve it yourself, then re-run the workflow.

## 5. Stop

```text
bash scripts/judge/metaviewer-judge.sh stop
```

Prints `JUDGE_STOP_CLEAN` only if no `srf-*` container, socket or RAM directory is left
[TARGET, unit decision].

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

Full table and sources: [INSTALL.md](INSTALL.md#hardware). In short, no profile has been
measured on a small machine:

- App only (T1): 2 cores, 4 GiB RAM [TARGET].
- One live capsule (T2), today: at least 15 logical CPUs, because the native runtime pins
  capsules to CPUs `10-14` [CITED: operator strategy note]; 16 GiB RAM recommended
  [TARGET], 30 GB free disk [TARGET], Docker.
- One live capsule (T2), after the CPU pinning is relaxed: 4 cores, 16 GiB RAM
  (8 GiB minimum) [TARGET].
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

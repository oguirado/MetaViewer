# Judge install audit (x86_64, report only)

Scope: `scripts/judge/` (launcher, preflight, `fetch_assets.py`, `unpack_node.py`),
`docs/JUDGE_QUICKSTART.md`, `docs/JUDGE_NO_DOCKER.md`, `docs/JUDGE_TROUBLESHOOTING.md`,
`tools/build_release_assets.py`. Base: `ci/assets-07a62f32c` (commit `07a62f3`).
These are candidate findings for independent verification. No product code changed.

## Test bed

- Ubuntu 24.04.5, x86_64, 4 vCPU [MEASURED], 16 GiB RAM [MEASURED], `/dev/shm` tmpfs
  16 GiB [MEASURED]. Docker client present, no daemon. No AppArmor userns sysctl.
- A new normal user `judge` (no sudo rights), `/run/user/<uid>` created by root to stand
  in for logind, `Xvfb :99` standing in for a desktop DISPLAY. Host `node` was v22
  [MEASURED], so install used the kit Node.
- Assets: public v0.2.5 release, `SHA256SUMS` digest taken from the release notes.
  `scripts/judge/` and `tools/build_release_assets.py` are byte-identical between the
  v0.2.5 tag commit and this branch (`git diff --stat` empty) [MEASURED]. The judge docs
  changed (166 insertions, 34 deletions) [MEASURED].
- Paths below use `~` for the judge home and `<checkout>` for the clone.

## Timings (T1, this host)

| Step | Result |
| --- | --- |
| `fetch_assets.py` T1 | `JUDGE_FETCH_OK`, 7.6 s [MEASURED] |
| `fetch_assets.py --capsules` | `JUDGE_FETCH_OK tier=T2`, 36.4 s [MEASURED] |
| `install` (first, includes `npm ci`) | `JUDGE_INSTALL_OK`, 43.4 s [MEASURED] |
| `install` again over an existing install | `JUDGE_INSTALL_OK`, 36.3 s [MEASURED] |
| `run` until the window is mapped | about 1 s [MEASURED], then `METAVIEWER_MAIN_READY` |
| `stop` | `JUDGE_STOP_CLEAN`, 0.33 s [MEASURED], no processes left [MEASURED] |

Download time depends on this cloud link. A home link will be slower. The total is about
1.5 min [MEASURED] from fetch to first window when nothing fails.

## Findings, ranked by how likely a judge hits them in the first 10 minutes

### 1. Judges without Docker who follow the release notes are refused with no route to T1

- Command (the v0.2.5 release notes' install block):
  `python3 scripts/judge/fetch_assets.py --source …/v0.2.5 --capsules --sums-sha256 0a46…0f08`
  then `bash scripts/judge/metaviewer-judge.sh install --capsules`
  (the refusal is the same with `doctor --capsules --before-install`).
- Output: `JUDGE_DOCKER: 'docker info' failed or timed out for this user; … -- fix: check systemctl status docker; if the rootful service is stopped, sudo systemctl start docker; …`
  The T2 fetch downloaded 6 assets plus `SHA256SUMS`, about 797 MB [CITED: release
  asset sizes], before this refusal.
- Expected: a pointer to the app-only route, which does not need Docker.
- Severity: medium. The judge is blocked until they find `docs/JUDGE_NO_DOCKER.md`.
- Smallest fix: append `; without Docker, omit --capsules (docs/JUDGE_NO_DOCKER.md)` to the
  `JUDGE_DOCKER` fix text in `scripts/judge/preflight.sh:351`. In the 0.2.6 release
  notes, add the T1 commands next to the T2 block.
- Docs: `docs/JUDGE_TROUBLESHOOTING.md:86` (`JUDGE_DOCKER` row): add the same no-Docker
  pointer.

### 2. Running as root fails late, and the fix text is wrong

- Command (root, with `/run/user/0` present and DISPLAY reachable):
  `bash scripts/judge/metaviewer-judge.sh install`
- Output, after 25.2 s [MEASURED] of node unpack and package verification:
  `JUDGE_SMOKE: the install smoke failed (rc 1): PKG_SMOKE_CHILD_FAILED: … FATAL … Running as root without --no-sandbox is not supported … -- fix: see …/logs/smoke.log; check DISPLAY/xvfb-run and the AppArmor profile, then re-run install`
- Without `/run/user/0` (a typical `sudo -i` or root ssh shell), root instead gets
  `JUDGE_XDG_RUNTIME: /run/user/0 does not exist … -- fix: use a desktop session (logind); on WSL2 set systemd=true …`.
  This advice is wrong for root.
- `sudo bash scripts/judge/metaviewer-judge.sh install` also runs as root. On Ubuntu, sudo
  sets HOME to `/root`, so any install lands under `/root/.local/share`, and a later
  `run` as the normal user reports `JUDGE_NOT_INSTALLED`.
- Expected: an immediate typed refusal that names the cause and says to use a normal user.
- Severity: high for root VPS or cloud-VM judges. The static doctor gives no warning.
- Smallest fix: add a `chk_root` to the static phase in `scripts/judge/preflight.sh`
  (line 536), for example:
  `[ "$UID_NOW" != 0 ] || refuse JUDGE_ROOT "running as root: Electron refuses root without --no-sandbox" "log in as a normal user (create one with: sudo adduser <name>) and re-run without sudo"`.
- Docs: `docs/JUDGE_QUICKSTART.md:96-97`: add "do not run with `sudo`; the script asks
  for sudo itself". `docs/JUDGE_TROUBLESHOOTING.md:73` (`JUDGE_SMOKE`): add the root
  cause.

### 3. The T1 install requires an administrator step, and a sudo refusal is reported as an apt failure

- Command (normal user, not in sudoers, x11-utils missing):
  `printf 'y\n' | bash scripts/judge/metaviewer-judge.sh install`
- Output:
  ```
  Administrator step: install the system packages: x11-utils
    command: sudo bash -c apt-get\ update\ \&\&\ apt-get\ install\ -y\ \"\$@\" _ x11-utils
  sudo: a terminal is required to read the password; …
  JUDGE_SYSDEP: apt-get failed (rc 1) for: x11-utils -- fix: sudo apt-get install -y x11-utils
  ```
- Expected: "sudo was refused (password needed or user not in sudoers)", and a fix the
  judge can run, such as asking an administrator or running the printed command as root.
- The T1 package set (`scripts/judge/preflight.sh:218`) also includes `xvfb strace git zip
  unzip python3-pip`. The app-only route on a visible desktop does not need those, so a
  missing tool such as `pip3` forces a sudo step for T1. This audit did not measure
  which of these are absent on a stock Ubuntu 24.04 desktop: ABSENT — do not invent.
- Severity: medium. The judge is blocked, and the message points them the wrong way.
- Smallest fix: in `step_sysdeps` (`scripts/judge/metaviewer-judge.sh:321-328`), when
  `EUID_NOW != 0` and `sudo -n true` fails before the step, print a typed `JUDGE_SUDO`
  ("sudo needs a password or this user is not in sudoers"). Scope the T1 list to what T1
  runs.
- Docs: `docs/JUDGE_NO_DOCKER.md:26` ("Install may request host packages …"): list the
  exact packages and say the step needs sudo. `docs/JUDGE_TROUBLESHOOTING.md:69`: add the
  sudo-refused case.

### 4. A failed install smoke leaves processes running, and `stop` still reports clean

- Command: any install whose smoke fails (reproduced with finding 5), then
  `bash scripts/judge/metaviewer-judge.sh stop`.
- Output after 3 failed smokes [MEASURED]: 3 `strace -f … /tmp/mv-clean-*/…/metaviewer`
  processes re-parented to PID 1, each with the Electron tree (12 `metaviewer` processes in
  total, about 155 MB RSS [MEASURED] for each main process) and a `metaviewer-core`.
  3 `Xvfb` servers on `:100`, `:101` and `:102` (from `xvfb-run`) also remained, and 3
  `/tmp/mv-pkg-*` directories were present. `stop` printed `JUDGE_STOP_CLEAN` with rc 0.
- Expected: smoke failure kills its whole process tree. `stop` should not report clean
  while install-owned processes run.
- Notes: the leaked Xvfb displays use the same numbers as the T2 profile pool
  (`scripts/judge/metaviewer-judge.sh:687`, `:100`–`:103`). Whether this collides with
  capsules was not tested. Which of the three `/tmp/mv-pkg-*` directories came from smokes
  rather than runs was not determined.
- Severity: high when it happens. Each retry stacks another tree.
- Smallest fix: in the `--smoke` path of `ui/tools/package.js` (clean root at line 2742),
  spawn `xvfb-run`/`strace` with `detached: true` and kill `-pid` (the process group) on
  every exit path.
- Docs: `docs/JUDGE_TROUBLESHOOTING.md:73` (`JUDGE_SMOKE`): until fixed, tell judges to
  check `pgrep -af mv-clean-` and kill those processes before retrying.

### 5. A space in the Node install path breaks the install smoke

- Command (host node older than 24, so the kit Node is used):
  `export MV_JUDGE_HOME="$HOME/inst dir ñ" MV_JUDGE_ASSET_DIR="$HOME/assets ñ"`, then
  `fetch_assets.py --dest "$MV_JUDGE_ASSET_DIR"` and `metaviewer-judge.sh install`, run from
  a checkout under `~/Mis proyectos ñ/`.
- Output (2 of 2 runs [MEASURED]): `JUDGE_SMOKE: … [metaviewer] network capability probe: binary_missing … METAVIEWER_BOOT_REFUSED ADAPTER_CRASHED: … adapter spawn failed: unsafe child pid … -- fix: … check DISPLAY/xvfb-run and the AppArmor profile`
- Cause: `writeFakeSmokeAdapter` writes `#!${process.execPath}` (`ui/tools/package.js:2586`).
  The kernel splits a shebang at the first space.
- Isolation [MEASURED]:
  - Smoke with the same node binary copied to `~/n o/bin/node`: `PKG_SMOKE_CHILD_FAILED`.
  - The same node with a space-free path: `METAVIEWER_MAIN_SMOKE_OK` in 7 of 7 runs. Those
    runs were 3 `MV_SRF_BIN_DIR` values with a space and/or `ñ`, a checkout path with both,
    an asset path with both, and 2 controls.
  - Non-ASCII alone is fine.
- Expected: the install works, or refuses the path up front with a typed error.
- Severity: medium (low likelihood). It also triggers finding 4.
- Smallest fix: refuse whitespace in `JUDGE_HOME` with `JUDGE_USAGE` next to
  `scripts/judge/metaviewer-judge.sh:83-87`. Alternatively, spawn the fake adapter as
  `process.execPath script` instead of relying on its shebang.
- Docs: `docs/JUDGE_QUICKSTART.md:105` (`MV_JUDGE_HOME` …): add "a path without spaces".

### 6. Install downloads npm packages without asking

- Command: first `install` from a fresh checkout.
- Output: no prompt, but `<checkout>/ui/node_modules` gained 85 top-level entries
  [MEASURED] (`npm ci --ignore-scripts` in `ensure_pkg_tool_deps`,
  `scripts/judge/metaviewer-judge.sh:396`).
- Expected: `scripts/judge/metaviewer-judge.sh:15` promises "Nothing is downloaded without
  a confirmation". Offline judges, or judges behind a proxy that blocks the npm registry,
  get `JUDGE_SMOKE: cannot install the package tool dependencies`.
- Severity: low to medium. It contradicts the stated safety rule and is a hidden network
  dependency. The offline failure was not reproduced here.
- Smallest fix: call `confirm "Install the package verifier's npm dependencies (uses the network)?"`
  before `npm ci`, or ship `@electron/asar` in the kit.
- Docs: `docs/JUDGE_QUICKSTART.md:222-225`: say that install runs `npm ci` itself and
  needs registry access.

### 7. `doctor --before-install` passes without a display

- Command (no DISPLAY): `doctor --before-install`, then `install`.
- Output: `JUDGE_DOCTOR_OK tier=T1 phase=before-install`. `install` then spends 5.8 s
  [MEASURED] (sysdeps and kit Node unpack) before
  `JUDGE_DISPLAY: DISPLAY is not set -- fix: xvfb-run -a …`.
- Expected: the static doctor flags an unset DISPLAY for T1 (warning or refusal) before
  any sudo step.
- Severity: low. The message itself is actionable.
- Smallest fix: in the static phase (`scripts/judge/preflight.sh:536`), check only
  `[ -n "$DISPLAY" ]`, which needs no `xdpyinfo`.
- Docs: `docs/JUDGE_NO_DOCKER.md:20`: note that this check does not test the display.

### 8. The release builder can ship Node 22 labelled as Node 24 (release-side)

- Command (maintainer box, host `node` v22.23.4):
  `build_release_assets.build_node_asset(out, 'x64')` without `--node-tarball`.
- Output [MEASURED]: archive top directory `node-v24-linux-x64/`, whose `bin/node --version`
  prints `v22.23.4`.
- Expected: the builder refuses a non-24 Node. Otherwise every judge whose host Node is
  older than 24 gets `JUDGE_NODE … major 24 is required` after unpack
  (`scripts/judge/metaviewer-judge.sh:346`). The v0.2.5 asset ships v24.14.0 [MEASURED],
  so v0.2.5 is not affected.
- Severity: high if the 0.2.6 assets are built this way. Likelihood depends on the release
  step.
- Smallest fix: in `tools/build_release_assets.py:244-255`, run `node_bin --version` and
  raise `AssetBuildError` unless the major version is at least 24. Derive the top directory
  from the real version.
- Docs: `docs/JUDGE_QUICKSTART.md:80` (maintainer build line): require `--node-tarball` for
  an official Node 24 archive.

### 9. Current docs describe a different app than the v0.2.5 package

- Command: `run` with the v0.2.5 app.
- Observed: a light theme and no left Humans/Agents tree column. The adapter was degraded
  (`OPENSUPERFICIES_ABSENT`, terminal only), and the window footer showed "Waiting for
  capsule frames".
- Expected per `docs/JUDGE_QUICKSTART.md:233-235`: "defaults to Dark … three columns … left
  tree".
- Severity: low. It resolves if 0.2.6 ships an app built from this tree, which needs the
  new `package.js` inputs (`daemon-adapter/guest_command_runtime`, `rewind_runtime`,
  `docs/ARM64_CAPSULE_ASSET_NOTICES.md`).
- Smallest fix: do not pair these docs with the v0.2.5 `metaviewer-linux-x64.tar.gz`.
- Docs: `docs/JUDGE_NO_DOCKER.md:12` and `docs/JUDGE_QUICKSTART.md:58-60`: update the tag
  and digest for 0.2.6.

### 10. Minor items

- The T1 `JUDGE_INSTALL_OK` prints `network=legacy`, which means nothing for T1
  (`scripts/judge/metaviewer-judge.sh:636`).
- Every `stop` prints `JUDGE_NOTE: private packaged runtime census incomplete: TMPDIR is
  unset …`. The docs never tell the judge to set TMPDIR.
- `JUDGE_RUNNING: another launcher owns run or install -- fix: wait … or interrupt the
  active launcher` appears for `install` while the app runs. `bash
  scripts/judge/metaviewer-judge.sh stop` would be the direct fix
  (`scripts/judge/metaviewer-judge.sh:211`).

## Checked and passed

- Fetch verifies the digest and refuses HTTP or a missing digest (code read). Its download
  is atomic through a temp directory.
- Re-running install over an existing install worked, and so did a second `run` or
  `install` while the app runs (typed refusal).
- `stop` after a normal run left 0 MetaViewer processes [MEASURED].
- An asset directory and checkout with spaces and `ñ` worked for fetch and smoke. Only the
  Node path breaks (finding 5).
- Architecture: the launcher, preflight and fetch map `x86_64` to `x64`. `chk_bundle_arch`
  checks ELF machine 62 [CITED: `scripts/judge/preflight.sh:85`]. No x64 assumption broke on
  this host.

## Not run here

- T2 install, run, stop with capsules, Open firewall, profile provisioning, the legacy
  proxy and `docker load`: there is no Docker daemon. The v0.2.5 `opensuperficies` binaries
  were downloaded but not executed, so native flags were not exercised. The launcher's
  native calls are unchanged since v0.2.5.
- The AppArmor userns step: this kernel has no
  `kernel.apparmor_restrict_unprivileged_userns`.
- A real logind desktop, Wayland/XWayland, WSLg, an interactive sudo password prompt, a
  stock Ubuntu desktop package set, arm64, an offline npm failure, and Ctrl+C or a closed
  terminal during `run`.
- `docs/JUDGE_TROUBLESHOOTING.md` was checked only for the rows cited above, not read in
  full.

Model: not written here. This session's rules forbid model identifiers in pushed files,
so the model is given in the session reply. Reasoning effort: 40 (session setting).

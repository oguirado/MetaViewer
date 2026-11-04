# App-only judging without Docker

Answers: install without docker, no docker daemon, T1 only, app only, Docker not available

This route installs the T1 wall, Rust authority core and adapter. It needs no
Docker daemon or private component access. It still needs a normal Linux user,
a reachable graphical display, a user-owned runtime directory and the verified
public app package. See [Before you start](JUDGE_QUICKSTART.md#before-you-start).
It demonstrates application startup and typed runtime unavailability, not live
browser/program capsules or an agent completing a goal.

## Fetch the public x64 package

Answers: download T1 assets, fetch command, which release

Use the matching source tag and release assets only after confirming the
[target publication](https://github.com/oguirado/MetaViewer/releases/tag/v0.2.6)
is available. Copy its independently published `SHA256SUMS` digest into
`SHA256SUMS_DIGEST`. If the tag, assets or digest are missing, stop with
`ABSENT — do not invent`; do not substitute an older package. No public ARM64
compiled set is established here. For T1,
`SHA256SUMS`, `metaviewer-linux-x64.tar.gz` and `node-linux-x64.tar.xz` are always
fetched. The Node archive is installed only when host Node is missing or older
than `24` [CITED: scripts/judge/fetch_assets.py:26, scripts/judge/metaviewer-judge.sh:353].
Run from the root of a clone of the same tag
(`git clone --branch v0.2.6 --depth 1 https://github.com/oguirado/MetaViewer.git`):
execute each command only after the previous one succeeded. A nonzero exit
means stop and resolve its diagnostic before continuing.

```bash
: "${SHA256SUMS_DIGEST:?Set the independently published manifest digest first}"
export RELEASE_ASSET_URL=https://github.com/oguirado/MetaViewer/releases/download/v0.2.6
bash scripts/judge/metaviewer-judge.sh doctor --before-install
python3 scripts/judge/fetch_assets.py --source "$RELEASE_ASSET_URL" --sums-sha256 "$SHA256SUMS_DIGEST"
bash scripts/judge/metaviewer-judge.sh install
bash scripts/judge/metaviewer-judge.sh doctor
bash scripts/judge/metaviewer-judge.sh run
```

Expected markers, in order:
`JUDGE_DOCTOR_OK tier=T1 phase=before-install (installed runtime not checked)`;
`JUDGE_FETCH_OK arch=x64 tier=T1`;
`METAVIEWER_MAIN_SMOKE_OK` and `JUDGE_INSTALL_OK tier=T1 network=legacy receipt=…`;
`JUDGE_DOCTOR_OK tier=T1`; then `METAVIEWER_RENDERER_READY`, `METAVIEWER_MAIN_READY` and the app window.
The run command remains in the foreground; use a separate terminal to stop it
[CITED: scripts/judge/metaviewer-judge.sh, scripts/judge/fetch_assets.py, ui/electron/main.js].
Any other line beginning `JUDGE_<CODE>:` is a refusal: look it up in
[troubleshooting](JUDGE_TROUBLESHOOTING.md#kit-install-and-run).

Omit `--capsules` throughout. Install may request host packages or sandbox setup;
review the printed requests. Missing tools are mapped to `xvfb`, `x11-utils`,
`xauth`, `tar`, `zip`, `unzip`, `strace`, `git`, `coreutils`, `python3` and
`python3-pip` [CITED: `../scripts/judge/preflight.sh`]. Package installation needs
administrator authorization; if sudo refuses, ask an administrator to install the
printed packages, then rerun the launcher as your normal user.
Headless smoke can use Xvfb as described in the
[quickstart](JUDGE_QUICKSTART.md#headless-installation), but seeing the wall
requires a visible display. Downloads default to the checkout's `assets/`;
use the documented `--dest` and `MV_JUDGE_ASSET_DIR` pair to keep them outside it.

## What to observe

Answers: did it work, what should I see, empty wall, adapter degraded

Doctor should print `JUDGE_DOCTOR_OK tier=T1`. In the terminal running the app,
look for `METAVIEWER_RENDERER_READY` and `METAVIEWER_MAIN_READY`. Missing surface
runtime is represented by `METAVIEWER_ADAPTER_DEGRADED`; the wall can remain
available in core-only mode. A configured but broken `MV_SRF_BIN_DIR` can instead
refuse startup: unset it for this app-only route. Creating live capsules requires
the compatible external runtime and images; an empty wall is not a capsule demo.
[CITED: `../ui/electron/main.js`, `../ui/tools/package.js`]

Stop from another terminal with the same installation environment:

```bash
bash scripts/judge/metaviewer-judge.sh stop
```

Inspect the stop diagnostics; `JUDGE_STOP_CLEAN` is the launcher's successful
cleanup result. See [Judge troubleshooting](JUDGE_TROUBLESHOOTING.md) for refusals.

## Inspect the core's proof without private access

Answers: verify the core without private parts, admission tests, journal, replay, mv-replay

The [evidence guide](EVIDENCE.md) links public admission, journal, replay and
corruption tests. Their fixtures are generated in temporary directories by the
tests; they are not committed sample journals. Run the public authority and replay tests from the checkout:

```bash
cargo test -p metaviewer-core --test admission_matrix --test admission_journal --test t1_journal_verify
```

A ready-made, scrubbed session journal is not supplied. For a session journal
you already own, the [replay instructions](USER_GUIDE.md#7-replay-of-a-session-journal-mv-replay)
require both the journal and its witness root. The release package's documented
binary list does not promise a bundled `mv-replay` executable; build it from
source with cached dependencies when needed. Do not claim a replay or tamper
check from wall startup alone. `mv-replay` needs the absolute real path of the
session directory: relative, symlinked or copied session paths give Invalid
[CITED: README.md, maintainer report; raw receipt absent].

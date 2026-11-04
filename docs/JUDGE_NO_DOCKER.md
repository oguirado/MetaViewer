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

Use the [v0.2.6 source tag and release assets](https://github.com/oguirado/MetaViewer/releases/tag/v0.2.6).
Copy the `SHA256SUMS` digest from that release's notes into `SHA256SUMS_DIGEST`
before running fetch. The release has no ARM64 compiled assets. T1 uses only
`SHA256SUMS`, `metaviewer-linux-x64.tar.gz` and, when host Node is older than 24,
`node-linux-x64.tar.xz` [CITED: scripts/judge/metaviewer-judge.sh:353].
Run from the root of a clone of the same tag
(`git clone --branch v0.2.6 --depth 1 https://github.com/oguirado/MetaViewer.git`):

```bash
export RELEASE_ASSET_URL=https://github.com/oguirado/MetaViewer/releases/download/v0.2.6
python3 scripts/judge/fetch_assets.py --source "$RELEASE_ASSET_URL" --sums-sha256 "$SHA256SUMS_DIGEST"
bash scripts/judge/metaviewer-judge.sh doctor --before-install
bash scripts/judge/metaviewer-judge.sh install
bash scripts/judge/metaviewer-judge.sh doctor
bash scripts/judge/metaviewer-judge.sh run
```

Expected markers, in order: `JUDGE_FETCH_OK arch=x64 tier=T1`;
`JUDGE_DOCTOR_OK tier=T1 phase=before-install (installed runtime not checked)`;
`METAVIEWER_MAIN_SMOKE_OK` and `JUDGE_INSTALL_OK tier=T1 network=legacy receipt=…`;
`JUDGE_DOCTOR_OK tier=T1`; then the app window
[CITED: scripts/judge/metaviewer-judge.sh:792, scripts/judge/fetch_assets.py:67].
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
[MEASURED].

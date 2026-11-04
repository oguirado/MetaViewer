# App-only judging without Docker

This route installs the T1 wall, Rust authority core and adapter. It needs no
Docker daemon or private component access. It still needs a normal Linux user,
a reachable graphical display, a user-owned runtime directory and the verified
public app package. See [Before you start](JUDGE_QUICKSTART.md#before-you-start).
It demonstrates application startup and typed runtime unavailability, not live
browser/program capsules or an agent completing a goal.

## Fetch the public x64 package

Use the matching [v0.2.5 source tag and release assets](https://github.com/oguirado/MetaViewer/releases/tag/v0.2.5)
[CITED: release]. Copy the `SHA256SUMS` digest from that release's notes before
running fetch. That release has no ARM64 compiled assets.
Run from the matching checkout root:

```bash
export RELEASE_ASSET_URL=https://github.com/oguirado/MetaViewer/releases/download/v0.2.5
python3 scripts/judge/fetch_assets.py --source "$RELEASE_ASSET_URL" --sums-sha256 "$SHA256SUMS_DIGEST"
bash scripts/judge/metaviewer-judge.sh doctor --before-install
bash scripts/judge/metaviewer-judge.sh install
bash scripts/judge/metaviewer-judge.sh doctor
bash scripts/judge/metaviewer-judge.sh run
```

Omit `--capsules` throughout. Install may request host packages or sandbox setup;
review the printed requests. Headless smoke can use Xvfb as described in the
[quickstart](JUDGE_QUICKSTART.md#headless-installation), but seeing the wall
requires a visible display. Downloads default to the checkout's `assets/`;
use the documented `--dest` and `MV_JUDGE_ASSET_DIR` pair to keep them outside it.

## What to observe

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

The [evidence guide](EVIDENCE.md) links public admission, journal, replay and
corruption tests. Their fixtures are generated in temporary directories by the
tests; they are not committed sample journals. A ready-made, scrubbed journal for
there is no standalone replay command. For a session journal
you already own, the [replay instructions](USER_GUIDE.md#7-replay-of-a-session-journal-mv-replay)
require both the journal and its witness root. The release package's documented
binary list does not promise a bundled `mv-replay` executable; build it from
source with cached dependencies when needed. Do not claim a replay or tamper
check from wall startup alone.

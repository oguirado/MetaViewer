# Judges: start here

MetaViewer is a Linux desktop wall of live capsules: browser and program windows
that a human or an AI agent controls. Agent action proposals pass through a Rust
authority core; human control and agent proposals are distinct input paths
[CITED: core/src/admission/mod.rs]. This page routes a judge, or a judge's AI, to the one document that
answers each question.

Capsules give the agent a named surface, current frame and explicit control
state. The core can refuse an action when its frame is stale or the human owns
control. This makes computer use inspectable while keeping human takeover
available [CITED: core/src/admission/mod.rs].

**A finding tells you where to look. Only the code proves it.**

Evidence tags used on every judge page: [MEASURED] observed on a live run,
[CITED: path] stated by that file, [TARGET] a design threshold, not a measurement.
A fact that was not found is written `ABSENT — do not invent`.

## Which document answers my question?

Answers: where do I start, which doc, reading map, what should I read first

Start with the row that matches your question; each linked section can be read alone.

| You want to | Go to |
| --- | --- |
| Install and run on your machine | [JUDGE_QUICKSTART.md](JUDGE_QUICKSTART.md#judge-paths-by-platform-and-tier) |
| Install without Docker (app only, tier T1) | [JUDGE_NO_DOCKER.md](JUDGE_NO_DOCKER.md) |
| Check the machine before installing | [JUDGE_QUICKSTART.md](JUDGE_QUICKSTART.md#2-check-your-machine-no-changes-made) |
| Know the hardware and software needed | [Requirements in numbers](#what-does-my-machine-need) |
| Know which capsules each tier gives | [Tiers and capsules](#which-capsules-does-each-tier-give) |
| Walk through the features after install | [JUDGE_TOUR.md](JUDGE_TOUR.md) |
| Understand a `JUDGE_…` or other refusal code | [JUDGE_TROUBLESHOOTING.md](JUDGE_TROUBLESHOOTING.md) |
| Build from source or run the offline gate | [INSTALL.md](INSTALL.md) |
| Let your own AI do the install | [Paste block for your AI](#what-do-i-paste-into-my-own-ai) |
| See what is proven and where the evidence is | [EVIDENCE.md](EVIDENCE.md) |
| Know what this release does not include | [Not in this release](#what-is-not-in-this-release) |

## What do I paste into my own AI?

Answers: let my AI install it, prompt for my coding agent, AI install, agent instructions

Paste this block into a coding agent with terminal access on the target Linux
machine. It authorizes the ordinary installation steps up front. A missing
release, password, incompatible host or failed check remains a real blocker.

```text
Install and launch MetaViewer from https://github.com/oguirado/MetaViewer,
version 0.2.6. Work as my normal user. You may clone the matching tag, download
and verify its release assets, and run the judge installer with --yes. This
includes its printed system-package, AppArmor and optional Open-firewall steps.
Do not ask me to approve those steps again. Do not publish, remove unrelated
state, enter credentials or change Docker group membership.

1. Inspect uname -m, /etc/os-release, the graphical session and docker info.
   Use T2 on Linux x64 when my user can reach local rootful Docker Engine;
   otherwise use T1 (app only). Do not disable Electron's sandbox. On arm64,
   report that public compiled assets are absent and read the source-build
   prerequisites in docs/INSTALL.md; stop if a pinned dependency is unavailable.
2. Verify that tag v0.2.6 and its matching release assets exist before cloning.
   Obtain the SHA256SUMS digest independently from that release's notes or its
   publisher-provided asset digest. If the release or digest is absent, report
   the missing prerequisite and stop. Never substitute another version or
   compute the trusted digest from the downloaded manifest itself.
3. Clone that tag, read llms.txt and docs/JUDGE_QUICKSTART.md, and run doctor
   --before-install (with --capsules for T2). Fix only documented prerequisites
   within the permission above; a sudo password or session restart is a blocker.
4. Run fetch_assets.py with the release URL and --sums-sha256, adding --capsules
   for T2. Run install --yes, adding --capsules for T2; then run full doctor with
   the same tier. Check each exit status and the quickstart's success markers.
5. Launch with `bash scripts/judge/metaviewer-judge.sh run` in a persistent
   terminal. It stays in the foreground. Require METAVIEWER_RENDERER_READY and
   METAVIEWER_MAIN_READY; do not equate an empty wall with working capsules.
6. On failure, find the exact code in docs/JUDGE_TROUBLESHOOTING.md and read its
   cited implementation. Apply a fix only within this authorization; otherwise
   preserve the diagnostic and report the blocker. Never guess a cleanup PID
   or delete a resource to force a passing result.
7. Leave the app running for me. Report the installed version, tier, network
   mode, observed markers and remaining limits, then point to docs/JUDGE_TOUR.md.
```

The exact command paths and expected outputs are in the
[quickstart](JUDGE_QUICKSTART.md#judge-paths-by-platform-and-tier). The code map
at `route/route_query.py` locates a symptom with
`python3 route/route_query.py error "<code>"`; read the returned current source
before explaining a cause. Findings are leads, not proof [CITED: route/README.md].

## What does my machine need?

Answers: requirements, minimum RAM, disk space, CPU, supported OS, hardware

The launcher checks these numbers itself and refuses with a typed code when one
is not met. Floors come from `scripts/judge/preflight.sh`.

| Need | T1 app only | T2 app plus capsules | Refusal if not met |
| --- | --- | --- | --- |
| Architecture | Linux x86_64 with release assets; aarch64 assets ABSENT in the release | same | `JUDGE_ARCH`, `JUDGE_BUNDLE_ARCH` |
| Operating system | Ubuntu 24.04 verified; others warn [CITED: scripts/judge/preflight.sh] | same | `JUDGE_OS` (warning only) |
| User | normal user, not root | same | `JUDGE_ROOT` |
| Available RAM | min(MemTotal/4, 20 GiB) + 512 MiB [TARGET] | same, and each Add capsule needs 6144 MiB available [CITED: scripts/judge/preflight.sh] | `JUDGE_RAM` |
| `/dev/shm` tmpfs free | 512 MiB [TARGET] | 1 GiB, 2.5 GiB recommended [TARGET] | `JUDGE_SHM` |
| Free disk | 2 GB [TARGET] | 15 GB at home and Docker root, 30 GB recommended [TARGET] | `JUDGE_DISK` |
| CPUs | no pinning required by default | 8 logical CPUs recommended [TARGET] | `JUDGE_CPUSET` only if pinning is requested |
| Node.js | major 24 or newer; the kit installs one if missing [CITED: scripts/judge/metaviewer-judge.sh] | same | `JUDGE_NODE` |
| Display | reachable X display (desktop, XWayland, WSLg; Xvfb for headless install) | same | `JUDGE_DISPLAY` |
| Login runtime dir | `/run/user/<uid>` owned by you | same | `JUDGE_XDG_RUNTIME` |
| Docker | not used | rootful Docker Engine reachable by your user; not rootless, not Docker Desktop | `JUDGE_DOCKER`, `JUDGE_DOCKER_DESKTOP`, `JUDGE_DOCKER_HOST` |

Example: on a 16 GiB machine the install floor is 4 GiB + 512 MiB = 4.5 GiB
available [TARGET]. Full hardware notes: [JUDGE_QUICKSTART.md](JUDGE_QUICKSTART.md#hardware).

## Which capsules does each tier give?

Answers: what do I get, T1 vs T2, which capsule kinds, browser, program, host program

A capsule is one live window on the wall with its own controller (human or agent).
Browser and Program capsules run inside containers; Host program and Desktop window
run on your computer and are not isolated.

| Tier | Install command | Capsules you can open |
| --- | --- | --- |
| T1 | `install` | Wall, core and adapter only. No live capsule is promised: creating one refuses with a typed error. Host program needs `srf-host-window` from the T2 kit [CITED: daemon-adapter/internal/capsule/host_xpra.go:214]. |
| T2 | `install --capsules` | T1 plus Identity browser and Program capsules in containers, up to 4 browser profile slots (`judge`, `mv-live-2`, `mv-live-3`, `mv-live-4`) [CITED: scripts/judge/metaviewer-judge.sh:840]; Host program and Desktop window when host tools `xpra xvfb xauth xdotool` are installed (these two are not isolated) |
| T0 | not part of the kit | Offline fixture conversation for developers; needs a private `wender-agent` checkout in `MV_MW_WENDER_ROOT`; see [Is there an offline fixture?](#is-there-an-offline-fixture) |

A judge does not get VM or MicroVM capsules from the kit. The developer launcher
(not the judge kit) offers, on a plain start, browsers, Host program and Program;
with `--arm64` it offers VM and MicroVM only
[CITED: README.md, maintainer report; raw receipt absent].

## What is not in this release?

Answers: limitations, what is missing, VM, MicroVM, rewind, arm64 assets, public browsing

The public judge kit does not supply the developer-only environments below;
its compiled workflows and network paths also have explicit limits.

| Not available to a judge | Why or what instead |
| --- | --- |
| arm64 release assets | ABSENT in the release; arm64 needs the [developer setup](ARM64_CAPSULE_SETUP.md) |
| x64 VM, MicroVM and rewind | Not in this release |
| arm64 VM, MicroVM and rewind | Developer setup only, KVM and verified local assets required |
| Public websites on the legacy network | The shipped policy grants no destinations; public browsing needs the Open image and its firewall step ([quickstart](JUDGE_QUICKSTART.md#capsule-network-tier-t2-only)) |
| Stored browser workflows in the compiled kit | Refuse `MW_COMPILED_WORKFLOW_UNAVAILABLE` |
| Windows or macOS as hosts | Windows only through WSL2 + WSLg; macOS unsupported |
| Source of `wender-agent`, `vision-engine`, `OpenSuperficies` | Private; only compiled x64 evaluation builds, under [NOTICE-EVALUATION.md](../NOTICE-EVALUATION.md) |

Developer-only observations and their evidence limits are in
[the tour](JUDGE_TOUR.md#architecture-support-at-this-snapshot). Live results are
maintainer-reported; receipts and video takes are not published in this repository.

## Is there an offline fixture?

Answers: T0, offline conversation, run without display or Docker

T0 is a developer fixture, not a judge path. It runs the runner against hosted fakes:

```sh
node tests/e2e/packs/builtin-fixtures/META/hosted.mjs
```

It needs Node on PATH and a locked `wender-agent` checkout in `MV_MW_WENDER_ROOT`,
which a fresh public clone does not supply. It is an offline simulation of a
neutral local page, not evidence about any live service. Without that checkout,
use T1 or T2 instead.

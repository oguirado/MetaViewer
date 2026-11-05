# Judges: start here

MetaViewer is a Linux desktop wall of live capsules: browser and program windows
that a human or an AI agent controls, with every action admitted and journaled by
a Rust core. This page routes a judge, or a judge's AI, to the one document that
answers each question.

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

Paste this block into the coding agent you trust, in a terminal on the Linux
machine where MetaViewer should run, as your normal user (not root).

```text
Install and run this repository; start at llms.txt.
Repository: https://github.com/oguirado/MetaViewer (tag v0.2.6).
Rules:
1. Read llms.txt, then docs/JUDGES.md, then docs/JUDGE_QUICKSTART.md section
   "Judge paths by platform and tier". Do not open whole documents you do not need.
2. Run as my normal user. Never use sudo for the launcher and never add --no-sandbox.
   The launcher prints every administrator command and asks first; show me each
   one and wait for my yes before answering it.
3. Run `bash scripts/judge/metaviewer-judge.sh doctor --before-install` first
   (add --capsules only if Docker Engine works for my user).
4. After each command, compare the output with the success marker in the
   quickstart. On any `JUDGE_<CODE>:` line, look the code up in
   docs/JUDGE_TROUBLESHOOTING.md, explain the cause to me in plain words, and
   apply only the fix printed after `-- fix:` when I agree.
5. To explain a refusal, find the code in the source file the troubleshooting row
   links, read that code, and quote path:line. A routed finding is a lead,
   not proof.
6. Report what ran, the exact markers seen, and what you could not run.
```

What the AI should do, in order: confirm the platform with `uname -m` and
`/etc/os-release`; clone the tag; run doctor; fetch assets with the release's
SHA256SUMS digest; install; full doctor; run; then follow
[JUDGE_TOUR.md](JUDGE_TOUR.md). The code map at `route/route_query.py` locates code
for a symptom (`python3 route/route_query.py error "<code>"`); its rows are pinned
to an older commit and marked FRESH or STALE per file [CITED: route/README.md], so
the AI must read the current file before stating anything.

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
with `--arm64` it offers VM and MicroVM only [MEASURED].

## What is not in this release?

Answers: limitations, what is missing, VM, MicroVM, rewind, arm64 assets, public browsing

| Not available to a judge | Why or what instead |
| --- | --- |
| arm64 release assets | ABSENT in the release; arm64 needs the [developer setup](ARM64_CAPSULE_SETUP.md) |
| x64 VM, MicroVM and rewind | Not in this release |
| arm64 VM, MicroVM and rewind | Developer setup only, KVM and verified local assets required |
| Public websites on the legacy network | The shipped policy grants no destinations; public browsing needs the Open image and its firewall step ([quickstart](JUDGE_QUICKSTART.md#capsule-network-tier-t2-only)) |
| Stored browser workflows in the compiled kit | Refuse `MW_COMPILED_WORKFLOW_UNAVAILABLE` |
| Windows or macOS as hosts | Windows only through WSL2 + WSLg; macOS unsupported |
| Source of `wender-agent`, `vision-engine`, `OpenSuperficies` | Private; only compiled x64 evaluation builds, under [NOTICE-EVALUATION.md](../NOTICE-EVALUATION.md) |

Rewind was measured on an ARM64 MicroVM in developer setup: 3 files deleted, Back
restored them, 387.5 ms shown by the app, and `mv-replay` returned rc 0 on that
session journal [MEASURED]. That is not a judge install path.

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

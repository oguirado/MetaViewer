# Why capsules

MetaViewer runs each application a person or an AI agent works with as a
**capsule**: one live, addressable surface with its own process boundary,
owner, frame stream and journal entries, shown as one tile on a wall. This
document answers why the product is built that way, what each capsule kind
isolates and what it does not, and what an agent builder gains or loses
compared with the usual alternatives.

A finding tells you where to look. Only the code proves it. Every coordinate
below was read on the `docs/v026-base` tree; numbers carry [MEASURED],
[CITED: path] or [TARGET]; anything not established reads
`ABSENT — do not invent`.

<a id="reading-map"></a>
## 0. Reading map

Answers: where do I start; which section answers my question about capsules.

| You want to know | Go to |
| --- | --- |
| The short answer: why capsules at all | [1](#short-answer) |
| Words used here (capsule, core, surface, frame, journal) | [2](#terms) |
| What one capsule kind isolates, who can drive it, what it costs | [3](#kinds) and its subsection |
| Which kind to choose for a task | [4](#choose-a-kind) |
| Why not a plain desktop, many tabs, containers, a VM per task, remote desktop | [5](#alternatives) |
| Why rendering, execution and authority are separate | [6](#separation) |
| What "fresh frame" means and why stale actions are refused | [7](#frame-freshness) |
| What the journal records and how replay checks it | [8](#journal-and-replay) |
| What Rewind restores and what it cannot | [9](#rewind) |
| Why a refusal is a feature, with a worked example | [10](#refusal-is-a-feature) |
| What this document does not claim | [11](#limits) |

Action rule: read the section, then open the cited code before repeating a
claim. Process and wire detail lives in [ARCHITECTURE.md](ARCHITECTURE.md);
error codes and symptoms live in the debug documents of the docs index
([docs/README.md](README.md)).

<a id="short-answer"></a>
## 1. Why capsules exist: the short answer

Answers: why does MetaViewer generate capsules; what is the advantage of
capsules; why not just let the AI use my desktop.

An AI agent that controls a computer needs three things a normal desktop does
not give it: a **target it cannot confuse with another**, **proof that it is
acting on what it last saw**, and **a record a human can check afterwards**.
A capsule supplies all three per application:

| Property | How a capsule supplies it | Coordinate |
| --- | --- | --- |
| One target, one owner | Each surface has one owner (human or one registered agent); agent proposals for a surface the agent does not own are refused `SURFACE_NOT_AGENT_CONTROLLED` | `core/src/admission/mod.rs:1313-1315` |
| Act only on what was seen | A proposal names the frame digest and generation it was based on; any mismatch is refused `STALE_FRAME` | `core/src/admission/mod.rs:1316-1321` |
| Human always wins | Taking control cancels in-flight agent proposals for that surface | `core/src/serve/mod.rs:1791-1830`, [ARCHITECTURE.md#fold-unfold-pin-and-take-control](ARCHITECTURE.md#fold-unfold-pin-and-take-control) |
| Contained damage | Identity browsers and Programs run in containers started by the private OpenSuperficies runtime; VM and MicroVM run in a guest | `daemon-adapter/internal/capsule/manager.go:845-854` |
| Checkable afterwards | Every admission, refusal and outcome is appended to a hash-chained journal that `mv-replay` re-verifies offline | `core/src/journal/mod.rs:3864-3867`, `core/src/bin/mv-replay.rs:1-45` |
| Many at once, side by side | Up to 16 live surfaces [CITED: `ui/electron/profilePicker.js:46`] on one wall, each with its own tile, owner and frame stream | `ui/electron/profilePicker.js:18-21` |

Generating capsules this way, rather than handing an agent the whole desktop,
means a wrong click lands in one application with one owner, at one known
frame, and leaves a journal entry. That is the gain. The cost is setup:
container images, RAM reservations and, for VMs, KVM.

<a id="terms"></a>
## 2. Terms used once

Answers: what is a capsule; what is a surface; what is the core; what is a
frame generation.

| Term | Meaning here |
| --- | --- |
| Capsule | One running application plus its native boundary (container, guest, or none for host routes) as managed by the daemon adapter |
| Surface | The live, addressable identity of a capsule inside the core: id, kind, owner, current frame |
| Tile | The picture of a surface on the wall. Presentation only; moving or folding a tile changes no authority |
| Core | The Rust process that alone decides admission, ownership, budgets and journal order (`core/`) |
| Daemon adapter | The Go process that starts and stops capsules and publishes frames (`daemon-adapter/`) |
| Frame | An immutable RGB24 picture in `/dev/shm` with a SHA-256 digest and a generation number |
| Generation | A per-surface counter that only increases; a newer picture always has a larger one |
| Journal | The append-only, hash-chained session record written by the core |
| Refusal | A typed "no" from the core, journalled with a reason code |
| Human / Agent role | Who may send input to a surface: the person at the wall, or the one registered agent |

<a id="kinds"></a>
## 3. The capsule kinds

Answers: what capsule kinds exist; what does each kind isolate; which kinds
are isolated; which kinds are available on x64 and on ARM64.

The launcher's closed kind list is `ui/src/catalog/catalogModel.js:98-135`.
Plain start offers Identity browser, Program and Host program (plus Desktop
window attachment); `--arm64` start offers VM and MicroVM only [MEASURED:
operator live run, 4 Nov 2026]. VM and MicroVM are filtered out unless the
host reports them available (`ui/src/catalog/catalogModel.js:150-151`) and
require an ARM64 host (`ui/electron/guestCommandProfile.js:11`). There is no
x64 VM or MicroVM in this release.

| Kind | Isolated? | Boundary | x64 | ARM64 |
| --- | --- | --- | --- | --- |
| [Identity browser](#identity-browser) | Yes, container | OpenSuperficies browser container per identity | Plain start | Plain start |
| [Program](#program) | Yes, container | OpenSuperficies program container; the executable must be in its image | Plain start | Plain start |
| [Host program](#host-program) | **No** | Separate Xvfb display via Xpra on the operator's computer | Plain start | Plain start |
| [Desktop window](#desktop-window) | **No** | Attaches an existing X11 window | X11 required | X11 required |
| [ARM64 VM](#arm64-vm) | Yes, guest | Graphical guest via the private VM executor, needs KVM | Not available | `--arm64` only |
| [MicroVM](#microvm) | Yes, guest | Firecracker guest, command console, needs KVM | Not available | `--arm64` only |

Memory and start time per kind: per-capsule container limits are cited below;
measured start times per kind are `ABSENT — do not invent`. The adapter
reserves 512 MiB per running capsule above a free-memory floor of
min(20 GiB, MemTotal / 4) [CITED: `daemon-adapter/internal/daemon/ram_admission.go:33`, `docs/INSTALL.md`].

<a id="identity-browser"></a>
### Identity browser

Answers: what does a browser capsule isolate; can the agent see my personal
browser; where do cookies live.

- **Isolates:** a browser running inside its own container from the private
  OpenSuperficies runtime, with its own display, its own persistent identity
  profile and a network mode chosen per profile through an egress record
  (`daemon-adapter/internal/capsule/manager.go:942-969`). Your personal browser
  profile is not used.
- **Does not isolate:** what the site itself does with your account, and
  anything you type into it. Stored-data slots save the stopped profile
  including credentials; copying them needs human confirmation
  (`daemon-adapter/internal/capsule/slots/store.go:278-279`).
- **Person:** types and clicks through the tile after taking control.
- **Agent:** proposes actions bound to a frame; the core admits or refuses
  each one. A login wall or bot check stops the workflow for the person
  ([REFERENCE.md#handoff](REFERENCE.md#handoff)).
- **Core sees:** surface id, owner, frame digest and generation, each
  proposal, verdict and receipt.
- **Cost:** Docker limit 4 GiB memory plus 2 GiB `/dev/shm` per capsule
  [CITED: `ui/electron/profilePicker.js:48-52`]; the UI refuses a create when
  free memory is below that 6 GiB [CITED: `ui/electron/profilePicker.js:22-24`].
  Start time `ABSENT — do not invent`.
- **Source:** kind `browser` mapping `daemon-adapter/internal/capsule/manager.go:396-399`.

<a id="program"></a>
### Program

Answers: what does a Program capsule isolate; why does Program need the
binary in the image; difference between Program and Host program.

- **Isolates:** a graphical Linux program inside an OpenSuperficies program
  container (`desktop_capsule` kind with native kind `program`,
  `daemon-adapter/internal/capsule/manager.go:400-403`). Only admitted programs
  run; the executable must exist in the capsule image.
- **Does not isolate:** files you copy in or out yourself; anything the
  program sends over the network it is allowed to reach.
- **Person and agent:** the same role model as the browser. The Human/Agent
  role is chosen at start; a role switch is served only for `browser` and
  `desktop_capsule` surfaces (`core/src/serve/role_switch.rs:29-30`).
- **Core sees:** the same as the browser.
- **Cost:** the same container limits as the browser [CITED:
  `ui/electron/profilePicker.js:48-52`]. Start time `ABSENT — do not invent`.

<a id="host-program"></a>
### Host program

Answers: is Host program isolated; why does switching a Host program between
human and agent restart it; why use Host program at all.

- **Isolates: nothing.** It runs an executable on the operator's own
  computer under Xpra with a separate Xvfb display
  (`daemon-adapter/internal/capsule/host_xpra.go:1-6`). The launcher and tile
  say "Runs on your computer — not isolated"
  (`ui/src/catalog/CatalogLauncher.vue:319`, `ui/src/surfaces/RoleSurface.vue:532`).
  Browsers started this way get a fresh temporary profile in RAM, never your
  personal profile; that is a privacy measure, not a sandbox.
- **Why it exists:** any installed program can be shown on the wall and driven
  with the same frame, ownership and journal rules, without building an image.
- **Person and agent:** the role is chosen before start. Switching between
  human and agent restarts the program [MEASURED: operator live run, 4 Nov
  2026]; unsaved program state is lost.
- **Core sees:** the same surface, frame and verdict records as other kinds.
- **Cost:** no container limit applies; it uses host memory. Measured
  footprint `ABSENT — do not invent`.

<a id="desktop-window"></a>
### Desktop window

Answers: what is Desktop window; can it move my real mouse; why is it not
isolated.

- **Isolates: nothing.** It attaches an already open X11 window from your
  desktop into a tile (`daemon-adapter/internal/capsule/host_window.go`).
  Native Wayland windows are not listed
  (`ui/src/catalog/catalogModel.js:123-129`). Input can move the real pointer
  and raise the real window; the tile says "Real desktop — not isolated"
  (`ui/src/surfaces/RoleSurface.vue:533`).
- **Why it exists:** to bring one existing window under the same frame and
  journal rules without restarting it.
- **Cost:** no capsule is started. Footprint `ABSENT — do not invent`.

<a id="arm64-vm"></a>
### ARM64 VM

Answers: what does the ARM64 VM capsule isolate; why is there no x64 VM.

- **Isolates:** a full graphical Linux guest behind KVM, run through the
  private VM executor in an `srf-vm-<profile>` container
  (`daemon-adapter/internal/capsule/manager.go:404-407`, `daemon-adapter/internal/capsule/manager.go:852-853`).
- **Does not isolate:** what the guest sends over a network you give it.
- **Available:** ARM64 hosts with `/dev/kvm` and the protected local setup in
  [ARM64_CAPSULE_SETUP.md](ARM64_CAPSULE_SETUP.md). Not available on x64.
- **Cost:** the launcher session helper runs under MemoryHigh 6 GiB, MemoryMax
  8 GiB, two CPUs, and requires a 32 GiB free-memory floor [TARGET, CITED:
  `docs/ARM64_CAPSULE_SETUP.md#packaged-launcher-interface`]. Start time
  `ABSENT — do not invent`.

<a id="microvm"></a>
### MicroVM

Answers: what is a MicroVM capsule; can the AI run shell commands; what does
Rewind need.

- **Isolates:** a Firecracker guest on ARM64 KVM. Commands run as guest UID
  10000 inside the guest, not on the host
  ([ARM64_GUEST_COMMANDS.md](ARM64_GUEST_COMMANDS.md)). No graphical desktop,
  no SSH, not an interactive PTY.
- **Person and agent:** both send commands through the core
  (`core/src/serve/guest_command.rs`); the SDK entry is
  `metaviewer_agents.guest_command.GuestCommandSession`. Neither supplies host
  paths, images or resource overrides.
- **Core sees:** each command request, acceptance, result, cancel and stop,
  with owner and generation.
- **Rewind:** see [9](#rewind).
- **Cost:** same guardian scope as the VM [TARGET]. A Back restore took
  387.5 ms as shown by the app [MEASURED: operator live run on ARM64, 4 Nov
  2026; raw receipt not in this repository].

<a id="choose-a-kind"></a>
## 4. Which kind to choose

Answers: which capsule should I use for a website; for a desktop app; for
shell commands; when is Host program acceptable.

| Task | Choose | Because |
| --- | --- | --- |
| A website, with a separate login per identity | Identity browser | Container per identity, persistent profile, network mode per profile |
| A Linux GUI program you can put in an image | Program | Container boundary, same rules as browsers |
| A program already installed on your computer, trusted | Host program | No image needed; **not isolated** |
| A window that is already open | Desktop window | Attach without restart; **not isolated**, real pointer |
| A whole graphical Linux system, ARM64 | ARM64 VM | Guest boundary |
| Shell commands an agent may get wrong, with undo, ARM64 | MicroVM with Rewind | Guest boundary plus checkpoints |

<a id="alternatives"></a>
## 5. Compared with what an agent builder would otherwise use

Answers: why not computer use on a plain desktop; why not one browser with
many tabs; why not Docker; why not one VM per task; why not a remote desktop.

No head-to-head numbers were measured; each row is a design comparison read
from the code, not a benchmark. Comparative performance:
`ABSENT — do not invent`.

| Alternative | What it gains | What it loses that a capsule keeps |
| --- | --- | --- |
| Plain desktop with computer use | Zero setup; every app at once | One shared screen and pointer: a click can land in the wrong window; no per-app owner; no proof the screenshot is still current when the click lands; the person and the agent fight for one mouse |
| One browser, many tabs | Cheap; one process | Tabs share a profile, cookies and process; one tab's login or crash affects the others; only the visible tab has fresh pixels; no per-tab ownership |
| Containers alone (Docker) | Process and file isolation | No live picture, no human takeover, no frame-bound admission, no journal of what the agent did; MetaViewer uses containers as one boundary and adds those |
| One VM per task | Strong boundary, snapshots | Heavy per task; still one screen per VM; snapshot alone does not say which action was admitted on which frame. MetaViewer offers VM and MicroVM where KVM exists (ARM64 only here) |
| Remote desktop (VNC, RDP) | Remote viewing and control | A pixel stream with no authority: anyone connected can type; nothing refuses a stale or unowned action; no journal |

What MetaViewer loses in exchange: setup cost (Docker, images, RAM floor,
KVM for guests), Linux only, and Host program and Desktop window do not give
isolation at all.

<a id="separation"></a>
## 6. Rendering, execution and authority are separate

Answers: why is the UI not allowed to inject input; who decides whether an
action happens; what happens if the UI crashes.

| Role | Process | May | May not |
| --- | --- | --- | --- |
| Rendering | Electron UI (`ui/`) | Show verified frames; send intents | Inject input into capsules; read frame paths over IPC |
| Execution | Go daemon adapter (`daemon-adapter/`) | Start, stop and drive capsules after admission | Decide whether an agent action is allowed |
| Authority | Rust core (`core/`) | Admit or refuse; own ownership, budgets, journal order | Draw pixels or run programs |

Why: a bug or compromise in one part cannot grant itself the powers of
another. The UI cannot fake an agent action, the adapter cannot admit one,
and the core never touches pixels it has not verified. Details:
[ARCHITECTURE.md#process-and-transport-model](ARCHITECTURE.md#process-and-transport-model)
and [UI_ARCHITECTURE.md](UI_ARCHITECTURE.md).

<a id="frame-freshness"></a>
## 7. Frame freshness

Answers: what is STALE_FRAME; why was my agent action refused as stale; how
does MetaViewer know a screenshot is current.

Each frame is published once, immutable, with `(sha256, generation, width,
height)`. The core keeps the current frame per surface and refuses an older
or equal generation as `STALE_FRAME` (`core/src/serve/mod.rs:995-1006`). An
agent proposal carries `based_on_frame`; admission refuses it when the
surface has no frame, a refresh is pending, or the digest or generation
differs from the current one (`core/src/admission/mod.rs:1307-1321`). Three
layers verify the bytes before use: the adapter publisher, the core witness
reader (`core/src/serve/mod.rs:806-842`, 64 MiB cap [CITED: `core/src/serve/mod.rs:806`]) and the Electron
reader (`ui/electron/frameReader.js`).

Gain: admission compares the proposal with the latest accepted frame for that
surface and refuses it while a refresh is pending. This does not prove the
screen stayed unchanged between capture and input delivery. Cost: a slow agent
sees more refusals and must observe again [CITED: `core/src/admission/mod.rs:1307`].

<a id="journal-and-replay"></a>
## 8. Journal and replay

Live game and Rewind results below are **maintainer-reported**, not reproduced
here. Session receipts and video takes are not published in this repository;
their public location is `ABSENT — do not invent`. Numeric live results are
[CITED: README.md, maintainer report only], not independent verification.

Answers: what does the journal record; how do I verify a session; why does
mv-replay say Invalid; what happens when the journal is full.

The core appends every admission, refusal and outcome to a hash-chained
journal; each record carries the previous record's SHA-256
([ARCHITECTURE.md#core-authority-and-replay](ARCHITECTURE.md#core-authority-and-replay)).
`mv-replay --journal <file> --witness-root <dir> [--verify-only]` rebuilds
state offline and prints its digest (`core/src/bin/mv-replay.rs:1-45`); exit
2 is invalid input, 3 duplicate evidence, 4 witness failure.

| Observation | Meaning |
| --- | --- |
| `mv-replay` rc=0 on a Rewind session journal | [CITED: README.md, maintainer report; receipts absent] |
| `Invalid` with a relative, symlinked or copied session path | Give absolute real paths to the original session directory [CITED: README.md, maintainer report; receipts absent] |
| `JOURNAL_FULL` | Admission closes for that session for good; accepted records stay replayable; start a fresh session for long runs ([JOURNAL_END.md](JOURNAL_END.md), `core/src/serve/journal_end.rs:128`) |

Gain: a judge can check what the agent was allowed to do without trusting the
agent's own log.

<a id="rewind"></a>
## 9. Rewind

Answers: what does Rewind restore; can Rewind undo a network request; is
there rewind on x64.

Rewind exists for the ARM64 MicroVM only. Mark seals full guest memory and
machine state into a RAM checkpoint; Back pauses the guest, restores the
checkpoint and resumes. Routing is authenticated in the core
(`core/src/serve/rewind.rs:1`); the journal, request history and restore
authority do not travel backwards.

| Fact | Tag |
| --- | --- |
| 3 files created, deleted, Back restored all 3 | [CITED: README.md, maintainer report; receipts absent] |
| Restore shown by the app: 387.5 ms | [CITED: README.md, same maintainer report; receipts absent] |
| `mv-replay` rc=0 on that session journal | [CITED: README.md, same maintainer report; receipts absent] |
| Network effects, host changes, anything outside the guest | Not restored ([ARM64_MICROVM_REWIND.md](ARM64_MICROVM_REWIND.md)) |
| x64 rewind | Not available |

Checkpoints are local, disposable and disappear when the session closes.
Setup: [ARM64_CAPSULE_SETUP.md#rewind-in-the-normal-wall](ARM64_CAPSULE_SETUP.md#rewind-in-the-normal-wall).

<a id="refusal-is-a-feature"></a>
## 10. Why a refusal is a feature

Answers: why did MetaViewer refuse my action; is a refusal a bug; how do I
explain a refusal to a judge.

A pre-dispatch admission refusal means the proposed input was not sent. A
post-dispatch uncertain result is different: input may already have reached
the application. For example, a focus click can be delivered before typing is
refused, and `mw_run_program` preserves the result as `INPUT_UNCERTAIN`
[CITED: `tools/mw_run_program.py:1283`]. Observe and reconcile the actual state;
do not replay the whole step or assume no effect.

| Code | What the core could not prove | Coordinate |
| --- | --- | --- |
| `STALE_FRAME` | The proposal matches the latest accepted frame, with no refresh pending | `core/src/admission/mod.rs:1316-1321` |
| `SURFACE_NOT_AGENT_CONTROLLED` | The agent owns this surface now (human took control, or it is not live) | `core/src/admission/mod.rs:1313-1315` |
| `LOCKED_BY_OTHER` | No other action holds the display | `core/src/admission/mod.rs:1322-1331` |
| `BUDGET_EXCEEDED` | The session still has budget, retries and time | [ARCHITECTURE.md#core-authority-and-replay](ARCHITECTURE.md#core-authority-and-replay) |
| `POLICY` | The operation is supported for this sender and state | same |
| `INPUT_UNCERTAIN` | Delivery or its effect could not be confirmed; some input may already have occurred | `tools/mw_run_program.py:1283` |
| `JOURNAL_FULL` | The session can still record what happens | [JOURNAL_END.md](JOURNAL_END.md) |

Worked example: a game driven by a scripted model loop, each key verified by
the core, reached 40 of 42 verified steps in one run with 2 reported
`INPUT_UNCERTAIN` [CITED: README.md, maintainer report; receipts absent]. The two
uncertain steps were reported as uncertain, not counted as success.

To explain a refusal: name the code, whether dispatch occurred or remains
uncertain, the fact that could not be proved, and the cited line; then observe
and reconcile before planning another action. The full code list belongs to the
generated error reference linked from [docs/README.md](README.md).

<a id="limits"></a>
## 11. What this document does not claim

Answers: what is not proven; which known bugs touch capsules.

- Host program and Desktop window are not isolated.
- No x64 VM, x64 MicroVM or x64 rewind.
- Per-kind start times and resident memory: `ABSENT — do not invent`.
- Head-to-head comparison with the alternatives in [5](#alternatives):
  `ABSENT — do not invent`.
- Isolation inside the private OpenSuperficies and VM executors is a boundary
  contract; their source is private ([NOTICE-EVALUATION.md](../NOTICE-EVALUATION.md)).
- Open bug: after `mw_run` the package gains `__pycache__` and `--arm64` then
  holds with "exhaustive manifest inventory"; workaround: remove the bytecode
  directories from the package [CITED: README.md, maintainer report; receipts absent].
- Open bug: a paired terminal exited after a very long typed line; cause
  unknown [CITED: README.md, maintainer report; receipts absent].
- Not run while writing this document: no capsule, VM or MicroVM was started
  here (the writing host had no KVM and no Docker daemon); every coordinate
  was read, not executed.

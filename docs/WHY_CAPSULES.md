# Why capsules

A capsule gives a running application an addressable surface, explicit control
ownership and a record of admitted actions. It lets a person and an agent work
against named targets on the same wall. The execution boundary depends on the
kind: **Host program and Desktop window are not isolated**.

The source citations below describe implemented checks, not live qualification.
Private executor internals cannot be audited from this checkout. See
[NOTICE-EVALUATION.md](../NOTICE-EVALUATION.md) for that boundary.

<a id="reading-map"></a>
## 0. Reading map

Start with the design reason, then choose an execution boundary and read its
limits before running an agent.

Answers: where should I start reading about capsules?

| Question | Section |
| --- | --- |
| Why make applications into capsules? | [Short answer](#short-answer) |
| What do the terms mean? | [Terms](#terms) |
| Which kind fits my task? | [Kinds](#kinds), [selection](#choose-a-kind) |
| What does this add to other approaches? | [Alternatives](#alternatives) |
| Who decides whether input is allowed? | [Authority](#separation), [freshness](#frame-freshness) |
| What can I check afterwards? | [Journal](#journal-and-replay), [refusals](#refusal-is-a-feature) |
| What can be restored or remains unproved? | [Rewind](#rewind), [limits](#limits) |

For operation, use [AI_OPERATOR_GUIDE.md](AI_OPERATOR_GUIDE.md). For process and
wire details, use [ARCHITECTURE.md](ARCHITECTURE.md).

<a id="short-answer"></a>
## 1. Why capsules exist: the short answer

Capsules make the target, control owner and evidence for an action explicit.
They are useful for computer use because a click needs more context than a
coordinate: which application, who controls it, and which observed state the
agent used to choose that click.

Answers: why does MetaViewer use capsules instead of giving an agent the desktop?

| Need | Implemented check | Cost or limit |
| --- | --- | --- |
| Address the intended application | Proposals name a surface; the core checks its owner and live state | A valid target still needs a configured native executor |
| Act on current evidence | Admission and dispatch compare the frame digest and generation and reject a pending refresh | The application can still change after capture |
| Share control with a person | Take control cancels undispatched work; dispatched or unknown work must drain | Takeover cannot undo an input already delivered |
| Audit the decision | The core records admitted state transitions and their witnesses for replay | A consistent journal does not prove that a semantic task succeeded |

Evidence: [CITED: `core/src/admission/mod.rs:1262`, `core/src/admission/mod.rs:1307`, `core/src/admission/mod.rs:1514`, `core/src/serve/mod.rs:1791`].

This gives an agent builder a common admission boundary across applications.
It also introduces setup, capture, verification and storage work. Capsules do
not turn every executor into a sandbox or every application into a reliable API.

<a id="terms"></a>
## 2. Terms used once

A capsule is the running workload; its surface is the identity the core uses to
address it; its tile is the wall's presentation of it.

Answers: what are capsule, surface, tile, frame and journal?

| Term | Meaning |
| --- | --- |
| Capsule | A running workload managed through an executor; its boundary can be a container, guest or host process |
| Surface | Core-visible target with an identity, lifecycle, owner and frame state |
| Tile | UI presentation of a surface; layout does not grant input authority |
| Frame | Captured pixels with geometry, digest and generation used for admission |
| Core | Rust authority over admission and recorded state transitions |
| Adapter | Go bridge to native lifecycle, input and capture operations |
| Journal | Ordered session archive with state transitions and retained evidence |
| Refusal | A typed rejection; its meaning depends on whether dispatch already occurred |

Evidence: [CITED: `core/src/admission/mod.rs`, `core/src/serve/layout.rs`, `daemon-adapter/internal/capsule/manager.go`, `core/src/journal/mod.rs`].

<a id="kinds"></a>
## 3. The capsule kinds

Choose a kind by where the workload runs, not by how its tile looks. The
launcher exposes the kinds below; guest choices depend on host capability and
protected setup [CITED: `ui/src/catalog/catalogModel.js:98`, `ui/electron/guestCommandProfile.js:47`].

Answers: what does each capsule kind give me, and what does it cost?

| Kind | Execution boundary | Benefit | Cost or exposure |
| --- | --- | --- | --- |
| [Identity browser](#identity-browser) | Private browser-container executor | Separate persistent identity and browser workload | Runtime, image, profile and network setup; signed-in data remains sensitive |
| [Program](#program) | Private program-container executor | Graphical program behind the same surface admission model | Program must be admitted and available in the image |
| [Host program](#host-program) | Host process with Xpra presentation | Use an installed host binary | **Not isolated**; host files and permissions remain relevant |
| [Desktop window](#desktop-window) | Existing host window | Attach an already running application | **Not isolated**; input affects the real window |
| [ARM64 VM](#arm64-vm) | Graphical guest executor | Work inside a guest desktop | Supported host, KVM and protected guest assets |
| [MicroVM](#microvm) | Guest command runtime | Bounded command sessions with guest lifecycle and Rewind support | Supported host, KVM and protected assets; no graphical observation stream |

The public adapter validates kind/profile/geometry mappings before a native
start [CITED: `daemon-adapter/internal/capsule/manager.go:395`, `daemon-adapter/internal/capsule/manager.go:818`]. Its validation is not a proof
of the private runtime's containment internals.

<a id="identity-browser"></a>
### Identity browser

An Identity browser uses a configured browser profile through the private
container executor. Profile data and live surface ownership are separate:
losing a frame does not establish that an identity is free.

Answers: why use an Identity browser, and where is its persistent state?

Stopped profile slots can carry credentials and signed-in sessions. The slot
store requires human confirmation and custody checks; it does not save a live
browser process. Evidence: [CITED: `daemon-adapter/internal/capsule/slots/store.go:274`].

The picker uses a container memory limit of 4 GiB and shared-memory limit of
2 GiB, with a combined free-memory admission threshold of 6 GiB [CITED: `ui/electron/profilePicker.js:48`]. These are configured limits, not measured
resident memory or startup time. A login wall or bot check requires the person
at the controls; see [handoff](REFERENCE.md#handoff).

<a id="program"></a>
### Program

Program runs an admitted graphical program through the private program-container
executor. Use it when the application belongs in that image rather than in the
host environment.

Answers: how is Program different from Host program?

The adapter requires the program mapping before starting it [CITED: `daemon-adapter/internal/capsule/manager.go:400`]. Container setup and compatible
application assets are required. Importing files or allowing network access
creates effects outside a purely local task; the tile does not erase them.

<a id="host-program"></a>
### Host program

Host program runs a host binary through the Xpra route. It is **not isolated**.

Answers: why offer a host route, and what does it expose?

It lets an installed application participate in the wall without putting that
binary in a container image. The process retains its host permissions. A
separate display is presentation, not filesystem or network containment.
Evidence: [CITED: `ui/src/catalog/catalogModel.js:117`, `daemon-adapter/internal/capsule/manager.go:805`].

<a id="desktop-window"></a>
### Desktop window

Desktop window attaches an existing X11 window. It is **not isolated**, and
input can affect the real application and pointer.

Answers: can I attach an existing window safely as though it were a container?

Use this route only with the intended host window. Native Wayland windows are
not listed by this launcher [CITED: `ui/src/catalog/catalogModel.js:125`]. A
verified frame does not remove the host exposure of attachment.

<a id="arm64-vm"></a>
### ARM64 VM

The graphical VM route presents a configured guest display. Availability is
conditional on supported host setup; it is not inferred from a successful
cross-build [CITED: `ui/electron/guestCommandProfile.js:47`].

Answers: when should I use the graphical VM?

Use it for work that needs a guest desktop and graphical observations. Guest
assets and the private executor are additional prerequisites. Follow
[ARM64_CAPSULE_SETUP.md](ARM64_CAPSULE_SETUP.md); source inspection alone does
not qualify the deployed guest.

<a id="microvm"></a>
### MicroVM

MicroVM provides guest command sessions with a lifecycle distinct from graphical
surface input [CITED: `core/src/serve/guest_command.rs`].

Answers: what does MicroVM add if it is not a graphical application?

It provides a guest execution boundary for commands and a place to restore guest
state with Rewind. Command output is not a captured desktop frame. See
[ARM64_GUEST_COMMANDS.md](ARM64_GUEST_COMMANDS.md) and
[ARM64_MICROVM_REWIND.md](ARM64_MICROVM_REWIND.md).

<a id="choose-a-kind"></a>
## 4. Which kind to choose

Use the narrowest available execution environment that contains the task's
required application and data.

Answers: which capsule kind fits my task?

| Task requirement | Candidate | Check first |
| --- | --- | --- |
| Separate browser identity | Identity browser | Profile custody, runtime and network configuration |
| Graphical program available in an image | Program | Admitted program mapping and image contents |
| Installed host binary | Host program | Host exposure is acceptable |
| Already open X11 application | Desktop window | Correct window and real pointer effects |
| Guest graphical desktop | ARM64 VM | Host capability and protected setup |
| Guest commands or guest checkpoint restore | MicroVM | Command/runtime availability and restore scope |

<a id="alternatives"></a>
## 5. Compared with what an agent builder would otherwise use

MetaViewer adds a common control and evidence model around workloads. The
comparison is about that model, not measured superiority over other products.

Answers: what do capsules add to tabs, containers, VMs or remote desktops?

| Approach | What MetaViewer adds | What it still depends on |
| --- | --- | --- |
| Direct desktop control | Named surfaces and explicit control ownership | Correct host targeting and careful treatment of external effects |
| Browser tabs | A workload/profile boundary separate from wall layout | Browser and account behavior |
| Containers | Shared admission, frame checks and a journal around native execution | Runtime configuration and private executor behavior |
| VM per task | A common wall and control protocol for guest and other workloads | Guest provisioning and host resources |
| Remote desktop | Frame-bound proposals and core admission in addition to pixels/input | The display transport and target application |

Head-to-head reliability, performance and containment benchmarks are
**ABSENT — do not invent**. A different tool may be simpler when the task only
needs a narrow application API.

<a id="separation"></a>
## 6. Rendering, execution and authority are separate

The UI presents and requests, the core admits, and the adapter executes. This
keeps moving a tile separate from permission to send input.

Answers: why not let the renderer or the agent inject input directly?

The core can apply the same ownership, frame, lease and budget checks to agent
proposals before native execution [CITED: `core/src/admission/mod.rs:1307`].
Layout requests have a separate path [CITED: `core/src/serve/layout.rs:29`].
The UI's appearance is therefore not evidence of authority.

This is a protocol boundary between cooperating processes. It is not containment
against a compromised process with the same host-user privileges, nor a reason
to trust untrusted screen text as instructions.

<a id="frame-freshness"></a>
## 7. Frame freshness

A proposal must match the latest accepted digest and generation for its surface,
with no refresh pending. The core checks this before admission and again for
dispatch [CITED: `core/src/admission/mod.rs:1307`].

Answers: what does a fresh frame prove?

It binds the proposal to the core's accepted observation. It does **not** prove
that the application stayed unchanged between capture and input delivery.
Pixel integrity and task meaning are also separate: a correct digest proves
which bytes were checked, not that a button has the intended effect.

A stale proposal is refused as `STALE_FRAME`. Observe again and plan from the
new state. Do not blindly reuse the old coordinates.

<a id="journal-and-replay"></a>
## 8. Journal and replay

The journal lets a reader reconstruct the core's recorded decisions and inspect
the evidence retained for them. It does not rerun the application.

Answers: what can a judge verify after a session?

The archive binds ordered records, state transitions and witnesses; the scanner
checks those relationships [CITED: `core/src/journal/mod.rs:3123`, `core/src/journal/mod.rs:3867`]. Keep the session archive together: journal text
alone is not the complete replay input.

```bash
mv-replay --journal <session-journal> --witness-root <session-root> --verify-only
```

The command exits nonzero on invalid input, duplicate evidence or witness failure
[CITED: `core/src/bin/mv-replay.rs:42`]. A successful scan establishes consistency
of the supplied archive, not independent authenticity of its origin or semantic
task completion. When session capacity is exhausted, `JOURNAL_FULL` closes new
work and requests a fresh session [CITED: `core/src/serve/journal_end.rs:128`].

<a id="rewind"></a>
## 9. Rewind

Rewind restores supported MicroVM guest state through an authenticated restore
path. It does not rewind the core's journal, host state or external services.

Answers: what can Back undo?

A guest checkpoint can recover guest-local work. It cannot retract a network
request, an external write or an input already delivered outside that guest.
The core keeps restore authority and recorded history moving forward [CITED: `core/src/serve/rewind.rs`, `core/src/rewind_flow.rs`]. Protected runtime setup is
required; follow [ARM64_MICROVM_REWIND.md](ARM64_MICROVM_REWIND.md).

Live Rewind results are maintainer-reported; their session receipts are not
published in this checkout. Publicly reproducible live performance is
**ABSENT — do not invent**.

<a id="refusal-is-a-feature"></a>
## 10. Why a refusal is a feature

A refusal tells the caller which required fact could not be established. Keeping
that result explicit prevents missing evidence from becoming apparent success.

Answers: how should an agent handle a refusal or uncertain result?

| Result | Meaning | Next action |
| --- | --- | --- |
| `STALE_FRAME` | Accepted observation no longer matches | Observe and plan again |
| `SURFACE_NOT_AGENT_CONTROLLED` | Owner or live state does not permit this agent | Check control and lifecycle |
| `LOCKED_BY_OTHER` | Surface/display lease conflicts | Wait for settlement and observe |
| `BUDGET_EXCEEDED` | Time or execution budget fails admission | Inspect the bound before new work |
| `POLICY` | Sender, operation or state is not admitted | Inspect the specific refusal |
| `INPUT_UNCERTAIN` | Input may already have reached the application | Observe and reconcile; do not replay the entire step |
| `JOURNAL_FULL` | Session cannot admit further recorded work | Start a fresh session after cleanup |

Admission evidence: [CITED: `core/src/admission/mod.rs:1307`]. Uncertainty
handling: [CITED: `tools/mw_run_program.py:1283`, `agents/metaviewer_agents/mw_refusals.py:36`].

For example, a focus click may be delivered before typing fails. The program
runner preserves `INPUT_UNCERTAIN` instead of calling the combined step a clean
refusal [CITED: `tools/mw_run_program.py:1283`]. That distinction is why counting
accepted inputs is not enough to claim a successful task.

<a id="limits"></a>
## 11. What this document does not claim

The public source establishes admission and adapter behavior. It does not prove
private executor internals, live platform qualification or a task's semantic
success.

Answers: where should a skeptical engineer withhold confidence?

- Host routes retain host exposure.
- Guest routes require supported architecture and protected assets.
- Startup time, resident memory and comparative reliability need measured runs.
- Same-user process compromise is outside the admission protocol's containment.
- Live results without published receipts remain maintainer reports.

The mandate of this document is limited to the cited public repository and
explicitly attributed reports.

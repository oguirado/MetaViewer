```json
{
  "schema": "metaviewer.reference/v1",
  "version": "0.2.6",
  "status": "source-reference; live qualification is separate",
  "licence": "AGPL-3.0-only",
  "private_components": ["wender-agent", "vision-engine", "OpenSuperficies"],
  "canonical_anchors": ["reading-map", "result-contract", "definitions", "architecture", "engineering-triptych", "domain-contracts", "limits", "reproducibility"],
  "date": "2026-11-04",
  "evidence": {
    "schema": "[CITED: tests/test_reference_docs.py] required document format",
    "version": "[MEASURED] VERSION:1",
    "date": "[CITED] reference publication date; not a runtime measurement",
    "licence": "[MEASURED] ui/package.json:4",
    "private_components": "[CITED] NOTICE-EVALUATION.md private-source boundary; pins in deps.lock:1"
  }
}
```

<a id="reading-map"></a>
## 0. Reading map and prerequisites [TARGET]

Read the design reason, choose the execution boundary, then verify the specific
operation against code and its tests. This reference connects those steps.

Answers: where should a judge, operator or agent start?

| Question | Read next |
| --- | --- |
| Why capsules and computer use? | [Design rationale](WHY_CAPSULES.md) |
| What can the public source establish? | [Result contract](#result-contract), [limits](#limits) |
| Which kind fits a workload? | [Domain table](#domain-contracts) |
| How does an agent operate the app? | [AI operator guide](AI_OPERATOR_GUIDE.md), [handoff](#handoff) |
| How do I check a claim? | [Oracle](#oracle), [evidence](#evidence) |
| How do I run a judge evaluation? | [Quickstart](JUDGE_QUICKSTART.md), [tour](#tour) |

<a id="prerequisites"></a>
### Prerequisites matrix

A route is available only when its own dependencies and admission checks pass.
Missing dependencies are not evidence of successful fallback.

Answers: what must exist before a route can work?

| Route | Required boundary | Source |
| --- | --- | --- |
| Public-source checks | Local toolchains and dependencies for the selected test | `tools/gate.sh` |
| Browser or Program | Configured private runtime, profile and compatible image | `daemon-adapter/internal/daemon/environment.go` |
| Host program/window | Intended host process or X11 window | `ui/src/catalog/catalogModel.js` |
| Guest routes | Supported architecture and protected host setup | `ui/electron/guestCommandProfile.js` |

[CITED: paths in the table]. See [INSTALL.md](INSTALL.md) and
[ARM64_CAPSULE_SETUP.md](ARM64_CAPSULE_SETUP.md) for setup.

<a id="persona-tracks"></a>
### Persona reading tracks

Choose a reading path according to the claim you need to evaluate.

Answers: which sections belong to my review?

| Reader | Path |
| --- | --- |
| Judge | [Result](#result-contract) → [limits](#limits) → [tour](#tour) |
| Agent developer | [Authority](#authority) → [architecture](#architecture) → [oracle](#oracle) |
| Operator | [Domains](#domain-contracts) → [handoff](#handoff) → [stop](#stop) |
| Security reviewer | [Private boundary](#private-boundary) → [slots](#stored-data-slots) → [negative knowledge](#negative-knowledge) |

<a id="notation"></a>
### Notation index

Evidence tags distinguish inspected code, attributed reports and intended
behavior; none silently means live qualification.

Answers: how should I interpret evidence and identifiers?

| Notation | Meaning |
| --- | --- |
| `[MEASURED]` | A named inspection, count or executed check; read its stated scope |
| `[CITED: path]` | Claim supported by the named source; source code is not a live run |
| `[TARGET]` | Intended bound or structure |
| `ABSENT — do not invent` | Required evidence is unavailable; absence is not success or zero |
| `surface_id` / `profile_id` | Live target / persistent identity; not interchangeable |
| `generation` / `sha256` | Accepted frame generation / byte digest |
| `epoch` | Authority or executor incarnation used to reject obsolete evidence |

<a id="result-contract"></a>
## 1. Abstract and result contract [TARGET]

MetaViewer presents capsule workloads on a wall and places core admission
between an agent proposal and execution. It records decisions and outcomes;
it does not guarantee that the requested task succeeds.

Answers: what result does the public implementation promise to check?

| Input or output | Meaning | Evidence |
| --- | --- | --- |
| Proposal | A request bound to a surface, frame and budget | [CITED: `core/src/admission/mod.rs:1307`] |
| Admission/refusal | Current authority permits or rejects that request | [CITED: `core/src/admission/mod.rs:1490`] |
| Execution evidence | Input and subsequent observations used for verification | [CITED: `core/src/verify/mod.rs:32`] |
| Session archive | Ordered state transitions and retained witnesses | [CITED: `core/src/journal/mod.rs:3123`] |

[CITED: coordinates in the table]. The checkout version is defined by `VERSION`
[MEASURED: `VERSION:1`]. This document does not qualify a separately built or
published package merely because its version label matches.

<a id="definitions"></a>
## 2. Definitions, validity and bounds [TARGET]

A surface identity, an execution boundary and a control owner answer different
questions. Treating them as equivalent leads to unsafe claims about isolation
or permission.

Answers: which distinctions matter when operating a capsule?

<a id="capsule-kinds"></a>
### Capsule kinds

User-facing kinds describe how a workload is opened; internal schema kinds and
native executor kinds are routing identities, not extra isolation guarantees.

Answers: which kinds appear in the launcher?

The launcher offers Identity browser, Program, Host program, Desktop window,
ARM64 VM and MicroVM [CITED: `ui/src/catalog/catalogModel.js:98`]. Availability
filters guest routes by capability [CITED: `ui/src/catalog/catalogModel.js:150`]. See [domains](#domain-contracts).

<a id="authority"></a>
### Authority core and roles

The core checks current ownership, lifecycle, frame identity, leases and budget
before admitting and dispatching an agent proposal.

Answers: what prevents a stale or unauthorized proposal from executing?

The checks reject an owner mismatch, pending refresh, changed digest/generation
and conflicting surface/display lease [CITED: `core/src/admission/mod.rs:1307`]. Takeover cancels undispatched work; dispatched or unknown
work can remain draining [CITED: `core/src/admission/mod.rs:1262`, `core/src/serve/mod.rs:1791`]. These are protocol
checks, not containment against a compromised process with the same host-user
privileges.

<a id="handoff"></a>
### Handoff

A login wall or bot check stops the workflow for the person at the controls.
Take control, handle the prompt manually, release control and explicitly re-run.

Answers: what happens when the workflow needs human input?

Acknowledging the notice only hides it; it does not resume execution. Failed or
missing handoff reads do not clear pending notices [CITED: `ui/src/handoff/handoffModel.js:11`, `ui/src/handoff/handoffModel.js:36`].

<a id="identity"></a>
### Identity

A profile represents persistent native data; a surface represents a live target.
Losing a frame does not prove that the profile or native process is free.

Answers: can a missing surface be reused immediately?

Lost bindings retain custody until a verified stop releases it [CITED: `daemon-adapter/internal/capsule/manager.go:862`]. Profile data operations have
separate custody checks [CITED: `daemon-adapter/internal/capsule/slots/store.go:274`].

<a id="stored-data-slots"></a>
### Stored data slots

Slots preserve compatible stopped Browser/Program profile data, including
credentials; they are not snapshots of running processes or a whole machine.

Answers: what does saving a slot preserve, and who may copy it?

The store requires human confirmation, refuses protected identities and checks
kind, image and architecture before load [CITED: `daemon-adapter/internal/capsule/slots/store.go:274`, `daemon-adapter/internal/capsule/slots/store.go:647`]. Treat slot payloads as
private data, not shareable fixtures.

<a id="rewind"></a>
### Rewind

Rewind restores supported guest state while authority history continues forward.
It cannot retract effects already sent to external systems.

Answers: is Back a rollback of the host and the journal?

No. Guest restore and core authority have separate lifecycles [CITED: `core/src/rewind_flow.rs`, `core/src/serve/rewind.rs`]. See
[ARM64_MICROVM_REWIND.md](ARM64_MICROVM_REWIND.md) for the protected setup and
boundary. Reported live results are maintainer reports; their raw receipts are
not published here.

<a id="grid"></a>
### Grid

The wall grid arranges surfaces; moving or folding a tile does not grant input
authority or create a new execution session.

Answers: does rearranging a tile affect its workload or owner?

Layout does not create, stop or rebind terminal sessions [CITED: `core/src/serve/layout.rs:1`]. Authority changes use the separate takeover path.

<a id="transport-bounds"></a>
### Transport validity and bounds

Transport limits constrain messages; they are not throughput or concurrency
measurements.

Answers: what stops oversized or indefinitely incomplete adapter messages?

The adapter validates explicit positive limits and deadlines. It caps frame
bytes at 1048576, nesting depth at 32, strings at 65536 bytes, keys at 256 and array items at 4096 [CITED: `daemon-adapter/internal/ipc/config.go:20`]. The hello
and read deadlines are also bounded by configuration validation [CITED: `daemon-adapter/internal/ipc/config.go:23`]. A valid message still needs admission.

<a id="admission-laws"></a>
### Admission laws

Repository changes follow the maintainer's authorship, contract, privacy and
verification rules.

Answers: which rules govern changes to this implementation?

Read [LAWS.md](../LAWS.md): schemas precede producers, tests are not weakened,
fixtures are synthetic or scrubbed, and the maintainer controls publication
[CITED: `LAWS.md`]. These contribution rules are distinct from runtime admission.

<a id="verification-gates"></a>
### Verification gates and failure meanings

Run the test that owns the claim, then the required aggregate checks for the
change. A passing structural document test does not establish semantic truth.

Answers: which checks distinguish document correctness from runtime behavior?

| Check | Command | Scope |
| --- | --- | --- |
| Documentation | `python3 -B -m unittest discover -s tests -p 'test_*doc*'` | Required text, anchors and coordinate structure |
| Contracts | `python3 tools/check_contracts.py` | Schema and fixture agreement |
| Aggregate | `bash tools/gate.sh` | Public implementation checks and build legs |
| Gate controls | `bash tools/gate.sh --self-test` | Gate behavior against negative fixtures |
| Routing | `python3 route/route_query.py check` | Freshness of the document routing index |

[CITED: `tests/test_reference_docs.py`, `tools/check_contracts.py`, `tools/gate.sh`, `route/route_query.py`]. Use the bounded execution form under
[oracle](#oracle). Index rebuilding belongs to the integration owner.

<a id="architecture"></a>
## 3. Architecture map [TARGET]

Electron presents the wall, Rust owns admission and recorded state, and the Go
adapter invokes native operations. Agent tools use that authority boundary.

Answers: where should I inspect each part of the implementation?

| Concern | Public source |
| --- | --- |
| Wall presentation | `ui/src/App.vue`, `ui/src/wall/WallWorkspace.vue` |
| Renderer/native boundary | `ui/electron/preload.js`, `ui/electron/hostBindings.js` |
| Admission | `core/src/admission/mod.rs` |
| Lifecycle and tool routing | `core/src/serve/mod.rs`, `core/src/serve/tools.rs` |
| Native target validation | `daemon-adapter/internal/capsule/manager.go` |
| Capture publication | `daemon-adapter/internal/frames/publisher.go` |
| Agent integration | `agents/metaviewer_agents/tools.py`, `agents/metaviewer_agents/mcp_server.py` |
| Archive and replay | `core/src/journal/mod.rs`, `core/src/bin/mv-replay.rs` |

[CITED: paths in the table]. Read [ARCHITECTURE.md](ARCHITECTURE.md) for control
flow and [UI_ARCHITECTURE.md](UI_ARCHITECTURE.md) for the UI.

<a id="private-boundary"></a>
### Private binaries boundary

The public checkout proves how MetaViewer calls private programs; it does not
publish or prove their internals.

Answers: what can a judge audit without the private repositories?

`wender-agent`, `vision-engine` and `OpenSuperficies` are private, separate
programs. Their pins are in `deps.lock`. Rights to evaluate supplied compiled
components are defined in [NOTICE-EVALUATION.md](../NOTICE-EVALUATION.md)
[CITED: `NOTICE-EVALUATION.md`, `deps.lock`]. Fake executor tests exercise the
public seam; they do not qualify an installed private binary.

<a id="engineering-triptych"></a>
## 4. Engineering triptych [TARGET]

Evaluate a claim by the evidence it needs, the observation that would falsify
it, and the check that distinguishes those outcomes.

Answers: how can a skeptical reader test the design argument?

<a id="epistemic-contract"></a>
### Panel A — epistemic contract

A stale frame is a concrete pre-dispatch refusal, not a claim about task success.

Answers: what is a checkable example of admission doing useful work?

If a proposal's digest or generation differs from the surface's accepted frame,
`CoreState::check` returns `STALE_FRAME` [CITED: `core/src/admission/mod.rs:1316`]. The transition is appended before replacing
current state [CITED: `core/src/admission/mod.rs:1514`]. A test can change the
frame and verify refusal without trusting an agent's narrative.

A later `INPUT_UNCERTAIN` result has different meaning: input may already have
been delivered. The program runner preserves that result even if typing was
refused after a delivered focus click [CITED: `tools/mw_run_program.py:1283`].
Observe and reconcile before considering another input.

<a id="negative-knowledge"></a>
### Panel B — negative knowledge

Several plausible-looking observations are insufficient to establish the claim
an operator actually cares about.

Answers: which shortcuts would overstate the evidence?

| Observation | Does not prove | Missing check |
| --- | --- | --- |
| Tile is visible | Agent owns its input | Current authority and role |
| Frame digest matches | Screen stayed unchanged until delivery | Subsequent observation and outcome |
| Input receipt succeeds | Semantic goal succeeded | Goal-specific verification |
| Journal scans successfully | Independent authenticity of its origin | Separately trusted evidence or protected anchor |
| Cross-build passes | Target host runs the assembled product | Live platform receipt |
| Host program is on the wall | Process is isolated | Actual execution boundary |

Evidence boundaries: [CITED: `core/src/admission/mod.rs:1307`, `core/src/verify/mod.rs:32`, `core/src/bin/mv-replay.rs:28`, `ui/src/catalog/catalogModel.js:117`].

<a id="oracle"></a>
### Panel C — reference usage and oracle

Public checks validate source behavior and document structure; live evaluation
requires the actual runtime and an attributed receipt.

Answers: what commands can reproduce the public checks?

Run from the repository root with the documented dependencies available.
Heavy checks use the bounded scope below; the memory limits are execution
choices, not measured product requirements [TARGET].

```bash
python3 -B -m unittest discover -s tests -p 'test_*doc*'
python3 tools/check_contracts.py
systemd-run --user --scope -p MemoryHigh=6G -p MemoryMax=8G -p MemorySwapMax=0 bash tools/gate.sh
systemd-run --user --scope -p MemoryHigh=6G -p MemoryMax=8G -p MemorySwapMax=0 bash tools/gate.sh --self-test
```

The reference tests deliberately remove anchors and tags and supply invalid
coordinates [CITED: `tests/test_reference_docs.py`]. They prove that this
structural check can reject bad input; they cannot prove that every cited line
entails the prose. Read that line and its governing test as well.

<a id="domain-contracts"></a>
## 5. Domain contracts per capsule kind [TARGET]

Choose the execution boundary before choosing how the wall presents it. Guest
capability, host exposure and profile storage remain distinct.

Answers: which surface gives which input and persistence contract?

| User-facing kind | Execution/input | Persistence and limit |
| --- | --- | --- |
| Identity browser | Private browser-container route; role-specific input | Stopped profile data can include credentials |
| Program | Private program-container route; admitted program | Compatible stopped profile slots; no running-process snapshot |
| Host program | Host Xpra route; **not isolated** | Host permissions and external effects remain |
| Desktop window | Existing X11 window; **not isolated** | Real window and pointer effects remain |
| ARM64 VM | Configured graphical guest | Protected setup; separate from profile slots |
| MicroVM | Guest commands, not graphical observations | Guest lifecycle and supported Rewind; external effects remain |

[CITED: `ui/src/catalog/catalogModel.js:98`, `daemon-adapter/internal/capsule/manager.go:818`, `daemon-adapter/internal/capsule/slots/store.go:274`, `ui/electron/guestCommandProfile.js:47`, `core/src/serve/guest_command.rs`].
Configured capability is not a live acceptance receipt. See
[WHY_CAPSULES.md](WHY_CAPSULES.md) for costs and alternatives.

<a id="limits"></a>
## 6. Applicability limits [TARGET]

The implementation checks admission and evidence within explicit boundaries.
It cannot certify every host, private runtime or semantic task from source alone.

Answers: what must remain qualified or unknown?

| Claim area | Limit |
| --- | --- |
| Isolation | Host routes are not isolated; private runtime internals are not published |
| Freshness | Matching accepted frame identity does not freeze the application |
| Restore | Guest Rewind does not retract host or external effects |
| Stored data | Slots require custody and compatible kind, image and architecture |
| Live results | Maintainer reports without public receipts are attributed reports |
| Performance | Per-kind startup time, resident memory and comparative reliability need measurements |

[CITED: `ui/src/catalog/catalogModel.js:117`, `core/src/admission/mod.rs:1316`, `core/src/rewind_flow.rs`, `daemon-adapter/internal/capsule/slots/store.go:647`].
Publicly reproducible live qualification outside supplied evidence is
**ABSENT — do not invent**.

<a id="reproducibility"></a>
## 7. Reproducibility [TARGET]

Reproduce the public tests from this checkout and evaluate a runtime only with
its matching assets, prerequisites and evidence.

Answers: how do I avoid confusing source verification with a live demo?

<a id="install"></a>
### Install and doctor

Follow the [judge quickstart](JUDGE_QUICKSTART.md) for packaged evaluation and
[ARM64 setup](ARM64_CAPSULE_SETUP.md) for the guest developer path.

Answers: which installation instructions apply to me?

Use the route-specific doctor before running workloads. Source test success
cannot replace missing images, private binaries, a display or protected guest
assets. Do not run installation as a documentation test.

<a id="tour"></a>
### Tour and result observation

The [judge tour](JUDGE_TOUR.md) demonstrates user gestures; evaluate its outcome
against the requested task rather than counting launched capsules or inputs.

Answers: what should a judge observe during a run?

Distinguish Human from Agent control, Program from Host program, and a verified
input from completed work. A handoff requires explicit release and re-run
[CITED: `ui/src/handoff/handoffModel.js:11`].

<a id="stop"></a>
### Stop and custody

Request cleanup through the documented launcher, then inspect its result.
A stop request is not proof that a native workload is gone.

Answers: when is it safe to reuse an identity?

Reconcile uncertain custody before reusing profiles or loading slots. Lost
bindings remain retained until verified cleanup [CITED: `daemon-adapter/internal/capsule/manager.go:862`]. See the
[judge quickstart](JUDGE_QUICKSTART.md) for the matching stop command.

<a id="evidence"></a>
### Evidence paths and interpretation

Keep authority evidence separate from public fixtures and release metadata.
Runtime archives and slot payloads can contain private information.

Answers: what should I preserve before making a result claim?

| Evidence | What it establishes |
| --- | --- |
| `VERSION` and dependency pins | Declared checkout and component identities |
| Complete session archive | Replayable transitions and retained witnesses |
| Test command and result | Behavior checked by that command in that environment |
| Scrubbed live receipt | Attributed outcome of the specific evaluated run |
| Slot payload | Persistent profile data, potentially credentials; keep private |

[CITED: `VERSION:1`, `deps.lock`, `core/src/journal/mod.rs:3867`, `daemon-adapter/internal/capsule/slots/store.go:274`]. This reference is limited
to the cited public repository and explicitly attributed reports.

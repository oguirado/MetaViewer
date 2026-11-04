# MetaViewer

<a id="metaviewer-a-live-wall-of-capsules-where-a-human-and-an-ai-share-one-desktop-under-one-authority"></a>

MetaViewer is a Linux desktop wall of application capsules that a person and an AI agent can operate under explicit control. It gives agent input a named target, checks the frame the agent saw, and records decisions in a verifiable journal.

Version `0.2.6` [CITED: `VERSION`] · `AGPL-3.0-only` [CITED: `LICENSE`] · [Release](https://github.com/oguirado/MetaViewer/releases/tag/v0.2.6)

**Choose an install:** [x64 packaged kit](#quick-start), with or without Docker capsules; [ARM64 source setup](docs/INSTALL.md#3-building-from-source-and-running-the-gate), with [additional KVM setup for VM and MicroVM](docs/ARM64_CAPSULE_SETUP.md).

**Find an answer:** [judge tour](docs/JUDGE_TOUR.md) · [operate with an AI](docs/AGENT_ENTRY.md) · [capsule design](docs/WHY_CAPSULES.md) · [troubleshooting](docs/JUDGE_TROUBLESHOOTING.md).

<!-- MV:BEGIN mv.node.v1 -->
```json
{
  "schema": "mv.node.v1",
  "version": "0.2.6",
  "repository": "https://github.com/oguirado/MetaViewer",
  "release": "https://github.com/oguirado/MetaViewer/releases/tag/v0.2.6",
  "setup": "bash scripts/judge/metaviewer-judge.sh install",
  "setup_capsules": "bash scripts/judge/metaviewer-judge.sh install --capsules",
  "preflight": "bash scripts/judge/metaviewer-judge.sh doctor --before-install",
  "success_marker": "JUDGE_INSTALL_OK",
  "doctor_marker": "JUDGE_DOCTOR_OK",
  "stop_marker": "JUDGE_STOP_CLEAN",
  "tiers": {
    "T1": "app only; no Docker capsules",
    "T2": "app plus browser and program containers; rootful Docker required",
    "ARM64-dev": "source setup; graphical VM, MicroVM and Rewind need KVM",
    "source": "build with the repository's pinned toolchains"
  },
  "router": "python3 route/route_query.py any \"<question>\"",
  "router_read": "python3 route/route_query.py show \"<reference>\"",
  "router_check": "python3 route/route_query.py check",
  "router_check_marker": "ROUTE_OK",
  "laws_check": "python3 tools/check_laws.py",
  "offline_gate": "bash tools/gate.sh",
  "licence": "AGPL-3.0-only; external components under NOTICE-EVALUATION.md"
}
```
<!-- MV:END mv.node.v1 -->

<a id="0-reading-map"></a>
## Where should I start?

Install through [Quickstart](#quick-start), or go directly to the guide for your task below.

Answers: where do I start; which document answers my question.

| Task | Read next |
|---|---|
| Evaluate the app as a judge | [Judge tour](docs/JUDGE_TOUR.md), with expected observations |
| Install or build on my platform | [docs/INSTALL.md](docs/INSTALL.md) |
| Let an AI operate a running capsule | [Executable agent entry](docs/AGENT_ENTRY.md) |
| Understand why capsules exist | [Why capsules](docs/WHY_CAPSULES.md) |
| Understand the computer-use workflow | [AI at the controls](docs/AI_AT_THE_CONTROLS.md) |
| Resolve a failure | [Judge troubleshooting](docs/JUDGE_TROUBLESHOOTING.md), then [exact errors](docs/ERRORS.md) |
| Inspect architecture or a message | [Architecture](docs/ARCHITECTURE.md), [reference](docs/REFERENCE.md), `contracts/v0.2/` |
| Find code or change the repository | [Agent protocol](AGENTS.md), then [router commands](route/README.md) |
| Assess evidence and limits | [Evidence](docs/EVIDENCE.md), then [limits below](#isolation-and-evaluation-limits) |

<a id="quick-start"></a>
## Quickstart

Use the packaged x64 judge kit after obtaining the release assets and the publisher's manifest digest; use the [source-build instructions](docs/INSTALL.md#3-building-from-source-and-running-the-gate) for ARM64.

Answers: how do I install MetaViewer; what commands do I run; how do I know installation succeeded.

The example selects Docker capsules (tier T2). Obtain the `SHA256SUMS` digest independently from the release publisher and replace the placeholder. If that digest or a required asset is unavailable, stop; do not substitute a digest computed from the downloaded manifest. The fetcher verifies the manifest and selected assets [CITED: `scripts/judge/fetch_assets.py`, `docs/JUDGE_QUICKSTART.md`].

```bash
git clone --branch v0.2.6 --depth 1 https://github.com/oguirado/MetaViewer.git
cd MetaViewer
export RELEASE_ASSET_URL=https://github.com/oguirado/MetaViewer/releases/download/v0.2.6
SHA256SUMS_DIGEST='<publisher-provided SHA256SUMS digest>'
python3 scripts/judge/fetch_assets.py --source "$RELEASE_ASSET_URL" --arch x64 --capsules --sums-sha256 "$SHA256SUMS_DIGEST"
bash scripts/judge/metaviewer-judge.sh doctor --before-install --capsules   # JUDGE_DOCTOR_OK
bash scripts/judge/metaviewer-judge.sh install --capsules                   # JUDGE_INSTALL_OK
bash scripts/judge/metaviewer-judge.sh doctor --capsules                    # JUDGE_DOCTOR_OK
bash scripts/judge/metaviewer-judge.sh run
bash scripts/judge/metaviewer-judge.sh stop                                 # JUDGE_STOP_CLEAN
```

For the app without Docker capsules (tier T1), remove `--capsules` from fetch, doctor and install. Keep the tier consistent throughout. A graphical Linux session is required; full prerequisites and the Windows WSL route are in [docs/INSTALL.md](docs/INSTALL.md).

An operational failure in the judge script prints `CODE: problem -- fix: remedy` and exits `2` [CITED: `scripts/judge/metaviewer-judge.sh:48`]; a usage error exits `64` [CITED: `scripts/judge/metaviewer-judge.sh:55`]. Follow the remedy before continuing. After installation, use the [Judge tour](docs/JUDGE_TOUR.md); for a refusal, use [Judge troubleshooting](docs/JUDGE_TROUBLESHOOTING.md).

<a id="1-abstract-and-result-contract"></a>
<a id="3-how-it-works"></a>
## Why capsules?

A capsule gives each task an addressable application surface with its own control state, so an agent can name what it intends to operate [CITED: `core/src/admission/mod.rs:96`, `core/src/admission/mod.rs:1297`]. Browser and Program capsules use container boundaries, while Host program and Desktop window expose host applications without isolation [CITED: `daemon-adapter/internal/capsule/manager.go`, `ui/src/surfaces/RoleSurface.vue`]. This separates the choice of execution boundary from the human-or-agent control protocol; the tradeoffs and alternatives are in [Why capsules](docs/WHY_CAPSULES.md).

Answers: why does MetaViewer use capsules; what does a capsule provide.

<a id="2-definitions-and-gates"></a>
### What do surface, frame and journal mean?

A **surface** is the target tracked by the core; a **frame** is an observed image with a generation and digest; the **journal** records core events for verification.

Answers: what is a surface; what is a frame generation; what does the journal record.

The Electron wall presents surfaces, the Rust core decides whether input may proceed, and the Go adapter runs capsules and exchanges frames and input. An agent proposal includes `surface_id` and `based_on_frame`; the core checks ownership, liveness, generation and digest before dispatch [CITED: `core/src/admission/mod.rs:1297`]. `mv-replay` checks the saved journal and frame witnesses; it is a verifier, not a command to repeat application actions [CITED: `core/src/bin/mv-replay.rs`]. Process and wire details: [Architecture](docs/ARCHITECTURE.md) and [Reference](docs/REFERENCE.md).

<a id="6-agent-operating-protocol"></a>
## Why computer use with an AI at the controls?

The maintainer recommends an AI at the controls because MetaViewer routes its proposals through frame and ownership checks, giving the agent feedback about whether an action may proceed [CITED: `core/src/admission/mod.rs:1297`]. A person can take control of a live surface, cancelling pending agent work; agent work requires explicit release of control and a fresh frame before it resumes [CITED: `core/src/admission/mod.rs:1136`, `core/src/admission/mod.rs:1159`]. The intended workflow is observe, propose, inspect the result, and hand back to the person when needed; [AI at the controls](docs/AI_AT_THE_CONTROLS.md) explains it and [Agent entry](docs/AGENT_ENTRY.md) provides the executable recipes.

Answers: why is MetaViewer focused on computer use; should I put an AI at the controls.

### How does an AI operate a running capsule?

Use the running app's attachment and copied capsule identity, then follow [docs/AGENT_ENTRY.md](docs/AGENT_ENTRY.md) for the selected task.

Answers: how does an AI attach; what is Direct task; how do I drive a capsule.

1. Open a capsule and its paired terminal. Choose an installed agent CLI or a shell.
2. Use **Copy ID for AI** and **Direct task**. Complete the task text, review it, and submit it yourself. The app prepares text without pressing Enter [CITED: `ui/src/terminal/workflowPrompts.js`, `ui/src/terminal/terminalDeckModel.js:1751`].
3. Follow the attachment and observation recipe in [Agent entry](docs/AGENT_ENTRY.md). Confirm the live capsule identity and control state; do not guess missing values.
4. Execute a supported, bounded step, inspect its verdict and observe the resulting state. Stop on a refusal. After `INPUT_UNCERTAIN`, inspect before considering any further input [CITED: `agents/metaviewer_agents/mw_refusals.py`].
5. At a login or challenge, hand control to the person. Acknowledge only hides the notice; it does not resume the run [CITED: `ui/src/handoff/handoffModel.js`].

Browser and program tasks, authored workflows, and ARM64 MicroVM commands have different recipes. The limits of `mw_run` are specific to that runner and mode; they are not a list of every action supported by the core [CITED: `agents/metaviewer_agents/mw_run.py:339`]. See [docs/AI_OPERATOR_GUIDE.md](docs/AI_OPERATOR_GUIDE.md) for the full workflow.

### How do I submit a reviewed proposal from the CLI?

Use `mvctl propose` with a reviewed proposal file and the registered values from the running app.

Answers: how do I send an action proposal; which CLI submits a proposal.

This command can dispatch input to the authorized capsule. `FILE` is the action-proposal JSON you reviewed; the variables must come from the app attachment. The transport bounds are explicit limits [TARGET], and argument validation is defined in the CLI [CITED: `agents/metaviewer_agents/mvctl.py`].

```bash
PYTHONPATH=agents python3 -m metaviewer_agents.mvctl propose --json-arg FILE \
  --socket "$MV_CORE_SOCKET" --session-id "$MV_SESSION_ID" \
  --agent-instance "$MV_AGENT_INSTANCE" --core-instance "$MV_CORE_INSTANCE" \
  --timeout-ms 5000 --max-line-bytes 65536 --max-reply-bytes 65536
# Inspect the returned verdict and verify the resulting capsule state.
```

<a id="status"></a>
<a id="5-coverage-and-domain-contracts"></a>
## Which capsule should I choose?

Choose Browser or Program for a container boundary, a host route for an existing application, or the ARM64 developer setup for a guest.

Answers: which capsule kinds exist; which are isolated; what runs on x64 or ARM64.

| Kind | Execution boundary | Platform and setup |
|---|---|---|
| Browser (`identity-browser`) | Container per identity | Docker capsule tier; [install](docs/INSTALL.md) |
| Program (`program`) | Container | Docker capsule tier; [install](docs/INSTALL.md) |
| Host program (`host-program`) | **Not isolated**; runs on the host | Host application and Xpra; [operator guide](docs/AI_OPERATOR_GUIDE.md) |
| Desktop window (`desktop-window`) | **Not isolated**; attaches a host window | X11 window; [operator guide](docs/AI_OPERATOR_GUIDE.md) |
| Graphical VM | Guest | ARM64 with KVM; [setup](docs/ARM64_CAPSULE_SETUP.md) |
| MicroVM and Rewind | Guest; Rewind restores guest RAM | ARM64 with KVM; [setup and limits](docs/ARM64_MICROVM_REWIND.md) |

The host routes and container routes are distinguished in the adapter and launcher [CITED: `daemon-adapter/internal/capsule/manager.go`, `ui/src/catalog/catalogModel.js`]. The guest capability check disables VM and MicroVM on non-ARM64 hosts [CITED: `ui/electron/guestCommandProfile.js:47`]. Rewind does not undo external network effects, host files or the journal; inspect the [Rewind contract](docs/ARM64_MICROVM_REWIND.md).

<a id="4-engineering-triptych"></a>
<a id="7-measured-results"></a>
## What evidence can I check?

Public code and tests support interface and refusal claims; live demonstrations remain maintainer-reported unless their receipts are published.

Answers: what is verified; where is the evidence; what does replay prove.

| Claim | Inspect | Limit |
|---|---|---|
| Stale frames and invalid ownership are refused | `core/src/admission/mod.rs`, `core/tests/admission_matrix.rs` | A refusal test does not certify every application workflow |
| Take control cancels pending agent work | `core/src/admission/mod.rs`, `core/src/journal/mod.rs` | Inspect the pending and already-dispatched cases separately |
| Journal and witnesses can be checked | `core/src/bin/mv-replay.rs`, `core/tests/t1_journal_verify.rs` | Verification does not prove a task was useful or correct |
| Wire messages match their schemas | `contracts/v0.2/`, `python3 tools/check_contracts.py` | Shape validation is not live execution |
| Installation checks have explicit markers | `scripts/judge/metaviewer-judge.sh` | A source test is not an installation on your machine |

`mv-replay` exits `0` on successful verification, `2` for invalid or corrupt input, `3` for a duplicate and `4` for a witness error [CITED: `core/src/bin/mv-replay.rs:41`]. Use the original session's journal and witnesses according to [Evidence](docs/EVIDENCE.md).

<a id="historical-live-evidence"></a>
<a id="live-on-the-026-candidate-measured-live-by-the-maintainer"></a>
### Where are the live demonstrations and receipts?

[AI at the controls](docs/AI_AT_THE_CONTROLS.md) records the maintainer's game and ARM64 Rewind reports; [Evidence](docs/EVIDENCE.md) distinguishes those reports from public test evidence.

Answers: has an AI driven MetaViewer; are the live results independently reproducible.

The reports are not measurements reproduced by this documentation review. Public raw receipts and a published location for the referenced game and Rewind recordings are `ABSENT — do not invent`. Live frame rate and latency at the current pins are also `ABSENT — do not invent`; older observations do not establish current performance.

<a id="isolation-and-evaluation-limits"></a>
<a id="8-rejected-levers-and-negative-results"></a>
<a id="9-limitations"></a>
<a id="11-pending-measurements"></a>
## What are the limits and known problems?

Host routes are not isolated, guest features require ARM64 setup, and a passing offline test suite does not establish live application acceptance.

Answers: what is unsupported; what remains unverified; where are known bugs.

- VM and MicroVM are unavailable on non-ARM64 hosts [CITED: `ui/electron/guestCommandProfile.js:47`]; Rewind profiles also require ARM64 [CITED: `ui/electron/guestCommandProfile.js:11`].
- A stale frame or missing ownership blocks admission [CITED: `core/src/admission/mod.rs:1297`]. After a runner reports `INPUT_UNCERTAIN`, inspect the resulting state before further input [CITED: `agents/metaviewer_agents/mw_refusals.py`]. A successful proposal is not proof of task completion.
- Known maintainer-reported issues, including package bytecode inventory and a terminal exit after a long line, are tracked in [Debug](docs/DEBUG.md) and [Judge troubleshooting](docs/JUDGE_TROUBLESHOOTING.md). Their causes must not be inferred from the symptoms.
- Screenshot and walkthrough publication for this entry page remains pending. Independent live receipts and current performance measurements remain absent.

<a id="10-reproducibility"></a>
## How do I find code or contribute?

Ask the local router, read the cited source, and follow [AGENTS.md](AGENTS.md) and [LAWS.md](LAWS.md) before editing.

Answers: how do I find an implementation; how do I verify a change; how do I build from source.

```bash
python3 route/route_query.py any "<question>"
python3 route/route_query.py show "<reference returned above>"
python3 route/route_query.py check
```

A finding tells you where to look. Only the code proves it. An empty result means retrieval found no answer, not that the feature is absent. Use [router commands](route/README.md) for exact symbols, error text and tests.

The build instructions and pinned toolchains are in [docs/INSTALL.md](docs/INSTALL.md); check coverage is in [Testing](docs/TESTING.md). Run the checks appropriate to your change:

```bash
python3 tools/check_laws.py
python3 tools/check_laws.py --version
python3 tools/check_contracts.py
python3 -B -m unittest discover -s tests -p 'test_*doc*'
bash tools/gate.sh
```

`check_laws.py` validates commit metadata and applicable changelog requirements; it does not scan all prose for privacy or factual accuracy [CITED: `tools/check_laws.py`]. After document changes, the index owner regenerates the docs index and checks `ROUTE_OK`. Contributor catalogue checks are separate; see [AGENTS.md](AGENTS.md).

<a id="12-licence-and-provenance"></a>
## What licence and evaluation permission apply?

MetaViewer's own source is `AGPL-3.0-only`; the external components have the separate evaluation permission in [NOTICE-EVALUATION.md](NOTICE-EVALUATION.md).

Answers: what is the licence; what is private; what may judges evaluate.

`wender-agent`, `vision-engine` and `OpenSuperficies` are separate proprietary programs whose source is not published. The notice permits hackathon judges to install, run and evaluate the supplied compiled forms for judging; it grants no redistribution, modification, reverse engineering or other use. Public source here describes the interfaces, not private implementation. `capsule-ui-kit` is a separate public repository under `AGPL-3.0-only` [CITED: `NOTICE-EVALUATION.md`].

Pre-existing work and event work: [Provenance](docs/PREEXISTING.md). Release history: [CHANGELOG.md](CHANGELOG.md).

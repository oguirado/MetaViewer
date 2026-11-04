# Dossier: agents, tools and the end-to-end evidence

Answers: how does an AI drive MetaViewer, what is mw_run, what is the agents package, where do I start debugging an agent run

This dossier explains the Python agent side of MetaViewer (`agents/`), the repository tools that an AI or a maintainer runs (`tools/`), and what the end-to-end tests in `tests/e2e/` prove. It is written for a judge and for the AI a judge points at the repository.

**A finding tells you where to look. Only the code proves it.** Every coordinate below was read on the base commit of this documentation wave. The machine-readable findings for the same files are in [`route/study/agents.jsonl`](../../route/study/agents.jsonl); each row cites byte spans whose digest `route/route_query.py` verifies, so a row turns STALE the moment its cited code changes.

Terms used once and then assumed:

| Term | Meaning here |
|---|---|
| core | The Rust authority (`core/`). It admits or refuses every action and journals outcomes. |
| capsule / surface | One live tile on the wall: a browser, a Host program, a Program, or on ARM64 a VM or MicroVM. `surface_id` names it. |
| control | Who may act on a surface: `human` or `agent`. Only an `agent` surface accepts agent input. |
| proposal | An action an agent asks the core to perform. Admission is not completion. |
| receipt / verify | The core's evidence that an admitted action had its expected effect. Only this counts as success. |
| refusal | A closed, named reason the core or a tool declines. Refusals are answers, not crashes. |
| handoff | The run stops and a person takes over; the run never resumes itself. |
| Host program | An application that runs on the host under MetaViewer's control surface, without a capsule boundary. |

Tags: [MEASURED] was counted or run for this dossier; [CITED: path] is stated by that file; [TARGET] is an intended bound, not a measurement. Inference is marked "(inference)".

## Reading map

Answers: which section answers my question, where is X documented

| You want | Go to |
|---|---|
| Why the agent side is shaped this way | [Why the agent side exists](#why-the-agent-side-exists) |
| How an AI drives the app, step by step | [How an AI drives MetaViewer](#how-an-ai-drives-metaviewer) |
| What a `mw_run` exit code or verdict means | [mw_run results and refusals](#mw_run-results-and-refusals) |
| The low-level tool verbs (observe, propose, wait_verify) | [Tool API and envelope codec](#tool-api-and-envelope-codec) |
| mvctl, the MCP server and the core client | [mvctl, MCP server and the core client](#mvctl-mcp-server-and-the-core-client) |
| Login or challenge walls and handoff | [Handoff latch](#handoff-latch) |
| MemoryWeb home and stored workflows | [MemoryWeb home and owner](#memoryweb-home-and-owner) |
| Perception, vcore, Muse Spark, planner | [Perception and planning](#perception-and-planning) |
| Rewind and guest commands on ARM64 MicroVM | [Rewind and guest commands](#rewind-and-guest-commands) |
| What `tools/gate.sh` runs | [The gate](#the-gate) |
| Why my commit was refused | [Commit laws checker](#commit-laws-checker) |
| What each e2e test proves | [What the end-to-end tests prove](#what-the-end-to-end-tests-prove) |
| A symptom, and where to look | [Symptom to code](#symptom-to-code) |
| Known open bugs | [Open bugs](#open-bugs) |
| What I could not verify | [Limits of this dossier](#limits-of-this-dossier) |

Related documents, not repeated here: [AI operator guide](../AI_OPERATOR_GUIDE.md) for UI steps, [agent entry](../AGENT_ENTRY.md) for the "Use MetaViewer" prompt, [first mw_run](../MW_RUN_FIRST_RUN.md), [testing](../TESTING.md), [ARM64 MicroVM rewind](../ARM64_MICROVM_REWIND.md).

## Why the agent side exists

Answers: why is the agent code separate from the core, why does an agent never act directly, what is the design principle

An agent never touches a surface directly. It observes, proposes one action, and waits for the core's verified receipt; the core alone admits input and records it. The Python package is a client of that authority, not a second authority.

The code states this repeatedly:

- The tool verbs never open sockets; an injected client owns framing, identity, sequence numbers and byte caps (`agents/metaviewer_agents/tools.py:1`). (inference) This lets every verb be tested against fakes, which is what `agents/tests/test_tools.py` does.
- One bounded attempt: observe, plan, propose once, wait. Success is only the core's verified receipt (`agents/metaviewer_agents/verify.py:1`).
- Perception fills only the closed `vision` object; admission, freshness and witnesses stay in the core (`agents/metaviewer_agents/perception/base.py:1`).
- The MemoryWeb owner has no native input path; it sends input only through `backend.call('propose')` (`agents/metaviewer_agents/mw_owner.py:759`).
- The host backend for `mw_run` never starts, stops or reconfigures a capsule (`tools/mw_run_backend.py:3`).

What this gains, against the alternative of an agent that drives input directly (inference from the refusal set): a wrong or stale plan becomes a named refusal (`STALE_FRAME`, `SURFACE_NOT_AGENT_CONTROLLED`, `LOCKED_BY_OTHER`) instead of a stray click; a human can take control at any time and agent input is then refused; and every run leaves a journal the core can replay. What it costs: every action pays a round trip through the core, and "verified" means the expected effect was seen, not that a task goal was met (`goal_completed` is always `null` in program and browser goal reports, see [mw_run results and refusals](#mw_run-results-and-refusals)).

The separate proprietary programs wender-agent and vision-engine are started as separate processes and spoken to over process and socket interfaces; this dossier covers only MetaViewer's side of those boundaries, as stated in [NOTICE-EVALUATION.md](../../NOTICE-EVALUATION.md).

## How an AI drives MetaViewer

Answers: how do I control MetaViewer as an AI, how do I run an agent task, what command does an AI use, Use MetaViewer

An AI drives MetaViewer from a terminal against a capsule that is already running and set to Agent control. It runs `python3 -m metaviewer_agents.mw_run` and reads exactly one JSON result line. It never creates capsules or attaches windows itself.

| Step | What to do | Coordinate |
|---|---|---|
| 1 | Start the app and a capsule; switch it to Agent control in the UI | [AI operator guide](../AI_OPERATOR_GUIDE.md) |
| 2 | In the app's terminal, source `${XDG_RUNTIME_DIR}/metaviewer/attach/current.env` in a subshell; it provides `MV_CORE_CONFIG`, `XDG_RUNTIME_DIR`, `MV_SRF_STATE_DIR` | `tools/mw_run_program.md:35` |
| 3 | Point `XDG_STATE_HOME` at a fresh directory under `/dev/shm` with mode 0700 | `tools/mw_run_program.py:79` |
| 4 | Run `PYTHONPATH=agents python3 -m metaviewer_agents.mw_run --surface-kind program --identity <profile> --planner rules --goal '<exact visible name>' --steps N` (or `--surface-kind browser`) | `agents/metaviewer_agents/mw_run.py:339` |
| 5 | Read the single stdout line, schema `metaviewer.mw_run/v1`, with `rc`, `verdict_code`, `report` and `receipt` paths | `tools/mw_run_backend.py:1049` |
| 6 | On a nonzero rc, read the remedy sentence printed to stderr | `agents/metaviewer_agents/mw_refusals.py:167` |

Three run modes share that entry (`agents/metaviewer_agents/mw_run.py:356`):

| Mode | Flags | Backend |
|---|---|---|
| Stored workflow (MemoryWeb) | `--site S --workflow W` | `tools/mw_run_backend.py:998` |
| Program goal | `--surface-kind program --goal ...` | `tools/mw_run_program.py:1196` |
| Browser goal | `--goal ...` on a browser surface | `tools/mw_run_browser_goal.py:326` |

Rules-mode grounding is literal: `--goal` must equal exactly one visible element name, otherwise `MW_PROGRAM_GOAL_UNGROUNDED` (`tools/mw_run_program.py:423`). `--goal focused --text T --steps 1` types at the current focus; `--goal focused-key --key Up|Down|Left|Right|Enter` is for Host programs only (`agents/metaviewer_agents/mw_run.py:362`). The optional `--planner muse` starts `tools/mw_program_muse.py` as a child process and is never a fallback from rules (`tools/mw_run_program.py:819`).

Why an AI at the controls fits this design (inference): the AI never needs privileged input; every move it asks for is checked against the current frame and control state and comes back as a verified receipt or a named refusal it can explain. Live fact [MEASURED, operator session]: switching a Host program between human and agent restarts that program, so an AI should switch control before it starts a long task, not during one.

## mw_run results and refusals

Answers: what does rc 4 mean, what does rc 5 mean, INPUT_UNCERTAIN, HUMAN_HANDOFF, MW_RUN_CONFIG, why did mw_run refuse, what is verdict_code

Every completed `mw_run` prints exactly one `metaviewer.mw_run/v1` line; argument errors are the exception and exit through argparse with rc 2 and no JSON line (`agents/metaviewer_agents/mw_run.py:359`).

| rc | Verdict | Meaning | What to do |
|---|---|---|---|
| 0 | `PROGRAM_BOUNDED_ACTIONS_VERIFIED`, `BROWSER_BOUNDED_ACTIONS_VERIFIED`, `PROGRAM_TEXT_UNCERTIFIED_NOT_READABLE` | Each bounded move was verified by the core. Task completion is not claimed: `goal_completed` is `null` | Check the outcome yourself |
| 2 | argparse usage | Flag combination refused before anything ran | Read the usage text |
| 4 | `HUMAN_HANDOFF` | A login or challenge wall was detected; the run stopped for a person | A person handles the wall; start a new run after |
| 5 | `INPUT_UNCERTAIN` | Input may have been delivered but its effect was not settled | Never retry automatically; look at the surface first |
| 6 | a named code such as `MW_RUN_CONFIG`, `MW_RUN_CORE`, `MW_DEPENDENCY`, `MW_PROGRAM_CONTROL` | Refused before or during the run with a reason | Read the stderr remedy |

Coordinates: default verdict `MW_RUN_CONFIG` at `tools/mw_run_backend.py:1006`; `HUMAN_HANDOFF` mapping at `tools/mw_run_backend.py:979` and `tools/mw_run_browser_goal.py:382`; INPUT_UNCERTAIN is kept even when the wall deadline expires, with the deadline text only appended to the diagnostic (`agents/metaviewer_agents/mw_run.py:255`).

Why rc 5 is never retried: a move that may already have reached the surface could double an effect if resent. The same rule holds at every layer: `ReplayOwner.recover` always answers False (`agents/metaviewer_agents/mw_owner.py:839`), and `propose` makes at most 3 attempts, only after `MW_REBIND_PIXELS` or a core `STALE_FRAME`, both of which prove the input was not delivered (`tools/mw_run_backend.py:824`).

Remedy sentences: `REFUSALS` in `agents/metaviewer_agents/mw_refusals.py:10` maps each code to one sentence; all `MW_GATE_` codes share one; unknown codes get a generic "inspect report" sentence (`agents/metaviewer_agents/mw_refusals.py:120`). stdout is never altered (`agents/metaviewer_agents/mw_refusals.py:145`). To add a code, add a row; `tests/test_mw_refusals.py:38` fails if a code raised in the source has no sentence.

Selected program-mode refusals (`tools/mw_run_program.py`): `MW_RUN_NO_SURFACE`, `MW_RUN_AMBIGUOUS`, `MW_PROGRAM_CONTROL` (surface not under agent control), `MW_IDENTITY`, `MW_PROGRAM_NO_VISIBLE_EFFECT`, `MW_PROGRAM_PASSWORD`, `MW_PROGRAM_TEXT_MISMATCH`, `MW_STALE_FRAME_EXHAUSTED`, `MW_PROGRAM_DEADLINE`, `MW_PROGRAM_RAM_REQUIRED`, `MW_PRIVATE_OUTPUT`, and with `--planner muse` `MW_PROGRAM_MODEL_TIMEOUT`, `MW_PROGRAM_MODEL_FAILED`, `MW_PROGRAM_MODEL_TARGET`. Browser goal adds `MW_BROWSER_TEXT`, `MW_BROWSER_KEY`, `MW_BROWSER_STEPS` (`tools/mw_run_browser_goal.py:221`). The full generated list of codes belongs to the error reference written by another lane; ABSENT here.

Bounds [CITED: agents/metaviewer_agents/mw_run.py]: steps 1..16, `--timeout-ms` 1..30000, `--model-timeout-ms` 1..240000, `--text` 1..65536 UTF-8 bytes (`agents/metaviewer_agents/mw_run.py:369`). The wall-deadline budget falls back to 360 s when the workflow cannot be read (`agents/metaviewer_agents/mw_run.py:214`), and an override can only lower it (`agents/metaviewer_agents/mw_run.py:177`).

### Wall deadline

Answers: MW_WALL_DEADLINE, run exceeded wall deadline, why did mw_run time out

`wall_deadline` arms `ITIMER_REAL` around the run (`agents/metaviewer_agents/mw_run.py:236`). On expiry stderr shows `mw_run: MW_WALL_DEADLINE: run exceeded wall deadline (N s); inspect report.json...` (`agents/metaviewer_agents/mw_run.py:58`) and `_write_fallback_report` emits an rc 6 report (`agents/metaviewer_agents/mw_run.py:298`). If `XDG_STATE_HOME` is unusable at that moment the result is `MW_PRIVATE_OUTPUT` with `report: null` (`agents/metaviewer_agents/mw_run.py:325`). Tests: `tests/test_mw_wall_deadline.py:100` (blocked runner ends with a deadline report), `tests/test_mw_wall_deadline.py:218` (override cannot raise the budget).

## Handoff latch

Answers: what happens at a login wall, MW_HANDOFF_REQUIRED, why did the run stop for a human, can the run resume

A detected login or challenge wall stops the run for good; there is deliberately no solver, retry, reset or resume, and a new run needs a new owner (`agents/metaviewer_agents/mw_handoff.py:1`).

- `HandoffLatch.inspect` runs the injected detector; an explicit `observed_wall` marker from the host also forces a stop (`agents/metaviewer_agents/mw_handoff.py:33`).
- The latch is set before the record is written (`agents/metaviewer_agents/mw_handoff.py:59`), so a failed write cannot reopen the run; a failed write raises `HandoffPersistenceError` with code `MW_HANDOFF_REQUIRED` (`agents/metaviewer_agents/mw_handoff.py:13`).
- The record, schema `metaviewer.handoff/v1`, keeps only kinds, never evidence values (`agents/metaviewer_agents/mw_handoff.py:60`).
- After the latch, every action is refused (`agents/metaviewer_agents/mw_owner.py:375`).

User sees rc 4 `HUMAN_HANDOFF` and the path `<run>/memoryweb-run.handoff.json` (`tools/mw_run_backend.py:979`). Tests: `agents/tests/test_mw_handoff.py:28` (absorbing latch), `agents/tests/test_mw_handoff.py:89` (no further propose after a stop), `tests/test_mw_wall_pages.py:41` (page cues).

Tradeoff: a run that meets a wall always costs a person's attention. The code accepts that rather than act on a wall (inference from the module docstring).

## MemoryWeb home and owner

Answers: what is MemoryWeb, MW_HOME refused, where are stored workflows, mw_home_check, what is a site pack, MW_GATE, MW_UNSUPPORTED_WORKFLOW

MemoryWeb replays a stored, compiled workflow for a site. Sites are data packs (`site.json` plus `workflows/*.json`); corpus bytes never choose Python code and no workflow scripts run (`agents/metaviewer_agents/mw_owner.py:1`).

### Home admission

Answers: MW_HOME_PATH, why was my MemoryWeb home refused, mode 0700, mw_home_check.py

The home holds user data and must be private, untracked, symlink-free and free of browser-profile state; unsafe homes are refused and never repaired (`agents/metaviewer_agents/mw_home.py:1`).

| Check | Coordinate |
|---|---|
| Every ancestor opened with `O_NOFOLLOW` | `agents/metaviewer_agents/mw_home.py:51` |
| Mode 0700 and the caller's uid | `agents/metaviewer_agents/mw_home.py:72` |
| At most 10000 entries, depth 32, 1 MiB per file (64 KiB under `workflows/`); refuses profile names, profile directories and SQLite magic bytes | `agents/metaviewer_agents/mw_home.py:130` |
| Site taken whole from the home, else from read-only builtins | `agents/metaviewer_agents/mw_home.py:207` |

The run path refuses before any core connection (`tools/mw_run_backend.py:1011`) and prints `mw_run: MW_HOME_*: MemoryWeb home <path> refused; check it with: python3 .../tools/mw_home_check.py --repo ...` (`tools/mw_run_backend.py:1039`). The run path never creates a home; `tools/mw_home_check.py` does create a missing one with mode 0700 (`tools/mw_home_check.py:132`) and prints `metaviewer.mw_home/v1`. Tests: `agents/tests/test_mw_home.py:47` (a 0755 home is refused and not repaired), `tests/test_mw_home_cli.py:66`.

### Replay owner

Answers: ReplayOwner, MW_RECEIPT_MISMATCH, MW_NOTICE, pacing refused, wender-agent workflow runner

The pinned wender-agent workflow runner needs owner objects (artifact, authorization, observations, transport, journal, slots); MetaViewer supplies them under its own custody (`agents/metaviewer_agents/mw_owner.py:940`). `wender_api` puts the locked checkout first on `sys.path` and refuses a compiled runtime (`agents/metaviewer_agents/mw_owner.py:77`).

| Rule | Refusal | Coordinate |
|---|---|---|
| Only T1 `ax:` anchors and focus/present predicates are supported | `MW_UNSUPPORTED_WORKFLOW` | `agents/metaviewer_agents/mw_owner.py:529`, `agents/metaviewer_agents/mw_owner.py:953` |
| Pinned gate categories | `MW_GATE_<category>` | `agents/metaviewer_agents/mw_owner.py:956` |
| Policy | `MW_NOTICE`, `MW_RESTART`, `MW_WRITE_APPROVAL` | `agents/metaviewer_agents/mw_owner.py:350` |
| Pacing above 5000 ms is refused, never clamped | — | `agents/metaviewer_agents/mw_owner.py:493` |
| Receipt binding to the sent action | `MW_RECEIPT_MISMATCH` | `agents/metaviewer_agents/mw_owner.py:784` |
| Output file must not exist yet | — | `agents/metaviewer_agents/mw_owner.py:930` |

Host side: `HostBackend.ownership` checks identity, exactly one active surface and one live lease (`tools/mw_run_backend.py:455`); `run_entry` admits the home, makes a private evidence directory, connects, then executes (`tools/mw_run_backend.py:998`). `MW_DEPENDENCY` carries a hint to set `MV_WENDER_ROOT` (`tools/mw_run_backend.py:1042`). Tests: `tests/test_mw_run_backend.py:105`, `tests/test_mw_stale_frame.py:34` (non-stale submissions never retry), `agents/tests/test_mw_owner.py:183`.

## Tool API and envelope codec

Answers: observe, list_surfaces, propose, wait_verify, ToolRefusal, VerificationFailed, bad_shape, unknown_version, envelope v0.2

The tool API is a closed set of verbs over the core mailbox: `observe`, `list_surfaces`, `propose`, `wait_verify`, plus `record_start` and `record_stop` (`agents/metaviewer_agents/tools.py:26`).

| Verb outcome | Python type | Coordinate |
|---|---|---|
| Refusal `STALE_FRAME`, `SURFACE_NOT_AGENT_CONTROLLED`, `LOCKED_BY_OTHER`, `BUDGET_EXCEEDED`, `OUT_OF_BOUNDS`, `POLICY` | `ToolRefusal`, with `core_seq` None and never invented | `agents/metaviewer_agents/tools.py:66`, `agents/metaviewer_agents/tools.py:603` |
| Error `PROTOCOL`, `UNAVAILABLE`, `NOT_FOUND` | `ToolOperationalError` | `agents/metaviewer_agents/tools.py:74` |
| `VERIFICATION_FAILED` or a `timeout` status | `VerificationFailed` | `agents/metaviewer_agents/tools.py:616` |
| Wait budget spent | `TimeoutError("wait_verify budget exhausted")` | `agents/metaviewer_agents/tools.py:861` |

`propose` returns only the admission verdict and never retries (`agents/metaviewer_agents/tools.py:724`). `wait_verify` keeps one monotonic deadline and sleeps `min(retry_after_ms, remaining)` while pending; a verified wait needs `focus_verified`, a matching `after_frame` digest and matching native input evidence (`agents/metaviewer_agents/tools.py:878`). Change points: new action kinds in `_ACTION_CHECKS` (`agents/metaviewer_agents/tools.py:281`), new expectations in `_EXPECTATION_CHECKS` (`agents/metaviewer_agents/tools.py:344`); both need a schema first, per [LAWS.md](../../LAWS.md).

### Envelope codec

Answers: EnvelopeError, length refused, depth 32, safe integer, why was my frame rejected

`agents/metaviewer_agents/envelope.py` validates every mailbox frame against embedded schema data (`agents/metaviewer_agents/_contracts_v02.py`, generated by `tools/generate_guest_command_sdk.py`). It knows five outer schemas and each admits only its own body families (`agents/metaviewer_agents/envelope.py:39`). Error codes are `bad_shape`, `unknown_version` and `length`. Bounds: safe integers within ±(2^53−1), no unpaired surrogates, strings up to 65536 bytes, nesting up to 32 (`agents/metaviewer_agents/envelope.py:801`); the byte cap is checked before decoding (`agents/metaviewer_agents/envelope.py:998`); duplicate keys, NaN, embedded CR or LF and blank frames are refused.

Tradeoff visible in code: stale `/v0.1` tags in the tool-result definitions are rewritten to `/v0.2` at import to match the Rust wire schemas, and the docstring says the source contract still needs the matching change (`agents/metaviewer_agents/envelope.py:619`). Tests: `agents/tests/test_envelope.py`, `agents/tests/test_fuzz_envelope.py`, `agents/tests/test_depth_32.py` (depth 32 accepted, 33 refused).

### Verify loop and observation check

Answers: run_loop, one bounded attempt, MV_WENDER_PLANNER_CMD, identity_mismatch, observation refused

`run_loop` makes one bounded attempt: observe, choose a planner, propose once, wait (`agents/metaviewer_agents/verify.py:54`). Setting `MV_WENDER_PLANNER_CMD` selects the Wender planner even when a local planner is passed (`agents/metaviewer_agents/verify.py:71`). If `wait_verify` raises `TypeError`, it is called again without `surface_id`; that is a second poll, never a second proposal, but it can hide a real `TypeError` (`agents/metaviewer_agents/verify.py:120`). Timeouts outside 1..60000 ms raise `ValueError('invalid timeout')` (`agents/metaviewer_agents/verify.py:42`).

`observe.py` checks an observation against a trusted (`surface_id`, `generation`) pair, with codes `unknown_version`, `identity_mismatch`, `bad_shape` (`agents/metaviewer_agents/observe.py:78`); `ramws_path` must be under `/dev/shm` (`agents/metaviewer_agents/observe.py:140`). These metadata checks cannot prove frame bytes, freshness or provenance, as the module itself says (`agents/metaviewer_agents/observe.py:15`).

## mvctl, MCP server and the core client

Answers: mvctl, MCP server, how does an external AI connect, ToolClient, core socket, hello pin, trusted component pins do not match

This section is pending in this branch; until it lands, use `python3 route/route_query.py file agents/metaviewer_agents/mvctl.py` and the [agent entry](../AGENT_ENTRY.md).

## Perception and planning

Answers: perception backend, vcore, vserve, Muse Spark, planner, STALE_FRAME from perception, commit_mismatch, dirty_tree, deps.lock

Perception turns a frame into the closed `vision` object (`summary`, `changed_regions`, `elements`); the registry never falls back silently between providers (`agents/metaviewer_agents/perception/base.py:1`). Providers are `fake`, `vcore` and `meta_muse`; an unknown name is `unavailable` (`agents/metaviewer_agents/perception/base.py:234`).

| Part | Role | Key failure | Coordinate |
|---|---|---|---|
| `deps_lock.resolve_locked_component` | Admit a checkout or wheel of a separate component only at its `deps.lock` commit | `bad_lockfile`, `commit_mismatch`, `dirty_tree`, `unavailable "<VAR> is required"` | `agents/metaviewer_agents/perception/deps_lock.py:352` |
| `compiled.compiled_executable` | Admit a compiled runtime only if every file is pinned and hashes match | `commit_mismatch`, `dirty_tree "unpinned compiled file"`, `hash_mismatch` | `agents/metaviewer_agents/perception/compiled.py:83` |
| `vcore` | Run the vision-engine program as a child process: persistent JSON-lines server, one-shot fallback | `BUDGET_EXCEEDED` on a full queue (no waiting), `identity_mismatch` never falls back, `timeout "vserve request timed out"` | `agents/metaviewer_agents/perception/vcore.py:1344`, `agents/metaviewer_agents/perception/vcore.py:2102` |
| `meta_muse` | Muse Spark model as a perception backend; transport is injected, no endpoint hardcoded | `unavailable "muse credential not configured"`, `identity_mismatch`, `unknown_version` | `agents/metaviewer_agents/perception/meta_muse.py:170` |
| `planner` | Choose a click target from an element table; excludes Stop or Detener controls | `generation_control`, `frame_mismatch`, `out_of_bounds` | `agents/metaviewer_agents/planner.py:482` |

Why a child process and not an import (inference from `agents/metaviewer_agents/perception/vcore.py:1`): the private program stays outside MetaViewer's address space and licence, the child gets a scrubbed environment (`agents/metaviewer_agents/perception/vcore.py:420`), and a hang can be killed: stdin EOF, then SIGTERM, then SIGKILL (`agents/metaviewer_agents/perception/vcore.py:1687`). The persistent server avoids interpreter start-up per tick (inference).

Debugging traps found in code:

- A planner timeout surfaces as `bad_shape "external planner execution failed: ..."` (`agents/metaviewer_agents/planner.py:865`), and the Wender bridge discards the child's stderr (`agents/metaviewer_agents/wender_bridge.py:428`). The real cause is not in the output.
- In vcore, one-shot exits 4, 5, 6 become `STALE_FRAME`, `unavailable`, `BUDGET_EXCEEDED` only after a vserve failure; otherwise any nonzero exit is `bad_shape` (`agents/metaviewer_agents/perception/vcore.py:2151`). Read `last_vserve_error` and `last_fallback_error`.
- `vision.py` reports every parse failure as `VisionBridgeError('invalid description')`; the reason is on `__cause__` (`agents/metaviewer_agents/vision.py:132`).
- The `loop_trials` command-line entry runs scripted test doubles unless factories are injected, so it does not measure a live session (`agents/metaviewer_agents/loop_trials.py:1218`).

Tests: `agents/tests/test_vcore.py`, `agents/tests/test_vcore_serve.py`, `agents/tests/test_deps_lock.py`, `agents/tests/test_compiled_runtime.py`, `agents/tests/test_meta_muse.py`, `agents/tests/test_planner.py`, `agents/tests/test_loop_trials.py` (an 8 of 10 negative control).

## Rewind and guest commands

Answers: rewind SDK, pause resume mark restore, GuestCommandUnknown, guest command, MicroVM, mv-replay Invalid

Both run only on the ARM64 MicroVM capsule; there is no x64 VM or rewind in this release. They share one claimed channel to the guest; there is no host shell, no reconnection and no resend (`agents/metaviewer_agents/guest_command.py:1`).

| Rule | Coordinate |
|---|---|
| Rewind phases: pause needs `ready`; resume needs `paused`; mark needs `ready` or `paused`; restore needs `paused` or `recoverable` | `agents/metaviewer_agents/rewind.py:90` |
| Two restore points; rotation evicts the oldest unreferenced point | `agents/metaviewer_agents/rewind.py:212` |
| An unknown outcome or missed deadline marks the session uncertain; every pending call raises `GuestCommandUnknown` | `agents/metaviewer_agents/rewind.py:125`, `agents/metaviewer_agents/guest_command.py:328` |
| Guest command bounds: command 1..16384 bytes, stdin up to 49152, total up to 65536, timeout 1..60000 ms, up to 64 jobs | `agents/metaviewer_agents/guest_command.py:46` |
| `close()` does not prove closure; only a `stopped` event with `native_absent` does | `agents/metaviewer_agents/guest_command.py:539` |

Why no resend: a command or restore whose outcome is unknown may already have run in the guest; resending could run it twice. The SDK fences the session instead (inference from `agents/metaviewer_agents/guest_command.py:328`).

Live facts [MEASURED, operator session on ARM64 MicroVM]: 3 files deleted, Back restored them, the app showed 387.5 ms, and `mv-replay` returned rc 0 on that session journal. `mv-replay` needs absolute real paths; relative, symlinked or copied session paths give `Invalid`. In code the check is in `core/`, not here: `confined` refuses `..` and symlinked components (`core/src/journal/mod.rs:1274`), `private_archive` needs two parent levels (`core/src/journal/mod.rs:1317`), and every directory must be owned by the current user with mode 0700 (`core/src/journal/mod.rs:1309`); the process exits 2 (`core/src/bin/mv-replay.rs:44`). That a plain copy loses the mode or owner is inference. A full journal ends the session; start a fresh session per long run [MEASURED, operator session].

Tests: `agents/tests/test_rewind_sdk.py`, `agents/tests/test_guest_command.py`, `agents/tests/test_guest_bootstrap_barrier.py`, `tests/e2e/e2e12_replay_purity.test.js`. Setup: [ARM64 MicroVM rewind](../ARM64_MICROVM_REWIND.md).

## The gate

Answers: what does tools/gate.sh run, how do I run the gate, BLOCKED vs FAIL, gate legs, what do I need to run tests

`bash tools/gate.sh` runs 11 legs in a fixed order [MEASURED: `tools/gate.sh:48`] and prints `PASS`, `BLOCKED` or `FAIL` per leg; `--leg <name>` runs one, `--self-test` tests the gate itself. CI does not call `gate.sh`; it runs its own jobs.

| Leg | Proves | Needs |
|---|---|---|
| manifests | Manifest pins; `deps.lock` equals the component pins | rust, npm, offline caches (inference) |
| laws | Commit laws over history (`tools/check_laws.py`) | git history |
| contracts | Schemas and examples (`tools/check_contracts.py`) | python3 |
| unit | `tests/` and `tests/e2e/e2e1_slice` with unittest; any skip fails | python3 |
| agents | `agents/tests` plus the mutant harness, 300 s total | python3 |
| js | Kit sync check; FAIL with `kit absent` without a kit checkout (`tools/gate.sh:2009`) | node, kit checkout |
| rust | fmt, clippy `-D warnings`, tests, toolchain 1.92.0 offline (`tools/gate.sh:1732`) | rustup 1.92.0 |
| go | vet and `test -race` for `daemon-adapter`; FAIL if go is missing | go |
| ui | `npm ci --offline`, UI tests, type check, build | node 24 or later |
| ui-smoke | Must print `METAVIEWER_SMOKE_OK`; BLOCKED without Electron or xvfb-run (`tools/gate.sh:1849`) | Electron, xvfb-run |
| perf | Budget tests; the live memory probe runs only with `MV_GATE_PERF_LIVE=1`, else it is skipped and the leg still passes (`tools/gate.sh:1916`) | node |

No gate leg needs KVM or docker; only the ARM64 tools do (`tools/arm64_capsules.py:255`). Related: `tools/budget_gate.py` enforces the memory caps [CITED: tools/budget_gate.py:22]; `tools/router_index.py --check` verifies the contributor catalogue; `tools/gate_g_ai.py` is live-only and is in neither CI nor the gate.

## Commit laws checker

Answers: why was my commit refused, forbidden message pattern, subject must start with a supported English imperative verb, changelog fragment required

`tools/check_laws.py` refuses a commit message or history that breaks the laws in [LAWS.md](../../LAWS.md); each error prints `ERROR: <msg>` and exits 1, success prints `Laws check: OK`.

| Rule | Refusal text | Coordinate |
|---|---|---|
| Subject `<scope>: <Verb> ...`, scope in core, contracts, ui, ci, docs, deps, tools | `subject must use an allowed scope followed by ": " and an English imperative` | `tools/check_laws.py:16` |
| Verb from `VERBS` | `subject must start with a supported English imperative verb (see VERBS)` | `tools/check_laws.py:18` |
| At most 72 characters | `subject exceeds 72 characters` | `tools/check_laws.py:174` |
| No attribution or tool names anywhere in the message, case-insensitive | `forbidden message pattern: <word>` | `tools/check_laws.py:13` |
| Product code needs `changes/unreleased/<slug>.md` with `- ` bullets | `product code change requires a changelog fragment in changes/unreleased/<slug>.md ...` | `tools/check_laws.py:139` |
| Author and committer equal the maintainer identity | `<role> must be <NAME> <<EMAIL>>` | `tools/check_laws.py` |

Paths under `docs/`, `changes/`, `tests/` and a few top-level files are not product code, so a documentation-only commit needs no fragment (`tools/check_laws.py:100`). Any attribution trailer fails the substring check (inference from the match rule).

## What the end-to-end tests prove

Answers: what does each e2e test prove, which tests need Electron, which tests need the core, how do I run tests/e2e

`tests/e2e/run.py` runs every `*.test.js` with `MV_E2E_LIVE=1` and then requires a cross-route mutant to fail with `E2E_ROUTING`, else it raises `E2E_MUTANT` (`tests/e2e/run.py:44`, `tests/e2e/run.py:63`). CI wraps it in `xvfb-run`. No e2e test needs KVM.

| Tests | Proves | Needs |
|---|---|---|
| `ac02_wall`, `ac03_lifecycle`, `ac04_control`, `ac05_ai`, `ac06_multislot`, `ac07_ram_first` | Wall of 4 tiles with cross-route refusal; lifecycle tombstones; control witness; AI tool-call and proposal schema; a shared terminal is refused across slots; RAM-first recording requests | node; Electron and xvfb for live parts |
| `e2e3_refusals`, `e2e8_ac04_control_journey`, `e2e10_stale_settlement`, `e2e23_unknown_vs_destroyed` | `SURFACE_NOT_AGENT_CONTROLLED` after a human takes control; `STALE_FRAME` with the budget unchanged; an unknown surface gives a stale frame while a destroyed one gives not-agent-controlled | Rust core built by cargo |
| `e2e11_golden_replay`, `e2e12_replay_purity`, `e2e13_repeat_rung`, `e2e2_scenario` | Golden replay digests; tampering refused; replay purity; 20 identical digests | core; `e2e12` also cc and strace |
| `e2e17_arrival_registration_order`, `e2e22_correlation_trace`, `e2e4_seams` | Arrival-order determinism; strictly increasing trace sequence; frame conservation | core |
| `e2e14_perf`, `e2e18_budgets`, `e2e25_production_frames`, `e2e26_control_with_frames`, `e2e27_human_input`, `e2e1_wall` | Canvas soak; memory caps and a leak that must fail; production frames; control acknowledged within 1 s while frames flow; human input through the preload | Electron and xvfb |
| `e2e16_electron_security`, `e2e21_launcher`, `e2e19_nested` | Chromium security flags, CSP and preload; launcher create and destroy; nesting depth 1 allowed, depth 2 refused | Electron |
| `adapter_startup`, `e2e15_conservation_ledger`, `e2e20_headless_discipline`, `e2e24_routing_ownership` | Adapter start-up refuses within a finite deadline; scheduler conservation; pinned display geometry and typed gate errors; routing ownership refusals | node |

## Symptom to code

Answers: where do I look for this error, debugging an agent run, my run printed X

| Symptom | Likely cause | Look at |
|---|---|---|
| rc 6 `MW_PROGRAM_CONTROL` | The capsule is under human control | `tools/mw_run_program.py`; switch to Agent in the UI |
| rc 6 `MW_PROGRAM_GOAL_UNGROUNDED` | `--goal` is not exactly one visible element name | `tools/mw_run_program.py:423` |
| rc 6 `MW_HOME_*` before anything ran | MemoryWeb home mode, owner, symlink or content | `agents/metaviewer_agents/mw_home.py:130`; run `tools/mw_home_check.py` |
| rc 6 `MW_DEPENDENCY` | wender-agent root missing or not at its `deps.lock` commit | `tools/mw_run_backend.py:1042`, `agents/metaviewer_agents/perception/deps_lock.py:352` |
| rc 5 `INPUT_UNCERTAIN` | Input may have landed; effect not settled | `agents/metaviewer_agents/mw_run.py:255`; inspect the surface, do not retry |
| rc 4 `HUMAN_HANDOFF` | A wall was detected | `agents/metaviewer_agents/mw_handoff.py:33` |
| `bad_shape "external planner execution failed"` | Planner child failed or timed out; stderr was discarded | `agents/metaviewer_agents/planner.py:865`, `agents/metaviewer_agents/wender_bridge.py:428` |
| `VisionBridgeError('invalid description')` | Any parse failure | `agents/metaviewer_agents/vision.py:132`, read `__cause__` |
| `DEMO_REFUSED` with no detail | `tools/mv_demo.py` collapses internal codes | `tools/mv_demo.py:527` |
| `ARM64_SESSION_REFUSED` | ARM64 session start refused; needs aarch64, `/dev/kvm`, 32 GiB available | `tools/arm64_capsule_session.py:691`, `tools/arm64_capsule_session.py:801` |
| `mv-replay` prints `Invalid`, rc 2 | Relative, symlinked or copied session path | `core/src/journal/mod.rs:1274` |

For any symptom not listed, run `python3 route/route_query.py error "<exact text>"`, then `locate "<symptom in plain words>"`; the rows in `route/study/agents.jsonl` cover these files on this commit.

## Open bugs

Answers: known bugs, __pycache__ after mw_run, arm64 holds, exhaustive manifest inventory, paired terminal exited

| Bug [MEASURED, operator session] | What the code shows | Status |
|---|---|---|
| After `mw_run` the package gains `__pycache__`, and a later `--arm64` start holds with "exhaustive manifest inventory"; removing the bytecode clears it | `mw_run.main` loads `tools/mw_run_backend.py` with `exec_module` (`agents/metaviewer_agents/mw_run.py:390`), which imports `metaviewer_agents`; only the state-shim child sets `PYTHONDONTWRITEBYTECODE=1` (`tools/mw_run_backend.py:680`). `verifyInstall` walks every packaged file and throws `PKG_MANIFEST_MISMATCH: <name>` for any unlisted file (`ui/tools/package.js:1919`). The exact text "exhaustive manifest inventory" does not appear in this tree [MEASURED: git grep]; where it is raised: ABSENT — do not invent. The link between the two is inference | Workaround: delete the bytecode. Candidate fix (not applied, needs a negative control): set `PYTHONDONTWRITEBYTECODE` on the launcher |
| The paired terminal exited after a very long typed line | ABSENT — do not invent | Cause unknown |

## Limits of this dossier

Answers: what was not verified, what could not be run, how far to trust this

- This box has no KVM and no docker daemon: nothing ARM64, no capsule, no live run of `mw_run` was executed for this dossier. Live facts are the operator's, tagged as such.
- Run for this dossier: the span checker over every citation in `route/study/agents.jsonl`, and the Python unit tests in `agents/tests` (result in the pull request).
- `agents/metaviewer_agents/export.py` and `agents/metaviewer_agents/loop_trials.py` are covered only by rows in the study file; they have no callers outside tests [MEASURED: grep].
- The full error-code list is owned by the debugging lane; the codes above are those read in these files.
- Findings were written by a model and checked byte-for-byte against the code, but not reviewed by a person.

# Agents dossier: observation, admission, verification and handoff

Answers: how an AI drives MetaViewer; where to diagnose agent failures; what the agent tests prove

The public agent layer connects a human-selected capsule to observation, planning and the core's admission and verification interfaces. It gives a caller bounded ways to request work and inspect evidence. A planner chooses a candidate action; it does not own the capsule or authorize that action. Separating proposal, admission, native evidence and task postconditions makes failures diagnosable without treating a model's answer as proof.

This dossier and `route/study/agents.jsonl` are a reading map. Findings remain leads: use `python3 route/route_query.py show '<path>@<start>-<end>'` to inspect their cited bytes before explaining a bug. Coordinates below are normalized, half-open byte spans; study citations store a digest and a length, not an end offset. The scope is the public code, interfaces and synthetic tests cited here.


Coordinates: `agents/metaviewer_agents/tools.py@28233-29467`; `agents/metaviewer_agents/tools.py@32295-35114`; `agents/metaviewer_agents/verify.py@790-1513`; `agents/metaviewer_agents/mw_run.py@15389-19424`; `tools/mw_run_backend.py@54712-55158`.

## Entry points and parts

Answers: which entry point should I use; mw_run versus mvctl versus MCP; where does planning live

| Part | Responsibility | Source |
|---|---|---|
| `mw_run` | Validate the requested mode and run deadline; select the host runner | `agents/metaviewer_agents/mw_run.py` |
| Host backend | Attach to the running app, observe native state, bind proposals and collect receipts | `tools/mw_run_backend.py` |
| Stored workflows | Validate corpus, supported actions, notices, ownership and final predicates | `agents/metaviewer_agents/mw_owner.py` |
| Browser goals | Ground targets, focus an editor, type and read back | `tools/mw_run_browser_goal.py` |
| Host program goals | Ground visual actions and classify text evidence | `tools/mw_run_program.py` |
| `mvctl` | Explicit low-level tool calls and recording requests | `agents/metaviewer_agents/mvctl.py` |
| MCP | Stdio JSON-RPC bridge to the tool functions | `agents/metaviewer_agents/mcp_server.py` |
| Perception and planning | Bind element evidence to a frame and recheck target custody | `agents/metaviewer_agents/perception/vcore.py`, `agents/metaviewer_agents/planner.py` |
| Transport and tools | Validate requests, talk to core, correlate results and wait for verification | `agents/metaviewer_agents/client.py`, `agents/metaviewer_agents/tools.py` |

`mw_run` selects stored workflow mode with `--site` and `--workflow`, browser goal mode with `--goal`, or Host program mode with `--surface-kind program --goal`. Mixed selectors are rejected. MCP exposes observation, listing, proposal and verification; recording verbs belong to `mvctl`, not this MCP inventory.

Coordinates: `agents/metaviewer_agents/mw_run.py@15389-19424`; `tools/mw_run_backend.py@54712-55158`; `agents/metaviewer_agents/mvctl.py@15204-19512`; `agents/metaviewer_agents/mcp_server.py@0-1605`; `agents/metaviewer_agents/mcp_server.py@9452-11845`; `agents/metaviewer_agents/mcp_server.py@12163-15848`; `agents/metaviewer_agents/perception/vcore.py@54611-56375`; `agents/metaviewer_agents/planner.py@19050-21461`; `agents/metaviewer_agents/planner.py@21462-23811`; `agents/metaviewer_agents/planner.py@25127-25889`; `agents/metaviewer_agents/executor.py@772-1578`.

## Setup and dependency boundaries

Answers: how to run the public agent modules; which dependencies are private; why a compiled workflow fails

The package manifest is `agents/pyproject.toml`. From the repository root, `PYTHONPATH=agents python3 -m metaviewer_agents.mw_run ...` runs the module without assuming an installed shell entry point. Substitute the actual arguments required by the parser; `mw_run` deliberately does not offer `--help`. Its accepted flags are in `build_parser`.

A running app and an authorized capsule identity are prerequisites for live work. `MV_CORE_CONFIG` selects an explicit core configuration. Otherwise `discover_attach` looks for the unique packaged adapter belonging to the running packaged app; missing or ambiguous attachment refuses `MW_RUN_ATTACH`. Use the actual running identity and configuration, not fixture identities copied from tests.

Stored MemoryWeb workflows call `wender_api`, which resolves the pinned Wender checkout and refuses a compiled-only distribution with `MW_COMPILED_WORKFLOW_UNAVAILABLE`. The compiled `state`/`stopstate` adapter is a separate path; its existence does not make stored-workflow execution available. Explicit compiled runtime selection validates all payload files against public locks and refuses a broken selection rather than switching to source mode.

Private component source, installation rights and evaluation permissions are governed by [NOTICE-EVALUATION.md](../../NOTICE-EVALUATION.md). Wender, vision-engine and OpenSuperficies remain separate private programs. For the supplied release installation, start with [Judge quickstart](../JUDGE_QUICKSTART.md). This dossier neither supplies their source nor extends permission to use or redistribute them.

Coordinates: `agents/metaviewer_agents/mw_run.py@15389-19424`; `tools/mw_run_backend.py@54712-55158`; `tools/mw_run_backend.py@7339-9873`; `agents/metaviewer_agents/mw_owner.py@2907-3534`; `agents/metaviewer_agents/perception/compiled.py@709-1737`; `agents/metaviewer_agents/perception/compiled.py@388-1064`; `agents/metaviewer_agents/perception/compiled.py@3730-6693`; `NOTICE-EVALUATION.md@408-1910`.

## Data flow and evidence

Answers: how observation becomes input; why admitted does not mean completed; what verifies text

| Stage | Evidence required | Next boundary |
|---|---|---|
| Observe | Surface identity, frame digest/generation and retained frame witness | Perception/state |
| Perceive | Element table and state matching that frame | Planner target selection |
| Plan | Target from the current table and an action inside its geometry | Caller-side recheck |
| Propose | Frame-bound action, ownership and budget | Core admission |
| Dispatch and wait | Admitted proposal, native focus/input witness and correlated receipt | Verification |
| Finish workflow | Freshly true final predicates and a valid persisted run summary | Report |

The local planner checks the target ordinal, role, name, box and reconstructed state. `AdmittedExecutor` verifies proposal/verdict identity and requires focus plus input time, while discarding any transport fields that pretend to confer verification authority.

`tools.propose` returns an admitted verdict or raises a refusal. `tools.wait_verify` waits on the admitted proposal; its expectation argument is checked locally but is not sent in the frozen wait request. Pending results may cause another wait within the deadline, not another input submission. A timeout therefore does not prove that the input failed to arrive.

For stored workflows, the owner validates proposal, surface, timestamp, focus and after-frame bindings before retaining a receipt. Final success additionally requires the workflow's postconditions and schema-valid persisted summary. Preserve these distinct records when explaining a bug.

Coordinates: `agents/metaviewer_agents/planner.py@19050-21461`; `agents/metaviewer_agents/planner.py@21462-23811`; `agents/metaviewer_agents/planner.py@25127-25889`; `agents/metaviewer_agents/executor.py@772-1578`; `agents/metaviewer_agents/executor.py@772-2589`; `agents/metaviewer_agents/tools.py@28233-29467`; `agents/metaviewer_agents/tools.py@32295-35114`; `agents/metaviewer_agents/verify.py@790-1513`; `agents/metaviewer_agents/tools.py@32295-34302`; `agents/metaviewer_agents/mw_owner.py@14892-16376`; `agents/metaviewer_agents/mw_owner.py@39746-43651`; `agents/metaviewer_agents/mw_owner.py@22931-24977`; `agents/metaviewer_agents/mw_owner.py@43652-43936`; `tools/mw_run_backend.py@53705-54710`.

## MemoryWeb gate and local data

Answers: why a workflow is refused before input; what the gate checks; why profiles do not belong in MemoryWeb

The home admission checks path shape, ownership, privacy, tracking state and bounded contents. It rejects profile filenames, browser databases, linked paths and nested repositories. An unsafe existing home is refused rather than silently repaired. `tools/mw_home_check.py --repo <checkout> --workflow <site>/<workflow>` identifies home and provenance faults; `--home <absolute-path>` selects an override. Inspect its output before changing the definition.

`Corpus` requires canonical site/workflow JSON, matching identities and schemas equivalent to the pinned Wender bundle. It records document digests and rechecks integrity. Successful JSON parsing alone is insufficient evidence that a workflow is admissible.

The owner admits only the action/target/predicate forms it implements. Unsupported `wait_signal`, direct `type`, fallback targets, conditional or repeated steps refuse before input. Private `paste` slots are translated through the checked typing path. A nonempty final oracle is required. Fix the definition or implement the missing supported path in its owning lane; do not remove the negative control.

Replay requires explicit offline-fixture proof. Site execution requires a declared network mode which remains consistent, an acknowledged matching notice and elapsed notice duration. Restart permission and an outstanding write-approval requirement refuse this runner. Ownership and stop state are checked again during send preparation.

Coordinates: `agents/metaviewer_agents/mw_home.py@1295-2666`; `agents/metaviewer_agents/mw_home.py@4382-7779`; `tools/mw_run_backend.py@54712-56698`; `tools/mw_home_check.py@3961-5877`; `agents/metaviewer_agents/mw_owner.py@4128-6926`; `agents/metaviewer_agents/mw_owner.py@14892-15474`; `agents/metaviewer_agents/mw_owner.py@27713-30141`; `agents/metaviewer_agents/mw_owner.py@39173-39746`; `agents/metaviewer_agents/mw_owner.py@11327-12205`; `agents/metaviewer_agents/mw_owner.py@16377-17048`; `agents/metaviewer_agents/mw_owner.py@14892-17795`.

## Perception, planning and stale frames

Answers: why a stale target refuses; where low-confidence model choices stop; what a digest proves

`project_element_table` rejects C2 evidence whose frame digest differs, and rejects normalized vision that has lost its adapter binding. Validated geometry and labels become candidate elements; they do not establish that the model understood the user's goal.

`ReplayOwner.sense` checks the frame reference, table and retained witness together. Frame generations cannot move backwards, and an equal generation cannot carry a different digest. State validation and stop detection run before targets can be used. Diagnose `MW_FRAME_BINDING`, `MW_STALE_PUBLICATION` or `identity_mismatch` at that boundary before blaming the planner.

The opt-in model planner still has to select an actual mark with a matching element-table row. It refuses `need_reasoning` and a supplied confidence below the configured threshold. Missing confidence is allowed by this code, so do not describe confidence as a mandatory proof. A syntactically valid model answer with an absent or ambiguous mark is also refused.

Coordinates: `agents/metaviewer_agents/mw_owner.py@19374-21550`; `agents/metaviewer_agents/perception/vcore.py@54611-56375`; `tools/mw_run_program.py@40516-42744`.

## Browser goals and Host program evidence

Answers: how browser typing is checked; what uncertified_text means; does a successful key prove a game move

Browser goal mode derives actionable targets from native state. A text action needs a unique native editor identity matching the selected target and current focus. Before optional Enter, exact native readback checks both the value and its observed length. Readback polling refreshes wall, focus and identity evidence without repeating input.

Host program text handling separately classifies readback after the core receipt. Exact text produces `verified_text`; absent certification can produce `uncertified_text`; mismatching text refuses `MW_PROGRAM_TEXT_MISMATCH`. A core-verified input must not be presented as an exact-text success when the readback is uncertified.

`--goal focused-key` is an explicit Host program mode. Its key receipt records `source='operator_asserted_focus'` and `gameplay_verified=False` in `tools/mw_run_program.py`. The parser restricts that request to the rules planner and a single step [CITED: agents/metaviewer_agents/mw_run.py]. A delivered key is not evidence that an application-level task or game objective was completed.

Coordinates: `tools/mw_run_browser_goal.py@6007-8477`; `tools/mw_run_browser_goal.py@11301-17650`; `tools/mw_run_program.py@33497-36247`; `tools/mw_run_program.py@37822-39443`; `agents/metaviewer_agents/mw_run.py@15389-19424`; `tools/mw_run_backend.py@54712-55158`.

## Human handoff and uncertain input

Answers: what happens at login or CAPTCHA walls; can a stopped run resume; what INPUT_UNCERTAIN means

`HandoffLatch` inspects the existing state through the stop detector, with an explicit observed wall marker as an additional signal. Login controls alone are not equivalent to an observed wall. On a stop, the latch closes before artifact persistence; a failed write cannot reopen input. The artifact retains reason and evidence kinds rather than raw detector values.

The owner stops with `HUMAN_HANDOFF`, and its guard blocks subsequent sensing/action/run work. There is no reset/resume operation on that latch. A new authorized run uses a new owner after human intervention. Handoff is a stop boundary, not an attempt to bypass a wall.

A mismatched or absent input receipt can leave the outcome uncertain. The hosted negative tests expect `INPUT_UNCERTAIN`, no further Return or replay, and no manufactured successful run summary. Preserve the intent and receipt evidence and inspect the application state before deciding what a human should do next.

Coordinates: `agents/metaviewer_agents/mw_handoff.py@740-3148`; `agents/metaviewer_agents/mw_owner.py@18622-19373`; `agents/metaviewer_agents/mw_owner.py@49007-49261`; `agents/metaviewer_agents/mw_owner.py@51817-52970`; `agents/metaviewer_agents/mw_owner.py@14892-16376`; `agents/metaviewer_agents/mw_owner.py@39746-43651`; `tests/e2e/asm_web_memoryweb_hosted.test.js@379-1871`; `tests/e2e/asm_web_memoryweb_hosted.test.js@3852-5191`; `tests/e2e/e2e1_slice/asm_web_live.py@52147-53735`; `tests/e2e/asm_web_memoryweb_hosted.test.js@16559-19439`; `tests/e2e/asm_web_memoryweb_hosted.test.js@21668-23970`.

## Failure diagnosis

Answers: where to find the cause of common agent refusals; what should change

| Symptom | Check before changing anything | Relevant boundary |
|---|---|---|
| `MW_RUN_ATTACH` | Actual packaged app parent, unique candidate and attachment environment | `discover_attach`, `attach_env` |
| `MW_HOME_*` | Private home, ignore/tracking state, profile content, links and modes | `mw_home`, `mw_home_check` |
| `MW_SCHEMA_PIN`, `MW_CANONICAL`, `MW_GATE_*` | Bundle/projection identity, canonical bytes and provenance | `Corpus`, pinned gate |
| `MW_COMPILED_WORKFLOW_UNAVAILABLE` | Whether stored-workflow source interface is present | `wender_api` |
| `MW_NETWORK`, `MW_NOTICE` | Positive network proof, matching notice and policy | Owner checks |
| `MW_FRAME_BINDING`, `MW_STALE_PUBLICATION` | Same surface/digest/generation across evidence | `sense` |
| `MW_RECEIPT_MISMATCH` | Proposal, native input time/focus and after-frame correlation | Owner `send` |
| `MW_BROWSER_FOCUS`, `MW_BROWSER_TEXT_MISMATCH` | Native editor identity and exact readback | Browser goal runner |
| `MW_PROGRAM_MODEL_TARGET` | Mark, target row, geometry and decision flags | Model planner |
| `uncertified_text` | Whether exact text readback was available | Program text dispatcher |
| `HUMAN_HANDOFF` | Stop record and human intervention | Absorbing handoff latch |

These are code-level diagnostic branches, not a claim that every occurrence has one external cause. Preserve the exact refusal and its report, route it with `error`, then inspect the cited branch and its governing test.

Coordinates: `tools/mw_run_backend.py@7339-9873`; `agents/metaviewer_agents/mw_home.py@1295-2666`; `agents/metaviewer_agents/mw_home.py@4382-7779`; `tools/mw_run_backend.py@54712-56698`; `agents/metaviewer_agents/mw_owner.py@4128-6926`; `agents/metaviewer_agents/mw_owner.py@14892-15474`; `agents/metaviewer_agents/mw_owner.py@2907-3534`; `agents/metaviewer_agents/perception/compiled.py@709-1737`; `agents/metaviewer_agents/mw_owner.py@11327-12205`; `agents/metaviewer_agents/mw_owner.py@16377-17048`; `agents/metaviewer_agents/mw_owner.py@14892-17795`; `agents/metaviewer_agents/mw_owner.py@19374-21550`; `agents/metaviewer_agents/mw_owner.py@14892-16376`; `agents/metaviewer_agents/mw_owner.py@39746-43651`; `tools/mw_run_browser_goal.py@6007-8477`; `tools/mw_run_browser_goal.py@11301-17650`; `tools/mw_run_program.py@33497-36247`; `tools/mw_run_program.py@40516-42744`; `agents/metaviewer_agents/mw_handoff.py@740-3148`; `agents/metaviewer_agents/mw_owner.py@18622-19373`; `agents/metaviewer_agents/mw_owner.py@49007-49261`; `agents/metaviewer_agents/mw_owner.py@51817-52970`.

## Where to change what

Answers: which file owns a fix; which dependent checks should accompany it

| Intended change | Owning public code | Dependent checks |
|---|---|---|
| Accepted invocation/mode | `mw_run.py`, `mvctl.py` | Entry flags, CLI matrix and timeout tests |
| Tool exposure or error mapping | `mcp_server.py`, `tools.py` | MCP inventory, malformed arguments, conformance and receipt tests |
| Native attachment or binding | `tools/mw_run_backend.py` | Attachment, native receipts, program/browser runner tests |
| Corpus admission or supported workflow | `mw_owner.py`, `mw_home.py` | Owner, home and hosted workflow mutations |
| Frame or target interpretation | `perception/vcore.py`, `planner.py` | Element-table, identity and planner tests |
| Stop/handoff behavior | `mw_handoff.py`, owner stop checks | Handoff and hosted wall tests |
| Text completion claim | Browser/program runner | Native readback and missing/mismatched receipt tests |

The frozen wire contracts and private component implementations are outside this dossier's edit surface. Changes must preserve the distinction between refusal, uncertainty and completion, and retain negative controls.

Coordinates: `agents/metaviewer_agents/mw_run.py@15389-19424`; `tools/mw_run_backend.py@54712-55158`; `agents/metaviewer_agents/mvctl.py@15204-19512`; `agents/metaviewer_agents/mcp_server.py@0-1605`; `agents/metaviewer_agents/mcp_server.py@9452-11845`; `agents/metaviewer_agents/mcp_server.py@12163-15848`; `agents/metaviewer_agents/mw_owner.py@14892-16376`; `agents/metaviewer_agents/mw_owner.py@39746-43651`; `agents/metaviewer_agents/mw_owner.py@4128-6926`; `agents/metaviewer_agents/mw_owner.py@14892-15474`; `agents/metaviewer_agents/perception/vcore.py@54611-56375`; `agents/metaviewer_agents/planner.py@19050-21461`; `agents/metaviewer_agents/planner.py@21462-23811`; `agents/metaviewer_agents/planner.py@25127-25889`; `agents/metaviewer_agents/executor.py@772-1578`; `agents/metaviewer_agents/mw_handoff.py@740-3148`; `agents/metaviewer_agents/mw_owner.py@18622-19373`; `agents/metaviewer_agents/mw_owner.py@49007-49261`; `agents/metaviewer_agents/mw_owner.py@51817-52970`; `tools/mw_run_browser_goal.py@6007-8477`; `tools/mw_run_browser_goal.py@11301-17650`; `tools/mw_run_program.py@33497-36247`.

## Tests and their proof boundaries

Answers: how to test the agent layer; what each test proves; which tests require Wender

Run checks from the repository root under the required resource scope, for example:

```sh
systemd-run --user --scope -p MemoryHigh=6G -p MemoryMax=8G -p MemorySwapMax=0 \
  env PYTHONPATH=agents python3 -m unittest discover -s agents/tests -p test_mcp_server.py
```

The resource values in this example are execution limits [TARGET]. Select a test file from the table for the next focused check; do not infer live acceptance from discovery alone.

| Test | What its assertions cover | What it does not establish |
|---|---|---|
| `agents/tests/test_mcp_server.py` | Closed inventory, argument validation, refusal/error mapping and stdio framing | Real core or desktop; tools are patched and client is a stub |
| `agents/tests/test_mw_run.py` | Parser guards, home-before-connection ordering and fixture summary checks | A native UI session; summary cases reuse the Wender fixture |
| `agents/tests/test_mw_handoff.py` | Stop record, absorbing latch, wall-before-intent and pacing boundaries | Every real site's wall; observations and timing are injected |
| `tests/e2e/asm_web_memoryweb_hosted.test.js` | Real Wender workflow runner composed with hosted RPC fakes; schema, receipt, private text and wall mutations | Live browser, real native core or complete GUI acceptance |

The hosted file requires `MV_MW_WENDER_ROOT` or `MV_WENDER_ROOT` pointing to the locked checkout [CITED: tests/e2e/asm_web_memoryweb_hosted.test.js]. With that prerequisite verified, its command is `node --test tests/e2e/asm_web_memoryweb_hosted.test.js`, wrapped in the same resource scope. A compiled-only distribution cannot satisfy its fixture builder's Wender source interface.

For a useful regression, pair the nominal result with the existing negative case: extra MCP property must not dispatch; unsafe home must not connect; wrong receipt must not advance; wall detection must prevent the next intent. Actual live acceptance remains a separate run with native evidence. Its outcome is ABSENT — do not invent unless measured.

Coordinates: `agents/tests/test_mcp_server.py@0-3565`; `agents/tests/test_mcp_server.py@7785-9493`; `agents/tests/test_mcp_server.py@29400-32379`; `agents/tests/test_mw_run.py@649-4488`; `agents/tests/test_mw_handoff.py@0-4786`; `agents/tests/test_mw_handoff.py@4786-7690`; `tests/e2e/asm_web_memoryweb_hosted.test.js@379-1871`; `tests/e2e/asm_web_memoryweb_hosted.test.js@3852-5191`; `tests/e2e/e2e1_slice/asm_web_live.py@52147-53735`; `tests/e2e/asm_web_memoryweb_hosted.test.js@16559-19439`; `tests/e2e/asm_web_memoryweb_hosted.test.js@21668-23970`.

## Router use and closure

Answers: how to retrieve this study; why fresh citations are not proof; who rebuilds the index

Start with `python3 route/route_query.py any "why does MemoryWeb reject a compiled workflow"` or an exact error query. Use `ask --level dossier` for subsystem findings, then `show` on the returned coordinate. A `FRESH` digest means the cited bytes match; it does not prove the interpretation or runtime outcome.

After changes, validate every study tuple as `[path, digest, start, length]` against normalized source bytes and include a changed-digest negative control. Run the route and legacy index checks and report their actual results. The conductor owns rebuilding the document/study manifest and the legacy catalogue; this lane does not refresh them.

This mandate and all explanations above are limited to the supplied public corpus and the cited test evidence.

Coordinates: `agents/metaviewer_agents/tools.py@28233-29467`; `agents/metaviewer_agents/tools.py@32295-35114`; `agents/metaviewer_agents/verify.py@790-1513`; `agents/metaviewer_agents/mw_owner.py@4128-6926`; `agents/metaviewer_agents/mw_owner.py@14892-15474`; `agents/tests/test_mcp_server.py@0-3565`; `agents/tests/test_mcp_server.py@7785-9493`; `agents/tests/test_mcp_server.py@29400-32379`.

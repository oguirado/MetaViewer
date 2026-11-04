# Agents dossier: observation, admission, verification and handoff

Answers: how an AI drives MetaViewer; where to diagnose agent failures; what the agent tests prove

The agent layer (`agents/metaviewer_agents/`, `tools/mw_run*.py`) lets a caller observe a capsule, propose an action and wait for the core's verified receipt. A planner or model chooses a candidate action. It does not own the capsule and it does not authorize the action: the core admits or refuses (see [core.md](core.md)). This file locates code and refusals; it does not prove them.

## Which entry point do I use?

Use mw_run for a task workflow, mvctl for explicit tool calls, or the stdio MCP bridge for its closed tool set.

Answers: mw_run versus mvctl versus MCP; where does planning live

| Entry | Use it for | Source |
|---|---|---|
| `mw_run` | High-level run: a stored workflow (`--site`, `--workflow`), a browser goal (`--goal`) or a Host program goal (`--surface-kind program --goal`). Mixed selectors are rejected. | `build_parser`, `agents/metaviewer_agents/mw_run.py:339` |
| `mvctl` | Explicit low-level tool calls and recording requests | `agents/metaviewer_agents/mvctl.py` |
| MCP server | Stdio JSON-RPC bridge. Exactly four tools: `mv_observe`, `mv_list`, `mv_propose`, `mv_wait_verify` (`agents/metaviewer_agents/mcp_server.py:56`). Recording verbs are not exposed here. | `agents/metaviewer_agents/mcp_server.py` |
| Tool functions | `observe`, `list_surfaces`, `propose`, `wait_verify` | `agents/metaviewer_agents/tools.py:648`, `:687`, `:724`, `:836` |
| Attach and run backend | Finds the running app, binds proposals, collects receipts | `tools/mw_run_backend.py` |
| Stored workflow owner | Corpus, supported actions, notices, ownership, final predicates | `agents/metaviewer_agents/mw_owner.py` (`ReplayOwner`, line 237) [CITED: `agents/metaviewer_agents/mw_owner.py`] |
| Browser and program runners | Browser typing with readback; Host program visual actions | `tools/mw_run_browser_goal.py`, `tools/mw_run_program.py` |
| Perception and planning | Element table bound to a frame; target custody | `agents/metaviewer_agents/perception/vcore.py:1458`, `agents/metaviewer_agents/planner.py` |

`mw_run` has no `--help` (`add_help=False`); read `build_parser` for flags.

## What must exist before a live run, and which parts are private?

From the repository root, `PYTHONPATH=agents python3 -m metaviewer_agents.mw_run ...` runs the module. A live run needs a running MetaViewer app. With `MV_CORE_CONFIG` set, that configuration is used. Without it, `discover_attach` (`tools/mw_run_backend.py:144`) looks for the one packaged app that is running; none or several refuse `MW_RUN_ATTACH`. Use your own running identity, not fixture identities copied from tests.

Answers: how to run the modules; MW_RUN_ATTACH; why a compiled workflow fails

Stored MemoryWeb workflows need the pinned Wender checkout. `agents/metaviewer_agents/mw_owner.py:80` refuses `MW_COMPILED_WORKFLOW_UNAVAILABLE` when only the compiled runtime (`wender-runtime`) is present.

Wender, vision-engine and OpenSuperficies are separate private programs. Source, installation and evaluation rights are in [NOTICE-EVALUATION.md](../../NOTICE-EVALUATION.md); this file grants none. For the supplied release start with [Judge quickstart](../JUDGE_QUICKSTART.md).

## How does an observation become an admitted action, and why is admitted not completed?

A frame-bound proposal passes admission before dispatch; verified completion needs subsequent evidence.

Answers: observation to input; wait_verify; what verifies text

| Stage | Evidence required |
|---|---|
| Observe | Surface identity, frame digest and generation, retained frame witness |
| Perceive | Element table and state matching that frame |
| Plan | A target from the current table and an action inside its box |
| Propose | Frame-bound action, ownership and budget; the core admits or refuses |
| Dispatch and wait | Admitted proposal, native focus and input time, correlated receipt |
| Finish a stored workflow | Final predicates true again, and a schema-valid run summary |

`AdmittedExecutor.dispatch` (`agents/metaviewer_agents/executor.py:23`) checks proposal and verdict identity and requires `focus_verified` plus an input time. It returns only those two fields, so a transport cannot add verification authority.

`wait_verify` (`agents/metaviewer_agents/tools.py:836`) checks the expectation locally but does not send it: "the frozen call carries no expectation slot". Pending results repeat only the wait, never the input. A timeout does not prove the input failed to arrive.

## Why is a workflow refused before any input?

The workflow owner checks home, corpus, supported forms and required notices before allowing input.

Answers: MemoryWeb gate; unsupported step; notice; network mode

- Home: `agents/metaviewer_agents/mw_home.py` rejects unsafe path shape, ownership, profile files, browser databases, links and nested repositories (`MW_HOME_PATH`, `MW_HOME_MODE`). Diagnose with `python3 tools/mw_home_check.py --repo <checkout> --workflow <site>/<workflow>`.
- Corpus: `Corpus` (`agents/metaviewer_agents/mw_owner.py:103`) requires canonical JSON and a schema equal to the pinned bundle (`MW_SCHEMA_PIN`, `MW_CANONICAL`).
- Supported forms: only the action, target and predicate forms the owner implements. Unsupported `wait_signal`, direct `type`, fallback targets and conditional or repeated steps refuse before input; a nonempty final oracle is required.
- Site runs: a declared, consistent network mode (`MW_NETWORK`, `agents/metaviewer_agents/mw_owner.py:244`) and an acknowledged matching notice (`MW_NOTICE`, `:353`). Replay needs explicit offline-fixture proof.

Do not remove a negative control to get past a refusal.

## Why does a stale target refuse, and what does a digest prove?

`project_element_table` (`agents/metaviewer_agents/perception/vcore.py:1458`) rejects evidence whose frame digest differs. `ReplayOwner.sense` (`agents/metaviewer_agents/mw_owner.py:389`) checks the frame reference, element table and retained witness together; a generation cannot move backwards. A matching digest shows which bytes were analysed. It does not show the model understood the goal.

Answers: MW_FRAME_BINDING; MW_STALE_PUBLICATION; model planner refusals

The opt-in model planner for Host programs must pick a mark that has a table row. It refuses `need_reasoning` and a confidence below the threshold (`tools/mw_run_program.py:766`, `MW_PROGRAM_MODEL_TARGET`). Missing confidence is allowed by that code, so confidence is not a mandatory proof.

## How are browser and Host program text checked?

Browser goals need one native editor whose identity matches the target and current focus (`MW_BROWSER_FOCUS`, `tools/mw_run_browser_goal.py:142`). Before an optional Enter, exact native readback must match the value and its length (`MW_BROWSER_TEXT_MISMATCH`, `:161`).

Answers: MW_BROWSER_TEXT_MISMATCH; uncertified_text; focused-key

Host program text is classified after the core receipt: exact readback gives `verified_text`, a missing certificate gives `uncertified_text`, a mismatch refuses `MW_PROGRAM_TEXT_MISMATCH` (`tools/mw_run_program.py:673`). Do not report `uncertified_text` as an exact-text success.

`--goal focused-key` sends one operator-selected key. Its receipt records `source='operator_asserted_focus'` and `gameplay_verified=False` (`tools/mw_run_program.py:726`). The parser limits it to `--steps 1` and the rules planner (`agents/metaviewer_agents/mw_run.py:366`). A delivered key is not evidence that a task or game objective was completed.

## What happens at a login or CAPTCHA wall?

`HandoffLatch` (`agents/metaviewer_agents/mw_handoff.py:26`) inspects state through the stop detector. Login controls alone are not a wall. On a stop the latch closes before the artifact is written, so a failed write cannot reopen input. The module has "no solver, retry, reset or resume operation" (`agents/metaviewer_agents/mw_handoff.py:1`). The owner stops with `HUMAN_HANDOFF` (`agents/metaviewer_agents/mw_owner.py:387`); after a person intervenes, start a new run with a new owner. Handoff is a stop, not a way past a wall.

Answers: HUMAN_HANDOFF; can a stopped run resume; INPUT_UNCERTAIN

A missing or mismatched input receipt can leave the outcome uncertain (`INPUT_UNCERTAIN`, preserved on deadline, `agents/metaviewer_agents/mw_run.py:21`). Tests expect no further Return, no replay and no manufactured success summary. Inspect the application state before deciding what a person does next.

## Which refusal means what?

Use the exact refusal code to locate the failed check; a code does not identify a unique external cause.

Answers: where to find the cause of a refusal code; what to check first

| Symptom | Check first | Code |
|---|---|---|
| `MW_RUN_ATTACH` | One packaged app running; attach environment | `tools/mw_run_backend.py:144` |
| `MW_HOME_*` | Private home, tracking, profile files, links, modes | `agents/metaviewer_agents/mw_home.py`, `tools/mw_home_check.py` |
| `MW_SCHEMA_PIN`, `MW_CANONICAL`, `MW_GATE_*` | Bundle identity and canonical bytes | `agents/metaviewer_agents/mw_owner.py:103` |
| `MW_COMPILED_WORKFLOW_UNAVAILABLE` | Stored-workflow source present? | `agents/metaviewer_agents/mw_owner.py:80` |
| `MW_NETWORK`, `MW_NOTICE` | Network proof, matching notice | `agents/metaviewer_agents/mw_owner.py:244` |
| `MW_FRAME_BINDING`, `MW_STALE_PUBLICATION` | Same surface, digest, generation | `agents/metaviewer_agents/mw_owner.py:389`, `tools/mw_run_program.py:402` |
| `MW_RECEIPT_MISMATCH` | Proposal, input time, focus, after-frame | `tools/mw_run_program.py:205` |
| `MW_BROWSER_FOCUS`, `MW_BROWSER_TEXT_MISMATCH` | Editor identity, exact readback | `tools/mw_run_browser_goal.py:142` |
| `MW_PROGRAM_MODEL_TARGET` | Mark, row, geometry, flags | `tools/mw_run_program.py:766` |
| `HUMAN_HANDOFF` | Stop record | `agents/metaviewer_agents/mw_handoff.py:26` |

Operator-facing text for many codes is in `agents/metaviewer_agents/mw_refusals.py`. These are code branches, not one external cause each: keep the exact refusal and its report, route it with `python3 route/route_query.py error "<code>"`, then read the branch and its test.

## Where do I change what, and what do the tests prove?

Tests cover the public boundary owned by each module; patched tools and fake observations do not establish live acceptance.

Answers: which file owns a fix; how to test the agent layer; which tests need Wender

| Change | Owning code | Check with |
|---|---|---|
| Accepted flags or mode | `mw_run.py`, `mvctl.py` | `agents/tests/test_mw_run.py` |
| Tool exposure or error mapping | `mcp_server.py`, `tools.py` | `agents/tests/test_mcp_server.py`, `agents/tests/test_mcp_conformance.py` |
| Native attachment or binding | `tools/mw_run_backend.py` | program and browser runner tests |
| Corpus or supported workflow | `mw_owner.py`, `mw_home.py` | hosted workflow test below |
| Frame or target interpretation | `perception/vcore.py`, `planner.py` | element-table and planner tests |
| Stop and handoff | `mw_handoff.py`, owner stop checks | `agents/tests/test_mw_handoff.py` |
| Text completion claim | browser and program runners | readback and receipt-mismatch tests |

Frozen wire contracts and the private components are outside this file's surface. Keep refusal, uncertainty and completion distinct and keep negative controls.

| Test | Covers | Does not establish |
|---|---|---|
| `agents/tests/test_mcp_server.py` | Closed tool inventory, argument validation, error mapping, stdio framing | A real core or desktop; tools are patched |
| `agents/tests/test_mw_run.py` | Parser guards, home-before-connection order | A native UI session |
| `agents/tests/test_mw_handoff.py` | Stop record, absorbing latch, wall before intent | Any real site's wall; observations are injected |
| `tests/e2e/asm_web_memoryweb_hosted.test.js` | Real Wender runner with hosted RPC fakes: schema, receipt, wall mutations | Live browser, real core, GUI acceptance |

Example, under the resource scope:

```sh
systemd-run --user --scope -p MemoryHigh=6G -p MemoryMax=8G -p MemorySwapMax=0 \
  env PYTHONPATH=agents python3 -m unittest discover -s agents/tests -p test_mcp_server.py
```

The hosted test needs `MV_MW_WENDER_ROOT` or `MV_WENDER_ROOT` pointing at the locked Wender checkout; run it with `node --test tests/e2e/asm_web_memoryweb_hosted.test.js` in the same scope. A compiled-only distribution cannot satisfy it. Pair each nominal result with its negative case: an extra MCP property must not dispatch, an unsafe home must not connect, a wrong receipt must not advance, a detected wall must block the next intent. Live acceptance results: ABSENT — not measured here.

Router: `python3 route/route_query.py any "<question>"`, then `show` on a returned coordinate. A `FRESH` digest means the cited bytes match, not that the reading is right. The conductor rebuilds indexes.

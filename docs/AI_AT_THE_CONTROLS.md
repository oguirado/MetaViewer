# An AI at the controls of MetaViewer

MetaViewer gives an AI a named capsule to operate, a live wall for the person to
watch, and checked action results to inspect before continuing. The AI still
needs a concrete task, the correct live binding and a check of the final outcome.
This page explains that operating model; it is not a live verification report.

Answers: why should an AI use MetaViewer for computer use.

A **capsule** is a named live task surface or guest session. A **player** acts
inside one capsule; a **director** arranges and observes the wall. These are
roles in a workflow, not additional built-in agents. Capsule kinds and their
boundaries are defined in [WHY_CAPSULES.md](WHY_CAPSULES.md) and
[CITED: ui/src/catalog/catalogModel.js]. Host programs run as the host user;
their separate display is not an isolation boundary.

## 0. Reading map

Choose the document for the next operation; the command protocol lives in
[AGENT_ENTRY.md](AGENT_ENTRY.md).

Answers: which document should an AI or judge read next.

| Need | Document |
|---|---|
| Understand the reason for capsules | [Why capsules](WHY_CAPSULES.md) |
| Arrange the wall, open capsules and use controls | [UI operator guide](AI_OPERATOR_GUIDE.md) |
| Attach an AI and follow a task button | [Agent entry protocol](AGENT_ENTRY.md) |
| Run a bounded goal and read its result | [First run](MW_RUN_FIRST_RUN.md) |
| Build a game, drawing or commentary session | [Computer-use playbook](COMPUTER_USE_PLAYBOOK.md) |
| Run the portable example programs | [Example entry points](../examples/computer-use/README.md) |
| Inspect recorded development usage | [Meta AI usage](../META_AI_USAGE.md) |

## 1. Why MetaViewer suits computer use

The checked runners bind actions to a particular live capsule and verify their
results, while the wall keeps the person able to observe and take control.
They do not make arbitrary desktop coordinates reliable.

Answers: what do capsules add to an AI computer-use loop.

| Need | Mechanism | Public source |
|---|---|---|
| Select the intended target | Copied capsule and identity, checked against live bindings | [capsuleId.js](../ui/src/wall/capsuleId.js), [program runner](../tools/mw_run_program.py) |
| Ground a click | A unique observed control name and current frame | [browser runner](../tools/mw_run_browser_goal.py), [program runner](../tools/mw_run_program.py) |
| Check visible change | Program click verification compares retained frames and rejects clock-only changes | [program runner](../tools/mw_run_program.py) |
| Keep human control | Agent input is refused during human takeover | [RoleSurface.vue](../ui/src/surfaces/RoleSurface.vue), [program runner](../tools/mw_run_program.py) |
| Avoid duplicate uncertain input | Stop on `INPUT_UNCERTAIN`; inspect before deciding what follows | [mw_refusals.py](../agents/metaviewer_agents/mw_refusals.py) |
| Inspect a session afterward | Journal verification with `mv-replay` | [mv-replay.rs](../core/src/bin/mv-replay.rs), [journal lifecycle](JOURNAL_END.md) |

The cost is deliberate: use supported actions, keep attachment and identity
current, wait for verification, and inspect the outcome. UI clicks that arrange
the wall are a separate control path from checked input inside a capsule.

## 2. Which agent CLIs work

The paired terminal offers installed host profiles for the following CLIs;
a missing executable is omitted, not replaced by another program.

Answers: which installed agent CLIs can the paired terminal start.

| Profile | Executable |
|---|---|
| `agent-codex` | `codex` |
| `agent-gemini` | `gemini` |
| `agent-opencode` | `opencode` |
| `agent-muse` | `muse` |

The host defines executables and arguments in
[CITED: ui/electron/agentProviders.js]. A recognized input prompt permits
bracketed paste; a sign-in or workspace-trust question stops it. The app never
presses Enter. Readiness is a text check, not proof of an authenticated account or
a successful task [CITED: ui/src/terminal/agentPromptGate.js].
See [paired agent preparation](AGENT_ENTRY.md#paired-agent-preparation) for the
attachment and profile requirements.

## 3. What Copy ID for AI and Direct task give the AI

**Copy ID for AI** copies target data; a task button prepares instructions for
the person to complete and submit.

Answers: what do the identity and task controls give the AI.

The copied shape is `CAPSULE=<surfaceId>  IDENTITY=<profileId>`.
`IDENTITY=<none>` means the usable identity is missing: stop and obtain it from
the operator [CITED: ui/src/wall/capsuleId.js].

| Button | Job | Protocol |
|---|---|---|
| Create automation | Turn an operator demonstration into a reviewed workflow | [Create automation](AGENT_ENTRY.md#create-automation) |
| Run automation | Execute an authored workflow after preflight | [Run automation](AGENT_ENTRY.md#run-automation) |
| Direct task | Execute a bounded goal without a stored workflow | [Direct task](AGENT_ENTRY.md#direct-task) |

These prompts end with `Task: `. For a command MicroVM, Direct task instead
carries `MICROVM`, `GENERATION`, `OWNER` and its complete binding; the other
buttons refuse that target [CITED: ui/src/terminal/workflowPrompts.js]. Follow
[MicroVM Direct task](AGENT_ENTRY.md#microvm-direct-task); the human owns Back.

## 4. Recipe: an AI operating one capsule

Attach, observe, act within the supported bounds, read the result, then observe
again. Continue only when the next step is justified by the new state.

Answers: what loop should an AI follow from task to verified outcome.

1. The person opens the intended capsule and supplies the task and copied ID.
2. The AI reads the matching section in [AGENT_ENTRY.md](AGENT_ENTRY.md), sources
   the live attachment in a task subshell and verifies the binding.
3. The AI observes the target before input. A missing or ambiguous target stops
   the task. Browser observation and program observation use different backends.
4. The person releases manual control before agent input. The AI selects a
   supported action from the current observation, not remembered coordinates.
5. The AI runs a bounded goal as shown in [MW_RUN_FIRST_RUN.md](MW_RUN_FIRST_RUN.md).
6. The AI reads the result, report and receipt, and inspects the fresh visible
   state. A verified action alone does not establish task completion.
7. The AI either chooses the next supported step, reports the verified outcome,
   or stops with the exact refusal and evidence needed by the person.

For wall layout, model players and multi-capsule sessions, use the separate
[playbook](COMPUTER_USE_PLAYBOOK.md#choose-the-control-level).

## 5. What the core and `mw_run` check

Checks cover action admission and bounded results, not arbitrary user goals.

Answers: which action checks do the core and runner enforce.

| Check | Refusal or result boundary | Source |
|---|---|---|
| Parser and action budget | Goal mode excludes stored-workflow flags | [mw_run.py](../agents/metaviewer_agents/mw_run.py) |
| Live identity and control | Wrong binding or human control prevents input | [program runner](../tools/mw_run_program.py), [backend](../tools/mw_run_backend.py) |
| Browser text | Exact native readback is required before optional Enter | [browser runner](../tools/mw_run_browser_goal.py) |
| Program text | Readback can be `exact`, `mismatch` or `not_readable`; the last is explicitly uncertified | [program runner](../tools/mw_run_program.py) |
| Program click | No qualifying visible change returns `MW_PROGRAM_NO_VISIBLE_EFFECT` | [program runner](../tools/mw_run_program.py) |
| Focused navigation | Host program only, rules planner, no text and a bounded key | [program runner](../tools/mw_run_program.py) |
| Session capacity | `JOURNAL_FULL` ends admission; preserve the journal | [journal_end.rs](../core/src/serve/journal_end.rs) |

## 6. Refusals and journals: what the AI must respect

Stop on refusals, and never repeat an input whose delivery is uncertain.

Answers: how must an AI handle refusals and session journals.

| Result [CITED: agents/metaviewer_agents/mw_refusals.py, tools/mw_run_backend.py] | Required response |
|---|---|
| `rc 0` | Inspect the verdict as well: program text can remain uncertified. Verify the requested outcome. |
| `rc 4`, `HUMAN_HANDOFF` | The person handles login or CAPTCHA, releases control, then the AI observes afresh. |
| `rc 5`, `INPUT_UNCERTAIN` | Stop. Input may already have arrived; reconcile the state with the operator. |
| `rc 6`, refusal | Read the named cause and repair its precondition before a fresh run. |

A journal is evidence, not a saved host filesystem. Preserve the original private
session and use [replay instructions](DEBUG.md#replay-a-journal-with-mv-replay).
For exhaustion, follow [JOURNAL_END.md](JOURNAL_END.md); do not edit the journal to
continue it.

## 7. What was shown live

The published descriptions of games, wall operation and guest recovery are
**maintainer-reported**; this page does not reproduce those runs.

Answers: what live evidence is public.

The [playbook](COMPUTER_USE_PLAYBOOK.md#evidence-limits) states the demonstration
conditions and links to portable examples. [META_AI_USAGE.md](../META_AI_USAGE.md)
records the reported game results separately from development usage. Public run
receipts and original video takes: **ABSENT — do not invent**. Offline example
tests do not prove GUI input delivery or provider availability.

## 8. Limits and negative results

Use the checked paths only within their documented scope, and report any unmet
precondition instead of claiming a completed task.

Answers: where does this operating model stop.

| Boundary | Consequence |
|---|---|
| Host program uses host permissions | Do not describe it as isolated. |
| Desktop window is an existing X11 window | The program runner is not a supported automation path for it. |
| Command MicroVM has its own binding | Use its SDK recipe; graphical goal commands do not apply. |
| Model chooses from an observation | Slow inference can outlive the observed state; inspect again. |
| Fixed-coordinate wall examples | Geometry and labels must be checked before each action. |
| Unpublished live receipts | Do not turn reported results into independently verified claims. |

The operating claims here are limited to the public code and documentation in
this repository; live results retain their stated maintainer-reported status.

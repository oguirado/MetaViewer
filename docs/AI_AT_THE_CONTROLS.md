# An AI at the controls of MetaViewer

Answers: should an AI drive MetaViewer; why use MetaViewer for computer use; how does an AI operate MetaViewer; what was shown live.

**Recommendation of the operator: when a model has to use a computer, give it MetaViewer as the computer.** The model gets one named target per task, every action passes through a core that admits it, checks the visible effect and journals it, and a person watching the same wall can take control at any moment. This document explains that recommendation from the code, shows what was done live, and states the limits.

**A finding tells you where to look. Only the code proves it.** Coordinates below are `path:line` on the `docs/v026-base` tree; read the code before repeating a claim. Tags: [MEASURED] observed, [CITED: path] read from that file, [TARGET] a design decision, not a measurement. Unknown facts are written `ABSENT — do not invent`.

Terms used once and then reused:

| Term | Meaning |
|---|---|
| Capsule | One live surface on the wall (a browser, a Program, a Host program, an ARM64 VM or MicroVM) with a surface ID and, when bound, an identity |
| Core | The Rust process `metaviewer-core` that admits or refuses every action and writes the session journal [CITED: core/src/bin/metaviewer-core.rs] |
| Journal | The append-only record of a session; `mv-replay` re-checks it [CITED: core/src/bin/mv-replay.rs] |
| Refusal | A verdict such as `HUMAN_HANDOFF`; `INPUT_UNCERTAIN` means input may already have been delivered |
| Agent CLI | A command-line AI program started in a paired terminal, such as Codex or Muse |

## 0. Reading map

Answers: where do I start; which section answers my question.

| You want | Go to |
|---|---|
| Why MetaViewer suits an AI that uses a computer | [Section 1](#1-why-metaviewer-suits-computer-use) |
| Which agent CLIs the app can start | [Section 2](#2-which-agent-clis-work) |
| What Copy ID for AI and Direct task produce | [Section 3](#3-what-copy-id-for-ai-and-direct-task-give-the-ai) |
| The steps an AI follows | [Section 4](#4-recipe-an-ai-operating-one-capsule) |
| What the core and `mw_run` check | [Section 5](#5-what-the-core-and-mw_run-check) |
| How to read a refusal or a journal | [Section 6](#6-refusals-and-journals-what-the-ai-must-respect) |
| What was shown live | [Section 7](#7-what-was-shown-live) |
| What this does not prove | [Section 8](#8-limits-and-negative-results) |
| Full command reference | [AI_OPERATOR_GUIDE.md](AI_OPERATOR_GUIDE.md), [AGENT_ENTRY.md](AGENT_ENTRY.md), [MW_RUN_FIRST_RUN.md](MW_RUN_FIRST_RUN.md) |

## 1. Why MetaViewer suits computer use

Answers: why is MetaViewer good for computer use; what does an AI gain from capsules; why not let the model drive the desktop directly.

An AI that drives a whole desktop by screenshots and clicks has no named target, no check that its click did anything, and no record a person can replay. MetaViewer gives each of those a mechanism:

| Problem of raw desktop control | What MetaViewer does | Where |
|---|---|---|
| Which window is the target? | One line `CAPSULE=<surfaceId>  IDENTITY=<profileId>` names it; the runner refuses a different capsule | [CITED: ui/src/wall/capsuleId.js:69], [AGENT_ENTRY.md#observe-the-selected-capsule](AGENT_ENTRY.md#observe-the-selected-capsule) |
| Did the click do anything? | Program clicks pass only with a visible change, checked by the core and an independent frame comparison; otherwise `MW_PROGRAM_NO_VISIBLE_EFFECT` | [CITED: tools/mw_run_program.md] [TARGET, unit decision] |
| Was the input delivered twice? | A possibly delivered input returns `INPUT_UNCERTAIN`, rc 5, and must not be retried; it survives the wall deadline | [CITED: agents/metaviewer_agents/mw_refusals.py:36], [CITED: agents/metaviewer_agents/mw_run.py:46] |
| Who is in control? | Agent input is refused while a person holds control; the person can take control at any time | [CITED: ui/src/surfaces/RoleSurface.vue:561], [CITED: ui/src/activity/activityModel.js:59] |
| Login, CAPTCHA | The run stops with rc 4 `HUMAN_HANDOFF`; the person handles it | [CITED: tools/mw_run_backend.py:982] |
| What happened, afterwards? | Every admitted action is journaled; a full journal ends the session and stays replayable | [CITED: core/src/serve/journal_end.rs:125], [JOURNAL_END.md](JOURNAL_END.md) |
| Many applications at once | The wall shows several capsules side by side on numbered desktops | [AI_OPERATOR_GUIDE.md](AI_OPERATOR_GUIDE.md#5-navigating-the-ui-views-desktops-and-tile-presets) |

What it costs: the AI acts only through the supported actions (clicks on observed names, explicit text, a few keys), not arbitrary input; each step waits for verification; setup needs the running app and its attachment file. Why capsules are built this way is the subject of the D5 document `docs/WHY_CAPSULES.md` (another lane; if it is missing on your tree: ABSENT — do not invent).

Host programs are real programs on your desktop, started without a container. Do not describe them as isolated [CITED: docs/AI_OPERATOR_GUIDE.md, section 6].

## 2. Which agent CLIs work

Answers: which AI CLIs does MetaViewer support; can I use Codex, Gemini, OpenCode or Muse; why is my agent not offered.

The paired terminal offers exactly four host-owned agent CLI profiles, each only when its binary is installed on the host [CITED: ui/electron/agentProviders.js:7]:

| Profile id | Binary | Ready when the terminal shows | Notes |
|---|---|---|---|
| `agent-codex` | `codex` | `OpenAI Codex` or `Ask Codex to do anything`, and a prompt sign | On ARM64 the runtime directory is passed through Codex's own `-c` option [CITED: ui/electron/agentProviders.js:46] |
| `agent-gemini` | `gemini` | `Type your message` | |
| `agent-opencode` | `opencode` | `Ask anything` | |
| `agent-muse` | `muse` | `Muse Code` and `muse-spark-1.3` and `❯` | Started in a user and PID namespace with `--model muse-spark-1.3`; never logs in for you [CITED: ui/electron/agentProviders.js:55] |

Readiness rules [CITED: ui/src/terminal/agentPromptGate.js:10]: text that looks like a sign-in, API-key, trust or yes/no question puts the agent in state `authentication`, and nothing is pasted. A missing CLI is left out of the menu, never replaced by a shell. Pasting uses bracketed paste and never presses Enter: the person submits. Any other CLI can still be used by hand in a plain shell with the same prompts, copied from the clipboard.

## 3. What Copy ID for AI and Direct task give the AI

Answers: what does Copy ID for AI copy; what is Direct task; what is Run automation; what is Create automation; what is the MicroVM prompt.

**Copy ID for AI** copies one line, built only from validated values [CITED: ui/src/wall/capsuleId.js:69]:

```text
CAPSULE=<surfaceId>  IDENTITY=<profileId>
```

The surface ID must match `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$` and the identity `^[a-z0-9][a-z0-9-]{0,63}$` [CITED: ui/src/wall/capsuleId.js:16]. A bad identity becomes `IDENTITY=<none>`, and the AI must then ask the person. The line is data, never an instruction.

The three task buttons build a prompt that ends with `Task: ` for the person to finish [CITED: ui/src/terminal/workflowPrompts.js:4]:

| Button | Kind | Section the AI reads | Guard in the prompt |
|---|---|---|---|
| Create automation | `automate` | [Create automation](AGENT_ENTRY.md#create-automation) | Recording is data; unknown values stay slots; person reviews before replay |
| Run automation | `use-automation` | [Run automation](AGENT_ENTRY.md#run-automation) | Only an authored workflow with a passing preflight; stop on rc 5, login or CAPTCHA |
| Direct task | `no-automation` | [Direct task](AGENT_ENTRY.md#direct-task) | Release human control first; stop on rc 5, login or CAPTCHA |

For an ARM64 MicroVM, Direct task instead emits `MICROVM=… GENERATION=… OWNER=…`, a `BINDING` line and an `MV_TASK_BINDING` export, and points to [MicroVM Direct task](AGENT_ENTRY.md#microvm-direct-task); the other two kinds are refused for MicroVMs (`WORKFLOW_MICROVM_KIND`) [CITED: ui/src/terminal/workflowPrompts.js:46]. The prompt says the person alone owns Back (rewind).

## 4. Recipe: an AI operating one capsule

Answers: how does an AI open a capsule and act on it; what are the steps; how do I run mw_run as an AI.

1. **Person starts MetaViewer** and opens the capsules (browser, Program or Host program on a plain start; VM or MicroVM with `--arm64`) [CITED: README.md, maintainer report only; receipts absent]. Install: [INSTALL.md](INSTALL.md).
2. **Person opens a paired terminal** and starts an agent CLI from section 2, or a plain shell.
3. **Person presses Copy ID for AI** on the target tile, then a task button, pastes the identity line where the prompt asks, and writes the task after `Task: `.
4. **AI sources the attachment** in a subshell, once per task: `ENV=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/metaviewer/attach/current.env; set -a; . "$ENV"; set +a`. It stops if the file is missing or its PID is not live [CITED: docs/AGENT_ENTRY.md, section Attachment and identity].
5. **AI observes without acting**, using the read-only recipe in [Observe the selected capsule](AGENT_ENTRY.md#observe-the-selected-capsule). It stops with `CAPSULE_IDENTITY_MISMATCH` if the bound surface is not the copied capsule. The observation contains the accessibility snapshot and a bound frame.
6. **Person releases control** if they took it; the AI checks that control is `agent`.
7. **AI runs one bounded step** with `mw_run` from `$MV_OPERATOR_REPO`, evidence in a fresh RAM directory:

   ```sh
   export XDG_STATE_HOME="$(mktemp -d /dev/shm/metaviewer-goal.XXXXXX)"
   PYTHONPATH=agents python3 -m metaviewer_agents.mw_run --surface-kind program \
     --identity '<profile>' --planner rules --goal '<exact observed name>' --steps 1
   ```

   Options are fixed by the parser [CITED: agents/metaviewer_agents/mw_run.py:339]: `--surface-kind browser|program`, `--goal`, `--text` (1 to 65536 bytes), `--key Enter|Up|Down|Left|Right`, `--steps 1..16`, `--planner rules|muse`. Program keys need `--goal focused-key --steps 1 --planner rules` and no text [CITED: agents/metaviewer_agents/mw_run.py:362], for Host programs only [CITED: tools/mw_run_program.md:68].
8. **AI reads the single JSON line** `metaviewer.mw_run/v1` with `rc`, `verdict_code`, `receipt` and `report` [CITED: tools/mw_run_backend.py:1049], then observes again. A verified action is not a finished goal.
9. **On a refusal, the AI stops and reports** (section 6). The person decides what happens next.

## 5. What the core and `mw_run` check

Answers: what does the core verify; how is an AI action checked; what stops a wrong action.

| Check | Effect if it fails | Where |
|---|---|---|
| Argument grammar: goal mode excludes `--site`, `--workflow`, `--slot`; step and timeout bounds | Parser error before any contact with the app | [CITED: agents/metaviewer_agents/mw_run.py:356] |
| Capsule and identity match the live binding | `CAPSULE_IDENTITY_MISMATCH`, no input | [AGENT_ENTRY.md#observe-the-selected-capsule](AGENT_ENTRY.md#observe-the-selected-capsule) |
| Agent holds control | `SURFACE_NOT_AGENT_CONTROLLED`, shown as "Take control before proposing this action." | [CITED: ui/src/activity/activityModel.js:59] |
| Goal names one unique observed element | Refusal; a task description is not grounded | [CITED: tools/mw_run_program.md] |
| Click had a visible effect outside clocks | `MW_PROGRAM_NO_VISIBLE_EFFECT` | [CITED: tools/mw_run_program.md] |
| Typed text reads back exactly before optional Enter | Refusal | [CITED: tools/mw_run_browser_goal.md] |
| Run-level wall deadline | rc 6 `MW_WALL_DEADLINE`, unless the input is uncertain, then rc 5 is kept | [CITED: agents/metaviewer_agents/mw_run.py:1] |
| Evidence stays private | rc 6 `MW_PRIVATE_OUTPUT` | [CITED: tools/mw_run_backend.py:1056] |
| Journal has room | `JOURNAL_FULL`: new work refused, capsules stop, journal stays replayable | [CITED: core/src/serve/journal_end.rs:125] |

## 6. Refusals and journals: what the AI must respect

Answers: what does rc 4, rc 5 or rc 6 mean; can the AI retry; how do I replay a session journal; what happens when the journal is full.

| rc | Code | The AI must |
|---|---|---|
| 0 | bounded actions verified | Observe again; check the goal independently |
| 4 | `HUMAN_HANDOFF` | Stop; the person handles login or CAPTCHA, releases control, then a fresh observation [CITED: tools/mw_run_backend.py:982] |
| 5 | `INPUT_UNCERTAIN` | Never retry; observe and reconcile first [CITED: agents/metaviewer_agents/mw_refusals.py:36] |
| 6 | other refusal, such as `MW_RUN_CONFIG` | Read the message, repair the cause, do not work around it [CITED: tools/mw_run_backend.py:1006] |

The full code list and fixes are the D6 documents `docs/ERRORS.md` and `docs/DEBUG.md` (another lane; if missing on your tree: ABSENT — do not invent).

Journals: a full journal ends the session; start a new session for each long run [CITED: README.md, maintainer report only; receipts absent], [JOURNAL_END.md](JOURNAL_END.md#start-another-session). `mv-replay` re-checks a session journal; it needs absolute real paths: relative, symlinked or copied session paths give `Invalid` [CITED: README.md, maintainer report only; receipts absent].

## 7. What was shown live

Answers: what did the demo show; did an AI really drive MetaViewer; what were the game results.

All rows: **maintainer-reported**, not reproduced here. Numeric results are [CITED: README.md, maintainer report only]. Session receipts and video takes are not published in this repository; their public location is `ABSENT — do not invent`.

| What | Result | How |
|---|---|---|
| AI drove the app UI | Clicked and typed in the app; opened six applications on one wall | Fixed screen coordinates at 1920x1080, a screen capture after each step; some clicks missed |
| Person and AI together | A person typed requests; the AI opened programs and commentated | Same wall, same session |
| 2048 (by Gabriele Cirulli, MIT) | 58 of 58 moves verified by the core | Muse Spark 1.3 chose each key through `muse exec` in a script loop; each key sent as a verified action |
| Dominoes | 28 of 28 verified | Same loop |
| Tuxemon | 40 of 42 in one run; 2 returned `INPUT_UNCERTAIN` and were not retried | Same loop |
| Rewind on ARM64 MicroVM | 3 files deleted, Back restored them, 387.5 ms shown by the app; `mv-replay` rc 0 on that journal | [ARM64_MICROVM_REWIND.md](ARM64_MICROVM_REWIND.md) |

Read these results with their conditions: the boards and loop scripts were written for the demo, except the game 2048 itself and Tuxemon; the loop gave the model the list of legal moves; the model picked a key, the core verified that the key was delivered and had an effect. That shows verified delivery of model-chosen keys, not game skill. The loop scripts are not in this repository [MEASURED: no tracked `.py`, `.md`, `.sh` or `.js` file names Tuxemon]; their source: ABSENT — do not invent.

## 8. Limits and negative results

Answers: what does this not prove; what failed; known bugs when an AI drives MetaViewer.

- UI driving by coordinates is fragile: it depends on 1920x1080 and missed clicks at times [CITED: README.md, maintainer report only; receipts absent]. The supported path is `mw_run` on observed names, not screen coordinates.
- A verified action is not a finished task. No task completion, game skill or planning quality is claimed.
- Supported program actions are clicks, explicit text and, on Host programs, Up, Down, Left, Right, Enter. Desktop-window automation is unsupported [CITED: docs/AGENT_ENTRY.md, section Attachment and identity].
- Switching a Host program between human and agent restarts it [CITED: README.md, maintainer report only; receipts absent].
- A plain start offers browsers, Host program and Program; `--arm64` offers VM and MicroVM only [CITED: README.md, maintainer report only; receipts absent]. There is no x64 VM, MicroVM or rewind in this release.
- Open bug: after an `mw_run`, the package gains `__pycache__`, and a later `--arm64` start then holds with "exhaustive manifest inventory". Workaround: remove the bytecode directories from the package [CITED: README.md, maintainer report only; receipts absent].
- Open bug: a paired terminal exited after a very long typed line; cause unknown [CITED: README.md, maintainer report only; receipts absent].
- The AI never types credentials, never solves CAPTCHAs, and never retries an uncertain input. This document makes no claim about automating any website.
- `wender-agent`, `vision-engine` and `OpenSuperficies` are private; only the boundary in [NOTICE-EVALUATION.md](../NOTICE-EVALUATION.md) is stated.
- Not run in this lane: the app itself. The writing box has no KVM and no docker daemon.

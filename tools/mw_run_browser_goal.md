# Browser goal runs

Run from the MetaViewer checkout in the Terminal tab, against an already running
Agent browser capsule. Copy its identity with **Copy ID for AI** and inspect the
current visible control names. Choose one unique exact normalized accessibility
(AX) name as the goal, one goal per run. Do not invent a name from a desired
outcome. `--planner rules` is the default and requires no Muse account; it uses
the locked Wender rules CLI, without constructing the Muse backend. It still
requires a verified dependency and the running app attachment.

Resolve `ENV=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/metaviewer/attach/current.env`
from the terminal's original runtime directory. Source it in a subshell because
the file changes `XDG_RUNTIME_DIR`; stop if its recorded app PID is no longer
live. `METAVIEWER_ATTACH` is a launcher stdout prefix naming this file, not a UI
control. The attachment supplies `MV_CORE_CONFIG`, `XDG_RUNTIME_DIR`,
`MV_SRF_STATE_DIR`, `MV_SRF_BIN_DIR`, `SRF_IDENTITY_STORE_ROOT`, and
`MV_WENDER_ROOT` when configured. Missing values must come from the running
app/operator, not a guessed path. Read `docs/AGENT_ENTRY.md` for the read-only
initial observation and exact capsule/identity check.

Agent programs start agent controlled. If you used **Take control** on the
selected tile, press **Release control** before running a command and verify
`control:'agent'`.

```sh
(
  ENV=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/metaviewer/attach/current.env
  set -a; . "$ENV"; set +a
  export XDG_STATE_HOME="$(mktemp -d /dev/shm/metaviewer-goal.XXXXXX)"
  PYTHONPATH=agents python3 -m metaviewer_agents.mw_run \
    --surface-kind browser --identity '<browser-profile>' --planner rules \
    --goal 'Exact visible control name' --steps 1
)
```

Evidence must be in
an owned private RAM directory beneath `/dev/shm`, mode `0700` [CITED:
`tools/mw_run_program.py` (`private_evidence_base`)], without symlink ancestors.
The example creates a fresh directory; keep its path to inspect the JSON result's
`report` and `receipt`. RAM evidence is temporary: inspect it before shutdown.

For a text field use the same attachment/RAM subshell, replacing only its command:

```sh
PYTHONPATH=agents python3 -m metaviewer_agents.mw_run \
  --surface-kind browser --identity '<browser-profile>' --planner rules \
  --goal 'Exact visible field name' --text 'Synthetic value' --key Enter --steps 3
```

The click example bounds actions at `1`; text with Enter needs `3` actions
[CITED: `agents/metaviewer_agents/mw_run.py` (`main`)]. Without Enter, omit `--key`
and use `--steps 2` [CITED: same]. Text requires focus, typing and exact native
`ax --text-of` readback before optional Enter; a different editor or text refuses.
Use only operator-supplied text. Do not combine goal mode with `--site`,
`--workflow` or `--slot`. `--steps` bounds inputs, not goal completion.

`--planner muse` needs Muse Code installed and authenticated (a Muse account).
It sends annotated marks to the authenticated provider through Wender's
`ModelClient`/`MuseBackend`; it is optional and never a fallback from rules.
Without that account keep `--planner rules`. Both modes keep grounding and custody
gates. AX supplies geometry; retained pixels and core settlement remain mandatory.
Vision-engine cross-checking is not implemented; model readings are commentary.

The pinned Linux x64 compiled runtime supports browser goals with rules or Muse.
Dependency hashes, architecture, grounding and custody gates still apply. Stored
browser workflows remain restricted in compiled mode and refuse
`MW_COMPILED_WORKFLOW_UNAVAILABLE`; those require a verified checkout matching
`deps.lock`. Live verification is limited to the architecture table in
[Judge tour](../docs/JUDGE_TOUR.md#architecture-support-at-this-snapshot).

| Result / rc [CITED: `tools/mw_run_browser_goal.py` (`run_entry`), `agents/metaviewer_agents/mw_run.py` (`main`)] | Meaning | Next action |
| --- | --- | --- |
| `BROWSER_BOUNDED_ACTIONS_VERIFIED` / `0` | Bounded actions verified; goal completion remains unknown. | Inspect receipts and fresh visible outcome before choosing another goal. |
| argparse error / `2` | Invalid command; no run. | Correct syntax and action budget. |
| `HUMAN_HANDOFF` / `4` | Login/CAPTCHA wall; automatic wall input stopped. | Person takes control and handles the wall. Release control, inspect the new state, then choose a fresh goal; never replay the old action blindly. |
| `INPUT_UNCERTAIN` / `5` | Delivery or settlement unknown. | Stop. Inspect report, dispatch and receipt journals with the operator; never automatically retry. |
| refusal / `6` | Inspect `verdict_code` and report; earlier verified moves may exist. | Repair the named precondition and inspect current state before a new run. |

For `MW_PROGRAM_CONTROL`, use **Switch to agent mode** for a Human-role capsule
or **Release control** after takeover of an Agent capsule, and verify
`control:'agent'` before a new run. For `MW_RUN_ATTACH`/`MW_RUN_CONFIG`, recopy the
running app's attachment. For `MW_PROGRAM_RAM_REQUIRED`/`MW_PRIVATE_OUTPUT`, use
the private RAM setup above. Missing/dirty/mismatched dependencies require the
operator's pinned root. Some unexpected missing private modules can escape as a
traceback without a JSON report; stop and provide the diagnostic to the operator.
Stored `--site` / `--workflow` behavior is unchanged.

[TARGET, unit decision] Optional Enter retains its real whole-surface change
expectation. Both planners use this same path; a caret phase or another pixel
change can satisfy it, while a page with no Enter effect can fail it. A prior
Muse pass does not establish a different key implementation or form submission.
A terminal core `VERIFICATION_FAILED` for Enter is now
`MW_PROGRAM_NO_VISIBLE_EFFECT` (rc 6 [TARGET]), with a persisted
`key_effect_unverified` attempt and no verified key move. It proves neither key
delivery nor submission: the frozen error projection has no native input
witness. `delivery_verified` remains null and `effect_verified` is false.
A timeout or transport failure still means `INPUT_UNCERTAIN`; no key is retried.
For a delivered no-op, effect verification is the unmet requirement, not proof
of wrong input. This runner cannot certify delivery from the terminal error
alone and therefore does not turn it into a successful action.

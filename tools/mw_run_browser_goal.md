# Browser goal runs

Run from the MetaViewer checkout in the Terminal tab, against an already running
Agent browser capsule. Copy its identity with **Copy ID for AI** and inspect the
current visible control names. Choose one unique exact normalized accessibility
(AX) name as the goal, one goal per run. Do not invent a name from a desired
outcome. `--planner rules` is the default and requires no Muse account; it uses
the locked Wender rules CLI, without constructing the Muse backend. It still
requires a verified dependency and the running app attachment.

Use **Copy env path** (also printed as `METAVIEWER_ATTACH`). Replace the copied
absolute path and identity placeholders below. Source in a subshell because the
file changes `XDG_RUNTIME_DIR`. Never copy credentials into prompts. The attachment
supplies `MV_CORE_CONFIG`, `XDG_RUNTIME_DIR`, `MV_SRF_STATE_DIR`, `MV_SRF_BIN_DIR`,
`SRF_IDENTITY_STORE_ROOT`, and `MV_WENDER_ROOT` when configured. Missing values
must come from the running app/operator, not a guessed path.

Agent programs start agent controlled. If you used **Take control** on the
selected tile, press **Release control** before running a command and verify
`control:'agent'`.

```sh
(
  set -a; . "<copied-current.env-path>"; set +a
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

Until a compiled browser build lands, this branch refuses a selected compiled
Wender runtime with `MW_COMPILED_BROWSER_UNAVAILABLE`. Neither planner bypasses
this. Ask the operator for a verified checkout matching `deps.lock`, set
`MV_WENDER_ROOT` to it and unset `MV_WENDER_EXECUTABLE` in the run subshell, or wait
for the compiled build. Never remove the guard or substitute an unverified root.
Compiled program support does not imply compiled browser support.

| Result / rc [CITED: `tools/mw_run_browser_goal.py` (`run_entry`), `agents/metaviewer_agents/mw_run.py` (`main`)] | Meaning | Next action |
| --- | --- | --- |
| `BROWSER_BOUNDED_ACTIONS_VERIFIED` / `0` | Bounded actions verified; goal completion remains unknown. | Inspect receipts and fresh visible outcome before choosing another goal. |
| argparse error / `2` | Invalid command; no run. | Correct syntax and action budget. |
| `HUMAN_HANDOFF` / `4` | Login/CAPTCHA wall; automatic wall input stopped. | Person takes control and handles the wall. Release control, inspect the new state, then choose a fresh goal; never replay the old action blindly. |
| `INPUT_UNCERTAIN` / `5` | Delivery or settlement unknown. | Stop. Inspect report, dispatch and receipt journals with the operator; never automatically retry. |
| refusal / `6` | Inspect `verdict_code` and report; earlier verified moves may exist. | Repair the named precondition and inspect current state before a new run. |

For `MW_PROGRAM_CONTROL`, press **Release control** on the tile and verify
`control:'agent'` before a new run. For `MW_RUN_ATTACH`/`MW_RUN_CONFIG`, recopy the
running app's attachment. For `MW_PROGRAM_RAM_REQUIRED`/`MW_PRIVATE_OUTPUT`, use
the private RAM setup above. Missing/dirty/mismatched dependencies require the
operator's pinned root. `MW_COMPILED_BROWSER_UNAVAILABLE` requires the checkout
route described above. Some unexpected missing private modules can escape as a
traceback without a JSON report; stop and provide the diagnostic to the operator.
Stored `--site` / `--workflow` behavior is unchanged.

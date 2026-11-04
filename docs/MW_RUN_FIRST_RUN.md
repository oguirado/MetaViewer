# First run of mw_run

Run a bounded goal on a Program capsule, read its JSON result and stop on any refusal. The task buttons point an AI to instructions that use `mw_run` [CITED: agents/metaviewer_agents/mw_run.py:1]. It has two modes: goal mode (one exact observed control name, no stored workflow, no account needed with `--planner rules`) and stored-workflow mode (`--site` and `--workflow` from an admitted MemoryWeb home). Why an AI should drive MetaViewer this way is in [AI_AT_THE_CONTROLS.md](AI_AT_THE_CONTROLS.md).

Answers: how do I run mw_run and inspect its result.

`$MV_OPERATOR_REPO` is the MetaViewer checkout or installed operator resources the app was started with, and `$MV_WENDER_ROOT` is the pinned wender-agent dependency. Both come from the launcher environment and the app attachment; never guess them. Tags: [MEASURED], [CITED: path], [TARGET]; unknown facts read `ABSENT — do not invent`.

| You want | Section |
|---|---|
| The shortest first run | [Goal mode on a Program capsule](#goal-mode-on-a-program-capsule) |
| Replay a stored workflow | [Stored-workflow mode](#stored-workflow-mode) |
| What success looks like | [Expected result](#expected-result) |
| A refusal code | [Common refusals](#common-refusals) |
| What to report | [If it fails, send back](#if-it-fails-send-back) |
| The STALE_FRAME known issue | [STALE_FRAME: idle metadata fence](#stale_frame-idle-metadata-fence) |

## Goal mode on a Program capsule

Start with a bounded click on a unique currently observed control.

Answers: how do I run a bounded Program goal.

1. **Start MetaViewer** and open a **Program** or **Host program** capsule (choose an available kind in the launcher [CITED: ui/src/catalog/catalogModel.js]). Agent programs start agent controlled; if you pressed **Take control**, press **Release control** first.
2. **Copy ID for AI** on the tile. You get `CAPSULE=<surfaceId>  IDENTITY=<profileId>` [CITED: ui/src/wall/capsuleId.js:69].
3. **Source the app attachment** using [Attachment and identity](AGENT_ENTRY.md#attachment-and-identity). For this program recipe, observe through [the read-only program recipe](AGENT_ENTRY.md#observe-a-program-without-input); the [browser observation recipe](AGENT_ENTRY.md#observe-the-selected-capsule) applies only to browsers. Pick one control name that is actually visible.
4. **Run one step** from `$MV_OPERATOR_REPO`, in the same subshell:

   ```bash
   cd "${MV_OPERATOR_REPO:?attachment must supply operator resources}"
   export XDG_STATE_HOME="$(mktemp -d /dev/shm/metaviewer-goal.XXXXXX)"
   PYTHONPATH=agents python3 -B -m metaviewer_agents.mw_run --surface-kind program \
     --identity '<profile>' --planner rules --goal '<exact observed name>' --steps 1
   ```

5. **Read the JSON line, then observe again.** For this click recipe, rc 0 means
   the bounded action passed its checks. Verify the requested outcome separately
   [CITED: tools/mw_run_program.py]. Program text has an additional uncertified
   result described below.

For the same program command, focused text uses
`--surface-kind program --goal focused --text 'hello' --steps 1`. Host navigation
uses `--surface-kind program --goal focused-key --key Right --steps 1 --planner rules`,
with no text [CITED: tools/mw_run_program.md:68]. Browser goals: [tools/mw_run_browser_goal.md](../tools/mw_run_browser_goal.md). `--planner muse` needs an authenticated Muse Code CLI and is never a fallback from `rules`.

## Stored-workflow mode

Admit the workflow home and check its live anchors before replay.

Answers: how do I preflight and replay a stored workflow.

Stored workflows live under the admitted MemoryWeb home as `sites/<site>/site.json` and `sites/<site>/workflows/<workflow>.json`; they are data, never commands [CITED: docs/AGENT_ENTRY.md, section Shared workflow guidance]. This page names no particular site.

1. **Check the home** from `$MV_OPERATOR_REPO`:

   ```bash
   python3 tools/mw_home_check.py --repo . --workflow '<site>/<workflow>'
   ```

   Expected: `{"schema":"metaviewer.mw_home/v1",...,"ok":true,"code":null,"faults":[]}`. A `"code":"MW_PROVENANCE"` means the definitions name a provenance document that is missing from the home; only a person who vouches for those definitions may record it. Do not invent provenance.
2. **Check the anchors** against the live capsule with one read-only accessibility (AX) snapshot, so a language or layout change is caught before any input:

   ```bash
   python3 tools/mw_ax_dump.py --repo . --capsule '<identity>' --site '<site>' \
     --workflow '<workflow>' --out /tmp/mv-ax-dump.json
   ```

   rc 0: every anchor is present, the file is written with mode 0600 and without row values. rc 3 `MW_AX_ANCHOR_DRIFT`: an anchor is missing; the printed summary lists live candidates [CITED: tools/mw_ax_dump.py:392].
3. **Run the workflow** from `$MV_OPERATOR_REPO/agents` (change to that directory first):

   ```bash
   cd "$MV_OPERATOR_REPO/agents"
   python3 -B -m metaviewer_agents.mw_run --identity '<identity>' \
     --site '<site>' --workflow '<workflow>' --slot 'name=<operator value>'
   ```

   Pass only slots the workflow declares and the person supplies. Stderr first announces the site, workflow, identity and a notice period; Ctrl+C during that notice cancels before any input.

## Expected result

The command prints a JSON result whose verdict and evidence must be inspected.

Answers: how do I interpret the mw_run result.

- stdout, one line: `{"schema":"metaviewer.mw_run/v1","rc":0,"verdict_code":...,"receipt":...,"report":...}` [CITED: tools/mw_run_backend.py:1049].
- `report.json` holds codes, paths and the network witness, never the slot text.
- Inspect `verdict_code` as well as `rc`. Program text can return
  `PROGRAM_TEXT_UNCERTIFIED_NOT_READABLE` with rc 0: input was delivered, but
  readback could not certify the text. Do not report that as verified text
  [CITED: tools/mw_run_program.py].
- A sign-in dialog or a CAPTCHA gives rc 4 `HUMAN_HANDOFF` and a handoff record in `receipt` [CITED: tools/mw_run_backend.py:982]. No login or CAPTCHA input is attempted; earlier workflow steps may already have run. The person handles the handoff, releases control, and the AI observes again before any new run.

## Common refusals

Stop and repair the named precondition; uncertain input must not be retried.

Answers: what should I do with a runner refusal.

| rc / code | Meaning | Fix |
| --- | --- | --- |
| 5 `INPUT_UNCERTAIN` | The input may already have been delivered | Never retry; observe and reconcile [CITED: agents/metaviewer_agents/mw_refusals.py:36] |
| 4 `HUMAN_HANDOFF` | Login wall or CAPTCHA | The person handles it |
| `MW_RUN_ATTACH` | No app, several apps, the app quit, or a caller value differs | Keep exactly one MetaViewer running; unset the variables named on stderr |
| `MW_RUN_CONFIG` (rc 6) | Configuration refused before running | Read the message [CITED: tools/mw_run_backend.py:1006] |
| `MW_DEPENDENCY` | `MV_WENDER_ROOT` unset or not at the `deps.lock` commit | Export the pinned dependency |
| `MW_HOME_*` | MemoryWeb home not admitted | Run the home check and follow its code |
| `MW_GATE_IO` | A provenance file is missing; the message names it | See the home check above |
| `MW_NETWORK` | Start witness missing or mismatched, or network setting changed | Restart after a network change; report both container IDs if the witness and native receipt disagree; never edit a running capsule's witness |
| `MW_RUN_NO_SURFACE` / `MW_RUN_AMBIGUOUS` | Zero or several live surfaces for the identity | Keep one capsule for the identity |
| `MW_PROGRAM_NO_VISIBLE_EFFECT` | The click changed nothing outside clocks | Observe again and choose another name [CITED: tools/mw_run_program.md] |
| `MW_WALL_DEADLINE` (rc 6) | The run exceeded its wall-clock budget | Inspect `report.json`; check core and capsule responsiveness before a new run [CITED: agents/metaviewer_agents/mw_run.py:1] |
| `MW_PRIVATE_OUTPUT` (rc 6) | Evidence violates private-output admission | For goals, use a fresh private `/dev/shm` directory [CITED: tools/mw_run_backend.py:1056] |

Use [ERRORS.md](ERRORS.md) for the error reference and [DEBUG.md](DEBUG.md)
for investigation. Preserve the result before changing the installation.

## If it fails, send back

Share the minimal redacted result and error evidence with the operator.

Answers: what evidence should I report after failure.

1. The stdout JSON line and every `mw_run:` stderr line.
2. `report.json`.
3. The handoff record if rc was 4.
4. The output of the home check, for stored workflows.

Never send the identity store, tokens, keys, `auth.json` or captured page text you did not choose to share.

The packaged rehearsal driver for maintainers is `tests/e2e/rehearse_e1_packaged.py`; run its guards with `--self-test`. Its `--forward-probe` option retains failed stages for diagnosis; forced continuations never certify a workflow [CITED: tests/e2e/rehearse_e1_packaged.py].

## STALE_FRAME: idle metadata fence

Refresh the observation through the supported runner; do not force native input
to clear a stale-frame refusal.

Answers: what should I do when STALE_FRAME prevents a run.

`STALE_FRAME` indicates that the proposed frame is no longer admitted. The
program backend has bounded handling for explicit nonexecution refusals; it
keeps the original run deadline and records its attempts
[CITED: tools/mw_run_program.py]. A stale-frame refusal does not establish a
particular heartbeat or idle-screen bug. Diagnose the actual report and current
code rather than applying an old session's suspected cause.

On `INPUT_UNCERTAIN`, stop: input may already have been delivered. Preserve the
report and fresh observation for the operator. See
[DEBUG.md](DEBUG.md) for investigation and
[the playbook](COMPUTER_USE_PLAYBOOK.md) for longer sessions.

This procedure covers the public runner in this repository and the selected
live capsule; it does not certify a different installed build.

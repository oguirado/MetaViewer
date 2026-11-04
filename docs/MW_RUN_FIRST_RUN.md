# First run of mw_run

Answers: how do I run mw_run the first time; what should mw_run print; what do I send back when mw_run fails.

**Answer first: run one bounded goal on a Program capsule, read the one JSON line it prints, and stop on any refusal.** `mw_run` is the engine behind the Use MetaViewer buttons [CITED: agents/metaviewer_agents/mw_run.py:1]. It has two modes: goal mode (one exact observed control name, no stored workflow, no account needed with `--planner rules`) and stored-workflow mode (`--site` and `--workflow` from an admitted MemoryWeb home). Why an AI should drive MetaViewer this way is in [AI_AT_THE_CONTROLS.md](AI_AT_THE_CONTROLS.md).

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

Answers: how do I click a button in a program with mw_run; what is the minimal mw_run command; do I need a Muse account.

1. **Start MetaViewer** and open a **Program** or **Host program** capsule (plain start; `--arm64` offers VM and MicroVM only [MEASURED, operator session 4 Nov 2026]). Agent programs start agent controlled; if you pressed **Take control**, press **Release control** first.
2. **Copy ID for AI** on the tile. You get `CAPSULE=<surfaceId>  IDENTITY=<profileId>` [CITED: ui/src/wall/capsuleId.js:69].
3. **Source the app attachment and observe** with the read-only recipe in [AGENT_ENTRY.md#observe-the-selected-capsule](AGENT_ENTRY.md#observe-the-selected-capsule) for browsers, or the observation steps in [tools/mw_run_program.md](../tools/mw_run_program.md) for programs. Pick one control name that is actually visible.
4. **Run one step** from `$MV_OPERATOR_REPO`, in the same subshell:

   ```bash
   export XDG_STATE_HOME="$(mktemp -d /dev/shm/metaviewer-goal.XXXXXX)"
   PYTHONPATH=agents python3 -m metaviewer_agents.mw_run --surface-kind program \
     --identity '<profile>' --planner rules --goal '<exact observed name>' --steps 1
   ```

5. **Read the JSON line, then observe again.** rc 0 means the bounded click had a visible effect, not that a task is done [CITED: tools/mw_run_program.md].

Text into a focused field: `--goal focused --text 'hello' --steps 1`. Arrow or Enter on a Host program: `--goal focused-key --key Right --steps 1 --planner rules`, no text [CITED: tools/mw_run_program.md:68]. Browser goals: [tools/mw_run_browser_goal.md](../tools/mw_run_browser_goal.md). `--planner muse` needs an authenticated Muse Code CLI and is never a fallback from `rules`.

## Stored-workflow mode

Answers: how do I replay a stored workflow; how do I check a MemoryWeb home; how do I check workflow anchors before running.

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

   rc 0: every anchor is present, the file is written with mode 0600 and without row values. rc 3 `MW_AX_ANCHOR_DRIFT`: an anchor is missing; the printed summary lists live candidates [CITED: tools/mw_ax_dump.py:399].
3. **Run the workflow** from `$MV_OPERATOR_REPO/agents`:

   ```bash
   python3 -m metaviewer_agents.mw_run --identity '<identity>' \
     --site '<site>' --workflow '<workflow>' --slot 'name=<operator value>'
   ```

   Pass only slots the workflow declares and the person supplies. Stderr first announces the site, workflow, identity and a notice period; Ctrl+C during that notice cancels before any input.

## Expected result

Answers: what does a successful mw_run print; where are the receipt and report.

- stdout, one line: `{"schema":"metaviewer.mw_run/v1","rc":0,"verdict_code":...,"receipt":...,"report":...}` [CITED: tools/mw_run_backend.py:1049].
- `report.json` holds codes, paths and the network witness, never the slot text.
- The receipt counts steps; a verified run has every step verified and rc 0.
- A sign-in dialog or a CAPTCHA gives rc 4 `HUMAN_HANDOFF` and a handoff record in `receipt` [CITED: tools/mw_run_backend.py:982]. Nothing is clicked or typed. The person deals with it in the capsule, releases control, and a new run may start.

## Common refusals

Answers: what does MW_RUN_ATTACH mean; what does rc 5 mean; why did mw_run refuse.

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
| `MW_PRIVATE_OUTPUT` (rc 6) | Evidence would leave the private RAM directory | Use a fresh `/dev/shm` directory [CITED: tools/mw_run_backend.py:1056] |

The complete list of codes is the D6 document `docs/ERRORS.md` (another lane; if it is missing on your tree: ABSENT — do not invent).

Known open bug: after an `mw_run`, the package gains `__pycache__` directories and a later `--arm64` start holds with "exhaustive manifest inventory". Workaround: remove the bytecode directories from the package [MEASURED, operator session 4 Nov 2026].

## If it fails, send back

Answers: what should I report after a failed run; what must I never send.

1. The stdout JSON line and every `mw_run:` stderr line.
2. `report.json`.
3. The handoff record if rc was 4.
4. The output of the home check, for stored workflows.

Never send the identity store, tokens, keys, `auth.json` or captured page text you did not choose to share.

The packaged rehearsal driver for maintainers is `tests/e2e/rehearse_e1_packaged.py`; run its guards with `--self-test`. Its `--forward-probe` option retains failed stages for diagnosis; forced continuations never certify a workflow.

## STALE_FRAME: idle metadata fence

Answers: why are proposals refused with refresh_after while the capsule is idle; what is the STALE_FRAME known issue.

**Answer: an unchanged idle capsule can carry a `refresh_after` fence that only a new verified frame clears, so proposals are refused although nothing changed.** On one packaged build, three proposals were refused over about 4 s with no advancing verified frame, and a forced native click that changed pixels cleared the fence [MEASURED, earlier packaged rehearsal; build and figures in this file's history]. The backend re-perceives and may resubmit only on an explicit `STALE_FRAME`, at most three submissions within the original budget [TARGET]; exhaustion reports `INPUT_UNCERTAIN`.

Where to look; these coordinates were rechecked on this tree, and the line numbers in older revisions of this file are stale:

| Step | Coordinate |
| --- | --- |
| The UI sends a periodic list heartbeat | `ui/electron/hostBindings.js:763` (10000 ms timer) |
| List snapshots become `state_changed` events | `daemon-adapter/internal/daemon/dispatch.go:122`, line 148 |
| Core applies lifecycle updates | `core/src/serve/mod.rs:2201` (`lifecycle`) |
| Admission sets the fence | `core/src/admission/mod.rs:994`, line 1152 |
| A later frame clears it | `core/src/admission/mod.rs:1021` |

Suggested repair [TARGET, outside this document]: publish a fresh verified confirmation frame when a list snapshot emits `state_changed`, or move the heartbeat to a path that does not count as a lifecycle change. Keep every core admission check. Read the code before stating the cause: these are leads, not proof.

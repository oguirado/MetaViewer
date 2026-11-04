# Debugging MetaViewer

How to go from a symptom to the code, tell a bug from a refusal, and explain it. Every code
MetaViewer prints has a section in [ERRORS.md](ERRORS.md). That page is generated from source by
`tools/gen_errors_doc.py`.

**A finding tells you where to look. Only the code proves it.**

Terms used once here: a *capsule* is one running program, browser or VM shown as a tile on the
wall. The *core* is the Rust authority that admits or refuses every action and journals it. The
*adapter* is the Go daemon that starts and stops the native side of capsules. A *refusal* is a
deliberate "no" with a code. A *bug* is behaviour that contradicts the cited code or its contract.

## Reading map

Answers: where do I start debugging; which page has which answer

| You have | Go to |
|---|---|
| An error or refusal code | [ERRORS.md](ERRORS.md), search for the exact code |
| A visible symptom, no code | [Symptom table](#symptom-table) |
| A judge install or doctor failure | [Install failures](#install-failures) and [JUDGE_TROUBLESHOOTING.md](JUDGE_TROUBLESHOOTING.md) |
| A session that stopped accepting work | [Session ended](#session-ended-journal_full) |
| A journal to check | [Replay a journal with mv-replay](#replay-a-journal-with-mv-replay) |
| Free text, no idea where the code is | [Find code with route_query](#find-code-with-route_query) |
| Something to report | [What to collect for a report](#what-to-collect-for-a-report) |

## Symptom table

Answers: blank tile; black tile; capsule says Lost; no agent CLI in the terminal; keys refused; install fails; session ended

Causes marked *unconfirmed* were read from code but not reproduced for this page.

| Symptom | What it usually means | First check | Code to read |
|---|---|---|---|
| Blank tile (no picture, tile chrome present) | No frame was presented yet, or the frame source reported destroyed or context lost and the UI dropped the retained frame on purpose so a dead picture is never shown as live | Does the tile status say Connecting, Lost or Error? Run with a terminal and look for `METAVIEWER_SURFACE_CREATE_REFUSED` | `ui/src/App.vue:1549`, `ui/src/surfaces/SurfaceCanvas.vue:158` |
| Black tile | *Unconfirmed.* The UI repaints the retained frame on canvas re-attach so a tile should not go black (`ui/src/surfaces/tileScheduler.js:1666`); a black picture is then the capsule's own content (for example a VM still booting) or a display problem in the capsule | Wait for the capsule to finish starting; check the adapter log line for the capsule | `ui/src/surfaces/tileScheduler.js:1666` |
| Tile shows "Lost" badge | The backend lifecycle is `lost`: the capsule's native side is gone or unproven; the tile is frozen on its last frame and never takes input | Open Identities and choose **Stop lost capsule** before reopening that identity | `ui/src/App.vue:1476`, `ui/src/App.vue:1090`, `ui/src/surfaces/tileScheduler.js:370` |
| "No agent CLI available from this terminal host" | None of the supported agent CLI binaries was found on the host search path | `command -v <cli>` in the same login; the app starts with `PATH=/usr/bin:/bin` plus `~/.local/bin` and standard dirs | `ui/src/terminal/TerminalDeckView.vue:1154`, `ui/electron/agentProviders.js:7`, `ui/electron/roleHost.js:92` |
| Same, only in `--arm64` mode | The ARM64 host environment check failed (`HOME` or `XDG_RUNTIME_DIR` not absolute) and discovery returns no profiles | `echo $XDG_RUNTIME_DIR` must print an absolute path | `ui/electron/agentProviders.js:35` |
| Keys or clicks refused | A refusal, not a bug: the capsule is under human control, the frame was stale, or the key request is outside the supported set | Read the code: `SURFACE_NOT_AGENT_CONTROLLED`, `STALE_FRAME`, `MW_PROGRAM_KEY_REQUEST`, `MW_PROGRAM_CONTROL` in [ERRORS.md](ERRORS.md) | `core/src/serve/mod.rs:182`, `agents/metaviewer_agents/mw_refusals.py:26` |
| rc 5 `INPUT_UNCERTAIN` | The input may already have been delivered; MetaViewer will not prove either way | Observe the capsule; never resend blindly | `agents/metaviewer_agents/mw_run.py:21` |
| Install or doctor fails | The judge launcher stopped on a named precondition | The stderr line `JUDGE_<CODE>: <problem> -- fix: <fix>` holds the fix | `scripts/judge/metaviewer-judge.sh:48` |
| Everything refused, session notice says journal is full | The session journal reached capacity; admission is closed | Start a new session | `core/src/serve/journal_end.rs:125` |
| A Host program restarted when switching human and agent | Expected: switching a Host program between human and agent restarts it [MEASURED] | None | ABSENT — do not invent (restart site not cited here) |

## Bug or refusal

Answers: is this a bug or a refusal; how do I tell a bug from a refusal

A refusal has a code, changes nothing, and matches a rule in the cited code. A bug contradicts
the code or its contract.

| Observation | Verdict |
|---|---|
| A code is printed and its [ERRORS.md](ERRORS.md) section explains the situation you are in | Refusal. Apply the fix in that section |
| A code is printed but the precondition it names is true (for example `CAPSULE_SLOT_UNAVAILABLE` with free slots) | Candidate bug. Read the raise site to confirm |
| An action takes effect but no verdict or receipt says it was admitted | Bug: the core must admit every effect |
| The process exits or hangs with no code | Candidate bug. Collect the items below |
| The code is not in [ERRORS.md](ERRORS.md) | Either the page is stale (`python3 tools/gen_errors_doc.py --check`) or the code is built at run time; search the code with route_query |

Unknown mw_run codes still read as refusals: `refusal_sentence` gives them a generic remedy
(`agents/metaviewer_agents/mw_refusals.py:120`).

## Install failures

Answers: install fails; doctor fails; what does JUDGE_ mean; where are the judge logs

Every launcher refusal prints `JUDGE_<CODE>: <problem> -- fix: <fix>` on stderr and exits 2
(`scripts/judge/metaviewer-judge.sh:48`). The fix text is the command to run. Each code has a
section in [ERRORS.md](ERRORS.md#family-judge-judge-launcher-failures) with every problem and fix
string from source. Per-code advice for judges is in
[JUDGE_TROUBLESHOOTING.md](JUDGE_TROUBLESHOOTING.md#kit-install-and-run).

| Item | Location |
|---|---|
| Launcher state | `$MV_JUDGE_HOME`, default `$XDG_DATA_HOME/metaviewer-judge` or `~/.local/share/metaviewer-judge` (`scripts/judge/metaviewer-judge.sh:82`) |
| Smoke log | `$MV_JUDGE_HOME/logs/smoke.log` (`scripts/judge/metaviewer-judge.sh:554`) |
| Re-check after a fix | `bash scripts/judge/metaviewer-judge.sh doctor`, success marker `JUDGE_DOCTOR_OK` |

## Session ended (JOURNAL_FULL)

Answers: session ended; everything is refused; journal is full; what does JOURNAL_FULL mean

The core journals every admitted record before it takes effect. When the journal is full, the
core closes admission for that session, stops capsules in order, and keeps the accepted journal
replayable. The UI shows: "Session journal is full. New work is refused (POLICY). Capsules are
stopping in order; the accepted journal remains replayable. Start a new session."
(`core/src/serve/journal_end.rs:125`). A full journal ends the session [MEASURED].

- Fix: start a new session; use a fresh session per long run.
- Verify: `journal-ended.json` exists in the old session directory and mv-replay on its journal
  returns rc 0.
- If a stop stays unconfirmed you get `JOURNAL_STOP_FAILED`; close MetaViewer and stop the
  remaining capsules with operating system tools. Details: [JOURNAL_END.md](JOURNAL_END.md).

## Read logs and the journal

Answers: where are the logs; where is the session journal; how do I read the journal

| Source | Where | What to look for |
|---|---|---|
| App stdout and stderr | The terminal that started MetaViewer | Lines starting `METAVIEWER_`, for example `METAVIEWER_SURFACE_CREATE_REFUSED code=<code> detail=<detail>` (`ui/electron/roleHost.js:78`) |
| Session journal | `$XDG_STATE_HOME/metaviewer/sessions/<session_id>/journal.jsonl` (fallback `~/.local/state/metaviewer/...`) | One JSON record per line, hash chained; append only |
| Session end marker | `journal-ended.json` in the same session directory | Present after `JOURNAL_FULL`; a hint only, replay decides |
| Judge launcher | `$MV_JUDGE_HOME/logs/` | `smoke.log` after install |
| mw_run | stdout: one `metaviewer.mw_run/v1` JSON line; stderr: the remedy sentence; `report.json` in its evidence directory | `verdict_code` and rc |

The journal is the record of what the core admitted. Do not edit it; copy nothing into it.

## Replay a journal with mv-replay

Answers: how do I run mv-replay; why does mv-replay say Invalid; verify a session journal

```bash
mv-replay --journal "$(realpath "$STATE/sessions/$SID/journal.jsonl")" --witness-root "$(realpath "$STATE/sessions/$SID")"
```

Here `STATE` is the state directory (for example `$XDG_STATE_HOME/metaviewer`) and `SID` the
session id. In a source checkout the binary is `./target/debug/mv-replay` after `cargo build`.
Add `--verify-only` to check the chain without printing the state hash.

| Result | Meaning | Source |
|---|---|---|
| rc 0 and a 64-hex state hash | Replay verified | `core/src/bin/mv-replay.rs:41` |
| rc 2 `Invalid` | Bad arguments or a path that fails the private-path rules | `core/src/bin/mv-replay.rs:22` |
| rc 2 `Corrupt(...)` | Torn, empty, oversize or malformed journal | `core/src/journal/mod.rs` Display impl |
| rc 3 | Duplicate record | `core/src/bin/mv-replay.rs:45` |
| rc 4 | Witness mismatch | `core/src/bin/mv-replay.rs:46` |

Pass absolute real paths. Relative, symlinked or copied session paths give `Invalid`
[MEASURED]. What the code shows: any path component that is a symlink or `..` is refused
(`core/src/journal/mod.rs:1274`). The state, sessions, session, `events` and `artifacts`
directories must each be owned by you with mode 0700 (`core/src/journal/mod.rs:1309`,
`core/src/journal/mod.rs:1317`). A plain copy usually loses mode 0700, so this is the likely cause
for copies (*unconfirmed*). Why relative paths fail is *unconfirmed*; use `realpath`.

Measured on ARM64 MicroVM: a session journal from a Rewind run (3 files deleted, Back restored
them, 387.5 ms shown by the app) replayed with mv-replay rc 0 using absolute real paths
[MEASURED].

## Find code with route_query

Answers: how do I find the code for an error; how do I use route_query error and locate

`route/route_query.py` searches a routed map of the repository. It reads only, standard library
only.

```bash
python3 route/route_query.py error "MW_PROGRAM_RAM_REQUIRED" --k 3
```

```bash
python3 route/route_query.py locate "Stop lost capsule" --k 5
```

| Subcommand | Use it for |
|---|---|
| `error "<code or message text>"` | Exact text of a refusal or error message: returns path, line and the matching text |
| `locate "<words>"` | Where a feature or UI string lives |
| `ask "<question>"`, `find "<words>"` | Wider questions and findings |
| `stats` | Which commit the findings are pinned to |

Findings are pinned to an older commit (`stats` prints `study_pin`) and many read STALE
[MEASURED] A row is a lead, not proof. Open the cited line and read it before you state
anything. For codes, [ERRORS.md](ERRORS.md) is generated from the current tree and is the
faster lookup.

## What to collect for a report

Answers: what do I include in a bug report; what to collect before reporting

1. The exact code and message, copied, plus the rc.
2. Mode and platform: plain start or `--arm64`; x64 or ARM64; capsule kind (browser, Host
   program, Program, VM, MicroVM). Plain start offers browsers, Host program and Program;
   `--arm64` offers VM and MicroVM only [MEASURED].
3. The steps, starting from a fresh session.
4. The `METAVIEWER_` lines from the app terminal and, for the launcher, `logs/smoke.log`.
5. `mv-replay` result on the session journal (absolute real paths).
6. `git rev-parse HEAD` of the checkout or the release version.
7. The [ERRORS.md](ERRORS.md) section you read and why the situation does not match it.

Do not attach journals, recordings or identity stores to a public report: they can hold your
browsing data. Describe them instead.

## Explain a bug to a judge in two sentences

Answers: how do I explain this bug to a judge; explain a refusal briefly

Use this form: sentence one says what happened and which rule or code path decided it, with a
coordinate; sentence two says what the user does now and how we know it worked.

- Refusal example: "The core refused the key because the frame the agent used was older than the
  capsule's current frame (`STALE_FRAME`, `core/src/serve/mod.rs`). The agent observes again and
  re-plans; an admitted verdict confirms it."
- Bug example: "After an `mw_run` on the packaged app, Python bytecode appears in the package and
  the next `--arm64` start holds with `exhaustive manifest inventory`. Remove the bytecode to
  start; the fix is open and the hold's source is not in this repository."

## Known issues and their status

Answers: known bugs; open issues; what is broken right now

| Issue | Status | Workaround | Evidence |
|---|---|---|---|
| After `mw_run`, the package gains `__pycache__` and a later `--arm64` start holds with "exhaustive manifest inventory" | Open | Remove the bytecode from the package directory, then start again | [MEASURED]. Source of the hold text: ABSENT — do not invent (not in this tree) |
| Paired terminal exited after a very long typed line | Open, cause unknown | Keep typed lines short | [MEASURED]; cause ABSENT — do not invent |
| Human mode on a browser took about 20 s, and one site was unreachable | Not diagnosed | Wait; check the capsule network setting | [MEASURED]; cause ABSENT — do not invent |
| Switching a Host program between human and agent restarts it | Expected behaviour | Save work in the program before switching | [MEASURED] |
| A full journal ends the session | Expected behaviour | Fresh session per long run | [MEASURED], `core/src/serve/journal_end.rs:125` |
| mv-replay refuses relative, symlinked or copied session paths | Expected behaviour, see [mv-replay](#replay-a-journal-with-mv-replay) | Use absolute real paths on the original directory | [MEASURED] |

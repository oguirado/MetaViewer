# Debugging MetaViewer

How to go from a symptom to the code, tell a bug from a refusal, and explain it. Source-discovered codes have lookup rows and selected reviewed explanations in [ERRORS.md](ERRORS.md). That page is generated from source by
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
| Blank or white tile (tile chrome present) | **Unresolved triage.** White pixels alone do not identify the cause. Missing presentation evidence, a destroyed source or context loss are branches to inspect | Collect tile status, presented frame handle/digest and dimensions, and `METAVIEWER_SURFACE_CREATE_REFUSED` from the app terminal before choosing a repair | `ui/src/App.vue:1549`, `ui/src/surfaces/SurfaceCanvas.vue:158` |
| Black tile | *Unconfirmed.* The UI repaints the retained frame on canvas re-attach so a tile should not go black (`ui/src/surfaces/tileScheduler.js:1666`); a black picture is then the capsule's own content (for example a VM still booting) or a display problem in the capsule | Wait for the capsule to finish starting; check the adapter log line for the capsule | `ui/src/surfaces/tileScheduler.js:1666` |
| Tile shows "Lost" badge | Either the backend lifecycle is `lost`, or a previously admitted row disappeared from a live/stale snapshot. Elapsed time does not prove journal exhaustion | Check the session notice and `journal-ended.json`; if the session ended, preserve/replay it and start a fresh session. Otherwise inspect the retained capsule and use **Stop lost capsule**, requiring confirmed cleanup before reopening | `ui/src/wall/tileStates.js:240`, `ui/src/App.vue:1090`, `core/src/serve/journal_end.rs:125` |
| "No agent CLI available from this terminal host" | Discovery yielded no usable profile: executable resolution failed, or ARM host-environment validation returned early | Check executable resolution in the app login and the next row for ARM validation. Per-provider setup failures are also omitted, so installation alone does not prove availability | `ui/src/terminal/TerminalDeckView.vue:1154`, `ui/electron/agentProviders.js:31` |
| Same, in `--arm64` mode | The trusted OS account home or runtime directory fails absolute/normalized-path checks, or the composed search path fails segment/byte limits; discovery catches this and returns empty | Inspect the OS account home, actual `XDG_RUNTIME_DIR`, and validated search path in the app login. Changing only shell `HOME` does not change the trusted account home | `ui/electron/agentProviders.js:20` |
| Keys or clicks refused | Possible pre-dispatch refusal: human control, stale frame or unsupported key request; a post-dispatch failure requires reconciliation | Read the code: `SURFACE_NOT_AGENT_CONTROLLED`, `STALE_FRAME`, `MW_PROGRAM_KEY_REQUEST`, `MW_PROGRAM_CONTROL` in [ERRORS.md](ERRORS.md) | `core/src/serve/mod.rs:182`, `agents/metaviewer_agents/mw_refusals.py:26` |
| rc 5 `INPUT_UNCERTAIN` | The input may already have been delivered; MetaViewer will not prove either way | Observe the capsule; never resend blindly | `agents/metaviewer_agents/mw_run.py:21` |
| Install or doctor fails | The judge launcher stopped on a named precondition | The stderr line `JUDGE_<CODE>: <problem> -- fix: <fix>` holds the fix | `scripts/judge/metaviewer-judge.sh:48` |
| Everything refused, session notice says journal is full | The session journal reached capacity; admission is closed | Start a new session | `core/src/serve/journal_end.rs:125` |
| A Host program restarted when switching human and agent | Expected: switching a Host program between human and agent restarts it [MEASURED] | None | ABSENT — do not invent (restart site not cited here) |

## Bug or refusal

Answers: is this a bug or a refusal; how do I tell a bug from a refusal

A pre-dispatch refusal has a code and rejects the proposed action. A later failure may follow
earlier effects: `INPUT_UNCERTAIN` can mean input already arrived, including a delivered focus
click before a text failure (`tools/mw_run_program.py:1274`). Observe and reconcile before
retrying. A bug contradicts the cited code or its contract; the presence of a code alone does
not decide that question.

| Observation | Verdict |
|---|---|
| A reviewed code explanation matches the observed state | Follow its remedy; for uncertain delivery, reconcile existing effects before further input |
| A code is printed but the precondition it names is true (for example `CAPSULE_SLOT_UNAVAILABLE` with free slots) | Candidate bug. Read the raise site to confirm |
| An action takes effect but its final receipt is missing | Possible uncertain completion; inspect admission, dispatch and settlement evidence before diagnosing a bug |
| The process exits or hangs with no code | Candidate bug. Collect the items below |
| The code is not in [ERRORS.md](ERRORS.md) | Either the page is stale (`python3 tools/gen_errors_doc.py --check`) or the code is built at run time; search the code with route_query |

Unknown mw_run codes still read as refusals: `refusal_sentence` gives them a generic remedy
(`agents/metaviewer_agents/mw_refusals.py:120`).

## Install failures

Answers: install fails; doctor fails; what does JUDGE_ mean; where are the judge logs

Launcher `fail` prints `JUDGE_<CODE>: <problem> -- fix: <fix>` on stderr and exits with status
2 [CITED: scripts/judge/metaviewer-judge.sh:48]. Usage errors exit with status
64 [CITED: scripts/judge/metaviewer-judge.sh:57]. The fix text is the command to run. Each source-discovered code has a
lookup row in [ERRORS.md](ERRORS.md#family-judge-judge-launcher-failures) with source coordinates; reviewed entries include the matching problem and fix
strings from source. Per-code advice for judges is in
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
(`core/src/serve/journal_end.rs:125`). Capacity exhaustion ends admission for that session [CITED: core/src/serve/journal_end.rs].

- Fix: start a new session; use a fresh session per long run.
- Verify: inspect the session notice and `journal-ended.json` when present, then replay the
  accepted journal. Marker persistence is best effort; absence does not prove the session is
  live (`core/src/serve/journal_end.rs:147`). A successful replay returns rc
  0 [CITED: core/src/bin/mv-replay.rs].
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

Live replay of the release candidate is not established by this documentation review.
The replay result, not the session marker alone, verifies the journal.

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
   program, Program, VM, MicroVM). Record the actual catalog and selected profile; mode alone does not prove that a
   profile, kind or geometry is admitted (`daemon-adapter/internal/capsule/manager.go:819`).
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
- Bug example: "Running Python tools from the package can create unmanifested bytecode; the
  campaign launcher then rejects its exact file inventory. Remove only that generated bytecode
  and recheck the unchanged manifest; prevent recurrence with `python3 -B` or
  `PYTHONDONTWRITEBYTECODE=1` for package-side Python tools."

## Known issues and their status

Answers: known bugs; open issues; what is broken right now

| Issue | Status | Workaround | Evidence |
|---|---|---|---|
| After package-side Python tools run, `__pycache__` causes "exhaustive manifest inventory" | Cause identified; launch discipline still required | Remove only the generated bytecode, keep the manifest unchanged, and use `python3 -B` or `PYTHONDONTWRITEBYTECODE=1` for Python tools in the package | Campaign verifier `manifest_rows()`; see [package inventory](#package-inventory-hold) |
| Paired terminal exited after a very long typed line | Open, cause unknown | Keep typed lines short | [MEASURED]; cause ABSENT — do not invent |
| Human mode on a browser took about 20 s, and one site was unreachable | Not diagnosed | Wait; check the capsule network setting | [MEASURED]; cause ABSENT — do not invent |
| Switching a Host program between human and agent restarts it | Expected behaviour | Save work in the program before switching | [MEASURED] |
| A full journal ends the session | Expected behaviour | Fresh session per long run | [MEASURED], `core/src/serve/journal_end.rs:125` |
| mv-replay refuses relative, symlinked or copied session paths | Expected behaviour, see [mv-replay](#replay-a-journal-with-mv-replay) | Use absolute real paths on the original directory | [MEASURED] |


## Package inventory hold

Answers: exhaustive manifest inventory; __pycache__; package rejected after mw_run

The literal emitter is the campaign-side `manifest_rows()` in
`w1/codex-rewind-arm64-1103/rw185-operator-launcher/operator_demo.py:71`.
`ctl/p17dev_arm64.py:34` loads that pinned verifier and `prepare()` calls its
`copy_package()` before launch. These coordinates are relative to the operator's campaign,
not files shipped in this public repository. The predicate compares every file under the
package with the manifest's file set. Any extra or missing file fails it, so the message alone
does not identify bytecode as the cause.

For the reported incident, running Python tools from the package wrote `__pycache__` into
that package. Those extra files violate the inventory. Remove only the generated bytecode
identified by comparing the inventory; do not delete unfamiliar files or regenerate the
manifest to hide changes. Then re-run the same verifier. Prevent recurrence with
`python3 -B` or `PYTHONDONTWRITEBYTECODE=1` on package-side Python invocations.

A synthetic file-inventory check passed before adding an unmanifested bytecode file, failed
with the exact message after adding it, and passed after removing it [MEASURED]. This verifies
the predicate and remedy, not a live capsule restart. The public equivalent is
`verifyInstall()` in `ui/tools/package.js:1882`: it walks the package and rejects unknown,
changed or mode-mismatched files with `PKG_MANIFEST_MISMATCH`. The judge launcher invokes it
through `--verify-install` (`scripts/judge/metaviewer-judge.sh:560`).

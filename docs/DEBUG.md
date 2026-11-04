# Debugging MetaViewer

Start with the exact symptom and error code, then read the public source that
emits it. A refusal is a decision about a request; it is not automatically a bug.
An absent receipt is not proof that input never reached the application.

The generated [error reference](ERRORS.md) maps discovered codes to source.
For ordinary operation, use [the user guide](USER_GUIDE.md).

## Where should I start?

Choose the path that matches the evidence you have.

Answers: debugging entry; error lookup; install failure; session recovery

| Evidence | Start here |
| --- | --- |
| Exact refusal or error code | Search [ERRORS.md](ERRORS.md) for that code |
| Visible symptom without a code | [Symptom table](#what-does-the-visible-symptom-tell-me) |
| Install or doctor failure | [Install failures](#how-do-i-diagnose-an-install-failure) |
| Session stopped accepting work | [Full session](#what-does-journal_full-mean) |
| Preserved journal | [Replay](#replay-a-journal-with-mv-replay) |
| Suspected package changes | [Package inventory](#package-inventory-hold) |
| Reproducible candidate bug | [Report contents](#what-should-a-bug-report-contain) |

## What does the visible symptom tell me?

A visible symptom narrows the investigation; it does not establish a cause by
itself. Check the authoritative state and result before attempting a repair.

Answers: blank tile; black tile; Lost; no agent CLI; input refused; terminal unavailable

| Symptom | Check next | Public source |
| --- | --- | --- |
| Blank, white or black tile | Capsule lifecycle, frame availability and presented frame identity. Pixel color alone cannot identify a failed layer | [SurfaceCanvas.vue](../ui/src/surfaces/SurfaceCanvas.vue), [tile scheduler](../ui/src/surfaces/tileScheduler.js) |
| Lost tile, possibly retaining a frame | Session notice and backend lifecycle. A retained picture does not prove a live capsule | [tile states](../ui/src/wall/tileStates.js), [journal end](../core/src/serve/journal_end.rs) |
| No usable agent profile | Executable discovery and host-environment validation. Installation alone does not prove discovery succeeded | [agentProviders.js](../ui/electron/agentProviders.js) |
| `TERMINAL_UNAVAILABLE` | The package needs usable native terminal support; copying a task prompt does not launch a terminal | [terminalHost.js](../ui/electron/terminalHost.js) |
| Keys or clicks refused | Ownership, stream freshness and the returned code; take control before human input | [input port](../ui/src/input/inputPort.js), [App.vue](../ui/src/App.vue) |
| `INPUT_UNCERTAIN` | Observe what the application actually did before any retry | [program runner](../tools/mw_run_program.py), [workflow runner](../agents/metaviewer_agents/mw_run.py) |
| Network reports `legacy` | No network mode is enforced; do not assume host or LAN blocking | [network copy](../ui/src/netmode/networkCopy.js) |
| Everything refused after the journal fills | Preserve the accepted history, verify cleanup, and start a fresh session | [journal end](../core/src/serve/journal_end.rs) |

## How do I distinguish a refusal from a bug?

Read the emitting condition and compare it with the state that accompanied the
request. A bug contradicts the implemented contract; a refusal may enforce it.

Answers: bug or refusal; uncertain input; safe retry; missing receipt

A pre-dispatch refusal can prevent an action. A later failure can follow effects
already delivered. In particular, program text input may deliver a focus click
before a later operation becomes uncertain. `INPUT_UNCERTAIN` uses exit status
`5` [CITED: [program runner](../tools/mw_run_program.py)]; observe and reconcile
before sending more input.

| Observation | Interpretation |
| --- | --- |
| State matches the refusal's precondition | Follow the documented remedy |
| State contradicts the refusal's precondition | Candidate bug; verify the raise site and preserve a reproduction |
| Application changed but the final result is missing | Uncertain completion; do not resend blindly |
| Process exits or hangs without a code | Collect process output and the minimal reproduction |
| Code is absent from the generated reference | Search current source; a generated index can be stale |

The current runner source, not the code's name alone, decides whether retry is
safe. Use [the error reference](ERRORS.md) for coordinates.

## How do I diagnose an install failure?

Read the launcher's `JUDGE_<CODE>: <problem> -- fix: <fix>` line and correct that
specific prerequisite before re-running the doctor.

Answers: install fails; doctor fails; JUDGE code; smoke log

The launcher's `fail` function exits with status `2`; usage errors exit with
status `64` [CITED: [metaviewer-judge.sh](../scripts/judge/metaviewer-judge.sh)].
The fix text explains the required action; it is not always a shell command.

| Evidence | Location or check |
| --- | --- |
| Launcher state | `$MV_JUDGE_HOME`, otherwise `$XDG_DATA_HOME/metaviewer-judge` or `$HOME/.local/share/metaviewer-judge` |
| Smoke output | `logs/smoke.log` beneath the launcher state directory |
| Re-check after a fix | `bash scripts/judge/metaviewer-judge.sh doctor` with the same selected options |

Source: [judge launcher](../scripts/judge/metaviewer-judge.sh). Use
[JUDGE_TROUBLESHOOTING.md](JUDGE_TROUBLESHOOTING.md) for the installation path
that produced the refusal.

## What does JOURNAL_FULL mean?

The session's journal capacity has been reached. The core closes admission,
stops capsules in order and retains the accepted journal for replay.

Answers: JOURNAL_FULL; session ended; POLICY; cleanup; JOURNAL_STOP_FAILED

Close and reopen MetaViewer through its normal entry to start a fresh session.
If cleanup remains unconfirmed, close the app and stop remaining capsules with
operating-system controls before reopening. Frozen frames do not establish that
a capsule is still running.

`journal-ended.json` is a best-effort marker. Its absence does not prove that
admission remains open, and its presence does not replace journal verification.
See [JOURNAL_END.md](JOURNAL_END.md). Source:
[journal_end.rs](../core/src/serve/journal_end.rs).

## Where are logs and the journal?

Start with the launching terminal and the session directory; preserve original
records rather than editing them into a passing result.

Answers: stdout; stderr; METAVIEWER messages; journal path; end marker

| Source | Location | Useful evidence |
| --- | --- | --- |
| Application output | Terminal that started MetaViewer | `METAVIEWER_` messages, including surface-create refusals |
| Session journal | `$XDG_STATE_HOME/metaviewer/sessions/<session-id>/journal.jsonl`, or the corresponding `$HOME/.local/state` path | Accepted records and their chain |
| Session-end marker | `journal-ended.json` beside the journal, when written | Cleanup progress and session-end hint |
| Judge launcher | `logs/smoke.log` beneath launcher state | Installation smoke result |
| Program runner | Its output and private evidence directory | `verdict_code`, exit status and observed effects |

Sources: [roleHost.js](../ui/electron/roleHost.js), `default_state_dir` in
[journal module](../core/src/journal/mod.rs),
[judge launcher](../scripts/judge/metaviewer-judge.sh),
[program runner](../tools/mw_run_program.py).

## Replay a journal with mv-replay

Run `mv-replay` against the preserved journal and its own session directory.
A passing replay validates the recorded history, not current application state.

Answers: run mv-replay; invalid replay path; corrupt journal; witness mismatch

From a source checkout with the binary built, replace these placeholders with
absolute real paths:

```sh
./target/debug/mv-replay --journal /absolute/state/sessions/SESSION/journal.jsonl \
  --witness-root /absolute/state/sessions/SESSION
```

| Result | Meaning |
| --- | --- |
| Exit `0` with a state hash | Replay verified; `--verify-only` suppresses the hash |
| Exit `2` | Invalid arguments or paths, unreadable data, or malformed/corrupt history |
| Exit `3` | Duplicate record |
| Exit `4` | Witness mismatch |

Exit values are [CITED: [mv-replay.rs](../core/src/bin/mv-replay.rs)]. Symlinks
and parent traversal are refused. The state directory, `sessions`, the session
directory, `events` and `artifacts` must belong to the effective user and have
mode `0700` [CITED: `private_archive` and `private_directory_for_uid` in
[journal module](../core/src/journal/mod.rs)]. Preserve journal and witness
contents when copying, then verify the copy's hierarchy, ownership and modes.
Do not create substitute witnesses or rewrite the journal.

## How do I find the current source?

Use the repository router for coordinates, then read the returned source before
drawing a conclusion.

Answers: find error source; route_query; source coordinates; generated errors

```sh
python3 route/route_query.py error "MW_PROGRAM_RAM_REQUIRED"
python3 route/route_query.py any "terminal unavailable"
```

`show` reads a returned reference. Router results and model-written findings are
leads; stale or absent results do not prove a feature is absent. For contributor
workflow and index checks, see [AGENTS.md](../AGENTS.md) and
[route/README.md](../route/README.md). The generated
[ERRORS.md](ERRORS.md) is another entry point, not an independent runtime test.

## What should a bug report contain?

Include a minimal reproduction and the evidence needed to compare the observed
state with the source predicate.

Answers: bug report; reproduction; required evidence; private data

- Exact message, code and exit status.
- Release version or checkout commit, platform and selected launch mode.
- Capsule kind, role and lifecycle when the action was attempted.
- Steps from a fresh session and the resulting state.
- Relevant application output, launcher smoke result and replay result if available.
- Source or error-reference entry whose behavior does not match the observation.

These fields follow the distinct launch, ownership and replay checks described
above. Do not publish raw journals, recordings, identity stores or login data.
Use synthetic or scrubbed reproduction material, as required by
[LAWS.md](../LAWS.md).

## Which issues and limits are currently established?

The table distinguishes source-established behavior from unresolved symptoms.
It is not a claim that every host or live workload has been tested.

Answers: known issues; status; limitations; unresolved symptoms

| Issue or limit | Status | Action | Evidence |
| --- | --- | --- | --- |
| Blank or black tile without a proven cause | Unresolved until lifecycle and frame evidence identify the failing path | Collect the symptom evidence above | [canvas](../ui/src/surfaces/SurfaceCanvas.vue), [scheduler](../ui/src/surfaces/tileScheduler.js) |
| Host program restarts when its Human/Agent role changes | Implemented behavior | Save work before the role switch | `switchMode` in [roleHost.js](../ui/electron/roleHost.js) |
| Session journal reaches capacity | Implemented limit | Confirm cleanup and start a fresh session | [journal end](../core/src/serve/journal_end.rs) |
| Package gains unmanifested files | Implemented integrity rejection | Verify the exact mismatch; restore the trusted package | [package verifier](../ui/tools/package.js) |
| Terminal support absent from a package | Explicit unavailable result | Use a package with native terminal support | [terminalHost.js](../ui/electron/terminalHost.js) |
| Network capability reports legacy | No enforced network mode | Check deployment requirements before relying on a policy | [network copy](../ui/src/netmode/networkCopy.js) |

A symptom without a reproducible trace remains undiagnosed. Do not assign a
cause from timing, pixel color or a previous release's report.

## Package inventory hold

A package inventory rejection means installed files do not match the trusted
manifest. It does not identify the cause without the mismatching path.

Answers: exhaustive manifest inventory; PKG_MANIFEST_MISMATCH; __pycache__; changed package

The public `verifyInstall()` walks the package and compares file presence,
digests and modes with its companion manifest. Extra or changed files produce
`PKG_MANIFEST_MISMATCH`; missing files produce `PKG_MANIFEST_MISSING`.
Source: [ui/tools/package.js](../ui/tools/package.js).

Python can create `__pycache__` inside an installed tree. Use `python3 -B` or
`PYTHONDONTWRITEBYTECODE=1` for package-side Python commands. If generated
bytecode is the verified extra file, remove only that identified bytecode and
re-run the same verifier. Otherwise restore the trusted package through the
[installation procedure](INSTALL.md). Do not rebuild a manifest to bless an
unexplained change.

The phrase “exhaustive manifest inventory” comes from external campaign tooling;
its implementation and incident receipts are not shipped here. The public
package verifier establishes the integrity rule, not a live reproduction of
that external incident.

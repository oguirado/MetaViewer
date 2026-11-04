# Agent lane audit (report only)

Base: `ci/assets-07a62f32c` at commit `07a62f3` [CITED]. Branch: `cloud/audit-agents`.
This file is a report, not routing or contributor instructions. No product code changed.

Convention: every `file:line` coordinate, rc value and code name quoted from source is
[CITED] at `07a62f3`. Values observed while running are marked [MEASURED]. Findings are
candidates for independent verification by another model and the conductor.

## Unit, scope, gate

- Unit: agent lane audit report. Dependency closure: none; nothing imports this file.
- Owned file: `cloud-audit/AGENTS.md` only. Probes lived in a scratch directory outside the
  tree and are not committed.
- Gate: `python3 tools/router_index.py --check`. Before writing: rc 0, coverage 100% of
  3255 files [MEASURED]. After writing: see "Gate result" at the end.
- Negative control: `tools/check_laws.py` `check_changelog_changes([('A','cloud-audit/AGENTS.md')])`
  returns a "requires a changelog fragment" error [MEASURED], because `cloud-audit/` is
  not a non-product prefix (`tools/check_laws.py:34-45`). The gate is live, and this commit
  would be flagged by that rule. The task allowed one file only, so no fragment was added.
- In scope: `agents/metaviewer_agents/` `mw_run`, `planner`, `client`, `mw_handoff`, `mw_owner`,
  `envelope`; `tools/mw_run_backend.py`, `tools/mw_run_program.py`, `tools/mv_demo.py`,
  `tools/mw_home_check.py`; `ui/src/terminal/workflowPrompts.js`; stored data under
  `memoryweb-builtin/sites/meta-ai/`.
- Not run: anything that needs `MV_WENDER_ROOT` or `VQA_VE_ROOT` (private). No private
  repository was accessed. Rust core and Go adapter guards cited below were read, not run.

## Findings

No finding met the serious-if-public bar, so nothing is withheld. Highest severity: medium.

| ID | Where | Severity | Confidence | Proof |
|---|---|---|---|---|
| F1 | `tools/mw_run_backend.py:1040-1045` | medium | high | run (stubbed) |
| F2 | `agents/metaviewer_agents/mw_handoff.py:26-69`, `tools/mw_run_backend.py:1014` | low | high | run (stubbed) |
| F3 | `tools/mw_run_backend.py:1022-1038` | medium if the assumption fails | low | read only |
| F4 | `agents/metaviewer_agents/client.py:604-624` with `:639-658` | low | medium | run (forced interleaving) |
| F5 | `agents/metaviewer_agents/mw_run.py:287-292`, `:396-400` | low | high | run (forced timing) |
| F6 | `tools/mw_run_program.py:1268-1313` | low | high | run (forced timing) |
| F7 | `tools/mw_run_backend.py:1016` | low | high | run |
| F8 | `tools/mw_home_check.py:45-47` | low | high | run |
| F9 | `agents/metaviewer_agents/mw_owner.py:510-524` | low | high | admission run, effect read only |
| F10 | `tools/mw_run_program.py:350-357`, `:703-704`, `:293` | low | medium | read only |
| F11 | `agents/metaviewer_agents/mw_handoff.py:53` | low | medium | partly run |
| F12 | `agents/metaviewer_agents/mw_owner.py:71-74` | info | high | run |
| F13 | `agents/metaviewer_agents/planner.py:892-896`, `:663-681` | info | high | run |
| F14 | `ui/src/terminal/workflowPrompts.js:58`, `:63` | info | high | run |
| F15 | `memoryweb-builtin/sites/meta-ai/NOTES.md:14` | info | high | read |
| F16 | `agents/metaviewer_agents/mw_home.py:107-114` via `tools/mw_home_check.py:129` | info | high | run |

**F1. Stored-workflow mode turns rc 5 into rc 6 when `report.json` cannot be written.**
Sequence: `execute` returns `(5, 'INPUT_UNCERTAIN')`; `ReplayOwner.write(report)` raises
`OSError` (disk full, permissions); the handler sets `rc=6, MW_PRIVATE_OUTPUT`
unconditionally. The same overwrite hits rc 0 and rc 4. Observed: control rc 5
`INPUT_UNCERTAIN`; forced write failure rc 6 `MW_PRIVATE_OUTPUT`, with a `report` path that
does not exist [MEASURED]. Effect: input that may have been delivered is reported as a
refusal. The prompts say rc 6 means "inspect and repair the refusal", so an agent can
repair and re-run, which can repeat a submit. The program lane handles this correctly
(`tools/mw_run_program.py:1310-1313`).

**F2. No durable latch after `HUMAN_HANDOFF` or `INPUT_UNCERTAIN`.** The handoff latch is in
memory, and every run gets a fresh evidence directory. Nothing reads an earlier
`.handoff.json` or an earlier uncertain result. Observed: a new latch on a path with an
earlier handoff record returned `False` on a clean page [MEASURED]. Effect: a re-run starts
again from step 1. Only prompt text ("never retry") stops a repeated submit. Mitigations:
the wall is re-detected on each observation, and the adapter refuses agent input during an
operator login (`daemon-adapter/internal/capsule/login_lock.go:13-23`, read only).

**F3. Stored-workflow mode does not classify an exception after dispatch as uncertain on its
own.** Unlike goal mode (`tools/mw_run_browser_goal.py:383-385`) and program mode
(`tools/mw_run_program.py:1281-1284`), `run_entry` does not inspect attempt rows when an
exception escapes. Attempt rows reach the trace only when `owner.run` returns
(`tools/mw_run_backend.py:971-978`). A correct `INPUT_UNCERTAIN` (rc 5) here depends on the
private runner turning every post-intent exception into that verdict. If it does not, a
core EOF or wall deadline mid-dispatch reports rc 6 `MW_RUN_CORE` or `MW_WALL_DEADLINE`.
The public tests that would prove it need `MV_WENDER_ROOT`. Public proof: ABSENT — do not invent.

**F4. Lane lock race: a second client can pass the `busy` refusal.** Client A's `_reserve`
locks a temp file, swaps it into place with `os.replace`, then closes the old descriptor,
which releases the lock on the old inode. If client B opened the sequence path before the
swap, its `flock` then succeeds on the unlinked inode, and it reads a stale sequence value.
Observed under forced interleaving: both clients ready; core saw hello sequence values
`[1, 2]`; the plain contention control still refused `busy` [MEASURED]. Effect: this breaks the
"never admit a second sequence writer" rule. Whether both runs can then act depends on core
sequence and lease checks, which were not run.

**F5. The wall-deadline timer stays armed after the runner prints its result.** If it fires
between the result `print` (`tools/mw_run_backend.py:1046-1047`) and the disarm, stdout
carries two result lines. Observed: `rc 0 PASS`, then `rc 6 MW_WALL_DEADLINE` with a second
report in a new run directory, and `main()` returned 6 [MEASURED]. A variant (firing during
cleanup) exits with code 1, with no fallback report and with the signal handler not
restored (read only). The window is narrow.

**F6. The program lane loses rc 5 if the deadline fires in the report window.**
`WallDeadlineError` subclasses `RuntimeError` (`agents/metaviewer_agents/mw_run.py:52`), so it is
caught inside the main try. It escapes only from the except body or the report write, then
becomes fallback rc 6 `MW_WALL_DEADLINE` (`mw_run.py:399-400`). Observed by the reviewer
under forced timing: rc 6 instead of rc 5; control rc 5 [MEASURED]. Some waits ignore the
run deadline (`tools/mw_run_backend.py:445` fixed 5000 ms).

**F7. State directory modes conflict between modes.** Stored-workflow mode creates
`metaviewer/` and `metaviewer/runs/` through `mkdir(parents=True)`, which leaves the parents
at mode 755. Goal modes require 700 on those directories
(`tools/mw_run_browser_goal.py:336-340`; `tools/mw_run_program.py:1215-1221`). Observed: after one
stored-workflow run (refused `MW_RUN_ATTACH`), browser and program goal runs in the same
`XDG_STATE_HOME` refused rc 6 `MW_PRIVATE_OUTPUT`; a fresh directory got the expected
`MW_RUN_ATTACH` [MEASURED]. Effect: fails closed, with a misleading remedy. Run directory
names are listable by other local users.

**F8. `--workflow` home check passes when its provenance check never ran.** A document
without an object `provenance`, or a document that is not an object, is skipped without a
fault. Observed: `site.json` `{}` with a workflow of `[]`, `null` or `{"provenance":"x"}` gave
`ok:true`, rc 0; controls (missing notes, invalid JSON, `ai` source without receipt) gave
`MW_PROVENANCE`, rc 6 [MEASURED]. `source:"human"` skips the hash check whatever the notes
contain. The pinned gate still refuses later (`agents/metaviewer_agents/mw_owner.py:130-144`).

**F9. A stored workflow can send nearly any key chord inside the capsule.** Admission checks
syntax, refuses Escape, and applies the workflow's own `forbidden_keys`. Observed with a
stub owner: `ctrl+l`, `alt+F4`, `ctrl+w`, `ctrl+shift+i` and `super+Return` admitted; `Escape`,
`esc`, `ctrl+Escape` refused [MEASURED]. Effects stay inside the capsule but reach browser
chrome (address bar, close tab or window, devtools). A key step needs a focus precondition
(`mw_owner.py:555-556`).

**F10. Focused key after pixel drift; password check only once.** A focused key is admitted
when only pixels changed (same surface and size, newer generation). Password evidence is
checked only on the first observation, not on rebind or on the `STALE_FRAME` retry, which
reuses the original observation. Effect: a dialog that appears between check and send can
receive Enter. This is documented as "only pixel drift is admitted"
(`tools/mw_run_program.md:75`).

**F11. Consent walls are not caught by public code.** The handoff marker path accepts only
`login_wall` and `captcha_wall` (also `tools/mw_run_backend.py:272-311`), while the site notes
say consent stops automation. Observed: a `consent_wall` marker did not stop the run
[MEASURED]. Whether consent is caught depends on the private detector.

**F12.** `sleep_ns` has no upper bound; `sleep_ns(10**20)` reached `time.sleep(1e11)`
[MEASURED]. The run-level alarm caps it on the `mw_run` path.

**F13.** An external planner proposal keeps its own `budget` and `proposal_id`. Observed:
the caller asked for `max_ms` 5000 and got 3600000 [MEASURED]. `recheck_plan` accepts a
`changed_region` expectation where `plan()` emits a state hash. Neither has a production
caller in the tree.

**F14.** `assertSafeWorkflowIdentity` accepts U+2028 and U+2029; `assertSafeWorkflowPrompt`
accepts U+202E [MEASURED]. The identity line is built from grammar-checked ids
(`ui/src/wall/capsuleId.js:77-90`), so exposure is low.

**F15.** Stored site notes contain the Spanish marker "ABSENT — no inventar". The laws require
English on disk and the exact marker `ABSENT — do not invent`.

**F16.** The preflight check creates `<checkout>/memoryweb` (mode 700) as a side effect.
The directory is ignored, so this is harmless; the agent lane tests do the same in the
checkout they run in.

## Answers

- **Stale frame:** no bypass found in scope. The core checks frame hash, generation and
  refresh at admission and again at dispatch (`core/src/admission/mod.rs:1215-1219`, `:1024`,
  `:1071`, read only). The backend re-observes and rebinds before every submit
  (`tools/mw_run_backend.py:757-816`). Residual: the screen can change after the last frame.
- **Wrong surface:** clean. One surface and capsule are pinned per identity; a swap refuses
  `MW_RUN_OWNERSHIP` (`tools/mw_run_backend.py:480`). Receipts must match the proposal, with
  wrong-surface and stale-generation negative controls (`:905-922`). Replies are correlated by
  request id and op (`client.py:705-708`). Weak point: the capsule is identified by its
  container name (`tools/mw_run_backend.py:469-480`); the frame continuity check is the backstop.
- **Person holds control:** browser modes rely on the core and adapter (Python checks control
  only for program capsules, `tools/mw_run_backend.py:482-483`). The core re-checks at
  dispatch, and taking control cancels pending proposals (`mod.rs:1106-1125`, read only).
  Program mode has a Python check-then-act gap between `ownership()` and `propose`, covered
  only by the core.
- **Focused keys on a host program:** refused without agent control, without exactly one
  surface and a ready binding, without a Host binding, for keys outside the allow-list
  (Up, Down, Left, Right, Enter), and on known password evidence (`tools/mw_run_program.py:116-153`,
  `:316-320`, `:701-704`). The receipt is written only after core verification with focus
  confirmed (`:719-729`); intent and dispatch records are synced before `propose` (`:214`, `:716`).
  The `dispatch-*.json` file is labelled immutable but is rewritten on refusal (`:223-228`).
- **Does `INPUT_UNCERTAIN` ever retry:** never automatically in public code. The only resends
  follow an explicit core `STALE_FRAME` admission refusal (`tools/mw_run_backend.py:842-849`,
  `:869-875`; `tools/mw_run_program.py:288-308`). The client goes terminal on EOF or timeout and
  never resends, even with `max_retries` in the proposal (run). Gaps: F1, F2, F3, F6.
- **Stored site document execution:** none found. No eval, exec, shell, script injection or
  navigation driven by stored data. Loading enforces bounded, no-symlink paths, canonical
  bytes and a hash-pinned schema bundle (`agents/metaviewer_agents/mw_owner.py:90-145`). Unsupported
  kinds are refused (`:545-552`). Typed text comes only from run-time slot values (`:179-234`).
  `script_ref` is allowed by the schema and read by no public code; private handling: ABSENT — do not invent.
- **Login wall:** detected on each observation and at submit. It writes a 600-mode record
  with no URL or values and stops with rc 4 `HUMAN_HANDOFF`. It never types credentials and
  never resumes (`mw_owner.py:840`). It does not switch the capsule to human control. See F2.
- **App restart mid-run:** stops; no reconnect path (`client.py:782-784`). The core refuses
  receipts from another epoch (`mod.rs:1085-1105`, read only). Result: rc 6 `MW_RUN_CORE`, or
  rc 5 in program and goal modes when input was in flight (run). Stored-workflow mode: F3.
- **Demo recording that loses its binding:** `tools/mv_demo.py` records only; it has no
  replay or rebind. The export carries no capsule binding (probe output: keys `schema` and
  `sha256` only [MEASURED]). Replay goes through `mw_run`, which resolves the binding afresh
  and refuses zero, several or changed surfaces. The fixed RAM recording path
  (`tools/mv_demo.py:46`) is not tied to the identity.
- **Receipts and rc 0:** rc 0 requires a validated receipt in stored-workflow mode
  (`tools/mw_run_backend.py:985-991`) and a verified key or click in program mode
  (`tools/mw_run_program.py:1260`). rc 0 in goal and program modes means bounded actions
  verified, not goal completed (`goal_completed=None`). `PROGRAM_TEXT_UNCERTIFIED_NOT_READABLE`
  exits rc 0 with uncertified text (documented). No path reports rc 0 for work that did not
  happen was found; the rc inconsistencies are F1, F5 and F6.

## Documented commands in the three prompts

All were run from a scratch clone at `07a62f3`, with `MV_WENDER_ROOT` unset and no app running.

| Command (from `workflowPrompts.js`) | Result [MEASURED] |
|---|---|
| `python3 tools/mw_home_check.py --repo . --workflow <site>/<workflow>` (`:34`) | fresh checkout: rc 6 `MW_WORKFLOW_ABSENT`; with `memoryweb/` populated from the builtin sites, rc 0 for `meta-ai/ask`, `new-chat`, `ask-fixture`; `--home memoryweb-builtin` relative: rc 2 `MW_HOME_PATH`; absolute: rc 6 `MW_HOME_TRACKED` |
| `python3 -m metaviewer_agents.mw_run --identity <id> --site <site> --workflow <workflow>` from `agents/` (`:36`) | parses; rc 6 `MW_RUN_ATTACH` |
| `PYTHONPATH=agents ... --surface-kind browser ... --planner rules --goal '...' --steps 1` (`:46`) | parses; rc 6 `MW_RUN_ATTACH` in a fresh state home |
| same with `--text 'Synthetic value' --key Enter --steps 3` (`:47`) | parses; rc 6 `MW_RUN_ATTACH` |
| program `--goal focused-key --key Up --steps 1 --planner rules` (`:48`, `tools/mw_run_program.md:65`) | parses; rc 6 `MW_RUN_ATTACH`; without `--key`, argparse rc 2 |
| `export XDG_STATE_HOME="$(mktemp -d /dev/shm/metaviewer-goal.XXXXXX)"` (`:49`) | works; reusing it after a stored-workflow run hits F7 |
| `mv_demo.py` record, prompt and check (`:25`) | subcommands exist (`tools/mv_demo.py:395-402`); not run live |

- Every referenced doc exists. The env names `MV_OPERATOR_REPO`, `MV_MW_HOME` and
  `MV_MEMORYWEB_REPO` are supplied by the attach env (`ui/tools/package.js:587-588`).
- The codes `MW_PROGRAM_CONTROL` and `MW_COMPILED_BROWSER_UNAVAILABLE` exist
  (`agents/metaviewer_agents/mw_refusals.py:25`, `:29`; `tools/mw_run_backend.py:413`).
- rc 4 and rc 5 are set in goal and program modes. In stored-workflow mode, rc 4 is set at
  `tools/mw_run_backend.py:982`; rc 5 comes from the private runner (F3).
- The MemoryWeb checkout's `tools/route.py` (`workflowPrompts.js:7`): not in this tree and not
  checked by `mv_demo.authoring_checkout` (`tools/mv_demo.py:294-302`). ABSENT — do not invent.
- All three prompts pass their own guard. Lines [MEASURED]: automate 33, use-automation 34,
  no-automation 36, against a limit of 40 (`:63`).

## Clean (with guards)

- Handoff latch closes before persisting; a write failure cannot reopen input (`mw_handoff.py:59`).
- Every input path checks the latch first (`mw_owner.py:376`, `:707`, `:733`, `:743`).
- Output files are opened exclusively, without following links, at mode 600 (`mw_owner.py:909`).
- Home walk follows no symlinks and refuses profiles, SQLite headers, `.git` and oversize
  files (`mw_home.py:51-69`, `:141-190`). Git results fail closed (`mw_home_check.py:25-32`, `:112-131`).
- Demo site copy follows no links and is bounded; its check runs with `-I` in a temp copy
  (`mv_demo.py:330-359`, `:385`). Typed-character events are refused (`mv_demo.py:120-158`).
- Program evidence must be RAM-backed, absolute and free of symlinks (`mw_run_program.py:79-89`).
- Native tool path allows only the read-only `ax` and `show` verbs (`mw_run_backend.py:426-427`).

A clean result here is not proof of absence. It covers the paths read and the probes run,
at this commit, without private code, without a live core, adapter or capsule, and within
a fixed time budget.

## Tests run [MEASURED]

- `agents/tests` `test_mw_run`, `test_planner`, `test_client`, `test_client_statemachine`,
  `test_envelope`, plus `tests/` `test_mw_stale_frame`, `test_mw_refusals`, `test_mw_e1_receipt`,
  `test_mw_wall_deadline`: 99 passed, 17 failed, 1 error. All 17 failures are
  `MV_WENDER_ROOT is required`. The error is a helper `test_level_watchdog` collected as a test.
- `tools/test_mw_run_program.py` + `tools/test_mw_program_client.py`: 95 passed, 1 skipped.
  `tools/test_mw_run_program_pins.py`: 4 failed (`VQA_VE_ROOT` required).
- `test_mw_home` 19, `test_mw_home_cli` 12, `test_mv_demo` 12, `test_mv_demo_flow` 23 passed;
  `test_meta_site` 3 of 4 (1 needs the private root).
- Not run (private root needed in setup): `test_mw_owner`, `test_mw_owner_sleep_ns`, `test_mw_handoff`.
- Not run: `ui/test/v026-terminal-buttons.test.js` (no `node_modules`; `@vue/compiler-sfc` absent).
- Private-dependency tests fail instead of skipping when the root is absent. This is
  consistent with LAWS L4.3, but a local run cannot tell a real failure from a missing dependency.
- Outside scope, seen once and not verified: `tests/test_v027_fix_j2.py` reported a UI
  attach failure and an `ImportError` for `tools.mv_identity`.

## Gate result

- `python3 tools/router_index.py --check` with this file staged: rc 1, "Stale or incomplete
  router", 3256 sources against 3255 committed nodes [MEASURED]. The gate is red.
- Cause: the router index does not cover this new file. Fixing it means regenerating
  `catalogue/nodes.jsonl`, which is outside the one-file scope of this task. It was not done.
- The laws checker would also ask for a changelog fragment (see the negative control above).
- Status: router unavailable. This edit is not routed.

## Auditor

Model identifier: withheld from the tree (session policy and LAWS.md L1.2); stated in the
session's final message. Effort: reasoning-effort setting 40 [MEASURED]; wall budget about
45 minutes [TARGET]; one lead auditor plus three parallel read-only reviewers, with their
findings re-checked by reading and by rerunning probes.

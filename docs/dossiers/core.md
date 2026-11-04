# Core dossier: admission, journal, frames, rewind, replay, recording

The Rust core (`core/`, crate `metaviewer-core`) is the one process that decides what may happen to a capsule and writes down every decision so it can be checked later. This dossier explains why it exists, how its parts fit, how each part fails, and where to change it.

**A finding tells you where to look. Only the code proves it.** Every coordinate below was read on the `docs/v026-base` commit. The machine-readable findings for this area are in `route/study/core.jsonl`: one row per finding, with byte spans checked against that commit. Anything marked *inference* is a reading of the code, not something the code states.

Terms used once and then reused:

| Term | Meaning here |
|---|---|
| Capsule | One live workload shown as a tile on the wall: a browser, a program, a VM or a MicroVM |
| Surface | The core's record of one capsule's display: owner, `live`, `agent_controlled`, latest frame, allowed verbs (`core/src/admission/mod.rs:96`) |
| Frame | One RGB picture of a surface, named by sha256, generation, width and height (`core/src/admission/mod.rs:88`) |
| Proposal | An agent's request to act on a surface, `action_proposal/v0.2` |
| Verdict | The core's answer, `action_verdict/v0.2`: admitted or refused with a reason code |
| Journal | The append-only session archive on disk; `mv-replay` checks it offline |
| Refusal | A journalled "no" with a fixed code. It is a normal outcome, not a crash |

## Reading map

Answers: where do I start in the core; which section answers my question; what is in this file

| You want | Go to |
|---|---|
| Why the core exists and why it is a single writer | [Why a single authority core](#why-a-single-authority-core) |
| Why an action was refused | [Admission](#admission-why-was-my-action-refused) |
| What the journal on disk is and how it fails | [Journal](#journal-what-is-written-and-when-it-refuses) |
| Why a session ended by itself on a long run | [Journal full](#journal-full-why-a-long-session-ends) |
| Why `mv-replay` says `Invalid` | [mv-replay](#mv-replay-how-to-verify-a-session-and-why-it-says-invalid) |
| How frames are trusted | [Frames](#frames-how-a-picture-becomes-evidence) |
| How REWIND decides and refuses | [Rewind](#rewind-how-pause-mark-restore-are-decided) |
| Recording and screenshot refusals | [Recording](#recording-limits-and-refusals) |
| Where to change what | [Where to change what](#where-to-change-what) |
| How to test it | [How to test the core](#how-to-test-the-core) |
| What the router says | [Using the router for the core](#using-the-router-for-the-core) |

## Why a single authority core

Answers: why does MetaViewer have a core; why one writer; why capsules go through the core; what advantage does this design give

The core is the only component that changes authority state; everything else proposes and the core decides. `CoreState::apply` (`core/src/admission/mod.rs:554`) is a pure reducer: the same input on the same state always gives the same outcome. `Authority::apply_with_witnesses` (`core/src/admission/mod.rs:1514-1524`) runs it on a copy, appends the result to the journal, and only then replaces the live state. So a failed disk write leaves the live state as it was.

What this buys, as the code shows it:

| Property | Where it holds | What a judge can check |
|---|---|---|
| Every decision is on disk before it takes effect | `core/src/admission/mod.rs:1514-1524` | `mv-replay` recomputes the final state hash |
| The journal cannot be rewritten into a different story | `Journal::append` re-reduces the input and refuses `Invalid` on any difference (`core/src/journal/mod.rs:3123-3160`) | Hash chain `prev_sha256` per record |
| Refusals are evidence, not silence | `Authority::admit` journals refused verdicts too (`core/src/admission/mod.rs:1490-1509`) | Refused proposals appear in the journal |
| An agent acts only on what it saw | Proposal must name the exact frame sha256 and generation (`core/src/admission/mod.rs:1297-1382`) | `STALE_FRAME` when the picture moved on |

Why capsules are routed this way (*inference* from the module docs and the reducer shape): putting each workload behind a surface that only the core can make agent-controlled lets one session hold many capsules while still giving a single, replayable order of events across all of them. The alternative, letting the UI or each adapter act directly, would leave no single record to replay. The "Future single writer" note in `core/README.md` states the same aim.

What the core does not do: it does not see pixels through a model, and it does not run workloads. Workloads run in adapters and the daemon; the core keeps the decisions.

## Parts and data flow

Answers: what are the parts of the core; which file does what; how does a message flow through the core

| Part | File | One-line job |
|---|---|---|
| Crate root | `core/src/lib.rs:1-25` | Lists public modules; `forbid(unsafe_code)` |
| Core binary | `core/src/bin/metaviewer-core.rs:5-21` | Reads `MV_CORE_CONFIG`, pins version, binds `$XDG_RUNTIME_DIR/metaviewer/core.sock` |
| Server | `core/src/serve/mod.rs` | Authenticated socket routing to the reducers |
| Admission | `core/src/admission/mod.rs` | The reducer: proposals, lifecycle, slots, budgets, leases |
| Journal | `core/src/journal/mod.rs` | Durable archive, recovery, scan, frame witnesses |
| Anchor | `core/src/journal/anchor.rs:1-12` | Optional external head that pins an exact journal end |
| Replay table | `core/src/replay/mod.rs:55-88` | Nonce and sequence replay protection per sender |
| Rewind (live) | `core/src/rewind_flow.rs`, `core/src/serve/rewind.rs` | REWIND pause, resume, mark, restore |
| Rewind (test only) | `core/src/rewind.rs:1-3` | Standalone reducer, not registered in the live core |
| Recording | `core/src/record/mod.rs`, `core/src/record/capture.rs`, `core/src/record/capture/export.rs` | Screenshots and recordings in RAM, PNG tar export |
| Verify | `core/src/verify/mod.rs` | Receipt checks over frame evidence |
| Offline verifier | `core/src/bin/mv-replay.rs:4-39` | Replays a journal and prints the state hash |

Flow of one agent action (from the code paths above):

1. A peer sends an envelope on the socket. `AdmissionRequest::decode` (`core/src/admission/mod.rs:54-73`) requires the sender to be the authenticated peer, the session to match, the target to be the core and the body to be an `ActionProposal`.
2. `Input::Propose` (`core/src/admission/mod.rs:1027-1092`) refuses duplicates, then runs `check`.
3. Admitted: one budget unit is spent, the surface lease is taken, a pending entry is created. The verdict is journalled.
4. `Input::Dispatch` (`core/src/admission/mod.rs:1092-1115`) rechecks everything before the adapter runs the action.
5. The adapter reports a receipt; `verify` checks it against frame evidence.

## Admission: why was my action refused

Answers: why was my click refused; what does STALE_FRAME mean; what does POLICY mean; LOCKED_BY_OTHER; BUDGET_EXCEEDED; OUT_OF_BOUNDS; SURFACE_NOT_AGENT_CONTROLLED

A proposal is refused at the first failing rule, in this order (`core/src/admission/mod.rs:1297-1382`). Codes come from `Refusal::code` (`core/src/wire/mod.rs:103-119`).

| Order | Condition | Code | What it means for the user |
|---|---|---|---|
| 1 | Surface is in a human role | `POLICY` | A person holds this capsule; switch it to agent first |
| 2 | Unknown surface, or no frame yet | `STALE_FRAME` | Nothing to act on yet; wait for a frame |
| 3 | Not `agent_controlled`, not `live`, or sender is not the owner | `SURFACE_NOT_AGENT_CONTROLLED` | The capsule is not handed to this agent |
| 4 | Refresh pending, or `based_on_frame` sha256 or generation differs | `STALE_FRAME` | The screen changed; take a new frame and propose again |
| 5 | Another lease on this surface or on the same display | `LOCKED_BY_OTHER` | One action at a time per display |
| 6 | No budget left, bad or passed deadline, clock before receipt time | `BUDGET_EXCEEDED` | Session action budget or time limit used up |
| 7 | `wait` longer than `budget.max_ms` | `BUDGET_EXCEEDED` | Ask for less time |
| 8 | `scroll` `dx` or `dy` does not fit in i32 | `OUT_OF_BOUNDS` | Delta too large |
| 9 | Any `scroll` or `wait` that passed 8 | `POLICY` | Not supported by the native adapter (module doc, `core/src/admission/mod.rs:14-15`) |
| 10 | Click `x >= width` or `y >= height`; expectation box empty or outside frame | `OUT_OF_BOUNDS` | Coordinates outside the picture |
| 11 | Wrong epoch, epoch 0, or sender is not an Agent | `POLICY` | Stale connection or wrong role |

Other admission refusals:

| Rule | Code | Coordinate |
|---|---|---|
| Same `proposal_id`, `msg_id` or nonce seen, or `seq` not increasing | `POLICY` | `core/src/admission/mod.rs:1027-1092` |
| Dispatch for unknown, already dispatched or unknown-outcome proposal | `POLICY` | `core/src/admission/mod.rs:1092-1115` |
| Capsule slot request not from the UI, reused id with other content, 256 outcomes retained, credential copy not confirmed, bad copy destination, busy profile, `mv-` profile | `POLICY` | `core/src/admission/mod.rs:426-473` |
| Slot request with no budget left | `BUDGET_EXCEEDED` | `core/src/admission/mod.rs:426-473` |

Invariants worth knowing before changing this file:

- Budget counts admitted attempts. A failed dispatch recheck removes the permit and does not refund it (`core/src/admission/mod.rs:16`, `core/src/admission/mod.rs:1092-1115`).
- Each proposal is dispatched at most once. A retry needs a new admission against a new frame.
- Lost and Destroyed surfaces are terminal; late frames cannot bring them back (`core/src/admission/mod.rs:20-25`).

Rejected option shown in the code: slot history keeps at most 256 outcomes "rather than evicting idempotency evidence" (`core/src/admission/mod.rs:426-473`). The tradeoff is that a very long session refuses new slot work with `POLICY` instead of forgetting earlier operation ids.

## Journal: what is written and when it refuses

Answers: what is journal.jsonl; where is the session archive; what does Corrupt mean; what does UPGRADE-REQUIRED mean; what is Poisoned

A session lives in `<state>/sessions/<session_id>/` with `journal.jsonl`, `genesis.json`, `checkpoint.json`, `events/` and `artifacts/`, all private to the effective user (directories mode 0700). `Journal::create` builds it (`core/src/journal/mod.rs:1679-1799`); `session_id` must be 1 to 128 bytes of `[A-Za-z0-9._-]` and not `.` or `..` (`core/src/journal/mod.rs:1261-1269`).

Ceilings (`core/src/journal/mod.rs:61-73`, `core/src/journal/mod.rs:651-652`), all from code [CITED: core/src/journal/mod.rs]:

| Limit | Value |
|---|---|
| Journal file and any artifact | 64 MiB (`MAX_BYTES`) |
| Records per session | 100000 (`MAX_RECORDS`) |
| One line | 1048576 bytes (`MAX_FRAME_BYTES`, `core/src/wire/mod.rs:20-21`) |
| Frame sync window | 50 ms, at most 8 frames per batch |
| Per-surface witness memory | 64 MiB |

Errors (`core/src/journal/mod.rs:667-719`):

| Error | Typical cause | What the user sees |
|---|---|---|
| `Corrupt(empty)`, `Corrupt(blank)`, `Corrupt(utf8_bom)`, `Corrupt(missing_lf)`, `Corrupt(oversize)`, `Corrupt` | File edited, torn write, or over the ceiling | `mv-replay` exit 2 with that text |
| `UPGRADE-REQUIRED` | Journal written by another core version | Archive the session unchanged; start a fresh session |
| `Duplicate` | Repeated `msg_id`, or `core_seq` not the running count | `mv-replay` exit 3 |
| `Witness` | Missing artifact or digest mismatch | `mv-replay` exit 4 |
| `Invalid` | Path rules, bad arguments, reducer mismatch | `mv-replay` exit 2 |
| `Policy` | Record or byte ceiling reached | Live: session ends (next section) |
| `Poisoned` | An earlier fsync failed | Every later write refuses |
| `Locked` | Another writer holds the journal lock | Recovery or a second core refused |

Recovery: `Journal::recover` (`core/src/journal/mod.rs:1811-1830`) takes the writer lock; if a scan fails it rolls back the torn or unsealed tail to the durable prefix (`try_rollback_uncommitted_tail`, `core/src/journal/mod.rs:3733`) and scans again. Read-only `scan` never repairs.

Rejected option shown in the code: migration between versions. "A recognized journal header from another core version requires an explicit fresh-session upgrade; it is never replayed or migrated" (`core/src/journal/mod.rs:14-15`, check at `core/src/journal/mod.rs:3886-3889`). Tradeoff: auditing an old session needs the matching `mv-replay` build.

## Journal full: why a long session ends

Answers: why did my session end; journal full; session stopped after many actions; long run ends by itself

When the journal reaches 100000 records or the next line would pass 64 MiB, `Journal::append` returns `Policy` (`core/src/journal/mod.rs:3144-3175`). The server catches exactly that error and calls `end_full_journal` (`core/src/serve/mod.rs:1326-1328`, `core/src/serve/journal_end.rs:172`). A capacity refusal ends admission, not the socket (`core/src/serve/journal_end.rs:1-30`): accepted records are flushed, a `metaviewer.journal-ended/v1` marker with `core_seq` and `state_sha256` is renamed into place as `journal-ended.json` (`core/src/serve/journal_end.rs:101`), and live surfaces get cleanup destroy commands one at a time. On load the marker must be a regular file of at most 1024 bytes, owned by the effective user, with no group or other bits (`core/src/serve/journal_end.rs:52-60`).

Live fact [MEASURED, conductor run on 0.2.6 base]: a full journal ends the session. Workaround: start a fresh session for each long run. See also [JOURNAL_END.md](../JOURNAL_END.md).

## mv-replay: how to verify a session and why it says Invalid

Answers: how do I verify a journal; mv-replay usage; mv-replay Invalid; mv-replay exit code; relative path; symlink; copied session

Usage (`core/src/bin/mv-replay.rs:4-39`):

```bash
mv-replay --journal /abs/state/sessions/ID/journal.jsonl --witness-root /abs/state/sessions/ID
```

Add `--verify-only` to skip printing the state hash, `--anchor <file>` to pin an externally kept head (`core/src/journal/anchor.rs:1-12`). Exit codes (`core/src/bin/mv-replay.rs:41-53`): 0 verified; 3 `Duplicate`; 4 `Witness`; 2 everything else.

Why `Invalid` for a path that looks fine (`core/src/journal/mod.rs:1274-1288`, `core/src/journal/mod.rs:1309-1327`):

| Path given | Rule that fails | Result |
|---|---|---|
| Contains `..` | `confined` rejects parent components | `Invalid` |
| Any symlink on the way | `confined` checks every prefix with `symlink_metadata` | `Invalid` |
| Session root without two parents (`state/sessions/ID`) | `private_archive` needs both parents | `Invalid` |
| Copied session directory | State, sessions, root, `events`, `artifacts` must each be owned by you with mode exactly 0700; a copy usually gets another mode (*inference*: depends on the copy tool and umask) | `Invalid` |

Live fact [MEASURED, conductor run]: `mv-replay` returned 0 on an ARM64 MicroVM rewind session journal given absolute real paths; relative, symlinked or copied session paths gave `Invalid`. Use `realpath` on both arguments and run it against the original session directory.

## Frames: how a picture becomes evidence

Answers: how is a frame verified; invalid frame witness; why is my frame rejected; /dev/shm frame

A frame reference names a file in `/dev/shm`. `read_published_frame` (`core/src/verify/mod.rs:67-99`) accepts it only if the path is already canonical, under `/dev/shm`, a regular file owned by the core user with no group or other bits, of the exact length, with the same device and inode before, during and after the read, and with valid RGB geometry. Any failure is "invalid frame witness". Reads are bounded by `MAX_RGB_BYTES` = 256 MiB (`core/src/verify/mod.rs:1-23`).

In the journal, `verify_surface_frame_with_geometry` (`core/src/journal/mod.rs:2229-2251`) refuses `Poisoned` on a poisoned journal and `Witness` on a zero, oversize or mismatched length or a malformed digest. An unchanged frame may skip rehashing by comparing bytes in memory, but bytes from disk are never marked verified without SHA-256 (`core/src/journal/mod.rs:30-41`).

Why this design (*inference*): binding every proposal to one frame hash means the core can show which picture the agent acted on, and refuse with `STALE_FRAME` instead of acting on a screen that moved.

## Rewind: how pause, mark, restore are decided

Answers: how does REWIND work; why is rewind refused; BUSY; STALE; POINT_UNAVAILABLE; CAPACITY; OWNER; rewind Back

The live reducer is `core/src/rewind_flow.rs` (`core/src/rewind_flow.rs:1-42`), routed by `core/src/serve/rewind.rs:1-30`. `core/src/rewind.rs` is a separate pure reducer that only `core/tests/rewind.rs` compiles; do not read it as live behaviour (`core/src/rewind.rs:1-3`). Physical evidence (process, mapping, closure) comes from the daemon; the reducer never invents it.

Phases and operations (`core/src/rewind_flow.rs:157-268`):

| Op | Allowed from | Moves to | Bumps generation and epoch |
|---|---|---|---|
| `pause` | `ready` | `pausing` | No |
| `resume` | `paused` | `resuming` | Yes |
| `mark` | `ready` or `paused` | `marking` | Yes when from `ready` |
| `restore` | `paused`, or `recoverable` to `last_good_usable` only | `restoring` | Yes |

At most two points; a third `mark` evicts the oldest point with no active references. A pending request expires after 35 s. While a request is pending, unknown or stopping, guest commands are fenced (`core/src/rewind_flow.rs:60-67`).

Refusal codes (`core/src/rewind_flow.rs:88-201`), answered as `rewind_event/v0.2` with `event: "refused"` and `data.code`:

| Code | Cause | Fix |
|---|---|---|
| `OWNER` | Caller is neither the guest-command creator UI nor the session agent, or the guest owner changed | Use the owning UI or agent |
| `UNAVAILABLE` | No guest command session | Start the guest first |
| `BUSY` | Guest not held, commands pending, a job running, or phase wrong for the op | Wait for `ready` or `paused` |
| `STALE` | Request `workload_id`, `generation` or `authority_epoch` is old | Read status and resend with current values |
| `DUPLICATE` | Same `request_id`, or 256 requests used | New request id; new session after 256 |
| `CAPACITY` | Two points held with references, or a counter would overflow | Release a point |
| `POINT_UNAVAILABLE` | No usable point with that id and the session compatibility hash | Mark again |
| `INVALID` | Missing field or unknown op | Fix the request |

Live fact [MEASURED, conductor run on ARM64 MicroVM]: 3 files created, deleted, Back restored them; the app showed 387.5 ms. Rewind is an ARM64 MicroVM feature; see [ARM64_MICROVM_REWIND.md](../ARM64_MICROVM_REWIND.md).

## Recording: limits and refusals

Answers: why can't I record; screenshot refused; LIMIT; CAPTURE_UNAVAILABLE; NOT_SEALED; export failed

Recording is a seam with a durable sink; a sink failure commits nothing, and raw pixels never cross the sink (`core/src/record/mod.rs:2-38`). Limits (`core/src/record/capture.rs:1-10`): 64 retained captures, 8 active recordings, 8 MiB per ring, 64 MiB of retained pixels, at most 60 fps, default 3 fps. Export archive at most 16 MiB (`EXPORT_BYTE_LIMIT`).

| Code | Cause | Coordinate |
|---|---|---|
| `NOT_RECORDING` | Stop on an id that is not an active recording | `core/src/record/capture.rs:271-332` |
| `SURFACE_UNKNOWN` | Surface not admitted | same |
| `ALREADY_RECORDING` | Surface already recording | same |
| `CAPTURE_UNAVAILABLE` | No frame for the surface yet, or pixels gone at export | same; `core/src/record/capture/export.rs:49-70` |
| `LIMIT` | 64 captures, 8 active, 64 MiB retained, or export over 16 MiB | same |
| `NOT_SEALED` | Export before stop | `core/src/record/capture/export.rs:49-70` |
| `CAPTURE_UNKNOWN` | Unknown capture id at export | same |
| `DESTINATION_UNAVAILABLE` | Export directory cannot be pinned or re-verified | `core/src/record/capture/export.rs:104-142` |
| `POLICY` / `BUDGET_EXCEEDED` with a text reason | Surface not admitted, wrong mode, bad bounds, reused id, destination not authorized, over limits | `core/src/record/mod.rs:239-300` |

## Where to change what

Answers: where do I change admission rules; where to add a refusal; where to change journal limits; where to change rewind

| Change | Edit | Keep in step |
|---|---|---|
| A proposal rule or its order | `CoreState::check`, `core/src/admission/mod.rs:1297-1382` | `core/tests/admission_matrix.rs`; replay of old journals changes meaning (*inference*) |
| A new refusal code | `Refusal`, `core/src/wire/mod.rs:103-119` | `contracts/v0.2/action_verdict.schema.json` first (contracts-first law, `LAWS.md`) |
| Journal ceilings | `core/src/journal/mod.rs:61-73`, `core/src/journal/mod.rs:651-652` | `core/src/serve/journal_end.rs`, journal-end tests |
| Archive path rules | `core/src/journal/mod.rs:1274-1327` | `mv-replay` users; `core/tests/t1_journal_verify.rs` |
| REWIND rules | `core/src/rewind_flow.rs:88-268` | `contracts/v0.2/rewind_*.schema.json`, `core/tests/rewind_flow.rs` |
| Recording limits | `core/src/record/capture.rs:1-10` | `core/tests/record_harden.rs` |

Contracts in `contracts/v0.2` and `contracts/v0.3` are read-only reference for this dossier.

## How to test the core

Answers: how do I run core tests; which tests cover admission, journal, rewind; how do I check a change

```bash
cargo test -p metaviewer-core --test admission_matrix
```

| Area | Test files |
|---|---|
| Admission | `core/tests/admission_matrix.rs`, `core/tests/admission_journal.rs`, `core/tests/admission_lifecycle.rs` |
| Journal and replay | `core/tests/t1_journal_verify.rs`, `core/tests/journal_recovery_fix.rs`, `core/tests/journal_upgrade.rs`, `core/tests/t1_anchor.rs`, `core/tests/replay_table.rs` |
| Rewind | `core/tests/rewind_flow.rs`, `core/tests/rewind.rs`, `core/tests/rewind_envelope.rs` |
| Recording | `core/tests/record_harden.rs`, `core/tests/record_release.rs`, `core/tests/mut_rec_capture.rs` |
| Journal end | `core/src/serve/journal_end_tests.rs` (unit, `cargo test -p metaviewer-core --lib journal_end`) |

Run on this branch [MEASURED, this lane, no KVM, no docker]: `admission_matrix` 16 passed, `admission_journal` 16, `t1_journal_verify` 16, `rewind` 16, `rewind_flow` 19, lib filter `journal_end record` 44 passed, 0 failed.

## Known open issues touching the core

Answers: known bugs; exhaustive manifest inventory; __pycache__; terminal exited

| Issue | Status |
|---|---|
| After `mw_run`, the package gains `__pycache__` and `--arm64` then holds with "exhaustive manifest inventory"; remove the bytecode | Open [MEASURED, conductor]. Not core code: the message does not appear under `core/` (*inference* from search) |
| Paired terminal exited after a very long typed line | Open, cause unknown [MEASURED, conductor]. ABSENT — do not invent a cause |

## Using the router for the core

Answers: how do I find core code; route_query for core; are the route findings fresh

```bash
python3 route/route_query.py error "UPGRADE-REQUIRED"
```

```bash
python3 route/route_query.py file core/src/rewind_flow.rs
```

Rows in `route/nodes.jsonl` are pinned to an older commit and many read `STALE`; treat a stale row as a lead. Rows in `route/study/core.jsonl` were written for this commit: each citation is `[symbol id, digest, start byte, length]`, the digest is the first 16 hex of sha256 over the CRLF-normalised bytes `data[start:start+length]`, exactly as `Map.cite` checks it (`route/route_query.py:73-94`). They are not yet merged into the router index; that is the router lane's call.

## Limitations of this dossier

Answers: what is not covered; how far to trust this

- Not covered in depth: `serve/` routing beyond the paths named, `supervisor/`, `catalog/`, `guest_command.rs`, `headless.rs`, `transport/`. ABSENT — do not invent their behaviour from this file.
- No KVM and no docker daemon here: no capsule was started; live facts come from the conductor's run.
- One author, one pass, no second reviewer.

# Core dossier: admission, journal, frames, rewind, replay, recording

The Rust core (`core/`, crate `metaviewer-core`) decides whether an agent action on a capsule is admitted and writes each decision to an on-disk journal that `mv-replay` can check offline. This file locates the code. It does not prove it: read the cited lines before relying on a statement. Statements marked *inference* are readings of the code, not things the code says.

Terms used here:

| Term | Meaning |
|---|---|
| Capsule | One live workload shown as a tile: a browser, a program, a VM or a MicroVM |
| Surface | The core's record of one capsule's display: owner, `live`, `agent_controlled`, latest frame (`core/src/admission/mod.rs:96`) |
| Frame | One RGB picture of a surface, named by sha256, generation, width and height (`core/src/admission/mod.rs:88`) |
| Proposal / verdict | An agent's `action_proposal/v0.2` and the core's `action_verdict/v0.2` (admitted, or refused with a code) |
| Journal | The append-only session archive on disk |
| Refusal | A journalled "no" with a fixed code; a normal outcome, not a crash |

## Why does the core decide instead of the UI or the adapters?

The core is the only component that changes authority state; everything else proposes. `CoreState::apply` (`core/src/admission/mod.rs:554`) clones the state and reduces the input on the clone. `Authority::apply_with_witnesses` (`core/src/admission/mod.rs:1514`) appends the result to the journal and only then replaces the live state, so a synchronous append error prevents that state replacement. Frame group-commit flush failures are handled separately by poisoning the journal.

Answers: why does MetaViewer have a core; why one writer; what can a judge check

| Property | Where | Check |
|---|---|---|
| A decision is journalled before it takes effect | `core/src/admission/mod.rs:1514` | `mv-replay` recomputes the final state hash |
| Appending re-reduces the input and refuses `Invalid` on any difference | `Journal::append`, `core/src/journal/mod.rs:3123` | Hash chain `prev_sha256` per record |
| Refusals are journalled too | `Authority::admit`, `core/src/admission/mod.rs:1490` | Refused proposals appear in the journal |
| A proposal must name the accepted frame | `check`, `core/src/admission/mod.rs:1297` | `STALE_FRAME` when accepted frame identity differs |

*Inference*: with one writer, one session holds many capsules and still has a single replayable order of events. If each adapter or the UI acted directly, no single record would exist. `core/README.md` calls the core the "single writer" for lifecycle, admission, control, budgets and replay.

The core does not perform model inference or run the target application. It does inspect pixel evidence during verification; adapters execute the workload operations.

## Which file does what?

The reducer owns admission; the server routes messages; the journal owns the replay archive.

Answers: where are the core parts; how does one agent action flow

| Part | File |
|---|---|
| Binary: reads `MV_CORE_CONFIG`, binds `$XDG_RUNTIME_DIR/metaviewer/core.sock` | `core/src/bin/metaviewer-core.rs` |
| Authenticated socket routing | `core/src/serve/mod.rs` |
| Reducer: proposals, lifecycle, slots, budgets, leases | `core/src/admission/mod.rs` |
| Journal, recovery, scan, frame witnesses | `core/src/journal/mod.rs` |
| Optional external journal head | `core/src/journal/anchor.rs` |
| Nonce and sequence replay table | `core/src/replay/mod.rs` |
| Live REWIND | `core/src/rewind_flow.rs`, `core/src/serve/rewind.rs` |
| Test-only REWIND reducer, not registered in the live core | `core/src/rewind.rs:1-3` |
| Screenshots and recordings in RAM, export | `core/src/record/mod.rs`, `core/src/record/capture.rs`, `core/src/record/capture/export.rs` |
| Receipt checks over frame evidence | `core/src/verify/mod.rs` |
| Offline verifier | `core/src/bin/mv-replay.rs` |

One action:

1. `AdmissionRequest::decode` (`core/src/admission/mod.rs:54`) requires the authenticated peer as sender, the matching session, the core as target and an `ActionProposal` body. [CITED: `core/src/admission/mod.rs`]
2. `Input::Propose` (`core/src/admission/mod.rs:1027`) refuses duplicates, then runs `check`. [CITED: `core/src/admission/mod.rs`]
3. If admitted, one budget unit is spent, the surface lease is taken and the verdict is journalled.
4. `Input::Dispatch` (`core/src/admission/mod.rs:1092`) rechecks before the adapter acts. [CITED: `core/src/admission/mod.rs`]
5. The adapter reports a receipt; `core/src/verify/mod.rs` checks it against frame evidence. [CITED: `core/src/verify/mod.rs`]

## Why was my action refused?

`check` (`core/src/admission/mod.rs:1297`) refuses at the first failing rule, in this order. Codes come from `Refusal` (`core/src/wire/mod.rs:103`).

Answers: STALE_FRAME; POLICY; LOCKED_BY_OTHER; BUDGET_EXCEEDED; OUT_OF_BOUNDS; SURFACE_NOT_AGENT_CONTROLLED

| Order | Condition | Code |
|---|---|---|
| 1 | Surface is in a human role | `POLICY` |
| 2 | Unknown surface, or no frame yet | `STALE_FRAME` |
| 3 | Not `agent_controlled`, not `live`, or sender is not the owner | `SURFACE_NOT_AGENT_CONTROLLED` |
| 4 | Refresh pending, or `based_on_frame` sha256 or generation differs | `STALE_FRAME` |
| 5 | Another lease on this surface or display | `LOCKED_BY_OTHER` |
| 6 | No budget left, bad or passed deadline, clock before receipt time | `BUDGET_EXCEEDED` |
| 7 | `wait` longer than `budget.max_ms` | `BUDGET_EXCEEDED` |
| 8 | `scroll` delta does not fit in i32 | `OUT_OF_BOUNDS` |
| 9 | Any other `scroll` or `wait` | `POLICY` (not supported by the native adapter, module doc `core/src/admission/mod.rs:14`) [CITED: `core/src/admission/mod.rs`] |
| 10 | Click outside the frame; expectation box empty or outside the frame | `OUT_OF_BOUNDS` |
| 11 | Wrong epoch, epoch 0, or sender not an Agent | `POLICY` |

Other refusals: a repeated `proposal_id`, `msg_id` or nonce, or a `seq` that does not increase (`core/src/admission/mod.rs:1027`); a dispatch of an unknown or already dispatched proposal (`core/src/admission/mod.rs:1092`); capsule-slot requests not from the UI, reused ids, 256 retained outcomes, unconfirmed credential copy, busy or `mv-` profiles (`POLICY`), or no budget left (`BUDGET_EXCEEDED`) (`core/src/admission/mod.rs:426`). [CITED: `core/src/admission/mod.rs`]

Invariants: budget counts admitted attempts and a failed dispatch recheck does not refund it (`core/src/admission/mod.rs:16`); each proposal dispatches at most once; Lost and Destroyed surfaces are terminal (`core/src/admission/mod.rs:20`).

Tradeoff in the code: slot history keeps at most 256 outcomes "rather than evicting idempotency evidence", so a very long session refuses new slot work with `POLICY` (`core/src/admission/mod.rs:426`). [CITED: `core/src/admission/mod.rs`]

## What is on disk, and when does the journal refuse?

A session is `<state>/sessions/<session_id>/` with `journal.jsonl`, `genesis.json`, `checkpoint.json`, `events/` and `artifacts/`, directories mode 0700. `Journal::create` (`core/src/journal/mod.rs:1679`) builds it. `session_id` is 1 to 128 bytes of `[A-Za-z0-9._-]`, not `.` or `..`. [CITED: `core/src/journal/mod.rs`]

Answers: journal.jsonl; Corrupt; UPGRADE-REQUIRED; Poisoned; Locked

Ceilings [CITED: core/src/journal/mod.rs, core/src/wire/mod.rs]: journal file and any artifact 64 MiB (`MAX_BYTES`, line 651); 100000 records (`MAX_RECORDS`); one line 1048576 bytes (`MAX_FRAME_BYTES`, `core/src/wire/mod.rs:20`); frame sync window 50 ms, 8 frames per batch (line 61).

| Error (`core/src/journal/mod.rs:667`) | Cause | Result |
|---|---|---|
| `Corrupt`, `Empty`, `Blank`, `Utf8Bom`, `MissingLf`, `Oversize` | Edited or torn file, or over the ceiling | `mv-replay` exit 2 [CITED: `core/src/bin/mv-replay.rs`] |
| `UpgradeRequired` | Journal from another core version | Start a fresh session; never migrated (`core/src/journal/mod.rs:3886`) |
| `Duplicate` | Repeated `msg_id`, or `core_seq` not the running count | `mv-replay` exit 3 [CITED: `core/src/bin/mv-replay.rs`] |
| `Witness` | Missing artifact or digest mismatch | `mv-replay` exit 4 [CITED: `core/src/bin/mv-replay.rs`] |
| `Invalid` | Path rules, bad arguments, reducer mismatch | `mv-replay` exit 2 [CITED: `core/src/bin/mv-replay.rs`] |
| `Policy` | Record or byte ceiling reached | Session ends, next section |
| `Poisoned` | An earlier fsync failed | Later writes refuse |
| `Locked` | Another writer holds the lock | Recovery or a second core refused |

`Journal::recover` (`core/src/journal/mod.rs:1811`) takes the writer lock. If a scan fails it rolls back the torn tail (`try_rollback_uncommitted_tail`, `core/src/journal/mod.rs:3733`) and scans again. Read-only `scan` never repairs. Tradeoff: auditing an old session needs the matching `mv-replay` build.

## Why did a long session end?

At 100000 records or 64 MiB, `Journal::append` returns `Policy` (`core/src/journal/mod.rs:3144`). The server catches it and calls `end_full_journal` (`core/src/serve/mod.rs:1326`, `core/src/serve/journal_end.rs:172`). Admission ends, not the socket: accepted records are flushed, a `metaviewer.journal-ended/v1` marker is renamed into `journal-ended.json` (`core/src/serve/journal_end.rs:101`), and live surfaces get cleanup destroy commands. The marker must be a regular file of at most 1024 bytes, owned by the effective user, with no group or other bits (`core/src/serve/journal_end.rs:52`). The module header labels this policy `[TARGET, unit decision]`.

Answers: journal full; session ended by itself; journal-ended.json

Maintainer-reported, receipts not published: a full journal ended a live session. Workaround: start a fresh session per long run. See [JOURNAL_END.md](../JOURNAL_END.md).

## How do I verify a session, and why does mv-replay say Invalid?

Run the matching replay binary against the complete session archive; path and witness checks can refuse it.

Answers: mv-replay usage; exit codes; relative path; symlink; copied session

```bash
mv-replay --journal /abs/state/sessions/ID/journal.jsonl --witness-root /abs/state/sessions/ID
```

`--verify-only` skips printing the state hash; `--anchor <file>` pins an externally kept head (`core/src/journal/anchor.rs`). Exit codes (`core/src/bin/mv-replay.rs:41`): 0 verified, 3 `Duplicate`, 4 `Witness`, 2 everything else. [CITED: `core/src/journal/anchor.rs`]

| Path given | Rule | Result |
|---|---|---|
| Contains `..` | `confined` rejects parent components (`core/src/journal/mod.rs:1274`) | `Invalid` |
| Any symlink on the way | `confined` checks each prefix with `symlink_metadata` | `Invalid` |
| Session root without two parents | `private_archive` needs `state/sessions/ID` (`core/src/journal/mod.rs:1309`) | `Invalid` |
| Copied session directory | The complete archive must still satisfy ownership, mode, hierarchy and witness checks | Copying alone does not determine validity |

Check the complete archive and its path permissions; do not treat every copied archive as intrinsically invalid.

## How does a frame become evidence?

`read_published_frame` (`core/src/verify/mod.rs:67`) accepts a frame reference only if the path is canonical, under `/dev/shm`, a regular file owned by the core user with no group or other bits, of the exact length, with the same device and inode before, during and after the read, and with valid RGB geometry. Any failure is "invalid frame witness". Reads are capped at `MAX_RGB_BYTES`, 256 MiB. [CITED: `core/src/verify/mod.rs`]

Answers: invalid frame witness; /dev/shm frame; why is my frame rejected

In the journal, `verify_surface_frame_with_geometry` (`core/src/journal/mod.rs:2229`) refuses `Poisoned` on a poisoned journal and `Witness` on a zero, oversize or mismatched length or a malformed digest. Bytes read from disk are never marked verified without SHA-256 (`core/src/journal/mod.rs:30`). [CITED: `core/src/journal/mod.rs`]

*Inference*: binding each proposal to one frame hash lets the core show which picture the agent acted on and refuse with `STALE_FRAME` instead of acting on a moved screen.

## How does REWIND decide and refuse?

The live reducer is `core/src/rewind_flow.rs`, routed by `core/src/serve/rewind.rs`. `core/src/rewind.rs` is a standalone reducer compiled only by `core/tests/rewind.rs`; it is not live behaviour (`core/src/rewind.rs:1`). Physical evidence comes from the daemon; the reducer never invents it.

Answers: pause, mark, restore, resume; BUSY; STALE; POINT_UNAVAILABLE; CAPACITY; OWNER

| Op | Allowed from | Moves to |
|---|---|---|
| `pause` | `ready` | `pausing` |
| `resume` | `paused` | `resuming` |
| `mark` | `ready` or `paused` | `marking` |
| `restore` | `paused`, or `recoverable` to `last_good_usable` only | `restoring` |

(`core/src/rewind_flow.rs:157`.) At most two points are kept; a third `mark` evicts the oldest unreferenced point. A pending request expires after 35 s. Guest commands are fenced while a request is pending or its outcome is unknown (`core/src/rewind_flow.rs:60`). [CITED: `core/src/rewind_flow.rs`]

Refusals arrive as `rewind_event/v0.2` with `event: "refused"` and `data.code` (`core/src/rewind_flow.rs:88`):

| Code | Cause |
|---|---|
| `OWNER` | Caller is neither the guest-command creator UI nor the session agent, or the guest owner changed |
| `UNAVAILABLE` | No guest command session |
| `BUSY` | Guest not held, commands pending, job running, or wrong phase for the op |
| `STALE` | Request `workload_id`, `generation` or `authority_epoch` is old |
| `DUPLICATE` | Same `request_id`, or 256 requests used [CITED: `core/src/rewind_flow.rs`] |
| `CAPACITY` | Two referenced points held, or a counter would overflow |
| `POINT_UNAVAILABLE` | No usable point with that id and compatibility hash |
| `INVALID` | Missing field or unknown op |

Live restore demonstrations remain maintainer reports with unpublished receipts. See [ARM64_MICROVM_REWIND.md](../ARM64_MICROVM_REWIND.md) for the restore boundary.

## What are the recording limits and refusals?

Recording sits behind a durable sink; a sink failure commits nothing and raw pixels never cross it (`core/src/record/mod.rs:2`). The policy in `core/src/record/capture.rs:1` (labelled `[TARGET, unit decision]`): 64 retained captures, 8 active recordings, 8 MiB per ring, 64 MiB retained pixels, at most 60 fps, default 3 fps. Export archive at most 16 MiB (`EXPORT_BYTE_LIMIT`).

Answers: screenshot refused; LIMIT; CAPTURE_UNAVAILABLE; NOT_SEALED

| Code | Cause |
|---|---|
| `NOT_RECORDING`, `SURFACE_UNKNOWN`, `ALREADY_RECORDING` | Stop on a non-active id; surface not admitted; surface already recording (`core/src/record/capture.rs:271`) |
| `CAPTURE_UNAVAILABLE` | No frame yet, or pixels gone at export (`core/src/record/capture/export.rs:49`) |
| `LIMIT` | Any count or byte limit above, or export over 16 MiB [CITED: `core/src/record/capture.rs`] |
| `NOT_SEALED`, `CAPTURE_UNKNOWN` | Export before stop; unknown id (`core/src/record/capture/export.rs:49`) |
| `DESTINATION_UNAVAILABLE` | Export directory cannot be pinned or re-verified (`core/src/record/capture/export.rs:104`) |
| `POLICY` / `BUDGET_EXCEEDED` with text | Not admitted, wrong mode, bad bounds, reused id, unauthorized destination (`core/src/record/mod.rs:239`) |

## Where do I change what, and which tests cover it?

Change the owning module and keep its contract and negative tests in step.

Answers: add a refusal; change limits; core tests

| Change | Edit | Keep in step |
|---|---|---|
| A proposal rule or order | `CoreState::check`, `core/src/admission/mod.rs:1297` | `core/tests/admission_matrix.rs`; retain the version and replay compatibility checks |
| A refusal code | `Refusal`, `core/src/wire/mod.rs:103` | `contracts/v0.2/action_verdict.schema.json` first (L3 in `LAWS.md`) |
| Journal ceilings | `core/src/journal/mod.rs:61`, `:651` | `core/src/serve/journal_end.rs`, `core/src/serve/journal_end_tests.rs` |
| Archive path rules | `core/src/journal/mod.rs:1274` | `core/tests/t1_journal_verify.rs` |
| REWIND rules | `core/src/rewind_flow.rs:88` | `contracts/v0.2/rewind_*.schema.json`, `core/tests/rewind_flow.rs` |
| Recording limits | `core/src/record/capture.rs:1` | `core/tests/record_harden.rs` |

Other test files: `core/tests/admission_journal.rs`, `core/tests/admission_lifecycle.rs`, `core/tests/journal_recovery_fix.rs`, `core/tests/journal_upgrade.rs`, `core/tests/t1_anchor.rs`, `core/tests/replay_table.rs`, `core/tests/rewind.rs`, `core/tests/rewind_envelope.rs`, `core/tests/record_release.rs`, `core/tests/mut_rec_capture.rs`. Example: `cargo test -p metaviewer-core --test admission_matrix`. Results of a current run: ABSENT — not run for this edit.

## What is not covered or still open?

This dossier covers the cited core paths; deployment behavior needs its own evidence.

Answers: known issues; limits of this dossier

- Not read for this file: `serve/` routing beyond the paths named, `supervisor/`, `catalog/`, `guest_command.rs`, `headless.rs`, `transport/`. ABSENT — do not invent their behaviour from here.
- Package-side Python tools can leave unmanifested bytecode, and the next launch then holds with "exhaustive manifest inventory". Remove only generated bytecode and use `python3 -B`; see [DEBUG.md](../DEBUG.md#package-inventory-hold).
- Maintainer-reported, receipts not published: a paired terminal exited after a very long typed line. Cause unknown. ABSENT — do not invent.
- Router rows in `route/nodes.jsonl` may read `STALE`; treat them as leads. Find code with `python3 route/route_query.py error "UPGRADE-REQUIRED"` or `python3 route/route_query.py file core/src/rewind_flow.rs`, then `show`.

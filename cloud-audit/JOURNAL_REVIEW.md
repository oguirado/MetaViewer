# Journal fix review: B "end a full session journal cleanly", A "store frame state digests"

Scope: report only. Base: `origin/cloud/review-journal` at `9be3ce56` (merge of `5fcfa125`
A and `a1d4430b` B onto `5cf3cee2`). No product code is changed by this commit. Line
numbers are for `9be3ce56`. Background: `origin/cloud/audit-journal:cloud-audit/JOURNAL.md`.

Evidence kinds, kept apart:

- **Run**: throwaway Rust tests appended to `core/src/serve/journal_end_tests.rs` in this
  checkout, run with `cargo test --locked -p metaviewer-core --lib audit_ -- --nocapture`,
  then the file was restored. They are not in the commit. Bodies are summarised in section 5.
- **Read only**: source read; file:line references point at it.

Numbers carry [MEASURED], [CITED] or [TARGET]. Anything not found is written
`ABSENT — do not invent`.

## 1. Verdicts

| Commit | Verdict | Reason |
|---|---|---|
| **B** | **Merge after fixes B1, B2 and B3.** B4 (contracts) is required by `LAWS.md`. | The live end path works: no peer is reset, no record is lost, the refused frame is not published, and the journal replays. The restart path does not: a torn marker blocks `Server::open`, any mismatched marker blocks it, and every restart after a full journal re-sends destroy for capsules that are already stopped, then stalls with a false "capsule could not be stopped" dialog. Each fix is small and stays inside `journal_end.rs`. |
| **A** | **Merge after fixes A1 and A2.** If they cannot land and be run before scope closes, **do not merge A for this release**; B alone contains the failure. | The encoding is sound: every witness, record and chain link is kept, v1 replays, a forged v2 digest is detected. But the live e2e harness and the demo/gate tools that load it still read `state` from the newest event, which is now usually a v2 frame. A also makes 0.2.6 archives unreadable to 0.2.5, so a rollback strands sessions. A only stretches time to failure by about 1.6x [MEASURED, derived], so it is not the containment. |

No finding below asks for a budget to be raised.

## 2. Findings for B (`a1d4430b`)

| # | Severity | Confidence | Evidence | Finding |
|---|---|---|---|---|
| B1 | High | High | Run | Marker write is not atomic: a torn marker blocks open, and a failed write brings back the peer reset |
| B2 | Medium | High | Run | Any marker that disagrees with replay makes `Server::open` fail |
| B3 | High | High | Run, plus Go read only | Stop progress is not persisted: a restart re-destroys stopped capsules and stalls |
| B4 | Medium | High | Read only | New wire codes and the reserved `surface_id:"session"` have no contract text or examples |
| B5 | Medium | Low | Read only | No in-product way to start a fresh session once a session has ended |
| B6 | Low | Medium | Read only | The end notice skips the reserved terminal slot and is dropped silently when a UI queue is full |
| B7 | Low | High | Read only | Stop acknowledgments are not shown to the UI, so stopped capsules still look live |
| B8 | Low | High | Read only | Tests reach the end only through the record-count limit (P1), never the archive budget (P3) that fails in the field |

### B1: marker write is not atomic (High, run)

- Where: `core/src/serve/journal_end.rs:98-107`. The sequence is `create_new(true).mode(0o600)`,
  then `write_all`, then `sync_all`, then a directory fsync. The parse happens at
  `journal_end.rs:62`, called from `core/src/serve/mod.rs:475`.
- Sequence 1 (crash): the core dies after `create_new` and before `write_all` completes. That
  leaves an empty or partial `journal-ended.json`. On restart, `Server::open` returns
  `EOF while parsing a value at line 1 column 0` [MEASURED]. The session cannot be opened
  until someone deletes the file by hand.
- Sequence 2 (I/O error, no crash): `write_all` or `sync_all` fails, for example on ENOSPC.
  The error propagates and `journal_end` stays `None`. The next capacity refusal calls
  `end_full_journal` again, `create_new` fails with `File exists (os error 17)` [MEASURED],
  and `route_at` returns `Err`. That is the original adapter reset this commit was meant
  to remove.
- Fix:
  - write to a temporary file, fsync it, `rename` it into place, then fsync the directory;
  - treat an unreadable or empty marker as absent and re-derive it. The marker grants no
    authority and replay is the source of truth, so a missing marker only means the next
    append ends the session again (see section 4, step 2).

### B2: a mismatched marker is fatal at open (Medium, run)

- Where: `journal_end.rs:63-64`, via `mod.rs:475`.
- Sequence: change `state_sha256` or `core_seq` in the marker, then reopen. `Server::open`
  fails with `journal end marker disagrees with replay` [MEASURED].
- A marker copied from another session fails the same way. Its `state_sha256` covers that
  session's state, which includes its `session_id`. This was read only and not run
  separately.
- Ownership, mode and size are checked (`journal_end.rs:54-60`), so tampering needs the same
  UID. A natural stale marker was not found: `flush_sync` runs before the marker is written,
  and nothing appends after it. But the result of a mismatch is a session that cannot be
  opened, and the marker by design carries no authority.
- Fix: on a mismatch, move the marker aside and emit a diagnostic, then let replay decide.
  Open must not fail. The existing negative control (`journal_end_tests.rs:126-133`) should
  then assert "ignored and reported", not "open refused".

### B3: restart re-destroys stopped capsules and stalls (High, run)

- Where:
  - `new_session_end` (`journal_end.rs:32-45`) builds the stop list from replayed state;
  - destroy replies are deliberately not journaled (`journal_end.rs:157-181`);
  - `resume_journal_end` runs on every daemon connect (`mod.rs:2675`).
- Sequence:
  1. The journal fills.
  2. Both capsules are destroyed and acknowledged.
  3. The core restarts with the marker present.
  4. The daemon connects. The core sends
     `{"op":"destroy","params":{"surface_id":"surface-demo"}}` again [MEASURED].
  5. The adapter answers a destroy for an unknown or terminal surface with
     `fault("surface", "unknown or terminal surface")`
     (`daemon-adapter/internal/capsule/manager.go:1185`). That becomes a `surface_event` error
     carrying the request's `surface_id` (`daemon-adapter/internal/capsule/capsule.go:406`,
     read only).
  6. The core then broadcasts `JOURNAL_STOP_FAILED` [MEASURED] and keeps that surface
     `active` forever. No later capsule is ever stopped [MEASURED].
  7. The UI shows "A capsule could not be stopped. Stop the remaining capsules..."
     (`ui/electron/main.js:3136-3137`). That is false.
- Impact: every restart after a full journal shows a false failure dialog. If a capsule did
  survive, it is never stopped, because the stall blocks everything after the first entry.
  This also answers the question "does anything block a normal restart after a full
  journal": yes, this does.
- Fix: before stopping, reconcile with a daemon `list`, or treat a destroy refusal of
  "unknown or terminal surface" for the active id as stopped. Keep a real failure (for
  example the `POLICY` "input must be drained", `manager.go:1188`) as `JOURNAL_STOP_FAILED`.

### B4: contracts first (Medium, read only)

- B adds the wire codes `JOURNAL_FULL` and `JOURNAL_STOP_FAILED` (`journal_end.rs:85-90`,
  `journal_end.rs:193-199`), with a reserved `surface_id` of `"session"`. The UI now acts on
  them: it ends admission and rejects pending work (`ui/electron/hostBindings.js:506-518`).
- `surface_event.schema.json:155-159` accepts any `code` string, so validation passes.
- But no contract, README or example defines these codes or the reserved id. A grep of
  `contracts/` and `docs/` for `JOURNAL_FULL` finds nothing.
- `LAWS.md` (contracts first) needs a schema-level definition with one valid and one invalid
  example before the code that sends or reads the message.
- The on-disk `metaviewer.journal-ended/v1` marker has no schema either. It is internal, so
  this part is lower priority.

### B5: no fresh session once ended (Medium, low confidence, read only)

- The end is per `session_id`: the session root is `state_dir/sessions/<session_id>`
  (`mod.rs:239`). Ending a session makes it permanently closed, which is intended.
- B tells the operator to "Start a new session" (`main.js:3136-3143`) but adds no action that
  does so. The session id comes from `MV_SESSION_ID` (`ui/electron/coreLauncher.js:118`,
  `ui/electron/coreLauncher.js:1410`).
- Whether the packaged app reuses the same id across launches:
  `ABSENT — do not invent`.
- If it does, every launch reopens an ended session. The app is then unusable until someone
  changes the environment. Check this before release.

### B6: notice can be dropped (Low, read only)

- The end notice goes out through the normal `send_at` (`journal_end.rs:112-120`), and a
  `SendFailure` is swallowed. A saturated UI misses it until its next request, which is
  answered with the notice (`journal_end.rs:158-160`).
- The existing `QUEUE_OVERFLOW` and replay-exhaustion paths use the reserved terminal slot
  (`mod.rs:644-656`). The end notice does not.

### B7: stopped capsules still look live (Low, read only)

- Stop acknowledgments are not fanned out, by design (`journal_end.rs:1-4`). The UI keeps
  stopped capsules on screen with their last frame. This is cosmetic, but it can mislead.

### B8: end-to-end coverage misses P3 (Low, read only)

- The test hook `set_record_limit_for_test` (`core/src/journal/mod.rs:653-663`,
  `core/src/journal/mod.rs:3168-3176`) only lowers P1, the record count.
- The field failure is P3, the archive budget. Restart at a real P3 limit was not run:
  `ABSENT — do not invent`.
- By reading, replay accepts `archive_bytes <= MAX_BYTES` (`core/src/journal/mod.rs:4005-4008`),
  so open should succeed.

### Attacks that held for B

- **Accepted records are flushed.** `flush_sync` runs before the marker is written
  (`journal_end.rs:94`).
- **The triggering record is not lost.** The refused record never became durable. In the
  shipped test, the journal bytes and the snapshot are unchanged (run, passed).
- **Peers stay connected.**
  - In the route path, `route_at` converts `JournalError::Policy` into the session end
    (`mod.rs:1288-1302`). Batched daemon frames also go through this path, via
    `route_at_with_pixels`, so they are covered too.
  - The daemon Connect path has the same mapping (`mod.rs:2654`).
  - `JournalError::Policy` is produced only by the append budgets
    (`core/src/journal/mod.rs:3178`, `:3180`, `:3205`, `:3233`, `:3235`), so no
    non-capacity error ends a session.
- **A frame racing the end** is routed to `route_ended_session` (`mod.rs:1322`). It is
  neither journaled nor published.
- **Emergency destroy replies** never become state or publications.
- **A create in flight** is added to the stop list (`journal_end.rs:163-167`).
- **An unrelated daemon error** does not release the ordered stop barrier (shipped test).
- **Timers** are gated (`mod.rs:2033`).
- **The retire path** swallows journal errors (`mod.rs:504-535`).
- **Replay after the end** matches the live snapshot (shipped test, passed).

## 3. Findings for A (`5fcfa125`)

| # | Severity | Confidence | Evidence | Finding |
|---|---|---|---|---|
| A1 | Medium | High | Read only | The live e2e harness, and the gate and demo tools that load it, read `state` from the newest event |
| A2 | Medium | High | Read only (diff) | 0.2.5 cannot open archives written by 0.2.6 |
| A3 | Low | Medium | Read only | `metaviewer.event/v2` is read by tools but has no schema or examples |
| A4 | Info | Medium | Derived | The archive budget gain is about 1.6x: not containment |

### A1: readers that still expect `state` (Medium, read only)

- `tests/e2e/e2e1_slice/live.py:708`: `replay_probe` reads
  `events/<last>.json["state"]` to compute the digest it compares with `mv-replay`.
- `tests/e2e/e2e1_slice/live.py:815`: `snapshot()` returns the newest event's `state`. Its
  callers are at `live.py:845`, `:862`, `:959`, `:987`, `:1022` and `:1219`. Line 1022 waits
  for a frame generation to advance, so the newest event there is by construction an
  admitted frame, now v2 with no `state`. That raises `KeyError`.
- `live.py` is loaded by:
  - `tests/e2e/e2e1_slice/asm_web_live.py:868`;
  - `tools/mw_run_backend.py:83`;
  - `tools/gate_g_ai.py:23`;
  - `tools/mv_demo.py:40`.
  The offline unit discovery in `tools/gate.sh:1409-1415` imports from the same directory.
- Fix:
  - `replay_probe` can use `state_sha256` when it is present. `mv-replay` prints
    `sha256_hex(snapshot)` (`core/src/bin/mv-replay.rs:36`), which is the same value.
  - `snapshot()` needs the real reduced state. Do not walk back to the last v1 event: that
    state is stale. Use a replay dump instead.
  - Then run the live slice once.
- Readers checked and safe for v2, read only:
  - `Server::open` (`mod.rs:271-330`) and `capture.rs:48-60` read only `input`, `outcome`
    and `witnesses`;
  - `mv-replay` uses `scan`;
  - rewind uses the boundaries computed by replay;
  - `contracts/` and `docs/` do not mention `metaviewer.event`.

### A2: no rollback path (Medium, read only, from the diff)

- Before A, all three verifiers required `event.schema == "metaviewer.event/v1"`. See the
  lines A removes at `core/src/journal/mod.rs:3562`, `:3591` and `:3936` of the base.
- A 0.2.5 core opening any session that a 0.2.6 core wrote with an admitted frame therefore
  gets `Corrupt` and refuses the session.
- Fix: a release note at minimum. Better: an explicit, actionable `UPGRADE-REQUIRED`-style
  refusal, like the existing one at `mod.rs:252`.

### A3: no schema for event/v2 (Low, read only)

- `valid_encoding` (`core/src/journal/mod.rs:1092-1103`) declares event/v2 "internal archive
  encoding only".
- But Python tooling reads `events/`, and `contracts/` has no schema or examples for v1 or
  v2. Record that unit decision in the docs, or add the schema.

### A4: budget gain (Info, derived)

- P3 still charges the full snapshot per record (`core/src/journal/mod.rs:3232`, `:3588`,
  `:3671`, `:4005`). Only the `state` embedded in the event goes away.
- From the background audit's 6-capsule figures (event 3 037 B, snapshot 1 929 B), a v2 event
  is about 1 190 B. A record then costs about 3 120 B instead of 4 966 B, so time to failure
  stretches about 1.6x [MEASURED, derived]: about 3.8 min becomes about 6 min at 60
  records/s.
- Recovery time per record is about the same: replay still builds the snapshot, and now
  hashes it.
- About 1.6x more records now fit, and `Server::open` reads every event file plus one witness
  per record (`mod.rs:271`), so recovery should get longer in proportion. Recovery time was
  not measured: `ABSENT — do not invent`.

### Attacks that held for A (shipped tests, run, passed)

- **Every record, witness and boundary is kept**:
  `compact_frames_keep_every_record_witness_and_reduced_boundary`.
- **v1 bytes survive recovery and mixed appends**:
  `legacy_frame_bytes_survive_recovery_and_mixed_compact_append`.
- **A forged v2 digest or other corruption fails, even after the archive hash is resealed**:
  `compact_corruption_fails_even_with_resealed_archive_hash`.
- **A fabricated post-state is refused at append**:
  `compact_append_still_rejects_a_fabricated_post_state`.
- **Refused frames keep full v1 snapshots**:
  `refused_frames_retain_full_diagnostic_snapshots`.
- **v2 is bound to reducer state** (read only). `valid_encoding` allows v2 only for an
  admitted `Input::Frame` with no `state` and a hex digest. `matches_snapshot`
  (`core/src/journal/mod.rs:1105-1113`) compares the digest with the snapshot that replay
  reduced itself, in all three verifiers.
- **Rewriting a v2 event as v1 with the correct full state** is accepted. That is harmless,
  because the state is still checked.

## 4. Crash at each step of the end sequence (B)

| Step | Crash or failure point | Result on restart | Evidence |
|---|---|---|---|
| 1 | Before `flush_sync` (`journal_end.rs:94`) | No marker. The refused record was never durable. The first append fails with `Policy` and ends the session again. Frames acknowledged but not yet synced follow the existing asynchronous frame-sync contract; B does not change it. | Read only |
| 2 | After flush, before `create_new` | Same as step 1. The end is re-derived. | Read only |
| 3 | Between `create_new` and a complete `write_all` | Open fails (B1) | Run |
| 4 | After the file fsync, before the directory fsync | The marker may vanish, giving the same result as step 2. Safe. | Read only |
| 5 | During notices and stops | The marker is valid and stops resume, but already-stopped capsules are re-destroyed and the sequence stalls (B3) | Run |

## 5. Run evidence

- Command: `cargo test --locked -p metaviewer-core --lib audit_ -- --nocapture --test-threads=1`.
- Result: 4 passed in 1.00 s [MEASURED].
- The shipped filtered suite (`journal_end`, `compact_tests`, `nv_regressions`) passed 47 of
  47 in 4.13 s [MEASURED], after a 55.5 s build [MEASURED].
- Each throwaway test seeds two surfaces and sets the record limit to the current sequence
  plus 1. It routes two frames, and the second one ends the session.

| Test | What it does | Observed [MEASURED] |
|---|---|---|
| `audit_restart_after_completed_stop_reissues_destroy_for_stopped_capsules` | Acknowledges both destroys, then reopens the session root. Calls `resume_journal_end` for a daemon. Routes the adapter's unknown-surface error. | The core sends destroy for `surface-demo` again. The UI receives `JOURNAL_STOP_FAILED`. No destroy for `surface-second` follows. |
| `audit_torn_marker_blocks_server_open` | Empties `journal-ended.json`, then reopens | `Server::open` fails: `EOF while parsing a value at line 1 column 0` |
| `audit_stale_marker_blocks_server_open` | Sets `state_sha256` to 64 zeros, then reopens | `Server::open` fails: `journal end marker disagrees with replay` |
| `audit_create_new_marker_refuses_second_end_after_torn_write` | Empties the marker, clears `journal_end` (the state left after a failed write), and routes one more frame | `route` returns `Err("File exists (os error 17)")` |

Not run here:

- the Go adapter, which was read only;
- the Electron UI;
- the e2e live slice;
- a restart at a real P3 limit;
- recovery-time measurement.

There is no display stack in this environment.

## 6. Minor

- The release notes are named `changes/unreleased/v028-*.md` while the release is 0.2.6.
  Check that they land in the right notes.
- `route_at` now clones every envelope (`mod.rs:1291`). The cost is small, because pixels
  travel separately.

---
Model: not named in this file, because repository policy forbids naming an AI model in
repository files; the session reply gives it. Effort: medium, about 40 minutes.

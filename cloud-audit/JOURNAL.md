# Journal load audit: `core peer closed: Policy` with animated Host program capsules

Scope: report only. Base: `ci/assets-a7c36e9da` at `a7c36e9`. No product code was
changed. This audit was done independently of the local worker. Evidence comes in
two kinds, kept apart:

- **Read only**: the source was read in this checkout and the file:line references
  point at it.
- **Run**: a throwaway Rust test ran in a separate scratch copy made with
  `git archive HEAD`. That test is not in this repository and was not committed.
  The test bodies are summarised in "Run evidence".

Numbers are tagged [MEASURED] (from the run), [CITED] (a constant or line in the
source) or [TARGET]. A figure marked "derived" is arithmetic on a measured cost and a
cited limit. Anything not found is written `ABSENT — do not invent`.

## 1. Verdict

The local reading is correct about the mechanism. It is incomplete about which limit
is hit. `Journal::append` has **three** budgets that end in `JournalError::Policy`:

1. the record count;
2. the size of `journal.jsonl`;
3. the **archive budget**.

The archive budget is what runs out first at these frame rates. Each record charges
it the size of the record's `events/<seq>.json` file plus the size of a full state
snapshot. The snapshot grows with every capsule, and the event file already contains
the state, so each record pays for the state twice.

The contrary data point is not contrary. "7583 records, 1.3 MB" works out to 171 B
per record [MEASURED], derived. That is the size of a `journal.jsonl` line, so 1.3 MB
is the `journal.jsonl` size. Neither number shows the archive budget.

A run with 6 synthetic capsules reproduced the failure at record 13 516 [MEASURED].
At that point `journal.jsonl` was only 2 397 239 B [MEASURED], and the error displayed
as exactly `Policy` [MEASURED].

## 2. Every path that can print `Policy` and close the peer (read only)

The log line comes from `core/src/serve/mod.rs:2541`:
`eprintln!("core peer closed: {error}")`. It prints whatever error `connection()`
returned. That error type is `Box<dyn Error>` (`core/src/serve/mod.rs:79`).

The text is exactly `Policy` only when the boxed error is `JournalError::Policy`.
Its `Display` falls back to `Debug` (`core/src/journal/mod.rs:704`). Messages that
look similar but are not this one:

- `Refusal::Policy` displays as `POLICY` (`core/src/wire/mod.rs:116-123`). It is sent
  as an `action_verdict` and never closes the peer.
- `HandshakeError::MissingPolicy` and `CatalogError::NestedPolicy` print their own
  variant names.
- No `io::Error` or `invalid(..)` message in `serve` contains `Policy`. A grep found
  none.

Sources of `JournalError::Policy` in `Journal::append` (`core/src/journal/mod.rs:3112`):

| # | Condition | Line | Limit |
|---|---|---|---|
| P1 | `count >= MAX_RECORDS` | 3125-3126 | `100_000` records [CITED] (line 652) |
| P2 | `bytes + record line + 1 > MAX_BYTES` (`journal.jsonl`) | 3147-3153 | 64 MiB = 67 108 864 B [CITED] (line 651) |
| P3 | `archive_bytes + event.len() + snapshot.len() > MAX_BYTES` | 3164-3175 | the same 64 MiB [CITED] |
| P4 | `checked_add` overflow on `count` or `archive_bytes` | 3128, 3173 | unreachable in practice |

Notes on these sources:

- `archive_bytes` only grows. It is set to the genesis size at open (line 1751), and
  on recovery it is rebuilt to the same total (lines 3888-3949). Nothing during a
  session ever lowers it.
- Replay has the same checks (lines 3890-3954). Those fire when the server opens, not
  as a peer close.

How a journal error reaches a peer close:

- Every journaled input goes through `Authority::apply_with_witnesses`
  (`core/src/admission/mod.rs:1412-1424`) and is propagated with `?`. That covers
  daemon frames (`core/src/serve/mod.rs:984-986`, called from 1549 and 1680),
  daemon observations (1707-1708), UI intents and agent proposals.
- `Input::Connect` on every new connection is journaled with a witness
  (`core/src/serve/mod.rs:2626-2628`).
- The read loop propagates route errors with `?` (around lines 2730-2815), so
  `connection()` returns the error. The socket is then dropped, and the adapter sees
  that as a connection reset.

`Policy` is returned **before** the handle is poisoned (line 3200). So the journal
stays open, but every later append fails the same way, including reconnects.

The run confirmed this: after the failure, `apply(Input::Connect)` returned
`Err(Policy)` [MEASURED]. Restarting the adapter cannot recover the session. Replay
recomputes the same budget, so restarting the core with the same session cannot
either. Only a fresh `session_id` can.

**Likely here:** P3, the archive budget. P1 needs 100 000 records [CITED] and the
contrary run had 7 583 [CITED, from the brief]. P2 needs 64 MiB of 173 B lines, about
388 000 records [MEASURED], derived.

## 3. What one displayed frame writes (run, separate scratch copy)

The test drove `Server::route_at` with daemon `surface_event.frame_ready` envelopes
through a real `Server::open` session root. It used 1, 4 and 6 surfaces, 20 frames
per surface and 320x240 RGB24 frames, then flushed and measured the files.

The surfaces are minimal synthetic ones: no allowed verbs, no slots, no profiles.
Real Host program capsules carry more state, so these per-record figures are a
**lower bound**.

| Per accepted frame | 1 capsule | 4 capsules | 6 capsules |
|---|---|---|---|
| Records | 1 [MEASURED] | 1 [MEASURED] | 1 [MEASURED] |
| `journal.jsonl` line incl. LF | 172.3 B [MEASURED] | 172.9 B [MEASURED] | 173.4 B [MEASURED] |
| `events/<seq>.json` | 1 623 B [MEASURED] | 2 471 B [MEASURED] | 3 037 B [MEASURED] |
| State snapshot charged to archive budget | 503 B [MEASURED] | 1 358 B [MEASURED] | 1 929 B [MEASURED] |
| **Archive budget charged** | **2 126 B** [MEASURED] | **3 829 B** [MEASURED] | **4 966 B** [MEASURED] |
| `artifacts/` growth (pixels and boundary envelope, 2 files) | 231 248 B [MEASURED] | 231 249 B [MEASURED] | 231 250 B [MEASURED] |

How to read these numbers:

- Artifacts grow by the raw frame size, 230 400 B for 320x240x3 [MEASURED], plus
  about 848 B for the boundary envelope [MEASURED].
- At 1280x900 the pixel artifact would be 3 456 000 B [CITED]
  (`core/src/serve/tests.rs:214`).
- Artifacts do **not** count toward any of P1-P3.
- Whether and when artifacts are evicted from disk was not examined:
  `ABSENT — do not invent`.

Limit run:

- Setup: 6 surfaces, 8x8 frames. Pixel size does not change P1-P3.
- `route_at` returned `Err`, displayed as `Policy`, downcast to
  `JournalError::Policy`, after 13 516 records [MEASURED].
- State at that point:
  - `events/` held 41 228 923 B in 13 516 files [MEASURED];
  - the snapshot was 1 919 B [MEASURED];
  - `journal.jsonl` was 2 397 239 B [MEASURED];
  - genesis was 345 B [MEASURED].
- Prediction from the per-record cost: 67 108 864 / 4 966 = 13 514 records
  [MEASURED], derived. That is within 2 records of the run.

## 4. Time to each limit at 10 images per second per capsule

Each displayed frame is one record. Setup records are negligible. Derived from the
measured synthetic per-record cost and the cited limits:

| Capsules | Records/s | P3 archive budget | P1 100 000 records | P2 `journal.jsonl` 64 MiB |
|---|---|---|---|---|
| 1 | 10 [TARGET] | 31 566 records, about 52.6 min [MEASURED], derived | 10 000 s, about 2.8 h [MEASURED], derived | about 388 000 records, never before P1 |
| 4 | 40 [TARGET] | 17 527 records, about 7.3 min [MEASURED], derived | 2 500 s, about 41.7 min [MEASURED], derived | never before P1 |
| 6 | 60 [TARGET] | 13 514 records, about 3.8 min [MEASURED], derived (run: 13 516) | 1 667 s, about 27.8 min [MEASURED], derived | never before P1 |

P3 comes first in every case.

Real Host program capsules: suppose the 7 583-record, 5-capsule run stopped because
of this. Then the real cost is about 67 108 864 / 7 583 = 8 850 B per record
[MEASURED], derived. That is about 1.8 times the synthetic 6-capsule cost, and at
50 records/s it is about 2.5 min.

This is an inference. The size of that run's `events/` directory was not provided:
`ABSENT — do not invent`. Running `du -b events/` plus one snapshot in that session
root would settle it.

## 5. Can a frame refusal raise the rate?

**No, but refusals do not save budget either.**

What happens to a stale frame:

- The core reads, hashes and retains the pixels first. A stale or unknown-surface
  frame then becomes `Input::Refuse { StaleFrame }`, journaled **with both
  witnesses** (`core/src/serve/mod.rs:961-986`).
- The run measured each stale refusal at:
  - 1 record [MEASURED];
  - a 165-167 B line [MEASURED];
  - a 1 496-2 930 B event file [MEASURED];
  - about 231 003 B of artifacts [MEASURED].

  That is almost the same cost as a displayed frame.
- The core then sends a `STALE_FRAME` verdict to the daemon (lines 1683-1694). The run
  confirmed one verdict per refusal [MEASURED].

What the adapter does with it:

- It consumes the verdict silently: it removes the frame ID and continues
  (`daemon-adapter/internal/daemon/stream.go:305-327`).
- It does not resend, and it does not reset deduplication.
- Only a failed publication or delivery resets digest confirmation
  (`daemon-adapter/internal/frames/subscriptions.go:3-8`). Even then, missed
  deadlines are skipped rather than queued. Read only; the Go side was not run.

So the record rate stays at the capture cadence. Every refused frame is still a full
record against P1-P3.

The cause of the repeated refusals in the incident was not determined:
`ABSENT — do not invent`. Possible causes, not shown: an out-of-order generation, or a
frame for a surface the core does not know yet.

## 6. Should one peer failing take all capsules down?

As built, it always will. All capsules share one daemon connection. When it drops,
`daemon.Run` returns code 2 (`daemon-adapter/internal/daemon/run.go:72-75`), and the
adapter sets `PR_SET_PDEATHSIG` (`daemon-adapter/cmd/mv-daemon-adapter/main.go:37-38`).
So the capsules die with it.

Two distinct questions:

- **Journal exhaustion is session-wide by design.** After P3, no peer can journal
  anything, Connect included. A fail-closed stop is consistent with "every frame
  witness journaled before fan-out" (`docs/ARCHITECTURE.md:182`).

  But the stop should be a typed terminal diagnostic, like the existing
  `QUEUE_OVERFLOW` slot (`docs/ARCHITECTURE.md:382-384`) or `ClockCeilingError`
  "restart session" (`core/src/serve/mod.rs:155-163`). It should not be a socket reset
  that crashes the adapter and kills the capsule processes. Capsule processes hold
  operator work that the journal does not.
- **A per-capsule fault should not retire the shared connection.** Today it does. For
  example, `frame digest mismatch` or a witness failure for one surface makes
  `Server::frame` return `Err` (`core/src/serve/mod.rs:945-954`, comment at 957-959),
  and that retires the whole daemon connection, so it affects all capsules. This is
  outside the journal question, but it is the same blast-radius issue.

## 7. What must be journaled (contracts, laws, docs)

- Each frame witness is verified and journaled before `frame_ready` fans out to the UI
  (`docs/ARCHITECTURE.md:182`). A displayed frame therefore requires a record.
- "Records refusals as well as admissions". Unsupported well-formed messages get
  journaled `POLICY` verdicts (`docs/ARCHITECTURE.md:378-381`). A refusal therefore
  requires a record.
- `session_record` is an "ordered append-only journal event"
  (`contracts/v0.2/README.md:39`) with `kind` in `received`, `admitted`, `refused`,
  `executed`, `verified` and `surface_changed`
  (`contracts/v0.2/session_record.schema.json`). The hash chain is `prev_sha256`
  (`core/src/journal/mod.rs:3140-3146`).
- A frame the core never displays may skip the journal. Superseded uncommitted frames
  "never enter state, journal, capture, or display" (`core/src/serve/mod.rs:1024-1025`).
- `LAWS.md` sets contracts first: a new or changed message type needs its schema, with
  one valid and one invalid example, before the code that sends or reads it.

## 8. Fix options: no limit raised, no required record dropped

| # | Option | Effect on time to failure | Risk |
|---|---|---|---|
| F1 | **Do not reset the socket on journal exhaustion.** Map `JournalError::Policy` from append into a typed terminal session notice, using the reserved terminal slot (as for `QUEUE_OVERFLOW`). Stop admitting journaled input. The adapter does not exit 2 on that notice, so it keeps the capsule processes alive, and the UI asks for a fresh session. | None, but capsules and operator work survive | Medium. A new terminal code or event needs a schema first (LAWS contracts first). The adapter exit and parent-death path must change carefully so slot writes still cannot outlive their launcher. Best fit for 0.2.6 as containment. |
| F2 | **Early warning.** Expose remaining P1, P2 and P3 headroom in diagnostics and warn at a fixed fraction, so the operator rotates the session before a demo. | None | Low. Diagnostics only, or a schema if it goes on the wire. |
| F3 | **Stop charging state twice in P3.** The event file already embeds `state`, and P3 adds `snapshot.len()` on top (`core/src/journal/mod.rs:3164-3172`, replay at 3943-3949). The snapshot charge does bound the replay `boundaries` vector, which is held in memory (3950), so it cannot simply be removed. Instead, keep boundaries as hashes plus offsets, or bound them separately with their own existing-size budget. | About 1.3-1.6 times longer [MEASURED], derived (2 126 / 1 623 to 4 966 / 3 037) | Medium. The checks in append and replay must stay identical or recovery refuses its own journal. It changes what P3 means, so it needs maintainer sign-off that this is not "raising a limit". |
| F4 | **Slim frame events.** Store a state digest or delta per record instead of the full `state` in `metaviewer.event/v1`. Most of the 1.6-3.0 KB event is state. | Large, tending toward the size of the line plus witnesses | High. It is a new event schema (`v2`), replay and verify change, and rewind boundaries must be rebuilt from deltas. Not for 0.2.6. |
| F5 | **Coalesce before commit.** Widen the existing supersede path (`can_supersede_frame`, `route_daemon_batch`) so that per surface per batch only the newest frame is verified, journaled and displayed. Frames never displayed need no record (section 7). | Proportional to the drop in displayed fps | Low to medium. The operator sees a lower effective fps under load. The existing anchored-path and symlink tests must keep passing. |
| F6 | **Pace display per capsule.** Lower the displayed cadence for off-screen or idle capsules, or hold one session budget across capsules. Every displayed frame stays journaled. | Proportional to the rate cut | Low to medium. It conflicts with "capture pacing belongs to the session, independently of UI visibility" (`subscriptions.go:3-4`), so that decision would need revising. |
| F7 | **Remove the cause of stale frames.** Each refusal costs a full record (section 5). Preventing the adapter from sending a generation the core will refuse saves budget without dropping any refusal that does occur. | Equal to the refusal share of records | Low, once the cause is known. The cause is currently `ABSENT — do not invent`. |
| F8 | **Segment rollover.** At a seal point, close the current journal and archive segment and continue the `prev_sha256` chain in a new segment under the same per-segment limits. | Unbounded session length | High. New on-disk format, recovery, checkpoint and rewind semantics, and contract work. Not for 0.2.6. |
| F9 | **Isolate per-capsule faults.** Turn a single surface's witness or digest failure into a journaled refusal or a `lost` for that surface instead of retiring the shared daemon connection (section 6). | None for the journal; contains other faults | Medium. Today's explicit decision (`core/src/serve/mod.rs:957-959`) keeps those failures atomic, so this needs a decision and tests. |

For 0.2.6, the order with the lowest regret is F1 plus F2 for containment, then F5 or
F6 to stretch the time to failure, with F7 once the cause of the refusals is known.
F3, F4 and F8 are post-release design work.

## 9. Run evidence (separate from the read-only part)

- Location: a scratch copy from `git archive HEAD`, outside this checkout. Command:
  `cargo test --locked --lib <name> -- --nocapture`.
- Two throwaway tests were appended to `core/src/serve/tests.rs` in the copy only:
  - `audit_journal_cost_per_frame`: 1, 4 and 6 surfaces; 20 accepted frames each,
    then 5 stale generation-1 frames each. It measured `journal.jsonl`, the `events/`
    and `artifacts/` directories, the snapshot and the `STALE_FRAME` verdicts. It
    passed in 6.77 s [MEASURED].
  - `audit_journal_limit`: 6 surfaces, frames until `route_at` failed. It printed the
    error, then called `apply(Input::Connect)`. It passed in 217.34 s [MEASURED].
- Both tests reuse the fixture pattern of
  `frame_ready_latency_and_concurrent_generations_on_3_45mb_frames`
  (`core/src/serve/tests.rs:90`).
- Not run here: the Go adapter, a display stack and real Host program capsules. This
  environment has no display, docker or KVM.

---
Model: not named in this file, because `LAWS.md` L1.2 forbids naming an AI model in
repository files; the session reply gives it. Effort: low.

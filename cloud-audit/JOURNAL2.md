# Journal fix second review: "end a full session journal cleanly" and its recovery fix

Scope: report only. Base: `origin/cloud/review-journal2` at `b5a79152`. The commits under
review are `35dd5e34` ("core: end a full session journal cleanly") and `b5a79152` ("core: fix
full journal recovery and closed-session presentation"). The earlier review is
`origin/cloud/audit-journal-review:cloud-audit/JOURNAL_REVIEW.md`, findings B1 to B8. This
commit changes no product code. Line numbers are for `b5a79152`. Compact frame events
(`5fcfa125`) are out of scope. They are also not in this branch.

Evidence kinds, kept apart:

- **Run**: throwaway Rust tests appended to `core/src/serve/journal_end_tests.rs` in this
  checkout, run, then the file was restored with `git checkout`. They are not in the commit.
  Section 6 summarises them.
- **Read only**: source read; file:line references point at it.

Numbers carry [MEASURED], [CITED] or [TARGET]. Anything not found is written
`ABSENT — do not invent`. No finding asks for a budget to be raised.

## 1. Verdict

**Merge after listed fixes F1 and F2** (section 3). Both are small and stay inside
`journal_end.rs`, `serve/mod.rs` retire, and one adapter refusal string.

The restart blockers from the first review are gone, and I ran each one:

- a torn, empty, malformed or mismatched marker no longer blocks `Server::open`;
- a failed marker write no longer resets the peer;
- a restart after completed stops no longer stalls on a false failure.

The archive-byte (P3) path is now tested end to end.

Two new holes come from the fixes themselves:

- **F1 (N1).** The B3 fix treats "unknown or terminal surface" as "stopped". The adapter sends
  the same refusal while a destroy is still in progress. The stop order is then broken, and a
  later real stop failure is never reported.
- **F2 (N2).** Disconnect cleanup still appends journal records after the session has ended.
  That turns the now-tolerated marker stale, so a restart reopens the ended session as live.

If F1 and F2 cannot land and be run before scope closes, merging as is still beats the base:
neither hole is worse than the stall or open failure it replaces. In that case, list N1 and N2
as known issues in the 0.2.6 notes.

## 2. Earlier findings B1 to B8

| # | Status | Evidence | Notes |
|---|---|---|---|
| B1 marker not atomic | **Fixed** | Run | Temp file, write, fsync, `rename`, directory fsync (`journal_end.rs:81-105`). An empty or torn marker is ignored (`journal_end.rs:62-77`). Admission closes before the write is attempted, so a write failure no longer reaches the peer (`journal_end.rs:136-139`). Residuals: N4 and N5. |
| B2 mismatched marker fatal | **Fixed** | Run | A mismatch is reported, renamed to `journal-ended.ignored.json`, and open continues (`journal_end.rs:69-76`). Side effect: a stale marker now silently un-ends the session, and N2 shows a natural way to make one. |
| B3 restart re-destroys and stalls | **Partly** | Run | The exact adapter pair `ADAPTER_SURFACE` / `surface: unknown or terminal surface` releases the barrier (`journal_end.rs:205-216`). This matches the real wire: `manager.go:1185` → `WireCode` gives `ADAPTER_SURFACE` (`manager.go:286-320`), and `Fault.Error()` gives `code: detail` (`cli/runner.go:21`, `environment.go:1149-1165`). Restart after completed stops now passes. Residual: N1. |
| B4 contracts first | **Partly** | Read only | `docs/JOURNAL_END.md` defines both codes and the reserved `session` id, with one valid and one invalid example in prose. See section 5 for the `LAWS.md` reading and the doc errors. |
| B5 no fresh session | **Fixed (docs + launcher)** | Read only | The packaged entry mints `pkg-${randomUUID()}` on every launch (`ui/tools/package.js:1017`, `:1461`). The dialog now says to close and reopen (`ui/electron/main.js:3138-3140`). The new relaunch test (`ui/test/pkgfix-packaged-entry.test.js:281-302`) was **not run** (section 6). There is still no in-app "new session" action. |
| B6 notice can be dropped | **Not fixed** | Read only | The notice still uses plain `send_at` (`journal_end.rs:127`), and a `SendFailure` is swallowed (`journal_end.rs:148-151`). A saturated UI learns of the end only on its next request. Still Low. |
| B7 stopped capsules look live | **Fixed (UI)** | Read only | On the first notice, every `active` surface is published as `lost` and removed from the display, and frames and pending deliveries are cleared (`ui/electron/hostBindings.js:510-522`). The shipped UI test was not run. Surfaces in other states are left as they are. |
| B8 P3 never tested | **Fixed** | Run | `journal_archive_byte_limit_preserves_replay_and_transport_with_a_torn_hint` (`journal_end_tests.rs:442-552`) fills the real 64 MiB budget: 865 records, 67 074 275 accounted bytes [MEASURED]. Replay, transport and the ended state all survive a restart. Its records are about 77 KB each because the fixture enlarges the state, and the headroom left at the end is 34 589 B [MEASURED, derived], smaller than any record. So the test cannot show the window N2 needs. |

## 3. New findings

| # | Severity | Confidence | Evidence | Finding |
|---|---|---|---|---|
| N1 | Medium | High (core), Medium (trigger) | Run (core), adapter read only | The "terminal" refusal also means "destroy in progress": the core advances early and masks a real stop failure |
| N2 | Medium | High (path), Medium (P3 reachability) | Run (P1 proxy) | Disconnect cleanup appends journal records after the end, which makes the marker stale; a restart then reopens the session as not ended |
| N3 | Low | High | Run | Any error naming the active stop target is reported as `JOURNAL_STOP_FAILED`, and the dialog is never withdrawn |
| N4 | Low | High | Run | The temp marker name can collide after a restart, and leftover temp files are never removed |
| N5 | Low | Medium | Read only | A `flush_sync` failure at the end still becomes a peer transport error |
| N6 | Low | High | Read only | `docs/JOURNAL_END.md` overstates closure, and its terminal-pair claim misses the in-progress case |

**Required before merge: F1 = fix N1, F2 = fix N2.** N3 to N6 are recommended, not blocking.

### N1: "unknown or terminal surface" is also "destroy in progress" (Medium)

- Where:
  - `daemon-adapter/internal/capsule/manager.go:1184-1186` returns the same fault when
    `m.destroying[q.SurfaceID]` is set. The destroy then drains with the lock released
    (`manager.go:1190-1199`), so it can take time and can still fail.
  - The core releases its barrier on that pair (`journal_end.rs:205-216`).
- Sequence A (no restart):
  1. A person or agent closes capsule X.
  2. The destroy is forwarded and X enters `destroying`.
  3. The journal fills before the `destroyed` state is journaled, so X is still in the stop
     list (`journal_end.rs:32-46`).
  4. The emergency destroy for X is answered "unknown or terminal surface".
  5. The core sends destroy for Y while X is still being destroyed, which breaks the "one
     outstanding destroy" rule (`journal_end.rs:1-4`).
  6. X's original destroy then fails. Its error names X, but `active` is now Y, so the error
     is ignored (`journal_end.rs:210-220`). No `JOURNAL_STOP_FAILED` is sent.
- Sequence B: the daemon reconnects while the emergency destroy for X runs.
  `resume_journal_end` pushes X back and re-sends it (`journal_end.rs:111-115`). The duplicate
  is answered with the same refusal, with the same result. Whether the adapter keeps a destroy
  running across a reconnect: `ABSENT — do not invent`.
- Proven: `audit2_destroy_in_progress_refusal_advances_and_masks_real_failure`. The next destroy
  is for `surface-second` while X is still being destroyed. The UI gets no message after X's
  real failure [MEASURED].
- Impact: a capsule can keep running while the UI shows it as `lost` and reports no failure.
  Order-dependent cleanup is violated.
- Fix (F1): split the adapter refusal. Keep `unknown or terminal surface` for
  `!ok || destroyed`, and add a distinct detail for `m.destroying`. In the core, keep the
  barrier on the in-progress detail and release it on the later `destroyed` state or error for
  that id. Add the matching negative control.

### N2: post-end journal appends make the marker stale (Medium)

- Where: `retire` (`serve/mod.rs:504-551`) calls the following with no `journal_end` gate:
  - `mark_headless_unknown` → `authority.apply(Input::HeadlessUncertain)` (`headless.rs:146`);
  - `mark_guest_command_unknown` → `apply(Input::GuestCommandUncertain)` (`guest_command.rs:223`);
  - `settle_human_input_in_journal` → `apply_with_witnesses(Input::Refuse{Policy})`
    (`serve/mod.rs:493-503`), for the daemon and for each UI.
- Under P1 (record count) these fail and the errors are swallowed. Under P3
  (`journal/mod.rs:3184-3196`), any record that fits the remaining archive bytes is admitted.
  The refused record was a frame, and every v1 record carries the full state twice, so a
  record a few hundred bytes smaller can fit. How often: `ABSENT — do not invent`. By
  arithmetic, the chance is about (size difference ÷ record size) per end.
- Sequence:
  1. A P3 end happens while a human input is pending, or while headless or guest-command
     authority is held.
  2. The person closes the app, and the daemon retires.
  3. One record is appended after the marker.
  4. On restart the marker mismatches, is moved aside, and `journal_end` stays `None`.
  5. A reconnecting UI gets no notice. Replayed state still lists the capsules that were
     stopped as active, because stops are not journaled.
- Proven (P1 headroom proxy: limit raised by one after the end, to stand in for P3 slack):
  `audit2_post_end_daemon_retire_appends_and_stales_marker`. `core_seq` goes from 3 to 4 after
  retire; on reopen `journal_end_some=false` and `ignored_exists=true`; the UI receives
  nothing [MEASURED].
- Impact: this contradicts "permanently closes admission" in the docs. An ended session reopens
  as live until the next refusal. Before B2 this was an open failure; now it is silent.
- Fix (F2): when `journal_end.is_some()`, retire must not journal. Answer the UI waiters
  locally with the `JOURNAL_FULL` refusal instead.

### N3: false `JOURNAL_STOP_FAILED` (Low)

- `journal_end.rs:217-243` treats any `error` whose `surface_id` equals the active target as a
  stop failure. That includes a late reply to an unrelated earlier request.
- Proven: `audit2_unrelated_error_for_active_target_reports_false_stop_failure`. The UI gets
  `JOURNAL_STOP_FAILED`. The later `destroyed` event releases the barrier and the next destroy
  goes out, but nothing withdraws the failure dialog [MEASURED].
- Fix: correlate the destroy reply by request identity, if the envelope carries one. If it does
  not, release on `destroyed` and treat other errors as failures only after a timeout.

### N4: temp marker collisions and leftovers (Low)

- `journal_end.rs:82-87` names the temp file `.journal-ended-<pid>-<serial>.tmp`, with a
  per-process serial that starts at 0. PIDs repeat across container restarts.
- Proven: `audit2_leftover_temp_and_ignored_marker_do_not_block_open`.
  - Leftover temp files and `journal-ended.ignored.json` do not block open, but nothing removes
    them.
  - A colliding temp makes persistence fail with `File exists (os error 17)`, and no marker is
    written [MEASURED].
  - The end still holds in memory, so this degrades to "re-derive at the next refusal".
- Fix: use a random name or `O_TMPFILE`, and sweep `.journal-ended-*.tmp` in `load_journal_end`.

### N5: flush failure still resets the peer (Low, read only)

- `self.authority.flush_sync()?` (`journal_end.rs:131`) runs before admission closes. An I/O
  error at that point returns `Err` from `route_at` (`serve/mod.rs:1291-1300`), which is the
  transport reset class.
- This may be intended, because accepted records are not durable. If so, document it.

### N6: doc truth (Low, read only)

- "A full journal permanently closes admission" and "subsequent cleanup are not journaled":
  false under N2.
- "These exact wire pairs are distinct from genuine policy failures": true, but the pair is
  not distinct from "destroy in progress" (N1).
- "Stop the remaining capsules before reopening" (`USER_GUIDE.md`, main dialog): there is no
  in-app way. The UI refuses everything except `list` (`hostBindings.js:319`, `:1006`), and the
  core answers every non-daemon message with the notice (`journal_end.rs:189-191`). Whether
  quitting the app stops capsules: `ABSENT — do not invent`.
- Checked true:
  - The schema's error variant requires `surface_id`, `code` and `detail`, each with
    `minLength: 1` (parsed from `contracts/v0.2/surface_event.schema.json`, `oneOf[4]`). So the
    valid example holds and "omitting `detail` is invalid" holds.
  - The fresh `pkg-` session id holds (B5).

## 4. Attacks on the fixes

### Crash or failure at each step (`end_full_journal`, `journal_end.rs:130-158`)

| Step | Point | Result on restart | Evidence |
|---|---|---|---|
| 1 | Before or during `flush_sync` | No marker. The end is re-derived at the first refused append. A flush error resets the peer (N5). | Read only |
| 2 | After `journal_end` is set, before persist | In memory only. Restart re-derives. | Read only |
| 3 | After temp `create_new`, before `rename` | Temp left behind; open succeeds; re-derive (N4) | Run |
| 4 | After `rename`, before directory fsync | The marker may or may not survive. Either way is safe. | Read only |
| 5 | During notices or stops | A valid marker resumes all non-destroyed ids; terminal refusals advance | Run (shipped) |
| 6 | A post-end retire append under P3 | Stale marker, ignored; the session reopens as not ended (N2) | Run (P1 proxy) |

### Restart

- **All capsules stopped:** each one is probed, the terminal refusal advances, no false dialog
  appears, and the snapshot is unchanged (shipped test, run).
- **Partly stopped:** stopped ids advance on the refusal and live ids are destroyed in order
  (read only, same code path).
- **Fresh adapter:** every id is "unknown", so all count as stopped without any stop being
  issued. That is correct only if an adapter restart implies the capsules are gone:
  `ABSENT — do not invent`.

### Frame racing the end

- Core: unchanged and still sound. `route_at_inner` sends everything after the end to
  `route_ended_session` (`serve/mod.rs:1322-1324`), which neither journals nor publishes.
- UI: the shipped test sends a generation-2 frame after the end. It asserts that no entry is
  added and that the last entry is `stateOnly` (`ui/test/hostBindings.test.js:2102-2117`).
  Not run.

### A person's way out

- What the app shows: a warning dialog (`main.js:3138-3143`) and the capsules as `lost`.
- How to start fresh: close and reopen, which gives a fresh session id (read only).
- Data loss: accepted records are flushed and the refused frame is not journaled (shipped tests,
  run).
- False "live": none in the normal path. It does occur in the N2 restart path.
- After `JOURNAL_STOP_FAILED` there is no in-app stop (N6).

### Other UI windows and agent peers

- Every non-daemon peer gets the notice, and none is disconnected (shipped test asserts the
  agent copy).
- `agents/` has no consumer for `JOURNAL_FULL` or `surface_id:"session"` (grep, read only). An
  agent client sees an error for a surface named `session`, and its pending requests are
  answered only by notices. How the client behaves then: `ABSENT — do not invent`.
- Renderer windows other than the main bindings' subscribers were not traced:
  `ABSENT — do not invent`.

### The archive byte path

`route_at` maps `JournalError::Policy` to the end (`serve/mod.rs:1291-1300`). The Connect path
does the same when no end is recorded (`serve/mod.rs:2645-2656`). The P3 refusal comes from
`journal/mod.rs:3194-3196`. The run test confirms the end, replay and restart at the real
limit. Cleanup records are not gated (N2).

## 5. `LAWS.md` and the reserved id

- L3.1 requires a schema for a new **message type**. These are new values of `code` on the
  existing `surface_event/v0.2` error variant, which already has examples (L3.3). A strict
  reading therefore asks for nothing more.
- The reserved `surface_id:"session"` changes how consumers must read that variant, and it is
  defined only in `docs/`. Neither the reserved id nor the two codes appear in `contracts/`, and
  no example of them is checked by CI.
- Recommended, not blocking: add `contracts/examples/v0.2/` valid and invalid examples for
  `JOURNAL_FULL`, and a `description` on the variant's `surface_id` naming the reserved value.
- `metaviewer.journal-ended/v1` stays internal, with no schema. That is acceptable, because
  it is a hint with no authority.

## 6. Run evidence

- Command: `cargo test --locked --no-fail-fast -p metaviewer-core --lib -- audit2_ journal_ --nocapture --test-threads=1`.
- Result: 23 passed, 0 failed, in 93.26 s [MEASURED]. That covers the 4 throwaway tests plus
  every shipped test whose name contains `journal_`. The first build took 1 m 12.7 s
  [MEASURED].
- The one interim failure was a harness bug in my own test: it dropped a receiver. It was fixed
  before the counted run.

| Throwaway test | Observed [MEASURED] |
|---|---|
| `audit2_destroy_in_progress_refusal_advances_and_masks_real_failure` | The next destroy is for `surface-second`; after X's real failure, the UI messages are `[]` |
| `audit2_post_end_daemon_retire_appends_and_stales_marker` | `ended_seq=3 after_retire_seq=4`; on reopen `journal_end_some=false ignored_exists=true`; the UI gets no notice |
| `audit2_unrelated_error_for_active_target_reports_false_stop_failure` | The UI gets `JOURNAL_STOP_FAILED`; it is not withdrawn after `destroyed` |
| `audit2_leftover_temp_and_ignored_marker_do_not_block_open` | Open succeeds with the leftovers present; a colliding temp gives `File exists (os error 17)` and no marker |

Not run:

- **UI tests.** The container has Node v22.23.4 [MEASURED], and Node 24 is required.
  `oguirado/capsule-ui-kit` at `aaada9de` was not cloned.
- **The Go adapter.** Read only.
- **The e2e live slice.**
- **A real P3 end with headroom for a cleanup record.** N2 was proven only with the P1 proxy.

## 7. Minor

- The release note is still `changes/unreleased/v028-journal-full.md`, while `VERSION` is
  `0.2.5` and the target release is 0.2.6. This is carried over from the first review.
- The UI marks only `active` surfaces as `lost` (`hostBindings.js:513`). A surface still
  creating when the end arrives keeps its earlier state.

---
Model: not named in this file, because `LAWS.md` L1.2 forbids naming an AI model in
repository files; the session reply gives it. Effort: about 35 minutes, one reviewer.

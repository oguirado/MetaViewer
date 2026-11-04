# Bounded state audit: ceilings that are never released

Scope: `core/src` and `daemon-adapter/internal` (plus `daemon-adapter/guest-command-broker/src`, read
only, to size output). Base: `ci/assets-a7c36e9da` at `a7c36e9`. This is a report only. No product code
changed. The findings are candidates for the conductor to verify.

Method: grep for ceilings (`len(..) >=`, `.len() <`, `CAPACITY`, `LIMIT`, `QUOTA`, `MAX_*`). For
each ceiling, check whether entries are ever removed (`delete`, `remove`, `retain`, `clear`). When a
ceiling is never released, drive it through its real entry point with a throwaway test. The tests are
not in this commit. Each one was run, removed, and the tree was restored to clean.

Number tags: [MEASURED] means a throwaway test run in this session printed it. [CITED] means it is a
constant or line in the source. [TARGET] means a reach estimate that I computed from cited constants
and an assumed workload rate. A [TARGET] number is not measured.

## Summary

| # | Location | Ceiling | Severity | Confidence | Evidence |
|---|----------|---------|----------|------------|----------|
| 1 | `core/src/serve/mod.rs:261`, `core/src/replay/mod.rs:82` | 100000 inbound envelopes per core process, never pruned | High | Medium-high | Proven by running (unit test) and read |
| 2 | `daemon-adapter/internal/capsule/manager.go:1498`, `:1591` | 100000 input proposals per daemon, never pruned | High | High | Proven by running |
| 3 | `core/src/guest_command.rs:194`, `:170` | 64 guest runs per guest session; one guest create per core process | Medium | High | Proven by running |
| 4 | `daemon-adapter/internal/guestcommand/manager.go:135` | 256 pending, never removed; Stop refused `CAPACITY` | Medium (latent end to end) | High in isolation | Proven by running; masked by #3 |
| 5 | `guestcommand/manager.go:238`, `core/src/guest_command.rs:388` | 8192 guest events per guest session, never released; the adapter poisons | Medium | Medium | Adapter proven by running; core read only |
| 6 | `guestcommand/rewind_manager.go:103` (prior finding), `core/src/rewind_flow.rs:147`, `:316` | Mismatch: the adapter combined 256 against the core per-family 256 and 64 | High (Stop refused) | Medium | Read only (reach); the defect itself is from the prior sweep |
| 7 | `core/src/record/capture.rs:308` | 64 capture rows, never removed | Low-Medium | Low | Read only; my drive hit a different budget first |
| 8 | `core/src/journal/mod.rs:652`, `:3125` | 100000 journal records | Unknown | Low | Read only; not driven |

## 1. Core replay table: 100000 envelopes per process, then a terminal refusal for every peer

- Where: `core/src/serve/mod.rs:261` (`ReplayTable::new(100_000)`). `core/src/replay/mod.rs:82`
  refuses with `CapacityExceeded`. `replay/mod.rs` has no `remove`, `retain` or `clear` on `entries`.
  Every authenticated inbound envelope is recorded: `serve/mod.rs:1303` (the routing path) and
  `serve/mod.rs:1086` (frames that are superseded and never routed are still recorded).
  Exhaustion goes to `serve/mod.rs:629-640` and sends a terminal `REPLAY_EXHAUSTED` with the text
  "start a fresh session".
- Sequence: daemon, UI and agent send envelopes. Each one adds a `(session, sender, nonce)` entry.
  At entry 100001 the sender gets the terminal error and is disconnected. A reconnect is refused too
  (`serve/mod.rs:2650-2668`).
- Proof (run): a throwaway lib test used the same constructor value. It accepted 100000 [MEASURED]
  daemon envelopes and then returned `CapacityExceeded`. After that, an unrelated UI sender got
  `CapacityExceeded`, and so did a *different session id* [MEASURED]. The table is per process, not
  per session, so "start a fresh session" means restarting core. The existing test
  `serve::v027_tests::v027_cr01_replay_exhaustion_reports_terminal_and_reconnect_refusal` passes and
  covers the terminal and reconnect behaviour with capacity 1.
- Reach: each animated capsule sends one daemon `frame_ready` envelope per published frame
  (`daemon-adapter/internal/frames/subscriptions.go:683`, `daemon/environment.go:879`). The legacy
  poll interval is 100 ms [CITED `frames/ringmode.go:14`], and ring mode defaults to 60 fps
  [CITED `daemon/environment.go` near `:1469`]. For a wall of 6 animated capsules:
  - at 10 fps each (the legacy ceiling): 100000 / 60 per s ≈ 28 min [TARGET]
  - at 1 fps each: ≈ 4.6 h [TARGET]
  - in ring mode at 60 fps: ≈ 4.6 min [TARGET]

  These estimates assume one inbound envelope per frame. I did not measure the real frame rate here
  because there is no display stack.
- Impact: the whole wall loses core. Every peer gets a terminal error, and it does not recover until
  the core process restarts.
- Note: the module doc marks replay exhaustion as a `[TARGET, unit decision]`
  (`serve/mod.rs:19-21`). The decision may be intended for an adversarial sender. The concern is
  that ordinary frame traffic reaches it within hours.

## 2. Adapter input proposals: 100000 per daemon, then all input is refused

- Where: `daemon-adapter/internal/capsule/manager.go:1498` (`len(m.used) >= 100000`) and `:1591`
  (`m.used[q.ProposalID] = true`). The map is declared at `:242`. No `delete(m.used, ...)` exists
  anywhere in the package.
- Sequence: each `input` request (human or agent, on any surface) adds its proposal id for good.
  `pending` is released on completion (`:1596`), but `used` is not. Destroying the capsules or
  creating new ones does not reset it.
- Proof (run): a throwaway test drove `Manager.Handle` in human control with 100005 distinct
  `key` inputs. It got 100000 [MEASURED] accepted, then `POLICY: fresh frame and unused input
  permit required`, with `pending=0` and `used=100000` [MEASURED]. It took 4.97 s [MEASURED].
- Reach: human typing at about 5 inputs/s takes ≈ 5.6 h [TARGET]. Six agents at 1 action per 2 s
  each (3/s) take ≈ 9.3 h [TARGET]. Scrolling, if each wheel event is one proposal, can be faster.
  I did not check whether the UI coalesces wheel events.
- Impact: once the ceiling is hit, every capsule refuses all input, including human take-over
  typing, with a misleading `POLICY` code until the daemon restarts. Core and adapter also
  disagree: the core proposal witnesses evict (`core/src/serve/tools.rs:301`) and core
  `human_inputs` releases on receipt (`serve/mod.rs:359`), so core keeps admitting input that the
  adapter refuses.

## 3. Core guest command: 64 runs per guest, and the guest cannot be recreated

- Where: `core/src/guest_command.rs:194` (`self.jobs.len() < 64`; the refusal code is
  `DUPLICATE`). `jobs` is never removed. `:170` sets `started = true` and nothing resets it, so
  `:169` refuses a second `create` with `CAPACITY`.
- Proof (run): a throwaway lib test drove `State::submit` and `State::observe` through 64 complete
  run → accepted → job_finished cycles, each with a unique `job_id`. Run 65 was refused
  `DUPLICATE` with `jobs=64 requests=65 pending=0` [MEASURED]. Stop was still accepted. After
  that, a second `create` was refused `CAPACITY` [MEASURED].
- Reach: 64 commands. An agent running one command every 30 s reaches it in ≈ 32 min [TARGET].
- Impact: guest command execution is dead for the rest of the core process. The refusal code
  (`DUPLICATE`) is misleading. Stop still works, so this is not a recovery block.

## 4. Adapter guest Manager: Stop refused after 255 completed operations

- Where: `daemon-adapter/internal/guestcommand/manager.go:135` (`len(m.pending) >= 256` returns
  `CAPACITY`). Entries are inserted at `:154`, `:179` and `:438`, and nothing deletes them. This is
  the same family as the prior `rewind_manager.go:103` finding, but in the base `Manager`.
- Proof (run): a throwaway test ran create plus 255 runs, each with accepted and job_finished
  through `Handle` and `consumeLocked`. That left `pending=256 active=0` [MEASURED]. Stop was then
  refused with `CAPACITY` [MEASURED].
- Reach end to end: core caps runs at 64 (#3) and allows at most one cancel per running job. The
  adapter therefore sees about 1 + 64 + 64 + 1 ≈ 130 [TARGET] guest requests, below 256. So this
  is latent today. It becomes live if core's 64-job cap is lifted, or if the adapter is driven
  directly. The poisoned path (`:126`) is checked before the capacity check, so a poisoned
  Manager can still reconcile Stop. The healthy path cannot.
- Severity: Medium. It is a recovery action refused by a ceiling, but core masks it today.

## 5. Guest event ceiling: 8192 events per guest session on both sides, never released

- Where: adapter `guestcommand/manager.go:238` (`len(m.seen) >= 8192`). In the receive loop the
  error poisons the Manager and runs `failLocked` (`manager.go:205-210`), which marks every pending
  operation `outcome_unknown`. Core has the same limit at `core/src/guest_command.rs:388`
  (`events.len() < 8192`, refused as `DUPLICATE`). Rewind uses the same pattern at
  `rewind_manager.go:340`.
- Proof (run, adapter): a throwaway test fed `output` events to one running job. 8192 [MEASURED]
  were accepted, then `guest event replay/capacity`. The job's own `job_finished` was refused
  after that [MEASURED]. I read the poisoning in `receive`; I did not drive it.
- Reach: every output chunk is one event. The broker sends a chunk per read of up to 16384 bytes,
  with at most 65536 bytes per job [CITED `guest-command-broker/src/dispatch.rs:107`, `:172`,
  `output.rs:13`]. One line-buffered job that prints 8192 short lines exhausts the session. So do
  64 jobs averaging 128 chunks each [TARGET].
- Impact: the guest session goes uncertain, and every operation projects `outcome_unknown`. In the
  base Manager, Stop still reconciles (read only). The limits match across core and adapter, so
  they do not disagree with each other here.

## 6. Rewind: the adapter's combined 256 against core's per-family limits (reach for the prior finding)

- Prior finding: `guestcommand/rewind_manager.go:103` checks capacity before the poisoned branch,
  so Stop is refused even when the Manager is poisoned. I did not re-prove the defect. My attempt
  through the rewind fixture got `BUSY` for runs in phase `paused`, so I could not complete the
  drive in time.
- Mismatch (read only): the adapter's `r.pending` holds guest *and* rewind requests under one
  256 ceiling. Core allows 256 rewind requests (`core/src/rewind_flow.rs:147`, never removed,
  refused as `DUPLICATE`) and, separately, about 130 guest requests (#3 and #4). Core can admit
  more than 256 in total, so the adapter fills first: create plus 255 pause, resume or mark
  operations. Core then admits Stop and the adapter refuses it `CAPACITY`.
- Other rewind ceilings that are never released: core `rewind_flow.rs:316` (events `< 1024`) and
  adapter `rewind_manager.go:340` (seen `>= 8192`). Core reaches 1024 events after about 341–512
  [TARGET] rewind operations, if each operation emits 2–3 events. That is masked by the 256
  request cap.
- Reach: 255 rewind operations. An agent doing a mark or restore cycle every 30 s reaches it in
  ≈ 2 h [TARGET].

## 7. Core capture rows: 64 per process (read only)

- Where: `core/src/record/capture.rs:308` (`self.rows.len() >= 64` returns `LIMIT` for
  `screenshot` and `recordStart`). Rows are inserted at `:404`. I found no `remove`, `retain` or
  `clear` on `rows` in `record/capture.rs`.
- Attempted run: `Host::prepare("screenshot")` stopped at screenshot 9 with `BUDGET_EXCEEDED`
  [MEASURED], because unreleased reservations hit their budget first. I did not drive the release
  path (`record/guard_tests.rs:94` shows that one exists), so I did not reach the 64-row ceiling.
- Reach if released rows stay: 64 screenshots or recordings per core process [CITED]. The fix
  decision is the conductor's.

## 8. Journal record ceiling (read only, not driven)

- `core/src/journal/mod.rs:652` (`MAX_RECORDS = 100_000`) and `:3125` (`count >= MAX_RECORDS`
  returns `Policy`). I did not check whether the journal rotates, or how many records one frame or
  one input commits. If every routed envelope commits a record, this has the same reach as #1.
  `ABSENT — do not invent` for rotation evidence.

## Checked and released (not findings)

- `frames/subscriptions.go:428` `MaxSubscriptions`: entries are deleted at `:476` and `:833`.
- `frames/publisher.go:457`, `:539` `MaxSurfaces`: entries are deleted at `:919` and `:947`.
- `capsule/manager.go:883`: quarantined profiles count against `MaxSurfaces` 16 [CITED
  `daemon/environment.go:202`]. The release sites are `manager.go:871`, `:1016`, `:1070`, `:1169`,
  `:1226`, `host_window.go:152`, `host_xpra.go:310` and `ringmode.go:64`. Keeping lost bindings is
  documented as intended at `manager.go:857`. I did not drive it.
- Core `serve/tools.rs` receipt, proposal-witness, frame-witness and destroyed rings evict at their
  caps. Core `supervisor/process.rs:151` `reaped` evicts. Core `human_inputs` (`serve/mod.rs:2256`)
  is released on receipt.

## Not covered

- `daemon-adapter/internal/capsule/slots/store.go` (`SLOT_QUOTA`, `SLOT_GENERATION_EXHAUSTED`),
  `headless`, `ipc`, `view`, `record`, `resourceinventory`, `cli`.
- Core `rewind.rs` (`:439` requests `< 256`, `:551` events `< 1024`; same pattern, not traced),
  `admission/mod.rs` `remaining_budget` (decremented at `:470`, `:569`, `:636`, `:693`; stop and
  cleanup are exempt; I did not check whether it is restored), the journal witness caches,
  `wire` `MAX_SEND_QUEUE`, `serve/timings.rs`, `headless.rs`, `catalog`, `transport`, `verify`.
- UI and Node: `oguirado/capsule-ui-kit` not cloned.
- End-to-end runs: there is no display stack, docker daemon or KVM here. Every reach time is a
  [TARGET] estimate.

## Provenance

Model: not written into the repository, per this environment's policy against pushing model
identifiers; the model is named in the session reply. Effort: low reasoning effort, a time-boxed
pass of about 45 minutes [TARGET].

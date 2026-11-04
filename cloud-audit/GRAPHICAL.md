# Graphical QEMU rewind review

Review of `origin/cloud/review-graphical` (e66187a9, "core: add graphical QEMU session
authority") against `origin/cloud/base-e1`, merge-base cc598309. The diff adds
graphical QEMU rewind: the new `contracts/v0.2/graphical_session*` contracts, Core and
adapter plumbing, and the Electron host API `window.metaviewer.graphicalSession`.
This is a report only. No product code is changed by this commit.

## Verdict

**Do not merge for this release.**

The feature fails closed in most places. Its Core, adapter and host state machines
check owner, runtime, generation and epoch, and handle replay correctly. Four findings
still block it:

- It ships a red UI gate (finding 1).
- It adds a per-message decode cost to every non-graphical body (finding 2).
- A late Core reply can tear down the UI binding for every capsule (finding 3).
- Its capacity ceilings never drain (finding 4).

It also changes startup behaviour on x64 (finding 5). The fixes below are bounded, but
too many to finish and prove before scope closes. No end-to-end proof inside the app
exists yet: ABSENT — do not invent.

## Scope and method

- Unit: `cloud-audit/GRAPHICAL.md` (new). Closure: none. The report is passive data and
  no product path is touched.
- Negative control: `git diff --name-only HEAD~1..HEAD` on this branch must list only
  this file.
- Router status: unavailable. Coordinates come from the commit diff and were checked
  against the files at e66187a9.
- Not reviewed: native private code is not in this repository and was not sought.
  Evidence that native RAM, overlay or point files are cleaned up: ABSENT — do not invent.
- Labels:
  - "Proven" means a throwaway test or benchmark was actually run. All of these were
    kept out of the commit, and the working tree was confirmed clean afterwards.
  - "Read" means read only.
  - A UI-only pass ran Node 24.22.2 (official tarball, checked against its SHA256) with
    `capsule-ui-kit` cloned anonymously at the pin in `ui/kit.lock.json`. Its content hash
    matched.

## Findings (most severe first)

| # | Severity | Confidence | Evidence | Summary |
|---|----------|------------|----------|---------|
| 1 | High | High | Proven | 22 existing UI tests now fail deterministically |
| 2 | High | High | Proven | New per-message Core decode cost on every non-graphical body |
| 3 | High | Medium-high | Throw proven, trigger read | Host timeout then Core's own timeout event: whole UI binding shut down |
| 4 | Medium-high | High | Proven | Request/history ceilings (128/256) never drain: Core, adapter and host |
| 5 | Medium | High | Proven (UI), read (Go) | x64 and disabled installs are touched: startup refusal on stray env |
| 6 | Medium | High | Proven | Outcome-unknown or pending fences the whole wall, not only Mark/Back |
| 7 | Medium | Medium | Partly proven | VM dies mid-operation: custody stuck, UI not told, Stop may be refused |
| 8 | Medium-low | High | Proven | Adapter's single slot is claimed by a request that was refused |
| 9 | Low | High | Proven | Failed Stop leaves `stopping` set on a still-active surface |
| 10 | Low | High | Proven state, read push | Adapter-epoch handoff silently flips an idle session to unknown |
| 11 | Info | High | Read | Graphical requests draw down the shared action budget |

### 1. Red UI gate: 22 existing tests fail

**Files.**
- `ui/electron/profilePicker.js:4` now imports `./coreLauncher.js`. This breaks the
  module's own purity contract (`profilePicker.js:6-10`) and
  `ui/test/multicap-profile-picker.test.js:241` ("module is pure: no imports").
- The 17 mutant tests at `:328` of that file then fail with `ERR_MODULE_NOT_FOUND`, which
  disables mutation coverage of capsule admission.
- `ui/electron/coreLauncher.js:102` adds a sixth entry to the frozen `ALLOWED_CORE_ENV`
  list that `ui/test/rewind-core-optin.test.js:21` (and :31, :48) pins to five entries.
- Two new IPC handlers change the handler count pinned by
  `rv9-elec-regressions` (:692) and `wire-authority` (:936): 24 instead of 22.

**Measurements.**
- New `graphical-session-*.test.js`: 17 of 17 pass [MEASURED].
- Full UI suite:
  - HEAD: 4453 tests, 4423 pass, 27 fail, 1 cancelled, 2 skipped [MEASURED].
  - Merge-base: 4436 tests, 4429 pass, 4 fail, 1 cancelled, 2 skipped [MEASURED].
- The five affected files run on their own: HEAD fails 22 of 111, merge-base fails 0 of
  111 [MEASURED].
- Five other files fail identically at both commits and are not counted here.

**Impact.** LAWS.md L4.2 says nothing is pushed with a red gate. The commit neither fixes
these tests nor updates them on purpose.

**Fix.** Inject the pin predicate into `profilePicker.js` instead of importing it. Pass
the graphical flag through its own allowlist rather than widening `ALLOWED_CORE_ENV`.
Any handler-count change must be a deliberate, reviewed contract update in the same
commit. No test may be weakened.

### 2. New per-message decode cost on the human input path

**Files.**
- `core/src/wire/payload.rs:2239-2240` inserts `GraphicalSessionRequest` and
  `GraphicalSessionEvent` as the 2nd and 3rd variants of the `#[serde(untagged)]`
  `Command` enum.
- `core/src/wire/graphical_session.rs:12-16`: each attempt runs `serde_json::from_str`
  on the embedded schema, then `valid(...)`. This bypasses the per-process schema cache
  that base commit 5cf4d2fd ("parse embedded contract schemas once per process") added to
  restore human-input latency.
- `graphical_session_event.schema.json` is 1127 lines [MEASURED: diffstat].

**Sequence.** For every `action_proposal`, `ui_intent`, `surface_request` and so on,
serde tries both graphical variants first. Each try parses a schema and validates it,
then fails.

**Measurements (release build, 4 vCPU, best of 5).**
- The two failed attempts on an `action_proposal` body:
  - `GraphicalSessionRequest`: 19.3 µs [MEASURED].
  - `GraphicalSessionEvent`: 131.6 µs, of which 92.8 µs is the schema parse alone
    [MEASURED].
- `decode_envelope` on `contracts/examples/v0.2/envelope.valid.json`, three runs each,
  interleaved:
  - HEAD: 1213, 1209, 1281 µs per message [MEASURED].
  - Base: 1015, 739, 960 µs per message [MEASURED].
  - The runs are noisy because a parallel build was running, but HEAD is slower in every
    run.

**Impact.** This is the same regression class that made input latency regress before.
Every non-graphical message pays it, including on x64, where the feature is off.

**Fix.** Before any schema work, check `value["schema"]` against the variant's constant
schema name and fail immediately on a mismatch. Use the cached `schemas::schema(..)` for
the parse. Gate: the same benchmark shows HEAD within noise of base.

### 3. Host timeout race tears down the whole UI binding

**Files.**
- `ui/electron/graphicalSessionHost.js:37`: the per-request timer, `timeoutMs = 30000`
  (`:8`).
- `:20`: `unknown()` records `closed:false`.
- `:46`: an event with no pending entry and no `closed` history throws
  `GRAPHICAL_CORRELATION`.
- `ui/electron/hostBindings.js:506`: `receive` is called inside the Core stream loop,
  whose `catch` (`:697`) runs `shutdown(acquireFail('HELLO_PROTOCOL'))`.
- Core's deadline is also 30 s from receipt (`core/src/graphical_session.rs:12`). At that
  deadline Core pushes its saved `outcome_unknown` event
  (`core/src/serve/graphical_session.rs:77-97`).

**Sequence.**
1. Mark or restore is sent at t0. The host timer fires at t0 + 30 s and deletes the
   pending entry.
2. Core's timer fires at t0 + δ + 30 s and sends `outcome_unknown`. A late `completed`
   forwarded by Core does the same.
3. The host throws, and the binding is shut down for every capsule.

The same applies to an already-seen `event_id` resent by
`mark_graphical_session_unknown_at` on a daemon reconnect (`:44`, `seen.has`).

**Evidence.** The UI pass ran the throw. The Core trigger and the shutdown link are read
only. The host timer always starts before Core's, so any native operation that runs past
30 s reaches this path.

**Fix.** An event for a request the host has recorded as unknown settles it or is
ignored; it never throws. Order the timeouts host > Core > adapter. Gate: a test where
the host timer fires, then Core's `outcome_unknown` and a late `completed` arrive, and no
shutdown happens.

### 4. Capacity ceilings that never drain

**Core.**
- `core/src/graphical_session.rs:10` sets `MAX_HISTORY = 128`. `:89` refuses `CAPACITY`
  once it is reached, and `:140` inserts on every accepted request.
- `destroyed()` (`:278-284`) never prunes `history` or `events`.
- The state is journaled (`core/src/admission/mod.rs:287-288`).
- Proven:
  - After 128 accepted attaches, each refused natively, the 129th request is refused.
  - It is still refused after the VM is destroyed and a brand-new VM surface is
    registered.
  - It is still refused after a serde round trip of `CoreState`: history = 128,
    `BudgetExceeded`.

**Adapter.**
- `daemon-adapter/internal/capsule/graphical_session.go:275` refuses at 128.
- `:314` records every admitted `request_id`. The map is cleared only when the surface is
  destroyed (`manager.go:1233`).
- Proven: after one attach, the first `CAPACITY` comes at mark index 127.

**Host.**
- `graphicalSessionHost.js:18` and `:25`: history holds 128 entries for the app's
  lifetime.
- `:28` and `:44`: `seen` holds 256. Past that, any graphical event throws
  `GRAPHICAL_PROTOCOL`, which leads to the binding shutdown in finding 3 (read).
- Proven by the UI pass: after 128 requests every new one returns `BUSY` even on another
  surface, while `status()` still reports `busy:false`.

**Impact.** This is the drain-free pattern `rewind_manager.go` had. A normal user reaches
128 Mark/Back operations, and recovery needs an app restart. Core needs more than that,
because the journal keeps the history.

**Fix.** Keep the numeric limits and make them drain:
- Core: prune a session's history and events when it is released or destroyed.
- Adapter: reset `requests` on attach and destroy, or key them to the current epoch.
- Host: clear history and `seen` on `surfaceClosed` and on disconnect.

### 5. x64 and disabled installs are not untouched

- `ui/electron/coreLauncher.js:192-203` is called on every launch. If any graphical
  variable is set, it now throws `GRAPHICAL_SESSION_ENV`. This includes
  `MV_GRAPHICAL_SESSION_ENABLED=1`, `''` or `false` on x64, and `=0` with leftover pins
  on arm64. The merge-base ignored these variables. Proven by the UI pass.
- `daemon-adapter/internal/capsule/process.go:328`: the adapter refuses to start on any
  architecture when `MV_GRAPHICAL_SESSION_ENABLED=0`. `:57` refuses a partial pin set
  (read).
- `ui/electron/preload.js:1653` and `authorityWire.js:907-908` expose
  `window.metaviewer.graphicalSession` and its two IPC handlers on x64 too. They fail
  closed: status returns `UNAVAILABLE` and request returns `BAD_REQUEST` (proven by the
  UI pass).
- The host object itself is only created when the flag is `1` and the machine is arm64
  (`hostBindings.js:313`). The x64 adapter and Core state machines stay inert, because
  the ISA is hard-coded to `aarch64`.

**Fix.** Ignore graphical variables unless arm64 and the flag equals `1`, as the base
did. Do not fail startup on a disabled or stray value.

### 6. An unknown or pending outcome fences far more than Mark/Back

- Core:
  - While any graphical request is pending or unknown, `create` is refused wall-wide
    (`admission/mod.rs:837`), `Created` lifecycle updates are refused (`:982`), and any
    new surface registration fails `InvalidInput` (`:1069`).
  - Pending is cleared only by `destroyed()` or by a terminal daemon event.
  - Proven: after an attach whose outcome is unknown, registering an unrelated surface
    returns `Err(InvalidInput)`.
- Adapter: `graphicalBlocks` includes `unknown` (`graphical_session.go:130-133`), so human
  input (`manager.go:1498`) and normal capture (`manager.go:1312`) return
  `BUSY: graphical rewind owns the surface`. Proven: after `outcome_unknown`, `Capture`
  is refused and the tile freezes until Stop.
- `docs/GRAPHICAL_VM_REWIND.md` says only Mark and Back are fenced.

**Fix.** Narrow the fence, or document the real one. A wall-wide create fence held by one
VM needs an explicit release path.

### 7. The VM dies during an operation

- Core:
  - `LifecycleUpdate::Lost` calls `uncertain()` and discards the returned event
    (`admission/mod.rs:1017-1018`). The poll skips requests that are already uncertain
    (`serve/graphical_session.rs:78-79`), so the UI is never told (read).
  - Pending stays set. Proven: after Lost, `pending` is still set, the surface is still
    fenced, and an unrelated surface still cannot be registered.
  - Stop of a non-live surface is admitted only from the UI and only when
    `!agent_controlled` (`serve/mod.rs:1450-1458`, pre-existing). A graphical VM is
    agent-owned (`graphical_session.rs:93`).
  - Plausible, read only: a lost VM that is agent-controlled keeps the wall-wide create
    fence of finding 6 forever.
- Adapter: if the binding leaves `active` during the native call, `HandleGraphicalSession`
  returns `nil, nil` (`graphical_session.go:389-394`). No event is emitted and `busy`
  stays true. Proven: output empty, error nil, `busy=true`, `unknown=false`, slot held.

**Fix.**
- Push `outcome_unknown` to the UI on Lost.
- Make Stop of a lost, graphical-held surface admissible.
- In the adapter, clear `busy` and set `unknown` on the not-live return.

### 8. The adapter's single slot is claimed by a refused request

- `graphical_session.go:265-268` installs `m.graphical` before the admission checks.
- With Core in the loop, the trigger is an attach that the native side refuses on VM A.
  Core clears its own session, but the adapter keeps the slot.
- Proven: after a refused request on VM A, the slot holds `session == nil`, and attach on
  VM B returns `refused BUSY` until A is destroyed.

**Fix.** Claim the slot only after native success, or release it on any refused attach.

### 9. A failed Stop leaves `stopping` set

`manager.go:1193` sets `stopping` before `BeforeDestroy` (`:1197`) and stop can still
fail. Proven: when the drain fails, the destroy returns an error, the surface state stays
`active` with `stopping=true`, and Capture and Mark are refused `BUSY` until Stop is
retried.

**Fix.** Set `stopping` only once destroy is committed, or reset it on failure.

### 10. Adapter-epoch handoff flips an idle session to unknown

`admission/mod.rs:1056` calls `uncertain()` without a pending request. That flips a
ready, held session to `outcome_unknown` with no UI push (the serve-level helper returns
early, `serve/graphical_session.rs:85`).

- Proven: phase `outcome_unknown`, pending none, next mark refused `LockedByOther`.
- The fence is defensible, because adapter points live only in memory. The silent part is
  the defect.

### 11. Budget

Each accepted graphical request decrements the shared `remaining_budget`
(`admission/mod.rs:650-652`). Mark/Back from the UI therefore draws down the agent's
action budget. Stop of a graphical-held surface is correctly exempt (`:832-835`,
`:863-866`). Reported as information. No budget change is proposed.

## Attacks that held

- **Owner and authority.**
  - Core routes `graphical_session_request` only from `Component::Ui`
    (`serve/mod.rs:1337`).
  - It requires the registered agent as surface owner and `owner_id` equal to that
    agent's actor id (`graphical_session.rs:85-96`).
  - Mark and restore also require the attach caller (`:108`).
  - The renderer cannot supply `owner_id` or `request_id` (the action format is closed
    and the host stamps both; proven by the UI pass). Any code in the app's own main
    frame can still mark or restore by design.
- **Runtime, generation and epoch binding.**
  - Core `check_binding` (`:252-261`) and the adapter (`graphical_session.go:353-367`)
    refuse a changed `runtime_id`, a stale tuple or a skipped generation.
  - A restore completes only with a strictly newer authoritative frame and +1 generation
    and epoch (`:234-242`).
- **Replay.** A repeated `request_id` returns the saved reply without redispatch
  (`graphical_session.rs:82-84`). Events are deduplicated by `event_id` (`:180`). The
  adapter refuses repeated ids with `STALE`.
- **Two attaches.** A second attach while held returns `BUSY` (`:100-102`). An attach
  with a null session leaves `session` unset until completion and binds the creator
  (`:143`).
- **Restore racing Stop.**
  - Core admits destroy budget-free while the surface is fenced.
  - The adapter cancels the work context (`manager.go:1193`, `graphical_session.go:157-164`).
  - A late completion is refused `POLICY`. Covered by the existing tests, which pass.
- **Contracts.**
  - No existing contract file is modified; the 60 new files are all additions
    [MEASURED: `git diff --name-status`].
  - No `oneOf` is added to an existing envelope. The graphical family has its own
    two-choice envelope.
  - MicroVM rewind files are unchanged.
- **Fixture pins and counts.**
  - The existing observation pins and their count check are retained.
  - Graphical fixtures are pinned separately, with their own count
    (`daemon-adapter/internal/ipc/policy_test.go`).
  - `core/tests/decode_envelope.rs` extends its tag loops; no assertion is removed (read).
- **Crash mid-restore.** Core journals pending before dispatch and marks it unknown when
  the daemon reconnects (`serve/mod.rs` `connection_with_liveness`), so it never resumes
  silently (read). Native RAM, overlay or point cleanup: ABSENT — do not invent.

## Runs

- Core, release build, at HEAD:
  - `graphical_session`: 13 pass.
  - `decode_envelope`: 9 pass.
  - `rewind_envelope`: 1 pass.
  - `rewind_flow`: 3 pass.
  - `oneof_poly`: 19 pass.
  - All [MEASURED]. The full Core suite did not finish within the time limit: ABSENT — do
    not invent.
- Go at HEAD: `internal/capsule`, `internal/daemon` and `internal/ipc` all ok [MEASURED].
- UI: see finding 1 [MEASURED].
- `python3 tools/router_index.py --check` at e66187a9: coverage 100% of 3336 files
  [MEASURED].
- With this report staged, the same router check fails, as expected: 3337 sources against
  3336 committed nodes [MEASURED]. The commit is limited to this one file, so the router
  index is not regenerated. The laws checker also classifies `cloud-audit/` as a
  product path (`tools/check_laws.py:34-44`), so a fragment check would fail too. This
  branch is a report carrier, not a merge candidate.
- Throwaway artefacts (Core attack and benchmark tests, Go attack tests) were removed. The
  working tree was clean before this commit.

## Fixes required before merge

1. Restore the green UI suite without weakening any test (finding 1).
2. Discriminate on `schema` before any schema parse in the Core graphical (and rewind)
   message macros. Prove it with the decode benchmark (finding 2).
3. Settle late or duplicate events in the host without throwing, and order the timeouts
   host > Core > adapter (finding 3).
4. Make the Core, adapter and host ceilings drain on release, destroy and disconnect, at
   unchanged limits (finding 4).
5. Leave x64 and disabled startup unchanged (finding 5).
6. Bound or document the wall-wide fence (finding 6). Push unknown to the UI on Lost and
   make Stop of a lost graphical VM admissible (finding 7).
7. Adapter slot, busy and stopping hygiene (findings 7 to 9).
8. Prove it in the app on arm64: visible mutation, Back, a fresh bound frame, continued
   input, measured timings and verified physical closure.

## Reviewer

- Model: withheld from tracked files under LAWS.md L1.2 and session policy; stated in the
  session reply.
- Effort: one bounded review pass of about 50 minutes at high reasoning effort, with a
  parallel UI-only sub-pass. Findings 1, 3 (throw), 4 (host) and 5 (UI) rest on that
  sub-pass's runs; their causes were re-read against the code at e66187a9.

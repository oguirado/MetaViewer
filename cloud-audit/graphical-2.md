# Graphical QEMU rewind re-review (2)

Re-review of `origin/cloud/base-graphical` at `b767222c4` on base `1760a40a9`. The branch
holds three commits: `db501419b` (Core and adapter authority), `d74575c5e` (UI checkpoint
controls) and `b767222c4` (lifecycle fixes). It is checked against the first review,
`cloud-audit/GRAPHICAL.md` (findings F1 to F11). That file lives on branch
`cloud/audit-graphical` at `08ed2a4d`; it is not on `cloud/review-graphical` as the brief said.

This is a report only. No product code is changed by this commit.

## Verdict

**DO NOT MERGE for today's release.**

The fixes close F1, F2, F5 and F9, and close most of F3, F4, F6, F7 and F8. Three new defects
block the merge. Each was reproduced with a throwaway test on this box.

- **N1.** With the native as it ships today, every rewind VM tile freezes as soon as it opens.
  - The UI attaches on its own, with no user action.
  - The native `--op attach` exits 2 [CITED: author].
  - `b767222c` now maps that exit to `outcome_unknown` instead of a refusal.
  - The result: capture and input are refused on that VM until Stop.
- **N2.** While a graphical session is held, the agent can no longer Stop its own VM.
- **N3.** While any graphical request is pending or unknown, a new capsule on another profile
  can reach native, but Core then refuses its `Created` update.

The background requires click proof for this feature in v0.2.6. It is impossible today: the
native attach fails, and this box has no arm64 and no KVM. Click proof: ABSENT — do not invent.

## Scope and method

- **Unit:** `cloud-audit/graphical-2.md` (new). Closure: none. The report is passive data.
- **Negative control:** `git diff --name-only HEAD~1..HEAD` on this branch must list only this
  file.
- **Router status:** unavailable. Coordinates come from the commit diffs and were checked
  against the files at `b767222c4`.
- **Line numbers** are at `b767222c4` unless a line says otherwise.
- **Native code** is private and absent here. Anything that depends on it is marked unknown.
- **Proof kinds:**
  - "Measured": a throwaway Go, Core or Node test was run on this box, then deleted. Both
    worktrees were confirmed clean afterwards.
  - "Sub-pass": a parallel UI-only pass ran it.
  - "Read": the code was read, not run.
- **Toolchain:**
  - Node 24.22.2, from the official tarball, SHA256 checked.
  - `capsule-ui-kit` cloned anonymously at the pin `aaada9de`; `tools/sync_kit.mjs` passed.
  - go 1.24.7 and cargo 1.97.0. Core tests ran in a release build.

## Status of F1 to F11

| Id | Status | Proof | One line |
|----|--------|-------|----------|
| F1 | Fixed | Measured (sub-pass) | UI gate green apart from failures that already fail at base |
| F2 | Fixed | Measured | Schema tag checked before any parse; the failed decode attempt drops to about 1.9 µs |
| F3 | Partly fixed | Measured (sub-pass) | No binding shutdown; timeout order unchanged |
| F4 | Partly fixed | Measured | Drains on destroy only; still 128 operations per VM lifetime |
| F5 | Fixed | Measured (sub-pass), read | x64 and flag-off startup unchanged |
| F6 | Partly fixed | Measured | Create request fence narrowed; `Created` and registration fences still cover the whole wall (see N3) |
| F7 | Partly fixed | Read, plus the author's test | Lost now pushes unknown to the UI; restore's second liveness check still returns silently |
| F8 | Partly fixed | Measured | A refused attach releases the slot; a refused mark and a drain timeout still hold it |
| F9 | Fixed | The author's test passes | `stopping` is reset when `BeforeDestroy` fails |
| F10 | Still present (deferred) | Read | Unchanged; it now also fences input at Core |
| F11 | Unchanged (info) | Read | Budget decrement unchanged |

### F1. UI gate: fixed

- **Measured, sub-pass, full UI suite at `--test-concurrency=2`:**
  - Head: 4491 tests, 4484 pass, 4 fail, 1 cancelled, 2 skipped [MEASURED].
  - Base: 4436 tests, 4423 pass, 10 fail, 1 cancelled, 2 skipped [MEASURED].
  - The 4 head failures also fail at base: DISPLAY stale task, floating allocation, v027 tile
    chrome, and V028-FIT-2.
  - The RSS rail file `uiel-smoke-rss.test.js` is excluded from both runs; see N6.
- **The four F1 files plus six graphical files, run on their own:** head passes 155 of 155;
  base passes 110 of 110 [MEASURED].
- **`profilePicker.js` is pure again:** it has no imports, and the pin result is injected
  through `graphicalReady`, with a `=== true` check at `:437`.
- **`ALLOWED_CORE_ENV`** is back to 5 entries (`coreLauncher.js:102`).
- **The handler-count edits are deliberate contract updates, not weakening:**
  - `rv9-elec-regressions.test.js:801-807` and `wire-authority.test.js:988-993` pin the legacy
    inventory at exactly 22, plus the exact graphical pair, using set equality.
  - A rollback negative control was added at `wire-authority.test.js:1177`.
- **Scope note:** `b767222c` also repairs the `restoreDuration.js` import maps in five
  MicroVM-era guest-command test files. This is a harmless change to test files only, bundled
  into a graphical commit.

### F2. Per-message decode cost: fixed

- **Fix:** `core/src/wire/graphical_session.rs:13-17` checks `schema` against the constant tag
  before any schema work. It then uses the cached `schemas::schema` (`schemas.rs:3-15`).
- **Measurement on this box, release build, best of 5 [MEASURED].** A failed graphical attempt
  on the `action_proposal/v0.2` body of `envelope.valid.json` costs:
  - `GraphicalSessionRequest`: 1.93 µs per message.
  - `GraphicalSessionEvent`: 1.87 µs per message.
  - In the first review these were 19.3 µs and 131.6 µs [CITED].
- **`decode_envelope` on the same envelope:** 623 µs per message at head [MEASURED]. There is no
  base figure from this box: ABSENT — do not invent.
- **Residual, not blocking:**
  - Each attempt still builds the body as a `Value` (`graphical_session.rs:12`).
  - The variants are still 2nd and 3rd in the untagged `Command` (`payload.rs:2239-2240`).
  - This cost also reaches MicroVM traffic.
  - Optional fix: move the variants behind the high-rate ones.

### F3. Host timeout race: partly fixed

- **Fixed:**
  - A throw from `receive` is caught at `hostBindings.js:505` and quarantines only the feature.
  - A late event, or one for an unknown request, returns false (`graphicalSessionHost.js:47-51`).
  - Sub-pass: 7 throwaway cases pass. They include: host timeout, then Core `outcome_unknown`,
    then a late `completed`; and an identical duplicate `event-core-6` (see N4) [MEASURED].
- **Still present, the timeout order:**
  - Host: 30000 ms, armed before send (`graphicalSessionHost.js:8`, `:37`).
  - Core: 30 s from receipt (`core/src/graphical_session.rs:12`).
  - Adapter: 30 s, which starts only after a drain of up to 2 s
    (`daemon-adapter/internal/capsule/graphical_session.go:311`, `:321`).
- **Sequence:** a native mark or restore takes 31 s and succeeds. Core has already marked the
  request unknown and refuses the late `completed`, because `p.uncertain`
  (`graphical_session.rs:193`) is set. Custody is held until Stop.
- **Effect:** this fails closed and gives no false success.
- **Smallest fix:** host above Core above adapter, with the drain included, for example
  40 s, 35 s and 30 s.

### F4. Ceilings: partly fixed

- **Fixed:** the ceilings now drain on physical destroy:
  - Core: `graphical_session.rs:294-295`.
  - Adapter: reset on attach at `graphical_session.go:475`, and the slot is dropped on destroy at `manager.go:1241-1243`.
  - Host: `surfaceClosed` at `graphicalSessionHost.js:100`.
- **Still present:** the limit is per VM lifetime.
  - Core refuses at 128 (`graphical_session.rs:99`) and refuses a re-attach while held (`:110-111`).
  - Adapter: the first `CAPACITY` comes at request index 127 within one attach [MEASURED].
  - Host, sub-pass: after 128 requests it returns `BUSY` while the buttons stay enabled
    [MEASURED].
- **Sequence:** about 128 Mark/Back operations on one VM. Checkpoints then stop working until
  Stop, which discards the guest state. The UI shows "BUSY", not "CAPACITY".
- **Smallest fix:**
  - Retire history entries once their terminal event is recorded, keeping only a bounded replay
    window.
  - At minimum, surface `CAPACITY` and disable the controls.

### F5. x64 and disabled installs: fixed

- **Go:**
  - `process.go:329` admits graphical sessions only when the arch is arm64 and the flag equals
    `1` (`:369-371`).
  - The graphical variables reach the native runner only when admitted (`:350-356`).
  - The author's `TestNewRuntimeIgnoresGraphicalEnvironmentUnlessAdmitted` passes in the head
    Go suite [MEASURED].
- **UI:** `coreLauncher.js:197`. Sub-pass on x64: flag `0`, `''`, `false`, `1` or unset, each
  with no pins, full pins and a bad pin. Nothing throws [MEASURED].
- **Residual:** `preload.js:1655` and `authorityWire.js:908-909` are still exposed on x64. They
  fail closed, the same pattern as rewind. Accepted.

### F6. Fence scope: partly fixed

- **Fixed:**
  - The create request fence is now scoped to the held VM's profile
    (`graphical_session.rs:60-66`, `admission/mod.rs:836-842`, `serve/mod.rs:1449-1453`).
  - The capture and input fence is now documented (`docs/GRAPHICAL_VM_REWIND.md:39-41`).
- **Still present:**
  - `LifecycleUpdate::Created` is refused across the whole wall while anything is pending
    (`admission/mod.rs:988`).
  - New surface registration also fails across the whole wall (`admission/mod.rs:1075`).
  - Narrowing only the first of these three fences creates N3.

### F7. VM dies during an operation: partly fixed

- **Fixed:**
  - On Lost, Core flushes the journal and then pushes the saved `outcome_unknown` to the creator
    (`serve/mod.rs:1607-1611`, `serve/graphical_session.rs:101-112`). The author's
    `lost_surface_publishes_graphical_outcome_unknown_to_creator` passes [MEASURED].
  - Stop of a lost, held VM by the UI endpoint that attached is admitted (`serve/mod.rs:1444-1447`,
    `:1461-1462`; `admission/mod.rs:862-863`).
  - The adapter's first liveness check now clears `busy` and emits `outcome_unknown`
    (`graphical_session.go:408-419`).
- **Still present:**
  - The restore's second liveness check, after the post-loadvm capture and publish
    (`graphical_session.go:493-495`), still returns `nil, nil`. It leaves `busy=true` and emits
    no event.
  - Sequence: the VM is lost during the fresh-frame capture. The adapter slot stays busy, so an
    attach on another VM returns `BUSY` until Stop. Core settles only through its deadline (read).
  - Smallest fix: the same treatment as `:408-419`.

### F8. Slot claimed by a refused request: partly fixed

- **Fixed:** a refused attach releases the slot, whether the native refused it or it was refused
  before spawn (`graphical_session.go:436-438`, `:447-449`).
- **Still present, first path:** the slot is still installed at `:268`, before the admission
  checks run.
  - Sequence: a mark is sent to VM A with no session. It is refused `STALE` at `:281`, the slot
    stays held, and an attach on VM B is refused `BUSY` [MEASURED].
  - Core never forwards such a mark (`graphical_session.rs:116-117`), so only the adapter can
    reach this path.
- **Still present, second path:** a drain-timeout refusal of an attach (`:333-338`) also keeps
  the slot (read).
- **Smallest fix:** claim the slot after the admission checks, and release it on any refusal
  while `session == nil`.

### F9. Failed Stop leaves `stopping` set: fixed

- **Fix:** `manager.go:1201-1210` resets `stopping` when `BeforeDestroy` fails.
- **Proof:** the author's `TestFailedBeforeDestroyDrainReopensStoppingWithoutErasingState`
  passes [MEASURED: head Go suite].
- **Note (read):** `stopGraphicalLocked` (`manager.go:1193`) has already cancelled any in-flight
  operation, so that operation settles as `outcome_unknown`. This fails closed.

### F10. Adapter-epoch handoff: still present (deferred, as the author states)

- **Code:** unchanged at `admission/mod.rs:1062`, which reaches `graphical_session.rs:273-279`.
- **Effect:** after any daemon reconnect, an idle held session flips to `outcome_unknown` and
  the UI is not told.
- **Raised to medium-low:** because `blocks_mutation` (`graphical_session.rs:46-51`) now also
  fences human input on that VM at Core (`admission/mod.rs:884`, `:1128`, `:1216`, `:1238`).
  The VM stays input-dead until Stop (read).

### F11. Budget: unchanged

Each accepted graphical request still decrements the shared action budget
(`admission/mod.rs:651`). Information only.

## New defects

### N1. Rewind VM frozen on open with today's native

**Severity: high, on the flag-on arm64 path.**

**Files.**
- `ui/src/App.vue:1624` and `ui/src/wall/graphicalStateControls.js:62-65`: the controller
  attaches to the first active `kind==='vm'` row on every change to rows or state, with no user
  action (sub-pass [MEASURED]).
- `graphical_session.go:430-441`: an attach exec error that is not a pre-spawn refusal now
  returns `outcome_unknown` and keeps the slot. Before `b767222c` it returned
  `refused UNAVAILABLE`.
- `process.go:300-304`: exit 2 counts as a pre-spawn refusal only when stderr carries
  `host_program_unavailable:`.
- Otherwise exit 2 becomes `cli.ExitFault` with code `usage` (`internal/cli/runner.go:58`).

**Sequence.**
1. The user opens a `notepad-rw-vm` tile.
2. The UI auto-attaches; Core accepts and records the request in history.
3. The adapter runs `graphical-session --container … --op attach`, and the native exits 2
   [CITED: author].
4. The adapter returns `outcome_unknown`.
5. On the adapter side, Capture and input return `BUSY` and the tile freezes.
6. On the Core side, `pending` becomes uncertain and human input is no longer forwarded.
7. A re-attach is refused `BUSY`. Through N3, every other capsule's `Created` update is refused.
8. Only Stop from the UI that attached releases it.

**Proof.**
- Go throwaway [MEASURED]: a runner returning `ExitFault(srf-identity-surface, 2)` gives:
  - event `outcome_unknown` and slot held;
  - Capture error `BUSY: graphical rewind owns the surface`;
  - a retried attach refused `BUSY`.
- Core throwaway [MEASURED]: after an attach `outcome_unknown`:
  - `pending.uncertain=true` and `blocks_mutation=true`;
  - 0 human inputs forwarded;
  - re-attach refused `BUSY`.
- Native stderr text: unknown, because native is private. If it carries
  `host_program_unavailable:`, step 4 becomes a clean refusal instead.

**Smallest fix.**
- Treat a `usage` exit (2) from attach as a proven pre-effect refusal: return `UNAVAILABLE` and
  release the slot.
- Attach only on a user action, or only on rewind-profile rows.
- Gate: the same throwaway sequence ends with Capture allowed.

**Note.** A plain VM is refused `UNAVAILABLE` at `graphical_session.go:259-260`, before the slot is
claimed, so auto-attach does not take the slot for it (read). It still costs one Core history
entry per tile.

### N2. Agent Stop of its own VM refused while held

**Severity: medium-high.**

**Files.**
- `serve/mod.rs:1444-1447`: destroy of the held surface is unsupported unless it comes from the
  UI endpoint that attached (`graphical_session.rs:57-59`).
- A session is held from attach until physical destroy, and there is no detach operation.

**Sequence.**
1. The UI attaches to the agent's VM, either automatically (N1) or by a click.
2. The agent sends `surface_request` destroy.
3. Core returns unsupported and nothing is forwarded.
4. Before `b767222c`, a fenced surface still admitted destroy.

**Proof.** Core throwaway [MEASURED]:
- Agent destroy with a session held: 0 forwarded.
- Control with no session: 1 forwarded.
- UI destroy: 1 forwarded.

**Effect.**
- The agent cannot clean up its own VM.
- This contradicts "Normal Stop remains available" (`docs/GRAPHICAL_VM_REWIND.md:41`).
- A UI endpoint whose instance differs from the creator's cannot Stop either. Whether the UI
  instance survives a restart: unknown.

**Smallest fix.** Also admit destroy of the held surface from the registered owner agent,
budget-free as before. Third parties stay refused.

### N3. Created refused after a narrowed create fence

**Severity: medium-high.**

**Files.**
- `admission/mod.rs:836-842` and `serve/mod.rs:1449-1453` now let a create for another profile
  through while a graphical request is pending.
- `admission/mod.rs:988` still refuses `LifecycleUpdate::Created` while anything is pending.
- `:1075` still fails registration with `InvalidInput`.

**Sequence.**
1. A graphical request on VM A is pending or unknown.
2. A capsule is created on another profile and forwarded to the daemon (native spawn).
3. The daemon reports `Created`; Core refuses it with `Policy`.
4. The surface is not registered.
5. With N1, the pending state never clears until VM A is stopped.

**Proof.** Core throwaway on the authority [MEASURED]:
- Control: create reason `None`, `Created` reason `None`, surface registered.
- After an attach `outcome_unknown`: create reason `None`, `Created` reason `Policy`, surface not
  registered.
- Rollback of the native capsule after the refused `Created`: unknown (not traced).

**Smallest fix.**
- Use one predicate for all three sites (`:836`, `:988`, `:1075`): the profile and held-surface
  scope.
- Or restore the create fence across the whole wall while anything is pending.

### N4. Duplicate unknown event on Lost after the deadline

**Severity: low.**

- **File:** `serve/graphical_session.rs:101-112` re-sends the saved reply even when the deadline
  push already delivered it.
- **Proof [MEASURED]:** the UI receives `event-core-6` twice. The host tolerates this (sub-pass
  [MEASURED]), so the effect is only a duplicate message.
- **Smallest fix:** send only when Lost itself caused the transition to unknown.

### N5. Unconditional journal fsync on every Lost event

**Severity: low. It touches accepted paths.**

- **File:** `serve/mod.rs:1607-1611` runs `flush_sync()` for every Lost surface. This includes
  MicroVM capsules and x64 with the flag off.
- **Effect (read):** a synchronous flush on the daemon stream for each Lost event. A flush error
  now returns before the human-input Lost cleanup at `:1613-1625`.
- **Smallest fix:** flush only when `graphical_session.held_surface() == Some(id)`.

### N6. Startup weight, and the 200 MB rail is not measured

**Severity: low.**

- **Preload** grows by 30,565 bytes (148,995 to 179,560) and loads in every renderer [MEASURED,
  sub-pass].
- **Renderer** (`App.vue:1610-1621`): imports the controls chunk at boot on every platform,
  sends one status IPC, and starts a 1 s timer for each visible control (read).
- **Main process:** `authorityWire.js:20` imports `graphicalSessionValues.js` eagerly. Its
  schema is now held as a string and parsed lazily.
  - Main-module import RSS in plain Node: 70.1 to 70.5 MB in both trees [MEASURED, sub-pass].
- **Core** parses graphical schemas lazily (`schemas.rs:3-15`) (read).
- **The 200 MB rail** (`ui/test/uiel-smoke-rss.test.js`) did not run on this box, at head or at
  base:
  - Electron running as root needs `--no-sandbox`.
  - With a `--no-sandbox` wrapper the main process never reached readiness within the test's
    20 s under Xvfb, at either commit.
  - Startup RSS against the 200 MB rail: ABSENT — do not invent.

### N7. VM tiles show "Checkpoints: UNAVAILABLE" with the feature off

**Severity: low.**

- **Files:** `graphicalStateControls.js:22` and `authorityWire.js:908`.
- **Sequence:** arm64, flag off, a VM tile. The tile shows "Checkpoints: UNAVAILABLE"
  (sub-pass [MEASURED]). The header test misses it, because its snapshot has `code:null`. x64
  has no VM rows.
- **Smallest fix:** show the controls only when `available || session !== null`.

## Attacks that held

- **False success in the checkpoint controls: none found (sub-pass, read).**
  - Points come only from a host-validated `completed` (`graphicalSessionHost.js:79-80`).
  - Back completes only with the +1 tuple and a frame witness (`:82`).
  - The buttons are enabled only when the session is ready and held, the tile is active, and
    nothing is busy, unknown or pending (`graphicalStateControls.js:26`).
  - The revision check refuses stale click handlers (`:69-72`).
- **Frame and input after loadvm (read):**
  - The input epoch is advanced before the fresh capture (`graphical_session.go:469-473`).
  - Capture stays fenced until delivery (`CompleteGraphicalEmission`).
  - Core requires a strictly newer frame with matching hash and generation
    (`graphical_session.rs:251-253`).
  - `b767222c` does not change this route.
- **Contracts:** additive only.
  - Against `1760a40a`, 60 files are added under `contracts/` and none is modified or deleted
    [MEASURED: `git diff --name-status`].
  - `b767222c` touches no contract file [MEASURED].
- **MicroVM rewind path:**
  - No file matching `*rewind*`, `*microvm*` or `*firecracker*` changed [MEASURED].
  - MicroVM UI modules are byte-identical (sub-pass [MEASURED]).
  - With empty graphical state, `held_surface()` is `None`, so the new destroy, create and Stop
    predicates reduce to base behaviour (`admission/mod.rs:832-866`, `serve/mod.rs:1444-1462`)
    (read).
  - Core `rewind_flow` (19) and `rewind_envelope` (3) pass [MEASURED].
  - Exceptions: N5 and the F2 residual also reach MicroVM traffic.
- **Native graphical attach fix** in progress outside this repository: unknown.

## Runs

- **Core, release build, at head:**
  - `decode_envelope` 13, `graphical_session` 14, `rewind_envelope` 3, `rewind_flow` 19: all
    pass [MEASURED].
  - Lib tests filtered on `graphical`: they pass, including the author's Lost test [MEASURED].
  - Full Core suite: not run, ABSENT — do not invent.
- **Go, `go test ./... -count=1` at head:**
  - 11 packages ok.
  - `internal/daemon` failed `TestBinaryCoreLifecycle` and `TestBinaryCoreWithoutHelloReply`
    while a parallel cargo build was running.
  - Re-run alone: the 4 `TestBinaryCore*` tests pass at head and at base [MEASURED].
- **UI:** see F1 [MEASURED, sub-pass].
- **Router:** `python3 tools/router_index.py --check` on a clean head gives coverage 100% of
  3350 files [MEASURED]. This report adds one file that is not indexed. As with the first
  review, this branch is a report carrier, not a merge candidate.
- **Cleanup:** the throwaway Core tests (in `core/src/serve/mod.rs`) and the Go test
  (`zz_audit_tmp_test.go`) were removed, and `git status` was confirmed clean in both
  worktrees.
- **Push:** made because the maintainer explicitly asked for it in this task. LAWS.md L6 is
  noted.

## Before any later merge

1. Fix N1 (treat a `usage` exit as a refusal; no automatic attach).
2. Fix N2 (owner agent Stop) and N3 (one fence predicate at three sites).
3. Fix the F7 residual (restore's second liveness check) and the F8 residual (claim the slot
   late).
4. Address the F4 lifetime limit (retire settled history, or surface `CAPACITY`).
5. Order the timeouts host, then Core, then adapter (F3).
6. Measure the 200 MB rail on a host that can run it.
7. Click proof on arm64 with the fixed native: visible mutation, Back, a fresh bound frame,
   continued input, measured timings and verified physical closure.

## What a merge today would risk

The product can ship without this work.

**On x64 and flag-off installs** the feature is mostly inert (read). Merging would still add:
- N5: an fsync on every Lost event, MicroVM included;
- the F2 residual, about 2 × 1.9 µs per decoded message [MEASURED];
- N6: preload +30,565 bytes [MEASURED], plus a boot-time chunk and IPC;
- N7: a stray "UNAVAILABLE" label on arm64 flag-off VM tiles.

**On flag-on arm64** with today's native it would add N1 to N3: a frozen tile, a VM the agent
cannot Stop, and capsules that native creates but Core refuses to register.

## Reviewer

- **Model:** withheld from tracked files under LAWS.md L1.2; stated in the session reply.
- **Effort:**
  - One bounded pass of about 20 minutes of wall-clock time (06:21 to 06:41 UTC), at the
    session's reasoning-effort setting `xhigh` (session metadata).
  - A parallel UI-only sub-pass of about 11 minutes. F1, F3, the host part of F4, the UI part of
    F5, N6, N7 and the false-success check rest on its runs, re-read against `b767222c4`.

DO NOT MERGE for today's release.

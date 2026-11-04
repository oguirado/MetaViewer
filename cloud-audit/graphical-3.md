# Graphical QEMU rewind re-review (3)

Third review of `origin/cloud/base-graphical-3` at `49ca5e2fb` on base `1760a40a9`. The branch
holds six commits, `db501419b` to `49ca5e2fb`. The last three (`2efb1d816`, `394c9bf1d`,
`49ca5e2fb`) are new since the second review, which covered `b767222c4`.

It checks the findings of the first review (`cloud-audit/GRAPHICAL.md` on `cloud/audit-graphical`,
F1 to F11), the second review (`cloud-audit/graphical-2.md` on `cloud/audit-graphical-2`, N1 to
N7), and the verifier's finding V1.

This is a report only. This commit changes no product code.

## Verdict

**DO NOT MERGE for today's release.** The product ships without this work.

The fixes close most earlier findings: F3, F6 to F9, N2 to N5 and N7, plus the UI half of N1.
Four problems remain, each reproduced on this box:

- **G1.** Two CI gates are red at the head, both because the new notice fixtures were never
  registered with the existing fixture checks:
  - Go: 6 `internal/ipc` tests fail [MEASURED]. One of them is the MicroVM rewind fixture-pin
    test.
  - Rust: Core `decode_envelope` fails 1 of 13 [MEASURED].
  - All three CI runs on `49ca5e2fb` were cancelled, so green CI is not shown [CITED: GitHub
    Actions run 41822121161].
- **G2.** A new Core defect: a daemon reconnect at a moment when the UI's queue is full locks the
  daemon out of Core until Core restarts [MEASURED].
- **V1.** One VM's checkpoint status still bleeds into every other VM tile. One refusal blocks
  Enable on every tile until that VM is stopped [MEASURED].
- **N1, adapter half.** With the native as it shipped, an exit-2 attach still freezes the tile
  and takes the single slot until Stop [MEASURED]. Now it happens only after a click.

The merge onto `cloud/base-e1` has one high-risk hunk. It is in the `serve/mod.rs` reconnect
path, which is the same code as G2.

## Scope and method

- **Unit:** `cloud-audit/graphical-3.md` (new). Closure: none. The report is passive data.
- **Negative control:** `git diff --name-only HEAD~1..HEAD` on this branch must list only this
  file.
- **Router status:** unavailable. Coordinates come from the commit diffs and were checked against
  the files at `49ca5e2fb`.
- **Line numbers** are at `49ca5e2fb` unless a line says otherwise.
- **Native code** (wender-agent, vision-engine, OpenSuperficies) is private and absent. Anything
  that depends on it is marked unknown.
- **Proof kinds:**
  - "Measured": a throwaway Go, Core or Node test was run on this box, then deleted.
  - "Sub-pass": a parallel UI-only pass ran it.
  - "Merge pass": a parallel pass did a trial merge onto e1 in a scratch worktree, then aborted it.
  - "Read": the code was read, not run.
- **Box:** x86_64, 4 CPU, no KVM. go 1.24.7 with the go1.26.0 toolchain the module asks for;
  cargo release build; Node 22.23.4, plus `capsule-ui-kit` at its pin for the UI sub-pass.

## Status of earlier findings

| Id | Status | Proof | One line |
|----|--------|-------|----------|
| F1 | Fixed (graphical scope) | Measured (sub-pass) | 173 of 173 graphical and pinned UI tests pass; the full suite has non-graphical failures, not compared at base |
| F2 | Partly fixed (residual, info) | Read | Tag check first; variants still 2nd and 3rd in the untagged `Command` |
| F3 | Fixed | Read, plus the author's test | Host 30 s, then Core 28 s, then adapter 24 s, drain included |
| F4 | Partly fixed | Measured (sub-pass) | `CAPACITY` now shown and controls disabled; the limit is still per VM lifetime (documented) |
| F5 | Fixed | Read | Unchanged; `notepad-rw-vm` is now offered only when the pins are ready |
| F6 | Fixed | Read, plus the author's test | `Created` and registration use the profile-scoped predicate |
| F7 | Fixed | Author's test passes | Restore's second liveness check now emits `outcome_unknown` |
| F8 | Fixed | Author's tests pass | Slot claimed after admission; a sessionless drain timeout releases it |
| F9 | Fixed | Author's test passes | Unchanged |
| F10 | Partly fixed | Read, plus the author's test | The UI is now told (new notice); the VM is still input-dead until Stop |
| F11 | Unchanged (info) | Read | Shared budget decrement |
| N1 | Partly fixed | Measured, plus read | No auto-attach now; an exit-2 attach after a click still freezes the tile |
| N2 | Fixed | Author's tests pass [MEASURED] | The registered owner agent can Stop its held VM; other agents cannot |
| N3 | Fixed | Author's test passes [MEASURED] | Created for an admitted other profile registers |
| N4 | Fixed | Author's test passes [MEASURED] | No re-send unless Lost caused the unknown |
| N5 | Fixed | Read | fsync only when the Lost surface is the held one |
| N6 | Unchanged | Measured (sub-pass) | Preload +30,565 bytes; RSS rail not run |
| N7 | Fixed | Measured (sub-pass) | No label with the feature off |
| V1 | Still present | Measured (sub-pass) | Status, code and Enable gate are wall-wide |

### F1. UI gate: fixed for the graphical scope

- **Graphical and pinned files** (graphical-*, vm-role-status, wire-authority,
  rv9-elec-regressions, mvui-w-host) after `npm ci` and the kit pin: 173 of 173 pass
  [MEASURED, sub-pass].
- **Full suite at `--test-concurrency=2`, RSS rail excluded:** 4517 tests, 4497 pass, 10 fail,
  8 cancelled, 2 skipped [MEASURED, sub-pass].
  - None of the failures are graphical.
  - 4 need Node 24.
  - `v028-fit-render` needs the gate's Electron.
  - `v027-tile-chrome` timed out.
  - The `display-holds`, `display-reader`, `floating-constraints`, `pkg-fullstack` and
    `r2t4-regressions` failures were not compared at base, so they are unchecked here.
  - The second review ran on Node 24 and had 4 failures, all of which also failed at base
    [CITED].

### F2. Decode cost: residual unchanged (info)

- `core/src/wire/payload.rs:2239-2240`: request and event are still the 2nd and 3rd variants.
- The new `GraphicalSessionNotice` is the last variant (`:2268`), so it adds no attempt to other
  traffic (read).

### F3. Timeout order: fixed

- Host: `ui/electron/graphicalSessionHost.js:9` (30000 ms).
- Core: `core/src/graphical_session.rs:12` (28 s).
- Adapter: `daemon-adapter/internal/capsule/graphical_session.go:313` (24 s). It is now started
  before the capture drain.
- These deadlines are stated as [TARGET] in `docs/GRAPHICAL_VM_REWIND.md:63-67`.
- **Residual:** the host's 2 s margin over Core includes transport. A Core push that takes more
  than 2 s still settles as unknown, which fails closed.

### F4. Ceilings: partly fixed

- **Fixed:** after 128 requests the host returns `CAPACITY`, `commandAllowed()` is false and the
  controls are disabled. Stop clears it [MEASURED, sub-pass] (`graphicalStateControls.js:29`).
- **Still present:** the limit is per VM lifetime (`core/src/graphical_session.rs:10`). It is now
  documented (`docs/GRAPHICAL_VM_REWIND.md:57-61`). Accepted as a stated limit.

### F6, F7, F8: fixed

- **F6:** `core/src/admission/mod.rs:988-992` and `:1079-1083` use `blocks_profile_registration`
  (`core/src/graphical_session.rs:90-104`). An unscoped `Input::Surface` registration is still
  refused while a session is held. This is intended, and the author's test asserts it.
- **F7:** `graphical_session.go:511-522` emits `outcome_unknown` and clears `busy`.
- **F8:** the slot is installed at `:315-317`, after every admission check. The drain-timeout
  refusal releases a sessionless slot at `:342-344`.
- **Proof:** the head Go `internal/capsule` suite passes, including
  `TestGraphicalMarkWithoutSessionDoesNotClaimSingleton`,
  `TestGraphicalAttachDrainTimeoutReleasesSessionlessSingleton` and
  `TestGraphicalRestoreLivenessLossAfterFreshCaptureEmitsUnknown` [MEASURED].

### F10. Epoch handoff: partly fixed

- **Fixed:** `core/src/serve/graphical_session.rs:6-46` sends `graphical_session_notice`
  (`EXECUTOR_EPOCH_CHANGED`) to the creator UI after a durable flush.
- **Still present:** the held VM stays fenced (`blocks_mutation`, `graphical_session.rs:46-51`)
  until Stop, and Stop discards the guest state. No release notice exists: the schema pins
  `outcome_unknown` and `held`.
- **Also:** the new send introduces G2.

### N1. Exit-2 attach: partly fixed

- **UI half, fixed (read, sub-pass):**
  - `graphicalStateControls.js:67-68` makes `attach(rows)` a no-op.
  - Attach now needs the "Enable checkpoints" click, once per row (`:75-78`).
- **Adapter half, still present [MEASURED].** A throwaway Go test (deleted) used a runner that
  returns `cli.ExitFault("srf-identity-surface", 2, "")` for the attach. Results:
  - event `outcome_unknown`, slot held, `unknown=true`;
  - Capture refused `BUSY: graphical rewind owns the surface`;
  - an attach on a second VM refused `BUSY`.
- **Cause:** `process.go` is unchanged since `b767222c4`. Exit 2 is a pre-spawn refusal only with
  `host_program_unavailable:` in stderr.
- **Sequence:** click Enable on a `notepad-rw-vm` tile with a native that exits 2. The tile
  freezes, and no other VM can attach until Stop.
- **Native status:** whether today's native still exits 2 is unknown. The author's click proof is
  not visible here: ABSENT — do not invent.
- **Smallest fix:** map a `usage` exit (2) on attach to `refused UNAVAILABLE` and release the slot.

### V1. Checkpoint status bleeds across VM tiles: still present

- **Files:**
  - `ui/src/wall/graphicalStateControls.js:25`: `visible` is true on every `kind==='vm'` tile
    whenever `session` is null (`attachable`).
  - `:31`: every visible tile gets the same `code`, `uncertain` and `busy`. Enable needs
    `snapshot.code===null`.
- **Sequence, measured with tiles A and B (sub-pass, throwaway at scratchpad, deleted after):**
  1. A's attach pending: both tiles show "Rewind pending".
  2. A refused `NATIVE_FAILED`: both tiles show "Checkpoints: NATIVE_FAILED", and both Enable
     buttons are disabled. The host itself would accept B (`commandAllowed()` true).
  3. A's attach times out: both tiles show "Rewind outcome unknown".
  4. Only `surfaceClosed(A)`, that is a physical Stop of A, clears it.
- **Effect:** a person sees A's error on B. After one refusal on any VM, no VM can enable
  checkpoints until that VM is stopped. This fails closed, with no false success, but it misleads.
- **Smallest fix (renderer only, no wire change):**
  - The controller records the surface of its last request.
  - `graphicalCapabilities` shows code, uncertain and busy only on that tile.
  - Enable is gated on busy, uncertain or `CAPACITY`, not on `code===null`.

### N6. Startup weight and the 200 MB rail

- **Preload:** 148,995 bytes at base, 179,560 at head, +30,565 [MEASURED, sub-pass].
- **Renderer:** one 1 s `setInterval` per mounted control (`GraphicalVmStateControls.vue:30`,
  cleared at `:31`). With no session, every VM tile mounts one (read).
- **200 MB rail:** `ui/test/uiel-smoke-rss.test.js` was run once with `--no-sandbox` under
  xvfb-run. The main process did not signal readiness within the 20 s deadline.
  - Startup RSS against the 200 MB rail: ABSENT — do not invent.

## New defects

### G1. CI Go and Rust gates red at head; MicroVM rewind pin test among the failures

**Severity: blocking.** CI runs `go test -race ./...` (`.github/workflows/ci.yml:1348`) and
`cargo test --locked --offline` (`:1168`). Both fail at the head.

**Rust part:**
- **File:** `core/tests/decode_envelope.rs:343`. `49ca5e2fb` added the notice examples but did
  not update this test. Its last change is `db501419b`.
- **Result:** `all_frozen_body_examples_and_negative_controls` panics with `unrecognized schema
  prefix "graphical_session_notice_envelope" in fixture
  graphical_session_notice_envelope.invalid.old-event.json`. 12 of 13 pass [MEASURED, release].
- **Control:** 13 of 13 passed at `b767222c4` [CITED: second review]. It was not re-run here.
- **Smallest fix:** register the notice body and envelope prefixes in the frozen-example check.

**Go part:**

- **Files:**
  - `daemon-adapter/internal/ipc/policy_test.go:91-92` refuses any `graphical_session*` example
    that is not in `graphicalFixturePins`.
  - `daemon-adapter/internal/ipc/graphical_fixture_pins_test.go:10`: that map does not list the
    8 new notice example files that `49ca5e2fb` adds under `contracts/examples/v0.2/`.
- **Failures:** `go test ./internal/ipc/ -count=1` gives 6 failures at `49ca5e2fb` and passes at
  `b767222c4` [MEASURED]. They are:
  - `TestAdditiveCorpusCannotHideLegacyLossOrChangedExtension`
  - `TestCommandObservationFixturePinsRejectChangeMissingAndUnknown`
  - `TestGraphicalFixturePinsRejectChangeMissingAndUnknown`
  - `TestProductionEnvelopePolicy`
  - `TestT6Open03FixtureCountAndSchemaCoverage`
  - `TestRewindFixturePinsRejectChangeMissingAndUnknown`
- **Error:** each one reports `unrecorded graphical fixture:
  graphical_session_notice.invalid.fake-pending.json`.
- **Effect:** CI red. The MicroVM rewind pin test fails through the shared corpus check. MicroVM
  behaviour is not affected (read).
- **CI on GitHub:** the CI, package and secrets runs on `49ca5e2fb` all ended `cancelled`
  [CITED: Actions runs 41822121161, 41822120976, 41822121058].
- **Smallest fix:**
  - Pin the 8 new example SHA256s in `graphicalFixturePins`, or give the notice files their own
    pin map.
  - Re-run `go test -race ./...`.

### G2. A daemon reconnect against a full UI queue locks the daemon out

**Severity: high on the flag-on path.**

- **Files:**
  - `core/src/serve/graphical_session.rs:44-45`: `notify_graphical_epoch_change_at` returns the
    `send_at` error. The existing graphical pushes ignore it (`let _ =`, `:137`, `:154`).
  - `core/src/serve/mod.rs:2696-2701`: the handshake calls it with `?`. This happens after the
    daemon was inserted into `connections` (`:2683-2691`).
  - The error path (`:2705-2727`) never calls `retire`. Every later hello for the daemon gets
    `endpoint already connected` (`:2661-2662`).
- **Sequence:**
  1. A checkpoint session is held and ready.
  2. The UI's outbound queue is full (frame bursts).
  3. The daemon reconnects.
  4. The notice enqueue fails with `QueueOverflow(Ui)`, and the daemon's admission fails.
  5. The daemon stays registered as connected, and all its reconnects are refused until Core
     restarts.
  6. The whole wall loses its daemon: no frames, input or lifecycle for any capsule.
- **Proof:** Core throwaway, in-process `connection_with_liveness`, deleted afterwards
  [MEASURED]:
  - UI queue full: attempt 0 failed `QueueOverflow(Endpoint{Ui})` with the daemon still in
    `connections`; attempt 1 failed `endpoint already connected`.
  - Negative control, UI queue not full: both attempts succeeded, and the daemon was retired
    afterwards.
- **Same shape, pre-existing:** a `flush_sync` or apply error in `mark_graphical_session_unknown_at`
  (`serve/mod.rs:2695`) follows the same path (read).
- **Smallest fix:**
  - Use `let _ = self.send_at(...)` for the notice.
  - Also retire the inserted connection on any admission error after `connections.insert`.

### G3. A person can see, and act on, a pre-restore frame after Back

**Severity: medium. This is a product-truth gap, not a protocol break.**

- **Files:**
  - `graphical_session.go:487-544`: after the native restore, the adapter takes one capture and
    publishes it.
  - Core accepts any strictly newer frame generation with a matching hash
    (`core/src/graphical_session.rs:287-290`).
  - `CompleteGraphicalEmission` (`graphical_session.go:138-154`) then clears `busy`. Core clears
    `pending`, so capture and input reopen at once.
- **What the check proves:** a new capture happened after loadvm. It does not prove that the
  capture shows the restored state.
- **Author's data:** the first SDK read 1.965 s after restore still returned the pre-restore state
  [CITED: author], and that read was excluded as recovery.
- **Sequence:**
  1. The person clicks Back.
  2. The status reaches "completed" with a frame witness.
  3. The tile shows the frame captured within that window, which may still show the pre-Back
     content.
  4. Input is already forwarded, so the person may type or click against a stale layout. The
     keystrokes land in the restored guest.
- **Can a person see it:** yes, if the native capture shares the recovering channel. Whether it
  does is unknown (native private). Can they act on it: yes. Input is unfenced at completion
  (read).
- **Smallest fix:**
  - Keep capture and input fenced after loadvm until the native returns a frame carrying a
    post-restore guest epoch or token.
  - Weaker: a settle delay of at least 2.5 s [TARGET] before the witness capture.
  - Live acceptance should record the delay to the first post-restore frame.

### G4. Host copies points on a Mark `accepted` without checking them

**Severity: low.**

- **File:** `graphicalSessionHost.js:65-66` (and `:70-71` for `outcome_unknown`). On `accepted`,
  the host copies the session without checking that the points are unchanged.
- **Proof:** in the sub-pass probe, a crafted `accepted` showed a not-yet-created point. Its Back
  button was visible but disabled while pending, and a refusal restored the old session
  [MEASURED, sub-pass].
- **Reachability:** Core builds `accepted` from its own state, so this needs a faulty Core.
- **Smallest fix:** for a Mark, require the accepted points to equal `p.before.points`.

## Lifecycle, Stop, contracts and MicroVM

- **Stop:**
  - The creator UI (`graphical_session.rs:57-61`) and the registered owner agent (`:62-82`,
    `serve/mod.rs:1444-1448`) can Stop the held VM.
  - Other endpoints stay refused.
  - After `surfaceClosed` the UI state clears, and another VM can attach [MEASURED, sub-pass].
  - Adapter Stop cancels in-flight work (`stopGraphicalLocked`, unchanged).
- **Other capsules during a pending request:**
  - Creates and `Created` for other admitted profiles pass. The held profile and an unknown VM
    profile stay fenced (author's test `scoped_create_registration_fence_allows_only_admitted_other_profiles`).
  - An unscoped `Input::Surface` registration is refused while held (read).
- **False success:**
  - Points and "completed" come only from host-correlated Core events (`graphicalSessionHost.js:72-88`).
  - The status text has no success wording.
  - Notices only quarantine and cannot create or clear an owner.
  - Stale clicks are refused (`graphicalStateControls.js:71`).
  - No false success found [MEASURED, sub-pass].
- **`graphical_session_notice` contract:**
  - Against `1760a40a9`, 72 files under `contracts/` are added and none is modified or deleted.
    Since `b767222c4`, 12 are added [MEASURED: `git diff --name-status`].
  - Existing `contracts/v0.2` bytes are untouched.
  - The schema has one valid example and five invalid ones; the envelope has one valid and three
    invalid. Core checks them (`core/src/wire/mod.rs:664-696`).
  - The Go pin corpus was not updated (G1).
- **MicroVM rewind:**
  - No file matching `rewind`, `microvm` or `firecracker` changed outside the graphical files
    [MEASURED].
  - N5 no longer fsyncs on MicroVM Lost.
  - The only regression found is G1's red pin test (harness only).
  - Core `rewind_flow` and `rewind_envelope`: see Runs.

## Integration onto `cloud/base-e1`

- **Ref:** measured against `origin/cloud/base-e1` at `7883ea412`, as fetched at about 11:37 UTC.
- **Trial merge [MEASURED, merge pass]:**
  - 640 conflicted paths, all but 4 under `catalogue/`. They are mechanical: regenerate the index.
  - `core/src/serve/mod.rs`: 2 hunks, semantic.
  - `ui/electron/preload.js`: 1 hunk, mechanical (subscription allow-list; keep `demo.state` and
    `graphical-session.state`). With both kept, `rv9-elec-regressions` and `wire-authority` pass
    72 of 72.
  - `docs/USER_GUIDE.md` and `router/index/SHA256SUMS`: mechanical.
  - `core/src/admission/mod.rs`, `daemon-adapter/internal/capsule/process.go` and
    `ui/src/App.vue` merged cleanly at this ref. e1 does not touch `admission/mod.rs`.
    The brief expected conflicts there. A newer e1 than `7883ea412` was not checked: unknown.
- **The brief's e1 features at this ref:**
  - A separate native command lane and MicroVM host agent access were not found in e1's Core or
    environment code. Unknown whether they exist on a later ref.
  - The native change found is `deferBusyFrame` (`native_busy` during demo recording).
- **Ranked semantic risks:**
  1. **High: the `serve/mod.rs` reconnect hunk.** e1 guards the `Connect` write with
     `journal_end.is_none()` and calls `resume_journal_end`. The graphical side adds
     `mark_graphical_session_unknown_at(...)?` and the notice `?`.
     - On a full journal, the graphical apply fails with Policy.
     - With G2's missing retire, the daemon is locked out, and `resume_journal_end` never
       restarts the stop drain. Capsules are left running.
     - Fix: run the graphical marking and notice only when `journal_end.is_none()`, never with
       `?`, and call `resume_journal_end` last.
  2. **Medium: Policy from the graphical deadline poll.** `poll_graphical_session_at` and
     `mark_graphical_session_unknown_at` propagate `JournalError::Policy` with `?` instead of
     taking e1's clean end. e1's headless and guest-command polls have the same gap.
  3. **Medium-low: UI graphical state after `JOURNAL_FULL`.** The host is never told. Call
     `graphicalSession?.disconnect()` in the `JOURNAL_FULL` branch of `hostBindings.js`.
  4. **Low: emergency destroy of lost capsules.** e1's Core-originated `destroy` bypasses the
     inbound fence, so it is not refused. The adapter clears `m.graphical`. Core's graphical state
     stays held after the end, by design.
  5. **Low: `native_busy` during demo recording.** It makes the post-restore capture fail, which
     settles as unknown and fails safe.
- **Not checked:** Rust and Go builds of the merged tree; whether the demo recorder can send
  input to a held VM.

## Runs

- **Go, `go test ./... -count=1` at head:** 11 packages ok; `internal/ipc` FAIL with the 6 tests
  in G1 [MEASURED]. At `b767222c4`, `internal/ipc` is ok [MEASURED].
- **Core, release, at head [MEASURED]:**
  - `graphical_session`: 17 of 17 pass.
  - `rewind_flow`: 19 of 19 pass.
  - `rewind_envelope`: 3 of 3 pass.
  - Lib tests filtered on `graphical`: 7 of 7 pass. They include the author's
    `registered_agent_can_forward_stop_for_its_held_graphical_vm`,
    `lost_after_deadline_does_not_republish_saved_unknown_event` and the notice tests.
  - `decode_envelope`: 12 of 13, FAIL (G1).
  - Full suite, `cargo test --release --no-fail-fast`: 75 test binaries, 580 passed, 3 failed
    [MEASURED].
    - 1 failure is `decode_envelope` (G1).
    - 2 are `verify::ownership_tests::foreign_uid_is_rejected`, once in the lib and once in a
      second target. That test needs `unshare --user`, and this box runs as root in a sandbox.
      Its file is unchanged since base, so it is treated as an environment failure (read). It was
      not run at base.
- **UI:** see F1 [MEASURED, sub-pass].
- **Router:** `python3 tools/router_index.py --check` on a clean head gives coverage 100% of
  3369 files [MEASURED]. This report adds one file that is not indexed. This branch is a report
  carrier, not a merge candidate.
- **Throwaways:**
  - Go: `internal/capsule/zz_audit_tmp_test.go`.
  - Core: two tests in `core/src/serve/mod.rs`.
  - UI: a probe in the scratchpad.
  - All were deleted, and `git status` was confirmed clean in the head worktree.
- **Laws:** `tools/check_laws.py --message-file` passes on the commit message.
  `--range HEAD~1..HEAD` asks for a `changes/unreleased/` fragment. The brief allows only one
  file, as for both earlier audit commits, so none is added.
- **Push:** made because the maintainer explicitly asked for it in this task. LAWS.md L6 is
  noted.

## Before any later merge

1. G1: pin the notice fixtures in the Go corpus, register them in `core/tests/decode_envelope.rs`,
   and get every CI gate green.
2. G2: send the notice with `let _ =` and retire the connection on an admission error.
3. Resolve the e1 reconnect hunk as described (risk 1).
4. N1, adapter half: map an exit-2 attach to `UNAVAILABLE` and release the slot.
5. V1: scope status and the Enable gate to the requesting tile.
6. G3: fence input after loadvm until a post-restore frame is proven.
7. Measure the 200 MB rail on a host that can run it.
8. Click proof on arm64 with the current native: visible mutation, Back, a post-restore frame
   with its delay, continued input, and verified physical closure.

## Reviewer

- **Model:** withheld from tracked files under LAWS.md L1.2; stated in the session reply.
- **Effort:**
  - The session's `effort_level` is `xhigh` (session metadata).
  - One bounded pass from about 11:37 to 12:05 UTC.
  - Two parallel sub-passes: a UI-only pass of about 12 minutes and an e1 merge pass of about
    4 minutes. F1, F4 (host), N6, N7, V1, G4 and the false-success check rest on the UI pass. The
    e1 section rests on the merge pass.

DO NOT MERGE for today's release.

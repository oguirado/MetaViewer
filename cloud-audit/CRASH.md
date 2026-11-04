# Crash consistency audit — release 0.2.6 candidate

Base: `ci/assets-a7c36e9da` at `a7c36e9`, compared with `origin/main`.
This is a report only. No product code was changed. The throwaway proofs ran from a
scratch directory outside the repository and are not committed. One temporary Go
test file was added under `daemon-adapter/internal/resourceinventory/`, run, and
deleted before the commit.

Excluded on request: `daemon-adapter/internal/capsule/slots` (being fixed elsewhere).

Legend: **PROVEN** means a throwaway test reproduced the state. **READ** means the
finding comes from reading the code only. Severity is for the 0.2.6 release:
High, Medium or Low.

## Summary

| # | Area | Finding | Severity | Confidence | Basis |
|---|------|---------|----------|------------|-------|
| C1 | ARM64 session / inventory | After any crash, the held-session marker can never be released, so every later ARM64 launch is refused | High | High | PROVEN |
| C2 | Go guest-command / rewind / headless | Reservation markers are never removed, even after a clean stop. A leftover headless marker also stops the normal adapter from starting | High (when profiles are configured) | High | READ |
| C3 | Rewind runtime | A crashed owner leaves full guest RAM images in `/dev/shm` and blocks every later rewind allocation | Medium | High | PROVEN |
| C4 | Screenshot export (Electron) | The copy is written straight to its final content-addressed name. A kill leaves a truncated `.tar` and every retry then fails with `EEXIST` | Medium | High | PROVEN |
| C5 | Program sidecars | A deleted identity's `program-binaries/<id>.json` survives a restart and comes back as a host program row | Medium | High | PROVEN |
| C6 | Layout display names | Capsule labels are never pruned. A reused profile id inherits the deleted capsule's name | Low | High | PROVEN |
| C7 | Identity Delete (`tools/mv_identity.py`) | No deleting-intent marker. An interrupted delete leaves the identity listed as normal, with a removed or partly removed profile | Medium | Medium | READ |
| C8 | Inventory ledger, Go and Python | A torn tail is refused forever and never truncated, so the session cannot be reconciled | Medium | High | PROVEN |
| C9 | Capture preferences / recent apps | Temp files leak after a kill and are never swept. Recent-apps saves have no fsync | Low | High | PROVEN (capture), READ (recent) |
| C10 | Identity recover | A kill after native release but before the admission records are unlinked leaves stale records that the next `recover` cannot clear | Low | Medium | READ |

## Findings

### C1 — ARM64 held session cannot be released after a crash (High)

Files: `tools/arm64_capsule_session.py:536-566`, `tools/arm64_capsule_reconcile.py:695-781`,
`tools/arm64_capsule_reconcile.py:469-471`, `tools/arm64_capsules.py:276-285`.

Sequence in `launch()`:
1. Take the `session.lock` flock and refuse if `held-session.json` exists (`:536`).
2. `mkdtemp` a session root in `/dev/shm` containing `home`, `store`, `native-state` and others (`:538-541`).
3. `write_bytes_new(setup.json)`, then `write_new(PLAN.json)`.
4. `write_new(held-session.json)`: `O_EXCL` on the final name, then write, fsync and directory fsync (`:554`).
5. Run the scope. Afterwards `seal_coordinator`, then `reconcile_held(release=True)` (`:563-566`).

What a kill leaves at each step:
- **Between 2 and 4:** a root in `/dev/shm` that no marker points to. No startup sweep finds it, so it stays in RAM until reboot. Nothing is leased yet, so impact is low.
- **Inside 4, after `O_EXCL` and before the write:** an empty `held-session.json`. The next launch refuses because the file exists. The reconciler refuses too: `bounded nonempty evidence required`. **PROVEN.**
- **During 5 (app, adapter or producer killed):** at least one producer never writes `producer_sealed`. `coordinator_sealed` needs all three producers sealed (`reconcile.py:464`), and release needs `complete=True`, which means coordinator sealed and every resource `closed` with no `unknown` (`:469-471`). So the session can never be released. That holds even after the reconciler proves through Docker and systemd that nothing is alive.
- **After a reboot:** `/dev/shm` is gone but the marker is in the persistent registry directory. `private_dir(held['root'])` raises `FileNotFoundError`, so release fails. **PROVEN.**

Impact: one crash makes every later ARM64 capsule launch fail with `previous session requires reconciliation`. No code path in the tree repairs this. Until reboot, signed-in profile data under `<root>/store` stays in `/dev/shm`. This conflicts with the product's crash recovery promise.

Proof output [MEASURED]:
```
empty marker (kill inside write_new) release= True -> REFUSED Refused bounded nonempty evidence required
marker after reboot (/dev/shm root gone) release= True -> REFUSED FileNotFoundError ... '/dev/shm/metaviewer-arm64-gone'
  marker still present: True
```

### C2 — Go reservation markers are never removed; headless marker blocks the normal adapter (High when configured)

Files: `daemon-adapter/internal/guestcommand/prepare.go:46,104`,
`daemon-adapter/internal/guestcommand/manager.go:92-95,315,417,448`,
`daemon-adapter/internal/guestcommand/rewind_manager.go:51-54`,
`daemon-adapter/internal/headless/manager.go:58-61,302`,
`daemon-adapter/internal/daemon/environment.go:170-174`.

Sequence in `prepare()`: write `*-reservation.json` with `status: pending` (`O_EXCL`, fsync, directory fsync), then `MkdirTemp attempt-*` and `headless-*`, then copy the bundle, `runner.py`, `python` and `launch.json`, then write `*.prepared`. Closing writes a sibling `*.closed`. Reconciling writes `*.reconcile` and then `*.closed`.

- No code in `guestcommand` or `headless` removes the base marker or the `attempt-*` and runtime directories. A repository-wide search for `os.Remove` or `RemoveAll` in these packages finds nothing outside tests.
- The startup check (`NewFromEnv`, `NewRewindFromEnv`) only checks whether the base marker exists. It never reads `*.closed`. So a **clean** stop leaves the same state as a crash, and the next adapter start refuses with `previous reservation requires reconciliation`.
- A kill inside `writeNew` after `O_EXCL` leaves an empty marker. It is treated the same way (fail-closed).
- `headless.NewFromEnv()` is also called from the **normal** graphical runtime (`environment.go:170`). When `MV_HEADLESS_PROFILE` is set, a leftover marker turns into `configuration("headless host profile: ...")` and the whole adapter fails to start, not only the headless feature.
- `launch.json` keeps the core `session_id` in the persistent state root indefinitely.

Impact: these features work once per state root. After that, starting needs manual deletion with no tool or documentation in the tree. Basis: READ. Constructing the managers needs `verifyGuardian` (systemd), which is not available here.

### C3 — Rewind owner crash strands guest RAM images and blocks rewind (Medium)

Files: `daemon-adapter/rewind_runtime/native.py:106-114,130-133,185-199,270-291`.
`daemon-adapter/rewind_runtime/SCOPE.md:21` documents that a crash or reconciliation guardian "is still required before deployment".

Sequence: flock `.rewind-owner.lock`, require the base to contain only that lock, `mkdtemp rewind-*`, create the fsynced ledger, then for each mark: snapshot `point-*.state` and `point-*.mem`. A full guest RAM image is 256 MiB [CITED `native.py:138`]. Only `_stop()` runs `rmtree` on the root.

- A SIGKILL anywhere after `mkdtemp` leaves `rewind-*/` in place, with the ledger, `fc`, the kernel and any `point-*.mem` files holding full guest memory, including whatever secrets the guest held. These stay in `/dev/shm` until reboot.
- The next `allocate()` refuses `prior runtime requires reconciliation`, and no reconciler exists. **PROVEN.**
- `finalize_mark` swallows `OSError` when unlinking the victim (`:207`), so a retired point can outlive its eviction. It stays tracked until Stop, and Stop is the only cleanup.
- The core side (`core/src/rewind_flow.rs`, `core/src/serve/rewind.rs`) keeps points only in memory. After a core restart, the on-disk points are orphaned with no index.

Proof output [MEASURED]:
```
REFUSED: prior runtime requires reconciliation
leftover still present: ['.rewind-owner.lock', 'point-x.mem', 'rewind-abc123']
```

### C4 — Screenshot export copy: a torn final file blocks every retry (Medium)

File: `ui/electron/capturePreferences.js:55-72`, called from `ui/electron/captureBridge.js:131-147` (auto-save on stop, and manual export).

Sequence: verify the source in the grant folder, `open(<folder>/<id>-<sha256>.tar, O_CREAT|O_EXCL)`, `writeFile`, `fsync`, check the folder identity, `dir.sync()`. Cleanup of a partial file happens only in `finally`, which does not run on SIGKILL or power loss.

- A kill between `open` and `fsync` leaves a **truncated file under its final name**, and that name states the full file's sha256. A consumer that trusts the name receives a corrupt archive.
- On the next export of the same capture, `O_EXCL` fails with `EEXIST`. `captureBridge` maps that to `DESTINATION_UNAVAILABLE` permanently, and nothing at startup repairs it. **PROVEN.**
- The partial file is private screen content left in a user folder. It has mode 0600.
- Contrast: core's own export (`core/src/record/capture/export.rs:127-170`, unchanged since main) uses an exclusive temporary, then fsync, then `hard_link` to the final name. The new Electron copy should follow the same pattern.

Proof output [MEASURED]:
```
RETRY FAILS: EEXIST
target bytes 100 of 4096 ; name claims sha d349a508c76f
```

### C5 — Program sidecar brings back a deleted identity (Medium)

Files: `ui/electron/programBinaries.js:13-19,42-44,57-70`, `ui/electron/roleHost.js:646-651`.

`reconcile(rows)` forgets a sidecar only for a profile in the in-memory `witnessed` set, which is filled during the current process run. `hostProfiles()` lists every sidecar with `hostXpra: true`, and `programs()` merges those rows with the identity list.

- If an identity is deleted while the UI is down, or the UI is killed before its next `programs()` call, the new process never witnessed it. Its `<id>.json` is never removed, and the deleted program, including `identityBound: true`, shows up again in the program list. **PROVEN.**
- `copyWith` writes the destination sidecar after core confirms the copy. A kill in between leaves a copied profile without its sidecar. Low impact.

Proof output [MEASURED]:
```
files after restart reconcile: [ 'work-mail.json' ]
hostProfiles (rows shown to UI): [ { id: 'work-mail', browser: 'program' } ]
```

### C6 — Layout display names outlive capsule deletion (Low)

Files: `ui/electron/desktopLayout.js:171-181`, `ui/src/wall/DesktopWorkspace.vue:295-306,321-325`.

`renameCapsule` stores `state.labels[profile_id || id]`. Both `forgetSurface` and the projection prune delete `assignments[id]` only, so `labels` (and `identityCells`) are never pruned. The label is persisted through `writeAtomic`. Profile ids are user-chosen slugs (`tools/mv_identity.py:45`) and can be reused. A new identity with the same id inherits the old name, which may describe the account. **PROVEN** with the real `desktopLayout.js` functions.
The save path (`ui/electron/main.js:1748-1759`, unchanged) uses temp, fsync and rename but does not fsync the directory. After power loss, the previous labels can come back. Low impact.

### C7 — Identity Delete has no intent marker (Medium, same family as the slot bug)

File: `tools/mv_identity.py:445-478`.

Sequence under the `<id>.guard` flock: check the lease is inactive, run a privileged `docker run --rm ... rm -rf /profiles/<id>`, then `metadata.unlink()`, then `record.unlink()`. Nothing records "deleting".
- A kill during the helper run: the Docker container keeps running on its own, but if the host or daemon dies, `rm -rf` stops part-way. The metadata survives, so after restart the identity is listed and launchable as an ordinary identity, with a **partly deleted browser profile**. Surviving cookies or tokens come back with it.
- A kill after the helper and before `metadata.unlink()`: the identity comes back with an empty profile, and the UI gives no sign that a delete was interrupted. A retry works (the comment at `:467-468`), but nothing prompts the user to retry.
- Leftover `locks/profile-helpers/*.cid` and `*.json` receipts are not swept.
Basis: READ (needs Docker).

### C8 — Torn inventory tail is fatal and never repaired (Medium)

Files: `daemon-adapter/internal/resourceinventory/ledger.go:195-197,394-408`, `tools/arm64_capsule_reconcile.py:292-305,531-539`.

Both writers append a row of up to 64 KiB [CITED `ledger.go:26`] with a write loop, then fsync. A partial write can happen on ENOSPC, on a fatal signal during a multi-page write, or on power loss. Go marks the producer poisoned but leaves the bytes. Every later reader (`parseHistory`, `read_journal`) refuses `torn or oversized journal` or `partial inventory tail`. No code truncates back to the last complete newline. The result is the C1 end state: the held session is never released. **PROVEN** (Go and Python).

### C9 — Temp files leak after a kill (Low)

- `ui/electron/capturePreferences.js:40-44`: `.capture-<uuid>` is left after a kill and later saves do not sweep it. **PROVEN** (`[ '.capture-deadbeef', 'capture.json' ]`). It holds folder paths only. The write itself is correct: file fsync, rename, directory fsync.
- `ui/electron/desktopApplications.js:93-97`: `.recent-<uuid>` is written with no fsync, and a failed `rename` (not only a kill) leaves it behind. There is no directory fsync. It holds recent app ids only. READ.
- `ui/electron/programBinaries.js:78`: `.<uuid>` temp is left after a kill. READ.

### C10 — Identity recover kill window (Low)

File: `tools/mv_identity.py:789-821`. Order: native `release`, Docker and view absence checks, unlink admission records, fsync. A kill after `release` leaves the lease inactive but the admission records still present. A second `recover` raises `HOLDER_MISMATCH` before it reaches the unlink, so the records stay until something else (`daemon/ram_admission.go:321-348`, unchanged) prunes them. READ.

## Coverage

Covered (new or changed since main):
- `ui/electron/capturePreferences.js`, the `captureBridge.js` auto-save and export path, and core export (read for contrast only).
- `ui/electron/desktopLayout.js` labels and identity cells, `DesktopWorkspace.vue` persist and prune, the layout save in `main.js`.
- `ui/src/settings/settingsHost.js`: only the default scheme changed, so no persistence change.
- `daemon-adapter/rewind_runtime/{native,controller}.py`, the `tools/rewind_runner.py` journal, `core/src/rewind_flow.rs` (no disk state).
- `daemon-adapter/internal/guestcommand/{prepare,manager,rewind_manager}.go`, `internal/headless/manager.go`, `internal/daemon/environment.go` wiring.
- `daemon-adapter/internal/resourceinventory/ledger.go`, `tools/arm64_capsule_reconcile.py`, `tools/arm64_capsule_session.py`.
- `tools/mv_identity.py` delete, recovery, recover and release; `ui/electron/roleHost.js` release-identity; `ui/electron/programBinaries.js`; `ui/electron/desktopApplications.js`.

Not covered:
- `daemon-adapter/internal/capsule/slots*` (excluded on request).
- `daemon-adapter/guest_command_runtime/storage.py`, `guest-command-broker` (Rust), `core/src/headless.rs`, `core/src/admission/mod.rs`, `agents/` SDK.
- `daemon-adapter/internal/resourceinventory/native_metadata.go` and `config.go` open path (only the ledger append was examined).
- The internal sweep of core recording export temporaries (unchanged code).
- No end-to-end crash runs: there is no display stack, Docker daemon, KVM or systemd here. Kill windows were reproduced by building the post-kill state directly.

Model: Claude Opus 5.5 (`claude-opus-5-5`). Effort: low.

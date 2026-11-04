# ARM64 MicroVM rewind

## What does Rewind do, and what does it not undo?

Rewind restores a MicroVM's guest RAM and machine state to a checkpoint you marked. It does not undo network requests, host files, or the journal.

Answers: what Rewind restores; what it cannot reverse; how long checkpoints live.

- Flow: Add capsule → MicroVM → run commands → **Mark** a state → **Back** to it. The command header shows a double-left rewind icon and a short list of timed checkpoints.
- Profile: immutable boot image plus a mutable RAM workspace. Checkpoints hold full guest memory and machine state, are local, and disappear when the owning session closes. They are not save slots.
- Not enabled: writable block disks and graphical desktops.
- A completed network request or any change outside the guest stays. Restoring guest memory cannot reverse it.
- A failed restore keeps the last verified checkpoint. A new manual restore is offered only after the failed native attempt is confirmed closed. Uncertainty never triggers retries or command replay.

Code: core routing is `core/src/serve/rewind.rs` and `core/src/rewind_flow.rs`; the guest side is `daemon-adapter/rewind_runtime/`. Why Rewind is limited to guest state: [WHY_CAPSULES.md#rewind](WHY_CAPSULES.md#rewind).

## Live result

Live Rewind demonstrations are maintainer-reported. Raw session receipts are not
published in this checkout, so this page does not claim independent timing or
packaged-runtime qualification.

Answers: has Rewind been demonstrated, and what can a reader reproduce?

Public tests can check the contracts, state transitions and injected failure
paths. A live result needs the matching protected artifacts and a recorded
Create, command, Mark, Back and Stop cycle, including cleanup evidence. Source
checks alone do not establish those runtime results. Publicly reproducible live
measurements are **ABSENT — do not invent**.

## What do Pause, Resume, Mark, Back and Stop do?

Each is one operation the core fences; commands stay blocked while an operation is uncertain.

Answers: what each control does; who holds authority; what the ring holds.

- **Pause** waits for the guest command channel to close and quiesce, then pauses the native machine. A running guest is paused before any restore.
- **Resume** opens a new guest session and reseeds it before accepting commands.
- **Mark** seals a full checkpoint in the protected RAM ring. The ring is capped at 1 GiB [CITED: `daemon-adapter/rewind_runtime/native.py`]. Rotation replaces only an unreferenced point, after the new one is verified. Memory of a restored machine stays held until that machine closes.
- **Back** lists points with their host-observed age (unknown age shows as unavailable). The guest counter shown is the last confirmed guest observation, not a frontend timer.
- **Stop** stays available for cleanup, including after uncertain operations. Ownership is released only after native closure is confirmed.

Authority stays outside the restored memory: request history, command generation and restore authority do not travel backwards. UI and SDK share one authenticated connection and discard stale results. Checkpoint paths, entropy and boot tokens never cross to the renderer.

## What does Rewind need, and what is not provided?

It needs a protected, hash-checked host profile, an admitted local ARM64/KVM backend, verified kernel and broker artifacts, and the application guardian. Availability follows reported capabilities. Start it with `--rewind` ([ARM64_CAPSULE_SETUP.md#rewind-in-the-normal-wall](ARM64_CAPSULE_SETUP.md#rewind-in-the-normal-wall)).

Answers: what must exist before Rewind is offered; what the repository does not ship; which tests count as evidence.

- The profile preparer is a developer tool, not an image installer. No download/import catalogue or turnkey end-user flow is claimed.
- No VM image or kernel binary is in this repository. Private Wender, Vision and OpenSuperficies sources and images stay external.
- The MicroVM header slot is `{capabilities, onRestore(point_id)}`. `capabilities.back` comes from validated current snapshots; each click builds one restore request from the current target. The slot gives the frontend no native authority.
- A developer profile must name the application guardian cgroup that exists before adapter startup. Runtime roots must fit the backend's Unix-socket path limit; shorten the private RAM root rather than relaxing the limit.
- Tests of contracts, reducers and fault injection are source evidence only. A feature counts as usable in the packaged app after a live Create, command, Mark, Back and Stop cycle shows the visible behaviour and closed resources.

# ARM64 MicroVM rewind

Core routing for Rewind is in this tree (`core/src/serve/rewind.rs`, `core/src/rewind_flow.rs`). An earlier developer-controlled ARM64 packaged application at commit `8b44747c83f0ad760aed2550277aa88cd417fb30` completed real Create, guest commands, Mark, header Back restoration, Pause, Resume and confirmed Stop with closed resources [MEASURED]. Normal end-user setup, the next integrated package, whole gate and hosted CI remain separate acceptance gates.

The goal is to add a MicroVM from **Add capsule**, work inside its command console, mark a known state and return to it with **Back**. The MicroVM command header provides the classic double-left rewind icon and a short list of timed checkpoints. Its optional header slot exposes `{capabilities, onRestore(point_id)}` so the shared frontend can place the same controls without acquiring native authority. A selected checkpoint requests one return operation; a running guest is explicitly paused first, and restoration proceeds only after that pause is confirmed. Commands remain fenced while the operation is uncertain.

The ARM64 rewind profile uses an immutable boot image and a mutable RAM workspace. Checkpoints contain full guest memory and machine state. They are local, disposable and disappear when the owning session closes. They are not durable save slots. Writable block disks, graphical Firecracker desktops and x64 rewind are not enabled by this profile.

External effects are not rewound. A completed network request or a change outside the guest cannot be reversed by restoring guest memory. A failed restore retains the last verified checkpoint. A new manual restore is offered only after the failed native attempt is confirmed closed; uncertainty does not trigger retries or replay commands.

## Live result

Answers: has Rewind been run; how long does Back take; does replay verify a Rewind session.

| Observation | Tag |
| --- | --- |
| Three files created in the guest, deleted, then **Back** restored all three | [MEASURED: operator live run on ARM64 MicroVM, 4 Nov 2026] |
| Restore time shown by the app: 387.5 ms | [MEASURED: same run] |
| `mv-replay` exit 0 on that session journal | [MEASURED: same run] |
| `mv-replay` with relative, symlinked or copied session paths gives `Invalid`; pass absolute real paths of the original session | [MEASURED: same run] |

The raw receipt of that run is not in this repository. Why rewind is restricted to guest state: [WHY_CAPSULES.md#rewind](WHY_CAPSULES.md#rewind).

## Controls and evidence

- Pause waits for the guest command channel to close and reach a quiescent state before pausing the native machine.
- Resume establishes a new guest session and reseeds it before accepting commands.
- Mark seals a full checkpoint in the protected RAM ring. Rotation replaces only an unreferenced point after the new point is verified. Memory used by a restored machine remains held until that machine closes.
- Back lists available points with their host-observed age. Unknown age is displayed as unavailable. The displayed guest counter is the last confirmed guest observation; it is not a timer fabricated by the frontend.
- Stop remains available for cleanup, including uncertain operations. Ownership is released only after native closure is confirmed.

The core retains authority outside the restored memory: request history, command generation and restore authority do not travel backwards. The UI and SDK use the same authenticated connection and must discard stale results. Checkpoint paths, entropy and boot tokens do not cross the renderer interface.

## Preparation and integration boundary

The feature requires a protected, hash-checked host profile, an admitted local ARM64/KVM backend, verified kernel and broker artifacts, and the application guardian. Availability is capability-driven and absent on x64. Existing graphical VM and other capsule paths keep their own setup and contracts.

The current profile preparer is a developer tool, not a turnkey image installer. Download/import catalogues and a normal end-user setup flow are not claimed by the source tests. Private Wender, Vision and OpenSuperficies implementations remain external; their source and private images are not included in this public repository. No VM image or kernel binary is added by this feature branch.

The shared native-surface header remains owned by the frontend. MicroVM workloads use the agreed command-header slot, with `capabilities.back` projected from validated current snapshots and one restore action built from the current target on each click. The presentation router uses the kit’s existing CapsulePanel and stable session identity; floating, hiding and showing a tile do not change its workload identity. The timeline retains Pause, Resume and Mark. Both header and timeline were observed in that bounded packaged proof; the next integrated application requires its own acceptance.

A developer profile must name the exact application guardian cgroup that exists before adapter startup. The native runner verifies its separate service cgroup and replaces the template path before constructing the controller. Runtime roots must fit the backend’s existing Unix-socket path limit; shortening a fresh private RAM root is required rather than relaxing that limit.

Tests of contracts, state reducers and fault injection are source evidence. A feature is usable in the packaged application only after a separate live Create, command, checkpoint, restore and Stop cycle confirms its visible behavior and closed resources.

# Adapter dossier: native lifecycle, input and capture

The Go adapter connects core requests to native lifecycle, input and capture
operations. This dossier locates public code; it does not establish private
executor internals or live platform qualification.

## What does the adapter own?

The adapter validates native targets and translates supported requests into
executor operations. The Rust core owns admission; an adapter reply does not
replace the core's decision or verification.

Answers: why is there a separate adapter, and where is its entry point?

Start at `daemon-adapter/cmd/mv-daemon-adapter/main.go` and
`daemon-adapter/internal/daemon/environment.go`. The latter loads the explicit
runtime configuration and connects to the core. The execution seam is
`daemon-adapter/internal/daemon/dispatch.go` [CITED: these public source files].

The private native programs are separate processes under the boundary described
in [NOTICE-EVALUATION.md](../../NOTICE-EVALUATION.md). A process boundary alone
does not prove containment against a compromised process with the same host
privileges.

## Which execution boundary does each kind use?

A native kind selects the workload route. A surface identity and a display do
not by themselves establish isolation.

Answers: which adapter routes run on the host, in containers or in guests?

| Public/native mapping | Workload boundary | Source |
| --- | --- | --- |
| `browser` / `browser` | Private browser-container executor | `daemon-adapter/internal/capsule/manager.go:395` |
| `desktop_capsule` / `program` | Private program-container executor | `daemon-adapter/internal/capsule/manager.go:400` |
| `desktop_capsule` / `host-xpra` | Host program; **not isolated** | `daemon-adapter/internal/capsule/manager.go:805` |
| `desktop_capsule` / `host-window` | Attached host X11 window; **not isolated** | `daemon-adapter/internal/capsule/manager.go:833` |
| `vm` / `vm` | Configured graphical guest executor | `daemon-adapter/internal/capsule/manager.go:405` |
| MicroVM command route | Separate guest-command lifecycle | `core/src/serve/guest_command.rs` |

[CITED: paths in the table]. The launcher names and prerequisites are explained
in [WHY_CAPSULES.md](../WHY_CAPSULES.md). Internal schema kinds are not additional
user-facing isolation guarantees.

## Where should I inspect a behavior?

Inspect configuration first, then the handler and native operation named by the
request. Do not diagnose a failure from a display label alone.

Answers: which files own lifecycle, frames, input and persistent data?

| Concern | Entry point |
| --- | --- |
| Environment, modes and core connection | `daemon-adapter/internal/daemon/environment.go` |
| Initial create and compensating cleanup | `daemon-adapter/internal/daemon/dispatch.go` |
| Profiles, lifecycle and input routing | `daemon-adapter/internal/capsule/manager.go` |
| Host program and existing window | `daemon-adapter/internal/capsule/host_xpra.go`, `host_window.go` |
| Frame publication | `daemon-adapter/internal/frames/publisher.go` |
| Continuous capture and liveness | `daemon-adapter/internal/frames/subscriptions.go` |
| Persistent profile slots | `daemon-adapter/internal/capsule/slots/store.go` |
| IPC policy and connection handling | `daemon-adapter/internal/ipc/` |
| Guest command runtime | `daemon-adapter/guest_command_runtime/` |
| Guest restore runtime | `daemon-adapter/rewind_runtime/` |

[CITED: paths in the table]. Use the repository router to find the governing
contract and tests, then inspect the returned code before changing it.

## What happens if creation or destruction is uncertain?

The adapter preserves the native identity and custody when it cannot prove
cleanup. Missing pixels or a closed client connection do not establish that a
workload is gone.

Answers: why can a profile remain unavailable after a failed start?

The manager checks profile, kind and geometry before native start [CITED:
`daemon-adapter/internal/capsule/manager.go:818`]. Agent-mode creation captures
an initial frame. A capture failure triggers bounded compensating destruction;
`CreationError` retains the committed surface identity and cleanup result
[CITED: `daemon-adapter/internal/daemon/dispatch.go:21`,
`daemon-adapter/internal/daemon/dispatch.go:73`].

Lost bindings retain capacity and profile custody until a verified stop releases
them [CITED: `daemon-adapter/internal/capsule/manager.go:862`]. This costs
availability during uncertainty, but avoids treating an unproved stop as a free
profile.

## How is input constrained after core admission?

The adapter still checks the live binding, origin, control state and input
permit before lowering an action to a native call.

Answers: can an admitted proposal bypass native target checks?

The input handler refuses an unknown or inactive surface, draining state,
wrong control origin, pending work and a reused permit [CITED:
`daemon-adapter/internal/capsule/manager.go:1491`]. Host-window and host-program
input are routed to the host-window implementation; that remains real host
input [CITED: `daemon-adapter/internal/capsule/manager.go:1542`].

The core independently checks frame identity, owner, lease and budget at
admission and dispatch [CITED: `core/src/admission/mod.rs:1092`,
`core/src/admission/mod.rs:1307`]. None of these checks freezes the application
between capture and delivery. If delivery is uncertain, observe and reconcile;
do not replay a whole step merely because its final result was missing.

## When does a frame become usable evidence?

Publication supplies immutable frame metadata; the core and UI must validate
its evidence before using it. A path-shaped string is not proof of valid pixels.

Answers: where should I look for stale frames or capture failures?

The publisher is `daemon-adapter/internal/frames/publisher.go`; continuous
capture is in `daemon-adapter/internal/frames/subscriptions.go`. Core witness
handling is in `core/src/journal/mod.rs` and presentation verification in
`ui/electron/frameReader.js` [CITED: these source files].

Distinguish native capture failure, publication failure and a core
`STALE_FRAME` refusal. They are different stages, so a frozen tile does not
identify a unique cause. Preserve the exact diagnostic and inspect the handler.

## What do stored-data slots preserve?

Slots preserve compatible stopped profile data, potentially including
credentials. They do not preserve live processes or general guest state.

Answers: why can save, load or copy be refused?

The slot store requires human confirmation, refuses protected identities and
checks custody before operating [CITED:
`daemon-adapter/internal/capsule/slots/store.go:274`]. Load checks matching kind,
architecture and image [CITED:
`daemon-adapter/internal/capsule/slots/store.go:647`]. Keep payloads private;
slot portability is constrained by those checks.

## How do guest commands and Rewind differ from graphical input?

Guest commands and Rewind use their own authenticated lifecycle and state
machines. They are not keyboard input to a graphical tile.

Answers: where is the guest path, and what does restore leave unchanged?

The core routes commands in `core/src/serve/guest_command.rs` and restore
operations in `core/src/serve/rewind.rs`. The host runtimes are under
`daemon-adapter/guest_command_runtime/` and `daemon-adapter/rewind_runtime/`
[CITED: these source files].

Rewind restores guest state, not external effects, host state or the core's
history. Availability depends on supported host architecture and protected
assets. Use [ARM64_CAPSULE_SETUP.md](../ARM64_CAPSULE_SETUP.md) and
[ARM64_MICROVM_REWIND.md](../ARM64_MICROVM_REWIND.md) for that path.

## How should adapter behavior be verified?

Read the owning handler and run its focused tests. A fake native executor can
verify public handling without establishing that a private runtime obeys it.

Answers: what tests are relevant, and what remains unproved?

For lifecycle and input, inspect `daemon-adapter/internal/capsule/` tests; for
publication and IPC, inspect `daemon-adapter/internal/frames/` and
`daemon-adapter/internal/ipc/`. Run the matching Go package tests from
`daemon-adapter`, using the bounded execution scope in
[REFERENCE.md](../REFERENCE.md#oracle).

This documentation change does not run native workloads. Live results remain
maintainer-reported where receipts are unpublished. Startup latency, resident
memory and private-runtime containment require separate evidence:
**ABSENT — do not invent** where it is unavailable.

The mandate of this dossier is limited to the cited public source and explicitly
attributed reports.

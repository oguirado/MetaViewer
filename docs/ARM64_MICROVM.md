# ARM64 MicroVM capsule

## Current status

This page covers only the original fixed-job mode (`headless_*`), which stays as its own mode. The MicroVM that **Add capsule** offers after an `--arm64` start runs sequential shell commands ([ARM64_GUEST_COMMANDS.md](ARM64_GUEST_COMMANDS.md)) and, with `--rewind`, adds Mark and Back ([ARM64_MICROVM_REWIND.md](ARM64_MICROVM_REWIND.md)). A plain start offers no MicroVM. Setup: [ARM64_CAPSULE_SETUP.md](ARM64_CAPSULE_SETUP.md). Why the capsule exists and what it contains: [WHY_CAPSULES.md#microvm](WHY_CAPSULES.md#microvm).

Answers: which MicroVM document is current; can the MicroVM run shell commands; does it have Rewind.

## What does the fixed-job mode do?

It runs one bounded sum-of-squares job per capsule, then stops. The SDK and contracts expose only that job (`run(n)`), with no command, shell or graphical input field [CITED: `agents/metaviewer_agents/headless.py`].

Answers: what the fixed-job entry exposes; which contracts and SDK class drive it; what a timeout means.

- Flow: Add capsule → ARM64 MicroVM → Create → Run fixed command → Stop capsule. The panel shows state from the authenticated core connection and the checked result from the guest.
- Backend: opt-in Firecracker on Linux ARM64.
- Python SDK: `metaviewer_agents.headless.HeadlessSession` with `create()`, `run(n)` and `stop()` [CITED: `agents/metaviewer_agents/headless.py`]. The agent needs its registered core identity.
- Contracts: `headless_request/v0.2`, `headless_event/v0.2`, `headless_session/v0.2`. They carry operation identity, workload generation, ownership and unknown outcomes.
- A timeout consumes the attempted operation. It does not authorize a retry and does not prove the guest stopped. A stopped state is delivered only after the controller and its owned process have closed.

## How is the fixed-job mode configured?

It needs `MV_HEADLESS_ONLY=1` and a valid private `MV_HEADLESS_PROFILE`; bad configuration refuses startup instead of falling back to a graphical capsule.

Answers: which variables enable the fixed-job entry; what the host must supply; who owns cleanup.

- `MV_HEADLESS_AGENT_INSTANCE` binds the protected profile to the registered agent. `MV_HEADLESS_GUARDIAN_UNIT`, if set, must match the profile [CITED: `daemon-adapter/internal/headless/manager.go`].
- `daemon-adapter/HEADLESS.md` specifies the profile and controller interface. The operator supplies the pinned controller sources, a verified Python, an ARM64 Firecracker binary, a compatible guest kernel and the guest init. Nothing is downloaded or embedded in the app.
- The daemon starts a dedicated service under the configured guardian with bounded memory, CPU, process count and lifetime. The controller checks KVM and the limits before creating a guest.
- Stop is limited to the exact owned process identity. Unresolved cleanup stays uncertain.
- Kernel and guest-image redistribution need their own provenance and licence review ([ARM64_CAPSULE_ASSET_NOTICES.md](ARM64_CAPSULE_ASSET_NOTICES.md)).

## What is not proved?

Source tests alone do not show a working packaged UI. Acceptance needs a UI create, a guest-produced checked result, a UI Stop, and independent confirmation that the guest and service are closed.

Answers: what evidence is still required; which features this page does not promise.

Graphical transport, image import and any other architecture are not provided by this entry.

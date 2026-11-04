# ARM64 MicroVM capsule

## Current status

Answers: which MicroVM document is current; can the MicroVM run shell commands; does it have Rewind.

This page describes the original fixed-job (`headless_*`) mode, which remains as its own mode. The MicroVM offered by **Add capsule** after `--arm64` start runs sequential shell commands ([ARM64_GUEST_COMMANDS.md](ARM64_GUEST_COMMANDS.md)) and, with `--rewind`, Mark and Back ([ARM64_MICROVM_REWIND.md](ARM64_MICROVM_REWIND.md)). Plain start offers no MicroVM; there is no x64 MicroVM. Setup: [ARM64_CAPSULE_SETUP.md](ARM64_CAPSULE_SETUP.md). Why a MicroVM capsule and what it isolates: [WHY_CAPSULES.md#microvm](WHY_CAPSULES.md#microvm).

The initial implementation is an opt-in Firecracker backend for Linux ARM64. The product flow is Add capsule → ARM64 MicroVM → Create → Run fixed command → Stop capsule. The panel displays the state returned through the authenticated core connection and the checked result received from the guest.

## Current boundary

The guest supports one bounded sum-of-squares job per capsule [TARGET]. It has no graphical desktop, general shell, SSH service, network interface, or arbitrary command execution. The Python SDK exposes the same typed lifecycle through `metaviewer_agents.headless.HeadlessSession`; an external agent must use its registered core identity.

The public contracts are `headless_request/v0.2`, `headless_event/v0.2`, and `headless_session/v0.2`. They retain operation identity, workload generation, ownership and unknown outcomes. A timeout consumes the attempted operation. It does not authorize a retry or prove that a guest was stopped. A stopped state is delivered only after the controller and its owned process have closed.

## Host configuration

The entry is exposed only with explicit `MV_HEADLESS_ONLY=1` and a valid private `MV_HEADLESS_PROFILE`. `MV_HEADLESS_AGENT_INSTANCE` binds the protected profile to the registered agent. `MV_HEADLESS_GUARDIAN_UNIT`, if provided, must match that profile. Invalid configuration refuses startup rather than falling back to a graphical capsule.

`daemon-adapter/HEADLESS.md` specifies the protected deployment profile and controller interface. The profile supplies pinned controller sources, a verified Python interpreter, an ARM64 Firecracker executable, a compatible guest kernel and the minimal guest init. These artifacts are supplied by the host operator; they are not downloaded implicitly or embedded in the application binary. Kernel and guest-image redistribution require their own provenance and licensing review.

The daemon launches a dedicated service under the configured guardian, with bounded memory, CPU, process count and lifetime. The controller verifies KVM support and the resource limits before creating a guest. Stop is restricted to the exact owned process identity, and unresolved cleanup remains uncertain.

## Planned broader capsule flow

The intended later flow adds architecture, VM or MicroVM type, compatible image and admitted resources to the capsule selection. Graphical transport, general terminal commands, image import and x64 backends each require their own implementation and actual lifecycle tests. Their availability must not be inferred from this ARM64 fixed-job entry.

The local source candidate and unit tests alone do not certify a packaged UI lifecycle. Acceptance requires an actual UI creation, a guest-produced checked result, UI Stop, and independent confirmation that the owned guest and service are closed.

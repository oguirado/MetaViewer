# VM and MicroVM roadmap

This document records the agreed direction and the current limits of VM capsules. It is a roadmap, not a declaration that every backend, image or mode is available. The graphical VM source descends from revision `07f2ada1b8011c78d046b665b3a0e823b80372fa`. Later owned episodes established manual ARM64 VM creation/frame/stop and fixed-job MicroVM creation/result/stop from the interface. Those tests do not mean every installed package contains or enables the relevant profiles.

The [ARM64 general-command candidate](docs/ARM64_GUEST_COMMANDS.md) has independently reviewed backend, configured packaged UI and SDK command/stop episodes. The next integration connects graphical VM and the visible MicroVM command console to ordinary Add capsule with [verified local setup](docs/ARM64_CAPSULE_SETUP.md). The new setup, transport and package require fresh acceptance before release; historical configured episodes do not prove the new package. General image import, graphical MicroVM, interactive PTY/SSH and save slots remain outside this acceptance.

## Current implementation and evidence

The current VM creation path uses the existing `createSurface({kind: 'vm'})` selector. The host chooses an eligible configured profile and owns its image, program and path configuration. The renderer cannot supply those values. The ordinary browser call remains `createSurface()` with no selector. VM creation reuses the existing `createSurface` method and channel. A separate read-only `authority.vmAvailable` boolean query uses `metaviewer:authority.vmAvailable`; it reports host capability without granting creation authority. See [authority admission](ui/electron/authorityWire.js), [preload validation](ui/electron/preload.js), [profile selection](ui/electron/profilePicker.js), and [creation regressions](ui/test/vm-capsule-open.test.js).

The admitted source template is an ARM64 graphical Linux VM using `notepad-vm`. The scoped graphical episode is complete: direct visual inspection observed the guest editor on the actual RoleSurface canvas, and the verified core-frame and owned teardown evidence received independent review. Core destruction and the absence of the owned application/native processes and control groups were corroborated. The visual observation was not an automated optical acceptance predicate.

The proposed typing action became stale as verified frames advanced and was refused before dispatch; no guest input was attempted and no retry ran. Guest input, semantic editing and VM AI planning therefore remain unproved. The graphical episode does not establish general image compatibility or every launch route. In particular, automatic boot is not evidence that the user clicked the VM creation control.

VM role status now resolves the configured VM profile while retaining the actual core identity, role and ownership checks. Unknown, malformed or foreign surfaces are refused. See [role authority](ui/electron/roleHost.js) and [role regressions](ui/test/vm-role-status.test.js). [RoleSurface](ui/src/surfaces/RoleSurface.vue) mounts the normal [SurfaceCanvas](ui/src/surfaces/SurfaceCanvas.vue) path after admitted status. Frames still pass through the verified [frame delivery path](ui/src/frames/framePortRouter.js).

The native frame-pair path admits VM frames with identity and freshness checks; see [ring source](daemon-adapter/internal/frames/ringsource.go) and [VM pair tests](daemon-adapter/internal/frames/vm_pair_test.go). Guest `DISPLAY` through the host X11 display transport remains unsupported, as enforced by the [VM display refusal test](daemon-adapter/internal/frames/displaytap_vm_test.go). The verified frame path must not be confused with generic display capture support.

## Proposed launch experience

The intended flow is:

**New capsule → VM or MicroVM → compatible installed image / import image → Desktop or Terminal → Start.**

This is a proposed expansion beyond the current configured VM template. The image step should show compatibility and provenance before selection. Import must validate a supported image-pack manifest; it must not imply that any arbitrary disk image becomes a working capsule.

Before Start, the UI should show requested CPU, RAM and disk resources, the image architecture, the selected backend and the verified host prerequisites. Host admission must check the current capacity again before creation. Only tested modes for that exact image/backend/architecture combination should be offered. Unsupported combinations should explain the missing prerequisite instead of falling back to a browser or another backend.

Desktop means a verified graphical frame path. Terminal means a separately admitted terminal or headless adapter and lifecycle contract; it is not inferred from a Linux image having a shell. Generic import, a general mode picker and headless jobs are not implemented or validated by the current VM selector.

## Acceptance matrix

Each row requires its own image version, host prerequisites and evidence. ARM64 and x64 are separate native targets; x64 is also called AMD64.

| Architecture | Backend | Mode | Current boundary | Next acceptance gate |
| --- | --- | --- | --- | --- |
| ARM64 | Ordinary VM | Desktop | Configured template; manual UI creation, frame delivery and owned stop independently reviewed | Enable the tested profile in the delivered package; guest input still needs its own acceptance |
| ARM64 | Ordinary VM | Terminal | Proposed; no general terminal/headless adapter proof | Define adapter contract, then prove session, output, cancellation and teardown |
| x64 | Ordinary VM | Desktop | Runtime unproved; inspected hosts currently return `ENODEV` from the KVM API | Establish usable host virtualization, then validate a native image and the full capsule lifecycle |
| x64 | Ordinary VM | Terminal | Runtime and adapter unproved; same host blocker | Resolve host prerequisite and validate terminal lifecycle independently |
| ARM64 | MicroVM | Desktop | Backend, image integration and graphical mode unproved | Select and validate a backend recipe plus guest capture/input integration |
| ARM64 | MicroVM | Terminal | Fixed-job UI lifecycle reviewed; general commands, file persistence, stderr/exit, cancel, timeout and stop observed in a separate real backend episode | Complete general-command SDK and packaged UI acceptance, then integrate the candidate |
| x64 | MicroVM | Desktop | Unproved; inspected host KVM blocker also applies | Resolve host prerequisite and prove backend/image/graphical integration |
| x64 | MicroVM | Terminal | Unproved; inspected host KVM blocker also applies | Resolve host prerequisite and prove backend/image/terminal integration |

More downloaded images alone cannot resolve the current x64 KVM failure. This roadmap authorizes no host package installation, virtualization setting change, network change or firewall change.

## Catalog and image-pack boundary

Keep versioned catalog metadata, backend recipes and adapters in source control. Store large image packs externally with immutable hashes, licenses and provenance. A pack must identify its architecture, supported backend and modes, guest agent version, required host capabilities and reproducible preparation recipe. Verify those facts before distribution and again when admitting an import. A raw cloud image or demonstration root filesystem is an input to integration, not a ready MetaViewer capsule.

A compatible guest agent and adapter must connect capture and lifecycle to the existing core authority. AI actions remain core-controlled, use the existing [action proposal](contracts/v0.2/action_proposal.schema.json) and [receipt](contracts/v0.2/action_receipt.schema.json) boundaries, and require current identity and verified-frame evidence. Image selection must not give the renderer arbitrary command, binary, profile or filesystem authority. Any necessary contract expansion requires its own explicit review; this roadmap does not change the existing [surface request](contracts/v0.2/surface_request.schema.json).

## Bounded work and validation gates

- Extend the closed ARM64 graphical episode with separate manual creation evidence and, only after a fresh frame/identity gate, a bounded core-controlled guest action with semantic readback and owned teardown. Reject stale proposals before dispatch; a mounted component, automatic boot or action receipt alone is insufficient.
- Define the versioned image-pack/catalog contract and import validation. Require valid licensed, hash-verified compatible packs; reject malformed metadata, wrong architecture and incompatible modes.
- Admit each backend on each host separately. Require a working virtualization API and resource admission; device-node presence alone is insufficient.
- Implement one compatible image and mode at a time. Require verified frames or terminal output, core-controlled actions where supported, cancellation and owned cleanup; reject foreign identities and uncertain sessions.
- Add the proposed picker only as those capabilities become proven. Preserve browser/program behavior and closed authority validation; never display speculative modes as available.

Source validation and release readiness remain separate. Bounded UI tests, type checking and build, the full fixture E2E suite with 435 passing cases [CITED: campaign validation], and ordinary package smoke passed. The original default-argument UI FPS failure and the unit gate's 300-second timeout [CITED: campaign validation] remain unwaived. Those passes and the diagnostic VM observation do not constitute release-wide CI acceptance. See the repository [testing guide](docs/TESTING.md) for the test structure.

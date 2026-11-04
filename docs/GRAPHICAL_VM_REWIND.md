# Graphical QEMU checkpoints

This developer opt-in addresses one configured ARM64 graphical VM. The native
runtime must provide the `notepad-rw-vm` program and the `graphical-session` verb.
It uses a private QMP connection and private qcow2 overlays for both the immutable
root and the initialized profile disk. The existing guest frame, input and view
channels remain the surface interface.

The trusted launcher requires `MV_GRAPHICAL_SESSION_ENABLED=1`,
`SRF_GRAPHICAL_VM_ENTRY`, `SRF_GRAPHICAL_VM_ENTRY_SHA256`,
`SRF_GRAPHICAL_QEMU_IMG` and `SRF_GRAPHICAL_QEMU_IMG_SHA256`. Executable paths
must be canonical, absolute regular executables owned by the current user or
root, with a single link, no group or other write permission, and the exact
pinned SHA256. The adapter and native runtime verify these pins; renderer
requests cannot supply or replace them. Both executables enter the existing
container through read-only binds. No new image build is required.

Configure an agent template with `Kind=vm`, `NativeKind=vm`,
`Program=notepad-rw-vm` and a separately admitted private RAM root. Create the VM
through Add capsule. Its graphical-session controls attach to the live surface
and submit Mark or Back using the current generation and authority epoch.
Human input control does not transfer the creator UI's checkpoint authority.

For this variant, set the explicit `MV_SRF_STATE_DIR` to an `identity-state`
child of that private RAM root. Both directories must already exist on tmpfs,
belong to the current user, and have mode `0700`. Native state pins their
device and inode identities. Capture output must remain under the bound private
root; an absent, replaced or malformed pin refuses capture and checkpoint
operations while retaining normal Stop.

The new `graphical_session` contracts carry this state separately. Core journals
the admitted request before native dispatch. The host only projects correlated
Core events. A completed restore advances the generation and authority epoch
only after a newer authoritative surface frame has been published. A point's
`manifest_sha256` identifies its native metadata manifest; it does not claim to
hash the VM's RAM or disk contents.

An ambiguous native outcome, timeout or lost connection holds custody and fences
further Mark and Back requests. Normal Stop remains available. Only physical
surface destruction releases the session; hiding a tile or losing a transport
does not establish cleanup. Native process, container, lease and overlay closure
must be verified independently.

Source tests and package checks establish only their stated boundaries. Live
acceptance additionally requires visible guest mutation, Back to the marked
state, a fresh bound frame, continued guest input, measured operation times and
verified physical closure with the read-only base unchanged.

# Local ARM64 capsule setup

This setup uses operator-provided local assets. It does not download, install,
export images, run a guest during configuration, or grant distribution rights.
Graphical VM means the tested graphical guest adapter; MicroVM means bounded
guest commands with visible output, not a graphical desktop or host shell.

The setup tools require Python from the existing installation. The application,
adapter, native tools, image, kernel and guest artifacts must already exist and
have independently verified provenance. Run these commands from the source tree
matching the packaged application:

```sh
python3 tools/arm64_capsules.py doctor --descriptor /absolute/private/setup-input.json
python3 tools/arm64_capsules.py configure-local --descriptor /absolute/private/setup-input.json
python3 tools/arm64_capsules.py status
```

The descriptor is a regular owner-private JSON file. Configuration verifies all
pins and the real ARM64 KVM API and local Docker image, then publishes an atomic,
non-replacing registry at
`$XDG_DATA_HOME/metaviewer/capsules/arm64/setup.json`. When `XDG_DATA_HOME` is
unset, the base is `~/.local/share`. Existing configuration is never silently
overwritten. A missing or invalid prerequisite refuses configuration.

## Descriptor

The closed format is `metaviewer-arm64-setup/v1`. Paths are canonical absolute
paths with no symlink components. Pins have exactly `path` and lowercase
`sha256` fields. The descriptor contains:

| Field | Content |
|---|---|
| `schema` | `metaviewer-arm64-setup/v1` |
| `source_commit`, `source_root` | Exact reviewed commit and installed public controller source root. A supplied commit is a provenance assertion; it is not a signature. |
| `package` | `app` and `asar` pins; ASAR must be the application's sibling `resources/app.asar`. |
| `python`, `python_prefix` | Real interpreter pin and canonical installed prefix directory. |
| `artifacts` | Pins named `engine`, `kernel`, `broker`, `busybox`; ARM64 ELF or raw ARM64 kernel as applicable. |
| `native` | Pins named `srf-identity-admin`, `srf-identity-surface`, together in one binary directory. Holdings is not part of this setup. |
| `runner` | Pin for `daemon-adapter/tools/guest_command_runner.py` under `source_root`. |
| `files` | Exact module closure below, each with `relative`, `path`, `sha256`. |
| `vm_image` | Exact local Docker image ID in `sha256:` form; never just a mutable tag. |
| `legal` | Explicit local-use statement below. |
| `normal_profiles` | Optional closed fresh Browser/Program recipes described below; absence means these capabilities are not configured by setup. |
| `producer_pins` | Exact `setup`, `graphical`, `guestcommand` pins. Setup is packaged `tools/arm64_capsule_session.py`; the other two pin the same packaged `resources/bin/mv-daemon-adapter`. |
| `package_manifest` | Pin of the external package `.sha256` manifest. |
| `reconciler` | Pin of packaged `tools/arm64_capsule_reconcile.py`. |
| `identity_provisioner` | Optional pin of packaged `tools/mv_identity.py`; required when a Browser recipe is configured. |

The module closure, relative to `source_root/daemon-adapter`, is:

```text
guest_command_runtime/__init__.py
guest_command_runtime/_schemas.py
guest_command_runtime/wire.py
guest_command_runtime/schema.py
guest_command_runtime/config.py
guest_command_runtime/image.py
guest_command_runtime/native_checks.py
guest_command_runtime/native.py
guest_command_runtime/protocol.py
guest_command_runtime/storage.py
guest_command_runtime/controller.py
```

The closed `legal` object has `scope: "operator-provided-local-only"`,
`operator_local_use_confirmed: true`, `redistribute: false`, and `assets`.
`assets` contains `engine`, `kernel`, `broker`, `busybox`, `vm_image`, `native`;
each entry has nonempty `license`, `source`, `evidence` strings describing the
actual facts. Unknown redistribution rights must remain explicitly unknown.
Operator confirmation does not authenticate licenses or authorize redistribution.
Do not place private component source, credentials or personal setup descriptors
in the public repository.

Optional `normal_profiles` contains only `browser` and `program`. `browser` has
`image_id`, sorted unique `domains`, and `legal` facts (`license`, `source`,
`evidence`). `program` has `image_id` and the same legal facts, and requires a
Browser recipe. Image IDs must be exact, locally present ARM64 images. Each
recipe creates a fresh owned identity and provisions only its own empty payload.
Only the Browser template is published as a static native profile; the existing
dynamic Program route uses that template. No static Program profile is invented.
The recipes do not create Docker networks or claim a tested browser/program
runtime merely because an image is present.

The application, interpreter and native binaries must be protected executable
ARM64 ELF files. Before registry publication or a held session, a bounded
isolated interpreter probe verifies the configured prefix and required standard
library imports. Installed helper/source files must be protected (for example,
mode 0644), never group/world writable. Setup does not chmod existing artifacts.

## Packaged launcher interface

The launcher invokes the installed helper with explicitly bound package paths:

```sh
python3 tools/arm64_capsule_session.py --app /absolute/package/metaviewer --source-root /absolute/public-source --ui-transport /absolute/private/ui-transport.json --expected-commit <sealed-package-commit> --launcher-pid <parent-pid> --launcher-start <parent-kernel-start>
```

The helper revalidates the registry, enters its own fresh guardian scope with
MemoryHigh 6 GiB, MemoryMax 8 GiB, no swap, two CPUs and TasksMax 256 [TARGET],
and checks actual effective limits before provisioning. It requires the existing
combined-admission free-memory floor of 32 GiB [TARGET]. It does not increase
native or daemon limits.

The wrapper uses the canonical installed system Python to enter this helper,
not an executable selected by parsing the registry. It supplies the sealed
package commit through `--expected-commit`; mismatch with `source_commit`
refuses before interpreter probing, held-marker publication or provisioning.
The separately pinned registry interpreter is validated before runtime use.
The wrapper obtains its PID and kernel start ticks from the current process;
the helper verifies the supplied launcher is its actual parent before creating
held state or allocating resources. These arguments are internal wrapper data,
not fields the end user must write.

The packaged wrapper, not the end user, creates the owner-private transport JSON:
`schema: "metaviewer-arm64-ui-transport/v1"`,
`mode: "trusted-user-invocation"` or `"private-ui"`, `display`, `xauthority`,
and `dbus_session_bus_address`. This is an explicit trusted launch-context handoff;
no ambient display/auth/bus setting is silently inherited. Private UI acceptance
requires an owned Xauthority file and private owned bus socket. Trusted normal
invocation may have null/empty Xauthority and may use the normal user bus. The
helper checks Xauthority metadata only; it never reads or copies credential bytes.

Manager calls always use the actual UID's `/run/user/<uid>` manager bus. The app
uses the separately admitted UI bus and private RAM HOME/XDG config/data/state/
cache/runtime/TMP directories. This prevents publishing an attach pointer in the
operator's runtime directory. An inherited `MV_HOSTED=1` remains set on the app.

It creates a fresh private RAM directory, native identity and payload, then uses
the accepted CHOWN-only constrained helper on that exact empty payload. The
helper identity, command, isolation and removal are verified. Unknown outcomes
retain the journal and refuse replay. No existing identity is borrowed.

A shared registered agent instance determines the guest-command owner. The host
writes the existing protected guest-command profile and projects
`MV_ARM64_CAPSULES=1`, `MV_GUEST_COMMAND_PROFILE`,
`MV_GUEST_COMMAND_AGENT_INSTANCE` and the native VM profile. It never sets either
exclusive `MV_GUEST_COMMAND_ONLY` or `MV_HEADLESS_ONLY` mode. Renderer selection
does not control host paths, owner, images or native commands. Packaged launcher,
UI and daemon must support this combined mode before this helper is usable.

Only after real host checks and fresh provisioning does the child projection set
`MV_ARM64_CAPSULE_STATUS` to
`{"vm":{"available":true,"reason":""},"microvm":{"available":true,"reason":""}}`.
The UI must intersect this with current live profile/custody checks; this metadata
does not replace backend admission or prove an already running guest.

The helper does not trigger graphical creation. The UI should wait for an actual
Add capsule action. Registry-absent normal launch behavior is unchanged.

### Rewind in the normal wall

Pass `--rewind` to `arm64_capsule_session.py` to select Rewind for MicroVMs in
the same normal wall. Both VM and MicroVM remain selectable in Add capsule;
no browser or VM is created automatically. The launcher still needs the complete
protected ARM64 registry, exact package commit and explicit UI transport above.
This is not the exclusive developer `MV_REWIND_ONLY` mode.

The helper derives the Rewind runner and module hashes from the verified package
manifest, uses the existing admitted artifact pins and records its explicit mode
in the private session plan. The resource inventory and held-session fence remain
active. The shorter, exclusively created runtime path avoids Unix socket path
limits without relaxing the native limit. A colliding directory is refused.

MicroVM creation remains blocked while any surface capsule, including a browser
or an unresolved creation, is held. An absent VM window does not establish that
all surface resources have closed. Missing setup must be repaired through the
protected launcher; setting availability flags by hand is not a setup procedure.

## Lifecycle and allocation custody

The durable `held-session.json` prevents another session while closure remains
unproven. PLAN captures exact launcher and outer-helper process/start/cgroup
identities. The outer helper catches TERM, INT and HUP and publishes private
`STOP_REQUESTED` instead of abandoning the scope. The internal guardian checks
both process identities and that stop record, including loss by SIGKILL. Before
each native/helper command it rechecks custody.

The app is terminated only through its owned Popen after checking the recorded
PID/start/cgroup. Teardown first waits five seconds [TARGET]; timeout records
unknown ownership. A bounded fallback may stop only the freshly matching own
guardian invocation/cgroup/inode. No foreign/reused process, broad process group,
Docker name, shared directory or guessed unit is signalled or removed.

Each new session snapshots the exact verified registry bytes to private
`setup.json`. It creates `inventory-config.json`, `allocations.lock` and the
append-only `allocations.jsonl` using the versioned resource-inventory contract.
The protected config binds registry, package manifest, ASAR, helpers and all
producer pins; it is projected as `MV_ARM64_INVENTORY_CONFIG` to the adapter.
Native and guest-command producers must independently use that same journal.

The setup producer records the session header, actual guardian invocation and
cgroup identity, CHOWN helper pending/bound/removed transitions, and app intent
before Popen followed by its actual PID/start/cgroup. A helper is marked removed
only after verified normal exit, payload ownership, removal and current absence.
Rows use the shared locked append API and hash chain; write failures retain
responsibility and are never automatically replayed.

After app exit the setup producer seals. After the scope process exits the outer
helper releases its lock, requests the coordinator seal and invokes the trusted
reconciler. The held marker remains the admission fence during lock reacquisition.
Only complete producer seals, complete allocation bindings and fresh source-bound
resource-absence proofs may release it. App exit alone is insufficient. Legacy
event files, missing producers, partial records, changed pins or unknown outcomes
retain the marker; deleting it manually is not a supported cleanup procedure.
No roots or payloads are deleted by reconciliation.

Dynamic identity provisioning through the existing identity tool also creates
Docker payload helpers. In normal mode the pinned auxiliary hook writes pending
before Docker, binds the protected CID file and verifies current absence before
removed. It selects only the protected browser-image ID, with no mutable-tag
fallback. A sealed or invalid inventory refuses before helper execution. Failed
or unconfirmed helpers retain their receipt/pending/unknown responsibility.

Direct identity-tool surface login/release operations outside the Go manager
write a permanent global unknown before their effect. Direct profile deletion
also retains unknown because it removes a previously recorded payload inode.
Metadata-only admin create/show is exempt; its Docker helper is inventoried
separately. These operations retain their existing function but currently block
automatic session release. This is a candidate limitation, not exhaustive native
lifecycle coverage. Unset-mode identity-tool behavior remains the legacy route.

Existing Browser/Program profiles are never borrowed from another native store.
When explicit normal recipes are configured, fresh Browser/Program identities
and payloads are created alongside the VM, with the Browser template admitted
for the existing dynamic Program route. Without those recipes, combined-session
Browser/Program availability remains blocked. Their real runtime regression is
still unproved by these synthetic tests. Ordinary registry-absent launch is
unchanged.

Configuration checks hashes, custody and recognizable ISA headers, not kernel
compatibility or authenticated guest hello. Source/package pins still require
independent release verification. These tools and synthetic tests establish no
new guest execution, installation, runtime acceptance or distribution approval.

## Desktop session bus

Normal ARM64 sessions require a root-owned, non-writable `xdg-dbus-proxy` executable in `/usr/bin`. The setup helper refuses before session admission if this prerequisite is absent or unsafe; it never installs it. The application connects through a guardian-owned filtered endpoint to the admitted session bus. Notifications, accessibility, settings and GTK file services remain available. The user manager and desktop portal are hidden from Chromium, preventing scope migration and portal dialogs routed to a different display. Electron uses its native GTK folder chooser on the admitted display; no runtime switches or sandbox markers are forged. Systemd supervision uses its separate explicit manager connection. The proxy closes through its lifetime descriptor when the application exits; the original guardian cgroup must still be absent before session release. This does not relax either graphical or MicroVM guardian verification.

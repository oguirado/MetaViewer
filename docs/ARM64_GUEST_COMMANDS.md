# ARM64 MicroVM command capsule

## What is the MicroVM command capsule?

It is an ARM64 MicroVM that runs one shell command at a time in a disposable guest and returns stdout, stderr and the exit status. It is not a graphical desktop, an interactive terminal (PTY) or an SSH client.

Answers: what the command capsule is; how a guest command differs from graphical input; which contract family it uses.

Guest command versus graphical input: a guest command is a typed request (`command`, relative `cwd`, optional `stdin`) that runs inside the guest as UID 10000 [CITED: `daemon-adapter/guest-command-broker/src/bootstrap.rs`]. Graphical input (clicks, keys on a pixel surface) belongs to the graphical VM and surface capsules and is not available here. Guest commands never reach the host shell.

Contracts: `guest_command_*` at `v0.2`. The earlier fixed-job path (`headless_*`) remains separate ([ARM64_MICROVM.md](ARM64_MICROVM.md)).

Flow: **Add capsule → MicroVM — ARM64 → enter a command → Run → read stdout/stderr and exit status → Stop capsule**. Cancel works once the guest has accepted a running command.

## How does an AI run guest commands?

Through the SDK: `metaviewer_agents.guest_command.GuestCommandSession.claim(entered_tool_client)`, then `create()`, `run()` (or `start()`), `cancel()` and `stop()` [CITED: `agents/metaviewer_agents/guest_command.py`].

Answers: which SDK entry; what the caller may and may not supply; what closing a connection proves.

- `claim` takes ownership of that authenticated client's I/O until it is closed.
- The caller supplies a command and a relative guest working directory. It cannot supply host executable paths, images, process IDs, credentials or resource overrides.
- The authenticated core binds the owner, reserves capacity before creation and keeps ownership when an outcome is unknown.
- A job handle exposes acceptance and the final result.
- Closing the SDK connection does not prove the VM stopped. Only a confirmed Stop does.

## What persists between commands, and what does not?

Files in the guest workspace persist between jobs. Shell state does not: each job gets a new shell and an explicit working directory, so variables and `cd` do not carry over.

Answers: what carries between jobs; what Stop destroys; how output is treated.

- Stop destroys the guest's disposable state.
- Output is handled as bytes/text and cannot trigger terminal control actions on the host.
- The profile keeps a bounded guest lifetime and the existing external service limits. It suits short disposable automation and tests.
- Not provided: long-running services, networking, arbitrary image import, graphical MicroVMs. To undo guest memory changes use the Rewind profile ([ARM64_MICROVM_REWIND.md](ARM64_MICROVM_REWIND.md)); it never reverses effects outside the guest.

## What evidence exists?

The public source defines the command and custody checks. Live backend results
remain maintainer-reported; their raw receipts are not published in this checkout.

Answers: what can a reader verify from the repository?

Inspect `agents/metaviewer_agents/guest_command.py`,
`core/src/serve/guest_command.rs` and `daemon-adapter/guest_command_runtime/`
[CITED: public implementation]. A backend test or compiled panel does not prove
that an installed package exposes the feature. That requires a matching package,
an admitted host profile and a live receipt.

## How is the command-only mode configured?

Set `MV_GUEST_COMMAND_ONLY=1`, a protected `MV_GUEST_COMMAND_PROFILE` and the matching `MV_GUEST_COMMAND_AGENT_INSTANCE`. `MV_HEADLESS_ONLY` must be absent [CITED: `daemon-adapter/internal/daemon/environment.go`].

Answers: which variables select command-only mode; which profile formats it reads; how it relates to the normal ARM64 session.

- Outer profile: `mv-guest-command-host/v1`. Controller configuration: `guest-command-host-config/v1`.
- The profile pins Firecracker, the guest kernel, the static guest broker and BusyBox.
- This mode does not start the graphical backend. The graphical VM profile is configured separately.
- The normal ARM64 session ([ARM64_CAPSULE_SETUP.md](ARM64_CAPSULE_SETUP.md)) projects the same profile without setting either exclusive variable.

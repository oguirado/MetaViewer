# Second security sweep: ci/assets-a7c36e9da

This report covers the surfaces that the first sweep (`origin/cloud/audit-sec`, `cloud-audit/SECURITY.md`) did not. Findings S1–S9 from that sweep are not repeated here.

- **Base:** commit `a7c36e9`, compared with `main` (`7721915`).
- **Method:** the sweep was report-only, and no product code was changed. Findings come from reading the source and from small throwaway tests run in a scratch directory or a scratch copy of the code. None of those tests is committed.
- **Evidence:** each finding is marked **proven by running** or **read only**.

**A clean result is not proof of safety.** "Clean" below means only that no concrete defect was found within the time limit (about 45 minutes).

**Withheld detail:** none. No finding was judged serious enough to withhold. None is rated Critical or High.

## Scope

- **Headless:** `core/src/headless.rs`, `core/src/serve/headless.rs`, and its UI host `ui/electron/headlessHost.js`.
- **Resource inventory:** `daemon-adapter/internal/resourceinventory/`.
- **VM creation:** normal VM and MicroVM creation, including the Firecracker launch in `guest_command_runtime/native.py` and the browser create quarantine in `daemon-adapter/internal/capsule/manager.go`.
- **Electron:** `ui/electron/desktopApplications.js`, and `ui/electron/roleHost.js` beyond Exec parsing (`list-apps`, `release-identity`, `create-program`).
- **ARM64 tooling:**
  - `tools/arm64_capsule_session.py`, with `tools/arm64_capsules.py` and `tools/arm64_capsule_reconcile.py`.
  - ARM64 package and setup paths in `ui/tools/package.js` and `docs/ARM64_CAPSULE_SETUP.md`.
- **Display tap and frame intake:** `daemon-adapter/internal/frames/`.
- **Agent client:** `agents/metaviewer_agents` changes for program text (`guest_command.py`, `headless.py`, `rewind.py`, `client.py`, `envelope.py`).
- **UI tests:** a security-relevant subset, run against the pinned `capsule-ui-kit` (see the last section).

## Findings

Severity is Critical, High, Medium, Low or Info.

| ID | File:line | Severity | Confidence | Evidence |
|----|-----------|----------|------------|----------|
| T1 | `ui/electron/headlessHost.js:68`, `ui/electron/hostBindings.js:689-692`, `core/src/serve/headless.rs:87-97` | Medium | High | proven by running (function level) |
| T2 | `core/src/headless.rs:97-99` | Low | High | proven by running |
| T3 | `daemon-adapter/internal/resourceinventory/config.go:115-122` | Low–Medium | Medium | proven by running (ledger level) |
| T4 | `daemon-adapter/internal/capsule/manager.go:510-541` | Low–Medium | Low–Medium | read only |
| T5 | `tools/arm64_capsule_session.py:595-601`, `:93-99` | Low | High | proven by running |
| T6 | `tools/arm64_capsule_reconcile.py:669`, `tools/arm64_capsules.py:18` | Low (availability) | High | proven by running |
| T7 | `daemon-adapter/internal/resourceinventory/ledger.go:248-251` | Low | High | proven by running |
| T8 | `agents/metaviewer_agents/client.py:592-600` | Low | High | proven by running |
| T9 | `contracts/v0.2/guest_command_request.schema.json` (run branch) | Low | High | proven by running |
| T10 | `daemon-adapter/internal/resourceinventory/ledger.go:58-66` | Low / Info | High | proven by running |

### T1: an agent request on a human-created MicroVM cuts the UI's core connection

- **Cause:**
  - Core sends every headless event to the agent, the creator and the pending caller (`serve/headless.rs:87-97`).
  - When the human created the workload and the agent then sends `run` or `stop`, the UI receives events whose `request_id` it never issued.
  - Outside the uncertain state, `headlessHost.js:68` throws `HEADLESS_CORRELATION`.
  - That exception reaches the socket data handler, which calls `shutdown(HELLO_PROTOCOL)` (`hostBindings.js:689-692`). This tears down the UI's whole core binding: headless, guest command, rewind and every painted surface lifetime.
  - Guest command has an adoption path for operations started by the other party (`guestCommandHost.js:82`, `guest_command.py:190-210`). Headless has none.
- **Sequence:**
  1. In headless mode, the human clicks Create and the workload reaches `ready`.
  2. The registered agent sends `{"op":"stop","params":{"workload_id":…,"generation":1}}` with its own `request_id`.
  3. The `accepted` event is fanned out to the UI, which throws, and the UI drops its core connection.
- **Impact:** the agent can disconnect the human's UI from core at will, and with it the human's ability to watch or stop the workload. The UI still showed `phase: ready` after the throw [MEASURED]. This affects only opt-in ARM64 headless mode (`MV_HEADLESS_ONLY=1`), and only the single registered agent can do it.
- **Proof:**
  - A throwaway node script drove `createHeadlessHost` through create → ready, then fed it the agent's `stop` `accepted` event. `receive` threw `HEADLESS_CORRELATION` [MEASURED].
  - The core fan-out and the `shutdown` path were confirmed by reading only. The full socket round trip was not run.
- **Possible fix:** passively adopt (or ignore) correlated foreign operations the way guest command does, rather than throwing.

### T2: the agent can run and stop the human's MicroVM, but the human cannot stop the agent's

- **Cause:**
  - `submit_inner` always sets `actor = actor_id(agent)` (`headless.rs:95`).
  - It then admits non-create operations when `creator == caller || caller == agent` (`:97-99`).
- **Measured** (throwaway test in a scratch copy of `core`):
  - The UI creates. The agent's `stop` returns `Ok`, and the agent's `run` returns `Ok`.
  - The agent creates. The UI's `stop` returns `Err("OWNER_MISMATCH")`.
- **Impact:**
  - Only one workload is allowed per core session (`started` never resets).
  - If the agent creates first, the human has no Stop and must end the whole session to reclaim the guest.
  - Guest command uses the same agent-owns-all model (`core/src/guest_command.rs:174-179`), so this looks like a design choice. The asymmetry is still worth an explicit decision.

### T3: a "program" allocation can claim the VM's or browser's reserved profile id

- **Cause:** for `kind == "program"`, `allowsProfile` accepts any `^[a-z0-9][a-z0-9-]{1,39}$` id outside the protected prefixes (`config.go:115-122`). It does not exclude the reserved ids `mv-arm64-<run_id>` and `arm64-browser-<run_id>` (`config.go:106-113`). `ledger.go:257` and `native_metadata.go:141` use this check.
- **Proof:** a `native_pending` row with `native_kind=program`, `profile_id=mv-arm64-<run_id>`, and the VM's payload under `store/profiles/` was accepted by `parseHistory` (`err=<nil>`) [MEASURED].
- **Impact:** the custody ledger can record a program as owning the VM's payload directory. Whether the native program launcher actually mounts that path was not verified.

### T4: browser quarantine can be lifted using a lease not tied to the profile

- **Cause:** `releasedIdentityAbsent` requires `locks/<profile>.json` to say `active:false` with some `srf-id-*` holder. It then checks only that a container named after that holder is absent (`manager.go:510-541`). It never requires `holder == "srf-id-" + profile`, and never checks that the pending container `srf-id-<profile>` is absent.
- **Sequence:**
  1. A browser create ends with an uncertain outcome, so quarantine is kept (`manager.go:984`).
  2. The lease still names an older, inactive holder that has been removed.
  3. The next create clears the quarantine (`manager.go:871`) and launches against the same identity again.
- **Impact:** a possible double launch on a human's browser identity. The identity store's own locking may refuse the second launch; that was not verified.

### T5: the ARM64 session failure handler runs a reconciler from an unvalidated `setup.json`

- **Cause:**
  - When `internal()` fails, the handler reads `<root>/setup.json` without `setup.validate()`, without comparing it to the plan's `registry_sha256`, and even when `PLAN.json` is absent (`arm64_capsule_session.py:595-601`).
  - It then executes `value['reconciler']['path']` (`:93-99`).
  - The only check is `pin`, against a hash taken from that same file.
  - This includes failures caused by "registry changed" or "session helper changed" (`:458-462`).
- **Input:** a 0700 directory holding a valid `guardian.json` and `setup.json` = `{"reconciler":{"path":"<scratch>/evil.py","sha256":"<its hash>"}}`, run as `python3 -I -B tools/arm64_capsule_session.py --internal-root <dir>`.
- **Measured:** rc=2 and `ARM64_SESSION_REFUSED` printed, but `evil.py` ran: its marker file was written [MEASURED].
- **Impact:** an attacker needs the same uid to write the private directory, so no boundary is crossed today. But the integrity-failure path runs unbound code.

### T6: ARM64 session release can never succeed

- **Cause:** `descriptor_context` requires `native` to be exactly {`srf-identity-admin`, `srf-identity-surface`, `srf-holdings-capsule`} (`arm64_capsule_reconcile.py:669`). Setup validation requires exactly the first two (`arm64_capsules.py:18,175`), and `docs/ARM64_CAPSULE_SETUP.md:39` says Holdings is not part of setup.
- **Measured:** a descriptor with the setup closure gets `closed object required` [MEASURED].
- **Impact:**
  - `reconcile_held(release=True)` always fails, so `held-session.json` is never removed.
  - Every later launch is refused with "previous session requires reconciliation".
  - The packaged launcher exits 2 (`ui/tools/package.js:1325-1328`).
  - This fails safe: custody is never released.

### T7: the inventory ledger allows two live allocations of one container and CID

- **Cause:** allocations are keyed only by `producer:id` (`ledger.go:248-251`). Nothing makes `container_name`, `payload` or `cid` unique.
- **Measured:** pending and bound rows for g1 and then g2, both on `srf-vm-<profile>` with the same CID, were accepted [MEASURED].
- **Impact:** after one generation closes, an apparently live twin is left, so reconciliation becomes ambiguous. In practice the capsule manager's own per-profile binding check (`capsule/manager.go:874-883`) stops this, so it is a defence-in-depth gap.

### T8: sequence reservation truncates a hard-linked file before refusing it

- **Cause:** `_reserve` opens `<seq>.tmp` with `O_CREAT|O_TRUNC|O_NOFOLLOW` but without `O_EXCL`. It checks `st_nlink != 1` only after the truncation has already happened (`client.py:592-600`).
- **Measured:** with `.tmp` hard-linked to a 15-byte 0600 file, the call raised `invalid sequence file`, and the target file was left at 0 bytes [MEASURED].
- **Impact:** an attacker needs the same uid to write the 0700 socket directory. This is old code that the sweep passed through.
- **Possible fix:** add `O_EXCL`, or check with `fstat` before truncating.

### T9: the guest-command request schema is looser than both implementations

The run branch accepts input that the Python client refuses (`guest_command.py:47,51`):

- **NUL:** `command_utf8` containing NUL.
- **Size:** `'\U0001F600'*16384` (65536 bytes). `maxLength` counts characters, not bytes.
- **Paths:** `cwd` of `../x` or `/etc`.

All three were proven with `make_envelope` [MEASURED].

Core `prepare_exec` (`core/src/guest_command.rs:68-89`) and `guest_command_runtime/protocol.py:23-33` check these again, so nothing is exploitable today. The risk is drift: any consumer that trusts the schema alone, such as the copy embedded in the UI preload, gets weaker rules.

### T10: inventory journal keys are matched case-insensitively

- **Cause:** Go's `encoding/json` matches struct fields regardless of case, and `ipc.ValidateJSON` rejects only exact duplicate keys (`ledger.go:58-66`, `ipc/json.go:100`).
- **Measured:** a row using `"SCHEMA"` and `"Seq"` was accepted [MEASURED]. Read only: `{"seq":1,"Seq":2}` should also pass, with the last value winning.
- **Impact:** a parser mismatch with the Python reconciler. Exploiting it needs write access to a 0600 journal.

## Info notes (read only)

- **No overall allocation cap:** the ledger is a custody record with no total for RAM or CPU. Per-container caps exist (`native_metadata.go:218-222`), but Docker containers run outside the guardian cgroup (`config.go:401-414`).
- **Program binary checks:** `createProgram` accepts any clean absolute executable, including `/bin/sh` (`roleHost.js:88-114`). The `.desktop` path denylists shells (`desktopApplications.js:19`). The input comes only from the human through the renderer, so this is an inconsistency, not a bypass.
- **Same 256-pending cap in guest command:** `daemon-adapter/internal/guestcommand/manager.go:135` follows the same pattern as first-sweep S1. Not re-analysed.
- **Firecracker without the jailer:** no chroot, uid drop or namespaces. It relies on Firecracker's built-in seccomp and the external cgroup (`guest_command_runtime/native.py:138`).
- **TOCTOU windows that need the same uid or source-tree write access:**
  - `arm64_capsule_session.py:368-372`: Docker re-resolves the bind source after `lstat`. The post-check catches a swap only after the fact.
  - `:94-98`: the reconciler is checked with `pin`, then re-read by path when it is executed, then checked again.
- **Path join before validation:** `displaytap.go:597` joins `b.Container` into a path before `validDisplayTarget` (`:641`). The open does not follow symlinks, and the file must be a single-link 0600 file owned by the euid whose JSON repeats the same container, so this was not exploitable.
- **Plan key mismatch:** `arm64_capsule_reconcile.py:14-16`: `PLAN_KEYS` lacks `launcher` and `outer`, so the legacy `inspect_held` path refuses current plans. Fails safe.
- **Session bus passed through:** non-hosted ARM64 mode passes the user's main session bus to the inner app (`arm64_capsule_session.py:241-243`, `ui/tools/package.js:1157-1158`). This is by design, and agents do not see the bus.
- **Possible sequence reuse:** `client.py:604-605,639-658`: two processes racing for the sequence file may reuse a sequence number. Whether core rejects a reused one: `ABSENT — do not invent`.

## Surfaces found clean (no concrete defect found; not proof of safety)

- **Headless core:**
  - Routing binds the role to the message: requests are accepted only from Ui or Agent, and events only from Daemon (`core/src/serve/mod.rs:1369-1374`). There is also a role-spoof test.
  - The `event-core-` prefix is reserved for core-generated events.
  - Request ids are capped at 64 and event ids at 128.
  - Events must match the pending request, the epoch, the workload/generation and the actor.
  - `n` is limited to 0..10000 by the schema [CITED], and release builds keep `overflow-checks = true`, so the sum-of-squares check cannot overflow.
  - A refusal carries the session only to its creator or the agent.
- **`desktopApplications.js`:**
  - Files are opened with `O_NOFOLLOW` and capped at 64 KiB, with at most 256 apps.
  - Only the first Exec token is used, with `%` codes and shells refused.
  - Icons are re-checked against their roots after `realpath` and size-capped, and SVGs with scripts or external references are refused.
  - Icons reach the renderer only as `<img src=data:…>`, so they cannot run script.
  - The renderer supplies no path: `list-apps` takes exact keys only.
- **`roleHost.js` `release-identity`:**
  - The renderer-supplied holder must equal the lease holder.
  - `dead_session` requires a modern admission record whose PID is dead or a zombie.
  - The observer PID is chosen by the host and must be a child of the caller's parent (`tools/mv_identity.py:713-801`).
- **Resource inventory:**
  - The journal is capped at 8 MiB, 8192 rows and a 64 KiB payload, and every decode goes through `ValidateJSON`.
  - Numbers are non-negative and at most 2^53.
  - Paths are opened with `O_NOFOLLOW` and `openat`, with stat comparisons before and after.
  - Appends happen under flock, and each producer holds an exclusive lease.
- **MicroVM:**
  - The Firecracker argv is only `--api-sock <path>`.
  - The nonce travels over the API socket and is redacted from the console summary.
  - The API reader caps headers at 8 KiB and the body at 4096 bytes.
  - Runtime files use `O_EXCL|O_NOFOLLOW` inside `mkdtemp`.
  - Assets are pinned by SHA-256 and size-capped, and nothing is downloaded.
- **ARM64 scripts:**
  - Every subprocess call is an argv list with no shell.
  - Writes are exclusive, do not follow symlinks and use mode 0600.
  - JSON input is capped at 128 KiB, with duplicate keys and NaN refused.
  - No credentials appear in argv or logs; Xauthority bytes are never read.
- **Frame intake:**
  - Record size is capped against the adapter's own target geometry.
  - The image layout must match exactly.
  - The pixel-format decoders bound size, stride and colour count. About 1.5M fuzz runs per decoder produced no panic [MEASURED].
  - The ring file is created on a private tmpfs, exclusively and without following symlinks.
- **Agent client:**
  - Command text never reaches a host shell or argv.
  - Inbound frames are capped and fail closed.
  - Guest output is limited to 65536 bytes in total and 16384 per chunk.
  - Owner, reservation, workload and generation are all checked.
  - Each envelope schema admits only its own body families.
  - Nonces come from `secrets.token_hex`.
  - The socket path is checked with `lstat`, and the peer is checked with `SO_PEERCRED`.

## UI security tests

- **Kit:** `oguirado/capsule-ui-kit` was cloned anonymously at `aaada9dedc177b096e8b4764959e258e76c1ef02` and staged with `tools/sync_kit.mjs`. The content hash matched `ui/kit.lock.json`. Dependencies were installed with `npm ci`, skipping the Electron binary download.
- **Selection:** 33 files covering security, origin, preload, CSP, control owner, role, desktop applications, headless, guest command, rewind, stored-data slots, capture preferences, agent prompts and packaging.
- **Result:** 288 tests, 286 passed and 2 failed [MEASURED]. Both failures are environmental:
  - `r2t4-regressions.test.js:406`: Node 22.23.4 is installed here and the packager requires Node ≥24.
  - `t4-packaged-security.test.js:54`: no Electron binary in `~/.cache/electron`.

## Not covered

- No end-to-end run of T1 over a real core socket, and no Docker, KVM or display stack, so nothing ran inside a capsule or a VM.
- Not run: the full UI suite, the vue-tsc check, and the two environment-blocked tests above.
- Not verified:
  - whether the native program launcher mounts the reserved payload path (T3);
  - whether identity-store locking blocks the second launch (T4).
- Not re-reviewed: guest command and rewind beyond the cross-references above.

## Sweep provenance

- Effort: low for the lead session; the three parallel sub-reviews ran at their default effort.
- Model: withheld from this file, because `LAWS.md` L1.2 forbids model or assistant names in repository files. It is given in the session reply.

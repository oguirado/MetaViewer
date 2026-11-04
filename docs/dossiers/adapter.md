# Adapter dossier: daemon-adapter and scripts

This dossier explains the Go daemon adapter, the ARM64 guest command and rewind runtime, the Rust guest broker, and the judge launcher scripts. It covers why each part exists, what must hold, how it fails, what the user then sees, and where to change it. Every coordinate is `path:line` on the docs base commit.

**A finding tells you where to look. Only the code proves it.** The row-level findings for this area are in [`route/study/adapter.jsonl`](../../route/study/adapter.jsonl), in the `route/nodes.jsonl` format, with byte spans that were checked against this tree. Statements marked *Inferred* come from reading the code and were not observed running. Numbers carry `[MEASURED]`, `[CITED: path]` or `[TARGET]`.

## 0. Reading map

Answers: where do I start in the adapter; which section answers my question; adapter reading map

Find your question in the left column and go to that section. For a single symptom, use section 9. For an exact message, run `python3 route/route_query.py error "<text>"`.

| You want | Go to |
|---|---|
| What the adapter is and why it is a separate process | [1](#1-what-is-the-daemon-adapter-and-why-is-it-a-separate-process) |
| Why capsules are generated per opening, and what that buys | [2](#2-why-are-capsules-generated-this-way-and-what-does-it-gain) |
| The parts, file by file | [3](#3-which-file-does-what) |
| How a request becomes a capsule, a frame or an input | [4](#4-how-does-a-request-flow-through-the-adapter) |
| What must always hold | [5](#5-what-must-always-hold) |
| Why a refusal happened, by code | [6](#6-what-does-each-refusal-code-mean) |
| Frames, frozen tiles and live view | [7](#7-why-is-a-tile-frozen-stale-or-lost) |
| Human and agent roles, Host programs | [8](#8-how-do-human-and-agent-roles-work-and-why-does-a-host-program-restart) |
| Symptom to cause to code | [9](#9-symptom-to-cause-table) |
| ARM64 VM, MicroVM, guest commands, rewind | [10](#10-how-do-arm64-guest-commands-and-rewind-work) |
| The broker inside the ARM64 guest | [11](#11-what-runs-inside-the-arm64-guest) |
| Installing and launching as a judge | [12](#12-how-do-the-judge-scripts-install-and-launch-metaviewer) |
| Known open bugs in this area | [13](#13-which-open-bugs-touch-this-area) |
| Where to change what | [14](#14-where-do-i-change-what) |
| How to test it, and what was run | [15](#15-how-do-i-test-it-and-what-was-run-here) |
| Tradeoffs and rejected options | [16](#16-what-tradeoffs-were-made-and-what-was-rejected) |
| What this dossier does not know | [17](#17-what-is-absent-or-unverified) |

Terms, defined once:

- **Capsule**: one tile on the wall and the native runtime behind it, such as a browser container or a program container.
- **Host program**: a program that runs on the host under a private Xvfb and xpra display. It is not inside a container.
- **Profile**: the named configuration a capsule is started from.
- **Quarantine**: a profile whose native start or stop was not proven. It cannot be reused until removal is verified.
- **Native CLI**: the external `srf-*` programs that the adapter calls as separate processes.
- **Core**: the Rust authority that the adapter connects to.

## 1. What is the daemon adapter and why is it a separate process?

Answers: what is mv-daemon-adapter; why Go; how does the core talk to capsules; adapter role

The adapter is a Go process. It connects to the Rust core over a Unix socket and turns versioned JSON requests (`surface_request/v0.2`, `record_request/v0.2`, `guest_command_request/v0.2`, `rewind_request/v0.2`, role switch v0.3) into calls to native CLIs. It answers with `surface_event`, `frame_ref`, `action_receipt` and `observation` messages (`daemon-adapter/README.md:1-11`).

The native programs are external components. Per [NOTICE-EVALUATION.md](../../NOTICE-EVALUATION.md), MetaViewer "starts them as separate processes and talks to them over documented process and socket interfaces". This dossier says nothing more about them.

Design choices visible in the code:

| Choice | Coordinate |
|---|---|
| The adapter is the client. It dials `$XDG_RUNTIME_DIR/metaviewer/core.sock` and opens with its own hello. | `daemon-adapter/internal/daemon/stream.go:3-5`, `daemon-adapter/internal/daemon/environment.go:241` |
| It dies with its launcher: `PR_SET_PDEATHSIG`, with the OS thread locked. | `daemon-adapter/cmd/mv-daemon-adapter/main.go:14-17`, `daemon-adapter/cmd/mv-daemon-adapter/main.go:35-45` |
| Every misconfiguration is a typed `configuration` fault and exit 2. There are no defaults that guess. | `daemon-adapter/cmd/mv-daemon-adapter/main.go:24-32`, `daemon-adapter/internal/daemon/run.go:89-91` |
| The adapter never claims a verified action. `action_receipt` always has `verified: false`, and checking the expectation is the core's job. | `daemon-adapter/internal/daemon/environment.go:1129` |
| It runs in exactly one mode: graphical, `MV_HEADLESS_ONLY=1`, `MV_GUEST_COMMAND_ONLY=1` or `MV_REWIND_ONLY=1`. | `daemon-adapter/internal/daemon/environment.go:87-110` |

*Inferred*: the adapter is a separate process so that the core never executes native programs or parses their output. A crash or hang in native work then ends the adapter, not the core.

## 2. Why are capsules generated this way, and what does it gain?

Answers: why capsules; why one container per opening; why quarantine; advantage of generating capsules; why fail closed

Each opening gets its own runtime, its own frames directory in RAM and its own binding. Run ids, frame roots and container names must be disjoint per profile (`daemon-adapter/internal/capsule/manager.go:1130-1140`). The header of the manager states the rule that shapes everything else: an uncertain native effect quarantines the profile until explicit reconciliation, and an uncertain start is never retried automatically (`daemon-adapter/internal/capsule/manager.go:9-14`).

| What the design does | What it gains | Coordinate |
|---|---|---|
| One binding per profile, disjoint runtime, frames and container | One tile cannot read or overwrite another tile's frames or state | `daemon-adapter/internal/capsule/manager.go:1130-1140` |
| Quarantine counts against capacity until removal is verified | A failed stop cannot leak a hidden second copy of a capsule | `daemon-adapter/internal/capsule/manager.go:877-888`, `daemon-adapter/internal/capsule/quarantine_count.go:6-21` |
| Only a proven pre-spawn refusal clears quarantine at once | "Nothing was started" is proven, not assumed | `daemon-adapter/internal/capsule/process.go:108-112` |
| Frames are hash-checked and copied into adapter-owned files | What the agent sees is exactly what was captured | `daemon-adapter/internal/frames/publisher.go:332-345` |
| Single-use input permits tied to a fresh frame | An agent cannot act twice on one stale view | `daemon-adapter/internal/capsule/manager.go:1539` |
| Protected containers and identities are refused before any exec | The person's own containers are never touched | `daemon-adapter/internal/capsule/protect.go:11-28` |
| RAM admission is checked before spawn and again after the initial frame | A new capsule cannot push the host out of memory | `daemon-adapter/internal/daemon/ram_admission.go:86-93`, `daemon-adapter/internal/daemon/ram_admission.go:202` |

Capsule kinds and where they run (`daemon-adapter/internal/capsule/manager.go:52-58`):

| Kind on the wall | Native kind | Where it runs | Container name |
|---|---|---|---|
| browser | browser | identity browser container | assigned by the native CLI |
| desktop_capsule | program | program inside a container | `srf-pg-<profile>` |
| desktop_capsule | host-xpra (Host program) | **on the host**, under a private Xvfb and xpra | `srf-pg-hx-<profile>` (`daemon-adapter/internal/capsule/host_xpra.go:299`) |
| desktop_capsule | host-window | an existing window of the person's X11 session | `srf-hw-<profile>-<xid>` (`daemon-adapter/internal/capsule/host_window.go:110`) |
| vm | vm | ARM64 only, see section 10 | `srf-vm-<profile>` |
| game_capsule | holdings | game capsule | native |

Host programs and host windows run on the host. Only their HOME and XDG directories (for host-xpra) and their frames live in RAM under `/dev/shm` (`daemon-adapter/internal/capsule/host_xpra.go:217`, `daemon-adapter/internal/capsule/host_window.go:116`). For the wider rationale and the alternatives considered, see [docs/ARCHITECTURE.md](../ARCHITECTURE.md).

## 3. Which file does what?

Answers: adapter files; package layout; which package owns frames, input, profiles

| Path | Role |
|---|---|
| `daemon-adapter/cmd/mv-daemon-adapter/main.go` | Process entry: thread lock, parent-death binding, signal context, `RuntimeFromEnv`, `Run` |
| `daemon-adapter/internal/daemon/environment.go` | Reads all environment configuration. Holds the wire handler (create, input, destroy, record, state), input settle and shutdown budgets |
| `daemon-adapter/internal/daemon/stream.go` | Dial, peer credentials, hello, inbound checks, keepalive, control and data lanes |
| `daemon-adapter/internal/daemon/client_authority.go` | Peer check, core hello pin, sender binding, fsynced replay ledger |
| `daemon-adapter/internal/daemon/ram_admission.go` | `/proc/meminfo` admission, reservation files, compensation after create |
| `daemon-adapter/internal/daemon/dispatch.go` | `NewHandler`: create, then the initial frame, then compensation |
| `daemon-adapter/internal/capsule/manager.go` | Capsule lifecycle, `WireCode`, input lowering, loss state machine |
| `daemon-adapter/internal/capsule/host_xpra.go` | Host program start and stop under a private Xvfb and xpra |
| `daemon-adapter/internal/capsule/host_window.go` | Attaching a host window, XWD capture, input, loss classification |
| `daemon-adapter/internal/capsule/identity_profiles.go` | Dynamic profiles, display pool, protected ids |
| `daemon-adapter/internal/capsule/opening_mode.go` | The one-shot opening request written by the UI host |
| `daemon-adapter/internal/capsule/handoff.go`, `role_switch.go`, `login_lock.go` | Take and release control, role switch, login lock |
| `daemon-adapter/internal/capsule/egress*.go` | Per-identity browser network mode and proxy policy |
| `daemon-adapter/internal/capsule/slots/store.go` | Saved capsule data slots |
| `daemon-adapter/internal/frames/` | Verified frame capture, DISPLAY live tap, subscriptions |
| `daemon-adapter/internal/view/` | Operator view and login helper |
| `daemon-adapter/internal/ipc/` | Socket, framing, closed schema policy, replay |
| `daemon-adapter/internal/record/` | RAM recording and explicit export |
| `daemon-adapter/internal/resourceinventory/` | ARM64 allocation journal |
| `daemon-adapter/internal/guestcommand/`, `daemon-adapter/internal/headless/` | ARM64 guest command and rewind owners; headless owner |
| `daemon-adapter/guest_command_runtime/`, `daemon-adapter/rewind_runtime/`, `daemon-adapter/tools/` | Python service side of guest commands and rewind |
| `daemon-adapter/guest-command-broker/` | Rust PID 1 inside the ARM64 guest |
| `scripts/judge/` | Judge launcher, preflight, asset fetch |

## 4. How does a request flow through the adapter?

Answers: data flow; how create works; how input works; how a frame reaches the UI; handler chain

The flow, with coordinates:

1. **Startup.** Environment variables go through `RuntimeFromEnv`, then `Run` and `connectStreaming` (`daemon-adapter/internal/daemon/environment.go:85-339`).
2. **Each inbound frame** passes these checks in order: frame limit, closed schema, route and hello, `Authenticate`, durable `Reserve` of (seq, nonce). Then it goes to the control or data lane (`daemon-adapter/internal/daemon/stream.go:266-366`). A keepalive is answered inline in the reader (`daemon-adapter/internal/daemon/stream.go:339-342`).
3. **The graphical handler chain** is: schema switch (`daemon-adapter/internal/daemon/environment.go:314-338`), then the DISPLAY wrapper (`daemon-adapter/internal/daemon/environment.go:1615-1639`), then the subscription handler (`daemon-adapter/internal/daemon/subscriptions.go:25`), then RAM admission for create and destroy (`daemon-adapter/internal/daemon/ram_admission.go:114`), then `capsule.Manager`.
4. **Create** goes through these steps:
   - Consume the opening request at `<MV_SRF_STATE_DIR>/opening-modes/<profile>.json` (`daemon-adapter/internal/capsule/opening_mode.go:47-118`).
   - Check capacity and quarantine (`daemon-adapter/internal/capsule/manager.go:877-888`).
   - Set quarantine, then start the native runtime (`daemon-adapter/internal/capsule/manager.go:987-1016`).
   - Check readiness and collisions (`daemon-adapter/internal/capsule/manager.go:1085-1140`).
   - Emit `created`, followed by an initial frame (`daemon-adapter/internal/daemon/dispatch.go:88-107`).
5. **Input** follows these steps:
   - Admission checks.
   - Lower the action to native argv.
   - Make one native call per text chunk, outside the lock (`daemon-adapter/internal/capsule/manager.go:1676-1715`).
   - Reply `input_applied` with evidence from this call alone and a fresh capture after the input (`daemon-adapter/internal/daemon/environment.go:795-799`).
6. **Errors** become a `surface_event` `error` whose `code` is `capsule.WireCode(err)` (`daemon-adapter/internal/daemon/environment.go:1191-1208`, `daemon-adapter/internal/capsule/manager.go:288-320`).

## 5. What must always hold?

Answers: invariants; what must hold in the adapter; capacity rules; state directory rules

| Invariant | Coordinate |
|---|---|
| Every manager map is guarded by `Manager.mu`. Native calls drop the lock and re-validate container, run id, state and epoch afterwards. | `daemon-adapter/internal/capsule/manager.go:1375-1381` |
| Capacity reserved = quarantined profiles + non-destroyed bindings. Lost bindings count too. | `daemon-adapter/internal/capsule/manager.go:877-888` |
| `MV_SRF_STATE_DIR` is a current-uid `0700` directory, walked without following symlinks. | `daemon-adapter/internal/capsule/process.go:64-80`, `daemon-adapter/internal/daemon/environment.go:129-142` |
| A missing egress record means open. A malformed record never means open. | `daemon-adapter/internal/capsule/egress.go:3-5` |
| Create admission: `MemAvailable >= min(20 GiB, MemTotal/4) + 512 MiB × reservation files` [CITED: daemon-adapter/internal/daemon/ram_admission.go]. The reservation is persisted before spawn. | `daemon-adapter/internal/daemon/ram_admission.go:32-33`, `daemon-adapter/internal/daemon/ram_admission.go:168-174` |
| The replay ledger has a single writer and holds at most 100000 entries and 32 MiB [CITED: daemon-adapter/internal/daemon/client_authority.go]. | `daemon-adapter/internal/daemon/client_authority.go:51-113` |
| Transport limits: frame 1048576 bytes, depth 32, string 65536, keys 256, array 4096, one connection, hello 5 s, read 30 s [CITED: daemon-adapter/internal/daemon/environment.go]. | `daemon-adapter/internal/daemon/environment.go:241`, `daemon-adapter/internal/ipc/config.go:20-25` |
| The peer UID must equal the configured UID. The socket is `0600` inside a `0700` directory. | `daemon-adapter/internal/ipc/peercred.go:32`, `daemon-adapter/internal/ipc/socket.go:25` |
| Shutdown fits inside the host's 45 s grace: 30 s close budget + 10 s create grace [TARGET]. | `daemon-adapter/internal/daemon/environment.go:1369-1384` |

## 6. What does each refusal code mean?

Answers: what is SURFACE_CAPACITY_OR_QUARANTINE; what is RAM_ADMISSION_REFUSED; ADAPTER_ codes; HOST_PROGRAM_UNAVAILABLE; why was my capsule refused

`WireCode` decides what the user sees (`daemon-adapter/internal/capsule/manager.go:288-320`):

- An uppercase fault code passes through unchanged.
- Five lowercase codes are mapped by name: `PROFILE_ALREADY_BOUND`, `SURFACE_CAPACITY_OR_QUARANTINE`, `IDENTITY_UNAVAILABLE`, `HOST_PROGRAM_UNAVAILABLE`, `HOST_WINDOW_UNAVAILABLE`.
- Any other lowercase code becomes `ADAPTER_<CODE>`.
- An error that is not a fault becomes `ADAPTER_ERROR`.

Native exit codes map as 2 usage, 3 setup, 4 unavailable, 5 malformed, 6 refused, 7 cli_failed. A signal kill maps to `uncertain` (`daemon-adapter/internal/cli/runner.go:43-66`).

| Code seen | Meaning | Coordinate |
|---|---|---|
| `SURFACE_CAPACITY_OR_QUARANTINE` | Surface limit reached, or the profile is quarantined after an unproven start or stop | `daemon-adapter/internal/capsule/manager.go:886` |
| `PROFILE_ALREADY_BOUND` | A non-destroyed binding, even a lost one, holds the profile | `daemon-adapter/internal/capsule/manager.go:880` |
| `IDENTITY_UNAVAILABLE` | Native exit 4: the identity is held by a live capsule or an abandoned lease | `daemon-adapter/internal/capsule/manager.go:1027` |
| `HOST_PROGRAM_UNAVAILABLE` | xpra, Xvfb, xauth or xdotool missing, or no X11 window published | `daemon-adapter/internal/capsule/host_xpra.go:211`, `daemon-adapter/internal/capsule/host_xpra.go:384` |
| `RAM_ADMISSION_REFUSED` | Free memory below the floor plus reserves, or an admission record failure | `daemon-adapter/internal/daemon/ram_admission.go:90`, `daemon-adapter/internal/daemon/ram_admission.go:275` |
| `POLICY` | Not allowed in this mode or role, for example input to a human tile or a role switch on a Host program | `daemon-adapter/internal/capsule/manager.go:1524-1526`, `daemon-adapter/internal/capsule/role_switch.go:21-23` |
| `LOGIN_ACTIVE` | An operator login view is open, so agent input is blocked | `daemon-adapter/internal/capsule/login_lock.go:14-21` |
| `SURFACE_NOT_AGENT_CONTROLLED`, `SURFACE_NOT_HUMAN_CONTROLLED` | Wrong controller for this action | `daemon-adapter/internal/capsule/handoff.go:60-62` |
| `NET_PROXIED_UNSUPPORTED`, `NET_OPEN_PREREQ`, `NET_EGRESS_*` | Browser network mode cannot be honoured | `daemon-adapter/internal/capsule/egress_policy.go:84`, `daemon-adapter/internal/capsule/egress_policy.go:160` |
| `capture_failed` | Two frame failures in a row. The real cause is printed only on stderr. | `daemon-adapter/internal/frames/subscriptions.go:801-804` |
| `BUDGET_EXCEEDED` (record) | Recording above 64 MiB session memory, ring above 8 MiB or above 30 fps [CITED: daemon-adapter/internal/record/record.go] | `daemon-adapter/internal/record/record.go:519-531` |
| `SLOT_*` | Slot store refusals, such as busy, quarantined, quota or reconciliation required | `daemon-adapter/internal/capsule/slots/store.go:339-345` |
| `JUDGE_<CODE>` | Launcher refusal, printed as `JUDGE_<CODE>: <problem> -- fix: <command>` with rc 2 | `scripts/judge/metaviewer-judge.sh:48-51` |

Some errors close the whole core session and send no reply. When a handler returns an error rather than an event, the connection drops (`daemon-adapter/internal/daemon/stream.go:147-149`). Causes include a bad role switch, a state request that did not come from the core, a missing guest owner, a hello pin mismatch and replay ledger capacity (`daemon-adapter/internal/daemon/client_authority.go:108-199`). Each code also has its own row in `route/study/adapter.jsonl`; a generated list of all codes is planned for `docs/ERRORS.md`, which another lane owns.

## 7. Why is a tile frozen, stale or lost?

Answers: frozen tile; black tile; tile not updating; live view stale; frame cadence; digest skip

Two separate pixel paths feed a tile:

1. **Verified capture.** It polls native frames, checks identity and SHA-256, and emits `frame_ready` with a `frame_ref/v0.2` (`daemon-adapter/internal/frames/publisher.go:803`, `daemon-adapter/internal/frames/subscriptions.go:678`).
2. **DISPLAY tap.** It writes a live tmpfs seqlock ring that the UI reads directly. It never calls the verified path (`daemon-adapter/internal/frames/displaytap.go:3`).

| Number | Value | Coordinate |
|---|---|---|
| Legacy poll interval | 100 ms [CITED: daemon-adapter/internal/frames/ringmode.go] | `daemon-adapter/internal/frames/ringmode.go:14` |
| Ring poll | 1 s / fps, at most 40 ms; default 60 fps [CITED: daemon-adapter/internal/frames/ringsource.go] | `daemon-adapter/internal/frames/ringsource.go:66` |
| DISPLAY sender | getimage then `sleep 0.03`, about 30 fps [CITED: daemon-adapter/internal/frames/displaytap.go] | `daemon-adapter/internal/frames/displaytap.go:528` |
| DISPLAY session cap and backoff | 9 min; 100 ms doubling to 2 s [CITED: daemon-adapter/internal/frames/displaytap.go] | `daemon-adapter/internal/frames/displaytap.go:379` |
| UI stale mark | 2 s without progress [CITED: ui/electron/displayReader.js] | `ui/electron/displayReader.js:11` |
| Subscriptions | 16 max, capture timeout 90 s [CITED: daemon-adapter/internal/daemon/environment.go] | `daemon-adapter/internal/daemon/environment.go:1521` |

| Symptom | Cause | Coordinate |
|---|---|---|
| Frozen, no error | Digest skip: unchanged pixels emit no `frame_ready`. This is expected. | `daemon-adapter/internal/frames/publisher.go:470` |
| Frozen, then `capture_failed` | Two consecutive failures. Look for `adapter: surface <id> error:` on stderr. | `daemon-adapter/internal/frames/subscriptions.go:801` |
| Lost | Two consecutive absence faults | `daemon-adapter/internal/frames/subscriptions.go:549-562` |
| Live view stale after 2 s | The DISPLAY tap ended or the sender stalled; check stderr for `adapter: DISPLAY tap` | `daemon-adapter/internal/frames/displaytap.go:248` |
| Host window lost | Error text matched terminal words. The classification is substring-based. | `daemon-adapter/internal/frames/displaytap.go:326`, `daemon-adapter/internal/capsule/host_window.go:54-73` |
| Host window paused | Window minimized, iconic or unmapped | `daemon-adapter/internal/capsule/host_window.go:257` |
| Black pixels | ABSENT — do not invent. No code here draws black on purpose. | — |

## 8. How do human and agent roles work, and why does a Host program restart?

Answers: human mode; agent mode; role switch; take control; Host program restarts when switching; why switching restarts

The human role blocks all adapter input (`daemon-adapter/internal/capsule/manager.go:1524-1526`). In the agent role, `take_control` hands control to the person and cancels input in flight. `release_control` needs a drained queue and a fresh capture (`daemon-adapter/internal/capsule/handoff.go:76-81`). Human mode needs 1280×900 and a browser or a depth-0 program or Host program (`daemon-adapter/internal/capsule/manager.go:916-918`). Host windows are agent-only (`daemon-adapter/internal/capsule/opening_mode.go:166`).

`SwitchRole` changes the role in place only for browsers and for programs inside a capsule. It never starts or stops the native runtime (`daemon-adapter/internal/capsule/role_switch.go:8-45`). For a Host program, the role is fixed when xpra starts, through `--readonly=<role==agent>` (`daemon-adapter/internal/capsule/host_xpra.go:278`). `SwitchRole` therefore refuses with `POLICY` "native role switch unsupported" (`daemon-adapter/internal/capsule/role_switch.go:21-23`).

Switching a Host program between human and agent restarts it [MEASURED live by the conductor]. The restart is a destroy plus a new create with a new opening request (`daemon-adapter/internal/capsule/manager.go:1179`, `daemon-adapter/internal/capsule/opening_mode.go:235-247`). *Inferred*: the UI host drives that restart, outside this area.

## 9. Symptom to cause table

Answers: debug adapter; my capsule will not start; connection drops; adapter exits 2; capsule stuck lost

| Symptom | Cause | Coordinate | Fix or workaround |
|---|---|---|---|
| Adapter exits 2: `configuration: MV_SRF_STATE_DIR must be absolute` | Missing or relative path | `daemon-adapter/internal/daemon/environment.go:115-118` | Set the absolute path |
| `configuration: private state directory required` | State directory is not `0700` or not owned by the current uid | `daemon-adapter/internal/daemon/environment.go:135-142` | `chmod 0700`; no symlinks in the path |
| `configuration: valid build revision required` | No VCS build info and no `MV_COMPONENT_COMMIT` | `daemon-adapter/internal/daemon/environment.go:292-309` | Build from git or set the variable |
| Second adapter fails at start | Another process holds the replay ledger lock | `daemon-adapter/internal/daemon/client_authority.go:58-60` | Stop the other daemon |
| `RAM_ADMISSION_REFUSED ... records counted: N, of which M belong to other owners` | Stale reservation files from a crashed daemon. A dead PID never frees one. | `daemon-adapter/internal/daemon/ram_admission.go:261-272` | `python3 tools/mv_ram_admission.py reclaim --dry-run`, then apply only after it proves containers absent |
| Core connection drops right after connect | Core hello commit differs from `MV_EXPECTED_CORE_COMMIT` | `daemon-adapter/internal/daemon/client_authority.go:127-141` | Fix the pin |
| Connection drops on one request | The handler returned an error; look for `dispatch:` on stderr | `daemon-adapter/internal/daemon/stream.go:139-159` | Fix the sender |
| `SURFACE_CAPACITY_OR_QUARANTINE` after a failed stop | Profile quarantined | `daemon-adapter/internal/capsule/manager.go:886` | Retry destroy until removal is verified |
| Tile stuck lost after Stop | Removal could not be verified | `daemon-adapter/internal/capsule/manager.go:1229` | Retry destroy |
| `fresh frame and unused input permit required` | Refresh fence, or a reused `proposal_id` | `daemon-adapter/internal/capsule/manager.go:1539` | Capture again; use a new id |
| `native_busy` on capture | Native recorder holds `control.lock` | `daemon-adapter/internal/capsule/process.go:100` | Wait for the recording to finish |
| Wheel input on a host window returns `unsupported` | No scroll case for host windows | `daemon-adapter/internal/capsule/host_window.go:387` | ABSENT — no workaround in code |
| `socket already served` | Another listener is live | `daemon-adapter/internal/ipc/socket.go:76-80` | Stop the other instance |
| Adapter client exits 2 printing `EOF` | Core closed cleanly | `daemon-adapter/internal/ipc/client.go:194-207` | Check the core side |
| `resource inventory: torn or oversized journal` or `row bound` | ARM64 journal would exceed 8 MiB or 8192 rows [CITED: daemon-adapter/internal/resourceinventory/ledger.go] | `daemon-adapter/internal/resourceinventory/ledger.go:195-204` | New session (new root) |
| `resource inventory: producer fenced` | An earlier write or fsync was uncertain | `daemon-adapter/internal/resourceinventory/ledger.go:400-418` | Restart under a new run |

## 10. How do ARM64 guest commands and rewind work?

Answers: ARM64 VM; MicroVM; guest command; rewind; Firecracker; requires reconciliation; Back restored files

VM, MicroVM, guest commands and rewind are ARM64 only. The Python native layer requires `platform.machine() == 'aarch64'` (`daemon-adapter/guest_command_runtime/native.py:104`, `daemon-adapter/rewind_runtime/native.py:122`). In the adapter, the switch is `MV_ARM64_CAPSULES=1`, and it is refused on other hosts (`daemon-adapter/internal/daemon/normal_guest_command.go:35-41`). `tools/arm64_capsule_session.py:549` sets it for an ARM64 session. Plain start offers browsers, Host program and Program; the ARM64 session offers VM and MicroVM only [MEASURED live by the conductor].

How it is built:

- A Go owner starts one pinned Python service through `systemd-run --user` (`daemon-adapter/internal/guestcommand/process.go:141`). The service owns one VMM and talks to the guest broker over vsock port 19001 (`daemon-adapter/guest_command_runtime/native_checks.py:27`).
- Go never runs guest commands itself. It checks each returned event and forwards it to the core (`daemon-adapter/internal/guestcommand/manager.go:107`).
- Responsibility is written down before acting: a reservation marker is written with O_EXCL and fsync before any process exists (`daemon-adapter/internal/guestcommand/prepare.go:45`).
- A marker left on the next start blocks the owner with "previous reservation requires reconciliation" (`daemon-adapter/internal/guestcommand/manager.go:92`). An uncertain owner accepts only stop (`daemon-adapter/internal/guestcommand/manager.go:126`).
- Services run Python with `-I -B` from verified, pinned bytes (`daemon-adapter/internal/guestcommand/process.go:149`, `daemon-adapter/tools/guest_command_runner.py:82`).

| Limit | Value | Coordinate |
|---|---|---|
| Guest VM | 256 MiB, 1 vCPU, 55 s lifetime [CITED: daemon-adapter/guest_command_runtime/native.py] | `daemon-adapter/guest_command_runtime/native.py:152` |
| Host headroom | 32 GiB MemAvailable [CITED: daemon-adapter/guest_command_runtime/native.py] | `daemon-adapter/guest_command_runtime/native.py:109` |
| Pending requests, jobs | 256 per owner, 64 per controller [CITED: daemon-adapter/internal/guestcommand/manager.go; daemon-adapter/guest_command_runtime/controller.py] | `daemon-adapter/internal/guestcommand/manager.go:135`, `daemon-adapter/guest_command_runtime/controller.py:145` |
| Rewind points | 2 points, 1 GiB total [CITED: daemon-adapter/rewind_runtime/native.py] | `daemon-adapter/rewind_runtime/native.py:203` |
| Runtime root path | at most 70 bytes [CITED: daemon-adapter/guest_command_runtime/native_checks.py] | `daemon-adapter/guest_command_runtime/native_checks.py:276` |

Refusal codes:

- Guest owner: DUPLICATE, CAPACITY, BUSY, UNAVAILABLE (`daemon-adapter/internal/guestcommand/manager.go:132`).
- Rewind owner: the same codes plus STALE and INVALID. Every rewind cancel is UNAVAILABLE by design (`daemon-adapter/internal/guestcommand/rewind_manager.go:100-108`).
- `outcome_unknown`: TRANSPORT, DEADLINE, PROTOCOL, PROCESS_IDENTITY, CLEANUP (`daemon-adapter/guest_command_runtime/controller.py:287`, `daemon-adapter/tools/rewind_runner.py:164`).

Rewind is opt-in through `MV_REWIND_ENABLED=1` (`daemon-adapter/internal/guestcommand/rewind_manager.go:32`). Authority only moves forward: resume and restore need a strictly greater generation and epoch (`daemon-adapter/rewind_runtime/controller.py:64`), and the guest is reseeded after every RAM change (`daemon-adapter/rewind_runtime/native.py:256`).

Measured live on an ARM64 MicroVM by the conductor:

- 3 files were deleted, and Back restored them, with 387.5 ms shown by the app [MEASURED].
- `mv-replay` returned rc=0 on that session journal [MEASURED].
- `mv-replay` needs absolute real paths. Relative, symlinked or copied session paths give Invalid [MEASURED].

## 11. What runs inside the ARM64 guest?

Answers: guest broker; PID1; MVGC wire; seccomp; guest powered off; why no error frame

`guest-command-broker` is a Rust PID 1. It must be root PID 1 on aarch64, or it exits 78 (`daemon-adapter/guest-command-broker/src/main.rs:3-9`, `daemon-adapter/guest-command-broker/src/guard.rs:10-15`). Its rule is that any uncertainty powers the guest off (`daemon-adapter/guest-command-broker/README.md:64-65`).

The host therefore sees a lost connection, not an error frame, for most guest failures. Only `BUSY` and `INVALID` are ever sent as `error` frames (`daemon-adapter/guest-command-broker/src/dispatch.rs:143-151`). Everything else is printed on the guest console as `guest_broker failed phase=<phase> ... detail=<string>` (`daemon-adapter/guest-command-broker/src/main.rs:23-33`). The rewind binary leaves out `detail=` (`daemon-adapter/guest-command-broker/src/bin/rewind-command-broker.rs:6`).

| Limit | Value | Coordinate |
|---|---|---|
| Header | 24 bytes, magic `MVGC`, version 1 [CITED: daemon-adapter/guest-command-broker/src/wire.rs] | `daemon-adapter/guest-command-broker/src/wire.rs:284-306` |
| Metadata, payload | 1..4096, 0..65536 bytes [CITED: daemon-adapter/guest-command-broker/src/wire.rs] | `daemon-adapter/guest-command-broker/src/wire.rs:9-12` |
| Frame arrival | within 3000 ms of its opening byte [CITED: daemon-adapter/guest-command-broker/src/wire.rs] | `daemon-adapter/guest-command-broker/src/wire.rs:494-498` |
| Send queue | 131072 bytes [CITED: daemon-adapter/guest-command-broker/src/transport.rs] | `daemon-adapter/guest-command-broker/src/transport.rs:14` |
| Guest lifetime | 60000 ms, except in rewind mode [CITED: daemon-adapter/guest-command-broker/src/bootstrap.rs] | `daemon-adapter/guest-command-broker/src/bootstrap.rs:13` |
| Output per job | 65536 bytes, stdout and stderr combined [CITED: daemon-adapter/guest-command-broker/src/dispatch.rs] | `daemon-adapter/guest-command-broker/src/dispatch.rs:172` |
| Job cgroup | memory 128 MiB, swap 0, 64 pids [CITED: daemon-adapter/guest-command-broker/src/dispatch.rs] | `daemon-adapter/guest-command-broker/src/dispatch.rs:163` |

Jobs run as uid 10000 inside a chroot jail whose `/dev` holds only null, zero, random and urandom (`daemon-adapter/guest-command-broker/src/sandbox.rs:191-200`). The seccomp filter is a denylist that ends in ALLOW, so any syscall not listed is permitted (`daemon-adapter/guest-command-broker/src/seccomp.rs:136`). The README states there is no in-guest CPU limit, so an external CPU cap is required (`daemon-adapter/guest-command-broker/README.md:28-30`).

## 12. How do the judge scripts install and launch MetaViewer?

Answers: install as a judge; metaviewer-judge.sh; doctor; JUDGE_ refusal; tiers T1 T2; preflight fails

These commands come from `scripts/judge/metaviewer-judge.sh`. For step-by-step guides per platform, see [docs/JUDGES.md](../JUDGES.md) and [docs/INSTALL.md](../INSTALL.md).

| Command | What it does | Success marker |
|---|---|---|
| `bash scripts/judge/metaviewer-judge.sh doctor [--capsules]` | Runs all preflight checks (`scripts/judge/metaviewer-judge.sh:1076`) | `JUDGE_DOCTOR_OK tier=...` |
| `bash scripts/judge/metaviewer-judge.sh install [--capsules] [--yes] [--no-firewall]` | Full install (`scripts/judge/metaviewer-judge.sh:754-793`) | `JUDGE_INSTALL_OK tier=... network=... receipt=...` |
| `bash scripts/judge/metaviewer-judge.sh run` | Starts the app in the foreground with `env -i` and an allowlist (`scripts/judge/metaviewer-judge.sh:819-866`) | the app's exit code |
| `bash scripts/judge/metaviewer-judge.sh stop` | SIGTERM, then a leak census (`scripts/judge/metaviewer-judge.sh:949-1067`) | `JUDGE_STOP_CLEAN` |
| `python3 scripts/judge/fetch_assets.py --source <dir-or-https> [--capsules]` | Provisions assets, checked against `SHA256SUMS` (`scripts/judge/fetch_assets.py:20-67`) | `JUDGE_FETCH_OK` |

Tier T1 is the packaged app alone. T2 (`--capsules`) adds the browser capsule images, network and profiles (`scripts/judge/metaviewer-judge.sh:9-10`). sudo is used only through a confirmed step, and no download happens without confirmation (`scripts/judge/metaviewer-judge.sh:12-20`).

| Refusal | Cause | Coordinate | Fix |
|---|---|---|---|
| `JUDGE_ROOT` | Running as uid 0 | `scripts/judge/preflight.sh:520` | Run as a normal user |
| `JUDGE_DISPLAY` | No reachable X display | `scripts/judge/preflight.sh:251` | `xvfb-run -a bash scripts/judge/metaviewer-judge.sh install`, or use a desktop DISPLAY |
| `JUDGE_USERNS` | User namespaces restricted and no AppArmor profile loaded | `scripts/judge/preflight.sh:241` | Run install, which loads the profile |
| `JUDGE_SHM`, `JUDGE_RAM`, `JUDGE_DISK` | Host too small | `scripts/judge/preflight.sh:276-297` | Enlarge `/dev/shm`, free memory or disk |
| `JUDGE_DOCKER*` | Docker is unreachable, rootless or Desktop | `scripts/judge/preflight.sh:339-377` | Use rootful docker, or drop `--capsules` |
| `JUDGE_NET` | Host routes overlap the capsule ranges | `scripts/judge/preflight.sh:407-413` | Renumber the route |
| `JUDGE_ASSET` | Missing or mismatched asset | `scripts/judge/metaviewer-judge.sh:266`, `scripts/judge/metaviewer-judge.sh:277` | Fetch the assets again |
| `JUDGE_STOP_LEAK` | Leftover containers, sockets or records | `scripts/judge/metaviewer-judge.sh:1062-1064` | Follow each printed fix, then run stop again |

Exit codes: 0 ok, 2 typed refusal, 64 usage (`scripts/judge/metaviewer-judge.sh:44`).

## 13. Which open bugs touch this area?

Answers: known bugs; __pycache__; exhaustive manifest inventory; paired terminal exited; journal full ends session

| Bug [MEASURED live by the conductor] | What the code shows | Coordinate |
|---|---|---|
| After `mw_run` the package gains `__pycache__`, and the ARM64 session then holds with "exhaustive manifest inventory". Workaround: remove the bytecode. | The exact string does not occur in the tree: ABSENT — do not invent. The nearest check is the exact install inventory, which fails on any extra file (`PKG_MANIFEST_MISMATCH`). Nothing under `scripts/` sets `PYTHONDONTWRITEBYTECODE`, and `run` uses `env -i`, so an exported value would not reach the app. The adapter's own services run Python with `-B`. | `ui/tools/package.js:1880`, `scripts/judge/metaviewer-judge.sh:866`, `daemon-adapter/internal/guestcommand/process.go:149` |
| A full journal ends the session; a long run needs a fresh session. | For the ARM64 allocation journal, the full condition is refused before anything is written, so native creates and the final seal fail. *Inferred*: the session end is decided outside this area. | `daemon-adapter/internal/resourceinventory/ledger.go:195-204`, `daemon-adapter/internal/daemon/environment.go:271-274` |
| The paired terminal exited after a very long typed line. Cause unknown. | Text input is split into chunks with one native call per chunk. The cause is not established: ABSENT — do not invent. | `daemon-adapter/internal/capsule/manager.go:1676-1715` |

## 14. Where do I change what?

Answers: where to change; add refusal code; change cadence; change limits; add environment variable

| Task | Location |
|---|---|
| Wire refusal code mapping | `daemon-adapter/internal/capsule/manager.go:288` |
| Native exit mapping | `daemon-adapter/internal/cli/runner.go:43-66` |
| Graphical environment variables | `daemon-adapter/internal/daemon/environment.go:85-161` |
| Transport values | `daemon-adapter/internal/daemon/environment.go:241`; ceilings in `daemon-adapter/internal/ipc/config.go:20` |
| RAM floor and reserve | `daemon-adapter/internal/daemon/ram_admission.go:32-33` |
| Host program xpra flags, window fit | `daemon-adapter/internal/capsule/host_xpra.go:278`, `daemon-adapter/internal/capsule/host_xpra.go:422` |
| Host window loss classification | `daemon-adapter/internal/capsule/host_window.go:54-73` |
| Role switch eligibility | `daemon-adapter/internal/capsule/role_switch.go:21` |
| Opening request schema (schema before code, see [LAWS.md](../../LAWS.md)) | `daemon-adapter/internal/capsule/opening_mode.go:88-101` |
| Frame poll interval, failure tolerance | `daemon-adapter/internal/frames/ringmode.go:14`, `daemon-adapter/internal/frames/subscriptions.go:64` |
| Recording budgets | `daemon-adapter/internal/record/record.go:241-243` |
| Journal limits | `daemon-adapter/internal/resourceinventory/ledger.go:24-26` |
| Guest VM size and lifetime | `daemon-adapter/guest_command_runtime/native.py:152` |
| Guest wire limits | `daemon-adapter/guest-command-broker/src/wire.rs:9-12` |
| Judge environment allowlist for the app | `scripts/judge/metaviewer-judge.sh:819-826` |
| Preflight thresholds | `scripts/judge/preflight.sh:269-273` |

## 15. How do I test it, and what was run here?

Answers: run adapter tests; go test; cargo test; which tests pass; how to verify

These commands were run in this lane's container (x86_64, no KVM, no docker daemon):

| Command | Result |
|---|---|
| `cd daemon-adapter && go test ./internal/capsule/` | ok [MEASURED] |
| `cd daemon-adapter && go test ./internal/daemon/ ./internal/cli/ ./cmd/...` | ok [MEASURED] |
| `cd daemon-adapter && go test ./internal/frames/ ./internal/view/` | ok [MEASURED] |
| `cd daemon-adapter && go test ./internal/ipc/ ./internal/record/ ./internal/resourceinventory/ ./internal/capsule/slots/` | ok [MEASURED] |
| `cd daemon-adapter && go test ./internal/guestcommand/ ./internal/headless/` | ok [MEASURED] |
| `cd daemon-adapter/guest-command-broker && cargo test --locked` | 27 lib tests and 2 doc-tests passed [MEASURED] |
| `... cargo test --locked --features rewind-profile` | 28 lib tests, 5 rewind tests and 2 doc-tests passed [MEASURED] |
| `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest tests.judge.test_static` | 7 OK [MEASURED] |
| `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest tests.judge.test_preflight` | Fails as root, because every case hits `JUDGE_ROOT` (`scripts/judge/preflight.sh:520`). Run it as a normal user. [MEASURED] |
| `cd daemon-adapter && PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s rewind_runtime -t .` | 2 errors in `test_recovery.py`. *Inferred* cause: this container's cgroup is `/`. [MEASURED] |
| `guest_command_runtime` tests `test_wire`, `test_image`, `test_console` | Pass only when run from inside that folder, because they use flat imports [MEASURED] |

Not run here: anything that needs KVM, an ARM64 host, docker, xpra or a real display. That covers VM, MicroVM, rewind, live host xpra (`daemon-adapter/internal/capsule/host_xpra_live_test.go`) and a static ARM64 broker build. Always run Python tests with `PYTHONDONTWRITEBYTECODE=1` to keep the tree clean.

## 16. What tradeoffs were made, and what was rejected?

Answers: why this design; rejected alternatives; tradeoffs; why not retry; why substring matching

| Decision | Cost accepted | Coordinate |
|---|---|---|
| Uncertain starts are never retried automatically | A capsule can stay quarantined until a person verifies removal | `daemon-adapter/internal/capsule/manager.go:9-14` |
| RAM reservations survive PID death | False refusals after a crash; a reclaim tool exists | `daemon-adapter/internal/daemon/ram_admission.go:278-281` |
| In-flight creates finish for 10 s instead of a group SIGKILL | Slower shutdown, but no unprovable capsule | `daemon-adapter/internal/daemon/ram_admission.go:175-179` |
| `capture_failed` hides the cause from the wire | The cause is only on stderr | `daemon-adapter/internal/frames/subscriptions.go:701` |
| One resident `getimage` loop instead of a `docker exec` per frame, because the native reader has no stream verb | Unverified live view, separate from verified frames | `daemon-adapter/internal/frames/displaytap.go:395-401` |
| Ring mode never falls back to the CLI after selection | No silent mode change mid-session | `daemon-adapter/internal/frames/ringsource.go:3-5` |
| Paste only for non-ASCII human text, because xdotool type drops non-ASCII | About 1.7 s per paste [CITED: daemon-adapter/internal/capsule/manager.go] | `daemon-adapter/internal/capsule/manager.go:165-166` |
| Host-xpra picks a random display and relies on the Xvfb lock | No fixed display pool | `daemon-adapter/internal/capsule/host_xpra.go:243` |
| An AppArmor profile instead of turning off the user namespace sysctl machine-wide | One extra install step | `scripts/judge/apparmor/metaviewer:3-7` |
| Rewind cancel was rejected; use stop | Fewer controls | `daemon-adapter/rewind_runtime/SCOPE.md:15` |
| Guest seccomp is a denylist | Syscalls not listed are allowed | `daemon-adapter/guest-command-broker/src/seccomp.rs:136` |

## 17. What is absent or unverified?

Answers: what is not known; limitations of this dossier; stale findings

- A rotation tool for the replay ledger: ABSENT — do not invent.
- A test for the full-journal bound of 8 MiB or 8192 rows: ABSENT; no test drives it.
- An in-area tool that clears a leftover guest-command reservation marker: ABSENT — do not invent.
- A launcher flag spelled `--arm64`: ABSENT in this tree. The adapter mode is `MV_ARM64_CAPSULES=1`.
- The rows in `route/nodes.jsonl` are pinned to an older commit, and many read STALE. The rows in `route/study/adapter.jsonl` were checked FRESH on this tree when written, and become hints once the code changes.
- No human reviewed these findings. They are coordinates, not proof.

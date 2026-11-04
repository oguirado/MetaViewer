# Opt-in headless controller

`MV_HEADLESS_PROFILE` names a private host-owned regular JSON file, with no group/other permissions and no symlink components. When absent, no headless manager or service is created. When `config_template.runtime_admitted` is false, requests return `UNAVAILABLE` before process creation. This interface does not publish surfaces or frames.

Set `MV_HEADLESS_ONLY=1` explicitly to bootstrap without any graphical/native profile or SRF paths. This requires the valid headless host profile, core registration (`MV_SESSION_ID`, `MV_CORE_INSTANCE`, `MV_DAEMON_INSTANCE`), and `XDG_RUNTIME_DIR`; it retains the existing build/contract/core-pin configuration. Other nonempty mode values refuse startup. This mode creates no capsule, frame, view or recording manager. Surface enumeration is empty, and graphical/recording operations receive typed policy refusals. Its replay ledger lives in the protected profile state root. Without this mode, existing graphical bootstrap requirements remain unchanged.

The closed profile schema is `mv-headless-host/v1`:

| Field | Host responsibility |
|---|---|
| `owner_id` | `actor-` plus lowercase SHA-256 of UTF-8 `agent:` concatenated with the registered agent instance. Must match the core's configured single owner. |
| `guardian_unit` | Active systemd user service/scope whose actual ControlGroup contains the daemon. Optional `MV_HEADLESS_GUARDIAN_UNIT`, if set, must equal it. |
| `python`, `runner` | Objects containing canonical absolute `path` and lowercase `sha256`. Python must be an executable host-provisioned interpreter; runner is this package's `tools/headless_runner.py`. |
| `python_prefix` | Canonical absolute prefix measured from that interpreter. Both original and private snapshot must import the required standard-library modules and report this exact prefix/base prefix before service launch. |
| `controller_relative` | Exactly `mc06-controller/controller.py`. |
| `files` | Exact entries containing `relative`, canonical `path`, and `sha256`, listed below. No additional files or bytecode. |
| `config_template` | Closed `mc06-host-config/v1` object. Host supplies artifact pins, matching owner, generation, explicit admission, fixed resources and deadlines. |
| `state_root`, `runtime_root` | Separate canonical, private, current-user-owned directories. A new lifecycle directory is allocated beneath each; old directories are never reused. |

The required source closure is:

* `mc06-controller/controller.py`
* `mc06-controller/arm_backend.py`
* `mc06-controller/contract_guard.py`
* `mc04-runtime/arm_harness.py`
* `mc05-contract-candidate/reference_model.py`
* `mc05-contract-candidate/contracts/v0.2/headless_request.schema.json`
* `mc05-contract-candidate/contracts/v0.2/headless_event.schema.json`
* `mc05-contract-candidate/contracts/v0.2/headless_session.schema.json`

The adapter snapshots verified bytes, including the executable interpreter with mode 0500, into its private attempt directory. Original pinned files must belong to root or the current user and must not be group/other writable. Reads reject nonregular files without blocking, and recheck descriptor/path metadata after bounded reads. Before service creation, bounded isolated probes import json, pathlib, socket, select, ctypes, hashlib and threading from both interpreter locations and compare their reported prefix/base prefix with the protected profile. A relocation failure refuses startup; no install or interpreter fallback occurs. The isolated interpreter loads only the pinned local controller modules and standard library. The controller also verifies its intrinsic dependency pins. The runner replaces `external_cgroup` with its actual cgroup and `runtime_root` with the new private runtime directory. The controller's state directory is new and distinct. Artifact paths remain host-configured, subject to the existing controller's digest, architecture and admission checks.

The service is bounded by MemoryMax=512M, MemorySwapMax=0, CPUQuota=100%, TasksMax=64 and RuntimeMaxSec=180 [TARGET]. It uses BindsTo/After the verified guardian, KillMode=control-group and no restart. The same controller stdin/stdout remains open across create, run and stop. Requests are never retried; both line size and response count are bounded. The existing authenticated core channel and schema policy remain mandatory.

The durable reservation precedes service creation. A companion preparation record stores allocated directory device/inode identities. Before admitting readiness, the adapter records the actual service InvocationID, MainPID/start, cgroup path/device/inode and requires a retained Linux process handle. Emergency termination revalidates that identity and signals only the retained process handle; it never stops a reusable unit name. Missing or changed evidence refuses termination. An existing reservation blocks another manager, including after a crash. No automatic reconciliation or deletion is provided. A stopped event is withheld until the controller has supplied its stopped/released proof, the service client exits successfully, the retained main process is gone and the recorded cgroup is empty or absent. A same-name replacement does not satisfy closure. A closure companion records that result; the original custody records remain intact.

If create is unacknowledged, the public schema cannot describe an unknown outcome without inventing a workload ID. The adapter closes the channel with an error and retains the reservation. For an established session, valid `outcome_unknown` events retain ownership and permit only a distinct stop request on the still-valid controller stream. Transport or contract uncertainty poisons that stream and prevents further requests. Application shutdown closes the controller input and stops only its own recorded service if needed; the guardian also owns service lifetime. Unknown cleanup never authorizes another attempt. Normal guest stop, observed already-exited guest reconciliation, and forced guardian cleanup remain distinguishable in the controller's private evidence; public stopped events assert confirmed resource release only.

This is an isolated source candidate. Synthetic tests and an offline build do not establish service startup, Firecracker boot, guest execution, application teardown or release readiness.

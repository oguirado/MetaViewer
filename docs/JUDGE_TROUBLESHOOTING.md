# Judge troubleshooting

Use this from the kit root on Linux x64 or arm64. Start with the area matching
what you were doing; use **Ctrl+F** to find the exact code. The first column is
an exact stable code or literal message,
not a paraphrase of a diagnostic. Variable paths, PIDs and details still come from
the actual output. The shell prints `CODE: problem -- fix: command`; use that
occurrence’s fix when one code covers several failures. Commands below are advice,
not actions performed by this page. Replace angle-bracket placeholders with values
from the diagnostic or release maintainer; never paste them literally.

[Quickstart](JUDGE_QUICKSTART.md) · [Tour and architecture verification table](JUDGE_TOUR.md#architecture-support-at-this-snapshot)

The tour’s architecture table scopes live verification. The release-package x64
WSL2 evaluation at c26/c27 [CITED: maintainer evaluation] measured browser rules
goals 10 of 10 [MEASURED]; Open network with its firewall step reached a public
site with HTTP 200 [MEASURED], with local network and Docker bridge blocked.
Agent `gnome-calculator` launched through both Host program and isolated Program;
Desktop window `gedit` attach, type, resize and closed message, login wall
`HUMAN_HANDOFF`, and clean stop were observed. Typed calculator `2+3` exited
with rc 0 [MEASURED] but `PROGRAM_TEXT_UNCERTIFIED_NOT_READABLE`; do not certify
readback or arithmetic. Muse on x64 and real mouse drag under a window manager
remain unverified. Arm64 kit installation is not separately attested.
“No known remedy” means stop and preserve the diagnostic, not guess a command
or weaken a check.

Before repeating any input, inspect the report and current capsule. `INPUT_UNCERTAIN`
may mean an effect already happened. Use **Release** after human takeover and obtain
a fresh observation before new agent input. Closing a tile with **✕** does not stop
its capsule; use **⋮ → Stop capsule**.

Rules goals need the unique exact visible control name, including in a browser:
`MW_PROGRAM_GOAL_UNGROUNDED` can therefore appear during a browser goal. The browser
planner uses the same grounding check ([code](../tools/mw_run_browser_goal.py),
[check](../tools/mw_run_program.py)). Use the current observed name, not an invented
task description. Sending text again to an already filled browser
field can produce `MW_BROWSER_TEXT_MISMATCH`; inspect and reconcile the field before
considering new input ([readback](../tools/mw_run_browser_goal.py)).

**Program** looks the binary up on your computer; a container image does not make a
missing host binary available ([lookup](../daemon-adapter/internal/capsule/opening_mode.go)).
**Host program** needs xpra and runs with real host access; it is not isolated
([runtime](../daemon-adapter/internal/capsule/host_xpra.go)). The tour records the
observed launch results and live-check limits; these source facts do not upgrade them.
`PROGRAM_TEXT_UNCERTIFIED_NOT_READABLE` means typed but not read by OCR.
Verdicts ending in `_BOUNDED_ACTIONS_VERIFIED` prove the moves, never the goal.

The tables include shipped runner remedies, judge launcher/preflight refusals,
adapter fault categories and Electron’s literal rejection codes. Internal shell
guards may provide only a code: their unknown repair is stated explicitly rather
than presenting an untested reinstall or retry as a cure. `MW_GATE_` is the shipped
prefix for dynamic gate codes; `NO_IDENTITY__` carries an encoded missing identity
in some shell refusals (use the displayed missing identity, not the encoded suffix).
External codes not in these sources can still occur.
For an unrecognized code, retain the diagnostic and report and reconcile the capsule
state before continuing; no source-backed code-specific remedy is available.


## Kit install and run

| Exact code or message | Meaning | Next command or click | Source |
| --- | --- | --- | --- |
| `JUDGE_PREFLIGHT_FAIL` | The selected preflight phase found refusals; the count is a summary, not a separate diagnosis. | Read each preceding `JUDGE_…` diagnostic and its `-- fix:`, then run `bash scripts/judge/metaviewer-judge.sh doctor --capsules --before-install` for host prerequisites, or `bash scripts/judge/metaviewer-judge.sh doctor --capsules` for the installed runtime. | [code](../scripts/judge/preflight.sh) |
| `JUDGE_USAGE` | Invalid command, options, HOME or installation directory. | Run `bash scripts/judge/metaviewer-judge.sh doctor --capsules --before-install`; for an invalid home, `unset MV_JUDGE_HOME`. | [code](../scripts/judge/preflight.sh) |
| `JUDGE_SUDO` | An administrator step was declined, unavailable or failed; package setup may have failed at sudo authorization or apt-get. | Inspect the printed command and its error. If sudo needs a password or refuses this user, ask an administrator to install the listed packages, then rerun install as your normal user. | [code](../scripts/judge/metaviewer-judge.sh) |
| `JUDGE_PIDFILE` | The launcher cannot lock or publish its owned process record. | Make the directory named in the diagnostic writable, then rerun the same command. | [code](../scripts/judge/metaviewer-judge.sh) |
| `JUDGE_RUNNING` | The app or another launcher already owns the run. | For a running app: `bash scripts/judge/metaviewer-judge.sh stop`; for an active launcher: wait for it to finish. | [code](../scripts/judge/metaviewer-judge.sh) |
| `JUDGE_ASSET` | A release asset, checksum, extraction or receipt cannot be trusted or written. | Follow this occurrence’s printed `-- fix:`; missing sums: `python3 scripts/judge/fetch_assets.py --source "<complete-release-directory>"` (replace the placeholder with the maintainer’s directory). | [code](../scripts/judge/metaviewer-judge.sh) |
| `JUDGE_SYSDEP` | A required system tool or package installation is missing or failed. | Run the exact `sudo apt-get install -y …` printed in `-- fix:`. | [code](../scripts/judge/preflight.sh) |
| `JUDGE_NODE` | The Node runtime is missing or too old. | Run `bash scripts/judge/metaviewer-judge.sh install` to install the kit runtime. | [code](../scripts/judge/preflight.sh) |
| `JUDGE_USERNS` | The required AppArmor profile or loader is unavailable. | Run `bash scripts/judge/metaviewer-judge.sh install`; if the loader is missing, `sudo apt-get install -y apparmor`. | [code](../scripts/judge/preflight.sh) |
| `JUDGE_NPM` | The Node asset lacks npm needed by package verification. | Run `sudo apt-get install -y npm`. | [code](../scripts/judge/metaviewer-judge.sh) |
| `JUDGE_ROOT` | Electron cannot run safely as root. | Log in as a normal user and re-run without sudo; install requests its own administrator steps. Never disable the sandbox. | [code](../scripts/judge/preflight.sh) |
| `JUDGE_SMOKE` | Package verification, tool dependency installation or application smoke failed. | Read the log named in `-- fix:`; restore the full kit for a missing tool, or replace the tarball for a verification failure. Use a non-root user and check DISPLAY/xvfb-run and the AppArmor profile before reinstalling. | [code](../scripts/judge/metaviewer-judge.sh) |
| `JUDGE_IMAGE` | A required capsule image is missing, incompatible or could not load. | Run `bash scripts/judge/metaviewer-judge.sh install --capsules`; if Open firewall is active but its image is absent, obtain the compatible kit named in the diagnostic. | [code](../scripts/judge/preflight.sh) |
| `JUDGE_PROFILE` | The profile pool or its private directories are invalid. | Run `bash scripts/judge/metaviewer-judge.sh install --capsules`; for an invalid custom pool use the printed diagnostic before provisioning it. | [code](../scripts/judge/preflight.sh) |
| `JUDGE_NET` | Capsule routes, network, proxy or private proxy metadata are not ready. | Run `bash scripts/judge/metaviewer-judge.sh install --capsules` for missing network setup. For overlapping routes or a mismatched existing proxy, follow the printed operator recovery diagnostic; no general automatic repair is supplied. | [code](../scripts/judge/preflight.sh) |
| `JUDGE_NOT_INSTALLED` | The app or valid installation receipt is absent. | Run `bash scripts/judge/metaviewer-judge.sh install` (add `--capsules` for live capsules). | [code](../scripts/judge/metaviewer-judge.sh) |
| `JUDGE_ARCH` | The machine architecture is unsupported. | Use Linux x64 or arm64; no command converts an incompatible host. | [code](../scripts/judge/preflight.sh) |
| `JUDGE_BUNDLE_ARCH` | The kit or its binaries target a different architecture. | Obtain the tarball for the architecture printed by the script, then run `bash scripts/judge/metaviewer-judge.sh install`. | [code](../scripts/judge/preflight.sh) |
| `JUDGE_DISPLAY` | No reachable X display is proved. | For headless installation: `xvfb-run -a bash scripts/judge/metaviewer-judge.sh install --capsules`; if xdpyinfo is missing: `sudo apt-get install -y x11-utils`. For visible use, choose a reachable desktop DISPLAY. | [code](../scripts/judge/preflight.sh) |
| `JUDGE_XDG_RUNTIME` | The login runtime directory is absent or foreign-owned. | Use a desktop logind session; on WSL enable `systemd=true` under `[boot]` in `/etc/wsl.conf`, then run `wsl --shutdown` from Windows. | [code](../scripts/judge/preflight.sh) |
| `JUDGE_SHM` | Shared memory is not tmpfs or has insufficient free capacity. | Free shared memory; for an existing tmpfs at the normal location the source suggests `sudo mount -o remount,size=4g /dev/shm` [CITED: preflight.sh]. Follow the printed path if configured differently. | [code](../scripts/judge/preflight.sh) |
| `JUDGE_RAM` | Available memory cannot be read or is below the admission floor. | Close applications or add RAM; on WSL raise `memory=` in `.wslconfig`. For unreadable meminfo, mount `/proc` and rerun. | [code](../scripts/judge/preflight.sh) |
| `JUDGE_CPUSET` | Explicitly requested CPU pinning includes unusable CPUs. | Use a host satisfying the cpuset printed in the diagnostic; no automatic repinning remedy is supplied. | [code](../scripts/judge/preflight.sh) |
| `JUDGE_DOCKER_HOST` | A remote/rootless Docker override is set. | Run `unset DOCKER_HOST DOCKER_CONTEXT`. | [code](../scripts/judge/preflight.sh) |
| `JUDGE_DOCKER` | Docker is inaccessible, rootless or uses a nonlocal endpoint. | Without Docker, omit `--capsules` and follow [app-only judging](JUDGE_NO_DOCKER.md). For group access: `sudo usermod -aG docker "$USER"`, then log out and in. For a nonlocal context: `docker context use default`. For rootless mode, install rootful Docker and run `systemctl --user disable --now docker` as directed. | [code](../scripts/judge/preflight.sh) |
| `JUDGE_DOCKER_DESKTOP` | Docker Desktop cannot bind the required host paths. | Install docker-ce inside the distro and stop Docker Desktop integration; no installation command is supplied by this refusal. | [code](../scripts/judge/preflight.sh) |
| `JUDGE_RAM_STALE` | Dead-owner admission records remain, or the inspection itself is unavailable. | When dead owners are proved: `python3 tools/mv_ram_admission.py reclaim --dry-run`, inspect it, then `python3 tools/mv_ram_admission.py reclaim --apply`. A failed or absent inspection is not a clean result. | [code](../scripts/judge/preflight.sh) |
| `JUDGE_DISK` | The installation or Docker filesystem lacks free space. | Run the exact `df -h …` printed in `-- fix:` and free space on the named filesystem. | [code](../scripts/judge/preflight.sh) |
| `JUDGE_NOTE` | Advisory output; a warning is not a passing check or a fatal refusal. | Read the warning’s named code in this table and its actual diagnostic; no generic remedy applies. | [code](../scripts/judge/preflight.sh) |
| `JUDGE_OS` | Warning: this host differs from the verified Ubuntu release. | No repair command is supplied; retain the warning and the tour’s platform limits. | [code](../scripts/judge/preflight.sh) |
| `JUDGE_HOST_PROGRAM` | Optional capability: Host program is disabled because xpra is absent. | Run `apt install xpra` with administrator privileges, as printed by preflight. | [code](../scripts/judge/preflight.sh) |
| `ARGS` | The request has the wrong argument count or argument shape. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/authorityWire.js) |
| `ARGS_FLAG` | only hermetic flags allowed | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `ARGS_ITEM` | extra args must be bounded NUL-free strings | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `ARGS_SHAPE` | extra args must be an array within cap | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `ARGS_SHELL` | hermetic flags require a bash shell | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `ARGV0_DASH` | argv[0] must not start with a dash | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `ARGV0_EMPTY` | argv[0] must be non-empty | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `ARGV_BYTES` | A launch argument exceeds its byte limit. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `ARGV_ITEM` | argv items must be strings | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `ARGV_LENGTH` | The launch argument list has an invalid length. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `ARGV_NUL` | argv items must not contain NUL | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `ARGV_SHAPE` | Launch arguments are not a bounded array of valid strings. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/main.js) |
| `ARG_INVALID` | cannot quote invalid shell arg | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `BAD_OUTCOME` | terminal outcome must carry ok | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `BOOT_ADAPTER` | adapter must provide start, dispose and getStatus | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/main.js) |
| `BOOT_CORE` | core must provide start, request, dispose and getStatus | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/main.js) |
| `BOOT_HANDLES` | handles must be an object | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/main.js) |
| `BOOT_SESSION` | session must be an object | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/main.js) |
| `BRAKE_SHAPE` | burst must be a positive safe integer | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `BRIDGE_DISPOSED` | terminal bridge is disposed | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `BRIDGE_PARITY` | bridge must carry exactly the two layout entries | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/main.js) |
| `BRIDGE_SHAPE` | ipcMain seam is required | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `BUTTON_ARGS` | A prompt-button request has invalid fields or identifiers. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/preload.js) |
| `BUTTON_REPLY` | The prompt-button response does not match its expected shape. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/preload.js) |
| `CALLBACKS` | callbacks must provide onStatus | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/coreLauncher.js) |
| `CLASS_LIMIT` | The live terminal limit for this session class is reached. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `CLIPBOARD_BOUND` | Clipboard text is empty or exceeds the permitted size. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/buttonBridge.js) |
| `CLOSED_OR_INVALID` | The terminal session is closed or its incoming message is invalid. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptySession.js) |
| `COMMAND` | command must be a bounded absolute path | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/coreLauncher.js) |
| `COMMAND_MISMATCH` | The requested command differs from the selected provider profile. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `COMMAND_NOT_ALLOWED` | The requested terminal executable or arguments are outside the configured profile. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/authorityWire.js) |
| `COMMAND_SHAPE` | The requested terminal command is neither shell nor provider. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `CORE_SEAMS_ABSENT` | The shell has no live core connection available. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/hostBindings.js) |
| `CORE_TIMEOUT` | The core request did not settle before its deadline. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/hostBindings.js) |
| `CORE_UNAVAILABLE` | The core connection is unavailable, disposed or unwritable. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/hostBindings.js) |
| `CSP_NONCE` | style nonce must be 32 base64 characters | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/main.js) |
| `DEMO_RUNTIME` | The demonstration runtime root is not configured. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/buttonBridge.js) |
| `DIMS_RANGE` | Terminal rows or columns are outside the permitted bounds. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `EGRESS_RECORD` | The capsule egress record fails validation. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/operatorBridge.js) |
| `ELECTRON_PIN` | The running Electron version does not match the pinned version. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/main.js) |
| `ENGINE_SHAPE` | transport is required | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `ENV_ALLOWLIST` | allowlist must be an array | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `ENV_BYTES` | A process environment value exceeds its byte limit. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `ENV_NAME` | allowlist names must match env grammar | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `ENV_NUL` | A process environment value contains a NUL character. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `ENV_PATH` | PATH must sanitize to at least one absolute segment | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/coreLauncher.js) |
| `ENV_RUNTIME` | runtime directory must be a bounded absolute path | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/coreLauncher.js) |
| `ENV_SCRUB` | The process environment contains a forbidden scrubbed variable. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `ENV_SECRET` | The process environment contains a credential-like variable name. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `ENV_SHAPE` | parent environment must be an object | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/coreLauncher.js) |
| `ENV_VALUE` | A process environment value is not a string. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `ERR_CLIPBOARD_INVALID` | The clipboard operation or its text failed validation. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/authorityWire.js) |
| `FACADE_SHAPE` | facade needs request and subscribe seams | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `FACADE_VALUE` | The facade value does not match the expected contract. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `FRAMER_CHUNK` | framer chunks must be strings | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `FRAMER_SHAPE` | maxLineBytes must be a positive safe integer | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `FRAME_BINDING` | The frame or stream binding does not match the expected surface binding. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/authorityWire.js) |
| `FRAME_DETACHED` | The sending frame is detached. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/main.js) |
| `FRAME_DIAG_ARGS` | frames.reportDiag requires exactly one argument | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/frameDiag.js) |
| `FRAME_DIAG_DECREASE` | rehash diag counters must not decrease | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/frameDiag.js) |
| `FRAME_DIAG_DISPOSED` | frame diag bridge is disposed | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/frameDiag.js) |
| `FRAME_DIAG_OPTIONS` | options must be an object | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/frameDiag.js) |
| `FRAME_DIAG_PAYLOAD` | frames.reportDiag requires plain object {rehashSkipped, rehashDone} | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/frameDiag.js) |
| `FRAME_DIAG_RUN_DIR` | frame diag run dir must be outside repository root | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/frameDiag.js) |
| `FRAME_DIAG_SYMLINK` | frame-diag.json must not be a symlink or non-regular file | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/frameDiag.js) |
| `FRAME_DIAG_WRITE` | unable to inspect frame-diag.json target | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/frameDiag.js) |
| `FRAME_NULL` | No sending frame can be established. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/main.js) |
| `FRAME_ORIGIN` | The sending frame does not have the required privileged origin. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/main.js) |
| `FRAME_STREAM_CAP` | The frame stream subscription limit is reached. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/authorityWire.js) |
| `FRAME_URL` | The sending frame URL is not admitted. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/main.js) |
| `HANDLE` | The supplied handle fails the required contract. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/main.js) |
| `HANDOFF_RECORD` | The handoff record fails validation. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/operatorBridge.js) |
| `HANDSHAKE` | handshake must be a function | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/coreLauncher.js) |
| `INTENT` | The UI intent fails closed-schema validation. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/authorityWire.js) |
| `INTENT_REFUSED` | The host did not admit the UI intent. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/hostBindings.js) |
| `INVALID_ACK` | A terminal acknowledgement has invalid ordering or byte accounting. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptySession.js) |
| `INVALID_INPUT` | Terminal input has an invalid sequence or exceeds the message size bound. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptySession.js) |
| `INVALID_MESSAGE` | The terminal message is not a supported valid message. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptySession.js) |
| `INVALID_SESSION` | The terminal session identifier fails validation. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptySession.js) |
| `INVALID_SPAWN_SPEC` | The terminal spawn specification fails validation. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptySession.js) |
| `IPC` | ipcMain must provide handle | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/frameDiag.js) |
| `KILLFN` | killFn must be a function | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/coreLauncher.js) |
| `LAYOUT_BOUNDS` | load accepts no payload | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/main.js) |
| `LAYOUT_CONTRACT_ABSENT` | layout storage unavailable | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/main.js) |
| `LAYOUT_CONTRACT_INVALID` | layout contract refused | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/main.js) |
| `LAYOUT_IN_REPO` | layout contract refused: inside source tree | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/main.js) |
| `LIFECYCLE` | ready-to-show wiring refused | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/main.js) |
| `LIMITS` | limits must carry exactly the bound keys | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/coreLauncher.js) |
| `LIMITS_KEY` | A limit override names an unsupported key. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `LIMITS_SHAPE` | limits overrides must be a record | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `LIMITS_VALUE` | A limit override is not a positive safe integer. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `LIMITS_WATER` | need 0 < lowWaterBytes < highWaterBytes | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `LINK_MESSAGE` | link messages must be records | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `LINK_SHAPE` | stdio link needs an input emitter | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `LOAD` | contents cannot load the bundle URL | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/main.js) |
| `MODES` | The configured capsule network modes fail validation. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/operatorBridge.js) |
| `NATIVE_ABSENT` | node-pty is not installed | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `NATIVE_ENV` | env must be a record for native resolution | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `NATIVE_OVERRIDE` | native override must not contain NUL | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `NOT_DIRECTORY` | The requested recording destination is not an existing directory. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/authorityWire.js) |
| `NO_IDENTITY` | No free configured profile has an identity yet. | Open **Identities**, create the exact identity named in the refusal so it matches a free profile in `MV_SRF_PROFILES`, then **＋ Add capsule**. | [code](../ui/electron/profilePicker.js) |
| `OPERATOR_ARGS` | The operator method or argument count is invalid. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/preload.js) |
| `OPERATOR_PAYLOAD` | The operator request fields fail validation. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/preload.js) |
| `OPERATOR_REPLY` | The operator response fields fail validation. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/preload.js) |
| `OPERATOR_SENDER` | The operator request sender is not admitted or the handler is disposed. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/operatorBridge.js) |
| `OPTIONS` | options must carry exactly the launcher keys | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/coreLauncher.js) |
| `OUTCOME` | The host response does not match the expected outcome contract. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/authorityWire.js) |
| `OWNERSHIP` | ownership must provide ownedPids and waitForExit | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/coreLauncher.js) |
| `PATHS_APP` | app must be an object | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/main.js) |
| `PATHS_BUNDLE` | renderer bundle root is not admitted | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/main.js) |
| `PATHS_ROOT` | shellRoot must be a bounded absolute path | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/main.js) |
| `PATHS_RUNTIME` | runtime must be a context object | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/main.js) |
| `PATHS_USERDATA` | userData path refused | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/main.js) |
| `PAYLOAD` | The IPC payload fails shape, serialization or size checks. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/authorityWire.js) |
| `PERSISTENCE_FAILED` | Reading back private state did not reproduce the state just written. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/operatorBridge.js) |
| `PICKER_INPUT_INVALID` | The capsule picker could not prepare the request. | Choose **＋ Add capsule** again, as directed by the dialog. | [code](../ui/electron/authorityWire.js) |
| `PRELOAD_ABSENT` | preload entry is not a regular file | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/main.js) |
| `PRELOAD_CONTAINMENT` | preload overlaps renderer root | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/main.js) |
| `PRIVATE_FILE` | A private state file fails ownership, type, permissions or size checks. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/operatorBridge.js) |
| `PRIVATE_PATH` | A private state directory fails the required ownership or permission checks. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/operatorBridge.js) |
| `PROFILE_ARGV` | shell profiles carry an empty argv | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `PROFILE_CLASS` | profile class must be shell, ai, or capsule-ai | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `PROFILE_COMMAND` | profile command must be shell or provider | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `PROFILE_CWD` | profile cwd must be an absolute path | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `PROFILE_EXEC` | provider executable must be absolute | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `PROFILE_ID` | profile ids must match id grammar | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `PROFILE_PATH` | A profile path is oversized or contains a NUL character. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `PROFILE_SHAPE` | spawn profile must be a record | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `PROFILE_SHELL` | profile loginShell must be an absolute path | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `PROMPT_SOURCE` | The prompt source does not contain the required unique text block. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/buttonBridge.js) |
| `PROPOSAL` | The action proposal fails closed-schema validation. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/authorityWire.js) |
| `PROTOCOL` | privileged scheme registration refused | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/main.js) |
| `PROVIDER_SHAPE` | The terminal provider identifier fails validation. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `PTY_SHAPE` | The spawned terminal does not expose the required PTY interface. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `QA_ARGS` | qa.anchors requires exactly one snapshot argument | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/qaAnchors.js) |
| `QA_DISPOSED` | qa anchors bridge is disposed | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/qaAnchors.js) |
| `QA_OPTIONS` | options must be an object | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/qaAnchors.js) |
| `QA_PAYLOAD` | row anchor is invalid | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/qaAnchors.js) |
| `QA_RUN_DIR` | qa run dir must be outside repository root | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/qaAnchors.js) |
| `QA_SYMLINK` | qa-anchors.json must not be a symlink or non-regular file | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/qaAnchors.js) |
| `QA_WRITE` | unable to inspect qa-anchors.json target | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/qaAnchors.js) |
| `READY` | app readiness refused | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/main.js) |
| `RENDERER_READY` | renderer ready sender refused | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/main.js) |
| `REQUEST_FAILED` | The capability request failed. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `RESOLVER_ARGV0` | argv0 must be a non-empty string | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `RESOLVER_SHAPE` | canExecute must be a function | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `RETAIL_ENV` | packaged launch refuses MV_FRAME_DIAG | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/frameDiag.js) |
| `RETAIL_FLAG` | A prohibited launch flag was supplied to the packaged app. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/main.js) |
| `ROOT` | bundle root must be a bounded nonempty string | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/main.js) |
| `RUNTIME_DIR` | runtime dir is not an owner-only caller-owned directory | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/main.js) |
| `RUNTIME_XDG` | XDG runtime dir is missing, unsafe or foreign-owned | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/main.js) |
| `SENDER` | The privileged request sender could not be admitted. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/authorityWire.js) |
| `SESSION_LIMIT` | The total live terminal session limit is reached. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `SESSION_MISMATCH` | The terminal message names a different session. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptySession.js) |
| `SETTINGS_DENSITY` | The requested density is not compact or comfortable. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/authorityWire.js) |
| `SETTINGS_DESTINATION` | MV_RECORDING_DESTINATION must be an existing directory | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/authorityWire.js) |
| `SETTINGS_IN_REPO` | MV_RECORDING_DESTINATION must be outside the source tree | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/authorityWire.js) |
| `SETTINGS_RECORDING_FPS` | The requested recording cadence is outside the supported integer range. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/authorityWire.js) |
| `SETTINGS_SCHEME` | The requested scheme is not mv-light or mv-dark. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/authorityWire.js) |
| `SETTINGS_UNKNOWN_KEY` | A settings update contains an unsupported key or property form. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/authorityWire.js) |
| `SETTINGS_WALL_FPS` | The requested wall cadence is not a supported value. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/authorityWire.js) |
| `SINGLE_INSTANCE` | another instance holds the lock | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/main.js) |
| `SPAWN` | spawn must be a function | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/coreLauncher.js) |
| `SPAWN_BRAKE` | The terminal launch circuit breaker rejected another attempt. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `SPAWN_CWD` | broker cwd must be a non-empty absolute path | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `SPAWN_ENTRY` | broker entry must be a non-empty absolute path | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `SPAWN_FAILED` | Creating the terminal process failed. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `SPAWN_RUNTIME` | runtime must be main-injected | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `SPAWN_SHAPE` | electron fork must return a utility process | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `SUBFRAME` | A subframe attempted a privileged top-frame operation. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/main.js) |
| `SUBSCRIBE_FAILED` | facade subscribe failed | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `TRANSPORT` | transport must provide connect, request and close | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/coreLauncher.js) |
| `TRANSPORT_DISPOSED` | broker transport is disposed | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `TRANSPORT_MESSAGE` | broker messages must be non-empty strings | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `TRANSPORT_SHAPE` | listener must be a function | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `UNKNOWN_PROVIDER` | The selected terminal provider is not configured for the requested command. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `UNKNOWN_SWITCH` | A launch switch is not recognized by the retail guard. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/main.js) |
| `UNOWNED_PID` | The requested process is not an admitted owned child. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/terminalHost.js) |
| `WINDOW` | window construction refused | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/main.js) |
| `WINDOW_PROFILE_FORBIDDEN` | A Desktop window request must not provide a capsule profile. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/roleHost.js) |



## Capsules

**Reused X11 id:** a closed Desktop window tile can retain an id later reused by
a new window. **Add** then refuses because the window is already attached.
Press **Stop** on the old tile, including a tile showing the closed message,
then refresh and select the intended live window. Closing with **✕** only hides
it. The x64 observation is not permission to bypass the binding check
[CITED: operator evaluation, c26/c27; [binding check](../ui/electron/roleHost.js)].

| Exact code or message | Meaning | Next command or click | Source |
| --- | --- | --- | --- |
| `MW_IDENTITY` | The identity is invalid or unavailable. | Select an existing identity and run again. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_RUN_NO_SURFACE` | No live capsule matches the identity. | Start a capsule for that identity before running again. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_RUN_AMBIGUOUS` | More than one surface or ownership route matches. | Close extra capsules for this identity and select a single live capsule. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_RUN_OWNERSHIP` | Capsule ownership changed or cannot be proved. | Select the intended capsule and verify its identity before running again. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_RUN_REGISTRATION` | The core agent registration is missing or ambiguous. | Use the running app configuration and select its registered agent with MV_AGENT_INSTANCE. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_RUN_ATTACH` | The runner cannot attach to one running app. | Start MetaViewer and use that app’s MV_CORE_CONFIG and XDG_RUNTIME_DIR values. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_RUN_CONFIG` | Runner configuration is missing or invalid. | Check the diagnostic and use the environment values of the running MetaViewer app. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_RUN_CORE` | The core connection failed. | Check that MetaViewer is running and use its core configuration before retrying. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_RUN_NATIVE` | The native observation command failed. | Check the capsule and native tool diagnostic before running again. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_RUN_NATIVE_INPUT` | Native input could not be verified. | Inspect the capsule and report for a delivered effect before considering another input. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_RUN_STATE` | The observed state cannot support this action. | Refresh the capsule observation before planning again. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_RUN_OPERATION` | The requested runner operation is unsupported. | Select a supported workflow operation. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_RUN_RECEIPT` | The run receipt is missing or invalid. | Inspect the report and capsule state before considering another run. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `receipt path absent` | The expected receipt was not written. | Inspect the report and capsule state before considering another run. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_COMPILED_BROWSER_UNAVAILABLE` | The compiled runtime cannot automate browser capsules. | Configure a verified wender-agent checkout with MV_WENDER_ROOT or use supported program automation. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_DEPENDENCY` | A pinned dependency is unavailable or mismatched. | Restore the checkout selected by deps.lock before running again. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_PRIVATE_OUTPUT` | Private evidence could not be written safely. | Use an absolute writable XDG_STATE_HOME outside the repository without symlinked parents. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_NETWORK` | The capsule network context is invalid or changed. | Verify its network setting and restart the capsule after changing it. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `INPUT_UNCERTAIN` | Input may already have been delivered. | Observe and reconcile the capsule state before considering another input. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_WALL_DEADLINE` | The run exceeded its wall deadline. | Inspect the report and capsule state before considering another run. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_FRAME_BINDING` | The frame does not match the active surface. | Acquire a fresh frame from the intended capsule before planning again. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_RECEIPT_MISMATCH` | The receipt does not match the submitted action. | Inspect the report and reconcile the capsule state before continuing. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_STALE_FRAME_EXHAUSTED` | Fresh-frame retries were exhausted. | Check capsule responsiveness and acquire a fresh observation before planning again. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_REBIND_PIXELS` | The rebound frame pixels do not match. | Refresh the capsule observation before planning again. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_REBIND_SURFACE` | The rebound surface does not match. | Select the intended capsule and refresh its observation. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_REBIND_TARGET` | The rebound target cannot be proved. | Refresh the observation and select an unambiguous target. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_AX` | The accessibility observation is unavailable or invalid. | Check native accessibility support and refresh the capsule observation. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_ANSWER_CAPTION_AMBIGUOUS` | The answer caption matches multiple elements. | Give the workflow an unambiguous answer selector. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_ANSWER_CONTAINER` | The answer container cannot be identified. | Repair its workflow selector against a fresh observation. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_ANSWER_TEXT` | The answer text cannot be read reliably. | Inspect the capsule and repair the answer selector before running again. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_SLOT` | Slot arguments are invalid or duplicated. | Supply each slot once as --slot name=value. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_SLOT_READBACK_DEADLINE` | Slot readback exceeded its deadline. | Inspect the editor state before considering another text input. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_SLOT_LENGTH_EDITOR_BINDING` | The editor binding does not match the slot. | Repair the workflow editor binding against a fresh observation. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_SLOT_LENGTH_MISSING_EDITOR_ID` | The slot has no editor identifier. | Add the workflow’s explicit editor identifier before running again. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_SLOT_LENGTH_MISSING_READABLE_TEXT` | The editor has no readable text witness. | Enable supported readback before running again. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_SLOT_LENGTH_TEXT_MISMATCH` | The editor text differs from the slot value. | Inspect and reconcile the editor before considering another text input. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_SLOT_LENGTH_TEXT_OF_UNAVAILABLE` | The editor text reader is unavailable. | Configure supported editor readback before running again. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_SLOT_LENGTH_TRUNCATED_TEXT` | The editor readback is truncated. | Obtain complete readable text before verifying the slot. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_HOME_GIT` | The MemoryWeb ignore check failed. | Repair repository access and rerun tools/mw_home_check.py. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_HOME_NOT_IGNORED` | The MemoryWeb home is not ignored by git. | Configure its ignore rule and rerun tools/mw_home_check.py. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_HOME_SYMLINK` | The MemoryWeb home contains a symlinked path. | Use a private home without symlinks and rerun tools/mw_home_check.py. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_GATE_` | The stored workflow failed its pinned gate. | Repair the site data and rerun tools/mw_home_check.py for the selected workflow. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `OUT_OF_SUPPORT` | The requested action is outside the supported contract. | Inspect the report and choose a supported workflow or take over manually. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `USAGE_SCHEMA` | The request does not match the supported schema. | Correct its arguments or workflow definition before running again. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `SEAL_MISMATCH` | An artifact does not match its pinned seal. | Restore the verified artifact before running again. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `LOW_CONFIDENCE` | The target cannot be identified confidently. | Refresh the observation and select one explicit target. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `CHANGE_MISMATCH` | The observed change does not match the expected effect. | Inspect and reconcile the capsule state before continuing. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `DEADLINE` | The workflow deadline expired. | Inspect the report and capsule state before considering another run. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `TORN` | The workflow journal is incomplete or inconsistent. | Preserve the evidence and recover a verified generation from the last complete prefix. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `STUCK` | The workflow cannot make verified progress. | Inspect the capsule and take over manually or revise the supported workflow. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `REPAIR_EXHAUSTED` | The workflow exhausted its repair attempts. | Inspect the handoff evidence and take over manually. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `STALE_FRAME` | The action refers to a stale frame. | Acquire a fresh observation and plan again. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `NET_DOMAIN_INVALID` | The domain list is not a unique normalized list of exact ASCII hostnames. | No known remedy in this source; preserve the full adapter diagnostic and inspect the capsule before any further input. | [code](../daemon-adapter/internal/capsule/egress.go) |
| `NET_EGRESS_CHANGED` | The egress record changed during network preparation. | No known remedy in this source; preserve the full adapter diagnostic and inspect the capsule before any further input. | [code](../daemon-adapter/internal/capsule/egress_policy.go) |
| `NET_EGRESS_INVALID` | The egress identity, document, mode or policy fails validation; read the accompanying detail. | No known remedy in this source; preserve the full adapter diagnostic and inspect the capsule before any further input. | [code](../daemon-adapter/internal/capsule/egress.go) |
| `NET_OPEN_PREREQ` | Open egress lacks the compatible image or root-owned firewall witness. | Run `bash scripts/judge/metaviewer-judge.sh doctor --capsules` and obtain the compatible kit; no automatic firewall bypass is supplied. | [code](../daemon-adapter/internal/capsule/egress_policy.go) |
| `NET_PROXIED_UNSUPPORTED` | This native runner cannot supply allowlisted egress. | No known remedy in this source; preserve the full adapter diagnostic and inspect the capsule before any further input. | [code](../daemon-adapter/internal/capsule/egress_policy.go) |
| `POLICY` | The surface lifecycle, role, ownership or capture policy forbids this operation; read the accompanying detail. | No known remedy in this source; preserve the full adapter diagnostic and inspect the capsule before any further input. | [code](../daemon-adapter/internal/capsule/handoff.go) |
| `SURFACE_NOT_AGENT_CONTROLLED` | Human control blocks agent input or cancelled an in-flight action. | Click **Release** on the tile, obtain a fresh observation, and plan again; inspect any cancelled input first. | [code](../daemon-adapter/internal/capsule/host_window.go) |
| `SURFACE_NOT_HUMAN_CONTROLLED` | Agent control blocks human input. | Click **Take control (emergency)** and wait for the authoritative control update. | [code](../daemon-adapter/internal/capsule/host_window.go) |
| `TEXT_TOO_LONG` | The text exceeds the adapter input limit. | No known remedy in this source; preserve the full adapter diagnostic and inspect the capsule before any further input. | [code](../daemon-adapter/internal/capsule/host_window.go) |
| `binding` | The native surface binding is unavailable, inconsistent or already held; read the accompanying detail. | No known remedy in this source; preserve the full adapter diagnostic and inspect the capsule before any further input. | [code](../daemon-adapter/internal/capsule/host_window.go) |
| `configuration` | The native runner or opening configuration fails validation; read the accompanying detail. | No known remedy in this source; preserve the full adapter diagnostic and inspect the capsule before any further input. | [code](../daemon-adapter/internal/capsule/host_window.go) |
| `correlation` | The required request correlation identity is missing or invalid. | No known remedy in this source; preserve the full adapter diagnostic and inspect the capsule before any further input. | [code](../daemon-adapter/internal/capsule/manager.go) |
| `execution` | The native executable is unadmitted or could not start; read the accompanying detail. | No known remedy in this source; preserve the full adapter diagnostic and inspect the capsule before any further input. | [code](../daemon-adapter/internal/capsule/process.go) |
| `frame` | The native frame, capture or publication witness fails validation; read the accompanying detail. | No known remedy in this source; preserve the full adapter diagnostic and inspect the capsule before any further input. | [code](../daemon-adapter/internal/capsule/host_window.go) |
| `host_program_unavailable` | The host binary or Host program runtime is unavailable. | For missing tools run `apt install xpra xvfb xauth xdotool` with administrator privileges [CITED: host_xpra.go]. For a missing binary, install the requested GUI application on the computer, then enter its executable in **Binary name → Start**. Other process-witness failures have no general remedy in source. | [code](../daemon-adapter/internal/capsule/host_xpra.go) |
| `host_window_unavailable` | The selected X11 window, capture or witness is unavailable. | Select an existing X11 window in **＋ Add capsule → Desktop window**; invalid/stale capture witnesses have no general repair command in source. | [code](../daemon-adapter/internal/capsule/identity_profiles.go) |
| `identity_unavailable` | The identity must exist in the configured store. | Open **Identities** to check or create the intended identity, then **＋ Add capsule**. | [code](../daemon-adapter/internal/capsule/identity_profiles.go) |
| `input` | The requested input or its independent verification fails validation; inspect whether any effect was delivered. | No known remedy in this source; preserve the full adapter diagnostic and inspect the capsule before any further input. | [code](../daemon-adapter/internal/capsule/host_window.go) |
| `malformed_cli` | The native CLI result fails the required format or evidence checks. | No known remedy in this source; preserve the full adapter diagnostic and inspect the capsule before any further input. | [code](../daemon-adapter/internal/capsule/capsule.go) |
| `nested_depth` | The requested nesting depth is outside the supported values. | No known remedy in this source; preserve the full adapter diagnostic and inspect the capsule before any further input. | [code](../daemon-adapter/internal/capsule/manager.go) |
| `profile` | The requested profile is invalid or incompatible with the native program mode. | No known remedy in this source; preserve the full adapter diagnostic and inspect the capsule before any further input. | [code](../daemon-adapter/internal/capsule/identity_profiles.go) |
| `protected_container` | The native operation targets a protected container and is refused. | No known remedy in this source; preserve the full adapter diagnostic and inspect the capsule before any further input. | [code](../daemon-adapter/internal/capsule/manager.go) |
| `refused` | The native tool explicitly refused the input. | No known remedy in this source; preserve the full adapter diagnostic and inspect the capsule before any further input. | [code](../daemon-adapter/internal/capsule/host_window.go) |
| `schema` | The surface request uses an unsupported schema. | No known remedy in this source; preserve the full adapter diagnostic and inspect the capsule before any further input. | [code](../daemon-adapter/internal/capsule/manager.go) |
| `surface` | The required active surface is absent, changed or incompatible with the operation. | No known remedy in this source; preserve the full adapter diagnostic and inspect the capsule before any further input. | [code](../daemon-adapter/internal/capsule/handoff.go) |
| `unavailable` | The required native view or capability could not become available; read the accompanying detail. | No known remedy in this source; preserve the full adapter diagnostic and inspect the capsule before any further input. | [code](../daemon-adapter/internal/view/process.go) |
| `uncertain` | A native effect may have happened without a verified result. | No automatic retry remedy is supplied. Inspect the capsule and receipt before considering another action. | [code](../daemon-adapter/internal/capsule/manager.go) |
| `unknown_op` | The adapter does not support the requested surface operation. | No known remedy in this source; preserve the full adapter diagnostic and inspect the capsule before any further input. | [code](../daemon-adapter/internal/capsule/manager.go) |
| `usage` | The surface operation is missing a required argument. | No known remedy in this source; preserve the full adapter diagnostic and inspect the capsule before any further input. | [code](../daemon-adapter/internal/capsule/manager.go) |
| `ADAPTER_ERROR` | The configured surface runtime could not open a capsule. | Check that it is installed and configured, then **＋ Add capsule**; a core-only wall cannot run capsules. | [code](../ui/electron/authorityWire.js) |
| `ADAPTER_SETUP` | The surface runtime setup is unavailable. | Run `bash scripts/judge/metaviewer-judge.sh doctor --capsules`, repair its reported prerequisite, then **＋ Add capsule**. | [code](../ui/electron/authorityWire.js) |
| `CAPSULE_ID` | The capsule identifier fails validation. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/authorityWire.js) |
| `CAPSULE_LIMIT_REACHED` | The concurrent capsule limit is reached. | Click **⋮ → Stop capsule** on an unused capsule, then **＋ Add capsule**. | [code](../ui/electron/authorityWire.js) |
| `CAPSULE_ROLE_INVALID` | The capsule role or profile choice fails validation. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/roleHost.js) |
| `CAPSULE_SLOT_UNAVAILABLE` | No capsule slot is free. | Click **⋮ → Stop capsule** on an unused capsule, then **＋ Add capsule**. | [code](../ui/electron/authorityWire.js) |
| `DISPLAY_ONLY` | Nested walls are display-only and cannot create capsules. | No remedy inside the nested wall is supplied. | [code](../ui/electron/authorityWire.js) |
| `DISPLAY_READER_OPTIONS` | The display reader options are not an options object. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/displayReader.js) |
| `HOST_WINDOW_UNAVAILABLE` | The host window request or native capture is unavailable. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/roleHost.js) |
| `IDENTITY` | caller pid and pgid must be safe integers above zero | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/coreLauncher.js) |
| `IDENTITY_LIMIT` | The identity tool output exceeded its size bound. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/operatorBridge.js) |
| `IDENTITY_LIST_UNAVAILABLE` | The identity list could not be read. | Open **Identities** to check the identity tool, then **＋ Add capsule**. | [code](../ui/electron/authorityWire.js) |
| `IDENTITY_PROTECTED` | The requested identity is foreign or protected from this operation. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/operatorBridge.js) |
| `IDENTITY_REFUSED` | The host refused the identity. | Open **Identities**, check the intended identity, then **＋ Add capsule**. | [code](../ui/electron/authorityWire.js) |
| `IDENTITY_REPLY` | The identity tool returned a response inconsistent with the requested identity. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/operatorBridge.js) |
| `IDENTITY_TIMEOUT` | The identity tool did not finish before its deadline. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/operatorBridge.js) |
| `IDENTITY_UNAVAILABLE` | The identity is unavailable or held by another capsule. | Open **Identities**, check the intended identity, then **＋ Add capsule**. | [code](../ui/electron/authorityWire.js) |
| `NESTED_DEPTH` | The nested-wall depth flags are invalid or contradictory. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/authorityWire.js) |
| `NESTED_DISPLAY_ONLY` | The nested display cannot issue surface input. | No input remedy inside the nested wall is supplied. | [code](../ui/electron/preload.js) |
| `NO_FREE_PROFILE` | All configured profiles are in use. | Stop an unused capsule, or add profiles to `MV_SRF_PROFILES` and restart MetaViewer. | [code](../ui/electron/authorityWire.js) |
| `PROFILE_ALREADY_BOUND` | This profile already belongs to a running capsule. | Reuse the running capsule or click its **⋮ → Stop capsule** before creating another. | [code](../ui/electron/authorityWire.js) |
| `PROGRAM_BINARY_REQUIRED` | Program creation requires a binary. | Enter the installed GUI executable in **Binary name**, then **Start**. | [code](../ui/electron/roleHost.js) |
| `PROGRAM_PROFILE_FORBIDDEN` | A program picker request must not supply a browser profile. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/roleHost.js) |
| `RAM_ADMISSION_REFUSED` | Insufficient free host memory for another capsule. | Close an unused capsule using **⋮ → Stop capsule**, or close other applications; then **＋ Add capsule**. | [code](../ui/electron/authorityWire.js) |
| `RECORD_FAILED` | Recording the terminal launch failed after process creation. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `SURFACE_CAPACITY_OR_QUARANTINE` | Capacity is exhausted or a profile is quarantined. | Stop an unused capsule. If quarantine remains, no recovery command is supplied; preserve the diagnostic for the operator. | [code](../ui/electron/authorityWire.js) |
| `SURFACE_CREATE_BUSY` | Another capsule is starting. | Wait for it to finish, then **＋ Add capsule**. | [code](../ui/electron/authorityWire.js) |
| `SURFACE_CREATE_FAILED` | The host could not start the capsule. | For a core-only install run `bash scripts/judge/metaviewer-judge.sh install --capsules`, restart MetaViewer, then **＋ Add capsule**. Otherwise inspect host logs first. | [code](../ui/electron/authorityWire.js) |
| `SURFACE_CREATE_INVALID` | The create request is invalid. | Choose **＋ Add capsule** again, as directed by the dialog. | [code](../ui/electron/authorityWire.js) |
| `SURFACE_CREATE_KIND_UNAVAILABLE` | This host can create only browser capsules. | No remedy for another capsule kind is supplied by this source. | [code](../ui/electron/authorityWire.js) |
| `SURFACE_CREATE_TIMEOUT` | The capsule did not become ready before its deadline. | The dialog says try again: choose **＋ Add capsule** after checking the existing capsule state. | [code](../ui/electron/authorityWire.js) |
| `SURFACE_PROFILE_BOUND` | Every configured profile is bound. | Reuse a running capsule, stop it, or add profiles to `MV_SRF_PROFILES`. | [code](../ui/electron/authorityWire.js) |
| `SURFACE_PROFILE_QUARANTINED` | The profile is quarantined after an earlier failure. | The dialog says to clear quarantine, but supplies no recovery command. No known remedy; preserve the diagnostic for the operator. | [code](../ui/electron/authorityWire.js) |
| `SURFACE_STATE` | The returned surface state fails validation. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/authorityWire.js) |
| `SURFACE_UNKNOWN` | The surface identifier is invalid or does not identify an admitted surface. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/roleHost.js) |
| `TERMINAL_ARGS` | exactly one argument is required | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `TERMINAL_AUTH` | authentication failed | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `TERMINAL_DISABLED` | The embedded terminal is disabled or its service is unavailable. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/authorityWire.js) |
| `TERMINAL_FORBIDDEN` | The terminal request includes a forbidden authority-bearing field. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `TERMINAL_IO_REFUSED` | The terminal I/O request or session binding was refused. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/authorityWire.js) |
| `TERMINAL_OWNER` | envelope owner mismatch | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `TERMINAL_REFUSED` | Opening the terminal did not return a valid successful session. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/authorityWire.js) |
| `TERMINAL_SHAPE` | value must be an owner envelope | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/ptyBroker.js) |
| `TERMINAL_UNAVAILABLE` | This build cannot provide the embedded terminal. | Use an external terminal with the running app’s attachment environment; no embedded-terminal repair command is supplied. | [code](../ui/electron/authorityWire.js) |
| `TERMINAL_UNKNOWN_SESSION` | The requested terminal session or session service is unavailable. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/authorityWire.js) |
| `TRACE_DESTINATION_UNSET` | Recording export has no configured destination. | No destination-setting click path is supplied by this source; preserve the recording in RAM while asking the operator to configure it. | [code](../ui/electron/roleHost.js) |
| `XPRA_BINDING_CHANGED` | The pinned Xpra run binding changed. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/roleHost.js) |
| `XPRA_BINDING_REFUSED` | The requested surface cannot use this Xpra binding. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/roleHost.js) |
| `XPRA_BOUNDS_REFUSED` | The Xpra tile geometry is invalid or outside supported bounds. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/roleHost.js) |
| `XPRA_HOST_CLOSED` | The host tile closed while the operation was pending. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/roleHost.js) |
| `XPRA_MODE_REFUSED` | Changing the native Xpra input mode failed; on x64, Human Program `gedit` closed its window with this refusal [CITED: operator evaluation, c26/c27]. | Preserve the diagnostic and stop that tile. Human Program `gedit` is not a verified demo route; use the measured Agent calculator or attach an existing harmless `gedit` through Desktop window for those distinct flows. | [code](../ui/electron/roleHost.js) |
| `XPRA_MODE_UNPROVEN` | The native acknowledgement did not prove the requested Xpra input mode. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/roleHost.js) |
| `XPRA_PAYLOAD_REFUSED` | The Xpra operation payload is unsupported or invalid. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/roleHost.js) |
| `XPRA_ROLE_OWNERSHIP` | The Xpra role or current surface ownership cannot authorize the operation. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/roleHost.js) |
| `XPRA_SENDER_REFUSED` | The Xpra request sender or role message is not admitted. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/roleHost.js) |
| `XPRA_TRACE_FAILED` | A fatal Xpra trace failure stopped the view. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/xpraHumanTile.js) |
| `XPRA_VIEW_BUSY` | An Xpra view operation already holds the surface lock. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/roleHost.js) |
| `XPRA_VIEW_CRASHED` | The Xpra view renderer exited unexpectedly. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/xpraHumanTile.js) |
| `XPRA_VIEW_UNRESPONSIVE` | The Xpra view renderer became unresponsive. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/xpraHumanTile.js) |
| `NET_EGRESS_IO` | Reading or writing the private egress record failed. | No known remedy in this source; preserve the full diagnostic and inspect the capsule state. | [code](../daemon-adapter/internal/capsule/egress.go) |
| `ADAPTER_EXITED` | adapter exited before handshake completed | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/coreLauncher.js) |
| `ADAPTER_HANDSHAKE_TIMEOUT` | adapter handshake aborted | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/coreLauncher.js) |
| `ALREADY_RECORDING` | A recording is already active. | Click **Stop** in the recording strip before starting another. | [code](../ui/electron/captureBridge.js) |
| `BUDGET_EXCEEDED` | The capture request was refused by the declared CAPTURE_CODES guard. | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/captureBridge.js) |
| `CAPTURE_UNAVAILABLE` | Capture is unavailable for this surface. | No known remedy in this source; inspect the disabled control’s reason. | [code](../ui/electron/captureBridge.js) |
| `CAPTURE_UNKNOWN` | The capture request was refused by the declared CAPTURE_CODES guard. | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/captureBridge.js) |
| `CHANNEL` | capture method | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/captureBridge.js) |
| `CLOSED` | The frame request was refused by the declared DISPLAY_READER_REASONS guard. | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/displayReader.js) |
| `DEPS` | A preload dependency contract is invalid. | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/preload.js) |
| `DESTINATION_EXISTS` | The capture request was refused by the declared CAPTURE_CODES guard. | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/captureBridge.js) |
| `DESTINATION_UNAVAILABLE` | The capture request was refused by the declared CAPTURE_CODES guard. | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/captureBridge.js) |
| `DESTINATION_UNSET` | The capture request was refused by the declared CAPTURE_CODES guard. | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/captureBridge.js) |
| `DIGEST_MISMATCH` | The frame request was refused by the declared FRAME_REASONS guard. | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/framePort.js) |
| `EMPTY_RING` | The frame request was refused by the declared DISPLAY_READER_REASONS guard. | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/displayReader.js) |
| `ENDPOINT_RESTART` | The surface request was refused by the declared PORT_REVOKE_REASONS guard. | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/framePort.js) |
| `HIDDEN` | The frame request was refused by the declared DISPLAY_READER_REASONS guard. | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/displayReader.js) |
| `INVALID_BINDING` | The frame request was refused by the declared FRAME_REASONS guard. | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/framePort.js) |
| `INVALID_BUDGET` | The frame request was refused by the declared FRAME_REASONS guard. | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/framePort.js) |
| `INVALID_CONTRACT` | The frame request was refused by the declared FRAME_REASONS guard. | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/framePort.js) |
| `INVALID_GENERATION` | The frame request was refused by the declared FRAME_REASONS guard. | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/framePort.js) |
| `INVALID_HEADER` | The frame request was refused by the declared DISPLAY_READER_REASONS guard. | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/displayReader.js) |
| `INVALID_PATH` | The frame request was refused by the declared FRAME_REASONS guard. | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/framePort.js) |
| `IN_FLIGHT` | The frame request was refused by the declared DISPLAY_READER_REASONS guard. | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/displayReader.js) |
| `IO_ERROR` | The frame request was refused by the declared FRAME_REASONS guard. | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/framePort.js) |
| `LEASE_INVALID` | The frame request was refused by the declared FRAME_REASONS guard. | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/framePort.js) |
| `LIMIT` | The surface request was refused by the declared SURFACE_INPUT_CODES guard. | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/authorityWire.js) |
| `NOT_IN_CONTROL` | Human input was requested without authoritative human control. | Click **Take control (emergency)** and wait for the control update before using the tile. | [code](../ui/electron/authorityWire.js) |
| `NOT_LIVE` | core is not live | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/coreLauncher.js) |
| `NOT_RECORDING` | No recording is active to stop. | No recovery is needed; inspect the tile’s capture state before using **Record**. | [code](../ui/electron/captureBridge.js) |
| `NOT_SEALED` | The requested capture is not sealed for export. | No general repair command is supplied; inspect the capture state and retain the diagnostic. | [code](../ui/electron/captureBridge.js) |
| `NOT_TMPFS` | The frame request was refused by the declared DISPLAY_READER_REASONS guard. | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/displayReader.js) |
| `NO_BROWSER_CAPSULE` | There is no browser capsule with a live frame. | No automatic repair command is supplied; inspect the browser capsule before continuing. | [code](../ui/electron/profilePicker.js) |
| `NULL_DIGEST` | The frame request was refused by the declared FRAME_REASONS guard. | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/framePort.js) |
| `OPEN_EACCES` | The frame request was refused by the declared ACQUIRE_CAUSE_CODES guard. | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/frameReader.js) |
| `OPEN_ENOENT` | The frame request was refused by the declared ACQUIRE_CAUSE_CODES guard. | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/frameReader.js) |
| `OPEN_IO` | The frame request was refused by the declared DISPLAY_READER_REASONS guard. | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/displayReader.js) |
| `OPEN_PATH` | The frame request was refused by the declared DISPLAY_READER_REASONS guard. | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/displayReader.js) |
| `OPEN_SYMLINK` | The frame request was refused by the declared DISPLAY_READER_REASONS guard. | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/displayReader.js) |
| `PORT_REVOKED` | The frame request was refused by the declared FRAME_REASONS guard. | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/framePort.js) |
| `QUEUE_BYTES` | request queue bytes are exhausted | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/coreLauncher.js) |
| `QUEUE_FULL` | request queue is full | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/coreLauncher.js) |
| `RATE_LIMITED` | The frame request was refused by the declared DISPLAY_READER_REASONS guard. | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/displayReader.js) |
| `REQUEST_BYTES` | request exceeds its byte bound | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/coreLauncher.js) |
| `REQUEST_SHAPE` | request is not measurable | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/coreLauncher.js) |
| `RING_ABSENT` | The frame request was refused by the declared DISPLAY_READER_REASONS guard. | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/displayReader.js) |
| `SCHEMA` | The surface request was refused by the declared SURFACE_INPUT_CODES guard. | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/authorityWire.js) |
| `SHUTDOWN` | The surface request was refused by the declared PORT_REVOKE_REASONS guard. | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/framePort.js) |
| `SIZE` | The frame request was refused by the declared ACQUIRE_CAUSE_CODES guard. | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/frameReader.js) |
| `SIZE_MISMATCH` | The frame request was refused by the declared DISPLAY_READER_REASONS guard. | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/displayReader.js) |
| `STALE` | The frame request was refused by the declared ACQUIRE_CAUSE_CODES guard. | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/frameReader.js) |
| `STALE_EPOCH` | The frame request was refused by the declared FRAME_REASONS guard. | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/framePort.js) |
| `STALE_FRAME_GENERATION` | The frame request was refused by the declared FRAME_REASONS guard. | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/framePort.js) |
| `STALE_STREAM` | The surface request was refused by the declared SURFACE_INPUT_CODES guard. | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/authorityWire.js) |
| `STALE_SURFACE_GENERATION` | The frame request was refused by the declared FRAME_REASONS guard. | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/framePort.js) |
| `STAT_IO` | The frame request was refused by the declared ACQUIRE_CAUSE_CODES guard. | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/frameReader.js) |
| `STAT_MODE` | The frame request was refused by the declared DISPLAY_READER_REASONS guard. | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/displayReader.js) |
| `STAT_NOT_FILE` | The frame request was refused by the declared DISPLAY_READER_REASONS guard. | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/displayReader.js) |
| `STAT_UID` | The frame request was refused by the declared DISPLAY_READER_REASONS guard. | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/displayReader.js) |
| `SURFACE_MISMATCH` | The frame request was refused by the declared FRAME_REASONS guard. | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/framePort.js) |
| `TIMEOUT` | The frame request was refused by the declared FRAME_REASONS guard. | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/framePort.js) |
| `TORN_SEQ_CHANGED` | The frame request was refused by the declared DISPLAY_READER_REASONS guard. | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/displayReader.js) |
| `TORN_SEQ_ODD` | The frame request was refused by the declared DISPLAY_READER_REASONS guard. | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/displayReader.js) |
| `UNCHANGED` | The frame request was refused by the declared DISPLAY_READER_REASONS guard. | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/displayReader.js) |
| `UNPUBLISHED` | The frame request was refused by the declared FRAME_REASONS guard. | No known remedy in this source; preserve the exact diagnostic for the operator. | [code](../ui/electron/framePort.js) |

`MW_RUN_ATTACH` / configuration: resolve `${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/metaviewer/attach/current.env` from the original terminal runtime, then follow [the attachment setup](AGENT_ENTRY.md#attachment-and-identity). Never guess a configuration path.

## Browser goals

| Exact code or message | Meaning | Next command or click | Source |
| --- | --- | --- | --- |
| `MW_BROWSER_GOAL_CONFIG` | Browser goal configuration is invalid. | Check the goal arguments and diagnostic before running again. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_BROWSER_GOAL_SURFACE` | The selected surface cannot run browser goals. | Select a live browser capsule for this identity. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_BROWSER_SURFACE` | The browser surface cannot be verified. | Select the intended live browser capsule and refresh its observation. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_BROWSER_AX_BOX` | The browser target has no valid accessibility box. | Refresh the observation and select a visible accessible target. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_BROWSER_FOCUS` | The browser text target cannot be uniquely focused. | Select one visible editable field before running again. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_BROWSER_KEY` | The browser key request is unsupported. | Use Enter only with explicit text and verified readback. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_BROWSER_MODEL_MARK_LIMIT` | The browser observation exceeds the model mark limit. | Narrow the visible target set before planning again. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_BROWSER_NO_TARGETS` | No supported browser targets are visible. | Reveal an accessible target and refresh the observation. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_BROWSER_PLANNER` | The browser planner configuration is unsupported. | Select a supported planner and check its configuration. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_BROWSER_STEPS` | The browser step budget cannot cover the requested input. | Include focus, typing and any requested key step. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_BROWSER_TEXT` | The browser text argument is invalid. | Provide nonempty text within the documented byte limit. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_BROWSER_TEXT_MISMATCH` | Browser text readback differs from the request. | Inspect and reconcile the field before considering another input. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `BROWSER_BOUNDED_ACTIONS_VERIFIED` | The bounded moves were verified, never the whole goal. | Inspect the fresh page state and receipts before claiming the requested outcome. | [code](../tools/mw_run_browser_goal.py) |



## Program goals

| Exact code or message | Meaning | Next command or click | Source |
| --- | --- | --- | --- |
| `MW_PROGRAM_CONTROL` | The capsule is under human control. | Press Release on its tile before running again. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_PROGRAM_BINDING` | The program surface binding cannot be verified. | Select the intended capsule and restore its adapter binding. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_PROGRAM_BUDGET` | The program action budget is exhausted or invalid. | Inspect the report and request a bounded supported action. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_PROGRAM_CLICK_TARGET` | The program click target cannot be uniquely located. | Reveal one visible target and refresh the observation. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_PROGRAM_CONFIG` | Program configuration is invalid. | Check the diagnostic and the running capsule configuration before running again. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_PROGRAM_DEADLINE` | The program action deadline expired. | Inspect the capsule and report before considering another action. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_PROGRAM_FOCUSED_TEXT_REQUIRED` | Focused program input requires explicit text. | Supply --text for the intended focused editor. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_PROGRAM_FOCUS_AMBIGUOUS` | More than one program focus target matches. | Select one visible editable target before running again. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_PROGRAM_FOCUS_UNVERIFIED` | Program focus cannot be verified. | Establish and observe the intended editor focus before typing. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_PROGRAM_FRAME_CUSTODY` | Program frame custody cannot be proved. | Acquire a fresh adapter-owned observation before planning again. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_PROGRAM_FRESH_FRAME` | A fresh program frame is unavailable. | Check capsule responsiveness and refresh the observation. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_PROGRAM_GOAL` | The program goal is unsupported or invalid. | Provide a bounded goal grounded in the visible capsule. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_PROGRAM_GOAL_UNGROUNDED` | The program goal has no verified visible grounding. | Reveal the intended target and rephrase the goal using that observation. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_PROGRAM_KEEPALIVE` | The program frame lease could not be maintained. | Check capsule responsiveness and obtain a fresh observation. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_PROGRAM_MODEL_BUDGET` | The model planning budget is exhausted or invalid. | Inspect the report and narrow the requested action. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_PROGRAM_MODEL_FAILED` | Model planning failed before a verified action was available. | Inspect the planner diagnostic and restore its configuration before planning again. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_PROGRAM_MODEL_FRAME` | The model frame does not match the current observation. | Acquire a fresh frame and plan again. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_PROGRAM_MODEL_OUTPUT_LIMIT` | The model reply exceeded the output limit. | Narrow the goal and request a bounded supported action. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_PROGRAM_MODEL_PROCESS_TARGET` | The model process target cannot be verified. | Select the intended capsule process and refresh its observation. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_PROGRAM_MODEL_TARGET` | The model reply does not identify one valid observed target. | Refresh the observation and select a uniquely grounded target before planning again. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_PROGRAM_MODEL_TIMEOUT` | Model planning timed out. | Check planner responsiveness and inspect the report before planning again. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_PROGRAM_NO_NEW_PUBLICATION` | The capsule published no new frame. | Check capsule responsiveness and obtain a new observation. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_PROGRAM_NO_VISIBLE_EFFECT` | The action produced no verified visible effect. | Inspect the capsule state before considering another action. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_PROGRAM_OBSERVATION_CHANGED` | The program observation changed during planning. | Refresh the observation and plan again. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_PROGRAM_OPERATION` | The requested program operation is unsupported. | Select a supported bounded program action. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_PROGRAM_PASSWORD` | Program input targets a protected password field. | Enter credentials manually in the capsule. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_PROGRAM_PERCEPTION` | Program perception is unavailable or invalid. | Check the pinned perception dependency and refresh the observation. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_PROGRAM_PLANNER` | The program planner is unsupported or unavailable. | Select a supported planner and check its pinned dependency. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_PROGRAM_RAM_REQUIRED` | Program evidence requires private RAM storage. | Configure a private evidence directory under /dev/shm. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_PROGRAM_STEPS` | The program step count is invalid. | Use a count within the documented CLI bounds. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_PROGRAM_SURFACE` | The selected program surface cannot be verified. | Select a live program capsule for this identity. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_PROGRAM_TEXT_FIELD` | The program text target is not a supported editable field. | Select a visible supported editor. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_PROGRAM_TEXT_MISMATCH` | Program text readback differs from the request. | Inspect and reconcile the editor before considering another input. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_PROGRAM_TEXT_REFUSED` | Program text input was refused. | Inspect the report and editor state before considering another input. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_PROGRAM_TEXT_STEPS` | Program text input requires a single bounded step. | Use --steps 1 with --text. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_PROGRAM_UNKNOWN_OBSERVATION` | The program observation cannot be classified safely. | Inspect the capsule and acquire a supported observation. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_PROGRAM_KEY_REQUEST` | The navigation request is unsupported. | Use focused-key with one arrow or Enter, one step, rules and no text. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_PROGRAM_KEY_HOST_ONLY` | Navigation requires an Agent Host program custody binding. | Select a live Agent Host program before running again. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_PROGRAM_KEY_REFUSED` | The navigation input was refused. | Inspect the report and acquire a fresh observation before planning again. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `PROGRAM_TEXT_UNCERTIFIED_NOT_READABLE` | Text was typed, but OCR did not read it back; a successful exit does not certify the text. | Take control and inspect the editor; do not blindly type again. No command to force readable OCR is supplied. | [code](../tools/mw_run_program.py) |
| `PROGRAM_BOUNDED_ACTIONS_VERIFIED` | The bounded moves were verified, never the whole goal. | Inspect the fresh capsule output and receipts; for a calculator, inspect the displayed result separately. | [code](../tools/mw_run_program.py) |



## Walls

| Exact code or message | Meaning | Next command or click | Source |
| --- | --- | --- | --- |
| `MW_NOTICE` | The required execution notice is invalid. | Repair the workflow execution policy before running again. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `MW_HANDOFF_REQUIRED` | The required handoff evidence is missing or invalid. | Inspect the run report and restore the handoff record before continuing. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `HUMAN_HANDOFF` | The workflow requires human action. | Inspect the handoff receipt and complete the requested action before continuing. | [code](../agents/metaviewer_agents/mw_refusals.py) |
| `LOGIN_ACTIVE` | An operator login is active or being registered. | Complete the login manually; release control and obtain a fresh observation before planning again. | [code](../daemon-adapter/internal/capsule/login_lock.go) |
| `LOGIN_CONFIRMATION_REQUIRES_HUMAN` | Login confirmation requires human control. | Take control, complete the login manually, then click **Mark as logged in**. | [code](../ui/electron/roleHost.js) |
| `LOGIN_URL` | The identity login tool supplied a URL outside its permitted local viewer form. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/operatorBridge.js) |
| `LOGIN_VIEW` | Opening the identity login view failed. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/operatorBridge.js) |



## Stop

| Exact code or message | Meaning | Next command or click | Source |
| --- | --- | --- | --- |
| `JUDGE_SMOKE_ACTIVE` | An interrupted install left a live group or ownership evidence that cannot be verified. | Inspect `run/smoke-processes/*.pid` (leader PID and `/proc` start time) and `run/smoke-roots/*.json` under `MV_JUDGE_HOME`. Let the exact recorded group exit, then re-run `install`; it reconciles exited groups and their private roots without sending signals. Preserve malformed or reused-PID records for manual inspection; never kill a guessed PID. | [code](../scripts/judge/metaviewer-judge.sh) |
| `JUDGE_SMOKE_STATE` | An interrupted install left a live group or ownership evidence that cannot be verified. | Inspect `run/smoke-processes/*.pid` (leader PID and `/proc` start time) and `run/smoke-roots/*.json` under `MV_JUDGE_HOME`. Let the exact recorded group exit, then re-run `install`; it reconciles exited groups and their private roots without sending signals. Preserve malformed or reused-PID records for manual inspection; never kill a guessed PID. | [code](../scripts/judge/metaviewer-judge.sh) |
| `JUDGE_HOME_PATH` | The judge home cannot fit the filesystem name or path limits. | Set `MV_JUDGE_HOME` to a shorter dedicated directory, such as `$HOME/mv-judge`, and retry. Ordinary long home names use the recorded short smoke root automatically. | [code](../scripts/judge/metaviewer-judge.sh) |
| `JUDGE_STOP_CLEAN` | The stop check found no scoped leftovers; the shared egress proxy is excluded. | Inspect any saved evidence; no further cleanup command is required by this result. | [code](../scripts/judge/metaviewer-judge.sh) |
| `JUDGE_STOP_TIMEOUT` | The owned app did not exit after termination. | Only if you accept losing unsaved capsule state, run the exact `kill -KILL <pid>` printed in the refusal; substitute only that reported owned PID. | [code](../scripts/judge/metaviewer-judge.sh) |
| `JUDGE_STOP_LEAK` | A scoped container, socket, RAM root, smoke ownership record or admission record remains. | Inspect its exact name and ownership. Use only this occurrence’s printed `-- fix:` after confirming the owner exited; private runtime roots have no automatic removal command. | [code](../scripts/judge/metaviewer-judge.sh) |
| `CAPSULE_STOP_UNAVAILABLE` | The host does not provide a surface-stop operation. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/roleHost.js) |
| `CAPSULE_STOP_UNPROVEN` | The stop response did not prove that the requested surface was destroyed. | No known remedy in this source; preserve the exact code and host diagnostic for the operator. | [code](../ui/electron/roleHost.js) |

`JUDGE_STOP_CLEAN` excludes the shared `srf-egress-proxy`, which intentionally remains running. The leak census is not proof that every private runtime root has disappeared. Inspect RAM evidence before stopping; remove only resources whose ownership and exited processes are established ([stop implementation](../scripts/judge/metaviewer-judge.sh)).

Standalone package smoke can refuse with `PKG_SMOKE_SOCKET_PATH` when its temporary directory cannot hold the core or Electron socket. Set `TMPDIR` to a short private directory under `/tmp`, or use the judge installer, which records a short smoke root independently of `MV_JUDGE_HOME` ([package tool](../ui/tools/package.js)).

This troubleshooting mandate is limited to the linked source code and the supplied tour’s verification claims.

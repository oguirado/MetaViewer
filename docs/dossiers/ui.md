# UI dossier: wall, layouts, tree, add capsule, terminals, Direct task, modes, identities, recording, activity

Answers: how does the MetaViewer UI work; where is the code for a UI symptom; why is the UI built this way; which file owns this tile, dialog or terminal; what does this UI error mean

This dossier explains the MetaViewer desktop UI (`ui/src/**`, `ui/electron/**`) at commit `9a58d527b` of branch docs/v026-base, subsystem by subsystem: why it exists, its parts, the data that moves, what must hold, how it fails and what the user then sees, where to change what, how to test it, and the tradeoffs the code or docs show. Every coordinate is `path:line` on that commit; inference is marked "(inference)"; numbers carry [CITED: path:line], [MEASURED] or [TARGET]; facts not found in the code are written `ABSENT — do not invent`.

**A finding tells you where to look. Only the code proves it.** The routed findings for the same files are in `route/study/ui.jsonl` (562 rows, every citation byte-checked on this commit). Query them with `python3 route/route_query.py` (see [route/README.md](../../route/README.md)).

### How to read this dossier

Answers: where do I start in the UI docs; which section answers my question; how do I go from a symptom to UI code

1. Have an exact UI message or error code? Search the "Failure modes" and "Refusals" tables of the matching subsystem below, or run `python3 route/route_query.py error "<text>"`.
2. Have a symptom in plain words? Pick the subsystem from the table, read its "Failure modes", then open the cited line.
3. Want to change behaviour? Read the subsystem's "Invariants" and "Where to change what" before editing.

| Subsystem | What it covers |
|---|---|
| [UI shell](#ui-shell-and-process-model-electron-main-preload-renderer) | UI shell and process model (Electron main, preload, renderer) |
| [Capsule tree](#capsule-tree-navigation-tree) | Capsule tree (navigation tree) |
| [Wall](#wall-and-tiles) | Wall and tiles |
| [Layouts](#layouts-and-desktops) | Layouts and desktops |
| [Add capsule](#add-capsule-catalog) | Add capsule (catalog) |
| [Modes](#modes-opening-mode-humanagent-control-network-mode-settings) | Modes (opening mode, human/agent control, network mode, settings) |
| [Terminals](#terminals-deck-side-terminal-paired-terminals-pty-broker) | Terminals (deck, side terminal, paired terminals, PTY broker) |
| [Direct task](#direct-task-workflow-prompts-to-an-agent-cli) | Direct task (workflow prompts to an agent CLI) |
| [Identities](#identities) | Identities |
| [Recording](#recording) | Recording |
| [Activity](#activity) | Activity |

Not covered here: the frame and input planes (`ui/src/frames/`, `ui/src/surfaces/`, `ui/src/input/`, `ui/electron/frame*.js`), rewind and guest-command hosts, xpra role tiles, and the closed components `wender-agent`, `vision-engine` and `OpenSuperficies`, which MetaViewer starts as separate processes over documented process and socket interfaces (see `NOTICE-EVALUATION.md`).

### What could not be run for this dossier

Answers: was this tested live; what was verified by running; what is unverified

The study box had no KVM and no docker daemon, so no capsule was started and nothing here was observed in a running app; the claims come from reading the code. The Vue-based UI tests could not run there because `vue` was not installed (`node_modules` absent). Facts tagged [MEASURED] come from the operator's live session on this release, not from this study.

## UI shell and process model (Electron main, preload, renderer)

Answers: what is ui shell and process model in MetaViewer; how does ui shell and process model work; where is the ui shell and process model code; what breaks in ui shell and process model

Terms used here: **main** is the Electron main process (`ui/electron/main.js`). **Preload** is the sandboxed script that runs before the page and exposes one object, `window.metaviewer` (`ui/electron/preload.js`). The **renderer** is the Vue page served from `app://metaviewer/index.html` (`ui/src/main.js` mounts `ui/src/App.vue`). The **core** is the separate MetaViewer daemon that owns state; the UI talks to it over a Unix socket. The **adapter** is the bundled daemon-adapter child that MetaViewer starts as a separate process to run capsules through OpenSuperficies (a closed component reached only through process and socket interfaces).

### UI shell: why does the shell exist, and why is it built this way?
Answers: why is main so strict; why does the renderer have no Node access; who owns state in MetaViewer; why is there a preload facade; why does the app refuse to start instead of degrading

The shell is a thin supervisor: "Main supervises; Rust owns state" (`ui/electron/main.js:25`). Every privileged IPC receiver begins by checking the sender with `observeSender` (`ui/electron/main.js:581`), the window runs with sandbox, context isolation and no Node integration (typedef at `ui/electron/main.js:306`), and the CSP closes network, frames, objects and forms (`ui/electron/main.js:151`). The renderer never receives a raw `invoke`, channel name, path or handle: the preload exposes a closed, frozen facade and shapes every argument, while main re-validates and owns persistence (`ui/electron/preload.js:146`). Failures are fail-closed with typed codes; raw host text and paths are kept out of dialogs (`ui/electron/main.js:62`).

On this commit the production path does **not** spawn the core binary. The default host module "Attach[es] to the already running owner-only core socket at $XDG_RUNTIME_DIR/metaviewer/core.sock ... Never spawn a guessed binary" (`ui/electron/hostBindings.js:3`). `createCoreLauncher` (`ui/electron/coreLauncher.js:594`) is imported only by tests (`ui/test/coreLauncher.test.js`, `ui/test/uiel-reap.test.js`) (inference from a grep of importers). The adapter, by contrast, is spawned by main when `MV_ADAPTER_BIN` is set (`ui/electron/main.js:2956`).

### UI shell: what are the parts of the shell?
Answers: which files make up the Electron shell; where is the preload; what does hostBindings do; where is the operator bridge; what does ui/src/main.js do

| File | Role |
|---|---|
| `ui/electron/main.js` | Main entry: retail guards, single-instance lock, privileged `app://` scheme, window policy, layout IPC, boot ordering, adapter supervision, startup dialogs, quit handling |
| `ui/electron/hostBindings.js` | Default host module: authenticates and connects to `core.sock`, builds the `core` handle and the `wire` (frames, terminals, display, capture, rewind, guest command, headless) |
| `ui/electron/coreLauncher.js` | Environment scrubbing, kill guard, adapter launcher with core-only degraded state, test-only core child launcher, headless profile check |
| `ui/electron/operatorBridge.js` | Operator IPC: identities (via `mv_identity.py`), egress records, handoff notices, demo buttons |
| `ui/electron/preload.js` | `window.metaviewer` facade, argument shaping, closed channel and subscription sets, reply validation |
| `ui/electron/rolePreload.cjs` (via `ui/electron/roleHost.js:1167`) | Second preload exposing `window.metaviewerRoles` (role surfaces, programs, identity open); not read in depth here |
| `ui/src/main.js` | Renderer entry: binds the facade, layout storage, settings, authority runtime, ports; mounts `App.vue` or shows the boot refusal |
| `ui/src/App.vue` | Root view: navigation rail and capsule tree, top bar, wall, multislot, recording, settings, terminal dock, dialogs |

Other bridges installed by main and covered by other readers: `ui/electron/authorityWire.js`, `captureBridge.js`, `capturePreferencesBridge.js`, `frameDiag.js`, `displayReader.js`, `qaAnchors.js`, `roleHost.js` (`ui/electron/main.js:2676`, `ui/electron/main.js:2702`-`2745`).

### UI shell: in what order does MetaViewer start, and what happens when the core is missing?
Answers: startup sequence; what if the core daemon is not running; CORE_SEAMS_ABSENT meaning; why no window appears; what does the user see when startup fails

1. `mainDirectEntry` (`ui/electron/main.js:3069`) runs `validateRetailLaunch` and the Electron pin check (`ui/electron/main.js:3121`-`3127`), registers the privileged scheme before any `await` (`ui/electron/main.js:3132`).
2. `loadMainBindings` (`ui/electron/main.js:2916`) imports `./hostBindings.js` (or an owner-only `MV_CORE_BOOTSTRAP` file) and calls `createMainBindings` (`ui/electron/hostBindings.js:161`). That function checks `MV_CORE_CONFIG` and `XDG_RUNTIME_DIR`, the owner-only runtime directories (mode 0700 [CITED: ui/electron/hostBindings.js:168]), the socket (mode 0600 [CITED: ui/electron/hostBindings.js:172]) (`ui/electron/hostBindings.js:165`-`172`), the pinned config (`ui/electron/hostBindings.js:189`-`197`), authenticates the socket peer by uid and VFS inode (`ui/electron/hostBindings.js:716`-`738`), sends the UI hello and re-checks the socket path (`ui/electron/hostBindings.js:753`-`756`).
3. If the core is missing or any of those checks fails, every error becomes `CORE_SEAMS_ABSENT: trusted host bindings unavailable (<cause>)` with a closed cause token such as `SOCKET_PATH`, `CONFIG_OPEN`, `HELLO_TIMEOUT` (`ui/electron/main.js:3061`; token list `ui/electron/main.js:9`). `failClosed` prints it, shows a warning dialog "MetaViewer could not start" with "Check the installation and the startup error in the host logs, then restart MetaViewer.", waits for the dialog or [CITED: ui/electron/main.js:3103] 15000 ms, then exits with code 1 [CITED: ui/electron/main.js:3110] (`ui/electron/main.js:3085`-`3117`). No window is created.
4. `bootProductionMain` (`ui/electron/main.js:2184`) checks handle shapes, retail verdict, `ELECTRON_PIN` and the single-instance lock (`ui/electron/main.js:2252`-`2273`), registers and serves the bundle, admits the layout bridge, hardens the default session, then (non-nested) requires `core.start()` to report `live` or throws `CORE_UNAVAILABLE` before any window exists (`ui/electron/main.js:2481`-`2502`).
5. The adapter is started next. With `MV_SRF_BIN_DIR` set (or headless mode) a non-live adapter aborts boot with an `ADAPTER_*` code (`ui/electron/main.js:2527`-`2565`); without it a failed adapter leaves a core-only wall. With a live adapter, one boot-time capsule create is fired asynchronously (`ui/electron/main.js:2566`-`2604`).
6. The window is constructed, policy attached (`ui/electron/main.js:2609`-`2624`), layout IPC registered (`ui/electron/main.js:2637`-`2668`), bridges installed (`ui/electron/main.js:2670`-`2763`), `index.html` loaded and the renderer-ready gate armed (`ui/electron/main.js:2782`-`2794`). The log line `METAVIEWER_MAIN_READY` follows (`ui/electron/main.js:3152`).
7. In the renderer, `bootstrap` (`ui/src/main.js:260`) binds `window.metaviewer`, reads settings once, builds ports and mounts `App.vue` (`ui/src/main.js:445`-`460`).

### UI shell: which IPC channels exist and who registers them?
Answers: list of ipcMain.handle channels; what window.metaviewer exposes; preload API surface; which events main pushes to the renderer; how does the renderer subscribe to frames

Main registers directly only `metaviewer:layout.load`, `metaviewer:layout.save` (`ui/electron/main.js:194`, `ui/electron/main.js:2662`) and `metaviewer:renderer-ready` (`ui/electron/main.js:2788`). The operator bridge registers `metaviewer:<method>` for each of `entry.copy`, `demo.start|stop|prompt|check|state`, `identity.list|show|create|delete|login`, `egress.get|set`, `handoff.list|ack` (`ui/electron/preload.js:162`, `ui/electron/operatorBridge.js:390`-`395`). The authority wire and other bridges register the domain channels named in `WIRE_NAMES` (`ui/electron/preload.js:959`-`966`), for example `metaviewer:settings.load`, `metaviewer:authority.createSurface`, `metaviewer:authority.propose`, `metaviewer:authority.intent`, `metaviewer:side-terminal.open`, `metaviewer:clipboard.writeText`, `metaviewer:capsule-state.request`, `metaviewer:rewind.request`, `metaviewer:headless.request`, plus capture channels `metaviewer:capture.*` (`ui/electron/preload.js:546`).

`window.metaviewer` (name at `ui/electron/preload.js:296`) carries `load`, `save`, `loadSettings`, `saveSettings`, `recordingDestination`, `nestedDepth`, `selfCapsuleId`, and groups `capture`, `slots`, `rewind`, `guestCommand`, `headless`, `authority` (`vmAvailable`, `createSurface`, `propose`, `intent`, `subscribeFrames`), `input`, `operator`, `frames.reportDiag`, `sideTerminal`, `clipboard`, and `qa` only when enabled (`ui/electron/preload.js:1271`-`1797`).

Host push channels the preload will subscribe to are closed: `metaviewer:authority.frames`, `capture.state`, `side-terminal.port`, `handoff.state`, `demo.state`, `headless.state`, `guest-command.state`, `guest-command.observation`, `rewind.state` (`ui/electron/preload.js:1873`). Main also sends `metaviewer:adapter-status` (`ui/electron/main.js:2803`). Frame ports are forwarded to the page by `window.postMessage` as `frame_port/v1` only for origin `app://metaviewer` (`ui/electron/preload.js:1711`-`1726`).

### UI shell: what must always hold in the shell?
Answers: shell invariants; security guarantees of main; sender admission rules; what preload guarantees; what the renderer may never do

- Every privileged receiver admits only the one expected webContents, top frame by object identity, origin `app://metaviewer` (`ui/electron/main.js:565`-`665`).
- Every window open is denied; permissions always deny; webview attach is prevented; navigation is allowed only to canonical bundled URLs (`ui/electron/main.js:489`-`523`, `ui/electron/main.js:699`-`811`). The single exception opens exactly the repository URL externally (`ui/electron/main.js:723`).
- Refused core readiness leaves zero windows (`ui/electron/main.js:2481`).
- Nested display-only mode (`--nested-depth=1`) never starts the core and registers no receivers (`ui/electron/main.js:2177`-`2181`, `ui/electron/main.js:2488`).
- The renderer-ready log needs three witnesses: index served with status 200 [CITED: ui/electron/main.js:1225], `did-finish-load`, and an admitted argument-free preload ping (`ui/electron/main.js:1214`-`1237`, `ui/electron/preload.js:1922`-`1925`).
- Child environments are allowlists; `ELECTRON_`, `NODE_`, `LD_`, `DYLD_`, `PYTHON` prefixes are forbidden (`ui/electron/coreLauncher.js:102`, `ui/electron/coreLauncher.js:159`).
- The core connection is never reconnected; a keepalive list runs every [CITED: ui/electron/hostBindings.js:763] 10000 ms (`ui/electron/hostBindings.js:757`-`764`).
- Adapter diagnostics are redacted before printing (`ui/electron/coreLauncher.js:34`).

### UI shell: what can go wrong, and what does the user see?
Answers: MetaViewer could not start; dialog on startup; capsules unavailable core-only; app quits by itself; Layout service unavailable; Core not connected

| Symptom the user sees | Cause | Coordinate | Fix or workaround |
|---|---|---|---|
| Dialog "CORE_SEAMS_ABSENT: MetaViewer could not start." then exit | Core socket, config, peer or hello check failed | `ui/electron/main.js:3061`, `ui/electron/hostBindings.js:165` | Start the core so `$XDG_RUNTIME_DIR/metaviewer/core.sock` exists (mode 0600 [CITED: ui/electron/hostBindings.js:172]) and set an absolute `MV_CORE_CONFIG`; read the cause token in stderr |
| Dialog "CORE_UNAVAILABLE: MetaViewer could not start." | Core handle not `live` | `ui/electron/main.js:2501` | Check the core process and logs |
| Dialog with an `ADAPTER_*` code and "The surface runtime could not start..." | `MV_SRF_BIN_DIR` set but adapter not live | `ui/electron/main.js:2564`, `ui/electron/main.js:83` | Fix adapter install / `MV_SRF_LIVE_PROFILE`, or unset `MV_SRF_BIN_DIR` for core-only |
| Capsules unavailable, status "Degraded mode (OPENSUPERFICIES_ABSENT)..." | Adapter preflight failed, core-only | `ui/electron/coreLauncher.js:1490` | Configure `MV_SRF_BIN_DIR` as an absolute directory |
| Dialog "MetaViewer could not open the first capsule" | Boot-time create refused (RAM, adapter, identity) | `ui/electron/main.js:75`-`81` | Follow the dialog text; the wall stays available |
| App exits at launch with only stderr text | `RETAIL_FLAG` / `RETAIL_ENV` (debug flag, forbidden env, `MV_E2E_LIVE` in a packaged build) | `ui/electron/main.js:3095`, `ui/electron/main.js:1544`-`1564` | Remove the flag or variable |
| Second launch quits immediately | `SINGLE_INSTANCE` lock held | `ui/electron/main.js:2272` | Use the running window |
| Page shows "MetaViewer cannot start: The application is unavailable. Please try again." | `window.metaviewer` missing or boot threw | `ui/src/main.js:58`, `ui/src/main.js:250` | Check preload build (`dist/preload/preload.cjs`, `PRELOAD_ABSENT` at `ui/electron/main.js:1458`) |
| Rail shows "Layout unavailable. The default layout is shown read-only..." | Layout load failed (`LAYOUT_CONTRACT_*`) | `ui/src/App.vue:115`, `ui/src/App.vue:1903` | Inspect `<userData>/presentation/layout.json` permissions or content |
| Window closes after a renderer crash | `render-process-gone` quits the app | `ui/electron/main.js:2857` | Restart; check logs for `METAVIEWER_PROCESS_GONE` |
| Dialog "Session journal full" | Core journal limit reached; requests reject `JOURNAL_FULL` | `ui/electron/main.js:3143`, `ui/electron/hostBindings.js:531` | Close and reopen MetaViewer |
| Status bar "Core not connected" | No feed envelope and no runtime | `ui/src/App.vue:1913` | See core rows above |

### UI shell: which refusals can the shell raise?
Answers: list of shell error codes; what does BRIDGE_PARITY mean; preload ContractError codes; OPERATOR_SENDER; DISPLAY_ONLY meaning

| Code or text | Raised at | Meaning |
|---|---|---|
| `SENDER`, `FRAME_NULL`, `FRAME_DETACHED`, `SUBFRAME`, `FRAME_ORIGIN`, `FRAME_URL` | `ui/electron/main.js:571`-`575` | IPC sender not the admitted top frame |
| `RENDERER_READY` | `ui/electron/main.js:1231` | Bad readiness ping |
| `ARGV_SHAPE`, `ENV_SHAPE`, `RETAIL_FLAG`, `RETAIL_ENV`, `NESTED_DEPTH`, `UNKNOWN_SWITCH` | `ui/electron/main.js:1525`-`1588` | Retail launch refusal |
| `ELECTRON_PIN`, `SINGLE_INSTANCE`, `READY`, `PROTOCOL`, `WINDOW`, `LOAD`, `LIFECYCLE`, `IPC` | `ui/electron/main.js:2257`-`2895` | Boot step refused |
| `PRELOAD_ABSENT`, `PRELOAD_CONTAINMENT`, `PATHS_*`, `RUNTIME_XDG`, `RUNTIME_DIR` | `ui/electron/main.js:1409`-`1506` | Bundle or runtime path not admitted |
| `CORE_SEAMS_ABSENT` (+ cause) | `ui/electron/main.js:3061` | Host bindings unavailable |
| `CORE_UNAVAILABLE` | `ui/electron/main.js:2501` | Core not live |
| `HEADLESS_PROFILE_INVALID`, `ADAPTER_ABSENT` | `ui/electron/main.js:2491`, `ui/electron/main.js:2504` | MicroVM headless prerequisites |
| `ADAPTER_*` | `ui/electron/main.js:2541`-`2564` | Adapter required but not live |
| `BRIDGE_PARITY` | `ui/electron/main.js:1855` | Layout bridge does not mirror the two channels |
| `LAYOUT_BOUNDS`, `LAYOUT_CONTRACT_ABSENT`, `LAYOUT_CONTRACT_INVALID` | `ui/electron/main.js:2650`, `ui/electron/main.js:1676`-`1677` | Layout call shape or content refused |
| `SURFACE_CREATE_BUSY`, `RAM_ADMISSION_REFUSED`, `SURFACE_CREATE_TIMEOUT`, `SURFACE_CREATE_*` | `ui/electron/main.js:2048`-`2122`, `ui/electron/hostBindings.js:1066`-`1071` | Capsule create refused |
| `NOT_LIVE`, `REQUEST_SHAPE`, `REQUEST_BYTES`, `QUEUE_FULL`, `QUEUE_BYTES`, `REQUEST_TIMEOUT` | `ui/electron/coreLauncher.js:1057`-`1080` | Core launcher request gates |
| `CAPSULE_STOP_REFUSED`/`_TIMEOUT`, `CAPSULE_MODE_REFUSED`/`_TIMEOUT` | `ui/electron/hostBindings.js:1024`-`1043` | Stop or role switch refused |
| `SURFACE_CREATE_INVALID` | `ui/electron/hostBindings.js:1300` | Create request outside the closed vocabulary |
| `JOURNAL_FULL` | `ui/electron/hostBindings.js:531` | Session journal ended |
| `OPERATOR_SENDER` | `ui/electron/operatorBridge.js:393` | Operator call from an unadmitted sender |
| `IDENTITY_TIMEOUT`, `IDENTITY_LIMIT`, `LOGIN_URL`, `LOGIN_VIEW`, `IDENTITY_REPLY` | `ui/electron/operatorBridge.js:130`-`161` | Identity tool run failed |
| `NET_OPEN_PREREQ`, `NET_PROXIED_UNSUPPORTED`, `NET_EGRESS_IO`, `HANDOFF_UNAVAILABLE`, `PRIVATE_PATH`, `PRIVATE_FILE` | `ui/electron/operatorBridge.js:352`-`370`, `ui/electron/operatorBridge.js:23`-`43` | Egress, handoff or private-file refusal |
| `DEPS`, `CHANNEL`, `ARGS`, `PAYLOAD`, `OUTCOME` | `ui/electron/preload.js:327` | Preload shaping refusal (ContractError) |
| `DISPLAY_ONLY`, `NESTED_DISPLAY_ONLY` | `ui/electron/preload.js:1177`, `ui/electron/preload.js:233` | Nested display-only window |
| `TERMINAL_IO_REFUSED`, `TERMINAL_UNKNOWN_SESSION`, `ERR_CLIPBOARD_INVALID` | `ui/electron/preload.js:1010`-`1029` | Terminal or clipboard call shape |
| `OPERATOR_ARGS`, `OPERATOR_PAYLOAD`, `OPERATOR_REPLY`, `BUTTON_ARGS`, `BUTTON_REPLY` | `ui/electron/preload.js:118`-`214` | Operator call or reply outside the closed set |
| `CAPSULE_STATE_REQUEST`, `CAPSULE_STATE_EVENT` | `ui/electron/preload.js:1950`-`1969` | Capsule state slot request or event malformed |
| "Layout service unavailable", `LAYOUT_SAVE_REFUSED`, `ERR_SETTINGS_HOST`, `ERR_STARTUP_UNAVAILABLE` | `ui/src/main.js:58`, `ui/src/main.js:91`, `ui/src/main.js:173`, `ui/src/main.js:252` | Renderer boot refusals |

### UI shell: where do I change what in the shell?
Answers: where to add an IPC channel; where to change startup dialog text; where to change the CSP; where is the retail flag list; where to change capsule create timeout

| To change | Edit |
|---|---|
| Startup dialog text | `showStartupFailure`, `ui/electron/main.js:68` |
| Boot order, bridge installation | `bootProductionMain`, `ui/electron/main.js:2184` |
| Host binding acquisition / socket path | `createMainBindings`, `ui/electron/hostBindings.js:161` |
| Retail flags and switches | `FORBIDDEN_ARGV_FLAGS` `ui/electron/main.js:236`, `KNOWN_RUNTIME_SWITCHES` `ui/electron/main.js:259` |
| CSP | `ui/electron/main.js:151` |
| A new domain channel | preload `WIRE_NAMES` `ui/electron/preload.js:959` and `wireCall` `ui/electron/preload.js:968`, plus the main-side bridge; per `AGENTS.md`, its schema comes first |
| Push subscription allowlist | `ui/electron/preload.js:1873` |
| Operator methods | `OPERATOR_METHODS` `ui/electron/preload.js:162`, `createOperatorService` `ui/electron/operatorBridge.js:286` |
| Adapter degraded messages | `setDegraded` `ui/electron/coreLauncher.js:1485` |
| Boot-time capsule defaults | `buildFirstSurfaceCreateRequest` `ui/electron/main.js:1938` |
| Create deadline | `SURFACE_CREATE_DEADLINE_MS` `ui/electron/hostBindings.js:49`, `FIRST_SURFACE_CREATE_TIMEOUT_MS` `ui/electron/main.js:1921` |
| Renderer boot refusal copy | `refuseBoot` `ui/src/main.js:250` |
| Host refusal toast text | `createReasons` in `submitHost`, `ui/src/App.vue:1273` |

### UI shell: how do I test the shell?
Answers: which tests cover main; how to run preload tests; test for renderer readiness; how to run UI tests

The package script is `node --max-old-space-size=1024 --test --test-concurrency=1 --test-timeout=120000 test/*.test.js` (`ui/package.json:12`), so `npm --prefix ui test` runs the whole suite. Relevant files that exist: `ui/test/main-startup-order.test.js`, `ui/test/renderer-ready.test.js`, `ui/test/pkgfix-main-quit.test.js`, `ui/test/t4-main-regression.test.js`, `ui/test/preload.test.js`, `ui/test/preload-ports.test.js`, `ui/test/wire-preload-origin.test.js`, `ui/test/coreLauncher.test.js`, `ui/test/hostBindings.test.js`, `ui/test/mvui-int-boot.test.js`, `ui/test/mvui29s-settings-boot.test.js`. A single file can be run directly with `cd ui && node --test test/renderer-ready.test.js` (not a package script). In this checkout without installed dependencies, `renderer-ready.test.js` passed and Vue-importing tests fail with `ERR_MODULE_NOT_FOUND` for `vue`; run `npm --prefix ui ci` first (inference).

### UI shell: which tradeoffs are documented?
Answers: why attach instead of spawn the core; why the adapter shutdown grace is long; why hide before teardown; why no modal dialogs

- Attach to a running core socket, never spawn a guessed binary (`ui/electron/hostBindings.js:3`-`7`).
- Adapter SIGTERM grace [CITED: ui/electron/main.js:2161] 45000 ms sits above the adapter's 30 s [CITED: ui/electron/main.js:3032] close budget; "equal budgets leaked the capsule" (`ui/electron/main.js:3032`-`3034`).
- Hide the window before teardown so a slow demo-recording stop does not leave a frozen window (`ui/electron/main.js:2313`-`2314`).
- Startup notices are never modal: "with nobody at the screen it would hang the app" (`ui/electron/main.js:87`).
- Boot-time capsule creation has its own final bound and does not consume the readiness budget (`ui/electron/main.js:45`-`49`).

## Capsule tree (navigation tree)

Answers: what is capsule tree in MetaViewer; how does capsule tree work; where is the capsule tree code; what breaks in capsule tree

The **capsule tree** is the left navigation rail in `App.vue`: two views (Humans, Agents), each with numbered desktops, each listing its capsules with a status. A **desktop** is one page of the wall; capsule-to-desktop assignments live in the desktop state owned by `DesktopWorkspace` (wall reader).

### Capsule tree: why does the capsule tree exist, and why is it built this way?
Answers: what is the navigation tree; why is buildWorkingTree pure; where does the tree get its data; why Humans and Agents

The tree is a presentation of already admitted projection rows; it creates no authority. `buildWorkingTree` is documented as "Pure presentation of admitted projection rows; ownership is never activity" (`ui/src/App.vue:1652`). It is recomputed from reactive inputs (`ui/src/App.vue:1698`), so it cannot drift from the wall's rows and desktop state.

### Capsule tree: what are the parts of the capsule tree?
Answers: which functions build the tree; where is the tree markup; where is rename implemented; who supplies handoff flags

| File / symbol | Role |
|---|---|
| `buildWorkingTree` `ui/src/App.vue:1658` | Pure builder: views, desktops, capsules, status, tone, symbol |
| `navigationTree` `ui/src/App.vue:1698` | Computed input wiring |
| `refreshTreeMetadata` `ui/src/App.vue:1685` | Reads app icons, programs, browser choices from `window.metaviewerRoles` |
| `beginTreeRename` / `saveTreeRename` / `cancelTreeRename` `ui/src/App.vue:1701`-`1721` | Inline rename |
| `treeDesktopExpanded` / `toggleTreeDesktop` / `selectTreeDesktop` `ui/src/App.vue:1725`-`1729` | Collapse and select |
| `selectTreeCapsule` `ui/src/App.vue:1731` | Reveal a capsule from the tree |
| Template `ui/src/App.vue:1861`-`1891` | Tree markup and anchors (`wall/tree/<id>`, `wall/tree/<view>/<desktop>/fold`, `wall/tree/rename/...`) |
| `HandoffNotice` `ui/src/App.vue:1911` | Emits `pending` surface ids into `treeHandoffs` |
| `ui/src/wall/DesktopWorkspace.vue` | Owns `renameDesktop`, `renameCapsule`, `selectDesktop`, `revealSurface` (wall reader) |

### Capsule tree: how does data flow into the tree?
Answers: where do tree statuses come from; how does Needs you appear; how are program icons found; how does recording show in the tree

Inputs: `rows` (admitted, not destroyed, not locally stopped; lost only on live boots, `ui/src/App.vue:1645`-`1651`) plus MicroVM workload tiles, `desktopState` (from `@desktops-change`, `ui/src/App.vue:755`), `treeHandoffs` (from `HandoffNotice`, `ui/src/App.vue:1911`), `closedPanels` (shown as Minimized), `treeMetadata` and `demoRecordingSnapshot` (`ui/src/App.vue:1698`). Kind is `microvm` for a guest-command workload, `program` when the profile matches a program, `browser` when it matches a browser choice, else `unknown` (`ui/src/App.vue:1667`). Metadata is refreshed when the row set changes or the launcher closes and keeps only base64 PNG/SVG icons and at most [CITED: ui/src/App.vue:1692] 256 apps (`ui/src/App.vue:1685`-`1697`). Titles prefer a stored label from `state.labels` keyed by profile id (`ui/src/App.vue:1676`).

### Capsule tree: what must hold in the tree?
Answers: tree status order; when is a capsule marked Not isolated; remove desktop rules; collapse persistence

- Status precedence: MicroVM phase, "Needs you", "Lost", "Recording automation", "Error", "Connecting", "Minimized", "Acting" (agent view only), then "Human"/"Agent" (`ui/src/App.vue:1674`).
- A capsule backed by a host window or host program carries `notIsolated` and shows "Not isolated" (Host programs run on the host) (`ui/src/App.vue:1676`, `ui/src/App.vue:1879`-`1881`).
- "Remove empty desktop" appears only for an active desktop other than desktop 1 [CITED: ui/src/App.vue:1888] and is disabled while any capsule is assigned there (`ui/src/App.vue:1888`); "+" is disabled until the desktop state loads or at `MAX_DESKTOPS_PER_VIEW` (`ui/src/App.vue:1867`).
- Collapse state is a local, unpersisted map keyed `<view>/<desktop>`; selecting a desktop expands it (`ui/src/App.vue:1725`-`1729`).
- Rename input is limited by `maxlength="80"` [CITED: ui/src/App.vue:1874].

### Capsule tree: what can go wrong in the tree?
Answers: rename fails; Name could not be saved; tree click does nothing; capsule missing from tree

| Symptom the user sees | Cause | Coordinate | Fix or workaround |
|---|---|---|---|
| "Name could not be saved." under the view | `renameDesktop`/`renameCapsule` returned false or threw (for example layout storage refused) | `ui/src/App.vue:1712`-`1713` | Check the "Layout unavailable" notice; retry |
| Clicking a capsule does nothing | Id not in rows or no desktop assignment | `ui/src/App.vue:1733`-`1735` | Use Refresh (`refreshWall`, `ui/src/App.vue:1435`) |
| Capsule not listed | Row destroyed, locally stopped, or lost on a fixture boot | `ui/src/App.vue:1647`-`1649` | Expected; reopen from the launcher |
| No program icons | `window.metaviewerRoles` absent (fixture/nested) or metadata rejected | `ui/src/App.vue:1686`, `ui/src/App.vue:1692` | (inference) host role preload not installed |
| "No capsules" under a desktop | Desktop has no assigned rows | `ui/src/App.vue:1885` | Move or open a capsule there |

### Capsule tree: which refusals does the tree raise?
Answers: tree error codes; rename refusal text

| Code or text | Raised at | Meaning |
|---|---|---|
| "Name could not be saved." | `ui/src/App.vue:1712` | Rename not persisted |
| Silent no-op | `ui/src/App.vue:1733`, `ui/src/App.vue:1735` | Unknown capsule or no home desktop |
| `LAYOUT_SAVE_REFUSED` (shown as "Changes cannot be saved in this session.") | `ui/src/App.vue:128`, `ui/src/App.vue:1904` | Layout writes locked for the session |

### Capsule tree: where do I change what in the tree?
Answers: change tree status text; change tree icons; add a tree action; change handoff marking

| To change | Edit |
|---|---|
| Status, tone, symbol | `ui/src/App.vue:1674`-`1676` |
| Kind detection and icons | `ui/src/App.vue:1663`-`1667`, `ui/src/App.vue:1881` |
| View labels "Humans"/"Agents" | `ui/src/App.vue:1678` |
| Rename behaviour | `ui/src/App.vue:1701`-`1721`; persistence in `ui/src/wall/DesktopWorkspace.vue` |
| Collapse / select | `ui/src/App.vue:1725`-`1741` |
| Handoff marking | `HandoffNotice` (`ui/src/handoff/HandoffNotice.vue`) and `ui/src/App.vue:1911` |

### Capsule tree: how do I test the tree?
Answers: tree tests; working tree test command

`ui/test/working-tree.test.js` references the tree (grep for `buildWorkingTree`, `beginTreeRename`, `tree-rename`). Run it with the suite (`npm --prefix ui test`) or directly with `cd ui && node --test test/working-tree.test.js`; it imports `vue`, so dependencies must be installed (it failed with `ERR_MODULE_NOT_FOUND` in this checkout).

### Capsule tree: which tradeoffs are documented for the tree?
Answers: why is collapse not saved; why ownership is not activity

The code comment states the builder is pure and "ownership is never activity" (`ui/src/App.vue:1652`): an owned capsule is shown "Human"/"Agent", and only `aiSessionActivity === 'busy'` or an in-flight dispatch shows "Acting" (`ui/src/App.vue:1673`). Keeping collapse state local and unpersisted is a design choice not explained in comments: ABSENT — do not invent.

## Wall and tiles

Answers: what is wall and tiles in MetaViewer; how does wall and tiles work; where is the wall and tiles code; what breaks in wall and tiles

Terms used here. A **capsule** is one running workload shown on the wall (a browser, a Host program, a Program, a VM or MicroVM). A **tile** is the on-screen panel for one capsule. The **projection** is the read-only feed of surface rows the core publishes (id, surfaceId, backendLifecycle, visibility, control, generation, refusal). An **intent** is a request the UI sends to the authority; the wall itself only rearranges panels. **Dockview** is the docking library inside the kit `DockWorkspace` component.

### Wall: why it exists and why built this way

Answers: why is the wall presentation-only; why can't the wall stop a capsule; why one panel per capsule; who owns the layout bytes; why are tile states derived and not stored

The wall shows every capsule as exactly one tile and lets the user arrange tiles, but it never creates, stops or changes a capsule itself. `WallWorkspace.vue` says so in its header: "Exactly one permanent panel per capsuleId; the kit owns the layout host, controller and restore barrier. This module never touches storage, layout bytes or backend verbs" (ui/src/wall/WallWorkspace.vue:3). Closing a tile only removes the dock panel and emits `panel-closed` (ui/src/wall/WallWorkspace.vue:1334); the local verbs close, hide, show, float and dock-back are documented as "None of them ends a backend surface" (ui/src/wall/WallWorkspace.vue:297).

The tile state is computed again on every projection notice from the authoritative row (`deriveTileState`, ui/src/wall/tileStates.js:225), so the tile cannot drift from core truth. Gestures (fold, pin, take or release control) become intents sent upward through `submit-intent`; the tile shows a pending "Folding"/"Unfolding" label only until the authority moves (ui/src/wall/SurfacePanel.vue:646).

The pure logic is kept in dependency-free modules (`tileStates.js`, `tileCapture.js`, `capsuleId.js`, the `<script>` block of `SurfacePanel.vue`) so node:test can load them without a DOM (ui/src/wall/tileStates.js:3).

### Wall: parts

Answers: which files make up the wall; what does SurfacePanel do; where is the tile capture rail; what is workloadPanelParams; is capsulePanelRouter used

| File | Role |
|---|---|
| ui/src/wall/WallWorkspace.vue | One wall per desktop over kit DockWorkspace; controller `createWallWorkspaceController` (ui/src/wall/WallWorkspace.vue:616) handles reveal, presets, resize, floating drag, layout echoes and orphan pruning |
| ui/src/wall/SurfacePanel.vue | One tile: kit CapsulePanel plus capture rail, network panel, paired-terminal drawer, state-controls slot; derives the tile state and emits intents |
| ui/src/wall/TileCaptureChrome.vue | Per-tile rail: record toggle, Screenshot, recording badge, capsule id chip with "Copy ID for AI", capture refusal alert |
| ui/src/wall/tileStates.js | The seven tile states and `deriveTileState` precedence |
| ui/src/wall/tileCapture.js | Capture rail helpers: anchors, labels, `--:--` elapsed, store reads, refusal text; re-exports capsuleId.js |
| ui/src/wall/capsuleId.js | Capsule id chip model, ready line, clipboard copy, 2000 ms [CITED: ui/src/wall/capsuleId.js:22] confirmation |
| ui/src/wall/workloadPanelParams.js | Live Dockview content router: capsuleId params go to SurfacePanel, sessionId params go to the workload slot |
| ui/src/wall/capsulePanelRouter.js | Older router variant ("microvm" kind); no ui/src importer on this commit, only tests |
| ui/src/wall/guestWorkloadTile.js | Builds the "ARM64 MicroVM" guest console tile identity from a guest-command snapshot |
| ui/src/wall/rewindStateControls.js | Pure projection of the MicroVM Back (rewind restore) menu |
| ui/src/wall/restoreDuration.js | Display-only timing of a rewind restore |
| ui/src/wall/EmptyWallView.vue | Empty-wall screen with "Add capsule" |
| ui/src/wall/wall.css | Wall styles; no design tokens defined in it (checked: no `--mv-` declarations) |

### Wall: data flow

Answers: how does a row become a tile; what events does a tile emit; how does the capture rail talk to recording; how does the MicroVM console tile get onto the wall; what does Copy ID for AI put on the clipboard

1. Projection to tile. `DesktopWorkspace.vue` hands each wall a filtered feed with `getProjection`, `getSnapshot` and `subscribe` (ui/src/wall/DesktopWorkspace.vue:97). `WallSurfaceRouter` (ui/src/wall/WallWorkspace.vue:1509) renders `SurfacePanel` for a panel whose params carry `capsuleId`. The panel picks the single row with `row.id === capsuleId && row.surfaceId === capsuleId` (ui/src/wall/SurfacePanel.vue:176) and runs `deriveTileState`.
2. Panel to kit. SurfacePanel provides `publicProjectionView` with the `folded` mirror (ui/src/wall/SurfacePanel.vue:503), plus `tileScheduler`, `presentationScheduler` and `controlRegistry` only when those objects really expose the needed functions.
3. Gestures to intents. Fold and pin call `intentBuilders.visibility`; control calls `intentBuilders.control`; these emit `submit-intent` (ui/src/wall/SurfacePanel.vue:655). Close and dock-back emit `presentation-intent`, which the wall applies locally (ui/src/wall/WallWorkspace.vue:1243). State controls emit `state-action` only for back, save or load when marked available (ui/src/wall/SurfacePanel.vue:465).
4. Capture rail. The rail reads `captureState.bySurface[surfaceId]` (`phase`, `elapsedMs`, `lastShot`, `lastCode`) and calls `captureState.toggleRecord(id)` or `captureState.screenshot(id)` (ui/src/wall/tileCapture.js:245). An injected `automation-recording` snapshot turns the badge into "Recording automation" with a Stop button (ui/src/wall/TileCaptureChrome.vue:69).
5. Copy ID for AI. It copies only the bare surface id to the injected or ambient clipboard (ui/src/wall/capsuleId.js:140), even though the function is named `copyCapsuleReadyLine`. The separate ready-line format is `CAPSULE=<id>  IDENTITY=<profile or <none>>` (ui/src/wall/capsuleId.js:69).
6. MicroVM guest console. App.vue builds at most one tile with `guestWorkloadTile` (ui/src/wall/guestWorkloadTile.js:5) and passes it as `workloadTiles` with `validGuestWorkloadTile`. The wall adds a `workload-panel:<id>` panel with params `{sessionId}` (ui/src/wall/WallWorkspace.vue:754), and `workloadPanelParams.js` routes it to the consumer `workload` slot. The rewind Back menu and the restore duration live in GuestCommandPanel.vue, which imports `rewindStateControls.js` and `restoreDuration.js` (ui/src/components/GuestCommandPanel.vue:5). Rewind and the MicroVM are ARM64-only.
7. Echoes. After the authority confirms a move, tab or float, the caller applies it with `applyLayoutEcho` (ui/src/wall/WallWorkspace.vue:1301); float bounds are validated but the kit ignores them today (comment at ui/src/wall/WallWorkspace.vue:1269).

### Wall: invariants

Answers: what must a capsule id look like; when is a tile live; when does the agent chip say acting; what can never be released by default; when is Back offered

- One panel per capsule: panel id is `panel-<surfaceId>` (ui/src/wall/layout.js:123) and the row must have `id === surfaceId` (ui/src/wall/WallWorkspace.vue:1079).
- Capsule ids are never invented: blank or whitespace ids refuse with ERR_INVALID_CAPSULE_ID (ui/src/wall/WallWorkspace.vue:520); SurfacePanel also rejects all-digit ids (ui/src/wall/SurfacePanel.vue:101).
- Transport alone never proves live: an unknown lifecycle or missing row stays connecting / "Waiting" (ui/src/wall/tileStates.js:225).
- Only lifecycles active, standby and ceded keep capture running; folded tiles keep capturing (ui/src/wall/tileStates.js:29).
- The agent chip says "Agent acting" only with evidence (busy session, or dispatch outcome admitting, accepted or executing); ownership alone reads "Agent ready" (ui/src/wall/tileStates.js:108, ui/src/wall/SurfacePanel.vue:573).
- A control request without a verb is always take_control; release needs an explicit verb (ui/src/wall/tileStates.js:178).
- Copy is allowed only for an id matching `/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/` (ui/src/wall/capsuleId.js:16) and up to 4096 bytes [CITED: ui/src/wall/capsuleId.js:24].
- Panel params may carry only capsuleId, sessionId, viewMode, slotFolded, with exactly one of capsuleId or sessionId (ui/src/wall/workloadPanelParams.js:12).
- Back is offered only when rewind and guest sessions are both held by the same owner for the same workload, nothing is busy or pending, and the guest job is finished (ui/src/wall/rewindStateControls.js:10).
- A restore duration is shown only after an observed "restoring" step and a successor with generation and authority_epoch each +1 [CITED: ui/src/wall/restoreDuration.js:32].

### Wall: failure modes

Answers: why does my tile say Waiting; why does a tile say Lost or Destroyed; why is Copy ID for AI disabled; why is the record button greyed out; what does Missing capsule id mean

| Symptom the user sees | Cause | Coordinate | Fix or workaround |
|---|---|---|---|
| Tile says "Waiting" | Projection transport unavailable or not live, or row missing / unknown lifecycle | ui/src/wall/tileStates.js:225 | Wait for the core feed; check the capsule is running |
| Tile says "Lost" | Row departed from a resident feed, or lifecycle lost | ui/src/wall/tileStates.js:225 | Reopen the capsule; a lost tile may keep its frozen last frame (ui/src/wall/SurfacePanel.vue:582) |
| Tile says "Destroyed" | backendLifecycle destroyed; the wall closes that panel on the next 150 ms [CITED: ui/src/wall/WallWorkspace.vue:1583] refresh | ui/src/wall/WallWorkspace.vue:1583 | Start a new capsule |
| Tile says "Surface update unavailable" | Typed refusal on the row or snapshot, or error transport; raw code only in `data-error-code` | ui/src/wall/SurfacePanel.vue:727 | Read the code with `refusalCodeFor`; act on that refusal |
| "Missing capsule id. Reset the workspace layout." | Graphical panel params lack a valid capsuleId | ui/src/wall/WallWorkspace.vue:1519 | Reset the workspace layout |
| "Missing capsule id or invalid capsule presentation." | Params fail router classification | ui/src/wall/workloadPanelParams.js:37 | Reset the workspace layout |
| "This capsule presentation is no longer available." | Workload panel with no single matching valid workload row (guest session gone) | ui/src/wall/workloadPanelParams.js:43 | Close the panel; reopen the MicroVM console when ready |
| Record disabled: "Recording is unavailable" | No capture store, `available:false`, or missing actions | ui/src/wall/tileCapture.js:36 | Recording service must be bound by the shell |
| Record disabled: "An automation is recording" | Automation recording active for this identity | ui/src/wall/TileCaptureChrome.vue:83 | Stop the automation (badge Stop button) |
| "Capture refused: this surface is not available. Reopen a live capsule." | Host lastCode SURFACE_UNKNOWN | ui/src/wall/tileCapture.js:332 | Reopen a live capsule |
| Copy ID for AI disabled: "Capsule is lost; nothing to manage" | Tile state lost or error | ui/src/wall/capsuleId.js:28 | Nothing to copy; reopen the capsule |
| "Copy unavailable" after clicking | No clipboard, write refused, or invalid id | ui/src/wall/capsuleId.js:140 | The tooltip carries the ERR_* reason |
| Floating window will not drag | No `*-style-nonce` meta, gesture refused silently | ui/src/wall/WallWorkspace.vue:97 | Run inside the packaged shell that sets the nonce |
| "Tile layout is unavailable. Try again after the desktop is ready." | Preset refused or threw (LAYOUT_PRESET_FAILED / ERR_NOT_READY) | ui/src/App.vue:1460, ui/src/wall/WallWorkspace.vue:810 | Retry after the wall is ready |

### Wall: refusals

Answers: what does ERR_NOT_READY mean; what codes can revealSurface return; what errors can SurfacePanel throw; what does LAYOUT_SIZE_INVALID mean; which clipboard errors exist

| Code or text | Raised at | Meaning |
|---|---|---|
| ERR_INVALID_CAPSULE_ID | ui/src/wall/WallWorkspace.vue:523 | Blank or whitespace capsule id |
| ERR_INVALID_PLACEMENT | ui/src/wall/WallWorkspace.vue:1120, ui/src/wall/WallWorkspace.vue:1277, ui/src/wall/WallWorkspace.vue:1301 | Unknown placement, or echo params out of range |
| ERR_NOT_READY ("wall is not ready: cold restore has not settled") | ui/src/wall/WallWorkspace.vue:1120 | Kit ready event not yet received |
| ERR_PROJECTION_UNAVAILABLE / ERR_UNKNOWN_SURFACE / ERR_ROW_IDENTITY_MISMATCH / ERR_SURFACE_GONE / ERR_UNKNOWN_LIFECYCLE | ui/src/wall/WallWorkspace.vue:1079 | Row lookup refused |
| ERR_REVEAL_FAILED | ui/src/wall/WallWorkspace.vue:1233 | Dockview threw during reveal |
| ERR_UNKNOWN_PRESENTATION / ERR_UNKNOWN_PANEL / ERR_PRESENTATION_FAILED | ui/src/wall/WallWorkspace.vue:1245 | Local presentation intent refused |
| ERR_INVALID_READY | ui/src/wall/WallWorkspace.vue:1051 | Kit ready payload lacks api or window presentation |
| ERR_UNKNOWN_WORKLOAD | ui/src/wall/WallWorkspace.vue:754 | No validated workload row with that id |
| LAYOUT_PRESET_INVALID / LAYOUT_PRESET_FAILED / LAYOUT_PRESET_DUPLICATE | ui/src/wall/WallWorkspace.vue:950, ui/src/wall/WallWorkspace.vue:810, ui/src/wall/WallWorkspace.vue:169 | Preset unknown, failed or has duplicate tiles |
| LAYOUT_SIZE_INVALID / LAYOUT_SIZE_FAILED | ui/src/wall/WallWorkspace.vue:977 | Unknown tile or size action, or Dockview threw |
| SNAP_GRID_INVALID | ui/src/wall/WallWorkspace.vue:17 | Snap grid outside 1..5 [CITED: ui/src/wall/WallWorkspace.vue:16] or bad wall size |
| ERR_PANEL_INVALID_PROP / ERR_PANEL_INVALID_ANCHOR ("SurfacePanel: invalid ...") | ui/src/wall/SurfacePanel.vue:152, ui/src/wall/SurfacePanel.vue:101 | Panel dependencies or id malformed (thrown at setup) |
| "Popout is unavailable: this window denies new windows." | ui/src/wall/SurfacePanel.vue:54 | Popout is always unavailable |
| ERR_CAPSULE_ID_INVALID / ERR_CAPSULE_LINE_TOO_LARGE / ERR_CLIPBOARD_UNAVAILABLE / ERR_CLIPBOARD_WRITE_REFUSED | ui/src/wall/capsuleId.js:140 | Copy ID for AI outcome reasons (never thrown) |
| SURFACE_UNKNOWN / CAPTURE_UNAVAILABLE (host lastCode) | ui/src/wall/tileCapture.js:332 | Mapped to safe capture refusal text |
| STALE_FRAME, SURFACE_NOT_AGENT_CONTROLLED, LOCKED_BY_OTHER, BUDGET_EXCEEDED, OUT_OF_BOUNDS, POLICY | ui/src/wall/SurfacePanel.vue:43 | Core refusal codes the panel recognizes |
| Error "Invalid capsule identity" / "Duplicate capsule identity" | ui/src/wall/layout.js:134 | Default layout build refused |

### Wall: where to change what

Answers: where do I change tile status text; where are tile presets computed; where is the copied text built; where is the capture refusal copy; where are minimum tile sizes

| To change | Edit |
|---|---|
| Tile state rules or precedence | ui/src/wall/tileStates.js:225 |
| Settled status labels (Folded, Human control, Agent acting/ready) | ui/src/wall/SurfacePanel.vue:573 |
| Preset geometry | ui/src/wall/WallWorkspace.vue:169 |
| Minimum tile size, orphan grace | ui/src/wall/WallWorkspace.vue:287 |
| Capture refusal text | ui/src/wall/tileCapture.js:332 |
| Copy ID for AI text and grammar | ui/src/wall/capsuleId.js:16 |
| Router accepted param keys | ui/src/wall/workloadPanelParams.js:12 |
| MicroVM Back gating | ui/src/wall/rewindStateControls.js:10 |
| Empty-wall copy | ui/src/wall/EmptyWallView.vue:15 |

### Wall: how to test it

Answers: which tests cover the wall; how do I run one wall test; where are tile state tests; is there a test for Copy ID for AI; how do I test panel routing

`ui/package.json` defines `"test"` as `node --max-old-space-size=1024 --test --test-concurrency=1 --test-timeout=120000 test/*.test.js`, so `npm --prefix ui test` runs the whole suite. To run one file, call node directly from `ui/`: `node --test test/<file>`.

| Test file | Covers |
|---|---|
| ui/test/wall.test.js | WallWorkspace imports, controller, router wiring |
| ui/test/workload-panel-routing.test.js | workloadPanelParams.js router |
| ui/test/capsule-panel-routing.test.js | capsulePanelRouter.js (legacy) and related guest tile modules |
| ui/test/mvui4-wall-states.test.js | Tile states |
| ui/test/mvui30-lost-panel.test.js | Lost tile with frozen frame |
| ui/test/mvui9-tile-chrome.test.js | Capture rail |
| ui/test/mvui14-wall-capture.test.js | Capture store behaviour on tiles |
| ui/test/capid-copy-id.test.js | Copy ID for AI |
| ui/test/rewind-header.test.js | Back menu projection |
| ui/test/restore-duration.test.js | Restore duration |
| ui/test/guest-workload-generation.test.js | Guest workload tile generation |
| ui/test/mvui-wall-sfc.test.js | Wall single-file components |

### Wall: tradeoffs and rejected options

Answers: why is derivePanelStatus deprecated; why does ownership not mean acting; why is the folded flag mirrored; why is popout disabled; why does a resize drop the preset

- `derivePanelStatus` is kept only for status-parity tests; tile decisions moved to `deriveTileState` (ui/src/wall/SurfacePanel.vue:196, comment "@deprecated").
- The earlier ownership fallback made every idle agent tile read "Agent acting"; it was removed so the chip needs activity evidence (ui/src/wall/tileStates.js:108).
- Live rows carry only `visibility`, so the panel mirrors it into the kit `folded` boolean; without it a committed fold never hid the kit body (ui/src/wall/SurfacePanel.vue:313).
- Popout stays unavailable "by design (R2)" (ui/src/wall/WallWorkspace.vue:295).
- A manual resize sets the preset to custom because "a preset refresh must not replace" Dockview ratios (ui/src/wall/WallWorkspace.vue:973).
- `readSurfaceEntry` reads the key directly before the own-property check, because a hasOwnProperty-only read left the badge frozen on its mount-time value (ui/src/wall/tileCapture.js:245).
- `WallMissingPanel` is exported but not registered as a panel component (ui/src/wall/WallWorkspace.vue:1349, ui/src/wall/WallWorkspace.vue:1562); (inference) it is unused on this commit.
- `capsulePanelRouter.js` and `workloadPanelParams.js` are near copies; only the latter is imported by the wall (inference: the former is a retained older version).

## Layouts and desktops

Answers: what is layouts and desktops in MetaViewer; how does layouts and desktops work; where is the layouts and desktops code; what breaks in layouts and desktops

Terms. A **view** is one of the two role groups, Humans (`human`) and Agents (`agent`). A **desktop** is one numbered wall inside a view. A **preset** is a named tile arrangement. The **snap grid** is the per-desktop columns x rows grid used for Control-held drag snapping. An **identity cell** is a remembered grid cell for an identity (profile), so a reopened identity returns to the same place.

### Layouts: why it exists and why built this way

Answers: why are there Humans and Agents views; why does each desktop have its own wall; why is the desktop state validated twice; why is layout presentation-only

Capsules are split by role into two views, each with up to 16 [CITED: ui/electron/desktopLayout.js:4] desktops, so the human and agent working sets do not mix. Each desktop mounts its own `WallWorkspace` with its own storage adapter and filtered feed (ui/src/wall/DesktopWorkspace.vue:87), so the kit restore logic stays per wall. The state model in `ui/electron/desktopLayout.js` is "Presentation state only. Shared by the renderer and packaged layout gate" (ui/electron/desktopLayout.js:1): the renderer validates on load and the Electron layout bridge validates again before accepting bytes (ui/electron/main.js:1685).

### Layouts: parts

Answers: which files handle desktops; where is the desktop schema; where are keyboard shortcuts defined; what builds the default layout

| File | Role |
|---|---|
| ui/src/wall/DesktopWorkspace.vue | Desktop host: load, migrate, save, assign capsules, move tiles, refresh, shortcuts |
| ui/electron/desktopLayout.js | `metaviewer.desktops/v1` model: validate, add, remove, renumber, move, prune, labels |
| ui/electron/desktopShortcuts.js | Shared chord grammar and native-tile forwarding |
| ui/src/wall/layout.js | Default wall profile (`createWallLayout`) and stored-layout migration (`migrateWallLayout`) |
| ui/src/wall/WallWorkspace.vue | Presets, snap drag, floating cells, resize (per wall) |
| ui/electron/main.js | Layout bridge that validates stored payloads (ui/electron/main.js:1685) |

### Layouts: data flow

Answers: how is the layout loaded; how is it saved; how does a shortcut reach the wall; how does a capsule get assigned to a desktop; how does moving a tile work

1. Load. On mount `storage.readRaw()` is parsed. A `metaviewer.desktops/v1` value must pass `validateDesktopState` with the kit decoder (ui/src/wall/DesktopWorkspace.vue:316); layouts are normalized and desktops renumbered. A legacy single-wall profile is copied into desktop 1 of both views (ui/src/wall/DesktopWorkspace.vue:325). ui/src/main.js runs stored bytes through `migrateWallLayout` (ui/src/main.js:78).
2. Assign. `reconcile` puts each row and workload tile into the view from `props.modes`, default `agent` (ui/src/wall/DesktopWorkspace.vue:70); a new capsule lands on that view's active desktop.
3. Save. Any state change triggers `persist`, a coalesced write loop through `storage.writeAtomic` that prunes panels not owned by the desktop (ui/src/wall/DesktopWorkspace.vue:55). Each wall writes its layout into its desktop through the adapter, which also records identity cells from floating positions (ui/src/wall/DesktopWorkspace.vue:104).
4. Shortcuts. In the renderer, capture-phase keydown/keyup go through `desktopShortcut`. When a native tile has focus, ui/electron/xpraHumanTile.js:68 calls `interceptDesktopShortcut`, which dispatches the `metaviewer:desktop-shortcut` CustomEvent into the renderer (ui/electron/desktopShortcuts.js:26); DesktopWorkspace listens at ui/src/wall/DesktopWorkspace.vue:361.
5. Move. `moveTile` asks native `metaviewerRoles.visibility(id,false)`, closes the panel on the source wall, moves the assignment, cleans layouts, reveals on the target and saves (ui/src/wall/DesktopWorkspace.vue:252).
6. Refresh. App.vue `refreshWall` (ui/src/App.vue:1435) calls `refreshCurrentDesktop` (ui/src/wall/DesktopWorkspace.vue:158), which re-reveals live rows and workload tiles and reapplies the preset; no capsule command is issued.

### Layouts: invariants

Answers: how many desktops can I have; can desktop 1 be removed; can a capsule be on two desktops; what labels are allowed; what snap grid sizes are valid

- Each view has desktop 1, at most 16 [CITED: ui/electron/desktopLayout.js:4] desktops, unique ids below `next`, and an existing active id (ui/electron/desktopLayout.js:22).
- Exact key sets at every level; any extra key fails validation (ui/electron/desktopLayout.js:22).
- A saved panel belongs to the desktop that its assignment names and appears once across all desktops (ui/electron/desktopLayout.js:22).
- Desktop 1 and any desktop with assigned capsules cannot be removed (ui/electron/desktopLayout.js:82).
- Moves stay inside the capsule's current view (ui/electron/desktopLayout.js:101).
- Snap grid cols and rows are 1..5 [CITED: ui/electron/desktopLayout.js:35]; identity cells at most 256 [CITED: ui/electron/desktopLayout.js:37] with col/row below 5.
- Labels: trimmed, 1..80 [CITED: ui/electron/desktopLayout.js:160] code points, no control or bidi override characters; at most 256 [CITED: ui/electron/desktopLayout.js:177] capsule labels.
- Assignments for ids absent from a live, fresh projection are pruned only after 5000 ms [CITED: ui/src/wall/DesktopWorkspace.vue:345] of live projection; panels on a wall after 5000 ms [CITED: ui/src/wall/WallWorkspace.vue:287].
- Layout scope is `metaviewer` / `default` / `main-wall` (ui/src/wall/layout.js:5).

### Layouts: failure modes

Answers: why can't I save my layout; why did my desktop refresh fail; why can't I add a desktop; why won't my desktop delete; why did my tile layout reset

| Symptom the user sees | Cause | Coordinate | Fix or workaround |
|---|---|---|---|
| Layout changes are not saved (layout unavailable, LAYOUT_SAVE_REFUSED) | Stored state failed validation or read failed; state became read-only | ui/src/wall/DesktopWorkspace.vue:330 | Fix or remove the stored layout; restart |
| "The desktop changed during refresh. Refresh the current desktop again." | DESKTOP_CHANGED | ui/src/App.vue:1435 | Refresh again |
| "Live capsule state is unavailable. Reconnect, then refresh." | PROJECTION_UNAVAILABLE: projection not live or stale | ui/src/wall/DesktopWorkspace.vue:168 | Reconnect to the core |
| "Some capsule panels could not be restored. Try again after their state is ready." | SURFACE_UNAVAILABLE with failedCapsules | ui/src/wall/DesktopWorkspace.vue:158 | Retry when capsules are ready |
| "Wall refresh is unavailable. Try again after the desktop is ready." | ERR_NOT_READY | ui/src/wall/DesktopWorkspace.vue:158 | Wait for the wall ready event |
| Add desktop does nothing (layout-error) | DESKTOP_LIMIT at 16 desktops | ui/electron/desktopLayout.js:66 | Remove an empty desktop |
| Remove desktop does nothing | Desktop 1, or capsules still assigned | ui/electron/desktopLayout.js:82 | Move the capsules away, then remove |
| Closed tile does not come back on its own | Tile is in the desktop dismissed set | ui/src/wall/DesktopWorkspace.vue:133 | Use refresh or reveal the capsule |
| Old stored layout opens as an empty wall | Foreign or mismatched panel ids replaced by a fresh wall | ui/src/wall/layout.js:156 | Expected; reopen capsules |
| Rename returns without change | Read-only, pending rename, invalid label, or save failed (label restored) | ui/src/wall/DesktopWorkspace.vue:388 | Use a valid label; retry |

### Layouts: refusals

Answers: what does LAYOUT_CONTRACT_INVALID mean; what is CAPSULE_ROLE_UNPROVEN; what codes does refreshCurrentDesktop return; what is DESKTOP_LIMIT

| Code or text | Raised at | Meaning |
|---|---|---|
| LAYOUT_SAVE_REFUSED | ui/src/wall/DesktopWorkspace.vue:55, ui/src/wall/DesktopWorkspace.vue:377 | State is read-only after a failed load |
| LAYOUT_CONTRACT_INVALID | ui/src/wall/DesktopWorkspace.vue:316; ui/electron/main.js:1685 | Stored desktops or layout failed validation |
| DESKTOP_LIMIT | ui/electron/desktopLayout.js:66 | 16 desktops already in that view |
| CAPSULE_ROLE_UNPROVEN | ui/electron/desktopLayout.js:72 | View is not human or agent |
| ERR_NOT_READY / DESKTOP_CHANGED / PROJECTION_UNAVAILABLE / SURFACE_UNAVAILABLE | ui/src/wall/DesktopWorkspace.vue:158 | refreshCurrentDesktop results |
| ERR_NOT_READY / LAYOUT_SAVE_REFUSED (setPreset) | ui/src/wall/DesktopWorkspace.vue:233 | Preset change before ready or while read-only |

### Layouts: where to change what

Answers: where do I add a preset; where do I change shortcut keys; where is the desktop limit; where is the default capsule size

| To change | Edit |
|---|---|
| Preset list (both places) | ui/electron/desktopLayout.js:6 (`PRESETS`) and ui/src/wall/WallWorkspace.vue:164 (`TILE_PRESETS`), geometry at ui/src/wall/WallWorkspace.vue:169 |
| Shortcut chords | ui/electron/desktopShortcuts.js:3 |
| Desktop limit | ui/electron/desktopLayout.js:4 |
| Desktop state validation | ui/electron/desktopLayout.js:22 |
| Default capsule size 1280 x 900 | ui/src/wall/layout.js:7 |
| Grid snap defaults on preset choice | ui/src/wall/DesktopWorkspace.vue:233 |

Keyboard reference (ui/electron/desktopShortcuts.js:3): Ctrl+Alt+Left / Right / Up / Down makes the focused tile narrower / wider / shorter / taller; Ctrl+Tab toggles Humans and Agents; Ctrl+1..9 selects a desktop.

### Layouts: how to test it

Answers: which tests cover desktops; how do I test shortcuts; where are layout load tests; how do I run one test

Run from `ui/`: `node --test test/<file>`; `npm --prefix ui test` runs the full suite (script in ui/package.json).

| Test file | Covers |
|---|---|
| ui/test/p18c-desktops.test.js | Desktops and shortcuts |
| ui/test/p18f-controls.test.js | Shortcut and control wiring |
| ui/test/v028-grid6.test.js | grid-3x2 preset |
| ui/test/v026-identity-cells-labels.test.js | Identity cells and labels |
| ui/test/display-names.test.js | Display labels |
| ui/test/layout-load.test.js | Layout load and migration |
| ui/test/mvui7-layout-unavailable.test.js | Layout unavailable path |
| ui/test/p18g-wall.test.js | Wall presets and floating |
| ui/test/mvui16d-place-float.test.js | Float placement |

### Layouts: tradeoffs and rejected options

Answers: why wrap leaf roots in a branch; why copy a legacy wall into both views; why identity cells; why wait before pruning

- Older envelopes stored a leaf root that the kit decoder admitted but Dockview's runtime rejects; the code wraps it in a branch and keeps the geometry (ui/electron/desktopLayout.js:111).
- A legacy mixed wall becomes "two filtered copies" rather than being split up front; stale references are removed on save and by each wall's orphan prune (ui/src/wall/DesktopWorkspace.vue:325).
- Identity cells are "bounded identity hints [that] outlive stopped surface IDs", so a restarted identity returns to its cell (ui/src/wall/DesktopWorkspace.vue:104).
- Pruning waits for a 5000 ms [CITED: ui/src/wall/DesktopWorkspace.vue:345] window of live projection, "never prune while native surfaces are still filling the authoritative projection" (ui/src/wall/DesktopWorkspace.vue:334).
- A fresh session switches to the Agents view once when every reported row is agent-mode; saved layouts and explicit navigation close that choice (ui/src/wall/DesktopWorkspace.vue:22).

## Add capsule (catalog)

Answers: what is add capsule in MetaViewer; how does add capsule work; where is the add capsule code; what breaks in add capsule

Terms used here. A *capsule* is one tile on the MetaViewer wall that runs one thing (a browser identity, a program, an attached desktop window, a VM or a MicroVM). A *Host program* is a program that runs directly on the user's computer and shows up in a tile. It is not isolated. The *launcher* is the "Add capsule" dialog. A *create intent* is the `{type:"create-capsule", kind, placement, ...}` object the launcher hands to App.vue.

### Add capsule: why it exists and why built this way
Answers: why does the Add capsule dialog exist; why is the catalog a closed list; why do unknown kinds not crash; why is the model separate from the Vue component

The launcher is the single place a person picks what kind of capsule to open. The kind list is closed and frozen in `ui/src/catalog/catalogModel.js:98` (`CATALOG_KINDS`). Any entry outside that list becomes a typed error row and never throws (`ui/src/catalog/catalogModel.js:88`). The model is pure: no DOM, no framework, no host calls. That lets tests drive it directly, and the Vue layer (`CatalogLauncher.vue`) only wires it up. The dialog itself (`GroupedCapsuleDialog.vue`) is a host copy of the pinned kit New Capsule dialog. It adds grouped sections (Capsule kinds, Recent, Installed apps) and keeps the kit's keyboard model, stable ids and placement modes (`ui/src/catalog/GroupedCapsuleDialog.vue:74`).

### Add capsule: parts
Answers: which files make up the launcher; where is the catalog model; who lists installed apps; what stores the program binary

| file | role |
|---|---|
| `ui/src/catalog/catalogModel.js` | Closed kind set, availability filter, typed error rows, create-intent builder, desktop-window admission, invoker focus return |
| `ui/src/catalog/CatalogLauncher.vue` | Launcher wrapper: app list, card list, role/identity step, program step, window step, emits `create` |
| `ui/src/catalog/GroupedCapsuleDialog.vue` | Grouped dialog: search, category rail, cards, disabled ARM cards, placement (Tab/Split/Floating), keyboard |
| `ui/src/catalog/catalog.css` | Error-row styles, kit tokens only |
| `ui/electron/desktopApplications.js` | Host inventory of installed apps from `.desktop` files, plus the recent-apps list |
| `ui/electron/programBinaries.js` | Per-profile sidecar holding the resolved binary and the Host-program flag |
| `ui/electron/openingMode.js` | Stages the one-shot human/agent opening-mode file for the daemon adapter |
| `ui/electron/rolePreload.cjs` | Exposes `globalThis.metaviewerRoles` over IPC channel `metaviewer:roles.v0.3` |
| `ui/electron/roleHost.js` | Main-process handler for that channel (create, create-program, create-window, list-apps, switch, ...) |

### Add capsule: data flow
Answers: what happens when I click Create Capsule; which IPC channel does the launcher use; how does an installed app become a Host program; how are desktop windows listed

1. App.vue mounts `<CatalogLauncher>` unless the wall is a display-only nested wall (`ui/src/App.vue:2019`). It passes `arm64-capabilities`, `vm-available`, `guest-command-available` and `headless-available`. App.vue fetches the capabilities each time the launcher opens (`ui/src/App.vue:227`).
2. When the launcher opens it calls `metaviewerRoles.listApps()` (`ui/src/catalog/CatalogLauncher.vue:46`). That sends op `list-apps` on `metaviewer:roles.v0.3` (`ui/electron/rolePreload.cjs:11`), which roleHost answers with `installedApps.list()` from `desktopApplications.js` (`ui/electron/desktopApplications.js:71`).
3. `dialogTypes` builds the cards (`ui/src/catalog/CatalogLauncher.vue:197`). Order: allowed catalog kinds, then disabled ARM cards, then Recent apps, then Installed apps.
4. The dialog emits `create` with `{type, placement}` (`ui/src/catalog/GroupedCapsuleDialog.vue:141`). `onCreate` (`ui/src/catalog/CatalogLauncher.vue:222`) then branches:
   - installed or recent app: opens the program step as `host-program` with role preset to `human`
   - `program` / `host-program`: opens the program step (binary name plus Human/Agent role)
   - `desktop-window`: calls `listWindows` (op `list-windows`), checks the whole list, and shows a pick list
   - `identity-browser`: when `metaviewerRoles` exists, opens the role/identity step and calls `choices()`
   - anything else: emits the intent directly
5. The program and window steps emit `create` with a `settle` callback and wait for `{ok:true}` (`ui/src/catalog/CatalogLauncher.vue:76`). App.vue's `onCreateCapsule` (`ui/src/App.vue:954`) routes the intent: `microvm` goes to the guest-command or headless host, `vm` to `authorityHost.createSurface({kind:'vm'})`, and programs to the roles host.
6. On the host side, roleHost resolves the binary, saves a sidecar with `savedPrograms.remember` and stages the opening mode (`ui/electron/roleHost.js:884`). After a successful Host program launch, roleHost records it as recent (`ui/electron/roleHost.js:920`).

### Add capsule: invariants
Answers: when are VM and MicroVM offered; can a disabled card create a capsule; what does a valid create intent look like; what windows can be attached

- VM and MicroVM cards are offered only when the host capabilities have `supported_host === true` and that kind's `available === true`. Without a capabilities object, both are hidden by default (`ui/src/catalog/catalogModel.js:149`).
- On a supported host, an unavailable VM or MicroVM card stays visible but disabled, with the host's reason (`ui/src/catalog/catalogModel.js:498`). The card footer says "Enable: configure verified local assets using the ARM64 capsule setup guide." (`ui/src/catalog/GroupedCapsuleDialog.vue:315`). `onCreate` ignores disabled cards (`ui/src/catalog/CatalogLauncher.vue:223`).
- A program or host-program intent needs a non-empty binary. Its role must be `human` or `agent` (`ui/src/catalog/catalogModel.js:412`). Placement is `tab` unless it is exactly `split` or `floating`.
- The desktop-window list is admitted as a whole or not at all. One bad row, or a duplicate xid or witness, rejects the entire list (`ui/src/catalog/catalogModel.js:368`). A single window needs xid 1..0xffffffff [CITED: ui/src/catalog/catalogModel.js:324], a witness of 1-128 characters with no shell characters, and a size of 1..4096 pixels [CITED: ui/src/catalog/catalogModel.js:349].
- Host program and installed-app cards are always labelled as not isolated: "Runs on your computer — not isolated." in the kind list, "Host programs — Not isolated" on the app groups (`ui/src/catalog/GroupedCapsuleDialog.vue:286`).
- The renderer cannot pick a profile for a program capsule. App.vue refuses with `PROGRAM_PROFILE_FORBIDDEN` (`ui/src/App.vue:982`).
- Installed apps are capped at 256 [CITED: ui/electron/desktopApplications.js:7] and recent ids at 12 [CITED: ui/src/catalog/CatalogLauncher.vue:50]. A `.desktop` entry whose Exec needs real arguments, or whose binary is a shell or `env`, is hidden (`ui/electron/desktopApplications.js:9`).

### Add capsule: failure modes
Answers: why is my installed app missing; why did Start do nothing; why is the VM card greyed out; why no windows in the desktop window list

| symptom the user sees | cause | coordinate | fix or workaround |
|---|---|---|---|
| "Installed apps are unavailable. Choose a capsule kind or type a binary." | `list-apps` failed or returned a bad shape | `ui/src/catalog/CatalogLauncher.vue:51` | Use the Program / Host program kind and type the binary |
| An installed app is not listed | `.desktop` is Hidden, NoDisplay or Terminal, needs arguments, or its binary is a shell | `ui/electron/desktopApplications.js:9` | Start it as Host program by binary name |
| "Program launch was not handled by the host." | No listener settled the create event | `ui/src/catalog/CatalogLauncher.vue:100` | Check that App.vue `onCreateCapsule` is wired (inference) |
| "Program could not be started." or a host reason | Host reply was `ok:false` or not `ok:true` | `ui/src/catalog/CatalogLauncher.vue:76` | Read the shown reason or code |
| "Desktop window attach was not handled by the host." | No listener settled the window intent | `ui/src/catalog/CatalogLauncher.vue:160` | As above |
| "No attachable X11 windows are open. Native Wayland windows are not listed." | Empty admitted list | `ui/src/catalog/CatalogLauncher.vue:411` | Open an X11 window; Wayland-native windows cannot be attached |
| "host_window_unavailable: invalid or ambiguous window list" | One bad or duplicate row rejected the whole list | `ui/src/catalog/CatalogLauncher.vue:261` | Retry; close duplicate windows (inference) |
| VM or MicroVM card disabled with a reason | Capabilities report the kind not available | `ui/src/catalog/catalogModel.js:498` | Follow the reason; see `docs/ARM64_CAPSULE_SETUP.md` |
| VM and MicroVM cards absent | Host not ARM64, or capabilities unavailable | `ui/src/catalog/catalogModel.js:149`, `ui/electron/guestCommandProfile.js:47` | Expected on x64 hosts |
| "This capsule kind is unavailable." row | Host catalog had an unknown kind | `ui/src/catalog/CatalogLauncher.vue:461` | Remove the unknown entry |

### Add capsule: refusals
Answers: what does ERR_CATALOG_UNKNOWN_KIND mean; what is NO_IDENTITY in Add capsule; what is PROFILE_ALREADY_BOUND; which codes can the launcher show

| code or text | raised at | meaning |
|---|---|---|
| `ERR_CATALOG_UNKNOWN_KIND` | `ui/src/catalog/catalogModel.js:88` | Kind id not in the closed set |
| `ERR_CATALOG_INVALID_ENTRY` | `ui/src/catalog/catalogModel.js:90` | Catalog entry has no string kind |
| `ERR_CATALOG_INVALID_INTENT` ("Invalid create intent.") | `ui/src/catalog/catalogModel.js:92` | Missing binary, bad role, or bad window in the intent |
| `SURFACE_CREATE_BUSY: A capsule is already starting...` | `ui/src/catalog/CatalogLauncher.vue:70` | Another capsule is still being created |
| `PROFILE_ALREADY_BOUND: Check this identity in Identities...` | `ui/src/catalog/CatalogLauncher.vue:71` | The chosen identity is not available |
| `NO_IDENTITY: Open Identities to add or check an available identity...` | `ui/src/catalog/CatalogLauncher.vue:71` | No identity chosen |
| `IDENTITY_LIST_UNAVAILABLE` | `ui/src/catalog/CatalogLauncher.vue:305` | The `choices()` call failed |
| `host_window_unavailable: ...` | `ui/src/catalog/CatalogLauncher.vue:251` | Window listing missing, failed or ambiguous |
| `PROGRAM_PROFILE_FORBIDDEN` | `ui/src/App.vue:982` | The renderer tried to choose a profile for a program |
| `DISPLAY_ONLY` | `ui/src/App.vue:956` | Nested walls cannot open new capsules |
| `CAPSULE_MODE_INVALID`, `CAPSULE_MODE_DIRECTORY`, `IDENTITY_PROTECTED` | `ui/electron/openingMode.js:8`, `:39`, `:35` | Bad opening-mode request, unsafe state directory, protected identity |
| `PROGRAM_BINARY_REFUSED` | `ui/electron/programBinaries.js:32` | Program sidecar unsafe or malformed |
| `VM_UNAVAILABLE` | `ui/electron/authorityWire.js:732` | VM create in ARM64 capsule mode without an available VM |

### Add capsule: where to change what
Answers: where do I add a capsule kind; where is the installed-app filter; where is the not-isolated wording; where is the window list check

| change | file |
|---|---|
| Add or rename a capsule kind, card text or keywords | `ui/src/catalog/catalogModel.js:98` |
| When VM/MicroVM show or are disabled | `ui/src/catalog/catalogModel.js:149`, `:498`; host side `ui/electron/authorityWire.js:883` |
| Card order, app cards, MicroVM description | `ui/src/catalog/CatalogLauncher.vue:197` |
| Role/identity, program or window step | `ui/src/catalog/CatalogLauncher.vue:68`, `:76`, `:135` |
| Dialog groups, keyboard, disabled-card footer | `ui/src/catalog/GroupedCapsuleDialog.vue:74`, `:141`, `:315` |
| Which `.desktop` files count as apps | `ui/electron/desktopApplications.js:9` |
| Program sidecar format | `ui/electron/programBinaries.js:71` |
| Intent routing after the launcher | `ui/src/App.vue:954` |

### Add capsule: how to test it
Answers: which tests cover the catalog; how do I run the launcher tests; is there a test for installed apps

These files exist under `ui/test/`: `mvui-catalog-model.test.js`, `mvui-catalog-dialog.test.js`, `grouped-launcher.test.js`, `p18g-catalog.test.js` (covers `availableCatalogKindIds` / `unavailableArmCapsules`), `launcher-recent-launch.test.js`, `desktop-applications.test.js`, `v023-program-binary.test.js`, `v025-desktop-window.test.js` and `arm64-capsule-composition.test.js`. The `test` script in `ui/package.json` runs every `test/*.test.js`, so the full suite is `npm --prefix ui test`. For one file, `cd ui && node --test test/p18g-catalog.test.js` uses Node's runner directly (inference: the script adds no per-file filter).

### Add capsule: tradeoffs and rejected options
Answers: why not let the renderer choose program profiles; why whole-list rejection for windows; why are app launchers with arguments hidden

- The Host program API accepts a binary, not argv. Launchers whose required arguments would be lost are therefore hidden rather than started wrong (comment at `ui/electron/desktopApplications.js:17`).
- Window lists fail closed as a whole. The model comment calls this "Whole-list fail-closed admission" (`ui/src/catalog/catalogModel.js:368`). This means one ambiguous window hides all windows (inference: the tradeoff is safety over convenience).
- Disabled ARM cards stay visible with a reason rather than being hidden: "Disabled ARM choices remain visible with safe host-provided reasons." (`ui/src/catalog/catalogModel.js:498`).

## Modes (opening mode, human/agent control, network mode, settings)

Answers: what is modes in MetaViewer; how does modes work; where is the modes code; what breaks in modes

Terms. *Human mode* means the person controls the capsule's input. *Agent mode* means a separate agent process drives it. The *opening mode* is the mode a capsule starts in. The *network mode* is a capsule's egress setting: Open, or Dedicated proxy with an allowlist. *Plain start* means launching without the ARM64 capsule projection. *--arm64 start* means the host projects `MV_ARM64_CAPSULES=1` and related variables (`docs/ARM64_CAPSULE_SETUP.md:136`).

### Modes: why it exists and why built this way
Answers: why does a capsule have a human or agent mode; why is the opening mode a file; why is network mode per capsule; why are settings a closed four-key object

The mode decides who may drive a capsule. The opening mode reaches the daemon adapter as a one-shot file, `<state>/opening-modes/<profile>.json`, with schema `metaviewer.opening_mode/v0.3`. It is created exclusively with mode 0600 and removed by the returned cleanup (`ui/electron/openingMode.js:8`, `:41`). This keeps the request out of the frozen surface contracts (comment at `ui/electron/openingMode.js:2`). Network mode is set per capsule and applies on the next start (`ui/src/netmode/NetworkPanel.vue:46`). Settings are one closed definition shared by every load and save path, so host error text never reaches the screen (`ui/src/settings/settingsModel.js:88`, `:722`).

### Modes: parts
Answers: which files implement modes; where is the network panel; where are settings stored; where is the handoff notice

| file | role |
|---|---|
| `ui/electron/openingMode.js` | Stages the opening-mode file (human/agent, optional host binary, host window, host_xpra) |
| `ui/electron/roleHost.js` | `switchMode` (op `switch`) and the create paths that call `stageOpeningMode` |
| `ui/electron/programBinaries.js` | Remembers each program's binary and Host-program flag, so a reopen or switch can restart it |
| `ui/src/netmode/NetworkPanel.vue` | Per-capsule Network dialog (Open / Dedicated proxy with allowlist) |
| `ui/src/netmode/networkCopy.js` | Refusal text, legacy explanation, hostname rules |
| `ui/src/settings/settingsModel.js` | Closed settings definition, decode/encode, store, debouncer, fps meter |
| `ui/src/settings/settingsHost.js` | Adapter from preload `loadSettings`/`saveSettings` to the store, with fallback only when a method is absent |
| `ui/src/settings/MvSettingsPanel.vue` | Settings page (scheme, density, wall fps, recording fps, capture folders, hidden live sessions) |
| `ui/src/settings/settings.css` | Panel styles, kit tokens only |
| `ui/src/handoff/handoffModel.js` | Handoff rows: a capsule step that stopped for the operator (login wall or bot check) |
| `ui/src/handoff/HandoffNotice.vue` | Notice with Take control and Acknowledge |
| `ui/src/handoff/handoff.css` | Handoff styles |

### Modes: how plain start vs --arm64 decides which capsule kinds are offered
Answers: why does --arm64 show only VM and MicroVM; why does plain start show browsers and programs; where is MV_ARM64_CAPSULES read; how are ARM64 capabilities computed

Observed behavior: plain start offers browsers, Host program and Program, and --arm64 offers VM and MicroVM only [MEASURED]. Here is what the code on this commit shows:

- The catalog keeps the non-ARM kinds always. It adds `vm`/`microvm` only when the capabilities say `supported_host === true` and the kind is `available === true` (`ui/src/catalog/catalogModel.js:149`).
- Capabilities come from `arm64CapsuleStatusSync` (`ui/electron/guestCommandProfile.js:47`). On a non-arm64 host, `supported_host` is false and both kinds are disabled. On arm64 they stay disabled until `MV_ARM64_CAPSULE_STATUS` carries a valid `{vm, microvm}` status. `capsuleCapabilities` then narrows that against live state (`ui/electron/authorityWire.js:883`), for example "Close and confirm existing graphical capsules before creating a MicroVM."
- With `MV_ARM64_CAPSULES=1`, main.js skips the automatic initial browser surface that a plain start creates (`ui/electron/main.js:2568`). A VM create without an available VM is refused with `VM_UNAVAILABLE` (`ui/electron/authorityWire.js:732`).
- How browser and Program kinds are removed in --arm64 mode: ABSENT — do not invent. In this scope the launcher does not filter them out. The `kinds` prop defaults to every id, and App.vue does not pass it (`ui/src/App.vue:2019`).

### Modes: how a Host program switch between human and agent restarts it
Answers: why does switching a Host program restart it; what does Switch mode do to a browser capsule; which IPC op changes mode; what if the mode change is not confirmed

Switching a Host program between human and agent restarts it [MEASURED]. Code path:

1. `confirmModeSwitch` calls `metaviewerRoles.switchMode(surfaceId)` (`ui/src/App.vue:832`). That is op `switch` on `metaviewer:roles.v0.3` (`ui/electron/rolePreload.cjs:18`).
2. `switchMode` (`ui/electron/roleHost.js:1000`) flips the role. For a Host program (`program?.hostXpra`, `ui/electron/roleHost.js:1009`), it marks the profile `stopping`, calls `stop(surfaceId)`, marks it `starting` and calls `createProgram({binary:program.path, role, hostXpra:true}, true, profileId)`. That is a new process with a new opening-mode file. The code comment says Host-Xpra programs "have a separate external-process lifecycle".
3. Other capsules call `core.switchRole` and keep the native process, identity, tabs and cookies (`ui/electron/roleHost.js:1018`). If the reply or the live surface does not confirm the new role, the result is `CAPSULE_MODE_UNPROVEN` (`ui/electron/roleHost.js:1030`).
4. Back in App.vue, if the reply is not `reused` on the same surface, the old tile is treated as stopped (`ui/src/App.vue:832`).

### Modes: data flow
Answers: what IPC carries network mode; where do settings go; how does a handoff reach the wall; how are opening modes passed to the daemon

- Opening mode: roleHost calls `stageMode(stateDir, profileId, role, binary, hostXpra)` (`ui/electron/roleHost.js:884`). The adapter reads `opening-modes/<profile>.json`, and roleHost then removes it with the returned cleanup.
- Network mode: `NetworkPanel` calls `host.egress.get({identity})` and `host.egress.set({identity, record:{schema:'metaviewer.capsule_egress/v1', mode, domains}, confirm?})` (`ui/src/netmode/NetworkPanel.vue:12`). Both are operator methods that preload checks (`ui/electron/preload.js:162`). SurfacePanel mounts the panel per capsule (`ui/src/wall/SurfacePanel.vue:708`).
- Settings: `ui/src/main.js:322` builds `createSettingsHost(host, preferences, fixture)`. The panel loads once and saves the full four keys through preload `saveSettings` (`ui/src/settings/MvSettingsPanel.vue:197`, `:389`). Boot shares the same decode through `createSettingsHost.decodeStoredSettings` (`ui/src/main.js:138`).
- Handoff: preload forwards `metaviewer:handoff.state` (`ui/electron/preload.js:240`) to `HandoffNotice`. The notice emits `activity` (code `CAPTCHA_HANDOFF`), `pending` and `take-control`. App.vue's `takeHandoffControl` reveals the tile and applies `take_control` (`ui/src/App.vue:311`).

### Modes: invariants
Answers: what values can settings take; can an agent clear a handoff; what modes are valid; how many allowlist hosts

- Opening mode is only `human` or `agent`, for a profile id matching `^[a-z0-9][a-z0-9-]{0,63}$`. A host-window target is allowed only in agent mode (`ui/electron/openingMode.js:8`).
- VM capsules and attached desktop windows cannot switch mode (`CAPSULE_ROLE_INVALID`, `ui/electron/roleHost.js:1000`).
- Settings keys are exactly scheme, density, wallFps and recordingFps (`ui/src/settings/settingsModel.js:88`). Wall fps is one of 3, 30 or 60 [CITED: ui/src/settings/settingsModel.js:56]. Recording fps is an integer from 1 to 60. Defaults are mv-dark, compact, 30 [CITED: ui/src/settings/settingsModel.js:62] and 3 [CITED: ui/src/settings/settingsModel.js:81].
- Saves are debounced over 150 ms [CITED: ui/src/settings/settingsModel.js:96]. The actual-fps readout uses a 2000 ms window [CITED: ui/src/settings/settingsModel.js:102].
- The allowlist holds 1 to 256 exact hostnames [CITED: ui/src/netmode/networkCopy.js:105]. Local names are refused. The preload rules stay authoritative.
- A handoff row stays until a successful operator acknowledge. A failed or empty list never dismisses it (`ui/src/handoff/handoffModel.js:31`). Acknowledge does not resume the run (`ui/src/handoff/handoffModel.js:11`).

### Modes: failure modes
Answers: why did my settings reset; why can I not save network mode; why is the handoff notice stuck; why did Switch mode fail

| symptom the user sees | cause | coordinate | fix or workaround |
|---|---|---|---|
| Settings back at defaults, no message | Stored text had an unknown key or a float fps such as 30.0 | `ui/src/settings/settingsModel.js:411` | Save once from the panel to rewrite the file |
| "Settings could not be saved on the host" | Host save did not acknowledge `true` | `ui/src/settings/settingsModel.js:606` | Check the host settings store |
| "Color scheme could not be applied" | Kit refused the scheme after the save | `ui/src/settings/MvSettingsPanel.vue:389` | Reload the host; the panel rolls the scheme back |
| "Recording folders are unavailable on this host." | No `metaviewerCapturePreferences` | `ui/src/settings/MvSettingsPanel.vue:641` | Expected without the capture host |
| "Network configuration unavailable: this capsule has no admitted profile identity." | Capsule has no profile identity | `ui/src/netmode/NetworkPanel.vue:17` | Use an identity capsule |
| NET_OPEN_PREREQ text plus "Confirm save for next start anyway" | Binary or image lacks Open mode | `ui/src/netmode/NetworkPanel.vue:29` | Confirm to record the choice for a future start |
| Capsule start refused NET_PROXIED_UNSUPPORTED | Stored allowlist, but the binary cannot enforce it | `ui/src/netmode/networkCopy.js:54` | Choose Open and save |
| "Handoff notifications unavailable." | Subscribe or first load failed | `ui/src/handoff/HandoffNotice.vue:18` | Restart the app (inference) |
| "Acknowledgement could not be saved. The notice stays visible." | Host ack not ok | `ui/src/handoff/HandoffNotice.vue:14` | Retry Acknowledge |
| Host program tile restarts on Switch mode | By design: stop then create with the new role | `ui/electron/roleHost.js:1009` | None; unsaved state in that program is lost (inference) |
| "The capsule is still open; use Take control / Release instead." | Runtime has no `switchRole` | `ui/electron/roleHost.js:1018` | Use Take control / Release |

### Modes: refusals
Answers: what is CAPSULE_MODE_UNPROVEN; what is NET_EGRESS_IO; what is ERR_SETTINGS_UNKNOWN_KEY; what is HANDOFF_UNAVAILABLE

| code or text | raised at | meaning |
|---|---|---|
| `CAPSULE_MODE_INVALID` | `ui/electron/openingMode.js:8` | Bad profile id, mode or target |
| `CAPSULE_MODE_DIRECTORY` | `ui/electron/openingMode.js:39` | opening-modes directory is not a user-owned real 0700 directory |
| `IDENTITY_PROTECTED` | `ui/electron/openingMode.js:35` | Foreign identity |
| `CAPSULE_ROLE_INVALID` | `ui/electron/roleHost.js:1000` | Switch requested for a VM or desktop window |
| `SURFACE_CREATE_BUSY` | `ui/electron/roleHost.js:1000` | Another create or switch is running |
| `CAPSULE_MODE_UNAVAILABLE` | `ui/electron/roleHost.js:1018` | Runtime cannot keep the capsule while switching |
| `CAPSULE_MODE_UNPROVEN` | `ui/electron/roleHost.js:1030` | Switch not confirmed by the reply or the live surface |
| `XPRA_SENDER_REFUSED` / `XPRA_PAYLOAD_REFUSED` | `ui/electron/roleHost.js:1062`, `:1067` | Wrong sender or schema / wrong key set on `metaviewer:roles.v0.3` |
| `NET_PROXIED_UNSUPPORTED`, `NET_OPEN_PREREQ`, `NET_EGRESS_IO`, `NET_EGRESS_INVALID` | text at `ui/src/netmode/networkCopy.js:62` | Adapter egress refusals |
| `ERR_SETTINGS_MALFORMED`, `_UNKNOWN_KEY`, `_UNKNOWN_SCHEME`, `_UNKNOWN_DENSITY`, `_UNKNOWN_WALL_FPS`, `_UNKNOWN_RECORDING_FPS` | `ui/src/settings/settingsModel.js:411` | Stored settings unreadable; defaults in use |
| `ERR_SETTINGS_HOST`, `ERR_SETTINGS_SAVE_FAILED`, `ERR_SETTINGS_APPLY_FAILED` | `ui/src/settings/settingsModel.js:565`, `:606`, `:722` | Host missing, save refused, scheme apply failed |
| `HANDOFF_UNAVAILABLE` | `ui/src/handoff/handoffModel.js:46` | Handoff list or ack not ok |

### Modes: where to change what
Answers: where do I change the switch behavior; where are network messages; where do I add a setting; where are handoff steps

| change | file |
|---|---|
| Opening-mode payload or checks | `ui/electron/openingMode.js:8` |
| Switch behavior (restart vs keep the process) | `ui/electron/roleHost.js:1000` |
| Network refusal wording, hostname rules | `ui/src/netmode/networkCopy.js:62`, `:85` |
| Network dialog flow | `ui/src/netmode/NetworkPanel.vue:12` |
| New setting key (needs both decoders and the host side) | `ui/src/settings/settingsModel.js:88` |
| Settings page layout | `ui/src/settings/MvSettingsPanel.vue` |
| Handoff steps and wording | `ui/src/handoff/handoffModel.js:11` |

### Modes: how to test it
Answers: which tests cover mode switch; how do I test settings; is there a network panel test; is there a handoff test

These files exist under `ui/test/`: `mode-switch-live-surface.test.js`, `v026-host-polish.test.js` (mentions `hostXpra`), `v024-program-human.test.js`, `netcopy-panel.test.js`, `mvui-settings-model.test.js`, `mvui-settings-panel.test.js`, `mvui33-settings-store.test.js`, `mvui35-settings-parity.test.js`, `mvui29s-settings-debounce.test.js`, `handoff-notice.test.js` and `arm64-capsule-composition.test.js`. Run everything with `npm --prefix ui test`. A single file runs with `cd ui && node --test test/mode-switch-live-surface.test.js` (inference: the script adds no per-file filter).

### Modes: tradeoffs and rejected options
Answers: why does load refuse the whole settings file; why save before applying the scheme; why does Host program switching restart; why is Acknowledge not resume

- Settings load used to ignore unknown keys. Since mvui35 it refuses the whole payload, so the store and boot fall back to full defaults the same way the host does (`ui/src/settings/settingsModel.js:14`).
- The panel saves first and applies the scheme live afterwards. If applying fails it rolls the scheme back and keeps the apply refusal (`ui/src/settings/MvSettingsPanel.vue:389`).
- Host programs restart on switch because they have a separate external-process lifecycle. Native identity capsules transfer in place (comment at `ui/electron/roleHost.js:1007`).
- Handoff has no resume ABI. Re-running the workflow is the operator's action (`ui/src/handoff/handoffModel.js:27`).
- The settings fallback to kit preference storage applies only when a preload method is absent. A host rejection never triggers it (`ui/src/settings/settingsHost.js:30`).

## Terminals (deck, side terminal, paired terminals, PTY broker)

Answers: what is terminals in MetaViewer; how does terminals work; where is the terminals code; what breaks in terminals

Terms used here. A **PTY** is a pseudo-terminal: the kernel device a shell or CLI reads keystrokes from and writes output to. The **broker** is the PTY engine (`runBroker` in `ui/electron/ptyBroker.js`) that owns every PTY handle. A **session port** is a MessagePort pair: the main process keeps one end, the renderer gets the other, and input, output, acks and exit all travel over it. **Credit** (also called ack) is the renderer confirming how many output bytes it consumed, so the broker knows when to pause the PTY. A **paired terminal** is a deck slot tied to one capsule id (or MicroVM workload id). Paired terminals are Host programs: they run on the host, not inside the capsule.

### Terminals: why it exists and why built this way
Answers: why does MetaViewer have its own terminal broker; why can't the renderer spawn a shell; why is there a session port; why are there so many limits on terminals

The deck gives the operator host shells and agent CLIs next to the wall. The renderer is never trusted to choose what runs: it sends only a profile reference (`shell` or an owned provider id), and the main process resolves executable, argv, cwd and env from host-owned profiles (`ui/electron/terminalHost.js:268`, `ui/electron/agentProviders.js:32`). The broker module says so directly: "renderer and child never exchange executable paths, argv, cwd or env, only provider references" (`ui/electron/ptyBroker.js:19`). Every byte stream is bounded: per-write size, per-session total output, unacked output, lifetime and rate. These bounds keep a runaway program or a hostile page from flooding the renderer or main process. The price is that a session that hits a bound is ended, not slowed down. See Failure modes.

### Terminals: parts
Answers: which files make up the terminal; what does terminalHost do; where is the deck controller; what is ptySession for

| file | role |
|---|---|
| `ui/electron/ptyBroker.js` | Broker engine `runBroker`, wire framer, IPC bridge `registerTerminalIpc`, renderer facade `createTerminalFacade`, all caps and refusal codes |
| `ui/electron/terminalHost.js` | Main-process host: runs `runBroker` in-process, owns sessions, hands out session ports, rate-limits input and resize, binds the sender, reaps process trees; created by `ui/electron/hostBindings.js:214` |
| `ui/electron/ptySession.js` | Separate direct-spawn seam for a utility process (one PTY per byte port) |
| `ui/electron/ptyUtility.js` | Utility-process entry that loads node-pty and runs one `createPtySession` |
| `ui/electron/agentProviders.js` | Discovers installed agent CLIs (`agent-codex`, `agent-gemini`, `agent-opencode`, `agent-muse`) and builds host-owned profiles |
| `ui/src/terminal/terminalClient.js` | Renderer end of a session port: input sequencing, output checks, acks |
| `ui/src/terminal/sideTerminalFacade.js` | Adapters: single-port facade, empty-state facade, broker opt-in facade, session transport, multi-session port facade used by the deck |
| `ui/src/terminal/terminalDeckModel.js` | Deck controller: screens, slots, launch, restart, close, paste, copy, acks, refusal hints, agent prompt gate |
| `ui/src/terminal/TerminalDeckView.vue` | Deck UI: xterm tiles, workflow buttons, paired-terminal chrome |
| `ui/src/terminal/pairedTerminals.js` | One retained slot per capsule id, serialized opens |
| `ui/src/terminal/TerminalView.vue` | Single xterm view over an injected port |
| `ui/src/terminal/SideTerminalOverlay.vue` | Right-side overlay on the kit SideTerminalPanel |
| `ui/src/terminal/BrokerLaunchControls.vue` | "Enable terminal access" opt-in and provider launch buttons |
| `ui/src/terminal/providers.js` | Provider entry validation and reference-only launch menu |

(inference) `launchTerminalUtility` (`ui/electron/terminalHost.js:9`) has no importer under `ui/electron` on this commit, so the live input path is terminalHost plus the in-process broker, not ptySession/ptyUtility.

### Terminals: data flow
Answers: how does a keystroke reach the shell; how does output get to xterm; what IPC channels does the terminal use; where are acks sent

Keystroke path (deck):
1. xterm `onData` gives one string per keystroke or paste (`ui/src/terminal/TerminalDeckView.vue:493`).
2. `controller.writeSessionBytes` encodes it to UTF-8 bytes, with no batching or chunking (`ui/src/terminal/terminalDeckModel.js:1039`).
3. `createPortSessionFacade.write` calls `client.input(bytes)` (`ui/src/terminal/sideTerminalFacade.js:648`).
4. `terminalClient.input` posts `{session, seq: ++inputSeq, bytes}` if bytes ≤ 65536 [CITED: ui/src/terminal/terminalClient.js:41]; larger input is dropped silently.
5. terminalHost's port handler checks shape, size ≤ 65536 [CITED: ui/electron/terminalHost.js:618] and `seq === inputSeq + 1` [CITED: ui/electron/terminalHost.js:616], then the rate buckets [CITED: ui/electron/terminalHost.js:625], then sends `{op:'write', b64}` into the broker (`ui/electron/terminalHost.js:633`).
6. The broker's `handleWrite` re-checks base64 and the 65536-byte [CITED: ui/electron/ptyBroker.js:104] cap, decodes with a fatal UTF-8 decoder and calls `pty.write` (`ui/electron/ptyBroker.js:1762`).

Output path: node-pty `onData` goes to broker `onPtyData` (byte cap, pending caps, pause at the high-water mark), which emits `{ev:'data', seq, b64}` (`ui/electron/ptyBroker.js:1490`). terminalHost turns it into a port frame `{session, seq, bytes}` (`ui/electron/terminalHost.js:434`). terminalClient checks it and hands it to the facade; the deck acks immediately with a cumulative byte count (`ui/src/terminal/terminalDeckModel.js:943`), and the view writes the decoded text into xterm (`ui/src/terminal/TerminalDeckView.vue:204`).

Exit path: broker `closeSession` emits `{ev:'exit', id, code, reason?}` (`ui/electron/ptyBroker.js:1472`). terminalHost forwards only `{session, exitCode}` (`ui/electron/terminalHost.js:436`). terminalClient sets status `Exited (<code>)` (`ui/src/terminal/terminalClient.js:18`), the facade emits an exit, and the deck marks the slot `exited` (`ui/src/terminal/terminalDeckModel.js:910`).

IPC: the broker bridge binds `metaviewer:terminal.open`, `.attach`, `.close`, `.write`, `.resize`, `.ack`, `.capabilities` (`ui/electron/ptyBroker.js:78`). The deck transport uses the host methods `attach`, `resize`, `close`, `listProviders`, `copyText` (`ui/src/terminal/sideTerminalFacade.js:281`), and all byte IO goes over the attached port.

### Terminals: invariants
Answers: what must hold for a terminal session; why is my input refused; what sequence rules apply; who may write to a session

- The renderer never supplies exe, cwd, env, argv, path or channel; the bridge refuses such values (`ui/electron/ptyBroker.js:139`).
- One write is at most 65536 bytes [CITED: ui/electron/ptyBroker.js:104], at every layer (client, host, broker).
- Input frames are strictly sequenced: the host admits only `seq === inputSeq + 1` (`ui/electron/terminalHost.js:620`).
- Each write must be complete UTF-8: the broker decoder is `fatal: true` without streaming (`ui/electron/ptyBroker.js:1322`).
- Acks must advance and match an exact recorded byte boundary (`ui/electron/ptyBroker.js:1866`).
- A session is bound to the sender that opened it (`ui/electron/terminalHost.js:462`).
- Credential-shaped env names and loader variables never reach a child (`ui/electron/ptyBroker.js:150`, `ui/electron/ptyBroker.js:180`).
- One pair per capsule id; pair opens are serialized (`ui/src/terminal/pairedTerminals.js:38`).
- A missing agent CLI is omitted, never replaced by a shell (`ui/electron/agentProviders.js:68`).

### Terminals: failure modes
Answers: why did my terminal exit; why does the tile say exited; why was my paste lost; paired terminal exited after a long line; what does Exited (-1) mean

The tile shows only the word `exited` and a Restart button (`ui/src/terminal/TerminalDeckView.vue:1308`); the reason is not displayed. terminalHost also drops the broker's exit reason (`ui/electron/terminalHost.js:436`), so `SESSION_CAP` and `SESSION_EXPIRED` look like a normal exit.

| symptom the user sees | cause | coordinate | fix or workaround |
|---|---|---|---|
| Tile turns `exited` while typing fast or while a program sends keys quickly | (inference) The host input buckets (64 writes burst and 64/s [CITED: ui/electron/terminalHost.js:107]) refuse one frame as retryable. A frame already in flight then has seq one too high, fails the admission check and is treated as fatal: non-retryable `TERMINAL_IO_REFUSED`, session closed | `ui/electron/terminalHost.js:616`, `ui/electron/terminalHost.js:639`, `ui/src/terminal/terminalClient.js:17` | Restart the slot. Code fix: make an out-of-sequence frame after a retryable refusal also retryable, or resend from `expectedSeq` in the client |
| Tile turns `exited` after long work in a shell pair, often with a full-screen CLI | Total output reached the shell-class cap of 8388608 bytes [CITED: ui/electron/ptyBroker.js:105]; the broker closes with reason `SESSION_CAP`. (inference) An agent TUI that repaints its whole input box per keystroke produces output that grows with line length | `ui/electron/ptyBroker.js:1497` | Launch the agent as its own profile (ai class, 67108864 bytes [CITED: ui/electron/ptyBroker.js:106]) instead of typing it into a shell pair |
| Tile turns `exited` after about an hour, whatever you were doing | Lifetime cap: shell class 3600000 ms [CITED: ui/electron/ptyBroker.js:111], ai class 14400000 ms [CITED: ui/electron/ptyBroker.js:112]; reason `SESSION_EXPIRED` | `ui/electron/ptyBroker.js:1481` | Restart; no setting in the UI |
| `exited` during a heavy output burst | Unacked output above 524288 bytes [CITED: ui/electron/ptyBroker.js:128] or 4096 frames [CITED: ui/electron/ptyBroker.js:129]; exit code -1 [CITED: ui/electron/ptyBroker.js:1508] | `ui/electron/ptyBroker.js:1507` | Restart; reduce output volume |
| `exited` right after a write was refused | Any broker error on a live session (`WRITE_TOO_LARGE`, `INVALID_INPUT`, `WRITE_FAILED`, `ACK_REFUSED`) becomes a non-retryable `TERMINAL_IO_REFUSED` frame; the deck then closes the session | `ui/electron/terminalHost.js:429`, `ui/src/terminal/terminalDeckModel.js:934` | Restart |
| Large paste does nothing, but no error is shown | `terminalClient.input` drops input over 65536 bytes [CITED: ui/src/terminal/terminalClient.js:41] silently; paste still reports success | `ui/src/terminal/terminalClient.js:41`, `ui/src/terminal/terminalDeckModel.js:1882` | Paste in smaller pieces |
| Session closes right after opening | Pre-attach queue over 64 frames [CITED: ui/electron/terminalHost.js:101] or 65536 bytes [CITED: ui/electron/terminalHost.js:102], or no attach within 10000 ms [CITED: ui/electron/terminalHost.js:100] | `ui/electron/terminalHost.js:335` | Retry open |
| Side terminal shows "Session ended unexpectedly." | Designed outcome text; host codes stay in data attributes | `ui/src/terminal/sideTerminalFacade.js:181` | Read `data-terminal-state` / outcome code |
| Garbled characters at frame borders | (inference) Output is decoded per frame without stream mode | `ui/src/terminal/TerminalDeckView.vue:206` | None in UI |

Open bug "paired terminal exited after a very long typed line, cause unknown": the cause is not established. The code shows these candidate paths, all (inference): (a) a retryable input refusal followed by an in-flight frame, which is fatal at `ui/electron/terminalHost.js:639`; (b) the shell-class output cap `SESSION_CAP` at `ui/electron/ptyBroker.js:1497`, if the pair ran a repainting CLI inside the default `shell` profile (`ui/src/terminal/pairedTerminals.js:28`); (c) the lifetime cap `SESSION_EXPIRED` at `ui/electron/ptyBroker.js:1483`; (d) the pending-output cap at `ui/electron/ptyBroker.js:1507`. A single typed keystroke never exceeds the 65536-byte [CITED: ui/electron/ptyBroker.js:104] write cap, so the size refusals are unlikely for typing (inference). The kernel line-discipline limit is outside this code: ABSENT — do not invent. Telling these apart needs the exit code and reason, which the UI does not keep.

### Terminals: refusals
Answers: what does TERMINAL_IO_REFUSED mean; what codes can terminal open return; what does WRITE_TOO_LARGE mean; where is SESSION_LIMIT raised

| code or text | raised at | meaning |
|---|---|---|
| `TERMINAL_IO_REFUSED` (retryable, with `expectedSeq`) | `ui/electron/terminalHost.js:595` | Input or resize not admitted now (rate or disabled); client rewinds seq |
| `TERMINAL_IO_REFUSED` (fatal) | `ui/electron/terminalHost.js:643` | Malformed or out-of-sequence port frame; session closed |
| `TERMINAL_IO_REFUSED: SENDER` | `ui/electron/terminalHost.js:464` | Caller is not the sender that opened the session |
| `TERMINAL_IO_REFUSED: RATE_LIMITED` | `ui/electron/terminalHost.js:673` | IPC resize over 16 burst / 16 per s [CITED: ui/electron/terminalHost.js:103] |
| `TERMINAL_DISABLED`, `PAYLOAD`, `COMMAND_NOT_ALLOWED` | `ui/electron/terminalHost.js:508`, `ui/electron/terminalHost.js:489`, `ui/electron/terminalHost.js:499` | Open before opt-in, bad request shape, unowned profile |
| `TERMINAL_UNAVAILABLE` | `ui/electron/terminalHost.js:512` | node-pty not bundled or not loadable |
| `TERMINAL_UNKNOWN_SESSION` | `ui/electron/terminalHost.js:460` | Session id not live on the host |
| `DISPLAY_ONLY` | `ui/electron/terminalHost.js:167` | Nested display window has no terminal |
| `ERR_CLIPBOARD_INVALID` | `ui/electron/terminalHost.js:713` | copyText text is not capsule-id shaped |
| `SESSION_LIMIT`, `CLASS_LIMIT`, `SPAWN_BRAKE`, `DIMS_RANGE`, `UNKNOWN_PROVIDER`, `COMMAND_MISMATCH`, `SPAWN_FAILED`, `PTY_SHAPE`, `RECORD_FAILED` | `ui/electron/ptyBroker.js:1558` | Broker open admission refusals |
| `WRITE_SHAPE`, `WRITE_TOO_LARGE`, `INVALID_INPUT`, `WRITE_FAILED` | `ui/electron/ptyBroker.js:1779`, `ui/electron/ptyBroker.js:1783`, `ui/electron/ptyBroker.js:1791`, `ui/electron/ptyBroker.js:1797` | Broker write refusals |
| `ACK_SHAPE`, `ACK_REFUSED` | `ui/electron/ptyBroker.js:1861`, `ui/electron/ptyBroker.js:1871` | Bad credit |
| `SESSION_CAP`, `SESSION_EXPIRED` (exit reasons) | `ui/electron/ptyBroker.js:1500`, `ui/electron/ptyBroker.js:1483` | Output cap or lifetime reached |
| `INPUT_DISABLED`, `NO_OWNER`, `DISPOSED` | `ui/electron/ptyBroker.js:2790` | Renderer facade gate |
| `INVALID_SPAWN_SPEC`, `INVALID_INPUT`, `INVALID_ACK`, `INVALID_MESSAGE`, `OUTPUT_OVERFLOW` | `ui/electron/ptySession.js:14`, `ui/electron/ptySession.js:52`, `ui/electron/ptySession.js:56`, `ui/electron/ptySession.js:65`, `ui/electron/ptySession.js:39` | Utility-process seam |
| `Terminal stream refused`, `Terminal binding refused` | `ui/src/terminal/terminalClient.js:22`, `ui/src/terminal/terminalClient.js:14` | Bad output frame or foreign session |
| `TERMINAL_CREDIT_REFUSED` | `ui/src/terminal/sideTerminalFacade.js:661` | Ack does not match pending credit |
| `PAIRED_CAPSULE_INVALID` | `ui/src/terminal/pairedTerminals.js:19` | Pair target is not a capsule or MicroVM |
| `SESSION_LIMIT: All terminal screens are full. Close a terminal before opening another.` | `ui/src/terminal/terminalDeckModel.js:1207` | Deck has no free slot |
| `AGENT_HOST_ENV_UNAVAILABLE`, `AGENT_HOST_PATH_UNAVAILABLE`, `AGENT_NAMESPACE_UNAVAILABLE` | `ui/electron/agentProviders.js:22`, `ui/electron/agentProviders.js:25`, `ui/electron/agentProviders.js:55` | Agent profile omitted |

Open refusals are shown as `<CODE>: <hint>` from `TERMINAL_REFUSAL_HINTS` (`ui/src/terminal/terminalDeckModel.js:99`).

### Terminals: where to change what
Answers: where do I change terminal limits; where is the input path; how do I show the exit reason; where are agent CLIs defined

| change | place |
|---|---|
| Write size, output caps, lifetimes, pending caps | `ui/electron/ptyBroker.js:104` (constants), `ui/electron/ptyBroker.js:899` (`DEFAULT_LIMITS`) |
| Input and resize rate limits, attach deadline | `ui/electron/terminalHost.js:99` |
| Retryable vs fatal input handling | `ui/electron/terminalHost.js:589`, `ui/src/terminal/terminalClient.js:16` |
| Keep the exit reason on the port | `ui/electron/terminalHost.js:436` |
| Show exit reason in a tile | `ui/src/terminal/terminalDeckModel.js:910`, `ui/src/terminal/TerminalDeckView.vue:1308` |
| Chunk large paste | `ui/src/terminal/terminalDeckModel.js:1814`, `ui/src/terminal/terminalClient.js:40` |
| Agent CLI list and argv | `ui/electron/agentProviders.js:7` |
| Pair reuse rules | `ui/src/terminal/pairedTerminals.js:30` |

### Terminals: how to test it
Answers: which tests cover the terminal; how do I run terminal tests; is the retryable refusal tested

`ui/package.json` has one test script: `node --test` over `test/*.test.js`. Run the whole suite with `npm --prefix ui test`. (inference) A single file runs with the same runner: `node --test ui/test/<file>`.

Relevant files that exist: `ui/test/terminalClient.test.js`, `ui/test/mvui36-terminal-retryable.test.js` (retryable refusal keeps the client alive; malformed retryable frames stay fatal), `ui/test/terminal-host.test.js`, `ui/test/ptyBrokerClasses.test.js`, `ui/test/ptyBrokerGuards.test.js`, `ui/test/ptyIntegration.test.js`, `ui/test/t5-elec-pty-regression.test.js`, `ui/test/sideTerminalFacade.test.js`, `ui/test/p18hTerminalDeck.test.js`, `ui/test/paired-terminals.test.js`, `ui/test/paired-drawer.test.js`, `ui/test/providers.test.js`, `ui/test/mvui29-terminal-session.test.js`. The `.mjs` files `ui/test/terminalHarden.test.mjs`, `ui/test/mutTerminalHarden.test.mjs`, `ui/test/terminalFix3.test.mjs` and `ui/test/terminalHardenWire.test.mjs` are not matched by the script's glob. I did not find a test for an in-flight frame after a retryable refusal; that is a negative check, not proof none exists.

### Terminals: tradeoffs and rejected options
Answers: why are terminals killed instead of slowed; why no streaming decoder; why does the client not resend refused input

- Bounded failure over back-pressure: the broker ends a session at the byte cap, the pending cap and the lifetime (`ui/electron/ptyBroker.js:8` documents per-class caps and staged close SIGHUP → 100 ms [CITED: ui/electron/ptyBroker.js:113] → SIGTERM → 250 ms [CITED: ui/electron/ptyBroker.js:114] → SIGKILL).
- The file header says "Retryable port refusals preserve the next input sequence" (`ui/electron/terminalHost.js:2`), but refused bytes are not resent by the client (`ui/src/terminal/terminalClient.js:17`). (inference) Dropping the refused input was chosen over replay.
- The fatal, non-streaming UTF-8 decoder (`ui/electron/ptyBroker.js:1322`) rejects split characters instead of buffering them (inference on intent).
- The workflow prompt is pasted only into an attested agent CLI and never into a shell (`ui/src/terminal/terminalDeckModel.js:1706`).

## Direct task (workflow prompts to an agent CLI)

Answers: what is direct task in MetaViewer; how does direct task work; where is the direct task code; what breaks in direct task

Terms. A **workflow prompt** is a fixed instruction text the deck prepares for an agent CLI. **Direct task** is the workflow kind `no-automation`: a task done without a saved automation. An **identity line** is a one-line `CAPSULE=...  IDENTITY=...` or `MICROVM=...  GENERATION=...  OWNER=...` string that names the paired target.

### Direct task: why it exists and why built this way
Answers: what is Direct task; why does Direct task not press Enter; why is the prompt only copied sometimes

Direct task lets the operator hand a capsule to an agent CLI in a paired terminal without a saved automation. The prompt is fixed text plus the identity line; it points the agent at the docs/AGENT_ENTRY.md section "Direct task" and carries a guard: release human control before acting, and on rc 5 [CITED: ui/src/terminal/workflowPrompts.js:7] INPUT_UNCERTAIN, a login or a CAPTCHA, stop and never retry (`ui/src/terminal/workflowPrompts.js:7`). The deck pastes it only into a running agent profile that shows a known input prompt, and never sends Enter, so the human adds the task and submits it (`ui/src/terminal/terminalDeckModel.js:1751`). Without such a target it only copies the text to the clipboard (`ui/src/terminal/terminalDeckModel.js:1722`). Authentication and trust questions block the paste; the gate never answers them (`ui/src/terminal/agentPromptGate.js:1`).

### Direct task: parts
Answers: which files implement Direct task; where is the prompt text; where is the agent readiness check

| file | role |
|---|---|
| `ui/src/terminal/workflowPrompts.js` | Prompt kinds, prompt text, identity and MicroVM context validation |
| `ui/src/terminal/agentPromptGate.js` | Ready / authentication / waiting detection, 15000 ms timeout [CITED: ui/src/terminal/agentPromptGate.js:4] |
| `ui/src/terminal/terminalDeckModel.js` | `useWorkflowPrompt` (copy only), `prepareAgentPrompt` (gated paste) |
| `ui/src/terminal/TerminalDeckView.vue` | Workflow buttons and `chooseWorkflow`, agent chooser, `launchWorkflowAgent` |
| `ui/src/terminal/pairedTerminals.js` | Provides the pair's identity line and slot |
| `ui/electron/agentProviders.js` | Which agent CLIs can be launched |
| `ui/src/agent/agentLane.js`, `ui/src/agent/AgentLaneHost.vue` | `window.__agentLane` snapshot of anchored controls (`agent_lane/v1`) for an agent driving the UI; no host calls |

### Direct task: data flow
Answers: what happens when I click Direct task; how does the prompt reach the agent; what does the MicroVM Direct task prompt contain

1. The deck shows buttons `Create automation`, `Run automation`, `Direct task`; for a MicroVM pair only `Direct task` (`ui/src/terminal/TerminalDeckView.vue:275`).
2. `chooseWorkflow` (`ui/src/terminal/TerminalDeckView.vue:280`): with no matching pair it calls `useWorkflowPrompt`, which copies the text; with a running agent profile it calls `prepareAgentPrompt`; otherwise it shows "Replace this paired process with an agent CLI:" and `launchWorkflowAgent` relaunches the pair's slot with the chosen agent profile (`ui/src/terminal/TerminalDeckView.vue:298`).
3. `prepareAgentPrompt` (`ui/src/terminal/terminalDeckModel.js:1730`) builds and validates the text, then polls every 100 ms [CITED: ui/src/terminal/terminalDeckModel.js:1755] until the agent shows its ready prompt with 300 ms of quiet [CITED: ui/src/terminal/terminalDeckModel.js:1750], up to 15000 ms [CITED: ui/src/terminal/agentPromptGate.js:4].
4. The text goes out once as a bracketed paste `ESC[200~ … ESC[201~` through `writeSessionBytes`, the same input path as typing (see Terminals → Data flow).
5. For a MicroVM, `workflowPrompt(kind, context)` adds the `MICROVM=` identity, a `BINDING:` line and `export MV_TASK_BINDING='<json>'`, and a guard that the human alone owns Back (`ui/src/terminal/workflowPrompts.js:46`).

### Direct task: invariants
Answers: what makes a workflow prompt unsafe; what identity lines are accepted; what MicroVM context is required

- A prompt has fewer than 40 lines [CITED: ui/src/terminal/workflowPrompts.js:22], no control characters, and nothing secret-shaped (Bearer, `sk-` keys, token/password/api_key assignments, `data:image/`).
- An identity line is at most 4096 chars [CITED: ui/src/terminal/workflowPrompts.js:12], has no control or bidi characters, and matches the CAPSULE or MICROVM grammar.
- A MicroVM context has exactly seven [CITED: ui/src/terminal/workflowPrompts.js:31] keys, profile `guest-command-arm64-v1`, backend `firecracker`, isa `aarch64` (`ui/src/terminal/workflowPrompts.js:30`).
- The prompt is pasted only while the slot, session and profile are unchanged and the agent has not exited (`ui/src/terminal/terminalDeckModel.js:1746`).
- Authentication detection takes priority over ready detection (`ui/src/terminal/agentPromptGate.js:12`).

### Direct task: failure modes
Answers: why was nothing pasted; agent input prompt not observed; why does Direct task say MicroVM binding unavailable

| symptom the user sees | cause | coordinate | fix or workaround |
|---|---|---|---|
| Toast "Agent input prompt not observed within 15 seconds; nothing pasted." (15 s = AGENT_START_TIMEOUT_MS [CITED: ui/src/terminal/agentPromptGate.js:4]) | No known ready marker in the agent output in time | `ui/src/terminal/terminalDeckModel.js:1749` | Wait for the CLI to finish starting, choose the workflow again |
| Toast "Complete authentication or workspace trust yourself, then choose the workflow again. Nothing pasted." | Output matched a sign-in, API-key or trust question | `ui/src/terminal/terminalDeckModel.js:1748` | Complete login or trust by hand |
| Toast "Agent exited or changed; nothing pasted." | Slot, session or profile changed, or the agent exited | `ui/src/terminal/terminalDeckModel.js:1746` | Relaunch the agent |
| Toast "Agent terminal unavailable; nothing pasted." | No identity line, non-agent profile or no session | `ui/src/terminal/terminalDeckModel.js:1742` | Pair a capsule and launch an agent profile |
| Toast "Copied — paste into your agent CLI, not a shell." | No attested agent target, so copy only | `ui/src/terminal/terminalDeckModel.js:1722` | Paste into the agent CLI by hand |
| "MicroVM binding unavailable; nothing prepared." | MicroVM pair does not match the target or has no context | `ui/src/terminal/TerminalDeckView.vue:283` | Reopen the MicroVM pair |
| Agent missing from the chooser | CLI not installed, or env checks failed under MV_ARM64_CAPSULES=1 | `ui/electron/agentProviders.js:36` | Install the CLI on the host |
| Paired agent tile turns `exited` during a long prompt or task | Same session caps and input path as any terminal; see Terminals → Failure modes | `ui/electron/ptyBroker.js:1497` | Restart the slot |

### Direct task: refusals
Answers: what does WORKFLOW_PROMPT_UNSAFE mean; what workflow errors exist

| code or text | raised at | meaning |
|---|---|---|
| `WORKFLOW_PROMPT_UNSAFE` | `ui/src/terminal/workflowPrompts.js:24` | Prompt too long, has control chars or secret-shaped text |
| `WORKFLOW_IDENTITY_UNSAFE` | `ui/src/terminal/workflowPrompts.js:12` | Identity line malformed or unsafe |
| `WORKFLOW_MICROVM_CONTEXT` | `ui/src/terminal/workflowPrompts.js:37`, `ui/src/terminal/terminalDeckModel.js:1711` | MicroVM context invalid, or a MICROVM line used without context |
| `WORKFLOW_MICROVM_IDENTITY` | `ui/src/terminal/terminalDeckModel.js:1732` | Identity line does not match the MicroVM context |
| `WORKFLOW_MICROVM_KIND` | `ui/src/terminal/workflowPrompts.js:49` | MicroVM allows only Direct task |
| `WORKFLOW_PROMPT_KIND` | `ui/src/terminal/workflowPrompts.js:61` | Unknown workflow kind |
| `ERR_AGENT_LANE_MOUNTED`, `ERR_AGENT_LANE_NO_ROOT`, `ERR_AGENT_LANE_ANCHOR` | `ui/src/agent/agentLane.js:437`, `ui/src/agent/agentLane.js:348`, `ui/src/agent/agentLane.js:510` | Agent lane install or anchor gate |

### Direct task: where to change what
Answers: where do I edit the Direct task prompt; where do I add a new agent CLI; where is the ready prompt detected

| change | place |
|---|---|
| Prompt text and guards | `ui/src/terminal/workflowPrompts.js:4` |
| Ready / authentication patterns per CLI | `ui/src/terminal/agentPromptGate.js:10` |
| New agent CLI | `ui/electron/agentProviders.js:7` and `AGENT_PROFILE_IDS` at `ui/src/terminal/agentPromptGate.js:3` |
| Paste timing (timeout, quiet period) | `ui/src/terminal/terminalDeckModel.js:1743` |
| Workflow buttons | `ui/src/terminal/TerminalDeckView.vue:275` |

### Direct task: how to test it
Answers: which tests cover workflow prompts; how do I test the agent prompt gate

Run `npm --prefix ui test`. Relevant existing files: `ui/test/opfix3-workflow-prompts.test.js`, `ui/test/agent-prompts.test.js`, `ui/test/agent-prompts-other-clis.test.js`, `ui/test/microvm-agent-prompt.test.js`, `ui/test/microvm-agent-prompt-delivery.test.js`, `ui/test/microvm-agent-prompt-recipe.test.js`, `ui/test/microvm-agent-host-profile.test.js`, `ui/test/muse-agent-profile.test.js`, `ui/test/mvui-agent-snapshot.test.js`, `ui/test/mvui-agent-contract.test.js`.

### Direct task: tradeoffs and rejected options
Answers: why not send Enter automatically; why copy instead of paste into a shell

- No Enter: the paste leaves submission to the human (`ui/src/terminal/terminalDeckModel.js:1752`).
- Copy-only fallback: the comment says "Until the host attests an agent input target, copy only: a shell must never receive these executable examples." (`ui/src/terminal/terminalDeckModel.js:1707`).
- Observed output is not treated as proof of authentication (`ui/src/terminal/agentPromptGate.js:1`); the gate only blocks and never answers.

## Identities

Answers: what is identities in MetaViewer; how does identities work; where is the identities code; what breaks in identities

Terms used here. An **identity** is a named, saved browser profile, such as `work-account`. It holds sign-ins and the list of sites it may open. A **profile** is the storage that a capsule mounts for that identity. A **protected** identity belongs to another project or to the live launcher, or has the `mv-` prefix, and MetaViewer will not create or delete it. A **foreign** identity is a protected identity owned outside MetaViewer, and MetaViewer will not open, log in to, release or manage stored data for it either. A **stored data slot** is a named snapshot of a profile's saved data that can be saved, loaded, copied or deleted.

### Identities: why it exists and why built this way
Answers: why does the Identities dialog exist; why are identity rules checked in the renderer; why are some identities protected; what is a login marker for

The Identities subsystem lets the operator create, open and remove the browser profiles that capsules run on. It does not hand identity contents to the renderer. The renderer checks the same rules as the host before it sends anything. `ui/src/identities/identityForm.js:3` says the rules "mirror the closed host validation in electron/preload.js so a typo is explained before the request is sent instead of surfacing as a bare OPERATOR_PAYLOAD". The host still re-validates every call (`ui/electron/preload.js:205`). Protection is one shared module, `ui/electron/identityProtection.js:4`, imported by both renderer and main-process code, so the dialog and the host refuse the same names. The comment there says it must stay in sync with `tools/mv_identity.py` `protected_identity`. Login confirmation is stored as a separate operator-written marker (`ui/electron/identityMarkers.js:1`), not inside the opaque browser profile. Profile choice for later capsules is a pure, injected function (`ui/electron/profilePicker.js:5`) whose every refusal fails closed.

### Identities: parts
Answers: which files make up Identities; where is the profile picker; what does identityMarkers do; where is the protected list

| file | role |
|---|---|
| `ui/src/identities/IdentitiesDialog.vue` | Modal: list, add, delete, log in, release, stop a lost capsule, open as human or agent, select stored data |
| `ui/src/identities/StoredDataSlots.vue` | Per-profile stored-data slots: save, overwrite, load, copy, delete, through `capsule_state_request/v0.2` |
| `ui/src/identities/identityForm.js` | Pure validation (id, label, domains) and operator error text for host codes |
| `ui/electron/identityProtection.js` | `PROTECTED_HOLDERS`, `FOREIGN_PREFIXES`, `isForeignIdentity`, `isProtectedIdentity` |
| `ui/electron/identityMarkers.js` | Read and write `metaviewer.login_confirmation/v0.3` markers (one 0600 JSON per profile) |
| `ui/electron/profilePicker.js` | Pick a free browser profile for Add capsule; capsule limit and memory admission; refusal copy |

### Identities: data flow
Answers: how does an identity create reach the host; what IPC does the Identities dialog use; how does Last login get its value; how does Add capsule choose a profile

1. **Identity operations.** The dialog calls `props.host.identity.<method>`, with `operatorHost` as the default. The preload accepts only `identity.list`, `identity.show`, `identity.create`, `identity.delete` and `identity.login` (`ui/electron/preload.js:162`). After any successful mutation the dialog calls `list` again (`ui/src/identities/IdentitiesDialog.vue:60`).
2. **Capsule modes.** After listing, the dialog reads `globalThis.metaviewerRoles.choices()` and `programs()` to learn each identity's mode, `surfaceId`, `busy`, `held` and `lastLogin` (`ui/src/identities/IdentitiesDialog.vue:64`). The role host builds those rows and reads the login marker for each profile (`ui/electron/roleHost.js:653`).
3. **Open.** For a browser identity, the dialog emits `open-identity {profileId, role}` and App.vue handles it (`ui/src/App.vue:2018`). A Host program opens through `roleApi.open`, `props.openProgram` or `roleApi.createProgram` (`ui/src/identities/IdentitiesDialog.vue:102`). Host programs run on the host, not inside a capsule.
4. **Login marker.** The `confirm-login` op is allowed only on a human-controlled surface. It calls `markers.confirm(profile_id)` (`ui/electron/roleHost.js:1119`). The marker directory is `<userData or MV_SRF_STATE_DIR>/identity-markers` (`ui/electron/roleHost.js:440`).
5. **Stored data.** `StoredDataSlots.vue` sends `{schema:'capsule_state_request/v0.2', operation_id, op, profile_id, slot_id, credential_copy_confirmed:true[, destination_profile_id]}` (`ui/src/identities/StoredDataSlots.vue:26`) through `globalThis.metaviewer.slots.request`, which is the preload call `slotRequest` (`ui/electron/preload.js:1275`).
6. **Add capsule.** `authorityWire.js` calls `pickCreateRequest({env, surfaces, listIdentities, readFreeMemoryBytes})` (`ui/electron/authorityWire.js:957`). The picker returns a `surface_request/v0.2` create, or `refusalReply` builds `{ok:false, code, message, action}`.

### Identities: invariants
Answers: what identity names are allowed; which identities can never be deleted; when can stored data change; how many capsules can run; how much memory does a capsule need

- An id matches `^[a-z0-9][a-z0-9-]{1,39}$` and is not protected (`ui/src/identities/identityForm.js:61`). A label has at most 128 [CITED: ui/src/identities/identityForm.js:28] code points and no shell metacharacters. Allowed sites hold at most 16 [CITED: ui/src/identities/identityForm.js:22] hostnames, sorted and de-duplicated.
- Protected means a `mv-` prefix or foreign. Foreign means the prefixes `srf-id-cuentas-`, `srf-id-perplexity-`, `srf-pg-` or one of the fixed `PROTECTED_HOLDERS` (`ui/electron/identityProtection.js:4`).
- Delete is refused while the identity is open, meaning busy, holding a surface, or in human or agent mode. The check runs before and after the confirm dialog (`ui/src/identities/IdentitiesDialog.vue:36`).
- Stored data is blocked while the dialog is busy, while modes are unknown, or while the identity is open (`ui/src/identities/IdentitiesDialog.vue:195`; `ui/src/identities/StoredDataSlots.vue:13`).
- Late replies are dropped: each change of the `open` prop bumps `invocationGeneration` (`ui/src/identities/IdentitiesDialog.vue:166`).
- A marker must be a regular file owned by the current uid, mode 0600, at most 1024 [CITED: ui/electron/identityMarkers.js:21] bytes. Its directory must be mode 0700 and not a symlink (`ui/electron/identityMarkers.js:33`).
- At most 16 [CITED: ui/electron/profilePicker.js:46] capsules are live. Each create needs 6 GiB free [CITED: ui/electron/profilePicker.js:55]. Only one creation runs per host state map (`ui/electron/profilePicker.js:36`). A lost browser surface still keeps its profile bound (`ui/electron/profilePicker.js:204`).
- VM profiles are offered only on arm64 (`ui/electron/profilePicker.js:436`).

### Identities: failure modes
Answers: why does Identities say Capsule status is unavailable; why does Last login show IDENTITY_MARKER_REFUSED; why does identity creation fail with PROFILE_NOT_PROVISIONED; why can't I delete an identity; why does Add capsule say no identity

| symptom the user sees | cause | coordinate | fix or workaround |
|---|---|---|---|
| "Capsule status is unavailable. Previously known states are retained; refresh Identities before opening another capsule." | the role API `choices()` or `programs()` threw after the list | `ui/src/identities/IdentitiesDialog.vue:70` | Close and reopen Identities |
| Last login line shows `IDENTITY_MARKER_REFUSED` | marker has the wrong owner, mode, size or schema, or a bad name | `ui/electron/roleHost.js:653`, `ui/electron/identityMarkers.js:21` | Make the marker owned by the user with mode 0600, or remove it and confirm login again |
| "Docker profile provisioning failed: PROFILE_NOT_PROVISIONED. profiles/<id> must be private 0700 owned by uid 10001…" | the host could not provision the profile directory | `ui/src/identities/identityForm.js:79` | Check Docker access and the judge images; the "Identities" section in `docs/INSTALL.md#identities` covers provisioning. The anchor `#identity-store` named in the UI text has no matching heading on this commit |
| "The identity tool could not run: IDENTITY_UNAVAILABLE…" | tool environment missing | `ui/src/identities/identityForm.js:88` | Set MV_SRF_BIN_DIR, MV_SRF_STATE_DIR, SRF_IDENTITY_STORE_ROOT and MV_OPERATOR_REPO |
| "The identity tool could not run: AUSENTE — no reason supplied" | the host sent an empty code (the fallback text is not in English) | `ui/src/identities/identityForm.js:91` | Check the host logs |
| "This identity has an open capsule. Stop it first, then delete it." | the identity is bound to a capsule | `ui/src/identities/IdentitiesDialog.vue:36` | Stop the capsule, then delete |
| "Release could not be verified. A live session or missing ownership evidence still holds this identity." | release refused (IDENTITY_RELEASE_REFUSED) | `ui/src/identities/IdentitiesDialog.vue:147` | Stop the live session, then release |
| "Saved program binary unavailable. Open the program through Add capsule first." | no saved binary, or no role API | `ui/src/identities/IdentitiesDialog.vue:95` | Open the program through Add capsule |
| Stored data shows "<Saved x.> <refusal>" | the write completed but the refresh failed | `ui/src/identities/StoredDataSlots.vue:79` | Refresh slots; do not save again |
| Add capsule: "No free capsule profile has an identity yet…" plus a Create identity… button | no free profile has an identity | `ui/electron/profilePicker.js:331` | Create an identity whose id matches an MV_SRF_PROFILES key |
| Add capsule: "Not enough free host memory (… GiB available; one capsule needs 6 GiB…)" | MemAvailable is below the limit | `ui/electron/profilePicker.js:128` | Close capsules or other applications |

### Identities: refusals
Answers: what does IDENTITY_PROTECTED mean; list of identity error codes; stored data slot error codes; profile picker refusal codes

| code or text | raised at | meaning |
|---|---|---|
| `IDENTITY_PROTECTED` | `ui/src/identities/IdentitiesDialog.vue:49`, `ui/src/identities/identityForm.js:75` | Foreign or protected identity; "Managed outside MetaViewer" |
| `IDENTITY_BOUND` | `ui/src/identities/IdentitiesDialog.vue:36` | Identity has an open capsule |
| `IDENTITY_HOST_ABSENT` | `ui/src/identities/IdentitiesDialog.vue:54` | Host exposes no identity API |
| `PROGRAM_OPEN_FAILED` | `ui/src/identities/IdentitiesDialog.vue:104` | Host program open reply was not ok |
| `CAPSULE_STOP_UNPROVEN` | `ui/src/identities/IdentitiesDialog.vue:133` | Stop of a lost capsule was not confirmed |
| `IDENTITY_RELEASE_REFUSED` | `ui/src/identities/IdentitiesDialog.vue:147` | Release of a held identity was refused |
| `OPERATOR_PAYLOAD`, `IDENTITY_REFUSED`, `IDENTITY_UNAVAILABLE`, `PROFILE_NOT_PROVISIONED`, `PROFILE_MISSING` | text at `ui/src/identities/identityForm.js:75` | Host codes mapped to operator text |
| `SLOT_STORE_UNAVAILABLE`, `SLOT_LIST_MISSING` | `ui/src/identities/StoredDataSlots.vue:25`, `ui/src/identities/StoredDataSlots.vue:56` | No slots API; list reply had no slots |
| `SLOT_EXISTS` … `SLOT_QUARANTINED` (13 codes [CITED: ui/src/identities/StoredDataSlots.vue:32]) | `ui/src/identities/StoredDataSlots.vue:31` | Fixed text per slot reason_code; any other code shows "Stored data is unavailable (<code>). Refresh to retry." |
| `IDENTITY_MARKER_REFUSED` | `ui/electron/identityMarkers.js:21` | Marker name, file or directory failed its checks |
| `LOGIN_CONFIRMATION_REQUIRES_HUMAN` | `ui/electron/roleHost.js:1119` | Login confirmation on a non-human surface |
| `PICKER_INPUT_INVALID`, `CAPSULE_LIMIT_REACHED`, `RAM_ADMISSION_REFUSED`, `NO_FREE_PROFILE`, `IDENTITY_LIST_UNAVAILABLE`, `NO_IDENTITY` | `ui/electron/profilePicker.js:260` | Picker refusals, checked in this order |
| `SURFACE_CREATE_BUSY`, `SURFACE_CREATE_TIMEOUT`, `ADAPTER_SETUP`, etc. | `ui/electron/profilePicker.js:390` | Operator sentences for create-path codes |

### Identities: where to change what
Answers: where do I change identity validation; where is the protected identity list; where do I change the slot error text; where is the capsule limit set

| change | file |
|---|---|
| Id, label or domain rules (also change preload) | `ui/src/identities/identityForm.js:61`, `ui/electron/preload.js:205` |
| Identity error text | `ui/src/identities/identityForm.js:75` |
| Protected or foreign names (also change tools/mv_identity.py) | `ui/electron/identityProtection.js:4` |
| Stored-data refusal text | `ui/src/identities/StoredDataSlots.vue:31` |
| Login marker schema or permissions | `ui/electron/identityMarkers.js:21` |
| Capsule limit, memory limit, picker order | `ui/electron/profilePicker.js:46`, `ui/electron/profilePicker.js:260` |
| Add capsule refusal copy | `ui/electron/profilePicker.js:331`, `ui/electron/profilePicker.js:390` |

### Identities: how to test it
Answers: which tests cover Identities; how do I run the stored data slot tests; is there a profile picker test

Tests under `ui/test/`: `ident-dialog.test.js`, `ident-persist.test.js`, `p18d-identities.test.js`, `stored-data-slots.test.js`, `stored-data-header.test.js`, `multicap-profile-picker.test.js`, `program-existing-identity.test.js`, `v026-identity-cells-labels.test.js`, `mvui34-retained-identity.test.js`, and `p18-modes-tiles.test.js` (imports `identityMarkers`). The `ui/package.json` `test` script runs `node --test … test/*.test.js` over all of them, so `npm --prefix ui test` runs the whole suite. For one file, run `(cd ui && node --test test/stored-data-slots.test.js)` (inference: a direct node invocation, not a package script).

### Identities: tradeoffs and rejected options
Answers: why are rules duplicated in the renderer; why is the release holder rechecked; why does the picker refuse when the memory probe fails

- Rules are duplicated in renderer and preload so the user gets a clear message instead of a bare code (`ui/src/identities/identityForm.js:3`).
- Confirming a release is host-local. The holder is snapshotted and checked again by the tool, and is "never accepted as proof of dead-session custody" (`ui/src/identities/IdentitiesDialog.vue:139`).
- When the memory or identity probe fails, the picker refuses instead of guessing: "A failing identity list or memory probe is a typed refusal, never a silent fallback" (`ui/electron/profilePicker.js:284`).

## Recording

Answers: what is recording in MetaViewer; how does recording work; where is the recording code; what breaks in recording

Terms used here. A **capture store** is the renderer object that holds recording and screenshot state per capsule and talks to the host. **Sealed** means the host finished and closed a recording or screenshot, so it can be exported. The **export destination** is a host-configured directory, never chosen by the renderer. A **human trace** is a log of a human's clicks, moves, keys and scrolls on a human tile.

### Recording: why it exists and why built this way
Answers: why are recordings kept in RAM; why can't I export a recording; why does the timer keep moving between frames; what is the human trace for

The recording panel lets the operator record a capsule "for AI", take screenshots, and export sealed captures. Captures stay in RAM (`MV_RECORDING_STORE = 'ram'`, `ui/src/recording/recordingModel.js:33`). Disk is reached only through a destination that the host advertises (`ui/src/recording/recordingModel.js:135`). The host owns every sink, and the renderer module touches no disk, network or clipboard (`ui/src/recording/recordingModel.js:10`). Host capture events are sparse (the clock comment cites capture_p50 of 318-567 ms [CITED: ui/src/recording/recordingClock.js:7]), so the elapsed readout is interpolated locally from the last host value (`ui/src/recording/recordingClock.js:75`). Separately, `ui/electron/humanTrace.js` writes a continuous `metaviewer.human_trace/v0.3` log of human input on human tiles. It withholds every printable key.

### Recording: parts
Answers: which files make up Recording; where is the recording panel; where is the badge; where is the human trace writer

| file | role |
|---|---|
| `ui/src/recording/MvRecordingPanel.vue` | Panel: record toggle, screenshot, frame-rate field, recordings manifest, screenshots list, export |
| `ui/src/recording/recordingModel.js` | Phases, gates, refusal copy, DOM ids and anchors, store row mapping |
| `ui/src/recording/recordingClock.js` | Elapsed interpolation and jitter hold, `--:--` text, source-rate note |
| `ui/src/recording/useRecordingElapsed.js` | Vue composable that ticks only while recording |
| `ui/src/recording/recordingBadge.js` | Tile badge text |
| `ui/src/recording/RecordingBadge.vue` | Badge component meant to replace the TileCaptureChrome badge; on this commit only tests import it |
| `ui/src/recording/recording.css` | Panel styles (scoped) |
| `ui/electron/humanTrace.js` | Human input trace: file sink, memory buffer, retention pruning |

### Recording: data flow
Answers: how does Record for AI reach the host; how is export done; where is the human trace written; what does the panel emit without a store

- **With a capture store bound** (App.vue passes `:capture-state` and `:capture-available`, `ui/src/App.vue:1977`): toggle calls `captureState.toggleRecord(capsuleId[, {maxFps}])` (`ui/src/recording/MvRecordingPanel.vue:496`). Screenshot calls `captureState.screenshot(capsuleId)` (`ui/src/recording/MvRecordingPanel.vue:522`). Export calls `captureState.exportCapture(recordingId)` (`ui/src/recording/MvRecordingPanel.vue:577`). The panel calls `store.refresh(capsuleId)` again on mount, on capsule switch and on a swap to an empty store (`ui/src/recording/MvRecordingPanel.vue:178`).
- **Without a store**: the panel emits kit `submit-intent` payloads (`buildRecordAiIntent`, `buildScreenshotIntent`, `buildRecordingSelectIntent`, `buildRecordingExportIntent`). Select always emits an intent.
- **Store to panel**: `captureEntryFor` reads `bySurface[capsuleId]`, which gives phase, elapsedMs, lastShot, lastCode and screenshotPending. `captureRowsFor` and `captureShotsFor` filter `rows` by `surface_id` (`ui/src/recording/recordingModel.js:876`, `ui/src/recording/recordingModel.js:913`). `ui/src/capture/capturePort.js:25` imports `MV_RECORDING_FAILED_CODE` and `MV_RECORDING_PHASES`.
- **Human trace**: when a human role view mounts, roleHost reads `MV_RECORDING_DESTINATION` through `recordingDestination` (`ui/electron/authorityWire.js:562`). It refuses with `TRACE_DESTINATION_UNSET` if that is unset (`ui/electron/roleHost.js:551`), and otherwise calls `createHumanTraceFile` (`ui/electron/roleHost.js:552`). Each event is written synchronously to `<destination>/<profileId>/human-trace-<uuid>.jsonl`.

### Recording: invariants
Answers: when can a recording be exported; what frame rates are allowed; can the trace capture passwords; how big can a trace get

- Export requires a destination and a sealed phase (`ui/src/recording/recordingModel.js:135`). Only an ok receipt with a 64-hex sha256 renders "Exported <prefix>" (`ui/src/recording/MvRecordingPanel.vue:558`).
- The frame rate is empty (host default) or an integer from 1 to 60 [CITED: ui/src/recording/recordingModel.js:554]. An invalid value blocks a start but never a stop (`ui/src/recording/MvRecordingPanel.vue:272`).
- Unknown phases render idle. Unknown elapsed renders `--:--`, never zero (`ui/src/recording/recordingModel.js:366`).
- A host sample at most 1000 ms [CITED: ui/src/recording/recordingClock.js:29] behind the shown value never rewinds the readout. The tick is 1000 ms [CITED: ui/src/recording/recordingClock.js:22].
- Host ids that are not canonical are hex-encoded for DOM ids and anchors (`ui/src/recording/recordingModel.js:279`). Duplicate or invalid row ids become `unknown-<index>` with export disabled (`ui/src/recording/MvRecordingPanel.vue:292`).
- Trace: printable keys are always withheld. Navigation keys are kept only when the AX row says the field is not sensitive and not a password (`ui/electron/humanTrace.js:51`). The file has mode 0600, is opened with O_EXCL and O_NOFOLLOW, and sits in a 0700 directory. The default byte budget is 50 MiB [CITED: ui/electron/humanTrace.js:92], and retention is 14 days [CITED: ui/electron/humanTrace.js:92].

### Recording: failure modes
Answers: why does Record do nothing; why does it say Capture is unavailable; why does the panel say No recordings yet; why did the human trace stop; why is Export disabled

| symptom the user sees | cause | coordinate | fix or workaround |
|---|---|---|---|
| "Capture is unavailable: no frame has arrived yet, or the host did not answer. Try again in a moment." | the store recorded `CAPTURE_UNAVAILABLE`, or the store promise rejected | `ui/src/recording/recordingModel.js:588`, `ui/src/recording/MvRecordingPanel.vue:496` | Wait for a frame, then retry |
| Toggle disabled, tooltip "Recording is unavailable" | `unavailableReason` is set, or the store is bound with `captureAvailable` false | `ui/src/recording/MvRecordingPanel.vue:145`, `ui/src/recording/MvRecordingPanel.vue:272` | Restore the capture host |
| Toggle disabled, "Frame rate must be a whole number from 1 to 60" | invalid frame rate | `ui/src/recording/MvRecordingPanel.vue:272` | Clear the field or enter 1 to 60 |
| "No export destination advertised by the host" (row and gate) | `MV_RECORDING_DESTINATION` unset | `ui/src/recording/recordingModel.js:160` | Configure the host destination |
| Gate chip "Sealed required" | the recording is not sealed yet | `ui/src/recording/recordingModel.js:511` | Stop the recording, then export |
| "Recording failed" on a row | the row phase is `error` (data-error-code ERR_RECORDING_FAILED) | `ui/src/recording/MvRecordingPanel.vue:369` | Start a new recording |
| "The recording failed on the host and stopped. Start a new one." | the store set `RECORDING_FAILED` on the host error phase | `ui/src/recording/recordingModel.js:41` | Start a new recording |
| "No recordings yet." after recording (older behavior) | the store was never listed | `ui/src/recording/MvRecordingPanel.vue:178` | Fixed by relisting; switch capsule to force a refresh |
| Tile badge reads "Idle — …" during an error | `recordingBadgeCopy` has no error-phase case | `ui/src/recording/recordingBadge.js:15` | (inference) add an error case |
| Human trace stops growing; view state `recording: paused_size_limit` | the shared byte budget is exceeded | `ui/electron/humanTrace.js:110`, `ui/electron/roleHost.js:552` | Restart the session; raise the limit |
| Human tile refused with `TRACE_DESTINATION_UNSET` | no recording destination configured | `ui/electron/roleHost.js:551` | Set MV_RECORDING_DESTINATION to an existing absolute directory |

### Recording: refusals
Answers: what export codes exist; what capture refusal codes exist; what trace errors are thrown

| code or text | raised at | meaning |
|---|---|---|
| `ERR_EXPORT_WITHOUT_DESTINATION`, `ERR_EXPORT_UNSEALED_RECORDING`, `ERR_RECORDING_UNAVAILABLE` | `ui/src/recording/recordingModel.js:135`, `ui/src/recording/recordingModel.js:160` | Local panel-level gate codes (data-refusal-code) |
| `DESTINATION_UNSET`, `CAPTURE_UNKNOWN`, `NOT_SEALED`, `DESTINATION_UNAVAILABLE`, `DESTINATION_EXISTS`, `LIMIT`, `NESTED_DISPLAY_ONLY`, `CAPTURE_UNAVAILABLE` | `ui/src/recording/recordingModel.js:177` | Closed host export codes; unknown codes become CAPTURE_UNAVAILABLE; text at `ui/src/recording/recordingModel.js:221` |
| `SURFACE_UNKNOWN`, `ALREADY_RECORDING`, `NOT_RECORDING`, `CAPTURE_UNAVAILABLE`, `NESTED_DISPLAY_ONLY`, `LIMIT`, `BUDGET_EXCEEDED`, `POLICY`, `RECORDING_FAILED` | `ui/src/recording/recordingModel.js:588` | Capture refusal text; any other code shows "Capture failed." |
| `TRACE_BINDING_REFUSED`, `TRACE_EVENT_REFUSED`, `TRACE_LIMIT`, `TRACE_CLOCK_REFUSED`, `TRACE_GEOMETRY_REFUSED`, `TRACE_COORDINATE_REFUSED`, `TRACE_BUTTON_REFUSED`, `TRACE_KEY_PHASE_REFUSED`, `TRACE_SCROLL_REFUSED` | `ui/electron/humanTrace.js:18` | Bad binding or event for the trace |
| `TRACE_PROFILE_REFUSED`, `TRACE_DIRECTORY_REFUSED`, `TRACE_RETENTION_REFUSED`, `TRACE_WRITE_FAILED`, `TRACE_CLOSED` | `ui/electron/humanTrace.js:76`, `ui/electron/humanTrace.js:92` | Unsafe directory, bad profile, short write, write after close |
| `METAVIEWER_TRACE_RETENTION_REFUSED` (log line) | `ui/electron/roleHost.js:341` | Pruning at startup failed for a reason other than ENOENT |

### Recording: where to change what
Answers: where do I change recording error text; where is the frame-rate limit; where is the trace size limit; where is the elapsed tick

| change | file |
|---|---|
| Capture or export refusal text | `ui/src/recording/recordingModel.js:588`, `ui/src/recording/recordingModel.js:221` |
| Frame-rate range | `ui/src/recording/recordingModel.js:554` |
| Export gate order | `ui/src/recording/recordingModel.js:135`, `ui/src/recording/recordingModel.js:511` |
| Elapsed tick and jitter | `ui/src/recording/recordingClock.js:22`, `ui/src/recording/recordingClock.js:29` |
| Badge text | `ui/src/recording/recordingBadge.js:15` |
| Trace byte limit, retention, redaction | `ui/electron/humanTrace.js:92`, `ui/electron/humanTrace.js:51` |

### Recording: how to test it
Answers: which tests cover recording; is there a test for the elapsed clock; which tests cover the human trace

Tests under `ui/test/`: `mvui-recording-model.test.js`, `mvui-recording-panel.test.js`, `capfix-recording-panel.test.js`, `mvui11-export-panel.test.js`, `mvui11-export-capture.test.js`, `mvui11-export-double.test.js`, `mvui16b-rec-refresh.test.js`, `mvui19-cap-shots.test.js`, `recstate-clock.test.js`, `recstate-elapsed.test.js`, `recstate-badge.test.js`, `recstate-panel.test.js`. For the human trace: `xpra-trace-drop.test.js`, `p18g-session.test.js`, `p18g-hardening.test.js`, `xpra-role-tiles.test.js`. Run all with `npm --prefix ui test`. For one file, run `(cd ui && node --test test/recstate-clock.test.js)` (inference: a direct node invocation).

### Recording: tradeoffs and rejected options
Answers: why is the trace written to disk at once; why does a high frame rate not add frames; why do the gates differ

- The trace file is written event by event "rather than exported from a memory buffer when the tile closes" (`ui/electron/humanTrace.js:89`). The bounded memory buffer with no-clobber export still exists (`ui/electron/humanTrace.js:128`).
- The frame rate is an upper bound only. The source delivers a few frames per second. The two comments disagree on the rate: about 2.7 [CITED: ui/src/recording/recordingModel.js:558] and about 2 [CITED: ui/src/recording/recordingClock.js:42].
- The panel gate checks the destination before the seal. The per-row gate follows the kit order: unavailable, then sealed, then destination (`ui/src/recording/recordingModel.js:511`).
- On this commit `RecordingBadge.vue` is not mounted by production code, only by tests (from grep).

## Activity

Answers: what is activity in MetaViewer; how does activity work; where is the activity code; what breaks in activity

Terms used here. An **authority outcome** is the single result the host adapters report for each submission: an intent acknowledgement, an action verdict (admitted or refused), or a refused request. The **activity strip** is the bar docked below the wall that lists the latest outcomes.

### Activity: why it exists and why built this way
Answers: what is the Activity strip; why does the strip not show the host message; why only 8 entries

The strip shows the operator what happened to each request without trusting text received as a prop. Visible text comes only from closed maps in `ui/src/activity/activityModel.js:54`, a local copy of the `ui/src/core/hostAdapters.js` literals (`ui/src/activity/activityModel.js:15`). There are two exceptions: human-input refusals name their closed code, and an UPPER_SNAKE code may carry a reason that App.vue has already bounded. The feed keeps 8 entries [CITED: ui/src/activity/activityModel.js:29]. App.vue repeats that limit inline (`ui/src/App.vue:1171`) so stub harnesses never load the model.

### Activity: parts
Answers: which files make up Activity; where is the feed written

| file | role |
|---|---|
| `ui/src/activity/activityModel.js` | Closed outcome rows, input refusal reasons, normalization, count text, DOM ids and anchors |
| `ui/src/activity/ActivityStrip.vue` | Docked bar: Activity toggle, count, role=log list |
| `ui/src/activity/activity.css` | Kit-token styles; in-flow grid row; list 132px [CITED: ui/src/activity/activity.css:32] tall with internal scroll |
| `ui/src/App.vue` (`recordActivity`) | The only writer of `activityFeed` |

### Activity: data flow
Answers: how does an outcome get into the strip; how are repeated input refusals shown

App.vue `recordActivity(outcome)` (`ui/src/App.vue:1174`) gives each outcome the next `seq`, keeps `reason` only when it is 1 to 256 [CITED: ui/src/App.vue:1179] characters with no control characters, and slices to the last 8 entries. Human-input refusals add a new row, or raise `count` on the last row when the code repeats (`ui/src/App.vue:1227`). `<ActivityStrip :entries="activityFeed" />` (`ui/src/App.vue:1912`) takes the last 8 items and passes each through `normalizeActivityEntry` (`ui/src/activity/ActivityStrip.vue:47`). The total is the largest `seq` (`ui/src/activity/activityModel.js:195`).

### Activity: invariants
Answers: can raw codes appear in the strip; what happens to malformed entries

- An entry without a positive integer `seq` is dropped (`ui/src/activity/activityModel.js:140`).
- An unknown code that is not UPPER_SNAKE renders "This request is unavailable. Please try again." (`ui/src/activity/activityModel.js:93`). Codes starting with `ERR_` or `LAYOUT_` never get their code shown.
- Every row is frozen and carries `data-activity-type` (intent-ack, verdict-admitted, verdict-refused or request-refused) and `data-activity-tone` (success or refusal).

### Activity: failure modes
Answers: why does Activity show latest 8 of N; why is my reason not shown; why is the list empty

| symptom the user sees | cause | coordinate | fix or workaround |
|---|---|---|---|
| Count reads "latest 8 of N" | more than 8 outcomes were recorded; older ones are dropped | `ui/src/activity/activityModel.js:214` | None; by design |
| Only "No authority activity yet." | no outcomes yet, or the host is inactive (`recordActivity` returns early) | `ui/src/App.vue:1174` | Check that the host is active |
| Fewer rows than the count | malformed feed items were dropped | `ui/src/activity/ActivityStrip.vue:47` | Fix the producer |
| "<CODE>: This request is unavailable. Please try again." | unknown UPPER_SNAKE code with no usable reason | `ui/src/activity/activityModel.js:140` | Add the code to ACTIVITY_ROWS |
| "Input refused: control released (NOT_IN_CONTROL) ×3." | repeated human-input refusals were merged | `ui/src/activity/activityModel.js:104` | Take control again |

### Activity: refusals
Answers: what codes does the activity strip know; what does STALE_FRAME mean

| code or text | raised at | meaning |
|---|---|---|
| `INTENT_ACKNOWLEDGED` "Request sent.", `ACTION_ADMITTED` "Action admitted." | `ui/src/activity/activityModel.js:54` | Success rows |
| `STALE_FRAME`, `SURFACE_NOT_AGENT_CONTROLLED`, `LOCKED_BY_OTHER`, `BUDGET_EXCEEDED`, `OUT_OF_BOUNDS`, `POLICY` | `ui/src/activity/activityModel.js:54` | Verdict refusals with fixed text |
| `CAPTCHA_HANDOFF` "CAPTCHA or bot check: solve it in the capsule, then re-run" | `ui/src/activity/activityModel.js:55` | A bot check on a browser capsule's site is handed to the human |
| Create-path codes (`NO_IDENTITY`, `RAM_ADMISSION_REFUSED`, `SURFACE_CREATE_*`, `ADAPTER_ERROR`, …) | `ui/src/activity/activityModel.js:54` | Same text as `ui/electron/profilePicker.js:390`, prefixed with the code |
| `NOT_IN_CONTROL`, `INPUT_MODE_READ`, `SURFACE_UNKNOWN`, `STALE_STREAM`, `LIMIT`, `NESTED_DISPLAY_ONLY`, `SCHEMA`, `CORE_UNAVAILABLE` | `ui/src/activity/activityModel.js:104` | surface_input/v1 refusals: "Input refused: <reason> (<CODE>)." |

### Activity: where to change what
Answers: where do I add a new activity code; where is the strip height

| change | file |
|---|---|
| Add or change outcome text | `ui/src/activity/activityModel.js:54` |
| Input refusal reasons | `ui/src/activity/activityModel.js:104` |
| Entry limit (change both places) | `ui/src/activity/activityModel.js:29`, `ui/src/App.vue:1171` |
| List height and dot colors | `ui/src/activity/activity.css:32` |

### Activity: how to test it
Answers: which tests cover the activity strip

Tests under `ui/test/`: `mvui5-activity-model.test.js`, `mvui5-activity-strip.test.js`, `mvui5-activity-app.test.js`, `mvui6-activity-anchors.test.js`, `mvui6-activity-bench.test.js`, `mvui6-activity-csp.test.js`, `mvui17-activity-count.test.js`, `mvui28-input-activity.test.js`. Run all with `npm --prefix ui test`, or one with `(cd ui && node --test test/mvui5-activity-model.test.js)` (inference: a direct node invocation).

### Activity: tradeoffs and rejected options
Answers: why keep a duplicate copy of host messages; why is the limit duplicated

- The strip keeps its own copy of the host literals "so the strip never trusts a message received as a prop" (`ui/src/activity/activityModel.js:17`). The cost is that the text must be kept in sync with `ui/src/core/hostAdapters.js` by hand.
- The limit is duplicated in App.vue so stub harnesses never resolve the model module. A test pins both literals (`ui/src/activity/activityModel.js:25`).
- The list has a fallback empty `<li>`, but the list renders only when `rows.length` is non-zero, so that `<li>` never appears (`ui/src/activity/ActivityStrip.vue:71`) (inference: leftover).

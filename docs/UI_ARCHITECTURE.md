# UI architecture

The MetaViewer desktop UI is an Electron main process, a sandboxed Vue renderer and a pinned component kit. It draws what the Rust core has admitted and submits requests. It holds no authority of its own. This page maps that split to the files that implement it. Version: 0.2.6 [CITED: `VERSION`]. Every path is relative to the repository root.

<a id="implemented-ui-map"></a>
<a id="reading-map"></a>
## Where does each UI behaviour live in the code?

Electron main owns host access, Vue components own presentation, and Rust owns admission; the table maps each UI concern to its source.

Answers: where is the UI code; which file renders tiles, the launcher, the terminal; which file enforces a UI security rule.

| Concern | Implemented in |
| --- | --- |
| Electron main, window flags, CSP, navigation and permission denial | `ui/electron/main.js` (`CONTENT_SECURITY_POLICY` :151, `createWindowOptions` :334, `attachWindowPolicy` :699) [CITED: `ui/electron/main.js`] |
| Starting the core with a scrubbed environment | `ui/electron/coreLauncher.js` (`createCoreLauncher` :594, `scrubChildEnv` :270) [CITED: `ui/electron/coreLauncher.js`] |
| Renderer facade over fixed IPC channels | `ui/electron/preload.js` (`createPreloadFacade` :514), `ui/electron/authorityWire.js` (`WIRE_CHANNELS` :39) [CITED: `ui/electron/preload.js`] |
| Frame verification before tiles | `ui/electron/frameReader.js` (:616), `ui/electron/framePort.js` (:457), `ui/src/frames/framePortRouter.js` [CITED: `ui/electron/frameReader.js`] |
| Wall grid and tile layout | `ui/src/wall/WallWorkspace.vue`, `ui/src/wall/layout.js` |
| One capsule tile, role badge, not-isolated badges | `ui/src/surfaces/RoleSurface.vue:532-533` |
| Painting frames fairly | `ui/src/surfaces/tileScheduler.js` (`createTileScheduler` :735), `ui/src/surfaces/SurfaceCanvas.vue` [CITED: `ui/src/surfaces/tileScheduler.js`] |
| Human input to a tile | `ui/src/input/inputPort.js`, `ui/src/input/keyMap.js` |
| Add-capsule launcher and kind list | `ui/src/catalog/CatalogLauncher.vue`, `ui/src/catalog/catalogModel.js` (`CATALOG_KINDS` :98) [CITED: `ui/src/catalog/CatalogLauncher.vue`] |
| Multislot AI attachment | `ui/src/multislot/` |
| Terminals | `ui/src/terminal/`, `ui/electron/terminalHost.js`, `ui/electron/ptyBroker.js` |
| Guest console and rewind controls | `ui/src/components/GuestCommandPanel.vue`, `ui/electron/guestCommandHost.js`, `ui/electron/rewindHost.js` |
| UI intents and read-only projection | `ui/src/core/intents.js`, `ui/src/core/projection.js` |
| Settings, recording, activity, identities | `ui/src/settings/settingsModel.js`, `ui/src/recording/recordingModel.js`, `ui/src/activity/activityModel.js`, `ui/src/identities/` |
| Pinned component kit | `ui/kit.lock.json` (repo `capsule-ui-kit`, version 0.2.1) [CITED: `ui/kit.lock.json`] |
| Pinned runtime dependencies | `ui/package.json` (Electron 44.9.2, Vue 3.5.43, dockview 8.4.1, xterm 6.0.0, node-pty 1.1.0) [CITED: `ui/package.json`] |

For per-subsystem failure modes and test files, see [dossiers/ui.md](dossiers/ui.md). For why the UI holds no authority and what each capsule kind isolates, see [WHY_CAPSULES.md#separation](WHY_CAPSULES.md#separation).

<a id="section-1"></a>
<a id="section-2"></a>
## Why does the UI hold no authority?

The UI draws state and submits requests; the Rust core decides. Supported requests still need core validation before changing capsule state, control or admission. This protocol boundary does not prove containment against every renderer or host compromise.

Answers: who decides; what can the UI change; what happens when the core refuses.

- **Presentation versus core authority.** The UI sends intents such as fold, unfold, pin, take control and release control (`ui/src/core/intents.js:1-6`, verbs at `:35-38`). The builders validate closed inputs and hand wire encoding to host encoders. The file states it "offers no surface creation or teardown path".
- **Projection.** Every snapshot goes through strict decode before any component sees it. A decode refusal keeps the last good snapshot and marks it stale (`ui/src/core/projection.js:1-8`). Components receive a frozen view.
- **Panel moves are not capsule actions.** The wall keeps one permanent panel per capsule id and uses presentation intents only (`ui/src/wall/WallWorkspace.vue`, file header). Moving, resizing or closing a panel does not stop a capsule.
- **Core-side rules.** Message order, nonces, leases and replay are in [ARCHITECTURE.md](ARCHITECTURE.md), not in the UI.

<a id="section-3"></a>
<a id="section-5"></a>
## How is the Electron renderer constrained?

The renderer runs sandboxed with no Node, no popups and no permissions, and reaches the host only through a fixed facade.

Answers: what flags protect the renderer; what can the renderer call; can a tile open a window.

- **Window flags.** `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false` (also in workers and subframes), `webSecurity: true`, `webviewTag: false` (`ui/electron/main.js:370-378`).
- **Content-Security-Policy.** `default-src 'none'`; scripts, styles, fonts from `'self'`; images from `'self'` and `data:`; `connect-src`, `frame-src`, `object-src`, `base-uri` and `form-action` are `'none'` (`ui/electron/main.js:151-162`).
- **Denials.** `decideWindowOpen`, `decidePermission` and `decideWebviewAttach` deny new renderer windows, permissions and webview attachment (`ui/electron/main.js:502-523`). The window-open handler can separately send the exact source-repository URL to the system opener while denying the new renderer window (`ui/electron/main.js:718-727`).
- **Facade.** `preload.js` exposes one frozen object named `metaviewer`. Its channel list is closed (`CHANNELS` at `:303` covers layout load and save; other domains are added as immutable properties at `:536-541`). Layout text is capped at 256 KiB (`IPC_BOUNDS`, `:320`) [CITED: `ui/electron/preload.js`].
- **Environment.** The core is started with an allowlist of environment names (`ALLOWED_CORE_ENV`, `ui/electron/coreLauncher.js:102`); `LD_`, `NODE_`, `ELECTRON_`, `DYLD_` and `PYTHON` prefixes are refused (`:159`).

Tests for these checks are in `ui/test/` (for example `coreLauncher.test.js`). Packaged-app behaviour beyond those tests: ABSENT — do not invent.

<a id="section-4"></a>
## How do frames get from a capsule to a tile?

The core and adapter publish frame references; the UI verifies each frame before painting.

Answers: who captures; what does the UI check; what happens to stale frames.

1. A `frame_ref` names a published rgb24 frame. `frameReader.js` copies a bounded snapshot, checks packed size and SHA-256, applies a per-surface generation floor, and only then returns a verified frame (`ui/electron/frameReader.js:1-30`). Null-digest frames fail closed. [CITED: `ui/electron/frameReader.js`]
2. A message port per surface and generation carries frames to the renderer. `framePortRouter.js` accepts only same-origin notices of the closed shape and acknowledges every delivery once (`ui/src/frames/framePortRouter.js:1-22`). [CITED: `ui/src/frames/framePortRouter.js`]
3. `tileScheduler.js` keeps one newest-only mailbox per surface and draws in fair rounds under a fixed budget. A frame replaced before paint is acknowledged as superseded. Frame bytes stay outside Vue reactivity (`ui/src/surfaces/tileScheduler.js:1-30`). [CITED: `ui/src/surfaces/tileScheduler.js`]
4. Folding or hiding a tile stops only painting. The capture lease stays active, and reopening requests the newest frame instead of replaying a backlog (same header).

Measured frame rates or latency: ABSENT — do not invent. The settings model defines wall refresh presets of 3, 30 and 60 fps, default 30 [CITED: `ui/src/settings/settingsModel.js:56`]. These are requested rates, not achieved-rate measurements.

<a id="section-6"></a>
## How does a person or an agent take over a tile?

Taking control is an explicit request to the core; typing reaches a tile only after the core admits it.

Answers: how does input reach a capsule; what limits apply; how are CAPTCHA and login pages handled.

- **Input.** `inputPort.js` builds `surface_input/v1` batches: 1 to 32 events per batch, payload at most 16 KiB, at most 60 batches per second per surface [CITED: `ui/src/input/inputPort.js:1-25`]. Refusals map to a closed code set and are shown without the typed text.
- **Gate reset.** Blur, unmount, stream change or control loss closes the surface's gate and drops queued batches, so buffered input is never replayed (same header).
- **Handoff.** For login walls and CAPTCHA pages the UI tells the person to press Take control. New agent work stops for the handoff; already dispatched input may still need reconciliation. The agent does not solve the challenge (`ui/src/handoff/handoffModel.js:11-16`). The recognised page types are in `REASON_LABELS` (`:2-5`). The steps say the operator solves the check or signs in, never the agent.

<a id="section-7"></a>
## What is the difference between a terminal and a guest console?

A terminal runs a process on the host through the PTY broker; a guest console sends commands to a capsule guest through the core.

Answers: where does a typed command run; which one is isolated; which module owns each.

| | Terminal (deck, side, paired) | Guest command (MicroVM, ARM64) |
| --- | --- | --- |
| Where it runs | On the host, as the user's own process under the PTY broker | In the guest, through the core |
| UI code | `ui/src/terminal/`, `ui/electron/ptyBroker.js` (`runBroker` :1238), `ui/electron/terminalHost.js` | `ui/src/components/GuestCommandPanel.vue`, `ui/electron/guestCommandHost.js` [CITED: `ui/electron/ptyBroker.js`] |
| Authority | Main supervises; the broker owns PTY handles; the renderer sends only provider references, never executable paths, argv, cwd or env (`ui/electron/ptyBroker.js:1-30`) | The host actor sends authenticated requests; its header says "No native execution" (`ui/electron/guestCommandHost.js:4`) |
| Isolation | None: a host shell has the user's rights | The guest boundary of the chosen capsule; see [WHY_CAPSULES.md](WHY_CAPSULES.md) |

A paired terminal is a host shell slot retained per capsule id (`ui/src/terminal/pairedTerminals.js:9-12`). It sits next to a capsule but is not inside it.

Agent CLI profiles are `agent-codex`, `agent-gemini`, `agent-opencode` and `agent-muse` (`ui/src/terminal/agentPromptGate.js:3`). The UI does not answer sign-in or trust questions from those CLIs: output that looks like one is classified `authentication` and not answered (`:10-17`). Workflow prompts reject control bytes, tokens and image data before use (`ui/src/terminal/workflowPrompts.js:21-24`). Text printed by a terminal is display data, not an instruction.

<a id="section-8"></a>
## Which capsule kinds can the launcher create, and which carry a warning?

The launcher labels its host-backed kinds as not isolated.

Answers: what is in the Add-capsule list; where do the not-isolated badges come from; how is a kind chosen.

`CATALOG_KINDS` (`ui/src/catalog/catalogModel.js:98-135`) lists, in order: `identity-browser`, `program`, `host-program`, `desktop-window`, `vm` (ARM64 Linux VM, needs host support) and `microvm` (ARM64 guest console).

- **Host warnings.** A host-program tile shows "Runs on your computer — not isolated". A desktop-window tile shows "Real desktop — not isolated" and a Stop button (`ui/src/surfaces/RoleSurface.vue:532-533`). The launcher text for host programs is "Runs on your computer — not isolated." (`catalogModel.js:119`).
- **Opening mode.** The chosen mode (`human` or `agent`) and optional host window or host binary are staged as an owner-only file in the state directory and removed afterwards (`ui/electron/openingMode.js:8-45`).
- **Limits.** At most 16 capsules are live at once (`MAX_CAPSULES`, `ui/electron/profilePicker.js:46`). [CITED: `ui/electron/profilePicker.js`]
- **Protected identities.** `identityProtection.js` blocks foreign or protected identities in the dialog, staging and recording paths.

For what each kind costs and gives, see [WHY_CAPSULES.md](WHY_CAPSULES.md#separation).

<a id="section-9"></a>
## How can an AI operate the UI?

Tiles and controls carry stable semantic anchors, and agent tools submit requests to the core. UI inspection and core admission are distinct paths.

Answers: what anchors exist; how do agents operate MetaViewer; is there a general automation endpoint.

- Controls carry `data-semantic-anchor` values such as `capsule/<id>/menu` and `capsule/<id>/host-window-stop` (`ui/src/surfaces/RoleSurface.vue:524-533`). `ui/src/qa/anchorCollector.js` collects them. `ui/electron/qaAnchors.js` writes them to a private run directory only when `MV_E2E_LIVE=1` in a non-packaged, non-nested launch.
- The agent path is the tools and MCP server in `agents/metaviewer_agents/`, which reach the core directly. See [AI_OPERATOR_GUIDE.md](AI_OPERATOR_GUIDE.md).
- The UI does not expose a general automation endpoint to the renderer. Nesting mode is display only and supplies no core, terminal or socket capability (`ui/electron/nesting.js:1-3`).

<a id="section-10"></a>
## How are settings, recording and activity kept in the UI?

Settings live on the host; recordings stay in memory until a destination is offered; the activity strip shows closed receipts.

Answers: what is stored; where; what does the activity strip show.

- **Settings.** The closed key set is `scheme`, `density`, `wallFps`, `recordingFps`. Defaults: `mv-dark`, `compact`, 30 and 3 (`ui/electron/authorityWire.js:13-14`; `ui/src/settings/settingsModel.js`). Load refuses unknown keys as a whole. Storage is the host's, not `localStorage`. [CITED: `ui/electron/authorityWire.js`]
- **Recording.** The store is RAM (`MV_RECORDING_STORE = 'ram'`, `ui/src/recording/recordingModel.js:33`). Disk export exists only when the host advertises a destination, otherwise the UI shows a typed refusal.
- **Activity.** The strip keeps the latest 8 receipts (`MV_ACTIVITY_LIMIT`, `ui/src/activity/activityModel.js:29`). Text comes from closed maps, so raw reason codes are not shown, except input-refusal codes. [CITED: `ui/src/activity/activityModel.js`]

<a id="section-11"></a>
<a id="section-12"></a>
## How is the UI tested, and what is unverified?

Node unit tests cover the models, the facade and the hosts; a packaged-app walkthrough is not part of this page.

Answers: how do I run the tests; what evidence is missing.

- Run: `cd ui && npm test` (script in `ui/package.json`; Node 24 or newer; the tests include `coreLauncher`, `frameReader`, `framePort`, `inputu2-port`, `guest-command-*`, `headless-*` and `capsule-panel-routing`). [CITED: `ui/package.json`]
- Type check: `npm run check` (`vue-tsc`). Build: `npm run build`.
- ABSENT — do not invent: UI performance numbers, accessibility audit results, packaged-app security review, and Steam or other store behaviour. Live results are maintainer-reported and receipts are unpublished.

<a id="section-13"></a>
<a id="section-14"></a>
## What is not covered or not done?

The UI does not isolate Host programs or desktop windows, has no measured frame budget, and cannot open renderer popup windows.

Answers: what limits should a reviewer know; what is not planned in this document.

- Host programs and desktop windows run on the user's computer. The badge communicates host exposure; input and request validation remain separate checks.
- A host terminal has the user's rights. A capsule execution boundary does not extend to its paired host terminal.
- Renderer-created OS windows are denied by policy (`decideWindowOpen`). In-wall `float` and `dock-back` are presentation-only intents (`ui/src/core/intents.js:85`).
- Design proposals that earlier versions of this page described (shared cross-product kit, orchestrator drawer, layout-profile service and similar) are not implemented here. They are not repository paths and are not claimed.

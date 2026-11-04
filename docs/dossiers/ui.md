# UI dossier: wall, layouts, tree, add capsule, terminals, Direct task, modes, identities, recording, activity

Answers: where is the code for a UI symptom; which file owns a tile, dialog or terminal; which test covers it; what is not covered.

This dossier maps the desktop UI (`ui/src/**`, `ui/electron/**`, version 0.2.6 [CITED: `VERSION`]) to files, rules and tests. Source pointers name a file, with line coordinates where given. Numbers carry [CITED: path:line], [MEASURED] or [TARGET]. Facts not found in the code are written `ABSENT — do not invent`. The design overview is [UI_ARCHITECTURE.md](../UI_ARCHITECTURE.md).

**A finding tells you where to look. Only the code proves it.** Routed findings for the same files are in `route/study/ui.jsonl`. Query them with `python3 route/route_query.py` (see [route/README.md](../../route/README.md)).

### How do I use this dossier?

Start with the symptom or exact refusal, then inspect the cited module and its tests.

Answers: where do I start; how do I go from a symptom to UI code.

1. Have an exact message or code? Run `python3 route/route_query.py error "<text>"` or search the file named in the subsystem below.
2. Have a symptom in plain words? Pick the subsystem from the table, open its first file, read the cited rule.
3. Want to change behaviour? Read the rule, then run the listed tests before and after.

| Subsystem | What it covers |
|---|---|
| [UI shell](#ui-shell-and-process-model-electron-main-preload-renderer) | Electron main, preload, renderer |
| [Capsule tree](#capsule-tree-navigation-tree) | Navigation tree |
| [Wall](#wall-and-tiles) | Tiles and frames |
| [Layouts](#layouts-and-desktops) | Desktops and presets |
| [Add capsule](#add-capsule-catalog) | Launcher and kinds |
| [Modes](#modes-opening-mode-humanagent-control-network-mode-settings) | Opening mode, control, network, settings |
| [Terminals](#terminals-deck-side-terminal-paired-terminals-pty-broker) | Host shells and the PTY broker |
| [Direct task](#direct-task-workflow-prompts-to-an-agent-cli) | Workflow prompts to an agent CLI |
| [Identities](#identities) | Identity dialog and stored data |
| [Recording](#recording) | Screenshots and recordings |
| [Activity](#activity) | Authority receipts strip |

Not covered here: the frame and input planes in depth (`ui/src/frames/`, `ui/src/input/`; summary in [UI_ARCHITECTURE.md](../UI_ARCHITECTURE.md#section-4)), rewind and guest-command hosts, xpra role tiles, and the closed components `wender-agent`, `vision-engine` and `OpenSuperficies`, which MetaViewer starts as separate processes over documented process and socket interfaces (see `NOTICE-EVALUATION.md`).

### Was the UI run to write this dossier?

No. This dossier comes from reading the code. The tests were not run for it, and `ui/.kit/` (the pinned component kit, pinned in `ui/kit.lock.json`) is not in the tracked tree. Live results are maintainer-reported with unpublished receipts.

Answers: what was verified by running; what is unverified.

## UI shell and process model (Electron main, preload, renderer)

The shell is `ui/electron/main.js` (window, CSP, policy), `ui/electron/preload.js` (one frozen `metaviewer` facade), `ui/electron/coreLauncher.js` (starts the core) and `ui/src/main.js` (renderer entry).

Answers: what are the parts of the shell; which rules protect the renderer; where do I change a shell rule.

| Rule | Where | Test |
|---|---|---|
| `sandbox`, `contextIsolation` on; `nodeIntegration` off; `webviewTag` off | `ui/electron/main.js:370-378` | `ui/test/main-startup-order.test.js` |
| CSP: `default-src 'none'`, `connect-src 'none'`, `frame-src 'none'` | `ui/electron/main.js:151-162` | same |
| Window open, permissions and webview attach always deny | `ui/electron/main.js:502-523` | same |
| Facade channels are a closed list; layout text capped at 256 KiB | `ui/electron/preload.js:303-320` | `ui/test/layout-load.test.js` [CITED: `ui/electron/preload.js`] |
| Core env is an allowlist; `LD_`, `NODE_`, `ELECTRON_`, `DYLD_`, `PYTHON` refused | `ui/electron/coreLauncher.js:102-166` | `ui/test/coreLauncher.test.js` |
| Boot refusal and ready markers: `METAVIEWER_BOOT_REFUSED`, `METAVIEWER_MAIN_READY` | `ui/electron/main.js:2561`, `:3152` | `ui/test/main-startup-order.test.js` |

If the core is missing or unsafe, main refuses to boot with `METAVIEWER_BOOT_REFUSED` instead of showing an empty wall. The log marker names the cause. The runtime directory must be owner-only (`ui/electron/main.js:1488`).

## Capsule tree (navigation tree)

The tree is built in `ui/src/App.vue` (`buildWorkingTree` :1658, collapse state `treeCollapsed` :1682) from the same snapshot that drives the tile rail (`:1139`). It does not create or destroy capsules. Rows come from the core projection (`ui/src/core/projection.js`, `ui/src/core/hostAdapters.js`); capsule ids are formatted by `ui/src/wall/capsuleId.js`. A dedicated tree test file: ABSENT — do not invent; `ui/test/capsule-panel-routing.test.js` covers panel routing. [CITED: `ui/src/App.vue`]

Answers: where is the tree; what does it show; how does it relate to the wall.

## Wall and tiles

The wall arranges permanent capsule panels; the frame pipeline verifies and paints their pixels.

Answers: which file draws a tile; what keeps a tile from stopping a capsule; how are frames painted.

- **Grid.** `ui/src/wall/WallWorkspace.vue` composes the kit dock workspace with one permanent panel per capsule id. It does not touch storage, layout bytes or backend verbs.
- **Panel routing.** `ui/src/wall/capsulePanelRouter.js` classifies panel parameters from the dock library as data only.
- **Tile.** `ui/src/surfaces/RoleSurface.vue` draws the header, role badge, size controls and the not-isolated badges (`:532-533`). `ui/src/surfaces/SurfaceCanvas.vue` draws the canvas.
- **Frames.** Verified by `ui/electron/frameReader.js`, delivered by `ui/electron/framePort.js` and `ui/src/frames/framePortRouter.js`, painted by `ui/src/surfaces/tileScheduler.js`. See [UI_ARCHITECTURE.md](../UI_ARCHITECTURE.md#section-4).
- **Fold.** Fold, unfold and pin are intents to the core (`ui/src/core/intents.js:35`). Closing or hiding a panel is local (`:85`).
- **Tile states.** `ui/src/wall/tileStates.js`, `ui/src/wall/guestWorkloadTile.js`.

Tests: `ui/test/mvui14-frames-router.test.js`, `ui/test/frameReader.test.js`, `ui/test/mvui17-wall-fold.test.js`, `ui/test/mvui12-wall-intents.test.js`, `ui/test/capsule-panel-routing.test.js`.

## Layouts and desktops

Desktops are presentation state with schema `metaviewer.desktops/v1`, at most 16 per view [TARGET], views `human` and `agent`, presets `single`, `side-by-side`, `grid`, `grid-3x2`, `focus-strip`, `floating` (`ui/electron/desktopLayout.js:1-8`). `ui/src/wall/DesktopWorkspace.vue` renders them; `ui/src/wall/layout.js` has the float drag and snap-to-grid arithmetic (grid counts 1 to 5). Layout text is loaded and saved through the two facade methods `load` and `save` (`ui/electron/preload.js:303-307`). The wrapper depends on the pinned external kit; its decoder implementation is not reproduced here.

Answers: how are desktops stored; which presets exist; what happens to a layout the UI cannot read.

Tests: `ui/test/layout-load.test.js`, `ui/test/floating-constraints-render.test.js`, `ui/test/mvui16-dockback.test.js`, `ui/test/mvui16d-place-float.test.js`.

## Add capsule (catalog)

The closed list is `CATALOG_KINDS` in `ui/src/catalog/catalogModel.js:98-135`: `identity-browser`, `program`, `host-program`, `desktop-window`, `vm`, `microvm`. The dialog is `ui/src/catalog/CatalogLauncher.vue`; grouped creation is `ui/src/catalog/GroupedCapsuleDialog.vue`. Host kinds show "not isolated" in the launcher text and on the tile (`ui/src/surfaces/RoleSurface.vue:532-533`). At most 16 capsules are live (`ui/electron/profilePicker.js:46`). Creation is requested through the host and admitted by the core; the renderer never selects executables, containers or displays. [CITED: `ui/src/catalog/catalogModel.js`]

Answers: which kinds can the launcher create; where is the list; which kinds warn.

Tests: `ui/test/grouped-launcher.test.js`, `ui/test/launcher-recent-launch.test.js`, `ui/test/multicap-profile-picker.test.js`.

## Modes (opening mode, human/agent control, network mode, settings)

Opening mode, current control, network policy and display settings have separate owners and checks.

Answers: what do opening mode and control mean; where is network mode; where are settings.

- **Opening mode.** `human` or `agent`. `stageOpeningMode` writes an owner-only file (mode 0600 in a 0700 directory) before creation and removes it afterwards (`ui/electron/openingMode.js:8-45`). [CITED: `ui/electron/openingMode.js`]
- **Control.** Take control and release control are intents (`ui/src/core/intents.js:38`). A tile accepts typing only under human control after the successful Take control action. See [UI_ARCHITECTURE.md](../UI_ARCHITECTURE.md#section-6).
- **Network mode.** The per-capsule panel (`ui/src/netmode/NetworkPanel.vue`, copy in `ui/src/netmode/networkCopy.js`) lists the modes the adapter declares. The host stays the authority for hostnames.
- **Settings.** Closed keys `scheme`, `density`, `wallFps`, `recordingFps`; unknown keys refuse the whole load (`ui/src/settings/settingsModel.js`; panel `ui/src/settings/MvSettingsPanel.vue`). Wall fps presets are 3, 30 and 60 (`:56`). [CITED: `ui/src/settings/settingsModel.js`]

Tests: `ui/test/mode-switch-live-surface.test.js`, `ui/test/host-settings-fps.test.js`, `ui/test/mvui29s-settings-refusal.test.js`, `ui/test/mvui33-settings-boot.test.js`.

## Terminals (deck, side terminal, paired terminals, PTY broker)

Terminals run on the host and are not capsule guests. The renderer sends only a provider reference. The PTY broker (`ui/electron/ptyBroker.js`, `runBroker` :1238) owns PTY handles, main supervises it, and server-owned argv and env are never supplied by the renderer (`ui/electron/ptyBroker.js:1-30`). The pieces: [CITED: `ui/electron/ptyBroker.js`]

Answers: where does a typed terminal command run; who owns the process; what does the renderer send.

| Piece | File |
|---|---|
| Deck of sessions | `ui/src/terminal/TerminalDeckView.vue`, `ui/src/terminal/terminalDeckModel.js` |
| Side terminal overlay | `ui/src/terminal/SideTerminalOverlay.vue`, `ui/src/terminal/sideTerminalFacade.js` |
| Paired terminal per capsule | `ui/src/terminal/pairedTerminals.js:9-12` |
| Session spawn validation | `ui/electron/ptySession.js`, `ui/electron/terminalHost.js:9` |
| Byte flow control | `ui/electron/bytePlane.js` |

Closing a side terminal only detaches the view; the host session keeps its owner (`ui/src/terminal/sideTerminalFacade.js:1-6`). A host terminal has the user's rights. For guest commands see [UI_ARCHITECTURE.md](../UI_ARCHITECTURE.md#section-7).

Tests: `ui/test/mvui12-terminal-boundary.test.js`, `ui/test/mvui2-terminal-broker.test.js`, `ui/test/bytePlane.test.js`, `ui/test/mutTerminalHarden.test.mjs`.

## Direct task (workflow prompts to an agent CLI)

A workflow prompt is a short text written to an agent CLI profile in a terminal. Kinds: `automate`, `use-automation`, `no-automation` (the last is titled "Direct task") (`ui/src/terminal/workflowPrompts.js:3-8`). Identity lines are one bounded line of data; control bytes, bearer tokens, `sk-`-style keys, password or api-key assignments and `data:image/` are rejected (`:13-24`). Profiles: `agent-codex`, `agent-gemini`, `agent-opencode`, `agent-muse` (`ui/src/terminal/agentPromptGate.js:3`). Output that asks to sign in, log in, trust a folder or confirm `(y/n)` is classified `authentication` and never answered (`:10-17`); a login or CAPTCHA requests a human handoff. Already dispatched input may still need reconciliation. This page does not claim any agent CLI is available on your machine.

Answers: what is a Direct task; which prompts are rejected; what does the UI never answer.

Tests: `ui/test/agent-prompts.test.js`, `ui/test/agent-prompts-other-clis.test.js`, `ui/test/microvm-agent-prompt.test.js`.

## Identities

The identity dialog validates user entries and forwards operations through the host boundary.

Answers: where is the identity dialog; what is validated; what is protected.

`ui/src/identities/IdentitiesDialog.vue` is the dialog. `ui/src/identities/identityForm.js` applies the same closed rules as `ui/electron/preload.js` so a typo is explained before the request is sent (hostnames are lower-case and match a DOMAIN pattern, `identityForm.js:3-4`). `ui/src/identities/StoredDataSlots.vue` manages saved data; ids match `^[a-z0-9][a-z0-9-]{1,39}$` (`:10`) and every request goes through core admission. `ui/electron/identityProtection.js` blocks protected and foreign identities.

Tests: `ui/test/ident-dialog.test.js`, `ui/test/ident-persist.test.js`.

## Recording

The recording panel uses the capture facade; export requires an advertised destination.

Answers: where are screenshots and recordings handled; where do they go; what refuses.

`ui/src/recording/MvRecordingPanel.vue` is the panel and `ui/src/recording/recordingModel.js` the model. Recording is RAM-first (`MV_RECORDING_STORE = 'ram'`, `:33`). Disk export exists only when the host advertises a destination; otherwise the UI shows a typed refusal. The facade's capture methods are closed (`ui/electron/preload.js:546-567`); a list reply holds at most 64 rows and an export at most 16 MiB (`:593-596`) [CITED: ui/electron/preload.js]. A tile shows "Recording paused (size limit)" when a size limit stops it (`ui/src/surfaces/RoleSurface.vue:536`).

Tests: `ui/test/capfix-recording-panel.test.js`, `ui/test/capture-export.test.js`, `ui/test/capture.test.js`.

## Activity

The strip shows the latest 8 authority receipts (`MV_ACTIVITY_LIMIT`, `ui/src/activity/activityModel.js:29`): intent acknowledgements and admitted or refused verdicts. Text comes from closed maps; raw reason codes are not displayed, except input-refusal codes (`activityModel.js:1-14`). The component is `ui/src/activity/ActivityStrip.vue`. [CITED: `ui/src/activity/activityModel.js`]

Answers: what does the activity strip show; where does its text come from.

Tests: `ui/test/mvui19-app-activity.test.js`, `ui/test/mvui17-activity-count.test.js`, `ui/test/mvui28-input-activity.test.js`.

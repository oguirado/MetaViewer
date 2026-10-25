# MetaViewer: design notes from Holdings (UI layer and capsule orchestrator)

Purpose: input for the MetaViewer design mesh and the research passes. This file is not the architecture. It records what building Holdings on HYPERBOOKS_WEB_MGMT_v1 (`<ARCH_NORM>`) taught us, and how that applies to the chosen visual stack. It complements `ARCHITECTURE.md` and keeps its laws: the Rust core is the only authority, and Electron renders state and submits intents but never injects input.

Number tags follow the house rule: [MEASURED] comes from Holdings runs, [CITED] from a file, [TARGET] is a design goal.

## 1. Product position

- MetaViewer is a full-screen work environment (F11), not a replacement for the OS desktop. Users: security-monitoring desks (a wall of live surfaces and alerts) and AI-productivity desks (a fleet of capsules, each driven by an AI agent, watched and steered from one place).
- It has two faces in one app:
  - a **viewer**, the live wall of surfaces;
  - an **orchestrator** in the OpenFresnel style: terminals that launch AI sessions and prompts towards capsules.
- Constraint inherited from `ARCHITECTURE.md`: visibility is not control. Folding a panel saves rendering work; it never stops capture, reasoning or verification.

## 2. Stack decision

| Layer | Choice | Why (Holdings evidence) |
|---|---|---|
| Native host | Electron (pin an exact version) | Holdings ships Electron 44.9.2 [CITED: Holdings deps]. One Chromium on every OS gives identical rendering. Our security, packaging and capsule tooling already work. Wails + WebView2 (OpenNewton) gave a different webview per OS |
| Authority | Rust core (napi in-process, or a child process per `ARCHITECTURE.md`) | Holdings keeps all state in Rust; the renderer holds no authority. This made determinism and replay possible |
| UI framework | Vue 3.5 stable (not 3.6 vapor while it is a release candidate) + Vite + TypeScript strict | Templates close to HTML; scoped CSS per component; large training corpus for AI writers |
| Components | OpenVue, the MIT continuation of PrimeVue, pinned exactly; PrimeVue v4 as fallback | Saves writing tables, forms and menus by hand. Young fork, so pin the version and keep the fallback |
| Layout | Dockview (`dockview-vue`) | IDE-style docking, tabs, groups, floating windows and popouts, serialisable layout |
| Terminal | `@xterm/xterm` (renderer) + `node-pty` (main or utility process) | The VS Code pattern; see section 6 |

Holdings stays on Lit. Two frameworks is fine: the HTML/CSS skills and the design-token system carry over.

## 3. What to copy from Holdings as it is

### 3.1 Shell security (HYPERBOOKS §12)
- `contextIsolation: true`, `sandbox: true` and `nodeIntegration: false` for every renderer. A strict CSP (no inline script, no eval).
- Electron fuses set at package time (RunAsNode off, cookie encryption on, ASAR integrity on, only load app from ASAR).
- A preload **facade** with a closed verb list and typed envelopes. The renderer never sees `ipcRenderer` and never gets a generic `invoke(channel, any)`.
- Caller guard in main: check the sender frame and origin on every IPC message.
- Window policy: deny `window.open`, block navigation, no remote content in privileged windows. Untrusted surfaces (web capsules) go in separate, unprivileged views.

### 3.2 Process model and budgets
- Separate processes per role: main (supervisor), renderer (UI), and utility processes (PTY broker, heavy I/O). A crash in one moves the affected surfaces to `lost`, as in `ARCHITECTURE.md`.
- Per-process RSS budgets with an enforced ceiling. Holdings budget: main 200 MB, renderer 370 MB, utility 260 MB, whole tree 1,150 MB, hard ceiling 2 GB [MEASURED: Holdings operator decision]. A wall of many live surfaces needs its own measured budget [TARGET].
- Every child process is spawned with a recorded PID, killed only by that PID and its tree, and reaped at shutdown. Never select processes by command line.

### 3.3 Deterministic agent-operable UI (HYPERBOOKS §5, §10)
- Every control has a **stable id, a role and an accessible name**, and the agent lane exports the element box in window pixels. Holdings' `agent_lane/v1` has closed verbs (`observe`, `submit`), nonce + seq, STATE with nodes {id, role, name, parent, depth, states, box}. wender-agent and vision-engine can then operate MetaViewer itself: the system can drive the screen it lives on.
- Good accessible HTML is the same thing as AI-operable HTML: semantic elements, roles and names first, styling second.
- **Lesson (Holdings, Holdings probe 3):** do not put rendered geometry (boxes) into the hash that tests compare across machines. Font metrics differ between host and capsule, so 0/72 battery digests matched while behaviour was identical [MEASURED]. Fix: battery digest = canonical STATE with every `box` set to null; the frame-binding hash keeps the boxes. After the fix: 107/107 legs matched across host and capsule in both runs [MEASURED].
- Fix the window geometry in every test and capture: Holdings uses 1280x900, and xvfb `-screen 0 1280x900x24`. One default-geometry gate caused a day of hash drift [MEASURED].

### 3.4 Build and delivery
- Build the capsule or app folder from a clean worktree at HEAD, never from a working tree with in-flight changes, and always with a freshly built release native module. A stale native module once shipped in a capsule.
- **Version every build** (`capsule-arm64-<sha>`) and promote it to the shared path only after the probe passes. Consumers running live series must never see a build change under them.
- The capsule runs as another uid (10001), so build folders need `a+rX`.

### 3.5 Testing Electron
- Holdings found that CDP/DevTools-driven automation taints the launcher. The reliable route was a **test-owned main process** that drives input with `webContents.sendInputEvent`. Evaluate Playwright for Electron against that lesson before adopting it.
- Electron SIGTRAP at exit came from a listener touching an already destroyed `webContents`. Guard every `destroyed` listener.
- Strict teardown assertions (no surviving process group) catch real leaks. Inside sandboxes that do not reap children, add a reaper wrapper instead of weakening the assertion.

## 4. Visual layer with Vue 3 + OpenVue + Dockview

### 4.1 Layout model
- Dockview owns **presentation state only**: panel positions, sizes, tabs and popouts. Serialise it (`toJSON`) per user profile. It is never authority: what a panel shows comes from Rust core snapshots.
- Panel types [TARGET]:

| Panel | Content | Data source |
|---|---|---|
| Surface | live view of one capsule or display | frame stream from OpenSuperficies / RAM capture |
| Terminal | xterm.js session | PTY broker (section 6) |
| Fleet | capsules, state, agent, budget, cost, progress | Rust core snapshot |
| Inspector | the agent lane STATE of the focused surface, element boxes over the frame | lane observe |
| Timeline / log | envelope journal, verdicts, alerts | append-only records |
| Alert board (security desks) | prioritised events, acknowledge flow | core events |

- F11 / kiosk: one BrowserWindow in full screen; Dockview popouts become extra BrowserWindows for multi-monitor walls.

### 4.2 CSS and design system (HYPERBOOKS A.5/A.6)
- **Design tokens** as CSS custom properties on `:root` (color, spacing scale, radius, type scale, z-layers, motion), with dark and light themes. A dark theme is the default for monitoring desks [TARGET].
- Map the OpenVue theme and the Dockview theme onto the **same tokens**, so the app looks like one product, not three libraries.
- Layout with Grid for the shell (header, wall, bottom drawer) and Flexbox inside panels. No absolute positioning except overlays such as element boxes.
- Status colours carry text or icons too, never colour alone (accessibility and AI legibility).

### 4.3 Rendering performance (a wall of live surfaces)
- Do not let frames enter Vue's reactivity. Use `shallowRef` and `markRaw` for heavy objects, and draw frames on `<canvas>`, WebGL or `<video>` (WebRTC or a shared-memory bridge) outside the virtual DOM.
- Folded or hidden panels stop drawing, but capture continues (`ARCHITECTURE.md` law).
- Measure: frames per second per surface, renderer RSS, main-thread long tasks. Holdings reference: 4 capsules at 26–31 fps each, about 310 MB and 1.6 cores per capsule [MEASURED: Holdings probe 2].

## 5. Orchestrator: capsule fleet (OpenFresnel style)

- Each capsule is one record in the Rust core: lifecycle state, assigned agent seat, budget, lock owner, cost, last verdict. The UI shows it and submits intents (start, pause, assign agent, send prompt, stop). The core admits or refuses each intent with a typed refusal family, and the refusal text is shown in a lane-visible alert element (a Holdings lesson: an agent loop failed 0/5 until refusals were readable).
- Prompt broadcast to many capsules is an **intent per capsule**, admitted individually (budget, lock, state), never a raw keystroke fan-out.
- Per-capsule caps: memory ceiling, wall time, cost ceiling, and a kill path through the recorded PID only.
- OpenFresnel's and OpenNewton's exact mechanisms (panel spawning, prompt routing, catalogue): AUSENTE in this note. Bring them in from their own repositories during the design mesh.

## 6. Bottom terminal drawer

| Piece | Rule |
|---|---|
| `node-pty` | runs in a utility process (PTY broker), never in the renderer; one PTY per session; spawned with a recorded PID inside a resource cap |
| IPC | typed frames {session, seq, bytes} with backpressure (pause the PTY when the renderer lags); input and output on separate channels; seq checked on both sides |
| `@xterm/xterm` | one instance per tab; the fit and search addons; the drawer collapses to a tab strip |
| Sessions | a shell, or an AI CLI attached to one capsule; the session list lives in the core so it survives a renderer reload |
| Security | never auto-execute text that arrives in a message, a file or an agent output; tokens never shown in the UI or logs; every session is audited in the append-only journal |
| Native module | `node-pty` must match the exact Electron ABI on every OS; CI builds or fetches prebuilt binaries per target |

## 7. AI production workflow (how Holdings was built)

| Stage | Seat | Rule |
|---|---|---|
| Unit card | conductor script | goal, files, interfaces, gates; one row of the plan |
| Router | Router model (plus a second router model in parallel; merge the two) | picks at most 12 exact spans from docs and corpora. For Dockview, OpenVue and xterm, give it the pinned library docs: these libraries are thin in model training data, so the docs pack is what stops invented APIs |
| Context lane | Context model | directives backed by exact quotes, checked by phrase search; splits the work into sub-units |
| Writers | Writer model | at most 3 files or one concern per unit, research-free, mirror-first |
| Integration | Integration seat | anything Electron/entry/IPC; the integration seat edits the live tree, so it holds the gate lock for its whole unit |
| Gates | conductor | type check, unit tests, the e2e/battery suite under fixed geometry; commit only on green |
| Review | Exit review (writes independent tests) + judge review | at milestone end only |
| Tests and CI | Test-writing models | from the integration branch only; ADD-only diffs |

Holdings throughput for reference: 18 writer sub-units for about $0.79 in one wave, all gates green [MEASURED]. The real limits were integration and review, not writing.

Lessons that cost us time:
1. **Design the production bindings before integration.** The integration seat correctly refused to integrate owners whose production command arguments did not exist yet.
2. Recapture test expectations only at wave end on a quiet tree.
3. Corpus extraction tools can fail on very wide lines: fall back to a direct read and never declare a span void because a tool failed.
4. A `_scratch` copy per worker plus a cargo target per worker filled about 569 GB of disk [MEASURED]. Use a shared build target, symlinked `node_modules` and automatic scratch cleanup after a green commit.
5. Batteries and baselines must own their display geometry.

## 8. Gates to plan from day one

- Type check (vue-tsc), unit tests (Vitest), and component tests for each panel type.
- An e2e journey per screen with the stable-id and role check, plus an accessibility-name check.
- A determinism check: same inputs, same STATE digest (geometry-free) across two fresh runs.
- An RSS and frame-rate budget test on the wall with N surfaces [TARGET N].
- A CI matrix for Windows, macOS and Linux x64, plus the host arm64 gate; native module builds per target.
- Pre-push secret scan; the operator pushes protected branches.

## 9. Open questions for the design mesh

- Frame transport into the renderer: WebRTC, shared memory with an Electron-side bridge, or MJPEG over a local socket. Which one meets the latency and RSS budgets? AUSENTE: needs measurement.
- Does Dockview's floating-window and popout model fit multi-monitor walls under Wayland? AUSENTE.
- OpenVue maturity: release cadence and theming API stability. Thin public signals as of October 2026.
- Where does the PTY broker live: an Electron utility process (simple) or a Rust core child (single authority over sessions)?
- Security-desk mode: alert acknowledgement as a core intent with an audit trail, and operator roles and permissions.

Scope note: these notes are limited to the Holdings evidence, the HYPERBOOKS_WEB_MGMT_v1 specification and the existing MetaViewer `ARCHITECTURE.md`.

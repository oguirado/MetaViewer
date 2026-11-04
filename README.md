# MetaViewer

**A Linux desktop wall of live browser and application surfaces where humans and AI agents share explicit control, governed by a single Rust admission authority and a hash-chained replayable session journal [CITED: `llms.txt`, `docs/REFERENCE.md`].**

<!-- VIDEO_SLOT: Packaged evaluation walkthrough video showing the 3-column live wall, human/agent control handoff, and mv-replay journal verification -->
<!-- IMAGE_SLOT: Hero 2x2 live wall showing concurrent isolated identity-browser and program capsules alongside the left Humans/Agents tree and right paired terminal dock -->

### 1. What It Is (First Screen for AI & Human Readers)

MetaViewer separates **rendering**, **execution**, and **authority** across three processes [CITED: `docs/REFERENCE.md#architecture`]:
- **Electron (`44.9.2`) + Vue (`3.5.43`) Desktop Wall (`ui/src/App.vue:148`):** Projects admitted state across `3` columns (left **Humans / Agents** ownership tree, center multi-tile live wall, right paired terminal dock) and submits closed `ui_intent/v0.2` intents without injecting raw input [MEASURED: `ui/package.json:21`, `ui/src/App.vue:148`].
- **Rust Admission & Journal Authority (`core/src/admission/mod.rs:52`):** Validates every agent `action_proposal/v0.2` against surface ownership and frame freshness (`generation` + `sha256`), refuses stale frames with `STALE_FRAME` before dispatch (`core/src/admission/mod.rs:1219`), and appends every admitted or refused outcome to a hash-chained JSONL journal (`metaviewer.journal/v1`) verified by `mv-replay` (`core/src/bin/mv-replay.rs:25`) [MEASURED].
- **Go Daemon Adapter (`daemon-adapter/cmd/mv-daemon-adapter/main.go:24`):** Bridges isolated `identity-browser` and container `program` capsules via the private and pre-existing `OpenSuperficies` runtime (`daemon-adapter/internal/capsule/manager.go:434`), enforces stop-first custody on stored-data save slots (`daemon-adapter/internal/capsule/slots/store.go:274`), and labels unisolated `host-program` and `desktop-window` routes explicitly as **not isolated** (`ui/src/catalog/CatalogLauncher.vue:317`, `ui/src/surfaces/RoleSurface.vue:517`) [MEASURED].

| Evaluation Path | Available Scope | Requirements & Platform Boundary | Start Guide |
| :--- | :--- | :--- | :--- |
| **App-only (`T1`)** | `3`-column desktop wall, Rust authority core, Go adapter, and `mv-replay` journal verifier; no live container capsule promise [CITED: `docs/JUDGE_NO_DOCKER.md`] | Linux graphical session (`X11` or `Xvfb`), user-owned `XDG_RUNTIME_DIR`, and verified release package [CITED: `scripts/judge/preflight.sh:177`] | [No-Docker Route](docs/JUDGE_NO_DOCKER.md) |
| **Browser & Program Capsules (`T2`)** | Up to `4` concurrent isolated `identity-browser` and `program` capsules, human takeover, identity save slots, paired terminal [CITED: `docs/JUDGE_QUICKSTART.md`] | Private and pre-existing `OpenSuperficies`, `vision-engine`, and `wender-agent` evaluation binaries, rootful Docker, container images (`0.2.0`), and RAM floor `min(20 GiB, MemTotal / 4)` [TARGET; CITED: `docs/INSTALL.md#concurrent-identities-and-ram-admission`] | [Judge Quickstart](docs/JUDGE_QUICKSTART.md) |
| **ARM64 VM & arm64 MicroVM Rewind** | Fixed `1280×900` graphical VM (`tools/arm64_capsule_session.py:472`) and bounded guest commands + RAM-ring checkpoint rewind inside a running **arm64 MicroVM** (`core/src/rewind_flow.rs:1`) [MEASURED] | **`linux-arm64` (`aarch64`) developer setup only** with KVM and verified local assets; no turnkey judge installer tier. **No VM or MicroVM on x64 in this release** (`ui/electron/guestCommandProfile.js:47`) [MEASURED] | [ARM64 Setup](docs/ARM64_CAPSULE_SETUP.md) |

### 2. How to Run

> **AI & Judge Entry Track:**
> 1. **Give [docs/AI_OPERATOR_GUIDE.md](docs/AI_OPERATOR_GUIDE.md) to your own AI** to install, configure, inspect, and explain the workspace [CITED: `docs/JUDGE_QUICKSTART.md`].
> 2. **Install & launch the packaged kit:** Follow [docs/JUDGE_QUICKSTART.md](docs/JUDGE_QUICKSTART.md) (Tier `T2` with Docker) or [docs/JUDGE_NO_DOCKER.md](docs/JUDGE_NO_DOCKER.md) (Tier `T1` without Docker), then walk through [Judge tour](docs/JUDGE_TOUR.md) and [Judge troubleshooting](docs/JUDGE_TROUBLESHOOTING.md) [CITED].
> 3. **Audit the engineering:** Read the [Engineering Triptych](docs/REFERENCE.md#engineering-triptych) (authority freshness, negative knowledge, and replay oracle) and the [evidence guide](docs/EVIDENCE.md) [CITED].

Fetch the checksum-verified `x64` release assets from the [v0.2.5 pre-release](https://github.com/oguirado/MetaViewer/releases/tag/v0.2.5) [CITED: release asset list] (that release provides compiled `x64` assets only; `arm64` builds from source; **no VM or MicroVM on x64 in this release** [CITED: `docs/JUDGE_QUICKSTART.md`]). Keep `--capsules` consistent across `fetch`, `doctor`, and `install` for the capsule tier (`T2`), or omit `--capsules` for the app-only tier (`T1`):

```bash
bash scripts/judge/metaviewer-judge.sh doctor --before-install --capsules
bash scripts/judge/metaviewer-judge.sh install --capsules
bash scripts/judge/metaviewer-judge.sh doctor --capsules
bash scripts/judge/metaviewer-judge.sh run

# Stop scoped capsules and inspect custody when finished
bash scripts/judge/metaviewer-judge.sh stop
```

### 3. What Is Proven

MetaViewer separates **deterministic public source verification** from **reported live observations** ([docs/EVIDENCE.md](docs/EVIDENCE.md), [docs/REFERENCE.md](docs/REFERENCE.md)):

| Claim | Public Source Implementation & Test Evidence | Verification Command / Coordinate |
| :--- | :--- | :--- |
| **Stale frame proposals are refused before dispatch** | `Authority` compares proposal `generation` and `sha256` against current surface state and returns `STALE_FRAME` before executor dispatch [MEASURED] | `core/src/admission/mod.rs:1219`, `core/tests/admission_matrix.rs` [MEASURED] |
| **Human takeover cancels pending agent work** | `take_control` transitions ownership to Human, cancels pending agent proposals with `SURFACE_NOT_AGENT_CONTROLLED`, and requires `release_control` plus a fresh `generation` (`+1`) before agent admission resumes [MEASURED] | `core/src/admission/mod.rs:1124`, `core/src/serve/mod.rs:223` [MEASURED] |
| **Session history is hash-chained and replayable** | `Authority::apply_with_witnesses` journals before replacing state (`core/src/admission/mod.rs:1422`); `mv-replay` reproduces the state digest (`rc 0`) and rejects corrupted input (`rc 2`), duplicates (`rc 3`), and witness mismatches (`rc 4`) [MEASURED] | `core/src/bin/mv-replay.rs:25`, `core/tests/admission_journal.rs`, `core/tests/t1_journal_verify.rs` [MEASURED] |
| **Save slots enforce stop-first custody & compatibility** | Slot store refuses running capsules, checks `browser`/`program` kind, CPU architecture, image compatibility, and SHA-256 payload digests, and requires human confirmation for credential copy [MEASURED] | `daemon-adapter/internal/capsule/slots/store.go:274`, `daemon-adapter/internal/capsule/slots/store_test.go` [MEASURED] |
| **arm64 MicroVM Rewind restores guest RAM checkpoints** | Bounded `2`-point, `1` GiB `/dev/shm` RAM ring (`256` MiB guest RAM, `1` vCPU) pauses, marks, and restores running **arm64 MicroVM** state across generations (`1` → `2` → `3`); developer-controlled arm64 packaged proof recorded at commit `8b44747c83f0ad760aed2550277aa88cd417fb30` [MEASURED] | `core/src/rewind_flow.rs:1`, `daemon-adapter/rewind_runtime/native.py:122`, `tools/microvm_scripted_scene.py:213`, `docs/ARM64_MICROVM_REWIND.md:3` [MEASURED] |
| **IPC transport enforces strict input ceilings** | Frame ceiling `1,048,576` B, JSON nesting depth `32`, string `65,536` B, object keys `256`, array items `4,096`, initial hello timeout `<= 5` s, later read timeout `<= 30` s [MEASURED] | `daemon-adapter/internal/ipc/config.go:20`, `core/src/transport/mod.rs:42` [MEASURED] |
| **Contracts-first wire discipline & `11`-leg offline gate** | `41` v0.2 schemas (`1,196` v0.2 fixtures) and `10` v0.1 schemas (`20` v0.1 fixtures) plus `40` Node E2E files, `6` Python E2E suites, and an `11`-leg unified offline gate [MEASURED] | `python3 tools/check_contracts.py`, `bash tools/gate.sh`, `bash tools/gate.sh --self-test` [MEASURED] |

---

## Why MetaViewer Matters in Agentic AI

Most computer-use harnesses hand an AI agent raw pointer or shell injection over a single display with no formal authority boundary when a frame goes stale, a human clicks the window, or a login/CAPTCHA wall appears. MetaViewer enforces `3` structural invariants [CITED: `docs/REFERENCE.md#engineering-triptych`]:

1. **Frame-Bound Admission (`STALE_FRAME` refusal):** An agent never injects raw input. It submits a closed `action_proposal/v0.2` bound to a specific `surface_id`, frame `generation`, and `sha256` digest (`core/src/admission/mod.rs:52`) [MEASURED]. If a newer frame arrives or ownership changes before dispatch, the Rust authority refuses the proposal with `STALE_FRAME` (`core/src/admission/mod.rs:1219`) [MEASURED].
2. **Instant Human Takeover & Explicit Handoff (`HUMAN_HANDOFF`):** Every surface is owned by either a **Human** or an **Agent**, never both simultaneously (`core/src/admission/mod.rs:99`) [MEASURED]. Clicking **Take control (emergency)** (`take_control` in `ui_intent/v0.2`) cancels in-flight agent proposals with `SURFACE_NOT_AGENT_CONTROLLED` and blocks new agent admission until `release_control` and a fresh frame generation (`core/src/admission/mod.rs:1124`) [MEASURED]. When a login wall, CAPTCHA, or bot check triggers a handoff notice (`ui/src/handoff/handoffModel.js:1`, exit code `4` [TARGET] in `docs/AGENT_ENTRY.md:100`), execution stops; acknowledging the banner only hides the notice and never resumes the workflow [MEASURED].
3. **Write-Ahead Cryptographic Session Journal (`mv-replay`):** Every admitted action, refusal (`STALE_FRAME`, `BUDGET_EXCEEDED`, `SURFACE_NOT_AGENT_CONTROLLED`, `POLICY`), and layout transition is fsynced to `<state_dir>/sessions/<session_id>/journal.jsonl` (`metaviewer.journal/v1`, `core/src/admission/mod.rs:1422`) before state publication [MEASURED]. The standalone `mv-replay` binary (`core/src/bin/mv-replay.rs:25`) verifies the SHA-256 chain (`rc 0`) and refuses corrupted records (`rc 2`), duplicate IDs (`rc 3`), and witness mismatches (`rc 4`) [MEASURED].

---

## Status

`VERSION` is **0.2.5** [MEASURED: `VERSION:1`], the checkout version (no version bump on this branch). Changes after the published `v0.2.5` pre-release are tracked in [Unreleased](CHANGELOG.md#unreleased) and [pending fragments](changes/unreleased/); see [the fragment workflow](changes/README.md) [CITED].

Verify this assembly with `bash tools/gate.sh` (`11` [MEASURED] legs: `manifests`, `laws`, `contracts`, `unit`, `agents`, `js`, `rust`, `go`, `ui`, `ui-smoke`, and `perf`) and `bash tools/gate.sh --self-test` (`tools/gate.sh:48`) [MEASURED]. Do not carry forward suite pass totals from an earlier commit; an offline gate pass does not establish live capsule frame rate or platform qualification [CITED: `docs/EVIDENCE.md`].

- **Contracts:** `10` v0.1 schemas (`20` v0.1 fixtures) and `41` v0.2 schemas (`1,196` v0.2 fixtures) [MEASURED: `contracts/v0.1/*.schema.json`, `contracts/v0.2/*.schema.json`, `contracts/examples/*.json`, `contracts/examples/v0.2/*.json`].
- **End-to-end journeys:** `40` Node journey files and `6` Python E2E suites [MEASURED: `tests/e2e/*.test.js`, `tests/e2e/test_*.py`]. Run `xvfb-run -a -s "-screen 0 1280x900x24" python3 tests/e2e/run.py` separately from the default gate [CITED: `tests/e2e/run.py`].
- **CI workflows:** `6` workflow files in `.github/workflows/` [MEASURED]; see [docs/TESTING.md](docs/TESTING.md) for the job matrix and local commands.

---

## Isolation and evaluation limits

<!-- IMAGE_SLOT: Add capsule catalog launcher showing isolated routes (identity-browser, program) alongside unisolated host routes (host-program, desktop-window) with explicit "not isolated" warnings -->
<!-- IMAGE_SLOT: Paired capsule terminal dock alongside the multi-tile wall showing task preparation buttons (Bootstrap, Create automation, Run automation, Direct task) -->

The launcher (`ui/src/catalog/catalogModel.js:118`, `ui/src/catalog/CatalogLauncher.vue:317`) offers `4` primary routes—`identity-browser`, `program`, `host-program`, and `desktop-window`—plus discovered host applications, while **ARM64 VM** and **ARM64 MicroVM** entries appear only when host capabilities admit them (`ui/electron/guestCommandProfile.js:47`) [MEASURED]:

- **Isolated Container Routes (`identity-browser`, `program`):** Driven through `mv-daemon-adapter` and the private and pre-existing `OpenSuperficies` runtime (`daemon-adapter/internal/capsule/manager.go:434`) [MEASURED]. Each `identity-browser` capsule offers **Open (default)** networking (requiring browser image `0.2.0` [CITED: `docs/INSTALL.md`], the operator firewall witness, and the Open-ready native pin) or an opt-in dedicated proxy with an exact hostname allowlist (`ui/src/netmode/NetworkPanel.vue`); legacy networking reaches no public site [CITED: `docs/JUDGE_QUICKSTART.md`].
- **Unisolated Host Routes (`host-program`, `desktop-window`):** `host-program` runs a local executable on the operator's computer via Xpra (`daemon-adapter/internal/capsule/host_xpra.go`) with a separate display and temporary RAM browser profile that do not create a sandbox; `desktop-window` attaches to an existing X11 window (`daemon-adapter/internal/capsule/host_window.go`) and can move the real pointer or raise the real window [MEASURED]. Both carry an explicit **not isolated** warning (`ui/src/surfaces/RoleSurface.vue:517`) [MEASURED].
- **Paired Terminal Task Preparation (No Saved Automation Run Claimed):** Clicking **Create automation**, **Run automation**, or **Direct task** prepares a prompt ending in `Task: ` bound to the target capsule identity (`llms.txt:16`, `docs/AGENT_ENTRY.md:105`) [CITED]. When paired with an installed, host-owned agent CLI profile that reaches a recognized input prompt within `15` seconds (`ui/src/terminal/agentPromptGate.js`), the terminal sends the text via bracketed paste **without sending Enter**; plain shells and unpaired controls remain copy-only [MEASURED]. **These controls prepare text only—they never execute a saved automation run** (`docs/JUDGE_QUICKSTART.md:271`), and stored browser workflows in the compiled `x64` evaluation runtime refuse with `MW_COMPILED_WORKFLOW_UNAVAILABLE` (`tools/mw_run_browser_goal.py:130`, `docs/JUDGE_QUICKSTART.md:335`) [MEASURED].
- **RAM Admission & Private Home:** Concurrent capsules are admitted against host RAM with a free-memory floor of `min(20 GiB, MemTotal / 4)` [TARGET; CITED: `docs/INSTALL.md#concurrent-identities-and-ram-admission`] (and `>= 6` GiB `MemAvailable` per **Add capsule** in `ui/electron/profilePicker.js`, otherwise refusing with `RAM_ADMISSION_REFUSED` [CITED: `docs/JUDGE_QUICKSTART.md:314`]). The gitignored `memoryweb/` directory (`MV_MW_HOME`) stores workflow/site data separately from browser profiles (`agents/metaviewer_agents/mw_home.py`) [MEASURED].
- **Evaluation Boundary:** The live wall and X11 attachment require a graphical session (`X11`, `XWayland`, `WSLg`, or `Xvfb` for headless smoke). Offline contract checks and hosted fakes do not prove live capsule execution. The [offline conversation fixture](docs/JUDGES.md) requires Node `>=24` and a local checkout of the private and pre-existing `wender-agent` component [CITED: `docs/JUDGES.md`].

---

## Rewind a Running arm64 MicroVM (Developer Setup Only)

<!-- IMAGE_SLOT: ARM64 MicroVM Guest commands panel and Rewind timeline showing Pause, Resume, Mark, header Back checkpoint selector, and Restore response (observed) in ms -->

On **`linux-arm64`** (`aarch64`) developer setups with KVM and verified local guest artifacts ([docs/ARM64_CAPSULE_SETUP.md](docs/ARM64_CAPSULE_SETUP.md), [docs/ARM64_MICROVM_REWIND.md](docs/ARM64_MICROVM_REWIND.md)), MetaViewer supports bounded guest command execution and live memory checkpoint **Rewind** inside a running **arm64 MicroVM** (`core/src/rewind_flow.rs:1`, `daemon-adapter/rewind_runtime/native.py:122`, `ui/src/components/GuestCommandPanel.vue:39`, `ui/src/components/RewindTimeline.vue:23`) [MEASURED]. **Graphical QEMU VM rewind is not supported or claimed** (`docs/REFERENCE.md:264`, `docs/ARM64_MICROVM_REWIND.md:7`), and **there is no VM or MicroVM on x64 in this release** (`ui/electron/guestCommandProfile.js:47`) [MEASURED].

1. **Seed Guest Workspace (`Generation 1`):** Inside the running **arm64 MicroVM** (`256` MiB guest RAM, `1` vCPU in `daemon-adapter/rewind_runtime/native.py:139` [MEASURED]), the scripted SDK demonstration (`tools/microvm_scripted_scene.py:25,213-220`) creates `./demo-files-<hex>` and seeds `3` [MEASURED] files (`notes.txt`, `photo.txt`, `plan.txt` → `Files: 3`).
2. **Mark Checkpoint in Bounded RAM Ring (`Mark`):** The operator labels a checkpoint and clicks **Mark** (`ui/src/components/RewindTimeline.vue:31`). The runtime waits for a quiescent guest command fence (`daemon-adapter/rewind_runtime/native.py:190`), pauses the **arm64 MicroVM**, and seals a full-memory `.state` + `.mem` snapshot into the bounded `2`-checkpoint (`len(self.points) >= 2`), `1` GiB (`1 << 30` bytes, `300` MiB free headroom) `/dev/shm` RAM ring (`daemon-adapter/rewind_runtime/native.py:203,207,220`) [MEASURED].
3. **Mutate Guest State (`Generation 2`):** A subsequent command deletes all `3` files (`rm ./demo-files-<hex>/{notes.txt,photo.txt,plan.txt}`) and confirms an empty workspace (`Files: 0`, `EMPTY` in `tools/microvm_scripted_scene.py:219,321`) [MEASURED].
4. **Restore via Header `Back` or `Rewind here` (`Generation 3`):** Selecting the checkpoint from the sticky header **Back** menu (`ui/src/components/GuestCommandPanel.vue:40-43`) or clicking **Rewind here** (`ui/src/components/RewindTimeline.vue:36`) restores the **arm64 MicroVM** memory snapshot (`daemon-adapter/rewind_runtime/native.py:250`), reseeds the guest session with a fresh challenge/nonce (`rewind_guest_reset/v0.2` at `daemon-adapter/rewind_runtime/native.py:258`), and advances authority to `Generation 3` where listing the directory immediately restores all `3` files (`Files: 3`, `CONTINUE` in `tools/microvm_scripted_scene.py:340`) [MEASURED].

- **Measured arm64 MicroVM Evidence & Sources:** A developer-controlled **arm64 MicroVM** packaged application at commit `8b44747c83f0ad760aed2550277aa88cd417fb30` completed real `Create`, guest commands, `Mark`, header `Back` restoration, `Pause`, `Resume`, and confirmed `Stop` with closed resources (`docs/ARM64_MICROVM_REWIND.md:3` [MEASURED]), backed by `17` audited `guest-command-broker` source/manifest/lock/test files (`docs/ARM64_CAPSULE_ASSET_NOTICES.md:27` [MEASURED]) and `21` locked registry crates (`docs/ARM64_CAPSULE_ASSET_NOTICES.md:36` [MEASURED]). The UI panel (`ui/src/components/GuestCommandPanel.vue:47`, `ui/src/wall/restoreDuration.js:40`) measures local `Restore response (observed)` from `Back` click to confirmed `Ready` in `0.1` ms increments up to a `60,000` ms ceiling [MEASURED]; a committed live millisecond figure is `ABSENT — do not invent` in this repository.
- **Containment & Scope of arm64 MicroVM Rewind:** Runs inside a dedicated `newton-ia.slice` cgroup enforcing `MemoryHigh=6 GiB`, `MemoryMax=8 GiB`, `pids.max=256`, `memory.swap.max=0`, `<= 2` CPUs, a `32` GiB host available-memory floor, and `1..10` s startup/stop deadlines (`daemon-adapter/rewind_runtime/native.py:33-36,123`, `daemon-adapter/rewind_runtime/config.py:24`) [MEASURED]. Rewind restores in-guest RAM workspace state only; it **never** undoes external network requests, host filesystem state, or the append-only authority journal (`docs/ARM64_MICROVM_REWIND.md:9,19`) [CITED].

---

## Save Slots for Stopped Identities

<!-- IMAGE_SLOT: Identities -> Stored data dialog showing named save slots on a stopped identity with Save, Overwrite, Load, Copy to a new capsule, and Delete slot actions -->

MetaViewer's **Identities → Stored data** dialog (`ui/src/identities/StoredDataSlots.vue`, `daemon-adapter/internal/capsule/slots/store.go`, `contracts/v0.2/capsule_state_request.schema.json:1`) manages named save slots (`Save`, `Overwrite`, `Load`, `Copy to a new capsule`, `Delete slot`) for **stopped** `browser` and `program` identities [MEASURED]:

- **What a Slot Saves:** Persistent profile data, cookies, and signed-in account sessions—**not** running processes, open browser tabs, or live VM memory (`docs/REFERENCE.md:117`) [CITED].
- **Stop-First Custody Gate:** Saving or loading while a capsule or its login view is active is refused (`Stop this capsule and close its login view before saving or loading` in `ui/src/identities/StoredDataSlots.vue:93`, `IDENTITY_PROTECTED` in `daemon-adapter/internal/capsule/slots/store.go:276`) [MEASURED].
- **Verified Compatibility & Credential Confirmation:** Loading or copying verifies kind (`browser` or `program`), CPU architecture, and container image compatibility (`COMPATIBILITY_REQUIRED` at `daemon-adapter/internal/capsule/slots/store.go:281-282`, `638`), validates payload SHA-256 digests and generation quotas, and requires explicit human confirmation before copying credential-bearing profiles (`CREDENTIAL_COPY_CONFIRMATION_REQUIRED` at `daemon-adapter/internal/capsule/slots/store.go:278-279`) [MEASURED]. Power-loss qualification on btrfs/WSL is `ABSENT — do not invent` (`daemon-adapter/internal/capsule/slots/store.go:7`) [MEASURED].

---

## Features

- **Three-Column Shell & Custom Snapping Grid (`ui/src/App.vue:148`, `ui/src/wall/WallWorkspace.vue:16`):** Left **Humans / Agents** ownership tree across virtual desktops (`Ctrl+1..9`), center live wall with presets (`1`, `2`, `2×2`, `3×2`, `Focus`, `Float`) and custom snapping grids (`1..5` floating cells per axis [MEASURED: `ui/src/wall/WallWorkspace.vue:16`]), and right paired terminal dock / capsule drawer (`@xterm/xterm` `6.0.0` + `node-pty` `1.1.0`, capped at `500×300` via `MAX_COLS = 500`, `MAX_ROWS = 300` in `ui/electron/ptyUtility.js`) [MEASURED].
- **Renderer Frame Port Painting (`frame_port/v1`, `frame_ack/v0.2`):** Preload (`ui/electron/preload.js:1`) forwards each surface stream's `MessagePort` once per stream; the renderer (`ui/src/frames/framePortRouter.js`, `ui/src/surfaces/SurfaceCanvas.vue`, `ui/src/surfaces/tileScheduler.js`) verifies shape, byte length, and SHA-256 digest, paints RGB24 pixels, and replies with `1` [MEASURED] `frame_ack/v0.2` (`PRESENTED`, `SUPERSEDED`, `FOLD_DRAIN`, `HIDDEN`, `CONTEXT_LOST`, `SURFACE_DESTROYED`, or `REFUSED`) [CITED: `ui/src/frames/framePortRouter.js`]. Optional diagnostics (`MV_FRAME_DIAG=1`) and QA anchors (`MV_QA_ANCHORS=1`) are off by default and refused in packaged retail runs [CITED: `ui/electron/frameDiag.js`, `ui/electron/qaAnchors.js`].
- **Wall Layout Intents & Nested Depth:** The Rust core (`core/src/serve/layout.rs:1`) admits and journals `7` [MEASURED] closed `ui_intent/v0.2` layout operations (`fold`, `unfold`, `move`, `tab`, `float`, `hide`, `show`), while `pin` remains UI-local. Nested capsules (`surface_request/v0.2` `create`) admit `nested_depth` `0` or `1` (`1` only for `metaviewer-nested` program entries, refused at `>= 2`) [MEASURED: `contracts/v0.2/surface_request.schema.json`, `core/src/catalog/mod.rs:15`].
- **Agent Loop & Private Pre-Existing Components (`agents/metaviewer_agents/`):** The Python agent loop (`verify.py`, `wender_bridge.py`, `planner.py`, `mw_run.py`) resolves the private and pre-existing `wender-agent` and `vision-engine` components through `deps.lock` (`resolve_locked_component`, refusing `commit_mismatch` before spawn) while keeping admission and execution authority in the Rust core [MEASURED: `agents/metaviewer_agents/wender_bridge.py`, `agents/metaviewer_agents/perception/vcore.py`].
- **RAM-First Capture & Deterministic Tar Export (`metaviewer.capture`):** Per-tile screenshots and RAM-first recordings (`core/src/record/capture.rs`, `core/src/serve/capture.rs`, `ui/src/recording/MvRecordingPanel.vue`) default to `3` [CITED] fps, accept `max_fps` `1..120` [CITED] with values `> 60` [CITED] refused as `BUDGET_EXCEEDED`, retain `1` frame per `1000/fps` [CITED] ms, journal `dropped_frames`, and export sealed recordings as deterministic PNG tar archives under `MV_RECORDING_DESTINATION` (`core/src/record/capture/export.rs`) [MEASURED].
- **Theme & Accessibility (`ui/src/settings/settingsModel.js`):** Defaults to `mv-dark` for new settings and switches between `mv-light` and `mv-dark` with WCAG AA contrast verified and `0` [MEASURED] bundled fonts (`tests/test_theme.py`).
- **Explicitly Refused / Not Available Yet:**
  - **Storyboard (`CREATIVE_SERVICE_UNAVAILABLE`):** Absent from live navigation (`ui/src/App.vue`, `ui/src/creative/CreativeCapsule.vue`) [MEASURED].
  - **General VM image/import manager, graphical QEMU rewind, and saved automation UI Run:** Not available; launcher offers `identity-browser`, `program`, `host-program`, `desktop-window`, and capability-gated arm64 guest entries (`ui/src/catalog/catalogModel.js:118`) [MEASURED].
  - **Direct core `observation` intake outside `mv_tool_call`:** Refused with a journaled `POLICY` verdict [CITED: `docs/ARCHITECTURE.md`].
  - **`100,000`-case nightly property gate & `G-NOVAC` meta-oracle:** Emit `BLOCKED` / `NOT_APPLICABLE` receipts in `.github/workflows/volume.yml` and `.github/workflows/ci.yml` (`ABSENT — do not invent`) [MEASURED].
  - **OS-level desktop installers (`.deb`, `.rpm`, Flatpak, AppImage) & native macOS/Windows builds:** Not supported (`build-macos` and `build-windows` emit `NOT_APPLICABLE` in `.github/workflows/ci.yml`) [MEASURED].

---

## Historical live evidence

<!-- IMAGE_SLOT: Recordings and screenshots panel showing a Sealed RAM recording ready for export and the reference-host ~2 fps (318 to 567 ms per frame) cadence note -->

These reported results predate the current assembly pins. The cited sources are external notes `holdings-e1/design/vision/live21_NOTE.md` and `live22_NOTE.md` (both dated `2026-10-28` [CITED]), outside this repository; their raw copies and raw `c26`/`c27` notes are `ABSENT — do not invent` in this repository (see [docs/EVIDENCE.md](docs/EVIDENCE.md)). Current-pin live wall fps and latency remain unmeasured here (`ABSENT — do not invent`), and the UI recording clock note discloses `~2` frames per second (`318` to `567` ms per frame [CITED: `ui/src/recording/recordingClock.js:42`]) on the reference host.

| Run | Core | Wall cadence | Core processing | Limiting stage |
| :--- | :--- | :--- | :--- | :--- |
| `live21` | debug | `2.71` fps over `61.0` s; `192` `PRESENTED` [CITED: external `live21_NOTE.md`, Frame cadence] | `52.11` ms p50, `58.67` ms p95 [CITED: external `live21_NOTE.md`, frame timings] | Historical capsule/adapter path [CITED] |
| `live22` | release | `2.58` fps over `61.2` s; `188` `PRESENTED` [CITED: external `live22_NOTE.md`, Cadence and stages] | `15.51` ms p50 [CITED: external `live22_NOTE.md`, core stage table] | Capsule capture ~`320` ms p50 [CITED: external `live22_NOTE.md`, adapter stage summaries] |

On `x64` WSL2 with the `v0.2.5` release package, maintainer evaluation ([docs/JUDGE_TOUR.md](docs/JUDGE_TOUR.md), raw repo receipt `ABSENT — do not invent`) reported: browser rules goals `10` of `10` [CITED: maintainer evaluation; raw receipt absent], Open network public site `HTTP 200` with LAN/Docker bridge blocked [CITED], isolated `program` (`gnome-calculator` as Agent) launch and typed `2+3` (`rc 0`, verdict `PROGRAM_TEXT_UNCERTIFIED_NOT_READABLE`) [CITED], `desktop-window` (`gedit`) attach/type/resize/close [CITED], login wall `HUMAN_HANDOFF` stop [CITED], and `JUDGE_STOP_CLEAN` [CITED]. Human `program` (`gedit`) closed with `XPRA_MODE_REFUSED` [CITED].

---

## Platform & x64 vs ARM64 Limits

MetaViewer is a **Linux** desktop application targeting **`linux-arm64`** (`aarch64`) as primary and supporting **`linux-x64`** (`x86_64`) [CITED: `ui/tools/package.js`, `.github/workflows/ci.yml`]. Native macOS and native Windows are unsupported; Windows uses a graphical Linux session under WSL2 + WSLg [CITED: `docs/JUDGE_QUICKSTART.md`]. **There is no VM or MicroVM on x64 in this release** (`ui/electron/guestCommandProfile.js:47`) [MEASURED].

| Capability / Route | `linux-x64` (`x86_64`) | `linux-arm64` (`aarch64`) | Windows (`WSL2` + `WSLg` Linux Session) |
| :--- | :--- | :--- | :--- |
| **Compiled Pre-Release Assets (`v0.2.5`)** | **Provided** (`SHA256SUMS` in GitHub release) [CITED] | **Not in `v0.2.5` release** (build from source + local assets) [CITED] | Uses `linux-x64` binaries inside Ubuntu `24.04` WSL2 [CITED] |
| **Desktop Wall, Rust Core & `mv-replay` (`T1`)** | Supported [MEASURED] | Supported [MEASURED] | Requires systemd + active WSLg/X11 display [CITED] |
| **Isolated `identity-browser` & `program` (`T2`)** | Configured; maintainer-reported on WSL2 (raw repo receipt `ABSENT — do not invent`) [CITED] | Configured; live repo receipt `ABSENT — do not invent` [CITED] | Requires rootful Docker Engine inside WSL2 (not Docker Desktop) [CITED] |
| **Graphical VM (`1280×900` fixed display)** | **Unavailable in this release** (`ui/electron/guestCommandProfile.js:47`) [MEASURED] | **Developer setup only** (`tools/arm64_capsules.py:324`, fixed `1280×900` at `tools/arm64_capsule_session.py:472`) [MEASURED] | **Unavailable in this release** (no x64 VM; Windows `10` WSL also lacks nested KVM) [CITED] |
| **arm64 MicroVM & Live RAM Rewind** | **Unavailable in this release** (no MicroVM on x64; disabled on non-ARM hosts at `ui/electron/guestCommandProfile.js:47`) [MEASURED] | **Developer setup only** (`daemon-adapter/rewind_runtime/native.py:122`, packaged proof at `8b44747c83f0ad760aed2550277aa88cd417fb30` in `docs/ARM64_MICROVM_REWIND.md:3`) [MEASURED] | **Unavailable in this release** [MEASURED] |
| **Unisolated `host-program` & `desktop-window`** | Available (**Not isolated**, requires `xpra`/`Xvfb`/`xauth`/`xdotool`) [CITED] | Available (**Not isolated**) [CITED] | Requires reachable X11 server in WSL2 (**Not isolated**) [CITED] |

---

## Architecture

```text
Electron 44.9.2 + Vue 3.5.43 Wall      Rust Authority Core               Go Daemon Adapter
(snapshots in, ui_intent/v0.2 out)     (admits, journals, serves)        (capsule & slot bridge)
        |                                          |                                |
        +--- envelope/v0.2 over NDJSON ------------+--- surface_request/event ------+
        |    core.sock + frame_port/v1 (RGB24)     |    core.sock (bounded IPC)     |
        |                                          |                                v
        |                                          |                  private and pre-existing OpenSuperficies
        |                                          |                  + arm64 MicroVM broker
        |                                          |                  (/dev/shm ramws, slots)
        |                                          |
        |                          Python Agent Loop (mvctl / mw_run / MCP)
        |                          private and pre-existing vision-engine + wender-agent
        |                          behind core admission
```

---

## Quickstart

### Prerequisites

| Tool / Component | Required Version & Pin |
| :--- | :--- |
| Rust toolchain | `1.97` [MEASURED: `Cargo.toml` `rust-version`] |
| Rust formatter | `1.92.0` [MEASURED: `tools/gate.sh:1757`] |
| Go toolchain | `1.26.0` [MEASURED: `daemon-adapter/go.mod`] |
| Node.js | `>=24` [MEASURED: `ui/package.json` `engines.node`] |
| Python | `>=3.11` [MEASURED: `agents/pyproject.toml`] |
| Capsule UI kit | `0.2.1`, commit `aaada9dedc177b096e8b4764959e258e76c1ef02` [MEASURED: `ui/kit.lock.json:1`]; set `CAPSULE_UI_KIT_REPO` |
| Electron dist | `44.9.2` [MEASURED: `ui/package.json:21`]; set `ELECTRON_OVERRIDE_DIST_PATH` |

The `3` [MEASURED: `deps.lock:1`] external runtime components pinned in `deps.lock` are **private and pre-existing** projects kept in separate closed repositories ([docs/PREEXISTING.md](docs/PREEXISTING.md), [NOTICE-EVALUATION.md](NOTICE-EVALUATION.md)):
- **Private and pre-existing `vision-engine`:** `v0.2.0` (`3bb54835db8a2e545311cfcc45185a0dfbd9313a`) [MEASURED: `deps.lock`] — perception (`vadapt.vserve` over `frame_raw`/`raw_shm` ring or one-shot `vadapt.cu_describe` in `agents/metaviewer_agents/perception/vcore.py`) [CITED].
- **Private and pre-existing `wender-agent`:** `v0.3.0` (`96120967b435b72fc6d29635f3844dae140388a9`) [MEASURED: `deps.lock`] — action planning (`wender.plan.cli` over the pipe-only observation/element-table/goal boundary in `agents/metaviewer_agents/wender_bridge.py`, required in `.github/workflows/assembly.yml` with `--require-planner`) [CITED].
- **Private and pre-existing `OpenSuperficies` (`opensuperficies` in `deps.lock`):** `os-cu-w9-mv1` (`3cb86d752f38457b6730eefd235d4da4c4039721`) [MEASURED: `deps.lock`] — isolated browser and program container backend (`srf-identity-surface`, `srf-identity-admin`, `srf-egress-proxy`) [CITED].

See [docs/INSTALL.md](docs/INSTALL.md) for the complete Linux (`arm64` and `x64`) installation, deterministic tarball packaging (`scripts/bootstrap.sh` and `ui/tools/package.js`), and troubleshooting reference.

### Build

Run from the clone root with `CAPSULE_UI_KIT_REPO` and `ELECTRON_OVERRIDE_DIST_PATH` exported and offline dependency caches populated in advance:

```sh
export CARGO_TARGET_DIR=$HOME/.cache/cargo-target/metaviewer
cargo build --offline -p metaviewer-core
go -C daemon-adapter build ./...
node tools/sync_kit.mjs "$CAPSULE_UI_KIT_REPO"
(cd ui && npm ci --offline && npm test && npm run check && npm run build)
```

### Run

```sh
# Core: config + runtime dir are mandatory (see core/src/bin/metaviewer-core.rs)
MV_CORE_CONFIG=/path/to/core.json XDG_RUNTIME_DIR=/run/user/$UID "$CARGO_TARGET_DIR/debug/metaviewer-core"
# Adapter: takes no arguments; configuration comes from the environment
go -C daemon-adapter run ./cmd/mv-daemon-adapter
# UI smoke (needs ELECTRON_OVERRIDE_DIST_PATH + xvfb-run)
(cd ui && npm run smoke)
# CLI probe: FILE is an action_proposal/v0.2 JSON object.
# Source the live attachment first. Select registered agent/core instances from
# MV_CORE_CONFIG and set MV_AGENT_INSTANCE, MV_CORE_INSTANCE, MV_CORE_SOCKET.
# MV_CORE_SOCKET is current.json's core_socket.
PYTHONPATH=agents python3 -m metaviewer_agents.mvctl propose --json-arg FILE --timeout-ms 5000 \
  --socket "$MV_CORE_SOCKET" --session-id "$MV_SESSION_ID" \
  --agent-instance "$MV_AGENT_INSTANCE" --core-instance "$MV_CORE_INSTANCE" \
  --max-line-bytes 65536 --max-reply-bytes 65536
# Hosted slice (no devices needed); --live needs the admitted capsule profile + env in tests/e2e/e2e1_slice/README.md
node tests/e2e/e2e1_slice/index.js
```

`mvctl observe` uses the current tool protocol by default; the optional leading `--v02` spelling selects the same protocol and is not a legacy repair. Observe also requires the registered bindings and `--surface-id` [CITED: `agents/metaviewer_agents/mvctl.py`]. Leave `MV_CAPTURE_RING` unset unless the private and pre-existing `OpenSuperficies` ring pin and host mount are ready (`MV_CAPTURE_RING=1` opts into `daemon-adapter/internal/frames/ringsource.go`) [CITED]. Use `MV_LIVE_WEB=1` only for the opt-in live web runner (`tests/e2e/e2e1_slice/asm_web_live.py`) [CITED].

### Checks

```sh
python3 tools/check_laws.py
python3 tools/check_laws.py --version
python3 tools/check_contracts.py
python3 -m unittest discover -s tests -v
bash tools/gate.sh                   # all 11 legs: manifests, laws, contracts, unit, agents, js, rust, go, ui, ui-smoke, perf
bash tools/gate.sh --leg contracts   # single leg
bash tools/gate.sh --self-test       # harness positive and negative controls
```

Secret scanning runs in `.github/workflows/secrets.yml` (pinned `gitleaks` `v8.18.4` history scan plus controls) [MEASURED: `tests/fixtures/secrets/gate.py`]. Enable the local commit hook before contributing:

```sh
git config core.hooksPath .githooks
```

---

## Repo map

| Path | Purpose |
| :--- | :--- |
| `README.md`, [docs/README.md](docs/README.md) | Project overview and ordered documentation index |
| [docs/REFERENCE.md](docs/REFERENCE.md), [docs/EVIDENCE.md](docs/EVIDENCE.md) | AI-first formal reference, engineering triptych, and public vs reported evidence guide |
| [docs/AI_OPERATOR_GUIDE.md](docs/AI_OPERATOR_GUIDE.md) | Complete AI and human operator guide for installing, configuring, and operating MetaViewer |
| [docs/JUDGE_QUICKSTART.md](docs/JUDGE_QUICKSTART.md), [docs/JUDGE_NO_DOCKER.md](docs/JUDGE_NO_DOCKER.md) | Packaged judge installation (`T2` with Docker and `T1` without Docker) |
| [docs/JUDGE_TOUR.md](docs/JUDGE_TOUR.md), [docs/JUDGE_TROUBLESHOOTING.md](docs/JUDGE_TROUBLESHOOTING.md) | Post-install tour, architecture support snapshot, and source-backed refusal remedies |
| [docs/ARM64_CAPSULE_SETUP.md](docs/ARM64_CAPSULE_SETUP.md), [docs/ARM64_MICROVM_REWIND.md](docs/ARM64_MICROVM_REWIND.md) | Developer-only local ARM64 VM setup and **arm64 MicroVM** RAM-ring rewind |
| [docs/INSTALL.md](docs/INSTALL.md), [docs/USER_GUIDE.md](docs/USER_GUIDE.md) | Linux (`arm64` and `x64`) build/packaging guide and operator manual |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/UI_ARCHITECTURE.md](docs/UI_ARCHITECTURE.md), [docs/TESTING.md](docs/TESTING.md) | Authority, IPC, capture, shared UI architecture, and `11`-leg gate specification [MEASURED] |
| [docs/DEMO_RUNBOOK.md](docs/DEMO_RUNBOOK.md), [docs/ROADMAP.md](docs/ROADMAP.md), [VM_MICROVM_ROADMAP.md](VM_MICROVM_ROADMAP.md) | Demo runbook, historical event plan, and VM/MicroVM acceptance roadmap |
| [docs/PREEXISTING.md](docs/PREEXISTING.md), [META_AI_USAGE.md](META_AI_USAGE.md) | Pre-existing work declaration and Meta model usage ledger (`3,538` lanes across `136` rooms [MEASURED: `docs/meta-ai/muse_lanes.json`]) |
| `LAWS.md`, [docs/COMMIT_LAWS.md](docs/COMMIT_LAWS.md), `VERSION`, `CHANGELOG.md`, `deps.lock` | Repository laws (`L1`–`L6`), release identity (`0.2.5` [MEASURED]), and private and pre-existing component pins (`wender-agent`, `vision-engine`, `OpenSuperficies`) |
| [contracts/v0.2/](contracts/v0.2/), `contracts/v0.1/`, `contracts/examples/` | `41` v0.2 schemas (`1,196` fixtures) and `10` v0.1 schemas (`20` fixtures) [MEASURED] |
| `core/` | Rust authority core (`metaviewer-core`, `mv-replay`) |
| `daemon-adapter/` | Go surface-daemon bridge (`mv-daemon-adapter`), slot store, and **arm64 MicroVM** rewind runtime |
| `agents/` | Python agent adapters, `mvctl`, `mw_run`, and MCP server |
| `ui/` | Electron `44.9.2` + Vue `3.5.43` desktop wall, frame port router, paired terminal, and capture panel [MEASURED: `ui/package.json`] |
| `tests/e2e/`, `tests/`, `tools/gate.sh` | `40` Node E2E journeys, `6` Python E2E suites, unit/judge suites, and unified `11`-leg offline gate [MEASURED] |
| `route/`, `router/`, `catalogue/` | Generated `route/route_query.py` code map and context-router data (contributor router remains declared unavailable in `AGENTS.md`) |

---

## Contributing, Pre-existing Work, Evaluation & License

- **Contributing:** Set both author and committer to the maintainer identity in [docs/COMMIT_LAWS.md](docs/COMMIT_LAWS.md) before committing. Components communicate only through versioned JSON contracts (`LAWS.md` `L3`) [CITED].
- **Pre-existing vs Built During the Event:** The runtime assembly (`core/`, `daemon-adapter/`, `agents/`, `ui/`, judge kit, and tests) was built during the event; the `v0.1` contract scaffold (`10` schemas, `20` fixtures), design notes, and the `3` **private and pre-existing** external components (`wender-agent`, `vision-engine`, and `OpenSuperficies`) predate it ([docs/PREEXISTING.md](docs/PREEXISTING.md)) [CITED].
- **Hackathon Judge Evaluation & License:** MetaViewer is licensed under the [GNU Affero General Public License v3.0 only](LICENSE) (`AGPL-3.0-only`), and `capsule-ui-kit` (`0.2.1` [MEASURED: `ui/kit.lock.json`]) is a separate public repository under `AGPL-3.0-only` [CITED]. The separate proprietary programs **`wender-agent`**, **`vision-engine`**, and **`OpenSuperficies`** are **private and pre-existing**: their repositories and source code are closed and are not covered by MetaViewer's AGPL. Under [NOTICE-EVALUATION.md](NOTICE-EVALUATION.md), the licensor (`oguirado`) permits hackathon judges to install, run, and evaluate their supplied compiled `x64` builds strictly for judging, without granting redistribution rights in those private and pre-existing components [CITED: `NOTICE-EVALUATION.md`].

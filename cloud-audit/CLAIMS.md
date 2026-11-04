# Documentation claims audit

Scope: `README.md`, `llms.txt`, `docs/USER_GUIDE.md`, `docs/JUDGE_QUICKSTART.md`,
`docs/JUDGE_TOUR.md`, `docs/INSTALL.md`, `docs/AGENT_ENTRY.md`,
`docs/ARM64_CAPSULE_SETUP.md`, `VM_MICROVM_ROADMAP.md`, checked against the code at
`origin/ci/assets-a7c36e9da`. Report only; no product code or docs were edited.

Severity: **high** = a judge can disprove it by trying it; **medium** = wrong but
needs code reading or a less common path; **low** = imprecise wording or citation.

## Summary

- Mismatches: 26 [MEASURED]: 11 high, 9 medium, 6 low.
- Clean: `llms.txt`, `docs/AGENT_ENTRY.md`, `docs/ARM64_CAPSULE_SETUP.md`.
- `docs/REFERENCE.md` spot check: 15 of 15 source coordinates hold [MEASURED]; one is
  only loosely anchored (see the end).
- Already correct across all docs: Storyboard is described as unavailable in live use.
  It renders only when `props.fixture` is set (`ui/src/App.vue:1831`), and live boot has
  no fixture. Apart from README.md:69, no audited doc presents **Use MetaViewer** as live.

## High

| # | Doc:line | Claim | Code | Replacement |
|---|---|---|---|---|
| H1 | `README.md:69` | "**Use MetaViewer** copies the exact prompt in AGENT_ENTRY.md…" | No control has that label. The label survives only in a comment (`ui/src/terminal/terminalDeckModel.js:52`), and tests assert it is gone (`tests/judge/test_v027_seams.py:262`). The prompt is copied by **🚀 Bootstrap** (`ui/src/terminal/TerminalDeckView.vue:1029-1037`, `ui/electron/buttonBridge.js:110`). | "**🚀 Bootstrap** in the terminal deck copies the exact prompt in [AGENT_ENTRY.md](docs/AGENT_ENTRY.md) for your chosen agent to run a stored workflow on an already running identity." |
| H2 | `README.md:39` | "`21` v0.2 schemas … `489` v0.2 fixtures [MEASURED]" | `ls contracts/v0.2/*.schema.json \| wc -l` = 41; `ls contracts/examples/v0.2/*.json \| wc -l` = 1194 [MEASURED]. | "I maintain `10` v0.1 schemas, `41` v0.2 schemas, `20` v0.1 fixtures and `1194` v0.2 fixtures [MEASURED: Python `Path.glob` over …same globs…]." |
| H3 | `README.md:100` | "`21` versioned JSON schemas [MEASURED: `ls -1 contracts/v0.2/*.schema.json \| wc -l`]" | The cited command returns 41 [MEASURED]. | "`41` versioned JSON schemas [MEASURED: `ls -1 contracts/v0.2/*.schema.json \| wc -l`] in `contracts/v0.2/` …" (rest unchanged) |
| H4 | `README.md:233` | "`21` versioned v0.2 JSON wire schemas" | Same as H3: 41 [MEASURED]. | "`41` versioned v0.2 JSON wire schemas [MEASURED: `ls -1 contracts/v0.2/*.schema.json \| wc -l`]" |
| H5 | `docs/INSTALL.md:153` | "the `21` [MEASURED: ls -1 contracts/v0.2/*.schema.json \| wc -l] versioned v0.2 JSON wire schemas" | Same as H3: 41 [MEASURED]. The whole directory is packaged (`ui/tools/package.js:2986`). | "`MetaViewer-linux-<arch>/resources/contracts/v0.2` — the `41` [MEASURED: ls -1 contracts/v0.2/*.schema.json \| wc -l] versioned v0.2 JSON wire schemas." |
| H6 | `docs/INSTALL.md:598-609` | "**Automate from a demo** opens the recording dialog. **Start** invokes…" | The menu item was removed. `DemoDialog` is still mounted (`ui/src/App.vue:1936`), but `demoOpen` is only set from test hooks (`ui/src/App.vue:1783,1787`), so a user cannot open it. README.md:71-72 already says "There is no menu action". | "The demo recording dialog has no menu entry in this release; run `tools/mv_demo.py record`, `prompt` and `check` directly from an operator checkout." |
| H7 | `docs/USER_GUIDE.md:191` (also 193-206, 248) | "I open the multislot screen with **Open in multislot** and return with **Back to wall**." | No "Open in multislot" label exists in `ui/src` or `ui/electron`. `multislotOpen` becomes true only from a fixture (`ui/src/App.vue:250`) or from `openMultislot()` (`ui/src/App.vue:1339-1345`), which only the bench hook exposes (`ui/src/App.vue:1316,1783,1787`). The recording panel is mounted only inside multislot (`ui/src/App.vue:1907-1916`). | "The multislot screen and its recording panel are not reachable from the live wall in this release; record and screenshot from the capsule header buttons (**Record**, **Screenshot**)." |
| H8 | `docs/USER_GUIDE.md:193,206,210` | Buttons named "**Take screenshot**" and "**Save recording**" | The labels are "Screenshot" (`ui/src/recording/recordingModel.js:459`) and "Export" / "Exporting" / "Exported" (`ui/src/recording/recordingModel.js:254,262`). Neither doc string appears in the UI. | "…in-RAM PNG screenshots (**Screenshot**). Exporting to disk (**Export**, which writes a `ustar` archive…)" |
| H9 | `docs/JUDGE_TOUR.md:168` | "…and the app's **Copy env path** to identify the actual running capsule." | No UI control has that label; the string exists only inside prompt text (`ui/src/terminal/workflowPrompts.js:9`). The app prints `METAVIEWER_ATTACH <path>` to stdout (`ui/tools/package.js:1591`), and that line appears in the terminal running `metaviewer-judge.sh run` (`scripts/judge/metaviewer-judge.sh:709`). | "Use the capsule **ID** / **Copy ID for AI** to identify the running capsule, and the `METAVIEWER_ATTACH <path>` line that the app prints in the terminal running `metaviewer-judge.sh run` (normally `$XDG_RUNTIME_DIR/metaviewer/attach/current.env`) to find its attachment." |
| H10 | `docs/JUDGE_TOUR.md:179` | "Replace the attachment placeholder with **Copy env path** from the running app." | Same as H9. | "Replace the attachment placeholder with the path from the `METAVIEWER_ATTACH` line printed in the terminal running `metaviewer-judge.sh run`." |
| H11 | `docs/JUDGE_QUICKSTART.md:280` | "`MemAvailable >= floor + 512 MiB` hard minimum, i.e. `4.5 GiB` on a 16 GiB machine [MEASURED]" | Preflight passes at that value (`scripts/judge/preflight.sh:294-299`), but each **Add capsule** is refused below 6 GiB free memory with `RAM_ADMISSION_REFUSED` (`ui/electron/profilePicker.js:22-24`). Preflight warns about this itself (`scripts/judge/preflight.sh:300-301`). The 4.5 GiB figure comes from a formula, not a measurement. | "`MemAvailable >= floor + 512 MiB` is the install/doctor minimum (`4.5 GiB` on a 16 GiB machine [TARGET]); each **Add capsule** additionally needs at least `6` GiB MemAvailable [CITED: `ui/electron/profilePicker.js`] or it refuses with `RAM_ADMISSION_REFUSED`." |

## Medium

| # | Doc:line | Claim | Code | Replacement |
|---|---|---|---|---|
| M1 | `docs/JUDGE_TOUR.md:165-167` | Buttons only copy prompts; "Automatic insertion is withheld until the host can attest the foreground agent input target." | With a matching paired terminal, the button offers an installed agent profile and launches it (`ui/src/terminal/TerminalDeckView.vue:257-275`). It then pastes the prompt without Enter once the input prompt is seen, or gives up after 15 s (`ui/src/terminal/terminalDeckModel.js:1729-1747`). Copy-only applies only when there is no pair (`ui/src/terminal/TerminalDeckView.vue:258`). This also contradicts `docs/JUDGE_QUICKSTART.md:234-236`. | "With a paired terminal, each button asks for an installed agent profile, launches it, and pastes the prompt ending in `Task: ` without Enter once the agent's input prompt is seen (or refuses after `15` seconds [CITED: `ui/src/terminal/agentPromptGate.js`]); add your task and submit it. Without a matching pair, the prompt is copied only." |
| M2 | `VM_MICROVM_ROADMAP.md:22` | "…it does not add a VM-specific public method or channel." | The preload exposes `authority.vmAvailable` (`ui/electron/preload.js:952,1204`) over its own channel, `metaviewer:authority.vmAvailable` (`ui/electron/authorityWire.js:6,44`). | "VM creation reuses the existing `createSurface` method and channel; the only VM-specific addition is the read-only `authority.vmAvailable` boolean query (`metaviewer:authority.vmAvailable`)." |
| M3 | `docs/USER_GUIDE.md:193` | Capture "bounded at `16` MiB and `4096` frames in RAM" | The RAM limits are 8 MiB per ring and 64 MiB total (`core/src/record/capture.rs:1-2,7-8`). 16 MiB and 4096 frames are limits on the exported archive (`core/src/record/capture/export.rs:2-3,61`). | "…bounded at `8` MiB [TARGET] per recording ring and `64` MiB [TARGET] retained pixels in RAM; an exported archive is limited to `16` MiB [TARGET] and `4096` [TARGET] frames." |
| M4 | `docs/USER_GUIDE.md:116`, `:247` | Refusal code "`nested_depth_exceeded` / `NESTED_DEPTH`" | `nested_depth_exceeded` appears nowhere in the code. Core refuses with `CatalogError::NestedDepth` (`core/src/catalog/mod.rs:44,56-59,116-117`), the UI uses `NESTED_DEPTH` (`ui/src/nested/nested.js:57,71`), and the schema sets `maximum: 1` (`contracts/v0.2/surface_request.schema.json:54-57`). | Line 116: "Any `nested_depth >= 2` is refused by the schema (`maximum: 1`) and by core catalog admission (`NestedDepth`); the UI reports `NESTED_DEPTH`." Line 247: replace "(`nested_depth_exceeded`)" with "(`NESTED_DEPTH`)". |
| M5 | `docs/USER_GUIDE.md:175` | `mvctl` connects "over `--socket` (default `$XDG_RUNTIME_DIR/metaviewer/core.sock`)" | `--socket` is `required=True` with no default (`agents/metaviewer_agents/mvctl.py:411-412`), and the parser also has `list`, `record-start` and `record-stop` (`agents/metaviewer_agents/mvctl.py:409-410`). | "With `--v02`, it speaks the v0.2 protocol (`observe`, `list`, `propose`, `wait-verify`, `record-start`, `record-stop`) over a required `--socket` path (normally `$XDG_RUNTIME_DIR/metaviewer/core.sock`)." |
| M6 | `docs/INSTALL.md:329` | `mv-pkg-*` isolates "`XDG_RUNTIME_DIR`, `XDG_STATE_HOME`, and `XDG_CONFIG_HOME`" | `resolvePackagedConfigHome` keeps the user's `$XDG_CONFIG_HOME` or `~/.config` (`ui/tools/package.js:507-522,1446`). Only runtime and state point into `mv-pkg-*` (`ui/tools/package.js:1468-1470`). | "Created mode `0700` on packaged startup to hold the private `XDG_RUNTIME_DIR` and session `XDG_STATE_HOME`, removed when the app exits; `XDG_CONFIG_HOME` stays the user's persistent config home (`$XDG_CONFIG_HOME` or `~/.config`)." |
| M7 | `docs/INSTALL.md:326` | Settings are "closed `{scheme, density}` JSON (`mv-light` / `mv-dark`, `compact`)" | The closed key set is `scheme, density, wallFps, recordingFps` (`ui/electron/authorityWire.js:13,369`), and density also accepts `comfortable` (`ui/electron/authorityWire.js:533`). | "closed `{scheme, density, wallFps, recordingFps}` JSON (`mv-light`/`mv-dark`, `compact`/`comfortable`; defaults `mv-dark`, `compact`, `30`, `3` [CITED: `ui/electron/authorityWire.js`])." |
| M8 | `docs/INSTALL.md:43`, `:403` | Images named without an arch suffix; Open "requires … `opensuperficies-identity-browser-arm64:0.2.0`" | Tags always carry `-x64` or `-arm64` (`tools/build_release_assets.py:442-447`, `daemon-adapter/internal/capsule/slots_bridge.go:64-72`, `tools/mv_identity.py:241-245`). Line 403 tells an x64 judge to use an arm64 image. | Line 43: "(`opensuperficies-identity-browser-<arch>:0.1.1`, `opensuperficies-program-host-<arch>:0.1.0`, `opensuperficies-desktop-<arch>:1.1.0`, where `<arch>` is `x64` or `arm64`)." Line 403: "Open requires the operator-built `opensuperficies-identity-browser-<arch>:0.2.0` image (`x64` or `arm64`)…" |
| M9 | `docs/INSTALL.md:33`, `:529-535` | Reclaim is blocked only by the matching `srf-id-/srf-pg-/srf-vm-<profile>` containers; only `srf-ng-hcap-*` keeps all reservations | `tools/mv_ram_admission.py` is stricter. Any `srf-id-*` container blocks every record (`tools/mv_ram_admission.py:63`). Legacy records are blocked by any `srf-id-`/`srf-pg-`/`srf-vm-` name (`tools/mv_ram_admission.py:25,65-66`). Any `xpra*`/`Xvfb` process also blocks reclaim (`tools/mv_ram_admission.py:72-81`). | "Any `srf-id-*` or `srf-ng-hcap-*` container, or any running `xpra*`/`Xvfb` host process, conservatively keeps all reservations; named records additionally require absence of `srf-pg-<profile>` and `srf-vm-<profile>`, and legacy hash-only records require absence of every `srf-id-*`, `srf-pg-*` and `srf-vm-*` container." |

## Low

| # | Doc:line | Claim | Code | Replacement |
|---|---|---|---|---|
| L1 | `docs/JUDGE_QUICKSTART.md:221` | "create virtual desktops (`+`, `Ctrl+1..9`)" | `Ctrl+1..9` only switches to existing desktops (`ui/electron/desktopShortcuts.js:11`, `ui/src/wall/DesktopWorkspace.vue:158-161,247`). | "create virtual desktops with `+` and switch between existing ones with `Ctrl+1..9`" |
| L2 | `docs/JUDGE_QUICKSTART.md:337-338` | "The launcher … verifies `EGRESS_PROXY_READY`" | The launcher only checks the exit status of `srf-identity-surface net up` (`scripts/judge/metaviewer-judge.sh:550-554`). The string `EGRESS_PROXY_READY` appears nowhere in the repository code. | "The launcher runs the kit's `srf-identity-surface net up` with those private paths and refuses if it fails; it does not replace an existing incompatible proxy." |
| L3 | `docs/USER_GUIDE.md:97` | Activity count shown as "`showing 8 of N`" | The rendered text is `latest ${visible} of ${all}` (`ui/src/activity/activityModel.js:217`). | "…alongside the total live event count (`latest 8 of N`)…" |
| L4 | `docs/INSTALL.md:42-43` | "`floor + 512 MiB` admission minimum" (`4.5 GiB` on 16 GiB) | The daemon checks `available >= floor + 512 MiB × live`, where `live` counts existing reservations only (`daemon-adapter/internal/daemon/ram_admission.go:88-89,151,159`). The UI's separate 6 GiB per-create check applies too (see H11). | "the first capsule needs `MemAvailable` ≥ min(20 GiB, 25 % of `MemTotal`) and at least `6` GiB free [CITED: `ui/electron/profilePicker.js`]; each further capsule adds 512 MiB per running incumbent." |
| L5 | `docs/INSTALL.md:547` | "(exact hostnames, one per line)" | The field says "Exact hostnames, separated by commas or spaces (1–256)" (`ui/src/netmode/NetworkPanel.vue:58`), and the parser splits on `/[\s,;]+/` (`ui/src/netmode/networkCopy.js:97`). | "(exact hostnames separated by commas or spaces, 1–256)." |
| L6 | `README.md:82-85` | "`MV_MW_HOME` selects an admitted alternative", citing `agents/metaviewer_agents/mw_home.py` | `mw_home.py` never reads `MV_MW_HOME` (`agents/metaviewer_agents/mw_home.py:43`); `mw_run.py` does (`agents/metaviewer_agents/mw_run.py:201`). | Add `agents/metaviewer_agents/mw_run.py` to the `[CITED: …]` list on that line. |

## Clean documents

- `llms.txt`: all labels, the Storyboard statement, x64/arm64 scope and Recording card match the code.
- `docs/AGENT_ENTRY.md`: the prompt is served from this file (`ui/electron/buttonBridge.js:110`). The labels Create automation / Run automation / Direct task match (`ui/src/terminal/TerminalDeckView.vue:1047`). The paste is bracketed and never sends Enter, with a `15000` ms wait (`ui/src/terminal/agentPromptGate.js:4`). Agent profiles are codex, gemini and opencode (`ui/electron/agentProviders.js`).
- `docs/ARM64_CAPSULE_SETUP.md`: verbs, flags, limits (6G/8G, 200% CPU, TasksMax 256, 32 GiB floor) and the arm64-only gate match `tools/arm64_capsules.py`, `tools/arm64_capsule_session.py` and `daemon-adapter/rewind_runtime/native.py:124`.

## Outside the audited docs (no action requested)

- `ui/src/terminal/terminalDeckModel.js:52`: a code comment still names the removed **Use MetaViewer** button.
- `ui/src/terminal/workflowPrompts.js:9`: prompt text sent to agents tells them to use "the running app's Copy env path", which is not a UI control. This is the same root issue as H9.

## docs/REFERENCE.md spot check (15 coordinates)

All 15 hold: each cited line or its immediate context supports the claim.

| REFERENCE line | Coordinate | Holds |
|---|---|---|
| 32 | `tools/gate.sh:1732` (tool discovery) | yes |
| 33 | `scripts/judge/preflight.sh:177` (arch refusal) | yes |
| 34 | `daemon-adapter/internal/daemon/environment.go:115` (absolute env paths) | yes |
| 35 | `ui/electron/guestCommandProfile.js:47` (`arch==='arm64'`) | yes |
| 74 | `core/src/serve/mod.rs:223` (`Server::open`) | yes, loosely: it anchors the server entry, not the outputs it lists |
| 77 | `ui/src/surfaces/RoleSurface.vue:517` ("not isolated" badge) | yes |
| 88 | `core/src/catalog/mod.rs:15` (`Kind` enum: five kinds) | yes |
| 103/108 | `daemon-adapter/internal/capsule/slots/store.go:271` (`IDENTITY_PROTECTED`, human confirmation) | yes |
| 113 | `daemon-adapter/rewind_runtime/native.py:122` (ARM64 Linux required) | yes |
| 118 | `ui/src/wall/WallWorkspace.vue:16` (1..5 cells) | yes |
| 125 | `daemon-adapter/internal/ipc/config.go:20` (1048576 / 32 / 65536 / 256 / 4096) | yes |
| 130 | `daemon-adapter/internal/ipc/config.go:23` (hello ≤ 5 s) | yes |
| 133 | `core/src/transport/mod.rs:42` (read deadline) | yes |
| 177 | `ui/electron/main.js:330` (`createWindowOptions`, context isolation) | yes |
| 182 | `daemon-adapter/cmd/mv-daemon-adapter/main.go:24` (`RuntimeFromEnv`) | yes |

Router check: `python3 tools/router_index.py --check` passed (`METAVIEWER_ROUTER_COVERAGE 100%`).

---
Auditor: Claude (Anthropic), Claude Code cloud session; reasoning effort: low.

# Recursive demo script: "the program inside the program"

Status: draft concept for my recursive demo video [TARGET]. For the live single-capsule runbook and `8/8` [MEASURED] agent-drive walkthrough that run today, see [DEMO_RUNBOOK.md](DEMO_RUNBOOK.md) and [DEMO_AGENT_SCRIPT.md](DEMO_AGENT_SCRIPT.md).
Language of the video: my choice at recording time; this script is in English.

## 1. Premise [TARGET]

The viewer watches me or an agent use MetaViewer: open capsules, fold one, hand a task to an AI terminal, record a slot [TARGET].
At the end the camera pulls back. Everything the viewer saw was an **inner MetaViewer instance running inside a capsule of an outer MetaViewer** [TARGET], operated by an AI from the attached terminal of that capsule's multislot [TARGET].
The reveal is the message: *every program, MetaViewer included, becomes AI-manageable once it lives in a capsule.*

Honesty rule: nothing is faked or pre-rendered. Every shot in a sealed production take must be a live capture of real software (`tests/test_video_seal.py`). Today, live evidence covers `1` [MEASURED] `mv-live-1` browser capsule (`1280x900` [MEASURED]) streaming at `2.71` fps [MEASURED] (`192` [MEASURED] `PRESENTED` deliveries, `0` [MEASURED] refused, core `52.11` ms [MEASURED] p50 per frame) and the `8/8` [MEASURED] single-capsule agent-drive loop (`docs/DEMO_AGENT_SCRIPT.md`); the multi-capsule (`3` capsules [TARGET]) and functional-inner-MetaViewer shots below remain `[TARGET]`.

## 2. Cast (components)

| Role | Component | State today |
|---|---|---|
| Outer program | MetaViewer (Electron + Rust authority core, shared capsule UI kit) | Wall, multislot host, side terminal overlay, and Rust authority core are built (`ui/`, `core/`); stages `capsule-ui-kit` `0.2.1` [CITED: ui/kit.lock.json] and streams `1` [MEASURED] live browser capsule (`mv-live-1`) at `2.71` fps [MEASURED] ([DEMO_RUNBOOK.md](DEMO_RUNBOOK.md)) |
| Capsule backend | OpenSuperficies (Go surface daemon: isolated displays/VMs, streaming, control) | Pinned in `deps.lock` (`opensuperficies` `os-cu-w9-mv1` [CITED: deps.lock]); the Go daemon adapter (`daemon-adapter/`) is implemented and drives the live `mv-live-1` capsule ([DEMO_RUNBOOK.md](DEMO_RUNBOOK.md)) |
| Inner program | A second MetaViewer instance launched inside one capsule | `--nested-depth=1` is implemented as a display-only nested shell guard (`ui/electron/nesting.js`, `contracts/v0.2/surface_request.schema.json`); a functional inner instance with its own core, capsules, and terminal is `[TARGET]` |
| AI hands | wender-agent (input) + vision-engine (perception), RAM-only | Pinned in `deps.lock` (`vision-engine` `v0.2.0`, `wender-agent` `v0.3.0` [CITED: deps.lock]) and wired into the live agent loop (`tools/gate_g_ai.py`, `tests/e2e/e2e1_slice/demo_agent_drive.py`, verified `8/8` [MEASURED] live on `mv-live-1` with `24` [MEASURED] vision marks); Holdings training data note is `ABSENT — do not invent` |
| AI brain | A provider CLI in the multislot terminal | Side terminal overlay (`ui/src/terminal/SideTerminalOverlay.vue`, `ui/electron/terminalHost.js`, `ui/electron/ptyBroker.js`, `ui/electron/ptyUtility.js`) is wired in code; live login-shell and provider-CLI driving of an inner instance remain `[TARGET]` |
| Semantic lane (optional) | agent_lane/v1: stable ids, roles, accessible names, control registry, socket | Implemented in `ui/src/agent/agentLane.js` (`agent_lane/v1` [CITED: ui/src/agent/agentLane.js]); Holdings probe count is `ABSENT — do not invent` |

## 3. Shot list (concept [TARGET], target length 2:30 to 3:00 [TARGET])

Shots `1`–`7` below specify the `[TARGET]` recursive inner/outer filming sequence (multi-capsule wall and functional inner MetaViewer instance are `[TARGET]`, not claimed as live today):

| # | Time | Picture (what the viewer sees) | Voice-over / caption idea | What really happens |
|---|---|---|---|---|
| 1 | 0:00-0:10 | Clean MetaViewer wall, light theme, three capsules (a browser, a game, a terminal app) [TARGET] | "This is MetaViewer: every app in its own live capsule." | Full-screen capture of the INNER instance's surface [TARGET] |
| 2 | 0:10-0:35 | Cursor opens "New Capsule", picks a browser, places it as a split [TARGET] | "Open anything. Place it anywhere." | The AI drives the inner instance via vision-engine + wender [TARGET] |
| 3 | 0:35-1:05 | A capsule folds to its rail, another goes to floating, the right terminal panel slides over without resizing anything [TARGET] | "Fold, float, hide. Nothing you are running is disturbed." | Same; overlay panel proves no reflow [TARGET] |
| 4 | 1:05-1:40 | In a multislot, I copy the capsule ID, the terminal shows a provider CLI receiving "drive capsule cap-… and fill the form" [TARGET] | "Talk to an AI in the capsule's own terminal." | Inner-level multislot; this is the only nested-AI moment shown on purpose [TARGET] |
| 5 | 1:40-2:00 | Record for AI chip turns red, a short demo is captured, input mode flips WRITE for one corrective click, back to READ [TARGET] | "Teach it. Nudge it. It keeps working." | READ/WRITE input mode; wender logs the nudge as guidance [TARGET] |
| 6 | 2:00-2:20 | Slow zoom out: the whole screen shrinks into a capsule tile on a larger wall; the outer terminal shows the AI's log of every action just seen [TARGET] | "Everything you just watched..." | Switch to the OUTER instance's real screen capture; the inner surface is one capsule [TARGET] |
| 7 | 2:20-2:40 | My hand is off the mouse; the outer multislot shows READ mode and the AI transcript scrolling [TARGET] | "...was an AI using MetaViewer, inside MetaViewer." | Real outer capture [TARGET] |
| 8 | 2:40-3:00 | Title card: MetaViewer — "Every app becomes AI-manageable. I built it solo." | Closing line | Static card |

Optional cold-open alternative: start with shot 6 reversed (zoom in from the outer wall into the inner surface), then reveal again at the end.

## 4. Technical setup [TARGET]

1. **Outer instance**: normal MetaViewer on the host display at `1920x1080` [TARGET]; capsule wall with one large multislot (surface on the left, terminal attached on the right).
2. **Inner instance**: launched by OpenSuperficies inside an isolated capsule surface at `1280x720` [TARGET] (today `--nested-depth=1` in `ui/electron/nesting.js` is display-only; a full inner core/capsule/terminal stack is `[TARGET]`).
   - Own user-data directory, own sockets and ports, own session; no shared state with the outer instance.
   - Nesting flag (`--nested-depth=1`): the inner instance never auto-opens a capsule of itself and refuses depth `>= 2` [CITED: contracts/v0.2/surface_request.schema.json] (no infinite recursion).
   - Seeded demo workspace (deterministic layout, fixture capsules) so takes are repeatable [TARGET].
3. **AI wiring**: in the outer multislot terminal, the provider CLI receives the inner capsule ID (Copy capsule ID) [TARGET]. It drives the inner surface with `vision-engine` (perception) + `wender-agent` (input), optionally the inner `agent_lane/v1` socket for exact control targeting [TARGET]. Engines stay RAM-only.
4. **Capture**: two simultaneous recordings [TARGET], the inner surface stream (shots 1-5) and the outer host screen (shots 6-7); the `ffmpeg x11grab` host screen recorder runs at `30` fps [TARGET] ([DEMO_RUNBOOK.md](DEMO_RUNBOOK.md)), whereas live capsule tile delivery today measures `2.71` fps [MEASURED] on `1` [MEASURED] `1280x900` [MEASURED] capsule (`52.11` ms [MEASURED] core p50 per frame; multi-capsule soak to `>= 4` [TARGET] capsules at `>= 10` [TARGET] fps for `10` min [TARGET] is still open — I never conflate the `30` fps [TARGET] recorder with live tile fps).
5. **Recording to disk**: only the screen recorder of the video production writes disk unless `MV_RECORDING_DESTINATION` is configured for explicit journaled `.tar` export ([DEMO_RUNBOOK.md](DEMO_RUNBOOK.md)).

## 5. Build checklist (what must exist before filming the recursive concept)

| # | Item | Owner | Status / Gate |
|---|---|---|---|
| B1 | Overlay right terminal (`SideTerminalOverlay.vue`, `terminalHost.js`, `ptyBroker.js`, `ptyUtility.js`) | `ui/` | Wired in code; live login-shell + provider-CLI session proof `[TARGET]` |
| B2 | AI multislot in the kit (surface + attached terminal, controls, `READ`/`WRITE`) | `ui/src/multislot/` | Built; `READ` no-scroll (`0` [MEASURED] input ops) and `WRITE` human bursts (`80` and `20` ms/key [MEASURED], `0` [MEASURED] lost chars) verified live on `mv-live-1` |
| B3 | MetaViewer app shell on the kit (wall, New Capsule, multislot host) | `ui/`, `core/` | Built and gated by `tools/gate.sh` |
| B4 | OpenSuperficies adapter in MetaViewer (surface stream, input, ids) | `daemon-adapter/` | Built; verified live on `1` [MEASURED] `mv-live-1` capsule (`2.71` fps [MEASURED], `192` [MEASURED] `PRESENTED` frames, `0` [MEASURED] refused) |
| B5 | Nesting flag + isolated inner profile | `ui/electron/nesting.js`, `core/` | `nested_depth: 1` admitted for `metaviewer-nested` and depth `>= 2` refused (`tests/e2e/e2e19_nested.test.js`); functional inner core/capsule/terminal `[TARGET]` |
| B6 | AI task script for shots 2-5 (prompts for the provider CLI driving an inner instance) | operator | `[TARGET]` (single-capsule `demo_agent_drive.py` passes `8/8` [MEASURED] live; see [DEMO_AGENT_SCRIPT.md](DEMO_AGENT_SCRIPT.md)) |
| B7 | Dual inner+outer capture rig (synced) | operator | `[TARGET]` (single-stack `--record <path.mp4>` verified in [DEMO_RUNBOOK.md](DEMO_RUNBOOK.md)) |

## 6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Nested streaming lag makes the inner UI look slow | Inner at `1280x720` [TARGET], compact density; film the inner stream directly, not the outer tile |
| AI hesitates or misclicks on camera | Seeded workspace, rehearsed prompts, `WRITE`-mode nudge is part of the story (shot 5) [TARGET] |
| Recursion or socket clash | Nesting flag and isolated profile (B5) |
| Viewers think it is faked | Seal every program shot to hash-chained `metaviewer.journal/v1` records (`tests/test_video_seal.py`) and publish the raw takes |
| Brand confusion | Style follows the design reference without any brand names or logos (system font) |

## 7. Next steps

1. Review this recursive concept script alongside the live single-capsule runbook ([DEMO_RUNBOOK.md](DEMO_RUNBOOK.md)) and `8/8` [MEASURED] agent-drive script ([DEMO_AGENT_SCRIPT.md](DEMO_AGENT_SCRIPT.md)).
2. Complete functional inner-instance wiring (`B5` beyond display-only `--nested-depth=1`) and live login-shell provider driving (`B1`, `B6`) [TARGET].
3. Rehearse and seal dual inner/outer capture takes (`B7`) with `tests/test_video_seal.py` [TARGET].

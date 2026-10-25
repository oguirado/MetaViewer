# Recursive demo script: "the program inside the program"

Status: draft for the operator [TARGET]. Hackathon video concept (operator GO; details in the private run log).
Language of the video: the operator's choice; this script is in English.

## 1. Premise

The viewer watches someone use MetaViewer: open capsules, fold one, hand a task to an AI terminal, record a slot.
At the end the camera pulls back. Everything the viewer saw was an **inner MetaViewer instance running inside a capsule of an outer MetaViewer**, operated by an AI from the attached terminal of that capsule's multislot.
The reveal is the message: *every program, MetaViewer included, becomes AI-manageable once it lives in a capsule.*

Honesty rule: nothing is faked or pre-rendered. Every shot is a live capture of real software. The "illusion" is only the framing: the first two minutes are shown full-screen from the inner instance's surface.

## 2. Cast (components)

| Role | Component | State today |
|---|---|---|
| Outer program | MetaViewer (Electron + Rust authority core, shared capsule UI kit) | Kit exists (shell, capsules, overlay terminal, multislot in build) [CITED: capsule-ui-kit]; product assembly starts at kickoff [CITED: README.md] |
| Capsule backend | OpenSuperficies (Go surface daemon: isolated displays/VMs, streaming, control) | Exists as its own repo; MetaViewer adapter [TARGET] |
| Inner program | A second MetaViewer instance launched inside one capsule | [TARGET] (needs the nesting flag below) |
| AI hands | wender-agent (input) + vision-engine (perception), RAM-only | Exist; trained on Holdings capsules |
| AI brain | A provider CLI (Claude Code, Codex, Meta) in the multislot terminal | Terminal = user's real shell with provider menu [TARGET: rooms rt1/rt2/ms1] |
| Semantic lane (optional) | agent_lane/v1: stable ids, roles, accessible names, control registry, socket | Exists in the kit; proven on Holdings (Holdings probe: 107/107 [CITED]) |

## 3. Shot list (target length 2:30 to 3:00)

| # | Time | Picture (what the viewer sees) | Voice-over / caption idea | What really happens |
|---|---|---|---|---|
| 1 | 0:00-0:10 | Clean MetaViewer wall, light theme, three capsules (a browser, a game, a terminal app) | "This is MetaViewer: every app in its own live capsule." | Full-screen capture of the INNER instance's surface |
| 2 | 0:10-0:35 | Cursor opens "New Capsule", picks a browser, places it as a split | "Open anything. Place it anywhere." | The AI drives the inner instance via vision-engine + wender |
| 3 | 0:35-1:05 | A capsule folds to its rail, another goes to floating, the right terminal panel slides over without resizing anything | "Fold, float, hide. Nothing you are running is disturbed." | Same; overlay panel proves no reflow |
| 4 | 1:05-1:40 | In a multislot, the operator copies the capsule ID, the terminal shows a provider CLI receiving "drive capsule cap-… and fill the form" | "Talk to an AI in the capsule's own terminal." | Inner-level multislot; this is the only nested-AI moment shown on purpose |
| 5 | 1:40-2:00 | Record for AI chip turns red, a short demo is captured, input mode flips WRITE for one corrective click, back to READ | "Teach it. Nudge it. It keeps working." | READ/WRITE input mode; wender logs the nudge as guidance |
| 6 | 2:00-2:20 | Slow zoom out: the whole screen shrinks into a capsule tile on a larger wall; the outer terminal shows the AI's log of every action just seen | "Everything you just watched..." | Switch to the OUTER instance's real screen capture; the inner surface is one capsule |
| 7 | 2:20-2:40 | The outer operator's hand is off the mouse; the outer multislot shows READ mode and the AI transcript scrolling | "...was an AI using MetaViewer, inside MetaViewer." | Real outer capture |
| 8 | 2:40-3:00 | Title card: MetaViewer, "Every app becomes AI-manageable", team, built with AI-assisted tooling | Closing line | Static card |

Optional cold-open alternative: start with shot 6 reversed (zoom in from the outer wall into the inner surface), then reveal again at the end.

## 4. Technical setup [TARGET]

1. **Outer instance**: normal MetaViewer on the host display at 1920x1080; capsule wall with one large multislot (surface on the left, terminal attached on the right).
2. **Inner instance**: launched by OpenSuperficies inside an isolated capsule surface at 1280x720 (enough for the video, cheaper to stream).
   - Own user-data directory, own sockets and ports, own session; no shared state with the outer instance.
   - Nesting flag (for example `--nested-depth=1`): the inner instance never auto-opens a capsule of itself and refuses depth > 1 (no infinite recursion).
   - Seeded demo workspace (deterministic layout, fixture capsules) so takes are repeatable.
3. **AI wiring**: in the outer multislot terminal, the provider CLI receives the inner capsule ID (Copy capsule ID). It drives the inner surface with vision-engine (perception) + wender-agent (input), optionally the inner agent_lane socket for exact control targeting. Engines stay RAM-only.
4. **Capture**: two simultaneous recordings, the inner surface stream (shots 1-5) and the outer host screen (shots 6-7), both at 30 fps; the zoom-out is an edit between the two real recordings aligned on the same moment (timestamps from the outer AI log).
5. **Recording to disk**: only the screen recorder of the video production writes disk; the product's "Record to disk" stays off unless a destination is configured.

## 5. Build checklist (what must exist before filming)

| # | Item | Owner | Gate |
|---|---|---|---|
| B1 | Overlay right terminal with real shell + provider menu | rooms rt1/rt2 | strict gate green + operator review |
| B2 | AI multislot in the kit (surface + attached terminal, controls, READ/WRITE) | room ms1 | strict gate green |
| B3 | MetaViewer app shell on the kit (wall, New Capsule, multislot host) | MetaViewer assembly | MetaViewer CI |
| B4 | OpenSuperficies adapter in MetaViewer (surface stream, input, ids) | MetaViewer repo | adapter tests + live capsule |
| B5 | Nesting flag + isolated inner profile | MetaViewer | test: depth 2 refused, no shared sockets |
| B6 | AI task script for shots 2-5 (prompts for the provider CLI) | operator | 3 clean rehearsal runs |
| B7 | Capture rig (inner stream + outer screen, synced) | operator | test take |

## 6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Nested streaming lag makes the inner UI look slow | Inner at 1280x720, compact density; film the inner stream directly, not the outer tile |
| AI hesitates or misclicks on camera | Seeded workspace, rehearsed prompts, WRITE-mode nudge is part of the story (shot 5) |
| Recursion or socket clash | Nesting flag and isolated profile (B5) |
| Viewers think it is faked | Show the outer AI transcript with timestamps matching the inner actions; publish the raw takes |
| Brand confusion | Style follows the design reference without any brand names or logos (system font) |

## 7. Next steps

1. Operator reviews this script (shots, length, language of the voice-over).
2. After B1 and B2 are green, the maintainer plans B5 and the adapter (B4) with the MetaViewer assembly.
3. Rehearsal plan and prompt set for B6 once B3/B4 run.

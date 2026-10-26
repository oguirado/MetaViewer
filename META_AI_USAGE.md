# Meta AI usage ledger

This file records every call I made to a Meta model while building MetaViewer: how many, when, why, what for,
what it cost and how much of the prompt was served from cache. It is regenerated from the raw run records after
every batch; the per-lane data is in [docs/meta-ai/muse_lanes.json](docs/meta-ai/muse_lanes.json).

## How I use Meta Muse Spark 1.3

- **Default context feeder and parallel generator.** Work is cut into *rooms*: one shared, byte-identical prefix
  (preamble + context) and N independent *lanes*, each with its own narrow surface and acceptance checks. Lanes run
  concurrently at effort `max`; their output is verified by gates before anything is integrated.
- **Two orchestrators.** A MetaViewer conductor (core, adapter, agents, integration) and a UI orchestrator (UI rooms) each run Muse rooms on a shared, admission-controlled lane budget; both are listed below.
- **Cache-first prompt design.** Every lane of a room shares the same prefix, so after the first lane the prefix is
  read from the provider's prompt cache. The cache-hit column below is measured from the usage counters, not estimated.
- **Roles.** Research of the exact component APIs, architecture audits, context packs for code writers,
  wire contracts, code for whole subsystems, adversarial review, tests, fixes and hand-off quizzes.

## Totals

| Metric | All | Pre-event (design) | Build period |
|---|---:|---:|---:|
| Lanes launched | 179 | 55 | 124 |
| Lanes finished OK | 179 | 55 | 124 |
| Agent steps | 9,096 | 2,705 | 6,391 |
| Lane-hours of agent work | 23.0 | 5.2 | 17.7 |
| Fresh input tokens | 39,635,670 | 11,482,034 | 28,153,636 |
| Cache-read input tokens | 831,204,153 | 226,255,212 | 604,948,941 |
| Prompt cache hit % | 95.4 | 95.2 | 95.6 |
| Output tokens | 8,284,380 | 2,135,708 | 6,148,672 |
| Thinking tokens | 4,371,828 | 1,050,039 | 3,321,789 |
| Cost (USD) | 7.2828 | 2.0279 | 5.255 |
| Cost per lane (USD) | 0.0407 | 0.0369 | 0.0424 |

Rooms: 37. Peak concurrent lanes [MEASURED from lane start/end]: 32.
Pre-event lanes produced plans, research and specifications only; product code was written in the build period.

## By stage

| Stage | Lanes | Cache hit % | USD |
|---|---:|---:|---:|
| build | 35 | 95.9 | 1.5489 |
| context | 42 | 95.9 | 1.9093 |
| demo | 4 | 90.7 | 0.0557 |
| design | 2 | 91.6 | 0.0547 |
| docs | 7 | 93.8 | 0.1642 |
| fix | 2 | 97.4 | 0.1115 |
| kit | 3 | 96.5 | 0.1997 |
| ops | 4 | 88.1 | 0.0468 |
| plan | 12 | 92.6 | 0.3072 |
| research | 14 | 94.6 | 0.5673 |
| review | 24 | 94.4 | 0.7832 |
| test | 12 | 95.6 | 0.5657 |
| testing | 8 | 93.7 | 0.217 |
| ui | 5 | 95.5 | 0.4215 |
| vision | 5 | 96.6 | 0.3302 |

## By room (why and what for)

| Room | Orchestrator | Started (CET) | Stage | Lanes | Cache hit % | USD | Why |
|---|---|---|---|---:|---:|---:|---|
| mv0ri | conductor | Oct 25 21:12 | research | 8 | 94.1 | 0.2776 | Research the eight hard engineering areas (authority core, journal and replay, supervision, IPC, Electron security, wall UI, terminal, gates) before any code is written. |
| mv0cf | conductor | Oct 25 21:15 | plan | 6 | 94.0 | 0.1626 | Audit the architecture norm section by section so every later writer inherits one consistent rule set. |
| mv0rvb | conductor | Oct 25 21:21 | plan | 6 | 90.4 | 0.1446 | Stress-test the build plan before the event: critical path, wave parallelism, seat matrix, testing volume, risks and the demo plan. |
| mv0pk1 | conductor | Oct 25 21:31 | context | 8 | 96.5 | 0.3376 | Write the context packs for the first eight W0 units (repo, kit, core, adapter, contracts, router): the best possible context for every code writer. |
| mv0pk2 | conductor | Oct 25 21:31 | context | 8 | 95.6 | 0.2837 | Write the context packs for router index, CI, agents client/mvctl and the Electron shell units. |
| mv0pk3 | conductor | Oct 25 21:31 | context | 8 | 96.0 | 0.435 | Write the context packs for the theme, core admission, supervisor, adapter and the W1 frames/wall/terminal/mvctl rooms. |
| mv0api | conductor | Oct 25 22:11 | research | 6 | 95.1 | 0.2897 | Extract the exact API truth of every component MetaViewer drives (OpenSuperficies CLI, UI kit, Electron 44, wender/vision, xterm/PTY) from installed files, so no writer invents an API. |
| mv0kit | conductor | Oct 25 22:13 | design | 2 | 91.6 | 0.0547 | Derive the MetaViewer theme tokens and the anchor/registry needs the UI kit must provide. |
| mv0v011 | conductor | Oct 26 16:53 | docs | 3 | 90.6 | 0.0422 | Prepare the public 0.1.1 release docs: README, pre-existing declaration, public roadmap, changelog checks. |
| mv0w0contracts2 | conductor | Oct 26 17:27 | build | 2 | 93.4 | 0.0515 | Author the MCP tool-call and tool-result contracts. |
| mv0w0contractscopy | conductor | Oct 26 17:27 | build | 1 | 92.7 | 0.0204 | Assemble the contract lanes into one coherent contracts/v0.2 tree. |
| mv0w0router | conductor | Oct 26 17:27 | build | 3 | 96.6 | 0.1486 | Build the repository router (kit, entry docs, index) so every AI reader finds the right file in one hop. |
| mv0w0contracts1 | conductor | Oct 26 17:27 | build | 8 | 92.7 | 0.1548 | Author the v0.2 wire contracts in parallel, one JSON schema with valid and invalid examples per lane. |
| mv0w0agents | conductor | Oct 26 17:39 | build | 2 | 97.1 | 0.127 | Build the Python agents client and the mvctl command line. |
| mv0w0ci | conductor | Oct 26 17:39 | build | 2 | 96.7 | 0.1171 | Build the CI matrix and the secrets gate with negative controls. |
| mv0w0shell | conductor | Oct 26 17:59 | build | 4 | 96.7 | 0.2416 | Build the Electron shell: main process, preload, app and theme. |
| mv0w1mvctl | conductor | Oct 26 18:28 | build | 3 | 94.0 | 0.148 | Build the agent tools, the MCP server and observe for mvctl. |
| mv0w1tests | conductor | Oct 26 18:28 | test | 4 | 95.1 | 0.1989 | Write integration, end-to-end, mutation and safety tests for W1. |
| mv0w1wall | conductor | Oct 26 18:41 | build | 4 | 96.2 | 0.2253 | Build the wall: workspace, surface panel, intents and projection. |
| mv0w1frames | conductor | Oct 26 18:41 | build | 3 | 93.7 | 0.1298 | Build the frame reader, frame port and frame view that put live capsule frames on screen. |
| mv0w1term | conductor | Oct 26 18:41 | build | 3 | 96.8 | 0.1848 | Build the terminal broker, byte plane and provider menu. |
| mv0w1rv | conductor | Oct 26 18:44 | review | 8 | 94.3 | 0.2749 | Adversarial review of every W0 surface in parallel; findings were adjudicated by a judge and became the binding fix list. |
| mv0w2pk1 | conductor | Oct 26 18:44 | context | 7 | 95.7 | 0.4027 | Write the W2 context packs (AI loop, human input, recording, multi-slot, catalog, settings, nested). |
| mv0w2pk2 | conductor | Oct 26 18:44 | context | 7 | 96.1 | 0.2992 | Write the W2 context packs (perception, tests, catalog core, docs, open-weight model, Muse image). |
| mv0w1fx | conductor | Oct 26 19:07 | fix | 2 | 97.4 | 0.1115 | Implement the judge's router fixes (F6-F8) and the CI/kit staging fix (F4). |
| mv0cq | conductor | Oct 26 19:17 | ops | 4 | 88.1 | 0.0468 | Continuity quiz: four lanes played the orchestrator after a context reset and found eleven ambiguities in the hand-off, all fixed. |
| mv0tp | conductor | Oct 26 20:05 | test | 8 | 95.8 | 0.3668 | Generate self-contained, paper-grounded testing prompts (verbatim excerpts from the software papers and OmniCodex) for the external web testers Jules and ChatGPT, one pair per code area, to test the current integration branch. |
| mv0ta | conductor | Oct 26 21:24 | review | 8 | 94.9 | 0.322 | Verify and de-duplicate the 126 findings of external testing round 1 (Jules + ChatGPT) against the current code, rank them for G-W1 and the v0.2.0 release, select the Jules tests worth keeping, and turn the confirmed issues into disjoint Sol fix units. |
| ew1 | UI orchestrator | Oct 26 21:47 | kit | 1 | 95.4 | 0.0432 | Add the generic EmptyWall component to the shared capsule UI kit (kit 0.2.1) because MetaViewer needs an empty-wall state. |
| mv0av | conductor | Oct 26 22:10 | review | 8 | 93.5 | 0.1863 | Verify the 56 findings of the Gemini Argon cross-review of today's integrated Sol code against the current head, rank them and turn the confirmed ones into disjoint Sol fix units. |
| mvui1 | UI orchestrator | Oct 26 22:12 | ui | 5 | 95.5 | 0.4215 | Build every MetaViewer renderer screen (wall, launcher, multislot + side terminal, recording/settings/nested, agent lane + state fixtures) on the shared kit as drops for the MetaViewer orchestrator. |
| kw1 | UI orchestrator | Oct 26 22:57 | kit | 2 | 96.7 | 0.1565 | Add wall tile states with take/release control and a kit-wide CSP audit to the shared kit (kit 0.2.1) for the MetaViewer wall and its strict CSP. |
| mvui2 | UI orchestrator | Oct 26 23:45 | vision | 5 | 96.6 | 0.3302 | Fix the MetaViewer renderer findings of the vision loop (wender-agent + vision-engine round on the integrated screens) and the remaining independent-judge notes, toward 0 medium/high findings. |
| mv0dm | conductor | Oct 27 00:28 | demo | 4 | 90.7 | 0.0557 | Prepare the live demo run sheet, the presentation video storyboard (AC-16, AC-17), the submission text and a rubric gap map so the demo criterion (25 percent) is planned from evidence. |
| mv0dc | conductor | Oct 27 00:28 | docs | 4 | 94.5 | 0.122 | Draft the product documentation (README quickstart, user guide, testing report, architecture refresh) verified against the integration head, for acceptance criterion AC-15. |
| mv0r2 | conductor | Oct 27 00:28 | testing | 8 | 93.7 | 0.217 | Write the external testing round-2 prompts (Jules test-writing and ChatGPT adversarial review per topic) targeting the code changed since round 1 and regression checks of every round-1 fix. |
| mv0w3pk | conductor | Oct 27 00:34 | context | 4 | 94.0 | 0.151 | Draft the context packs of the W3 product-finishing units (packaging, CI matrix, memory budgets, install docs) so their Sol writers start from verified file:line context. |

## Every lane

| Room | Lane | What for | Started (CET) | OK | Steps | Cache hit % | USD |
|---|---|---|---|---|---:|---:|---:|
| mv0ri | A | Core authority + admission | Oct 25 21:12 | yes | 44 | 93.2 | 0.031282 |
| mv0ri | B | Journal, hash chain, replay | Oct 25 21:12 | yes | 56 | 95.2 | 0.031589 |
| mv0ri | C | Process supervision + kill safety | Oct 25 21:13 | yes | 40 | 93.6 | 0.030959 |
| mv0ri | D | IPC: UDS, NDJSON framing, peer credentials | Oct 25 21:13 | yes | 65 | 94.5 | 0.041019 |
| mv0ri | E | Electron main/preload security + launcher | Oct 25 21:13 | yes | 45 | 94.3 | 0.034419 |
| mv0ri | F | Wall UI on capsule-ui-kit + frame tiles | Oct 25 21:14 | yes | 64 | 95.6 | 0.05489 |
| mv0ri | G | Terminal broker + provider menu | Oct 25 21:14 | yes | 34 | 92.0 | 0.029259 |
| mv0ri | H | Gates, CI, router, hygiene | Oct 25 21:14 | yes | 28 | 90.3 | 0.0242 |
| mv0cf | S1 | Conventions, scope, books, anchors, bridge (sections 0-4) | Oct 25 21:15 | yes | 48 | 94.9 | 0.032296 |
| mv0cf | S2 | Determinism, replay, math layer, docs engine, repo and router (sections 5-8) | Oct 25 21:15 | yes | 29 | 92.2 | 0.022687 |
| mv0cf | S3 | Gates (section 9) | Oct 25 21:16 | yes | 26 | 90.1 | 0.02518 |
| mv0cf | S4 | T2 operability, AI workflow and memory (sections 10-11) | Oct 25 21:16 | yes | 57 | 96.7 | 0.028441 |
| mv0cf | S5 | Electron and release, tooling gaps, boundaries and dissent (sections 12, 15, 16) | Oct 25 21:16 | yes | 31 | 93.2 | 0.028108 |
| mv0cf | S6 | Language companions A.1-A.6 and later appendices | Oct 25 21:17 | yes | 32 | 92.4 | 0.025928 |
| mv0rvb | T1 | Critical path and tempo compression | Oct 25 21:21 | yes | 32 | 87.4 | 0.032516 |
| mv0rvb | T2 | Wave parallelisation and surfaces | Oct 25 21:22 | yes | 23 | 90.2 | 0.020586 |
| mv0rvb | T3 | Seat matrix under the Wave Mind pipeline | Oct 25 21:22 | yes | 26 | 92.5 | 0.024279 |
| mv0rvb | T4 | Testing, CI volume, external testers | Oct 25 21:23 | yes | 37 | 93.3 | 0.031374 |
| mv0rvb | T5 | Risks and external dependencies | Oct 25 21:23 | yes | 23 | 90.0 | 0.020583 |
| mv0rvb | T6 | Early demo and AI-generated presentation | Oct 25 21:24 | yes | 15 | 83.8 | 0.01526 |
| mv0pk1 | P01 | Context pack W0-REPO | Oct 25 21:31 | yes | 37 | 93.9 | 0.026225 |
| mv0pk2 | P09 | Context pack W0-ROUTER-INDEX | Oct 25 21:31 | yes | 37 | 92.6 | 0.034121 |
| mv0pk3 | P17 | Context pack W0-SHELL-THEME | Oct 25 21:31 | yes | 55 | 95.3 | 0.044051 |
| mv0pk1 | P02 | Context pack W0-KIT | Oct 25 21:31 | yes | 45 | 94.9 | 0.028319 |
| mv0pk2 | P10 | Context pack W0-CI-MATRIX | Oct 25 21:31 | yes | 31 | 91.6 | 0.023454 |
| mv0pk3 | P18 | Context pack W1-CORE-ADMIT | Oct 25 21:31 | yes | 51 | 95.4 | 0.031942 |
| mv0pk1 | P03 | Context pack W0-CORE-SKEL | Oct 25 21:31 | yes | 60 | 96.1 | 0.053835 |
| mv0pk2 | P11 | Context pack W0-CI-SECRETS | Oct 25 21:31 | yes | 45 | 94.8 | 0.023933 |
| mv0pk3 | P19 | Context pack W1-SUPERVISOR | Oct 25 21:31 | yes | 63 | 96.0 | 0.08645 |
| mv0pk1 | P04 | Context pack W0-ADAPTER-SKEL | Oct 25 21:31 | yes | 78 | 97.1 | 0.047709 |
| mv0pk2 | P12 | Context pack W0-AGENTS-CLIENT | Oct 25 21:31 | yes | 96 | 97.5 | 0.050456 |
| mv0pk3 | P20 | Context pack W1-ADAPTER-OS | Oct 25 21:31 | yes | 55 | 95.7 | 0.043165 |
| mv0pk1 | P05 | Context pack W0-CONTRACTS-V02 | Oct 25 21:31 | yes | 95 | 97.4 | 0.067318 |
| mv0pk2 | P13 | Context pack W0-AGENTS-MVCTL | Oct 25 21:31 | yes | 38 | 93.1 | 0.031814 |
| mv0pk3 | P21 | Context pack R-W1-FRAMES | Oct 25 21:31 | yes | 64 | 91.8 | 0.053088 |
| mv0pk1 | P06 | Context pack R-W0-CONTRACTS | Oct 25 21:31 | yes | 63 | 96.2 | 0.041303 |
| mv0pk2 | P14 | Context pack W0-SHELL-MAIN | Oct 25 21:31 | yes | 64 | 96.1 | 0.046722 |
| mv0pk3 | P22 | Context pack R-W1-WALL | Oct 25 21:31 | yes | 96 | 97.6 | 0.06432 |
| mv0pk1 | P07 | Context pack W0-ROUTER-KIT | Oct 25 21:31 | yes | 79 | 97.4 | 0.045917 |
| mv0pk2 | P15 | Context pack W0-SHELL-PRELOAD | Oct 25 21:31 | yes | 50 | 94.9 | 0.033222 |
| mv0pk3 | P23 | Context pack R-W1-TERM | Oct 25 21:31 | yes | 96 | 96.3 | 0.064018 |
| mv0pk1 | P08 | Context pack W0-ROUTER-ENTRY | Oct 25 21:31 | yes | 43 | 94.1 | 0.027008 |
| mv0pk2 | P16 | Context pack W0-SHELL-APP | Oct 25 21:31 | yes | 56 | 96.5 | 0.040002 |
| mv0pk3 | P24 | Context pack R-W1-MVCTL | Oct 25 21:32 | yes | 66 | 96.4 | 0.048004 |
| mv0api | O | OpenSuperficies CLI and srfd wire | Oct 25 22:11 | yes | 46 | 94.8 | 0.053999 |
| mv0api | K | capsule-ui-kit consumer API | Oct 25 22:11 | yes | 69 | 95.8 | 0.045425 |
| mv0api | E | Electron 44.9.2 surface used by MetaViewer | Oct 25 22:11 | yes | 63 | 95.5 | 0.033466 |
| mv0api | V | wender-agent and vision-engine interfaces | Oct 25 22:11 | yes | 70 | 94.5 | 0.060387 |
| mv0api | P | Terminal stack: xterm 6 and the PTY broker | Oct 25 22:11 | yes | 64 | 94.6 | 0.054135 |
| mv0api | Y | Pre-event docs hygiene proposal | Oct 25 22:12 | yes | 53 | 95.5 | 0.04229 |
| mv0kit | T | MetaViewer theme tokens (light + derived dark) | Oct 25 22:13 | yes | 33 | 91.6 | 0.036867 |
| mv0kit | A | Anchor and registry needs list for the kit | Oct 25 22:14 | yes | 25 | 91.5 | 0.017853 |
| mv0v011 | R | README for v0.1.1 | Oct 26 16:53 | yes | 22 | 91.0 | 0.015061 |
| mv0v011 | P | Pre-existing declaration and public roadmap | Oct 26 16:53 | yes | 20 | 90.1 | 0.015759 |
| mv0v011 | V | Version, changelog and doc index checks | Oct 26 16:53 | yes | 22 | 90.5 | 0.011367 |
| mv0w0contracts2 | mv_tool_call | W0-CONTRACTS-mv_tool_call | Oct 26 17:27 | yes | 24 | 90.5 | 0.017347 |
| mv0w0contractscopy | COPY | W0-CONTRACTS-COPY | Oct 26 17:27 | yes | 32 | 92.7 | 0.020386 |
| mv0w0router | KIT | W0-ROUTER-KIT | Oct 26 17:27 | yes | 99 | 97.7 | 0.076034 |
| mv0w0contracts1 | hello | W0-CONTRACTS-hello | Oct 26 17:27 | yes | 35 | 94.1 | 0.020498 |
| mv0w0contracts2 | mv_tool_resu | W0-CONTRACTS-mv_tool_result | Oct 26 17:27 | yes | 43 | 94.5 | 0.034181 |
| mv0w0contracts1 | capsule_meta | W0-CONTRACTS-capsule_meta | Oct 26 17:27 | yes | 29 | 92.7 | 0.019295 |
| mv0w0router | ENTRY | W0-ROUTER-ENTRY | Oct 26 17:27 | yes | 22 | 90.4 | 0.018387 |
| mv0w0router | INDEX | W0-ROUTER-INDEX | Oct 26 17:27 | yes | 52 | 95.6 | 0.054158 |
| mv0w0contracts1 | ui_intent | W0-CONTRACTS-ui_intent | Oct 26 17:27 | yes | 23 | 90.4 | 0.017112 |
| mv0w0contracts1 | catalog_entr | W0-CONTRACTS-catalog_entry | Oct 26 17:28 | yes | 22 | 90.4 | 0.015998 |
| mv0w0contracts1 | terminal_ses | W0-CONTRACTS-terminal_session | Oct 26 17:28 | yes | 26 | 92.1 | 0.018212 |
| mv0w0contracts1 | record_reque | W0-CONTRACTS-record_request | Oct 26 17:28 | yes | 28 | 92.1 | 0.019192 |
| mv0w0contracts1 | record_event | W0-CONTRACTS-record_event | Oct 26 17:28 | yes | 27 | 94.0 | 0.018022 |
| mv0w0contracts1 | settings | W0-CONTRACTS-settings | Oct 26 17:28 | yes | 42 | 93.5 | 0.026493 |
| mv0w0agents | CLIENT | W0-AGENTS-CLIENT | Oct 26 17:39 | yes | 77 | 97.1 | 0.066926 |
| mv0w0ci | MATRIX | W0-CI-MATRIX | Oct 26 17:39 | yes | 63 | 96.9 | 0.060844 |
| mv0w0ci | SECRETS | W0-CI-SECRETS | Oct 26 17:39 | yes | 56 | 96.5 | 0.056267 |
| mv0w0agents | MVCTL | W0-AGENTS-MVCTL | Oct 26 17:39 | yes | 68 | 97.1 | 0.060028 |
| mv0w0shell | MAIN | W0-SHELL-MAIN | Oct 26 17:59 | yes | 85 | 97.3 | 0.090466 |
| mv0w0shell | PRELOAD | W0-SHELL-PRELOAD | Oct 26 17:59 | yes | 39 | 94.0 | 0.037098 |
| mv0w0shell | APP | W0-SHELL-APP | Oct 26 17:59 | yes | 36 | 93.6 | 0.031768 |
| mv0w0shell | THEME | W0-SHELL-THEME | Oct 26 17:59 | yes | 90 | 97.3 | 0.082226 |
| mv0w1mvctl | TOOLS | W1-MVCTL-TOOLS | Oct 26 18:28 | yes | 54 | 92.7 | 0.062312 |
| mv0w1tests | INTEG | W1-T-INTEG | Oct 26 18:28 | yes | 85 | 96.4 | 0.068842 |
| mv0w1mvctl | MCP | W1-MVCTL-MCP | Oct 26 18:29 | yes | 60 | 96.5 | 0.048412 |
| mv0w1tests | E2E | W1-T-E2E | Oct 26 18:29 | yes | 81 | 94.7 | 0.066296 |
| mv0w1mvctl | OBSERVE | W1-MVCTL-OBSERVE | Oct 26 18:29 | yes | 39 | 90.5 | 0.037237 |
| mv0w1tests | MUT | W1-T-MUT | Oct 26 18:29 | yes | 29 | 92.3 | 0.026979 |
| mv0w1tests | SAFE | W1-T-SAFE | Oct 26 18:29 | yes | 36 | 93.9 | 0.03679 |
| mv0w1wall | WORKSPACE | W1-WALL-WORKSPACE | Oct 26 18:41 | yes | 91 | 96.6 | 0.103858 |
| mv0w1frames | READER | W1-FRAMES-READER | Oct 26 18:41 | yes | 50 | 95.7 | 0.045513 |
| mv0w1term | BROKER | W1-TERM-BROKER | Oct 26 18:41 | yes | 99 | 97.7 | 0.112777 |
| mv0w1wall | PANEL | W1-WALL-PANEL | Oct 26 18:41 | yes | 48 | 95.9 | 0.038549 |
| mv0w1frames | PORT | W1-FRAMES-PORT | Oct 26 18:41 | yes | 33 | 93.5 | 0.031484 |
| mv0w1term | PLANE | W1-TERM-PLANE | Oct 26 18:41 | yes | 51 | 95.1 | 0.047883 |
| mv0w1wall | INTENTS | W1-WALL-INTENTS | Oct 26 18:41 | yes | 28 | 91.6 | 0.029826 |
| mv0w1frames | VIEW | W1-FRAMES-VIEW | Oct 26 18:41 | yes | 35 | 91.1 | 0.052826 |
| mv0w1term | PROVIDERS | W1-TERM-PROVIDERS | Oct 26 18:41 | yes | 28 | 91.9 | 0.02418 |
| mv0w1wall | PROJECTION | W1-WALL-PROJECTION | Oct 26 18:41 | yes | 62 | 96.8 | 0.0531 |
| mv0w1rv | CORE | Review core/ (Rust authority core skeleton) | Oct 26 18:44 | yes | 44 | 91.5 | 0.048306 |
| mv0w2pk1 | Q01 | Pack W2-AILOOP | Oct 26 18:44 | yes | 43 | 94.3 | 0.031738 |
| mv0w2pk2 | Q08 | Pack R-W2-PERCEPTION | Oct 26 18:44 | yes | 35 | 93.5 | 0.031159 |
| mv0w1rv | ADAPT | Review daemon-adapter/ (Go adapter skeleton) | Oct 26 18:44 | yes | 27 | 92.6 | 0.022319 |
| mv0w2pk1 | Q02 | Pack W2-HUMAN-INPUT | Oct 26 18:44 | yes | 78 | 96.2 | 0.065015 |
| mv0w2pk2 | Q09 | Pack R-W2-TESTS | Oct 26 18:44 | yes | 76 | 97.0 | 0.051277 |
| mv0w1rv | SHELL | Review ui/electron and ui/src (Electron shell) | Oct 26 18:44 | yes | 53 | 95.4 | 0.034877 |
| mv0w2pk1 | Q03 | Pack W2-REC | Oct 26 18:44 | yes | 53 | 94.9 | 0.042427 |
| mv0w2pk2 | Q10 | Pack W2-CATALOG-CORE | Oct 26 18:44 | yes | 43 | 93.7 | 0.029309 |
| mv0w1rv | CONTR | Review contracts/v0.2 and tools/check_contracts.py | Oct 26 18:44 | yes | 56 | 96.0 | 0.042677 |
| mv0w2pk1 | Q04 | Pack R-W2-MULTISLOT | Oct 26 18:44 | yes | 64 | 96.7 | 0.049057 |
| mv0w2pk2 | Q11 | Pack R-W2-DOCS-EARLY | Oct 26 18:44 | yes | 88 | 97.3 | 0.052906 |
| mv0w1rv | CI | Review the .github workflows, .githooks/pre-push and tests/fixtures/secrets | Oct 26 18:44 | yes | 55 | 95.7 | 0.032664 |
| mv0w2pk1 | Q05 | Pack R-W2-CATALOG | Oct 26 18:44 | yes | 101 | 96.6 | 0.082158 |
| mv0w2pk2 | Q12 | Pack R-W3-TESTS-EARLY | Oct 26 18:44 | yes | 83 | 96.7 | 0.063206 |
| mv0w1rv | ROUTER | Review router/, catalogue/, llms.txt, AGENTS.md, tools/router_index.py | Oct 26 18:44 | yes | 48 | 95.1 | 0.03112 |
| mv0w2pk1 | Q06 | Pack R-W2-SETTINGS | Oct 26 18:44 | yes | 79 | 94.7 | 0.092337 |
| mv0w2pk2 | Q13 | Pack W2-OPENWEIGHT | Oct 26 18:44 | yes | 43 | 95.6 | 0.028391 |
| mv0w1rv | KIT | Review tools/sync_kit.mjs, ui/kit.lock.json, tests/test_kit_source.py | Oct 26 18:44 | yes | 28 | 87.5 | 0.028901 |
| mv0w2pk1 | Q07 | Pack R-W2-NESTED | Oct 26 18:44 | yes | 53 | 94.7 | 0.039962 |
| mv0w2pk2 | Q14 | Pack R-W2-MUSE-IMAGE | Oct 26 18:44 | yes | 45 | 94.4 | 0.042933 |
| mv0w1rv | AGENTS | Review agents/metaviewer_agents and agents/tests (committed files only) | Oct 26 18:44 | yes | 44 | 94.5 | 0.034065 |
| mv0w1fx | ROUTERFIX | Router fixes F6-F8 | Oct 26 19:07 | yes | 94 | 97.6 | 0.070623 |
| mv0w1fx | CIKIT | CI and kit sync fix F4 | Oct 26 19:07 | yes | 66 | 96.8 | 0.04088 |
| mv0cq | CQ1 | Continuity quiz 1 | Oct 26 19:17 | yes | 13 | 87.1 | 0.010361 |
| mv0cq | CQ2 | Continuity quiz 2 | Oct 26 19:17 | yes | 11 | 86.0 | 0.010783 |
| mv0cq | CQ3 | Continuity quiz 3 | Oct 26 19:17 | yes | 12 | 81.8 | 0.013452 |
| mv0cq | CQ4 | Continuity quiz 4 | Oct 26 19:17 | yes | 23 | 92.8 | 0.012211 |
| mv0tp | T1 | Testing prompts T1 CORE | Oct 26 20:05 | yes | 58 | 96.1 | 0.049412 |
| mv0tp | T2 | Testing prompts T2 ADAPTER | Oct 26 20:06 | yes | 64 | 96.3 | 0.057087 |
| mv0tp | T3 | Testing prompts T3 AGENTS | Oct 26 20:06 | yes | 33 | 92.1 | 0.03335 |
| mv0tp | T4 | Testing prompts T4 UI-SEC | Oct 26 20:06 | yes | 41 | 91.2 | 0.043924 |
| mv0tp | T5 | Testing prompts T5 UI-WALL | Oct 26 20:06 | yes | 76 | 97.0 | 0.050686 |
| mv0tp | T6 | Testing prompts T6 CONTRACTS | Oct 26 20:06 | yes | 59 | 96.1 | 0.041277 |
| mv0tp | T7 | Testing prompts T7 CI-SUPPLY | Oct 26 20:06 | yes | 55 | 95.8 | 0.045032 |
| mv0tp | T8 | Testing prompts T8 E2E | Oct 26 20:06 | yes | 77 | 97.1 | 0.045986 |
| mv0ta | T1 | Analysis T1 Rust authority core | Oct 26 21:24 | yes | 56 | 92.6 | 0.055136 |
| mv0ta | T2 | Analysis T2 Go daemon adapter | Oct 26 21:24 | yes | 49 | 92.9 | 0.04958 |
| mv0ta | T3 | Analysis T3 Python agents | Oct 26 21:24 | yes | 48 | 95.0 | 0.031614 |
| mv0ta | T4 | Analysis T4 Electron security | Oct 26 21:24 | yes | 49 | 95.0 | 0.028932 |
| mv0ta | T5 | Analysis T5 Vue wall, frames and terminal | Oct 26 21:24 | yes | 61 | 95.8 | 0.036656 |
| mv0ta | T6 | Analysis T6 Contracts v0.2 cross-language | Oct 26 21:24 | yes | 63 | 96.1 | 0.037596 |
| mv0ta | T7 | Analysis T7 CI and supply chain | Oct 26 21:24 | yes | 66 | 96.0 | 0.042541 |
| mv0ta | T8 | Analysis T8 End-to-end scenario | Oct 26 21:24 | yes | 54 | 95.5 | 0.039981 |
| ew1 | E | EmptyWall + 0.2.1 | Oct 26 21:47 | yes | 52 | 95.4 | 0.043179 |
| mv0av | CORE | Verify Argon findings core | Oct 26 22:10 | yes | 33 | 92.8 | 0.025852 |
| mv0av | ADAPTER | Verify Argon findings adapter | Oct 26 22:10 | yes | 26 | 91.8 | 0.016858 |
| mv0av | AGENTS | Verify Argon findings agents | Oct 26 22:10 | yes | 36 | 94.9 | 0.018099 |
| mv0av | CI | Verify Argon findings ci | Oct 26 22:10 | yes | 31 | 93.6 | 0.023692 |
| mv0av | UI_PTY | Verify Argon findings ui_pty | Oct 26 22:10 | yes | 35 | 89.4 | 0.028726 |
| mv0av | UI_FRAMES | Verify Argon findings ui_frames | Oct 26 22:10 | yes | 44 | 94.4 | 0.029635 |
| mv0av | UI_SHELL | Verify Argon findings ui_shell | Oct 26 22:10 | yes | 30 | 92.5 | 0.019574 |
| mv0av | UI_SURFACES | Verify Argon findings ui_surfaces | Oct 26 22:11 | yes | 45 | 95.9 | 0.023821 |
| mvui1 | U1 | Wall screens + tile states | Oct 26 22:12 | yes | 97 | 96.6 | 0.083064 |
| mvui1 | U2 | New Capsule launcher / catalog | Oct 26 22:12 | yes | 80 | 96.2 | 0.062871 |
| mvui1 | U3 | AI multislot + side terminal wiring | Oct 26 22:12 | yes | 101 | 91.0 | 0.143107 |
| mvui1 | U4 | Recording, settings, nested mode | Oct 26 22:13 | yes | 97 | 97.1 | 0.07956 |
| mvui1 | U5 | agent_lane snapshot + state fixtures | Oct 26 22:13 | yes | 70 | 97.0 | 0.052854 |
| kw1 | T | Wall tile states + take/release | Oct 26 22:57 | yes | 96 | 96.5 | 0.078896 |
| kw1 | C | Kit-wide CSP audit | Oct 26 22:57 | yes | 101 | 96.9 | 0.077633 |
| mvui2 | V1 | Side terminal no-core empty state (MV-1) + terminal judge notes | Oct 26 23:45 | yes | 91 | 96.7 | 0.080473 |
| mvui2 | V2 | Dock tab anchors + wall/catalog judge notes (MV-2) | Oct 26 23:46 | yes | 74 | 97.1 | 0.069468 |
| mvui2 | V3 | Contrast (MV-3, MV-4) in MetaViewer tokens | Oct 26 23:46 | yes | 72 | 97.0 | 0.055331 |
| mvui2 | V4 | Vision hooks: ?scheme= and frame binding | Oct 26 23:46 | yes | 83 | 96.1 | 0.083357 |
| mvui2 | V5 | SurfaceCanvas v-show + engine notes | Oct 26 23:47 | yes | 58 | 96.2 | 0.041545 |
| mv0dm | DEMO | Live demo run sheet | Oct 27 00:28 | yes | 17 | 87.7 | 0.013046 |
| mv0dc | README | README with first-person quickstart | Oct 27 00:28 | yes | 35 | 91.5 | 0.025479 |
| mv0r2 | T1 | Round-2 prompts T1 | Oct 27 00:28 | yes | 28 | 93.6 | 0.024157 |
| mv0r2 | T2 | Round-2 prompts T2 | Oct 27 00:28 | yes | 35 | 93.5 | 0.026001 |
| mv0dc | USER_GUIDE | docs/USER_GUIDE.md first draft | Oct 27 00:28 | yes | 43 | 94.8 | 0.027043 |
| mv0dm | STORY | Video storyboard and shot list | Oct 27 00:28 | yes | 27 | 92.7 | 0.014227 |
| mv0dc | TESTING | docs/TESTING.md with measured counts | Oct 27 00:28 | yes | 66 | 96.0 | 0.038237 |
| mv0dm | SUBMIT | Submission text draft | Oct 27 00:28 | yes | 22 | 90.8 | 0.013933 |
| mv0r2 | T3 | Round-2 prompts T3 | Oct 27 00:28 | yes | 27 | 91.7 | 0.021159 |
| mv0dm | JUDGE | Rubric gap map | Oct 27 00:28 | yes | 22 | 90.4 | 0.014449 |
| mv0r2 | T4 | Round-2 prompts T4 | Oct 27 00:28 | yes | 47 | 95.0 | 0.030298 |
| mv0dc | ARCH | docs/ARCHITECTURE.md refresh | Oct 27 00:28 | yes | 39 | 93.9 | 0.031267 |
| mv0r2 | T5 | Round-2 prompts T5 | Oct 27 00:29 | yes | 40 | 94.2 | 0.02737 |
| mv0r2 | T6 | Round-2 prompts T6 | Oct 27 00:29 | yes | 45 | 94.9 | 0.028242 |
| mv0r2 | T7 | Round-2 prompts T7 | Oct 27 00:29 | yes | 32 | 92.6 | 0.034937 |
| mv0r2 | T8 | Round-2 prompts T8 | Oct 27 00:29 | yes | 29 | 92.4 | 0.024794 |
| mv0w3pk | P_PKG | Pack W3-PKG | Oct 27 00:34 | yes | 40 | 91.9 | 0.04142 |
| mv0w3pk | P_CI_MATRIX | Pack W3-CI-MATRIX | Oct 27 00:34 | yes | 39 | 94.1 | 0.036339 |
| mv0w3pk | P_BUDGETS | Pack W3-BUDGETS | Oct 27 00:34 | yes | 49 | 94.1 | 0.040309 |
| mv0w3pk | P_INSTALL_DOCS | Pack W3-INSTALL-DOCS | Oct 27 00:34 | yes | 63 | 95.6 | 0.032982 |

## Method

- Source: the per-lane run record of each Muse Spark 1.3 call (model id, effort, usage counters, USD as reported
  by the client, agent steps, wall time). Start time comes from the session UUIDv7.
- Cache hit % = cache-read input tokens / (fresh input + cache-read input tokens).
- Scope: this ledger lists Meta model usage only. Other development tools I used (editor, CI and non-Meta
  coding assistants) are outside its scope and are not part of the product.

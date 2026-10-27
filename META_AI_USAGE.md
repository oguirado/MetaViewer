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
| Lanes launched | 244 | 55 | 189 |
| Lanes finished OK | 244 | 55 | 189 |
| Agent steps | 12,296 | 2,705 | 9,591 |
| Lane-hours of agent work | 31.6 | 5.2 | 26.4 |
| Fresh input tokens | 52,566,087 | 11,482,034 | 41,084,053 |
| Cache-read input tokens | 1,116,923,743 | 226,255,212 | 890,668,531 |
| Prompt cache hit % | 95.5 | 95.2 | 95.6 |
| Output tokens | 11,185,774 | 2,135,708 | 9,050,066 |
| Thinking tokens | 5,945,058 | 1,050,039 | 4,895,019 |
| Cost (USD) | 9.7276 | 2.0279 | 7.6997 |
| Cost per lane (USD) | 0.0399 | 0.0369 | 0.0407 |

Rooms: 54. Peak concurrent lanes [MEASURED from lane start/end]: 24.
Pre-event lanes produced plans, research and specifications only; product code was written in the build period.

## By stage

| Stage | Lanes | Cache hit % | USD |
|---|---:|---:|---:|
| build | 48 | 95.7 | 1.9905 |
| context | 42 | 95.9 | 1.9093 |
| demo | 4 | 90.7 | 0.0557 |
| design | 2 | 91.6 | 0.0547 |
| docs | 15 | 94.8 | 0.5371 |
| fix | 2 | 97.4 | 0.1115 |
| kit | 3 | 96.5 | 0.1997 |
| ops | 4 | 88.1 | 0.0468 |
| plan | 12 | 92.6 | 0.3072 |
| research | 14 | 94.6 | 0.5673 |
| review | 47 | 94.4 | 1.393 |
| test | 12 | 95.6 | 0.5657 |
| testing | 22 | 94.7 | 0.7556 |
| ui | 9 | 96.4 | 0.6965 |
| vision | 8 | 97.2 | 0.537 |

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
| mv0nv | conductor | Oct 27 00:38 | review | 4 | 95.5 | 0.1275 | Verify the 30 findings of the Gemini Argon cross-review of the night's integrated code (60f9239..492d6d0) against the current head and turn confirmed ones into disjoint Sol fix units. |
| mv0dc2 | conductor | Oct 27 00:54 | docs | 4 | 92.8 | 0.2117 | Adversarial fact-check of the documentation drafts against the integration head, so the public README, user guide, testing report and architecture contain only verified claims (AC-15). |
| mv0pr | conductor | Oct 27 01:04 | review | 8 | 93.6 | 0.228 | Adversarial pre-integration review of the eight Sol units finished tonight (journal lock, frame_ref v0.2, agent loop, recording, human input, serve and adapter P0 fixes, budget gate), so defects are caught before they land. |
| mv0tg | conductor | Oct 27 01:06 | testing | 6 | 93.4 | 0.175 | Map every acceptance criterion AC-01..AC-17 to the tests that prove its positive pass and negative control, per component, and specify the missing tests as Sol units, so the v0.2.0 release is provably complete. |
| mv0mv | conductor | Oct 27 01:08 | review | 3 | 94.9 | 0.0828 | Verify the 16 findings of the second Gemini Argon cross-review (492d6d0..e19feb6: serve tools, frame subscriptions, journal anchor, contracts checker, catalog) and turn confirmed ones into Sol fix units. |
| mv0w2museimage | conductor | Oct 27 01:12 | build | 2 | 95.0 | 0.0695 | Muse Spark writer room mv0w2museimage: build the W2 component lanes (CLIENT, UI) from the Argon-compiled context pack, with tests first. |
| mv0w2tests | conductor | Oct 27 01:12 | build | 6 | 94.9 | 0.2003 | Muse Spark writer room mv0w2tests: build the W2 component lanes (AC02, AC03, AC04, AC05, AC06, AC07) from the Argon-compiled context pack, with tests first. |
| mv0rw3testsearly | conductor | Oct 27 01:12 | build | 2 | 94.9 | 0.0738 | Muse Spark writer room mv0rw3testsearly: build the W2 component lanes (AC09, AC12) from the Argon-compiled context pack, with tests first. |
| mv0w2perception | conductor | Oct 27 01:13 | build | 3 | 94.7 | 0.098 | Muse Spark writer room mv0w2perception: build the W2 component lanes (PLUGIN, META, VCORE) from the Argon-compiled context pack, with tests first. |
| mv0ab1r | conductor | Oct 27 01:25 | review | 2 | 91.5 | 0.035 | Blind adversarial review of the two candidates of A/B pair 1 (same test unit written by two different writer models), to measure writer quality before choosing the cheaper seat for test units. |
| mv0jb | conductor | Oct 27 01:41 | review | 3 | 94.0 | 0.1343 | Prepare the W1 judgement: evidence bundle per acceptance criterion, consolidated open findings across all testers and reviews, and the XML judge brief for the Opus and Argon judges. |
| mv0rv | conductor | Oct 27 01:47 | review | 3 | 95.0 | 0.0654 | Verify the 12 findings of the third Gemini Argon cross-review (integrations since e19feb6: frame_ref v0.2 path, preload origin, no-follow witness, journal lock, UI drops) and turn confirmed ones into Sol fix units. |
| mv0p1 | conductor | Oct 27 02:00 | review | 4 | 94.9 | 0.1175 | Re-verify the 35 open P1 findings on the current head and turn the still-open ones into disjoint, ordered Sol fix units: the morning work queue towards the v0.2.0 release. |
| mvui3n | UI orchestrator | Oct 27 02:52 | ui | 4 | 97.5 | 0.275 | Polish the MetaViewer wall for live data after the live G-W1 gate passed: a live-replay fixture through the real authority runtime, live tile states, multislot real terminal sessions and a receipt/verdict activity strip. |
| mv0sv | conductor | Oct 27 04:07 | review | 4 | 94.4 | 0.0942 | Verify the 26 findings of the fourth Gemini Argon cross-review (integrations 102f2e0..b64ec5a after G-W1) and turn confirmed ones into Sol fix units. |
| mv0dc3 | conductor | Oct 27 04:14 | docs | 4 | 96.8 | 0.1612 | Second fact-check and refresh of the product documentation against the integration head after G-W1, so README, user guide, testing report and architecture can be committed with only verified claims (AC-15). |
| mvui4l | UI orchestrator | Oct 27 04:21 | vision | 3 | 97.9 | 0.2069 | Fix the MetaViewer live-state findings of vision round mv5 (lost tile vanishes, badge/placeholder, folded/error tile layout) and make refusal, verdict, activity, multislot outcome and terminal lifecycle rows reachable for the vision loop. |
| mv0r2b | conductor | Oct 27 05:24 | testing | 8 | 95.6 | 0.3636 | Refresh the external testing round-2 prompts (Jules and ChatGPT, T1-T8) to the integration head after G-W1 and the W1 judgement, so testers target new code and still-open items. |

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
| mv0w2pk1 | Q01 | Pack W2-AILOOP | Oct 26 18:44 | yes | 43 | 94.3 | 0.031738 |
| mv0w2pk2 | Q08 | Pack R-W2-PERCEPTION | Oct 26 18:44 | yes | 35 | 93.5 | 0.031159 |
| mv0w2pk1 | Q02 | Pack W2-HUMAN-INPUT | Oct 26 18:44 | yes | 78 | 96.2 | 0.065015 |
| mv0w2pk2 | Q09 | Pack R-W2-TESTS | Oct 26 18:44 | yes | 76 | 97.0 | 0.051277 |
| mv0w2pk1 | Q03 | Pack W2-REC | Oct 26 18:44 | yes | 53 | 94.9 | 0.042427 |
| mv0w2pk2 | Q10 | Pack W2-CATALOG-CORE | Oct 26 18:44 | yes | 43 | 93.7 | 0.029309 |
| mv0w2pk1 | Q04 | Pack R-W2-MULTISLOT | Oct 26 18:44 | yes | 64 | 96.7 | 0.049057 |
| mv0w2pk2 | Q11 | Pack R-W2-DOCS-EARLY | Oct 26 18:44 | yes | 88 | 97.3 | 0.052906 |
| mv0w2pk1 | Q05 | Pack R-W2-CATALOG | Oct 26 18:44 | yes | 101 | 96.6 | 0.082158 |
| mv0w2pk2 | Q12 | Pack R-W3-TESTS-EARLY | Oct 26 18:44 | yes | 83 | 96.7 | 0.063206 |
| mv0w2pk1 | Q06 | Pack R-W2-SETTINGS | Oct 26 18:44 | yes | 79 | 94.7 | 0.092337 |
| mv0w2pk2 | Q13 | Pack W2-OPENWEIGHT | Oct 26 18:44 | yes | 43 | 95.6 | 0.028391 |
| mv0w2pk1 | Q07 | Pack R-W2-NESTED | Oct 26 18:44 | yes | 53 | 94.7 | 0.039962 |
| mv0w2pk2 | Q14 | Pack R-W2-MUSE-IMAGE | Oct 26 18:44 | yes | 45 | 94.4 | 0.042933 |
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
| mv0nv | N_CORE | Verify Argon night findings n_core | Oct 27 00:38 | yes | 60 | 96.3 | 0.035999 |
| mv0nv | N_ADAPTER | Verify Argon night findings n_adapter | Oct 27 00:38 | yes | 47 | 95.1 | 0.028921 |
| mv0nv | N_UISRC | Verify Argon night findings n_uisrc | Oct 27 00:38 | yes | 52 | 95.5 | 0.034291 |
| mv0nv | N_E2E | Verify Argon night findings n_e2e | Oct 27 00:38 | yes | 47 | 94.8 | 0.028245 |
| mv0dc2 | README | Fact-check README.md | Oct 27 00:54 | yes | 33 | 87.6 | 0.028904 |
| mv0dc2 | USER_GUIDE | Fact-check USER_GUIDE.md | Oct 27 00:55 | yes | 76 | 94.9 | 0.06418 |
| mv0dc2 | TESTING | Fact-check TESTING.md | Oct 27 00:55 | yes | 42 | 88.9 | 0.048864 |
| mv0dc2 | ARCH | Fact-check ARCHITECTURE.md | Oct 27 00:55 | yes | 82 | 93.5 | 0.069783 |
| mv0pr | JLOCK | Pre-integration review JLOCK | Oct 27 01:04 | yes | 38 | 93.9 | 0.029251 |
| mv0pr | FRAMEREF | Pre-integration review FRAMEREF | Oct 27 01:04 | yes | 51 | 95.9 | 0.037604 |
| mv0pr | AILOOP | Pre-integration review AILOOP | Oct 27 01:04 | yes | 22 | 90.1 | 0.020601 |
| mv0pr | REC | Pre-integration review REC | Oct 27 01:04 | yes | 41 | 94.6 | 0.02858 |
| mv0pr | HUMAN | Pre-integration review HUMAN | Oct 27 01:04 | yes | 26 | 93.0 | 0.016742 |
| mv0pr | NVSERVE | Pre-integration review NVSERVE | Oct 27 01:04 | yes | 46 | 92.3 | 0.039935 |
| mv0pr | NVADAPTER | Pre-integration review NVADAPTER | Oct 27 01:04 | yes | 47 | 93.1 | 0.037064 |
| mv0pr | BUDGETS | Pre-integration review BUDGETS | Oct 27 01:04 | yes | 25 | 90.9 | 0.018235 |
| mv0tg | CORE | Test gaps CORE | Oct 27 01:06 | yes | 36 | 93.5 | 0.024217 |
| mv0tg | ADAPTER | Test gaps ADAPTER | Oct 27 01:06 | yes | 41 | 94.1 | 0.040359 |
| mv0tg | AGENTS | Test gaps AGENTS | Oct 27 01:07 | yes | 38 | 94.1 | 0.022923 |
| mv0tg | UIEL | Test gaps UIEL | Oct 27 01:07 | yes | 38 | 94.0 | 0.032417 |
| mv0tg | UISRC | Test gaps UISRC | Oct 27 01:07 | yes | 29 | 91.9 | 0.019161 |
| mv0tg | E2E | Test gaps E2E | Oct 27 01:07 | yes | 37 | 91.3 | 0.035968 |
| mv0mv | M_CORE | Verify Argon findings m_core | Oct 27 01:08 | yes | 45 | 94.8 | 0.0244 |
| mv0mv | M_ADAPTER | Verify Argon findings m_adapter | Oct 27 01:08 | yes | 52 | 95.7 | 0.033758 |
| mv0mv | M_CONTRACTS | Verify Argon findings m_contracts | Oct 27 01:09 | yes | 37 | 93.6 | 0.024674 |
| mv0w2museimage | CLIENT | W2-MI-CLIENT | Oct 27 01:12 | yes | 45 | 94.9 | 0.035014 |
| mv0w2tests | AC02 | W2-T-AC02 | Oct 27 01:12 | yes | 18 | 90.2 | 0.020141 |
| mv0rw3testsearly | AC09 | W3-T-AC09 | Oct 27 01:12 | yes | 44 | 94.4 | 0.036937 |
| mv0w2museimage | UI | W2-MI-UI | Oct 27 01:12 | yes | 46 | 95.1 | 0.034444 |
| mv0rw3testsearly | AC12 | W3-T-AC12 | Oct 27 01:12 | yes | 47 | 95.4 | 0.036836 |
| mv0w2tests | AC03 | W2-T-AC03 | Oct 27 01:12 | yes | 44 | 95.9 | 0.031771 |
| mv0w2tests | AC04 | W2-T-AC04 | Oct 27 01:12 | yes | 51 | 95.6 | 0.046629 |
| mv0w2tests | AC05 | W2-T-AC05 | Oct 27 01:12 | yes | 41 | 95.3 | 0.041222 |
| mv0w2tests | AC06 | W2-T-AC06 | Oct 27 01:12 | yes | 34 | 94.2 | 0.025351 |
| mv0w2perception | PLUGIN | W2-PER-PLUGIN | Oct 27 01:13 | yes | 29 | 92.6 | 0.024535 |
| mv0w2tests | AC07 | W2-T-AC07 | Oct 27 01:13 | yes | 35 | 94.1 | 0.035233 |
| mv0w2perception | META | W2-PER-META | Oct 27 01:13 | yes | 39 | 94.6 | 0.031569 |
| mv0w2perception | VCORE | W2-PER-VCORE | Oct 27 01:13 | yes | 46 | 95.7 | 0.041913 |
| mv0ab1r | X | Blind review candidate X | Oct 27 01:25 | yes | 31 | 92.6 | 0.019299 |
| mv0ab1r | Y | Blind review candidate Y | Oct 27 01:25 | yes | 21 | 89.6 | 0.015651 |
| mv0jb | EVIDENCE | W1 evidence bundle | Oct 27 01:41 | yes | 42 | 94.2 | 0.023844 |
| mv0jb | OPEN | Consolidated open findings | Oct 27 01:41 | yes | 75 | 94.1 | 0.092762 |
| mv0jb | BRIEF | Judge brief draft (XML) | Oct 27 01:41 | yes | 26 | 93.3 | 0.017704 |
| mv0rv | R_CORE | Verify Argon findings r_core | Oct 27 01:47 | yes | 52 | 96.5 | 0.028434 |
| mv0rv | R_UI | Verify Argon findings r_ui | Oct 27 01:47 | yes | 47 | 94.9 | 0.026538 |
| mv0rv | R_ADAPTER | Verify Argon findings r_adapter | Oct 27 01:47 | yes | 15 | 86.0 | 0.010406 |
| mv0p1 | CORE | P1 backlog CORE | Oct 27 02:00 | yes | 37 | 93.6 | 0.033091 |
| mv0p1 | ADAPTER | P1 backlog ADAPTER | Oct 27 02:00 | yes | 58 | 96.4 | 0.034043 |
| mv0p1 | UIEL | P1 backlog UIEL | Oct 27 02:00 | yes | 24 | 90.2 | 0.016941 |
| mv0p1 | CI | P1 backlog CI | Oct 27 02:00 | yes | 47 | 95.5 | 0.033459 |
| mvui3n | R | Live-replay fixture through the real authority runtime | Oct 27 02:52 | yes | 78 | 97.6 | 0.074263 |
| mvui3n | T | Live tile states UX | Oct 27 02:53 | yes | 92 | 97.7 | 0.068771 |
| mvui3n | M | Multislot real terminal sessions | Oct 27 02:53 | yes | 91 | 97.7 | 0.072079 |
| mvui3n | V | Receipt and verdict activity strip | Oct 27 02:53 | yes | 73 | 96.7 | 0.059905 |
| mv0sv | S_CORE | Verify Argon findings s_core | Oct 27 04:07 | yes | 49 | 95.4 | 0.030601 |
| mv0sv | S_UI | Verify Argon findings s_ui | Oct 27 04:08 | yes | 39 | 94.5 | 0.021885 |
| mv0sv | S_ADAPTER | Verify Argon findings s_adapter | Oct 27 04:08 | yes | 44 | 94.5 | 0.023579 |
| mv0sv | S_CI | Verify Argon findings s_ci | Oct 27 04:08 | yes | 25 | 90.9 | 0.018159 |
| mv0dc3 | README | Final docs README.md | Oct 27 04:14 | yes | 34 | 93.3 | 0.021293 |
| mv0dc3 | USER_GUIDE | Final docs USER_GUIDE.md | Oct 27 04:14 | yes | 92 | 97.4 | 0.059736 |
| mv0dc3 | TESTING | Final docs TESTING.md | Oct 27 04:14 | yes | 71 | 96.6 | 0.035632 |
| mv0dc3 | ARCH | Final docs ARCHITECTURE.md | Oct 27 04:14 | yes | 81 | 97.1 | 0.044512 |
| mvui4l | W | Lost tile + tile layout (MV-7, MV-8, MV-9) | Oct 27 04:21 | yes | 98 | 97.8 | 0.075483 |
| mvui4l | R | Replay steps for refusal, verdict, multislot outcomes, terminal lifecycle | Oct 27 04:22 | yes | 100 | 98.6 | 0.084558 |
| mvui4l | V | Activity strip + fixture-only bench dispatch hook | Oct 27 04:22 | yes | 55 | 95.9 | 0.046832 |
| mv0r2b | T1 | Round-2 prompts T1 | Oct 27 05:24 | yes | 37 | 93.3 | 0.03246 |
| mv0r2b | T2 | Round-2 prompts T2 | Oct 27 05:24 | yes | 65 | 96.3 | 0.052145 |
| mv0r2b | T3 | Round-2 prompts T3 | Oct 27 05:24 | yes | 78 | 96.7 | 0.057313 |
| mv0r2b | T4 | Round-2 prompts T4 | Oct 27 05:24 | yes | 58 | 94.6 | 0.064222 |
| mv0r2b | T5 | Round-2 prompts T5 | Oct 27 05:24 | yes | 52 | 95.0 | 0.037282 |
| mv0r2b | T6 | Round-2 prompts T6 | Oct 27 05:24 | yes | 40 | 94.3 | 0.031806 |
| mv0r2b | T7 | Round-2 prompts T7 | Oct 27 05:24 | yes | 53 | 95.6 | 0.039991 |
| mv0r2b | T8 | Round-2 prompts T8 | Oct 27 05:25 | yes | 68 | 96.2 | 0.048332 |

## Method

- Source: the per-lane run record of each Muse Spark 1.3 call (model id, effort, usage counters, USD as reported
  by the client, agent steps, wall time). Start time comes from the session UUIDv7.
- Cache hit % = cache-read input tokens / (fresh input + cache-read input tokens).
- Scope: this ledger lists Meta model usage only. Other development tools I used (editor, CI and non-Meta
  coding assistants) are outside its scope and are not part of the product.

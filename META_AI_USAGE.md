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
| Lanes launched | 361 | 55 | 306 |
| Lanes finished OK | 361 | 55 | 306 |
| Agent steps | 19,932 | 2,705 | 17,227 |
| Lane-hours of agent work | 51.8 | 5.2 | 46.5 |
| Fresh input tokens | 80,478,973 | 11,482,034 | 68,996,939 |
| Cache-read input tokens | 1,886,041,444 | 226,255,212 | 1,659,786,232 |
| Prompt cache hit % | 95.9 | 95.2 | 96.0 |
| Output tokens | 17,614,110 | 2,135,708 | 15,478,402 |
| Thinking tokens | 9,404,869 | 1,050,039 | 8,354,830 |
| Cost (USD) | 15.3428 | 2.0279 | 13.3149 |
| Cost per lane (USD) | 0.0425 | 0.0369 | 0.0435 |

Rooms: 98. Peak concurrent lanes [MEASURED from lane start/end]: 24.
Pre-event lanes produced plans, research and specifications only; product code was written in the build period.

## By stage

| Stage | Lanes | Cache hit % | USD |
|---|---:|---:|---:|
| build | 48 | 95.7 | 1.9905 |
| context | 42 | 95.9 | 1.9093 |
| demo | 4 | 90.7 | 0.0557 |
| design | 2 | 91.6 | 0.0547 |
| docs | 15 | 94.8 | 0.5371 |
| fix | 37 | 96.8 | 2.0407 |
| kit | 3 | 96.5 | 0.1997 |
| ops | 4 | 88.1 | 0.0468 |
| plan | 12 | 92.6 | 0.3072 |
| release | 5 | 93.2 | 0.0945 |
| research | 14 | 94.6 | 0.5673 |
| review | 59 | 94.6 | 1.7206 |
| submission | 4 | 94.9 | 0.0995 |
| test | 12 | 95.6 | 0.5657 |
| testing | 73 | 96.1 | 3.1874 |
| ui | 19 | 96.7 | 1.429 |
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
| mv0tg3 | conductor | Oct 27 07:22 | testing | 8 | 95.0 | 0.2757 | Refresh the AC test-gap map on the integration head after the night (about 80 new commits), and prepare the round-2 tester index and the TESTING.md fact base, so local testing with Muse Spark drives the remaining test units to v0.2.0. |
| mvkp | conductor | Oct 27 07:32 | release | 5 | 93.2 | 0.0945 | Prove with Meta Muse Spark 1.3 that the capsule-ui-kit repository holds no secret, personal data or unsafe workflow in any reachable ref before the developer makes it public, and design its full code router. |
| mvr2c | conductor | Oct 27 08:01 | testing | 8 | 96.9 | 0.4935 | Context-engineer the round-2 external testing prompts (Jules and ChatGPT, T1-T8): embed verbatim excerpts of the software papers and OmniCodex language books, which the web testers cannot access, so each tester runs a complete, evidence-driven job on the public repo. |
| mvui9 | UI orchestrator | Oct 27 08:17 | ui | 4 | 97.1 | 0.2974 | Operator saw no recording menus, screenshot action or capsule action icons on wall tiles: add per-tile record-for-AI/screenshot/recording chrome over the new closed capture facade, adopt kit 0.2.1 tile actions and anchors, and audit every capsule action icon. |
| mvrv6 | conductor | Oct 27 08:48 | review | 4 | 93.6 | 0.0926 | Verify the findings (1 critical, 6 high, 10 medium) of the Gemini Argon cross-review of the day-2 integrations before any fix, and turn confirmed ones into Sol fix units. |
| mvvd2 | conductor | Oct 27 10:26 | submission | 4 | 94.9 | 0.0995 | Turn the measured day-2 evidence (live G-W1 with verified receipts, live G-AI with vision-engine and wender-agent, 25 fps wall, per-tile capture) into the demo video script, the shot list, a fact-checked TESTING.md and README update, all claims traceable to evidence. |
| mvr3 | conductor | Oct 27 11:09 | testing | 8 | 96.7 | 0.4913 | Write round-3 external testing prompts: ChatGPT as a mathematical reasoner using Context7 math-router plus the software papers and OmniCodex to prove invariants, derive test oracles and propose optimizations of the day-2 core features; Jules as pure tester of the same features. |
| mvui11 | UI orchestrator | Oct 27 11:30 | ui | 2 | 96.1 | 0.1675 | Close the renderer halves of AC-06 (multislot placement routed to the new authoritative layout intents) and AC-07 (recording panel export routed to capture.export with typed refusals), assigned to us by the MetaViewer orchestrator after the core contracts landed. |
| mvr2v | conductor | Oct 27 11:32 | testing | 6 | 96.3 | 0.2373 | Verify every external round-2 finding (ChatGPT static reviews T2, T3, T5, T6, T8 and Jules T4 tests) on the current head with Meta Muse Spark before any fix, and group confirmed ones into disjoint fix units. |
| mvr2v2 | conductor | Oct 27 11:32 | testing | 2 | 94.6 | 0.0584 | Verify every external round-2 finding (ChatGPT static reviews T2, T3, T5, T6, T8 and Jules T4 tests) on the current head with Meta Muse Spark before any fix, and group confirmed ones into disjoint fix units. |
| mvr2vj | conductor | Oct 27 12:08 | testing | 3 | 95.4 | 0.0758 | Verify the Jules round-2 test branches T4 (updated), T6 and T7 on the current head with Meta Muse Spark before adopting any test or opening any fix unit. |
| mv0tg4 | conductor | Oct 27 12:11 | testing | 6 | 95.1 | 0.1967 | Refresh the AC test-gap map on the integration head after the day-2 morning (about 50 integrations, round-2 fixes in flight) and audit the repository router, so Argon test and router units start from verified specs. |
| mvr2vj8 | conductor | Oct 27 12:23 | testing | 1 | 95.8 | 0.0279 | Verify the Jules round-2 test branches T4 (updated), T6 and T7 on the current head with Meta Muse Spark before adopting any test or opening any fix unit. |
| mvui14 | UI orchestrator | Oct 27 13:32 | ui | 2 | 97.4 | 0.1478 | Move live frame painting from the interim preload painter into the renderer (frame_port/v1 + frame_ack/v0.2 after the real paint), and fix three renderer defects measured live by the orchestrator: capture chrome not reacting, tile title ':100', 'Agent acting' without an agent. |
| mvrv7 | conductor | Oct 27 13:47 | review | 4 | 95.8 | 0.1389 | Verify the 25 findings (1 critical, 8 high) of the Gemini Argon cross-review of the day-2 afternoon integrations before any fix, and turn confirmed ones into disjoint fix units. |
| mvui14b | UI orchestrator | Oct 27 13:56 | fix | 1 | 97.1 | 0.0393 | Fix a blocking frame-port router defect (notice stream id compared with delivery surfaceGeneration would refuse every real frame) and align three legacy tests with the profile_id title contract. |
| mvui14c | UI orchestrator | Oct 27 15:51 | fix | 1 | 96.7 | 0.0508 | Fix the judge's blocking notes on MV-UI7: SurfaceCanvas retired the live frame port on every generation update, and CONTEXT_LOST did not close the stream. |
| mvac17 | conductor | Oct 27 15:59 | testing | 1 | 94.1 | 0.023 | Map AC-17 (nested demo) on the integration head and specify the smallest Argon units that make it pass live, with its negative control. |
| mvui17 | UI orchestrator | Oct 27 16:30 | fix | 3 | 96.2 | 0.1455 | Fix renderer findings from the second real-app vision round: QA anchor grammar (kit anchors with '/' were rejected), wall tile Fold with no visible effect, Activity count stuck. |
| mvui16b | UI orchestrator | Oct 27 16:46 | fix | 2 | 96.4 | 0.127 | Finish MV-UI8 (one type error) and fix real-app round 2 renderer findings: Float enabled in agent/READ mode, status bar contrast, recordings list never refreshed from the host. |
| mvui16d | UI orchestrator | Oct 27 17:04 | fix | 2 | 97.3 | 0.14 | Fix the judge notes on the MV-UI8 drop (stale echo replay, float geometry not applied by the kit, recordings refresh coalescing) and real-app L2-1 (local multislot toggles reaching the host). |
| mvui16e | UI orchestrator | Oct 27 17:30 | fix | 1 | 96.5 | 0.0489 | Reconcile four failures after rebasing the MV-UI8/MV-UI9 drop: respect the wall no-fromJSON contract, repair a stale negative control, align one host test assertion that pinned the recordings defect. |
| mvui18 | UI orchestrator | Oct 27 18:23 | fix | 1 | 97.4 | 0.0635 | BLOCKER: live frames never paint on the real app (canvas attach identity mismatch between frame router and SurfaceCanvas); plus frame scale jitter and kit view subscribe mirroring. |
| mvui18c | UI orchestrator | Oct 27 18:39 | fix | 1 | 95.1 | 0.0234 | Unblock the live-frames fix: one regression where a recreated frame stream acks REFUSED instead of PRESENTED. |
| mvui18d | UI orchestrator | Oct 27 18:48 | fix | 1 | 93.3 | 0.0496 | Before handing over the live-frames blocker fix: stop per-frame canvas detach/re-attach, clear retained frames on stream identity change, tidy duplicated checks. |
| mvrv8 | conductor | Oct 27 19:27 | review | 4 | 94.8 | 0.0961 | Verify the findings of the Gemini Argon cross-review of the day-2 evening integrations before any fix, and turn confirmed ones into disjoint fix units. |
| mvui19 | UI orchestrator | Oct 27 19:35 | fix | 3 | 97.0 | 0.2283 | Fix the renderer items from the evening cross-review (capture rows, empty profile id) and the minor findings of real-app round 3 (activity count, sticky toast, folded tile height, screenshots list, contrast, multislot anchors). |
| mvui20 | UI orchestrator | Oct 27 19:43 | fix | 1 | 96.4 | 0.0854 | URGENT: after the first live frame is presented, the following frames of the stream are refused and the tile falls back to Connecting (production-path e2e evidence). |
| mvui19b | UI orchestrator | Oct 27 19:58 | fix | 2 | 96.9 | 0.0973 | Finish MV-UI11: give the new screenshots control a kit icon and contract it in the icon audit; complete the multislot anchor grammar fix and contrast items from real-app round 3. |
| mvr3v3 | conductor | Oct 27 20:03 | testing | 8 | 97.0 | 0.5521 | Refresh the 16 round-3 tester prompts (8 ChatGPT, 8 Jules) to the CURRENT bridge/integration head before the operator launches them: they were written at midday and about 60 integrations landed since. |
| mvui20b | UI orchestrator | Oct 27 20:05 | fix | 1 | 98.3 | 0.0746 | Live tile turns black after a multislot round trip (second canvas for the same surface replaces and then removes the binding); black placeholder before the first frame. |
| mvui19c | UI orchestrator | Oct 27 20:15 | fix | 1 | 96.9 | 0.0563 | Fix a judge-found id/anchor collision between the recording panel's recordings and new screenshots sections before handover. |
| mvui21 | UI orchestrator | Oct 27 20:54 | fix | 1 | 95.8 | 0.0328 | URGENT: frame tests bound async waits by setImmediate turns and flake on loaded hosts, reddening unrelated integration gates; bound them by wall-clock deadlines (test-only). |
| mvui22 | UI orchestrator | Oct 27 21:06 | fix | 2 | 97.2 | 0.1283 | Live round 7 findings: the 4 s outcome toast is invisible on take/release although the activity is recorded; the Activity strip steals tile height (frame rescale); plus the MV-UI12 judge notes on the frame path. |
| mvui22b | UI orchestrator | Oct 27 21:26 | fix | 1 | 97.0 | 0.0505 | Finish MV-UI13 lane T with known causes: outcome toast stacked below kit overlay layers; Activity strip stealing tile height. |
| mvui23 | UI orchestrator | Oct 27 21:29 | fix | 1 | 96.7 | 0.0514 | TOP PRIORITY: on the real app the wall tile stays black from READY until a multislot round trip (startup race between frame-port notice/deliveries and the first canvas binding). |
| mvui23c | UI orchestrator | Oct 27 21:43 | fix | 1 | 96.5 | 0.047 | L8-1 follow-up: when the unbound hold window expires, ack HIDDEN and keep the frame so a late canvas still paints it (the host never resends a static frame). |
| mvui23d | UI orchestrator | Oct 27 21:58 | fix | 1 | 95.5 | 0.0702 | L8-1 co-cause from a verified review: reactive canvas width/height wipe the first painted frame; plus stream leak on unmount and stale retained frame on blanking. |
| mvui23e | UI orchestrator | Oct 27 22:16 | fix | 1 | 96.4 | 0.0485 | Align seven older frame tests with the corrected canvas sizing contract (the reactive canvas dimensions they pinned wiped the first frame, L8-1). |
| mvui24 | UI orchestrator | Oct 27 22:37 | fix | 2 | 97.3 | 0.1286 | Complete MV-UI13 with the remaining verified RV9 renderer items: capture refresh evicting rows, scheduler raw ids in DOM ids and never-destroyed entries, screenshot row ids/labels. |
| mvui25 | UI orchestrator | Oct 28 01:08 | ui | 2 | 97.2 | 0.1198 | Live finding: human typing and clicks never reach the capsule in WRITE mode with human control; build the renderer side of surface_input/v1 (input port, focusable canvas capture, mounting) and fix the READ-ONLY strip label. |
| mvui25b | UI orchestrator | Oct 28 01:26 | fix | 1 | 97.3 | 0.0563 | Fix pass for the human-input renderer drop: lane C's canvas capture broke 37 existing tests (new SFC imports unmapped in harnesses, unguarded blur) and vue-tsc; make the full gate green without weakening tests. |
| mvui25c | UI orchestrator | Oct 28 01:39 | fix | 1 | 95.6 | 0.0297 | Human-input renderer drop: key chords with punctuation or non-ASCII characters violate the host adapter key grammar; map them to X keysym names or drop them. |
| mvui25d | UI orchestrator | Oct 28 01:50 | fix | 2 | 95.4 | 0.0559 | Argon notes on the human-input renderer drop: an unavailable input port made the canvas focusable and swallow keys; fail closed, fix the strip oracle, harden mapper load failure and integer checks. |

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
| mv0tg3 | CORE | Test gaps CORE | Oct 27 07:22 | yes | 50 | 94.9 | 0.031108 |
| mv0tg3 | ADAPTER | Test gaps ADAPTER | Oct 27 07:23 | yes | 53 | 95.1 | 0.032759 |
| mv0tg3 | AGENTS | Test gaps AGENTS | Oct 27 07:23 | yes | 56 | 95.2 | 0.040303 |
| mv0tg3 | UIEL | Test gaps UIEL | Oct 27 07:23 | yes | 56 | 95.6 | 0.044436 |
| mv0tg3 | UISRC | Test gaps UISRC | Oct 27 07:23 | yes | 33 | 92.1 | 0.025485 |
| mv0tg3 | E2E | Test gaps E2E | Oct 27 07:23 | yes | 52 | 95.6 | 0.038849 |
| mv0tg3 | IDX | Round-2 tester index | Oct 27 07:23 | yes | 26 | 91.0 | 0.025073 |
| mv0tg3 | TST | TESTING.md fact base | Oct 27 07:23 | yes | 65 | 96.1 | 0.03766 |
| mvkp | SEC | Kit public audit SEC | Oct 27 07:32 | yes | 25 | 91.7 | 0.016575 |
| mvkp | PATHS | Kit public audit PATHS | Oct 27 07:32 | yes | 47 | 94.9 | 0.029627 |
| mvkp | WF | Kit public audit WF | Oct 27 07:32 | yes | 20 | 88.6 | 0.015448 |
| mvkp | LIC | Kit public audit LIC | Oct 27 07:32 | yes | 29 | 94.1 | 0.013866 |
| mvkp | ROUTER | Kit public audit ROUTER | Oct 27 07:33 | yes | 32 | 92.6 | 0.018948 |
| mvr2c | T1 | Round-2 context-engineered prompts T1 | Oct 27 08:01 | yes | 55 | 95.6 | 0.052605 |
| mvr2c | T2 | Round-2 context-engineered prompts T2 | Oct 27 08:01 | yes | 96 | 97.2 | 0.080201 |
| mvr2c | T3 | Round-2 context-engineered prompts T3 | Oct 27 08:01 | yes | 86 | 97.2 | 0.048532 |
| mvr2c | T4 | Round-2 context-engineered prompts T4 | Oct 27 08:01 | yes | 81 | 97.0 | 0.073367 |
| mvr2c | T5 | Round-2 context-engineered prompts T5 | Oct 27 08:01 | yes | 38 | 94.2 | 0.048991 |
| mvr2c | T6 | Round-2 context-engineered prompts T6 | Oct 27 08:01 | yes | 95 | 97.7 | 0.059117 |
| mvr2c | T7 | Round-2 context-engineered prompts T7 | Oct 27 08:02 | yes | 80 | 96.0 | 0.067963 |
| mvr2c | T8 | Round-2 context-engineered prompts T8 | Oct 27 08:02 | yes | 95 | 97.5 | 0.062708 |
| mvui9 | C | Capture port, reactive capture state and contract double | Oct 27 08:17 | yes | 43 | 95.1 | 0.031247 |
| mvui9 | T | Per-tile capsule chrome on the wall | Oct 27 08:18 | yes | 100 | 97.4 | 0.079043 |
| mvui9 | A | Kit 0.2.1 adoption, capture mounting and tile-chrome fixture | Oct 27 08:18 | yes | 100 | 96.3 | 0.111255 |
| mvui9 | I | Capsule action icon and anchor audit | Oct 27 08:18 | yes | 102 | 98.0 | 0.075807 |
| mvrv6 | d2core | Verify Argon findings d2core | Oct 27 08:48 | yes | 35 | 93.5 | 0.024234 |
| mvrv6 | d2adapter | Verify Argon findings d2adapter | Oct 27 08:49 | yes | 39 | 94.5 | 0.024701 |
| mvrv6 | d2agents | Verify Argon findings d2agents | Oct 27 08:49 | yes | 34 | 92.7 | 0.023151 |
| mvrv6 | d2uiel | Verify Argon findings d2uiel | Oct 27 08:49 | yes | 33 | 93.4 | 0.020509 |
| mvvd2 | SCRIPT | Video/docs SCRIPT | Oct 27 10:26 | yes | 26 | 91.6 | 0.015845 |
| mvvd2 | SHOTS | Video/docs SHOTS | Oct 27 10:26 | yes | 49 | 95.1 | 0.027942 |
| mvvd2 | TESTING | Video/docs TESTING | Oct 27 10:26 | yes | 67 | 96.7 | 0.036815 |
| mvvd2 | README | Video/docs README | Oct 27 10:27 | yes | 20 | 89.0 | 0.018915 |
| mvr3 | T1 | Round-3 prompts T1 | Oct 27 11:09 | yes | 66 | 95.7 | 0.054374 |
| mvr3 | T2 | Round-3 prompts T2 | Oct 27 11:09 | yes | 68 | 96.4 | 0.047621 |
| mvr3 | T3 | Round-3 prompts T3 | Oct 27 11:10 | yes | 47 | 94.6 | 0.041853 |
| mvr3 | T4 | Round-3 prompts T4 | Oct 27 11:10 | yes | 88 | 97.4 | 0.085894 |
| mvr3 | T5 | Round-3 prompts T5 | Oct 27 11:10 | yes | 97 | 96.2 | 0.087655 |
| mvr3 | T6 | Round-3 prompts T6 | Oct 27 11:10 | yes | 96 | 97.4 | 0.069752 |
| mvr3 | T7 | Round-3 prompts T7 | Oct 27 11:10 | yes | 92 | 97.4 | 0.055781 |
| mvr3 | T8 | Round-3 prompts T8 | Oct 27 11:10 | yes | 71 | 96.6 | 0.048409 |
| mvui11 | L | AC-06 multislot placement over authoritative layout intents | Oct 27 11:30 | yes | 98 | 95.7 | 0.10533 |
| mvui11 | E | AC-07 recording export over capture.export | Oct 27 11:31 | yes | 68 | 96.6 | 0.062207 |
| mvr2v | T5 | Verify round-2 T5 | Oct 27 11:32 | yes | 97 | 97.2 | 0.052739 |
| mvr2v | T6 | Verify round-2 T6 | Oct 27 11:32 | yes | 94 | 97.1 | 0.059743 |
| mvr2v | T8 | Verify round-2 T8 | Oct 27 11:32 | yes | 32 | 92.7 | 0.02389 |
| mvr2v | T3 | Verify round-2 T3 | Oct 27 11:32 | yes | 43 | 94.5 | 0.024206 |
| mvr2v | T2 | Verify round-2 T2 | Oct 27 11:32 | yes | 67 | 96.4 | 0.050364 |
| mvr2v | J4 | Verify round-2 J4 | Oct 27 11:32 | yes | 39 | 93.4 | 0.026407 |
| mvr2v2 | T7 | Verify round-2 T7 | Oct 27 11:32 | yes | 30 | 92.5 | 0.021523 |
| mvr2v2 | T4 | Verify round-2 T4 | Oct 27 11:32 | yes | 56 | 95.5 | 0.03689 |
| mvr2vj | J4 | Verify round-2 J4 | Oct 27 12:08 | yes | 54 | 95.5 | 0.030159 |
| mvr2vj | J6 | Verify round-2 J6 | Oct 27 12:08 | yes | 34 | 94.4 | 0.015961 |
| mvr2vj | J7 | Verify round-2 J7 | Oct 27 12:09 | yes | 56 | 95.7 | 0.029714 |
| mv0tg4 | CORE | Gap map CORE | Oct 27 12:11 | yes | 67 | 96.5 | 0.038911 |
| mv0tg4 | ADAPTER | Gap map ADAPTER | Oct 27 12:11 | yes | 42 | 94.2 | 0.029121 |
| mv0tg4 | AGENTS | Gap map AGENTS | Oct 27 12:11 | yes | 45 | 95.0 | 0.036006 |
| mv0tg4 | UIEL | Gap map UIEL | Oct 27 12:11 | yes | 38 | 93.7 | 0.029083 |
| mv0tg4 | E2E | Gap map E2E | Oct 27 12:11 | yes | 57 | 95.6 | 0.041027 |
| mv0tg4 | ROUTER | Router audit | Oct 27 12:11 | yes | 36 | 93.1 | 0.022537 |
| mvr2vj8 | J8 | Verify round-2 J8 | Oct 27 12:23 | yes | 60 | 95.8 | 0.027931 |
| mvui14 | F | Frame port consumer and painting | Oct 27 13:32 | yes | 100 | 97.6 | 0.08969 |
| mvui14 | W | Capture chrome reactivity, tile title, agent chip | Oct 27 13:32 | yes | 82 | 97.1 | 0.058136 |
| mvrv7 | pmadapter | Verify pmadapter | Oct 27 13:47 | yes | 47 | 94.7 | 0.040462 |
| mvrv7 | pmagents | Verify pmagents | Oct 27 13:47 | yes | 55 | 96.3 | 0.028329 |
| mvrv7 | pmtests | Verify pmtests | Oct 27 13:47 | yes | 39 | 94.0 | 0.023338 |
| mvrv7 | pmui | Verify pmui | Oct 27 13:47 | yes | 76 | 96.8 | 0.046767 |
| mvui14b | B | stream id + title tests | Oct 27 13:56 | yes | 75 | 97.1 | 0.039263 |
| mvui14c | C | frame router judge notes | Oct 27 15:51 | yes | 75 | 96.7 | 0.050846 |
| mvac17 | ROUTER | AC-17 plan | Oct 27 15:59 | yes | 38 | 94.1 | 0.023028 |
| mvui17 | Q | QA anchor grammar v2 | Oct 27 16:30 | yes | 64 | 96.3 | 0.030881 |
| mvui17 | W | Wall tile Fold visible effect | Oct 27 16:30 | yes | 100 | 96.5 | 0.088908 |
| mvui17 | A | Activity count | Oct 27 16:31 | yes | 47 | 95.1 | 0.025678 |
| mvui16b | T | type error, Float gating, status bar contrast | Oct 27 16:46 | yes | 82 | 97.5 | 0.057206 |
| mvui16b | R | recordings list refresh | Oct 27 16:46 | yes | 72 | 95.2 | 0.069815 |
| mvui16d | P | placement echo, float geometry, L2-1 | Oct 27 17:04 | yes | 102 | 97.5 | 0.096288 |
| mvui16d | R | recordings refresh coalescing | Oct 27 17:04 | yes | 61 | 96.6 | 0.043733 |
| mvui16e | E | post-rebase reconciliation | Oct 27 17:30 | yes | 70 | 96.5 | 0.048876 |
| mvui18 | J | live frames paint (L3-1) + jitter + subscribe mirror | Oct 27 18:23 | yes | 96 | 97.4 | 0.063491 |
| mvui18c | S | second stream re-registration | Oct 27 18:39 | yes | 45 | 95.1 | 0.023382 |
| mvui18d | D | SurfaceCanvas judge notes | Oct 27 18:48 | yes | 49 | 93.3 | 0.049622 |
| mvrv8 | evadapter | Verify evadapter | Oct 27 19:27 | yes | 40 | 93.8 | 0.026009 |
| mvrv8 | evcontracts | Verify evcontracts | Oct 27 19:27 | yes | 50 | 95.0 | 0.023924 |
| mvrv8 | evui | Verify evui | Oct 27 19:27 | yes | 52 | 95.3 | 0.023144 |
| mvrv8 | evci | Verify evci | Oct 27 19:27 | yes | 45 | 95.0 | 0.023045 |
| mvui19 | C | capture rows and screenshots list | Oct 27 19:35 | yes | 99 | 97.5 | 0.070197 |
| mvui19 | A | activity count, sticky toast, empty profile id | Oct 27 19:36 | yes | 93 | 97.7 | 0.07481 |
| mvui19 | U | folded height, contrast, multislot anchors | Oct 27 19:36 | yes | 100 | 95.5 | 0.083317 |
| mvui20 | F | subsequent frames REFUSED | Oct 27 19:43 | yes | 101 | 96.4 | 0.085444 |
| mvui19b | I | icon audit for the new screenshots control | Oct 27 19:58 | yes | 59 | 96.3 | 0.038018 |
| mvui19b | U | multislot anchors and contrast | Oct 27 19:59 | yes | 98 | 97.3 | 0.059246 |
| mvr3v3 | T1 | Refresh round-3 T1 | Oct 27 20:03 | yes | 50 | 95.5 | 0.037372 |
| mvr3v3 | T2 | Refresh round-3 T2 | Oct 27 20:03 | yes | 100 | 97.4 | 0.091518 |
| mvr3v3 | T3 | Refresh round-3 T3 | Oct 27 20:03 | yes | 98 | 97.8 | 0.069307 |
| mvr3v3 | T4 | Refresh round-3 T4 | Oct 27 20:04 | yes | 95 | 97.6 | 0.06823 |
| mvr3v3 | T5 | Refresh round-3 T5 | Oct 27 20:04 | yes | 49 | 94.5 | 0.085346 |
| mvr3v3 | T6 | Refresh round-3 T6 | Oct 27 20:04 | yes | 98 | 97.3 | 0.076588 |
| mvr3v3 | T7 | Refresh round-3 T7 | Oct 27 20:04 | yes | 98 | 97.1 | 0.083823 |
| mvr3v3 | T8 | Refresh round-3 T8 | Oct 27 20:04 | yes | 50 | 95.5 | 0.039923 |
| mvui20b | M | multi-canvas binding + placeholder | Oct 27 20:05 | yes | 100 | 98.3 | 0.074583 |
| mvui19c | R | cross-section id uniqueness | Oct 27 20:15 | yes | 72 | 96.9 | 0.056318 |
| mvui21 | W | wall-clock bounded waits | Oct 27 20:54 | yes | 55 | 95.8 | 0.032847 |
| mvui22 | T | toast visibility + strip height | Oct 27 21:06 | yes | 96 | 97.2 | 0.069539 |
| mvui22 | F | MV-UI12 judge notes | Oct 27 21:06 | yes | 84 | 97.3 | 0.058729 |
| mvui22b | T | toast z-index + strip height | Oct 27 21:26 | yes | 77 | 97.0 | 0.050467 |
| mvui23 | S | startup race: deliveries before canvas binding | Oct 27 21:29 | yes | 62 | 96.7 | 0.05142 |
| mvui23c | H | hold expiry keeps bytes | Oct 27 21:43 | yes | 65 | 96.5 | 0.04701 |
| mvui23d | C | canvas dimensions + unmount + blanking | Oct 27 21:58 | yes | 75 | 95.5 | 0.070191 |
| mvui23e | T | mvui18 tests vs new sizing contract | Oct 27 22:16 | yes | 63 | 96.4 | 0.048504 |
| mvui24 | R | capture refresh + shot rows | Oct 27 22:37 | yes | 95 | 97.2 | 0.067596 |
| mvui24 | S | scheduler DOM ids + entry lifecycle | Oct 27 22:37 | yes | 87 | 97.4 | 0.060989 |
| mvui25 | P | input port, key map, frame map, double | Oct 28 01:08 | yes | 57 | 96.5 | 0.053615 |
| mvui25 | A | mounting and gating in App | Oct 28 01:09 | yes | 100 | 97.6 | 0.066224 |
| mvui25b | C | canvas capture gate fix | Oct 28 01:26 | yes | 97 | 97.3 | 0.056333 |
| mvui25c | P | keyMap chord grammar | Oct 28 01:39 | yes | 53 | 95.6 | 0.029741 |
| mvui25d | C | unavailable port fails closed | Oct 28 01:50 | yes | 52 | 95.7 | 0.034515 |
| mvui25d | P | safe integer checks | Oct 28 01:51 | yes | 40 | 94.8 | 0.021396 |

## Method

- Source: the per-lane run record of each Muse Spark 1.3 call (model id, effort, usage counters, USD as reported
  by the client, agent steps, wall time). Start time comes from the session UUIDv7.
- Cache hit % = cache-read input tokens / (fresh input + cache-read input tokens).
- Scope: this ledger lists Meta model usage only. Other development tools I used (editor, CI and non-Meta
  coding assistants) are outside its scope and are not part of the product.

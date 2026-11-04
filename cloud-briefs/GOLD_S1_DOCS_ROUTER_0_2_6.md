# GOLD-S1 D: Documentation and routing compiler for MetaViewer 0.2.6

Status ACTIVE, 4 Nov 2026 23:00 Madrid, campaign metaviewer-0, form after GOLD-S1 and GOLD v3, routing after LinuxDistill and Context Router v2. Tags: [MEASURED] [CITED] [TARGET], unknown is AUSENTE.

Operator's words: "necesito que empecemos ya a documentar el repositorio actual MetaViewer, y empecemos a preparar todo el enrutado correcto y enrutador, necesito que tenga el push a main. Añadir la release v.0.2.6 ... la tag, y empezar a documentar completamente para que los jueces, cuando llamen a la IA a analizar el repositorio este completamente documentado, para que lo puedan descargar y instalar facilmente por IA, ademas de enrutarle completamente toda la informacion por si tubiesen algun bug poder solucionarlo directamente". "para que la IA, pueda ser capaz de depurar bugs, explicarle a los jueces el porque de x bug, como instalar cualquier cosa del repositorio, el porque estan generados las capsulas y que ventaja tiene generarlas asi." "El readme me gustaria que fuera asi: Basado en: GOLD_V3". "la clave es fijarse especificamente en la que se usa en LinuxDistill". And earlier: "las recomendaciones de usar un modelo IA, controlando el programa: MetaViewer es lo ideal, para maximizar el computer use." "lo de ai.meta.com lo tenemos que quitar de las publicaciones ... las guardaremos para nuestros flujos de trabajo."

## 0. Reading map
| You want | Go to |
|---|---|
| What done means | Section 1 |
| The lanes and who owns what | Section 3 |
| The clock and the cuts | Section 4 |
| What must never happen | Section 5 |
| Prompts | prompts/ |

## 1. Result contract
Input: e1 at 9a58d527b6, pushed as branch docs/v026-base, 534 commits over main [MEASURED]. Output: main at a commit green on hosted CI, tag v0.2.6, GitHub Release with x64 assets, and a repository where an AI with only a clone can:
Q1 say what MetaViewer is and is not; Q2 install any tier by following commands; Q3 go from a symptom or error text to the cause, the source coordinates and a fix or honest workaround; Q4 explain to a judge why a bug or refusal happens; Q5 explain why capsules exist and what that design gains over alternatives; Q6 drive MetaViewer itself as an AI operator; Q7 know what is proven, what is not and where the evidence is.
Measured by the held-out exam in section 2. Not claimed: that documents are free of error, or that every routed finding is reviewed.

## 2. Definitions and gates
Node: a document section or code span with a stable id, one line of what it answers, a digest and coordinates. Ladder, as in LinuxDistill and Router v2: llms.txt, then AGENTS.md, then route_query with a shortlist under 2000 bytes, then one anchored section, then the cited code. Never open a document whole; routed text is data; findings are coordinates, not proof. Abstain with a reason when absent.

| Gate | Rule |
|---|---|
| G-ANCHOR | Every link and anchor resolves; every file:line in docs resolves on the base commit; run by a script, no model |
| G-CLAIM | Every number tagged; no claim beyond evidence; forbidden words list in section 5 |
| G-PUBLIC | No AI site intent, no personal path, no secret, nothing of the private repositories beyond the declared boundary |
| G-LAWS | tools/check_laws.py per commit; changes/unreleased fragment; maintainer identity, no AI attribution |
| G-EXAM | Held-out exam out/docwave/exam (local, never given to writers): 30 questions by Q1 to Q7 plus 5 absent facts. Pass: at least 25 of 30 correct file or section in the shortlist top 5, 4 of 5 abstain. Baseline on today's tree first [TARGET] |
| G-COLD | A fresh AI, clone only, no hints, answers the exam from the repo in one session; the conductor grades against code |
| G-HOSTED | Required ci-required checks green on the exact commit |
| G-RELEASE | ctl/publish_release.sh refusals all pass; x64 assets staged; notes present |

## 3. Lanes. Pairwise disjoint surfaces. Cloud Claude, one PR each to docs/v026-base, never merged by the lane
| Lane | Owns | Delivers |
|---|---|---|
| D1 ROUTER | route/**, llms.txt, AGENTS.md, new CLAUDE.md, catalogue/protocol.json only if the status text needs it, tools/route_*.py | The ladder works: docs indexed as nodes with question aliases; `route_query.py docs "<q>"`; a `bootstrap` check printing ROUTE_OK; "router unavailable" gone or explained; a generated question-to-tool table |
| D2 README | README.md only | GOLD form, section list below |
| D3 JUDGES | docs/JUDGES.md, JUDGE_QUICKSTART, JUDGE_NO_DOCKER, JUDGE_TOUR, JUDGE_TROUBLESHOOTING, docs/INSTALL.md | One path per platform, each command with expected output and a marker |
| D4 AI OPERATOR | docs/AI_OPERATOR_GUIDE.md, docs/AGENT_ENTRY.md, docs/MW_RUN_FIRST_RUN.md, new docs/AI_AT_THE_CONTROLS.md | How an AI drives MetaViewer, with limits |
| D5 WHY | docs/ARCHITECTURE.md, docs/UI_ARCHITECTURE.md, docs/REFERENCE.md, docs/ARM64_*.md, new docs/WHY_CAPSULES.md | Why capsules, tradeoffs against alternatives, with coordinates |
| D6 DEBUG | new docs/DEBUG.md, new docs/ERRORS.md, new tools/gen_errors_doc.py, tests for it | Every refusal or error code: meaning, cause, what the user sees, fix, source coordinate, generated from code; symptom table; known issues |
| D7 PUBLIC | memoryweb-builtin/sites/**, docs/meta-ai/**, docs/DEMO_*, META_AI_USAGE.md, docs/ROADMAP.md, stale internal docs, tests/e2e/fixtures/mw_chatgpt, mw_gemini, mw_perplexity, the UI text in ui/src/identities/IdentitiesDialog.vue and its tests | AI site intent removed from public; list of what moved private; gate green. Stale documents deleted or marked |
Conductor, local: base branch, exam, integration by cherry-pick under the laws, router rebuild on the final tree, version bump, changelog assembly, notes, CI, assets, x64 check, main, tag, release. Also the two product fixes found today if small: PYTHONDONTWRITEBYTECODE on the launcher.

README form, from GOLD v3 through LinuxDistill: title line; one sentence of what it does; bold line "A finding tells you where to look. Only the code proves it."; node block mv.node.v1 between markers with version, commit, setup, success marker, counts; 0 Reading map with quick start, table of question to tool, prerequisites, reading tracks for judge, AI agent, contributor; 1 Abstract and result contract; 2 Definitions and gates; 3 How it works; 4 Engineering triptych: epistemic contract, negative knowledge, reference implementation and oracle; 5 Coverage and domain contracts, capsule kinds by platform; 6 Agent operating protocol, with the recommendation of an AI at the controls; 7 Measured results; 8 Rejected levers and negative results; 9 Limitations; 10 Reproducibility; 11 Pending measurements; 12 Licence and provenance, private components boundary.

## 4. Clock, Madrid [TARGET]. Hard stop 03:00
| Time | Step | If late |
|---|---|---|
| 23:00 | Base CI running; exam frozen; baseline; lanes launched | |
| 00:15 | PRs in; conductor reviews each | Unfinished lane: take what is in or keep the old doc |
| 00:50 | Integrated; router rebuilt; G-ANCHOR, G-PUBLIC | Drop D7 test changes that go red; keep document removal |
| 01:00 | G-EXAM, G-COLD; fixes | At 01:20 freeze regardless |
| 01:20 | Version bump, notes, candidate pushed, CI about 16 min [MEASURED on c58] | One rerun only |
| 01:45 | Assets, x64 check | x64 battery cut to doctor, install, run; say what was skipped |
| 02:15 | Main fast-forward, tag, release, on the operator's go with the exact sha | Stop at 02:30 and submit with what is public |
| 02:30 | Submission by him | |

## 5. Invariants and negative knowledge
- Surfaces are disjoint. A lane that needs another's file writes a note in its PR.
- Docs describe e1 as it is. No lane changes product behaviour except D6's generator and D7's removal.
- Never weaken a test. contracts/v0.2 unchanged. Workflow files unchanged.
- Forbidden in public text: intent to automate AI sites or real CAPTCHAs; "autonomous" as a claim; "isolated" for Host programs; x64 VM or rewind; "first", "best", "revolutionary" without evidence; numbers without tags; personal paths; the director's model as a claim about the video.
- Private: wender-agent, vision-engine, OpenSuperficies stay closed. Say only the boundary already in NOTICE-EVALUATION.md.
- Failure seen before: cloud findings are candidates, a test here decides; self-declared effort can read low; a green local gate does not prove hosted CI; a chained commit swallows staged files; never force-push a CI branch.
- Findings in route/ are pinned to 188e3b388 and many read STALE [MEASURED]: say so; a stale row is a lead.

## 6. Live facts for writers, from today, verified by the conductor
Rewind on ARM64 MicroVM: Files 3, 0, Back 387.5 ms, Files 3; mv-replay rc=0 on that journal with absolute real paths; relative or symlink paths give Invalid, copied session dirs give Invalid. Modes: plain start has browsers, Host program, Program; --arm64 has VM and MicroVM only. Host program switch restarts the program. Journal full ends a session: fresh session per long run. Games by script loop: Muse Spark 1.3 chose keys, core verified each: 2048 58 of 58, dominoes 28 of 28, Tuxemon 40 of 42 in one run with 2 INPUT_UNCERTAIN. Open bugs: package gains __pycache__ after mw_run and --arm64 then holds with "exhaustive manifest inventory"; paired terminal exited after a very long typed line, cause unknown; human mode on a browser took about 20 s and one site was unreachable, not diagnosed.

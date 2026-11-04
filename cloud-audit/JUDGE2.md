# Second AI judge pass: MetaViewer

Reader: an AI judge reading this repository for the first time, time-boxed to about 30 minutes.
Machine: Linux x86_64, Ubuntu 24.04, 4 CPUs, 15 GiB RAM, Python 3.13, Node 22, Rust 1.97, Go 1.24, a Docker CLI and no Docker daemon, no visible display [MEASURED].
Snapshot: branch `ci/assets-07a62f32c`, commit `07a62f3`, `VERSION` 0.2.5. This commit is 1 commit past tag `v0.2.5` (`7721915`, also `origin/main`) [MEASURED]. Judges who open the default branch today see the tag version of the docs, not this one.
Read in order: `README.md`, `llms.txt`, `docs/JUDGE_QUICKSTART.md`, `docs/JUDGE_NO_DOCKER.md`, `docs/EVIDENCE.md`, `docs/JUDGE_TOUR.md`, `docs/REFERENCE.md`, then spot reads of `NOTICE-EVALUATION.md`, `docs/JUDGES.md`, `VM_MICROVM_ROADMAP.md`, `docs/ARM64_MICROVM_REWIND.md`, `META_AI_USAGE.md` and the v0.2.5 release page.
Tags: [MEASURED] means I ran or counted it here. [CITED] means the repository or release page says it. [TARGET] means a stated intent. The scores are judgments, not measurements. I wrote the scores before I read the first judge report (section 12).

## 1. What it is after 2 minutes

The first sentence of the README works: "a Linux desktop wall of live browser and application surfaces, with explicit human and AI agent control" [CITED: README L3]. In two minutes I understood the following:

- An Electron/Vue desktop app tiles live surfaces called capsules. A capsule is a browser identity or Linux program in a container run by a private executor, a host program, or an attached X11 window. Only the container routes are isolated.
- A human or an agent holds each tile. A Rust core admits or refuses every action. It refuses an agent action based on a stale frame, and human takeover cancels pending agent work. A hash-chained journal records every decision, and `mv-replay` can verify it.
- Three load-bearing parts are private: the planner (`wender-agent`), perception (`vision-engine`) and the capsule runtime (`OpenSuperficies`). They ship as compiled x64 builds for judges only.

What I did not get in 2 minutes is **why I would want it**. The README never names the problem in one sentence. A natural one would be: "supervising several computer-use agents at once, taking over at any moment, and proving afterwards what each agent was allowed to do". The first screen is mostly caveats: not isolated, private, ARM64-only VM, "legacy networking reaches no public site today". They come before any picture of the working product. Images and video are known to arrive at the freeze.

## 2. The idea in its era

By late 2026, agents with computer use are common. The open problem is supervision rather than raw capability: several agents in parallel, a person who can take over, credentials that do not leak, and an audit trail. MetaViewer aims straight at that problem, and the design choices fit it:

- **Stale-frame refusal** addresses a real failure mode of screenshot-driven agents: acting on a screen that has already changed. It is enforced in the core before dispatch, not in the agent [CITED: `core/src/admission/mod.rs:1219`]. The core admission tests pass here (section 5).
- **Shared live control with typed handoff.** Login walls and CAPTCHAs stop the run with `HUMAN_HANDOFF` for a person to solve; nothing tries to bypass them. After release, a fresh observation is required.
- **Save slots for identities.** Stopped browser and program profile data, including signed-in sessions, can be saved, loaded and copied, with custody checks and a human confirmation before credentials are copied [CITED: REFERENCE §2 "Stored data slots"]. REFERENCE says plainly that a slot is not a VM snapshot.
- **Rewind of a running MicroVM** is the most forward-looking idea: checkpoint an agent's environment, let it try, and roll the guest back on failure. It is also the least reachable. It is ARM64 and KVM only, developer setup only, absent on x64, and its document opens with "Unreleased feature branch" [CITED: `docs/ARM64_MICROVM_REWIND.md` L3]. The only result is [MEASURED] at commit `8b44747`, which I cannot resolve in this clone, so a receipt is `ABSENT — do not invent`.

Hosted browser sandboxes with live view and human takeover already exist. MetaViewer differs by being local-first, showing many capsules on one wall, and putting a single admission authority with typed refusals and a replayable journal under both human and agent input. I find that combination original. Its weak spot as a product of this era is that the agent itself (planner and perception) is private, and Muse on x64 is unverified [CITED: JUDGE_TOUR]. The shipped architecture therefore cannot reproduce the most interesting agent flows as verified.

## 3. What is impressive

- **The authority core is real and tested.** `admission_matrix`, `admission_journal` and `t1_journal_verify` pass: 48 of 48 tests in 3 test files [MEASURED: `cargo test -p metaviewer-core --test ...`]. They cover stale-frame refusal, durable replay, digest reconstruction and corruption rejection.
- **Contracts-first is enforced, not just stated.** There are 10 v0.1 and 41 v0.2 schemas, 20 v0.1 and 1196 v0.2 fixtures, and `tools/check_contracts.py` prints OK [MEASURED]. `tools/check_laws.py` OK, `test_reference_docs` 13 of 13 and `router_index --check` at 100% coverage of 3255 files [MEASURED]. Every README count I rechecked matched: schemas, fixtures, 40 Node and 6 Python E2E files, 6 workflows, 3 `deps.lock` components, 3538 lanes in 136 rooms [MEASURED].
- **The judge installer is careful.** It fetches pinned assets and checks them against a digest (T1 set: 3 files in about 7 s [MEASURED]). It asks before every administrator step, refuses with `JUDGE_<CODE>: problem -- fix: command`, writes a receipt without host paths, and stops cleanly. Every refusal I hit was accurate.
- **The T1 no-Docker route behaves exactly as documented.** As a normal user, install, doctor, run and stop printed the documented markers in order (section 5).
- **Evidence discipline.** `docs/EVIDENCE.md` separates source assertions, reported live runs and missing receipts. REFERENCE §4 has a claim, evidence and falsifier table and a "negative knowledge" table ("a receipt proves task success" and why that fails). Program text with an unreadable OCR result is labelled `PROGRAM_TEXT_UNCERTIFIED_NOT_READABLE` instead of passing. "Not isolated" appears wherever it applies.
- **Open network mode** (reported): public internet allowed, LAN and Docker bridge blocked, behind one visible administrator firewall step [CITED: release notes, raw receipt absent]. This is the right default stance for agents that browse.

## 4. What looks unproven

- **Every live result is maintainer-reported, with no receipt in the repository.** This covers browser Human/Agent tiles, 10 of 10 rules goals, calculator, handoff, Open network HTTP 200 and stop [CITED: JUDGE_TOUR, EVIDENCE]. EVIDENCE says so honestly. It is still the single biggest gap for a judge who cannot run T2.
- **The agent on the shipped architecture.** On x64 only the rules planner on local pages is reported. Muse on x64 is unverified. The calculator result is "sent, rc 0, text uncertified" [CITED]. Muse-driven flows (calculator 7+8, browser goals) are reported only on arm64, which has no release assets.
- **Performance.** The only live numbers are about 2.6–2.7 fps wall cadence from 2026-10-28 notes outside the repository [CITED: README "Historical live evidence"]. The README itself says current fps is unmeasured.
- **Isolation.** The isolation of browser and program capsules lives entirely in private `OpenSuperficies`. The public Go adapter tests prove handling with a fake executor, not that the deployed binary isolates anything [CITED: REFERENCE §3]. Judges have to take isolation on trust.
- **Save slots live.** There is source and Go tests for the slot store, but the tour's "Identity data and release" section has no architecture or verification line at all [CITED: JUDGE_TOUR].
- **Capture, terminal prompt buttons and recording**: "available; live verification absent" [CITED: JUDGE_TOUR table].
- **`META_AI_USAGE.md`**: 3,538 of 3,538 lanes "finished OK" [CITED]. The lane count reproduces [MEASURED]. A 100% success column with no failed lanes reads as unverifiable rather than wrong.

## 5. Quickstart on this machine (x86_64, no Docker daemon)

| Step | Result [MEASURED] | Did the docs warn me? |
|---|---|---|
| `doctor --before-install` as root, no `XDG_RUNTIME_DIR` | `JUDGE_XDG_RUNTIME ... /run/user/0 does not exist`, rc 2 | Yes, QUICKSTART "Before you start" |
| `preflight.sh --tier T2 --phase static` | `JUDGE_XDG_RUNTIME` and `JUDGE_DOCKER`, rc 2 | Yes; the no-Docker route is linked from "Before you start" |
| Same doctor with a user-owned runtime dir, **still root** | `JUDGE_DOCTOR_OK tier=T1 phase=before-install` | **Partly.** Docs say "run as a normal user" and cite `preflight.sh` "sandbox policy", but preflight has no root check. Its sandbox check is the AppArmor userns rule. Root passes the doctor. |
| `fetch_assets.py` T1 with `--dest` and the digest from the release notes | `JUDGE_FETCH_OK arch=x64 tier=T1`, 3 files, about 7 s | Yes; NO_DOCKER gives URL and says where the digest is |
| `install` (T1) under `xvfb-run`, root, stdin closed | Asked to `apt-get install x11-utils`; declining gave `JUDGE_SUDO ... fix: sudo apt-get install -y x11-utils` | Yes ("Install may request host packages") |
| `install` again after installing `x11-utils`, root | Extract OK, `JUDGE_PREFLIGHT_OK phase=display`, then `JUDGE_SMOKE ... Running as root without --no-sandbox is not supported`. The fix text says "check DISPLAY/xvfb-run and the AppArmor profile" | Warned in "Before you start", but too late to help: the refusal's own fix hint points the wrong way |
| `install` as a normal user | First attempt failed in `npm ci` with `SELF_SIGNED_CERT_IN_CHAIN`. That was this sandbox's TLS proxy CA, not the product. With the CA: `METAVIEWER_MAIN_SMOKE_OK`, `JUDGE_INSTALL_OK tier=T1 network=legacy` | Partly: QUICKSTART mentions that the source-checkout verifier "may also need `npm ci`". NO_DOCKER says nothing about install reaching the npm registry. |
| `doctor` (full) | `JUDGE_DOCTOR_OK tier=T1`; receipt has Node `v24.14.0` from the kit (host has 22) | Yes |
| `run` under `xvfb-run`, 30 s | `METAVIEWER_RENDERER_READY`, `METAVIEWER_MAIN_READY`, `METAVIEWER_ADAPTER_DEGRADED`, `METAVIEWER_ATTACH` | Yes, exactly as NO_DOCKER "What to observe" says |
| `stop` | `JUDGE_STOP_CLEAN`, plus `JUDGE_NOTE: ... TMPDIR is unset; shared /tmp roots cannot be attributed` | The TMPDIR note is not in any judge doc |
| `install --capsules` (T2) | Not attempted: no Docker daemon | Yes |
| Tour flows (capsules, agent, handoff, capture) | Not possible without T2 | Yes, the tour says T1 cannot start capsules |
| Public proof without private access | Rust core tests 48 of 48; contracts, laws, reference-doc and router checks OK | Partly: EVIDENCE links the test files, but no judge doc gives the one `cargo test` command that runs them |

**Where it stops:** T1 completes end to end, headless. I did not see the rendered wall because there was no visible display and I took no screenshot. Everything beyond T1 stops at the Docker daemon. I did not run `tools/gate.sh`: it needs the external UI kit, the Electron distribution and Go 1.26 (this host has 1.24).

**Value of the product and friction on my machine, kept separate.** My friction was being root, having no logind session, having no Docker daemon, and a sandbox TLS proxy. Most of it was mine, and the docs anticipated most of it. The product's own friction is real but inherent to what it does: T2 needs rootful Docker, about 16 GiB RAM, a firewall step for public browsing and a visible X11 or WSLg display. That is reasonable for a local multi-capsule wall, but it means most judges will judge from evidence. The evidence a judge can check (public source, contracts, core tests) is strong. The evidence a judge cannot check is the live agent and isolation behaviour, and that is exactly what the product promises.

## 6. Dead links and references

- Markdown links and anchors in 21 judge-path files: README, llms.txt, the 5 judge docs, REFERENCE, JUDGE_TROUBLESHOOTING, AI_OPERATOR_GUIDE, docs/README, AGENT_ENTRY, JUDGES, USER_GUIDE, INSTALL, NOTICE-EVALUATION, AGENTS, LAWS, PREEXISTING, VM roadmap, ARM64_CAPSULE_SETUP and TESTING. **No broken relative link or anchor** [MEASURED: script over GitHub-style heading slugs and explicit `<a id>`].
- External URLs: the v0.2.5 release page, its `SHA256SUMS` download and the repository all return HTTP 200 [MEASURED].
- Every backticked source path in the 7 entry documents exists, and every `path:line` coordinate is within its file [MEASURED]. The only non-resolving names are bare workflow file names, runtime files (`judge_receipt.json`, `policy/policy.json`) and the external `live21_NOTE.md` / `live22_NOTE.md`, which the docs declare external.
- Commits named as evidence, `8b44747…` (MicroVM rewind) and `07f2ada…` (VM roadmap), do not resolve in this clone. The clone is shallow, so I cannot tell whether they exist publicly: `ABSENT — do not invent`.

## 7. Contradictions

1. **The kit is Open-ready, but the docs say otherwise.** QUICKSTART §1 lists the image archive as `identity-browser:0.1.1`, `program-host:0.1.0` and `desktop:1.1.0`. The README warns up front that "legacy networking reaches no public site today". The actual `images-linux-x64.tar` of v0.2.5 contains `identity-browser-x64:0.2.0` (the Open image) **and** `0.1.1`, plus an unlisted `program-gtk-x64:0.1.0` [MEASURED: `manifest.json` in the release archive, sha256 matches the release digest]. The release notes say "with the x64 Open image". The docs undersell the one thing a Docker-equipped judge most needs to know: public browsing works if you accept the firewall step.
2. **The same result carries two provenance tags.** "Browser rules goals 10 of 10" is [MEASURED] in QUICKSTART "Troubleshooting" and in the tour's architecture table. In the tour header and its "Automate a browser goal" section it is [CITED: maintainer evaluation; raw receipt absent]. The same applies to "rc 0 [MEASURED]". By REFERENCE's own notation, a maintainer report with no receipt is [CITED].
3. **Handoff on x64.** The tour section "Take control and Release" says "x64 and arm64 — available; independent live handoff verification is not documented here". The tour's own table and the release notes say "Take control and Release verified by clicks on WSL2".
4. **The T0 tier.** QUICKSTART §2 lists T0 as "Offline conversation fixture only; no display, no Docker". `docs/JUDGES.md` needs "the locked Wender checkout configured through `MV_MW_WENDER_ROOT`", which is private source. T0 is not available to any judge.
5. **The root check.** QUICKSTART cites `scripts/judge/preflight.sh` "sandbox policy" for the root refusal. Preflight does not refuse root; Electron does, at install smoke (section 5).
6. **Primary architecture.** README "Platform" says the package "targets `linux-arm64` as primary". The only release assets are x64, and README L23 says so. The release page opens "Pre-release for Linux x64 and arm64".
7. **Pins and shipped binaries.** QUICKSTART says the compiled lock "binds the distribution to the source commit in `deps.lock`". The release notes say the x64 OpenSuperficies binaries "are built from a descendant of the commit named in `deps.lock`".
8. **x64 receipts in REFERENCE.** REFERENCE §5 lists Identity browser, Program, Host program and Desktop window on x64 as "live receipt ABSENT". The tour marks them "Verified". A legend sentence reconciles the two, but an AI that reads the table alone gets the opposite answer.
9. **The rewind doc's status.** `docs/ARM64_MICROVM_REWIND.md` opens "Unreleased feature branch" while it sits on the release-candidate branch and is linked from the release docs.
10. **A stale release page.** The v0.2.5 notes say "The quickstart's statement that no public release exists predates this release." The quickstart no longer says that, so the note now describes an error that is gone.

## 8. False claims and filler

- **Garbled sentence** in `docs/JUDGE_NO_DOCKER.md` "Inspect the core's proof without private access": "A ready-made, scrubbed journal for there is no standalone replay command." It sits in the one section written for judges without Docker.
- **[MEASURED] on unreceipted maintainer runs** (contradiction 2). This is the only place where a tag claims more than the evidence. I found no fabricated result.
- **"Complete … every MetaViewer feature"** (README repo map, describing `AI_OPERATOR_GUIDE.md`), while the tour says the recording panel's click route "is not documented here in this checkout".
- **Tag noise.** Every REFERENCE heading ends in `[TARGET]`. `[CITED]` is attached to code constants (`3` fps, `500x300`). The README "Features" frame-port bullet is a long run of identifiers, file paths and ack states. It is accurate but unreadable for a first pass, and it buries the few facts that matter.
- **Size.** `docs/JUDGE_TROUBLESHOOTING.md` is 106,700 bytes [MEASURED] and is linked first, above everything else, in QUICKSTART and the tour. An AI reader will truncate it.

## 9. Process residue

- Two consecutive commits share the subject "core: add x64 browser automation, program text and bug fixes". The second touches 1900 files (+95,177 / −9,151) against the tag, including 727 under `contracts/` and 655 under `catalogue/` [MEASURED: `git diff --stat v0.2.5..HEAD`].
- `AUSENTE` (Spanish) remains in 28 tracked files [MEASURED: `git grep -l`]. They include `contracts/v0.2/README.md`, `docs/UI_ARCHITECTURE.md`, `docs/DEMO_RUNBOOK.md`, `tests/perf/README.md` and UI sources. `LAWS.md` requires English-only on disk.
- `scripts/judge/fetch_assets.py` docstring begins `[TARGET, unit decision]`. That is brief text inside a judge-facing tool.
- Internal codenames in judge docs: `c26/c27`, `live21/live22`, `holdings-e1`, `AC-17`, `G-NOVAC`, `W2`. In `docs/` there are 40 entries [MEASURED], including `P18B-HEADER-MENUS.md`, `HOLDINGS_LESSONS_UI_ORCHESTRATOR.md`, `DEMO_PROPOSALS.md`, `RESEARCH_LOG.md` and `docs/research/` with `HANDOFF_OSCU0_UI_RESEARCH.md` and `REPORT_UIARCH_SOL_PASS2.md`. `changes/unreleased/` has `e1-*` and `p18*` fragments.
- `llms.txt` and `AGENTS.md` both announce "Status: router unavailable." on the AI front door. To a judging AI, that reads as a broken subsystem.
- The tour says "not documented here in this checkout", which is audit-note voice inside a user guide.
- `AGENTS.md` says "Automation never pushes". This report exists because an automated session was told to push it under the maintainer identity. I followed the operator's explicit instruction, but the law and the practice disagree.

## 10. Private components: how honestly is it stated?

Consistently and honestly. README, `llms.txt`, EVIDENCE, REFERENCE §3 and `NOTICE-EVALUATION.md` all say the same things:

- the source and repositories are closed;
- compiled x64 builds are downloadable for judge evaluation only;
- they are outside the AGPL, through a section 7 additional permission;
- there are no rights to redistribute, modify or reverse-engineer them;
- the licence changed at v0.2.5 (earlier releases were PolyForm Strict).

REFERENCE explicitly says that the public fake-executor tests "prove adapter handling, not that a deployed private binary obeys the same contract". That is the right sentence to have.

Two things weaken the statement. The `deps.lock` pins point at commits nobody outside can resolve, and the shipped OpenSuperficies build is a descendant of its pin (contradiction 7), so "pins" are not a verifiable identity for a judge. And the product's central promise, isolated capsules, rests entirely on the private part. Both are disclosed, but not side by side where a judge would weigh them. I did not access the private repositories.

## 11. Scores (1 to 10)

Evidence base: the repository, the release page and archive manifest, a full T1 install, run and stop on x86_64, and the public core tests. I did not run capsules, see the wall, or run an agent.

| Criterion | Score | Reason |
|---|---|---|
| Originality | 8 | A local wall where humans and agents share live control of many capsules under one admission authority with typed refusals, a hash-chained replayable journal, credential-custodied identity slots and (ARM64) MicroVM rewind. The individual parts exist elsewhere; this combination, aimed at supervising computer-use agents, is distinctive. |
| Technical depth | 8 | Rust authority with freshness, leases, budget and epochs; 51 schemas with 1216 fixtures, checked; journal with replay and typed exit codes; Go adapter with transport ceilings; Electron frame port with digest-checked acks. 48 of 48 core tests pass here. Capped because isolation, planner and perception are private and unauditable. |
| Value for agentic AI | 7 | It addresses the right problem: stale-observation actions, human takeover, CAPTCHA and login handoff, credential custody, auditability. But agent success is shown only by unreceipted maintainer runs, the hackathon's model (Muse) is unverified on the only shipped architecture, and the reported wall cadence is about 2.6 fps. |
| Usability | 5 | The installer is excellent at refusing clearly and asking before admin steps, and T1 worked as documented once I was a normal user. But the real product (T2) needs rootful Docker, about 16 GiB, a firewall step and a visible X11/WSLg display. The root failure surfaces late with a misleading fix hint. The docs that a person must read first are long and dense with identifiers. I could not see the UI itself. |
| Completeness | 6 | The x64 kit is published with images, runtime and Open network, and the main flows are reported on at least one architecture. Capture, terminal prompt buttons and slots lack live verification. VM, MicroVM and rewind are ARM64 developer-only. Compiled-mode stored workflows refuse. T0 is unreachable for judges. Storyboard is absent (and stated). |
| Documentation | 6 | Unusually honest and well linked: zero broken links, counts that reproduce, explicit `ABSENT`, a clean EVIDENCE guide and a judge summary in REFERENCE. Held back by a garbled sentence on the no-Docker page, a stale kit table that hides Open readiness, MEASURED/CITED mix-ups, the handoff and T0 contradictions, a missing one-line "why", heavy tag density, codename residue and a 107 KB troubleshooting file linked first. |

Unweighted mean: 6.7.

## 12. Compared with the first judge report (`origin/cloud/audit-judge:cloud-audit/JUDGE.md`)

The first pass audited `a7c36e9` and scored originality 7, technical depth 8, usability 4, completeness 6, documentation 6. It had no "value for agentic AI" row.

**Improved since then:**
- The README now says what the product is in its first sentence. The first pass found it only at line 31.
- The public release URL is stated consistently across README, QUICKSTART and NO_DOCKER. "Not established" and `AUSENTE` are gone from the judge index.
- Stale counts are fixed: 41 schemas, 1196 fixtures, and all counts reproduce. `tools/check_contracts.py` is green; it was red on the first snapshot.
- `docs/JUDGE_NO_DOCKER.md` and `docs/EVIDENCE.md` exist (first-pass edits 5 and 8, partly). The T1 markers they promise are exactly what I saw.
- "Before you start" now covers root, `XDG_RUNTIME_DIR`, `--yes` and `MV_JUDGE_ASSET_DIR`.
- `llms.txt` now begins with an ordered judge path, not AGENTS.md.
- REFERENCE gained a four-fact judge summary. Leaked "operator assignment", the "0.2.6" target, first-person README voice and "laptop-ready" are gone.
- The private-component paragraph now says plainly that compiled builds are downloadable for evaluation. The licence history is linked.

**Unchanged or worse:**
- The root problem is documented but not fixed. Preflight still passes as root, and `JUDGE_SMOKE` still points at DISPLAY and AppArmor. The doc's citation of preflight is now wrong (contradiction 5).
- The MEASURED versus CITED problem the first judge raised has only partly gone. "10 of 10 [MEASURED]" survives in two places.
- There is still no committed sample journal or one-command core proof. NO_DOCKER's journal paragraph was cut mid-sentence: this is a new regression.
- `AUSENTE` remains in 28 tracked files. `[TARGET, unit decision]` remains in `fetch_assets.py`. `JUDGE_TROUBLESHOOTING.md` is still about 107 KB and linked first. "Status: router unavailable" is still on the AI front door.
- The release page's stale line about the quickstart is still there.
- New since then: the stale image table that hides the kit's Open readiness, the handoff contradiction inside the tour, and a 1900-file commit that reuses the previous commit's subject.

Net: documentation is clearly better at the front door and on provenance of release assets. My scores are equal or one point higher on the four shared criteria. The two passes' scores are not strictly comparable, because I added the agentic-value row and was able to rerun the core tests.

## 13. Ten edits that would most raise the score, by value per effort

1. **`docs/JUDGE_NO_DOCKER.md`, section "Inspect the core's proof without private access".** Fix the garbled sentence. Add the one command a judge without Docker can finish: `cargo test -p metaviewer-core --test admission_matrix --test admission_journal --test t1_journal_verify` (48 tests, green here [MEASURED]). Say in one line what each file proves. This turns "I could not run it" into "I watched the core refuse a stale frame and verify a journal".
2. **`docs/JUDGE_QUICKSTART.md` §1 asset table and "Capsule network", and the README paragraph beginning "Legacy networking reaches no public site today".** List the real archive tags (`identity-browser-x64:0.2.0` and `0.1.1`, `program-host-x64:0.1.0`, `program-gtk-x64:0.1.0`, `desktop-x64:1.1.0`). State that the v0.2.5 x64 kit is Open-capable and that accepting the one firewall step enables public browsing with LAN blocked. Lead with what works.
3. **`docs/JUDGE_QUICKSTART.md` "Troubleshooting" paragraph and `docs/JUDGE_TOUR.md` "Architecture support at this snapshot" table and calculator sections.** Change "10 of 10 [MEASURED]" and "rc 0 [MEASURED]" to `[CITED: maintainer evaluation; raw receipt absent]`, as the tour header already does.
4. **`docs/JUDGE_TOUR.md` section "Take control and Release", Architecture line.** Align it with the table and release notes: x64 verified by clicks on WSL2, arm64 verified.
5. **`docs/JUDGE_QUICKSTART.md` §2 tier table, row T0.** Say that it needs the private locked Wender checkout and is not available to judges, or drop the row.
6. **`docs/JUDGE_QUICKSTART.md` "Before you start", first bullet, and `scripts/judge/preflight.sh` static phase.** Add a root refusal (`JUDGE_ROOT ... -- fix: run as a normal user`) so doctor fails early. Until then, correct the citation and quote the exact smoke symptom ("Running as root without --no-sandbox"). Also make the `JUDGE_SMOKE` fix hint mention root.
7. **`README.md` top, right after the first paragraph.** Add one "why" sentence (supervising several computer-use agents with takeover and an auditable record) and a three-line "verify in 10 minutes without Docker" pointer (T1 plus the core tests). Move the frame-port and capture identifier lists from "Features" into REFERENCE. Pair this with the frozen images and video.
8. **The v0.2.5 release page notes**, and `docs/EVIDENCE.md` "Private boundary". Delete the stale line about the quickstart. Replace "Pre-release for Linux x64 and arm64" with x64 assets only. State next to the pin text that x64 OpenSuperficies is built from a descendant of the `deps.lock` commit, and how that build is identified (asset digest).
9. **Residue sweep.** Remove "Status: router unavailable." from `llms.txt`, or move it below the judge path as contributor-only. Translate `AUSENTE` in the 28 files. Drop `[TARGET, unit decision]` from `scripts/judge/fetch_assets.py`. Replace `c26/c27` and `live21/22` with dates in judge docs. Move `docs/research/`, `P18*`, `HOLDINGS_*`, `DEMO_PROPOSALS.md` and `RESEARCH_LOG.md` under a `docs/history/` folder. Split `JUDGE_TROUBLESHOOTING.md` so the first link a judge sees is short.
10. **`docs/EVIDENCE.md` "Reported live evidence and its limits".** Commit scrubbed receipts for the x64 c26/c27 run under `docs/evidence/`: `judge_receipt.json`, the 10 `mw_run` reports, the stop diagnostics and the Open HTTP 200 probe. Run and record one Muse browser goal on x64. Highest value of all, but the most effort; it moves every "Verified" cell from [CITED] towards checkable.

## 14. Limits of this pass

- No Docker daemon, so no capsule, tour flow or agent run. No visible display, so I never saw the wall.
- To get past documented host checks I created `/run/user/0`, installed `x11-utils` through apt as the installer requested, and created a throwaway user `judge` with its own checkout copy and runtime dir. I gave that user this sandbox's proxy CA so that `npm ci` could reach the registry. Assets, builds and judge state went outside the repository (the session scratchpad and that user's home). The 435 MB image archive was downloaded only to read its manifest, then deleted.
- `AGENTS.md` says its ladder never reads `README.md`. The operator's task assigned README as the start, and this file is an audit report, not product code, so I followed the task.
- I did not run `tools/gate.sh` or `--self-test`, read `JUDGE_TROUBLESHOOTING.md`, `INSTALL.md`, `AI_OPERATOR_GUIDE.md` or `TESTING.md` in full, or inspect CI history.
- Only `cloud-audit/JUDGE2.md` was written. The repository `commit-msg` hook passes on this commit. `python3 tools/check_laws.py`, run after committing, flags it as "product code change requires a changelog fragment", because `cloud-audit/` is not in `NON_PRODUCT_PREFIXES` (`tools/check_laws.py` L34). The task allowed this file only, so no fragment was added.

Model: claude-opus-5-5 (Opus 5.5), confirmed by session metadata. Effort: session effort level `xhigh`.

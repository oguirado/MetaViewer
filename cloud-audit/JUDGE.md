# AI judge simulation: MetaViewer

Reader: an AI judge reading this repository for the first time, on a Linux x86_64 machine with 4 CPUs, 15 GiB RAM, Python 3.13, Node 22, Rust 1.97, Go 1.24, a Docker CLI and no Docker daemon.
Snapshot: branch `ci/assets-a7c36e9da`, commit `a7c36e9`, `VERSION` 0.2.5.
Order read: `README.md`, `llms.txt`, `docs/REFERENCE.md`, `docs/JUDGE_QUICKSTART.md`, `docs/JUDGE_TOUR.md`, then spot reads of `docs/README.md`, `docs/JUDGES.md`, `NOTICE-EVALUATION.md`.
Tags follow `AGENTS.md`: [MEASURED] means I ran it or counted it here; [CITED] means I am quoting the repository; [TARGET] means a stated intent. Anything I did not find is `ABSENT — do not invent`.

Deviation from `AGENTS.md`: the router ladder is declared unavailable and says "never read README". The task assigned README as the start, and this file is an audit report, not product code, so I followed the task. Only `cloud-audit/JUDGE.md` was written.

## 1. What the project is after 2 minutes

README lines 1 to 30 are links and a release-asset caveat. The first sentence that says what the product is comes at line 31 (and it is a 150-word sentence in the first person).
After reading `docs/REFERENCE.md` §1 as well, I understand it as follows.

- A Linux desktop "wall" in which each tile is a live, isolated surface (browser identity, containerised GUI program) or a host window. A human or an AI agent holds each tile, never both at once. [CITED: README L31, REFERENCE §1]
- The distinctive idea is the split of authority. A Rust core is the only thing that admits input. Electron paints frames and sends intents. A Go adapter drives the capsule executors. Python agents observe, propose and verify. Every admitted or refused event goes into a hash-chained journal that `mv-replay` can verify. [CITED: README L31, L98, L124-L137]
- The closed-contract discipline is unusually strict. Components talk only through versioned JSON schemas, each with valid and invalid fixtures, and an agent action needs a fresh frame and no human control. [CITED: README L100, REFERENCE §2 "Authority"]
- Three of the load-bearing parts (`wender-agent` planner, `vision-engine`, `OpenSuperficies` capsule runtime) are private and shipped only as compiled binaries. [CITED: README L14, NOTICE-EVALUATION.md]

One-line version I would write for the judges: "A wall of live, isolated app surfaces where a human can seize control from an AI agent at any instant, and every action is admitted and journaled by a Rust core."
The repository never states this in one line.

## 2. What is impressive

- **Authority model and honesty about it.** `docs/REFERENCE.md` §4 has a table of claims against evidence required against falsifier, and a "negative knowledge" table ("a receipt proves task success", "a vanished window frees identity"). I spot-checked `core/src/admission/mod.rs:1207` (returns `Refusal::StaleFrame`) and `:16` ("unknown dispatched work is never refunded"); both match the prose. [MEASURED]
- **Contracts discipline.** 10 v0.1 and 41 v0.2 schemas and 1194 v0.2 fixture files under `contracts/` [MEASURED]. At tag `v0.2.5` the contract checker passes [MEASURED].
- **Scale of real code.** About 59k lines of Rust, 65k of Go, 48k of Python and 227k of Vue/JS (the last count includes tests) [MEASURED: `wc -l` on `core`, `daemon-adapter`, `agents`, `ui`].
- **Refusal-first install UX.** `scripts/judge/preflight.sh` and `metaviewer-judge.sh` print `JUDGE_<CODE>: problem -- fix: command` and exit 2. On this machine every refusal I hit was accurate and had a usable fix. [MEASURED, section 4]
- **Honest limits.** Host program and Desktop window are repeatedly labelled "not isolated". Live fps is reported as 2.58 to 2.71 fps in the historical table, not inflated. Unverified x64 and arm64 cells are listed rather than hidden. [CITED: README L109-L116, JUDGE_TOUR architecture table]
- **Safety behaviours worth demonstrating.** Automation stops at CAPTCHA or login with `HUMAN_HANDOFF`; `INPUT_UNCERTAIN` is never auto-retried; acknowledging a notice does not resume a run. [CITED: README L75, JUDGE_TOUR]
- **Public release exists and is checksummed.** Release `v0.2.5` carries `SHA256SUMS`, the x64 app, node, images, `opensuperficies`, `vision-engine` and `wender-agent` archives. `fetch_assets.py` verified the T1 set in about 20 s. [MEASURED]

## 3. What looks unproven

- **Live behaviour of the headline feature.** The 4-capsule wall, agent drive, handoff and recording are claimed only through "maintainer evaluation c26/c27" on WSL2. That evaluation is not in the repository. `ABSENT — do not invent` for the c26/c27 notes. [CITED: JUDGE_TOUR L16; MEASURED: grep finds no such file]
- **Performance.** The only live number is about 2.6 fps over 61 s, taken from `holdings-e1/.../live21_NOTE.md` and `live22_NOTE.md`, which are explicitly outside the repo. The README says it has not measured fps since the current pins. The multi-capsule soak (>=4 capsules, >=10 fps, 10 min) is a [TARGET]. At 2.6 fps the wall is a slideshow, and nothing in the README says whether that is acceptable. [CITED]
- **Agent quality.** Rules planner "10 of 10" browser goals [CITED] is on local pages with exact control names. Calculator `2+3` ends in `PROGRAM_TEXT_UNCERTIFIED_NOT_READABLE`, so the one program demo is uncertified by its own docs. Muse on x64 is unverified. [CITED: JUDGE_TOUR L237, L16]
- **Private components.** The planner, vision and capsule isolation cannot be audited from this checkout. REFERENCE says so itself (§1, §3). A judge has no way to tell whether "isolated capsule" holds. [CITED]
- **`META_AI_USAGE.md` "3538 lanes across 136 rooms".** The figure is [MEASURED] against `docs/meta-ai/muse_lanes.json` and I reproduced it. It is a usage ledger, not evidence of quality, and it sits in the repo map next to technical artefacts. It reads as filler unless the file explains what a lane is.
- **Gate not reproducible here.** `python3 tools/check_contracts.py` fails on this branch (section 6). `bash tools/gate.sh --self-test` failed 8 of 31 tests on this host [MEASURED]. I did not diagnose them; Go 1.24 versus the required 1.26 and no offline cargo cache are likely causes. A judge cannot tell "my machine" from "the repo is red".

## 4. Quickstart on this machine (x86_64, no Docker daemon)

I ran only the steps that do not need Docker. Each row says what happened and whether the docs warned me.

| Step | Command (abridged) | Result [MEASURED] | Warned in docs? |
|---|---|---|---|
| Get the kit | `git clone --branch "$RELEASE_TAG" ...` | Tag `v0.2.5` exists; I used my checkout | Yes (§1), but README L27 says no public release URL is established |
| Fetch assets | `fetch_assets.py --source "$RELEASE_ASSET_DIRECTORY"` | Fails: `SHA256SUMS: No such file` (variable unset). With the URL and digest from the release notes it prints `JUDGE_FETCH_OK arch=x64 tier=T1` | Partly. The URL pattern is in QUICKSTART §1; the digest is only in the release notes, and README and `docs/README.md` say the URL is unknown |
| Static preflight, T1 | `preflight.sh --tier T1 --phase static` | Fails `JUDGE_XDG_RUNTIME` (no `/run/user/<uid>`; I am root in a container). Passes after creating that directory | Partly: the code and fix are printed, QUICKSTART only mentions logind in the WSL section |
| Static preflight, T2 | `preflight.sh --tier T2 --phase static` | Fails `JUDGE_DOCKER`: daemon unreachable. The message is accurate and the fix is correct | Yes. T1 versus T2 is explained |
| Install T1, as root | `xvfb-run -a ... install` | Gets through extraction and checksum, then fails `JUDGE_SMOKE`: Electron "Running as root without --no-sandbox is not supported" | **No.** Nothing says "do not run as root", and the failure text points at AppArmor and DISPLAY |
| Install T1, as a normal user | same, as user `jd` | `METAVIEWER_MAIN_SMOKE_OK`, `JUDGE_INSTALL_OK tier=T1 network=legacy` | n/a |
| Doctor T1 | `doctor` | `JUDGE_DOCTOR_OK tier=T1`. Node 22 on the host was handled by the kit's Node 24 | Yes |
| Run | `run` under `xvfb-run` for 25 s | `METAVIEWER_RENDERER_READY`, `METAVIEWER_MAIN_READY`, then `METAVIEWER_ADAPTER_DEGRADED OPENSUPERFICIES_ABSENT ... running core-only`. I did not look at the rendered window | Yes: T1 "creating a capsule fails with a clear error" |
| Stop | `stop` | `JUDGE_STOP_CLEAN` | Yes |
| Tier T2 (Docker, capsules) | `install --capsules` | Not possible: no daemon | Yes |
| Judge tour (all browser, program, takeover flows) | | Not possible without capsules | Yes, and the tour says what is unverified |

Other findings on the way:

- I ran `install --yes` once to see the next step. With `--yes` the launcher ran `apt-get update && apt-get install x11-utils` without further prompt. This is documented ("`--yes` answers for you") but is easy to trigger on a judge machine.
- A fresh `fetch_assets.py` with no `--dest` writes into `./assets/`, which is not git-ignored, so a judge's working tree becomes dirty with about 800 MB for T2. `MV_JUDGE_ASSET_DIR` and `MV_JUDGE_HOME` exist in the launcher but are undocumented in `docs/*.md` and `README.md` [MEASURED: grep]. Not warned.
- README "Build" (`cargo build --offline`, `npm ci --offline`) fails on a clean clone: "location searched: crates.io index". `go build` tries to download Go 1.26.0. Node 22 fails the `>=24` rule. The README says "the kit and Electron paths exported", but never says `--offline` needs a pre-populated cache. Not warned.
- Contracts checker fails on this branch (section 6). Not warned.
- The T0 fixture in `docs/JUDGES.md` needs a locked, private Wender checkout I do not have. The docs warn about that ("external prerequisite"), but it means there is no documented offline demo of the product that a judge without private access can run.

## 5. What I could not find

- A one-sentence pitch, a screenshot, a diagram of the wall, a GIF, or a video. (Known; README images arrive at the freeze.) The ASCII architecture diagram at README L124-L137 is the only visual.
- A "how this meets a hackathon" statement. I have been told to judge on five criteria only, and the repo does not list any; I invent none.
- A 60-second thing to run that proves the core without Docker, private repos or a GUI. For example a committed sample journal verified with `mv-replay` (the exit codes `rc 0/2/3/4` are documented at README L98). I found `.jsonl` files only under `route/` and the router kit [MEASURED: `find`]. If a sample journal exists, no document points at it.
- The c26/c27 evaluation notes, `live21_NOTE.md`, `live22_NOTE.md` (all `ABSENT — do not invent`).
- Any statement of what the product does when the agent is wrong at scale (error rate over many runs beyond "10 of 10").
- Any record of the cost or latency of an agent step in real time.
- A statement explaining why compiled private binaries are downloadable publicly from a release while the README calls them "fully private" (see section 7).

## 6. Dead links, paths and stale numbers

I checked every Markdown link and anchor in 16 judge-facing files (README, llms.txt-referenced docs, QUICKSTART, TOUR, REFERENCE, JUDGES, docs index, INSTALL, USER_GUIDE, ARCHITECTURE, AI_OPERATOR_GUIDE, JUDGE_TROUBLESHOOTING, PREEXISTING, NOTICE-EVALUATION, VM roadmap, META_AI_USAGE). **No dead relative link or bad anchor.** [MEASURED]
I resolved every backticked path in README, REFERENCE, QUICKSTART, TOUR, llms.txt and JUDGES. Every `path:line` coordinate is inside its file. Non-resolving items are only deliberate or generated: `holdings-e1/...live21_NOTE.md` and `live22_NOTE.md` (external, stated), bare workflow filenames, runtime-generated `judge_receipt.json` and `policy.json`, and `automation.json`/`NOTES.md` in `JUDGES.md` (not located; likely in a subfolder). [MEASURED]
I did not semantically verify every coordinate, only six (all matched).

Wrong or stale numbers, all tagged [MEASURED] in the docs:

- README L39, L100, L233: "`21` v0.2 schemas". Actual at this commit: 41. At `v0.2.5` the count was 21. [MEASURED]
- README L39: "`489` v0.2 fixtures". Actual at this commit: 1194 (`contracts/examples/v0.2/*.json`). [MEASURED]
- `python3 tools/check_contracts.py` at this commit fails with two errors on `guest_command_observation*.schema.json` ("unwitnessed alternative ... requester/component/enum/0"). At tag `v0.2.5` the same checker prints `Contracts check: OK`. [MEASURED] README presents this command under "Checks" as expected to pass.
- `docs/README.md` ("Judge reading order") contains `AUSENTE — no inventar`, Spanish, in a repo whose `LAWS.md` and `AGENTS.md` require English-only and the exact phrase `ABSENT — do not invent`. The same Spanish sits in `contracts/v0.2/README.md`, `tests/perf/README.md`, `memoryweb-builtin/sites/meta-ai/NOTES.md`. [MEASURED: grep] `README.md`, `docs/JUDGE_QUICKSTART.md`, `docs/AI_OPERATOR_GUIDE.md` and `docs/UI_ARCHITECTURE.md` also contain non-ASCII Latin letters; I did not check whether that is Spanish.

## 7. Contradictions between documents

1. **Public release.** README L27-L29: "A complete public release URL is not established here." `docs/README.md`: the complete public asset set is "AUSENTE". But the release `v0.2.5` publishes all x64 assets with a digest, and its notes say "The quickstart's statement that no public release exists predates this release." QUICKSTART §1 already gives the URL pattern. The repo's own front doors are the stale party.
2. **Tag meaning.** REFERENCE defines [MEASURED] as "inspected source or named command; static evidence does not imply a live run". README, QUICKSTART and TOUR use [MEASURED] for observed runs ("10 of 10", "HTTP 200"). The same word means "I read the code" in one document and "I ran it" in another.
3. **x64 status.** REFERENCE §5 says Identity browser and Program on x64: "Configured; live receipt ABSENT". JUDGE_TOUR and the release notes say x64 browser Human/Agent and isolated `gnome-calculator` are verified on WSL2. The two documents disagree on what has a receipt; REFERENCE says its unit has no receipts, and the TOUR cites ones not in the repo.
4. **Version.** README says `VERSION` 0.2.5 is "the release candidate"; the GitHub release is called "pre-release"; REFERENCE says "the requested release scope is 0.2.6 [TARGET: operator assignment]". The third is task-assignment text leaking into a public document.
5. **Windows.** QUICKSTART gives Windows 11 WSL2 steps and says "Windows itself is not a supported host"; README says Windows 10 WSL has no nested KVM; REFERENCE columns "Windows 10 WSL [CITED: operator target]". Three Windows stories.
6. **"Fully private" versus downloadable.** README L14 and L270, NOTICE: `wender-agent`, `vision-engine`, `OpenSuperficies` are "fully private". The release hosts their compiled forms for anyone, under an evaluation permission. The NOTICE explains this accurately; the README line does not. A judge reading only README thinks nothing of them can be downloaded. [CITED]
7. **License history.** NOTICE says releases up to v0.2.4 are PolyForm Strict 1.0.0; README and QUICKSTART say only AGPL-3.0-only. Not wrong, but the README gives no pointer to the change.
8. **Entry point.** `llms.txt` says "Read first: AGENTS.md, then catalogue/protocol.json" and "Status: router unavailable". AGENTS.md is an edit protocol that forbids reading README. A judging AI that obeys `llms.txt` is steered away from the judge docs, and a router that is "unavailable" is a visible self-declared fault on the front door.

## 8. False claims and filler

I found no claim I could show to be false in the sense of fabricated results. The risks are staleness and wording.

- **Stale [MEASURED] numbers** (section 6) are the closest thing to a false claim.
- **First-person "I" in the README** ("I build", "I run", "I keep") mixed with "the maintainer" and "the licensor" elsewhere. The voice shifts between documents.
- **Leaked process text** in public docs: REFERENCE L170 ("Router staleness after reference edits is expected and is not a unit blocker [CITED: operator execution header]"), L80 ("operator assignment"), `[TARGET, unit decision]` in `fetch_assets.py --help` and QUICKSTART L286, `[TARGET: document structure]` on every REFERENCE heading. These tell the reader the doc was produced against a brief.
- **Tag soup.** README L31-L105 carries bracketed tags and source lists in almost every sentence. The tagging is honest, but many tags cite a path for a number that is a language constant ("`3` [CITED] fps"). Density hides the three or four facts that matter.
- **CI count paragraph** (README L41) restates job counts four ways (20, 28, 13, 15, 10). It adds length, not insight.
- **Historical docs in the main index** (research log, router bootstrap, Holdings lessons, P18 design, rehearsal notes). The index labels them historical; they still make 38 files in `docs/` and about 800 KB, so first-pass retrieval wanders.
- **`JUDGE_TROUBLESHOOTING.md`** is 106 KB. It is linked from the top of README, QUICKSTART and TOUR. Size alone makes it unreadable on first pass; an AI will truncate it.
- "Laptop-ready" (README repo map) while the same table says T2 needs rootful Docker, sudo, firewall and 16 GiB RAM.

## 9. Is engineering depth findable fast?

Not on the first pass.
The best material, REFERENCE §4 (epistemic contract, negative knowledge, oracle) and `docs/ARCHITECTURE.md`, is 3 clicks away behind a 29 KB README and a `llms.txt` that points at agent edit rules instead. The README mentions the Rust core in its first prose sentence but never shows the admission decision itself: no short worked example of "agent proposes, frame stale, core refuses `STALE_FRAME`, journal records it, `mv-replay` reproduces the digest".
The strongest depth signal for a quick reader is the `mv-replay` return codes and the refusal enumeration; both are mid-README. An AI judge reading the first screen will see roadmap links, ARM64 caveats and an asset warning before seeing the product.
REFERENCE is the right document for an AI judge, but it opens with a JSON header and a reading map, and its "Judge" persona track lists only `Result → Limits → Tour`.

## 10. Scores (1 to 10)

Evidence base: the repository as read, a T1 install and run on x86_64, and the public release. I could not run capsules, view the wall, or run the agent loop.

| Criterion | Score | Reason |
|---|---|---|
| Originality | 7 | A human/agent hand-off wall with a single admission authority, journaled and replayable, and strict closed contracts, is a distinct design. Single-pane multi-surface walls and computer-use agents are not new, and the proof that it works with an agent in the loop is an external evaluation. |
| Technical depth | 8 | Authority core with freshness, leases, budget and epoch; 41 schemas; hash-chained journal with replay and typed exits; Go adapter with transport ceilings; slot custody; rewind design; Electron frame port with acks. Verified by size and spot checks, not by running the gate (the gate is red on this branch for contracts). The private binaries cap how much of the depth is auditable. |
| Usability | 4 | A judge on a normal laptop with Docker can probably reach T2 (verified on WSL2 by the maintainer), but I hit a root-user smoke failure with no warning, `XDG_RUNTIME_DIR` friction, `--yes` triggering apt, an asset directory that dirties the tree, and docs that say the release URL is unknown when it exists. Without Docker, the wall runs core-only, and there is no offline demo. 2.6 fps live is low. Score is capped by what I could actually reach. |
| Completeness | 6 | Many flows are verified on at least one architecture, with refusal states for the rest, and the "Not available yet" list is honest. But VM, MicroVM and rewind are arm64 developer-only, x64 program text is uncertified, Muse on x64 is unverified, and the nightly volume gate and G-NOVAC meta-oracle are absent. The gate is red on this snapshot. |
| Documentation | 6 | Unusually honest, unusually well cross-referenced, and zero dead links. But it is too big, too tag-dense, partly stale (counts, release URL, Spanish phrases), leaks process text, contradicts itself on release and x64 status, and has no one-line pitch. Honesty about private components is good in NOTICE and REFERENCE and weaker in README. |

## 11. Ten edits that would raise the score most, by value per effort

1. **`README.md` lines 1-30.** Replace the opening links with a 5-line pitch ("A wall of live isolated surfaces where a human can take control from an AI agent at any instant; a Rust core admits and journals every action"), a 3-row status table (works today / needs Docker / needs arm64), and a "10-minute path" link. Move the VM/ARM64/Windows caveats below Status. Highest value, lowest effort.
2. **`README.md` L27-L29, `docs/README.md` paragraph beginning "A complete public release asset set is AUSENTE", `docs/JUDGE_QUICKSTART.md` §1.** State the real `v0.2.5` source URL, say the manifest digest is in the release notes (or commit it as `assets.sha256`), and delete "not established"/"AUSENTE". Also state that arm64 compiled assets are `ABSENT — do not invent` for this release, as QUICKSTART L315 already says.
3. **`README.md` L39, L100, L233** (and the other stale counts, e.g. L41). Fix 21 to 41 and 489 to 1194, or drop the counts and say "see `contracts/`". Then fix the failing `tools/check_contracts.py` on `guest_command_observation*.schema.json` so the README's "Checks" block is green. A red documented check on the judged commit is the worst possible first impression for a "contracts first" project.
4. **`docs/JUDGE_QUICKSTART.md` §2, before "Check your machine".** Add a short "Before you start" box: run as a normal user (Electron refuses root: `JUDGE_SMOKE ... --no-sandbox`), a logind session or `XDG_RUNTIME_DIR` owned by you, `--yes` will run `apt-get`, `MV_JUDGE_ASSET_DIR` redirects the 800 MB assets, and put `assets/` in `.gitignore`. Each of these cost me a failed attempt.
5. **New `docs/JUDGE_NO_DOCKER.md` (linked from README and QUICKSTART §2).** The route a judge without Docker or private access can finish in 10 minutes: T1 install, `run`, what "core-only degraded mode" looks like, plus `mv-replay` on a committed synthetic journal (or a recorded one, scrubbed) showing `rc 0` and then a tampered copy showing `rc 2`. This turns "I could not run it" into "I saw the core do its job".
6. **`llms.txt`.** Replace "Read first: AGENTS.md, then catalogue/protocol.json" and "Status: router unavailable" with a 3-line pitch and an ordered list: README → `docs/JUDGE_QUICKSTART.md` → `docs/JUDGE_TOUR.md` → `docs/REFERENCE.md` §4. Say that AGENTS.md is the contributor edit protocol, not the judge path. Add the five-line list of what is private.
7. **`docs/REFERENCE.md` L1-L65.** Add a "30-second summary for judges" with the four strongest engineering facts, each pointing at one source line (admission freshness, journal and replay, slot custody, transport ceilings), and the one worked example "stale frame refused and replayed". Rename [MEASURED] in this file to [INSPECTED] or define it once in a shared `docs/EVIDENCE_TAGS.md`, so the tag means the same in README, TOUR and REFERENCE.
8. **Evidence for the headline claims.** Commit scrubbed copies of the c26/c27 evaluation notes and `live21_NOTE.md`/`live22_NOTE.md` under `docs/evidence/`, or one-page summaries with run dates, commit hashes, and the command used. Link them from JUDGE_TOUR L16 and README L111. Without them, every "verified" cell in the architecture table is [CITED] to a file nobody can open.
9. **`README.md` L14 and L270, `docs/REFERENCE.md` §3 "Private binaries boundary".** One plain paragraph: "The three private programs are source-closed; their compiled x64 builds are downloadable from the release for evaluation only; here is exactly what the public repository can and cannot prove about them." Link the NOTICE. This is the honesty point judges will probe most, and it is already almost right.
10. **Remove process residue and Spanish.** `docs/REFERENCE.md` L80 and L170 ("operator assignment", "operator execution header"), the `[TARGET: document structure]` suffix on every heading, `[TARGET, unit decision]` in `scripts/judge/fetch_assets.py --help` and QUICKSTART L286, the first-person "I" in README, and all `AUSENTE — no inventar` (`docs/README.md`, `contracts/v0.2/README.md`, `tests/perf/README.md`, `memoryweb-builtin/sites/meta-ai/NOTES.md`). Make README Build state that `--offline` needs a primed cache and that Go 1.26 and Node 24 are required. Cheap and removes the filler smell.

## 12. Honest limits of this audit

- No Docker daemon, so no capsule, no tour step beyond T1, no agent loop. I did not see the rendered wall.
- I installed `x11-utils` on this host through the launcher's `--yes` path, created a throwaway user `jd` and `/run/user/<uid>` directories to get past documented checks. The repository working tree was not modified except for this file; assets and builds went to the session scratchpad.
- A partial `assets/` download that I started in the checkout was killed and removed before any commit.
- I did not read `docs/JUDGE_TROUBLESHOOTING.md` (106 KB), `INSTALL.md`, `TESTING.md` or `UI_ARCHITECTURE.md` in full, and I did not inspect CI results or the GitHub Actions history.
- Counts of CI jobs and tests in README L41 and L40 I did not recompute (workflow files: 6 [MEASURED]; Node journey files: 40 and Python E2E suites: 6 [MEASURED]).

Model: claude-sonnet-5-5 (Sonnet 5.5). Reasoning effort: 10 (session setting).

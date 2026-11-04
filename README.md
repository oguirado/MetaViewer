# MetaViewer: a live wall of capsules where a human and an AI share one desktop under one authority

Version `0.2.6` | licence `AGPL-3.0-only` | Linux x64 and ARM64 | release [v0.2.6](https://github.com/oguirado/MetaViewer/releases/tag/v0.2.6)

MetaViewer puts browsers and programs into separate capsules on one Linux desktop wall, lets a human or an AI agent control each one, and makes every agent action pass a single Rust authority that refuses stale or unowned input and writes each outcome to a hash-chained journal you can replay.

**A finding tells you where to look. Only the code proves it.**

<!-- VIDEO_SLOT: walkthrough video: the wall, a human taking control from an agent, mv-replay verifying the session journal -->
<!-- IMAGE_SLOT: hero: the 3-column wall with capsules, the Humans/Agents tree and the paired terminal dock -->

<!-- MV:BEGIN mv.node.v1 -->
```json
{
  "schema": "mv.node.v1",
  "version": "0.2.6",
  "version_file_at_docs_base": "0.2.5",
  "repository": "https://github.com/oguirado/MetaViewer",
  "release": "https://github.com/oguirado/MetaViewer/releases/tag/v0.2.6",
  "setup": "bash scripts/judge/metaviewer-judge.sh install",
  "setup_capsules": "bash scripts/judge/metaviewer-judge.sh install --capsules",
  "preflight": "bash scripts/judge/metaviewer-judge.sh doctor --before-install",
  "success_marker": "JUDGE_INSTALL_OK",
  "doctor_marker": "JUDGE_DOCTOR_OK",
  "stop_marker": "JUDGE_STOP_CLEAN",
  "tiers": {
    "T1": "app only: wall, Rust core, Go adapter, mv-replay; no container capsules",
    "T2": "T1 plus isolated browser and program capsules; needs rootful Docker",
    "ARM64-dev": "graphical VM, MicroVM and Rewind; linux-arm64 with KVM, developer setup only",
    "source": "build from source with the pinned toolchains"
  },
  "router": "python3 route/route_query.py ask \"<question>\"",
  "router_check": "python3 tools/router_index.py --check",
  "router_check_marker": "METAVIEWER_ROUTER_COVERAGE",
  "laws_check": "python3 tools/check_laws.py",
  "offline_gate": "bash tools/gate.sh",
  "licence": "AGPL-3.0-only; private components under NOTICE-EVALUATION.md"
}
```
<!-- MV:END mv.node.v1 -->

---

## 0. Reading map

Answers: where do I start; what is MetaViewer; how do I read this repository; which document answers my question.

**Action rule.** Install with the judge kit and wait for `JUDGE_INSTALL_OK`. To find code, ask the router (`route/route_query.py`) and treat each answer as coordinates; open the cited span and read it before you state a cause. Never open a document whole: follow the anchors below. If a fact is not in the code or a cited receipt, say `ABSENT — do not invent`.

### Quick start

Answers: how do I install MetaViewer; what commands do I run; how do I know it worked.

```bash
git clone --branch v0.2.6 --depth 1 https://github.com/oguirado/MetaViewer.git
cd MetaViewer
export RELEASE_ASSET_URL=https://github.com/oguirado/MetaViewer/releases/download/v0.2.6
# SHA256SUMS_DIGEST: copy it from the v0.2.6 release notes
python3 scripts/judge/fetch_assets.py --source "$RELEASE_ASSET_URL" --capsules --sums-sha256 "$SHA256SUMS_DIGEST"
bash scripts/judge/metaviewer-judge.sh doctor --before-install --capsules   # JUDGE_DOCTOR_OK
bash scripts/judge/metaviewer-judge.sh install --capsules                   # JUDGE_INSTALL_OK
bash scripts/judge/metaviewer-judge.sh run
bash scripts/judge/metaviewer-judge.sh stop                                 # JUDGE_STOP_CLEAN
```

Drop `--capsules` everywhere for tier T1 (no Docker). Keep it the same across `fetch`, `doctor` and `install`. The subcommands are exactly `doctor|install|run|stop` with flags `--before-install --capsules --yes --no-firewall` [CITED: `scripts/judge/metaviewer-judge.sh:55`]. Every failure prints `CODE: problem -- fix: remedy` and exits `2` [CITED: `scripts/judge/metaviewer-judge.sh:48`]. Full per-platform steps with expected output: [docs/INSTALL.md](docs/INSTALL.md) and [docs/JUDGES.md](docs/JUDGES.md).

### Which question goes to which tool

Answers: which command finds the code for a bug; where is the error explained; which doc tells an AI how to drive the app.

| You want to know | Use | Answer is |
|---|---|---|
| What MetaViewer is, in five minutes, as a judge | [docs/JUDGES.md](docs/JUDGES.md) | A guided path with markers |
| How to install any tier on my platform | [docs/INSTALL.md](docs/INSTALL.md) | Commands with expected output |
| Which files to open for a symptom | `python3 route/route_query.py locate "<symptom>"` | Ranked files with FRESH or STALE |
| What an exact error or log line means | `python3 route/route_query.py error "<text>"`, then [docs/ERRORS.md](docs/ERRORS.md) | Code coordinates; meaning, cause, fix |
| What must hold in some code, how it fails | `python3 route/route_query.py ask "<question>"` | Model-written findings with code spans |
| Where a symbol is defined | `python3 route/route_query.py find <name>` | Symbol ids and spans |
| Everything about one file | `python3 route/route_query.py file <path>` | Findings and symbols of that file |
| How to go from a symptom to a fix | [docs/DEBUG.md](docs/DEBUG.md) | Symptom table and known issues |
| How an AI should operate MetaViewer | [docs/AI_OPERATOR_GUIDE.md](docs/AI_OPERATOR_GUIDE.md), [docs/AI_AT_THE_CONTROLS.md](docs/AI_AT_THE_CONTROLS.md) | Protocol and limits; summary in [§6](#6-agent-operating-protocol) |
| Why capsules, and what that design gains | [docs/WHY_CAPSULES.md](docs/WHY_CAPSULES.md) | Tradeoffs with coordinates; summary in [§3](#3-how-it-works) |
| What is proven and where the receipt is | [§7](#7-measured-results), [docs/EVIDENCE.md](docs/EVIDENCE.md) | Tagged claims |
| Architecture and wire contracts | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/REFERENCE.md](docs/REFERENCE.md), `contracts/v0.2/` | Processes, schemas, examples |
| ARM64 VM, MicroVM, Rewind | [docs/ARM64_CAPSULE_SETUP.md](docs/ARM64_CAPSULE_SETUP.md), [docs/ARM64_MICROVM_REWIND.md](docs/ARM64_MICROVM_REWIND.md) | Developer setup |
| How to edit this repository | [AGENTS.md](AGENTS.md), [LAWS.md](LAWS.md), [docs/COMMIT_LAWS.md](docs/COMMIT_LAWS.md) | Laws and gates |

The router reads the tree and writes nothing; it needs Python standard library only [CITED: `route/README.md`]. Its findings are pinned to an older commit and many rows read `STALE` [MEASURED: `route_query.py ask` on this tree]; a stale row is a lead, not a fact.

### Prerequisites

Answers: what do I need before installing; what must I understand first.

| You need | Why | Where |
|---|---|---|
| Linux with a graphical session (X11, XWayland, WSLg, or `Xvfb` for smoke) | The wall is an Electron window | [docs/INSTALL.md](docs/INSTALL.md) |
| Rootful Docker (tier T2 only) | Browser and program capsules are containers | [docs/INSTALL.md](docs/INSTALL.md) |
| `linux-arm64` with KVM (ARM64 tier only) | VM and MicroVM need hardware virtualisation | [docs/ARM64_CAPSULE_SETUP.md](docs/ARM64_CAPSULE_SETUP.md) |
| Python 3 | `fetch_assets.py`, router, checks | `scripts/judge/fetch_assets.py` |
| The idea of a frame `generation` | Every agent action names the frame it saw | [§2](#2-definitions-and-gates) |
| The difference between capsule and Host program | Only capsules are isolated | [§5](#5-coverage-and-domain-contracts) |

### Reading tracks

Answers: what should a judge read; what should an AI agent read; what should a contributor read.

- **Judge:** [Quick start](#quick-start), then [§1](#1-abstract-and-result-contract), then [§7](#7-measured-results), then [§9](#9-limitations); for a guided tour, [docs/JUDGES.md](docs/JUDGES.md).
- **AI agent installing, debugging or explaining:** [§6](#6-agent-operating-protocol), then [§4 Panel 2](#panel-2-negative-knowledge), then [docs/DEBUG.md](docs/DEBUG.md) and [docs/ERRORS.md](docs/ERRORS.md).
- **AI agent at the controls of the app:** [§6](#6-agent-operating-protocol), then [docs/AI_AT_THE_CONTROLS.md](docs/AI_AT_THE_CONTROLS.md).
- **Contributor:** [AGENTS.md](AGENTS.md), [§2 gates](#2-definitions-and-gates), [§4 Panel 3](#panel-3-reference-implementation-and-oracle), [§10](#10-reproducibility).

### Notation and evidence tags

Answers: what does [MEASURED] mean; what does ABSENT mean.

| Tag or term | Meaning |
|---|---|
| `[MEASURED]` | Read from the tree, a stored receipt, or a command that was run |
| `[CITED: path]` | Stated in that file; read it to check |
| `[TARGET]` | A chosen limit or something not yet achieved |
| `ABSENT — do not invent` | Not known or not measured. Never means zero |
| `path:line` | A coordinate in this tree; line numbers can drift, so re-find by the quoted name |
| FRESH, STALE | Router states: cited code is identical, or has changed since the router pin |

---

## 1. Abstract and result contract

Answers: what problem does MetaViewer solve; what does it promise; what does it not promise.

When an AI agent uses a computer, three things go wrong silently: it acts on a screen that has already changed, a human and the agent both drive the same window, and afterwards nobody can prove what happened. MetaViewer answers all three in code. An agent never injects raw input; it sends a proposal bound to one surface and to the exact frame it saw (`generation` and `sha256`). The Rust core refuses the proposal with `STALE_FRAME` if that frame is no longer current, and with `SURFACE_NOT_AGENT_CONTROLLED` if a human has taken control [CITED: `core/src/admission/mod.rs:1308`, `core/src/admission/mod.rs:1314`]. Every admitted or refused outcome is appended to a hash-chained journal that the separate `mv-replay` binary verifies [CITED: `core/src/bin/mv-replay.rs:41`].

Each browser or program capsule runs in its own container, so a crash, a login or a download in one stays out of the others, and every surface has one owner at a time. Host programs and attached desktop windows are the exception: they run on your computer and are labelled not isolated.

### Result contract

| Item | Contract |
|---|---|
| **Input** | A clone of this repository at tag `v0.2.6` and the release assets for your architecture |
| **Output** | A running wall; for T2, live browser and program capsules; a session journal under the state directory |
| **Authority** | One Rust process admits every agent action; the UI only submits closed `ui_intent/v0.2` intents [CITED: `docs/ARCHITECTURE.md`] |
| **Tamper response** | `mv-replay` exits `0` on a valid chain, `2` on corrupt input, `3` on a duplicate, `4` on a witness mismatch [CITED: `core/src/bin/mv-replay.rs:44`] |
| **Scope** | Linux x64 and ARM64; Windows only as a Linux session under WSL2 + WSLg |
| **Not promised** | Isolation for Host programs or attached desktop windows; VM, MicroVM or Rewind on x64; that a routed finding is correct |

---

## 2. Definitions and gates

Answers: what is a capsule; what is a surface; what is a generation; what checks must pass.

| Term | Definition |
|---|---|
| **Capsule** | One browser or program running in its own container, started through the private `OpenSuperficies` runtime by the Go adapter [CITED: `daemon-adapter/internal/capsule/manager.go`] |
| **Host program** | A program on your own computer shown on the wall through Xpra. **Not isolated** and labelled so in the UI [CITED: `ui/src/catalog/CatalogLauncher.vue:319`, `ui/src/surfaces/RoleSurface.vue:532`] |
| **Desktop window** | An existing X11 window attached to the wall. **Not isolated** [CITED: `ui/src/surfaces/RoleSurface.vue:533`] |
| **Surface** | Anything on the wall that has frames and an owner |
| **Owner** | Human or Agent, never both. Take control moves a surface to Human and cancels pending agent work [CITED: `core/src/admission/mod.rs:1136`] |
| **Frame generation** | A counter plus SHA-256 of the pixels an agent saw; a proposal must name the current one [CITED: `core/src/admission/mod.rs:1316`] |
| **Journal** | Append-only JSONL, each record hashed into the next, `metaviewer.journal/v1` [CITED: `docs/REFERENCE.md`] |
| **Contract** | A versioned JSON schema with one valid and one invalid example; components talk only through these [CITED: `LAWS.md`] |
| **Router** | `route/route_query.py`, a deterministic code map plus model-written findings [CITED: `route/README.md`] |

### Verification gates

Answers: how do I check the repository; which command proves what.

| Gate | Command | Passes when |
|---|---|---|
| Laws | `python3 tools/check_laws.py` | Commit identity, messages, English-only, no secrets |
| Contracts | `python3 tools/check_contracts.py` | 41 v0.2 schemas validate their examples [MEASURED: `contracts/v0.2/*.schema.json`] |
| Offline gate | `bash tools/gate.sh` | All legs green; `--self-test` checks the harness itself |
| Router coverage | `python3 tools/router_index.py --check` | Prints `METAVIEWER_ROUTER_COVERAGE 100% 3426 files` [MEASURED on the docs base] |
| Install | `metaviewer-judge.sh install` | Prints `JUDGE_INSTALL_OK tier=...` [CITED: `scripts/judge/metaviewer-judge.sh:792`] |
| Journal | `mv-replay --journal <abs path> --witness-root <abs path>` | Exit `0` |

An offline gate pass does not prove live capsule behaviour or frame rate [CITED: `docs/EVIDENCE.md`].

---

## 3. How it works

Answers: how is MetaViewer built; why are capsules generated this way; what does that design gain.

```text
Electron + Vue wall           Rust core (authority)            Go daemon adapter
renders snapshots,      ──►   admits or refuses,        ──►   starts capsules, moves
sends ui_intent/v0.2          journals every outcome           frames, save slots
        ▲                            ▲                                │
        │ frame_port/v1 (RGB24)      │ action_proposal/v0.2           ▼
        └──────────── frames ────────┴──── Python agent loop    capsules (containers via
                                            (mvctl, mw_run)      private OpenSuperficies)
```

1. **Rendering, execution and authority are three processes.** The UI cannot act on a capsule; it asks the core. The adapter cannot decide; it executes what the core admitted [CITED: `docs/ARCHITECTURE.md`].
2. **Capsules are generated per identity, on demand, in RAM-backed work areas.** The adapter accepts only `/dev/shm` work paths [CITED: `daemon-adapter/internal/capsule/manager.go:434`]. A capsule's browser profile, cookies and sign-ins stay with that identity and can be saved to a slot only when it is stopped [CITED: `daemon-adapter/internal/capsule/slots/store.go`].
3. **Why this design.** One capsule per identity means a site, a crash or a download stays inside that capsule; one owner per surface means human and agent never fight over a pointer; frame-bound proposals mean an agent cannot act on a screen it did not see; the journal means a judge can check afterwards what was admitted and what was refused. The full argument, with alternatives and their costs: [docs/WHY_CAPSULES.md](docs/WHY_CAPSULES.md).
4. **Where it costs.** Capsules need Docker and RAM; concurrent capsules are admitted against a free-memory floor [CITED: `docs/INSTALL.md#concurrent-identities-and-ram-admission`]. Host programs trade isolation for convenience and are labelled.

---

## 4. Engineering triptych

Answers: what can I trust; what must I not do; how is correctness checked.

### Panel 1: epistemic contract

Answers: what is proven by code; what is only reported.

| Kind of statement | Proven by | Strength |
|---|---|---|
| Refusal behaviour (`STALE_FRAME`, takeover, `POLICY`) | Rust code and tests, e.g. `core/src/serve/b1_stale_frame_tests.rs` | Public source and tests |
| Journal integrity | `mv-replay` exit codes, `core/tests/` | Public source and tests |
| Wire shapes | `contracts/v0.2/` with valid and invalid examples | Schema check |
| Live behaviour (capsules, rewind, games) | Maintainer live runs | [MEASURED] live; raw receipts in this tree are `ABSENT — do not invent` unless cited |
| Private component internals | Nothing public | Outside this repository |
| Router findings | A model, no human review [CITED: `route/README.md`] | Leads only |

### Panel 2: negative knowledge

Answers: what mistakes do agents make here; what should I not assume.

| Do not | Because | Do instead |
|---|---|---|
| Call a Host program or desktop window isolated | It runs on your computer; the UI says "not isolated" | Use a `program` capsule for isolation |
| Expect VM, MicroVM or Rewind on x64 | Disabled on non-ARM hosts [CITED: `ui/electron/guestCommandProfile.js:47`] | Use a `linux-arm64` host with KVM |
| Pass relative, symlinked or copied session paths to `mv-replay` | They give `Invalid` [MEASURED live] | Pass absolute real paths of the original session directory |
| Keep one session for a very long run | A full journal ends the session with `JOURNAL_FULL` [CITED: `core/src/serve/journal_end.rs:128`] | Start a fresh session per long run |
| Resend after `INPUT_UNCERTAIN` | The input may already have landed [CITED: `agents/metaviewer_agents/mw_refusals.py:36`] | Observe, reconcile, then decide |
| Treat a router row as proof | Findings are model-written and often `STALE` | Read the cited span |
| Switch a Host program between human and agent mid-task | The switch restarts the program [MEASURED live] | Choose the mode before starting |
| Read "acknowledge" on a handoff banner as resume | It only hides the notice [CITED: `ui/src/handoff/handoffModel.js`] | Release control explicitly |

### Panel 3: reference implementation and oracle

Answers: where is the reference logic; what decides if behaviour is right.

| Behaviour | Reference implementation | Oracle |
|---|---|---|
| Admission of a proposal | `core/src/admission/mod.rs:1297` (`fn check`) | `core/tests/admission_matrix.rs` |
| Human takeover | `core/src/admission/mod.rs:1136` | `core/src/journal/mod.rs` takeover tests |
| Journal chain | `core/src/journal/mod.rs` | `mv-replay`, `core/tests/t1_journal_verify.rs` |
| Save slots, stop-first | `daemon-adapter/internal/capsule/slots/store.go` | `daemon-adapter/internal/capsule/slots/store_test.go` |
| Agent program input | `agents/metaviewer_agents/mw_run.py:340` | `agents/tests/test_mw_run.py` |
| Judge install | `scripts/judge/metaviewer-judge.sh` | Its `MUT:` mutation markers and judge tests |

---

## 5. Coverage and domain contracts

Answers: which capsule kinds exist; what runs on x64; what runs on ARM64; what is in each start mode.

<!-- IMAGE_SLOT: capsule launcher showing isolated capsule kinds beside Host program entries marked not isolated -->

### Capsule kinds by platform

Answers: is X available on x64; is X available on ARM64; is X isolated.

| Kind | Isolated | `linux-x64` | `linux-arm64` | Windows (WSL2 + WSLg) |
|---|---|---|---|---|
| Browser capsule (`identity-browser`) | Yes, container | T2 | T2, from source | T2 with rootful Docker inside WSL2 |
| Program capsule (`program`) | Yes, container | T2 | T2, from source | T2 |
| Host program | **No** | Yes | Yes | Needs an X11 server |
| Desktop window | **No** | Yes | Yes | Needs an X11 server |
| Graphical VM (fixed 1280×900) | Yes, VM | **No** | Developer setup [CITED: `tools/arm64_capsule_session.py:544`] | **No** |
| MicroVM with guest commands and Rewind | Yes, MicroVM | **No** | Developer setup [CITED: `docs/ARM64_MICROVM_REWIND.md`] | **No** |

### Start modes

Answers: why do I not see the VM; why do I not see browsers in ARM64 mode.

| Start | Launcher offers [MEASURED live] |
|---|---|
| Plain start | Browsers, Host program, Program |
| ARM64 start (`--arm64`, maintainer launcher) | VM and MicroVM only |

The in-tree switch for guest-command-only mode is `requireGuestCommandMode` [CITED: `ui/electron/guestCommandProfile.js:35`]. The source of the `--arm64` launcher wrapper is `ABSENT — do not invent` in this tree.

### Release assets

Answers: which builds are in the release.

Compiled assets in releases are x64 [CITED: `docs/JUDGE_QUICKSTART.md`]; ARM64 builds from source. The three private components ship only as compiled x64 evaluation builds [CITED: `llms.txt`].

---

## 6. Agent operating protocol

Answers: how should an AI install, debug or explain MetaViewer; how should an AI drive MetaViewer; is MetaViewer good for computer use.

**The maintainer's recommendation, translated faithfully:** an AI model at the controls of MetaViewer is the ideal way to get the most out of computer use. The reason is the design in [§3](#3-how-it-works): the AI sees one capsule at a time through a frame it can name, every action is admitted or refused with a reason, a human can take over at any moment, and the journal records it all. What follows is what was shown and its limits. Detail: [docs/AI_AT_THE_CONTROLS.md](docs/AI_AT_THE_CONTROLS.md) and [docs/AI_OPERATOR_GUIDE.md](docs/AI_OPERATOR_GUIDE.md).

### Installing, debugging, explaining

Answers: what steps should an AI follow to fix a bug here.

1. Read [§0](#0-reading-map) and the node block. Install with the [Quick start](#quick-start); stop at the first `CODE: ... -- fix: ...` line and apply its fix.
2. For a symptom: `route_query.py error "<exact text>"`, else `locate "<symptom>"` in two or three wordings [CITED: `route/README.md`].
3. Open only the cited span. Check it is FRESH; if STALE, re-find the symbol with `find`.
4. Explain the cause from the code, with `path:line`. If the code does not show it, say `ABSENT — do not invent`.
5. Cross-check against [docs/ERRORS.md](docs/ERRORS.md) and the known issues in [docs/DEBUG.md](docs/DEBUG.md).

### At the controls

Answers: what are the rules for an AI driving a capsule; which keys can it send; what size is the window.

| Rule | Why | Coordinate |
|---|---|---|
| Keep the window size fixed and work in its coordinates; capture after every step | Proposals are bound to the frame you saw; a stale frame is refused | `core/src/admission/mod.rs:1316` |
| In the program lane, keys are only `Enter`, `Up`, `Down`, `Left`, `Right`, one step, rules planner | `mw_run` refuses anything else | `agents/metaviewer_agents/mw_run.py:347` |
| Browser lane keys: `Enter` only | Same parser | `agents/metaviewer_agents/mw_run.py:367` |
| Program goals: 1..16 steps, timeout 1..30000 ms | Parser limits | `agents/metaviewer_agents/mw_run.py:369` |
| After `INPUT_UNCERTAIN`, observe before acting again | Input may have been delivered | `agents/metaviewer_agents/mw_refusals.py:36` |
| A login wall, CAPTCHA or bot check is a handoff to the human | The run stops; a human decides | `ui/src/handoff/handoffModel.js` |
| A full journal ends the session | New work is refused; start a new session | `core/src/serve/journal_end.rs:128` |
| Terminal task buttons prepare text; they never press Enter | Bracketed paste only | [CITED: `llms.txt`, `docs/AGENT_ENTRY.md`] |

### What was shown live

Answers: has an AI actually driven MetaViewer; with what result.

| Run | Result |
|---|---|
| Games by script loop, Muse Spark 1.3 choosing keys, core verifying each | 2048: 58 of 58; dominoes: 28 of 28; Tuxemon: 40 of 42 with 2 `INPUT_UNCERTAIN` [MEASURED live, raw receipt `ABSENT — do not invent` in this tree] |
| Rewind on ARM64 MicroVM | See [§7](#7-measured-results) |

---

## 7. Measured results

Answers: what has been measured; did rewind work; what numbers can I quote.

<!-- IMAGE_SLOT: MicroVM Guest commands panel and Rewind timeline with Back and the observed restore time -->

### Live, on the 0.2.6 candidate [MEASURED live by the maintainer]

| Check | Result |
|---|---|
| Rewind on ARM64 MicroVM | 3 files created, deleted (0), header **Back** restored 3 files; app showed 387.5 ms |
| `mv-replay` on that session journal | `rc=0` with absolute real paths |
| `mv-replay` with relative, symlinked or copied session paths | `Invalid` |
| Plain start | Browsers, Host program, Program offered |
| `--arm64` start | VM and MicroVM only |
| Host program mode switch | Restarts the program |
| Full journal | Ends the session |

Raw receipts for these runs are `ABSENT — do not invent` in this tree.

### From the tree [MEASURED]

| Item | Value |
|---|---|
| v0.2 schemas | 41, with 1,196 v0.2 example files |
| Node end-to-end journey files | 40 (`tests/e2e/*.test.js`) |
| Router coverage | 100 %, 3,426 files |
| IPC ceilings | Frame 1,048,576 B; nesting 32; string 65,536 B [CITED: `daemon-adapter/internal/ipc/config.go`] |

### Not measured on this repository

Live wall frame rate and latency at the current pins: `ABSENT — do not invent`. Earlier reported cadence is in [docs/EVIDENCE.md](docs/EVIDENCE.md).

---

## 8. Rejected levers and negative results

Answers: what was tried and dropped; what does MetaViewer deliberately not do.

| Lever | Why rejected |
|---|---|
| Raw pointer or keyboard injection by the agent | Cannot be tied to the frame the agent saw; replaced by frame-bound proposals |
| Shared control of one surface | Ambiguous ownership; replaced by one owner and explicit take or release |
| Acknowledge-to-resume on a handoff | Would let a banner click restart an agent; acknowledge only hides it |
| Graphical VM rewind | Not supported or claimed; only MicroVM RAM rewind [CITED: `docs/ARM64_MICROVM_REWIND.md`] |
| Saving a running capsule | Refused; stop first [CITED: `daemon-adapter/internal/capsule/slots/store.go`] |
| Router-only answers | Findings read STALE often; code decides |

Negative results: one site was unreachable in human mode on a browser and a human-mode start took about 20 s; neither is diagnosed [MEASURED live].

---

## 9. Limitations

Answers: what does not work; what are the open bugs; what are the platform limits.

- **Open bug:** after `mw_run`, the package gains `__pycache__`, and an `--arm64` start then holds with "exhaustive manifest inventory". Workaround: remove the bytecode directories from the package, then start again [MEASURED live]. See [docs/DEBUG.md](docs/DEBUG.md).
- **Open bug:** the paired terminal exited after a very long typed line. Cause unknown [MEASURED live].
- Host programs and desktop windows are not isolated.
- No VM, MicroVM or Rewind on x64; the ARM64 tier is developer setup, not a judge installer.
- Rewind restores guest RAM only; it never undoes network requests, host files or the journal [CITED: `docs/ARM64_MICROVM_REWIND.md`].
- Native macOS and Windows builds are not supported.
- This build box had no KVM and no Docker daemon, so the docs lane could not re-run capsules or rewind.

---

## 10. Reproducibility

Answers: how do I build from source; how do I re-run the checks.

| Tool | Pin |
|---|---|
| Rust | `rust-version` in `Cargo.toml` |
| Go | `daemon-adapter/go.mod` |
| Node.js | `engines.node` in `ui/package.json` |
| Python | `agents/pyproject.toml` |
| Private components | `deps.lock` (commit-pinned; mismatch refuses before spawn) |

```bash
cargo build --offline -p metaviewer-core
go -C daemon-adapter build ./...
(cd ui && npm ci --offline && npm test && npm run build)
python3 tools/check_laws.py
python3 tools/check_contracts.py
bash tools/gate.sh
python3 tools/router_index.py --check
```

Full build and packaging: [docs/INSTALL.md](docs/INSTALL.md). Test matrix: [docs/TESTING.md](docs/TESTING.md). Release identity is `VERSION`; pending changes are in `changes/unreleased/` [CITED: `llms.txt`].

---

## 11. Pending measurements

Answers: what is not yet measured; what is planned.

| Item | Status |
|---|---|
| Live frame rate and latency at current pins | `ABSENT — do not invent` |
| Hosted CI on the release commit | [TARGET] |
| Held-out documentation exam: 25 of 30 routed, 4 of 5 abstain | [TARGET] |
| Cause of the paired-terminal exit | Not diagnosed |
| Human-mode browser start time and unreachable site | Not diagnosed |
| Raw receipts for the live runs in §6 and §7 | Not in this tree |

---

## 12. Licence and provenance

Answers: what is the licence; what is private; what may judges do with the private parts.

MetaViewer's own source is `AGPL-3.0-only` [CITED: `LICENSE`, `NOTICE-EVALUATION.md`]. `capsule-ui-kit` is a separate public repository, also `AGPL-3.0-only`.

**Private boundary.** `wender-agent`, `vision-engine` and `OpenSuperficies` are separate, proprietary and fully private programs. Their repositories and source are not published, they run as separate processes over documented process and socket interfaces, and they are not covered by the AGPL. Judges of the hackathon may install, run and evaluate their compiled forms, as supplied in the release assets, for judging only; no redistribution, modification, reverse engineering or other use [CITED: `NOTICE-EVALUATION.md`]. Public tests here establish interfaces and refusal behaviour, not private internals.

Pre-existing work and what was built during the event: [docs/PREEXISTING.md](docs/PREEXISTING.md). Release: [v0.2.6](https://github.com/oguirado/MetaViewer/releases/tag/v0.2.6). Changes: [CHANGELOG.md](CHANGELOG.md).

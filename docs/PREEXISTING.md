# Pre-existing work declaration

## Current assembly and historical boundary

The current candidate is **0.2.5** [CITED: `../VERSION`]. This declaration
separates the pre-event documentation baseline from the implemented assembly.
Kickoff was **October 26, 2026** [CITED: operator schedule]. The historical
baseline below describes **0.1.1** [CITED: git `ebc5546`]; statements about empty
skeletons and TBD pins apply to that baseline, not the current tree.

The assembly now contains runtime code in `core/src/`, `daemon-adapter/`,
`agents/metaviewer_agents/`, and `ui/`, plus packaging, judge tooling and tests.
See [CHANGELOG.md](../CHANGELOG.md), [pending fragments](../changes/unreleased/),
and [README.md](../README.md) for current behavior and limits. Presence of code
is not evidence of a live acceptance pass or event eligibility.

## Historical in-repository scaffold

Committed as `a01a420` on **2026-10-22** [CITED: git log], **49 files**
[CITED: git show --stat]. Laws, contracts, schema tooling, tests, CI and
design. No application code.

| Item | Contents |
| --- | --- |
| `LAWS.md` | Repository laws L1-L6 |
| `docs/COMMIT_LAWS.md` | Commit identity, message and version policy |
| `contracts/v0.1/` | **10** closed, versioned JSON schemas [CITED: tree] |
| `contracts/examples/` | **20** synthetic fixtures: one valid and one invalid example per schema [CITED: tree] |
| `tools/check_laws.py` | Commit, identity and version checks |
| `tools/check_contracts.py` | Schema audit and example checks |
| `tests/` | Unit tests for both checkers |
| `.github/workflows/ci.yml` | Laws, version, contracts and unit-test gates |
| `docs/ARCHITECTURE.md` | Authority, IPC, capture and replay design |
| `docs/ROADMAP.md` | Event plan, rewritten as the public roadmap in this release |
| `CHANGELOG.md`, `VERSION` | Release identity |
| `deps.lock` | Component pins; OpenSuperficies entries are TBD |
| `core/`, `ui/`, `agents/`, `daemon-adapter/` | Empty skeleton directories; READMEs only, no code |
| `.githooks/commit-msg`, `.gitignore` | Commit-message hook and ignore rules |

## Pre-event design and research notes

Committed as `e06d627` on **2026-10-25** [CITED: git log], **13 files**
[CITED: git show --stat]. Design and research notes only; no runtime code.

| Item | Contents |
| --- | --- |
| `docs/UI_ARCHITECTURE.md` | Shared capsule visual architecture: specified behavior, not installed APIs |
| `docs/ROUTER_BOOTSTRAP.md` | Context-router bootstrap notes for the shared UI |
| `docs/RESEARCH_LOG.md` | Visual-layer research ledger |
| `docs/DEMO_RECURSIVE_SCRIPT.md` | Draft hackathon video concept script |
| `docs/research/` | **8** supporting files [CITED: tree]: acceptance review, terminal-workspace synthesis, UI seal decisions, research handoff, npm pins evidence, UI architecture report, **2** query logs |

## Historical external private components

These components predate the event, stay in their own private repositories,
and are integrated through versioned contracts. The following pins are historical [CITED: git `ebc5546:deps.lock`],
not the current lock. Their source stays in separate repositories; packaging may
include external runtime material subject to its own permission.

| Component | Role | How MetaViewer consumes it |
| --- | --- | --- |
| wender-agent | AI input execution | Private repo `oguirado/wender-agent`, pin `v0.1.1` / `f24bda5` [CITED: git `ebc5546:deps.lock`]; reached through versioned contracts only |
| vision-engine | Perception: capture, change detection, localisation | Private repo `oguirado/vision-engine`, pin `v0.1.1` / `cff8f3a` [CITED: git `ebc5546:deps.lock`]; reached through versioned contracts only |
| OpenSuperficies | Isolated capsule backend (Go surface daemon) | Pins TBD in `deps.lock` [CITED: git `ebc5546:deps.lock`]; reached through versioned contracts only |
| Shared capsule UI kit | Maintainer's UI kit for the wall: shell, capsules, overlay terminal (multislot in build) [CITED: docs/DEMO_RECURSIVE_SCRIPT.md] | Consumed as a compiled bundle; never copied |

The baseline planned to finalise pins in a `deps:` commit [TARGET, historical plan]. Per L2, a pin changes only in a commit whose message starts with
`deps:` [CITED: LAWS.md].

## Pre-event planning with Meta models

Before kickoff I used Meta Muse Spark 1.3 for planning only: **55 lanes**
[MEASURED: META_AI_USAGE.md] on **October 25** (21:12-22:14 CET) and
**October 26** (16:53 CET, before the 17:00 kickoff). Every lane is listed
with its start time, purpose and cost in `META_AI_USAGE.md` (phase
"pre-event").

| Room | Lanes | Output |
| --- | --- | --- |
| `mv0ri` | 8 | Research notes on the eight hard engineering areas |
| `mv0cf` | 6 | Audit of the architecture norm |
| `mv0rvb` | 6 | Review of the build plan: critical path, risks, demo plan |
| `mv0pk1`-`mv0pk3` | 24 | Context packs: specifications and source citations for the build-period writers |
| `mv0api` | 6 | Extracts of the installed APIs of the pre-existing components |
| `mv0kit` | 2 | Theme token proposal (design data) and the UI kit needs list |
| `mv0v011` | 3 | The 0.1.1 release documents (`ebc5546`) |

No product code was written before kickoff. Apart from the 0.1.1 documents,
these outputs stay in my private planning workspace and are not committed
here; the context packs and research notes were inputs for the writers of
the build period.

## Current external pins

These are integration pins, not evidence that each pinned revision predates kickoff.
External components are pre-existing projects; the event-period changes in their
private repositories are not established by this declaration. MetaViewer source is
licensed under [AGPL-3.0-only](../LICENSE). The separate proprietary programs
`wender-agent`, `vision-engine` and `OpenSuperficies` are fully private; `capsule-ui-kit` is a separate public repository under `AGPL-3.0-only`. [NOTICE-EVALUATION.md](../NOTICE-EVALUATION.md) grants judges
limited evaluation permission for supplied compiled external components, without
granting redistribution rights in those components.

| Component | Version [CITED] | Commit [CITED] | Source |
| --- | --- | --- | --- |
| vision-engine | `v0.2.0` | `3bb54835db8a2e545311cfcc45185a0dfbd9313a` | `deps.lock` |
| wender-agent | `v0.3.0` | `96120967b435b72fc6d29635f3844dae140388a9` | `deps.lock` |
| OpenSuperficies | `os-cu-w9-mv1` | `3cb86d752f38457b6730eefd235d4da4c4039721` | `deps.lock` |
| capsule-ui-kit | `0.2.1` | `aaada9dedc177b096e8b4764959e258e76c1ef02` | `ui/kit.lock.json` |

## Built during the event

The MetaViewer assembly implements the Rust authority core, Go daemon adapter,
Python agent adapters and Electron/Vue wall. These were absent from the historical
scaffold and now exist in the directories listed above [CITED: current tree;
git `a01a420`, `e06d627`]. The claim concerns the product assembly; pre-event schema
tooling and tests already contained executable code.

Current integration includes observe/propose/verify, journal replay, capture,
control handoff and the terminal. Host programs and attached desktop windows are
not isolated; live display and external runtime prerequisites still apply.
See [README.md](../README.md#isolation-and-evaluation-limits) for limitations.

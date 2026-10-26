# Pre-existing work declaration

This document belongs to release **0.1.1** [TARGET], a documentation-only
release published before the hackathon build period. The build period starts
at kickoff on **October 26, 2026** [CITED: operator schedule]. Everything
listed below predates the event: the v0.1 scaffold in this repository, the
pre-event design and research notes, and the external private components the
product integrates. The assembly units built during the event are listed at
the end.

## In-repository scaffold

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
| `docs/HOLDINGS_LESSONS_UI_ORCHESTRATOR.md` | Design notes from Holdings for the UI layer and capsule orchestrator |
| `docs/research/` | **8** supporting files [CITED: tree]: acceptance review, terminal-workspace synthesis, UI seal decisions, research handoff, npm pins evidence, UI architecture report, **2** query logs |

## External private components

These components predate the event, stay in their own private repositories,
and are integrated through versioned contracts. They are pinned in
`deps.lock` and never copied into this repository.

| Component | Role | How MetaViewer consumes it |
| --- | --- | --- |
| wender-agent | AI input execution | Private repo `oguirado/wender-agent`, pin `v0.1.1` / `f24bda5` [CITED: deps.lock]; reached through versioned contracts only |
| vision-engine | Perception: capture, change detection, localisation | Private repo `oguirado/vision-engine`, pin `v0.1.1` / `cff8f3a` [CITED: deps.lock]; reached through versioned contracts only |
| OpenSuperficies | Isolated capsule backend (Go surface daemon) | Pins TBD in `deps.lock` [CITED: deps.lock]; reached through versioned contracts only |
| Shared capsule UI kit | Maintainer's UI kit for the wall: shell, capsules, overlay terminal (multislot in build) [CITED: docs/DEMO_RECURSIVE_SCRIPT.md] | Consumed as a compiled bundle; never copied |

All pins are finalised in a `deps:` commit at the start of the build period
[TARGET]. Per L2, a pin changes only in a commit whose message starts with
`deps:` [CITED: LAWS.md].

## Built during the event

The hackathon product is the assembly of MetaViewer [TARGET]: the Rust
authority core, the Go daemon adapter, the Python agent adapters, and the
Electron/Vue wall, written during the event. None of these exists in the
repository at this release: the component directories hold READMEs only
[CITED: tree]. Planned runtime AI uses Meta models through the Meta Model
API, plus any provider CLI the user chooses in the built-in terminal
[TARGET; nothing implemented yet].

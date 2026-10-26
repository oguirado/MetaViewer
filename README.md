# MetaViewer

MetaViewer is a wall of live, isolated application surfaces [TARGET]. People fold, unfold, pin and take control of surfaces while an agent continues to observe, act and verify outcomes, including on hidden surfaces [TARGET]. Perception and reasoning are designed to use Meta models through the Meta Model API [TARGET], with vision-engine for capture analysis and wender-agent for input execution [CITED: docs/ARCHITECTURE.md]; the built-in terminal also accepts any provider CLI the user chooses [TARGET].

Current release: **0.1.1** [CITED: VERSION]. This release is a documentation-only pre-event snapshot: the v0.1 scaffold (laws, contracts, schema tooling, tests, CI, architecture) plus pre-event design and research notes. No application code is present; the component directories are empty skeletons apart from their READMEs. Nothing here starts a display, daemon or agent. Application assembly starts at the hackathon kickoff.

## Pre-existing vs built during the event

Everything in this release predates the event; everything runnable is built during it. See docs/PREEXISTING.md for the item-by-item declaration: the v0.1 scaffold (first commit a01a420, 2026-10-22 [CITED: git log]) and the pre-event design and research notes (e06d627 [CITED: git log]), versus the assembly units written during the event (Rust authority core, Go daemon adapter, Python agent adapters, Electron/Vue wall [TARGET]). External components stay in their own repositories, pinned in deps.lock and never copied.

| Path | Purpose |
| --- | --- |
| `README.md` | Project overview and release status (this file) |
| `LAWS.md`, `docs/COMMIT_LAWS.md` | Repository and commit policy |
| `VERSION`, `CHANGELOG.md`, `deps.lock` | Release identity and component pins |
| `contracts/v0.1/` | Closed, versioned JSON schemas |
| `contracts/examples/` | Synthetic passing and deliberately failing fixtures |
| `tools/`, `tests/`, `.githooks/` | Standard-library checks and commit hook |
| `.github/workflows/ci.yml` | Commit, version, contracts and unit-test gates |
| `.gitignore` | Local artifact exclusions |
| `docs/ARCHITECTURE.md` | Authority, IPC, capture and replay design |
| `docs/ROADMAP.md` | Public hackathon day-by-day plan and gates |
| `docs/PREEXISTING.md` | Pre-existing declaration: what predates the event |
| `docs/UI_ARCHITECTURE.md` | Shared capsule visual architecture design |
| `docs/ROUTER_BOOTSTRAP.md` | Context router bootstrap design |
| `docs/RESEARCH_LOG.md` | Visual-layer research ledger |
| `docs/DEMO_RECURSIVE_SCRIPT.md` | Hackathon demo video concept script |
| `docs/HOLDINGS_LESSONS_UI_ORCHESTRATOR.md` | Design notes from Holdings: UI layer and capsule orchestrator |
| `docs/research/` | Pre-event UI research evidence, briefs and pin data |
| `core/`, `ui/`, `agents/`, `daemon-adapter/` | Future implementation boundaries |

Use Python **3.10+** [TARGET]. No package installation is required:

```sh
python3 tools/check_laws.py
python3 tools/check_laws.py --version
python3 tools/check_contracts.py
python3 -m unittest discover -s tests -v
```

The history check accepts an empty repository. Invalid explicit revision ranges fail. Enable the local hook when preparing to contribute:

```sh
git config core.hooksPath .githooks
```

Set both author and committer to the identity in `docs/COMMIT_LAWS.md` before committing. CI repeats checks independently of the local hook. No build steps exist until application code and its build manifests are introduced.

## Hackathon timeline

Assembly runs during the event only [TARGET]: day 0 contracts (v0.2) and skeletons, day 1 vertical slice (admission, capsule adapter, frames to the wall, terminal, AI control CLI), day 2 feature complete, day 3 packaged linux-arm64 product, then large-scale testing, polish, code seal v1.0.0 on Nov 1, demo video and submission [all TARGET]. See docs/ROADMAP.md for the day-by-day plan and verification gates.

## License

MetaViewer is licensed under the [PolyForm Strict License 1.0.0](LICENSE). The external components it integrates (wender-agent, vision-engine, OpenSuperficies and the capsule UI kit) are proprietary and are not covered by this license.

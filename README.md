# MetaViewer

MetaViewer is a wall of live, isolated application surfaces. People fold, unfold,
pin and take control of surfaces while an agent continues to observe, act and
verify outcomes, including on hidden surfaces. Muse Spark provides multimodal
vision, assisted by vision-engine; wender-agent provides input execution.

Current release: **0.1.0** [CITED: VERSION]. This release contains contracts,
laws, schema tooling, tests, CI and architecture. Application implementation
starts at the hackathon kickoff; the component directories are empty skeletons
apart from their READMEs. Nothing here starts a display, daemon or agent.

| Path | Purpose |
| --- | --- |
| `LAWS.md`, `docs/COMMIT_LAWS.md` | Repository and commit policy |
| `VERSION`, `CHANGELOG.md`, `deps.lock` | Release identity and component pins |
| `contracts/v0.1/` | Closed, versioned JSON schemas |
| `contracts/examples/` | Synthetic passing and deliberately failing fixtures |
| `tools/`, `tests/`, `.githooks/` | Standard-library checks and commit hook |
| `.github/workflows/ci.yml` | Commit, version, contracts and unit-test gates |
| `docs/ARCHITECTURE.md` | Authority, IPC, capture and replay design |
| `docs/ROADMAP.md` | Assembly, release and verification gates |
| `core/`, `ui/`, `agents/`, `daemon-adapter/` | Future implementation boundaries |

Use Python **3.10+** [TARGET]. No package installation is required:

```sh
python3 tools/check_laws.py
python3 tools/check_laws.py --version
python3 tools/check_contracts.py
python3 -m unittest discover -s tests -v
```

The history check accepts an empty repository. Invalid explicit revision ranges
fail. Enable the local hook when preparing to contribute:

```sh
git config core.hooksPath .githooks
```

Set both author and committer to the identity in `docs/COMMIT_LAWS.md` before
committing. CI repeats checks independently of the local hook. No build steps
exist until application code and its build manifests are introduced.

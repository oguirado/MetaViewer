# How MetaViewer is tested

MetaViewer has source checks, component tests, Electron journeys and opt-in live
capsule checks. Passing one does not establish the others. This page describes
the shipped runners; it does not claim a new test run. The current release identity
is in [VERSION](../VERSION), and the evidence boundary is in [EVIDENCE.md](EVIDENCE.md).

## Which check should I run?

Choose the check for the behavior you changed, then run the complete gate before
integration. A passing fixture is evidence about that fixture, not a live capsule.

Answers: testing guide; test commands; unit tests versus live acceptance

| Change or question | Runner | What a pass establishes |
| --- | --- | --- |
| Documentation, command paths and required pages | `python3 -B -m unittest discover -s tests -p 'test_*doc*'` | The documentation assertions in the selected suites hold |
| Complete local integration | `bash tools/gate.sh` | Every local gate leg passed for this checkout and environment |
| The gate itself | `bash tools/gate.sh --self-test` | Its fault-injection fixtures passed |
| Electron journeys | `python3 tests/e2e/run.py` under Xvfb | The selected wall journeys and cross-routing negative control passed |
| Real capsule and cleanup | `node tests/e2e/e2e1_slice/index.js --live` with the live prerequisites below | The live slice report and its cleanup assertions passed |
| Agent action and state verification | `python3 tools/gate_g_ai.py --surface mv-live-1` with the live prerequisites below | The local live gate's assertions, negative controls and cleanup passed |

Sources: [local gate](../tools/gate.sh), [journey runner](../tests/e2e/run.py),
[live slice](../tests/e2e/e2e1_slice/index.js), [agent gate](../tools/gate_g_ai.py).

## What does the local gate run?

The local gate runs each leg listed below and prints `PASS aggregate` only when
all selected legs return success. Use `--leg` to select a leg while iterating.

Answers: local gate; gate legs; full gate; PASS aggregate

```sh
bash tools/gate.sh --leg contracts
bash tools/gate.sh --leg unit
bash tools/gate.sh --self-test
bash tools/gate.sh
```

| Leg | Checks in the shipped runner |
| --- | --- |
| `manifests` | Release manifests, pinned dependencies, frozen offline resolution and required ignore rules |
| `laws` | Release version and repository commit laws |
| `contracts` | Closed schemas and their valid and invalid examples |
| `unit` | Python suites under `tests/`, including the live-slice harness unit suites |
| `agents` | Python agent suites and their mutation harness |
| `js` | The pinned capsule UI kit and its content hash |
| `rust` | Pinned formatter, Clippy and offline locked Cargo tests |
| `go` | Vet and race tests on the host, plus vet and compile checks for the other supported Linux architecture |
| `ui` | Offline npm installation, Node tests, Vue type checking and production build |
| `ui-smoke` | Electron renderer and main-process smoke checks with their required success markers |
| `perf` | Offline resource-budget assertions, a rejected leak fixture and an optional live RSS probe |

This table describes `LEAVES`, `leaf`, `build_leg`, `go_leg`, `ui_smoke_leg` and
`perf_leg` in [tools/gate.sh](../tools/gate.sh). A cross-architecture compile is
not a run on that architecture. The laws leg checks [LAWS.md](../LAWS.md) through
[check_laws.py](../tools/check_laws.py); it is not a secret scanner.

## What must be installed before the local gate?

Use the pinned build prerequisites in [INSTALL.md](INSTALL.md), a local checkout
of the pinned capsule UI kit, cached build dependencies and a local Electron
binary. Offline resolution deliberately fails when the cache is incomplete.

Answers: gate prerequisites; offline dependencies; missing kit; missing Electron

Set `CAPSULE_UI_KIT_REPO` or `MV_KIT_CHECKOUT` to the kit checkout. Set
`ELECTRON_OVERRIDE_DIST_PATH` if Electron is outside `ui/node_modules/electron/dist`.
The gate verifies the kit pin from [ui/kit.lock.json](../ui/kit.lock.json).
It uses the formatter toolchain named in `build_leg`, which is distinct from
the workspace compiler requirement in [Cargo.toml](../Cargo.toml).

Install the UI dependencies before a standalone `unit` leg: some packaging
fixtures load the package tooling. The full gate is a verifier, not an online
dependency installer. See `validate_frozen_dependencies`, `electron_dist` and
`build_leg` in [tools/gate.sh](../tools/gate.sh).

## How do I interpret a skipped or blocked check?

A missing prerequisite, skipped test or unexecuted live probe is not a passing
result for that behavior. Read the individual result as well as the aggregate.

Answers: skipped checks; blocked checks; absent evidence; gate failure

The `unit` and `agents` legs reject empty selections, skipped tests, expected
failures and unexpected successes. Other runners have their own rules. In
particular, `perf_leg` can pass its offline checks while printing that the live
probe was skipped. Even with `MV_GATE_PERF_LIVE=1`, missing Electron or Xvfb leaves
that probe skipped. A live resource claim requires evidence that the probe ran.
[CITED: ../tools/gate.sh, `UNIT_CODE`, `AGENTS_UNIT_CODE`, `perf_leg`]

The assembly web runner also returns a successful process exit with
`status: "SKIPPED"` when live mode is not enabled. Inspect its report, not just
its exit status. [CITED: ../tests/e2e/e2e1_slice/asm_web_live.py, `main`]

## How do I run the Electron journeys?

Build the production UI, then run the journey orchestrator under Xvfb with the
pinned kit and a local Electron distribution available.

Answers: Electron E2E; wall journeys; routing negative control

From the repository root, after setting the prerequisite environment variables:

```sh
node tools/sync_kit.mjs "$CAPSULE_UI_KIT_REPO"
(cd ui && npm ci --offline && npm run build)
xvfb-run -a python3 tests/e2e/run.py
```

The runner builds a fresh temporary E2E bundle, discovers the existing Node
journey files and runs them serially. It then enables `MV_E2E_CROSS_ROUTE` for
the wall test. Success requires that the changed route fail the intended wall
assertion with `E2E_ROUTING`; a prerequisite failure does not count as detecting
the mutation. [CITED: ../tests/e2e/run.py, `main`, `is_cross_route_mutant_killed`]

These journeys test their configured fixtures. They do not by themselves prove
that every capsule kind, installed application or external runtime works.

## How do I verify a real capsule?

Use the live runners only after provisioning their named test identity and
pinned external runtimes. The public source contains the harness; a normal
checkout alone does not supply those runtime assets.

Answers: live capsule; G-W1; G-AI; cleanup evidence

The live slice requires `MV_E2E_LIVE=1`, the core, adapter and replay binaries,
and the native runtime paths listed by `requireLive` in
[the slice entry point](../tests/e2e/e2e1_slice/index.js). Keep the test identity
separate from any personal browser profile. The expected environment keys are:

```text
MV_E2E_CORE_BIN       MV_E2E_ADAPTER_BIN     MV_E2E_REPLAY_BIN
MV_SRF_BIN_DIR        MV_SRF_LIVE_PROFILE    MV_SRF_LIVE_RAM_ROOT
MV_SRF_STATE_DIR      SRF_IDENTITY_STORE_ROOT
SRF_PROXY_REGISTRY
```

The agent gate also requires `VQA_VE_ROOT` and `MV_WENDER_ROOT` to identify
runtime installations whose provenance matches [deps.lock](../deps.lock).
[CITED: ../tools/gate_g_ai.py, `preflight`;
../agents/metaviewer_agents/perception/deps_lock.py]

Once those prerequisites are verified, the commands are:

```sh
node tests/e2e/e2e1_slice/index.js --live
python3 tools/gate_g_ai.py --surface mv-live-1
```

The slice checks frame delivery, action receipts, stale-frame refusal, control
handoff, replay, rendering and cleanup. Its `DONE` result requires the named
assertions and cleanup fields to pass. The agent gate additionally resolves its
pinned runtime dependencies in `preflight`; `DONE` requires all assertions,
negative controls and cleanup. Read the full report before declaring success.
[CITED: ../tests/e2e/e2e1_slice/index.js, `checkLiveResult`;
../tools/gate_g_ai.py, `main`]

For an evaluator's installed-package route, use [JUDGE_QUICKSTART.md](JUDGE_QUICKSTART.md)
and [JUDGE_TOUR.md](JUDGE_TOUR.md). The fixture harness and the judge tour answer
different questions.

## How are web workflows and MemoryWeb checked?

The repository provides hosted fixtures and an explicit opt-in live runner.
Start with the hosted checks; they do not need a personal browsing session.
The MemoryWeb hosted suite still requires the pinned Wender checkout through
`MV_MW_WENDER_ROOT` or `MV_WENDER_ROOT`; hosted does not mean dependency-free.

Answers: web workflow tests; MemoryWeb home; hosted versus live web acceptance

```sh
node --test tests/e2e/asm_web_live_hosted.test.js
node --test tests/e2e/asm_web_memoryweb_hosted.test.js
python3 -B -m unittest discover -s tests -p 'test_mw_home_cli.py'
```

[asm_web_live.py](../tests/e2e/e2e1_slice/asm_web_live.py) requires
`MV_LIVE_WEB=1`, `MV_E2E_LIVE=1`, its dedicated profile and every `REQUIRED_ENV`
entry before native execution. Do not infer these from a hosted pass. Workflow
support and refusal behavior are implemented in the runner and
[mw_owner.py](../agents/metaviewer_agents/mw_owner.py); their fixtures are in
[the MemoryWeb hosted suite](../tests/e2e/asm_web_memoryweb_hosted.test.js).

For a local MemoryWeb home check, run:

```sh
python3 tools/mw_home_check.py --repo "$PWD"
```

That command may create the private home. It emits a JSON admission result and
checks ignored/untracked storage, home policy and optional workflow provenance.
It does not execute a workflow or certify a website.
[CITED: ../tools/mw_home_check.py, `main`]

## What do hosted CI and nightly runs establish?

Hosted CI checks the revision and environment named in its job results. A workflow
file's existence does not prove a completed run or configured branch protection.

Answers: ci-required; hosted CI; nightly volume; private assembly

[ci.yml](../.github/workflows/ci.yml) defines the `ci-required` aggregator,
platform jobs and receipt validation. It rejects missing required jobs, failed
assertions and mismatched product or revision evidence. The separate
[secrets workflow](../.github/workflows/secrets.yml) owns secret scanning.
[volume.yml](../.github/workflows/volume.yml) is scheduled/manual coverage, not
a required pull-request status. [assembly.yml](../.github/workflows/assembly.yml)
needs access to the private components and is not reproducible from public source
alone. Evaluation permission is defined in [NOTICE-EVALUATION.md](../NOTICE-EVALUATION.md).

Read actual job output and the commit identity before quoting a CI result.
Current-checkout test totals and live performance receipts are not supplied by
this page: **ABSENT — do not invent**.

## How are documentation and negative controls kept honest?

Documentation checks require real pages, existing command paths and matching
index entries. A changed document needs a refreshed generated index before the
full freshness gate can pass.

Answers: documentation tests; stale index; missing suite; non-vacuity

```sh
python3 -B -m unittest discover -s tests -p 'test_*doc*'
python3 route/route_query.py check
python3 tools/router_index.py --check
```

[The presence gate](../tests/test_docs_presence.py) rejects missing pages,
wrong required headings, nonexistent test-suite names and stale document digests.
[The command-path checks](../tests/test_router_docs.py) reject Python commands
that name missing files. [The non-vacuity matrix](../tests/test_novac_matrix.py)
checks that its gates accept intended inputs and reject altered ones.

The index owner refreshes generated indexes after documentation changes. Report
index drift separately; do not edit a stored digest or weaken a test to obtain
a pass. For bug evidence and safe recovery, use [DEBUG.md](DEBUG.md).

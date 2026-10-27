# How MetaViewer is tested

MetaViewer is verified by six overlapping layers:

1. **The local ten-leg gate** (`bash tools/gate.sh`) and its **self-test** (`bash tools/gate.sh --self-test`).
2. **Live gates** against a real running capsule (`node tests/e2e/e2e1_slice/index.js --live`, `python3 tools/gate_g_ai.py --surface mv-live-1`).
3. **End-to-end journeys** in real headless Electron (`tests/e2e/run.py`, `32` `[MEASURED: ls -1 tests/e2e/*.test.js | wc -l]` Node journey files under `tests/e2e/*.test.js`, and `2` `[MEASURED: ls -1 tests/e2e/test_*.py | wc -l]` Python live-stack suites under `tests/e2e/test_*.py`).
4. **Hosted CI and nightly/soak workflows** (`19` `[MEASURED: grep -E '^  [a-z0-9-]+:$' .github/workflows/*.yml | wc -l]` jobs across `5` `[MEASURED: ls -1 .github/workflows/*.yml | wc -l]` GitHub Actions workflows in `.github/workflows/*.yml`, gated on pull requests and `main` by the `ci-required` aggregate job).
5. **Mutation proofs, budget gate, and negative controls** (`tests/test_contract_mutants.py`, `agents/tests/run_mutant_harness.py`, `tests/supervisor/run_process_gate.sh`, `tools/budget_gate.py --self-test`, and `tools/gate.sh --self-test`).
6. **External testers** (two independent external testers across three adversarial rounds).

Every numeric count in this document is measured on the current tree at commit `b0e7feaf` `[MEASURED: git rev-parse --short HEAD]` (`573` `[MEASURED: git rev-list --count HEAD]` commits on the branch, version `0.1.2` `[MEASURED: cat VERSION]`).

---

## 1. The local gate (`tools/gate.sh`)

Run the full local gate from the repository root:

```sh
CAPSULE_UI_KIT_REPO=/path/to/capsule-ui-kit \
ELECTRON_OVERRIDE_DIST_PATH=/path/to/electron/dist \
  bash tools/gate.sh
```

To run a single leg during iteration, pass `--leg <name>`:

```sh
bash tools/gate.sh --leg laws
bash tools/gate.sh --leg contracts
```

`tools/gate.sh` executes `10` `[MEASURED: bash tools/gate.sh]` legs in order (`manifests`, `laws`, `contracts`, `unit`, `agents`, `js`, `rust`, `go`, `ui`, `ui-smoke`). Every leg must pass (`PASS aggregate` `[MEASURED: bash tools/gate.sh]`) before a change is integrated.

| Order | Leg (`--leg`) | What it runs | Measured result on current tree |
| ---: | :--- | :--- | :--- |
| 1 | `manifests` | Checks for unresolved merge-conflict markers across tracked files (`git grep -n -I -E '^(<<<<<<< \|=======$\|>>>>>>> )'`) and parses `package.json`, `ui/package.json`, `ui/kit.lock.json`, `Cargo.toml`, and `daemon-adapter/go.mod`. | `PASS manifests` (`0` conflict markers, `5` manifest files validated) `[MEASURED: bash tools/gate.sh --leg manifests]` |
| 2 | `laws` | `python3 tools/check_laws.py`: enforces `LAWS.md` on the tree and git history (`--check-git` when `.git` is present) — author identity, English-only tracked files, no secrets/keys/host paths, and no third-party or model attribution strings. | `PASS laws` (`LAWS check: OK`) `[MEASURED: bash tools/gate.sh --leg laws]` |
| 3 | `contracts` | `python3 tools/validate_contracts.py`: validates every JSON Schema under `contracts/v0.1/` (`10` `[MEASURED: ls -1 contracts/v0.1/*.schema.json | wc -l]` schemas) and `contracts/v0.2/` (`20` `[MEASURED: ls -1 contracts/v0.2/*.schema.json | wc -l]` schemas) against `20` `[MEASURED: ls -1 contracts/examples/*.json | wc -l]` v0.1 example fixtures (`10` valid + `10` invalid) and `479` `[MEASURED: ls -1 contracts/examples/v0.2/*.json | wc -l]` v0.2 example fixtures (every schema has at least one `.valid.json` and one `.invalid.json` fixture, including `frame_ack/v0.2`, `frame_port/v1`, `surface_request/v0.2` with `nested_depth`, and `qa_anchors/v0.2`). | `PASS contracts` (`Contract validation: OK`) `[MEASURED: bash tools/gate.sh --leg contracts]` |
| 4 | `unit` | `python3 -m unittest discover -s tests -t .` (`top_level_dir` = repo root): runs all Python unit, contract, router, packaging, and CI-policy suites under `tests/` (`tests/test_*.py`, `tests/ci/test_*.py`, `tests/e2e/test_*.py`, `tests/supervisor/test_*.py`). | `363` `[MEASURED: bash tools/gate.sh --leg unit]` tests, `OK` (`PASS unit`) |
| 5 | `agents` | `python3 -m unittest discover -s agents/tests -t .`: runs the AI-broker, vision-lane, schema-validation, and policy suites under `agents/tests/`. | `553` `[MEASURED: bash tools/gate.sh --leg agents]` tests, `OK` (`PASS agents`) |
| 6 | `js` | Resolves `capsule-ui-kit` at locked version `0.2.1` `[MEASURED: python3 -c 'import json; print(json.load(open("ui/kit.lock.json"))["version"])']`, runs `node tools/sync_kit.mjs`, and checks JS syntax (`node --check`) on `ui/src/main.js`. | `PASS js` (kit `0.2.1` synced and verified) `[MEASURED: bash tools/gate.sh --leg js]` |
| 7 | `rust` | Runs `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -- -D warnings`, and `cargo test --workspace` (`--offline` when `MV_CARGO_OFFLINE=1` is set) across the `metaviewer-core` workspace (`core/`), covering capsule lifecycle, fold/unfold, multislot, recording/replay, IPC framing, and property tests. | `214` `[MEASURED: bash tools/gate.sh --leg rust]` tests passed (`0` failed, `0` ignored) across `39` `[MEASURED: bash tools/gate.sh --leg rust]` test binaries (`PASS rust`) |
| 8 | `go` | Runs `go vet ./...` and `go test -race -count=1 ./...` in `daemon-adapter/`, then cross-checks `GOARCH=amd64 go vet ./...` and `GOARCH=amd64 go test -run '^$' -exec /bin/true ./...` when host `go env GOARCH` is not `amd64`. | `7` `[MEASURED: bash tools/gate.sh --leg go]` Go test packages `ok` (`capsule`, `cli`, `daemon`, `frames`, `ipc`, `record`, `view`; `cmd/mv-daemon-adapter` has `[no test files]`) across native `-race` and `GOARCH=amd64` compile/vet passes (`14` `[MEASURED: bash tools/gate.sh --leg go]` `ok` lines total, `PASS go`) |
| 9 | `ui` | Runs `npm ci --offline` (when `ui/node_modules` is absent), `npm test` (`node --test test/*.test.js`), `npm run check:types` (`vue-tsc --noEmit`), and `npm run build` (`vite build`) in `ui/`. | `2,259` `[MEASURED: bash tools/gate.sh --leg ui]` tests across `237` `[MEASURED: bash tools/gate.sh --leg ui]` suites (`2,258` `[MEASURED: bash tools/gate.sh --leg ui]` pass, `0` fail, `1` `[MEASURED: bash tools/gate.sh --leg ui]` skipped), `vue-tsc --noEmit` clean, `vite build` (`72` `[MEASURED: bash tools/gate.sh --leg ui]` modules transformed, `PASS ui`) |
| 10 | `ui-smoke` | Headless Electron smoke check (`xvfb-run -a node test/electron_smoke.mjs`) verifying that the packaged renderer and Electron main process boot and emit their readiness markers. | `2` `[MEASURED: bash tools/gate.sh --leg ui-smoke]` smoke markers (`METAVIEWER_SMOKE_OK` and `METAVIEWER_MAIN_SMOKE_OK`, `PASS ui-smoke`) |

### Gate self-test (`bash tools/gate.sh --self-test`)

`bash tools/gate.sh --self-test` executes the embedded `GateSelfTests` suite in `tools/gate.sh` (backed by unit checks in `tests/test_gate_target_isolation.py` and `tests/test_t7r2c_gate_admission.py`), verifying that the gate script rejects injected faults across every leg (merge markers, law violations, broken schemas, failing unit/agent/Rust/Go/UI tests, `GOARCH=amd64` compile/vet regressions, and missing smoke markers):

```sh
bash tools/gate.sh --self-test
```

Measured count: `25` `[MEASURED: bash tools/gate.sh --self-test]` self-tests, `OK` (`PASS self-test`, `PASS aggregate`).

---

## 2. Live gates on a real capsule

Live gates run the compiled Rust core (`metaviewer-core`), Go daemon adapter (`mv-daemon-adapter`), and Electron tile against a live isolated capsule (`mv-live-1`), then verify complete teardown (owned container removed, owned processes exited, sockets, temporary state directories, and `/dev/shm` frame directories cleaned up).

### G-W1 (`node tests/e2e/e2e1_slice/index.js --live`)

`node tests/e2e/e2e1_slice/index.js --live` (with `tests/e2e/e2e1_slice/live.py`, `electron-relay.mjs`, and `mv-replay`) exercises `11` `[MEASURED: grep -c 'assert' tests/e2e/e2e1_slice/live.py]` live assertions across the real stack:

1. Capsule frame publication, UI fan-out, and retained witness bytes (`1280x900` `rgb24`).
2. Observe → admitted → dispatched → receipt → pixel verification (`status: "verified"`, `focus_verified: true`, `receipt.verified: true`, `method: "pixel"`).
3. Different-surface binding negative control (`verified: false`).
4. Generation-binding negative control (`verified: false`).
5. Stale-generation refusal (`STALE_FRAME`) without domain state change.
6. Pending proposal cancellation on human takeover (`SURFACE_NOT_AGENT_CONTROLLED`).
7. Human refusal while under human control and clean control release.
8. Fresh-frame readmission after control release (`live-readmitted` admitted and receipted).
9. Durable journal replay equality (`mv-replay` `rc=0`) and corrupted-journal rejection (`Corrupt`, `rc=2`).
10. Real Electron tile rendering under `xvfb-run` (`tile: "PASS"`, canvas SHA-256 equal to frame SHA-256).
11. Complete container, process, socket, temporary-tree, and RAM cleanup.

### G-AI (`python3 tools/gate_g_ai.py --surface mv-live-1`)

`python3 tools/gate_g_ai.py --surface mv-live-1` (backed by `tests/e2e/e2e1_slice/g_ai_stack.py` and `8` `[MEASURED: python3 -m unittest tests/test_gate_g_ai_harness.py -v]` harness unit tests in `tests/test_gate_g_ai_harness.py`) runs `8` `[MEASURED: grep -c '"A[1-8]"' tools/gate_g_ai.py]` live assertions (`A1`–`A8`) and `19` `[MEASURED: python3 -m unittest tests/test_gate_g_ai_harness.py -v]` negative controls across the AI observe-propose-admit-verify loop (`action_verdict/v0.2` → `action_receipt/v0.2`), verifying post-action pixel witnesses and runtime dependency pins in `deps.lock`.

---

## 3. End-to-end journeys (`tests/e2e/`)

### Inventory of E2E suites

`tests/e2e/` contains `32` `[MEASURED: ls -1 tests/e2e/*.test.js | wc -l]` Node journey files (`tests/e2e/*.test.js`) and `2` `[MEASURED: ls -1 tests/e2e/test_*.py | wc -l]` Python live-stack test files (`tests/e2e/test_*.py`).

`tests/e2e/run.py` orchestrates the default `20` `[MEASURED: xvfb-run -a -s "-screen 0 1280x900x24" python3 tests/e2e/run.py]` `SUITE_FILES` in a single shared headless Electron pass plus a mandatory negative-control pass (`run_negative_control()`, which injects `MV_E2E_MUTANT_CROSS_ROUTING=1` and verifies that `tests/e2e/ac06_multislot.test.js` fails when cross-slot frame routing is mutated). The remaining `12` `[MEASURED: python3 -c 'import glob, runpy; s=set(runpy.run_path("tests/e2e/run.py")["SUITE_FILES"]); all_js={p.split("/")[-1] for p in glob.glob("tests/e2e/*.test.js")}; print(len(all_js - s))']` Node `.test.js` files are targeted acceptance, slice, scenario, and production-bundle journeys invoked directly with `node --test` or by the Python E2E harnesses.

#### Default suites executed by `tests/e2e/run.py` (`20` files)

1. `tests/e2e/e2e1_wall.test.js` — wall shell, dockview layout, capsule creation, and activity strip.
2. `tests/e2e/e2e3_refusals.test.js` — deterministic contract and policy refusals in the live UI.
3. `tests/e2e/e2e4_seams.test.js` — core/daemon/UI seam integrity and correlation propagation.
4. `tests/e2e/e2e6_slice.test.js` — live vertical slice across core, daemon-adapter, and Electron renderer.
5. `tests/e2e/e2e7_live_slice_honesty.test.js` — verifies no synthetic or mock frame injection on the live slice path.
6. `tests/e2e/e2e8_ac04_control_journey.test.js` — AC-04 human/agent control handoff, takeover preempt, and `"Agent acting"` / `"Agent ready"` indicator transitions.
7. `tests/e2e/e2e10_stale_settlement.test.js` — stale frame and settlement rejection after state transitions.
8. `tests/e2e/e2e11_golden_replay.test.js` — deterministic `.mvrec` golden recording and replay verification.
9. `tests/e2e/e2e12_replay_purity.test.js` — replay side-effect purity (replay cannot mutate live capsules).
10. `tests/e2e/e2e13_repeat_rung.test.js` — repeated lifecycle rung stability across create/fold/unfold/destroy cycles.
11. `tests/e2e/e2e14_perf.test.js` — interactive frame and input latency budget checks.
12. `tests/e2e/e2e15_conservation_ledger.test.js` — resource and session conservation ledger invariants.
13. `tests/e2e/e2e16_electron_security.test.js` — Electron `contextIsolation`, `sandbox`, preload bridge, and CSP invariants.
14. `tests/e2e/e2e17_arrival_registration_order.test.js` — out-of-order frame arrival vs surface registration handling.
15. `tests/e2e/e2e18_budgets.test.js` — memory, queue depth, and frame-port backpressure budget enforcement.
16. `tests/e2e/e2e19_nested.test.js` — AC-17 nested MetaViewer capsule (`metaviewer-nested`) with `nested_depth: 0` outer wall, `nested_depth: 1` inner capsule, and `nested_depth >= 2` deterministic refusal.
17. `tests/e2e/e2e20_headless_discipline.test.js` — headless Xvfb discipline and clean process group teardown.
18. `tests/e2e/ac02_oracle_regression.test.js` — AC-02 pixel oracle regression checks on rendered canvas surfaces.
19. `tests/e2e/ac06_multislot.test.js` — AC-06 multi-capsule wall isolation (`N >= 2` simultaneous capsules without cross-routing).
20. `tests/e2e/ac07_ram_first.test.js` — AC-07 RAM-first ring buffer and zero-disk-write idle discipline.

#### Additional targeted and production-bundle Node journeys (`12` files)

21. `tests/e2e/ac02_wall.test.js` — standalone AC-02 wall pixel verification journey.
22. `tests/e2e/ac03_lifecycle.test.js` — standalone AC-03 capsule create/fold/unfold/destroy lifecycle journey.
23. `tests/e2e/ac04_control.test.js` — standalone AC-04 human/agent control exclusivity journey.
24. `tests/e2e/ac05_ai.test.js` — standalone AC-05 AI vision intent and action journey.
25. `tests/e2e/e2e1_slice.test.js` — standalone E2E-1 live slice journey.
26. `tests/e2e/e2e2_scenario.test.js` — multi-step operator scenario journey.
27. `tests/e2e/e2e21_launcher.test.js` — desktop launcher and CLI entrypoint journey.
28. `tests/e2e/e2e22_correlation_trace.test.js` — end-to-end `correlation_id` trace continuity across IPC boundaries.
29. `tests/e2e/e2e23_unknown_vs_destroyed.test.js` — distinct refusal codes for unknown vs already-destroyed capsules.
30. `tests/e2e/e2e24_routing_ownership.test.js` — surface routing ownership and stale-owner rejection.
31. `tests/e2e/e2e25_production_frames.test.js` — production `ui/dist` renderer frame painting journey over `frame_port/v1` (`MessagePortMain` / `MessageChannelMain`) with `frame_ack/v0.2` (`PRESENTED`, `SUPERSEDED`, `FOLD_DRAIN`, `HIDDEN`, `CONTEXT_LOST`, `SURFACE_DESTROYED`, `REFUSED`), `[MV_FRAME_DIAG]` diagnostics (`MV_FRAME_DIAG=1`), and recording list coalescing.
32. `tests/e2e/volume_bootstrap.test.js` — volume and soak bootstrap journey invoked by `tests/e2e/test_volume_bootstrap.py`.

#### Python E2E suites (`2` files)

- `tests/e2e/test_live_stack.py` — live stack integration tests across the Rust core, Go daemon-adapter, and headless Electron harness.
- `tests/e2e/test_volume_bootstrap.py` — volume, repeat-rung (`--repeat`), and wall-soak (`--wall-soak-seconds`) harness verification (`29` `[MEASURED: python3 -m unittest tests/e2e/test_live_stack.py tests/e2e/test_volume_bootstrap.py -v]` tests across both Python E2E files, `OK`).

### Running the E2E suite and individual journeys locally

#### Step 1: Build the production UI (`ui/dist/`) and E2E bundle

Sync `capsule-ui-kit` and build `ui/dist/` in `ui/` first (required by production-bundle journeys such as `tests/e2e/e2e25_production_frames.test.js` and `ui-smoke`):

```sh
node tools/sync_kit.mjs /path/to/capsule-ui-kit
(cd ui && npm ci --offline && npm run build)
```

#### Step 2: Run the full E2E orchestrator (`tests/e2e/run.py`)

`tests/e2e/run.py` automatically builds the E2E fixture bundle via `tests/e2e/build.mjs`, runs the `20` default suites under Xvfb, and then runs the cross-routing negative control:

```sh
CAPSULE_UI_KIT_REPO=/path/to/capsule-ui-kit \
ELECTRON_OVERRIDE_DIST_PATH=/path/to/electron/dist \
  xvfb-run -a -s "-screen 0 1280x900x24" python3 tests/e2e/run.py
```

Measured result on the current tree: `223` `[MEASURED: xvfb-run -a -s "-screen 0 1280x900x24" python3 tests/e2e/run.py]` tests across `20` `[MEASURED: xvfb-run -a -s "-screen 0 1280x900x24" python3 tests/e2e/run.py]` suites (`222` `[MEASURED: xvfb-run -a -s "-screen 0 1280x900x24" python3 tests/e2e/run.py]` pass, `0` fail, `0` skipped, `1` `[MEASURED: xvfb-run -a -s "-screen 0 1280x900x24" python3 tests/e2e/run.py]` todo) plus `E2E negative control: cross-routing detected` (`PASS`).

#### Step 3: Run an individual `tests/e2e/*.test.js` journey locally

For journeys that run against the E2E fixture bundle (`tests/e2e/build.mjs`), build `/tmp/mv-e2e-build` once and run `node --test` on the desired journey file under `xvfb-run`:

```sh
MV_E2E_BUILD=/tmp/mv-e2e-build node tests/e2e/build.mjs
MV_E2E_LIVE=1 MV_E2E_BUILD=/tmp/mv-e2e-build \
  ELECTRON_OVERRIDE_DIST_PATH=/path/to/electron/dist \
  xvfb-run -a -s "-screen 0 1280x900x24" \
  node --test tests/e2e/e2e19_nested.test.js
```

For `tests/e2e/e2e25_production_frames.test.js`, which boots the production renderer bundle in `ui/dist/` (`npm run build` in `ui/` first) and verifies live `frame_port/v1` canvas presentation (`MV_E2E_STRICT_RENDERER=1` enables the full 2-capsule strict renderer assertion):

```sh
(cd ui && npm run build)
MV_E2E_STRICT_RENDERER=1 \
  ELECTRON_OVERRIDE_DIST_PATH=/path/to/electron/dist \
  xvfb-run -a -s "-screen 0 1280x900x24" \
  node --test tests/e2e/e2e25_production_frames.test.js
```

Measured result for `tests/e2e/e2e25_production_frames.test.js` with `MV_E2E_STRICT_RENDERER=1`: `3` `[MEASURED: MV_E2E_STRICT_RENDERER=1 xvfb-run -a -s "-screen 0 1280x900x24" node --test tests/e2e/e2e25_production_frames.test.js]` tests, `3` pass, `0` fail, `0` todo.

---

## 4. Hosted CI and workflow jobs (`.github/workflows/*.yml`)

The repository defines `5` `[MEASURED: ls -1 .github/workflows/*.yml | wc -l]` workflow files in `.github/workflows/*.yml` containing `19` `[MEASURED: grep -E '^  [a-z0-9-]+:$' .github/workflows/*.yml | wc -l]` job definitions (`13` `[MEASURED: grep -E '^  [a-z0-9-]+:$' .github/workflows/ci.yml | wc -l]` in `.github/workflows/ci.yml`, `1` `[MEASURED: grep -E '^  [a-z0-9-]+:$' .github/workflows/secrets.yml | wc -l]` in `.github/workflows/secrets.yml`, `1` `[MEASURED: grep -E '^  [a-z0-9-]+:$' .github/workflows/package.yml | wc -l]` in `.github/workflows/package.yml`, `1` `[MEASURED: grep -E '^  [a-z0-9-]+:$' .github/workflows/build-other.yml | wc -l]` in `.github/workflows/build-other.yml`, and `3` `[MEASURED: grep -E '^  [a-z0-9-]+:$' .github/workflows/volume.yml | wc -l]` in `.github/workflows/volume.yml`).

### How required status is decided

In `.github/workflows/ci.yml`, the aggregate gate job `ci-required` declares:

```yaml
needs: [ci-policy, laws-contracts, router, rust, go, python, js, e2e, novac, package]
```

`ci-required` runs with `if: always()` on `[x64, arm64]` and fails unless every one of those `10` `[MEASURED: grep -F 'for r in (' .github/workflows/ci.yml | wc -l]` upstream jobs succeeded. `build-macos` and `build-windows` are excluded from `ci-required.needs` and carry `continue-on-error: true`. `.github/workflows/secrets.yml` (`Secrets / secrets`) runs as a separate workflow on every push and pull request; `.github/workflows/package.yml`, `.github/workflows/build-other.yml`, and `.github/workflows/volume.yml` are non-required packaging, reference, or scheduled/manual soak workflows.

### Complete workflow job inventory (`19` jobs across `5` files)

| Workflow file | Job key (`name`) | Runners / matrix | Required (`ci-required`) | What it runs |
| :--- | :--- | :--- | :--- | :--- |
| `.github/workflows/ci.yml` | `ci-policy` (`ci-policy (x64)`) | `ubuntu-24.04` (`x64`) | **Yes** (in `ci-required.needs`) | Runs `node --test tests/ci/*.test.cjs` (`7` `[MEASURED: node --test tests/ci/*.test.cjs]` tests), `python3 -m unittest discover -s tests/ci -p 'test_*.py' -v` (`96` `[MEASURED: python3 -m unittest discover -s tests/ci -p 'test_*.py' -v]` tests), and `python3 tools/budget_gate.py --self-test` (`6` `[MEASURED: python3 tools/budget_gate.py --self-test]` checks). |
| `.github/workflows/ci.yml` | `laws-contracts` (`laws-contracts (x64)`) | `ubuntu-24.04` (`x64`) | **Yes** (in `ci-required.needs`) | Runs `python3 tools/check_laws.py --check-git`, `python3 tools/validate_contracts.py`, and `python3 -m unittest tests/test_contract_mutants.py -v` (`2` `[MEASURED: python3 -m unittest tests/test_contract_mutants.py -v]` schema-mutant tests). |
| `.github/workflows/ci.yml` | `router` (`router (x64)`) | `ubuntu-24.04` (`x64`) | **Yes** (in `ci-required.needs`) | Runs `python3 tools/router_index.py --check` and `python3 -m unittest discover -s tests -p 'test_router*.py' -v`. |
| `.github/workflows/ci.yml` | `rust` (`rust (${{ matrix.arch }})`) | `ubuntu-24.04` (`x64`), `ubuntu-24.04-arm` (`arm64`) | **Yes** (in `ci-required.needs`) | Runs `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -- -D warnings`, and `cargo test --workspace` on `1.92.0` (`PROPTEST_CASES: 64`). |
| `.github/workflows/ci.yml` | `go` (`go (${{ matrix.arch }})`) | `ubuntu-24.04` (`x64`), `ubuntu-24.04-arm` (`arm64`) | **Yes** (in `ci-required.needs`) | Runs `go vet ./...` and `go test -race -count=1 ./...` in `daemon-adapter/` on Go `1.22.5`. |
| `.github/workflows/ci.yml` | `python` (`python (${{ matrix.arch }})`) | `ubuntu-24.04` (`x64`), `ubuntu-24.04-arm` (`arm64`) | **Yes** (in `ci-required.needs`) | Runs `python3 -m unittest discover -s tests -p 'test_*.py' -v`, `python3 -m unittest discover -s agents/tests -p 'test_*.py' -v`, `python3 agents/tests/run_mutant_harness.py` (`8` `[MEASURED: python3 agents/tests/run_mutant_harness.py]` mutants `M1`–`M8`), and `bash tests/supervisor/run_process_gate.sh` (`13` `[MEASURED: bash tests/supervisor/run_process_gate.sh]` mutation controls + `1` unittest). |
| `.github/workflows/ci.yml` | `js` (`js (${{ matrix.arch }})`) | `ubuntu-24.04` (`x64`), `ubuntu-24.04-arm` (`arm64`) | **Yes** (in `ci-required.needs`) | Syncs `capsule-ui-kit`, runs `npm ci`, `npm test`, `npm run check:types`, `npm run build` in `ui/`, and headless Electron smoke `xvfb-run -a node test/electron_smoke.mjs`. |
| `.github/workflows/ci.yml` | `e2e` (`e2e (${{ matrix.arch }})`) | `ubuntu-24.04` (`x64`), `ubuntu-24.04-arm` (`arm64`) | **Yes** (in `ci-required.needs`) | Builds `metaviewer-core` (`cargo build`), `mv-daemon-adapter` (`go build`), and `ui/dist` (`npm run build`), then runs `xvfb-run -a -s "-screen 0 1280x900x24" python3 tests/e2e/run.py`, `MV_E2E_STRICT_RENDERER=1 xvfb-run -a -s "-screen 0 1280x900x24" node --test tests/e2e/e2e25_production_frames.test.js`, and `python3 -m unittest tests/e2e/test_live_stack.py tests/e2e/test_volume_bootstrap.py -v`. |
| `.github/workflows/ci.yml` | `novac` (`novac (x64)`) | `ubuntu-24.04` (`x64`) | **Yes** (in `ci-required.needs`) | Runs `python3 tools/check_no_vacuous_tests.py` to reject vacuous assertions across the test tree. |
| `.github/workflows/ci.yml` | `package` (`package (${{ matrix.arch }})`) | `ubuntu-24.04` (`x64`), `ubuntu-24.04-arm` (`arm64`) | **Yes** (in `ci-required.needs`) | Runs `bash tools/package_linux.sh "${{ matrix.arch }}"` and smoke-tests the packaged artifact via `xvfb-run -a bash tools/smoke_packaged.sh "dist/metaviewer-linux-${{ matrix.arch }}.tar.gz"`. |
| `.github/workflows/ci.yml` | `build-macos` (`build-macos (non-blocking)`) | `macos-latest` | **No** (`continue-on-error: true`, not in `ci-required.needs`) | Compiles `cargo build --workspace --all-targets` and `go build ./...` / `go test -run '^$' ./...` on macOS. |
| `.github/workflows/ci.yml` | `build-windows` (`build-windows (non-blocking)`) | `windows-latest` | **No** (`continue-on-error: true`, not in `ci-required.needs`) | Compiles `cargo build --workspace --all-targets` and `go build ./...` / `go test -run '^$' ./...` on Windows. |
| `.github/workflows/ci.yml` | `ci-required` (`ci-required (${{ matrix.arch }})`) | `ubuntu-24.04` (`x64`), `ubuntu-24.04-arm` (`arm64`) | **Yes** (aggregate required gate job) | Aggregate required check (`if: always()`); verifies that all `10` `[MEASURED: grep -F 'for r in (' .github/workflows/ci.yml | wc -l]` jobs in `needs` (`ci-policy`, `laws-contracts`, `router`, `rust`, `go`, `python`, `js`, `e2e`, `novac`, `package`) returned `"success"`. |
| `.github/workflows/secrets.yml` | `secrets` (`secrets (x64)`) | `ubuntu-24.04` (`x64`) | Separate branch-protection check (`Secrets / secrets`; not in `ci-required.needs`) | Runs `python3 tools/check_secrets.py --check-git` and `python3 -m unittest discover -s tests -p 'test_secrets*.py' -v` on `push` and `pull_request`. |
| `.github/workflows/package.yml` | `linux-package` (`linux-package (${{ matrix.arch }})`) | `ubuntu-24.04` (`x64`), `ubuntu-24.04-arm` (`arm64`) | **No** (standalone packaging workflow on `v*` tags / `push` / `pull_request` / `workflow_dispatch`) | Builds `dist/metaviewer-linux-${{ matrix.arch }}.tar.gz`, verifies `SHA256SUMS`, runs `xvfb-run -a bash tools/smoke_packaged.sh`, and uploads release artifacts. |
| `.github/workflows/build-other.yml` | `build-other-reference` (`build-other (${{ matrix.os }}, non-blocking)`) | `macos-latest`, `windows-latest` | **No** (`workflow_dispatch` only, `continue-on-error: true`) | Manual reference compile check (`cargo check --workspace` and `go build ./cmd/mv-daemon-adapter`) on macOS and Windows. |
| `.github/workflows/volume.yml` | `volume-property` (`volume-property (${{ matrix.arch }})`) | `ubuntu-24.04` (`x64`), `ubuntu-24.04-arm` (`arm64`) | **No** (nightly `schedule` `17 3 * * *` and `workflow_dispatch`) | Runs deep property-based testing with `PROPTEST_CASES=10000 cargo test --workspace` (`timeout-minutes: 45`). |
| `.github/workflows/volume.yml` | `volume-mutants` (`volume-mutants (${{ matrix.arch }})`) | `ubuntu-24.04` (`x64`), `ubuntu-24.04-arm` (`arm64`) | **No** (nightly `schedule` `17 3 * * *` and `workflow_dispatch`) | Runs `python3 tools/check_no_vacuous_tests.py`, `python3 -m unittest tests/test_contract_mutants.py -v`, `python3 agents/tests/run_mutant_harness.py`, and `bash tests/supervisor/run_process_gate.sh`. |
| `.github/workflows/volume.yml` | `volume-e2e` (`volume-e2e (${{ matrix.arch }})`) | `ubuntu-24.04` (`x64`), `ubuntu-24.04-arm` (`arm64`) | **No** (nightly `schedule` `17 3 * * *` and `workflow_dispatch`) | Runs `python3 tests/e2e/run.py --repeat 20` (`volume-e2e`), `python3 tests/e2e/run.py --repeat 300 --suite e2e6_slice.test.js` (`volume-e2e-qualification`), and `python3 tests/e2e/run.py --wall-soak-seconds 600` (`volume-wall-soak`), then uploads soak summary JSON artifacts. |

### Reproducing the hosted-like environment locally

Hosted Ubuntu runners differ from a developer workstation in four ways that previously masked regressions if not tested explicitly:

1. **No global git identity (`GIT_CONFIG_GLOBAL=/dev/null`):** hosted runners have no `~/.gitconfig` `user.name` or `user.email`. Tests that create temporary git repositories or verify receipt identities must succeed with `GIT_CONFIG_GLOBAL=/dev/null`:

   ```sh
   GIT_CONFIG_GLOBAL=/dev/null \
     python3 -m unittest tests/ci/test_t7r2c_receipt_identity.py -v
   ```

   Measured result: `8` `[MEASURED: GIT_CONFIG_GLOBAL=/dev/null python3 -m unittest tests/ci/test_t7r2c_receipt_identity.py -v]` tests, `OK`.

2. **Python stdlib-only (`PyYAML` absent):** the `ci-policy`, `laws-contracts`, and `router` jobs run on system Python 3 without third-party packages such as `PyYAML`. All workflow parsers in `tests/ci/` must work with `yaml` blocked (`sys.modules['yaml'] = None`):

   ```sh
   GIT_CONFIG_GLOBAL=/dev/null python3 -c "import sys, unittest; sys.modules['yaml']=None; suite=unittest.defaultTestLoader.discover('tests/ci', pattern='test_t7r2c_*.py'); res=unittest.TextTestRunner(verbosity=2).run(suite); sys.exit(0 if res.wasSuccessful() else 1)"
   ```

   Measured result: `34` `[MEASURED: GIT_CONFIG_GLOBAL=/dev/null python3 -c "import sys, unittest; sys.modules['yaml']=None; suite=unittest.defaultTestLoader.discover('tests/ci', pattern='test_t7r2c_*.py'); res=unittest.TextTestRunner(verbosity=2).run(suite); sys.exit(0 if res.wasSuccessful() else 1)"]` tests across `tests/ci/test_t7r2c_*.py`, `OK`.

3. **Empty npm and Electron caches (`npm_config_cache`, `ELECTRON_CACHE`, `electron_config_cache`):** offline packaging scripts must fail closed with a deterministic prerequisite diagnostic (`PKG_CLEAN_CI_PREREQ_NPM_CACHE_MISSING` / `PKG_CLEAN_CI_PREREQ_ELECTRON_ZIP_MISSING`) instead of hanging or attempting network fetches when caches are empty:

   ```sh
   npm_config_cache=/tmp/mv-empty-npm-cache \
   ELECTRON_CACHE=/tmp/mv-empty-electron-cache \
   electron_config_cache=/tmp/mv-empty-electron-cache \
     python3 -m unittest tests/ci/test_fx2_package.py -v
   ```

   Measured result: `1` `[MEASURED: npm_config_cache=/tmp/mv-empty-npm-cache ELECTRON_CACHE=/tmp/mv-empty-electron-cache electron_config_cache=/tmp/mv-empty-electron-cache python3 -m unittest tests/ci/test_fx2_package.py -v]` test, `OK` (emits `CLEAN_CI_REPRO_PREREQ: PKG_CLEAN_CI_PREREQ_NPM_CACHE_MISSING`).

4. **Cross-architecture `GOARCH=amd64` Go vet and compile check on `arm64` hosts:** `daemon-adapter/` includes architecture-specific syscalls and struct fields (`uint64` vs `uint32`), so `tools/gate.sh --leg go` runs both native `go test -race` and `GOARCH=amd64` compilation/vetting:

   ```sh
   GOARCH=amd64 go -C daemon-adapter vet ./...
   GOARCH=amd64 go -C daemon-adapter test -run '^$' -exec /bin/true ./...
   ```

   Measured result: `0` `[MEASURED: GOARCH=amd64 go -C daemon-adapter vet ./...]` warnings (`rc=0`) and `7` `[MEASURED: GOARCH=amd64 go -C daemon-adapter test -run '^$' -exec /bin/true ./...]` packages compiled cleanly.

---

## 5. Mutation proofs, budget gate, and negative controls

To prevent vacuous green suites, the repository ships automated mutation and negative-control harnesses that run both in the local gate and in CI (`ci-policy`, `laws-contracts`, `python`, `e2e`, and nightly `volume-mutants`):

| Harness | Command | What it verifies and measured count |
| :--- | :--- | :--- |
| Contract schema mutants | `python3 -m unittest tests/test_contract_mutants.py -v` | Generates at least `10` `[MEASURED: grep -E '^MIN_MUTANTS_PER_SCHEMA = [0-9]+' tests/test_contract_mutants.py]` deterministic structural mutations (`MIN_MUTANTS_PER_SCHEMA = 10`) per JSON schema across `contracts/v0.1/` and `contracts/v0.2/` and asserts every mutant is rejected (`2` `[MEASURED: python3 -m unittest tests/test_contract_mutants.py -v]` tests, `OK`). |
| Agent policy mutant harness | `python3 agents/tests/run_mutant_harness.py` | Injects `8` `[MEASURED: python3 agents/tests/run_mutant_harness.py]` policy and broker mutants (`M1` through `M8`) and verifies `8` of `8` are rejected (`100%` conforming). |
| Process supervisor mutation gate | `bash tests/supervisor/run_process_gate.sh` | Runs `1` `[MEASURED: bash tests/supervisor/run_process_gate.sh]` supervisor unit suite (`OK`) and `13` `[MEASURED: bash tests/supervisor/run_process_gate.sh]` process-containment mutation controls (`13` of `13` rejected). |
| Performance & resource budget gate | `python3 tools/budget_gate.py --self-test` | Verifies the metric budget evaluator against synthetic passing and failing latency/memory/drop fixtures (`6` `[MEASURED: python3 tools/budget_gate.py --self-test]` self-test checks passed, `0` failed). |
| E2E cross-routing negative control | `xvfb-run -a -s "-screen 0 1280x900x24" python3 tests/e2e/run.py` | Runs `tests/e2e/ac06_multislot.test.js` with `MV_E2E_MUTANT_CROSS_ROUTING=1` and asserts that the suite fails when a frame for capsule A is routed to capsule B (`1` `[MEASURED: xvfb-run -a -s "-screen 0 1280x900x24" python3 tests/e2e/run.py]` negative control pass). |
| Gate fault-injection self-test | `bash tools/gate.sh --self-test` | Injects synthetic failures into each leg of `tools/gate.sh` and asserts the gate exits non-zero (`25` `[MEASURED: bash tools/gate.sh --self-test]` tests in `tools/gate.sh` `GateSelfTests`, `OK`). |

Across a full `bash tools/gate.sh` run, `12` `[MEASURED: bash tools/gate.sh]` mutant-named unit/agent/UI tests execute and pass inside the standard legs in addition to the standalone harnesses above.

---

## 6. External testers

Two independent external testers reviewed the repository across three adversarial rounds (documented in [`META_AI_USAGE.md`](../META_AI_USAGE.md)):

- **Round 1:** audited early contract schemas, daemon-adapter process lifecycle, and local gate coverage; surfaced missing negative controls and cross-architecture `GOARCH=amd64` build checks.
- **Round 2:** audited hosted-CI parity (`GIT_CONFIG_GLOBAL=/dev/null`, stdlib-only Python without `PyYAML`, offline packaging prerequisites), Electron security (`contextIsolation`, `sandbox`, preload surface), and multi-slot isolation (`ac06_multislot.test.js`).
- **Round 3:** audited production renderer frame delivery (`frame_port/v1` and `frame_ack/v0.2`), `nested_depth` (`0` / `1` / `>= 2` refusal) on `surface_request/v0.2`, QA anchors gating (`MV_QA_ANCHORS=1`), recording list coalescing, and documentation/test-count parity (`tests/test_docs_presence.py`).

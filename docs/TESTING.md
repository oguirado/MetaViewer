# How MetaViewer is tested

I verify MetaViewer across six overlapping layers:

1. **The local eleven-leg gate** (`bash tools/gate.sh`) and its **self-test** (`bash tools/gate.sh --self-test`).
2. **Live gates** against a real running capsule (`node tests/e2e/e2e1_slice/index.js --live`, `python3 tools/gate_g_ai.py --surface mv-live-1`).
3. **End-to-end journeys** in real headless Electron (`tests/e2e/run.py`, `35` `[MEASURED: ls -1 tests/e2e/*.test.js | wc -l]` Node journey files under `tests/e2e/*.test.js`, and `2` `[MEASURED: ls -1 tests/e2e/test_*.py | wc -l]` Python live-stack suites under `tests/e2e/test_*.py`).
4. **Hosted CI and nightly/soak workflows** (`19` `[MEASURED: grep -E '^  [a-z0-9-]+:$' .github/workflows/*.yml | wc -l]` jobs across `5` `[MEASURED: ls -1 .github/workflows/*.yml | wc -l]` GitHub Actions workflows in `.github/workflows/*.yml`, gated on pull requests and `main` by the `ci-required` aggregate job).
5. **Mutation proofs, budget gate, and negative controls** (`tests/test_contract_mutants.py`, `agents/tests/run_mutant_harness.py`, `tests/supervisor/check_mutations.py`, `tools/budget_gate.py --self-test`, and `tools/gate.sh --self-test`).
6. **External testers** (two independent external testers across three adversarial rounds).

Every numeric count in this document is measured on the current tree at commit `a768a684` `[MEASURED: git rev-parse --short HEAD]` (`769` `[MEASURED: git rev-list --count HEAD]` commits on the branch, version `0.1.2` `[MEASURED: cat VERSION]`).

---

## 1. The local gate (`tools/gate.sh`)

I run the full local gate from the repository root:

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

`tools/gate.sh` executes `11` `[MEASURED: bash tools/gate.sh]` legs in order (`manifests`, `laws`, `contracts`, `unit`, `agents`, `js`, `rust`, `go`, `ui`, `ui-smoke`, `perf`). Every leg must pass (`PASS aggregate` `[MEASURED: bash tools/gate.sh]`) before a change is integrated.

| Order | Leg (`--leg`) | What it runs | Measured result on current tree |
| ---: | :--- | :--- | :--- |
| 1 | `manifests` | Runs `validate_manifests()` (`tools/gate.sh`): verifies `VERSION` and the `6` `[MEASURED]` manifest/ignore files in `FILES` (`Cargo.toml` with `rust-version = "1.97"`, `core/Cargo.toml`, `daemon-adapter/go.mod` with `go 1.26.0`, `agents/pyproject.toml`, `ui/package.json`, `.gitignore`), then runs `validate_frozen_dependencies()` in a disposable scratch tree against `deps.lock`, `Cargo.lock` (`cargo metadata --offline --locked`), and `ui/package-lock.json` (`npm ci --offline --ignore-scripts --dry-run`). | `PASS manifests` (`VERSION`, `6` `[MEASURED]` manifest/ignore files, and frozen offline locks validated) `[MEASURED: bash tools/gate.sh --leg manifests]` |
| 2 | `laws` | Runs `python3 tools/check_laws.py --version` and `LAWS_CODE` (`tools/check_laws.py` excluding only `refs/stash` from `git rev-list --all`): enforces `LAWS.md` on tracked files and git history — author identity, English-only tracked files, no secrets/keys/host paths, and no third-party or model attribution strings. | `PASS laws` (`Laws check: OK` twice) `[MEASURED: bash tools/gate.sh --leg laws]` |
| 3 | `contracts` | Runs `python3 tools/check_contracts.py`: validates every JSON Schema under `contracts/v0.1/` (`10` `[MEASURED: ls -1 contracts/v0.1/*.schema.json | wc -l]` schemas) and `contracts/v0.2/` (`21` `[MEASURED: ls -1 contracts/v0.2/*.schema.json | wc -l]` schemas) against `20` `[MEASURED: ls -1 contracts/examples/*.json | wc -l]` v0.1 example fixtures (`10` `[MEASURED]` valid + `10` `[MEASURED]` invalid) and `488` `[MEASURED: ls -1 contracts/examples/v0.2/*.json | wc -l]` v0.2 example fixtures (every schema has at least one `.valid.json` and one `.invalid.json` fixture, including `surface_request/v0.2` with `nested_depth` and `surface_input/v0.2`). | `PASS contracts` (`Contracts check: OK`) `[MEASURED: bash tools/gate.sh --leg contracts]` |
| 4 | `unit` | Runs `UNIT_CODE` (`unittest.defaultTestLoader.discover(start_dir="tests")` plus `tests/e2e/e2e1_slice`): executes all Python unit, contract, router, packaging, and CI-policy suites under `tests/` (`tests/test_*.py`, `tests/ci/test_*.py`, `tests/e2e/test_*.py`, `tests/integration/test_*.py`, and `tests/e2e/e2e1_slice/test_*.py`). Note: `tests/test_t7r2c_reproducibility.py` imports `ui/tools/package.js` (`@electron/asar`), so `ui/node_modules` must be installed (`npm --prefix ui ci --offline`) before running `--leg unit`. | `408` `[MEASURED: bash tools/gate.sh --leg unit]` tests, `OK` (`PASS unit`) |
| 5 | `agents` | Runs `AGENTS_UNIT_CODE` (`unittest.defaultTestLoader.discover(start_dir="agents/tests")`) followed by `python3 agents/tests/run_mutant_harness.py` (`SW-0065` mutant injection matrix `M1`–`M8`). | `584` `[MEASURED: bash tools/gate.sh --leg agents]` unit tests (`OK`) + `8` `[MEASURED: python3 agents/tests/run_mutant_harness.py]` mutants (`M1`–`M8`, `100%` conforming, `PASS agents`) |
| 6 | `js` | Resolves `capsule-ui-kit` at locked version `0.2.1` `[MEASURED: python3 -c 'import json; print(json.load(open("ui/kit.lock.json"))["version"])']` (`MV_KIT_CHECKOUT` or `CAPSULE_UI_KIT_REPO`) and runs `node tools/sync_kit.mjs` and `node tools/sync_kit.mjs --check`. | `PASS js` (kit `0.2.1` synced and contentHash verified) `[MEASURED: bash tools/gate.sh --leg js]` |
| 7 | `rust` | Runs `rustup run 1.92.0 cargo fmt --all --check`, `cargo clippy --locked --offline --all-targets -- -D warnings`, and `cargo test --locked --offline` across the `metaviewer-core` workspace (`core/`), covering capsule lifecycle, fold/unfold, multislot, recording/replay, IPC framing, and property tests. | `256` `[MEASURED: bash tools/gate.sh --leg rust]` tests passed (`0` failed, `0` ignored) across `42` `[MEASURED: bash tools/gate.sh --leg rust]` test binaries (`PASS rust`) |
| 8 | `go` | Runs `go vet ./...` and `go test -race -count=1 ./...` in `daemon-adapter/`, then cross-checks `GOARCH=amd64 go vet ./...` and `GOARCH=amd64 go test -run '^$' -exec /bin/true ./...` when host `go env GOARCH` is not `amd64`. | `7` `[MEASURED: bash tools/gate.sh --leg go]` Go test packages `ok` (`capsule`, `cli`, `daemon`, `frames`, `ipc`, `record`, `view`; `cmd/mv-daemon-adapter` has `[no test files]`) across native `-race` and `GOARCH=amd64` compile/vet passes (`14` `[MEASURED: bash tools/gate.sh --leg go]` `ok` lines total, `PASS go`) |
| 9 | `ui` | Runs `npm ci --offline --no-audit --no-fund`, `npm test` (`node --test --test-timeout=120000 test/*.test.js`), `npm run check` (`vue-tsc --noEmit -p tsconfig.json`), and `npm run build` (`vite build`) in `ui/`. | `2,829` `[MEASURED: bash tools/gate.sh --leg ui]` tests across `291` `[MEASURED: bash tools/gate.sh --leg ui]` suites (`2,828` `[MEASURED: bash tools/gate.sh --leg ui]` pass, `0` fail, `1` `[MEASURED: bash tools/gate.sh --leg ui]` skipped), `vue-tsc --noEmit -p tsconfig.json` clean, `vite build` (`430` `[MEASURED: bash tools/gate.sh --leg ui]` modules transformed, `PASS ui`) |
| 10 | `ui-smoke` | Runs headless Electron smoke checks in `ui/`: `xvfb-run -a -s '-screen 0 1280x900x24' node test/smoke.mjs` and `xvfb-run -a -s '-screen 0 1280x900x24' node test/smoke-main.mjs`. | `2` `[MEASURED: bash tools/gate.sh --leg ui-smoke]` smoke markers (`METAVIEWER_SMOKE_OK` and `METAVIEWER_MAIN_SMOKE_OK`, `PASS ui-smoke`) |
| 11 | `perf` | Runs offline AC-14 budget checks (`python3 -m unittest discover -s tests -p 'test_budget_gate*.py'`, `python3 tools/budget_gate.py --self-test`, `node --test tests/perf/proc_fields.test.mjs`, and positive leak control `python3 tools/budget_gate.py --receipt tests/perf/leak-renderer.json` expecting `rc=1`). When `MV_GATE_PERF_LIVE=1` is set, also runs the live Electron RSS probe (`xvfb-run -a -s '-screen 0 1280x900x24' python3 tools/budget_gate.py --probe --electron <electron>`). | `10` `[MEASURED: bash tools/gate.sh --leg perf]` Python budget unit tests (`OK`), `6` `[MEASURED: python3 tools/budget_gate.py --self-test]` budget self-tests, `2` `[MEASURED: node --test tests/perf/proc_fields.test.mjs]` proc-field tests, and `1` `[MEASURED]` rejected leak receipt (`PASS perf`; live probe skipped unless `MV_GATE_PERF_LIVE=1`) |

### Gate self-test (`bash tools/gate.sh --self-test`)

`bash tools/gate.sh --self-test` executes the embedded `GateTests` suite in `tools/gate.sh` (backed by unit checks in `tests/test_gate_target_isolation.py` and `tests/test_t7r2c_gate_admission.py`), verifying that the gate script rejects injected faults across every leg (manifest/lock drift, law violations, broken schemas, failing unit/agent/Rust/Go/UI/perf tests, `GOARCH=amd64` compile/vet regressions, and missing smoke markers):

```sh
bash tools/gate.sh --self-test
```

Measured count: `30` `[MEASURED: bash tools/gate.sh --self-test]` self-tests in `GateTests`, `OK` (`PASS self-test`, `PASS aggregate`; note that `grep -c 'def test_' tools/gate.sh` returns `37` `[MEASURED]` because `7` `[MEASURED]` inline fixture strings inside `GateTests` also define synthetic `def test_` functions).

---

## 2. Live gates on a real capsule

Live gates run the compiled Rust core (`metaviewer-core`), Go daemon adapter (`mv-daemon-adapter`), and Electron tile against a live isolated capsule (`mv-live-1`), then verify complete teardown (owned container removed, owned processes exited, sockets, temporary state directories, and `/dev/shm` frame directories cleaned up).

In the measured live End-to-End slice (`live21`), `1` `[MEASURED]` live capsule runs at `2.71` fps `[MEASURED]` (`34` `[MEASURED]` frames over `12.528` s `[MEASURED]`, `1` `[MEASURED]` `create_surface` call; a multi-capsule live wall remains `[TARGET]`), `metaviewer-core` spends `52.11` ms p50 `[MEASURED]` (`54.02` ms p95 `[MEASURED]`) per `1280x900` (`3,456,000` B `[MEASURED]`) `rgb24` frame, and `34` of `34` `[MEASURED]` frame deliveries arrive on the renderer `MessagePort` with `isTrusted=true` and `utilityVerified=true` (`0` `[MEASURED]` renderer SHA-256 fallback hashes).

### G-W1 (`node tests/e2e/e2e1_slice/index.js --live`)

`node tests/e2e/e2e1_slice/index.js --live` (with `tests/e2e/e2e1_slice/live.py`, `electron-relay.mjs`, and `mv-replay`) exercises `11` live verification stages containing `67` `[MEASURED: grep -c 'assert' tests/e2e/e2e1_slice/live.py]` `assert` statements in `tests/e2e/e2e1_slice/live.py`:

1. Capsule frame publication, UI fan-out, and retained witness bytes (`1280x900` `rgb24`).
2. Observe → admitted → dispatched → receipt → pixel verification (`status: "verified"`, `focus_verified: true`, `receipt.verified: true`, `method: "pixel"`).
3. Different-surface binding negative control (`verified: false`).
4. Generation-binding negative control (`verified: false`).
5. Stale-generation refusal (`STALE_FRAME`) without domain state change.
6. Pending proposal cancellation on human takeover (`SURFACE_NOT_AGENT_CONTROLLED`).
7. Human refusal while under human control and clean control release.
8. Fresh-frame readmission after control release (`live-readmitted` admitted and receipted).
9. Durable journal replay equality (`mv-replay` `rc=0`) and corrupted-journal rejection (`Corrupt`, `rc=2`).
10. Real Electron tile rendering under `xvfb-run` (`tile: "PASS"`, canvas SHA-256 equal to frame SHA-256) and nested MetaViewer capsule (`metaviewer-nested` at `nested_depth: 1`, plus `nested_depth: 2` refusal).
11. Complete container, process, socket, temporary-tree, and RAM cleanup.

### G-AI (`python3 tools/gate_g_ai.py --surface mv-live-1`)

`python3 tools/gate_g_ai.py --surface mv-live-1` (backed by `tests/e2e/e2e1_slice/g_ai_stack.py` and `8` `[MEASURED: python3 -m unittest tests/test_gate_g_ai_harness.py -v]` harness unit tests in `tests/test_gate_g_ai_harness.py`) runs `8` `[MEASURED: grep -c "'A[1-8]'" tools/gate_g_ai.py]` live assertions (`A1`–`A8`) and `19` `[MEASURED]` negative controls (`14` `[MEASURED]` in `controls()` + `4` `[MEASURED]` provenance controls in `preflight()` + `1` `[MEASURED]` `A6_stale` in `tools/gate_g_ai.py`) across the AI observe-propose-admit-verify loop (`action_verdict/v0.2` → `action_receipt/v0.2`), verifying post-action pixel witnesses and runtime dependency pins in `deps.lock`.

---

## 3. End-to-end journeys (`tests/e2e/`)

### Inventory of E2E suites

`tests/e2e/` contains `35` `[MEASURED: ls -1 tests/e2e/*.test.js | wc -l]` Node journey files (`tests/e2e/*.test.js`) and `2` `[MEASURED: ls -1 tests/e2e/test_*.py | wc -l]` Python live-stack test files (`tests/e2e/test_*.py`).

`tests/e2e/run.py` syncs `capsule-ui-kit` (`node tools/sync_kit.mjs`), builds the E2E bundle (`node tests/e2e/build.mjs`), globs all `35` `[MEASURED: ls -1 tests/e2e/*.test.js | wc -l]` `sorted((ROOT / "tests/e2e").glob("*.test.js"))` files and runs them sequentially under `node --test --test-concurrency=1`, and then runs the cross-routing negative control (`MV_E2E_CROSS_ROUTE=1` on `tests/e2e/e2e1_wall.test.js`, verifying `is_cross_route_mutant_killed` on `"wall renders four tiles without cross-routing (AC-02)"` with `E2E_ROUTING`).

#### Node E2E journey files executed by `tests/e2e/run.py` (`35` files)

1. `tests/e2e/ac02_oracle_regression.test.js` — AC-02 pixel oracle regression checks on rendered canvas surfaces.
2. `tests/e2e/ac02_wall.test.js` — AC-02 wall pixel verification journey.
3. `tests/e2e/ac03_lifecycle.test.js` — AC-03 capsule create/fold/unfold/destroy lifecycle journey.
4. `tests/e2e/ac04_control.test.js` — AC-04 human/agent control exclusivity journey.
5. `tests/e2e/ac05_ai.test.js` — AC-05 AI vision intent and action journey.
6. `tests/e2e/ac06_multislot.test.js` — AC-06 multi-capsule wall isolation (`N >= 2` simultaneous capsules in harness without cross-routing).
7. `tests/e2e/ac07_ram_first.test.js` — AC-07 RAM-first ring buffer and zero-disk-write idle discipline.
8. `tests/e2e/e2e10_stale_settlement.test.js` — stale frame and settlement rejection after state transitions.
9. `tests/e2e/e2e11_golden_replay.test.js` — deterministic golden recording and replay verification.
10. `tests/e2e/e2e12_replay_purity.test.js` — replay side-effect purity (replay cannot mutate live capsules).
11. `tests/e2e/e2e13_repeat_rung.test.js` — repeated lifecycle rung stability across create/fold/unfold/destroy cycles.
12. `tests/e2e/e2e14_perf.test.js` — interactive frame and input latency budget checks.
13. `tests/e2e/e2e15_conservation_ledger.test.js` — resource and session conservation ledger invariants.
14. `tests/e2e/e2e16_electron_security.test.js` — Electron `contextIsolation`, `sandbox`, preload bridge, and CSP invariants.
15. `tests/e2e/e2e17_arrival_registration_order.test.js` — out-of-order frame arrival vs surface registration handling.
16. `tests/e2e/e2e18_budgets.test.js` — memory, queue depth, and frame-port backpressure budget enforcement.
17. `tests/e2e/e2e19_nested.test.js` — AC-17 nested MetaViewer capsule (`metaviewer-nested`) with `nested_depth: 0` outer wall, `nested_depth: 1` inner capsule, and `nested_depth >= 2` deterministic refusal.
18. `tests/e2e/e2e1_slice.test.js` — E2E-1 live slice journey.
19. `tests/e2e/e2e1_wall.test.js` — wall shell, dockview layout, capsule creation, activity strip, and `MV_E2E_CROSS_ROUTE=1` negative-control target.
20. `tests/e2e/e2e20_headless_discipline.test.js` — headless Xvfb discipline and clean process group teardown.
21. `tests/e2e/e2e21_launcher.test.js` — desktop launcher and CLI entrypoint journey.
22. `tests/e2e/e2e22_correlation_trace.test.js` — end-to-end `correlation_id` trace continuity across IPC boundaries.
23. `tests/e2e/e2e23_unknown_vs_destroyed.test.js` — distinct refusal codes for unknown vs already-destroyed capsules.
24. `tests/e2e/e2e24_routing_ownership.test.js` — surface routing ownership and stale-owner rejection.
25. `tests/e2e/e2e25_production_frames.test.js` — production `ui/dist` renderer frame painting journey over `frame_port/v1` (`frame_delivery/v0.2` -> `frame_ack/v0.2`), `frame_diag/v1` diagnostics (`MV_FRAME_DIAG=1`), multislot round trip, and rotating frame publisher.
26. `tests/e2e/e2e26_control_with_frames.test.js` — human takeover and control handoff under continuous live `frame_port/v1` delivery (`W3-CTRL-UNDER-FRAMES`).
27. `tests/e2e/e2e27_human_input.test.js` — human keyboard and pointer input forwarding in `WRITE` mode (`W2-HUMAN-INPUT`).
28. `tests/e2e/e2e2_scenario.test.js` — multi-step operator scenario journey.
29. `tests/e2e/e2e3_refusals.test.js` — deterministic contract and policy refusals in the live UI.
30. `tests/e2e/e2e4_seams.test.js` — core/daemon/UI seam integrity and correlation propagation.
31. `tests/e2e/e2e6_slice.test.js` — live vertical slice across core, daemon-adapter, and Electron renderer.
32. `tests/e2e/e2e7_live_slice_honesty.test.js` — verifies no synthetic or mock frame injection on the live slice path.
33. `tests/e2e/e2e8_ac04_control_journey.test.js` — AC-04 human/agent control handoff, takeover preempt, and `"Agent acting"` / `"Agent ready"` indicator transitions.
34. `tests/e2e/harness_fresh_build.test.js` — verifies fresh E2E harness bundle build and artifact isolation.
35. `tests/e2e/volume_bootstrap.test.js` — volume and soak bootstrap journey.

#### Python E2E suites (`2` files)

- `tests/e2e/test_live_stack.py` — live stack integration tests across the Rust core, Go daemon-adapter, and headless Electron harness.
- `tests/e2e/test_volume_bootstrap.py` — volume and soak bootstrap harness verification (`29` `[MEASURED: python3 -m unittest tests/e2e/test_live_stack.py tests/e2e/test_volume_bootstrap.py -v]` tests across both Python E2E files, `OK`).

### Running the E2E suite and individual journeys locally

#### Step 1: Build the production UI (`ui/dist/`) and E2E bundle

Sync `capsule-ui-kit` and build `ui/dist/` in `ui/` first (required by production-bundle journeys such as `tests/e2e/e2e25_production_frames.test.js` and `ui-smoke`):

```sh
node tools/sync_kit.mjs /path/to/capsule-ui-kit
(cd ui && npm ci --offline && npm run build)
```

#### Step 2: Run the full E2E orchestrator (`tests/e2e/run.py`)

`tests/e2e/run.py` automatically syncs `capsule-ui-kit`, builds the E2E fixture bundle via `tests/e2e/build.mjs`, runs all `35` `[MEASURED: ls -1 tests/e2e/*.test.js | wc -l]` `tests/e2e/*.test.js` suites under Xvfb, and then runs the `MV_E2E_CROSS_ROUTE=1` negative control on `tests/e2e/e2e1_wall.test.js`:

```sh
CAPSULE_UI_KIT_REPO=/path/to/capsule-ui-kit \
ELECTRON_OVERRIDE_DIST_PATH=/path/to/electron/dist \
  xvfb-run -a -s "-screen 0 1280x900x24" python3 tests/e2e/run.py
```

#### Step 3: Run an individual `tests/e2e/*.test.js` journey locally

For journeys that run against the E2E fixture bundle (`tests/e2e/build.mjs`), build `/tmp/mv-e2e-build` once and run `node --test` on the desired journey file under `xvfb-run`:

```sh
MV_E2E_BUILD=/tmp/mv-e2e-build node tests/e2e/build.mjs
MV_E2E_LIVE=1 MV_E2E_BUILD=/tmp/mv-e2e-build \
  ELECTRON_OVERRIDE_DIST_PATH=/path/to/electron/dist \
  xvfb-run -a -s "-screen 0 1280x900x24" \
  node --test tests/e2e/e2e19_nested.test.js
```

For `tests/e2e/e2e25_production_frames.test.js`, which boots the production renderer bundle in `ui/dist/` (`npm run build` in `ui/` first) and verifies live `frame_port/v1` canvas presentation:

```sh
(cd ui && npm run build)
MV_E2E_STRICT_RENDERER=1 \
  ELECTRON_OVERRIDE_DIST_PATH=/path/to/electron/dist \
  xvfb-run -a -s "-screen 0 1280x900x24" \
  node --test tests/e2e/e2e25_production_frames.test.js
```

Measured result for `tests/e2e/e2e25_production_frames.test.js` with `MV_E2E_STRICT_RENDERER=1`: `5` `[MEASURED: MV_E2E_STRICT_RENDERER=1 xvfb-run -a -s "-screen 0 1280x900x24" node --test tests/e2e/e2e25_production_frames.test.js]` tests, `5` `[MEASURED]` pass, `0` fail, `0` todo.

---

## 4. Hosted CI and workflow jobs (`.github/workflows/*.yml`)

The repository defines `5` `[MEASURED: ls -1 .github/workflows/*.yml | wc -l]` workflow files in `.github/workflows/*.yml` containing `19` `[MEASURED: grep -E '^  [a-z0-9-]+:$' .github/workflows/*.yml | wc -l]` job definitions (`13` `[MEASURED: grep -E '^  [a-z0-9-]+:$' .github/workflows/ci.yml | wc -l]` in `.github/workflows/ci.yml`, `1` `[MEASURED: grep -E '^  [a-z0-9-]+:$' .github/workflows/secrets.yml | wc -l]` in `.github/workflows/secrets.yml`, `1` `[MEASURED: grep -E '^  [a-z0-9-]+:$' .github/workflows/package.yml | wc -l]` in `.github/workflows/package.yml`, `1` `[MEASURED: grep -E '^  [a-z0-9-]+:$' .github/workflows/build-other.yml | wc -l]` in `.github/workflows/build-other.yml`, and `3` `[MEASURED: grep -E '^  [a-z0-9-]+:$' .github/workflows/volume.yml | wc -l]` in `.github/workflows/volume.yml`).

### How required status is decided

In `.github/workflows/ci.yml`, the aggregate gate job `ci-required` declares:

```yaml
needs: [ci-policy, laws-contracts, router, rust, go, python, js, e2e, novac, package]
```

`ci-required` runs with `if: always()` on `[x64, arm64]` and fails unless every one of those `10` `[MEASURED: grep -F 'for r in (' .github/workflows/ci.yml | wc -l]` upstream jobs succeeded and emitted valid `gate_receipt/v1` artifacts. `build-macos` and `build-windows` are excluded from `ci-required.needs`, carry `continue-on-error: true`, and emit `NOT_APPLICABLE` receipts. `.github/workflows/secrets.yml` (`Secrets / secrets`) runs as a separate workflow on every push and pull request; `.github/workflows/package.yml`, `.github/workflows/build-other.yml`, and `.github/workflows/volume.yml` are standalone packaging, reference, or scheduled/manual soak workflows.

### Complete workflow job inventory (`19` jobs across `5` files)

| Workflow file | Job key (`name`) | Runners / matrix | Required (`ci-required`) | What it runs |
| :--- | :--- | :--- | :--- | :--- |
| `.github/workflows/ci.yml` | `ci-policy` (`ci-policy (x64)`) | `ubuntu-24.04` (`x64`) | **Yes** (in `ci-required.needs`) | Runs the embedded Python policy fixture verifier (`policy-fixtures`) checking workflow structure, permissions, SHA-pinned actions, and `gate_receipt/v1` compliance; the standalone CI policy suites in `tests/ci/` comprise `7` `[MEASURED: node --test tests/ci/*.test.cjs]` Node tests and `112` `[MEASURED: python3 -m unittest discover -s tests/ci -p 'test_*.py' -v]` Python tests. |
| `.github/workflows/ci.yml` | `laws-contracts` (`laws-contracts (x64)`) | `ubuntu-24.04` (`x64`) | **Yes** (in `ci-required.needs`) | Runs `python3 tools/check_laws.py --range` (`laws-range`), `python3 tools/check_laws.py --version` (`laws-version`), `python3 tools/check_contracts.py` (`contracts`), and `python3 -m unittest discover -s tests` (`unittest-root`). |
| `.github/workflows/ci.yml` | `router` (`router (x64)`) | `ubuntu-24.04` (`x64`) | **Yes** (in `ci-required.needs`) | Runs `python3 tools/router_index.py --check` (`router-check`). |
| `.github/workflows/ci.yml` | `rust` (`rust (${{ matrix.arch }})`) | `ubuntu-24.04` (`x64`), `ubuntu-24.04-arm` (`arm64`) | **Yes** (in `ci-required.needs`) | Runs `rustup run 1.92.0 cargo fmt --all --check` (`rust-fmt`), `cargo clippy --locked --offline --all-targets -- -D warnings` (`rust-clippy`), `cargo test --locked --offline` (`rust-test`) on Rust `1.97.0`, and `bash .github/workflows/offline.sh bash tests/supervisor/run_process_gate.sh`. |
| `.github/workflows/ci.yml` | `go` (`go (${{ matrix.arch }})`) | `ubuntu-24.04` (`x64`), `ubuntu-24.04-arm` (`arm64`) | **Yes** (in `ci-required.needs`) | Runs `go vet ./...` (`go-vet`) and `go test -race ./...` (`go-test`) in `daemon-adapter/` on Go `1.26.0`. |
| `.github/workflows/ci.yml` | `python` (`python (${{ matrix.arch }})`) | `ubuntu-24.04` (`x64`), `ubuntu-24.04-arm` (`arm64`) | **Yes** (in `ci-required.needs`) | Runs `python3 -m unittest discover -s agents/tests -v` (`python-agents`, `584` `[MEASURED: python3 -m unittest discover -s agents/tests -v]` tests). |
| `.github/workflows/ci.yml` | `js` (`js (${{ matrix.arch }})`) | `ubuntu-24.04` (`x64`), `ubuntu-24.04-arm` (`arm64`) | **Yes** (in `ci-required.needs`) | Runs `node --test tests/ci/*.test.cjs`, `node tools/sync_kit.mjs` (`js-kit`), `npm ci --offline --no-audit --no-fund` (`js-install`), `node .github/workflows/install_electron.cjs` (`js-electron`), `npm test` (`js-test`), `npm run check` (`js-check`), and `npm run build` (`js-build`) in `ui/`. |
| `.github/workflows/ci.yml` | `e2e` (`e2e (${{ matrix.arch }})`) | `ubuntu-24.04` (`x64`), `ubuntu-24.04-arm` (`arm64`) | **Yes** (in `ci-required.needs`) | Runs `xvfb-run -a -s "-screen 0 1280x900x24" python3 tests/e2e/run.py` (`e2e-xvfb`) inside `.github/workflows/offline.sh`. |
| `.github/workflows/ci.yml` | `novac` (`novac (x64)`) | `ubuntu-24.04` (`x64`) | **Yes** (in `ci-required.needs`) | Emits a `NOT_APPLICABLE` `gate_receipt/v1` receipt (`G-NOVAC required from W1, interface ABSENT in W0`). |
| `.github/workflows/ci.yml` | `package` (`package (${{ matrix.arch }})`) | `ubuntu-24.04` (`x64`), `ubuntu-24.04-arm` (`arm64`) | **Yes** (in `ci-required.needs`) | Runs `python3 tests/ci/test_package_identity.py --build` (`package`) inside an offline network namespace. |
| `.github/workflows/ci.yml` | `build-macos` (`build-macos (non-blocking)`) | `macos-latest` | **No** (`continue-on-error: true`, not in `ci-required.needs`) | Emits a `NOT_APPLICABLE` `gate_receipt/v1` receipt (`packager argv ABSENT in W0, build-only leg`). |
| `.github/workflows/ci.yml` | `build-windows` (`build-windows (non-blocking)`) | `windows-latest` | **No** (`continue-on-error: true`, not in `ci-required.needs`) | Emits a `NOT_APPLICABLE` `gate_receipt/v1` receipt (`packager argv ABSENT in W0, build-only leg`). |
| `.github/workflows/ci.yml` | `ci-required` (`ci-required (${{ matrix.arch }})`) | `ubuntu-24.04` (`x64`), `ubuntu-24.04-arm` (`arm64`) | **Yes** (aggregate required gate job) | Aggregate required check (`if: always()`); runs `python3 tests/ci/test_package_identity.py --build`, `python3 tests/ci/test_package_identity.py --distribution`, `python3 tools/budget_gate.py --self-test`, and `xvfb-run -a -s "-screen 0 1280x900x24" node --test tests/e2e/e2e18_budgets.test.js tests/e2e/e2e14_perf.test.js`, then verifies all `10` `[MEASURED: grep -F 'for r in (' .github/workflows/ci.yml | wc -l]` upstream `needs` jobs succeeded. |
| `.github/workflows/secrets.yml` | `secrets` (`secrets (x64)`) | `ubuntu-24.04` (`x64`) | Separate branch-protection check (`Secrets / secrets`; not in `ci-required.needs`) | Downloads `gitleaks` `v8.18.4` (`checksum verified`), runs `python3 tests/fixtures/secrets/gate.py`, `gitleaks detect --config .gitleaks.toml`, `python3 tests/fixtures/secrets/gate.py controls`, and `python3 -m unittest tests/test_gitleaks_config.py`. |
| `.github/workflows/package.yml` | `linux-package` (`linux-package (${{ matrix.arch }})`) | `ubuntu-24.04` (`x64`), `ubuntu-24.04-arm` (`arm64`) | **No** (standalone packaging workflow on `v*` tags / `push` / `pull_request` / `workflow_dispatch`) | Runs `bash scripts/bootstrap.sh`, `node ui/tools/package.js --verify-install "$MV_PKG_OUT/MetaViewer-linux-${{ matrix.arch }}.tar"`, and `node ui/tools/package.js --smoke "$MV_PKG_OUT/MetaViewer-linux-${{ matrix.arch }}.tar"`. |
| `.github/workflows/build-other.yml` | `build-other-reference` (`build-other (${{ matrix.os }}, non-blocking)`) | `macos-latest`, `windows-latest` | **No** (`workflow_dispatch` only, `continue-on-error: true`) | Manual UI build reference check on macOS and Windows: runs `npm --prefix ui ci --offline`, `node tools/sync_kit.mjs`, `node tools/sync_kit.mjs --check`, `npm --prefix ui test`, `npm --prefix ui run check`, and `npm --prefix ui run build`. |
| `.github/workflows/volume.yml` | `volume-property` (`volume-property (${{ matrix.arch }})`) | `ubuntu-24.04` (`x64`), `ubuntu-24.04-arm` (`arm64`) | **No** (nightly `schedule` `17 2 * * *` and `workflow_dispatch`) | Checks for the `100,000`-case `[TARGET]` property entrypoint (`.github/workflows/volume.yml`) and emits a `BLOCKED` `gate_receipt/v1` receipt until registered. |
| `.github/workflows/volume.yml` | `volume-mutants` (`volume-mutants (${{ matrix.arch }})`) | `ubuntu-24.04` (`x64`), `ubuntu-24.04-arm` (`arm64`) | **No** (nightly `schedule` `17 2 * * *` and `workflow_dispatch`) | Runs `100` `[TARGET]` iterations of `python3 -m unittest tests.test_contract_mutants -v` (plus `python3 agents/tests/run_mutant_harness.py` and `python3 tests/test_t7r2c_reproducibility.py --flake-hunt` on `schedule` runs). |
| `.github/workflows/volume.yml` | `volume-e2e` (`volume-e2e (${{ matrix.arch }})`) | `ubuntu-24.04` (`x64`), `ubuntu-24.04-arm` (`arm64`) | **No** (nightly `schedule` `17 2 * * *` and `workflow_dispatch`) | Runs `20` `[TARGET]` smoke repetitions and `300` `[TARGET]` qualification repetitions of `xvfb-run -a -s "-screen 0 1280x900x24" python3 tests/e2e/run.py`, followed by the `600` s `[TARGET]` wall soak (`node tests/e2e/perf-build.mjs` and Electron on `tests/e2e/perf-main.cjs`). |

### Reproducing the hosted-like environment locally

Hosted Ubuntu runners differ from a developer workstation in four ways that I test explicitly:

1. **No global git identity (`GIT_CONFIG_GLOBAL=/dev/null`):** hosted runners have no `~/.gitconfig` `user.name` or `user.email`. Tests that create temporary git repositories or verify receipt identities must succeed with `GIT_CONFIG_GLOBAL=/dev/null`:

   ```sh
   GIT_CONFIG_GLOBAL=/dev/null \
     python3 -m unittest tests/ci/test_t7r2c_receipt_identity.py -v
   ```

   Measured result: `10` `[MEASURED: GIT_CONFIG_GLOBAL=/dev/null python3 -m unittest tests/ci/test_t7r2c_receipt_identity.py -v]` tests, `OK`.

2. **Python stdlib-only (`PyYAML` absent):** the `ci-policy`, `laws-contracts`, and `router` jobs can run on system Python 3 without `PyYAML`. All workflow parsers in `tests/ci/` must work with `yaml` blocked (`sys.modules['yaml'] = None`):

   ```sh
   GIT_CONFIG_GLOBAL=/dev/null python3 -c "import sys, unittest; sys.modules['yaml']=None; suite=unittest.defaultTestLoader.discover('tests/ci', pattern='test_t7r2c_*.py'); res=unittest.TextTestRunner(verbosity=2).run(suite); sys.exit(0 if res.wasSuccessful() else 1)"
   ```

   Measured result: `41` `[MEASURED: GIT_CONFIG_GLOBAL=/dev/null python3 -c "import sys, unittest; sys.modules['yaml']=None; suite=unittest.defaultTestLoader.discover('tests/ci', pattern='test_t7r2c_*.py'); res=unittest.TextTestRunner(verbosity=2).run(suite); sys.exit(0 if res.wasSuccessful() else 1)"]` tests across `tests/ci/test_t7r2c_*.py`, `OK`.

3. **Empty npm and Electron caches (`npm_config_cache`, `ELECTRON_CACHE`, `electron_config_cache`):** offline packaging scripts must fail closed with a deterministic prerequisite diagnostic (`PKG_CLEAN_CI_PREREQ_NPM_CACHE_MISSING` / `PKG_CLEAN_CI_PREREQ_ELECTRON_ZIP_MISSING`) instead of hanging or attempting network fetches when caches are empty:

   ```sh
   npm_config_cache=/tmp/mv-empty-npm-cache \
   ELECTRON_CACHE=/tmp/mv-empty-electron-cache \
   electron_config_cache=/tmp/mv-empty-electron-cache \
     python3 -m unittest tests/ci/test_fx2_package.py -v
   ```

   Measured result: `4` `[MEASURED: npm_config_cache=/tmp/mv-empty-npm-cache ELECTRON_CACHE=/tmp/mv-empty-electron-cache electron_config_cache=/tmp/mv-empty-electron-cache python3 -m unittest tests/ci/test_fx2_package.py -v]` tests, `OK` (emits `CLEAN_CI_REPRO_PREREQ: PKG_CLEAN_CI_PREREQ_NPM_CACHE_MISSING`).

4. **Cross-architecture `GOARCH=amd64` Go vet and compile check on `arm64` hosts:** `daemon-adapter/` includes architecture-specific syscalls and struct fields (`uint64` vs `uint32`), so `tools/gate.sh --leg go` runs both native `go test -race` and `GOARCH=amd64` compilation/vetting:

   ```sh
   GOARCH=amd64 go -C daemon-adapter vet ./...
   GOARCH=amd64 go -C daemon-adapter test -run '^$' -exec /bin/true ./...
   ```

   Measured result: `0` `[MEASURED: GOARCH=amd64 go -C daemon-adapter vet ./...]` warnings (`rc=0`) and `7` `[MEASURED: GOARCH=amd64 go -C daemon-adapter test -run '^$' -exec /bin/true ./...]` packages compiled cleanly.

---

## 5. Mutation proofs, budget gate, and negative controls

To prevent vacuous green suites, I ship automated mutation and negative-control harnesses that run in the local gate and in CI:

| Harness | Command | What it verifies and measured count |
| :--- | :--- | :--- |
| Contract schema mutants | `python3 -m unittest tests/test_contract_mutants.py -v` | Generates at least `10` `[MEASURED: grep -E '^MIN_MUTANTS_PER_SCHEMA = [0-9]+' tests/test_contract_mutants.py]` deterministic structural mutations (`MIN_MUTANTS_PER_SCHEMA = 10`) per JSON schema across `contracts/v0.1/` and `contracts/v0.2/` and asserts every mutant is rejected (`2` `[MEASURED: python3 -m unittest tests/test_contract_mutants.py -v]` tests, `OK`). |
| Agent policy mutant harness | `python3 agents/tests/run_mutant_harness.py` | Runs in `tools/gate.sh --leg agents`; injects `8` `[MEASURED: python3 agents/tests/run_mutant_harness.py]` policy and broker mutants (`M1` through `M8`) and verifies `8` of `8` `[MEASURED]` are rejected (`100%` conforming). |
| Process supervisor mutation controls | `python3 tests/supervisor/check_mutations.py` and `python3 tests/supervisor/test_mutations.py -v` | Rejects `13` `[MEASURED: python3 tests/supervisor/check_mutations.py]` permissive reaper mutations (`13` of `13` `[MEASURED]` rejected) and verifies unique mutation anchors (`1` `[MEASURED: python3 tests/supervisor/test_mutations.py -v]` unit test, `OK`). |
| Performance & resource budget gate | `python3 tools/budget_gate.py --self-test` | Runs in `tools/gate.sh --leg perf`; verifies the metric budget evaluator against synthetic passing and failing latency/memory/drop fixtures (`6` `[MEASURED: python3 tools/budget_gate.py --self-test]` self-test checks passed, `0` failed). |
| E2E cross-routing negative control | `xvfb-run -a -s "-screen 0 1280x900x24" python3 tests/e2e/run.py` | Runs `tests/e2e/e2e1_wall.test.js` with `MV_E2E_CROSS_ROUTE=1` and asserts that `LIVE_WALL_TEST_NAME` (`"wall renders four tiles without cross-routing (AC-02)"`) fails with `E2E_ROUTING`. |
| Gate fault-injection self-test | `bash tools/gate.sh --self-test` | Injects synthetic failures into each leg of `tools/gate.sh` and asserts the gate exits non-zero (`30` `[MEASURED: bash tools/gate.sh --self-test]` tests in `tools/gate.sh` `GateTests`, `OK`). |

Across a full `bash tools/gate.sh` run, `56` `[MEASURED: bash tools/gate.sh]` mutant-named test cases execute and pass inside the standard legs in addition to the standalone harnesses above.

---

## 6. External testers

Two independent external testers reviewed the repository across three adversarial rounds (documented in [`META_AI_USAGE.md`](../META_AI_USAGE.md)):

- **Round 1:** audited early contract schemas, daemon-adapter process lifecycle, and local gate coverage; surfaced missing negative controls and cross-architecture `GOARCH=amd64` build checks.
- **Round 2:** audited hosted-CI parity (`GIT_CONFIG_GLOBAL=/dev/null`, stdlib-only Python without `PyYAML`, offline packaging prerequisites), Electron security (`contextIsolation`, `sandbox`, preload surface), and multi-slot isolation (`ac06_multislot.test.js`).
- **Round 3:** audited production renderer frame delivery (`frame_port/v1`, `frame_delivery/v0.2`, and `frame_ack/v0.2`), `nested_depth` (`0` / `1` / `>= 2` refusal) on `surface_request/v0.2`, QA anchors retail gating (`MV_E2E_LIVE=1` in `ui/electron/qaAnchors.js`), capture state refresh (`MvRecordingPanel.vue`), and documentation/test-count parity (`tests/test_docs_presence.py`).

## Opt-in assembly web acceptance

Run `node --test tests/e2e/asm_web_live_hosted.test.js` for the hosted dry-run
and AX-skip mutation control. The native runner is Python beside `g_ai_stack.py`
to reuse its ownership and wire harness. It stays inert unless `MV_LIVE_WEB=1`,
`MV_E2E_LIVE=1`, and `MV_SRF_LIVE_PROFILE=mv-live-1` are explicit. Supply all
`requireLive` environment keys documented by `tests/e2e/e2e1_slice/index.js`,
plus the pinned `MV_WENDER_ROOT` and `VQA_VE_ROOT` checkouts. With the identity
unallocated, run `python3 tests/e2e/e2e1_slice/asm_web_live.py`. The conductor
runs this live command; hosted CI must leave `MV_LIVE_WEB` unset.

The runner creates one owned browser capsule, asserts network down before local
fixture navigation, and retains one perception client across tasks. Optional
`MV_WENDER_PLANNER_CMD` is a JSON argv using the existing custody-bound click
protocol; otherwise it uses the pinned G-AI state shim and named targets.
Typing is deterministic against the focused field; table reading admits no
input. Runtime blob links bind the flow fixtures without network access
`[TARGET, unit decision]`. Stdout reports task budgets, measured stage latencies,
frame/state digests, AX proofs, receipts, replay and cleanup. Evidence files
(frames, journal/archive, wire and report JSON) remain in the printed private
temporary evidence directory outside the repository. Failure retains available
evidence and returns nonzero. The native run reuses `MV_E2E_VERIFY_BIN` or builds
the existing receipt verifier offline with tools from PATH and `CARGO_TARGET_DIR`;
the `propose` latency includes admission and native input settlement. Run both
the dry-run and full gate in foreground
`systemd-run --user --scope -q -p MemoryMax=8G -p MemorySwapMax=0` scopes.

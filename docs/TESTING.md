# How MetaViewer is tested

I test MetaViewer in six layers [MEASURED]: a local offline gate that every change must pass, live gates against a real capsule, end-to-end journeys, hosted CI across two Linux architectures (`arm64` and `x64`), mutation-style negative controls, and external tester rounds. Every count below is measured on the current integration head (`2015cbfc`, release `0.1.2` [CITED: `VERSION`]) or cited from the corresponding gate record.

## 1. The local gate (`tools/gate.sh`)

`tools/gate.sh` runs 10 legs [CITED: `tools/gate.sh`] and prints one `PASS <leg>` line per leg plus a final `PASS aggregate` line. A leg whose required tools or inputs are missing reports `BLOCKED` (exit code `2` [CITED: `tools/gate.sh`]), never a silent pass.

| Leg | What it runs | Latest result |
| --- | --- | --- |
| `manifests` | Validates `VERSION` (`0.1.2` [CITED: `VERSION`]) and the manifest, lockfile and `.gitignore` closure across `Cargo.toml`, `core/Cargo.toml`, `daemon-adapter/go.mod`, `agents/pyproject.toml`, `ui/package.json`, `Cargo.lock` and `ui/package-lock.json` [CITED: `tools/gate.sh`] | `PASS` [MEASURED] |
| `laws` | `tools/check_laws.py --version` (`VERSION` and `CHANGELOG.md` parity) plus a full commit-history scan of authorship and message rules [CITED: `tools/gate.sh`, `tools/check_laws.py`] | `PASS` [MEASURED] |
| `contracts` | `tools/check_contracts.py` over `contracts/v0.1/` (10 schemas [MEASURED]) and `contracts/v0.2/` (20 schemas [MEASURED]) plus valid/invalid fixtures under `contracts/examples/` [CITED: `tools/check_contracts.py`] | `PASS` [MEASURED] |
| `unit` | `python3 -m unittest` discovery over `tests/`; empty selection, skips, expected failures and unexpected successes all fail the leg [CITED: `tools/gate.sh`] | 256 tests, `OK` (`PASS unit`) [MEASURED] |
| `agents` | `python3 -m unittest discover -s agents/tests`; a missing `agents/tests` directory fails the leg [CITED: `tools/gate.sh`] | 525 tests, `OK` (`PASS agents`) [MEASURED] |
| `js` | `node tools/sync_kit.mjs` followed by `node tools/sync_kit.mjs --check` against the checkout pinned in `ui/kit.lock.json` (`v0.2.1` [CITED: `ui/kit.lock.json`]) | `PASS` [MEASURED] |
| `rust` | Pinned `rustup run 1.92.0 cargo fmt --all --check`, `cargo clippy --offline --all-targets -- -D warnings`, and `cargo test --offline` [CITED: `tools/gate.sh`] | 205 passed, 0 failed across 39 test binaries (`PASS rust`) [MEASURED] |
| `go` | `go vet ./...` and `go test -race -count=1 ./...` in `daemon-adapter/` with `GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local` [CITED: `tools/gate.sh`] | 7 packages `ok` (`capsule`, `cli`, `daemon`, `frames`, `ipc`, `record`, `view`; `cmd/mv-daemon-adapter` has no test files) [MEASURED] |
| `ui` | `npm ci --offline`, `node --test test/*.test.js`, `vue-tsc --noEmit`, and `vite build` in `ui/` [CITED: `tools/gate.sh`] | 1,818 tests across 201 suites: 1,817 pass, 0 fail, 1 skipped (`PASS ui`) [MEASURED] |
| `ui-smoke` | `node test/smoke.mjs` (`METAVIEWER_SMOKE_OK`) and `node test/smoke-main.mjs` (`METAVIEWER_MAIN_SMOKE_OK`) under `xvfb-run` [CITED: `tools/gate.sh`] | Both markers witnessed (`PASS ui-smoke`) [MEASURED] |

The gate also includes a harness self-test (`bash tools/gate.sh --self-test`) that exercises the gate runner against disposable fixtures, including negative controls per leg: 25 tests, `OK` (`PASS self-test`, `PASS aggregate`) [MEASURED].

To run the local gate:

```sh
bash tools/gate.sh
bash tools/gate.sh --leg <manifests|laws|contracts|unit|agents|js|rust|go|ui|ui-smoke>
bash tools/gate.sh --self-test
```

The `js` leg requires a local checkout of `capsule-ui-kit` matching `ui/kit.lock.json` (`MV_KIT_CHECKOUT` or `CAPSULE_UI_KIT_REPO`); the `ui-smoke` leg requires a local Electron 44.9.2 distribution (`ELECTRON_OVERRIDE_DIST_PATH`) and `xvfb-run` [CITED: `tools/gate.sh`]. Rust builds respect `CARGO_TARGET_DIR` for per-worktree isolation.

## 2. Live gates on a real capsule

Live gates run the compiled Rust core, Go daemon adapter and Electron tile against one live OpenSuperficies capsule (`mv-live-1`, 1 capsule created per run [MEASURED]), then verify complete teardown (owned container removed, owned processes exited, sockets, temporary state directories and `/dev/shm` frame directories absent, and unrelated Docker containers untouched).

**G-W1 (live wall slice).** Two consecutive live runs passed 11 of 11 assertions each on head `f92edd6c` [MEASURED] (following earlier 8/8 consecutive passes on heads `5b3c9ea` and `a996ef43` [MEASURED]):
1. Capsule frame publication, UI fan-out and retained witness bytes (`1280x900` `rgb24` [MEASURED]).
2. Observe → admitted → dispatched → receipt → pixel verification (`status: "verified"`, `focus_verified: true`, `receipt.verified: true`, `method: "pixel"`, `detail: "frame-bound witness matched"` [MEASURED]).
3. Different-surface binding negative control (`verified: false`, `detail: "missing, invalid or unmatched witness"` [MEASURED]).
4. Generation-binding negative control (`verified: false`, `detail: "missing, invalid or unmatched witness"` [MEASURED]).
5. Stale-generation refusal (`STALE_FRAME`) without domain state change [MEASURED].
6. Pending proposal cancellation on human takeover (`SURFACE_NOT_AGENT_CONTROLLED`) [MEASURED].
7. Human refusal while under human control and clean control release [MEASURED].
8. Fresh-frame readmission after control release (`live-readmitted` admitted and receipted) [MEASURED].
9. Durable journal replay equality (`mv-replay` rc `0` [MEASURED]) and corrupted-journal rejection (`Corrupt`, rc `2` [MEASURED]).
10. Real Electron tile rendering under `xvfb-run` (`tile: "PASS"`, canvas SHA-256 equal to frame SHA-256, `authority_delivered: true`, `path_stripped: true` [MEASURED]).
11. Complete container, process, socket, temporary-tree and RAM cleanup [MEASURED].

Runner: `node tests/e2e/e2e1_slice/index.js --live` (with `tests/e2e/e2e1_slice/live.py`, `electron-relay.mjs`, and `mv-replay`).

**G-AI (live AI agent loop).** Two consecutive live runs passed 8 of 8 assertions (`A1`–`A8`) each on base `9055b82d` with `receipt_verified: true` and `focus_verified: true`, using planner `local:custody_click/v1` [MEASURED]. In each run, the agent perceived 24 elements (3 raw Wender AX entries pruned to 1 actionable button target, `"Advance gate"` [MEASURED]), drove the live capsule through core admission (`action_verdict/v0.2` → `action_receipt/v0.2`), verified the post-action frame witness on the Electron tile, and passed all 19 negative controls (`A2_digest`, `A2_path`, `A3_binding`, `A3_float`, `A4_float_digest`, `A4_float_validate`, `A5_box`, `A5_custody`, `A5_stop`, `A6_binding`, `A6_stale`, `A7_focus`, `A7_timestamp`, `A8_no_change`, `A8_window`, `vision-engine_missing`, `vision-engine_pin`, `wender-agent_missing`, `wender-agent_pin`) [MEASURED]. Runtime dependency verification matched `deps.lock`: `vision-engine` `v0.2.0` (`9bbb49f220837388e1ab90c34ae0eedee27a66eb`) and `wender-agent` `v0.3.0` (`7648b258d1d04953bacffe8627de5acd7c75d817`) [CITED: `deps.lock`; MEASURED].

Runner: `python3 tools/gate_g_ai.py --surface mv-live-1` (backed by `tests/e2e/e2e1_slice/g_ai_stack.py` and harness unit tests in `tests/test_gate_g_ai_harness.py`).

## 3. End-to-end journeys (`tests/e2e/`)

The `tests/e2e/` suite covers:
- Acceptance journeys: live wall and oracle regression (`ac02_wall.test.js`, `ac02_oracle_regression.test.js`), capsule lifecycle (`ac03_lifecycle.test.js`), human control handoff (`ac04_control.test.js`), AI observe-propose-admit-verify loop (`ac05_ai.test.js`), multislot layout and terminal attachment (`ac06_multislot.test.js`), and RAM-first capture/recording (`ac07_ram_first.test.js`).
- System slices and invariants: the E2E-1 authority slice and wall (`e2e1_slice.test.js`, `e2e1_wall.test.js`, `e2e6_slice.test.js`), golden scenarios (`e2e2_scenario.test.js`), typed refusals (`e2e3_refusals.test.js`), component seams (`e2e4_seams.test.js`), replay purity (`e2e12_replay_purity.test.js`), performance (`e2e14_perf.test.js`), Electron security (`e2e16_electron_security.test.js`), memory/resource budgets (`e2e18_budgets.test.js`), nested display-only startup (`e2e19_nested.test.js`), capsule launcher (`e2e21_launcher.test.js`), live stack checks (`test_live_stack.py`), and volume bootstrap (`test_volume_bootstrap.py`, `volume_bootstrap.test.js`).

On `linux-arm64`, the full `tests/e2e/` run after the budget-bootstrap fix (`3cf2e767`) measured 194 passed, 0 failed, and 3 todos [CITED: commit `3cf2e767`].

## 4. Hosted CI (`arm64` and `x64`)

Hosted CI (`.github/workflows/ci.yml`) runs the `rust`, `go`, `python`, `js`, `e2e`, and `package` jobs across a two-architecture Ubuntu matrix: `ubuntu-24.04` (`x64` / `x86_64`) and `ubuntu-24.04-arm` (`arm64` / `aarch64`) [CITED: `.github/workflows/ci.yml`]. Single-runner jobs check `ci-policy`, `laws-contracts`, `router`, and `novac` (non-vacuity and supply-chain checks), while `ci-required` aggregates all required statuses [CITED: `.github/workflows/ci.yml`]. Secret scanning runs in `.github/workflows/secrets.yml` (pinned `gitleaks` `v8.18.4` [CITED: `tests/fixtures/secrets/gate.py`] plus adversarial controls). Because MetaViewer is Linux-first, `build-macos` and `build-windows` only report platform applicability and are never required statuses [CITED: `.github/workflows/ci.yml`].

Current status: across hosted CI runs 1–6, matrix failures were narrowed down to two harness issues in run 6 (`ci-policy` at 44 passed, 1 failed on the per-architecture distribution fixture in `tests/ci/test_package_identity.py`, and the `arm64` `e2e` job exiting in `e2e18_budgets.test.js` when booting a minimal main without capture handlers [MEASURED]). Both were fixed and verified locally in commit `3cf2e767`, and the next hosted CI run is pending [TARGET]. Every integration on `bridge/integration` still passes the full local 10-leg gate before landing: 142 integrations recorded in total, 38 of them on day 2 since 07:10 CET [MEASURED].

## 5. Mutation proofs and negative controls

I do not trust a check that cannot fail. Every validator and gate leg is paired with negative controls:
- **Contract schema mutants (`tests/test_contract_mutants.py`).** For every schema in every supported contract version (`v0.1` and `v0.2`), the valid example is mutated five ways—required key dropped, unknown key (`zz_mutant_unexpected`) added, wrong value type, out-of-range value, and flipped `const`/`enum`—with at least 10 mutants per schema (`MIN_MUTANTS_PER_SCHEMA = 10` [CITED: `tests/test_contract_mutants.py:17`]). The validator must reject every mutant while passing the unmutated positive example.
- **Cross-suite mutant checks.** The full gate log executes 29 mutant-named test lines (26 distinct mutant test cases across `unit`, `rust`, and `ui` [MEASURED]), covering directional swap mutants (`SW-0244`), per-variant witness oracles, dependency commit and `ui/kit.lock.json` parity mutants, commit-message law mutants, router bootstrap mutants, journal tail-deletion/duplicate/artifact corruption mutants, UI state/phase guard mutants, corner-routing and release-audit mutants, and `hide`/`show`/`move`/`tab`/`float` layout bound mutants.
- **Gate harness negative controls (`bash tools/gate.sh --self-test`).** The 25 self-tests verify that broken contracts, missing or failing `agents`, `go`, `rust`, `ui`, `ui-smoke`, and `js` legs, unpinned dependencies, and false passes all fail closed [MEASURED].

## 6. External testers

Alongside local and hosted suites, I run structured external testing rounds against the public `bridge/integration` branch:
- **Round 1 (completed).** 8 subsystem topics (`T1` Rust authority core, `T2` Go daemon adapter, `T3` Python agents, `T4` Electron security, `T5` Vue wall/frames/terminal, `T6` Contracts v0.2, `T7` CI and supply chain, `T8` End-to-end scenario), each reviewed independently by two external testers (16 reports total), consolidated into 126 findings [MEASURED] that were verified against the tree and turned into regression tests and fix units.
- **Round 2 (prepared on head `1a119bc2`).** 16 context-engineered prompts (8 test-writing prompts and 8 adversarial review prompts, 12–14 verbatim paper and specification excerpts per prompt [MEASURED]) ordered by subsystem churn (`T5` frame/UI first, then `T1` core, `T6` contracts, `T8` e2e, `T3` agents, `T2` adapter, `T7` CI/supply, `T4` UI security).
- **Round 3 (prepared in `META_AI_USAGE.md` room `mvr3`).** 8 lanes generating invariant/oracle proofs and test suites targeting the day-2 features (live receipts, perception loop, layout intents, and capture/export) [CITED: `META_AI_USAGE.md`]. Every external finding is reproduced or verified against the current head before becoming a fix unit.

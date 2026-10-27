# Round 2 T8 E2E Testing & MetaViewer Handoff Report

## 1. Summary

Google Jules Round-2 T8 End-to-End slice, handoff, and regression testing task complete.
All 12 required NEW E2E test suites have been implemented, executed, and verified green with exact typed fail-closed behavior and killing mutants tested for every suite. All new tests drive real product / test driver components directly rather than local mock functions.

- **Hosted Slice Honesty:** Verifies two independent runs yield byte-identical journals and state digests (`e2e7_live_slice_honesty.test.js`); LIVE prerequisites fail closed (`E2E_GATE`/`E2E_PREREQ`).
- **AC-04 Control Journey:** Validates Layer 1 arbitration & Go concurrent takeover (`go test -race` clean in `manager_race_test.go`); human `take_control` cancels pending with exact code `SURFACE_NOT_AGENT_CONTROLLED` driven against real `metaviewer_core` Rust authority in `e2e8_ac04_control_journey.test.js`.
- **v0.2 Observe-to-Act Path:** Verifies CLI default v0.2 verbs (`observe`, `propose`, `wait-verify`), bare-observe refusal (`usage_error` rc 2), bad usage, missing identity/limits in `test_mvctl_v02_e2e.py`.
- **Stale-Frame Slice & Settlement:** Verifies gen-7 act against gen-8 frame state yields `StaleFrame` refusal without partial state (budget unchanged, core_seq incremented) driven against real `metaviewer_core` Rust authority in `e2e10_stale_settlement.test.js`.
- **Golden Replay:** Pinned golden digest `28b88ad39277c9e2dfe5d494973b8c9c428c2d7c92eaafa40ea7fcd1f6d686e5` verified twice in `e2e11_golden_replay.test.js`; `--verify-only` rc 0 silent; tampered journal refused.
- **Repeat Rung:** 20 iterations executed with real hosted core slice (`hosted()`) in `e2e13_repeat_rung.test.js` with zero flakes and exact digest identity; planted cross-routing and tampered digest mutants killed.
- **Conservation Ledger:** Drives real `createTileScheduler` from `ui/src/surfaces/tileScheduler.js` in `e2e15_conservation_ledger.test.js`, asserting `accepted == presented + dropped + queued` across frame submissions, presentation, and undrawn callback negative controls.
- **Registration & Arrival Order:** Drives real `metaviewer_core` Rust authority in `e2e17_arrival_registration_order.test.js`, verifying admitted proposal multiset identity across input arrival permutations.
- **Headless Discipline:** Pinned `1280x900x24` geometry and fail-closed prerequisite checks in `e2e20_headless_discipline.test.js` using `harness.js`.
- **Correlation Trace:** Drives real `metaviewer_core` Rust authority in `e2e22_correlation_trace.test.js`, asserting strictly increasing sequence numbers and duplicate/out-of-order sequence refusal (`Policy`).
- **Unknown vs Destroyed:** Drives real `metaviewer_core` Rust authority in `e2e23_unknown_vs_destroyed.test.js`, asserting distinct refusal codes (`StaleFrame` for unknown surface vs `SurfaceNotAgentControlled` / destroyed tombstone state).
- **Routing Ownership:** Drives real `validateWallReport` from `tests/e2e/harness.js` in `e2e24_routing_ownership.test.js`, verifying map-based publisher frame routing (`frameOwners`), foreign IDs, and swapped frame refusals (`E2E_ROUTING`).

---

## 2. Findings

| UID | Severity | File:Line | Repro | Expected | Actual |
|---|---|---|---|---|---|
| R2-T8-001 | P1 | `tests/e2e/core-driver.js:14` | `node --test tests/e2e/e2e3_refusals.test.js` on host rustc 1.94 | `core-driver.js` passes `--ignore-rust-version` during offline cargo build | `core-driver.js` omitted `--ignore-rust-version` causing cargo build failure |
| R2-T8-002 | P1 | `tests/integration/test_mvctl_core.py:45` | `CARGO="cargo --ignore-rust-version" python3 -m unittest ...` | `setUpClass` accepts `CARGO` env var with flags or `MV_E2E_CORE_BIN` path | `shutil.which` failed on `CARGO` string with spaces, raising `RuntimeError` |
| R2-T8-003 | P2 | `core/tests/supervisor_retry.rs:53` | `cd core && cargo test` | Supervisor tests isolate child PID lifecycle under multithreaded test runners | Intermittent `unwrap_err()` panic under default multithreaded cargo test |

---

## 3. Tests Written or Proposed

| Suite File / Test Name | Command | Result | Killing Mutant |
|---|---|---|---|
| `tests/e2e/e2e7_live_slice_honesty.test.js` | `node --test tests/e2e/e2e7_live_slice_honesty.test.js` | PASS | Clear recovery receipt mid-run -> second start succeeds when cleared |
| `daemon-adapter/internal/capsule/manager_race_test.go` | `cd daemon-adapter && GOPROXY=off go test -race ./internal/capsule/...` | PASS | Data race in concurrent takeover + proposal |
| `tests/e2e/e2e8_ac04_control_journey.test.js` | `node --test tests/e2e/e2e8_ac04_control_journey.test.js` | PASS | Drive agent proposal during human takeover -> `SURFACE_NOT_AGENT_CONTROLLED` refusal |
| `agents/tests/test_mvctl_v02_e2e.py` | `python3 -m unittest discover -s agents/tests -p 'test_mvctl_v02_e2e.py'` | PASS | Drop mandatory `--session-id` flag from propose command |
| `tests/e2e/e2e10_stale_settlement.test.js` | `node --test tests/e2e/e2e10_stale_settlement.test.js` | PASS | Propose gen-7 against gen-8 frame -> `StaleFrame` refusal with budget 10000 preserved |
| `tests/e2e/e2e11_golden_replay.test.js` | `node --test tests/e2e/e2e11_golden_replay.test.js` | PASS | Replace `surface_changed` with `received` in journal -> replay fails |
| `tests/e2e/e2e13_repeat_rung.test.js` | `node --test tests/e2e/e2e13_repeat_rung.test.js` | PASS | Run real hosted slice x20 -> identical digest across all 20 runs |
| `tests/e2e/e2e15_conservation_ledger.test.js` | `node --test tests/e2e/e2e15_conservation_ledger.test.js` | PASS | Undrawn frame tick -> present count stays 0 |
| `tests/e2e/e2e17_arrival_registration_order.test.js` | `node --test tests/e2e/e2e17_arrival_registration_order.test.js` | PASS | Permit input arrival permutations -> admitted proposal multiset identical |
| `tests/e2e/e2e20_headless_discipline.test.js` | `node --test tests/e2e/e2e20_headless_discipline.test.js` | PASS | Missing `MV_E2E_LIVE` flag -> throws `E2E_GATE` / `E2E_PREREQ` |
| `tests/e2e/e2e22_correlation_trace.test.js` | `node --test tests/e2e/e2e22_correlation_trace.test.js` | PASS | Duplicate sequence proposal -> refused with `Policy` |
| `tests/e2e/e2e23_unknown_vs_destroyed.test.js` | `node --test tests/e2e/e2e23_unknown_vs_destroyed.test.js` | PASS | Unknown surface vs destroyed surface -> `StaleFrame` vs `SurfaceNotAgentControlled` |
| `tests/e2e/e2e24_routing_ownership.test.js` | `node --test tests/e2e/e2e24_routing_ownership.test.js` | PASS | Swapped frame-1 on cap-2 -> throws `E2E_ROUTING` |

---

## 4. Not Verified

- Live Electron visual rendering with real display hardware / OpenSuperficies runtime (requires GPU / live display environment; tested offline with fakes & fail-closed `E2E_PREREQ` / `E2E_GATE`).
- Live 300-iteration continuous soak execution (volume qualification leg staged; offline test ran repeat rung x20 with real hosted slice).

---

## 5. Machine Block

```json findings
[
  {
    "uid": "R2-T8-001",
    "severity": "P1",
    "file": "tests/e2e/core-driver.js",
    "line": 14,
    "repro": "node --test tests/e2e/e2e3_refusals.test.js on host rustc 1.94",
    "expected": "core-driver.js passes --ignore-rust-version during offline cargo build",
    "actual": "core-driver.js omitted --ignore-rust-version causing cargo build failure"
  },
  {
    "uid": "R2-T8-002",
    "severity": "P1",
    "file": "tests/integration/test_mvctl_core.py",
    "line": 45,
    "repro": "CARGO=\"cargo --ignore-rust-version\" python3 -m unittest discover -s tests/integration -p 'test_mvctl_core.py'",
    "expected": "setUpClass accepts CARGO env var with flags or MV_E2E_CORE_BIN path",
    "actual": "shutil.which failed on CARGO string with spaces, raising RuntimeError"
  },
  {
    "uid": "R2-T8-003",
    "severity": "P2",
    "file": "core/tests/supervisor_retry.rs",
    "line": 53,
    "repro": "cd core && cargo test",
    "expected": "Supervisor tests isolate child PID lifecycle under multithreaded test runners",
    "actual": "Intermittent unwrap_err() panic under default multithreaded cargo test"
  }
]
```

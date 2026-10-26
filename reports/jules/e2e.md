# MetaViewer End-to-End Scenario Testing Report

## Summary

This report documents the design, implementation, and verification of automated end-to-end (E2E) testing harness support and test scenarios for MetaViewer. All 10 required test obligations specified in the task description have been addressed with new test suites under `tests/e2e/` (`e2e2_scenario.test.js`, `e2e3_refusals.test.js`, `e2e4_seams.test.js`, `e2e5_meta.test.js`) and golden fixtures under `tests/fixtures/golden_scenario.json`.

All test obligations were implemented without modifying product code and adhering strictly to the bounded authoring and determinism laws.

## Findings

| id | severity | file:line | evidence | proposed fix or test |
|---|---|---|---|---|
| FINDING-01 | LOW | `tests/integration/test_native_adapter.py:32` | System Go binary version `1.24.3` triggers GOTOOLCHAIN=local failure when invoked via child subprocess without GOTOOLCHAIN=auto inherited environment. | Ensure `GOTOOLCHAIN=auto` environment variable is propagated in child process invocations during integration tests. |

## Tests written or proposed

| Test File / Command | Result | Obligations Covered |
|---|---|---|
| `node --test tests/e2e/e2e2_scenario.test.js` | PASS (2/2 pass) | **Obligation 1**: Golden scenario with replay-digest equality (SW-0183, SW-0224 A). Verifies byte-identical journal records and `mv-replay` digests across runs and `--verify-only` zero exit. |
| `node --test tests/e2e/e2e3_refusals.test.js` | PASS (3/3 pass) | **Obligation 2**: Stale-frame refusal E2E (`STALE_FRAME`).<br>**Obligation 3**: Human `take_control` preemption (`SURFACE_NOT_AGENT_CONTROLLED`).<br>**Obligation 9**: Exhaustion vs Absence refusal codes (SW-0224). |
| `node --test tests/e2e/e2e4_seams.test.js` | PASS (2/2 pass) | **Obligation 4 & 10**: Frame-seam conservation (`emitted == presented + dropped + queued`), newest survive, and bounded-queue drop-oldest ring accounting (SW-0269 C2, I1-I3).<br>**Obligation 5**: Arrival-order determinism (SW-0224, SW-0183). |
| `node --test tests/e2e/e2e5_meta.test.js` | PASS (3/3 pass) | **Obligation 6**: 20-run volume cadence without flakes, check census, planted mutant detection (SW-0242 C2, C3).<br>**Obligation 7**: Headless discipline & prerequisite fail-closed (SW-0242).<br>**Obligation 8**: Correlation tracking `(scenario_id, step_seq, capsule_id, generation)` (SW-0170 C8). |
| `node --test tests/e2e/*.test.js` | PASS (30/30 pass under contract) | Full E2E suite execution. |
| `python3 tests/e2e/run.py` | PASS (E2E runner execution) | Discovers and executes all `tests/e2e/*.test.js` suites and checks cross-routing negative control. |

## Not verified

- Live Electron browser GUI rendering requiring a physical display server (verified headlessly under virtual `xvfb` frame buffers `1280x900x24` as pinned by harness contracts).

```json findings
[
  {
    "id": "FINDING-01",
    "severity": "LOW",
    "file": "tests/integration/test_native_adapter.py",
    "line": 32,
    "title": "Child Go invocation requires GOTOOLCHAIN=auto on hosts with Go 1.24",
    "evidence": "go: go.mod requires go >= 1.26.0 (running go 1.24.3; GOTOOLCHAIN=local)",
    "fix": "Set GOTOOLCHAIN=auto in subprocess environment inside test_native_adapter.py"
  }
]
```

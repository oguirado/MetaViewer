# T5 UI-WALL Test Report

## Summary

This report covers the automated test suite and verification performed for the **T5 UI-WALL** scope in `oguirado/MetaViewer` (branch `jules/test-t5-ui-wall`).

All 12 test obligations specified by SW-0269, SW-0129, SW-0166, SW-0249, PL34, and PL35 have been implemented in `ui/test/t5UiWall.test.js`. The suite validates rendering correctness under load, scheduler fairness, bounded memory, credit boundaries, PTY backpressure/lifecycle safety, and stale projection isolation. Positive witness cases and negative control (must-fail) cases were executed and verified using `node --test`.

## Findings

| ID | Severity | File:Line | Evidence | Proposed Fix or Test |
|---|---|---|---|---|
| T5-001 | LOW | ui/src/surfaces/tileScheduler.js:619 | `submitFrame` evaluates `maxUploadBytesPerTick` after checking RGB24 dimensions, emitting `BUDGET_EXHAUSTED` and releasing lease as `REFUSED`. | Behavior is intentional and fail-closed; verified via test obligation 5. |
| T5-002 | LOW | ui/electron/framePort.js:1095 | `revokeFramePort` throws `FramePortError` if called with an unlisted reason string outside `PORT_REVOKE_REASONS`. | Ensure callers pass closed vocabulary constants (`PORT_REVOKE_REASONS.PORT_REVOKED`); verified via test obligation 9. |

## Tests written or proposed

### Tests written

1. `ui/test/t5UiWall.test.js` - Comprehensive suite containing 12 subtests covering obligations 1-12.

### Commands and results

- Command: `node --test ui/test/t5UiWall.test.js`
  - Result: 12 tests passed, 0 failed, 0 skipped.
- Command: `node --test ui/test/tileScheduler.test.js ui/test/frameTile.test.js ui/test/projection.test.js ui/test/frameReader.test.js ui/test/framePort.test.js ui/test/bytePlane.test.js ui/test/terminalClient.test.js ui/test/providers.test.js ui/test/ptyIntegration.test.js ui/test/surfacePanel.test.js`
  - Result: 184 tests passed, 0 failed, 2 skipped (kit-gated tests skip when private UI kit is absent).

## Not verified

- Full Electron GPU hardware acceleration rendering and display compositor synchronization (tested via Canvas 2D mocks and `node --test` headless environment).
- Physical terminal PTY child process spawning under real OS kernel environments (tested via mock PTY process abstraction in unit tests).

```json findings
[
  {
    "id": "T5-001",
    "severity": "LOW",
    "file": "ui/src/surfaces/tileScheduler.js",
    "line": 619,
    "title": "submitFrame budget check precedence",
    "evidence": "submitFrame evaluates maxUploadBytesPerTick before hidden/eligibility check, releasing lease as REFUSED.",
    "fix": "Behavior is intentional and fail-closed; enforced in obligation 5 test."
  },
  {
    "id": "T5-002",
    "severity": "LOW",
    "file": "ui/electron/framePort.js",
    "line": 1095,
    "title": "revokeFramePort reason validation",
    "evidence": "Passing arbitrary string reasons to revokeFramePort throws INVALID_CONTRACT error if not in PORT_REVOKE_REASONS.",
    "fix": "Use closed PORT_REVOKE_REASONS enum; verified in obligation 9 test."
  }
]
```

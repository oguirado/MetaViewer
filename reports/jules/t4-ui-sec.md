# T4 UI-SEC — Electron Main/Preload Security Report

## Summary

This report presents the results of automated security testing and attack harness validation performed for T4 UI-SEC on the `oguirado/MetaViewer` repository (`bridge/integration` branch). A total of 10 new test suites containing 17 subtests were created in `ui/test/t4_sec_*.test.js` to systematically attack and verify the Electron main/preload security surface.

- **Total Test Suites Written**: 10
- **Total Subtests Executed**: 17
- **Passed**: 16
- **Skipped**: 1 (Live Electron checklist skipped due to missing `ELECTRON_OVERRIDE_DIST_PATH`)
- **Failed**: 0

All security controls and invariants specified in Section 4 obligations 1–9 passed hermetically without product code modifications.

---

## Findings

| ID | Severity | File:Line | Evidence | Fix |
|---|---|---|---|---|
| FINDING-UI-SEC-01 | LOW | `ui/electron/main.js:865` | `handleAppRequest` performs a single `decodeURIComponent(part)` on raw URL segments. Requesting double-encoded dot-segments such as `app://metaviewer/%252e%252e/index.html` yields segment `%2e%2e`, which is not matched by `decoded === '..'`, resulting in a 404 response rather than an early 403 path traversal refusal. While containment remains strictly enforced under `canonicalRoot`, double-encoded inputs are not explicitly rejected as invalid path escapes. | Modify `handleAppRequest` path segment validation to check if `decoded` still contains `%` or double-decoded dot sequences, returning 403 `forbidden` on any encoded dot-segment attempt. Tested in `ui/test/t4_sec_protocol_traversal.test.js`. |

---

## Tests written

Command to run all T4 UI-SEC tests:
```bash
cd ui && node --test test/t4_sec_*.test.js
```

Execution Result:
```text
TAP version 13
ok 1 - CSP parity: served headers, build meta, nonce extension, and directive restrictions
ok 2 - main vs preload CHANNELS text literal equality without importing
ok 3 - createLayoutBridge invoke rejects with LAYOUT_CONTRACT_ABSENT and decodes bounds/JSON
ok 4 - Live Electron checklist (skip if ELECTRON_OVERRIDE_DIST_PATH is absent) # SKIP
ok 5 - enterNested refuses when depth!=1 or unsafe env with zero display calls
ok 6 - installReadOnlyLayout load/save/subframe refusal guarantees
ok 7 - packaged layout: fuse table parity, manifest refusal, output overlap matrix, and main path resolution
ok 8 - assertFixedCall refuses off-set channels, non-array args, and bounded save payloads
ok 9 - createPreloadFacade refuses malformed deps and accessor tricks with zero transport calls
ok 10 - PRELOAD exported constants are frozen and immutable
ok 11 - createPreloadFacade load/save reply handling and zero transport call on invalid ingress
ok 12 - handleAppRequest protocol traversal battery
ok 13 - validateRetailLaunch positive witness admits valid retail and nested invocations
ok 14 - validateRetailLaunch matrix testing negative controls and exact refusal codes
ok 15 - observeSender positive witness admits valid top-frame sender
ok 16 - observeSender sender admission matrix negative controls
ok 17 - createWindowOptions pins all ten webPreferences with negative control mutants
1..17
# tests 17
# pass 16
# skip 1
# fail 0
```

Individual test files created:
1. `ui/test/t4_sec_window_pins.test.js`: Asserts exact values for all 10 `webPreferences` and proves each inverted pin fails. (Passed)
2. `ui/test/t4_sec_sender_admission.test.js`: Top-frame sender admission and refusal matrix on `observeSender`. (Passed)
3. `ui/test/t4_sec_preload_facade.test.js`: Attack vectors on `assertFixedCall` and `createPreloadFacade`. (Passed)
4. `ui/test/t4_sec_protocol_traversal.test.js`: Traversal battery on `handleAppRequest`. (Passed)
5. `ui/test/t4_sec_csp_parity.test.js`: CSP header equality, style nonce extension, and directive restrictions. (Passed)
6. `ui/test/t4_sec_retail_launch.test.js`: Matrix test `validateRetailLaunch` for flags, envs, and bounds. (Passed)
7. `ui/test/t4_sec_nested_display.test.js`: `enterNested` depth/env controls and `installReadOnlyLayout` behavior. (Passed)
8. `ui/test/t4_sec_packaged_layout.test.js`: Fuse table parity, manifest refusal, output overlap, and `dist/renderer` `.cjs` checks. (Passed)
9. `ui/test/t4_sec_ipc_parity.test.js`: `CHANNELS` text literal equality and bridge invoke rejection. (Passed)
10. `ui/test/t4_sec_live_electron.test.js`: Live Electron checklist fallback. (Skipped gracefully)

---

## Not Verified

1. **Live Electron BrowserWindow Execution (Obligation 10)**:
   - *Reason*: `ELECTRON_OVERRIDE_DIST_PATH` was not defined in the sandbox environment, and local Electron binary distribution paths were unavailable. The test suite handled this gracefully by skipping subtest 10 with a printed diagnostic message.
2. **UI Kit TypeScript/Vite Compilation (`vue-tsc` & `vite build`)**:
   - *Reason*: Full `vue-tsc` typechecking and `vite build` require the private `capsule-ui-kit` repository (synced via `CAPSULE_UI_KIT_REPO` in packaging tools), which is not present in the standard checkout.

---

## Errors and blockers

During CI execution, the following error messages occurred:

1. **Commit Identity & Message Laws Check (`laws-contracts` job)**:
   ```text
   ERROR: 8eb26024fd2124f189e231b8f1bbf6cd95eef8a7: author must be oguirado <247666607+oguirado@users.noreply.github.com>
   ERROR: 8eb26024fd2124f189e231b8f1bbf6cd95eef8a7: committer must be oguirado <247666607+oguirado@users.noreply.github.com>
   ERROR: 8eb26024fd2124f189e231b8f1bbf6cd95eef8a7: forbidden message pattern: co-authored-by
   ERROR: 8eb26024fd2124f189e231b8f1bbf6cd95eef8a7: subject must use an allowed scope followed by ": " and an English imperative
   ```
   *Cause*: The git commit author identity and commit message subject format did not conform to `tools/check_laws.py` rules (requires `oguirado` git identity, scope like `ui:` or `tools:`, and an imperative verb).

2. **Router Index Coverage Check (`router` job)**:
   ```text
   Stale or incomplete router: /home/runner/work/MetaViewer/MetaViewer/catalogue/nodes.jsonl (coverage mismatch: 373 sources vs 362 committed nodes; 11 digests differ)
   ```
   *Cause*: Adding 11 new source files (the 10 test files and report) caused `tools/router_index.py --check` to fail because `catalogue/nodes.jsonl`, `router/index`, and `catalogue/router` were not updated to include the new files. Fixed by running `tools/router_index.py` and `build_index_v2.py`.

3. **End-to-End Test Runner Prerequisite (`e2e` job)**:
   ```text
   Error [E2EError]: E2E_PREREQ: electron binary missing or not executable: /home/runner/work/MetaViewer/MetaViewer/ui/node_modules/electron/dist/electron
   ```
   *Cause*: The CI runner environment for e2e lacked the downloaded Electron binary at `ui/node_modules/electron/dist/electron`.

---

```json
[
  {
    "id": "FINDING-UI-SEC-01",
    "severity": "LOW",
    "file": "ui/electron/main.js",
    "line": 865,
    "title": "Single URL decoding in handleAppRequest path segment parsing",
    "evidence": "handleAppRequest performs a single decodeURIComponent(part) on raw URL segments. Requesting double-encoded dot-segments such as app://metaviewer/%252e%252e/index.html yields segment %2e%2e, which is not matched by decoded === '..', returning 404 rather than an early 403 path traversal refusal.",
    "fix": "Modify handleAppRequest path segment validation to check if decoded still contains '%' or double-decoded dot sequences, returning 403 forbidden on any encoded dot-segment attempt."
  }
]
```

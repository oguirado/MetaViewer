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

| ID | Severity | File:Line | Evidence | Proposed Fix or Test |
|---|---|---|---|---|
| FINDING-UI-SEC-01 | LOW | `ui/electron/main.js:865` | `handleAppRequest` performs a single `decodeURIComponent(part)` on raw URL segments. Requesting double-encoded dot-segments such as `app://metaviewer/%252e%252e/index.html` yields segment `%2e%2e`, which is not matched by `decoded === '..'`, resulting in a 404 response rather than an early 403 path traversal refusal. While containment remains strictly enforced under `canonicalRoot`, double-encoded inputs are not explicitly rejected as invalid path escapes. | Modify `handleAppRequest` path validation to check if `decoded` still contains `%` or double-decoded dot sequences, returning 403 `forbidden` on any encoded dot-segment attempt. Tested in `ui/test/t4_sec_protocol_traversal.test.js`. |

---

## Tests Written or Proposed

The following test suites were written under `ui/test/`:

1. **`ui/test/t4_sec_window_pins.test.js`** (Obligation 1):
   - Asserts exact values for all 10 `webPreferences` (`sandbox`, `contextIsolation`, `nodeIntegration`, `nodeIntegrationInWorker`, `nodeIntegrationInSubFrames`, `webSecurity`, `webviewTag`, `allowRunningInsecureContent`, `experimentalFeatures`, `preload`).
   - Mutation control: proves each inverted pin value fails verification.
2. **`ui/test/t4_sec_sender_admission.test.js`** (Obligation 2):
   - Positive witness for top-frame sender admission on `observeSender`.
   - Matrix of negative controls: subframe identity mismatch, `detached: true`, destroyed sender, null/non-object `senderFrame`, foreign origin mismatch, non-privileged URL, invalid sender IDs (0, negative, non-integer, missing).
3. **`ui/test/t4_sec_preload_facade.test.js`** (Obligation 3):
   - Positive witness for `assertFixedCall` load and save.
   - Attack vectors on `assertFixedCall` and `createPreloadFacade`: off-set channels, non-array args, multibyte payload UTF-8 byte-cap vs char-length, lone surrogates, prototype-polluted and accessor deps, symbol keys, frozen export mutation, and malformed load/save replies (`undefined`, `0`, `{}`, over-cap string, `1`, `'true'`, truthy objects). Asserts zero transport calls on ingress refusals.
4. **`ui/test/t4_sec_protocol_traversal.test.js`** (Obligation 4):
   - Attack battery on `handleAppRequest`: `%2e%2e`, `%252e%252e`, backslash `\`, NUL byte `\0`, `?`/`#` smuggling, uppercase host, credentials/port in URL, wrong scheme, dir without index.html, symlink file, symlink dir escape, FIFO pipe, over-8MiB file, HTML without `<head>`, style nonce uniqueness across responses, and 2049-char URL. Asserts exact 403/404 status and exact base CSP header.
5. **`ui/test/t4_sec_csp_parity.test.js`** (Obligation 5):
   - Validates `CONTENT_SECURITY_POLICY` header equality for non-HTML, refusals, and 404s.
   - Style nonce extension verification.
   - Meta tag CSP equality in `index.html`.
   - Strict rejection of insecure policy directives (`unsafe-inline`, `unsafe-eval`, `http:`, `https:`, `*`).
6. **`ui/test/t4_sec_retail_launch.test.js`** (Obligation 6):
   - Matrix testing of `validateRetailLaunch`: bare and `=value` forbidden flags, prefix lookalikes (`--inspectX`), `--nested-depth` variants, unknown switches, runtime pass-through switches (`--user-data-dir`, `--ozone-platform`), forbidden env names, non-string env values, max argv items (257), max char length (4097), and NUL items. Asserts exact refusal codes.
7. **`ui/test/t4_sec_nested_display.test.js`** (Obligation 7):
   - Asserts `enterNested` with depth!=1 or unsafe env records zero display calls.
   - Asserts `installReadOnlyLayout` load arity refusal, save refusal, and subframe identity refusal.
8. **`ui/test/t4_sec_packaged_layout.test.js`** (Obligation 8):
   - Verifies `FUSE_TABLE` parity (9 rows, 6 required) and `buildFuseConfig` index-for-index equality.
   - `resolveMainPaths` refusal of missing/legacy bundle roots.
   - `validateOutput` overlap matrix checks.
   - `writeManifest` refusal on existing files (`wx`), symlinks, and non-files.
   - `handleAppRequest` refusal of `/preload/preload.cjs` and traversal spellings.
   - Verification of `dist/renderer` containing no `.cjs` files.
9. **`ui/test/t4_sec_ipc_parity.test.js`** (Obligation 9):
   - Source text literal equality check between `main.js` and `preload.js` `CHANNELS` definitions without importing.
   - `createLayoutBridge` invoke rejection with `LAYOUT_CONTRACT_ABSENT`.
   - Save decoder byte-cap and JSON parsing boundaries.
10. **`ui/test/t4_sec_live_electron.test.js`** (Obligation 10):
    - Live Electron checklist (skips gracefully with printed reason when `ELECTRON_OVERRIDE_DIST_PATH` is absent).

### Commands and Execution Results

```bash
cd ui && node --test test/t4_sec_*.test.js
```

Output summary:
```text
# tests 17
# pass 16
# fail 0
# skipped 1
# duration_ms 931.84
```

---

## Not Verified

1. **Live Electron BrowserWindow Execution (Obligation 10)**:
   - *Reason*: `ELECTRON_OVERRIDE_DIST_PATH` was not defined in the sandbox environment, and local Electron binary distribution paths were unavailable. The test suite handled this gracefully by skipping subtest 10 with a printed diagnostic message.
2. **UI Kit TypeScript/Vite Compilation (`vue-tsc` & `vite build`)**:
   - *Reason*: Full `vue-tsc` typechecking and `vite build` require the private `capsule-ui-kit` repository (synced via `CAPSULE_UI_KIT_REPO` in packaging tools), which is not present in the standard checkout.

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

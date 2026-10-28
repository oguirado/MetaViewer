# Round 3 — T4 Electron Security Day-2 Test Results and Findings Report

## 1. Summary

This report presents the results of authoring and running new security, regression, surface, and refresh delta automated tests for the day-2 wave in MetaViewer (`ui/`).

All tests were written in isolated test files (`ui/test/r3t4-*.test.js`) and executed using Node's native runner (`node --test`). Zero product source files were modified.

| Category | Suite File | Total Tests | Pass | Fail | Skip |
|---|---|---|---|---|---|
| Day-2 Regressions (Part A) | `test/r3t4-regressions.test.js` | 10 | 8 | 0 | 2* |
| New Security Surface (Part B) | `test/r3t4-new-surface.test.js` | 9 | 7 | 0 | 2* |
| Still-Open Confirmations (Part C) | `test/r3t4-still-open.test.js` | 7 | 7 | 0 | 0 |
| Refresh Delta Round 3 (Part D) | `test/r3t4-r3-refresh.test.js` | 6 | 5 | 0 | 1* |
| Refresh Delta Round 4 (Part D) | `test/r3t4-r4-refresh.test.js` | 3 | 3 | 0 | 0 |
| **Total** | | **35** | **30** | **0** | **5** |

*\*Note: Skips correspond to hermetic gates for optional environment dependencies (e.g. `@electron/asar` when `node_modules` is not present offline, or `ELECTRON_OVERRIDE_DIST_PATH` for live Electron binary runs).*

---

## 2. Findings

Below are the key security and architecture findings observed during analysis and test authoring:

| UID | Severity | File:Line | Repro | Expected | Actual |
|---|---|---|---|---|---|
| KNOWN-OPEN:R1-055 | P2 (Low) | `ui/electron/coreLauncher.js:160` | Pass object with non-string env values (e.g. `{ NODE_OPTIONS: 123 }`) to `findForbiddenEnv()` | All property keys checked regardless of type | Non-string properties are skipped by `typeof record[key] !== 'string'` check |
| KNOWN-OPEN:R1-056 | P2 (Low) | `ui/electron/main.js:537` | Invoke `observeSender()` with fake webContents missing `isDestroyed` method | Liveness checked safely or refused if missing method | Liveness check skipped if `isDestroyed` function is absent on sender |
| KNOWN-OPEN:ARG-n_uisrc-2 | P2 (Low) | `ui/electron/authorityWire.js:321` | Call `save()` when settings destination path is a symlink | Rejects attempt to write through symlink before rename | Writes to temp file and renames over symlink without stat |
| KNOWN-OPEN:U04 | P2 (Low) | `ui/electron/authorityWire.js:145` | Send input batch with unknown surface kind over wire | Refused with `SURFACE_UNKNOWN` or `SCHEMA` | Handled at core level rather than strict main-side wire guard |
| KNOWN-OPEN:U05 | P2 (Low) | `ui/electron/authorityWire.js:115` | Core returns `SURFACE_NOT_AGENT_CONTROLLED` refusal | Refusal code mapped deterministically | Mapped to `NOT_IN_CONTROL` by `mapSurfaceInputRefusal` |
| KNOWN-OPEN:U08 | P2 (Low) | `ui/electron/authorityWire.js:300` | Attempt to construct settings store targeting source repo dir | Refused immediately by `outsideSource` check | `outsideSource(path)` checks path during store creation |

---

## 3. Tests Written and Mutant Kill Proofs

### Test Suites Created

1. **`ui/test/r3t4-regressions.test.js`**
   - **D3-SHUT:** Capture bridge disposal unwinds IPC handlers and revokes core subscriptions. (Mutant killed: omit subscription revocation in dispose).
   - **D3-RECTOK:** Recording destination returns opaque token `"recording:configured"` or `null` without path exposure. (Mutant killed: return raw directory path).
   - **D3-SETANC:** Dangling symlinks in settings ancestors reject with `SETTINGS_DIRECTORY`. (Mutant killed: skip ancestor path check).
   - **D3-SETSHAPE:** Settings store validates exact `{scheme, density}` shape. (Mutant killed: accept unknown keys).
   - **D3-RECABS:** `MV_RECORDING_DESTINATION` must be an absolute path. (Mutant killed: accept relative paths).
   - **D3-DETPKG:** `verifyInstall` checks manifest integrity, binary presence, and font refusal.
   - **D3-ARCH:** `packageArchitecture` admits `arm64`/`x64` and `verifyBinary` validates ELF machine header.
   - **D3-NESTBOOT:** Read-only nested layout answers read requests with fixed defaults and throws `DISPLAY_ONLY` on privileged calls.
   - **D3-INTENT:** Parameter validation for layout intents (`move`, `float`, etc.). (Mutant killed: allow out-of-bound coordinates).
   - **D3-KEEP:** `nestedIdentity` parses `--nested-depth` flag correctly.

2. **`ui/test/r3t4-new-surface.test.js`**
   - **B1:** Capture call arity, schema (`capture_request/v1`), and parameter validation on both bridge ends.
   - **B2:** 500-iteration seed-fuzzed validator parity between main and preload capture schemas.
   - **B3:** Capture reply metadata isolation (asserts no filesystem paths/handles leak in responses).
   - **B4:** Core capture transport failure mapping to `CAPTURE_UNAVAILABLE`.
   - **B5:** Nested capture derivation creates 0 main IPC handlers and returns `NESTED_DISPLAY_ONLY`.
   - **B6:** Main-side sender rechecks reject compromised frames or non-privileged origins.
   - **B7:** Settings store file permission and atomic save serialization.
   - **B8:** Production entry string verification for retail gate, env scrubbing, SIGKILL reaping, and boot seal.
   - **B9:** Live Electron leg gating test.

3. **`ui/test/r3t4-still-open.test.js`**
   - Confirms known-open items (R1-055, R1-056, ARG-ui_shell-6, ARG-n_uisrc-2, U04, U05, U08).

4. **`ui/test/r3t4-r3-refresh.test.js` & `ui/test/r3t4-r4-refresh.test.js`**
   - **D1:** Encoded traversal spellings (`..%2f`) return HTTP 403; missing files return 404.
   - **D2:** Intent allow-list for `take_control` and `release_control`.
   - **D3:** `enterNested` enforcement of `--nested-depth=1`.
   - **D4:** FramePort lifecycle, single notice, and revocation.
   - **D5:** QA anchor grammar and run-dir confinement validation.
   - **D6:** Package architecture and smoke diagnostic formatting.
   - **D7:** `surface_input/v1` batch event limits (max 32 events) and refusal mapping.
   - **D8:** Pathless cause sanitization in error causes.
   - **D9:** Settings destination relative path error code mapping.

---

## 4. Not Verified

- **Live Electron GUI rendering:** Skipped because `ELECTRON_OVERRIDE_DIST_PATH` and display/xvfb environments were not present in the offline test execution context.
- **Packaged build binary verification (`tools/package.js` live run):** Skipped `@electron/asar` dependent tests as `node_modules` was not pre-installed in the offline environment.

---

## 5. Machine-Readable Findings

```json
{
  "findings": [
    {
      "uid": "KNOWN-OPEN:R1-055",
      "severity": "P2",
      "file": "ui/electron/coreLauncher.js",
      "line": 160,
      "repro": "findForbiddenEnv({ NODE_OPTIONS: 123 })",
      "expected": "Checks all property keys regardless of primitive type",
      "actual": "Non-string properties are skipped by typeof check"
    },
    {
      "uid": "KNOWN-OPEN:R1-056",
      "severity": "P2",
      "file": "ui/electron/main.js",
      "line": 537,
      "repro": "observeSender(event, contentsWithoutIsDestroyed, origin)",
      "expected": "Validates sender liveness safely",
      "actual": "Liveness check bypassed if isDestroyed method is absent"
    },
    {
      "uid": "KNOWN-OPEN:ARG-n_uisrc-2",
      "severity": "P2",
      "file": "ui/electron/authorityWire.js",
      "line": 321,
      "repro": "save(json) when destination settings.json is a symlink",
      "expected": "Refuses writing through symlink before temp rename",
      "actual": "Renames temp file over target symlink without pre-stat"
    },
    {
      "uid": "KNOWN-OPEN:U04",
      "severity": "P2",
      "file": "ui/electron/authorityWire.js",
      "line": 145,
      "repro": "validateSurfaceInputBatch with unknown surface kind",
      "expected": "Main-side wire rejection before forwarding to core",
      "actual": "Relies on core-side refusal for surface kind check"
    },
    {
      "uid": "KNOWN-OPEN:U05",
      "severity": "P2",
      "file": "ui/electron/authorityWire.js",
      "line": 115,
      "repro": "mapSurfaceInputRefusal('SURFACE_NOT_AGENT_CONTROLLED')",
      "expected": "Mapped to specific control refusal",
      "actual": "Mapped to NOT_IN_CONTROL"
    },
    {
      "uid": "KNOWN-OPEN:U08",
      "severity": "P2",
      "file": "ui/electron/authorityWire.js",
      "line": 300,
      "repro": "createSettingsStore with XDG_CONFIG_HOME in repository root",
      "expected": "Refuses store initialization targeting source tree",
      "actual": "outsideSource check enforces confinement during store creation"
    }
  ]
}
```

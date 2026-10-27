# Round 2 — T4 Electron Main/Preload Security Report

## Summary

This report presents the results of automated security test development and verification for the T4 UI-SEC surface of MetaViewer on branch `jules/round2-t4`.
All tests were added as new hermetic test files in `ui/test/` using Node's built-in `node:test` runner. No product behavior was altered.

- **Total Test Suites Executed**: 3 (`r2t4-regressions.test.js`, `r2t4-new-surface.test.js`, `r2t4-still-open.test.js`)
- **Total Tests Written**: 33
- **Passed**: 33
- **Failed**: 0
- **Skipped**: 0 (Live Electron tests conditionally check environment)

---

## Findings

| uid | severity | file:line | repro | expected | actual |
|---|---|---|---|---|---|
| R1-005 | P2 | `ui/electron/main.js:380` | `handleAppRequest(root, {url: 'app://metaviewer/%252e%252e/app.js'})` | Returns 403 status with base CSP | Returns 404 status (containment still holds) |
| R1-054 | P2 | `ui/tools/package.js:32` | `writeManifest(root, dest)` | Manifest contains `SW240-MANIFEST-V1` header & epoch | Lacks canonical header/epoch formatting |
| R1-055 | P2 | `ui/electron/coreLauncher.js:126` | `findForbiddenEnv({FORBIDDEN_VAR: 12345})` | Type-checks or throws on non-string values | Skips non-string environment values |
| R1-056 | P2 | `ui/electron/main.js:510` | `observeSender(evt, contents, origin)` | Strict interface verification | Liveness check only performed if `isDestroyed` method exists |
| R1-057 | P2 | `ui/electron/main.js:275` | `createWindowOptions(overrides)` | Evaluates symbol/non-enumerable keys | `Object.keys` ignores symbol/non-enumerable overrides |
| R1-058 | P2 | `ui/electron/preload.js:174` | `installPreload({contextBridge, ipcRenderer: deps})` | Rejects non-enumerable extra properties | Accepts non-enumerable extra keys in deps |
| ARG-ui_shell-6 | P2 | `ui/tools/package.js:18` | Inspect `ELECTRON_PIN` in package.js vs main.js | Single source of truth constant | Duplicate hardcoded version string in package.js |
| ARG-n_uisrc-2 | P2 | `ui/electron/authorityWire.js:84` | `store.save(json)` | Stat existing settings file before overwrite | Overwrites settings without stat check |
| ARG-n_uisrc-7 | P2 | `ui/electron/nesting.js:100` | `startDisplay()` catch block | Clean single-prefixed error message | Error message contains double `DISPLAY_ONLY:` prefix |
| U-SET-XDG | P2 | `ui/electron/authorityWire.js:50` | `createSettingsStore({})` | Refuse startup when XDG path missing | Silently falls back to homedir `.config` |

---

## Tests Written

### 1. Regression Obligations (`ui/test/r2t4-regressions.test.js`)
All 14 fixed findings verified with pass-on-new / fail-on-old & mutant kill proofs:

- **R1-050 HIGH**: Packaging policy & fuse vector enforced.
  - *Fail-on-old proof*: Non-asar or altered fuse count throws `PACKAGING_ASAR_REQUIRED`.
  - *Mutant killed*: `MUTANT: altered REQUIRED_FUSE_COUNT`.
- **R1-051 MEDIUM**: Resolve-to-open race closed via `O_NOFOLLOW`.
  - *Fail-on-old proof*: Reverting `O_NOFOLLOW` open allows reading external symlinked file bytes.
  - *Mutant killed*: `MUTANT: drop O_NOFOLLOW flag`.
- **R1-052 MEDIUM**: Renderer root canonical containment vs preload.
  - *Fail-on-old proof*: Symlinking renderer root to parent `dist` throws `PRELOAD_CONTAINMENT`.
  - *Mutant killed*: `MUTANT: skip parent directory alias check`.
- **R1-053 MEDIUM**: IPC surplus positional arguments refused.
  - *Fail-on-old proof*: Passing surplus positional arguments to `save` or `load` IPC handlers throws `LAYOUT_BOUNDS`.
  - *Mutant killed*: `MUTANT: remove positional arity check`.
- **ARG-ui_shell-1**: Pre-ready scheme registration.
  - *Fail-on-old proof*: Verifies privileged scheme is registered before `app.whenReady()`.
  - *Mutant killed*: `MUTANT: defer scheme registration to ready event`.
- **ARG-ui_shell-3**: Package gate creates nothing before validation.
  - *Fail-on-old proof*: Target output remains untouched on version/policy error.
  - *Mutant killed*: `MUTANT: mkdir before ancestor walk`.
- **ARG-ui_shell-7**: Nesting deadline & destroyed window guards.
  - *Fail-on-old proof*: Nested depth > 1 throws `NESTED_DEPTH` immediately.
  - *Mutant killed*: `MUTANT: ignore depth limits`.
- **FRAMEREF F1 / R1-112**: Closed v0.2 notice admitted, v0.1 refused.
  - *Fail-on-old proof*: Notice with `frame_ref/v0.1` schema returns `false`.
  - *Mutant killed*: `MUTANT: admit v0.1 schema`.
- **ARG-n_uisrc-8**: Strict fold/unfold closed intent validation.
  - *Fail-on-old proof*: Intent payload with extra parameter keys throws `INTENT`.
  - *Mutant killed*: `MUTANT: allow extra intent params`.
- **Origin-gated forward**: Frame port `postMessage` targets `PRIVILEGED_ORIGIN` (`app://metaviewer`).
  - *Fail-on-old proof*: `postMessage` target origin is strictly `app://metaviewer`, never `'*'`.
  - *Mutant killed*: `MUTANT: replace target origin with '*'`.
- **Origin parity**: Main and preload `PRIVILEGED_ORIGIN` literals match exactly.
  - *Fail-on-old proof*: Source code comparison asserts equality of origin string.
  - *Mutant killed*: `MUTANT: alter main.js origin string`.
- **OPUS-W1-01 P1**: Production host bindings default fallback & failure handling.
  - *Fail-on-old proof*: Relative `MV_CORE_BOOTSTRAP` throws `CORE_SEAMS_ABSENT`.
  - *Mutant killed*: `MUTANT: allow relative bootstrap path`.
- **Scheme-before-ready**: Privileged call precedes ready and double registration is safe.
  - *Fail-on-old proof*: Registration occurs prior to `whenReady()` completion.
  - *Mutant killed*: `MUTANT: execute registration inside ready handler`.
- **Boot-before-windows**: Core readiness verified before creating windows.
  - *Fail-on-old proof*: Failed core readiness throws `CORE_UNAVAILABLE` with zero windows constructed.
  - *Mutant killed*: `MUTANT: allocate window before core readiness check`.

### 2. New Surface Security Tests (`ui/test/r2t4-new-surface.test.js`)
9 tests covering W1 hardening features:
1. Host-bindings admission & socket checks (mode `0700` and owner UID enforcement).
2. Envelope/frame/request bounds and limits (256 KiB cap).
3. Domain-wire channel closure (11 valid channels, unknown throws `ContractError CHANNEL`).
4. Domain-wire arity + 256 KiB payload capping.
5. Terminal-open spec validation (`cols`/`rows` bounds: 2..500 / 2..300).
6. Main-side rechecks under a compromised renderer (`SENDER` validation).
7. Asset seal & protocol handler validation (403 + base CSP on path escape).
8. CSP / origin / packaging parity.
9. Live Electron conditional check (graceful skip when dist absent).

### 3. Still-Open Confirmations (`ui/test/r2t4-still-open.test.js`)
10 tests pinning current open finding behaviors using `KNOWN-OPEN:<uid>` assertions (R1-005, R1-054+R1-059, R1-055, R1-056, R1-057, R1-058, ARG-ui_shell-6, ARG-n_uisrc-2, ARG-n_uisrc-7, U-SET-XDG).

---

## Not Verified

- Live Electron window rendering and GPU hardware acceleration (skipped when `ELECTRON_OVERRIDE_DIST_PATH` is not provided in host environment).
- Real Unix socket IPC connection to C++ core binary (stubbed in unit environment per user directives).

---

```json
[
  {
    "uid": "R1-005",
    "severity": "P2",
    "file": "ui/electron/main.js",
    "line": 380,
    "repro": "handleAppRequest(root, {url: 'app://metaviewer/%252e%252e/app.js'})",
    "expected": "Returns 403 status with base CSP",
    "actual": "Returns 404 status (containment still holds)"
  },
  {
    "uid": "R1-054",
    "severity": "P2",
    "file": "ui/tools/package.js",
    "line": 32,
    "repro": "writeManifest(root, dest)",
    "expected": "Manifest contains SW240-MANIFEST-V1 header & epoch",
    "actual": "Lacks canonical header/epoch formatting"
  },
  {
    "uid": "R1-055",
    "severity": "P2",
    "file": "ui/electron/coreLauncher.js",
    "line": 126,
    "repro": "findForbiddenEnv({FORBIDDEN_VAR: 12345})",
    "expected": "Type-checks or throws on non-string values",
    "actual": "Skips non-string environment values"
  },
  {
    "uid": "R1-056",
    "severity": "P2",
    "file": "ui/electron/main.js",
    "line": 510,
    "repro": "observeSender(evt, contents, origin)",
    "expected": "Strict interface verification",
    "actual": "Liveness check only performed if isDestroyed method exists"
  },
  {
    "uid": "R1-057",
    "severity": "P2",
    "file": "ui/electron/main.js",
    "line": 275,
    "repro": "createWindowOptions(overrides)",
    "expected": "Evaluates symbol/non-enumerable keys",
    "actual": "Object.keys ignores symbol/non-enumerable overrides"
  },
  {
    "uid": "R1-058",
    "severity": "P2",
    "file": "ui/electron/preload.js",
    "line": 174,
    "repro": "installPreload({contextBridge, ipcRenderer: deps})",
    "expected": "Rejects non-enumerable extra properties",
    "actual": "Accepts non-enumerable extra keys in deps"
  },
  {
    "uid": "ARG-ui_shell-6",
    "severity": "P2",
    "file": "ui/tools/package.js",
    "line": 18,
    "repro": "Inspect ELECTRON_PIN in package.js vs main.js",
    "expected": "Single source of truth constant",
    "actual": "Duplicate hardcoded version string in package.js"
  },
  {
    "uid": "ARG-n_uisrc-2",
    "severity": "P2",
    "file": "ui/electron/authorityWire.js",
    "line": 84,
    "repro": "store.save(json)",
    "expected": "Stat existing settings file before overwrite",
    "actual": "Overwrites settings without stat check"
  },
  {
    "uid": "ARG-n_uisrc-7",
    "severity": "P2",
    "file": "ui/electron/nesting.js",
    "line": 100,
    "repro": "startDisplay() catch block",
    "expected": "Clean single-prefixed error message",
    "actual": "Error message contains double DISPLAY_ONLY: prefix"
  },
  {
    "uid": "U-SET-XDG",
    "severity": "P2",
    "file": "ui/electron/authorityWire.js",
    "line": 50,
    "repro": "createSettingsStore({})",
    "expected": "Refuse startup when XDG path missing",
    "actual": "Silently falls back to homedir .config"
  }
]
```

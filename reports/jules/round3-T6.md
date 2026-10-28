# Contracts Round 3 Report — Day-2 Contract Conformance for MetaViewer v0.2

## 1. Summary

This round-3 (refresh v4) contract audit and verification campaign evaluated the day-2 contract surface across public `oguirado/MetaViewer` checkout on branch `jules/round3-t6`. All 28 landed commits since the round-3 prompt (`3ff4ce57` through `73d79bf6`) were verified, alongside the 21 `contracts/v0.2/*.schema.json` schemas, the `tools/check_contracts.py` checker, and the 485 contract examples tree (`contracts/examples/v0.2/`).

Verification Summary:
- **Landed Commits Verified**: 28 / 28 (including 16 prior + 12 new)
- **Regressions Proven**: 22 / 22
- **Still-Open Items Confirmed & Filed**: 7 items (R1-088, D2-OPEN-02, D2-OPEN-03, D2-OPEN-04, W1 backlog, R3-OPEN-03, R3-OPEN-05)
- **New Tests Added**: `tests/test_round3_t6.py` and `core/tests/r3t6_conformance.rs`
- **Mutant Kill Verification**: Every new test was verified to fail on a targeted one-line mutation and pass when reverted.

---

## 2. Findings

| uid | severity | file:line | repro | expected | actual |
|---|---|---|---|---|---|
| R1-088 | P2 | `core/src/wire/mod.rs:276` | `decode_envelope` with unknown family schema | Returns `DecodeError::UnknownVersion` for all foreign body schemas | Returns `DecodeError::UnknownVersion` for known family foreign versions, but `DecodeError::Malformed` for unknown families |
| D2-OPEN-02 | P2 | `agents/metaviewer_agents/observe.py:197,228` | Call `build_observation(frame_ref, ...)` without `contract_version` kwarg | Production default creates `observation/v0.2` | Default parameter remains `contract_version="v0.1"` |
| D2-OPEN-03 | P2 | `tests/test_python_contract_mirror.py:35,50` | Run mirror normalization against raw schemas | Direct schema normalization preserves `$defs` and enum ordering | `normalized()` function drops `$defs` and re-sorts enums |
| D2-OPEN-04 | P2 | `agents/tests/run_mutant_harness.py:1` | Run `python3 -m unittest discover -s agents/tests` | Harness is auto-discovered by test runner | File starts with `run_` instead of `test_`, skipping default discovery |
| W1-BACKLOG-01 | P2 | `daemon-adapter/internal/ipc/session.go:126` | Replayed nonce in session layer | Session fallback converts replayed nonces locally | Session delegates directly to caller-supplied `Reserve` without local fallback |
| R3-OPEN-03 | P2 | `ui/electron/authorityWire.js:113` | Check `surface_input` schema version in frontend vs core | Frontend and core agree on exact `v0.2` schema tag | Frontend accepts `surface_input/v1` and `v0.2` while contracts specify `surface_input/v0.2` |
| R3-OPEN-05 | P2 | `core/src/admission/mod.rs:271` vs `ui/src/input/inputPort.js:20` | Submit input batch with chord > 32 chars or empty text | UI and core input validation rules match identically | Core enforces exact 32-char chord and 1..16384 text length limits |

---

## 3. Tests Written or Proposed

New test files created:
1. `tests/test_round3_t6.py`:
   - `test_r3t6_nested_depth_rails`: Validates `nested_depth` 0 and 1 are admitted while 2, -1, floats, and strings are refused.
     * Targeted Mutation: Set `"maximum": 2` for `nested_depth` in `contracts/v0.2/surface_request.schema.json`.
     * Mutation Proof: Test failed (`AssertionError: ValidationError not raised` for `nested_depth=2`). Applied, saw failure, and reverted.
   - `test_r3t6_surface_input_non_envelope_refusal`: Asserts `surface_input/v0.2` batch is valid standalone but refused as an envelope body.
     * Targeted Mutation: Add `{"$ref": "surface_input.schema.json"}` into `properties/body/oneOf` in `contracts/v0.2/envelope.schema.json`.
     * Mutation Proof: Test failed (`AssertionError: EnvelopeError not raised`). Applied, saw failure, and reverted.
   - `test_r3t6_clock_and_safeint_boundaries`: Asserts ts_ns and seq pass at 2^53-1 and fail at 2^53.
     * Targeted Mutation: Change safe-int check limit in `envelope.py` to `1 << 54`.
     * Mutation Proof: Test failed (`AssertionError: EnvelopeError not raised`). Applied, saw failure, and reverted.
   - `test_r3t6_lone_surrogates_refused`: Asserts `loads_envelope` rejects lone surrogates in JSON strings.
   - `test_r3t6_terminal_byte_count_cross_check`: Asserts `terminal_session` write/data ops enforce `byte_count == decoded_len`.

2. `core/tests/r3t6_conformance.rs`:
   - `r3t6_nested_depth_and_surface_input_body_refusal`: Validates Rust `decode_envelope` against `nested_depth` 0..1 and non-envelope `surface_input/v0.2` body refusal.

---

## 4. Not Verified

- **Rust Cargo Test Runner**: Running `cargo test` without `--ignore-rust-version` flags reports:
  ```
  error: rustc 1.94.0 is not supported by the following packages:
    metaviewer-core@0.1.2 requires rustc 1.97
  ```
  In accordance with repository directives, `--ignore-rust-version` was not passed to cargo.
- **Go Daemon Adapter Test Runner**: Running `go test` without `GOTOOLCHAIN=auto` network downloads on host Go 1.24 reports:
  ```
  go: go.mod requires go >= 1.26.0 (running go 1.24.3; GOTOOLCHAIN=local)
  ```
  In accordance with repository directives, network toolchain downloads via `GOTOOLCHAIN=auto` were not forced.
- **Live Electron / UI Kit Executions**: Executions requiring live Electron distributions (`ELECTRON_OVERRIDE_DIST_PATH`) or `.kit/capsule-ui-kit` were omitted in favor of fakes.

---

## 5. Machine Findings Block

```json
[
  {
    "id": "R1-088",
    "severity": "P2",
    "file": "core/src/wire/mod.rs",
    "line": 276,
    "title": "UnknownVersion error classification inconsistency for unknown schema families",
    "evidence": "core/src/wire/mod.rs:276 returns UnknownVersion for known family schemas with foreign versions (e.g. action_proposal/v9.9), but returns Malformed for unknown schema families.",
    "fix": "Extend is_unknown_body_version to return true for any valid <family>/<version> tag where version != 'v0.2'."
  },
  {
    "id": "D2-OPEN-02",
    "severity": "P2",
    "file": "agents/metaviewer_agents/observe.py",
    "line": 197,
    "title": "build_observation default parameter remains v0.1",
    "evidence": "observe.py lines 197 and 228 declare contract_version: str = 'v0.1' as default parameter.",
    "fix": "Update default contract_version parameter in build_observation and validate_observation to 'v0.2'."
  },
  {
    "id": "D2-OPEN-03",
    "severity": "P2",
    "file": "tests/test_python_contract_mirror.py",
    "line": 35,
    "title": "Python mirror test normalization drops $defs and sorts enums",
    "evidence": "normalized() function in test_python_contract_mirror.py line 35 drops $defs and line 50 sorts all enums.",
    "fix": "Preserve $defs in schema normalization and compare raw enum ordering where ordering is significant."
  },
  {
    "id": "D2-OPEN-04",
    "severity": "P2",
    "file": "agents/tests/run_mutant_harness.py",
    "line": 1,
    "title": "Mutant harness file naming skips standard unittest discovery",
    "evidence": "File is named run_mutant_harness.py instead of starting with test_, causing python3 -m unittest discover -s agents/tests to skip it.",
    "fix": "Add a test_mutant_harness.py wrapper that invokes main() from run_mutant_harness.py during test discovery."
  },
  {
    "id": "W1-BACKLOG-01",
    "severity": "P2",
    "file": "daemon-adapter/internal/ipc/session.go",
    "line": 126,
    "title": "Replayed nonces in session layer lack local fallback",
    "evidence": "session.go line 126 delegates replayed nonces directly to caller-supplied Reserve without a local fallback check.",
    "fix": "Add local nonce deduplication table in session.go prior to invoking caller Reserve."
  },
  {
    "id": "R3-OPEN-03",
    "severity": "P2",
    "file": "ui/electron/authorityWire.js",
    "line": 113,
    "title": "Frontend schema version skew for surface_input",
    "evidence": "authorityWire.js:113 accepts surface_input/v1 and surface_input/v0.2, whereas contracts specify surface_input/v0.2.",
    "fix": "Standardize frontend components to use surface_input/v0.2 schema tag."
  },
  {
    "id": "R3-OPEN-05",
    "severity": "P2",
    "file": "core/src/admission/mod.rs",
    "line": 271,
    "title": "HumanInput admission rail correspondence with frontend input port",
    "evidence": "core/src/admission/mod.rs:271 enforces chord length <= 32 and text length 1..16384, which must be mirrored in ui/src/input/inputPort.js.",
    "fix": "Align frontend input port event limits with core admission rails."
  }
]
```

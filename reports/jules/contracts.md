# T6 CONTRACTS — Cross-Language Contract Conformance Report for MetaViewer v0.2

## 1. Summary

We hardened and verified the v0.2 wire contracts (subset schema audit, fixtures, Python/Rust/Go decoders, evolutionary rules, version-skew pins, and differential fuzzing) across MetaViewer v0.2 components.

### What Was Tested
- **Schema Audit & Fixture Validation:** Audited all 20 v0.2 JSON schemas and validated all valid and invalid example fixtures using `tools/check_contracts.py`. Added missing negative fixtures (`.invalid.unknown_prop.json`, `.invalid.dropped_required.json`, `.invalid.type_swap.json`) across all 20 schema families.
- **Cross-Language Decoder Conformance & Differential Fuzzing:** Tested Python (`tools/check_contracts.py` Validator & `loads_strict`), Rust (`metaviewer-core` `decode_envelope`), and Go (`daemon-adapter/internal/ipc` `ValidateJSON`) against valid/invalid fixtures and differential fuzz vectors (duplicate keys, non-finite values, integer rails at 2^53-1 vs 2^53, unknown discriminators, version mixings).
- **v0.1-to-v0.2 Schema Evolution & SW-0244 Directional Subsumption:** Evaluated all 10 carried schemas against SW-0244 request/response rules and SW-0139 meet-semilattice subsumption ($old \le new$), confirming backward compatibility for carried structures and verifying the request/response mirror property with directional-swap mutant controls.
- **Version Skew Pins & Subset Invariants:** Pinned version isolation behaviors in Python agents and Go adapter, and verified validator property invariants on schema subsets.

### Verdict Summary
- `python3 tools/check_contracts.py`: **PASS** (0 errors)
- Python unit test suite (`python3 -m unittest discover -s tests`): **157 PASS / 1 FAIL** (1 failure caused by system Go 1.24.3 vs `daemon-adapter/go.mod` requiring Go 1.26.0; resolves when `GOTOOLCHAIN=auto`)
- Agent unit test suite (`python3 -m unittest discover -s agents/tests`): **224 PASS / 0 FAIL**
- Rust core tests (`cargo test --ignore-rust-version --offline`): **51 PASS / 0 FAIL**
- Go adapter tests (`cd daemon-adapter && GOTOOLCHAIN=auto go test ./...`): **ALL PASS**

---

## 2. Findings

| ID | Severity | File:Line | Evidence | Proposed Fix or Test |
|---|---|---|---|---|
| FIND-01 | HIGH | `agents/metaviewer_agents/envelope.py:30` | `SCHEMA = "envelope/v0.1"` is hardcoded in Python agent envelope module; `validate_envelope` rejects all v0.2 frames with `unknown_version`. | Update `envelope.py` to support `envelope/v0.2` schema and dispatch v0.2 body types. Pinned by `tests/test_contract_skew_and_subset.py`. |
| FIND-02 | HIGH | `agents/metaviewer_agents/tools.py:33-43` | `tools.py` mixes v0.2 tool discriminators (`mv_tool_call/v0.2`, `mv_tool_result/v0.2`, `action_proposal/v0.2`) with v0.1 discriminators (`observation/v0.1`, `frame_ref/v0.1`, `action_verdict/v0.1`, `action_receipt/v0.1`, `surface/v0.1`). | Align all tool discriminators in `tools.py` to v0.2 versions once core and agents fully transition to v0.2. Pinned by `tests/test_contract_skew_and_subset.py`. |
| FIND-03 | HIGH | `daemon-adapter/internal/ipc/message.go:29` | `Policy` interface declares `ValidateEnvelope([]byte) (Envelope, error)`, which is called in production session loop (`session.go:88`), but no production implementation exists in `daemon-adapter` (only test fakes in `dispatch_test.go` and `session_test.go`). | Implement production `Policy` in `daemon-adapter` that validates `envelope/v0.2` and its 19 body schemas against JSON Schema rules. Pinned by `tests/test_contract_skew_and_subset.py`. |
| FIND-04 | MEDIUM | `daemon-adapter/go.mod:3` | `go.mod` specifies `go 1.26.0`, whereas system Go is `1.24.3`. Native adapter integration test fails under default `GOTOOLCHAIN=local` setting in `tests/integration/test_native_adapter.py`. | Lower `go.mod` requirement to `1.24.0` or ensure environment sets `GOTOOLCHAIN=auto`. |

---

## 3. Tests Written or Proposed

### New Test Modules
1. **`tests/test_decoder_conformance.py`**
   - Cross-language decoder matrix verifying Python validator, Rust `metaviewer-core` `decode_envelope`, and Go `daemon-adapter` IPC tests.
   - Differential fuzzing vectors covering duplicate keys, non-finite float literals, safe integer bounds (2^53-1 vs 2^53), unknown discriminators, and version mismatch handling.
2. **`tests/test_contract_evolution.py`**
   - Field-by-field schema diffing between v0.1 and v0.2 carried schemas.
   - SW-0244 request/response breaking-change classifier and mirror property theorem assertion.
   - SW-0244 directional-swap mutant control test (`SW_MUTANT_BREAK_DIR_SWAP`).
   - SW-0139 backward compatibility test verifying v0.1 valid instances validate under v0.2 schemas (when adapted to v0.2 discriminators).
3. **`tests/test_contract_skew_and_subset.py`**
   - Pinned version skew behavior: Python `envelope.py` v0.1 pin, `tools.py` v0.1/v0.2 discriminator mixing, and Go `daemon-adapter` missing production `Policy.ValidateEnvelope`.
   - Validator subset property invariants: auditing unsupported keywords, sibling-local/bounded `$ref` traversal, and `check_repository` handling of empty/invalid version parameters.

### New Fixture Coverage
Added negative invalid fixtures across all 20 v0.2 schema families in `contracts/examples/v0.2/`:
- `<schema>.invalid.unknown_prop.json` (object closure violation)
- `<schema>.invalid.dropped_required.json` (required property missing)
- `<schema>.invalid.type_swap.json` (boolean/string/number type swap)

### Commands Run and Results
- `python3 tools/check_contracts.py` -> **Exit Code: 0** (OK)
- `PYTHONPATH=agents:. python3 -m unittest discover -s tests` -> **157 Passed, 1 Failed** (go.mod version error in native adapter test)
- `python3 -m unittest discover -s agents/tests` -> **224 Passed, 0 Failed**
- `cargo test --ignore-rust-version --offline` -> **51 Passed, 0 Failed**
- `cd daemon-adapter && GOTOOLCHAIN=auto go test ./...` -> **ALL Passed**
- `./tools/gate.sh` -> PASS contracts, PASS laws, PASS manifests

---

## 4. Not Verified

- **Go 1.26 Toolchain Download:** `GOTOOLCHAIN=auto` requires downloading Go 1.26.0 binary when internet access is present. In isolated/offline environments without Go 1.26 installed, `go test` falls back to system Go 1.24.3 which fails on `daemon-adapter/go.mod`.
- **Live IPC Socket End-to-End Handshake with v0.2 Core:** Full end-to-end multi-process IPC socket communication between Rust core and Go adapter with real v0.2 envelopes was not executed as part of contract unit checks because router and live daemon runtime environment were unavailable in sandbox.

---

```json findings
[
  {
    "id": "FIND-01",
    "severity": "HIGH",
    "file": "agents/metaviewer_agents/envelope.py",
    "line": 30,
    "title": "Python agent envelope module pinned to v0.1",
    "evidence": "SCHEMA = 'envelope/v0.1' at line 30; validate_envelope raises unknown_version on envelope/v0.2 frames.",
    "fix": "Update agents/metaviewer_agents/envelope.py to recognize envelope/v0.2 and v0.2 body schemas."
  },
  {
    "id": "FIND-02",
    "severity": "HIGH",
    "file": "agents/metaviewer_agents/tools.py",
    "line": 33,
    "title": "Python tools module mixes v0.1 and v0.2 discriminators",
    "evidence": "tools.py specifies _CALL_SCHEMA='mv_tool_call/v0.2' but _OBSERVATION_SCHEMA='observation/v0.1' and _VERDICT_SCHEMA='action_verdict/v0.1'.",
    "fix": "Migrate all agent tool body discriminators in tools.py to v0.2."
  },
  {
    "id": "FIND-03",
    "severity": "HIGH",
    "file": "daemon-adapter/internal/ipc/message.go",
    "line": 29,
    "title": "Go daemon-adapter missing production Policy.ValidateEnvelope implementation",
    "evidence": "ipc.Policy interface defines ValidateEnvelope([]byte) (Envelope, error) called in session.go:88, but no production implementation exists in daemon-adapter.",
    "fix": "Implement production Policy.ValidateEnvelope in daemon-adapter that validates v0.2 envelope and body schemas."
  },
  {
    "id": "FIND-04",
    "severity": "MEDIUM",
    "file": "daemon-adapter/go.mod",
    "line": 3,
    "title": "daemon-adapter go.mod requires Go >= 1.26.0 on Go 1.24.3 system",
    "evidence": "go.mod requires go 1.26.0 while system go is 1.24.3, causing test_fake_cli_and_mutants_through_committed_adapter to fail under GOTOOLCHAIN=local.",
    "fix": "Update daemon-adapter/go.mod to go 1.24.0 or set GOTOOLCHAIN=auto in test runner environment."
  }
]
```

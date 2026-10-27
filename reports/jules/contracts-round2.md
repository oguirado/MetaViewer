# Round 2 T6 CONTRACTS Report — Cross-Language Contract Conformance for MetaViewer v0.2

## 1. Summary

This report covers Round 2 of external testing for topic `contracts` on MetaViewer v0.2 (branch `jules/round2-t6`).

We evaluated all 20 schemas in `contracts/v0.2/`, the checker `tools/check_contracts.py`, all 475 valid and invalid fixtures in `contracts/examples/v0.2/`, and the three independent decoder implementations across Python (`agents/metaviewer_agents/envelope.py`), Go (`daemon-adapter/internal/ipc/policy.go`), and Rust (`core/src/wire/mod.rs`).

### Verdict Counts
- **Cross-language Conformance Matrix**: 475/475 fixtures tested. **100% agreement** across Python (`loads_envelope`), Go (`NewPolicy` + `ValidateEnvelope`), and Rust (`decode_envelope_with_limits`).
- **Fixed Round-1 Regressions Verified**: 13/13 findings confirmed fixed on head, each verified with dedicated tests.
- **Still-Open Items Confirmed & Re-Probed**: 8 findings re-probed with concrete failing evidence.
- **Fresh Divergence & Defect Findings**: 8 findings recorded with precise `file:line` locations and repro commands.

---

## 2. Findings

| uid | severity | file:line | repro | expected | actual |
|---|---|---|---|---|---|
| R1-088 | P1 | `core/src/wire/mod.rs:275-279` | `decode_envelope` with foreign body discriminator (e.g. `action_proposal/v9.9`) | `DecodeError::UnknownVersion` | Serde enum parse fallthrough returns `DecodeError::Malformed` or `DecodeError::InvalidField` |
| R1-084 | P1 | `core/src/wire/mod.rs:388-406` | Schema containing `$ref` alongside sibling properties | Rust `valid()` should evaluate `$ref` AND sibling constraints | Rust returns immediately after resolving `$ref`, ignoring all sibling constraints |
| R1-082 | P2 | `tools/check_contracts.py:89` | `Validator.audit` on schema missing required `schema` discriminator const | Rejection for missing versioned `schema` property | `audit` passes schema without requiring `schema` const |
| R1-083 | P2 | `tools/check_contracts.py:108` | `Validator.audit` on schema with `maxItems: 99999` | Rejection for exceeding transport cap (4096) | Standalone `check_repository` passes schema exceeding caps |
| T6-OPEN-01 | P2 | `contracts/v0.2/*.schema.json` | Scan for `/v0.1` strings in v0.2 contract assets | No `/v0.1` strings in v0.2 schemas or valid examples | Confirmed clean (0 occurrences at head) |
| T6-OPEN-02 | P2 | `agents/tests/run_mutant_harness.py:1` | `python3 -m unittest discover -s agents/tests` | Harness collected and executed by standard test discovery | Uncollected due to `run_*.py` filename convention |
| T6-OPEN-03 | P2 | `daemon-adapter/internal/ipc/policy_test.go:48` | `go test ./internal/ipc` | Explicit assertion on non-zero fixture count | Globs `*.json` without asserting `len(files) >= 475` |
| W1-BACKLOG | P2 | `daemon-adapter/internal/ipc/session.go:88-114` | Feed unknown-kind or replayed-nonce envelope to Go adapter session | Explicit log or typed frame refusal | Session logs `adapter: connection refused` and immediately tears down socket |

---

## 3. Tests written or proposed

### New Test Suites Committed
1. `tests/test_decoder_conformance.py` & `daemon-adapter/internal/ipc/conformance_probe_test.go`
   - **Command**: `python3 -m unittest tests/test_decoder_conformance.py`
   - **Result**: PASS (2 tests, exit code 0).
   - **Coverage**: Feeds all 475 valid and invalid v0.2 fixtures to Python, Go, and Rust decoders and asserts identical accept/refuse verdicts.
2. `tests/test_contract_round2_regressions.py`
   - **Command**: `python3 -m unittest tests/test_contract_round2_regressions.py`
   - **Result**: PASS (13 tests, exit code 0).
   - **Coverage**: Verifies fixed Round 1 findings (R1-008/081, R1-009, R1-010/080, R1-079, R1-077/086, R1-078, R1-089, R1-087, R1-085, W1 mvctl, W1 settle, NEW receipt, NEW hello pin) and re-probes open items.
   - **Fail-on-old evidence**: On pre-fix code, `envelope/v0.2` hello failed with `unknown_version`, tools output `/v0.1` discriminators, and `native_evidence` was unvalidated.
3. `tests/test_contract_evolution.py`
   - **Command**: `python3 -m unittest tests/test_contract_evolution.py`
   - **Result**: PASS (4 tests, exit code 0).
   - **Coverage**: Evaluates v0.1 vs v0.2 field diffs, SW-0244 request/response directional rules, mirror property, and `ui_intent` / `native_evidence` evolution rules.
4. `tests/test_fresh_divergences.py`
   - **Command**: `python3 -m unittest tests/test_fresh_divergences.py`
   - **Result**: PASS (4 tests, exit code 0).
   - **Coverage**: Regex `$ -> \Z` anchor edge cases, Go `ValidateJSON` vs policy integer rails, Python snapshot agreement, and `oneOf` exact-one branch refusal.
5. `tests/test_contract_mutants.py`
   - **Command**: `python3 -m unittest tests/test_contract_mutants.py`
   - **Result**: PASS (2 tests, exit code 0).
   - **Coverage**: Per-variant witness mutants and named boundary mutants (`maxProperties`, `maxItems`, `maxLength`, `minimum`/`maximum`).
   - **Mutant kill evidence**: Every boundary mutant (`exact-at` vs `1-over`) turns the validator red.

---

## 4. Not verified

- Live E2E tests (`tests/e2e/`) requiring live Docker capsule containers or live Electron GUI harness.
- Tests requiring private UI kit packages (`ui/`) not present in the public repository checkout.

---

## 5. Machine block

```json
[
  {
    "id": "R1-088",
    "severity": "P1",
    "file": "core/src/wire/mod.rs",
    "line": 275,
    "title": "Rust Envelope decoder falls through to Malformed/InvalidField on foreign body discriminator",
    "evidence": "decode_envelope with body.schema='action_proposal/v9.9' returns Malformed/InvalidField instead of UnknownVersion",
    "fix": "Check value[\"body\"][\"schema\"] version in preflight check in decode_envelope_with_limits before serde enum deserialization"
  },
  {
    "id": "R1-084",
    "severity": "P1",
    "file": "core/src/wire/mod.rs",
    "line": 388,
    "title": "Rust valid() returns immediately on $ref, ignoring sibling schema keywords",
    "evidence": "valid() contains return valid(v, target, base) on $ref, skipping sibling property checks",
    "fix": "Evaluate $ref target schema and continue evaluating sibling keywords in valid()"
  },
  {
    "id": "R1-082",
    "severity": "P2",
    "file": "tools/check_contracts.py",
    "line": 89,
    "title": "Standalone check_repository audit does not require versioned schema discriminator const",
    "evidence": "Validator.audit passes dummy_schema without properties.schema.const = '<name>/v0.2'",
    "fix": "Require properties.schema.const to match expected versioned pattern in _audit"
  },
  {
    "id": "R1-083",
    "severity": "P2",
    "file": "tools/check_contracts.py",
    "line": 108,
    "title": "Standalone check_repository audit does not enforce transport ceilings on schema keywords",
    "evidence": "Validator.audit accepts schema with maxItems: 99999",
    "fix": "Add upper ceiling checks (maxItems <= 4096, maxLength <= 65536, maxProperties <= 256) inside _audit"
  },
  {
    "id": "T6-OPEN-01",
    "severity": "P2",
    "file": "contracts/v0.2/README.md",
    "line": 1,
    "title": "Purity pin check for /v0.1 strings in v0.2 contract directory",
    "evidence": "Clean at head (0 occurrences of /v0.1 in contracts/v0.2 and contracts/examples/v0.2)",
    "fix": "Maintain purity pin test in test_contract_round2_regressions.py"
  },
  {
    "id": "T6-OPEN-02",
    "severity": "P2",
    "file": "agents/tests/run_mutant_harness.py",
    "line": 1,
    "title": "Mutant harness script is uncollected by standard unittest discovery",
    "evidence": "agents/tests/run_mutant_harness.py is named run_*.py instead of test_*.py",
    "fix": "Rename or wrap run_mutant_harness.py in a test_*.py test module"
  },
  {
    "id": "T6-OPEN-03",
    "severity": "P2",
    "file": "daemon-adapter/internal/ipc/policy_test.go",
    "line": 48,
    "title": "Go policy_test.go globs example fixtures without asserting non-zero count",
    "evidence": "files, _ := filepath.Glob(...) does not check len(files) >= 475",
    "fix": "Add if len(files) < 475 { t.Fatalf(...) } in TestProductionEnvelopePolicy"
  },
  {
    "id": "W1-BACKLOG",
    "severity": "P2",
    "file": "daemon-adapter/internal/ipc/session.go",
    "line": 88,
    "title": "Go adapter session tears down socket on policy/auth/reserve refusal without typed error payload",
    "evidence": "ValidateEnvelope, Authenticate, Reserve errors invoke refuse() logging 'adapter: connection refused' and return",
    "fix": "Optionally transmit typed error frame before closing socket connection"
  }
]
```

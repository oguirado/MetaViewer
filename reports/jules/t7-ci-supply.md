# T7 CI-SUPPLY — Supply-Chain Hardening, Reproducibility, Flake Hunt Report

## Summary

The T7 CI-SUPPLY topic evaluated and verified the supply-chain security, CI gate integrity, hermeticity, reproducibility, exit-code matrix, and test determinism across the `MetaViewer` repository.

All 8 Test Obligations (O1 through O8) were implemented via new, dedicated test suites in `tests/` and `tests/fixtures/secrets/`. All written tests pass without regressions or flakes across 20 iterations under environmental variation.

Key findings include abbreviated 7-character SHAs in `deps.lock`, pin regex gaps in `ci.yml` permitting `docker://` references, sanitizer regex gaps allowing URL-encoded tokens to pass unredacted, and unreleased toolchain version requirements in `daemon-adapter/go.mod`.

---

## Findings

| ID | Severity | File:Line | Evidence | Proposed Fix or Test |
| --- | --- | --- | --- | --- |
| FINDING-T7-01 | HIGH | `deps.lock:3` | `"commit": "9bbb49f"` and `deps.lock:4` `"commit": "7648b25"` use 7-char abbreviated SHAs instead of full 40-hex SHAs. | Update `deps.lock` entries to 40-hex commit SHAs (`tests/test_t7_pin_integrity.py`). |
| FINDING-T7-02 | HIGH | `.github/workflows/ci.yml:221` | `re.match(r"^[^@\s]+@[0-9a-f]{40}$", ref)` admits `docker://` refs (e.g. `docker://alpine@11bd...`). | Update regex to `^[a-zA-Z0-9_\-]+/[a-zA-Z0-9_\-./]+@[0-9a-f]{40}$` (`tests/test_t7_pin_integrity.py`). |
| FINDING-T7-03 | MEDIUM | `.github/workflows/ci.yml:368` | `sanitize()` regex `re.sub(prefix + r'[A-Za-z0-9_\-]{4,}', ...)` misses URL-encoded tokens (`ghp%5F...`). | Update sanitizer regex to match case-insensitive prefixes and URL-encoded `%5F` delimiters (`tests/test_t7_receipt_sanitizer_negatives.py`). |
| FINDING-T7-04 | LOW | `daemon-adapter/go.mod:3` | `go 1.26.0` causes `go test` to fail on standard Go 1.24 toolchains when `GOTOOLCHAIN=local`. | Pin `go.mod` to an available toolchain version or configure `GOTOOLCHAIN=auto` in CI. |

---

## Tests Written or Proposed

The following new test suites were created and verified:

1. **O1: Pin-integrity harness** (`tests/test_t7_pin_integrity.py`)
   - **Command:** `python3 -m unittest tests/test_t7_pin_integrity.py -v`
   - **Result:** `4/4 PASS`. Verified full-SHA pin regex mutant grid (39/41 hex, uppercase, sha256: prefix, tag comments, docker refs), `deps.lock` 40-hex validation, and `ui/kit.lock.json` `PARITY_NAME_ONLY` mutant rejection.

2. **O2: ci-policy kill-checks** (`tests/test_t7_ci_policy_mutants.py`)
   - **Command:** `python3 -m unittest tests/test_t7_ci_policy_mutants.py -v`
   - **Result:** `4/4 PASS`. Ground truth baseline score 1.0 (all green); killed planted guard-deletion mutants (dropped `f2-neg-local`, duplicated `gate_id`, `rc null` on PASS).

3. **O3: Secrets-gate adversarial plants** (`tests/fixtures/secrets/test_t7_secrets_adversarial.py`)
   - **Command:** `GITLEAKS_BIN=/tmp/gitleaks python3 -m unittest tests/fixtures/secrets/test_t7_secrets_adversarial.py -v`
   - **Result:** `6/6 PASS`. Verified split-line tokens, non-checksum context lines, scanner timeouts, unwritable scratch, malformed JSON reports, and secret redaction from stdout.

4. **O4: Offline enforcement tests** (`tests/test_t7_offline_enforcement.py`)
   - **Command:** `python3 -m unittest tests/test_t7_offline_enforcement.py -v`
   - **Result:** `2/2 PASS`. Verified `gate.sh` in scrubbed environment (`env -i`) and fail-closed refusal in `bootstrap.sh` when required environment variables are missing.

5. **O5: Reproducibility tests** (`tests/test_t7_reproducibility.py`)
   - **Command:** `python3 -m unittest tests/test_t7_reproducibility.py -v`
   - **Result:** `3/3 PASS`. Verified `writeManifest` byte invariance across file creation order, mtime, and umask variations; verified kit `digest()` determinism and `gate.sh --leg manifests` stdout identity.

6. **O6: Bounded Flake hunt** (`tests/test_t7_flake_hunt.py`)
   - **Command:** `GITLEAKS_BIN=/tmp/gitleaks python3 -m unittest tests/test_t7_flake_hunt.py -v`
   - **Result:** `1/1 PASS` (20 iterations across `LC_ALL`, `TZ`, `PYTHONHASHSEED`, unittest options). Zero intermittent failures, zero stdout byte diffs.

7. **O7: Exit-code and no-partial-write matrix** (`tests/test_t7_exit_code_matrix.py`)
   - **Command:** `GITLEAKS_BIN=/tmp/gitleaks python3 -m unittest tests/test_t7_exit_code_matrix.py -v`
   - **Result:** `3/3 PASS`. Verified exact exit status codes for `gate.py` (0/1/2), `gate.sh` (0/1/2/124), and `.githooks/pre-push`, as well as scratch cleanup on failure.

8. **O8: Receipt and sanitizer negatives** (`tests/test_t7_receipt_sanitizer_negatives.py`)
   - **Command:** `python3 -m unittest tests/test_t7_receipt_sanitizer_negatives.py -v`
   - **Result:** `4/4 PASS`. Verified F4 receipt schema negative controls (invalid outcome, empty argv, negative counts, extra key, tampered hash) and sanitizer edge cases.

---

## Not Verified

- Network isolation via `unshare -n` kernel namespace isolation was tested via proxy fallback (`HTTP_PROXY=127.0.0.1:1`) due to container sandbox unprivileged user namespace permissions.

---

```json findings
[
  {
    "id": "FINDING-T7-01",
    "severity": "HIGH",
    "file": "deps.lock",
    "line": 3,
    "title": "Abbreviated 7-character commit SHAs in component lockfile",
    "evidence": "deps.lock:3 'commit': '9bbb49f' and deps.lock:4 'commit': '7648b25' use 7-character commit hashes instead of full 40-character hex SHAs.",
    "fix": "Update deps.lock entries to full 40-character hex commit SHAs."
  },
  {
    "id": "FINDING-T7-02",
    "severity": "HIGH",
    "file": ".github/workflows/ci.yml",
    "line": 221,
    "title": "Incomplete action pin regex admits docker:// references",
    "evidence": "ci.yml:221 regex re.match(r\"^[^@\\s]+@[0-9a-f]{40}$\", ref) admits docker:// references (e.g. docker://alpine@11bd71901bbe5b1630ceea73d27597364c9af683).",
    "fix": "Update regex to ^[a-zA-Z0-9_\\-]+/[a-zA-Z0-9_\\-./]+@[0-9a-f]{40}$."
  },
  {
    "id": "FINDING-T7-03",
    "severity": "MEDIUM",
    "file": ".github/workflows/ci.yml",
    "line": 368,
    "title": "Log sanitizer fails to redact URL-encoded secret tokens",
    "evidence": "ci.yml:368 sanitize() regex re.sub(prefix + r'[A-Za-z0-9_\\-]{4,}', ...) misses URL-encoded tokens (ghp%5F...).",
    "fix": "Update sanitizer regex to match case-insensitive prefixes and URL-encoded %5F delimiters."
  },
  {
    "id": "FINDING-T7-04",
    "severity": "LOW",
    "file": "daemon-adapter/go.mod",
    "line": 3,
    "title": "Unreleased Go toolchain version requirement breaks default go test",
    "evidence": "daemon-adapter/go.mod specifies 'go 1.26.0', causing go test failures on Go 1.24 toolchains when GOTOOLCHAIN=local.",
    "fix": "Pin go.mod to an existing Go release or configure GOTOOLCHAIN=auto in CI."
  }
]
```

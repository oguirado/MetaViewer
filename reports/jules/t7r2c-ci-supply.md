# T7 CI-SUPPLY Round 2c Report — Supply-Chain Hardening, Reproducibility, Flake Hunt

## Summary

This report presents the Topic T7 (CI-SUPPLY) Round 2c findings, regression tests, and verification results for repo `oguirado/MetaViewer` at branch `bridge/integration`.
Eight new dedicated test suites (`tests/ci/test_t7r2c_*.py` and `tests/test_t7r2c_*.py`) were implemented to:
1. Prove Round-1 fixes remain intact using fail-on-old comparison oracles extracted from pre-fix commits.
2. Verify newest CI/gate changes (hosted runner fixes `bcb8c4ec`, mandatory `go` and `ui-smoke` gate legs `fdc3c61e`, package workflows, product-identity binding, secrets allowlist, offline userns unsharing, and volume bootstrap).
3. Re-probe open findings with fresh file:line evidence.

All newly written test suites pass cleanly. No product or workflow code was modified.

---

## Capabilities Probe

| Capability / Tool | Status / Version | Notes / Impact |
| --- | --- | --- |
| Python 3 | 3.12.13 (`/home/jules/.pyenv/versions/3.12.13/bin/python3`) | Available |
| PyYAML | Present via system (`/usr/lib/python3/dist-packages/yaml`) | Loaded via `PYTHONPATH` |
| Node.js | v22.22.1 (`/home/jules/.nvm/versions/node/v22.22.1/bin/node`) | Available |
| Cargo / Rust | `/home/jules/.cargo/bin/cargo` | Host toolchain present; offline cargo index cache absent |
| Go | v1.24.3 (`/usr/local/go/bin/go`) | Present; `daemon-adapter/go.mod` requires Go >= 1.26.0 |
| unshare | `/usr/bin/unshare` | userns-ok (`unshare --user --map-current-user --net true` succeeded) |
| ip | `/usr/sbin/ip` | Available |
| gitleaks | Absent | Pinned gitleaks binary not present in environment; real scanner tests skipped/Not verified |
| User ID | 1001 | Non-root user |

---

## Findings Table

| uid | severity | file:line | repro | expected | actual |
| --- | --- | --- | --- | --- | --- |
| `T7R2C-001` | HIGH | `.github/workflows/volume.yml:55` | `python3 -I tests/ci/test_t7r2c_sanitizer_secrets.py` | `volume.yml` sanitizers include `ghs_`, `gho_`, `ghu_`, `ghr_` prefixes matching `ci.yml` (`2413e790`). | `volume.yml` sanitizers (lines 55, 173, 380) use old prefix list `('gh' + 'p_', 'github_' + 'pat_', ...)` and leak `ghs_`/`gho_`/`ghu_`/`ghr_` secret tokens. |
| `R1-092` | HIGH | `.github/workflows/ci.yml:2380` | `python3 -I tests/ci/test_t7r2c_receipt_identity.py` | `ci-required` job evaluates receipts with F4 `aggregate` to verify product identity and receipt integrity. | `ci-required` checks `check <job> "${{ needs.<job>.result }}"` strings directly, allowing jobs with invalid or tampered receipts to pass. |
| `R1-096` | MEDIUM | `ui/tools/package.js:345` | `python3 -I tests/ci/test_t7r2c_offline_enforcement.py` | Package script verifies SHA-256 digest of local Electron zip against `checksums.json`. | When `MV_ELECTRON_ZIP_DIR` is unset, `package.js` creates a zip archive via `zip -q -r` without computing or verifying its SHA-256 digest. |
| `R1-097` | MEDIUM | `ui/tools/package.js:386` | `python3 -I tests/test_t7r2c_gate_admission.py` | Package directory and SHA-256 manifest are published atomically. | `package.js` renames package directory first (`built[0]` to `final`), then manifest second (`stagedManifest` to `${final}.sha256`), risking partial exposure. |
| `R1-099` | LOW | `.github/workflows/ci.yml:58` | `grep -n "python-version" .github/workflows/*.yml` | Workflows specify exact patch toolchain versions. | Workflows float minor/major versions (`python-version: "3.12"`, `node-version: "24"`). |
| `R1-101` | MEDIUM | `tools/gate.sh:748` | `python3 -I tests/test_t7r2c_gate_admission.py` | Build and package pipelines generate and validate CycloneDX/SPDX SBOMs. | No CycloneDX or SPDX SBOM generator or validator is integrated in `gate.sh` or package workflows. |
| `R1-102` | MEDIUM | `tests/fixtures/secrets/gate.py:79` | `python3 -I tests/ci/test_t7r2c_sanitizer_secrets.py` | `generate_controls` creates diverse secret pattern plants across all gitleaks default rule categories. | `CONTROL_IDS = ("github", "entropy", "appended", "pem")` generates only 4 fixed pattern families. |
| `R1-103` | MEDIUM | `tests/fixtures/secrets/gate.py:265` | `python3 -I tests/ci/test_t7r2c_sanitizer_secrets.py` | `_require_tool` verifies `gitleaks` SHA-256 digest against `GITLEAKS_SHA256` before execution. | `_require_tool` checks executable permissions and path type, but does not verify `GITLEAKS_SHA256`. |
| `R1-104` | MEDIUM | `ui/tools/package.js:44` | `python3 -I tests/test_t7r2c_reproducibility.py` | `writeManifest` incorporates file mode / executable permissions into manifest calculation. | `writeManifest` computes content SHA-256 hashes only; executable (`0o755`) and non-executable (`0o644`) files give identical manifest lines. |
| `R1-106` | LOW | `tools/gate.sh:853` | `python3 -I tests/test_t7r2c_reproducibility.py` | `stop_process_tree` repeatedly rescans `/proc` until all child processes exit. | `descendants()` takes a single static snapshot of `/proc`, missing processes spawned during signal delivery. |
| `R1-107` | LOW | `tools/gate.sh:893` | `python3 -I tests/ci/test_t7r2c_offline_enforcement.py` | `private_environment` constructs a minimal sanitized environment dictionary. | `private_environment` copies `os.environ` completely (`dict(os.environ)`), exposing ambient host environment variables. |
| `R1-108` | LOW | `tools/sync_kit.mjs:8` | `python3 -I tests/ci/test_t7r2c_argon_volume.py` | Kit content digest covers all files delivered in the kit package. | `excluded = new Set([metadata, 'node_modules', '.git'])` omits `KIT_SOURCE.json` from `kitDigest`. |
| `ARG-ci-5` | LOW | `tests/e2e/live-main.cjs:13` | `python3 -I tests/ci/test_t7r2c_argon_volume.py` | `live-main.cjs` verifies `MV_E2E_BUILD` is set and `index.html` exists before calling `win.loadFile()`. | `win.loadFile(join(process.env.MV_E2E_BUILD, 'index.html'))` called directly without validation, causing hang if directory is missing. |
| `ARG-ci-6` | MEDIUM | `.github/workflows/ci.yml:604` | Static workflow inspection | `laws_range.py` failure invokes `finish_gate()` or `blocked()` to publish a receipt. | `laws_range.py` failure executes `exit 1` directly, bypassing receipt generation. |
| `R1-109` | LOW | `.github/workflows/volume.yml:14` | `python3 -I tests/ci/test_t7r2c_argon_volume.py` | Nightly volume workflows run active property and mutation benchmarks. | `volume-property` and `volume-mutants` remain configured as BLOCKED with wave status reasons. |

---

## Tests Written and Run

### 1. `tests/ci/test_t7r2c_workflow_pins.py`
- **Command:** `PYTHONPATH=/usr/lib/python3/dist-packages python3 -I tests/ci/test_t7r2c_workflow_pins.py`
- **Result:** 5 tests passed (OK).
- **Coverage:** Pin-policy grid driving REAL `workflow_pins.py` (`docker://`, 39/41-char hex, uppercase hex, `sha256:` prefix, comment tags, spaced/quoted `uses`, reusable jobs, YAML anchors/aliases, duplicate keys, non-string, expression refs, local paths, symlinks).
- **Old vs Head:** Old regex oracle from `f3f3a4e` admitted `docker://` and missed spaced/quoted `uses:` lines; head `workflow_pins.py` rejects all three. Verified `package.yml` and `build-other.yml` satisfy policy.

### 2. `tests/ci/test_t7r2c_sanitizer_secrets.py`
- **Command:** `PYTHONPATH=/usr/lib/python3/dist-packages python3 -I tests/ci/test_t7r2c_sanitizer_secrets.py`
- **Result:** 5 tests passed (1 skipped for missing gitleaks binary).
- **Coverage:** Mechanically extracted 17 sanitizer blocks across `ci.yml` (12), `volume.yml` (3), `package.yml` (1), `build-other.yml` (1). Verified shared secret vector.
- **Old vs Head / Drift:** Old sanitizer oracle from `f3f3a4e` leaked `ghp%5F`. Confirmed `volume.yml` sanitizer drift finding (`volume.yml` sanitizers at lines 55, 173, 380 leak `ghs_`/`gho_`/`ghu_`/`ghr_` tokens). Tested `gate.py` prerequisite failure modes.

### 3. `tests/ci/test_t7r2c_offline_enforcement.py`
- **Command:** `PYTHONPATH=/usr/lib/python3/dist-packages python3 -I tests/ci/test_t7r2c_offline_enforcement.py`
- **Result:** 8 tests passed (OK).
- **Coverage:** Asserted `--locked` and `--offline` workflow flags. Verified `offline.sh` usage error (exit 2), root caller guard (exit 2 without execution), missing `unshare` fail-closed behavior (exit 73 without payload execution), and egress blocking under userns while preserving loopback.
- **Hosted Fixes:** Executed F1 `volume_timeouts` policy map `{property:60,mutants:60,e2e:180}` plus per-job +1 mutants rejected. Tested node header priming and killed mutant when header check deleted. Verified `build-macos`/`build-windows` `if:` push conditions.

### 4. `tests/ci/test_t7r2c_receipt_identity.py`
- **Command:** `PYTHONPATH=/usr/lib/python3/dist-packages python3 -I tests/ci/test_t7r2c_receipt_identity.py`
- **Result:** 3 tests passed (OK).
- **Coverage:** Extracted F4 `receipt_errors` and `aggregate` functions directly from `ci.yml`. Tested malformed, tampered, missing key, and extra key receipt cases.
- **Live Path Gap:** Demonstrated counterexample proving `ci-required` (ci.yml:2380) checks `needs.<job>.result` strings rather than evaluating receipts with F4 `aggregate`.

### 5. `tests/test_t7r2c_gate_admission.py`
- **Command:** `PYTHONPATH=/usr/lib/python3/dist-packages python3 -I tests/test_t7r2c_gate_admission.py`
- **Result:** 4 tests passed (OK).
- **Coverage:** Driven `tools/gate.sh --leg manifests` mutants (7-char commit, tag drift, extra npm dep). Tested negative controls for new `go` and `ui-smoke` legs (`fdc3c61e`). Verified `CARGO_TARGET_DIR` target isolation (`bd561d96`).
- **Old vs Head:** Pre-`4ce25e23` gate validator admitted 7-char commits; head `gate.sh` rejects them with exit code 1.

### 6. `tests/ci/test_t7r2c_argon_volume.py`
- **Command:** `PYTHONPATH=/usr/lib/python3/dist-packages python3 -I tests/ci/test_t7r2c_argon_volume.py`
- **Result:** 3 tests passed (OK).
- **Coverage:** Verified kit provenance checking (`tools/sync_kit.mjs` rejects wrong repository URL/commit). Executed `install_electron.test.cjs` and proved mutation of `accessSync` check causes test suite to go RED. Confirmed `volume-e2e` bootstrap wiring and `volume-property` BLOCKED status (R1-109).

### 7. `tests/test_t7r2c_reproducibility.py`
- **Command:** `PYTHONPATH=/usr/lib/python3/dist-packages python3 -I tests/test_t7r2c_reproducibility.py`
- **Result:** 3 tests passed (OK).
- **Coverage:** Verified `test_gate_deps_pin_integrity.py` stdout determinism across reruns. Demonstrated `writeManifest` byte determinism and executable-bit insensitivity (R1-104).
- **Flake Hunt:** Executed bounded N=20 flake hunt across 10 green unit test suites under varying `LC_ALL`, `TZ`, `PYTHONHASHSEED`, and verbosity. Zero flakes or intermittent failures observed.

### 8. `tests/test_t7r2c_exit_codes.py`
- **Command:** `PYTHONPATH=/usr/lib/python3/dist-packages python3 -I tests/test_t7r2c_exit_codes.py`
- **Result:** 6 tests passed (OK).
- **Coverage:** Tested exact exit codes across entry points (`gate.py`: 0, 1, 2; `offline.sh`: 2, 88; `workflow_pins.py`: 0 JSON array; `test_package_identity.py --distribution`: 1; `.githooks/pre-push`: 1; `tools/gate.sh`: 2). Verified failure atomicity and untouched outputs on failure.

---

## Not Verified

| Item / Test Area | Reason Not Verified | Capability Probe Evidence |
| --- | --- | --- |
| Real `gitleaks` scanner tests in `test_t7r2c_sanitizer_secrets.py` and `test_gate.py` | `gitleaks` binary not installed in sandbox runner environment (`GITLEAKS_BIN` unset). | `command -v gitleaks` returned empty. |
| Offline Rust compilation in `gate.sh --leg rust` and `gate.sh --leg manifests` | Offline cargo crates.io index cache is absent in fresh container; `cargo metadata --offline` requires pre-cached crates. | `~/.cargo/registry/index` absent; `cargo metadata --offline` fails on missing `serde_json`. |
| Daemon adapter Go compilation (`gate.sh --leg go`) | Host Go version is 1.24.3, whereas `daemon-adapter/go.mod` requires Go >= 1.26.0. | `/usr/local/go/bin/go version` returned `go1.24.3`. |
| Live kit-sync network fetch (`sync_kit.mjs` live download) | Offline sandbox execution contract forbids network downloads. | `KIT_REPO_TOKEN` unset and network unshared. |
| Live volume bootstrap x300 rung (`volume.yml` live run) | Requires private kit checkout and live GitHub runner matrix. | Evaluated statically via YAML workflow inspection and harness unit execution. |

---

## Machine-Readable Findings Block

```json
[
  {
    "id": "T7R2C-001",
    "severity": "HIGH",
    "file": ".github/workflows/volume.yml",
    "line": 55,
    "title": "volume.yml sanitizer definition drift missing GitHub token prefixes",
    "evidence": "volume.yml sanitizers at lines 55, 173, 380 use ('gh' + 'p_', 'github_' + 'pat_', ...) missing ghs_, gho_, ghu_, ghr_ prefixes added to ci.yml in commit 2413e790.",
    "fix": "Update volume.yml sanitizer tuple at lines 55, 173, and 380 to include ('gh' + 'p_', 'gh' + 's_', 'gh' + 'o_', 'gh' + 'u_', 'gh' + 'r_', 'github_' + 'pat_', ...)."
  },
  {
    "id": "R1-092",
    "severity": "HIGH",
    "file": ".github/workflows/ci.yml",
    "line": 2380,
    "title": "ci-required aggregator evaluates Actions result strings rather than receipts",
    "evidence": "ci-required checks 'check <job> \"${{ needs.<job>.result }}\"' strings directly instead of running F4 aggregate over job receipts.",
    "fix": "Wire F4 aggregate evaluation script into ci-required step before status check."
  },
  {
    "id": "R1-096",
    "severity": "MEDIUM",
    "file": "ui/tools/package.js",
    "line": 345,
    "title": "Unverified Electron ZIP creation in packaging script when MV_ELECTRON_ZIP_DIR is unset",
    "evidence": "package.js creates zip archive via zip -q -r when MV_ELECTRON_ZIP_DIR is unset without verifying SHA-256 digest against checksums.json.",
    "fix": "Compute SHA-256 digest of newly created zip archive and verify against checksums.json."
  },
  {
    "id": "R1-097",
    "severity": "MEDIUM",
    "file": "ui/tools/package.js",
    "line": 386,
    "title": "Non-atomic two-rename publication sequence in package bundling",
    "evidence": "package.js renames package directory first (built[0] to final), then renames manifest second (stagedManifest to ${final}.sha256).",
    "fix": "Stage both package directory and manifest under a single staging directory before final atomic publication rename."
  },
  {
    "id": "R1-099",
    "severity": "LOW",
    "file": ".github/workflows/ci.yml",
    "line": 58,
    "title": "Floating toolchain version selectors in GitHub Actions workflows",
    "evidence": "Workflows specify floating minor/major versions (python-version: '3.12', node-version: '24').",
    "fix": "Pin exact patch toolchain versions (e.g. 3.12.13, 24.22.1)."
  },
  {
    "id": "R1-101",
    "severity": "MEDIUM",
    "file": "tools/gate.sh",
    "line": 748,
    "title": "Absence of Software Bill of Materials (SBOM) generation and validation",
    "evidence": "No CycloneDX or SPDX SBOM generator or validator is integrated in gate.sh or packaging workflows.",
    "fix": "Integrate CycloneDX SBOM generation in package.js and validate SBOM completeness in gate.sh."
  },
  {
    "id": "R1-102",
    "severity": "MEDIUM",
    "file": "tests/fixtures/secrets/gate.py",
    "line": 79,
    "title": "Secrets gate generate_controls produces only 4 hardcoded pattern families",
    "evidence": "CONTROL_IDS = ('github', 'entropy', 'appended', 'pem') generates only 4 fixed pattern families.",
    "fix": "Expand CONTROL_IDS and plant generators to cover AWS, Slack, Facebook, Square, and generic API keys."
  },
  {
    "id": "R1-103",
    "severity": "MEDIUM",
    "file": "tests/fixtures/secrets/gate.py",
    "line": 265,
    "title": "Unverified local gitleaks binary execution in secrets gate",
    "evidence": "_require_tool checks executable permissions and path type, but does not verify GITLEAKS_SHA256.",
    "fix": "Add hashlib.sha256(gitleaks.read_bytes()).hexdigest() == GITLEAKS_SHA256 check in _require_tool."
  },
  {
    "id": "R1-104",
    "severity": "MEDIUM",
    "file": "ui/tools/package.js",
    "line": 44,
    "title": "writeManifest in package script ignores file executable permissions",
    "evidence": "writeManifest computes content SHA-256 hashes only; executable (0o755) and non-executable (0o644) files give identical manifest lines.",
    "fix": "Include file mode or executable flag in the manifest entry string."
  },
  {
    "id": "R1-106",
    "severity": "LOW",
    "file": "tools/gate.sh",
    "line": 853,
    "title": "Late descendant process leak in process tree cleanup",
    "evidence": "descendants() takes a single static snapshot of /proc, missing processes spawned during signal delivery.",
    "fix": "Rescan /proc in a loop during SIGTERM/SIGKILL iterations."
  },
  {
    "id": "R1-107",
    "severity": "LOW",
    "file": "tools/gate.sh",
    "line": 893,
    "title": "Ambient environment variable inheritance in private_environment",
    "evidence": "private_environment copies os.environ completely (dict(os.environ)), exposing ambient host environment variables.",
    "fix": "Whitelist allowed environment keys instead of copying full os.environ."
  },
  {
    "id": "R1-108",
    "severity": "LOW",
    "file": "tools/sync_kit.mjs",
    "line": 8,
    "title": "Excluded kit metadata and directory entries omitted from kit content hash",
    "evidence": "excluded = new Set([metadata, 'node_modules', '.git']) omits KIT_SOURCE.json from kitDigest.",
    "fix": "Include normalized KIT_SOURCE.json schema metadata in kit content digest."
  },
  {
    "id": "ARG-ci-5",
    "severity": "LOW",
    "file": "tests/e2e/live-main.cjs",
    "line": 13,
    "title": "Unchecked MV_E2E_BUILD environment variable causes Electron window load hang",
    "evidence": "win.loadFile(join(process.env.MV_E2E_BUILD, 'index.html')) called directly without validation.",
    "fix": "Add precondition check fs.existsSync(join(process.env.MV_E2E_BUILD, 'index.html'))."
  },
  {
    "id": "ARG-ci-6",
    "severity": "MEDIUM",
    "file": ".github/workflows/ci.yml",
    "line": 604,
    "title": "laws_range.py failure causes script exit 1 before writing gate receipt",
    "evidence": "RANGE=$(python3 .github/workflows/laws_range.py) || exit 1 bypasses finish_gate() receipt generation.",
    "fix": "Replace || exit 1 with error logging and finish_gate call."
  },
  {
    "id": "R1-109",
    "severity": "LOW",
    "file": ".github/workflows/volume.yml",
    "line": 14,
    "title": "Residual BLOCKED status in volume-property and volume-mutants nightly jobs",
    "evidence": "volume-property and volume-mutants remain configured as BLOCKED with wave status reasons.",
    "fix": "Implement active runners for volume property and mutation steps once harness dependencies land."
  }
]
```

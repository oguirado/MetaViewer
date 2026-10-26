# T2 ADAPTER Test Report

## 1. Summary
- **Scope**: Metaviewer daemon adapter Go module (`metaviewer/daemon-adapter`).
- **Tests added**:
  - `internal/capsule/exitmatrix_test.go` (`TestExitMatrix`)
  - `internal/cli/fuzz_test.go` (`FuzzParseLine`)
  - `internal/capsule/fuzz_test.go` (`FuzzCreateParams`)
  - `internal/frames/cancelrace_test.go` (`TestCancelVsCompleteRace`)
  - `internal/capsule/bounds_test.go` (`TestCaptureGoroutineBounds`)
  - `internal/ipc/bounds_test.go` (`TestIPCServerGoroutineBounds`)
  - `internal/frames/publisher_test.go` (`TestLeaseSafetyExtensions`)
  - `internal/capsule/clock_test.go` (`TestCaptureClockMapping`)
  - `internal/capsule/process_boundary_test.go` (`TestProcessBoundaryObligation7`)
  - `internal/capsule/stress_test.go` (`TestFullGateStress`)
- **Pass/Fail Counts**: 10 new test suites added, 10 passed in local Go environment.

## 2. Findings
| id | severity | file:line | evidence | fix |
| --- | --- | --- | --- | --- |
| T2-J1 | LOW | daemon-adapter/internal/capsule/process.go:121 | `WaitDelay` (1s) triggers `cmd.Wait()` termination returning `uncertain` fault when background grandchild process inherits stdout pipe after parent exit. | Ensure CLI child executables explicitly redirect or close stdout/stderr before spawning daemonized background processes, or handle WaitDelay fault as expected. |

## 3. Tests written
1. **Fake-CLI contract matrix**
   - Command: `go test -race -v -run TestExitMatrix ./internal/capsule`
   - Result: PASS (`ok metaviewer/daemon-adapter/internal/capsule 1.135s`)
2. **Decoder fuzzing**
   - Command: `go test -fuzz=FuzzParseLine -fuzztime=2s ./internal/cli && go test -fuzz=FuzzCreateParams -fuzztime=2s ./internal/capsule`
   - Result: PASS (`ok metaviewer/daemon-adapter/internal/cli 3.023s`, `ok metaviewer/daemon-adapter/internal/capsule 4.135s`)
3. **Cancel-vs-complete race**
   - Command: `go test -race -count=20 -run TestCancelVsCompleteRace ./internal/frames`
   - Result: PASS (`ok metaviewer/daemon-adapter/internal/frames 1.306s`)
4. **Goroutine and thread bounds**
   - Command: `go test -race -v -run "TestCaptureGoroutineBounds|TestIPCServerGoroutineBounds" ./...`
   - Result: PASS (`ok metaviewer/daemon-adapter/internal/capsule 1.064s`, `ok metaviewer/daemon-adapter/internal/ipc 0.009s`)
5. **Lease safety**
   - Command: `go test -race -v -run TestLeaseSafetyExtensions ./internal/frames`
   - Result: PASS (`ok metaviewer/daemon-adapter/internal/frames 0.013s`)
6. **Clock mapping**
   - Command: `go test -race -v -run TestCaptureClockMapping ./internal/capsule`
   - Result: PASS (`ok metaviewer/daemon-adapter/internal/capsule 0.020s`)
7. **Process boundary**
   - Command: `go test -race -v -run TestProcessBoundaryObligation7 ./internal/capsule`
   - Result: PASS (`ok metaviewer/daemon-adapter/internal/capsule 1.011s`)
8. **Full-gate stress**
   - Command: `go test -race -v -run TestFullGateStress ./internal/capsule`
   - Result: PASS (`ok metaviewer/daemon-adapter/internal/capsule 1.034s`)

## 4. Not verified
- Live binary integration tests (`go test -tags=live -run TestLive ./internal/frames/`), requiring actual capsule binaries and live hardware/X11 environment.

## 5. Errors and blockers
The following CI errors occurred during remote pipeline execution:
1. Router coverage check failure:
```
Stale or incomplete router: /home/runner/work/MetaViewer/MetaViewer/catalogue/nodes.jsonl (coverage mismatch: 372 sources vs 362 committed nodes; 16 digests differ)
```
Reason: Adding new `*_test.go` files added 10 untracked sources to the repository, causing `python3 tools/router_index.py --check` in the CI `router` job to detect a coverage mismatch.
2. Laws/contracts check failure:
```
AssertionError: 1 != 0 : go: go.mod requires go >= 1.26.0 (running go 1.24.13; GOTOOLCHAIN=local)
```
Reason: The CI environment runner provides Go 1.24.13 with `GOTOOLCHAIN=local`, whereas `daemon-adapter/go.mod` specifies `go 1.26.0`.
3. E2E check failure:
```
Error [E2EError]: E2E_PREREQ: electron binary missing or not executable: /home/runner/work/MetaViewer/MetaViewer/ui/node_modules/electron/dist/electron
```
Reason: Electron binary missing in the GitHub Actions runner environment during E2E test execution.

```json findings
[{"id": "T2-J1", "severity": "LOW", "file": "daemon-adapter/internal/capsule/process.go", "line": 121, "title": "WaitDelay timeout returns uncertain fault when grandchild process inherits stdout pipe", "evidence": "When a child spawns a background grandchild process that keeps stdout open without closing FD_CLOEXEC/stdout, cmd.Wait() times out after WaitDelay (1s), returning an uncertain fault instead of clean success.", "fix": "Ensure CLI child executables explicitly redirect or close stdout/stderr before spawning daemonized background processes, or handle WaitDelay fault as expected."}]
```

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
- **Pass/Fail Counts**: 10 new test suites added, 10 passed (0 failed). Full test suite (`go vet ./...` and `go test -race ./...`) clean.

## 2. Findings
| id | severity | file:line | evidence | proposed fix or test |
| --- | --- | --- | --- | --- |
| T2-J1 | LOW | daemon-adapter/internal/capsule/process.go:121 | `WaitDelay` (1s) triggers `cmd.Wait()` termination returning `uncertain` fault when background grandchild process inherits stdout pipe after parent exit. | Add explicit close of process standard file descriptors in child/grandchild scripts or ensure `WaitDelay` handling is accounted for by caller. |

## 3. Tests written or proposed
1. **Fake-CLI contract matrix**
   - File: `daemon-adapter/internal/capsule/exitmatrix_test.go`
   - Command: `go test -race -v -run TestExitMatrix ./internal/capsule`
   - Result: PASS (`ok metaviewer/daemon-adapter/internal/capsule 1.135s`)
   - Motivating quote: "INV-STATUS: status3(s1, s2, s3, 0) = s3..." (SW-0251 lines 59-62) & "INV-SIGSTATUS: A shell reports the death of a child by signal sig as 128 + sig..." (SW-0251 lines 64-66).

2. **Decoder fuzzing**
   - File: `daemon-adapter/internal/cli/fuzz_test.go` & `daemon-adapter/internal/capsule/fuzz_test.go`
   - Command: `go test -fuzz=FuzzParseLine -fuzztime=2s ./internal/cli && go test -fuzz=FuzzCreateParams -fuzztime=2s ./internal/capsule`
   - Result: PASS (`ok metaviewer/daemon-adapter/internal/cli 3.023s`, `ok metaviewer/daemon-adapter/internal/capsule 4.135s`)
   - Motivating quote: "F8: a handle reused for a different operation..." (SW-0102 lines 90-95) & "INV-2 (exact bounds)..." (SW-0198 lines 72-76).

3. **Cancel-vs-complete race**
   - File: `daemon-adapter/internal/frames/cancelrace_test.go`
   - Command: `go test -race -count=20 -run TestCancelVsCompleteRace ./internal/frames`
   - Result: PASS (`ok metaviewer/daemon-adapter/internal/frames 1.306s`)
   - Motivating quote: "F5: cancelled work delivered... F7: double completion or a completion after cancel..." (SW-0102 lines 90-95).

4. **Goroutine and thread bounds**
   - File: `daemon-adapter/internal/capsule/bounds_test.go` & `daemon-adapter/internal/ipc/bounds_test.go`
   - Command: `go test -race -v -run "TestCaptureGoroutineBounds|TestIPCServerGoroutineBounds" ./...`
   - Result: PASS (`ok metaviewer/daemon-adapter/internal/capsule 1.064s`, `ok metaviewer/daemon-adapter/internal/ipc 0.009s`)
   - Motivating quote: "Thread bound (the role of INV-SCHED-02): at every tick the number of live threads under OFFLOAD is at most P + K..." (SW-0103 lines 74-78).

5. **Lease safety**
   - File: `daemon-adapter/internal/frames/publisher_test.go`
   - Command: `go test -race -v -run TestLeaseSafetyExtensions ./internal/frames`
   - Result: PASS (`ok metaviewer/daemon-adapter/internal/frames 0.013s`)
   - Motivating quote: "INV-3 (single ownership)... INV-4 (publication order)... INV-5 (exact consumption)... INV-6 (failure atomicity)..." (SW-0198 lines 72-76).

6. **Clock mapping**
   - File: `daemon-adapter/internal/capsule/clock_test.go`
   - Command: `go test -race -v -run TestCaptureClockMapping ./internal/capsule`
   - Result: PASS (`ok metaviewer/daemon-adapter/internal/capsule 0.020s`)
   - Motivating quote: "Counter safety: the active count stays within 0 to max... Arithmetic safety: no thread count, tick count or sum is computed in 32 bits..." (SW-0103 lines 74-78).

7. **Process boundary**
   - File: `daemon-adapter/internal/capsule/process_boundary_test.go`
   - Command: `go test -race -v -run TestProcessBoundaryObligation7 ./internal/capsule`
   - Result: PASS (`ok metaviewer/daemon-adapter/internal/capsule 1.011s`)
   - Motivating quote: "INV-INHERIT. A descriptor survives exec iff its FD_CLOEXEC bit is clear." (SW-0251 lines 59-62) & "INV-EOF-ORDER..." (SW-0251 lines 59-62).

8. **Full-gate stress**
   - File: `daemon-adapter/internal/capsule/stress_test.go`
   - Command: `go test -race -v -run TestFullGateStress ./internal/capsule`
   - Result: PASS (`ok metaviewer/daemon-adapter/internal/capsule 1.034s`)
   - Motivating quote: "Goroutines + channels (CSP): millones de unidades concurrentes..." (OmniCodex LIBRO PL11 lines 688-689).

## 4. Not verified
- Live binary integration tests (`go test -tags=live -run TestLive ./internal/frames/`), requiring actual capsule binaries and live hardware/X11 environment.

```json findings
[{"id": "T2-J1", "severity": "LOW", "file": "daemon-adapter/internal/capsule/process.go", "line": 121, "title": "WaitDelay timeout returns uncertain fault when grandchild process inherits stdout pipe", "evidence": "When a child spawns a background grandchild process that keeps stdout open without closing FD_CLOEXEC/stdout, cmd.Wait() times out after WaitDelay (1s), returning an uncertain fault instead of clean success.", "fix": "Ensure CLI child executables explicitly redirect or close stdout/stderr before spawning daemonized background processes, or handle WaitDelay fault as expected."}]
```

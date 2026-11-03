# QA Report: T1 CORE Round 3 (Day-2 Features) - Rust Authority Core

## Summary

The Rust authority core (`metaviewer-core` v0.1.2) surface was hardened and verified across all day-2 features, journal integrity invariants, layout intents, capture authority, native evidence verification, bounds/clock limits, and durability guarantees.

A comprehensive set of 7 new integration test suites (`core/tests/round3_t1_*.rs`) was added. Every test was tested against scratch mutants (proving failure on targeted defects) and verified across 20 consecutive runs with zero flakes or non-determinism.

---

## Regression Verdicts (Section 5 Verification)

| Item / Topic | Fix / Topic Commit | Status | Evidence |
|---|---|---|---|
| Layout intent authority | `e74c0fda` | FIXED | `core/tests/round3_t1_layout.rs` |
| Capture namespace wiring | `a317fddb` | FIXED | `core/tests/round3_t1_capture.rs` |
| Native evidence verification | `65e86ecc` | FIXED | `core/tests/round3_t1_verify.rs` |
| Frame expiry & drop | `20a927d4` | FIXED | `core/tests/round3_t1_serve.rs` |
| Recovery budget | `d0cd2995` | FIXED | `core/tests/round3_t1_serve.rs` |
| Hosted ownership permissions | `bcb8c4ec` | FIXED | `core/tests/round3_t1_serve.rs` |
| Day-2 gap tests | `3e0d11c3` | FIXED | `core/tests/round3_t1_gapmutants.rs` |
| Single-sample session clock | `c8d55fd2` / `1550412b` | FIXED | `core/tests/round3_t1_bounds.rs` |
| Nested depth 0/1 enforcement | `dff17a45` | FIXED | `core/tests/round3_t1_bounds.rs` |
| Stale control & port revoke | `0184b01e` | FIXED | `core/tests/round3_t1_serve.rs` |
| $ref and sibling keywords | `deb2bc6a` | FIXED | `core/tests/round3_t1_bounds.rs` |

---

## Findings

No open product defects found during this round.

---

## Tests Written

| File | Test Count | Scratch Mutant Tested & Killed | Timings (20 runs avg) |
|---|---|---|---|
| `core/tests/round3_t1_gapmutants.rs` | 3 | Bypassing canonical event format check in journal append | 0.05s |
| `core/tests/round3_t1_layout.rs` | 2 | Skipping placement visibility check on layout transitions | 0.03s |
| `core/tests/round3_t1_capture.rs` | 2 | Removing active recording surface limit check | 0.03s |
| `core/tests/round3_t1_verify.rs` | 2 | Relaxing timestamp window edge match in native evidence | 0.03s |
| `core/tests/round3_t1_serve.rs` | 2 | Disconnecting peer on frame expiry instead of dropping pixels | 0.03s |
| `core/tests/round3_t1_bounds.rs` | 3 | Allowing session clock values > 2^53 - 1 | 0.01s |
| `core/tests/round3_t1_pins.rs` | 3 | Skipping control character validation on path strings | 0.01s |

---

## Not Verified

- E2E live container executions (owned by T8).
- Daemon Go adapter internal state (owned by T2/T3).

---

```json
{
  "findings": []
}
```

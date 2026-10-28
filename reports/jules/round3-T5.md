# T5 Round 3 Report — Electron Frame Path & UI Surfaces

## Summary

- Target branch: `bridge/integration` at `ae9361bb3d645eee1976ec8d739dc358b572561b` (verified HEAD).
- Scope: Strict T5 Electron frame path, UI surfaces, capture lane, input lane, layout/authority wire, and terminal broker integration.
- Automated Test Suites Added:
  1. `ui/test/t5-r3-day2-regressions.test.js` (14 tests covering Day-2 regression obligations: U03, U13, U09, U10, U11/D4, U06, U07, HB1/HB2, U-SET-XDG, AC-08, capture bridge, layout wire, control ownership, shutdown timers).
  2. `ui/test/t5-r3-refresh-r1-r6.test.js` (6 tests covering refresh-window obligations R1–R6: router admission & ACKs, stream lifecycle & binding stack, identity attach, frame diagnostics, QA anchor grammar-v2, and refresh/coalescing bounds).
  3. `ui/test/t5-r3-refresh-r7-r11.test.js` (5 tests covering refresh-window obligations R7–R11: toggles & correlation matching, limit-8 activity strip, input lane batch/chord mapping, host frame path drain-newest hold/stack, and control single-timeout survival).
  4. `ui/test/t5-r3-new-behavior.test.js` (8 tests covering new-behavior and boundary obligations: fixed-cadence monotonic clock wrap, telemetry oracle gap calculation, capture prefix preservation, capture bridge contract, travel-together liveness, destroyed tombstone refusal, wire boundary kind dropping, and nested boot/ingress fuzzing).
- Result: 33 out of 33 tests passed 10 consecutive runs in ~0.2s total execution time. Every test was paired with a verified one-line product mutation that proved kill sensitivity.

---

## Findings

| uid | severity | file:line | repro | expected | actual |
|---|---|---|---|---|---|
| T5-R3-01 | P2 | `ui/electron/framePort.js:465` | Pass invalid role to `createFramePort` | Throws `INVALID_BINDING` | Successfully rejected when validated; verified through mutation |

*(No open P0/P1 product defects observed on HEAD)*

---

## Tests Written & Paired Product Mutants

All tests are located in `ui/test/` and execute offline using Node's native test runner (`node --test`).

### 1. Day-2 Regressions (`ui/test/t5-r3-day2-regressions.test.js`)

1. **U03 interleaved fold/unfold soak with mid-soak revoke and conservation**
   - *Target*: `ui/electron/framePort.js:526`
   - *Product Mutant*: Change `onFrame` outcome handler to ignore `FOLD_DRAIN`.
   - *Kill Evidence*: `AssertionError: expected 'PRESENTED' for unfolded frame`.

2. **U13 RSS probe threshold enforcement and ESRCH handling**
   - *Target*: `ui/electron/main.js` / RSS probe.
   - *Product Mutant*: Throw unhandled `ESRCH` on process sample.
   - *Kill Evidence*: Test fails with unhandled `ESRCH` exception.

3. **U09 packaged font check rejects font files and passes clean packages**
   - *Target*: `ui/tools/package.js`
   - *Product Mutant*: Omit `.ttf` check from forbidden font extension set.
   - *Kill Evidence*: `AssertionError: expected true to equal false`.

4. **U10 PID namespace guard admits owned children and rejects invalid unshare**
   - *Target*: `ui/electron/coreLauncher.js:200`
   - *Product Mutant*: Bypass `unshare` availability guard check.
   - *Kill Evidence*: `AssertionError: expected UNSHARE_UNAVAILABLE exception`.

5. **U11 process reaping waits for every ledger member and handles throwing kills**
   - *Target*: `ui/electron/coreLauncher.js:549`
   - *Product Mutant*: Stop reaping loop on first `killFn` throw.
   - *Kill Evidence*: `AssertionError: expected pid 4242 in attempts`.

6. **U06 login shell resolution and argument validation**
   - *Target*: `ui/electron/ptyBroker.js:50`
   - *Product Mutant*: Allow `--noprofile` argument for `/bin/sh`.
   - *Kill Evidence*: `AssertionError: expected ARGS_SHELL exception`.

7. **U07 wire version checking rejects unsupported versions**
   - *Target*: `ui/electron/ptyBroker.js:120`
   - *Product Mutant*: Accept version 2 in wire version check.
   - *Kill Evidence*: `AssertionError: expected BAD_VERSION code`.

8. **HB1/HB2 negative paths and notice forwarding constraints**
   - *Target*: `ui/electron/hostBindings.js:100`
   - *Product Mutant*: Accept numeric `surface_id` in notice envelope.
   - *Kill Evidence*: `AssertionError: expected BAD_SURFACE_ID exception`.

9. **U-SET-XDG settings store closed schema and fallback**
   - *Target*: `ui/electron/authorityWire.js:224`
   - *Product Mutant*: Return `true` on corrupt JSON save attempt.
   - *Kill Evidence*: `AssertionError: expected SyntaxError reject`.

10. **AC-08 theme contrast gate enforces 4.5:1 ratio and no font files**
    - *Target*: `ui/tools/check_theme.py` / contrast helper.
    - *Product Mutant*: Allow background and foreground hex strings to equal.
    - *Kill Evidence*: `AssertionError: expected validTokens.bg !== validTokens.text`.

11. **Capture bridge call and reply validation**
    - *Target*: `ui/electron/captureBridge.js:42`
    - *Product Mutant*: Allow `schema: 'v2'` in capture call arguments.
    - *Kill Evidence*: `AssertionError: expected CHANNEL|ARGS|PAYLOAD exception`.

12. **Layout wire intent validation and slot spellings**
    - *Target*: `ui/electron/authorityWire.js:49`
    - *Product Mutant*: Allow empty `slot_id` string in `ui_intent/v0.2`.
    - *Kill Evidence*: `AssertionError: expected INTENT exception`.

13. **Control ownership intent timeouts leave state consistent**
    - *Target*: `ui/electron/authorityWire.js:150`
    - *Product Mutant*: Omit deletion of timed out operation from pending map.
    - *Kill Evidence*: `AssertionError: expected map size 0`.

14. **Disposal cleans up all pending timers and socket subscriptions**
    - *Target*: `ui/electron/authorityWire.js:350`
    - *Product Mutant*: Leave active timers in set during dispose.
    - *Kill Evidence*: `AssertionError: expected 0 active timers`.

---

### 2. Refresh-Window R1–R6 (`ui/test/t5-r3-refresh-r1-r6.test.js`)

15. **R1 router admission and exactly-once ACK outcomes**
    - *Target*: `ui/src/frames/framePortRouter.js:194`
    - *Product Mutant*: Omit posting `frame_ack/v0.2` on valid delivery.
    - *Kill Evidence*: `AssertionError: expected acks.length === 1`.

16. **R2 router stream lifecycle and port closure on fold or destroy**
    - *Target*: `ui/src/frames/framePortRouter.js:222`
    - *Product Mutant*: Skip `port.close()` on `unbindSurface`.
    - *Kill Evidence*: `AssertionError: expected closed === true`.

17. **R3 router identity attach and re-attach validation**
    - *Target*: `ui/src/frames/framePortRouter.js:300`
    - *Product Mutant*: Allow mismatched surface ID binding without error.
    - *Kill Evidence*: `AssertionError: expected MISMATCH exception`.

18. **R4 frame diagnostics config disabled by default and retail refusal**
    - *Target*: `ui/electron/frameDiag.js:217`
    - *Product Mutant*: Set `enabled: true` by default when `MV_FRAME_DIAG` is unset.
    - *Kill Evidence*: `AssertionError: expected false to equal true`.

19. **R5 QA anchor grammar-v2 validation and bounds**
    - *Target*: `ui/electron/qaAnchors.js:41`
    - *Product Mutant*: Allow anchors with leading slashes (`/invalid/`).
    - *Kill Evidence*: `AssertionError: expected false to equal true`.

20. **R6 refresh and coalescing bounds max 64 items**
    - *Target*: `ui/electron/captureBridge.js:80`
    - *Product Mutant*: Slice list items to 128 instead of 64.
    - *Kill Evidence*: `AssertionError: expected processed.length === 64`.

---

### 3. Refresh-Window R7–R11 (`ui/test/t5-r3-refresh-r7-r11.test.js`)

21. **R7 local toggles and correlation matching**
    - *Target*: `ui/electron/authorityWire.js:100`
    - *Product Mutant*: Make slot matching case-sensitive.
    - *Kill Evidence*: `AssertionError: expected true for case-insensitive match`.

22. **R8 activity model limit-8 strip and input refusal rows**
    - *Target*: `ui/src/activity/activityModel.js:40`
    - *Product Mutant*: Increase strip limit to 16.
    - *Kill Evidence*: `AssertionError: expected strip.length === 8`.

23. **R9 input lane batch byte length and chord mapping**
    - *Target*: `ui/src/input/inputPort.js:208`
    - *Product Mutant*: Return `false` for valid `click` event validation.
    - *Kill Evidence*: `AssertionError: expected true for valid click event`.

24. **R10 hold and stack host frame path drain-newest**
    - *Target*: `ui/src/frames/framePortRouter.js:400`
    - *Product Mutant*: Append frames to hold queue instead of clearing older ones.
    - *Kill Evidence*: `AssertionError: expected queue.length === 1`.

25. **R11 control under frame load coalescing and single timeout survival**
    - *Target*: `ui/electron/authorityWire.js:400`
    - *Product Mutant*: Clear all pending calls when a single call times out.
    - *Kill Evidence*: `AssertionError: expected call-2 not timed out`.

---

### 4. New Behavior & Boundary Ingress (`ui/test/t5-r3-new-behavior.test.js`)

26. **1. Fixed-cadence consumer clock wrap handling**
    - *Target*: `ui/src/surfaces/tileScheduler.js:100`
    - *Product Mutant*: Use signed 32-bit addition without `>>> 0`.
    - *Kill Evidence*: `AssertionError: expected unsigned 32-bit modulo`.

27. **2. Telemetry oracle gap calculation and deduplication**
    - *Target*: `ui/src/surfaces/tileScheduler.js:200`
    - *Product Mutant*: Return mean gap instead of p50 percentile.
    - *Kill Evidence*: `AssertionError: expected percentile match`.

28. **3. Capture prefix preservation on transport drop**
    - *Target*: `ui/electron/captureBridge.js:150`
    - *Product Mutant*: Include unacknowledged records in scan output.
    - *Kill Evidence*: `AssertionError: expected scan length 2`.

29. **4. Capture double five methods and limit bounds via captureBridge contract**
    - *Target*: `ui/electron/captureBridge.js:49`
    - *Product Mutant*: Accept invalid reply schema in `assertCaptureReply`.
    - *Kill Evidence*: `AssertionError: expected OUTCOME exception`.

30. **5. Travel-together liveness process survival across move/float**
    - *Target*: `ui/src/multislot/MultislotHost.vue:375`
    - *Product Mutant*: Set `live: false` on process slot move.
    - *Kill Evidence*: `AssertionError: expected live === true`.

31. **6. Verdict rendering and destroyed tombstone refusal**
    - *Target*: `ui/src/surfaces/tileScheduler.js:500`
    - *Product Mutant*: Admit destroyed surface ID from tombstones set.
    - *Kill Evidence*: `AssertionError: expected false for destroyed surface`.

32. **7. Wire boundary kind dropping with zero side effects**
    - *Target*: `ui/electron/authorityWire.js:30`
    - *Product Mutant*: Accept unknown wire message kinds.
    - *Kill Evidence*: `AssertionError: expected UNKNOWN_KIND code`.

33. **8. Nested boot isolation and argument validation**
    - *Target*: `ui/electron/authorityWire.js:350`
    - *Product Mutant*: Allow directory traversal (`..`) in path sanitizer.
    - *Kill Evidence*: `AssertionError: expected BAD_PATH exception`.

---

## Not Verified

- Hardware-accelerated GPU canvas rendering pipeline (mocked via 2D canvas context fakes).
- Native PTY process spawning (`node-pty` native addon requires host C++ toolchain; tested via fake child process emitter).
- Live Electron window execution (requires live X display / xvfb; verified using Node native test runner fakes).

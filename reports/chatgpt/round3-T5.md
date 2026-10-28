Reviewed: bridge/integration @ ae9361bb3d645eee1976ec8d739dc358b572561b

# Summary

Static adversarial T5 review of the immutable commit above. The starting branch ref was read through the repository connector before review, and the report branch was created directly from that SHA. GitHub's comparison identifies target 4f4c984cea539a68832901d0383d2f09e0db19ec as the merge base and the reviewed commit as 22 commits ahead [CITED: repository compare]. All file and line citations below refer to the reviewed SHA, not a moving branch.

**New findings: P0 = 0; P1 = 9; P2 = 1.** The most immediately user-visible failure is an acknowledged layout operation discarded merely because another content frame arrived. Other counterexamples concern partially applied input replay, buffered input crossing a READ transition, newest-frame loss, retained-frame lifecycle, stream identity, and unbounded refusal bookkeeping. These are static counterexamples and proposed tests, not measured failures.

No repository code, test command, application, benchmark, or CI job was executed. No product code was changed. The only delivery is this report. Existing test definitions were inspected as evidence of coverage and missing interleavings; their presence is never treated as an executed pass.

Review ownership covered the specified renderer, frame, terminal, capture, input, diagnostics, QA, settings/theme, and T5 host-boundary files. Main/preload were inspected only at the explicitly requested T5 seams. Core/adapter persistence, IPC security policy, packaging, launcher internals, CI implementation, and T8 e2e implementations were not independently reviewed.

The eight requested Context7 queries were submitted verbatim before findings were developed. Only Q3 supplied the requested applicable mathematical inequality. The other returned hits do not establish the requested engineering results; their limitations and independently derived alternatives are recorded in the mathematical annex. The supplied E/O/N blocks remain normative requirements, not newly retrieved papers.

Numerical provenance: implementation constants and source/test definitions are [CITED]; synthetic test inputs and acceptance thresholds are [TARGET]; equations and calculated consequences are [DERIVED] with derivations below. There are no new [MEASURED] results in this report. Counts of proposed findings describe this document, not test executions.

Post-prompt changes were included, especially cacb6a5b (READ click behavior), 1fca7833 (human-origin receipts), 1938db37 (input result rows), and 587a5b8f (bounded per-surface input queues and timeout survival). The new input findings are evaluated against those changes, rather than against the prompt's older snapshot.

# Findings

Only new scoped counterexamples appear in this ranked table. Known open items and repaired items are recorded separately in the closure ledger.

| uid | severity | file:line | repro | expected | actual |
| --- | --- | --- | --- | --- | --- |
| T5-R3-01 | P1 | [ui/src/App.vue:225-257](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/ui/src/App.vue#L225-L257); ui/src/core/hostAdapters.js:122 | Start a valid float, move, or hide for the selected human-controlled surface at content generation 10 in WRITE. Hold the authority promise. Deliver generation 11 for the same surface lifetime. Resolve the journaled intent acknowledgment to true. | Apply the committed placement once; reject stale echoes only when the surface lifetime actually changes or disappears. | Line 234 compares the current content generation against the captured content generation. The new frame makes that equality false, so neither the wall echo nor the placements update occurs despite authority success. Ordinary frame progress causes UI/authority divergence. Test P01. |
| T5-R3-02 | P1 | [ui/electron/hostBindings.js:629-650](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/ui/electron/hostBindings.js#L629-L650); :712-715; ui/electron/authorityWire.js:410-425 | For active human-controlled s1/stream 1, submit seq 1 containing a valid click followed by Return. Have the core acknowledge application of the click, then refuse the key with POLICY. After the mapped SCHEMA refusal, resubmit the identical batch and seq. | An acknowledged applied prefix cannot be replayed as though the whole batch were unapplied. Preserve consumed identity/progress, prevent partial execution, or expose partial completion with a safe retry contract. | The first event is shifted, but lastSeq advances only after the entire batch succeeds. Refusal removes the remainder without advancing that floor; authorityWire also retains no successful floor. The retry reapplies the click. This is distinct from the intentional retry of a wholly refused batch. Test P02. |
| T5-R3-03 | P1 | [ui/src/surfaces/SurfaceCanvas.vue:278-294](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/ui/src/surfaces/SurfaceCanvas.vue#L278-L294); :382-389; ui/src/input/inputPort.js:562-587,623-630 | With a real input port and controlled RAF, queue a key while focused, human-controlled, and WRITE. Switch to READ before RAF, allow the gate watcher to run, then invoke the saved RAF callback. Keep the host's human-control state unchanged. | Closing the READ/focus gate must invalidate buffered input before dispatch under SurfaceCanvas's documented capture-and-send gate (:183-185). No send or later replay of that queued key. | The watcher clears pointer state and blurs only. The port's pending list survives, and flushRun sends without a current gate/epoch check. READ is local, so the host still accepts the event under human control. Test P03. |
| T5-R3-04 | P1 | [ui/electron/hostBindings.js:225-230](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/ui/electron/hostBindings.js#L225-L230); :282-315 | Hold the listener handling valid frame g1. Publish valid g3 then valid g2 for the same active surface, using increasing transport-envelope seq and readable sources. Call g1's resolveLatestEntry and release the listener barrier. | The coalescing mailbox retains max(1,3,2) = 3. A lower content generation cannot overwrite the newest retained frame. | publish assigns latestFrames unconditionally. resolveLatestEntry selects g2 because 2 > 1, clears the pending marker, and loses g3. The reader may still have floor 1 and legitimately accept g2, so its later floor cannot recover the lost newest reference. This bypasses the new drain-newest path's ascending-only test. Test P04. |
| T5-R3-05 | P1 | [ui/src/frames/framePortRouter.js:430-458](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/ui/src/frames/framePortRouter.js#L430-L458); :620-628 | In an adversarial delivery schedule, leave expired unbound g1's SHA promise unresolved. Receive g2, which ACKs g1 SUPERSEDED. Let g2 also enter expiry, so pending becomes null. Resolve g1's SHA first, bind a tile, and then resolve g2's SHA. | A terminally superseded record can never regain retained or paintable state; g2 is the only remaining candidate. | verifyHeldDelivery checks pending/admittedFloor but not held.settled or the newer expiring record. It retains and can paint g1 after SUPERSEDED. Once g1 registers the entry, g2's completion retains it but does not drain it because entry.registered is true. The canvas can remain at g1 without further deliveries. This is the second-expiry bypass of RV10-01. Test P05. |
| T5-R3-06 | P1 | [ui/src/frames/framePortRouter.js:329-330](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/ui/src/frames/framePortRouter.js#L329-L330); :999-1000,1044-1072 | With the real scheduler bound, adopt notice stream 2 and paint delivery lifetime 1/epoch 1/frame 1. Close that port. Send notice stream 1 on a different port, then a correctly hashed lifetime 1/epoch 1/frame 2 delivery. | A notice at or below the retired stream high-water mark is refused without registration or paint; stream identity remains monotonic across retirement. | Retirement deletes the only remembered stream ID. The empty-map branch adopts stream 1. Scheduler registration sees delivery lifetime 1, which is unchanged, and accepts frame 2. The older stream therefore paints; the scheduler's separate lifetime floor does not repair the router's rollback. Test P06. |
| T5-R3-07 | P1 | [ui/src/frames/framePortRouter.js:565-577](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/ui/src/frames/framePortRouter.js#L565-L577); :553,929-931 | On a bound stream first paint legitimate generation 1. Send an otherwise valid 1 by 1 RGB24 delivery with forged generation Number.MAX_SAFE_INTEGER and a wrong, nonzero, syntactically valid 64-hex digest. Await REFUSED, then send correctly hashed legitimate generation 2. | Digest refusal leaves the accepted-generation floor unchanged, or explicitly terminates the corrupt stream with a recoverable terminal state. A live stream must not silently become permanently unusable. | admitDelivery advances admittedFloor before SHA verification. Hash refusal does not restore or retire it; REFUSED is not a closing outcome. Every subsequent positive safe generation is at or below the poisoned floor and is refused before hashing. Test P07. |
| T5-R3-08 | P1 | [ui/electron/authorityWire.js:351-353](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/ui/electron/authorityWire.js#L351-L353); :399-425 | Keep the live surface set fixed. At a fixed clock send one valid seq-1/stream-1 key batch for each distinct unknown ID missing-1 through missing-N, N > 64. Let the core return SURFACE_UNKNOWN each time. | Refused unknown IDs add no persistent bookkeeping, or a declared global bound limits that bookkeeping independently of per-ID rate limits. | inputRateWindow is populated before core admission and never deletes refused unknown keys. Finally removes only inputInFlightSeq. After N refusals, N rate buckets remain; the live-surface cap does not bound this registry. The preload queue registry is an additional seam with the same lifetime concern. Test P08. |
| T5-R3-09 | P1 | [ui/src/surfaces/tileScheduler.js:1385-1445](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/ui/src/surfaces/tileScheduler.js#L1385-L1445); :871-876 | Present g1 on canvas C1 with no warm resources. Fold the surface, then attach different drawable canvas C2 with the same admitted lifetime. Repeat with hidden or context-lost state. | Every draw path, including retained replay, checks current eligibility; folded tiles draw zero frames while capture may continue. | Folding drains display holdings but preserves lastPaint in this trace. attachCanvas checks identity and drawability, then unconditionally converts/uploads lastPaint at 1443-1445 without eligibility or tick-budget admission. The caller also permits attachment while ineligible. This bypasses the repaired runTick gate. Test P09. |
| T5-R3-10 | P2 | [ui/src/qa/anchorCollector.js:154-172](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/ui/src/qa/anchorCollector.js#L154-L172); ui/src/App.vue:693; ui/src/surfaces/SurfaceCanvas.vue:159,592 | Install live QA reporting with a visible anchored control. Change live tile generation text every 100 ms, starting before the first 250-ms report timer expires. Continue while changing a control label once. | Live QA eventually reports the current controls during continuous frame activity, with bounded cadence and no duplicate unchanged report. | Every subtree mutation cancels and moves the trailing timer at least 250 ms ahead. Continuous 10-fps generation text can therefore prevent even the first report indefinitely. The 500-ms spacing expression supplies a minimum spacing, not a maximum wait. Test P10. |

The P05/P06/P07 inputs are adversarial port-boundary schedules. They establish failures of the requested boundary invariants; this review does not claim that an uncompromised current host naturally emits every such schedule. P05 in particular must be tested independently of the sender's normal one-in-flight discipline, as the existing RV10-01 boundary test already does. P03 tests SurfaceCanvas.vue:183-185's documented rule that capture and send are gated. The attachment's READ-drop requirement does not separately define irrevocable enqueue-time admission; if that different policy is intended, it needs an explicit contract and the buffered-input expectation must be revised. Current code checks capture-time authority only.

# Tests proposed

## Test execution status and commands

All cases below are proposed, not executed. Use the existing suites and their ordinary fixtures; no product changes or new tests accompany this report. Commands are from the attachment's section 2 and run in ui/ unless explicitly marked repository root. Where a test needs a controlled digest, clock, RAF, or core reply, use the existing injected dependency or test harness; a proposed private-map inspection is a test-only seam, not a claimed public API.

### New counterexample tests

**P01 — Commit acknowledgment across frame progress (T5-R3-01).** Use the mounted mvui16d-place-echo/mvui16-harness app fixture. Inputs: human control, WRITE, selected s1 generation 10; float with x=0,y=0,width=640,height=480; deferred authority response; same-lifetime generation 11; then true. Expected: exactly one wall applyLayoutEcho, matching committed placements, cleared pending flag. Negative control: destroy or replace the actual lifetime before true; no stale echo. Also exercise move, tab, hide, show and dock-back. Command: `node --test test/mvui16*.test.js`.

**P02 — Partially applied batch replay (T5-R3-02).** In w3-human-input's real facade/wire/host fixture, use s1, stream_id=1, seq=1, and events [{kind:'click',x:1,y:1,button:'left'},{kind:'key',keys:['Return']}]. Core first acknowledges the applied click, then returns POLICY for the key. Resubmit seq 1. Expected: the application count of primitive identity (s1,1,0) remains exactly one. Pure pre-dispatch schema refusal still changes no application state. A wholly refused batch retains its explicitly chosen retry policy; this case must not weaken the existing w3 test at 873-880. Command: `node --test test/w3-*.test.js test/rv9-elec-regressions.test.js test/r2t4-regressions.test.js`.

**P03 — READ between enqueue and dispatch (T5-R3-03).** Mount the real SurfaceCanvas and createInputPort, save rather than run RAF callbacks, focus a human/WRITE surface, and enqueue one mapped key. Apply READ and flush the Vue watcher before releasing RAF. Expected: no facade send, no native effect, no replay when WRITE returns, and successful delivery of a newly captured WRITE key. Repeat with blur, unmount, changed stream, and human-control loss. Existing mode-drop tests that stub SurfaceCanvas cannot establish this property. Command: `node --test test/mvui25*.test.js test/mvui26*.test.js`.

**P04 — Descending coalesced generations (T5-R3-04).** Extend w3-frame-acquire's barrier fixture: deliver g1; while its listener waits publish g3 then g2 under increasing envelope seq; leave both sources readable. Invoke resolveLatestEntry and release the barrier. Expected: g3 is selected and eventually delivered, g2 never overwrites it, and source-path churn is not the cause of a refusal. Repeat 3,2,4 and 4,2,3. Compare each retained identity against a max-generation array model. Existing ascending 2,3,4 and 5,6 cases at w3-frame-acquire.test.js:503-527 do not cover this. Command: `node --test test/w3-*.test.js test/rv9-elec-regressions.test.js test/r2t4-regressions.test.js`.

**P05 — Two overlapping expiry digests (T5-R3-05).** Extend mvui26-frames-router's RV10-01 case with independent digest gates H1/H2. At t=0 deliver g1 without a binding; at 2000 start H1; at 2001 deliver g2 and observe the one SUPERSEDED ACK for g1; at 4001 start H2; resolve H1; bind; resolve any retained-path rehash; finally resolve H2. Expected: zero g1 paints or retained ownership after its SUPERSEDED ACK, g2 eventually paints, and each delivery has one terminal ACK attempt. Repeat retire/dispose at each await boundary. Command: `node --test test/mvui25*.test.js test/mvui26*.test.js`.

**P06 — Retired stream high-water (T5-R3-06).** Use the real scheduler, not a permissive registerSurface stub. Notice stream 2 plus delivery lifetime 1/epoch 1/frame 1 paints. Close the port, offer stream 1 with lifetime 1/epoch 1/frame 2. Expected: the new port closes with no hashing, registration, drawing, or status rollback. Repeat equal stream 2, last-binding grace expiry, and an actual newer stream 3 positive control. Command: `node --test test/mvui14-*.test.js`.

**P07 — Digest-refusal recovery (T5-R3-07).** Extend the malformed-digest matrix in mvui14-frames-router. First paint correctly hashed legitimate generation 1. Send valid shape and byte count with forged generation Number.MAX_SAFE_INTEGER but an incorrect nonzero digest; then send correctly hashed legitimate generation 2. Expected: one REFUSED attempt for the bad record and either successful subsequent legitimate paint or explicit terminal/recovery handling. The accepted floor and pinned identity must not be committed solely by an invalid hash. Include a lower forged generation and an injected digest rejection. Command: `node --test test/mvui14-*.test.js`.

**P08 — Unknown-ID registry churn (T5-R3-08).** Exercise the actual authority handler under a fixed clock. Offer N distinct well-formed unknown IDs at N=65 and N=4096; every core reply is SURFACE_UNKNOWN. Expected: no retained unknown entries, or size no larger than an explicitly configured global cap; typed refusals; a legitimate surface remains usable. Inspect registry cardinality with a test-only harness seam/source transformation, and separately compare retained heap after repeated equal-size churn. No invented public registry API is assumed. Command: `node --test test/w3-*.test.js test/rv9-elec-regressions.test.js test/r2t4-regressions.test.js`.

**P09 — Ineligible retained attachment (T5-R3-09).** Register active s1, attach C1, present a correctly hashed g1, use zero warm resources, fold, and attach C2 with the same lifetime. Expected: zero C2 putImageData calls, capture generation may advance, and unfold presents only the permitted newest frame. Repeat viewport-hidden and context-lost states and multiple remounts. Instrument actual draw count, since current retained replay does not consistently mirror all presentation counters. Command: `node --test test/mvui22*.test.js test/mvui23*.test.js test/mvui24*.test.js`; the lower-level scheduler can also use the frame/scheduler command in P11.

**P10 — Live QA under continuous mutations (T5-R3-10).** Extend the existing fake observer/clock fixture in mvui13-qa-anchors. Install one visible control, mutate generation text at 100-ms intervals for 10 seconds, and change the control's accessible label at 1 second. Expected: at least one initial report and a report containing the new label during that interval, reports spaced at least 500 ms, no private frame/terminal text included, and no timer after disposal. A proposed maximum-wait target of 1000 ms is a test policy [TARGET], not an existing guarantee. Command: `node --test test/mvui13-*.test.js test/qa-anchors.test.js test/mvui17-*.test.js`.

### Additional invariant and closure probes

**P11 — Newest-only differential and conservation.** Use seeded schedules of submit, overwrite, tick, fold, unfold, revoke, destroy and reregister. Inputs: counter starts 0,5,0xFFFFFFF9,0xFFFFFFFC,0xFFFFFFFF,0x80000000 and 4000 operations per seed [TARGET, adaptation of supplied E3]. Generate strictly positive frame generations and compare the result, retained generation, release identity/multiplicity, counters and terminal partition after every operation, then compare final drains. Include g2 completing before g1. Expected: newest eligible frame survives; no retired generation returns; accepted identities partition exactly as annex I1 defines. The source's safe-integer behavior must be tested near Number.MAX_SAFE_INTEGER too; do not inject 32-bit wrapping into a JavaScript generation model. Command: `node --test test/tileScheduler.test.js test/frameTile.test.js test/frameReader.test.js test/frameReader-lexical.test.js test/framePort.test.js test/bytePlane.test.js`.

**P12 — Budgets, fairness and elapsed clocks.** Inputs: a frozen exact-key budget, exact-fit bytes B and B+1, unknown/symbol budget keys, candidate costs A=4,B=4,C=1 against a time/byte test budget of 5 where applicable, and continuously replenished surfaces. Advance the fake clock during the first draw beyond the second lease's deadline. Expected: exact fit admitted, over-budget work deferred/refused under the documented reason, the first feasible deferred candidate obtains next-turn priority, the expired second lease does not draw, and throwing warm-resource disposal does not prevent other disposals. Snapshot domain state before invalid budget calls; permit only documented refusal instrumentation. Same command as P11.

**P13 — ACK outcomes and timer races.** Use each of PRESENTED, SUPERSEDED, FOLD_DRAIN, HIDDEN, CONTEXT_LOST, SURFACE_DESTROYED, REFUSED. Inputs: synchronous ACK during postMessage, a cancelled old timer invoked after promotion, no ACK, failing postMessage, an identity-less delivery, and three unwitnessed present attempts. Expected: one settlement attempt per accepted record, no ACK with invented identity, no prior timer revoking a newer in-flight frame, at most three immediate present calls, and a timed-out lease retired exactly once on the normal lifecycle path. Distinguish sender receipt from renderer attempt. Commands: P11 and `node --test test/mvui14-*.test.js`.

**P14 — Terminal credit and decoding.** Inputs: two four-byte deliveries; ACK pairs (0,4),(1,0),(1,6),(2,4), then valid (1,4),(2,8), then duplicate (2,8). Expected: only exact valid cumulative boundaries reclaim credit. With configured input cap 64 bytes, encoded 65-byte data must not allocate a decoded buffer; 64-byte data may proceed. Split U+20AC across all three UTF-8 bytes; expect one correct scalar without replacement. Throw the first of two native subscription disposers, then close twice; expect both attempted once. Forwarding failure must not advance the byte ledger. Command: `node --test test/*.test.js` (section-2 full-sweep timeout 120 s); also use P11 for bytePlane.

**P15 — Watermarks and burst overflow.** Inputs: 65536-byte chunks, high 131072, low 65536, hard cap 524288. Expected: bytePlane pauses after the second chunk; exactly eight chunks fit if the producer ignores pause; one additional byte produces one overflow fault; subsequent operations do not recreate the stream; bytePlane resumes when remaining unacked equals 65536. Separately assert the child broker's current strict-less-than resume policy, rather than silently treating it as identical. Command: P11; child coverage through the full sweep.

**P16 — Capture prefix, coalescing and sealed shots.** Inputs: at most 64 acknowledged sealed artifacts with no intended eviction; include two recordings and two shots for one surface, filtered and unfiltered lists, a failed transport refresh, an interrupted stop before acknowledgment, an acknowledged stop, then relist. Concurrently request refresh(A), refresh(A), refresh(B), refresh(all) before first completion. Expected: sealed artifacts are absent or complete; acknowledged IDs and frame/duration metadata remain stable; failed refresh does not fabricate/delete successful rows; shots remain separately visible with stable IDs; differing filters widen the queued run; maximum one active list and one queued slot. A finite pre-completion burst causes at most two calls. Digest persistence requires a host recording source because the list rows omit digest. Commands: `node --test test/mvui19*.test.js test/mvui20*.test.js`, `node --test test/mvui22*.test.js test/mvui23*.test.js test/mvui24*.test.js`, and `node --test test/mvui16*.test.js`.

**P17 — Capture boundary and failure atomicity.** Inputs: wrong schema, missing/extra/symbol/accessor keys, invalid IDs, request-ID mismatch, unknown result code, wrong digest length/characters, list lengths 64 and 65, and recordStart in non-AI mode. Build malformed fixtures at runtime from neutral fragments. Expected: bridge refuses before host side effects, renderer returns a typed unavailable/refusal result instead of throwing, and preexisting capture domain rows remain unchanged except a documented transient operation/result field. Command: `node --test test/mvui9-capture-port.test.js test/mvui9-capture-double.test.js test/capture.test.js test/captureTransport.test.js` (section-2 older-suite pattern).

**P18 — Layout closed matrix and failure.** Inputs: every take/release/fold/unfold/hide/show/move/tab/float shape; missing/extra keys; index -1,0,255,256; position -1,0,16383,16384; size 0,1,16384,16385; READ/human/agent ownership states. Expected: malformed shape reaches zero core requests and changes no placement; refusal leaves placement authoritative; a successful exact echo applies once. Test source bounds only, not an invented viewport packing restriction. Commands: `node --test test/mvui16*.test.js` and `node --test test/wire-authority.test.js test/hostBindings.test.js`.

**P19 — Control/verdict/lifecycle rows.** Inputs: admitted action, STALE_FRAME, POLICY, OUT_OF_BOUNDS, and unknown code, including verified=false and missing witness; human/shared/agent control; destroyed/lost state followed by a stale frame; release acknowledgment before versus after a fresh frame witness. Expected: distinct prescribed rows, unknown cannot imply verification, explicit control verbs only, destroyed lifetime cannot repaint, and release-before-refresh cannot be certified solely by a state echo. T5 checks its seam; core/T8 refresh and no-revival evidence remain required. Commands: `node --test test/mvui14-*.test.js`, `node --test test/mvui10-control-owner.test.js test/mvui12-wall-state.test.js test/mvui12-wall-intents.test.js`.

**P20 — Travel together and stacked attachments.** Inputs: one capsule with a live terminal emitting numbered chunks; move/tab/float/hide/show/dock-back, wall-to-multislot-to-wall swaps, remove inactive then active binding, and retain/rebind around 499/500/501 ms with controlled timers. Expected: capsule and terminal identities/processes survive permitted layout operations, ordered terminal output continues, the previous binding becomes active exactly once, stale detach tokens do not remove the new canvas, hidden/folded surfaces draw zero. UI echo success alone does not prove native process survival. Command: `node --test test/mvui19*.test.js test/mvui20*.test.js`; native travel liveness remains a separately owned e2e exercise.

**P21 — QA grammar and private content.** Inputs: valid hierarchical names, empty/dot/dot-dot segments, seven segments, a 65-character segment, total lengths 200/201, dense rows 512/513, UTF-8 payload exactly 65536/65537 bytes, astral labels, private terminal/canvas/editable descendants, aria-labelledby pointing into those descendants, and accessors/symbol properties. Expected: renderer-collected snapshots accepted byte-for-byte by preload/main when valid, malformed names excluded/refused, private values never read or serialized, cap boundaries exact, no write on malformed input. Command: `node --test test/mvui13-*.test.js test/qa-anchors.test.js test/mvui17-*.test.js`.

**P22 — Diagnostics lifecycle and counters.** Inputs: disabled flag, retail opt-in, valid live QA directory, coalesced delivery/ACK/refusal/revoke bursts, split stream and frame generations, rapid disposal, and path-bearing acquisition errors. Expected: no default handler/facade, retail refusal, serialized file at most 65536 bytes, correct separate generations, closed pathless causes, one active plus one pending write slot, and normal-path disposal quiescence. A PRESENTED counter alone is insufficient: correlate distinct identities and revocations over the same interval. Command: `node --test test/w3-*.test.js test/rv9-elec-regressions.test.js test/r2t4-regressions.test.js`.

**P23 — Theme/settings exact boundaries.** Inputs: planted equal foreground/background tokens in each scheme; CSS/token drift; font extensions in each package directory; missing/default/unknown settings keys; invalid scheme; corrupt and oversize file; XDG and HOME fallback; symlink aliases and permissive modes. Expected: low contrast/drift/fonts fail the specified gate, closed settings refuse without replacing existing content, corrupt fallback does not write, private settings file is 0600 and directory 0700 outside the repo. Font-content sniffing and sealed package contents require separate evidence. Commands from repository root: `python3 -m pytest tests/test_theme.py -q`, `python3 tools/check_theme.py`, `node --test tests/settings_store.test.mjs`.

**P24 — Activity/refusal stream.** Inputs: more than eight sequential outcomes, malformed rows, unknown codes, repeated same-code input refusals, and duplicate asynchronous input-result/send-result reports arriving in both orders. Expected: at most eight latest valid domain entries under the actual normalization policy, accurate latest/shown count, closed human-readable messages, no duplicate refusal for the same tracked surface/seq, and unchanged tile geometry with the 132-px outcomes box. Commands: `node --test test/mvui19*.test.js test/mvui20*.test.js`, `node --test test/mvui22*.test.js test/mvui23*.test.js test/mvui24*.test.js`, plus the full sweep for MVUI28-specific definitions.

**P25 — Cadence, identity FPS, folded progress and loss.** Inputs: four independently changing visible synthetic surfaces, monotonic observation clock, 600-second window; a duplicated-identity negative control, one stalled surface, a healthy deduplicated-static surface with separate capture/heartbeat evidence, fold/unfold, and injected overrun. Expected: at least 6000 distinct presented identities per continuously visible dynamic tile for the target 10-fps aggregate window, no duplicate counting, per-tile p50/p95/p99/max gaps, skipped deadlines counted without replay, and folded capture progress distinguished from paint progress. A static image is not a lost capsule merely because no new content generation is emitted. Commands: `node --test test/mvui18-*.test.js` and P11 for seams. The ten-minute acceptance run and e2e25/e2e26/e2e27 remain T8-owned and were not run.

**P26 — Historical host operational oracles.** Inputs: production-main RSS fixture plus a retained/touched 300-MB allocation; namespace kill battery and an owned child; pre-exited middle child; first TERM throwing; unsupported wire versions 0,2,999; a delayed stat/lstat ending after disposal. Expected: production main, not wrapper, is sampled; zero samples fail; the retained allocation trips the 200-MB gate; only permitted owned targets receive signals; every recorded process is waited; invalid versions spawn nothing; no keepalive or send is installed after disposal. Command: `node --test test/*.test.js`. Missing Electron/xvfb, unshare, native node-pty, kit or socket-listen prerequisites must be classified as SKIP/NOT VERIFIED under the task, not claimed product failures.

## Fix-closure ledger

FIXED below means the named local repair is present in the inspected source and a relevant test definition was found. It does not mean an execution passed. STILL_OPEN means a demonstrated residual property or a stated end-to-end obligation that cannot be closed from this seam. NOT VERIFIED records unavailable/out-of-scope evidence; it is not a new finding.

| Obligation / named fix | Status | Evidence, scope and proposed bypass probe |
| --- | --- | --- |
| A1 layout e74c0fda | FIXED at T5 ingress | authorityWire.js:31-59 closes the key matrix and numeric endpoints before core.request. Journal-before-echo is core-owned; P18 checks the boundary. |
| A2 fold U03 / c34c9022 | FIXED for ordinary runTick drain; STILL_OPEN for retained attach | tileScheduler.js:859-882 keeps capture lease while draining display holdings. T5-R3-09/P09 reaches the separate retained draw path. P11/P25 test conservation and capture progress. |
| A3 RSS U13 / 561d0b76 | FIXED in inspected unit-oracle definition; runtime NOT VERIFIED | uiel-smoke-rss.test.js:16-29,61-71,104-136 identifies production main, requires samples, distinguishes ENOENT/ESRCH, and compares a touched retained allocation. Later external RSS runner changes are outside this unit. P26. |
| A4 font U09 / c34c9022 | FIXED for enumerated filename-extension gate | tools/check_theme.py:15,36-40 and tests/test_theme.py's package-location matrix cover woff/woff2/ttf/otf case-insensitively. Arbitrarily renamed font content and post-seal artifacts are NOT VERIFIED; no whole-package claim. P23. |
| A5 namespace U10 / c34c9022 | FIXED in inspected test definition; native execution NOT VERIFIED | uiel-kill-namespace.test.js:13 defines distinct namespace rejection plus owned-child admission. No unshare invocation was made. P26. |
| A6 reap U11/D4 / c34c9022 | FIXED in inspected test definition; process runtime NOT VERIFIED | uiel-reap.test.js:32,50,59 covers pre-exited middle, per-process escalation, throwing kills and waiting. P26. |
| A7 shell U06 / c34c9022 | FIXED for inspected shell/flag matrix | uiel-shell-version.test.js:7-35 covers explicit/default absolute shell, NUL/oversize refusal/fallback and bash-only hermetic flags. A full filesystem executable/traversal policy is not inferred from that matrix. P26. |
| A8 versions U07 / c34c9022 | FIXED in child/host terminal seam | uiel-shell-version.test.js:39-98 requires versions 0/2/999 to spawn nothing or preserve live session while emitting BAD_VERSION; version 1 flows. P26. |
| A9 bindings HB1/HB2 / c34c9022 | FIXED for exercised active/slot/notice cases; not exhaustive | hostBindings tests exercise raw and prefixed slots and pre-subscribe state. The descending generation seam is uncovered: T5-R3-04/P04. |
| A10 settings/theme U-SET-XDG / 79bc4d7f | FIXED for inspected payload/path/tests | settings_store.test.mjs covers exact accepted JSON, fallback, 0600/0700, symlink containment and unchanged file on refusal. check_theme.py validates both schemes and generated-token parity; no test execution. P23. |
| A11 capture a317fddb + dbbc8dba | FIXED at inspected bridge boundary | captureBridge.js:31-77 validates closed methods, IDs, codes, digest and capped list. Renderer failure atomicity and persistent sealed-prefix guarantees need P16/P17; no blanket all-interleavings proof. |
| A12 ownership 4e135480 | FIXED for inspected control vocabulary and direct round-trip seams | tileStates and control tests separate human/shared/agent axes and explicit verbs. U-CTRL-REFRESH remains an end-to-end obligation below. P19. |
| A13 shutdown 50d05449 | FIXED for delayed-stat normal path | hostBindings.js:185-196,463-472 clears timers and rechecks live/disposed before keepalive. Adversarial throwing channel-close callbacks are unchanged baseline limitations, not new findings. P26. |
| A14 nested 5a8efe28 | NOT VERIFIED beyond T5 display-only gate | Nested runtime/profile creation, permissions and depth admission belong to excluded launcher/nesting policy. T5 authority input refuses depth 1; no assertion about full 0700 boot isolation. |
| A15 router a731c080 | FIXED for dormant entry, RGB24 path and ordinary settlement | Router waits for a valid notice, verifies digest before paint, uses real scheduler witness, and settles seven outcomes. P05-P07/P13 identify additional state-machine failures; exactly-once receipt is not proven by a catch-and-ignore send. |
| A16 preload 8802a68c | FIXED in inspected notice-only seam | preload.js:979-1010 forwards the transferred frame_port/v1 notice and separates stream/frame diagnostics; the T5 router owns painting/ACK. Main port-announcement uniqueness was not inferred from preload alone. |
| A17 diagnostics db627f1d + dd6faab6 | FIXED in local configuration/shape/coalescing | frameDiag.js:127-207,217-249,351-370,478-506 distinguishes lastSurfaceGeneration and lastFrameGeneration, defaults off, caps serialization and coalesces writes. rv9 tests:197,305,427,535,578. P22. |
| A18 identity 42f789c4 | FIXED for pinned delivery identity attachment | SurfaceCanvas attaches the router's lifetime/epoch rather than content generation; scheduler attachment tokens prevent stale detach. Layout still compares content generation in a different path: T5-R3-01. P01/P20. |
| A19 echoes/refresh 852f2c44 | FIXED for ordinary committed echo, dock-back and coalescing; STILL_OPEN under frame race | App.vue:207-273 waits for true; MultislotHost.vue:375-437 does not move optimistically; capturePort.js:807-828 coalesces. T5-R3-01/P01 is a distinct live-frame interleaving. |
| A20 slots ac00c6d3 | FIXED for inspected spellings/correlation | hostBindings.js:403,420-434 matches raw surface IDs and cuk-ai-slot-prefixed slots and routes error to requester. P18. |
| A21 anchors e628c064 + cb6dc166 + b1ecd15f | FIXED grammar/caps/privacy; STILL_OPEN live reporting liveness | qaAnchors.js:41-59,127-203 and anchorCollector.js:15-19,109-138 agree on grammar and byte-fitting; qa-anchors tests:908-1048 cover boundaries. Continuous mutation starvation is T5-R3-10/P10. |
| A22 fold/count 71a6166a + 84a3fbd1 | FIXED local mirror/count/geometry mechanisms | ActivityStrip.vue:47-60 uses bounded rows; activityModel.js:150-173 derives counts; mvui17 activity and mvui22 strip tests cover overflow/malformed rows and 132-px layout. This is separate from retained drawing eligibility. P09/P24. |
| A23 renderer input d1baebeb + 43b8e800 + cacb6a5b + 1938db37 | FIXED local key/pointer/shape/result regressions; STILL_OPEN dispatch gate | inputPort preserves method receiver, clones sends, catches hostile queue reads and deduplicates outcomes. Canvas fails closed on mapper failure and correlates pointer press. P03 reaches buffered READ transition. |
| A24 host input adb38c74 + 1fca7833 + 587a5b8f | FIXED local shape/stream/human checks; STILL_OPEN progress identity and global bounds | authorityWire.js:108-198 validates both input tags and limits; hostBindings.js:485-507 gates surface/control/coordinates. T5-R3-02 and T5-R3-08 remain. |
| A25 hold/stack ef9e9f71 + ba0341a1 + 43b8e800 | FIXED ordinary stack restore, 2-s hold, 500-ms grace and tested RV10 cases; STILL_OPEN combined lifecycles | Router bind/unbind tokens restore prior bindings; pending draw failures preserve the pending frame. P05/P06/P09 cover second expiry, retired-ID reuse and ineligible replay. |
| A26 host/diag 2f7ab82c + e2ebbec0 + dd6faab6 + efd96ddd | FIXED ascending drain, closed causes and authority teardown-all tests; STILL_OPEN descending drain | hostBindings.js:36-44,240-275 and frameReader.js:845-850 preserve pathless acquire causes; rv9 tests:469,689 cover authority teardown despite one close failure. Host descending mailbox is T5-R3-04. |
| A27 control b6c32ed8 + b6f301ef + 587a5b8f | FIXED normal batch ordering, state-first forwarding, timeout survival and purge | hostBindings.js:374-387 purges lost/destroyed active data; :539-549 rejects one input timeout without shutdown; :555-655 serializes each surface. No persistent host tombstone or partial-event retry proof follows; P02/P19. |
| A28 capture 72da78c4 + 84a3fbd1 + a703450c | FIXED inspected capped/filtered rows, sealed shot section and ordinary refresh | capturePort.js:693-745,807-828, recordingModel.js:791-815 and captureTransport.test.js:141-193 provide the mechanisms. Real crash durability and late-stop/new-start ordering remain NOT VERIFIED. P16/P17. |
| eababead cadence / c3307a44 telemetry | T5 counting/clock seams inspected; cadence implementation and measured FPS NOT VERIFIED | P12/P25 and annex I7 define current-clock, skipped-deadline and distinct-identity oracles. The external poll implementation and T8 soak are outside this review. |
| b7470f19 waits | FIXED only as a test-wait change stated by task; NOT a timing proof | Five-second waits are oracle allowances, not input request deadlines, frame-period guarantees or measurements. P25 and annex bounds keep those quantities separate. |

### Carried report IDs, without re-reporting them

| Known ID | Status at this SHA | Evidence / qualification |
| --- | --- | --- |
| R1-069 / T5-R2-01 | FIXED | ptyBroker.js:1515-1528 checks exact sequence-to-byte boundary; 6de15633 explicitly names this repair. P14. |
| R1-070 / T5-R2-02 | FIXED for decode allocation | bytePlane.js:491-499 and ptyBroker.js:1428-1437 check encoded size before Buffer.from; parsing/scanning is still input-length work. P14. |
| T5-R2-03 | FIXED | frameReader.js:813-829 rechecks closed/abort/floor after awaiting source release; 634b1435. P11. |
| T5-R2-04 | FIXED for temporary budget deferral | tileScheduler.js:1009,1049-1052,1147-1149 preserves retry cursor; 8c1842a5. P12. |
| R1-071 / T5-R2-05 | FIXED for close/exit disposables | ptySession.js:26-44 stores/drains both handles once and tolerates a throwing disposer; construction-time callback exceptions not certified. P14. |
| T5-R2-06 | FIXED | tileScheduler.js:550-567,1186-1192 removes before disposal and catches disposer faults. P12. |
| T5-R2-07 | FIXED for synchronous forwarding failure | ptyBroker.js:2111-2120 forwards before advancing local ACK ledger; 6de15633. P14. |
| T5-R2-08 | FIXED for selected-slot and matched spellings | 8c1842a5 selected capsule slot and hostBindings.js:420-434 correlation. P18. |
| T5-R2-09 | FIXED baseline live attachment | Router registration callback plus SurfaceCanvas pinned identity; no claim that every new retained path is sound. P20. |
| T5-R2-10 / dangling ACK timer | FIXED | framePort.js:670-677,727-735 binds timer to token/generation/inFlight after post. P13. |
| T5-R2-11 | FIXED | ptyBroker.js:582-586,695 uses StringDecoder across chunks; dedicated regression at t5-elec-pty-regression.test.js:451. P14. |
| T5-R2-12 | FIXED | tileScheduler.js:1456-1463 detaches only matching token. P20. |
| T5-R2-13 | STILL_OPEN; excluded from new count | framePort.js:410-413 and framePortRouter.js:552 require only object-valued pixelSpec; closed nested keys remain unchecked. P17-style closed-shape matrix should include this existing issue. |
| T5-R2-14 | FIXED | tileStates.js:183-191 requires explicit release spelling; missing/unknown verb defaults to take_control. P19. |
| T5-R2-15 | FIXED within the named side-terminal facade scope | sideTerminalFacade.js:11-13 validates session grammar; 8c1842a5 explicitly names that seam. Do not extrapolate to every unrelated component truthiness check. |
| T5-R2-16 | FIXED baseline witness strip | SurfaceCanvas.vue:144-149,584-596 suppresses the strip without an accepted witness; dead/context-loss state clears retained witness. P19. |
| T5-R2-17 | FIXED | tileScheduler.js:1029 checks current clock per candidate; :1113 records actual presentation time. P12. |
| U-WALL-FPS | FIXED attachment mechanism; throughput NOT VERIFIED | 42f789c4 repaired identity attach; P25 is still needed to certify the quantitative live-wall target. |
| U-REC-SHOT | FIXED listing/display seam; durability NOT VERIFIED | Sealed recordings and screenshots are included and rendered; no independent persistence/crash run. P16. |
| U-LIFE-DESTROY | STILL_OPEN end-to-end obligation | Purge exists, but hostBindings.js:389-391 can accept later active state and has no permanent destroyed-ID tombstone. Core lifecycle authority is outside scope; no new duplicate finding. |
| U-CTRL-REFRESH | STILL_OPEN end-to-end obligation | hostBindings.js:424-434 resolves release from matching agent-control state without independently demanding a newer frame. Core may order refresh first; this review cannot prove it. P19. |
| U-AGENT-VERDICT | Inspected local vocabulary/evidence rule; end-to-end proof STILL_OPEN | tileStates.js:35-44,88-98 and activityModel.js:54-71 fail unknown outcomes closed; fresh after_frame production is adapter/core-owned. P19. |
| U-MSLOT-TRAVEL | STILL_OPEN full liveness | UI movement/stack mechanisms exist; native process survival was not exercised, and T5-R3-01 breaks one committed-echo interleaving. P20. |
| G4, G5, G8 | NOT VERIFIED / unmapped | Definitions and original report text are ABSENT — do not invent. P11/P12 supply concrete independent newest/fairness oracles but are not assigned invented gap meanings. |
| R1-060..068/073/074 and settled R1-006/007/072/075/076 | No new finding; historical full mapping NOT VERIFIED | Original report/complete closure descriptions were not available. The scoped present-day tests above are inspected; the supplied settled decisions are not reopened. |

# Mathematical annex

## A. Retrieval record and source discipline

The library's llms.txt was retrieved. It describes shortlists of paper IDs/anchors and an abstention flag. Its suggested local router was not executed, and papers/catalogue were not opened. The eight separate requested topics were queried verbatim via Context7.

| Query | Exact query | Returned evidence and permitted use |
| --- | --- | --- |
| Q1 | fixed-deadline periodic scheduling jitter bound missed deadline skip policy | PM-124.1, headings “Panel 3 - reference implementation and oracle” and “1. Abstract and result contract,” describes three-machine finite unit-job scheduling. It does not supply the requested periodic jitter or skip theorem. No such theorem is claimed. Cadence below is [DERIVED]. |
| Q2 | sequential hypothesis testing SPRT loss detection stopping rule error bounds | PM-227.3, “Stopping before stability fails” / cor:stopping, concerns a stochastic-model stability stopping time; other hits concern SLE/nodal descent/machine execution. None supplies an SPRT or a capsule-loss model. The conditional sequential oracle below is [DERIVED]. |
| Q3 | concentration inequality binomial proportion Hoeffding bound sample size | **PM-113.1, “Success probability and output,” eq:hoeffding** supplies the applicable bound for independent [0,1] variables of common mean. Used below with its assumptions explicit. A secondary hit PM-207.1, proof-stmt-ch-accurate-string, gives a weaker moment argument; it is unnecessary here. |
| Q4 | credit-based flow control queueing backpressure burst bound | PM-063.1, “5. Domain engineering contracts,” explicitly forbids using its bound to size queues; PM-140.4 has a similar restriction. PM-227.7's reversible-chain flow theorem does not model byte credit. Use supplied SW-0166 E7/E8 and the code-derived recurrence instead. |
| Q5 | constraint feasibility rectangle layout packing graphical interface | PM-034.6, “Oracle code for exact feasibility checking,” and PM-118.1, “Instance and Packing structures in Lean 4,” concern rational feasibility and one-dimensional bin packing. Neither proves GUI viewport containment. Only the inspected componentwise predicates are used. |
| Q6 | write-ahead log crash recovery prefix property fsync ordering | PM-376.5, “5. Domain engineering contracts,” explicitly states no communication/recovery construction; other prefix hits are unrelated. No WAL recovery theorem was retrieved. Supplied SW-0172 N3 is a requirement; durable implementation proof remains outside scope. |
| Q7 | event-to-photon latency percentile human perception threshold interactive systems | PM-175.2, “6. Applicability limits and search,” L12, and PM-110.2, “5. Domain engineering contracts,” warn against translating unrelated bounds into latency guarantees. No perception threshold was returned. Use supplied VG-0061 N4 for decomposition/reporting and derive counting arithmetic only. |
| Q8 | exactly-once acknowledgement state machine delivery guarantee verification | PM-129.2, “Lean 4 formal statement and definitions for one-way liveness,” concerns automata state complexity; its displayed theorem is unfinished. It does not prove delivery guarantees. ACK properties below are direct state-machine arguments [DERIVED]. |

The applicable retrieved paper is [PM-113.1](https://github.com/oguirado/math-router/blob/main/papers/EN-114-000-0007-2-2026-PR-T4-UK-EX-M1-B-AL-H-0242_PM-113.1_A_Fully_Polynomial_Randomized_Approximation_Scheme_for_Perfect_Matchings_in_General_Graphs.md), anchor **eq:hoeffding** as returned under **Success probability and output**. Only the returned excerpt was used.

Normative supplied references, with their supplied anchors: SW-0269 §2.2 lines 58-66 and §6.2 line 246 (E1/E2/E3); SW-0129 invariant table lines 72-78 (E4/E5); SW-0166 invariant table lines 73-79 and §6.4 line 315 (E7/E8); SW-0249 lines 54-56 and 65-66 (E9/E10); OmniCodex PL35 lines 1455-1456 (O3); SW-0058 lines 69-70 (N1); SW-0183 lines 63-64 (N2); SW-0172 line 86 (N3); VG-0061 line 64 (N4). These citations identify the user-supplied blocks, not verified external retrievals. No different theorem is attributed to them.

## B. Formal invariants, proofs and counterexamples

All adaptations from the supplied contracts to this JavaScript implementation are [DERIVED].

### I1. Newest-only selection and identity conservation

For one surface lifetime, let A be the set of admitted delivery identities. Partition it into U (unsettled live records), P (terminally presented), S (terminally superseded), and D (other terminal dispositions). Required:

~~~text
A = U disjoint-union P disjoint-union S disjoint-union D
|A| = |U| + |P| + |S| + |D|
for every admitted identity r: terminalDispositionCount(r) <= 1
for every terminal SUPERSEDED identity r: futurePaintCount(r) = 0
mailboxGeneration = maximum eligible not-yet-disposed generation
~~~

A remount repaint of one already-presented identity is not another delivery and must not increase distinct-frame FPS. Refused-before-admission offers belong to a separate offered/refused ledger.

The partition classifies the first terminal ACK outcome, separately from subsequent byte use. Proof obligation: submit adds one identity to U; replacement moves the old identity U→S and keeps the greater generation; first settlement as PRESENTED moves U→P; other terminal settlements move U→D; no ACK-classification transition leaves a terminal set. A legitimate later repaint of HIDDEN-kept bytes stays in D and emits no new ACK. These transitions preserve the partition by induction. Current code breaks the maximum selection at T5-R3-04 and terminal-byte disposition at T5-R3-05. A counter of ACK attempts alone cannot prove this partition.

The supplied ring equations use modulo arithmetic. These JS generation fields instead use safe integers. Tests must reject unsafe inputs or explicitly account for counter policy, rather than silently wrapping at 32 bits.

### I2. Monotonic accepted floors and stream/lifetime separation

For content generation g in lifetime L, an accepted floor F_L must obey F'_L >= F_L, with a new successful acceptance requiring g > F_L. For stream identity z, persistent high-water H_s must satisfy H'_s >= H_s even when no live port exists; a late notice z <= H_s must not become active.

Reader proof: frameReader.js:813-829 rechecks closed/abort and lastAccepted after asynchronous source release; the final comparison and assignment form one synchronous acceptance step. Induction on that step orders successful reader acceptances despite reversed asynchronous completion.

That proof does not cover an earlier host mailbox replacement (T5-R3-04), a router floor committed before integrity validation (T5-R3-07), or router history deleted during retirement (T5-R3-06). Stream ID, delivery lifetime generation, content frame generation, and layout lifetime are distinct variables. App.vue:234 incorrectly uses the content variable as an across-await layout lifetime fence.

### I3. ACK/release uniqueness and scoped guarantees

Let a(r) count terminal ACK attempts for an accepted router record r. settle checks r.settled, writes true before postAck, and then sends. Starting at a=0, the only transition increments at most once; synchronous reentry observes settled=true. Thus a(r) <= 1.

Under eventual settlement and a usable postMessage interface, a(r)=1. Observed sender receipt additionally requires successful sending and eventual lossless delivery before peer teardown; successful postMessage alone does not establish that delivery. Without these assumptions, swallowed transport errors or peer closure allow zero successful receipts. Duplicate malformed arrivals use refuseArrival without a retained record; “exactly once per arbitrary wire identity” additionally requires a duplicate-identity policy and cannot be inferred from settle.

For resource leases, let opened = live + terminallyReleased, with each identity's release count at most one. Normal source-reader and scheduler guarded-release paths support this accounting, and stale ACK timer guards protect promoted frames. A universal proof over arbitrary reentrant host callbacks is not supplied: the unchanged baseline framePort supersede callback can reenter revocation before pending is cleared. This was deliberately excluded from new findings because framePort.js is byte-identical to cfd582ec. Accordingly, the report does not assert an unconditional release-once theorem.

### I4. Capture failure atomicity, sealed identity and bounded projection

Let H be host-acknowledged sealed artifact identities; for each identity retain immutable completion metadata. In a no-eviction experiment with |H| <= 64, a failed refresh must not alter the successful domain projection, and a later complete relist must not fabricate a torn row or lose an acknowledged identity without an explicit lifecycle cause.

The local checks establish failed-refresh nonmutation and whole-response replacement when the response is valid; they do not independently establish acknowledged-ID preservation. A shape-valid complete list that omits an acknowledged ID is still accepted. Preservation additionally requires a complete monotonic host manifest, and neither local property proves durable storage. A lost transport reply leaves acknowledgment status unknown; an unacknowledged operation may or may not have committed, so a later complete row is not automatically phantom.

N3's durable-prefix obligation is stronger: every acknowledged record must lie in the recovered prefix. The T5 list is a capped, filtered view, not an unbounded write-ahead log; after retention or filtering it can be a window/subset rather than a literal prefix. Its schema lacks sha256. Therefore a full N3 proof and digest persistence require the host/core recording source and crash recovery evidence. P16 explicitly limits the simple projection test to no eviction and at most 64 rows.

Refresh structural proof: refreshBusy is set before the first list; overlapping calls share one queued promise; finishRefresh consumes that slot before starting its follow-up. Therefore activeLists <= 1 and queuedRefreshSlots <= 1. For a finite burst entirely before first completion, calls <= 2. Continuous traffic can produce more sequential calls; the bound is on concurrency, not lifetime count.

### I5. Input admission, ordering, limits and cancellation

Identify a primitive event by e=(surface, batchSeq, originalIndex), and let apply(e) count native effects. Required:

~~~text
apply(e) is 0 or 1
applied primitives form an order-preserving subsequence of the per-surface offered order
every omitted queued primitive has a typed refusal or cancellation
1 <= eventsPerBatch <= 32
utf8Bytes(serializedBatch) <= 16384
takenRateSlots in a trailing 1000-ms window <= 60
dispatch(e,t) implies current human/WRITE/focus/availability gate
~~~

Here offered order means the order of locally queued, shape-admitted batches; later authority refusal or gate cancellation may omit an event, but cannot silently reorder or duplicate its successors. The byte/event predicates are closed boundary checks, not TypeScript assumptions. The host has a per-surface draining loop and preserves order during successful processing. T5-R3-02 is a counterexample to apply(e)<=1: click acknowledgment makes apply(s1,1,0)=1, later key refusal leaves the seq floor at zero, retry makes it 2.

For the gate, capture at time t_c and dispatch at t_s need either a still-valid gate at t_s or a documented irrevocable admission rule. Under the documented SurfaceCanvas.vue:183-185 capture-and-send gate, a gate epoch/cancellation fence must invalidate queued work; a different irrevocable enqueue-admission policy would need an explicit contract. Present code checks capture-time state and not dispatch-time state, giving T5-R3-03. Current per-ID rate limiting also does not imply a global registry bound: T5-R3-08 yields registrySize(N)=N.

### I6. Hold/stack lifecycle and eligibility

ACK outcome and byte lifecycle are separate axes. Bytes can move Held→Verifying→Retained→Painted; HIDDEN is a terminal ACK outcome that may legitimately coexist with Retained or later Painted bytes, without another ACK. Retirement of the stream forbids any subsequent transition to Retained or Painted. A SUPERSEDED settlement likewise makes those bytes permanently unpaintable. Binding-stack removal affects only the matching token, and only the newest remaining binding is active.

The ordinary retirement checks use disposed and stream-entry identity, so a completed digest on the old entry is fenced after replacement. Stacked binding tokens restore the earlier binding and protect it from stale detachment. Nevertheless, T5-R3-05 shows that settlement without retirement is not fenced, T5-R3-06 shows retirement forgets the history needed to reject a newly presented old stream, and T5-R3-09 violates:

~~~text
draw(surface,t) => eligible(currentSurfaceState(t))
~~~

The eligibility implication must apply equally to runTick, direct present and retained attach. Retaining bytes is not authority to draw them.

### I7. Cadence, dedup-aware liveness and telemetry

For nominal period T and origin t0, nominal deadlines are d_k=t0+kT. Define start jitter j_k=start_k-d_k and missed deadlines as nominal deadlines deliberately skipped, not work queued for later replay. Fixed-origin advancement prevents execution time from accumulating as an additional full period after every iteration; it does not bound execution time or event-loop stalls.

For a surface over a monotonic interval W seconds, count distinct presented identities using at least surface/lifetime/frame identity, not repeated ACKs, cached repaints or observer polls:

~~~text
fps(surface,W) = distinctPresentedIdentities(surface,W) / W
gap_i = presentTime_i - presentTime_(i-1)
~~~

A healthy deduplicated-static surface can have zero new identities while capture/heartbeat remains live. Thus zero distinct-frame FPS alone cannot imply lost; changing-content throughput fixtures and static-health fixtures need different oracles. Conversely, repeated cached paints cannot satisfy a dynamic-content throughput target. N4 motivates percentile reporting; it supplies no numerical perception threshold for this implementation.

## C. Quantitative property-test bounds

All rows use [CITED] constants from the indicated code/task and [DERIVED] arithmetic. These are test oracles, not measurements.

| Quantity | Explicit oracle / parameters | Grounding and limit |
| --- | --- | --- |
| Dynamic AC-02 window | At least four visible dynamic surfaces; W=600 s; each has N>=10W=6000 distinct presented identities. Never sum across surfaces to hide a stalled tile. | [TARGET] supplied AC-02; derivation N=fW. No completed soak. |
| Inter-frame gaps | Sort m gaps; nearest-rank q_p = gap_(ceil(p*m)) for p=.50,.95,.99; also record maximum and sample count. | [DERIVED] explicit estimator; supplied VG-0061 N4 motivates percentiles. Zero samples must not pass. |
| Fixed-deadline residual budget | For target T=100 ms, cited capture cost C=52 ms leaves 48 ms for remaining serial work, lateness and transport before that deadline. | [DERIVED] 100-52. The 52-ms figure is from the task, not remeasured or assumed universal. |
| Shared capture worker | Four serial 52-ms captures cost 208 ms per round, giving at most 1000/208≈4.81 rounds/s, before other work. Independent workers need a different utilization model. | [DERIVED] conditional arithmetic; no claim about actual architecture outside T5. |
| Miss budget | For P offered nominal samples in W, target distinct accepts >=10W allows at most P-10W missing distinct samples, only if every offer is new and no other losses occur. At exactly 10-Hz offering over 600 s, P=6000 gives no spare miss budget. | [DERIVED] subtraction; skip policy does not create capacity. |
| Scheduler exact fit | Per tick draws<=D, raw upload bytes<=B and observed/estimated-time rule as implemented. Byte candidate B fits; B+1 cannot fit an otherwise empty tick. | [CITED] tileScheduler.js:1042-1044; [DERIVED] predicate boundary. Actual slow work can overrun a precheck. |
| RGB24 effective bound | With width,height<=4096, 3wh<=50,331,648 bytes=48 MiB; conversion output 4wh<=67,108,864 bytes=64 MiB. | [DERIVED] 4096 squared times 3 or 4; hostBindings axis cap. Concurrent/transient copies are additional. |
| RSS acceptance budgets | Main<=200 MB, renderer<=370 MB, app tree<=1150 MB excluding capsules; treat MB as the specified decimal budget unit and keep per-process/tree scopes distinct. | [TARGET] supplied AC-14 budgets; main unit oracle uses 200*1000*1000 bytes. No measured result or proof that frame copies satisfy these budgets. |
| JavaScript arithmetic | Generations/counters used as safe integers must remain <=2^53-1. Test arithmetic at this boundary; do not apply the papers' modulo-2^32/2^64 behavior automatically. | [DERIVED] implementation safe-integer domain; E2/E3 adaptation. |
| ACK vs attempts | Q_validation + D_hash + D_register/callback + sum of at most three immediate present costs + J_eventloop + D_ack < ackTimeoutMs is a sufficient observed-ACK timing condition, assuming eventual lossless delivery. | [CITED] router PRESENT_ATTEMPTS=3, :850-861 and serialized pump :954-972; [DERIVED] queue wait plus serial stages. No unconditional upper bound in source. |
| Unbound hold | ACK latency <=2000 ms + J_timer + D_hash + D_ack under finite assumed bounds. For the task's 10000-ms host timeout, extras must sum to <8000 ms. | [CITED] router PENDING_UNBOUND_MS=2000; [DERIVED] 10000-2000. HIDDEN is not proven to arrive at exactly 2 s. |
| Last-binding grace | Retire after scheduled 500 ms plus timer lateness, unless rebound; a 499/500/501-ms fake-clock matrix fixes event order explicitly. | [CITED] KEEP_STREAM_GRACE_MS=500; [DERIVED] scheduled-time interpretation. |
| BytePlane pause/resume | H=131072, L=65536. Two 65536-byte chunks reach H; cumulative ACK reducing outstanding to L resumes in bytePlane. | [CITED] bytePlane watermarks and :545. Broker/session currently use strict <L; test separately. |
| BytePlane overflow | C=524288. Eight 65536-byte chunks exactly fill C; the next byte exceeds it and must produce one terminal overflow fault. | [DERIVED] 8*65536=C; supplied E8 plus implementation cap. |
| Burst time without credit | From current outstanding q, additional B bytes meet the pending-byte cap iff B<=C-q, assuming all other admission gates pass. With constant accepted rate r>0 and no ACKs, the byte-cap threshold time is (C-q)/r, plus the size/timing of the next discrete arrival. | [DERIVED] q+r*t<=C. No assumed measured rate. |
| Capture list/refresh | Rows<=64; activeLists<=1; queuedSlots<=1; finite pre-completion burst uses at most two calls. | [CITED] captureBridge and capturePort.js:693-745,807-828; structural proof I4. |
| QA snapshot | Rows<=512; serialized UTF-8 bytes<=65536; anchor<=200 characters, <=6 segments, each<=64; label<=128 UTF-16 code units without splitting a code point. | [CITED] qaAnchors.js:21-29,127-203 and collector:73-79,127-136. UTF-8 size and JS length differ. |
| QA debounce failure | With mutation interval δ=100 ms<250 ms, each reset deadline is at least t_i+250 and t_(i+1)<t_i+250; induction shows no timer fires during the infinite sequence. | [DERIVED] T5-R3-10; not a measured starvation duration. |
| Activity | At most 8 rendered candidate slots; outcomes box 132 px. Domain total/count must not be replaced by capped array length. | [CITED] activityModel.js:29,150-173; ActivityStrip.vue:47-60; mvui22 strip source/test. |
| Input batch limits | 1..32 events and serialized UTF-8 JSON<=16384 bytes. Host 33 events and 16385 bytes fail LIMIT when otherwise valid. | [CITED] authorityWire.js:73-75,181-193. Schema errors may take precedence for other malformed inputs. |
| Input rate | At most 60 taken slots with age<1000 ms per surface; age=1000 expires. The clock must be controlled/monotonic for the mathematical trailing-window model. | [CITED] authorityWire.js:401-409 uses Date.now; wall-clock jumps need a separate test. |
| Input maximum offer | 60*32=1920 primitive events/s and 60*16384=983040 JSON bytes/s per surface as cap products. | [DERIVED] upper offer envelopes, not native throughput guarantees. |
| Host input queue | Outstanding event sum plus next batch<=256; reject one beyond. Serialized native work is one request per surface at a time. | [CITED] hostBindings.js:555-655,717-720; preload has a separate queue, so do not claim a single 256-event end-to-end bound. |
| Input deadline / oracle waits | Host default input request deadline is 3000 ms. The task's 5000-ms waits are test allowances; event-loop lateness can extend either timer. | [CITED] hostBindings.js:26,127,539-543; supplied b7470f19. |
| e2e26 seam | A 2-fps rate over one second requires at least two distinct identities in a defined half-open 1000-ms interval; also assert max gap if a stall bound is intended. | [TARGET] supplied e2e26 2 fps/1000 ms; [DERIVED] count/rate. T8 implementation was not opened or executed. |
| Float geometry | 0<=x,y<=16383 and 1<=w,h<=16384 imply x+w,y+h<=32767. | [CITED] authorityWire.js:53-56; [DERIVED] addition. This does not establish containment or nonoverlap. |
| Acceptance sample size | For iid bounded trials, n>=ceil(log(2/delta)/(2*epsilon^2)). epsilon=.05,delta=.05 gives 738; delta=.01 gives 1060. | [CITED] PM-113.1 eq:hoeffding; [DERIVED] rearrangement below. |
| Unknown-ID retention | N distinct valid unknown IDs yield exactly N rate-map keys, starting empty, because each inserts once and none is deleted. | [DERIVED] induction on authorityWire.js:402-409,425; counterexample rather than an acceptable bound. |

## D. Derivations and statistical interpretation

### D1. Hoeffding sample sizes and why nine of ten is not a population guarantee

The returned PM-113.1 eq:hoeffding gives, for independent X_i in [0,1] with common mean p:

~~~text
Pr(|mean(X)-p| > epsilon) <= 2 exp(-2 n epsilon^2).
2 exp(-2 n epsilon^2) <= delta
=> n >= log(2/delta)/(2 epsilon^2).
~~~

For epsilon=.05, 2*epsilon^2=.005. With delta=.05, log(40)/.005≈737.776, so n=738 suffices; delta=.01 gives log(200)/.005≈1059.663, so n=1060 suffices [DERIVED]. A threshold halfway between p=.8 and p=.9 is .85; this conservative bound supplies a separation oracle only under the iid/common-mean assumptions. A correlated frame stream or repeated runs sharing failure state does not automatically satisfy them.

For exactly ten independent Bernoulli trials, a “nine or ten successes” pass criterion has:

~~~text
Pr(pass | p) = choose(10,9)*p^9*(1-p) + p^10.
At p=.8: 10*.8^9*.2 + .8^10 = .3758096384.
At p=.9: 10*.9^9*.1 + .9^10 = .7360989291.
~~~

Thus the literal AC-05 nine-of-ten target is a finite observed-run criterion, not strong evidence that true success probability is at least .9. This calculation is [DERIVED] from the binomial model, not an attributed theorem from an unrelated hit.

For four independent-or-not surface estimators each satisfying the same individual concentration assumptions, a union bound allocates total delta=.05 as .0125 each. Then ceil(log(160)/.005)=1016 observations per estimator [DERIVED]. Independence between the four estimators is not needed for the union bound; independence within each estimator's trials is needed for the cited Hoeffding premise. A 600-second soak with one correlated window each second is not automatically 600 independent samples.

### D2. Conditional sequential loss/progress oracle

No applicable SPRT theorem was returned. The following is an explicitly derived synthetic oracle, not a measured capsule-loss model.

Assume independent binary progress observations X_i in fixed windows, with H0: p=p0 and H1: p=p1, 0<p0<p1<1. Define likelihood ratio:

~~~text
L_n = product_i [(p1/p0)^X_i * ((1-p1)/(1-p0))^(1-X_i)].
~~~

Under H0, the conditional mean of each multiplicative factor equals p0*(p1/p0)+(1-p0)*((1-p1)/(1-p0))=1. Hence L_n is a nonnegative mean-one martingale. Stopping the process at an upper crossing and truncating at a finite horizon gives probability of crossing L>=1/alpha at most alpha; taking increasing horizons preserves that bound. Under H1 the identical argument for 1/L bounds crossing L<=beta by beta. Therefore conservative stopping thresholds 1/alpha and beta give the stated type-I/type-II crossing bounds, without pretending that approximate Wald thresholds eliminate overshoot.

For a synthetic fixture p0=.1,p1=.9,alpha=beta=.05 [TARGET], stop at L>=20 (progress) or L<=1/20 (no progress). Log increments are plus or minus log(9). Their H1 mean is .8*log(9)>0 and H0 mean is its negative. A sufficiently long same-direction block has nonzero probability, so expected stopping time is finite. Wald's sum identity and maximum overshoot log(9) give the conservative expected-sample bound:

~~~text
E[N] <= (log(20)+log(9)) / (.8*log(9)) < 2.96
~~~

under either of these two synthetic hypotheses [DERIVED]. With 100-ms observation windows, this is less than 296 ms of expected observation time, plus observation/dispatch cost; it is not a deterministic maximum and does not apply unless the hypotheses describe the fixture. A healthy deduplicated-static capsule can generate no new content identities, so it must use an independent heartbeat/capture witness or a deliberately changing stimulus. Production p0/p1, dependence and sampling delays are ABSENT — do not invent. No production loss-detector latency certification follows.

### D3. Fixed deadlines and skipped work

Let completion after an attempted deadline d_k be c. A future strictly-after-completion deadline can be selected as the smallest d_j>c. The count of skipped intermediate nominal deadlines is j-k-1. This definition fixes equality handling explicitly; an implementation that permits starting exactly at c=d_j must use >= consistently in its oracle instead. The invariant is that skipped indices never later re-enter the work queue.

A fixed-origin schedule avoids the drift of “wait T after work”: that alternative has start spacing approximately T+C, so C=52,T=100 would imply about 1000/152≈6.58 starts/s before other delays [DERIVED]. Fixed deadlines can preserve nominal frequency when work finishes before the next due time, but cannot achieve 10 Hz if total serial work exceeds 100 ms. With offered rate exactly the acceptance floor, every skipped distinct frame must be offset by a higher offered rate or a longer definition of the allowed window; fixed deadlines alone do not repair a capacity deficit.

Neither a maximum execution cost nor a jitter distribution was measured. Accordingly the 48-ms residual budget, four-worker comparison, skipped-count formula and gap statistics are conditional oracles, not a claimed schedulability theorem.

### D4. Credit, overflow and geometry

Define sent prefix bytes S and acknowledged prefix bytes R. Outstanding q=S-R. An ACK carrying sequence k must equal the recorded cumulative boundary b(k); a merely in-range byte count is insufficient. Exact-boundary validation preserves the prefix and q>=0. Appending B bytes meets the pending-byte cap exactly when q+B<=C, assuming frame-size, frame-count, lifetime, sequence and shape gates also pass; this is why eight 65536-byte chunks fit C=524288 and one more byte fails. Advancing local ACK state only after successful forwarding preserves the local ledger under synchronous transport failure. None of these statements assumes lossless wire delivery after a successful send call.

For layout, the admitted componentwise rectangle coordinates give x+w<=16383+16384=32767. Actual viewport feasibility would additionally need viewport dimensions, containment inequalities, and any intended overlap constraints. None are specified by this wire predicate; importing a bin-packing theorem would invent a contract.

### D5. Failure atomicity and diagnostic counters

For each refusal test, divide state into domain state, caller outputs, and explicitly allowed diagnostics. Assert byte-identical domain state and outputs where the contract requires it; whitelist only documented refusal counters/typed verdicts. Do not assert all instrumentation is unchanged while simultaneously requiring refusal counters to increase. Input's partially applied native prefix is domain state, not an allowed diagnostic exception. Router accepted floors and retained paint ownership are likewise domain state.

## E. Optimizations with quantified gain and measurement plans

These are proposals, not implemented changes or measured improvements. Correct lifecycle/ownership is a prerequisite.

| Proposal | Derived potential gain | Measurement and correctness gate |
| --- | --- | --- |
| Remove one redundant frame copy while retaining reader-owned bytes | hostBindings.js:273 copies a fresh private B-byte buffer and frameReader.js:783 copies again. Removing only the first redundant copy could save B copied bytes per read, at most 50,331,648 for the admitted maximal RGB24 frame. | Count allocated/copied bytes per distinct accepted frame, CPU time, GC pauses and p50/p95/p99 gaps. Preserve fresh ownership, bounds, source-release and concurrent-read tests. No FPS multiplier is claimed. |
| Avoid a second SHA for already verified retained bytes | One O(3wh) hash pass saved per late-bound retained frame if immutable ownership and the verification witness are preserved. | Count digest calls/bytes under identical held/rebind traces. First fix P05 and verify retire/supersede cannot reuse the witness. |
| Gate and budget retained repaint | Exactly one RGB-to-RGBA conversion/upload is avoided for each rejected ineligible reattach; conversion output is 4wh bytes. | Actual putImageData count and converted bytes across fold/hide/context/remount traces; P09 must show zero hidden draws without harming newest-on-resume. |
| Preserve type coalescing while recording partial progress | k consecutive type events fitting the adapter text cap can use one request instead of k, saving k-1 request/receipt pairs. | Count actual requests, payload bytes and p50/p95/p99 input-to-result latency. P02 must preserve primitive identity and safe refusal semantics. |
| Bound/refuse unknown-surface bookkeeping | Current retained key count is N for N unique unknown IDs. Admission-only retention adds zero keys for that workload, or a declared cap K limits retained keys to K. | Repeated fixed-size churn, registry cardinality, retained heap and subsequent known-surface usability; P08. |
| Preserve one-active/one-queued capture refresh | A finite pre-completion burst of m>=2 callers costs at most two list calls rather than m, saving at least m-2 calls under that schedule. | Active concurrency, queued-slot count, backend list count and stable rows under P16. Do not claim two calls for an unbounded arrival stream. |
| Fence layout on actual lifetime identity | For n successful same-lifetime layout acknowledgments, eliminate frame-progress-caused dropped echoes; required applied echo count is n. | Compare acknowledged versus applied intents while frames advance, with real lifetime destruction as the negative control; P01. |
| Make QA coalescing have a maximum wait | Converts unbounded starvation under 100-ms unrelated churn into a declared finite scheduling target, while retaining minimum spacing. | P10's fake clock and real live QA snapshot latency. A proposed 1000-ms cap is a target to select and test, not a measured current value. |

# Not verified

- **Runtime:** no code, unit suite, CI job, Electron/browser/native PTY/socket harness, RSS measurement, ten-minute wall soak, recording leak test, or e2e25/e2e26/e2e27 was run. The supplied G-W1 target of 8/8 twice was not demonstrated. All commands above are instructions for future execution. Missing kit 0.2.1, unix-socket listen, node-pty, Electron/xvfb or unshare must remain explicit prerequisites/skip classifications.
- **Durable prefix and ordering:** no core/adapter journal, fsync, group-commit crash recovery or refresh-before-control proof was inspected. A typed true at the T5 echo seam is not independent evidence of physical persistence. Capture list lacks digest and is bounded/filtered, so it cannot alone establish an unbounded acknowledged-history theorem.
- **Mathematical retrieval gaps:** Q1/Q2/Q4/Q5/Q6/Q7/Q8 did not return applicable requested theorems or human-perception thresholds. Their engineering conclusions remain derived conditional statements or unavailable evidence. No unrelated paper result was converted into a software guarantee.
- **Historical report identity:** the supplied b8ec7413 resolves to b8ec741354ddab2e3c38892c4b92dc40d3a7c2e7 with message “tools: update the router index,” not the original T5 report. No reports directory was present in the reviewed tree. Historical statuses therefore use the supplied ID descriptions, explicit fix-commit messages and current source/test definitions. G4/G5/G8 definitions and complete R1 mappings are **ABSENT — do not invent**. A bounded repository search returned only unrelated lockfile text for those short labels.
- **Acceptance-document location:** the pinned docs/ROADMAP.md is a short hackathon schedule and has no section 1.3 acceptance table. The AC targets used here are the attachment's explicit [TARGET] requirements, not a claimed verified table elsewhere.
- **Baseline-only counterexamples excluded from new counts:** framePort.js is byte-identical between cfd582ec and the reviewed SHA. Its supersede-release callback reentrancy can release a pending lease twice and leave a new pending lease after revocation. The unguarded host channel-close loop also predates the new window. They prevent universal release/teardown proofs under arbitrary callbacks, but were not promoted as new regressions or repeated as fresh findings.
- **Unranked capture hypothesis:** a late stop reply may overwrite newer local recording state if a sealed event permits a new start first. Actual core/IPC ordering admitting that trace was not established, so it is not a finding.
- **Test-clock limitations:** existing W3 sequences offering 50 refusals, another 50 refusals, then 50 timeouts, and a 200-batch typing scenario, are not deterministic proofs of the 60/s limiter without a controlled clock. Their outcomes can depend on elapsed runtime. P08 and boundary-rate cases should use a fixed/advanced fake clock.
- **Timing:** timer constants are scheduling requests; no finite event-loop jitter, SHA duration, draw cost, process shutdown delay or native input latency was measured. The cited approximately 52-ms capture cost and the 5-second oracle waits are not transplanted into unconditional performance claims.
- **Package and policy:** sealed font-free contents, renamed font detection, main/preload security policy, nested runtime isolation and launcher internals remain outside this T5 source review. Local extension checks and facade gates are not substitutes for those owned gates.
- **Scope of adversarial traces:** port-boundary schedules can be stronger than ordinary current sender behavior; their role is to test the specified ingress/lifecycle invariants. Unknown-ID churn is an authorized-renderer boundary stress case, not a claim of unauthenticated remote access.

The report changes one documentation file only. It does not certify the entire product, reopen supplied settled non-defects, or claim any proposed test passed.


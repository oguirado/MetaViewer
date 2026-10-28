Reviewed: bridge/integration @ ae9361bb3d645eee1976ec8d739dc358b572561b

## Summary

The hosted slice has materially stronger and non-vacuous oracles than the earlier review: the independent golden, two-run journal comparison, explicit control/refusal sequence, native-evidence prerequisite, production canvas checks, cancellation-before-drain, and sealed-recording list are present. **Release qualification is not established. This review identifies 15 findings: P0 = 0, P1 = 13, P2 = 2.** The principal remaining problems are a reproducible frame-budget counterexample, an oversized handoff that consumes ownership, negative controls that can report the wrong result, and acceptance evidence that overstates its scope.

The review froze the initial branch head shown above. GitHub's comparison places it 22 commits ahead of, and zero behind, `4f4c984cea539a68832901d0383d2f09e0db19ec`, with that commit as the merge base [CITED: [comparison](https://github.com/oguirado/MetaViewer/compare/4f4c984cea539a68832901d0383d2f09e0db19ec...ae9361bb3d645eee1976ec8d739dc358b572561b)]. Every MetaViewer source link below is pinned to the reviewed head. Findings concern T8-observable behavior or the adequacy of its oracles. Other-topic internals are cited only where necessary to establish an interface consequence.

**Method and execution status.** This was a connector-based source review, including reads of existing GitHub Actions evidence. No repository was cloned, no product code or tests were written, and no test command was executed for this review. Proposed cases and mathematical counterexamples are explicitly distinguished from observed executions.

The original [branch CI run](https://github.com/oguirado/MetaViewer/actions/runs/40643560774) is successful at the reviewed SHA. The [x64 E2E job](https://github.com/oguirado/MetaViewer/actions/runs/40643560774/job/122667050535) and [arm64 E2E job](https://github.com/oguirado/MetaViewer/actions/runs/40643560774/job/122667050510) each report 242 tests, 242 passes, and zero failures, skips, or todos [CITED — existing CI]. Their printed Node suite durations are 213.294028902 s and 269.847315438 s respectively [MEASURED — those existing CI executions, not a new benchmark]. These statuses do not establish a completed volume qualification, a native ten-run provider loop, or a 600-second native wall soak. The Actions query for this head returned no Volume execution at inspection.

### Landed-fix verification ledger

“FIXED” below means that the scoped fix and a relevant assertion are present in the reviewed source; it is not a claim that every private/live leg was executed. A residual finding does not reopen the already-correct part of a landing.

| Landing or obligation | Verdict and evidence |
|---|---|
| R1-113/R1-114, hosted slice, golden independence | **FIXED.** Two fresh roots compare journal bytes, states, and replay digests; the corrupting mutation must change bytes. The declared six-event state and digest are checked independently. [tests/e2e/e2e1_slice/index.js:58-86](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/e2e1_slice/index.js#L58-L86), [tests/e2e/e2e2_scenario.test.js:12-48](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/e2e2_scenario.test.js#L12-L48), [tests/fixtures/golden_scenario.json:11-59](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/fixtures/golden_scenario.json#L11-L59). |
| `07a5cc21`, G-AI live prerequisite and custody checks | **FIXED at the inspected gate.** Missing live flags block; success requires the A1–A8 checks, negative controls, and cleanup. Pixel change is accompanied by independently checked Wender and battery-state change. [tests/e2e/e2e1_slice/g_ai_stack.py:40-42](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/e2e1_slice/g_ai_stack.py#L40-L42), [tools/gate_g_ai.py:277-329](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tools/gate_g_ai.py#L277-L329). Actual private-component execution remains **Not verified**. |
| `505a7333`, `65e86ecc`, `9e142208`, native-evidence requirement | **FIXED at the product tool endpoint.** Native identity/action/focus/time checks precede recomputation of verification. The public verifier probe separately rejects changed surface and frame generation. [core/src/serve/tools.rs:449-512](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/core/src/serve/tools.rs#L449-L512), [tests/e2e/e2e1_slice/verify-receipt.rs:29-41](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/e2e1_slice/verify-receipt.rs#L29-L41). The demo's timestamp projection has residual finding T8-R3-15; no native-verification bypass is claimed. |
| R1-115/R1-116, `12cc5a1e`, `4e135480`, control/drain/release refresh | **FIXED in scoped state-machine oracles.** A genuinely pending proposal is cancelled; held proposals refuse; premature release refuses; a post-release old frame refuses; a newer frame re-admits; permits cannot be reused. [tests/e2e/ac04_control.test.js:1074-1185](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/ac04_control.test.js#L1074-L1185), [daemon-adapter/internal/capsule/manager_handoff_test.go:42-111](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/daemon-adapter/internal/capsule/manager_handoff_test.go#L42-L111), [core/tests/human_input_control.rs:111-168](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/core/tests/human_input_control.rs#L111-L168). Optimized LIVE assertions and the e2e26 post-release presentation test have separate residuals. |
| `3ff4ce57`, `73d79bf6`, failed-input settlement and waiter cleanup | **FIXED for the tested cooperating handlers.** Validation/body/route/schema/auth failures cancel before draining workers; six input-failure classes emit one correlated unverified receipt; successful destroy deletes epochs/refresh while retaining anti-replay history. [daemon-adapter/internal/ipc/client.go:162-191](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/daemon-adapter/internal/ipc/client.go#L162-L191), [daemon-adapter/internal/daemon/stream.go:194-223](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/daemon-adapter/internal/daemon/stream.go#L194-L223), [daemon-adapter/internal/daemon/input_settlement_test.go:54-169](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/daemon-adapter/internal/daemon/input_settlement_test.go#L54-L169), [daemon-adapter/internal/capsule/manager_a2_test.go:219-288](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/daemon-adapter/internal/capsule/manager_a2_test.go#L219-L288). Exact-code exhaustiveness and arbitrary cancellation-ignoring handlers are not proved. |
| `adb38c74`, `d1baebeb`, `43b8e800`, human-input gating and recovery | **FIXED in the inspected UI and real-core/adapter seams.** e2e27 covers 33-event LIMIT, empty SCHEMA, sequence reuse, refusal recovery, and ordered coalescing. The companion uses the real Rust server, compiled Go adapter, and product input bridge, with a fake native CLI. [tests/e2e/e2e27_human_input.test.js:620-876](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/e2e27_human_input.test.js#L620-L876), [core/tests/human_input_real_adapter.rs:469-653](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/core/tests/human_input_real_adapter.rs#L469-L653), [core/tests/human_input_real_adapter.rs:1111-1281](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/core/tests/human_input_real_adapter.rs#L1111-L1281). Actual native OpenSuperficies dispatch remains **Not verified**. |
| `c3307a44`, AC-02 telemetry | **PARTLY FIXED.** FPS and generation are sampled from the running fixture; fixed numeric claims were replaced. The sampled quantity is a projection tag, not a successful paint, and maximum silence is absent: T8-R3-06/07. [tests/e2e/live-main.cjs:62-93](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/live-main.cjs#L62-L93). |
| `eababead`, fixed capture deadlines | **FIXED structurally.** The next deadline stays on the original grid and skips overruns. Fake-clock tests distinguish slow work, missed slots, and an exact-boundary overrun. [daemon-adapter/internal/frames/subscriptions.go:275-284](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/daemon-adapter/internal/frames/subscriptions.go#L275-L284), [daemon-adapter/internal/frames/subscriptions_cadence_test.go:109-164](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/daemon-adapter/internal/frames/subscriptions_cadence_test.go#L109-L164). This does not prove an OS scheduling-latency bound. |
| `65314760`, `b21afc62`, `5cee47d6`, dedup and retention | **FIXED for changed/unchanged publication and conditional retention.** Unchanged encoded or decoded RGB returns `changed=false`; confirmations precede dedup. Caps can override retention age. The hard global cap has T8-R3-01. [daemon-adapter/internal/frames/subscriptions.go:202-274](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/daemon-adapter/internal/frames/subscriptions.go#L202-L274), [daemon-adapter/internal/frames/publisher.go:294-340](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/daemon-adapter/internal/frames/publisher.go#L294-L340), [daemon-adapter/internal/frames/publisher.go:386-466](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/daemon-adapter/internal/frames/publisher.go#L386-L466). |
| `db627f1d`, `dd6faab6`, `2f7ab82c`, `9b672341`, `42f789c4`, `ef9e9f71`, `ba0341a1`, production frame journey | **FIXED for the actual finite traces.** The former todo is active; surface generation 1 and frame generation 3 are distinguished; all three delivered frames are PRESENTED, waiting text is absent, wall↔multislot colors are checked at generations 3–7, and rotating files produce changing pixels. [tests/e2e/e2e25_production_frames.test.js:1101-1210](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/e2e25_production_frames.test.js#L1101-L1210). These are not a general per-surface burst ledger or HD retention proof. |
| `b7763a88`, `e10f1106`, fresh builds | **FIXED for watched source, materialized kit, and artifact-tree changes.** The dependency lockfile is missing from the watched inputs (T8-R3-04), and supplied LIVE binaries follow a separate weaker path (T8-R3-05). [tests/e2e/ac-harness.cjs:33-35](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/ac-harness.cjs#L33-L35), [tests/e2e/ac-harness.cjs:449-460](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/ac-harness.cjs#L449-L460), [tests/e2e/ac-harness.cjs:526-551](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/ac-harness.cjs#L526-L551). |
| `b6c32ed8`, control under frame load | **PARTLY FIXED.** The production UI/bridge journey checks control state, ordering, latency and FPS against a fixture core. The post-release progress check can consume pre-release frames (T8-R3-08). [tests/e2e/e2e26_control_with_frames.test.js:638-785](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/e2e26_control_with_frames.test.js#L638-L785). |
| `4b85c870`, SCM_RIGHTS handoff | **FIXED baseline, STILL_OPEN size regression.** An authenticated same-user transfer and second-attach refusal exist; a buffered reply can exceed the client's own cap after ownership is consumed (T8-R3-02). [tests/e2e/e2e1_slice/stack.py:292-455](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/e2e1_slice/stack.py#L292-L455). |
| `8e4d9790`, `0104b3b9`, demo checkpoints and focus no-op | **FIXED baseline.** The ordered checkpoint audit and explicit unverified focus no-op are present. Do not misreport the intentional no-op as a verified action. [tests/e2e/e2e1_slice/demo_agent_drive.py:511-585](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/e2e1_slice/demo_agent_drive.py#L511-L585), [tests/e2e/e2e1_slice/test_demo_agent_drive.py:390-443](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/e2e1_slice/test_demo_agent_drive.py#L390-L443), [tests/e2e/e2e1_slice/test_demo_agent_drive.py:548-581](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/e2e1_slice/test_demo_agent_drive.py#L548-L581). |
| `e9c8509c`, `2ca704bf`, `60790e11`, `9dcbd69c`, stack/tick/receipt/expiry work | **PARTLY VERIFIED.** The stack configuration, bounded supervisor, and expiry-recovery oracle exist; receipt/expiry failures are explicit in ordinary interpretation. [tests/e2e/e2e1_slice/live.py:543-623](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/e2e1_slice/live.py#L543-L623), [tests/e2e/e2e1_slice/stack.py:1246-1300](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/e2e1_slice/stack.py#L1246-L1300). Timing, actual TICK behavior, and the full private display run were not re-executed; do not restate the prompt's historical measurements as new measurements. |
| `dff17a45`, `7bb10ae1`, nested depth | **FIXED at the inspected schema/catalog/adapter boundaries.** Depth 2 is schema-invalid, adapter depth checks are explicit, and depth 1 requires the sanctioned desktop profile. The socket test deliberately observes disconnect plus `Decode(InvalidField)`, not a fabricated wire error. [contracts/v0.2/surface_request.schema.json:54-58](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/contracts/v0.2/surface_request.schema.json#L54-L58), [core/src/catalog/launch.rs:114-159](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/core/src/catalog/launch.rs#L114-L159), [daemon-adapter/internal/capsule/manager.go:138-180](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/daemon-adapter/internal/capsule/manager.go#L138-L180), [daemon-adapter/internal/capsule/manager.go:354-382](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/daemon-adapter/internal/capsule/manager.go#L354-L382), [tests/e2e/e2e19_nested.test.js:894-930](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/e2e19_nested.test.js#L894-L930). |
| `cb6dc166`, QA anchors | **FIXED at the exposed seam.** Exact keys, dense row array, integer positive rectangles, UTF-8 byte cap and disabled-before-registration behavior are explicit. [ui/electron/qaAnchors.js:127-203](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/ui/electron/qaAnchors.js#L127-L203), [ui/electron/qaAnchors.js:273-302](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/ui/electron/qaAnchors.js#L273-L302), [ui/electron/qaAnchors.js:389-400](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/ui/electron/qaAnchors.js#L389-L400). Runtime races and T4 internals are outside this proof. |
| `de2c69c0`, `a317fddb`, `dbbc8dba`, `e2ebbec0`, capture and destination | **FIXED for the inspected list/configuration seams.** The host lists sealed recordings with correlated replies, and invalid configured destinations preserve `SETTINGS_DESTINATION` in main-binding tests. [core/src/serve/capture.rs:827-949](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/core/src/serve/capture.rs#L827-L949), [ui/test/rv9-elec-regressions.test.js:164-195](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/ui/test/rv9-elec-regressions.test.js#L164-L195). AC-07's declared five-minute soak is not connected to its actual journey: [tests/e2e/ac07_ram_first.test.js:1068-1147](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/ac07_ram_first.test.js#L1068-L1147). |
| `b087f776`, `3e48c2da`, `c3a79ddc`, CLI and pin resolver | **FIXED for inspected entry validation and gate provenance checks.** Default/compatibility v0.2 parsing requires identity and limits, validates request shape, and differentiates usage/transport errors from tool refusals. [agents/metaviewer_agents/mvctl.py:403-554](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/agents/metaviewer_agents/mvctl.py#L403-L554), [agents/metaviewer_agents/mvctl.py:557-563](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/agents/metaviewer_agents/mvctl.py#L557-L563), [tools/gate_g_ai.py:190-215](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tools/gate_g_ai.py#L190-L215). Full T3 envelope-client internals were not re-reviewed. |
| `e74c0fda`, layout intents | **FIXED for closed wire bounds and visibility transitions.** Hidden placement changes refuse; numeric and shape controls exist. [core/src/serve/layout.rs:1-43](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/core/src/serve/layout.rs#L1-L43), [tests/test_layout_intents.py:8-40](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/test_layout_intents.py#L8-L40). These contracts do not assert non-overlapping float packing or a group-size-dependent insertion index. |
| `9ac428d5`, `e3885467`, gate precedence and cleanup | **FIXED for inspected gate semantics.** Earlier failure survives later passes; precedence is timeout, blocked, failure, success. Subreaper cleanup and standard-library parsing are present. [tools/gate.sh:966-978](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tools/gate.sh#L966-L978), [tools/gate.sh:1178-1207](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tools/gate.sh#L1178-L1207), [tools/gate.sh:1529-1536](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tools/gate.sh#L1529-L1536). Cross-architecture aggregate receipt implementation (`cd4eec02`) remains T7 ownership. |
| `5a8efe28`, added journey map; `561d0b76`, RSS | **PARTLY VERIFIED.** Security checks real Chromium flags/CSP/preload and an unsafe negative control; RSS explicitly qualifies the shell workload and rejects a planted renderer excess; the launcher checks every offered kind and non-revival. [tests/e2e/e2e16_electron_security.test.js:13-45](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/e2e16_electron_security.test.js#L13-L45), [tests/e2e/e2e18_budgets.test.js:1-58](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/e2e18_budgets.test.js#L1-L58), [tests/e2e/e2e21_launcher.test.js:16-44](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/e2e21_launcher.test.js#L16-L44). Long soak calibration has T8-R3-09. |
| `b4de49c8`, `1420c239`, `0da9e5b6`, hosted/locked-driver work | **FIXED in the scoped driver.** Cargo receipts identify artifacts; builds are offline and locked; the driver allowlists four environment keys. [tests/e2e/core-driver.js:8-60](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/core-driver.js#L8-L60). This does not make every Electron/Python runner hermetic. |
| `51f4a770`, `079c2a99`, `a703450c`, `1550412b`, `b8e0ae37`, `f6597790`, and other-topic peer/state/packaging landings | **No blanket re-certification.** The report evaluates their observable T8 consequences and the scoped tests above. Journal poison/checkpoint internals, claimed ~52 ms timings, a hard 50 ms loss bound, all hosted ceilings, package/version refusal, and statistical flake closure are **Not verified** unless explicitly supported below. They are not counted again as unfixed product defects merely because runtime evidence was unavailable. |

The known-open native provider loop, native 600-second soak, handshake timing, video sealing, and remaining native lifecycle/PTY journeys remain open. Hosted scaffolding and short production-renderer traces must keep their actual scope. In particular, `tests/test_e2e_ai_loop.py` labels its fake-provider/adapter-seam loop hosted; a passing 9-of-10 sample is not a population reliability guarantee. AC-06's fixture manipulates local session/DOM/input evidence; its production terminal/native-input proof remains separate from the now-fixed e2e25 pixel round trip. [tests/e2e/live-multislot.cjs:75-198](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/live-multislot.cjs#L75-L198), [tests/e2e/ac06_multislot.test.js:937-950](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/ac06_multislot.test.js#L937-L950).

**A specification correction matters:** a refused proposal intentionally appends an audit event and anti-replay history. The literal demand that refusal mutate neither *journal* nor budget is contradicted by the golden itself. The correct safety property is unchanged domain effects and budget, no dispatch, settled pending work, and deterministic refusal auditing. [tests/e2e/e2e1_slice/scenario.rs:31-37](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/e2e1_slice/scenario.rs#L31-L37), [tests/fixtures/golden_scenario.json:13-55](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/fixtures/golden_scenario.json#L13-L55). This is not counted as a new product bug.

## Formal invariants

Notation: a trace is a finite sequence of admitted protocol inputs; `domain(S)` excludes audit and anti-replay bookkeeping. `J` is the journal byte string, `H` the declared canonical-state digest, and `G` the pinned golden. “Proved” here denotes the stated implication in inspected code or an elementary derivation; it does not replace a live execution.

### IN-SLICE — scoped completion and fail-closed prerequisites

For every supported configuration \(e\), let \(R(e)\) be the declared runner mode and \(C(e)\) its completion result. The intended predicate is

\[
R(e)=hosted\land C(e)=PASS
\Rightarrow J_1=J_2\land S_1=S_2\land H_1=H_2,
\]
\[
R(e)=LIVE\land\neg flag(e)\Rightarrow E2E\_GATE,\qquad
R(e)=LIVE\land flag(e)\land\neg prerequisites(e)\Rightarrow nonzero,
\]
\[
R(e)=G\!-\!AI\land\neg liveEnvironment(e)\Rightarrow BLOCKED\land rc\ne0.
\]

**Proof/limit.** Hosted comparisons precede returning `hosted-core-only`; flag and listed-variable checks explicitly throw `E2E_GATE`/`E2E_PREREQ`. [tests/e2e/e2e1_slice/index.js:9-15](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/e2e1_slice/index.js#L9-L15), [tests/e2e/e2e1_slice/index.js:58-86](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/e2e1_slice/index.js#L58-L86). G-AI catches failure without setting its zero success status. [tools/gate_g_ai.py:317-329](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tools/gate_g_ai.py#L317-L329). The stronger literal claim “every later missing LIVE prerequisite has exactly E2E_PREREQ” is not established: later Electron/Xvfb failures become a blocked live report. More importantly, PASS strings can survive erased Python assertions (T8-R3-03), and binary provenance is not bound to the advertised source SHA (T8-R3-05). **Verdict: hosted predicate supported; universal LIVE qualification refuted by concrete harness counterexamples.** E9/E11/E12; tests T01/T02/T03.

### IN-REPLAY — fixed reference, byte determinism and process purity

For the declared six-event input \(I\), for each checked architecture \(a\), and each repeat \(r\in\{1,2\}\):

\[
Replay_a(J_{a,r})=Direct_a(I)=G,\quad
J_{a,1}=J_{a,2},\quad
VerifyOnly(J_{a,r})=(rc=0,stdout=\epsilon,stderr=\epsilon).
\]

Here \(G=\)`28b88ad39277c9e2dfe5d494973b8c9c428c2d7c92eaafa40ea7fcd1f6d686e5` [CITED: [tests/fixtures/golden_scenario.json:58](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/fixtures/golden_scenario.json#L58)]. For the tested semantic tamper and duplicate transformations \(m\), require \(rc(Replay(m(J)))\ne0\). Under the installed denial instruments, require unchanged output and archive bytes.

**Proof/limit.** The expected state is declared in the fixture, independently canonicalized, and a budget mutant differs. The test compares both run records, including journals; the driver checks both output streams for verify-only. [tests/e2e/e2e2_scenario.test.js:12-48](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/e2e2_scenario.test.js#L12-L48), [tests/e2e/core-driver.js:52-60](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/core-driver.js#L52-L60). The purity leg proves that its clock/network/model instruments are live, refuses a duplicate with rc 3, and checks the archive before and after. [tests/e2e/e2e12_replay_purity.test.js:43-99](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/e2e12_replay_purity.test.js#L43-L99). Existing CI is green on both architectures, but the full retained per-architecture journal/digest artifacts were not inspected. Libc clock interposition plus network/process tracing does not prove absence of direct clock syscalls, direct vDSO/cycle-counter access, or every possible model-loading path. Prefix truncation also needs a trusted terminal commitment; see B3. **Verdict: fixed six-event oracle supported; universal purity/completeness is bounded by the instrumentation.** E1/E2/E3/Q3; tests T04/T05.

### IN-CONTROL — human ownership, drain, fresh release fence and single-use permits

For every active surface \(s\), let the states be \(A\) (agent-ready), \(H_D\) (human-held with cancelled work draining), \(H_0\) (human-held, drained), and \(A_R\) (released, awaiting a fresh frame).

\[
A\xrightarrow{take}H_D\ \text{or}\ H_0;\quad
H_D\xrightarrow{drain}H_0;\quad
H_0\xrightarrow{release}A_R;\quad
A_R\xrightarrow{freshFrame}A.
\]

For all agent proposals \(p\), \(state(s)\in\{H_D,H_0\}\Rightarrow refusal(p)=SURFACE\_NOT\_AGENT\_CONTROLLED\). Release from \(H_D\) refuses with POLICY. In \(A_R\), an old frame must refuse STALE_FRAME at the core; a newer committed frame beyond the release fence is required before admission. Once a permit is used, it stays unusable.

**Proof/limit.** The adapter cancels pending work, requires drain before release, marks refresh, and retains used permits; its local pre-refresh refusal is POLICY, not the core's STALE_FRAME. These are different interfaces, not interchangeable codes. [daemon-adapter/internal/capsule/handoff.go:35-99](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/daemon-adapter/internal/capsule/handoff.go#L35-L99), [daemon-adapter/internal/capsule/manager.go:698-714](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/daemon-adapter/internal/capsule/manager.go#L698-L714). The real-core arbitration script asserts the complete sequence and exact markers, including a nonempty cancellation set. [tests/e2e/ac04_control.test.js:1074-1185](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/ac04_control.test.js#L1074-L1185). A durable core test also refuses re-publication of the old generation before accepting the newer one. [core/tests/human_input_control.rs:111-168](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/core/tests/human_input_control.rs#L111-L168). **Verdict: underlying scoped arbitration supported; optimized LIVE assertions and the e2e26 progress oracle remain defective.** E5/E13; tests T01/T06/T07.

### IN-RECEIPT — native proof and an independently recomputed effect

For every proposal \(p\), before-observation \(b\), and raw executor receipt \(r\):

\[
WaitVerified(p,b,r)\Rightarrow N(p,b,r)\land V(p,b,r),
\]

where \(N\) requires native evidence with matching surface, nonempty native surface identity, expected action kind, result “ok,” verified focus, and the explicit timestamp ordering. \(V\) is recomputation against the retained before/after evidence and proposal binding. For the G-AI semantic task, also require changed canonical Wender state and changed battery state within the declared tick window.

**Proof/limit.** Absence of native evidence returns failure before pixel verification; the incoming success bit is not used as the oracle. [core/src/serve/tools.rs:449-504](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/core/src/serve/tools.rs#L449-L504). G-AI checks the semantic effect independently of frame change. [tools/gate_g_ai.py:277-302](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tools/gate_g_ai.py#L277-L302). The successful public result deliberately projects native proof into separate fields; the demo subsequently mislabels an execution timestamp as a native monotonic timestamp (T8-R3-15). The public `verify-receipt.rs` probe alone is not the entire tool endpoint and must not be used to “prove” its native-evidence precondition. **Verdict: pixels-only success is excluded at the inspected endpoint; transcript provenance and an exhaustive cross-language receipt matrix still need work.** E1/E4/E8/Q3; tests T08/T09.

### IN-CADENCE — fixed deadlines, truthful presentation telemetry and dedup

For every subscription \(s\), with period \(T_s>0\), initial grid origin \(d_0\), and work completion \(c_i\):

\[
d_{i+1}=\min\{d_0+kT_s:d_0+kT_s>c_i\}.
\]

For every folded interval with changing captured content, successful presentation count is constant while capture generation advances. For byte-identical frames after the configured initial confirmations, publication generation does not advance. For a qualifying visible interval, the full presentation-rate and maximum-gap predicate B4 must hold.

**Proof/counterexample.** Fixed-phase scheduling and skipped-deadline accounting follow the integer remainder calculation; dedup suppresses emission only after confirmations. [daemon-adapter/internal/frames/subscriptions.go:202-284](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/daemon-adapter/internal/frames/subscriptions.go#L202-L284). This proves the scheduled grid, not execution exactly on that grid. AC-02 can count an unpainted changing tag and can hide a four-second stall in a high whole-window mean (T8-R3-06/07). **Verdict: scheduling/dedup structure supported; the AC-02 presentation/soak implication is false.** E6/E7/Q2/Q4; tests T10/T11/T12.

### IN-ROUTING — ownership comes from the publication authority

For every non-null reported pair \((s,f)\), and supplied publication map \(M\):

\[
Accept(s,f,M)\Rightarrow f\in dom(M)\land M(f)=s.
\]

An opaque \(f\) without \(M\), a missing entry, a foreign owner, or conflicting ownership must produce E2E_ROUTING. The no-map hosted fixture is separately restricted to its declared exact `frame-<capsule>-gen7` recipe.

**Proof/limit.** The validator rejects non-Map ledgers and compares the reported owner to an independent lookup; its fallback does not admit arbitrary opaque strings. [tests/e2e/harness.js:469-504](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/harness.js#L469-L504). The live-wall caller separately requires non-null frames. [tests/e2e/e2e1_wall.test.js:409-419](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/e2e1_wall.test.js#L409-L419). The routing predicate is supported, but qualification can misclassify an unrelated mutant-process failure as a killed routing mutant (T8-R3-10). **Verdict: routing validation fixed; mutant attribution still open.** E4/E6/E7; tests T13/T14.

### IN-SETTLE — terminal work, unchanged domain effects and intentional refusal auditing

For every pre-admission refusal \(p\):

\[
dispatch(p)=false,\quad domain(S')=domain(S),\quad budget(S')=budget(S).
\]

For every dispatched input \(p\) whose native work terminates or cooperatively cancels, the owning protocol must emit exactly one terminal outcome and complete the required drain so \(p\notin pending\). After successful verified destroy of \(s\), \(s\notin inputEpochs\land s\notin refresh\), while used-permit history is preserved.

**Counterexample to the literal journal clause.** The stale golden step explicitly requires \(\Delta coreSeq=1\) and unchanged domain/budget. Thus \(J'=J\) is false by design. [tests/e2e/e2e1_slice/scenario.rs:31-37](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/e2e1_slice/scenario.rs#L31-L37). Native failures, unsupported actions, capture/publication failures, takeover and loss have one-receipt tests; first-error cancellation precedes worker drain. [daemon-adapter/internal/daemon/input_settlement_test.go:54-169](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/daemon-adapter/internal/daemon/input_settlement_test.go#L54-L169), [daemon-adapter/internal/ipc/client_test.go:494-544](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/daemon-adapter/internal/ipc/client_test.go#L494-L544). Destroy cleans the two per-surface maps only after verified removal. [daemon-adapter/internal/capsule/manager.go:553-564](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/daemon-adapter/internal/capsule/manager.go#L553-L564). **Verdict: corrected domain/settlement property supported for the tested handlers; literal journal immutability refuted.** E5/E8; tests T15/T16.

### IN-HEADLESS — explicit reproducibility envelope and typed prerequisite refusal

The literal requested predicate is, for every headless gate \(g\):

\[
Env(g)\subseteq E_{allowed},\quad seed(g)=seed_0,\quad
geometry(g)=1280\times900\times24,
\]
\[
missingPrerequisite(g)\Rightarrow typedNonzero(g)\land\neg skip(g),
\]
with logic assertions independent of ambient clock, randomness, terminal, and network.

**Counterexamples/limits.** The core driver is narrowly allowlisted and locked, but the Electron wrapper copies the environment and removes only `ELECTRON_RUN_AS_NODE`; LIVE Python inherits it too. [tests/e2e/core-driver.js:8-25](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/core-driver.js#L8-L25), [tests/e2e/harness.js:713-727](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/harness.js#L713-L727), [tests/e2e/e2e1_slice/index.js:22-24](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/e2e1_slice/index.js#L22-L24). The private stack starts a 1600×1000×24 display, and e2e26 obtains latency from Date.now. [tests/e2e/e2e1_slice/stack.py:1297-1300](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/e2e1_slice/stack.py#L1297-L1300), [tests/e2e/e2e26_control_with_frames.test.js:643-677](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/e2e26_control_with_frames.test.js#L643-L677). The inherited `PYTHONOPTIMIZE` counterexample is consequential, not merely a style preference. Missing native tools have explicit E2E_PREREQ tests. [tests/e2e/e2e12_replay_purity.test.js:103-129](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/e2e12_replay_purity.test.js#L103-L129). **Verdict: universal literal invariant does not hold.** Deterministic logic tests should use supplied clocks; performance measurements must declare their real-clock/environment envelope rather than claim clock independence. E11/E12/E13/E14; tests T01/T17.

### Required refresh-surface postconditions

These refine the eight invariants rather than introducing another acceptance label.

- **Frame accounting:** for every \((surface,streamEpoch)\), unique posted deliveries equal PRESENTED + REFUSED + other terminal drops + in-flight deliveries. At quiescence the last term is zero. Pre-post reader/port refusals belong to a separate attempted-input ledger. The exact e2e25 finite counts are present, but global counters plus a 16-event tail cannot establish arbitrary per-surface uniqueness or conservation. [ui/electron/frameDiag.js:379-408](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/ui/electron/frameDiag.js#L379-L408), [ui/electron/frameDiag.js:618-638](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/ui/electron/frameDiag.js#L618-L638), [tests/e2e/e2e25_production_frames.test.js:1111-1209](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/e2e25_production_frames.test.js#L1111-L1209). See B5/T18.
- **Nested feasibility:** default omitted depth to zero; require depth in \(\{0,1\}\), registered matching profile/kind/geometry, and \(depth=1\Rightarrow desktop\_capsule\land program=metaviewer\text{-}nested\land geometry=1280\times720\). The adapter additionally requires desktop kind whenever the depth field is explicitly supplied, even if zero. Schema-invalid depth 2 is a decode/disconnect at the core wire, a `nested_depth` fault in the direct adapter seam, and an invalid configuration when installed as an inadmissible profile. [daemon-adapter/internal/capsule/manager.go:138-180](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/daemon-adapter/internal/capsule/manager.go#L138-L180), [daemon-adapter/internal/capsule/manager.go:354-382](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/daemon-adapter/internal/capsule/manager.go#L354-L382), [tests/e2e/e2e19_nested.test.js:894-930](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/e2e19_nested.test.js#L894-L930). See B6/T19.
- **QA bounds/inertness:** every accepted snapshot has exact top-level keys \(\{schema,seq,rows\}\), positive safe-integer sequence, a dense row array of length at most 512, exact closed row/rectangle keys, positive integer rectangle dimensions, and at most 65,536 UTF-8 bytes after normalization. Disabled, nested or normal packaged operation registers no QA handler; an illicit packaged live flag refuses instead of enabling it. [ui/electron/qaAnchors.js:127-203](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/ui/electron/qaAnchors.js#L127-L203), [ui/electron/qaAnchors.js:273-302](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/ui/electron/qaAnchors.js#L273-L302), [ui/electron/qaAnchors.js:393-400](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/ui/electron/qaAnchors.js#L393-L400). See B8/T20.
- **Input admission:** for each batch, valid shape, fresh sequence/stream identity, active controlled surface, applicable WRITE/focus policy, and \(1\le n\le32\) are necessary; READ sends are undelivered. UI, core and adapter codes must be asserted at their own layer. The real-core/adapter companion supports settlement and subsequent release/retake, with a fake native CLI. [tests/e2e/e2e27_human_input.test.js:620-876](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/e2e27_human_input.test.js#L620-L876), [core/tests/human_input_real_adapter.rs:469-653](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/core/tests/human_input_real_adapter.rs#L469-L653), [core/tests/human_input_real_adapter.rs:1159-1281](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/core/tests/human_input_real_adapter.rs#L1159-L1281). See T21.

## Quantitative bounds

### Context7 query and applicability audit

All seven requested strings were submitted exactly to `/oguirado/math-router`. Its public `llms.txt` and the selected source reading maps/anchors were inspected. The retrievals did **not** supply applicable proofs for the requested engineering bounds. Therefore every bound below is **[DERIVED]**, with its assumptions and derivation; no unrelated theorem is borrowed.

The following records every distinct returned paper. “No fragment returned” is intentional; a heading or item name is not silently promoted into an invented anchor.

| Query | Returned paper IDs and explicit fragments | Follow-up and applicability |
|---|---|---|
| Q1: `sequential hypothesis testing for loss detection` | PM-140.2 `#stmt-inc-history`; PM-298.1, no fragment returned; PM-122.3, no fragment returned; PM-324.2 `#stmt-lem-tail-separation`. | PM-140.2's source/reading map identifies Gaussian-regression conditional information, with canonical `#pm-s7`; this is not an SPRT result. The other returned subjects were free entropy, trace reconstruction, and Banach-space detectors. No loss-detector theorem transferred. |
| Q2: `concentration bounds for flaky-test rates` | PM-235.3, PM-235.1, PM-222.4, PM-149.1: no explicit fragments returned. | PM-235.3 was followed to `#pm-s7`, `#sec:introduction`, and `#sec:interfaces`: random-k-SAT hitting-time variance. Returned item labels `window-location`/`classwise_uniformity` are not asserted as URL anchors. No IID flaky-test bound transferred. |
| Q3: `Merkle hash-chain security bounds second preimage` | No hit, paper ID, or anchor returned. | **ABSENT — do not invent.** B3 states an explicit ideal-hash assumption instead of claiming a retrieved SHA-256 security proof. |
| Q4: `fixed-deadline scheduling jitter real-time` | PM-124.1 `#stmt-thm-main`; PM-130.1, no fragment returned. Other PM-124.1 blocks had no fragment. | The inspected PM-124.1 theorem concerns an offline three-machine unit-job model; its source excludes communication delays and does not provide practical timing guarantees. No polling-jitter bound transferred. |
| Q5: `queueing backpressure drop-oldest loss bounds` | PM-034.12, PM-227.7, PM-063.1, PM-099.1: no explicit fragments returned. | PM-034.12 was followed to its actual `#stmt-thm-main` and negative-knowledge item AU-04. It concerns arithmetic degrees; AU-04 expressly excludes queue-sizing transfer. The later-followed theorem fragment was not a fragment returned by Q5. |
| Q6: `constraint feasibility layout rectangle packing` | PM-118.1 `#stmt-thm-unbounded-gap`; its other returned blocks had no fragment. | The inspected source/reading map describes one-dimensional rational bin-packing hardness/configuration gaps, not this UI's two-dimensional feasibility contract. |
| Q7: `combinatorial coverage pairwise test design` | PM-092.1, PM-113.2, PM-320.1, PM-118.1: no explicit fragments returned. | PM-092.1's inspected reading map describes lattice covering of convex bodies. No covering-array minimum for software inputs was recovered. B7 proves the narrower precedence result directly. |

Selected followed sources: [PM-140.2 reading map](https://github.com/oguirado/math-router/blob/main/papers/EN-114-000-0003-2-2026-PR-T4-UK-EX-M1-B-ML-M-0287_PM-140.2_Posterior_replicas_and_conditional_information_in_Gaussian_regression.md#pm-s0), [PM-235.3 reading map](https://github.com/oguirado/math-router/blob/main/papers/EN-115-000-0003-2-2026-PR-T4-UK-EX-M2-B-ML-M-0471_PM-235.3_Variance_of_the_Random_k_SAT_Hitting_Time.md#pm-s0), [PM-124.1 theorem](https://github.com/oguirado/math-router/blob/main/papers/EN-114-000-0022-2-2026-PR-T4-UK-EX-M1-B-ML-H-0261_PM-124.1_A_Polynomial_Time_Algorithm_for_Three_Machine_Unit_Job_Scheduling.md#stmt-thm-main), [PM-034.12 theorem](https://github.com/oguirado/math-router/blob/main/papers/EN-103-000-0000-2-2026-PR-T4-UK-EX-M3-C-TO-M-0094_PM-034.12_Arithmetic_Stein_degree_bounds_for_log_CalabiYau_pairs.md#stmt-thm-main), [PM-118.1 reading map](https://github.com/oguirado/math-router/blob/main/papers/EN-114-000-0022-2-2026-PR-T4-UK-EX-M1-B-ML-H-0253_PM-118.1_Additive_hardness_and_unbounded_configuration_gaps_in_bin_packing.md#pm-s0), [PM-092.1 reading map](https://github.com/oguirado/math-router/blob/main/papers/EN-108-000-0003-2-2026-PR-T4-UK-EX-M2-B-TO-H-0203_PM-092.1_A_single_lattice_covering_bound_of_order_n_log_n.md#pm-s0). These are citations of the retrieval audit and non-applicability, not support for the bounds.

### B1. Clean-run confidence, concentration bounds and the 9-of-10 bar [DERIVED]

Assume independent, identically distributed Bernoulli run failures with fixed probability \(p\), and fix the run count before inspecting results. Zero failures in \(n\) runs has probability \((1-p)^n\). For testing \(p\ge p_0\), that probability is largest at \(p=p_0\). Thus a one-sided error level \(\delta\) requires

\[
(1-p_0)^n\le\delta,\qquad
n\ge\left\lceil{\ln\delta\over\ln(1-p_0)}\right\rceil .
\]

The zero-failure upper confidence endpoint is \(p_U=1-\delta^{1/n}\).

| Claim after zero failures | Required clean runs, one architecture | Required clean runs per architecture for both simultaneously |
|---|---:|---:|
| \(p<0.01\), confidence at least 95% | 299 | 368 |
| \(p<0.05\), confidence at least 95% | 59 | 72 |

The simultaneous column allocates \(\delta/2=0.025\) to each architecture; the probability that either conclusion is wrong is at most the sum, 0.05. Independence between architectures is unnecessary for that union bound. Independence/stationarity within the claimed run population remains necessary. Twenty clean runs yield only \(p_U\approx0.139108\); 300 yield \(p_U\approx0.00993608\) for one architecture. The mandatory 300-run rung is therefore meaningful under this model, while x20 is not a 1% or 5% flake certificate. Pooling the two architectures is unjustified without a shared-distribution argument.

For comparison, the elementary Hoeffding bound can be derived here rather than cited without a source. For centered Bernoulli \(Y=X-p\), let \(g(\lambda)=\ln E[e^{\lambda Y}]\). Its second derivative is the variance of a tilted Bernoulli and is at most \(1/4\); \(g(0)=g'(0)=0\), so integrating twice gives \(g(\lambda)\le\lambda^2/8\). Independence and Markov's inequality yield
\[
P(\bar X-p\le-\epsilon)\le\exp(-\lambda n\epsilon+n\lambda^2/8).
\]
Taking \(\lambda=4\epsilon\) gives \(\exp(-2n\epsilon^2)\). At zero observed failures, this requires 14,979 runs for 1%, or 600 for 5%, at \(\delta=.05\). The exact binomial calculation is much tighter.

A variance-sensitive bound follows similarly: \(|Y|\le1\) implies \(E|Y|^k\le E[Y^2]=\sigma^2\), and \(k!\ge2\cdot3^{k-2}\) for \(k\ge2\). Expanding the exponential gives
\[
\ln E[e^{\lambda Y}]\le{\sigma^2\lambda^2\over2(1-\lambda/3)},\quad0<\lambda<3.
\]
With \(\lambda=\epsilon/(\sigma^2+\epsilon/3)\), the resulting bound is
\[
P(\bar X-p\le-\epsilon)\le
\exp\!\left(-{n\epsilon^2\over2(\sigma^2+\epsilon/3)}\right).
\]
For \(\epsilon=p,\ \sigma^2=p(1-p)\), its exponent increases with \(p\), so the worst null is \(p_0\). It needs \(\lceil2(4/3-p_0)\ln(1/\delta)/p_0\rceil\) runs: 793 for 1%, 154 for 5%. Neither bound improves on the exact zero-failure oracle.

The AC-05 sample rule is \(successes\ge9\) in exactly 10 attempts, with every success independently verified. That is a sample acceptance rule, not 95% evidence that the population success probability is at least .9. For nine successes, the one-sided lower endpoint solves
\[
q^9(10-9q)=.05,
\]
approximately \(q=.606\). Even ten successes give only \(.05^{1/10}\approx.7411\). Twenty-nine clean successes are needed for a one-sided 95% statement \(q>.9\), because \(.9^{29}<.05\).

**Oracle:** T22 checks the exact boundary counts \(298/299,\ 58/59,\ 367/368,\ 71/72\), and sample outcomes \(8/10,\ 9/10,\ 10/10\). This is a deterministic arithmetic census: no random seed or empirical confidence is needed to validate the formulas. Actual qualification preserves all mandatory 300 runs, records architecture and attempts, and never resets failures on retry. Correlated frames within one soak do not supply thousands of independent run trials. Q2/E9/E10.

### B2. A bounded sequential loss probe and its limits [DERIVED]

Model one episode with \(X_i=1\) for a missed probe, \(H_0:q_0=.01\) (“healthy”), \(H_1:q_1=.9\) (“loss candidate”), and IID observations within that episode. Define

\[
L_n=\sum_{i=1}^n
\left[X_i\ln90+(1-X_i)\ln(0.1/0.99)\right].
\]

Stop for loss candidate at \(L_n\ge A=\ln100\), or healthy at \(L_n\le B=\ln.05\). Stop as **inconclusive** after 20 observations if neither boundary is hit.

Under \(H_0\), \(e^{L_n}\) has conditional expectation equal to its preceding value, initially 1. Stopping this bounded process preserves expectation 1; the upper-boundary event contributes at least \(100P_0(loss)\), so \(P_0(loss)\le.01\). Under \(H_1\), use \(e^{-L_n}\) and the lower event's value at least 20 to obtain \(P_1(healthy)\le.05\). The inconclusive outcome does not increase either bound.

The increments are \(u=\ln90\approx4.49981\) and \(v=\ln(0.1/0.99)\approx-2.29253\). Let \(N\) include boundary stopping or the 20-sample cap. Independence of the next increment from the decision to take it gives \(E L_N=\mu E N\), by expanding \(L_N=\sum_{i=1}^{20}Y_i1_{\{N\ge i\}}\). Since \(L_N\le A+u\) and \(L_N\ge B+v\),

\[
E_1N\le{A+u\over D(.9\Vert.01)}\approx2.3832,\quad
E_0N\le{-B-v\over D(.01\Vert.9)}\approx2.3772,
\]
where direct expansion gives the drifts \(D(.9\Vert.01)\approx3.820575\) and \(D(.01\Vert.9)\approx2.224611\). These are mean sample counts over all outcomes, not conditional times to a correct loss declaration.

With probe starts every 250 ms and a 100 ms per-probe deadline [TARGET], two consecutive misses from a fresh episode cross the upper threshold in 350 ms from the first start, or 600 ms including the maximum initial phase. Under \(H_1\) that first pair occurs with probability \(.9^2=.81\); it is **not** a worst-case detection guarantee. The capped horizon is \(19\cdot250+100=4850\) ms from first start, or 5100 ms including phase.

**Oracle:** T23 exhausts all \(2^{20}=1,048,576\) binary sequences, applies absorbing decisions, weights each sequence under each hypothesis, and checks the two exact error upper bounds and the cap. No seed or Monte Carlo estimate is involved. For continuous rearming, allocate \(\alpha_j\) with \(\sum_j\alpha_j\le\alpha_{total}\); a per-episode .01 bound is not a lifetime bound. Use the result to request independent absence confirmation, preserving the product's `confirmedAbsent` condition before MarkLost. [daemon-adapter/internal/capsule/manager.go:647-660](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/daemon-adapter/internal/capsule/manager.go#L647-L660). Q1/E4/E8.

### B3. Hash-chain guarantees, truncation and checkpoint coverage [DERIVED]

Assume a fixed trusted 256-bit digest and an ideal uniform hash for each adversarially distinct attempt. For \(q\) attempts at a second preimage, each succeeds with probability \(2^{-256}\), so a union bound gives at most \(q/2^{256}\). For any collision among \(q\) distinct hashed objects, sum over the \(\binom q2\) pairs to obtain at most \(q(q-1)/2^{257}\). For example, at \(q=2^{32}\), the respective bounds are \(2^{-224}\) and less than \(2^{-193}\). These are conditional model bounds, not an unconditional proof about SHA-256.

A semantic byte change, duplication or reorder that changes a committed chain input cannot preserve a trusted terminal chain digest except within that assumption's bound. But a valid prefix has valid links without any collision. Thus **truncation is not authenticated by links alone**: it needs a trusted terminal record count/digest or equivalent external commitment. Likewise a final *state* digest need not commit to every audit event; two effect-equivalent histories can share it legitimately. Harmless serialization whitespace must not be confused with a semantic corruption test.

The current independent golden checks both six events plus the header and the declared final state; its tested semantic mutation and duplicate refuse. [tests/e2e/e2e2_scenario.test.js:18-32](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/e2e2_scenario.test.js#L18-L32), [tests/e2e/e2e12_replay_purity.test.js:90-99](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/e2e12_replay_purity.test.js#L90-L99). Universal tamper completeness is not inferred from those examples.

For checkpoint suffixes through length 64, the number of ordered boundary pairs \(0\le k\le p\le64\) is
\[
\sum_{p=0}^{64}(p+1)={65\cdot66\over2}=2145.
\]
At each pair, compare restoring the state before input \(k\) and applying \([k,p)\) with the independently evaluated straight prefix \([0,p)\). The suffix uses \(p-k\) transitions rather than \(p\), saving exactly \(k\) transitions. The current E2E slice exposes one recovery boundary after the six-event prefix, not this full census. [tests/e2e/e2e1_slice/scenario.rs:38-45](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/e2e1_slice/scenario.rs#L38-L45).

**Oracle:** T04 mutates each of the six semantic event payloads separately, appends a duplicate, swaps each adjacent pair, and removes each possible nonempty suffix; the external full-run oracle must reject every changed history, while a prefix-only replay must not be mislabeled “complete.” T05 runs all 2145 boundary pairs, one fixed deterministic input sequence and declared per-prefix oracle, plus the two architecture receipts. No probabilistic confidence is claimed for this finite coverage. Q3/E1/E2/E3.

### B4. Cadence, silence, buffer lifetime and the soak predicate [DERIVED]

The fixed-deadline recurrence gives \(0<d_{i+1}-c_i\le T\) and grid alignment by construction. It does **not** imply bounded actual start jitter without an OS/scheduler assumption. If actual starts are at most \(J\) late, total capture/publish/delivery work is at most \(W\), and renderer completion adds at most \(R\), then consecutive completed presentations are at most
\[
T+J+W+R
\]
apart: finish one worker, wait at most \(T\) to the next grid deadline, at most \(J\) to start, then at most \(W+R\) to present. If work overruns, slots are skipped; fixed phase alone cannot establish 10 FPS.

The exact existing fake-clock examples use \(T=100\) ms:

| Capture + delivery work | Capture starts | Next wait | Missed slots per completion |
|---|---|---:|---:|
| 30 + 20 ms | 0, 100, 200, 300 ms | 50 ms | 0 |
| 250 + 20 ms | 0, 300, 600, 900 ms | 30 ms | 2 |
| 180 + 20 ms | 0, 300, 600, 900 ms | 100 ms | 2 |

These are [CITED test inputs/oracles], not measurements: [daemon-adapter/internal/frames/subscriptions_cadence_test.go:109-164](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/daemon-adapter/internal/frames/subscriptions_cadence_test.go#L109-L164). Completion exactly on a grid point intentionally selects the following point.

For each of at least four live visible surfaces, define actual unique presentation times \(t_1,\ldots,t_n\) in \((a,b]\), with \(b-a\ge600\) s. Require finite, ordered times, independently verified changing-content presentations, and
\[
n/(b-a)\ge10,\qquad
\max(t_1-a,\max_i(t_{i+1}-t_i),b-t_n)\le2\text{ s}.
\]
During a folded interval, draw/presentation increments must be zero while capture generation advances **for changing content**. After two unchanged confirmations, a static source is a separate dedup case and must not be required to mint fake generations.

The counterexample \(596\cdot25/600=24.8333\ldots\) FPS with a contiguous four-second stall proves that average FPS cannot imply the silence bound. A report with changed tags but zero paints separately refutes paint throughput.

For RGB24 1280×900, \(F=1280\cdot900\cdot3=3,456,000\) bytes. A 128 MiB cap fits only
\[
\lfloor134,217,728/F\rfloor=38
\]
frames. Retaining every frame younger than four seconds at 10 Hz requires at least 40 frames, or 138,240,000 bytes; four such surfaces need 552,960,000 bytes, above 512 MiB. The current cap-before-age policy may evict generation 1 when generation 39 arrives at 3.8 s; at 25 Hz the age is 1.52 s. These are exact constant-frame-size counterexamples to an **unconditional** four-second retention claim, not an extra bug where the contract explicitly lets caps override age. [daemon-adapter/internal/frames/publisher.go:386-401](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/daemon-adapter/internal/frames/publisher.go#L386-L401).

**Oracles:** T10 extends the injected-clock test with seed `0x269`, 4000 completions, work from \(\{0,1,99,100,101,199,200,201,270\}\) ms, and exact grid/missed-count comparison. T11/T12 cover no-paint, a 4000 ms gap, and the full 600 s visible/folded predicates. T24 checks 39 HD-sized changing frames at exact 100 ms/40 ms spacing against the declared cap/retention policy. These deterministic traces do not confer a statistical OS jitter guarantee. A longer correlated soak does not turn its frames into independent trials for B1. Q4/Q2/E6/E7.

### B5. Conservation, burst loss and feasibility of retention floors [DERIVED]

Let \(A\) count accepted scheduler frames, \(P\) successful presentations, \(X\) terminal drops, and \(Q\) all queued/in-flight frames. Initially all are zero. An accepted enqueue increments \(A,Q\); a successful terminal draw increments \(P\) and decrements \(Q\); any other terminal release increments \(X\) and decrements \(Q\). By induction,
\[
A=P+X+Q.
\]
For the posted-frame transport, split terminal outcomes into PRESENTED, REFUSED and other drops:
\[
D=P+R+X+I.
\]
Require a disjoint outcome per delivery identity, not merely equal aggregate numbers. Duplicating one ACK while losing another can preserve totals. At teardown require \(I=0\). Integer counters either obey this modulo their declared width or refuse before overflow; do not silently interpret unsafe JSON numbers as exact integers.

For a drop-oldest queue of capacity \(K\), initial occupancy \(q_0\), a burst of \(B\) accepted items and no departures gives exactly
\[
X=\max(0,q_0+B-K),\quad Q_{final}=\min(K,q_0+B),
\]
with the newest \(K\) surviving items retained. With \(S\) services during a window, conservation implies the lower bound \(X\ge\max(0,q_0+A-S-K)\). At long-run arrival rate \(\lambda>\mu\), a bounded queue therefore loses at least fraction \(1-\mu/\lambda\); there is no useful universal upper loss bound without burst assumptions.

If arrivals obey \(A(t+u)-A(t)\le\sigma+\rho u\) and service guarantees \(\mu(u-L)_+\), with \(\rho\le\mu\), the backlog bound is \(\sigma+\rho L\): for \(u\le L\), the arrival bound increases to that value; for \(u\ge L\), arrival minus service has slope \(\rho-\mu\le0\). Thus \(K\ge\lceil\sigma+\rho L\rceil\) avoids capacity drops **only under those assumptions**. A model oracle with \(\sigma=8,\rho=\mu=40/s,L=.2s\) needs \(K=16\); a burst of 17 into an empty 16-slot queue must instead drop exactly the oldest one.

For a two-frame retention floor on \(M\) surfaces with frame sizes \(F_s\), feasibility necessarily requires
\[
2F_s\le B_s\quad\forall s,\qquad2\sum_sF_s\le B_{global}.
\]
The five-allocation counterexample in T8-R3-01 violates the global budget because the no-victim branch breaks rather than refuses. No probabilistic argument rescues an infeasible capacity constraint.

**Oracles:** T18 uses four surface identities, 4000 deterministic operations with seed `0x269`, an independent identity ledger, and burst/fold/rejection/teardown events; require conservation after every operation and zero in flight at the end. A separate integer reference ledger uses six initial counter positions \(\{0,1,2^{32}-2,2^{64}-3,2^{64}-2,2^{64}-1\}\); the wire test rejects values outside its safe-integer rails rather than sending these as JavaScript numbers. T25 uses the exact 6-byte/four-slot/24-byte configuration and fifth allocation. These are finite deterministic coverage claims, not failure-probability estimates. Q5/E6/E7.

### B6. Layout and nested feasibility [DERIVED]

For a visible rectangle \(r_i=(x_i,y_i,w_i,h_i)\) in a viewport \(W\times H\), a proposed bounded-layout predicate is integer coordinates, \(w_i,h_i>0\), \(0\le x_i,\ 0\le y_i,\ x_i+w_i\le W,\ y_i+h_i\le H\). For any pair required to be disjoint, add
\[
x_i+w_i\le x_j\ \lor\ x_j+w_j\le x_i\ \lor\
y_i+h_i\le y_j\ \lor\ y_j+h_j\le y_i.
\]
This disjunction is necessary and sufficient for axis-aligned non-overlap because overlapping projections on both axes are exactly an interior intersection. Inserting into an existing group of size \(m\) requires \(0\le index\le m\), if group-relative insertion is the chosen policy.

These are **proposed semantic constraints, not claims about the ratified API**. The current schema/driver permits declarative groups and a bounded index up to 255; floats can overlap and their component-wise numeric rails do not establish viewport containment. The positive fixture \((x,y,w,h)=(0,16383,16384,1)\) is deliberately valid. [core/src/serve/layout.rs:1-8](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/core/src/serve/layout.rs#L1-L8), [tests/test_layout_intents.py:8-14](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/test_layout_intents.py#L8-L14). It would be wrong to report overlap as a product defect without a non-overlap requirement. Hidden placement attempts do have a defined refusal, LAYOUT_ILLEGAL_TRANSITION. [core/src/serve/layout.rs:28-43](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/core/src/serve/layout.rs#L28-L43).

The nested predicate in the formal section is finite: depth in \(\{0,1\}\), matching registered profile and geometry, and the depth-1 desktop/program constraints. A schema boundary can reject before the adapter returns its own code; both layers must be tested separately.

**Oracles:** T26 exhausts the scalar boundary values \(index\in\{-1,0,255,256\}\), width/height \(\{0,1,16384,16385\}\), and coordinate bounds already in the schema, plus every ordered pair of hide/show/move/tab/float operations from visible and hidden states. T19 tests omitted depth, explicit \(0,1,2,-1\), browser versus desktop, correct/wrong program and 1280×720 versus 1280×900 geometry. No random confidence is claimed; the exact finite corpus and expected layer-specific outcomes are stated below. Q6/E5/E13.

### B7. Minimal pairwise precedence coverage, and what it cannot prove [DERIVED]

For \(N\ge2\) distinct items, one permutation contains exactly one orientation for each unordered pair, so at least two tests are necessary to observe both orientations of every pair. A permutation \(\pi\) and its reversal \(\operatorname{rev}(\pi)\) supply both for every pair, so two are sufficient and minimal for **precedence orientation only**.

This is not a minimum for a general covering array over arbitrary parameter values, adjacency patterns, positions, or thread interleavings. For four arrivals crossed with four registration orders, the full small census contains \(4!\cdot4!=576\) cases. If only one domain's precedence orientations are needed, \([a,b,c,d]\) and \([d,c,b,a]\) suffice.

Do not require equal journals for differently ordered meaningful inputs, or equal winners for reversed sequence numbers in the same agent lane. T8-R3-14's present test compares neither meaningful identities nor a declared state oracle. An order-independent projection must be explicitly identified before comparing permutations.

**Oracle:** T27 runs the two minimal registration permutations, then all 576 arrival/registration permutations for a four-identity corpus, checking the declared per-ID surface projection and each trace's own replay oracle. Separately pin winner identities for the existing order-sensitive \([1,2,3]\)/\([3,2,1]\) trace. One finite census, no seed and no population confidence claim. Q7/E5/E1.

### B8. Bounded handoff, QA, settlement and durability claims [DERIVED]

The handoff reply containing a \(B\)-byte receive remainder as hex has length \(2B+C\), where the remaining JSON and newline contribute \(C>0\). Therefore \(B=2048\) necessarily exceeds the 4096-byte receiver limit. Enforce the serialized bound **before** consuming ownership, or use an explicitly bounded transport that preserves the remainder. [tests/e2e/e2e1_slice/stack.py:334-359](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/e2e1_slice/stack.py#L334-L359), [tests/e2e/e2e1_slice/stack.py:395-410](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/e2e1_slice/stack.py#L395-L410). T02 tests \(B\in\{0,512,1024,2048,4096\}\) with a usable transferred descriptor or an atomic pre-transfer refusal.

QA's row and byte bounds are independent. A maximum of 512 rows cannot imply 64 KiB by itself because text lengths and UTF-8 expansion vary; the explicit serialized-byte check is necessary. T20 tests 512 versus 513 rows and normalized encodings of exactly 65,536 versus 65,537 bytes, plus the disabled handler path. [ui/electron/qaAnchors.js:137-144](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/ui/electron/qaAnchors.js#L137-L144), [ui/electron/qaAnchors.js:199-203](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/ui/electron/qaAnchors.js#L199-L203).

The pending-worker regression has a conditional two-second oracle against a 2200 ms fallback, not a universal scheduler theorem. With one handler waiting cooperatively on cancellation and a second queued handler, invalid input must cancel the first, prevent the second dispatch, and return an error before two seconds. The all-valid control must return r1 then r2. T15 covers the five malformed classes. T16 covers 1000 create/input/take/release/destroy cycles and preserves the used-permit set while the epoch/refresh maps empty. [daemon-adapter/internal/ipc/client_test.go:354-547](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/daemon-adapter/internal/ipc/client_test.go#L354-L547), [daemon-adapter/internal/capsule/manager_a2_test.go:219-288](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/daemon-adapter/internal/capsule/manager_a2_test.go#L219-L288).

A nominal 50 ms flush interval alone cannot prove “at most 50 ms lost”: if scheduling delay is \(J_f\) and the durable flush costs \(F_f\), a time-based vulnerability window can be as large as \(50+J_f+F_f\) ms. An acknowledgement-after-durability contract is a different claim. The prompt's ~52 ms and hard loss-window statements were not independently benchmarked or proved in this T8 review; journal internals remain T1. T28 proposes a crash-at-offset test with a declared acknowledgement boundary, not a weakened durability claim.

### B9. Qualification feasibility and calibration arithmetic [DERIVED]

The volume job allows 180 minutes, 20 smoke repetitions, 300 qualification repetitions and a default 600-second soak. [.github/workflows/volume.yml:330](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/.github/workflows/volume.yml#L330), [.github/workflows/volume.yml:538-572](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/.github/workflows/volume.yml#L538-L572). Even ignoring setup, the average repetition must satisfy
\[
320t+600\le10800,\quad t\le31.875\text{ s}.
\]
Each individual repetition separately has a 120-second timeout.

Substituting the **observed existing CI** suite durations gives repeat-plus-soak projections of
\[
320(213.294028902)+600=68854.08924864\text{ s}\approx19.1261\text{ h},
\]
\[
320(269.847315438)+600=86951.14094016\text{ s}\approx24.1531\text{ h}.
\]
These are projections under unchanged cost, not measured warmed-repeat durations or a proof that no faster implementation can exist. They demonstrate that the supplied green baseline does not fit the configured per-attempt or job budget. At those costs, even ideal equally loaded shards would need at least 7 x64 or 9 arm64 jobs with a 10200-second repeat allowance, before overhead.

The long-soak calibration defect is exact: its supposedly 8.5 FPS fixture always contains 26 timestamps, so its actual rate is \(26000/duration_{ms}\). It drops below the required hosted-arm64 8 FPS once duration exceeds 3250 ms; at 600000 ms it is about 0.0433 FPS. [tests/e2e/e2e14_perf.test.js:103-108](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/e2e14_perf.test.js#L103-L108). For duration-independent calibration use exactly 27, 36 and 5400 presentations at 3000, 4000 and 600000 ms respectively: each is precisely 9 FPS, passes the 8 FPS comparator and fails the 10 FPS comparator.

**Oracles:** T29 validates the budget inequality against explicit timings per architecture/shard; T30 checks all three calibration durations with evenly spaced half-step timestamps and the full positive/negative long journey. Confidence comes only from B1 after a completed preserved census; no timing extrapolation grants it. Q2/E9/E10.

## Optimization proposals

These are review proposals only. No optimization was implemented or benchmarked. Quantities marked **[DERIVED]** are calculations under explicit assumptions; **[TARGET]** values are acceptance goals, not measurements. None permits reducing the prescribed qualification census, accepting a missing prerequisite, changing a refusal into a skip, or erasing a failed attempt.

| Proposal and reason | Baseline and expected gain | Preservation oracle |
|---|---|---|
| Bind reusable build artifacts to all source inputs, locks, materialized kit, compiler/runtime versions, build flags and architecture; verify artifact digests before reuse. Apply the same provenance rule to supplied LIVE core/adapter executables. | Current source/kit/artifact stamping already avoids some rebuilds, while dependency-lock and supplied-binary gaps remain. If a repetition has compile cost \(c\) and exercise cost \(r\), \(n\) repeats cost \(n(c+r)\); one proven reusable build plus \(n\) fresh exercises costs \(c+nr\), saving exactly \((n-1)c\) **[DERIVED]**. No value of \(c\) was measured here. | T03/T17 mutate every declared input and one artifact independently; each must rebuild/refuse, while the unchanged companion reuses. Keep fresh process/state roots where determinism depends on them. Preserve offline/locked builds and no-network prerequisites. |
| Split volume attempts into declared, independently attributable shards and budget them from measured warmed timings. Keep both architectures, all 20 smoke and 300 qualification attempts, per-attempt outcome records and the soak. | Existing CI durations are the only measurements. Under unchanged cost, ideal minima are 7 x64 or 9 arm64 shards before overhead (B9). Wall-time reduction is at most ideal parallelism; setup, shared-host interference and soak placement reduce it. No achieved speedup is claimed. | T29 checks \(\sum_i t_i+setup+soak\le budget\) per job, sufficient per-attempt timeouts, exact aggregate census, no attempt lost to retries and no cross-architecture pooling. A failed or absent shard cannot yield aggregate PASS. |
| Cache explicitly serialized checkpoint states for the deterministic suffix census while retaining independent per-prefix reference states. | For all \(0\le k\le p\le64\), recomputing each candidate from origin uses \(\sum_{p=0}^{64}p(p+1)=91,520\) candidate transitions. Generating all checkpoints once takes 64, then all suffixes take \(\sum p(p+1)/2=45,760\): 45,824 total, 45,696 fewer (about 49.93%) **[DERIVED]**, excluding identical reference-oracle cost and serialization overhead. | T05 still checks all 2145 pairs, empty suffixes, boundary corruption and each declared prefix. Keep the existing two independent fresh-root runs; a cache cannot substitute for crash/recovery or full replay tests. |
| Use the bounded sequential probe in B2 as an early request for independent loss confirmation. | Under the stated IID episode model, expected samples are at most 2.3832 under \(H_1\) and 2.3772 under \(H_0\), versus a fixed 20-sample diagnostic horizon **[DERIVED]**. The target probe schedule gives a 350ms first-pair loss indication; its probability under \(H_1\) is .81, not a deadline guarantee. | T23 exhausts all 20-bit traces, retains inconclusive timeout, applies lifetime error allocation and preserves independent `confirmedAbsent`. Correlation invalidates the IID performance claim; do not use this alone to retire a live capsule. |
| Record unique per-surface presentation identity and time at the terminal ACK/draw boundary, then derive FPS, gaps and conservation from that ledger. Use a streaming gap maximum and bounded diagnostic tail. | Streaming metrics need \(O(1)\) counters and previous timestamp per surface; a bounded identity window also bounds dedup storage **[DERIVED]**. A 16-event global tail is already bounded but insufficient to prove every delivery's disposition. No throughput gain is assumed. | T11/T12/T18 reject no-paint tags, a 4s silence, duplicate ACKs, orphaned deliveries, folded draws and unsafe counters. Keep the exact e2e25 pixel/generation checks. Retain enough identity state to distinguish outstanding/recent events rather than inferring uniqueness from totals. |
| Preflight frame-cap feasibility before acquiring/mapping or publishing a new generation; make the no-victim branch an atomic refusal under a hard budget. | The existing counterexample retains 30 bytes against 24. Refusing before commit prevents the exact six-byte overrun **[DERIVED]**. For HD RGB, B4 proves why a 128MiB per-surface cap cannot simultaneously guarantee every frame for four seconds at 10Hz. There is no claimed RSS saving beyond payload accounting. | T24/T25 assert both accepted-path pixels and refusal atomicity; preserve two passive generations when feasible. Document cap precedence over age, or increase budgets to satisfy the requested floor. Never “fix” a hard cap by silently allowing over-allocation. |
| Use the exact zero-failure bound for planning confidence instead of loose generic concentration inequalities; report the model and population. | At a 1% target and 95% confidence, exact planning needs 299 clean IID runs versus 14,979 under Hoeffding and 793 under the derived Bernstein bound. At 5%, counts are 59, 600 and 154 **[DERIVED]**. This comparison improves planning accuracy; it does not authorize reducing the mandatory 300-run rung. | T22 checks integer boundaries, architecture-wise allocation, attempts and failures. Require 368 per architecture only if making the stronger simultaneous 95% claim that both separate rates are below 1%; otherwise state the exact per-architecture confidence supplied by the prescribed census. |
| Keep test-fixture calibration independent of the measured soak duration and label each evidence scope accurately. | The present 26-point calibration fails beyond 3250ms. A 9FPS reference constructed from the requested duration removes this unrelated false failure while retaining the 8-versus-10 comparator check **[DERIVED]**. A 3s synthetic fixture provides 3s synthetic evidence; it contributes zero native ten-minute qualification. | T30/T31/T32 require finite numeric observations, real duration/argv/source labels, unchanged positive production checks and negative stall/fold/routing cases. No threshold is loosened to obtain a pass. |

Prioritize the hard cap, handoff transaction, optimized Python assertions and provenance fixes first. Next repair the presentation, calibration and mutant/soak evidence paths, then complete the missing native evidence with correctly scoped receipts. The existing fixed oracles remain valuable and should not be replaced with weaker aggregates.

## Findings

All repros below are source-derived counterexamples or proposed deterministic fixtures. They were not executed during this review. Existing CI observations are explicitly identified. P1 denotes a hard observable contract failure or a release-qualification oracle/provenance defect; P2 denotes a narrower evidence gap. No P0 issue was established. Findings intentionally avoid recounting fixed landings or treating unavailable native evidence as a new product defect.

| uid | severity | file:line | repro | expected | actual |
|---|---|---|---|---|---|
| T8-R3-01 — Global frame budget is exceeded when passive surfaces have only two retained generations | P1 | [daemon-adapter/internal/frames/publisher.go:424](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/daemon-adapter/internal/frames/publisher.go#L424) | In TestGlobalCapPreservesTwoPassiveGenerations, use the existing 2×1 RGB fixture (6 bytes), MaxSurfaceBytes=24, MaxTotalBytes=24, MaxRetained=64, MaxSurfaces=4, MinRetention=10s and deduplication disabled. Publish a1,a2,b1,b2, then the first c frame without advancing the clock. See T25. | The fifth allocation must refuse before publication or choose a contract-permitted eviction; total retained bytes must stay ≤24 and any refusal must leave generation/references unchanged. | The global-budget loop finds no victim on a or b because each has only two generations, and none on c because it has no prior refs. It breaks, then commits the six-byte c frame, retaining 30 bytes. |
| T8-R3-02 — Oversized descriptor-handoff reply consumes the only agent session | P1 | [tests/e2e/e2e1_slice/stack.py:341](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/e2e1_slice/stack.py#L341) | Place 2048 bytes in the peer receive remainder before an authenticated attach. The hex field alone is 4096 bytes, so the JSON reply exceeds MAX_CONTROL_BYTES=4096. Attempt the attach and then retry. See T02. | A fully usable descriptor and all buffered bytes transfer once, or a size refusal occurs before ownership is consumed so a valid retry remains possible. | On normal sender completion, the server records agent_handoff before sending the unbounded reply and closes its original peer. The client raises CONTROL_PROTOCOL_ERROR for the over-limit reply and closes received descriptors; a second attach is ALREADY_HANDED_OFF. Other transport failures may instead terminate the supervisor. |
| T8-R3-03 — Inherited Python optimization erases release-stale acceptance assertions | P1 | [tests/e2e/e2e1_slice/live.py:510](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/e2e1_slice/live.py#L510) | Run the release_stale_probe fixture with PYTHONOPTIMIZE=1 and then 2; return an admitted verdict, changed domain budget, dispatch=true, and an admitted journal row for live-release-stale while retaining required JSON fields. See T01. | A bad release-stale trace must fail in every supported interpreter mode and must not set assertions.release_stale_before_refresh to PASS. | The JS wrapper inherits PYTHONOPTIMIZE. Python removes the helper's assert statements, but its unconditional PASS append remains. The downstream JS check validates marker presence rather than those evidence semantics. |
| T8-R3-04 — Fresh-build stamp excludes the UI dependency lockfile | P1 | [tests/e2e/ac-harness.cjs:35](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/ac-harness.cjs#L35) | Create a successful fresh-build stamp, change only a transitive resolution in ui/package-lock.json, and preserve src, electron, package.json, kit.lock.json, materialized .kit, vite config and dist. The omission remains after installing the newly locked node_modules because that directory is not fingerprinted. Call ensureFreshUiDist again. See T17. | A build-input change invalidates the stamp and forces a rebuild, or returns E2E_PREREQ with stale artifacts unusable if rebuilding fails. | The input hash enumerates watched directories and top-level files without package-lock.json. Artifact and watched-input hashes still match, so the existing build is accepted as fresh. |
| T8-R3-05 — Supplied LIVE binaries are attributed to HEAD without matching build provenance | P1 | [tests/e2e/e2e1_slice/stack.py:723](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/e2e1_slice/stack.py#L723) | Supply a protocol-compatible earlier core executable and an earlier adapter containing the Go build marker plus PublishIfChanged, DeduplicateUnchanged and PublishForced. Set its mtime later than changed Go source; keep it executable. See T03. | Before live evidence is attributed to the reviewed SHA, source and executable digests must be bound by a verified build stamp, or the binaries must be rebuilt/refused. | The core is checked only for being an executable file. Adapter acceptance uses marker substrings and mtime, not source identity. Supervisor registration advertises git rev-parse HEAD independently of those executable contents. This is a provenance defect, not a claim that every arbitrary binary passes the complete journey. |
| T8-R3-06 — AC-02 counts frame-tag changes as successful presentations | P1 | [tests/e2e/live-main.cjs:74](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/live-main.cjs#L74) | Use the existing fixture's 40ms generation/tag updates while leaving its canvas unpainted. Observe the whole-window tag-derived counter at approximately 25/s. See T11. | The presentation-rate gate must count successful production presentation completions and check independently expected pixel content. | The counter increments on a changed data-frame-tag. The fixture creates the canvas and updates the tag without painting it, so healthy-looking FPS can accompany zero successful draws. |
| T8-R3-07 — AC-02 aggregate FPS cannot enforce maximum presentation silence | P1 | [tests/e2e/live-main.cjs:91](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/live-main.cjs#L91) | Provide 25Hz activity except one contiguous 4s silence during 600s; mean throughput remains about 24.83 FPS. The deterministic 10s fixture in T12 has 151 presentations and an exact 4000ms gap. | For each visible tile, require both the applicable throughput threshold and no presentation gap above 2000ms, including start/end boundaries. | AC-02 records aggregate FPS and generation totals without presentation timestamps or a maximum-gap check. A high mean accepts the stalled trace. |
| T8-R3-08 — Post-release progress can be satisfied entirely by pre-release frames | P1 | [tests/e2e/e2e26_control_with_frames.test.js:752](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/e2e26_control_with_frames.test.js#L752) | At the pre-TAKE baseline, set presented=2; deliver five more frames while held, reaching 7; acknowledge RELEASE and deliver no further frames. Preserve the existing positive state-only count. See T07. | Capture a RELEASE-time generation/count baseline and require a new completed presentation after the release acknowledgement/fence. | The final condition compares against presentedBeforeTake+3 rather than a release-time baseline. Seven already exceeds five, so the purported post-release progress check succeeds without any post-release presentation. |
| T8-R3-09 — Fixed 26-frame calibration invalidates supported long-soak runs | P1 | [tests/e2e/e2e14_perf.test.js:105](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/e2e14_perf.test.js#L105) | Run the proposed long path with MV_SOAK_SECS=600 and otherwise healthy clean output; the calibration clone retains 26 timestamps over the full clean duration. See T30. | The comparator-calibration fixture must retain a rate strictly between the 8 FPS hosted-arm64 and 10 FPS local thresholds for every accepted duration from 3 through 600 seconds. | Its rate is 26000/duration_ms, below 8 once duration exceeds 3250ms and approximately 0.0433 FPS at 600s. The positive hosted-arm64 assertion therefore fails independently of renderer health. |
| T8-R3-10 — Routing-mutant failure attribution accepts unrelated failures | P1 | [tests/e2e/run.py:29](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/run.py#L29) | Return mutant process status 1 with output containing the passing test title 'malformed publisher ledger refuses with E2E_ROUTING' and an unrelated E2E_PREREQ failure; no failing routing oracle is present. See T14. | Accept a mutant kill only when structured test evidence identifies the intended live-wall routing oracle as failed because of the injected mutation. | The classifier requires only any nonzero status and the E2E_ROUTING substring. A passing test title provides the marker, so an unrelated failure is misattributed. This does not demonstrate survival of the current routing mutant. |
| T8-R3-11 — Volume soak validator accepts non-finite presentation times | P1 | [.github/workflows/volume.yml:622](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/.github/workflows/volume.yml#L622) | Inject a valid JSON synthetic report with started=0, ended=600000, four distinct tiles each containing 6000 string values 'nan', presentCount=6000, positive generation, matching RGBA pixels and a valid folded transition. See T31. | Every timestamp must be a JSON number with finite value and valid ordering; invalid observations must fail before a PASS receipt is emitted. | float('nan') yields NaN. Every gap comparison g<0 or g>2000 is false, while the count-based FPS and other fixture fields pass. The validator can emit PASS without usable presentation times. |
| T8-R3-12 — Volume time budgets are unsupported by the observed suite cost | P1 | [.github/workflows/volume.yml:540](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/.github/workflows/volume.yml#L540) | Compare the workflow's 120s repetition limit and 180min job limit for 20+300 repeats plus 600s soak with the reviewed-head existing CI suite durations: 213.294028902s x64 and 269.847315438s arm64. See B9/T29. | Declare measured warmed costs, feasible per-attempt limits and enough total/sharded capacity to complete every mandatory attempt on each architecture; reject an infeasible qualification plan before spending the run. | The observed suites exceed the per-attempt limit. The job allows an average at most 31.875s per repetition before overhead; unchanged-cost projections are approximately 19.13h x64 and 24.15h arm64. No warmed benchmark or completed Volume run was inspected, so this is a configuration/evidence mismatch, not an observed timeout. |
| T8-R3-13 — Synthetic short-soak receipt claims 600-second live qualification | P1 | [.github/workflows/volume.yml:673](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/.github/workflows/volume.yml#L673) | Inject or run a valid 3s synthetic-rgb24 report with four distinct 20Hz tiles, correct counters/pixels and folded capture progression, using the permitted 3s soak setting. See T32. | The receipt must identify actual duration, synthetic/native scope and executed argv. A 600s native qualification claim requires that exact evidence. | The validator scales its duration requirement to the chosen value but unconditionally reports a ten-minute live soak and count_source volume:soak-600s. The actual producer is perf-main.cjs, while the recorded command names e2e14_perf.test.js. |
| T8-R3-14 — Ordering test verifies digest syntax and counts without a semantic oracle | P2 | [tests/e2e/e2e4_seams.test.js:133](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/e2e4_seams.test.js#L133) | Keep ADMITTED1:1 and ADMITTED2:1 but replace either printed digest with a different valid 64-character lowercase hex string. The existing assertions still accept. See T27. | For each trace, compare against an independent declared state/verdict oracle and its own replay; compare only a documented commutative projection across permutations, and assert admitted identities when claiming the same multiset. | Both digests are only regex-checked, and equal admission counts are labeled the same multiset. The current reversed same-lane sequence is order-sensitive, so blindly asserting equal digests would also be incorrect. |
| T8-R3-15 — Demo transcript substitutes an execution timestamp for native input time | P2 | [tests/e2e/e2e1_slice/demo_agent_drive.py:1254](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/e2e1_slice/demo_agent_drive.py#L1254) | Use a successful tool result whose verified top-level input_mono_ns is 9001, whose receipt.executed_at_ns is 101, and whose projected receipt has no native_evidence member. Follow the real agents/tools.py wrapper into demo dispatch. See T09. | Preserve the verified top-level native timestamp as 9001, or explicitly omit an unavailable native measurement; do not relabel an execution timestamp as native input time. | The tool wrapper returns only the receipt. The demo's absent-native-evidence fallback uses receipt.executed_at_ns (or 1), then emits it as input_mono_ns. Its fixture retains nested native evidence and masks this real-path projection loss. Core native verification still runs. |

Additional causal links: the complete UI source enumeration returns only its explicit directories/files, kit and Vite configs; the rebuild consumes the installed Vite executable. [tests/e2e/ac-harness.cjs:159-215](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/ac-harness.cjs#L159-L215), [tests/e2e/ac-harness.cjs:594-623](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/ac-harness.cjs#L594-L623), [ui/package-lock.json:1-35](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/ui/package-lock.json#L1-L35). The passing routing-title marker is present at [tests/e2e/e2e1_wall.test.js:426-427](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/e2e1_wall.test.js#L426-L427). Python documents that optimization removes assert statements: [Python command-line reference](https://docs.python.org/3/using/cmdline.html#cmdoption-O). The relevant LIVE helper then appends PASS unconditionally: [tests/e2e/e2e1_slice/live.py:510-535](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/e2e1_slice/live.py#L510-L535).

The AC-02 fixture's canvas/tag behavior is visible at [tests/e2e/ac-wall-fixture.mjs:77-108](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/ac-wall-fixture.mjs#L77-L108); the production renderer's separate successful-pixel checks are credited in the fix ledger. For the demo projection, the endpoint strips nested native evidence while returning verified top-level fields, and the Python wrapper drops those top-level fields before the demo fallback. [core/src/serve/tools.rs:507-512](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/core/src/serve/tools.rs#L507-L512), [agents/metaviewer_agents/tools.py:768-782](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/agents/metaviewer_agents/tools.py#L768-L782), [tests/e2e/e2e1_slice/demo_agent_drive.py:1252-1277](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/e2e1_slice/demo_agent_drive.py#L1252-L1277).

## Tests written or proposed

**Written: none. Executed for this review: none.** The command lines below are concrete commands for the existing test files after the proposed cases are added. They do not imply that the current files already contain every described case. Run commands from the repository root unless a different working directory is stated. Go commands use `daemon-adapter/` as their working directory. Preserve the repository's pinned/offline toolchain, explicit target directories, private-kit prerequisites and typed nonzero prerequisite behavior; unavailable inputs cannot become skips.

Every negative case has a positive companion. Exact byte streams, identities, timestamps, seeds and counts are specified so a future implementation cannot satisfy the proposal with a marker-only assertion.

### T01 — optimized LIVE negative and positive controls

**Input:** launch the helper fixture in separate Python subprocesses with optimization levels 0, 1 and 2. Stub send; return `{"schema":"action_verdict/v0.2","proposal_id":"live-release-stale","decision":"admitted","core_seq":1}`; patch the two domain snapshots to `{"budget":100}` and `{"budget":99}`. Supply a readable `events/1.json` with `outcome={"reason":null,"dispatch":true}` and a header followed by one journal row `{"core_seq":1,"kind":"admitted"}`. Keep file access valid so assertion erasure is the only changed factor.

**Expected:** every negative subprocess is nonzero and no `assertions.release_stale_before_refresh="PASS"` is accepted. For the companion, use unchanged domain, `decision=refused`, `reason_code=STALE_FRAME`, event reason STALE_FRAME/dispatch false, and journal kind refused; all three modes must either correctly validate it or explicitly reject unsupported optimized operation before starting the live run. Rejection of optimization with E2E_PREREQ is a proposed policy, not an observed current code.

**Command:** `python3 -m unittest discover -s tests/e2e -p 'test_live_stack.py'`.

### T02 — atomic bounded descriptor handoff

**Input:** extend the real socketpair/SCM_RIGHTS fixture with receive buffers of 0, 512, 1024, 2048 and 4096 bytes, using byte \(i\bmod256\). Authenticate the same user, transfer once, then attempt a second attach. Repeat the oversized case with a deliberately failed send.

**Expected:** a successful transfer preserves every byte and a usable FD exactly once, then the second attach returns ALREADY_HANDED_OFF. An oversized refusal happens before ownership changes, leaves the original connection usable and leaks no FD. The current normal-send 2048-byte trace instead raises CONTROL_PROTOCOL_ERROR after consumption. A failed send must have an explicit cleanup/ownership outcome; do not require ALREADY_HANDED_OFF after a terminated supervisor.

**Command:** `python3 -m unittest discover -s tests/e2e/e2e1_slice -p 'test_demo_agent_drive.py'`. Existing socketpair seam: [tests/e2e/e2e1_slice/test_demo_agent_drive.py:870-967](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/e2e1_slice/test_demo_agent_drive.py#L870-L967).

### T03 — binary/source identity, including misleading mtimes

**Input:** use executable fixture files representing old core and adapter artifacts; the adapter bytes contain the Go build marker and all three currently required publication/dedup symbols. Give binaries mtime \(t+100\), source mtime \(t\), then change one Go source byte while preserving its older mtime. Also test a non-Go-marked executable, a mismatched claimed stamp, a changed binary with unchanged stamp, and a valid matching stamp.

**Expected:** source/digest mismatch forces rebuild or nonzero refusal before spawning/advertising HEAD. The matching stamp is accepted without rebuilding. Mere marker/mtime acceptance must not establish provenance. Check the exact executable digest recorded in evidence.

**Commands:** `python3 -m unittest discover -s tests/e2e/e2e1_slice -p 'test_stack_demo.py'`; `python3 -m unittest discover -s tests/e2e -p 'test_live_stack.py'`.

### T04 — independent replay and history-integrity corpus

**Input:** the exact pinned six-event golden, twice in independent roots; mutate one semantic byte in each event separately, append each event as a duplicate, swap each of the five adjacent pairs, and truncate each of the six nonempty event suffixes. Preserve valid serialization where the test concerns semantic integrity. Retain the trusted expected event count and terminal commitment outside the mutated archive.

**Expected:** both clean runs match the declared state/digest and exact journal bytes; verify-only exits zero with empty stdout and stderr. Semantic corruption/duplicate transforms fail the relevant replay/history oracle; duplicate is rc 3 in the current purity test. Every incomplete or reordered full-run history fails the independent complete-run oracle, even if a valid prefix can replay successfully. Harmless whitespace changes alone are not required to fail semantic replay. Denial instruments must themselves have a failing negative control.

**Commands:** `node --test tests/e2e/e2e2_scenario.test.js tests/e2e/e2e12_replay_purity.test.js`. Preserve x64 and arm64 artifacts instead of inferring their equality from job labels alone.

### T05 — all checkpoint suffixes through 64 inputs

**Input:** declare one deterministic 64-input legal trace and independent per-prefix state oracle; enumerate every \(0\le k\le p\le64\), exactly 2145 cases. Include empty prefix/suffix and the final boundary. Restore the serialized checkpoint at \(k\), then apply exactly inputs \([k,p)\). Independently corrupt each tested boundary's identity once.

**Expected:** the restored suffix equals the declared straight-prefix state for \(p\), its own replay verifies, and corrupted/mismatched checkpoint identity refuses. Do not reuse the candidate's computed result as its expected value.

**Command:** `node --test tests/e2e/e2e2_scenario.test.js`, extending its Rust driver fixture. This is a proposed integration census, not a claim that the existing six-event fixture already exposes all checkpoint boundaries.

### T06 — control, drain, refresh and used-permit sequence

**Input:** admit pending proposal p1, TAKE as human, submit p2 while held, attempt RELEASE before p1's native cancellation completes, complete cancellation and drain p1, RELEASE, submit p3 using the pre-release frame, publish a genuinely newer committed frame, submit p4, and reuse p4's permit. Preserve a recovery/replay companion after release.

**Expected:** cancellation contains p1; p2 refuses SURFACE_NOT_AGENT_CONTROLLED; premature adapter release refuses POLICY; drain enables release; core p3 refuses STALE_FRAME with unchanged domain/budget and no dispatch; fresh p4 admits; permit reuse refuses POLICY at the adapter. Audit journal growth on refusal is expected, not a failure of settlement.

**Commands:** `node --test tests/e2e/ac04_control.test.js`; from `daemon-adapter/`, `GOPROXY=off go test -race ./internal/capsule -run TestHandoff -count=1`; `cargo test --offline --test human_input_control`.

### T07 — post-release presentation must be new

**Input:** pre-TAKE presented count 2, held-time count 7, successful RELEASE acknowledgement, then freeze frame delivery. Keep the already-required positive state-only count at 2 or more and all other successful fixture evidence unchanged. Companion delivers one new distinguishable generation/pixel only after release.

**Expected:** the frozen trace reaches E2E26_FINAL_DIAG_TIMEOUT (or an equally explicit repaired negative result), and the companion passes a predicate whose baseline is recorded at release. Existing core release-refresh behavior remains covered separately by T06.

**Command:** `node --test tests/e2e/e2e26_control_with_frames.test.js`.

### T08 — native-receipt and semantic-effect matrix

**Input:** preserve the existing positive 2×1 RGB fixture: before bytes `[255,0,0,0,255,0]`, after `[0,0,255,0,255,0]`, generations 1→2. One at a time remove native evidence; change native surface; set focus false; set native input time before observation or after execution; change native kind; keep pixels unchanged; return an error; make the after frame late; forge only the incoming verified bit; change proposal surface or before-frame generation. Add a G-AI companion where pixels change but canonical Wender/battery state does not.

**Expected:** the valid endpoint result is independently verified. Each native/effect mutation produces no verified-native result; the public endpoint reports its existing verification failure, and malformed closed evidence fails decoding. The G-AI semantic no-op fails its semantic oracle despite pixel change. Assert the actual layer's code rather than forcing a single code on decoder, internal verifier and public endpoint.

**Commands:** `cargo test --offline native_evidence_closed_decoding_and_negative_controls`; `python3 -m unittest discover -s tests -p 'test_e2e_ai_loop.py'`. The inspected native matrix is already substantive: [core/src/serve/receipt_evidence_tests.rs:41-125](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/core/src/serve/receipt_evidence_tests.rs#L41-L125); the proposal extends its boundary combinations and cross-language path.

### T09 — preserve native timestamp projection

**Input:** verified tool-result top-level `input_mono_ns=9001`, receipt `executed_at_ns=101`, no nested native_evidence; route through the real Python wrapper and demo dispatcher. Companion uses a legitimate nested fixture with the same native time.

**Expected:** transcript native time is 9001 or explicitly absent when unavailable; it is never 101 or a synthetic fallback 1 labeled as native time. Core verification/focus requirements remain unchanged.

**Command:** `python3 -m unittest discover -s tests/e2e/e2e1_slice -p 'test_demo_agent_drive.py'`.

### T10 — fixed-grid arithmetic across boundary work durations

**Input:** injected clock with period 100ms and logical origin zero; 4000 work durations selected with seed `0x269` from `{0,1,99,100,101,199,200,201,270}` ms. Use the integer LCG x₀=0x269, xₙ₊₁=(1664525xₙ+1013904223) mod 2³², selecting the next work value by xₙ₊₁ mod 9; no runtime PRNG is involved. Retain existing 30+20, 250+20 and 180+20ms examples.

**Expected:** each next deadline is the first original-grid deadline strictly after completion, every wait lies in (0,100]ms, and missed-slot counts match an independent integer reference. No elapsed wall-clock jitter is used to assess this arithmetic test.

**Command:** from `daemon-adapter/`, `GOPROXY=off go test -race ./internal/frames -count=1`. Keep slow-source and unchanged-source dedup tests distinct.

### T11 — a moving tag without a paint is a failing wall

**Input:** four tiles change projection tags every 40ms, while a draw stub records zero canvas draws and the presented-pixel buffer stays unchanged; companion routes changing RGB through the production presentation path and successful ACKs.

**Expected:** the no-paint case cannot qualify as ≥10 FPS and fails the presentation oracle (E2E_FPS in the proposed AC gate); the companion's rate is computed from unique completed presentations and expected pixel colors.

**Command:** `node --test tests/e2e/ac02_wall.test.js`. Retain `node --test tests/e2e/e2e25_production_frames.test.js` as the separate existing real-renderer pixel companion.

### T12 — mean throughput plus silence, including boundaries

**Input:** deterministic 10000ms window, timestamps `40,80,...,10000`, then remove `1040,1080,...,4960`. The remaining 151 timestamps give 15.1 FPS and a 4000ms gap from 1000 to 5000. Apply independently to each of four tiles; add start-gap, end-gap, negative-time and folded-draw mutants. The full qualification companion lasts 600000ms with changing visible inputs and a folded interval.

**Expected:** the high-average 4s-gap trace fails the ≤2000ms silence predicate; start/end gaps also fail. The full companion meets actual presentation rate and silence bounds per tile, with no folded presentation increment and advancing capture for changing content.

**Command:** `MV_E2E_SOAK_MS=600000 node --test tests/e2e/ac02_wall.test.js`. The AC-02 setting is MV_E2E_SOAK_MS; MV_SOAK_SECS belongs to the separate performance harness.

### T13 — routing by independent ownership

**Input:** independent map `opaque-A→surface-a, opaque-B→surface-b`; test correct pairs, swapped pairs, a foreign owner, an unpublished opaque ID, absent map, and a non-Map ledger. For the no-map synthetic recipe, test exact `frame-<capsule>-gen7`, gen6 and a near-match suffix.

**Expected:** correct mapped pairs and the precisely permitted hosted recipe pass; every wrong/unpublished/ambiguous pair refuses E2E_ROUTING. The live caller independently rejects a null frame. Ownership must not be reconstructed from an opaque ID's spelling.

**Command:** `node --test tests/e2e/e2e1_wall.test.js`.

### T14 — attribute the routing mutant to its actual failing oracle

**Input:** subprocess fixtures: (a) rc 0 with E2E_ROUTING text, (b) rc 1 with a passing `malformed publisher ledger refuses with E2E_ROUTING` title plus an unrelated prerequisite failure, (c) rc 1 with structured failed live-wall routing evidence caused by the injected cross-route, (d) rc 1 without the routing failure.

**Expected:** only (c) counts as the intended mutant kill. All other cases return an explicit mutation/prerequisite failure and preserve the underlying failing evidence; marker presence alone never grants success.

**Command:** `python3 -m unittest discover -s tests/e2e -p 'test_volume_bootstrap.py'`, adding the run.py classification fixtures beside the existing runner bootstrap tests.

### T15 — cancel before draining blocked workers

**Input:** one handler blocked on context cancellation with a 2200ms fallback, a second queued request, then each malformed class separately: invalid payload, body unmarshal failure, invalid route, unknown schema, bad authentication. The all-valid companion contains requests r1 and r2 in order.

**Expected:** the malformed case cancels the first handler, never dispatches the queued second, returns a non-nil error in less than 2s, and leaves no pending worker. The valid case returns r1 then r2. Assert each boundary's current concrete error classification; existing tests do not prove an exhaustive common code taxonomy.

**Commands:** from `daemon-adapter/`, `GOPROXY=off go test -race ./internal/ipc -run TestRV8ClientFailureCancelsInFlightWorkersBeforeDrain -count=1`; `GOPROXY=off go test -race ./internal/daemon -run TestRV8StreamFailureCancelsInFlightWorkersBeforeDrain -count=1`.

### T16 — exact terminal receipts and repeated lifecycle cleanup

**Input:** independently trigger native failure, unsupported input, post-input capture failure, publication failure, takeover during work and surface loss for proposal `failed-proposal`. Repeat the loss notification. Separately run 1000 create/input/take/release/destroy cycles with distinct used permits.

**Expected:** each dispatched failing input emits exactly one correlated action_receipt/v0.2 with verified false, nonempty error and the required after-frame evidence; a repeated loss does not duplicate it. Cancelled work drains before release. After verified destroy, epoch and refresh maps are empty; used-permit history contains the 1000 used identities and never becomes reusable. Pending-map bounds are separate from intentionally retained anti-replay history.

**Commands:** from `daemon-adapter/`, `GOPROXY=off go test -race ./internal/daemon ./internal/capsule -count=1`. Scope evidence: [daemon-adapter/internal/daemon/input_settlement_test.go:54-169](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/daemon-adapter/internal/daemon/input_settlement_test.go#L54-L169), [daemon-adapter/internal/capsule/manager_a2_test.go:219-288](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/daemon-adapter/internal/capsule/manager_a2_test.go#L219-L288).

### T17 — closed build inputs and explicit headless prerequisites

**Input:** first produce a valid UI stamp; independently mutate one src file, one electron file, package.json, package-lock.json, kit.lock.json, a materialized kit file, a Vite config and one dist file. Include a lock-only transitive-resolution change followed by updated installed dependencies while retaining old dist. Plant hostile loader/interpreter environment values, including the optimization variants in T01. Remove each required executable in a controlled PATH fixture. Assert the declared qualification Xvfb argv contains 1280×900×24; keep the explicitly different private-stack display profile separately labeled.

**Expected:** each changed build input/artifact invalidates freshness; rebuild failure removes reusable stale output and returns E2E_PREREQ. The unchanged companion reuses its verified build. Core-driver child environment remains exactly its approved allowlist; broader runners document and enforce their own envelope. Missing tools are nonzero typed prerequisites, never skips or false PASS.

**Commands:** `node --test tests/e2e/harness_fresh_build.test.js tests/e2e/e2e4_seams.test.js tests/e2e/e2e12_replay_purity.test.js`; T01's Python command covers optimized LIVE operation.

### T18 — per-surface, per-epoch delivery conservation

**Input:** four surfaces a–d, each with independent stream epochs and a reference ledger of unique delivery IDs. Use 4000 operations from the same explicitly defined LCG as T10, selecting surface by \(x\bmod4\) and operation by \(\lfloor x/4\rfloor\bmod8\): enqueue, present, refuse, drop-oldest burst, fold, unfold, destroy, recreate. Apply only legal present/refuse operations to the oldest outstanding ID; empty queues make those operations no-ops. A burst adds 17 uniquely identified items to a fresh 16-slot model queue before service. Drain every remaining item at teardown. Separately initialize an integer reference counter at each of \(\{0,1,2^{32}-2,2^{64}-3,2^{64}-2,2^{64}-1\}\).

**Expected:** after every operation, unique accepted/posted IDs partition into exactly the disjoint terminal/in-flight categories in B5; no ACK is counted twice, no foreign epoch consumes a delivery, fold creates no PRESENTED event, and teardown leaves zero in flight. The 17-item burst drops exactly the oldest one. Explicit duplicate-ACK and orphaned-delivery mutants fail even when aggregate totals are arranged to match. Counter overflow is either handled according to the declared integer contract or refused; unsafe integers cannot silently pass a safe-JSON-number boundary.

**Commands:** `node --test tests/e2e/e2e4_seams.test.js tests/e2e/e2e25_production_frames.test.js`. This extends the finite production trace; it does not claim that existing global diagnostics already constitute such a ledger.

### T19 — nested depth and geometry at each boundary

**Input:** cross omitted depth and explicit `0,1,2,-1` with browser/desktop kinds and matching/nonmatching registered profiles. Use program `metaviewer-nested` versus `notepad`, native kind program, and geometry 1280×720 versus 1280×900.

**Expected:** valid depth-zero registered profiles and sanctioned depth-one desktop/nested 1280×720 succeed. Core wire depth 2/-1 fails schema decoding; assert disconnect plus Decode(InvalidField) where that is the actual transport contract. Direct adapter out-of-range depth, explicit depth on a browser, or profile-depth mismatch returns nested_depth; mismatched registered geometry/kind returns profile. Invalid installed profile configuration returns configuration before creation. Depth-one notepad is inadmissible. Do not pretend that every layer returns the same wire refusal.

**Commands:** `node --test tests/e2e/e2e19_nested.test.js`; `python3 -m unittest discover -s tests -p 'test_e2e_nested_bootstrap.py'`; from `daemon-adapter/`, `GOPROXY=off go test -race ./internal/capsule -count=1`.

### T20 — exact QA row/byte boundaries and disabled inertness

**Input:** `schema="qa_anchors/v1", seq=1`, 512 rows ordered \(i=0..511\), each `anchor="q/"+i, role="button", name="", rect={x:0,y:0,w:1,h:1}`. The normalized compact ASCII JSON is 39,869 bytes **[DERIVED from the specified serialization]**. Set names for rows 0–199 to 128 ASCII “a” characters and row 200 to 67 “a” characters: exactly 65,536 bytes. Increase row 200 to 68 for exactly 65,537. For the row-cap pair, use empty names and 512/513 rows. Also remove/add a key, make an array hole, use sequence 0 or an unsafe integer, and make one dimension 0. A Unicode companion replaces two ASCII bytes with one “é,” preserving bytes while changing character count. Cross disabled, nested, packaged normal, illicit packaged-live flag, and explicitly enabled private-live configurations.

**Expected:** valid 512-row/65,536-byte input passes; 513 rows, 65,537 bytes and each malformed closed/sequence/rectangle case returns QA_PAYLOAD. Field name length remains ≤128 in every boundary fixture. Disabled/nested/normal packaged configurations register no handler and produce no file; illicit packaged live configuration refuses RETAIL_ENV. Only the explicitly enabled authorized sender writes the private atomically replaced output.

**Command:** `node --test ui/test/qa-anchors.test.js`. Source constants and validator: [ui/electron/qaAnchors.js:17-30](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/ui/electron/qaAnchors.js#L17-L30), [ui/electron/qaAnchors.js:127-203](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/ui/electron/qaAnchors.js#L127-L203).

### T21 — human-input bounds, isolation, coalescing and recovery

**Input:** batch sizes 0, 1, 32 and 33 on a known active stream; repeat a previously accepted sequence, supply a stale stream, use READ authority, attempt before human TAKE, and forge human/agent source authority in each direction. Positive batches contain ordered click/key/type events. Preserve the real-core/Go-adapter test's 200 characters at 10ms spacing, sequences 1–200, fake native CLI and delayed 250ms capture.

**Expected:** at the UI bridge, 0 events is SCHEMA, 33 is LIMIT, before TAKE is NOT_IN_CONTROL, and unknown/stale identities return their existing codes; valid 1/32 batches pass under WRITE and human control. READ cannot deliver. At the core, agent-held requests refuse SURFACE_NOT_AGENT_CONTROLLED; source forgery refuses POLICY; human input while agent-owned refuses LOCKED_BY_OTHER. Valid native commands settle; 200 characters preserve exact concatenated order with fewer than 200 type CLI calls, adapter stays alive, RELEASE causes NOT_IN_CONTROL for new UI input and re-TAKE restores it. The delayed-capture companion must retain the inspected input-within-150ms condition; this is that fake-CLI scenario, not a universal native latency bound.

**Commands:** `node --test tests/e2e/e2e27_human_input.test.js`; `GOPROXY=off cargo test --offline --test human_input_real_adapter`.

### T22 — confidence arithmetic and sample acceptance

**Input:** deterministic \((p_0,\delta,n)\) triples around \((.01,.05,298/299)\), \((.05,.05,58/59)\), \((.01,.025,367/368)\), \((.05,.025,71/72)\). Also evaluate exact zero-failure endpoints for n=20 and 300, and ten-attempt success counts 8, 9, 10. Preserve all 300 mandatory attempts even though the mathematical single-architecture threshold is 299.

**Expected:** the lower n in each pair fails \((1-p_0)^n\le\delta\), the upper passes; endpoints agree with B1. Eight successes fails the AC-05 sample bar, nine/ten passes the sample bar only when each success is independently verified. Neither grants a 95% population ≥90% claim. A failure is never removed by retry or pooling architectures.

**Commands:** `python3 -m unittest discover -s tests/e2e -p 'test_volume_bootstrap.py'`; `python3 -m unittest discover -s tests -p 'test_e2e_ai_loop.py'`, adding arithmetic/receipt assertions rather than running an artificial random flake simulation.

### T23 — exhaustive bounded SPRT oracle

**Input:** all \(2^{20}\) binary miss/hit traces; \(q_0=.01,q_1=.9\), log increments \(\ln90,\ln(.1/.99)\), upper \(\ln100\), lower \(\ln.05\), cap 20. Decisions are absorbing. Weight complete traces under each model even after the decision, so continuation weights sum to one.

**Expected:** exact weighted upper-decision probability under \(H_0\) ≤.01; lower-decision probability under \(H_1\) ≤.05; mean capped sample counts respect B2; any undecided trace is inconclusive. A second episode spends an explicitly allocated share of the lifetime false-loss budget. Even a loss-candidate result never directly calls MarkLost without independent confirmed absence.

**Command:** `python3 -m unittest discover -s tests/e2e -p 'test_live_stack.py'`, adding a pure arithmetic diagnostic model. This proposal does not silently replace the existing production liveness policy.

### T24 — retention age versus byte-cap feasibility

**Input:** 39 distinct RGB24 1280×900 frames, injected clock spacing 100ms and then 40ms; per-surface cap 128MiB, requested minimum age 4s, sufficient generation-count cap and changing payloads. Repeat for four surfaces under a 512MiB global cap. Pair with a feasible cap of at least the required total payload.

**Expected:** every retained payload stays within the hard configured ceiling. Under cap-before-age policy, generation 1 can be evicted by generation 39 at age 3.8s/1.52s; the evidence must not claim unconditional 4s retention. A policy that promises all frames under 4s must instead provision the B4 minimum or refuse the infeasible configuration. Validate newest-frame pixels and exact retained references, not just RSS.

**Command:** from `daemon-adapter/`, `GOPROXY=off go test -race ./internal/frames -count=1`.

### T25 — exact hard-global-cap regression

**Input:** the existing six-byte 2×1 RGB fixture; MaxSurfaces=4, MaxFrameBytes=64<<20, MaxPixels=64<<20, MaxRetained=64, MinRetention=10s, MaxSurfaceBytes=24, MaxTotalBytes=24, deduplication disabled. At one logical time publish a1,a2,b1,b2 (24 payload bytes), then c1.

**Expected:** four publications succeed; the fifth refuses atomically because no permissible victim exists, with total bytes 24 and previous generations, references and pixels unchanged. Raising the global cap to 30 provides the positive five-publication companion. Do not invent a present refusal code for the current bug: the current implementation succeeds.

**Command:** from `daemon-adapter/`, `GOPROXY=off go test -race ./internal/frames -run TestGlobalCapPreservesTwoPassiveGenerations -count=1`, strengthening the existing case's cap assertion.

### T26 — ratified layout bounds and transition census

**Input:** index values \(-1,0,255,256\); width/height \(0,1,16384,16385\); x/y \(-1,0,16383,16384\); missing/extra fields, booleans and fractional numbers. Keep the declared valid float \((0,16383,16384,1)\). From visible and hidden states, enumerate every ordered pair of the five operations hide/show/move/tab/float, 50 starting-state sequences.

**Expected:** wire values obey the exact scalar rails: index 0..255, dimensions 1..16384, coordinates 0..16383; closed/type violations reject. At the state layer, hide is valid only when visible, show only when hidden, placement only when visible; invalid transitions return LAYOUT_ILLEGAL_TRANSITION atomically. Neither viewport containment nor non-overlap is required by the current ratified contract. If those are adopted later, validate the B6 predicate in a separately specified policy.

**Commands:** `python3 -m unittest discover -s tests -p 'test_layout_intents.py'`; `cargo test --offline --test layout_routing`. Exact schema rails: [contracts/v0.2/ui_intent.schema.json:285-365](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/contracts/v0.2/ui_intent.schema.json#L285-L365).

### T27 — meaningful ordering and replay comparison

**Input:** four independently identified surface-registration inputs with disjoint effects and independent per-ID expected projections. First run registration orders \([a,b,c,d]\) and \([d,c,b,a]\), then every registration permutation crossed with every independent arrival permutation, exactly 576 traces. Separately retain the existing same-agent sequence orders \([1,2,3]\) and \([3,2,1]\), with expected admitted identities specified from a separate reference state machine.

**Expected:** both orientations of every pair are covered; each trace's declared projection and its own replay match. A changed printed digest fails its independent oracle. For the same-lane order-sensitive trace, assert actual admitted identities, not “same multiset” from equal counts; no unsupported cross-order digest equality is required.

**Command:** `node --test tests/e2e/e2e4_seams.test.js`.

### T28 — bounded crash/durability evidence

**Input:** an owner-reviewed journal test with crash offsets 0, 1, 49, 50 and 51ms relative to a declared flush schedule, injected scheduler/flush delays, and an explicit distinction between accepted and durably acknowledged entries. Use a separate subprocess/process group per crash; preserve its last externally observed durable commitment.

**Expected:** recovered archive is a valid committed prefix, externally durable acknowledgements are never lost, and completeness is judged against the declared commitment. Report the actual loss window including scheduling/flush delay. A nominal 50ms timer alone cannot pass a universal ≤50ms claim. This is a proposal for T1's existing integration seam; no kill/crash experiment was performed here.

**Command:** `cargo test --offline --test admission_journal`, after adding the specified subprocess cases under T1 ownership.

### T29 — qualification budget and census feasibility

**Input:** 20+300 attempts; 600s soak; 120s individual timeout; 10800s job limit; per-attempt costs 213.294028902s and 269.847315438s as separate architecture scenarios, plus separately measured warmed-cost fixtures when available. Include missing-shard, retry-erased-failure and duplicate-attempt mutants.

**Expected:** each current-cost scenario fails a configuration-feasibility preflight. Revised/sharded plans satisfy every per-job inequality including measured setup/soak and every per-attempt timeout, preserve all attempt identities/counts on each architecture, and refuse incomplete aggregate receipts. The 7/9 ideal shard calculations are lower bounds before overhead, not automatically sufficient production settings.

**Command:** `python3 -m unittest discover -s tests/e2e -p 'test_volume_bootstrap.py'`, extending its workflow/runner oracle fixtures.

### T30 — duration-independent comparator calibration

**Input:** duration D in \(\{3000,4000,600000\}\) ms; timestamp count \(n\in\{27,36,5400\}\) respectively, at \(started+(i+.5)D/n\). Set the matching presentCount, positive capture generation, correct pixels and valid folded fields. Preserve the full clean journey and existing 2200ms producer-stall and isolated silence controls.

**Expected:** every calibration is exactly 9 FPS, accepted by the hosted-arm64 8 FPS comparator and rejected by the local 10 FPS comparator with the E2E_FPS assertion message. The supported full 600s synthetic run no longer fails merely because a calibration count was fixed at 26. Its evidence stays labeled synthetic.

**Command:** `MV_SOAK_SECS=600 node --test tests/e2e/e2e14_perf.test.js`.

### T31 — non-finite and wrong-type soak observations

**Input:** use MV_SOAK_REPORT_FIXTURE with schema metaviewer.perf-wall/v1, capture synthetic-rgb24, started 0, ended 600000 and IDs a–d. Each tile has 6000 times, presentCount 6000, lastCaptureGeneration 1, pixel and expectedPixel `[0,0,0,255]`. Set every time to the valid JSON string `"nan"`. Folded fields: hidden true, before generation 1/draws 0, after folded true/captureLeaseActive true/generation 2/draws 0. Companion uses numeric half-step timestamps \((i+.5)\cdot100\). Also mutate one time to an infinity string, numeric string or null, and mutate finite window bounds to non-finite representations.

**Expected:** the numeric finite companion passes its synthetic metric validator. Each non-finite/wrong-type case fails before PASS or a successful qualification receipt; the diagnostic names the invalid metric. No comparison involving NaN may count as proof of ordered bounded gaps.

**Command:** `python3 -m unittest discover -s tests/e2e -p 'test_volume_bootstrap.py'`, using the existing workflow-fixture injection seam.

### T32 — duration, producer and argv truthfulness

**Input:** SOAK_SECS=3 with a valid 3000ms synthetic report, IDs a–d, 60 timestamps per tile at \((i+.5)\cdot50\), matching counters/pixels and the valid folded transition from T31. Then use SOAK_SECS=600 with the finite 600000ms companion. Record the actually launched perf-main.cjs producer and arguments, not a command that was not executed.

**Expected:** the short report may establish a three-second synthetic check only. Neither report earns a native qualifier solely from synthetic capture. Emitted duration, source, count_source and argv agree with actual evidence; a dedicated 600s native qualification requires its own actual native input and timing receipt.

**Command:** `python3 -m unittest discover -s tests/e2e -p 'test_volume_bootstrap.py'`.

### T33 — AC-07 elapsed RAM-first journey and sealed recording list

**Input:** real journey with a monotonic start/end interval of at least 300000ms, controlled filesystem roots, changing frames and capture start/stop. Keep two sealed recordings for one surface and one for another, then request the list for the first surface; also exercise the empty list. Test an unset destination at each actual interface and invalid configured destination strings.

**Expected:** actual elapsed time is asserted, capture/readback stays within declared RAM-first destinations until explicit recording/export, outside-root writes are absent, and the filtered list contains only the two matching sealed records with correlated request/reply and frame counts. Assert the current layer-specific destination refusal: main-binding invalid configuration SETTINGS_DESTINATION, core recording setup DESTINATION_UNSET, and the AC fixture's coordinator POLICY/harness E2E_DESTINATION where applicable. Do not collapse them into one invented end-to-end code. A source constant of 300000ms without a wait and elapsed assertion cannot satisfy the soak.

**Commands:** `node --test tests/e2e/ac07_ram_first.test.js`; `node --test ui/test/rv9-elec-regressions.test.js ui/test/wire-authority.test.js`. Native video sealing remains a separate required run.

### T34 — production multislot/native lifecycle evidence

**Input:** extend the existing four-capsule journey with each currently offered launcher kind; preserve a real terminal session/identity through move, tab, float, fold, wall and multislot transitions. Send a unique input token under WRITE and attempt the same under READ; destroy and recreate each capsule with a new identity. Keep the synthetic fixture as an explicitly named fast companion.

**Expected:** actual native-terminal output contains the WRITE token exactly once, READ sends are undelivered, layout does not recreate or rebind the terminal, destroyed IDs never revive, and production pixels continue across the round trip. A local Map, DOM insertion or Buffer encoding of a pretend PTY token cannot substitute for this proof. Unsupported VM must not appear as an offered launcher card.

**Commands:** `node --test tests/e2e/ac06_multislot.test.js tests/e2e/e2e21_launcher.test.js tests/e2e/e2e25_production_frames.test.js`, after the production/native companion is added. No native terminal run is claimed by this review.

### Evidence-to-oracle index

The E labels used above are a compact index of the report's evidence domains; Q1–Q7 are the exact retrieval queries and B1–B9 the derived bounds.

| Evidence domain | Principal invariant or bound | Concrete test proposals |
|---|---|---|
| E1: independent golden/direct/replay equivalence | IN-REPLAY, B3 | T04/T05/T27 |
| E2: checkpoints and corruption completeness | IN-REPLAY, B3 | T04/T05/T28 |
| E3: clock/network/model purity and silent verification | IN-REPLAY, IN-HEADLESS | T04/T17 |
| E4: native receipt and liveness evidence | IN-RECEIPT, B2 | T08/T09/T23 |
| E5: takeover, drain, release and legal state transitions | IN-CONTROL, IN-SETTLE, B6/B7 | T06/T07/T16/T26/T27 |
| E6: frame ownership, scheduling and exact accounting | IN-ROUTING, IN-CADENCE, B4/B5 | T10–T13/T18/T24/T25 |
| E7: sustained cadence, folded capture and drop bounds | IN-CADENCE, B4/B5 | T10–T12/T18/T24/T30 |
| E8: failure settlement and lifecycle cleanup | IN-SETTLE, B8 | T08/T15/T16/T23 |
| E9: strict LIVE/G-AI evidence and true scope | IN-SLICE, IN-RECEIPT, B1 | T01–T03/T08/T22/T31–T34 |
| E10: volume feasibility and confidence | B1/B9 | T14/T22/T29–T32 |
| E11: build/input provenance and environment | IN-HEADLESS | T01/T03/T17 |
| E12: typed prerequisites, packaging and opt-in isolation | IN-SLICE, IN-HEADLESS | T01/T17/T19/T20 |
| E13: refreshed UI/control/QA/human-input journeys | IN-CONTROL and refresh postconditions | T07/T18–T21/T26/T33/T34 |
| E14: owned cleanup and reproducible execution scope | IN-SETTLE, IN-HEADLESS | T15/T16/T17/T28; existing subreaper tests cited below |

## Not verified

- **No new execution.** No repository checkout, product/test modification, test launch, benchmark, crash experiment or native/private run occurred during this review. Existing CI status/log observations are the only execution evidence used. Source-derived counterexamples have not been represented as reproduced live failures. Proposed optimization gains are conditional calculations, not measurements.
- **Architecture artifacts and Volume.** The inspected original CI run is green on x64 and arm64 with 242/242 Node tests per job. Complete per-architecture journal bytes, golden digest artifacts, warmed repeat timings and a completed Volume x20/x300/soak receipt were not inspected. Green ordinary CI cannot substitute for those missing receipts. The 120s/180min mismatch is stated against observed cost and a conditional projection, not a claim that a particular unseen Volume job timed out.
- **Native provider acceptance.** The ten-run ≥9/10 native provider loop, full native display/bridge, independently checked Wender/battery effect for every claimed success, custody and cleanup require actual scoped receipts. The hosted fake-provider/adapter-seam loop must retain its hosted label. The 9-of-10 sample rule is not a population confidence guarantee (B1). [tests/test_e2e_ai_loop.py:1-40](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/test_e2e_ai_loop.py#L1-L40), [tools/gate_g_ai.py:277-329](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tools/gate_g_ai.py#L277-L329).
- **Native sustained performance.** At least four native visible surfaces for 600 actual seconds, ≥10 successful presentations/s per surface, no >2s silence, folded changing-content capture with zero folded draws, bounded resources, lost-surface retirement and native session continuity were not measured here. The synthetic perf fixture and finite production-renderer pixel journey remain useful within their own scope. e2e14 already has a genuine gap check; T8-R3-07 concerns AC-02, not a blanket absence of gap validation. [tests/e2e/e2e14_perf.test.js:39-67](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/e2e14_perf.test.js#L39-L67), [tests/e2e/e2e14_perf.test.js:109-112](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/e2e14_perf.test.js#L109-L112).
- **AC-07 elapsed time and native sealing.** The five-minute constant and soak-duration helper exist, but the actual test journey calls its Rust scenario and filesystem snapshots without calling that helper or asserting the elapsed 300000ms interval. Its driver uses explicit event times and manual frame publication; the constant alone supplies no wall-clock soak. [tests/e2e/ac07_ram_first.test.js:515-524](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/ac07_ram_first.test.js#L515-L524), [tests/e2e/ac07_ram_first.test.js:1002-1044](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/ac07_ram_first.test.js#L1002-L1044), [tests/e2e/ac07_ram_first.test.js:1068-1147](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/ac07_ram_first.test.js#L1068-L1147). Sealed-recording enumeration and main destination validation are scoped fixes; native video sealing, crash/recovery and extended no-outside-write behavior still need the actual run. T33 is proposed evidence, not a new counted product finding.
- **AC-06 production terminal/input.** The current fixture constructs local session state, direct DOM layout and a fake PTY byte buffer. It proves that fixture's interface assertions, not production native terminal identity or dispatch. [tests/e2e/live-multislot.cjs:75-198](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/live-multislot.cjs#L75-L198), [tests/e2e/ac06_multislot.test.js:937-950](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/e2e/ac06_multislot.test.js#L937-L950). The now-fixed e2e25 generation/pixel round trip is separately credited. No additional defect is counted solely from the missing native companion.
- **Scheduling, retention and liveness.** No host-scheduler jitter bound, maximum native capture/render duration, traffic burst envelope, lifetime loss-detector false-positive rate, or universal cancellation latency was measured. B2/B4/B5 state the assumptions that make their bounds valid. The current two-confirmation static dedup behavior and cap-over-age retention policy must not be misreported as unconditional changing-frame throughput or four-second retention.
- **Journal durability/poison/checkpoint internals.** Full T1 correctness, all checkpoint suffixes, poison recovery, atomic durable acknowledgement and a hard ≤50ms crash-loss claim were not re-proved. Historical ~52ms numbers in the supplied task were not independently remeasured. Valid-prefix replay is not full-history completeness without a trusted terminal commitment. T04/T05/T28 describe the missing evidence without inventing a SHA-256 theorem.
- **Other-topic internals and package/version handshakes.** T2 low-level transport/capture implementation, T3 full Python envelope-client internals, T4 complete UI architecture, T5 capsule/native implementation and T7 aggregate cross-architecture receipt ownership are not blanket re-certified by this T8 source review. Native package/version refusal, handshake timing and every hosted ceiling remain unverified beyond the explicit seams cited. The real-core/Go-adapter human-input companion uses a fake native CLI; it is strong interface evidence but not an actual native OpenSuperficies run.
- **Gate cleanup and environment.** Source supports sticky failure precedence, standard-library parsing, subreaper/session cleanup and token-scoped descendant rechecks. The tests include the double-fork/late-descendant/other-run isolation cases. [tools/gate.sh:1044-1207](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tools/gate.sh#L1044-L1207), [tools/gate.sh:678-810](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tools/gate.sh#L678-L810). Those were not rerun here; an arbitrary cancellation-ignoring native subprocess and every platform's process-tree semantics are not proved. The runner begins with a copied environment before specific scrubbing, so it is not universally equivalent to the core driver's four-key allowlist. [tools/gate.sh:1212-1224](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tools/gate.sh#L1212-L1224).
- **Quantitative applicability.** Every engineering bound is DERIVED and scoped to its assumptions. Context7's seven required queries returned no applicable theorem for these tasks; each distinct returned paper and available fragment is recorded above. No paper ID, anchor, measurement or confidence level was invented to fill that gap.

The machine-readable array below describes the same fifteen findings as the table. Its `file` and `line` fields refer to the pinned reviewed commit, not the later report-only commit.

```json findings
[
  {
    "uid": "T8-R3-01",
    "severity": "P1",
    "file": "daemon-adapter/internal/frames/publisher.go",
    "line": 424,
    "title": "Global frame budget is exceeded when passive surfaces have only two retained generations",
    "repro": "In TestGlobalCapPreservesTwoPassiveGenerations, use the existing 2×1 RGB fixture (6 bytes), MaxSurfaceBytes=24, MaxTotalBytes=24, MaxRetained=64, MaxSurfaces=4, MinRetention=10s and deduplication disabled. Publish a1,a2,b1,b2, then the first c frame without advancing the clock. See T25.",
    "expected": "The fifth allocation must refuse before publication or choose a contract-permitted eviction; total retained bytes must stay ≤24 and any refusal must leave generation/references unchanged.",
    "actual": "The global-budget loop finds no victim on a or b because each has only two generations, and none on c because it has no prior refs. It breaks, then commits the six-byte c frame, retaining 30 bytes."
  },
  {
    "uid": "T8-R3-02",
    "severity": "P1",
    "file": "tests/e2e/e2e1_slice/stack.py",
    "line": 341,
    "title": "Oversized descriptor-handoff reply consumes the only agent session",
    "repro": "Place 2048 bytes in the peer receive remainder before an authenticated attach. The hex field alone is 4096 bytes, so the JSON reply exceeds MAX_CONTROL_BYTES=4096. Attempt the attach and then retry. See T02.",
    "expected": "A fully usable descriptor and all buffered bytes transfer once, or a size refusal occurs before ownership is consumed so a valid retry remains possible.",
    "actual": "On normal sender completion, the server records agent_handoff before sending the unbounded reply and closes its original peer. The client raises CONTROL_PROTOCOL_ERROR for the over-limit reply and closes received descriptors; a second attach is ALREADY_HANDED_OFF. Other transport failures may instead terminate the supervisor."
  },
  {
    "uid": "T8-R3-03",
    "severity": "P1",
    "file": "tests/e2e/e2e1_slice/live.py",
    "line": 510,
    "title": "Inherited Python optimization erases release-stale acceptance assertions",
    "repro": "Run the release_stale_probe fixture with PYTHONOPTIMIZE=1 and then 2; return an admitted verdict, changed domain budget, dispatch=true, and an admitted journal row for live-release-stale while retaining required JSON fields. See T01.",
    "expected": "A bad release-stale trace must fail in every supported interpreter mode and must not set assertions.release_stale_before_refresh to PASS.",
    "actual": "The JS wrapper inherits PYTHONOPTIMIZE. Python removes the helper's assert statements, but its unconditional PASS append remains. The downstream JS check validates marker presence rather than those evidence semantics."
  },
  {
    "uid": "T8-R3-04",
    "severity": "P1",
    "file": "tests/e2e/ac-harness.cjs",
    "line": 35,
    "title": "Fresh-build stamp excludes the UI dependency lockfile",
    "repro": "Create a successful fresh-build stamp, change only a transitive resolution in ui/package-lock.json, and preserve src, electron, package.json, kit.lock.json, materialized .kit, vite config and dist. The omission remains after installing the newly locked node_modules because that directory is not fingerprinted. Call ensureFreshUiDist again. See T17.",
    "expected": "A build-input change invalidates the stamp and forces a rebuild, or returns E2E_PREREQ with stale artifacts unusable if rebuilding fails.",
    "actual": "The input hash enumerates watched directories and top-level files without package-lock.json. Artifact and watched-input hashes still match, so the existing build is accepted as fresh."
  },
  {
    "uid": "T8-R3-05",
    "severity": "P1",
    "file": "tests/e2e/e2e1_slice/stack.py",
    "line": 723,
    "title": "Supplied LIVE binaries are attributed to HEAD without matching build provenance",
    "repro": "Supply a protocol-compatible earlier core executable and an earlier adapter containing the Go build marker plus PublishIfChanged, DeduplicateUnchanged and PublishForced. Set its mtime later than changed Go source; keep it executable. See T03.",
    "expected": "Before live evidence is attributed to the reviewed SHA, source and executable digests must be bound by a verified build stamp, or the binaries must be rebuilt/refused.",
    "actual": "The core is checked only for being an executable file. Adapter acceptance uses marker substrings and mtime, not source identity. Supervisor registration advertises git rev-parse HEAD independently of those executable contents. This is a provenance defect, not a claim that every arbitrary binary passes the complete journey."
  },
  {
    "uid": "T8-R3-06",
    "severity": "P1",
    "file": "tests/e2e/live-main.cjs",
    "line": 74,
    "title": "AC-02 counts frame-tag changes as successful presentations",
    "repro": "Use the existing fixture's 40ms generation/tag updates while leaving its canvas unpainted. Observe the whole-window tag-derived counter at approximately 25/s. See T11.",
    "expected": "The presentation-rate gate must count successful production presentation completions and check independently expected pixel content.",
    "actual": "The counter increments on a changed data-frame-tag. The fixture creates the canvas and updates the tag without painting it, so healthy-looking FPS can accompany zero successful draws."
  },
  {
    "uid": "T8-R3-07",
    "severity": "P1",
    "file": "tests/e2e/live-main.cjs",
    "line": 91,
    "title": "AC-02 aggregate FPS cannot enforce maximum presentation silence",
    "repro": "Provide 25Hz activity except one contiguous 4s silence during 600s; mean throughput remains about 24.83 FPS. The deterministic 10s fixture in T12 has 151 presentations and an exact 4000ms gap.",
    "expected": "For each visible tile, require both the applicable throughput threshold and no presentation gap above 2000ms, including start/end boundaries.",
    "actual": "AC-02 records aggregate FPS and generation totals without presentation timestamps or a maximum-gap check. A high mean accepts the stalled trace."
  },
  {
    "uid": "T8-R3-08",
    "severity": "P1",
    "file": "tests/e2e/e2e26_control_with_frames.test.js",
    "line": 752,
    "title": "Post-release progress can be satisfied entirely by pre-release frames",
    "repro": "At the pre-TAKE baseline, set presented=2; deliver five more frames while held, reaching 7; acknowledge RELEASE and deliver no further frames. Preserve the existing positive state-only count. See T07.",
    "expected": "Capture a RELEASE-time generation/count baseline and require a new completed presentation after the release acknowledgement/fence.",
    "actual": "The final condition compares against presentedBeforeTake+3 rather than a release-time baseline. Seven already exceeds five, so the purported post-release progress check succeeds without any post-release presentation."
  },
  {
    "uid": "T8-R3-09",
    "severity": "P1",
    "file": "tests/e2e/e2e14_perf.test.js",
    "line": 105,
    "title": "Fixed 26-frame calibration invalidates supported long-soak runs",
    "repro": "Run the proposed long path with MV_SOAK_SECS=600 and otherwise healthy clean output; the calibration clone retains 26 timestamps over the full clean duration. See T30.",
    "expected": "The comparator-calibration fixture must retain a rate strictly between the 8 FPS hosted-arm64 and 10 FPS local thresholds for every accepted duration from 3 through 600 seconds.",
    "actual": "Its rate is 26000/duration_ms, below 8 once duration exceeds 3250ms and approximately 0.0433 FPS at 600s. The positive hosted-arm64 assertion therefore fails independently of renderer health."
  },
  {
    "uid": "T8-R3-10",
    "severity": "P1",
    "file": "tests/e2e/run.py",
    "line": 29,
    "title": "Routing-mutant failure attribution accepts unrelated failures",
    "repro": "Return mutant process status 1 with output containing the passing test title 'malformed publisher ledger refuses with E2E_ROUTING' and an unrelated E2E_PREREQ failure; no failing routing oracle is present. See T14.",
    "expected": "Accept a mutant kill only when structured test evidence identifies the intended live-wall routing oracle as failed because of the injected mutation.",
    "actual": "The classifier requires only any nonzero status and the E2E_ROUTING substring. A passing test title provides the marker, so an unrelated failure is misattributed. This does not demonstrate survival of the current routing mutant."
  },
  {
    "uid": "T8-R3-11",
    "severity": "P1",
    "file": ".github/workflows/volume.yml",
    "line": 622,
    "title": "Volume soak validator accepts non-finite presentation times",
    "repro": "Inject a valid JSON synthetic report with started=0, ended=600000, four distinct tiles each containing 6000 string values 'nan', presentCount=6000, positive generation, matching RGBA pixels and a valid folded transition. See T31.",
    "expected": "Every timestamp must be a JSON number with finite value and valid ordering; invalid observations must fail before a PASS receipt is emitted.",
    "actual": "float('nan') yields NaN. Every gap comparison g<0 or g>2000 is false, while the count-based FPS and other fixture fields pass. The validator can emit PASS without usable presentation times."
  },
  {
    "uid": "T8-R3-12",
    "severity": "P1",
    "file": ".github/workflows/volume.yml",
    "line": 540,
    "title": "Volume time budgets are unsupported by the observed suite cost",
    "repro": "Compare the workflow's 120s repetition limit and 180min job limit for 20+300 repeats plus 600s soak with the reviewed-head existing CI suite durations: 213.294028902s x64 and 269.847315438s arm64. See B9/T29.",
    "expected": "Declare measured warmed costs, feasible per-attempt limits and enough total/sharded capacity to complete every mandatory attempt on each architecture; reject an infeasible qualification plan before spending the run.",
    "actual": "The observed suites exceed the per-attempt limit. The job allows an average at most 31.875s per repetition before overhead; unchanged-cost projections are approximately 19.13h x64 and 24.15h arm64. No warmed benchmark or completed Volume run was inspected, so this is a configuration/evidence mismatch, not an observed timeout."
  },
  {
    "uid": "T8-R3-13",
    "severity": "P1",
    "file": ".github/workflows/volume.yml",
    "line": 673,
    "title": "Synthetic short-soak receipt claims 600-second live qualification",
    "repro": "Inject or run a valid 3s synthetic-rgb24 report with four distinct 20Hz tiles, correct counters/pixels and folded capture progression, using the permitted 3s soak setting. See T32.",
    "expected": "The receipt must identify actual duration, synthetic/native scope and executed argv. A 600s native qualification claim requires that exact evidence.",
    "actual": "The validator scales its duration requirement to the chosen value but unconditionally reports a ten-minute live soak and count_source volume:soak-600s. The actual producer is perf-main.cjs, while the recorded command names e2e14_perf.test.js."
  },
  {
    "uid": "T8-R3-14",
    "severity": "P2",
    "file": "tests/e2e/e2e4_seams.test.js",
    "line": 133,
    "title": "Ordering test verifies digest syntax and counts without a semantic oracle",
    "repro": "Keep ADMITTED1:1 and ADMITTED2:1 but replace either printed digest with a different valid 64-character lowercase hex string. The existing assertions still accept. See T27.",
    "expected": "For each trace, compare against an independent declared state/verdict oracle and its own replay; compare only a documented commutative projection across permutations, and assert admitted identities when claiming the same multiset.",
    "actual": "Both digests are only regex-checked, and equal admission counts are labeled the same multiset. The current reversed same-lane sequence is order-sensitive, so blindly asserting equal digests would also be incorrect."
  },
  {
    "uid": "T8-R3-15",
    "severity": "P2",
    "file": "tests/e2e/e2e1_slice/demo_agent_drive.py",
    "line": 1254,
    "title": "Demo transcript substitutes an execution timestamp for native input time",
    "repro": "Use a successful tool result whose verified top-level input_mono_ns is 9001, whose receipt.executed_at_ns is 101, and whose projected receipt has no native_evidence member. Follow the real agents/tools.py wrapper into demo dispatch. See T09.",
    "expected": "Preserve the verified top-level native timestamp as 9001, or explicitly omit an unavailable native measurement; do not relabel an execution timestamp as native input time.",
    "actual": "The tool wrapper returns only the receipt. The demo's absent-native-evidence fallback uses receipt.executed_at_ns (or 1), then emits it as input_mono_ns. Its fixture retains nested native evidence and masks this real-path projection loss. Core native verification still runs."
  }
]
```

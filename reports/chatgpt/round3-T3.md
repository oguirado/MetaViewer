Reviewed: bridge/integration @ ae9361bb3d645eee1976ec8d739dc358b572561b

## Summary

**Verdict: changes required before release.** The delivered recording verbs cannot complete through the production client, and validly shaped responses can still cross a frame/surface binding boundary. There are **14 findings: 1 P0, 12 P1 and 1 P2 [MEASURED: table and machine block below]**. Two P1 items are test-oracle defects under the requested severity rule; they do not claim that the correctly implemented checks are currently absent.

The review covers the supplied T3 agents scope, all twelve refresh commits, the named day-2 paths and their dependency/contract tests at the immutable SHA in the first line. Source was read through the GitHub connector. The review owns only `reports/chatgpt/round3-T3.md`; no product code or tests are changed by this delivery. Temporary counterexamples and runtime mutants were run outside the published change. The source router declares itself unavailable, so the supplied explicit source coordinates and governing contracts were used; no routed-edit claim is made.

**Head reconciliation [MEASURED: GitHub compare and blob identity].** The reviewed head is 22 commits ahead of minimum `4f4c984cea539a68832901d0383d2f09e0db19ec`. The only additional `agents/` difference after that minimum is the optional `surface_request` input `origin` enum (`agent`/`human`) in `_contracts_v02.py:2051`, from `1fca7833429afb78d8c73c8dc06d8d45f0d79148`. Its mirror parity passed. `wender_bridge.py`, `perception/deps_lock.py`, `verify.py` and `mcp_server.py` have the same Git blob IDs as at `7acc35f7`; their re-confirmation still exposes the concrete remainder cases described here.

### Validation actually performed

| Check | Observed result |
|---|---|
| `python3 -m unittest discover -s agents/tests` | **554 tests, OK, 15.669 s** on Python **3.12.14** [MEASURED]. Temporary Unix sockets and subprocess/Git fixtures were permitted; no live core/capsule was used. |
| `python3 -m unittest discover -s tests -p test_python_contract_mirror.py` | **5 tests, OK, 0.019 s** [MEASURED]. All **541** supporting contract files were checked byte-for-byte against their pinned Git blob IDs. |
| Hardened `test_mvctl_timeout.py` with two concurrent CPU workers | **3 tests, OK, 0.700 s** [MEASURED], including its unshared-budget negative control. Its printed 75/120 ms values come from a mocked clock, not physical latency. |
| VCore real-child reap counterpart | Existing `test_tg_hygiene.py:303` passes for both `run_vcore` and `perceive` [MEASURED]. The prompt's claim that this test is missing is stale. |
| Record op-match mutant / VCore stderr-cap mutant | Each passes **554/554** tests in a fresh interpreter, with the runtime patch still active [MEASURED]. Exact behavioral differences were independently demonstrated. |
| Wender verified-root comparison mutant | **Killed: 2 failures in 554 tests** [MEASURED], by `test_w2_fx_agents.py:110,149`. A narrower test selection had missed these assertions; there is no finding for this check. |
| Supplemental codec probes | **4,353** real-base64-decoder comparisons pass; deep builder, timeout representability, sequence partial-write and width probes give the exact results in the annex [MEASURED]. |
| Existing hosted CI for the reviewed SHA | [CI run 40643560774](https://github.com/oguirado/MetaViewer/actions/runs/40643560774) completed successfully [CITED: GitHub workflow result]. This is existing CI evidence, not a newly dispatched full-stack gate. Other runs for this SHA were in progress when inspected. |

Full-suite mutation experiments changed objects/functions in the test interpreter, not repository bytes. Independently launched CLI interpreters therefore loaded original source. The two reported coverage gaps also have exact non-equivalence probes and a review of their committed test paths; the counts are not a claim that a patched checkout was tested by every spawned interpreter.

### Refresh-window rulings

`FIXED` below applies to the named original defect, not to every stronger property of the containing module. `STILL_OPEN` always identifies a new counterexample or an explicit proof limit.

| Commit | Ruling at reviewed head | Evidence and remaining scope |
|---|---|---|
| `e1f07fa3` | **FIXED** for stale consts, canonical sequence syntax, required request ID and request timeout rail | `envelope.py:595-604`; `client.py:399-433`; `test_fx2_agents_b.py:182,221,243,276,317`. Partial-write integrity and finite backend timeouts remain separate findings 10/06. |
| `d206e28e` | **FIXED** for C2 reply-vs-input digest, simple symlink refusal, bounded pump, summary limit and listed shape guards; **STILL_OPEN** for full pixel custody/totality | `test_fx2_agents_a.py:60-320` passes. Findings 02/04/07/08 identify different inputs; the existing fixes are not re-reported. |
| `bb77d17d` | **FIXED** for Wender kill/reap and duplicated huge-integer assertion coverage | `test_wender_bridge.py:222`; surviving `test_tg_contracts.py:118-162` retains the dropped CLI assertions with controlled warnings. Statistical order-independence is not certified. |
| `268afa51` | **FIXED** for a dead mutant making the harness fail | `agents/tests/run_mutant_harness.py:217-244` aborts on a failing baseline and exits 1 for any survivor. New surviving mutants are findings 12/13. |
| `b95affe5` | **FIXED** for terminal decoded byte-count consistency | `envelope.py:685-696`; `test_fx2_agents_b.py:482`; real-decoder oracle below. |
| `ffb1c910` | **FIXED** for the four no-core CLI refusal journeys | `test_mvctl_v02_e2e.py:28,39,52,57` passes in the full suite. The T8 integration file was read only. |
| `e4321108` | **FIXED** local op match, destination preflight and event-shape checks; **STILL_OPEN** end-to-end recording | Production transport necessarily rejects valid events (01); the op-match negative control is missing (12). Stop's per-event budget is quantified separately. |
| `c8d55fd2` | **FIXED** for the v0.2 mirror/wire rails and bounded generated session stamps | Wire and mirror tests pass; standalone builder skew remains (14). Rebasing is not a proof of globally monotonic timestamps. |
| `dff17a45` | **FIXED** for integer `nested_depth` in `{0,1}` | Mirror `surface_request` branch and full canonical-mirror comparison; bool/float/string are outside the accepted typed set. |
| `1550412b` | **FIXED** for frame surface-ID shape in both observation versions | `observe.py:123-127`; `test_observe.py:170`. Core clock implementation is outside T3. |
| `adb38c74` | **FIXED** for non-envelope `surface_input/v0.2` refusal and split example testing | No mirror entry; `wrap` produces `unknown_version`; `test_round1_regressions.py`, `test_tg_contracts.py`, mirror test exclusion is explicit. |
| `f6597790` | **FIXED** for the shared-budget test's race and missing negative control | All three tests pass under the stated load; no empirical all-load guarantee is claimed. |

**Closing items.** U3-AG-06 and ARG-agents-2 are **CLOSED** by removal of const healing plus raw/effective mirror parity. R1-048 is **CLOSED for `ToolClient.request`'s exact-int 1..60000 rail**; finding 06 concerns independently accepted backend timeout values. U3-AG-07 is **CLOSED for assertion-preserving test replacement**, with flake-rate certification explicitly not verified. U3-AG-01 remains open for truthful CLI config/operational-error mapping (11); resolver/planner failures are not reachable through this CLI and must not be invented as CLI branches. U3-AG-02 remains open (02); U3-AG-03's submit-once safety is proved; U3-AG-04's wired adapter path is covered, subject to its synchronous adapter contract; U3-AG-05's new spawn inventory is present and tested. No design-decision finding is reopened merely because a stronger, undocumented property would be desirable.

**Acceptance interpretation.** AC-01 remains partial (resolver content-integrity remainder); AC-02 and AC-05 remain partial (binding findings); AC-03 list/lifecycle shape remains partial and passes its Python tests; AC-04's human-control refusals and non-envelope refusal are preserved; AC-07 remains partial and is currently blocked through the real client; AC-09 has deterministic digest/nonce coverage without a blanket replay proof; AC-10 remains partial despite both direct-child reap tests; AC-11/12's owner/peer/closed-wire/no-echo checks pass within the stated trust model; AC-13 has passing baseline/CI evidence but the two new dead oracles. AC-06/08/14/15/16/17 have no T3 agents ownership in this report.

## Findings


Rows are ranked by severity. Repro details, proof domains and exact follow-up tests appear in the annex and test section. File links are pinned to the reviewed SHA.


| uid | severity | file:line | repro | expected | actual |
|---|---|---|---|---|---|
| T3R3-01 | P0 | [agents/metaviewer_agents/client.py:458](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/agents/metaviewer_agents/client.py#L458) | Real Unix-socket fixture: ram_start/ram_stop receives a correlated, codec-valid started/stopped record_event/v0.2. | Return the typed recording event; correlate the request, surface and recording identities. | ToolValidationError: uncorrelated tool result; one request has already been sent. |
| T3R3-02 | P1 | [agents/metaviewer_agents/perception/vcore.py:687](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/agents/metaviewer_agents/perception/vcore.py#L687) | A=bytes([0,0,0]), B=bytes([1,2,3]); reference sha256(A), Frame(1,1,B); honest C2 reports sha256(B). | identity_mismatch before the B pixels can produce trusted vision. | VCore accepts B; normalized element table labels its crop with sha256(A). Meta Muse also checks only dimensions. |
| T3R3-03 | P1 | [agents/metaviewer_agents/tools.py:774](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/agents/metaviewer_agents/tools.py#L774) | Observe surf-1, submit p-1; legal-wire verified p-1 has after_frame.surface_id=surf-B and outer frame_sha256='b'*64 differing from after_frame.sha256. | Typed correlation refusal; exactly one submission and no verified return. | run_loop returns verified=True for surf-B; operations are observe, propose, wait_verify. |
| T3R3-04 | P1 | [agents/metaviewer_agents/perception/vcore.py:343](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/agents/metaviewer_agents/perception/vcore.py#L343) | A FIFO without a writer at an otherwise valid RAM frame pathname; one RGB24 pixel, adapter timeout=0.01 seconds. | Typed non-regular-file refusal or an acquisition timeout, with zero engine spawns. | Blocking os.open, or os.read with an incomplete writer, precedes the bounded pump and can wait indefinitely. |
| T3R3-05 | P1 | [agents/metaviewer_agents/perception/deps_lock.py:133](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/agents/metaviewer_agents/perception/deps_lock.py#L133) | Commit tracked.py='print(1)\n'; git update-index --assume-unchanged tracked.py; replace with 'print(2)\n'; resolve against the unchanged full HEAD pin. | DependencyLockError with dirty_tree; no resolved checkout. | Empty git status and matching HEAD cause the modified checkout to be returned. |
| T3R3-06 | P1 | [agents/metaviewer_agents/client.py:209](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/agents/metaviewer_agents/client.py#L209) | CoreClient timeout_s=1e300; Wender timeout=10**400; either subprocess adapter timeout=1e20. | Typed timeout/bad_shape before connection or spawn for unrepresentable intervals. | Raw OverflowError at socket timeout conversion, math.isfinite, or selector timeout conversion; the adapter case can spawn first. |
| T3R3-07 | P1 | [agents/metaviewer_agents/perception/vcore.py:426](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/agents/metaviewer_agents/perception/vcore.py#L426) | Valid C2 except crop.reason=[]; run_vcore('selftest',[chr(0)]); NUL marks_out; 200,007-byte object containing 100,000 nested arrays. | PerceptionError bad_shape/unavailable, no raw Python exception; invalid argv refused before spawn. | Raw TypeError, ValueError or RecursionError. |
| T3R3-08 | P1 | [agents/metaviewer_agents/wender_bridge.py:241](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/agents/metaviewer_agents/wender_bridge.py#L241) | goal=chr(0xd800), or otherwise valid STATE with source.title=chr(0xd800). | ObservationError bad_shape: invalid goal before spawn; invalid returned STATE before storing a digest. | Raw UnicodeEncodeError at request encoding or canonical state hashing. |
| T3R3-09 | P1 | [agents/metaviewer_agents/envelope.py:842](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/agents/metaviewer_agents/envelope.py#L842) | make_envelope body with an unknown field containing 2,000 nested lists; build_observation frame with an unknown field containing a 1,200-level dict chain. | EnvelopeError/ObservationError bad_shape before traversing irrelevant deep content. | Raw RecursionError from deepcopy before the advertised validation boundary. |
| T3R3-10 | P1 | [agents/metaviewer_agents/client.py:374](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/agents/metaviewer_agents/client.py#L374) | Sequence file b'9', next_seq=9; make os.write perform only the first byte of reservation b'10' and return 1. | Failed reservation cannot decrease the next usable sequence and sends no request. | ClientError is raised, but the file becomes canonical b'1'; the next open accepts sequence 1. |
| T3R3-11 | P1 | [agents/metaviewer_agents/tools.py:598](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/agents/metaviewer_agents/tools.py#L598) | Valid UNAVAILABLE/NOT_FOUND tool errors; valid JSON configs {}, {"peers":[]}, {"peers":[null]}, or a mismatched session. | Preserve operational failure kind; classify local registration defects as usage_error without echo. | Core errors become schema_error; configs become transport_error, transport_unavailable or schema_error before any client exists. |
| T3R3-12 | P1 | [agents/tests/test_record.py:72](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/agents/tests/test_record.py#L72) | Remove only mvctl.py:473's op/command guard in memory; run all 554 agents tests. Separately pass ram_start JSON to record-stop. | A committed negative control turns the mutated suite red. | 554/554 pass; the separate killing input changes local refusal into rc0 and disk_stop dispatch. |
| T3R3-13 | P1 | [agents/tests/test_fx2_agents_a.py:131](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/agents/tests/test_fx2_agents_a.py#L131) | Raise only vcore._STDERR_RAW_CAP from 2**20 to 2**60 in memory; run all 554 tests; real child emits 2**20+1 stderr bytes. | A committed over-stderr-cap control kills the mutant and confirms reaping. | 554/554 pass; original rejects the real child, mutant accepts all 1,048,577 stderr bytes. |
| T3R3-14 | P2 | [agents/metaviewer_agents/observe.py:128](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/agents/metaviewer_agents/observe.py#L128) | Otherwise valid frame with ts_ns=2**53 (also generation/tick/capture_us); summary=chr(0xd800) or 65,537 ASCII characters. | A validated builder result round-trips through the selected envelope version, or raises ObservationError first. | Builder returns successfully; the envelope rejects unsafe integer, surrogate or UTF-8 ceiling. Some tool checks also reject the integer. |



## Proofs and bounds annex

### Evidence conventions and Context7 routing

`[MEASURED]` identifies an executed observation, `[CITED]` a retrieved repository/CI fact, `[TARGET]` a proposed acceptance condition, and `[DERIVED]` a mathematical argument shown here. All source locations refer to the immutable reviewed head. Paths abbreviated below are under `agents/metaviewer_agents/`, except explicit test/contract paths. The supplied E1–E14 excerpts motivate the proof obligations; their original scanner, cage and oracle theorems are not silently transferred to different Python code.

All six requested exact phrases were submitted to `/oguirado/math-router` through Context7. Its tool permits three documentation-query calls per question, so related phrases were grouped into three calls: M1+M4 (loss detection and finite buffers), M2+M5 (confidence versus interaction coverage), M3+M6 (timing and integrity assumptions of timestamped evidence). The returned material did **not** contain the requested applicable theorem statements. M2 returned `PM-113.1#pm-cite-18`, mentioning Hoeffding without constants; M5's `PM-138.2#stmt-lem-separator` concerned a different coverage problem; M3's `PM-124.1#stmt-thm-main` concerned unit-job precedence scheduling and did not establish practical latency. No usable SPRT, M/M/1/K, IPO optimum or SHA-256 theorem/anchor was returned. Requested extraction: **ABSENT — do not invent**. The results below are consequently derived, with explicit assumptions, rather than falsely attributed to those papers.

| Requested query | Application here |
|---|---|
| M1 `sequential hypothesis testing for loss detection` | Deterministic cache eviction first; a separately assumed Bernoulli sequential experiment with explicit error/sample bounds. |
| M2 `concentration bounds for flaky-test rates` | Assertion-preserving drop audit and an explicit future statistical certification target. |
| M3 `fixed-deadline scheduling and jitter` | Conditional ceil-quantization and scheduler/cleanup bounds, not an unconditional real-time promise. |
| M4 `queueing backpressure bounded buffers` | Actual payload caps; queue formula derived only for a model the receipt cache does not satisfy. |
| M5 `combinatorial coverage for test design` | A proved minimal matrix for a precisely declared factor model, not an invented universal IPO optimum. |
| M6 `hash-chain security bounds` | Ideal-hash union bounds, explicit trust anchors, and no hash-chain claim for the decimal sequence file. |

### A1. Closed codec, version isolation, framing and representability (obligations 1, 7, 8, 10; E1/E2/E7/E12/E13)

**Wire-codec invariant [DERIVED].** For a positive integer byte cap C and a byte string x, `loads_envelope(x,max_bytes=C)` either returns a dictionary satisfying its supported discriminated schema and global scalar restrictions, or raises `EnvelopeError`. This claim is for the byte-oriented decoder under ordinary Python resource availability, not arbitrary user-defined objects or a guarantee against MemoryError. The checks occur in this order: byte cap; LF/CRLF framing and no embedded raw newline; UTF-8 decode; a string-aware container scan refusing depth 33; JSON parsing with duplicate-key and literal-nonfinite rejection; exact outer keys; safe integers, finite floats and Unicode scalar strings; endpoint/name/sequence/stamp shape; exact body registry/version; recursive closed-schema validation. `1e999` parses as infinity but is rejected by `_check_json_values`, so it does not evade the finite-number rail. See `envelope.py:739-804,887-944` and `test_depth_32.py`, `test_nesting.py`, `test_round1_regressions.py`, `test_fx2_agents_b.py`.

The safe-integer domain is `[-K,K]`, `K=2**53-1`; nonnegative stamps additionally require `>=0`, and sequences require `>=1`. `type(x) is int` rejects booleans as integers. Strings are Unicode scalar sequences whose UTF-8 encoding has at most 65,536 bytes. The global byte test applies to keys too. First-rejected oracles: integer K+1; `NaN`, `Infinity`, `1e999`; lone `chr(0xd800)`/`chr(0xdfff)`; ASCII lengths 65,536/65,537; emoji counts 16,384/16,385; nesting levels 32/33. Test the byte loader and encoder independently. Direct builders are a different path: deep-copy-before-validation refutes their totality (09), and standalone observations lack some global scalar rails (14).

**Version-isolation invariant [DERIVED].** If decoding succeeds, `body.schema` is an exact key of `_BODIES` and its final version segment equals the supported outer version. Suffix guessing alone never admits an unknown discriminator: `make_envelope` may choose a legacy outer wrapper from a suffix, but `validate_envelope` still requires the exact registry key. Nested pins come from the selected mirror. `_version_refs` writes only keys equal to `$ref`; for the probe `{'const':'observation/v0.1','$ref':'frame_ref.schema.json'}`, the const is unchanged and the ref becomes `v0.2/frame_ref.schema.json`. No const-rewrite branch survives at `envelope.py:595-604`. Raw and effective mirror comparisons against every canonical envelope schema pass; this closes U3-AG-06. The special canonical `surface_input.schema.json` is intentionally excluded from the envelope mirror by `tests/test_python_contract_mirror.py:66-77`. Standalone source-schema validation of a valid `surface_input/v0.2` body succeeds, but wrapping that same body raises `unknown_version` and sends nothing. This is expected refusal, not mirror drift. The newest `origin` enum is mirrored and does not turn the client codec into an authorization decision.

**Regex invariant [DERIVED].** Compiling terminal `$` as `\Z` at `envelope.py:570-575` prevents acceptance just before a trailing LF. Fullmatch or an equivalent end anchor plus the explicit CR/LF path check applies to the relevant identifiers/digests/paths. A 64-character lowercase digest passes; the same string plus LF fails. A canonical RAM path plus CR/LF fails at tools, observation and envelope boundaries. The schema prefix must remain exact; an ID that happens to contain a version substring does not select a schema.

**Terminal byte-count theorem [DERIVED].** The terminal `b64` schema admits complete base64 quartets followed by only an allowed final padded quartet. Let `m=len(b64)` and let p be the number of trailing `=` characters. Each full quartet encodes three bytes, and final padding removes p bytes, so decoded length is exactly `3*(m//4)-p`. `envelope.py:685-696` compares `byte_count` to that value after child-schema validation. This arithmetic is sound only because malformed alphabet/length/padding has already been refused. `[MEASURED]` All 257 encodings of byte lengths 0..256 and all 4,096 two-symbol padded spellings were compared against `base64.b64decode(...,validate=True)`: 4,353 comparisons agree. `YQ==/1`, `YWI=/2` and empty/0 pass; `YQ==/2`, `A`, `A===` and `====` refuse. `YR==` and `YWJ=` have noncanonical pad bits but the strict stdlib decoder accepts them with lengths 1 and 2; the length check does not claim canonical base64 spelling or content authenticity.

**Read-decision bound [DERIVED].** In `CoreClient.recv`, with complete-frame cap C, initially `len(_rx)<=C+1`; every recv asks for exactly `C+1-len(_rx)` bytes, so induction preserves that bound. A newline-delimited frame is accepted for parsing only when its total length, including LF, is <=C; no newline and C+1 bytes causes immediate length refusal. Thus at most C+1 accumulated bytes are needed to decide an oversized line. This cap convention differs by one byte from E1's payload-only M. Timeouts do not reset on incoming chunks. `mcp_server.serve` similarly calls `readline(M+1)` once per candidate frame, with `M=2**20`, and terminates after a length/nontermination framing error rather than parsing the tail as a new request. These are bounds on explicitly retained framing data; Python's underlying buffered I/O, copies and JSON objects consume additional memory. A silent stdio peer can block `readline`: no wall-time input deadline is implemented or inferred from the byte theorem.

**Emission bound [DERIVED].** On the normal blocking-writer path, every `serve` write consists of one JSON payload plus one LF and has length <=M. `json.dumps` escapes embedded controls and uses `allow_nan=False`; failure/oversize enters a correlated error fallback; an unbounded ID is replaced by null; the actual fallback is rechecked; a fixed null-ID literal is rechecked; if even that literal will not fit, nothing is written. At the declared ID cap, the fallback plus LF is at most 207 bytes, and the null-ID literal plus LF is 83 bytes [DERIVED by 128-byte maximal serialized ID replacing the four-byte `null`; verified byte counts]. Oracle caps `{82,83,206,207,2**20}` exercise all fallbacks; every written frame must end in exactly one raw LF and parse whole. Physical stream writes are not transactional: an OS write/flush failure can leave a prefix. E2's all-or-nothing physical I/O property is therefore not a theorem of this implementation. With the supplied trusted client, stdout has no other emission path; arbitrary injected code that prints is outside that purity guarantee.

**ID-cap theorem [DERIVED].** `_bounded_id` caps the serialized JSON representation, not merely character count (`mcp_server.py:388-392`). Thus 126 unescaped ASCII characters, such as `'a'*126`, plus quotes total 128 bytes and pass; 127/128/129 such characters fail. ASCII quotes, backslashes and controls consume extra escape bytes. Escaped `é` consumes six bytes per character: 21 pass (128 including quotes), 22 fail. Safe integer IDs ±K pass, ±(K+1) fail, bool is rejected by `Server.handle`. These oracles avoid the incorrect claim that all 128-character IDs should pass.

**Width and parse-cost assessment [DERIVED].** The wire byte cap and depth scan precede parsing; `maxProperties` and `maxItems` do not. For input length L within the configured cap, valid-depth JSON parsing and duplicate checking require O(L) space and expected O(L) work under ordinary constant/amortized hash-table behavior and bounded numeric-conversion costs before schema width rejection. Global scalar traversal also precedes schema member checks. A single scan/parse/traversal does not establish an adversarial worst-case time bound for hashing or numeric conversion; the measured short-key/zero-value family below isolates the width cost. Constants and allocator overhead are not one byte per input byte. `[MEASURED]` Replacing a valid proposal's action with `{str(i):0 for i in range(N)}` gave: N=10,000, L=89,412, `bad_shape`, 0.058684 s and 1,787,470 tracemalloc peak bytes; N=100,000, L=989,412, `bad_shape`, 0.516403 s and 22,471,342 peak bytes. Both are below the MCP 1 MiB input cap. These single-run local observations do not establish a portable latency/RSS limit. Proposed pre-parse member counting must understand strings/escapes and preserve each schema's declared array limits; counting every comma is not sufficient.

`mcp_server._decode_frame` uses `parse_constant` but no checked `parse_float`, so `1e999` becomes infinity in otherwise ignored initialize capability metadata [MEASURED]. Numeric tool arguments reject it by exact type/range; output serialization rejects nonfinite results. A global “all MCP metadata is finite” theorem is not supported. This is recorded as a boundary difference, not an invented operational acceptance defect or a re-report of a closed envelope guard. The serial `serve` loop awaits each `to_thread` operation before reading/dispatching another, so it creates no per-request unbounded dispatch backlog; concurrent external `Server.call_tool` invocations are a different embedding contract.

### A2. Client state, strict requests, sequence persistence and session clock (obligations 4, 5, 7, 10; E5/E8/E9)

**Absorbing-state proof [DERIVED].** Model the client as fresh, connected, hello-ready, and terminal. `_terminate` and `close` set `_terminal=True`, clear the receive buffer and close/remove the socket (`client.py:145-149,320-325`). No method sets `_terminal=False` after construction. `connect`, `send`, `recv` and `handshake` check it before work. Every failed handshake reaches `_terminate`; repeat handshake also terminates. ToolClient's `close` clears `_ready`; failures in enter/request close it. Therefore terminal is absorbing for all public transitions, and a pin mismatch sends zero verb envelopes. A local pre-send validation refusal can leave a connected client usable by design; it is not a revival of a terminal state. Standalone legacy `connect` failures must not be conflated with failed hello exchanges.

**Strict-request theorem [DERIVED].** Conditional on a ready client, accepted `timeout_ms` has exact type int and lies in `[1,60000]`. The check precedes envelope construction, reservation and send (`client.py:424-425`). Required `request_id` must be a nonempty string; envelope validation subsequently enforces its remaining shape/cap. Boolean, float, string, null, negative, zero, 60001 and `10**400` inputs fail before any effect. This proves the specified R1-048 request rail over ordinary Python input types. The lower CoreClient constructor's finite-positive test is not a representability proof for socket/select timeouts (06). Every request uses `deadline=now+min(previous_timeout,T/1000)` and recomputes receive allowance; the previous transport timeout is restored in finally. Synchronous sequence-file fsync, encoding and OS scheduling are outside a strict wall-clock bound and can consume time before the next deadline check.

**Sequence invariant and counterexample [DERIVED].** Enter checks owner, regular-file type, mode 0600, link count one, final-component no-follow and an exclusive nonblocking lock. The accepted persisted syntax is exactly `[1-9][0-9]{0,15}`; no signs, whitespace, newline, leading zero or non-ASCII digits pass. `_envelope` rejects safe-integer exhaustion. `_reserve` writes the next sequence before any socket send, then truncates/fsyncs. With complete durable writes and a stable locked inode, this prevents uncertain sends from reusing a reservation. It does not establish integrity under partial writes: from `b'9'`, the first byte of `b'10'` leaves `b'1'`, then the short-write branch raises. The next opener accepts the canonical earlier state. This exact real-write fault injection is finding 10. A filename SHA-256 partitions identity scopes; the file contents have neither a checksum nor a hash chain. Parent-directory mutability, crash publication and integrity protection require additional assumptions; canonical decimal syntax alone is insufficient.

**Clock-range theorem [DERIVED].** Let the sampled integer clock be n, remembered origin o and `K=2**53-1`. `make_envelope` samples once. If o is absent, the clock function identity changed, n<o, or n-o>K, it assigns o:=n; otherwise it keeps o. Thus the generated timestamp is either 0 or n-o with `0<=n-o<=K`, proving no out-of-safe-range stamp on the generated path (`envelope.py:822-832`). Explicit supplied stamps are validated independently. Oracle: one clock function returns `[100,100+K,101+K,50]`; generated stamps are `[0,K,0,0]` [MEASURED]. Swap clock functions and test the same condition; use explicit K/K+1 to test admission/refusal. A backwards sample still above the origin can reduce a timestamp, and a rebase resets it to zero. Consequently this is a range/fail-closed representation guarantee, not globally monotonic chronology across rebases or independent session epochs. No floating ceil is used in this integer clock; M3 quantization applies to timeout arithmetic separately.

### A3. Wender state custody, dependency resolution and subprocesses (obligations 2, 3, 9, 10; E3/E6/E7/E9/E12/E13/E14)

**State/plan safety [DERIVED].** For representation-valid built-in JSON values, `validate_state` requires the exact state/source/prune/node/count key sets, unique lowercase 16-hex node IDs, parents referencing an earlier node, count consistency, and ordered equality of actionable IDs to actionable nodes (`wender_bridge.py:44-107`). Exact integer checks exclude bool; canonical state rejects floats and non-string keys, and refuses depth beyond 100. `plan_step` clears its stored digest first, validates v0.2 observation/table binding, exact row/bbox shape and integer score in `[0,1000000]`, then sends only JSON stdin. The returned unique-key object must have the exact response keys; the chosen target must match one actionable node in the same returned STATE, and its click must satisfy `x0<=x<x0+w` and `y0<=y<y0+h`. Digest assignment occurs only after these checks. This proves internal response consistency and half-open geometry on successful calls; it does not independently authenticate the returned STATE against perception, and it does not prove totality for every supplied str/int (06/08).

Boundary oracles: score `{0,1000000}` passes and `{-1,1000001,True,0.5}` refuses; in a 4x3 frame `(0,0,4,3)` is inside, `(0,0,5,3)` and `(4,0,1,1)` are outside; for box `[1,1,2,2]`, clicks `(1,1)` and `(2,2)` pass, `(3,2)` and `(2,3)` refuse. Closed-key/geometry assertions in `test_w2_fx_agents.py:21-74` independently cover these classes. Leading-whitespace generation-control names such as `' Stop'` are refused by the refreshed executor match, with a killing test at `test_fx2_agents_a.py:189`. There is no fixed total node-count or goal-length cap on direct API inputs; consistency counts are not a width cap. Before output parsing, the response byte cap bounds wire response size, but direct supplied state/goal can require work proportional to its full size. `_canonical_bytes` encoding of a surrogate refutes total typed validation (08).

**Resolver decision partition [DERIVED].** For declared name/path types and a stable filesystem: malformed unique-key JSON, non-object lock, non-list components, non-object cells, duplicate/nonempty-name failures, non-lowercase/full-40-hex commits, or a missing required component yield `bad_lockfile`; only exact requested names `vision-engine` and `wender-agent` proceed. Additional valid named lock entries may exist but cannot be requested as components. Missing/bad/non-directory root gives `unavailable`. A `.git` checkout takes the Git branch without a wheel fallback: unequal HEAD gives `commit_mismatch`, reported tracked dirt gives `dirty_tree`; the remaining return path is not a full tracked-byte proof because of finding 05. A wheel root requires exactly one matching distribution metadata directory and valid Git `direct_url.json` provenance with the expected full commit; malformed/ambiguous metadata gives `unavailable`, mismatched commit gives `commit_mismatch`. See `perception/deps_lock.py:51-143` and all `test_deps_lock.py` cases.

Root aliases resolve before comparison; a legitimate symlink to the same checkout is accepted, distinct resolved roots with `verify_lock=True` are refused. The full-suite mutant confirms both independent Wender root tests are effective (`test_w2_fx_agents.py:80-110,138-150`). Symlinked/relative lock paths are allowed, not a promised confinement boundary. Wheel provenance metadata does not authenticate installed bytes. The inspected HEAD and worktree may change between Git commands or before spawn; without an immutable checkout, no atomic custody theorem follows. The concrete assume-unchanged attack is stronger than a merely hypothetical race and is the reported integrity finding.

**Confinement theorem and limits [DERIVED].** Wender's Popen receives an argv tuple, resolved-root cwd, no shell option, and explicit environment drawn from `{PATH,LANG,PYTHONPATH,PYTHONDONTWRITEBYTECODE}`; the latter values are set to the resolved root and `'1'`. CPython may add `LC_CTYPE` during startup, as the test anticipates. Untrusted goal/observation text reaches stdin only. VCore invokes fixed module prefixes `vadapt.cu_describe`/`visioncore.cli`, passes frame descriptors explicitly and captures both output pipes. Its environment intentionally also preserves HOME and does not disable bytecode writes. It is incorrect to attribute Wender's four-key environment or a no-checkout-write theorem to VCore. Trusted interpreter/argv/PATH/root configuration can select executable code; argv-only invocation is not an OS filesystem/network sandbox, and explicitly configuring a shell executable is not shell interpolation by this bridge.

**Bounded-pump proof [DERIVED].** Wender's selector drains stdout and stderr while writing stdin in nonblocking pieces of at most 4096 bytes, so a child that never drains stdin cannot trap the parent in a blocking write. The loop checks one monotonic deadline. Its caps are stdout 1,048,576 bytes and stderr 65,536 bytes; each read is limited to remaining capacity plus one sentinel. At immediate overflow, retained output payload is at most 1,114,113 bytes. VCore has *both* stdout and raw stderr caps equal to 1,048,576 bytes, with a separate 1000-character display truncation. Its retained chunk payload is at most 2,097,152 bytes; a transient read adds at most 65,536; joins can additionally duplicate up to 2,097,152. These bounds exclude interpreter/object/request/JSON overhead. A stream of one-byte reads can create O(B) chunk objects even with bounded payload B.

Both pumps kill a still-running direct child and wait in finally, closing their own pipe handles. Wender's real-child test is `test_wender_bridge.py:222`; VCore's already-existing counterpart is `test_tg_hygiene.py:303-348`, covering both spawn paths and `waitpid(...,WNOHANG)` raising after reaping. `[MEASURED]` The VCore counterpart passed. The dead stderr-size oracle is separate (13). Descendants are not explicitly process-group-contained. A bound on time-to-kill needs a scheduler/batch-work bound; unconditional `wait()` has no specified finite worst-case cleanup duration. The pre-spawn FIFO counterexample is even earlier: stock-code `perceive`, timeout 0.01, remained blocked at **0.300497 s** after a READY signal, with no engine marker, in a real temporary `/dev/shm` FIFO [MEASURED]. The watchdog killed/reaped only its helper and cleaned both fixtures. Thus the subprocess timeout cannot be advertised as a bound on acquisition/encoding plus execution.

### A4. Loop safety, receipt integrity, frame binding and error mapping (obligations 1, 4, 5, 6; E4/E5/E8/E9/E10)

**Submit-once proof [DERIVED].** `verify.run_loop` is straight-line observe → optional perception → planner → proposal → wait. Its control-flow graph contains exactly one `tools.propose` call at line 78 and no back edge. Planner/perception validation or deadline failure before that point gives zero submissions; any later refusal/timeout gives at most one. `tools.wait_verify` repeats only wait requests, never a proposal. Hence every invocation path satisfies `number_of_submit_calls<=1`, independently of whether callbacks terminate. A transport failure after admission may leave one executed action; no retry is correct. Arbitrary synchronous injected callbacks can sleep forever or raise arbitrary exceptions, so they cannot support a universal typed-termination or fixed wall-time theorem. The module explicitly assigns adapter subprocess timeouts to the adapters. U3-AG-03's safety remainder is closed; U3-AG-04 wiring is present, with these liveness qualifications.

**Day-2 closures [DERIVED].** Observation validation passes the requested `contract_version` through tools and builder, so v0.2 no longer hard-codes v0.1. An accepted state-hash tick window has integer nonnegative endpoints and `min_tick<=max_tick`; `(3,2)` refuses before dispatch, `(2,2)` is permitted (`tools.py:314-319`). `tools._check_receipt_verified` requires the closed native-evidence shape, safe nonnegative stamps and `native.surface_id==receipt.after_frame.surface_id` before accepting verification; unknown keys and mismatching native surface refuse (`tools.py:512-553`; `test_native_receipts.py`; `test_verify_v02_loop.py`). The separately frozen inline tool-result receipt intentionally does not gain native_evidence merely because standalone receipts do; `test_tg_contracts.py:54` documents that distinction. No source/mirror drift finding is based on it.

**Desired verification invariant [TARGET].** On successful verified return R for proposal P based on observation O: `R.proposal_id=P.proposal_id`, `R.after_frame.surface_id=P.surface_id=O.frame_ref.surface_id`, outer `frame_sha256=R.after_frame.sha256`, all relevant stamps are in `[0,K]`, `R.verified=True`, `R.error==''`, and the required outer witness fields exist. If native evidence is present, its surface must equal that after-frame surface and its declared success fields must be valid. The present code proves proposal identity, syntax/ranges, `verified=True`, empty receipt error and outer focus proof; it does **not** prove the two cross-surface/hash conjuncts (03). A native-surface check against an already wrong after-frame cannot repair the missing correlation to the original observation. A false/unwitnessed receipt is never promoted merely by asynchronous harvesting, and the timeout branch requires `verified=False`.

**Perception-binding invariant [TARGET].** Let H be SHA-256, P the actual input pixels, F the trusted frame reference, and C the C2 response. Required custody is `H(P)=F.sha256=C.frame_sha256` with matching dimensions and surface/generation. The refresh establishes the comparison `H(P)=C.frame_sha256` for supplied/loaded pixels, not the missing equality with F. The exact one-pixel A/B counterexample in finding 02 passes an honest engine and is later labelled with F. Meta Muse similarly checks dimensions without input digest custody. This is not a cryptographic collision and needs no SHA-256 attack. `vision.describe`'s tuple/return-code/description checks and original C2-to-reference bridge checks remain fixed; the adapter path is the surviving gap.

**Reachable CLI mapping [DERIVED from `mvctl.py:118-125,187-216,422-554` and `tools.py:66-79,586-598`].** The table enumerates the actual kind sets rather than manufacturing planner/resolver branches in a CLI that never invokes them.

| Input/failure family | Complete relevant kinds | Current output/exit |
|---|---|---|
| Successful supported verb | observe, list, propose, wait-verify, record-start, record-stop | One JSON result and rc 0, if its underlying path returns; actual record transport currently prevents this for the two record verbs. |
| Core/record policy refusal | STALE_FRAME, SURFACE_NOT_AGENT_CONTROLLED, LOCKED_BY_OTHER, BUDGET_EXCEEDED, OUT_OF_BOUNDS, POLICY | Fixed refusal result, unchanged reason, rc 1. |
| Core tool errors | PROTOCOL, UNAVAILABLE, NOT_FOUND, VERIFICATION_FAILED | First three become schema_error/rc 2; last preserves original failure payload/rc 1. UNAVAILABLE and NOT_FOUND are valid operational failures, so the first mapping is misleading (11). |
| ClientError | timeout, unknown_version, version, schema, bad_shape, length, socket | timeout; unknown_version; version; schema_error; schema_error; transport_error; socket maps by phase to endpoint_error/transport_error. All rc 2. |
| Local parsing/config/shape | missing flags/duplicates; unreadable or non-JSON config; successfully parsed bad registration shape | First two classes usage_error/rc 2; structural config faults scatter across transport/schema categories (11). No config text is echoed. |
| Other exception helper mapping, if called | TimeoutError; AttributeError/TypeError; FileNotFoundError/NotADirectoryError/PermissionError; ValueError/UnicodeError; ConnectionError/OSError/EOFError; other mapped values | timeout; transport_unavailable; endpoint_error; endpoint_error in connect else schema_error; endpoint_error in connect else transport_error; fallback transport_error. This helper table is broader than `_run_v02`'s catch set: line 545 catches only ValueError, OSError, TimeoutError, TypeError, KeyError and StopIteration. AttributeError/EOFError are not caught there merely because the helper defines a mapping. Construction/enter failures use call phase. |
| Record event families | started, stopped, frame_captured, exported, dropped, refused | Exact event checks; valid policy refusal follows rc 1; malformed/unexpected event maps schema_error/rc 2, foreign version unknown_version/rc 2. Actual production transport fails first (01). |
| Resolver / lock library | bad_lockfile, unavailable, commit_mismatch, dirty_tree | `DependencyLockError`; adapters preserve the code. **Not a reachable `_run_v02` branch.** |
| Planner/perception library | bad_shape, unknown_version, identity_mismatch, unavailable, timeout, plus propagated resolver codes; bridge uses VisionBridgeError | Library exceptions/caller responsibility, not CLI exits. The raw exceptions in 06–09 refute an exhaustive typed-outcome claim. |

**Exit theorem qualification [DERIVED].** For a successfully parsed machine-mode verb, rc 0 is reached only after the selected verb function returns and its result is printed. The code does not return 0 for an empty or missing-flag invocation. Literal universal “rc 0 iff at least one verb step ran” is false for `['--help']` and `['observe','--help']`, which intentionally return 0 through argparse without a verb. This ordinary help behavior is a theorem-domain exception, not a style-only product finding. Likewise successful `propose` means admitted submission, not completed physical verification; `wait-verify` owns that later statement. Fixed refusal text prevents input/config echo, while truthful category preservation remains incomplete (11).

### A5. Recording, bounded rails and closure oracles (obligations 8, 9, 10)

**Record-request invariant [DERIVED].** `_check_record_request` accepts only exact envelope-body keys and op-specific param sets, matching optional expected_op, schema, identities and numeric rails (`tools.py:819-881`). CLI preflight accepts start ops only for record-start and stop ops only for record-stop (`mvctl.py:467-480`). Disk start requires both a syntactically valid capability ID and an absolute NUL/CR/LF-free destination path; omission refuses before client construction and no recording bytes are written. RAM start forbids disk destination fields. These checks are currently correct; removing op match is the separate dead-oracle finding 12.

**Record-event invariant and contradiction [DERIVED].** A locally checked event has exactly the requested `(request_id,surface_id,recording_id)`, safe `mono_ns`, exact event-dependent keys and bounded counters. Start must return started with matching mode; RAM-stop intermediates may only be frame_captured/dropped, disk-stop intermediates only exported, and final event must be stopped; otherwise typed refusal. Yet a closed `record_event` contains no op, while `ToolClient.request` unconditionally compares `result.get('op')` against the nonempty request op. None cannot equal any supported op, so every schema-valid event fails that transport predicate. The real Unix-socket reproductions establish the blocked end-to-end path (01), beyond the fake-client record tests.

**Destination/RAM proof scope.** Agents validate destination syntax and forward it; they do not resolve capability authority or open the recording destination. An absolute string containing `..` is not by itself a demonstrated disk escape: authority/canonicalization occurs outside this Python layer and was not executed here. No end-to-end filesystem containment theorem is claimed. RAM tool functions have no recording-file write path, but the complete CLI still reads config/payload and reserves a sequence file beside the trusted socket. A fake-client test cannot prove that arbitrary endpoint configurations leave every home/repository byte unchanged. The report preserves that distinction instead of inventing a native-writer guarantee or reopening a deliberate sequence-file design.

**Record-stop exposure [DERIVED, quantified limitation rather than an unconditional contract allegation].** Unlike wait_verify, `record_stop` reuses the full T-ms timeout for each of at most 256 requests (`tools.py:1063-1072`). With n cooperative replies the transport allowance is at most nT, plus processing/scheduler overhead; at T=60000, 256T=15,360,000 ms=256 minutes. `[MEASURED]` Three legal dropped/dropped/stopped replies taking 40 ms each with T=50 returned after 120.640 ms, receiving budgets `[50,50,50]`. The function documents stream draining but does not explicitly promise a single overall deadline, so this is not counted as a separate unambiguous defect. A consistent single-verb deadline is proposed below; after the transport fix, it needs its own test and an explicit contract. A virtual-clock oracle can expose the replenishment without flaky timing assertions.

**Cross-layer rail map [CITED: named source checks; property interpretations DERIVED].** Do not treat narrower tool-result policy as an accidental change to a separately frozen standalone schema.

| Rail | Where established | Exact boundary/property oracle |
|---|---|---|
| Dimensions and positive bbox sizes <=16384 | v0.2 mirror; `tools.py` frame/action/expectation checks; `observe.py:132-135` | Dimensions `{1,16384}` pass, `{0,16385,True}` refuse. For an observed bbox additionally require nonnegative x/y and x+w<=width, y+h<=height. Standalone proposal x/y do not have an implied observed-frame origin bound. |
| Wait/budget ms <=3600000 and retries <=10 | v0.2 mirror; `tools.py:243,373-375` | ms 1/3600000 pass, 0/3600001 refuse; retries 0/10 pass, -1/11 refuse; bool/float refuse. These are distinct from the per-request 60000-ms limit. |
| Per-request 1..60000 ms | `client.py:424-425`; wait/MCP checks | Exact int endpoints pass shape; 0/60001 and alternate types refuse before reservation/send. Some direct tools helpers only enforce positivity, but production transport still rejects >60000. |
| 65,536 UTF-8 bytes and scalar strings | `envelope.py:739-759,705-715`; global independent checker/mirror tests | ASCII/emoji and surrogate oracles in A1. Standalone observation builder exception is finding 14. |
| RAM path length 10..255; 1..8 segments, segment length 1..128 | tools/observe/envelope/mirror | `/dev/shm/x` is the minimum valid form; `/dev/shm/` fails. Eight one-character segments pass; nine fail. Segment first char is alphanumeric/underscore; later dot/dash allowed. To test total lengths 255/256 use two otherwise valid segment lengths 128+117 / 128+118. Reject duplicate slash, `..` segment, spaces, CR/LF/NUL. |
| Surface ID 1..128 | `observe.py:123-127` in both versions; tools and v0.2 mirror | `a`, 128 a's pass; empty/129 a's fail; dot/dash/colon/underscore first character fail, same characters after `a` pass; slash, space, newline, NUL fail. Full neighbor counts are derived below. |
| `nested_depth` | mirror create branch around `_contracts_v02.py:1970`; canonical parity | Typed int 0/1 accepted, -1/2 refused; explicitly test bool, float, str, null rather than relying on Python equality to 0/1. |
| Vision summary and collections | `perception/base.py:36-39`; `tools.py:422-434`; Meta Muse checks | Summary length 4096 accepted, 4097 refused at plugin/inline tool boundary. Plugin regions/elements cap is 4096; inline tool-result regions/elements cap is 256: test cap and cap+1 separately with valid entries. Plugin element-name ceiling is 65536; inline name ceiling is 4096. Standalone observation has separately declared widths. |
| Recording ring/FPS/stream | `tools.py:56-60,845-848,1063` | Ring bytes 1/(2**30) pass, 0/(2**30+1) refuse; FPS 1/120 pass, 0/121 refuse; 256 allowed intermediates without terminal event reach typed stream-cap refusal. |

**Drop audit [DERIVED and MEASURED].** The removed `test_mvctl_huge_integer_exact_refusal` checked x=`10**400`, rc 2, no ToolClient construction, and one exact schema-error stderr line. The surviving `ContractGapTests.test_huge_integer_refusal_stays_exact_during_resource_cleanup_warning` (`test_tg_contracts.py:118-162`) repeats those assertions, additionally checks empty stdout and cleanup, explicitly triggers delayed TemporaryDirectory GC, and captures ResourceWarning separately while restoring GC state. Codec/receive huge-integer tests remain too, but they are not the substitute for exact CLI stderr; the named survivor is. The immutable full suite passed. This closes the coverage-equivalence question while leaving population flake-rate certification to the M2 experiment below.

### A6. New mutant contrast matrix (obligation 9; E11)

The baseline is green. “Measured” is an actual contrast; “read judgment” names the precise committed assertion expected to kill the proposed mutation and is not an executed mutation claim. Each new survivor has its own P1 finding. The old harness's eight historical mutants are not substituted for this refresh-window inventory.

| New mutant | Window | Evidence / verdict |
|---|---|---|
| R3_SKIP_RECORD_OP_MATCH: bypass only `mvctl.py:473` | Refresh | **Measured survivor**, 554 tests pass; exact mismatched command changes refusal to disk_stop. Finding 12. |
| R3_VCORE_STDERR_NO_CAP: `_STDERR_RAW_CAP=2**60` | Refresh | **Measured survivor**, 554 tests pass; real 1,048,577-byte stderr child changes refusal to acceptance. Finding 13. |
| R3_SKIP_RECORD_PREFLIGHT | Refresh | **Measured killed**, 1 failure among the 2 record tests; `test_disk_without_destination_refused_zero_bytes` observes client construction. |
| R3_SKIP_RECORD_EVENT_CHECK | Refresh | **Measured killed**, 6 failing subtests and 1 error among 2 record tests; unknown-key/path/hash/identity/refusal cases in `test_ram_start_stop_event_sequence`. Subtests are not counted as separate top-level tests. |
| R3_SKIP_SURFACE_ID_PATTERN | Refresh | **Measured killed**, 18 failing subtests in `test_frame_ref_surface_id_pattern_enforced`, covering both versions. |
| R3_UNSHARED_POLL_BUDGET | Refresh test/control | **Measured killed by the built-in negative control** under the stated load; second requested budget must shrink and over-budget terminal reply must not be admitted. |
| R3_SKIP_TERMINAL_BYTE_COUNT | Refresh | **Read judgment: killed** by `test_fx2_agents_b.py:test_t6r2_007_terminal_byte_count_cross_check`, matching and mismatching counts for write/data. |
| R3_SKIP_C2_RESPONSE_BINDING | Refresh | **Read judgment: killed** by `test_ag2_01_perceive_binds_c2_digest`; this does not cover the distinct pixels-vs-reference attack (02). |
| R3_ACCEPT_NESTED_DEPTH_2 in the raw/effective mirror | Refresh | **Read judgment: killed** by canonical structural equality in `PythonContractMirrorTests.test_every_canonical_schema_matches_python`. Add direct value-domain tests as well. |
| R3_DROP_64K_STRING_CEILING | Refresh | **Read judgment: killed** by `test_t6r2_005_utf8_byte_ceiling_enforced`, including multibyte cases. |
| R3_DROP_REQUEST_TIMEOUT_RAIL | Refresh | **Read judgment: killed** by `test_ag2_16_request_timeout_ms_bounded`; its invalid values must produce no writes. |
| R3_RESTORE_CONST_SELF_HEAL | Refresh | **Read judgment: killed** by the const-preservation probe in `test_ag2_06_raw_snapshot_has_no_v01_consts_and_no_rewrite`, regardless of whether the current mirror happens to need healing. |
| R3_ADMIT_SURFACE_INPUT_BODY | Refresh | **Read judgment: killed** by the explicit non-envelope split in round1/contract tests and raw mirror membership comparison. |
| D2_SKIP_NATIVE_SURFACE_CORRELATION / D2_SKIP_TICK_WINDOW | Day 2 | **Read judgment: killed** by `test_verify_v02_loop.py:test_tick_window_and_native_evidence_negative_controls`, respectively a different native surface and min_tick=3/max_tick=2 with zero dispatch. |
| D2_SKIP_WENDER_VERIFIED_ROOT_COMPARE | Day 2 | **Measured killed**, 2 failures / 554 tests, `test_w2_fx_agents.py:110,149`. The direct mismatched-root semantic probe also changes refusal to acceptance under the mutant. No finding. |

The harness's return rule now distinguishes a passing baseline from an unobserved mutation: any survivor triggers exit 1 (`run_mutant_harness.py:235-244`). A green baseline alone proves neither mutant sensitivity nor the new invariants. Process-local mutation scope is stated in Summary; no publication contains mutated product files.

### A7. Quantitative derivations and explicit statistical/combinatorial oracles (M1–M6)

The following derivations supplement A1–A6. Probability statements are conditional models, not measured production rates. Test inputs and commands are expanded in Tests proposed.

#### M1: deterministic retention, exact loss detection, and a conservative SPRT

##### Actual object under review

`client.py:453-456` inserts a deep copy keyed by proposal id and evicts `next(iter(...))` above 128 keys. `receipt()` at 469-471 returns a copy without deleting. This is a bounded insertion-order cache, **not** a queue with a service/dequeue process. Updating an existing key does not refresh its insertion order. Consequently stationary queueing probabilities cannot be attributed to it.

**[DERIVED] Cache theorem.** Starting empty, after N distinct received proposal ids with no other mutation, retained ids are exactly the last min(N,128) insertions and exactly max(0,N-128) ids have been evicted. Induction: insertion increases size by one; if the resulting size is 129, removing the first insertion restores 128 and advances the oldest retained id by one. Existing-key updates leave size and order unchanged. The retained-value count is bounded, but the retained byte count additionally depends on the configured per-envelope cap and Python object overhead.

**Deterministic oracle:** send distinct receipt ids `p000` through `p128` followed by a correlated tool reply. Assert size 128; `receipt('p000') is None`; `receipt('p001')` through `receipt('p128')` match their exact evidence; no receipt is claimed to be verified merely because it was cached. Repeat for N in `{0,1,127,128,129,256}`. To test order precisely, insert ids 0..127, update id 0, then insert 128; id 0 is still evicted by the current policy. This establishes documented behavior; treating evidence eviction itself as a new defect requires a separate no-loss requirement, not a stochastic inference.

##### Sampling loss, if an audit cannot enumerate

**[DERIVED]** After 129 distinct insertions, choose identifiers independently and uniformly with replacement from the 129 original ids. Exactly one is absent. The probability m probes all miss that loss is `(128/129)^m`; `m=592` gives approximately `0.00998145 < 0.01`. Checking the oldest id directly needs one probe and detects the loss with probability 1. A cache with no missing id has false-positive probability zero for an exact membership check. Independence belongs to fresh probe selection, not to the deterministic evictions.

##### Sequential loss test with explicit errors and sample bounds

**[DERIVED]** For independent Bernoulli loss indicators X_i, test H0: p<=p0=0.001 against H1: p>=p1=1/129. Let

`S_n = sum_i [X_i log(p1/p0) + (1-X_i) log((1-p1)/(1-p0))]`.

Stop at S_n>=log(100) and declare high loss, or S_n<=-log(100) and declare low loss. These conservative thresholds are deliberate: the familiar nominal Wald thresholds `(1-beta)/alpha` and `beta/(1-alpha)` should not be presented as exact error guarantees while ignoring boundary overshoot. Here alpha=beta=0.01 follow directly: under H0, exp(S_n) is a nonnegative supermartingale starting at 1; stopping at the upper boundary therefore has probability at most 1/100. Under H1 apply the same argument to exp(-S_n). The composite hypotheses hold because the one-step likelihood-ratio expectation is increasing in p and equals one at p0; its reciprocal behaves symmetrically at p1.

The two log increments are u=2.047942874620465 and d=-0.0067816401084714595. At p1 the positive drift is D1=0.009146456904931148; at p0 the negative drift magnitude is D0=0.004726915593742523. To bound expected samples without suppressing overshoot, use stopped sums at tau∧n. Independence gives `E[S_(tau∧n)] = D1 E[tau∧n]` under p1. At every stopped/unstopped value, `S_(tau∧n) <= log(100)+u`, hence monotone convergence gives `E1[tau] <= (log(100)+u)/D1 < 728`. Symmetrically `E0[tau] <= (log(100)-d)/D0 < 976`. These are rigorous expectation upper bounds for the stated independent model, not wall-time bounds and not guaranteed maximum sample counts. An imposed finite cap must yield INCONCLUSIVE, not an invented acceptance.

**Property oracle:** generate independent synthetic Bernoulli streams with p=0.001 and p=1/129, verify the exact update/threshold implementation, and distinguish simulated empirical errors from the mathematical alpha/beta bounds. For the actual 129-id cache, prefer the deterministic full enumeration above. A repeated Monte Carlo check cannot itself prove an asserted 1% error bound without another confidence calculation.

#### M2: flake-rate confidence and the limits of the dropped-test audit

**[DERIVED] One-sided Hoeffding bound with constants.** Let X_i∈[0,1] be independent with mean p (Bernoulli suite failures are the intended specialization). For a bounded variable, the second derivative of its log moment-generating function is a variance under an exponentially tilted distribution, at most 1/4 because its support remains [0,1]. Integrating twice yields `E exp(t(X_i-E X_i)) <= exp(t²/8)`. Independence and Markov's inequality give `P(mean(X)-p >= e) <= exp(-t N e + N t²/8)`; minimizing at t=4e gives `exp(-2 N e²)`. The lower tail is identical; the two-sided bound is twice that value.

With epsilon=0.01, delta=0.05, a zero-failure mean and the one-sided inequality require `N=ceil(log(1/delta)/(2 epsilon²))=14,979` independent full-suite runs. That is a valid, conservative certification target.

**[DERIVED] Exact zero-failure bound.** For iid Bernoulli failure probability p, the probability of N successes is `(1-p)^N`. To reject p>=epsilon after zero failures at error probability delta, choose `N=ceil(log(delta)/log(1-epsilon))`. At epsilon=0.01 and delta=0.05, **N=299**, since `0.99^299≈0.0495363`. Thus 299 independent, clean runs certify the rate only relative to the predeclared distribution of environment, order, and load. They do not prove there is no adversarial failing order. Repeating one deterministic order, reusing correlated interpreter state, or adaptively selecting favorable runs cannot claim this bound. No 299-run certification was performed in this review.

**Rerun-oracle proposal:** run the complete unittest suite in a fresh interpreter 299 times, with each test order independently selected from a fixed documented distribution and fresh temporary fixtures; record all return codes, stderr, and seeds; accept the statistical gate only if 299/299 pass. Include an injected failure with iid probability 0.01 as a negative control: the probability the gate misses it is at most 0.05. Also retain a deterministic mutant that adds stderr noise to the relevant surviving test; that must fail on every execution. A test removal is closed only if a named surviving test retains every relevant assertion; passing the suite once cannot establish that equivalence.

#### M3: deadlines, quantization, and process cleanup

`verify.py:35-42` forms one absolute deadline D and computes remaining milliseconds with ceil; 44-80 is a straight-line observe/plan/propose/wait path. `tools.py:751-807` recomputes each poll from one absolute deadline and caps sleep by the remaining time. `ToolClient.request` at 434-467 uses another absolute deadline whose allowance is min(previous transport timeout, requested milliseconds).

**[DERIVED] Arithmetic bound.** In exact real arithmetic, for r=D-now>0, q=ceil(1000r) satisfies `0 <= q/1000-r < 0.001 seconds`. For r<=0, q<=0 and remaining() raises. Recomputing from the same D prevents per-poll timeout replenishment. In a synchronous stage that honors its supplied timeout with scheduling/cleanup overhead J, that stage can finish at most `D+1 ms+J`; absolute recomputation prevents adding another whole original budget per poll.

This is not an unconditional end-to-end termination theorem. An injected planner may execute `sleep(A)` for arbitrary A, and perception is synchronous and owns its own timeout. Popen and the final unbounded process.wait() also have no Python-level worst-case real-time bound. `run_loop` detects elapsed time after the blocking call and before admitting later work, but cannot preempt it. A successful return has passed the final clock check; that does not bound scheduler delay between that check and the return instruction. At-most-once submission is proved syntactically: tools.propose occurs once in straight-line code, and no exception handler retries it.

**[DERIVED] Float caveat:** the strict <1 ms expression applies to exact arithmetic, with floating representation error added for Python floats. A concrete frozen-clock oracle with `time.monotonic()=4075.083964801264` and timeout 60000 yields `((t+60)-t)*1000=60000.00000000045`, so ceil is 60001. This is an exact counterexample to claiming remaining() is always <=60000. Normal syscall time may absorb this tiny error; do not inflate it into a production defect without impact evidence. A proposed fix can clamp to the original budget; a test should explicitly exercise this time value.

**Process time-to-kill:** the bounded pumps check elapsed time before each selector batch. Conditional on scheduling latency J and bounded batch work C, the kill call is reached no later than D+J+C. Wender processes at most stdin/stdout/stderr events in a batch; vcore at most two output events. Reaping uses wait() without a timeout, so no finite unconditional time-to-reaped bound follows. State the conditional bound and measure J/C under controlled load; do not present a platform-specific latency sample as a theorem.

**Oracles:** patched monotonic sequences that make r equal 1 ms, 0.0001 ms, 0, and -0.0001 ms should yield q=1,1,TimeoutError,TimeoutError respectively. Freeze the explicit float value above to test the upper rail. A planner that consumes all remaining time must cause zero proposals; a wait failure after admission must leave proposal count exactly one. For pending replies with retry_after_ms=3600000 and budget=100, the sleep argument is at most the ceil-quantized remaining 100 ms, followed by refusal rather than renewed 100 ms polling.

#### M4: queueing model, actual byte bounds, and backpressure

**[DERIVED] M/M/1/K under its own hypotheses.** In a continuous-time birth/death queue with independent Poisson arrivals rate lambda, independent exponential service rate mu, and total capacity K, detailed balance gives `pi_(n+1)=rho*pi_n`, rho=lambda/mu. Normalization gives `pi_K=(1-rho)rho^K/(1-rho^(K+1))` for rho!=1 and `1/(K+1)` for rho=1. Poisson arrivals see the stationary distribution, so this is the arrival rejection probability in that model. This last statement follows by independence of Poisson increments from the queue state immediately before arrival. For K=128 and rho=1 it is 1/129≈0.00775194; rho=0.5 gives approximately 1.46937e-39; rho=2 gives approximately 0.5. These values are model illustrations, not measured MetaViewer loss rates.

The receipt cache has neither deletion on read nor the model's exponential service, so the model does not apply. An adversary filling 129 distinct ids makes eviction deterministic (probability 1). After N>0 unique arrivals without consumption, the fraction discarded is max(0,N-128)/N. Output pipes likewise use a deterministic kill-on-overflow policy, not statistical drop probabilities.

**[DERIVED] Payload bounds:** Wender caps stdout at 1,048,576 bytes and stderr at 65,536. Its residual-cap+1 reads permit at most one excess byte before refusal; retained output bytearrays have aggregate length at most B_w+1 on overflow, B_w=1,114,112. Vcore's actual constants at `vcore.py:110-111` cap **each** of stdout and raw stderr at 1,048,576 bytes, so B_v=2,097,152; it does not use Wender's 64 KiB stderr cap. Vcore retains chunks only while their cumulative length is at most B_v; the currently read transient chunk is <=65,536, so stored output payload plus current transient payload is <=2,162,688 bytes before refusal. The final joins can add another B_v bytes of copies, yielding up to 4,194,304 bytes for retained chunks plus joined results. These are payload bounds, not RSS bounds: Python object overhead, request bytes, decoder allocations, and per-chunk list overhead are additional. Reading one byte per chunk can create O(B_v) Python objects even though payload bytes are bounded.

**Oracles:** for each output stream, emit cap-1, cap, cap+1 bytes. Cap and cap-1 do not fail solely because of the size bound; cap+1 must yield typed bad_shape and a reaped direct child. A syntactically invalid payload at exactly cap can still fail parsing. Exercise both pipes full together, stdin never read, EOF followed by a sleeping child, and kill paths; subprocess timeout and output-limit tests must check the saved child's pid has been reaped, not merely that a typed exception was raised.

**Optimization 1:** replace silent cache eviction with an explicit bounded overflow signal or pin the outstanding proposal id and refuse further unrelated receipt ingestion when capacity is full. For a burst of 256 unique receipts, the current retention drops 128; pinning one pending id eliminates loss of that one critical evidence item (1 item protected), and a bounded explicit-failure queue reduces silent loss to zero while retaining the same 128-entry cap. Blocking the shared socket without a separate receipt channel can deadlock waiting for a tool reply, so do not promise a lossless blocking implementation for free. Measure dropped-id count, pending-id retention, peak retained bytes, and p50/p99 request latency at bursts 128/129/256/1024.

**Optimization 2:** use a bounded contiguous accumulation strategy for vcore rather than retaining arbitrary numbers of tiny chunks. In the worst-case one-byte-read pattern, this reduces O(B) chunk object/list entries to O(1) buffers while retaining byte caps; payload-size saving is not the main benefit. Measure tracemalloc peak and object allocation count for one-byte writes through stdout/stderr, plus elapsed time and output equivalence at 1 KiB, 64 KiB, and exact cap. State observed bytes/milliseconds only after measuring.

#### M5: explicit pairwise designs with honest minimality

##### General bound, not an invented IPO theorem

**[DERIVED]** For k factors with v values each and interaction strength t, any covering array needs N>=v^t rows because a fixed set of t factors has v^t tuples and each row covers only one. A random uniform row misses a specified tuple with probability 1-v^-t. A union bound over C(k,t)v^t tuples proves existence when `C(k,t)v^t*(1-v^-t)^N < 1`. This is an existence upper bound and is generally not minimal. A greedy IPO-style extension can add columns and uncovered rows, but no exact IPO optimum was retrieved or is asserted.

##### mvctl: a proved minimal 12-row negative-test matrix

Define factors explicitly: command C has six values `observe,list,propose,wait-verify,record-start,record-stop`; five binary factors record presence of `--surface-id` S, `--proposal-id` P, `--json-arg` J, `--cursor` U, and `--limit` L. Required identity/cap flags are held valid and fixed. Invalid command/flag combinations are intentionally included: this is a parser/preflight negative-test matrix, not a valid-workflow-only matrix. Each command must appear with both values of every flag, requiring at least 2 rows per command and hence N>=12.

The following 12 rows attain this bound. Odd rows are each command's valid flag shape; even rows are its bitwise complement. Every flag pair sees 00,01,10,11, and every command×flag pair sees both values. Thus N=12 is proved minimal **for this declared factor model**. It does not cover all value classes, duplicate flags, option ordering, malformed JSON, or every valid cursor variant.

| Row | Command | S P J U L | Exact optional argv suffix | Shape expectation |
|---:|---|---|---|---|
|1|observe|1 0 0 0 0|`--surface-id s1`|dispatch observe once with a successful fake transport|
|2|observe|0 1 1 1 1|`--proposal-id p1 --json-arg proposal.json --cursor c1 --limit 1`|usage_error, rc=2, zero transport|
|3|list|0 0 0 0 1|`--limit 1`|dispatch list once|
|4|list|1 1 1 1 0|`--surface-id s1 --proposal-id p1 --json-arg proposal.json --cursor c1`|usage_error, rc=2, zero transport|
|5|propose|0 0 1 0 0|`--json-arg proposal.json`|dispatch propose once|
|6|propose|1 1 0 1 1|`--surface-id s1 --proposal-id p1 --cursor c1 --limit 1`|usage_error, rc=2, zero transport|
|7|wait-verify|0 1 1 0 0|`--proposal-id p1 --json-arg expectation.json`|dispatch wait_verify once|
|8|wait-verify|1 0 0 1 1|`--surface-id s1 --cursor c1 --limit 1`|usage_error, rc=2, zero transport|
|9|record-start|0 0 1 0 0|`--json-arg start.json`|dispatch record_start once|
|10|record-start|1 1 0 1 1|`--surface-id s1 --proposal-id p1 --cursor c1 --limit 1`|usage_error, rc=2, zero transport|
|11|record-stop|0 0 1 0 0|`--json-arg stop.json`|dispatch record_stop once|
|12|record-stop|1 1 0 1 1|`--surface-id s1 --proposal-id p1 --cursor c1 --limit 1`|usage_error, rc=2, zero transport|

Every row is `mvctl COMMAND --config core.json --socket SOCKET --session-id s1 --agent-instance a1 --core-instance c1 --timeout-ms 100 --max-line-bytes 65536 --max-reply-bytes 65536 SUFFIX`, where SOCKET is a temporary absolute AF_UNIX fixture path generated at runtime. Bind core.json and JSON files to the existing v0.2 fixture builders and inject exact successful replies; do not present example host paths as real endpoints. Record argv lists in the proposed unittest. A separate `list --limit 1 --cursor c1` case is needed to exercise the valid cursor path; it is deliberately not claimed covered by this minimal presence-pair design.

##### Record op×command matrix

**[DERIVED]** With actual op strings `{ram_start,disk_start,ram_stop,disk_stop}` and commands `{record-start,record-stop}`, pairwise coverage of these two factors is their full Cartesian product: exactly **N=8** rows, minimal because a row covers one of eight pairs. Four matching pairs must proceed to the correct verb; four cross-phase pairs must yield schema_error rc=2 before any socket activity. If mode is fixed to RAM, the restricted 2×2 phase matrix needs only N=4; do not call that the complete concrete-op matrix.

Use all eight ordered pairs `(record-start,ram_start)`, `(record-start,disk_start)`, `(record-start,ram_stop)`, `(record-start,disk_stop)`, `(record-stop,ram_start)`, `(record-stop,disk_start)`, `(record-stop,ram_stop)`, `(record-stop,disk_stop)`. Give disk_start a valid synthetic capability id/destination, then independently remove each destination field to test the preflight. Pairwise coverage cannot replace those value/boundary tests.

If the op factor includes every schema-valid `record_request` op, add `screenshot`, which is unsupported by both CLI commands. The full 5×2 matrix then has exactly **N=10**, including `(record-start,screenshot)` and `(record-stop,screenshot)` as typed pre-spawn refusals. N=8 explicitly refers only to the four supported recording operations, not all schema-valid record_request operations.

##### Resolver and surface-id enumeration

**[DERIVED] Resolver names.** `vision-engine` has length 13 and `wender-agent` 12. Enumerating all one-byte substitutions excluding the original byte yields `255*(13+12)=6,375` trials; appends yield `2*256=512`; prepends another 512. Enumerating every proper prefix including the empty prefix gives 25 per-name checks but 24 distinct strings, since only the empty prefix is shared. No one-byte mutation of either allowed name equals the other; the public resolver should reject every one of these trials with a typed error. A proper-prefix convention excluding empty instead gives 23 checks; state the convention.

**[DERIVED] Surface-id alphabet.** `observe.py:44,125-126` permits a first character in 62 ASCII letters/digits and subsequent characters in 66 characters (the first alphabet plus `. _ : -`), with length 1..128. For a valid L-byte ASCII id, one-byte substitution trials total 255L: `61+65(L-1)=65L-4` remain valid, and `194+190(L-1)=190L+4` are refused. For L<128, appends have 66 valid/190 refused and prepends 62 valid/194 refused. At L=128 every append/prepend is refused by length. Proper prefixes including empty give L trials: L-1 remain valid and the empty one is refused. Unlike exact component names, this language intentionally accepts many neighbors.

**Oracle:** for L in `{1,2,127,128}`, start from `'a'*L`, sweep character values 0..255 in every position, and assert the formula above against `_check_frame_ref` for both versions using an otherwise valid frame. Dot, dash, colon, and underscore are rejected **as the first character**, while `a.`, `a-`, `a:`, and `a_` are valid. Slash, space, newline, NUL, empty, and 129 characters are refused. A UTF-8 wire byte mutation above ASCII may additionally fail decoding before the schema; do not confuse that with a regex acceptance.

**[DERIVED] nested_depth:** the accepted typed domain is exactly Python ints `{0,1}`; bools must be excluded. Testing integer domain -2..3 plus `{False,True,0.0,1.0,'0','1',None}` is an exact finite boundary oracle. For the one-character decimal byte spellings `b'0'`,`b'1'`, 510 substitution trials contain two accepted cross-substitutions (0→1,1→0) and 508 rejected raw spellings; append/prepend counts depend on JSON number grammar, so a byte-level exact-name law should not be incorrectly applied to integer values. E.g. appending a space is legal JSON whitespace, not a new integer value; `01` is invalid JSON while `0` is valid. State the value-domain proof rather than inventing uniform string rejection.

#### M6: hash bounds and what they do not authenticate

**[DERIVED, ideal-hash assumption]** For q distinct messages hashed to independent uniform 256-bit values, the collision probability is `1-product_(i=0..q-1)(1-i/2^256)` and is at most `q(q-1)/2^257` by the union bound on message pairs. The birthday *work scale* is order 2^128; it is not a 2^-128 failure probability. At q=2^64 the upper bound is less than 2^-129; at q=2^128 the exact idealized collision probability is approximately 1-exp(-1/2), around 0.393.

For a single fixed trusted target hash and q independent fresh candidate messages, the second-preimage success probability is at most q/2^256. If an attacker can match any of L fixed trusted targets, a union bound is Lq/2^256 (overlap can only reduce it). For example q=2^64 and L=1 gives 2^-192; L=2^20 gives 2^-172. These are ideal-model bounds, not a proof that SHA-256 outputs are independent random variables, nor a claim that an unkeyed digest authenticates an untrusted producer.

The frame-binding check must compare a computed digest against a digest obtained through a trusted binding. If an attacker can replace both bytes and the expected digest, no collision search is required. A hash chain needs a trusted head/anchor and unambiguous encoding to provide the usual tamper-evidence argument; the agents sequence file is plain canonical decimal digits, not such a hash chain. Its filename hash separates registration scopes but does not authenticate its stored sequence.

`compute_battery_state_sha256` at `observe.py:292-318` first replaces every node.box by None. Thus geometry-only changes produce equal canonical messages and equal digests **with probability 1** by design; this is not a cryptographic collision. Nongeometry canonical changes are the relevant collision/second-preimage domain. The source docstring already says this digest is not the core state witness and does not promise native-encoder agreement without a golden fixture/safe-integer domain.

**Oracles:** hash a synthetic frame, flip each of its first 256 bits one at a time while retaining the trusted original digest, and assert identity_mismatch before spawn; change C2-reported digest and assert refusal; alter a nongeometry state field and compare the exact expected digest; alter only node.box and assert equality intentionally. Changing the plaintext sequence file from canonical `7` to canonical `8` must not be described as a SHA-256 tamper test. These tests establish the actual comparison/projection behavior, not empirical cryptographic probabilities.


## Tests proposed

These are follow-up test specifications, not files added by this report. Every current-source counterexample is distinguished from a proposed regression assertion. Use a fresh interpreter for each mutation experiment: some existing registry tests retain state if a suite is rerun in the same interpreter. Proposed method names below belong to a new `agents/tests/test_round3_review_regressions.py`, class `Round3ReviewTests`; they are not claimed to exist already.

Run any row with the complete command:

```bash
PYTHONPATH=agents:agents/tests python3 -m unittest test_round3_review_regressions.Round3ReviewTests.METHOD -v
```

Replace `METHOD` with the exact method name in the table. Run the whole proposed module with `PYTHONPATH=agents:agents/tests python3 -m unittest test_round3_review_regressions -v`, and retain the baseline gate `python3 -m unittest discover -s agents/tests`. All paths for sockets, checkouts, config and outputs are generated by `TemporaryDirectory`; there are no machine-specific paths or private checkouts in these fixtures. Lowercase IDs/digests in the following fixtures are synthetic data.

| Finding / proposed METHOD | Exact inputs and setup | Required result / negative control |
|---|---|---|
| 01 `test_record_events_over_real_tool_client` | Existing `test_mvctl_v02.MvctlV02Tests.core` and `.client`; start `surf-1/rec-1`, RAM ring 4096, timeout 1000; `_event(call,'started',mono_ns=1,mode='ram')`. Separate stop with `_event(call,'stopped',mono_ns=1,frame_count=0,byte_count=0)`. | Each real codec/socket call returns its event. Wrong request/surface/recording ID still refuses. Assert exact request count and no invented op in replies. Current source fails both positive cases. |
| 02 `test_pixels_bound_before_perception` | `A=bytes([0,0,0])`, `B=bytes([1,2,3])`, Frame dimensions 1x1, reference surface `A`, generation 1, tick/stamp/capture 0, format rgb24, valid RAM path, hash H(A). Pass Frame(1,1,B) to VCore and Meta Muse. Honest C2 emits H(B), dimensions 1x1, changed null, regions [], crop `{x:0,y:0,w:1,h:1,reason:'salient'}`, timing_us 1. | Refuse identity mismatch before vision use, ideally before engine spawn. Matching A/A passes and a mismatching C2 response still refuses. Repeat via a RAM file whose bytes change from A to B while reference A is retained. |
| 03 `test_verified_receipt_surface_and_hash_binding` | Existing valid observation/receipt fixtures; observe `surf-1`, proposal `p-1`, action wait 1 ms, expectation text_present `done`. First vary only outer frame_sha256 to `'b'*64`; second make internally consistent reply hashes but after_frame.surface_id `surf-B`. Serialize each reply through `make_envelope`. | Both refuse with ToolValidationError and at most one propose. Matching surface/hash control returns verified. Unknown native field and native-only surface mismatch remain separate controls. |
| 04 `test_fifo_frame_refused_before_spawn` | Fresh `/dev/shm` temporary directory; `mkfifo` at `frame.rgb`; valid one-pixel reference; VCore timeout 0.01; helper announces READY before perceive; no writer. Use an engine marker and a 0.3-second external watchdog only to prevent hanging the test harness. | Typed non-regular-frame refusal and no engine marker. Repeat with writer holding FIFO open but sending only two of three RGB bytes. Current code blocks; clean up/reap the helper even on assertion failure. A regular three-byte file is the positive control. |
| 05 `test_pinned_checkout_checks_hidden_tracked_bytes` | Git fixture commits `tracked.py` bytes `b'print(1)\n'`; actual full commit in lock; separately set assume-unchanged and skip-worktree; replace with `b'print(2)\n'`; use `MV_WENDER_ROOT` pointing to that fixture. | dirty_tree, no returned root. Clear flags and restore exact bytes for the positive control; retain intentional untracked-file acceptance. |
| 06 `test_timeout_values_are_backend_representable` | CoreClient timeout_s `1e300`; Wender timeout `10**400`; each adapter timeout `1e20`; valid roots/argv otherwise. Spy on connection and Popen. Include normal finite 0.05/1 and existing request-ms boundary values. | Declared typed/configuration refusal before effects for impossible durations; no OverflowError and no child spawn. Keep request 1/60000 accepted and 0/60001/bool/string/float refused. |
| 07 `test_vcore_invalid_json_and_argv_are_typed` | Otherwise valid C2 with crop.reason `[]`; `run_vcore('selftest',[chr(0)])`; marks path with final chr(0); raw `b'{"x":'+b'['*100000+b'0'+b']'*100000+b'}'` (200,007 bytes). | PerceptionError with an appropriate closed code; invalid argv/path rejected before Popen, parser nesting refused before recursion escapes. Correct reason/ordinary argv/valid shallow response controls pass. |
| 08 `test_wender_surrogate_inputs_are_typed` | Call `validate_state` on existing `test_wender_bridge.reply()['state']` with only source.title changed to chr(0xd800); separately call plan_step with valid observation/table and goal chr(0xd800); then have a real planner return the malformed STATE. | ObservationError bad_shape. Direct state validation has no spawn; invalid goal must cause no Popen; returned STATE must refuse before publishing the battery digest, after the child has run and been reaped. Ordinary accented and astral Unicode scalar strings pass encoding. |
| 09 `test_builders_validate_before_deepcopy` | Body with an unknown property containing 2000 nested lists; valid frame plus an unknown property containing 1200 nested dictionaries. Hold nonce/ts explicitly valid for the envelope case. | EnvelopeError/ObservationError before copying irrelevant subtree; no raw RecursionError. Valid inputs still deep-copy and remain isolated after caller mutation. |
| 10 `test_partial_sequence_reservation_cannot_roll_back` | Temporary regular file initially b'9'; active.next_seq=9. Wrapped os.write performs the real write of `data[:1]`, returns 1, while intended data is b'10'. Then exercise next-open validation. | Reservation fails and subsequent entry cannot accept a sequence below the pre-reservation next sequence, or fails closed. Repeat at transitions 9→10, 99→100 and 999→1000 with nonzero partial writes 1..len(data)-1 and fsync/truncate exceptions. A proven zero-byte write with no send may safely retain the original unused sequence. No socket send occurs. |
| 11 `test_cli_preserves_failure_categories` | Complete common argv/config from existing fixture; valid config JSON `{}`, `{"peers":[]}`, `{"peers":[null]}`, and valid config with session `'wrong'`; then valid core errors PROTOCOL/UNAVAILABLE/NOT_FOUND/VERIFICATION_FAILED for each reachable verb. | Local shape/session errors: rc 2/usage_error, fixed stderr, empty stdout, no client. Operational errors retain their distinct kind and fixed diagnostics; verification failure rc 1 is preserved. Assert no reflected fixture/config text. |
| 12 `test_record_command_operation_matrix` | All eight ordered pairs of commands record-start/record-stop and ops ram_start/disk_start/ram_stop/disk_stop; request ID rq-1, surface surf-1, recording rec-1; RAM ring 4096/FPS 30; disk valid synthetic capability and a generated absolute destination. Add both screenshot pairs. | Four matching recording pairs dispatch the intended op; four cross-phase pairs and both screenshot pairs refuse schema_error before ToolClient. The guard-removal mutant must turn the suite red. |
| 13 `test_real_stderr_cap_and_reaping` | Real child outputs `{}` to stdout, returns 0, writes stderr counts `2**20-1`, `2**20`, `2**20+1`; timeout 2; save Popen child object. Repeat mixed stdout/stderr floods. | First two do not fail solely on stderr size; last gives PerceptionError bad_shape and child reaped (`waitpid` raises). Raising cap to 2**60 must fail the oversized assertion. |
| 14 `test_observation_output_roundtrips_wire_rails` | For each frame generation/tick/ts_ns/capture_us, set K then K+1 with trusted generation adjusted when needed. For each version use valid summary lengths 65536/65537, emoji 16384/16385 and chr(0xd800); separate plugin summary 4096/4097 cases. | Builder either returns a value the corresponding envelope accepts or raises ObservationError. Preserve declared standalone-versus-inline widths; never “fix” parity by silently accepting an invalid wire value. |

The recording failure can be independently reproduced today using only already-committed helpers (current source raises on the start case; run each tuple separately to inspect both):

```bash
PYTHONPATH=agents:agents/tests python3 - <<'PY'
from test_mvctl_v02 import MvctlV02Tests
from test_record import _event
from metaviewer_agents import tools
case = MvctlV02Tests()
for command, event, fields in [
    ('record_start', 'started', {'mode':'ram'}),
    ('record_stop', 'stopped', {'frame_count':0,'byte_count':0}),
]:
    with case.core([[lambda call: _event(call,event,mono_ns=1,**fields)]]) as (path,calls):
        with case.client(path) as client:
            if command == 'record_start':
                result = tools.record_start('surf-1','rec-1',ring_bytes=4096,
                                            client=client,timeout_ms=1000)
            else:
                result = tools.record_stop('surf-1','rec-1',client=client,timeout_ms=1000)
            assert result['event'] == event
PY
```

### Additional property/oracle tests

Put these in a proposed `agents/tests/test_round3_math_bounds.py`; command: `PYTHONPATH=agents:agents/tests python3 -m unittest test_round3_math_bounds -v`. Each row defines its input domain and exact oracle, not a claim that the new test module was committed or executed.

| Property | Explicit parameters and expected result |
|---|---|
| Framing/id/fallback | Caps 82/83/206/207/2**20; line lengths C-1/C/C+1; first LF at indices C-2/C-1/C; no LF; two coalesced frames. Enforce C+1 read-decision bound, reject tail after framing failure, every written frame <=C. IDs: ASCII 126/127/128/129, é 21/22, ±K/±(K+1), True. |
| Decoder/terminal | Levels 32/33, widths 10000/100000, duplicate key, trailing LF inside patterned string, UTF-8/surrogate/safe-int cases in A1. Base64 byte lengths 0..256 plus the 4096 two-symbol padded spellings; decoded count exactly equals strict decoder length. Mismatch each count by 1 must refuse. |
| Surface and RAM allowlists | Both frame versions; IDs `'a'*L` for L=1,2,127,128, each single-byte neighbor 0..255. Compare accepted/refused counts to M5; include empty/129. Path lengths 255/256 and segments 8/9 use valid segment characters, so only the intended rail changes. |
| Depth/mirror/non-envelope | nested_depth list `[-2,-1,0,1,2,3,False,True,0.0,1.0,'0','1',None]` with types preserved: only integer 0/1 pass. Copy const/ref probe, foreign versions, mixed nested v0.1/v0.2 and source-valid surface_input body: expected const unchanged and unknown_version for non-envelope wrap. |
| Session clock | Same clock callable returns `[100,100+K,101+K,50]`: stamps `[0,K,0,0]`; function swap rebases; explicit K+1 refuses. Do not assert monotonicity across rebases. |
| Loop deadline/single submit | Virtual clock gives positive remainders 1 ms / 0.0001 ms then 0/negative; outcomes 1/1/TimeoutError/TimeoutError in exact arithmetic. Use frozen 4075.083964801264 with T=60000 to expose ceil 60001. Planner error/stale frame/refused proposal/verification timeout: propose count 0 or 1 as specified, never 2. |
| Shared stop budget target | Virtual time starts 0; each fake reply advances 0.040; timeout 50, replies dropped/dropped/stopped. Proposed overall-deadline behavior gives second request <=10 ms and times out before third; current repeated 50 ms allowances document the policy difference. |
| Receipt retention | N=0,1,127,128,129,256 distinct valid asynchronous receipts then a correlated tool reply; expect retained min(N,128), evicted max(0,N-128), oldest-update does not refresh order. Directly audit oldest; alternative independent uniform 129-id audit m=592 misses one absent ID with probability<.01 under the stated sampling model. |
| Sequential-loss test | Independent Bernoulli streams p0=.001,p1=1/129, thresholds ±ln100, alpha=beta=.01; verify exact log-likelihood increments and stop rule. A finite experiment cap returns inconclusive; empirical simulation does not replace the mathematical error proof. |
| Flake-rate target | Fresh independent full-suite runs N=299, epsilon=.01, delta=.05, predeclared order/load distribution; require 299/299 passes. Injected independent 1% failure is missed with probability<=.05. No 299-run certification was attempted here. |
| Hash/intentional projection | Frame(12,1,bytes(36)); flip each of bits 0..255 and retain original trusted digest: mismatch before spawn. For canonical state, alter a nongeometry field and compare independently computed hash; alter only box and require equal geometry-free hash. Do not assign SHA-256 guarantees to plaintext sequence edits. |
| Process caps/cleanup | Wender stdout 1 MiB, stderr 64 KiB; VCore each 1 MiB. Use cap-1/cap/cap+1, both pipes active, stdin undrained, EOF then sleeping child; assert typed refusal plus direct-child reap. Treat measured latency separately from a theorem. |

### Planner argv interaction sweep

In addition to the minimal twelve-row CLI matrix and eight/ten-row record matrix in M5, define three planner configuration factors: four exact hostile *argument strings* A, environment-extra presence B in `{0,1}`, and resolved-root alias selection C in `{0,1}`. A is one of `'; touch SENTINEL'`, `'$(touch SENTINEL)'`, '`touch SENTINEL`', `'x && touch SENTINEL'`. These are passed as one data argument to a fixed benign Python planner fixture; they are never executed by the test harness as shell text. B sets `REVIEW_EXTRA_ENV='fixture'` or omits it. C chooses the real temporary engine root or a symlink resolving to that same root.

Use these **eight rows [DERIVED]**: `(A0,0,0),(A0,1,1),(A1,0,1),(A1,1,0),(A2,0,0),(A2,1,1),(A3,0,1),(A3,1,0)`. Every A×B and A×C pair occurs, and both parities give all four B×C pairs. At least `4*2=8` rows are required by A×B, so eight is minimal for this declared factor model. Each case must deliver the exact string in argv, omit the extra environment key, use the same resolved cwd, produce one valid planner response, and leave SENTINEL absent. This tests transport/confinement; it does not pretend that a host-configured explicit shell binary is forbidden.

Add value-boundary negatives outside the pairwise design: configured command JSON string instead of array, empty array, non-string member, empty member, NUL member, malformed JSON; `run_loop` must yield ObservationError bad_shape before resolver/spawn/propose. A JSON argv containing ordinary punctuation remains data and may pass. Proposed command: `PYTHONPATH=agents:agents/tests python3 -m unittest test_round3_review_regressions.Round3ReviewTests.test_planner_argv_pairwise -v`. Pairwise coverage cannot substitute for these single-boundary and root-mismatch assertions.

## Optimizations

These proposals are targets, not changes made by the report. Expected gains are derived in concrete work/space units; no unmeasured throughput percentage is asserted.

| Proposal | Expected gain and tradeoff | Exact measurement procedure |
|---|---|---|
| Make receipt overflow explicit, or pin the outstanding proposal's evidence | [DERIVED] For 256 distinct receipts the current cache evicts 128. Pinning the active proposal can protect that one critical evidence item; explicit bounded overflow eliminates silent loss while retaining 128 entries. A lossless blocking queue on the same socket can deadlock behind the awaited tool reply, so it requires protocol/stream design rather than just blocking reads. | Bursts 128/129/256/1024, including active ID first/last/updated. Count dropped IDs, active-evidence retention, peak retained bytes and p50/p99 request latency. Require a documented typed outcome at overflow; compare with the exact retention oracle. |
| Validate root shape/depth/scalars before deep-copying malformed builder input | [DERIVED] An immediately unknown root field holding N nodes can be refused without copying those N nodes. This removes the demonstrated 1200/2000-level recursion escape and avoids O(N) copy work on that rejection path. Preserve copying for valid inputs. | `perf_counter_ns` and `tracemalloc` at chain depths 32/100/1200/2000 and flat widths 10000/100000. Compare exception type, peak bytes, copy-spy calls and unchanged valid-input isolation. The measured width costs in A1 are a baseline, not a forecast of a specific speedup. |
| Add a sound pre-parse object-member rail | [DERIVED] At a declared global object cap 256, recognizing the 257th key can avoid materializing the rest of a 100000-member hostile object. It does not eliminate byte acquisition/scanning, and arrays have distinct allowed limits up to 4096 in the current mirror. Requires a string/escape-aware scanner with semantic parity. | Reuse exact 89,412/989,412-byte inputs from A1, plus quoted commas/braces, duplicate keys and nested valid arrays. Measure parse allocations and rejection position; differential-test against the independent checker before using the rail. |
| Use fewer accumulated chunk objects in VCore | [DERIVED] Worst-case one-byte reads can retain up to 2,097,152 positive chunks across the two 1 MiB streams. Two bounded accumulators reduce that metadata count to O(1) buffers; final immutable/output decoding copies still need accounting. Payload caps must remain unchanged. | Inject read sizes 1/16/4096/65536 with equal output bytes and use real-child small-chunk controls. Record tracemalloc peak, chunk-object/list-entry count and elapsed time at 1 KiB/64 KiB/1 MiB per stream. Require identical parsed result, overflow refusal and cleanup. |
| Give record_stop one declared overall budget and avoid repeated stop commands if the protocol supports a correlated stream | [DERIVED] At 256 events and T=60000, nominal transport allowance can fall from 15,360,000 ms to 60,000 ms, saving 15,300,000 ms of allowed waiting, plus overhead differences. A single stop followed by stream receives could save 255 stop requests and sequence reservations/fsyncs. Native stream semantics must be verified before changing that protocol. | Virtual-clock 50 ms budget / 40 ms per event fixture first; then real socket event batches 1/2/256, track each requested budget, request ID, stop count and sequence reservation. Report physical monotonic time separately. Preserve refusal on uncorrelated/unsupported events and verify no duplicate native stop side effects. |
| Preflight remaining operation budget and pixel identity before subprocess launch | [DERIVED] Every already-expired or A/B-mismatched call can save one child spawn, all of its pipe/parse work and its entire otherwise-allowed subprocess interval. The expected millisecond saving is the measured spawn-plus-work cost for that fixture, not a fabricated universal constant. | Cases matching pixels, mismatching pixels, deadline expired before serialization, and expiration during preparation. Count Popen calls, digest comparisons and elapsed/peak memory. Required negative cases: zero spawns, typed refusal, no stored state digest. |

The decoder, receipt, root and recording correctness fixes should precede performance tuning. Optimization tests must compare semantic outcomes and negative controls, so a faster refusal caused by rejecting legitimate input is not counted as a gain.

## Not verified

- **No live capsule, real private vision-engine/wender-agent checkout, native recorder, or Rust-core T8 execution.** The public pinned source, synthetic Git/engine/socket fixtures and Python suites were reviewed/run. `tests/integration/test_mvctl_core.py` was read as a cross-topic integration surface; no product code in that lane was changed. Capability-to-destination containment, native human-origin admission, native clock sampling and Go process cleanup remain their owners' responsibility.
- **The requested pair of consecutive G-AI run artifacts was not available.** The task states that two verified runs exist. The retrieved [CHANGELOG.md:5](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/CHANGELOG.md#L5) records a G-AI pass, and [docs/TESTING.md:80](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/docs/TESTING.md#L80) describes its assertions. [docs/ARCHITECTURE.md:475](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/docs/ARCHITECTURE.md#L475) describes two consecutive **G-W1** live-slice runs, which must not be relabelled G-AI. Identifiers/raw receipts for the two G-AI runs: **ABSENT — do not invent**. The live gate was not rerun, as requested.
- **No applicable external theorem extraction for the six mathematical searches.** Context7 was used with every exact requested phrase, but its returned papers did not establish the requested theorems. Every quantitative result used for this review is explicitly derived and conditional; no invented paper ID, theorem or anchor is used as support.
- **No statistical certification of flake freedom or arbitrary test-order immunity.** One immutable full-suite baseline, the stated fresh-interpreter mutant experiments, and the targeted loaded timeout suite were executed. Neither 299 independent full-suite runs nor the conservative 14,979-run Hoeffding target was executed. U3-AG-07's closure is assertion preservation, not a probability claim.
- **No portable finite end-to-end latency, peak-RSS, descendant-containment or atomic-physical-write guarantee.** Synchronous user callbacks, RAM-file acquisition, Popen, fsync, scheduler service and final wait require assumptions beyond the bounded pipe loops. Byte/payload bounds and measured tracemalloc values are not hard RSS limits. Owner-only socket/pin/argv checks do not make trusted subprocess configuration an OS sandbox.
- **No cross-language canonical-hash proof or unkeyed-hash authenticity claim.** The battery digest intentionally strips geometry; native canonicalization requires its own golden fixtures and safe-number domain. The sequence file has no hash chain. The SHA-256 probability bounds assume an ideal hash and a trusted target/anchor.
- **Hosted evidence is limited to retrieved run results for the pinned source.** A completed successful CI run is linked in Summary; concurrent unfinished runs were not relabelled successful. Branch-protection enforcement, a red shard blocking main and the full external tokenizer/router-kit gate were not independently demonstrated. The report-only publication is not a claim that the newly proposed regression tests have landed or that a future report-commit workflow has already completed.

All findings are scoped to the reviewed SHA. Fixed guards are marked fixed, known intentional API/version distinctions are preserved, and a missing external artifact is reported as missing rather than supplied with invented evidence.


## Machine block

```json findings

[
  {
    "id": "T3R3-01",
    "severity": "P0",
    "file": "agents/metaviewer_agents/client.py",
    "line": 458,
    "title": "Production ToolClient rejects every valid recording event",
    "evidence": "client.py:458-461 requires reply.op == request.op. record_event has event and forbids op. Real socket reproductions fail for both delivered record verbs; test_record substitutes a fake transport.",
    "fix": "Select correlation by reply family; keep mv_tool_result op correlation and validate record_event request_id/surface_id/recording_id/event without inventing an op field."
  },
  {
    "id": "T3R3-02",
    "severity": "P1",
    "file": "agents/metaviewer_agents/perception/vcore.py",
    "line": 687,
    "title": "Perception can relabel B pixels with the trusted A frame digest",
    "evidence": "vcore.py:685-691 hashes supplied or RAM-loaded pixels, :749 compares C2 against that hash, and :625-627 projects the caller reference hash. No comparison binds those pixels to frame_ref.sha256. meta_muse.py:102-106,175-185 has the same input binding gap. Executed with an honest PNG-decoding subprocess.",
    "fix": "Compare the computed pixel digest to the trusted frame_ref digest before transport and preserve that binding through normalization and element projection."
  },
  {
    "id": "T3R3-03",
    "severity": "P1",
    "file": "agents/metaviewer_agents/tools.py",
    "line": 774,
    "title": "Verified result is not bound to the observed surface or outer frame digest",
    "evidence": "tools.py:774-782 checks proposal_id, focus and digest syntax but not outer digest equality; verify.py:79-81 does not correlate returned after_frame to the observed surface. Every response in the executed counterexample passed make_envelope.",
    "fix": "Bind receipt.after_frame.surface_id to the submitted/observed surface and result.frame_sha256 to receipt.after_frame.sha256 before returning verification."
  },
  {
    "id": "T3R3-04",
    "severity": "P1",
    "file": "agents/metaviewer_agents/perception/vcore.py",
    "line": 343,
    "title": "RAM frame acquisition can block before the subprocess deadline",
    "evidence": "vcore.py:337-353 uses blocking O_RDONLY and reads without a regular-file check; :685-686 calls it before the subprocess deadline. A temporary FIFO helper remained blocked after a 300 ms external deadline; see annex for the precise executed fixture.",
    "fix": "Open nonblocking, verify the opened descriptor is a regular file of expected size, and share an absolute deadline across acquisition, hashing, encoding and subprocess work."
  },
  {
    "id": "T3R3-05",
    "severity": "P1",
    "file": "agents/metaviewer_agents/perception/deps_lock.py",
    "line": 133,
    "title": "Git index suppression flags hide changed tracked dependency bytes",
    "evidence": "deps_lock.py:133-138 equates HEAD equality plus empty porcelain status with tracked-byte integrity. A real Git fixture demonstrates changed tracked bytes hidden by assume-unchanged. This requires mutable local checkout/index state.",
    "fix": "Reject assume-unchanged/skip-worktree suppression and independently verify tracked contents/modes against the pinned tree, preferably using an immutable checkout."
  },
  {
    "id": "T3R3-06",
    "severity": "P1",
    "file": "agents/metaviewer_agents/client.py",
    "line": 209,
    "title": "Finite timeout checks do not establish platform representability",
    "evidence": "client.py:72-79 accepts finite 1e300 and :209 raises raw OverflowError. wender_bridge.py:203 converts huge integers implicitly; :133 and vcore.py:521 overflow for finite 1e20 after spawn. The specific ToolClient.request 1..60000 rail remains correct.",
    "fix": "Guard conversion and enforce representable, documented timeout bounds before effects; translate backend overflow to the closed error type."
  },
  {
    "id": "T3R3-07",
    "severity": "P1",
    "file": "agents/metaviewer_agents/perception/vcore.py",
    "line": 426,
    "title": "VCore malformed response and path inputs escape the typed boundary",
    "evidence": "vcore.py:426 hashes an unchecked reason; :770-783 permits a NUL argument; :247-249 catches only OSError; :369-374 does not catch RecursionError. The nested response is below the existing 1 MiB cap. Counterexamples executed.",
    "fix": "Type-check before membership, reject NUL before path/argv use, pre-scan response nesting, and translate decoding/encoding/path exceptions to PerceptionError."
  },
  {
    "id": "T3R3-08",
    "severity": "P1",
    "file": "agents/metaviewer_agents/wender_bridge.py",
    "line": 241,
    "title": "Wender accepts surrogate strings until raw UTF-8 encoding fails",
    "evidence": "wender_bridge.py:239-241 accepts any str goal; observe.py:268 accepts any str as canonical, then :289 UTF-8 encoding fails. Both exact inputs were executed without product changes. Direct validate_state has no spawn; response STATE is validated after the planner has run.",
    "fix": "Validate Unicode scalar strings throughout goals/state before encoding, with a typed encoding failure and unchanged digest state."
  },
  {
    "id": "T3R3-09",
    "severity": "P1",
    "file": "agents/metaviewer_agents/envelope.py",
    "line": 842,
    "title": "Builders deep-copy hostile subtrees before bounded validation",
    "evidence": "envelope.py:842 and observe.py:252-261 copy before structural/depth checks. The wire decoder has a 32-container pre-parse cap, but these public builder paths bypass it. Both direct API counterexamples were executed.",
    "fix": "Check exact keys, scalar validity and bounded depth before copying; map copy/recursion failures to the closed error class while preserving valid-input isolation."
  },
  {
    "id": "T3R3-10",
    "severity": "P1",
    "file": "agents/metaviewer_agents/client.py",
    "line": 374,
    "title": "A partial sequence reservation can leave a canonical earlier sequence",
    "evidence": "client.py:370-377 overwrites in place before checking the write length. Executed fault injection performs the real one-byte write; :399-402 accepts the resulting lower decimal state. No malicious filesystem change or hash collision is needed.",
    "fix": "Use a crash/partial-write-safe sequence record with integrity checking and atomic publication under a stable lock; never allow a partial update to become an earlier valid reservation."
  },
  {
    "id": "T3R3-11",
    "severity": "P1",
    "file": "agents/metaviewer_agents/tools.py",
    "line": 598,
    "title": "Operational core failures and malformed registrations lose their truthful category",
    "evidence": "tools.py:596-598 funnels valid core errors into ToolValidationError; mvctl.py:491-495 and :545-551 conflate local shape/lookup faults with transport or schema faults. Exact outcomes were measured with committed config and transport fixtures.",
    "fix": "Validate registration shape at a dedicated local boundary; represent operational core errors separately from schema-validation errors and retain their machine-readable cause."
  },
  {
    "id": "T3R3-12",
    "severity": "P1",
    "file": "agents/tests/test_record.py",
    "line": 72,
    "title": "The record command-operation guard has a surviving test mutant",
    "evidence": "Fresh full-suite experiment: 554 tests, zero failures/errors/skips; mutation still active afterward. The current production guard is correct. Existing tests do not cover mismatched command/op. Spawned fresh CLI interpreters retain original source; see mutation scope note.",
    "fix": "Add the full 2 commands x 4 supported operations matrix, with four mismatches refused before ToolClient; include both unsupported screenshot cases for the 5-operation matrix."
  },
  {
    "id": "T3R3-13",
    "severity": "P1",
    "file": "agents/tests/test_fx2_agents_a.py",
    "line": 131,
    "title": "VCore raw stderr size limit has a surviving test mutant",
    "evidence": "Fresh full-suite experiment and physical non-equivalence probe. Current stdout flooding is covered; test_exit_2_stderr_truncated mocks subprocess.run and checks only display truncation. VCore raw stderr cap is 1 MiB, not Wender's 64 KiB.",
    "fix": "Test actual children at stderr cap-1/cap/cap+1, concurrent stdout/stderr floods and reaping; do not substitute a mocked completed process for the bounded pump."
  },
  {
    "id": "T3R3-14",
    "severity": "P2",
    "file": "agents/metaviewer_agents/observe.py",
    "line": 128,
    "title": "Standalone observation builder can return values rejected by its wire codec",
    "evidence": "observe.py:128-141 checks only lower bounds for stamps/counters; :159-180 omits scalar/byte rails for summary/name. envelope.py:744-752 enforces them. Production ToolClient remains fail-closed, so this is API consistency, not an accepted malformed wire frame.",
    "fix": "Share the wire-safe integer and Unicode/UTF-8 validators with standalone observation construction, preserving explicit differences between standalone and inline tool-result schemas."
  }
]

```

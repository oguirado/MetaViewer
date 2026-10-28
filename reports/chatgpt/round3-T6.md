Reviewed: bridge/integration @ ae9361bb3d645eee1976ec8d739dc358b572561b

# Summary

Topic: contracts. This is a static mathematical and adversarial review of the pinned [source snapshot](https://github.com/oguirado/MetaViewer/tree/ae9361bb3d645eee1976ec8d739dc358b572561b). No repository code, build, test, live process, or mutant was executed. “Actual” below means the result deduced from the cited implementation, not an observed test run. FIXED means the inspected implementation and its stated test assertions cover the particular claim; it does not certify a passing run.

The reviewed head is ahead of the requested minimum 4f4c984c by 22 commits [CITED: GitHub compare]. It includes later human-origin and journal-shutdown changes, so the prompt's older line numbers and backlog assertions were not treated as current evidence. All source coordinates below refer to the full SHA on the first line. The owned delivery is this report only; its dependency closure is the named contracts, their validators, producers, consumers, and test oracles. No product or generated router files are changed.

The connector tree and all fixture files were read: **21 schemas; 488 v0.2 JSON fixtures = 21 base valid + 373 named valid + 94 invalid = 394 valid + 94 invalid** [CITED: pinned contracts/v0.2 and contracts/examples/v0.2 trees]. The three additional fixtures beyond the brief are the two valid origin variants and the invalid origin variant of surface_request. The envelope still has 19 body alternatives; surface_input is the standalone schema outside that union [CITED: contracts/v0.2/envelope.schema.json:92; contracts/v0.2/surface_request.schema.json:223; tests/test_python_contract_mirror.py:75].

**Findings: 17 — P0: 1; P1: 7; P2: 9** [DERIVED: count of the Findings table and machine block]. Six findings concern concrete conformance differences, including one synthetic supported-schema case; three concern state/resource guarantees; six concern oracle coverage or interpretation; two concern refusal classification. The recording CLI's production reply path is the P0 because it blocks that end-to-end slice. The current source does not support a blanket “all five oracles agree” certification.

The 28 requested commit targets receive **17 FIXED / 11 PARTIAL / 0 NOT FIXED** rulings; the overlapping 15 section-5 claimed-fix rows receive **5 FIXED / 10 PARTIAL / 0 NOT FIXED** [DERIVED: tables below; do not add these overlapping totals]. Of the ten named still-open probes, four are closed or not live in the reviewed scope, and six remain partial or confirmed. In particular, R1-088 is now fixed; no internal production caller relies on build_observation's v0.1 default. D2-OPEN-03's reachable reference-normalization hole remains, and D2-OPEN-04's routine-gate omission remains.

## Context7 retrieval record

The math-router llms.txt was read first. All six requested queries were then sent verbatim to /oguirado/math-router. Counts below mean returned excerpt blocks / distinct papers within that response, not a claimed total search index hit count. Total returned: 23 excerpt blocks from 17 distinct paper identifiers [CITED: retrieval responses]. The corpus entry described 719 preprints [CITED: llms.txt].

| Query, verbatim | Hits [CITED] | Paper identifiers and anchors returned; what can be used |
|---|---:|---|
| JSON Schema subschema inclusion decidability tree automata complexity | 2 / 2 | PM-129.1, “3. Proof roadmap”; PM-133.2, “PolytimeManyOne”. Neither proves a complexity class for the MetaViewer fragment. |
| covering arrays combinatorial test design N-wise coverage bounds | 1 / 1 | PM-138.2, “1. Abstract and result contract”. No minimum covering-array theorem was returned. |
| mutation testing competent programmer hypothesis coupling effect minimal mutant sets | 5 / 4 | PM-100.2 and PM-125.1, “Panel 3 - reference implementation and oracle”; PM-269.2, “Oracle implementation for coupling coefficient verification”; PM-202.1, generating-tuples oracle. These are examples, not a general mutant-subsumption theorem. |
| behavioral subtyping Liskov substitution request response compatibility | 5 / 5 | PM-094.1, “5. Domain engineering contracts”; PM-110.1, “Lemma 34”; PM-244.1, substitution into binary formulas; PM-376.7, “subst definition”; PM-247.2, “1. Abstract and result contract”. No request/response theorem was returned. PM-244.1 is not SW-0244. |
| regular expression anchor semantics multiline dollar end assertion equivalence | 5 / 1 | PM-134.3: Scope, Formal statement, GeneralizedStarHeight.lean, metadata, and section 2 / #sec:introduction. These do not establish engine anchor semantics. |
| concentration bounds binomial confidence property based testing runs | 5 / 4 | PM-114.2, section 6 / limit-independent-confidence-amplification; PM-113.1, specialized sampling arguments / #pm-cite-18; PM-114.1, section 5; PM-142.1, section 6. PM-114.2 supports the independence caveat; the numerical bound below is derived. |

A retrieved tight complexity theorem, a minimal covering array for this repository, and a general coupling/subsumption theorem are **ABSENT — do not invent**. The corresponding claims below are explicitly [DERIVED], with their arguments. The supplied SW-0134, SW-0139, SW-0070, SW-0244, and SW-0064 excerpts motivate the checks; none is silently substituted for an unrelated Context7 result.

## Requested landed-commit rulings

Every PARTIAL row has a concrete counterexample or coverage limitation in a numbered finding/test. Historical fixes are credited for the cases they actually repaired.

| Commit | Ruling | Deciding source and scope |
|---|---|---|
| 3ff4ce57 | FIXED | daemon-adapter/internal/daemon/stream.go:101-106 cancels before worker drain; daemon-adapter/internal/ipc/session.go:42-50 closes clients; daemon-adapter/internal/frames/publisher.go:527-551 releases per-surface state with retry progress. The bounded completion assumption remains explicit. |
| dff17a45 | FIXED | contracts/v0.2/surface_request.schema.json:54-57 bounds optional nested_depth to 0..1; core/src/wire/payload.rs:1515-1519 preserves it for validation; core/src/catalog/launch.rs:114-130 propagates it. T21 covers absent/0/1/2/negative/type cases. |
| c8d55fd2 | FIXED | Canonical bounds and core/src/serve/mod.rs:369-401 enforce the Rust clock ceiling; tests at :2698-2771 cover before/at/after and unchanged state. T6-R3-003 is an independent Python producer residual introduced by e1f07fa3 and not repaired by this Rust ceiling fix. |
| f8c0343a | FIXED | Fixed conformance expectations at tests/test_decoder_conformance.py:296-309,498-503; independent property-count/open-object cases at tests/test_contract_evolution.py:350-412; distinct cleanup failures at tests/e2e/test_live_stack.py:303-326,336-346. M18-M20 target those specific repairs. |
| c9aebfe1 | FIXED | daemon-adapter/internal/daemon/stream.go:232-237 attaches the preceding control completion gate; :142-148 waits before data dispatch. IPC policy validates before authentication/reservation at daemon-adapter/internal/ipc/session.go:100-126. |
| deb2bc6a | PARTIAL | core/src/wire/mod.rs:408-445 now conjoins target, const, enum and oneOf, closing the reported const bug. Type-dependent typeless siblings still fail at :447-516 and Go daemon-adapter/internal/ipc/policy.go:342-344; T07. |
| e4321108 | PARTIAL | agents/metaviewer_agents/mvctl.py:467-480 and agents/metaviewer_agents/tools.py:838-871 validate recording requests; the production response correlator rejects every valid event at agents/metaviewer_agents/client.py:458-461. T01. |
| ffb1c910 | PARTIAL | Real-core cases exist in tests/integration/test_mvctl_core.py:154-369, but agents/tests/test_mvctl_v02_e2e.py:52-55 accepts either rc 0 or 2 for its syntax case. No production recording round trip is pinned; T01 supplies it. This is a coverage limitation, not a claim that existing real-core cases fail. |
| b95affe5 | FIXED | tools/check_contracts.py:28-56 rejects surrogates/duplicate keys/non-finite constants; :125-139 audits version consts and supplied ceilings; :218-227 checks decoded byte_count. tests/test_checker_t6.py:37-221 pins the named repairs. |
| 268afa51 | PARTIAL | The real cross-language matrix and survivor exit are present; evolution still ignores oneOf (T11), and newest negative identities can disappear below stale floors (T14). |
| bb77d17d | FIXED | agents/tests/test_wender_bridge.py:222-263 checks quick child and timed-out child reaping; production agents/metaviewer_agents/wender_bridge.py:159-162 kills/waits. No new timing measurement is claimed. |
| d206e28e | FIXED | agents/metaviewer_agents/perception/vcore.py:99-101 sets 24/16/8 bounds, :603-635 makes closed projected rows and integer scores, :679-691 and :749-750 bind frame identity/digest; agents/tests/test_vcore_v02_element_table.py:102-123 supplies negatives. |
| ac5df0d2 | FIXED | Nested typed tags are validated at core/src/wire/mod.rs:278-285; core/tests/decode_envelope.rs:278-352 rejects nested v0.1 observation/frame/surface/verdict/receipt tags. |
| e1f07fa3 | PARTIAL | Raw and effective mirror checks both run at tests/test_python_contract_mirror.py:69-70,85-86; strict client/cap controls exist in agents/tests/test_fx2_agents_b.py:221-410. It introduced clock re-origining (T03), and the shared normalizer still loses siblings (T10). |
| e60412b4 | PARTIAL | Strict Go JSON and Rust preflight rails are present; daemon-adapter/internal/ipc/policy_test.go:51-53 retains old minimum corpus counts, so T14's missing new negative does not trip those controls. |
| d2fb1077 | FIXED | daemon-adapter/internal/daemon/stream.go:97-106,142-174 has separate bounded lanes, cancellation and worker stop; daemon-adapter/internal/frames/publisher.go:527-582 preserves retryable release/close state. This proves sequencing under bounded handlers, not a scheduler-independent latency theorem. |
| 1550412b | FIXED | core/src/serve/mod.rs:836-841 samples once before replay at :855-856; send uses the route override at :403-405. observe.py's surface-id binding and agents/tests/test_observe.py:170 negative cover the requested identity rail. |
| b156f56f | FIXED | core/src/serve/mod.rs:1298-1306 samples before dequeue and restores the override on errors; :2865-2938 pins entry-ceiling refusal and two waiters served by one below-ceiling sample. |
| b6c32ed8 | FIXED | core/src/serve/mod.rs:758-823 preserves message order and stops lookahead at non-frame/regressing generations; :1893-1908 bounds batches to 32 and polls waiters. core/src/serve/regression.rs:798-1177 covers frame bursts, invalid lookahead, expired pixels and regressions. |
| 5cee47d6 | PARTIAL | Retention/dedup paths exist, but hard caps can be exceeded when the protected floor prevents eviction (T06). daemon-adapter/internal/frames/publisher_test.go:358-360 explicitly lets byte pressure override the time window; four seconds is conditional. |
| a703450c | FIXED | core/tests/layout_routing.rs:109-126,131-293 covers seven layout/control ops and negative cases; :300-374 checks unknown live slots; core/tests/control_facade.rs:251-418 exercises production release. It does not prove every possible live-daemon-loss case. |
| 51f4a770 | PARTIAL | Ordered append, non-frame barriers and retained verified pixels are implemented at core/src/journal/mod.rs:1237-1247,1308-1315,1323-1336 and core/src/serve/mod.rs:803-817. The claimed 50 ms horizon has no idle trigger; T04. |
| b21afc62 | FIXED | Publisher forced publication at daemon-adapter/internal/frames/publisher.go:256-258, post-input daemon-adapter/internal/daemon/environment.go:520-530, confirmation at daemon-adapter/internal/daemon/subscriptions.go:202, and adapter_binary_stale in tests/e2e/e2e1_slice/stack.py:692-731 implement the specific freshness/rebuild changes. Hard-cap correctness remains T06. |
| adb38c74 | PARTIAL | surface_input is excluded from envelope membership and raw mirror at core/src/wire/schemas.rs:3-52 and tests/test_python_contract_mirror.py:75-79. Its batch rails differ from host checks; T08. Human admission is journaled at core/src/journal/mod.rs:705. |
| f6597790 | FIXED | agents/tests/test_mvctl_timeout.py:139-175 keeps a shared deadline, tests two delayed replies and a reset-budget negative; Wender reaping is pinned above. These are source assertions, not measured timing. |
| 65314760 | PARTIAL | daemon-adapter/internal/daemon/subscriptions.go:80,92,100-105,202 keys confirmations by surface, refuses invalid config and resets release state. Publisher's no-victim branch still exceeds caps; T06. |
| 079c2a99 | PARTIAL | Sticky fsync failure and Poisoned checks at core/src/journal/mod.rs:987-990,1073-1079,1129-1131,1230-1232; core/tests/t1_journal_verify.rs:337-416 pins failure. Frame refusals now exist, but their action_verdict body kills the real daemon; T02. |
| 73d79bf6 | FIXED | At this newer head, core/src/serve/mod.rs:1445-1505 forwards a valid surface_request with origin human and tracks it; :1111-1113 removes on first matching receipt; :1507-1559 settles the UI outcome. core/tests/human_input_real_adapter.rs:563-652 now pins applied click/key/type and unsupported-scroll refusal. The subsequent 1fca7833 origin repair is included. |

The later 8cf06ece journal-worker ownership change is **PARTIAL**: normal close/drop joins, but its timeout detaches the writer (T05). Static commit-patch attribution, not an executed bisect: recording correlation was introduced by e43211081d4e80f2021c1f45c74cca9731619cf3; clock re-origining by e1f07fa3cd16651dba7d1a769a513d8927b97faa; the arrival-only durability claim by 51f4a7702651a5584a7d25e61d61520f3d389122; frame-refusal vocabulary by 079c2a99f8cda46213299d48cee4b4d0cd5f9ab9; the shutdown timeout branch by 8cf06ece313876278d3134ed0603130db5292ea1. The general cap hole predates 65314760; that change sharpened the protected two-generation case. No unsupported exact introducing commit is assigned to older residuals.

## Section-5 claimed fixes

| Target | Ruling | Evidence, remaining counterexample, or limit |
|---|---|---|
| D2-01 receipt mirror/equality | PARTIAL | Current receipt evidence matches canonical shape and agents/tests/test_native_receipts.py:43-104 rejects missing inner fields. The general equality guarantee remains unsound through local-ref siblings, T10. |
| D2-02 mvctl mapping/list | PARTIAL | Pagination and hello/version mappings exist at agents/metaviewer_agents/mvctl.py:407,444-447,506-508 and agents/tests/test_tg_cli.py:144-155. Parsed config {} is misclassified, T15; unreadable/invalid-text cases are the currently covered controls. |
| D2-03 observation/table | PARTIAL | Explicit v0.2 tags and closed integer-score projection exist; validate_observation still omits canonical upper bounds, T09. The legacy default has no internal production caller. |
| D2-04 bridge | PARTIAL | Bounded stdout/stderr, reaping, frame/row validation and transport codes exist at agents/metaviewer_agents/wender_bridge.py:44-104,121-162,225-256. Invalid action/expectation loses bad_shape, T16. |
| D2-05 pin resolver | FIXED | agents/metaviewer_agents/perception/deps_lock.py:24 exact lowercase 40-hex end assertion; :37-48 duplicate-key refusal; :51-70 unique names/pins; :92-142 unique provenance, full commit, mismatch and dirty-tree refusal. This ruling concerns identity fields, not strict treatment of ignored metadata; T30 states that remaining limit. |
| D2-06 planner wiring | FIXED | agents/metaviewer_agents/verify.py:47-60 rejects non-JSON/empty/NUL argv with bad_shape; configured planner errors do not enter :69-75's unconfigured fallback; :78-81 accepts success only from wait_verify. |
| D2-07 layout pin | FIXED | tests/test_layout_intents.py:8-40 pins closed hide/show/move/tab/float and missing/type negatives; contracts/v0.2/ui_intent.schema.json:230-233,284-287,332-356 supplies the exact rails. T23 completes every edge combination. |
| D2-08 peer/cap | FIXED | daemon-adapter/internal/ipc/session.go:70,84-87 enforces capacity/kernel peer identity; daemon-adapter/internal/ipc/foreign_peer_test.go:19-88 and daemon-adapter/internal/ipc/maxconn_test.go:16-75 include foreign/second-client negatives and a surviving first client. No bypass established. |
| D2-09 purity pin | PARTIAL | Raw source scan exists but decoded JSON Unicode slash escapes evade that isolated instrument, T13. This does not imply the full checker accepts stale versions. |
| NEW native receipt | FIXED | contracts/v0.2/action_receipt.schema.json:56-108 makes evidence optional but requires surface_id/input_mono_ns/input_ts_ns when present; three direct and three envelope native fixtures plus agents/tests/test_native_receipts.py:30-104 pin closure/rails. Presence alone is not verification. |
| W1 mvctl | PARTIAL | Trusted hello, strict input and real-core loop coverage exist at agents/metaviewer_agents/client.py:94-145,365-414 and tests/integration/test_mvctl_core.py:154-369. Recording correlation and parsed-config classification remain, T01/T15. |
| R1 batch | PARTIAL | Dual-stack outer/body matching, strict nested tags, closed objects and exact-one hold in the inspected paths; the full documented ref conjunction still has T07's residual. |
| R3-01 | PARTIAL | Required version const/ceiling/surrogate/byte_count audits are fixed; sibling const works; typeless sibling bounds still disagree, T07. |
| R3-02 | PARTIAL | Actual probes, fixed expected verdicts, baseline and nonempty checks are present. Fixture-identity erosion, routine harness omission and error-as-kill remain, T12/T14/T17. |
| R3-03 | PARTIAL | Snapshot purity, strict client inputs, nested-depth and raw numeric bounds have source pins. Producer clock reset, recording correlation and mirror-normalization semantics remain, T01/T03/T10. |

## Still-open probes rechecked

| Probe | Current ruling |
|---|---|
| R1-088 | **FIXED.** core/src/wire/mod.rs:270,291-299 now recognizes foreign versions of registered body families before typed deserialization; core/tests/decode_envelope.rs:357-388 pins UnknownVersion. Unknown families deliberately remain Malformed. Go uses closed-body refusal; Python unknown_version; checker has no typed version error. T20 separates verdict from vocabulary. |
| D2-OPEN-02 | **FIXED as an internal live-path allegation.** build_observation is defined/exported but has no production invocation in the complete agents module set. validate_observation callers agents/metaviewer_agents/tools.py:464-466, agents/metaviewer_agents/wender_bridge.py:214-215 and agents/metaviewer_agents/vision.py:164-165 explicitly choose v0.2. The public default remains v0.1; no external caller inventory is claimed. |
| D2-OPEN-03 | **NOT FIXED.** Reachable nullable-id ref sibling drift passes normalization, T10. Dropping unused defs and sorting enum order alone are not defects. |
| D2-OPEN-04 | **PARTIAL.** A survivor now produces rc 1, but local/PR discovery still omits the real matrix; T12. Errors can also masquerade as kills; T17. |
| W1 refusal backlog | **PARTIAL.** Unknown kinds and replay refuse; exact policy vocabulary still lacks the requested dedicated string pin. Exact current strings and a proposed assertion are in T24. The concrete cross-component vocabulary regression is T02. |
| R3-OPEN-01 | **FIXED for current nested-depth semantics.** Absent/0/1 accept; 2/negative/bool/fraction/string refuse across schema-based paths. T21 adds every lexical form, including 1.0 and 1e0, to the verdict table. |
| R3-OPEN-02 | **PARTIAL.** Raw timestamp M is representable and M+1 refused across decoders. Server-generated time deliberately stops at M. Python instead re-origins after overflow, T03; that is a producer violation, not a disagreement on the emitted zero. |
| R3-OPEN-03 | **PARTIAL.** All envelope paths refuse surface_input as a body; standalone checker accepts it. UI accepts both v1 and v0.2, emits v1, then host translates to v0.2 surface_request. Batch chord/Unicode rails still differ, T08/T22. |
| R3-OPEN-04 | **FIXED.** One route/tick sample precedes mutation/dequeue; no waiter is lost at entry ceiling; identical reply stamps are pinned at core/src/serve/mod.rs:2774-2938. T25 adds the requested explicit boundary table. |
| R3-OPEN-05 | **PARTIAL.** Normal admitted input is journaled and settled once, with role/origin/replay refusals. Batch/admission rail correspondence has T08's gap. A supplied valid proposal_id is preserved: the empty-id minting fallback at core/src/serve/mod.rs:1460-1463 is unreachable for an externally valid request requiring a nonempty id. This corrects the “always core-minted” claim without inventing an ID-collision bypass. |


# Math

All arguments in this section labelled [DERIVED] are deductions from the stated domains and connector-read source. Numerical targets are proposals, not benchmark results.

## Domain, invariants, and implementing oracles

Let M = 2^53 - 1. Let W be valid, uniquely keyed NDJSON with scalar Unicode, the documented integer lexical/type rules, and the applicable transport caps. Let S be the canonical envelope schema plus normative semantic checks such as terminal byte_count. Define A_C, A_R, A_G, A_P and A_M as checker, Rust, Go, Python, and evaluation of the raw Python mirror **on the same value, schema version, embedding, and transport domain**. A standalone batch validator is a different predicate from an envelope-body validator. The shared matrix has four executable language columns; raw/effective mirror equality is a fifth logical source check, not an independent fifth wire parser [CITED: tests/test_decoder_conformance.py:456-469,472-484; tests/test_python_contract_mirror.py:75-86].

| Invariant [DERIVED] | Formula / argument | Implementation and pin |
|---|---|---|
| Conformance | For every x in W, A_C(x)=A_R(x)=A_G(x)=A_P(x)=A_M(x). | Shared fixture/override matrix at tests/test_decoder_conformance.py:472-521 plus mirror :85-86. T07 refutes total supported-schema agreement; source inspection is not an execution proof on all fixtures. |
| Fail closed | x outside den(S) implies every applicable A is false before effects. | tools/check_contracts.py:174-256; core/src/wire/mod.rs:252-285; daemon-adapter/internal/ipc/policy.go:248-266; agents/metaviewer_agents/envelope.py:762-803. Go daemon-adapter/internal/ipc/session.go:100-126 validates before Authenticate and Reserve. |
| Object closure/completeness | keys(o) subset properties(s), and required(s) subset keys(o). A conflict-free but incomplete object is invalid. | Checker :210-217; Rust :455-471; Go :345-363; Python :660-685. Drop-required and unknown-property controls in tests/test_contract_mutants.py:354-369. |
| Exact-one | Sum over branches of 1[A_branch(x)] equals 1, not merely at least 1. | Checker :197-206; Rust :442-445; Go :326-335; Python envelope.py oneOf check; tests/test_fresh_divergences.py:126-152. Duplicating a matching branch must refuse. |
| Version identity | Every reachable versioned discriminator equals the version required at that schema position; outer v0.2 cannot carry nested v0.1. | Checker audit :125-132; Rust :270-285; Go compiled consts; Python :795-803. core/tests/decode_envelope.rs:278-388 and mirror raw-const test :55-70. |
| Integer domain | Genuine integer representation/type and -M <= n <= M, intersected with each field's smaller interval. | Rust :300-324,490-509; Go json.go walk and daemon-adapter/internal/ipc/policy.go:385-396; Python agents/metaviewer_agents/envelope.py:739-745 and :716-721; checker :249-256. T21/T26 exercise representation and endpoints. |
| String domain | Scalar-count field bounds and UTF-8-byte transport bounds are separate intersections. | contracts/v0.2/README.md:136-148; Rust preflight :215 and scalar count :485; Go json.go / daemon-adapter/internal/ipc/policy.go:375-377; Python agents/metaviewer_agents/envelope.py:705-709,739-752; checker :236-248. T08 finds a UI UTF-16 discrepancy. |
| Terminal payload length | For valid Base64, byte_count = 3*(encoded_length/4) - padding. | Checker :218-227; Rust terminal_lengths :327-339; Python agents/metaviewer_agents/envelope.py:685-696; canonical and Go controls in T26. The formula requires prior Base64 syntax validation. |
| Reference conjunction | A_(ref+sibs)(x) = A_target(x) AND A_sibs(x), for every applicable sibling. | Rust :408-445 and Go :311-336 fix const, enum, exact-one; local type switches leave T07's residual. |
| Mirror soundness | N(S)=N(Mirror) must imply equal denotations on W. | Equality is asserted at mirror test :85-86. N loses local-ref siblings at :27-32; T10 refutes the implication. Equality alone cannot prove the normalizer sound. |
| Clock/request atomicity | A successful route/tick samples once; all generated stamps equal that sample. At sample >= M, no replay/domain/dequeue mutation occurs. | core/src/serve/mod.rs:836-856,1298-1306; tests :2774-2938. Python generator violates the lifetime aspect in T03. |
| Human input settlement | A successfully admitted input has one journaled admission and at most one pending entry removed by its correlated receipt; a replay cannot dispatch twice. | core/src/admission/mod.rs:280-286; core/src/journal/mod.rs:705; core/src/serve/mod.rs:1111-1113,1445-1559; core/tests/human_input_real_adapter.rs:563-652. This is an at-most-once safety claim; delivery/liveness also needs a functioning adapter. |
| Resource/durability bounds | RetainedBytes <= configured cap; an advertised time bound needs an arrival-independent trigger and bounded I/O assumption. | Publisher :386-466 and journal :1405-1412 violate these respective claims in T06/T04. |

[DERIVED] Adding fixture files adds obligations; it does not change any acceptance predicate. This is the useful monotonicity property of the negative catalogue. Adding oneOf schema alternatives is different: a duplicate branch turns a former one-match value into a two-match refusal. New ui_intent operations have distinct op consts, so those particular additions are disjoint union extensions. The distinction prevents an incorrect universal monotonicity claim.

## Inclusion: decidable here, with no invented tight complexity class

The nearest useful model is an acyclic, bounded tree language: closed named records; bounded arrays; const/enum partitions; bounded numeric intervals; regular anchored string languages; and Boolean exact-one combinations. References resolve to a finite graph, and the checker rejects cycles/depth overflow at tools/check_contracts.py:96-103 [CITED].

[DERIVED] Inclusion is automatable in principle on W. With byte cap L=1,048,576 [CITED: contracts/v0.2/README.md:136], at most

    sum(i=0..L) 256^i = (256^(L+1)-1)/255

candidate byte strings exist. Enumerate them, parse, then seek A_old(x) AND NOT A_new(x). This terminates for the bounded, terminating validators. It is an intentionally enormous constructive upper bound, multiplied by the cost of two validations, not a usable algorithm or a tight schema-complexity classification. A tight complexity result for unrestricted JSON Schema or the precise encoded-bound fragment was not retrieved: **ABSENT — do not invent**.

[DERIVED] A practical symbolic procedure can partition integers at bounds, separate present/missing fields, compile the actual regular patterns, preserve closed-object structure, and search Boolean products. Exact-one can be represented as the union, over i, of B_i intersected with every other branch's complement. Reference siblings must remain conjuncts. A procedure that only compares root property dictionaries is not such an inclusion decision procedure; T11 gives its counterexample.

[DERIVED] The current canonical envelope graph has a container-depth upper bound of 7, by structural recursion: scalar depth 0; object depth 1 plus maximum child depth; array depth 1 plus item depth; oneOf takes the maximum; references follow their acyclic target. One longest path is envelope.body -> mv_tool_call.args -> proposal -> action -> lane payload -> args array. Every object is closed. Thus Python's internal depth constant of 100 versus Rust/Go transport depth 32 does not by itself provide an accepted current-schema 33-container witness. It remains a transport parity test obligation. Do not claim an exploitable current depth differential without such a witness [CITED sources: contracts/v0.2/envelope.schema.json:92; mv_tool_call.schema.json; action_proposal.schema.json; core/src/wire/mod.rs:180-245; agents/metaviewer_agents/envelope.py:49,739-759].

## Request/response direction and the supplied E6/E7 rules

[DERIVED] For whole-document languages O and N, old request producers remain usable exactly when O is a subset of N. Old response readers remain safe exactly when N is a subset of O. For an independent field with inhabited value domains and requiredness flags r_o,r_n, this gives:

    request_breaks = (O not subset N) OR (not r_o AND r_n)
    response_breaks = (N not subset O) OR (r_o AND not r_n)

Equivalently, include an “absent” value in an optional field's domain and apply ordinary inclusion. Substitution of old/new proves request_breaks(old,new) = response_breaks(new,old), including presence changes. This derives the supplied E6/E7 relationship; the query-4 hits did not establish it.

The equality is necessary for a correct implementation but insufficient as an oracle: two functions that both omit oneOf return false on the same breaking case and preserve the equality. Independent witness acceptance must accompany the mirror property, T11.

| Concrete change | Request direction [DERIVED] | Response direction [DERIVED] | Witness / source |
|---|---|---|---|
| Introduce a finite ts_ns maximum in a formerly unbounded schema | Breaking on old values above the maximum. | Safe narrowing for an old permissive reader. | contracts/v0.2/envelope.schema.json:15-19; n=M+1. Runtime wire-domain restrictions may already exclude this value, so state whether comparison is raw schema or W-relative. |
| Add optional native_evidence to a closed receipt | Safe extension for old values that omit it. | Breaking for an old closed reader when it is present. | contracts/v0.2/action_receipt.schema.json:56-108. Optional outside does not make its required inner fields optional. |
| Add a disjoint move/layout alternative | Safe request extension. | Old response union cannot accept the new alternative. | contracts/v0.2/ui_intent.schema.json:215-321; concrete move request in T11. |
| Make existing layout index optional -> required | Breaking: an otherwise valid old request may omit it. | Safe narrowing; new replies always provide it. | Synthetic requiredness mutant on the real move field, range 0..255 at :230-233. Reverse the pair to prove the opposite direction. |
| Remove the move branch | Breaking; the old move witness is lost. | Safe narrowing. | T11; reversed pair must be response-breaking. |

The complete carried-schema comparison was read against v0.1. Changes are classified below after recursively retagging versions; without retagging, differing required schema consts make raw v0.1/v0.2 documents incompatible both ways [DERIVED].

| Carried scope / delta | Classification and exact scope [DERIVED from the two schema sets] |
|---|---|
| Envelope | Added maxima on ts_ns/seq narrow the raw language; 8 -> 19 body alternatives widen it. These effects oppose each other, so the whole schema is not generically monotone. Added enum-string lengths are redundant for current short enum values. |
| surface; create geometry | Width/height maxima 16384 and display-string cap narrow formerly unbounded values. Additional maxProperties=256 is redundant for already closed objects with fewer declared properties. |
| surface_request | Optional nested_depth and origin extend closed objects; their omission remains valid. Coordinate/scroll/sequence maxima, key/argument array caps, text caps, wait <=3,600,000 narrow old unbounded fields. |
| frame_ref | Safe counter maxima, dimensions <=16384, stricter surface-id/RAM path languages and path length narrow requests and are safe response narrowing. Lengths fixed by schema/format/hash consts or patterns are redundant. |
| observation | Summary/name caps, changed-region/element item caps, bounding-box size rails, safe tick/coordinate maxima narrow old values. Existing confidence remains a bounded number; the new external element-table projection uses integer scores in its own structure. |
| action_proposal | Safe generations/coordinates/sequences, array/string caps, wait/max_ms <=3,600,000, max_retries <=10 and bounded expectation boxes narrow old values. Required lists on carried fields did not flip in the compared schemas. |
| surface_event; action_verdict; session_record | New finite detail/counter caps narrow where previously unbounded; limits redundant on closed key sets or already fixed enum/hash languages do not change denotation. Nested references inherit their target's narrowing. |
| action_receipt | Counter/detail/error caps narrow; optional native_evidence widens. Consequently neither direction is globally guaranteed by looking at one delta. |
| New list and layout verbs | Disjoint operation-union additions are request extensions and response widenings, conditional on aligned tags and otherwise unchanged branches. This says nothing about correct CLI implementation; T01 shows why a shape theorem is insufficient. |
| Strict client/mirror instead of silently dropping fields | Narrows the implementation's previously overpermissive accepted language. It restores canonical closure rather than establishing compatibility for previously malformed inputs. |
| Element projection | agents/metaviewer_agents/perception/vcore.py:603-635 emits closed rows and rounds score*1,000,000; frame/hash/row checks are separate semantic obligations. It is a representation conversion, not an inclusion proof for all old raw engine output. |

The ten carried base positive fixtures were also read [CITED: contracts/examples/*.valid.json]. After recursive v0.2 retagging, their short ids, small counts, 800x600 geometry, valid RAM paths, bounded boxes, confidence 0.95, and modest budgets satisfy the new constraints by inspection. This finite positive result is not a proof that every old valid document remains valid; maxima and stricter paths supply counterexamples. tests/test_contract_evolution.py:453-468 checks retagged fixtures and even skips a missing fixture at :457-458, so the repository checker remains a separate required guard.

## Anchors, Unicode, and mirror normalization

The official [Python re syntax](https://docs.python.org/3.11/library/re.html#regular-expression-syntax), [Rust regex empty-match syntax](https://docs.rs/regex/latest/regex/#empty-matches), and [Go regexp/syntax](https://pkg.go.dev/regexp/syntax#hdr-Syntax) were read for engine semantics. In default nonmultiline mode Python dollar can match before a final LF; Python \Z requires the actual end. Rust regex and Go dollar require the actual end absent multiline mode, with \z as the explicit end assertion. Go \Z must not be substituted for Python \Z. MetaViewer's Rust decoder actually uses handwritten recognizers in core/src/wire/mod.rs:368-405, not the regex crate.

[DERIVED] There are ten distinct pattern strings in the current 21-schema set, including two equivalent spellings of the absolute-path control exclusion. All use an unescaped final dollar and no inline multiline flag. They cover lowercase hex, ASCII identifiers, bounded shared-memory segments, absolute-path exclusions, key tokens, non-NUL input text, and Base64. The terminal-dollar rewrite therefore enforces the intended exact-end wire predicate for these patterns. It is **not** language-preserving relative to unmodified Python re: the real id pattern ^[A-Za-z0-9][A-Za-z0-9._:-]*$ accepts x followed by LF under native Python dollar semantics but fails under exact end. Current checker/decoder paths already refuse that id, so this historical newline bug is not refiled. Arbitrary future regexes need parsed syntax and a portable subset audit, not extrapolation from this finite inventory.

[DERIVED] Sorting enum values and required names is semantics-preserving here; sorting oneOf preserves multiplicity, so the exact-one count is preserved. Unused defs do not affect denotation. Reachable defs may be expanded, but every ref sibling must survive. Erasing bounds +/-M is sound only relative to the mandatory global integer rail and the actual typed schema nodes, not as unrestricted raw-schema equality. T10 demonstrates a reachable defs drift that passes both snapshot comparisons.

[DERIVED] The purity pin is not complete. Serialize the slash in the forbidden discriminator as the JSON Unicode escape `\u002f`: decoded content is unchanged, but the literal raw substring disappears. An ordinary escaped solidus `\/` does not evade this check because its raw text still contains `/v0.1`. The canonical parser and raw-mirror const walk can still reject it; the isolated source-text instrument does not, T13. The statement “no stale raw const values” and the statement “the file contains no literal substring” are different predicates.

## Quantitative coverage and mutation oracles

[DERIVED] For independent scalar factors with cardinalities v_i, a t-way covering set needs at least max over t-subsets I of product(v_i for i in I) rows: one row witnesses only one tuple for that factor subset. Exhausting product(all v_i) complete assignments is sufficient. Under constraints, count only feasible tuples; another sufficient construction takes one full witness per feasible t-tuple. Arrays can witness several tuples in one document, so a scalar lower bound cannot be transferred to an array-bearing schema without accounting for witness capacity.

For direct action_receipt fixtures, verification.method has three values and native_evidence.kind has three independent values [CITED: contracts/v0.2/action_receipt.schema.json:30-37,70-77]. The direct native-click/key/text examples all use method pixel; base/variant-001/variant-002 omit native evidence. Therefore only 3 of 9 feasible scalar pairs are witnessed, with six missing [DERIVED from the six connector-read files]. Nine rows are necessary and sufficient for this two-factor present-evidence projection; an absent-evidence witness is a separate obligation. A missing pair is method=element, kind=key. The 394-valid corpus is **gapped under the proposed pairwise criterion**. Its global minimum or bloat is not established, and pairwise coverage is stronger than today's documented one-way alternative requirement at tools/check_contracts.py:260-279. T31 turns the exact nine-pair set into an oracle.

[DERIVED] Let K(m) be the set of tests that kill mutant m. A nonvacuous subsumption implication requires K(m1) nonempty and K(m1) subset K(m2). Merely requiring ten generated mutants or the tags drop/add_unknown/flip_const does not establish such an inclusion. The generator actually includes wrong types, numeric/length/array/enum changes as well (tests/test_contract_mutants.py:230-257); the mandatory tag set is at :364-365. Its JSON serialization at :323 cannot emit duplicate-key raw JSON. Integer/number type overapproximation at :93-94 does not systematically cover 1.0/1e0 lexical integers. Ref siblings, exact-one overlap, temporal clock sampling and raw trailing parse are further independent classes. The broader matrix covers some of these, but no general subsumption theorem was retrieved.

A valid mutation kill must be a designated runtime assertion failure. Missing compilers, build failures, import errors and collection failures are ERROR/BLOCKED, not kills; when using the supplied marker convention, rc 99 is a survival/error indicator, never success [CITED: supplied E10]. T17 shows the current harness conflates failures and errors.

## Explicit differential-fuzz parameters

PM-114.2 section 6 / limit-independent-confidence-amplification warns that confidence amplification requires appropriate independence. The following numbers are conditional targets.

[DERIVED] If each independent sample exposes a particular defect with probability at least p, N misses have probability (1-p)^N <= exp(-pN). Choose p=0.001 and alpha=0.000001 [TARGET]. The exact Bernoulli threshold is ceil(log(alpha)/log(1-p)) = 13,809; a convenient budget is **20 independently drawn, recorded seeds x 700 new inputs = 14,000 inputs** [DERIVED/TARGET]. exp(-14) is about 8.32e-7, below alpha. With zero detections, the corresponding one-sided upper bound on p is 1-alpha^(1/14000), about 0.0009863 [DERIVED].

For reproducibility, record the actual twenty seed integers before running; generate independent streams from them, replay the identical serialized bytes through all applicable oracles, retain minimized counterexamples and include deterministic boundary rows outside the random budget. No seed outcomes are fabricated here. Repeating the same fixtures does not amplify coverage. If one claims a simultaneous guarantee over F families, use at least ceil(log(F/alpha)/p) per family by the union bound [DERIVED]. These claims depend on the sampling distribution and independence; an arbitrarily rare defect has no universal detection guarantee.

## Measurable optimizations and resource tradeoffs

| Proposal | Expected gain / invariant [TARGET unless derived] | Measurement after implementation |
|---|---|---|
| Batch schema-override Go probes | Reduce the three Go invocations at tests/test_decoder_conformance.py:438-449 to one, while preserving every row's schema, expected verdict and output identity. No percentage speedup is asserted. | Run /usr/bin/time -v python3 -m pytest tests/test_decoder_conformance.py -q before/after; record wall time, max RSS, subprocess count and identical verdict vector. |
| Lossless, memoized mirror comparison | Detect the nullable-id sibling mutation currently invisible; preserve metadata/value separation and all reference conjuncts. Memoization should reduce repeated graph visits, measured rather than assumed. | Run python3 -m pytest tests/test_python_contract_mirror.py -q; instrument node visits in a proposed test and require T10 to fail on drift. Compare time and graph visits, plus the named mutant kill. |
| Shared manifest and constrained fixture minimization | Zero omitted families/negative identities; 9/9 receipt pairs; same byte corpus for every language. Remove a positive only after proving it contributes no unique required obligation. | Record per-schema counts, feasible-pair sets and complete probe-input digests; run checker, mutant, mirror and differential commands before/after. The current total alone does not justify deleting fixtures. |
| Honest retention admission | Enforce bytes before publication; explicitly refuse or shed load when protected leases make the next frame infeasible. | Extend publisher tests in T06; record retained bytes, publication refusals, protected lease lifetime and fresh-after-frame latency, under changed and unchanged frames. |

[DERIVED] At 1280x900 RGB24, a frame is 3,456,000 bytes. A 128 MiB cap holds only floor(134,217,728 / 3,456,000)=38 such frames. Continuously changed content at 10 Hz needs about forty frame intervals for four seconds, before extra generations and overhead. Therefore a universal four-second retention promise, that byte cap, and unrestricted continued publication cannot all hold simultaneously. Deduplication helps unchanged content; admission/refusal or a revised conditional promise is necessary under sustained change. Existing daemon-adapter/internal/frames/publisher_test.go:358-360 already chooses cap pressure over time retention; T06 is the independent bug where even that cap can be exceeded.


# Findings

The table is ranked by severity. Every row includes its blast radius in the actual column. T01–T17 below provide complete input/mutation, command, expected result, predicted current result, and scope. All source links are pinned to the reviewed SHA.

| uid | severity | file:line | repro | expected | actual |
|---|---|---|---|---|---|
| T6-R3-001 | P0 | [agents/metaviewer_agents/client.py:458](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/agents/metaviewer_agents/client.py#L458) | T01: valid ram_start followed by a matching started record_event. | Started/stopped succeeds; refused event maps to refusal. | ToolValidationError; schema_error, CLI rc 2. Every recording CLI exchange is affected. |
| T6-R3-002 | P1 | [core/src/serve/mod.rs:1042](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/core/src/serve/mod.rs#L1042) | T02: reproduce the destroyed-surface frame refusal and then send a permitted request. | POLICY refusal handled; shared connection remains usable. | core surface request required; adapter exits 2 and cleanup affects other surfaces. |
| T6-R3-003 | P1 | [agents/metaviewer_agents/envelope.py:828](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/agents/metaviewer_agents/envelope.py#L828) | T03: stable clock callable returns 100, then 100 + 2**53 for the same session. | Typed refusal and no second emitted envelope. | Second envelope is accepted with ts_ns=0; long-lived session ordering is reset. |
| T6-R3-004 | P1 | [core/src/journal/mod.rs:1407](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/core/src/journal/mod.rs#L1407) | T04: append one frame before the window, keep the journal open, then stop appending. | Timed dispatch without a new append; bounded durability under stated I/O assumptions. | No dispatch until a later transition, threshold or shutdown; the advertised maximum-loss horizon is unsupported. |
| T6-R3-005 | P1 | [core/src/journal/mod.rs:1035](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/core/src/journal/mod.rs#L1035) | T05: block worker I/O past its five-second join timeout; Drop, then unblock it. | No writes after completed destruction; exclusive ownership held until quiescent. | Late worker writes remain possible after Drop and explicit unlock, risking overlap with recovery. |
| T6-R3-006 | P1 | [daemon-adapter/internal/frames/publisher.go:424](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/daemon-adapter/internal/frames/publisher.go#L424) | T06: a six-byte frame with caps five; or two protected frames on each of two surfaces then a third surface. | Refusal with no retained-cap excess. | Successful publication above the configured surface/global cap; multi-surface memory bounds fail. |
| T6-R3-007 | P1 | [core/src/wire/mod.rs:447](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/core/src/wire/mod.rs#L447) | T07: valid frame under body oneOf containing its ref plus maxProperties:11, without type. | All semantic evaluators refuse the twelve-key frame. | Rust/Go accept; checker/Python refuse. This is a supported-language hole; current canonical refs have no validation siblings. |
| T6-R3-008 | P1 | [contracts/v0.2/surface_input.schema.json:86](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/contracts/v0.2/surface_input.schema.json#L86) | T08: eight four-character key tokens; separately 513 copies of one non-BMP scalar. | One documented context-free validity verdict at the batch boundary. | Standalone checker accepts both; host refuses SCHEMA. The Unicode text also fits Rust's downstream byte rail. |
| T6-R3-009 | P2 | [agents/metaviewer_agents/observe.py:79](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/agents/metaviewer_agents/observe.py#L79) | T09: v0.2 observation with generation 2**53, or summary length 65537. | ObservationError with bad_shape before planner serialization. | Helper accepts; canonical envelope refuses. Normal tools.observe has stronger checks; this is not an admission bypass. |
| T6-R3-010 | P2 | [tests/test_python_contract_mirror.py:32](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/test_python_contract_mirror.py#L32) | T10: canonical-only nullable-id sibling maximum 127; exit.signal has 128 ASCII characters. | Mirror drift detected; canonical and mirror verdicts compared. | Equality still holds; canonical checker refuses while the unchanged snapshot accepts. |
| T6-R3-011 | P2 | [tests/test_contract_evolution.py:168](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/test_contract_evolution.py#L168) | T11: delete only the move branch; retain a valid move witness. | Request narrowing and reversed response widening both report breaking. | Both helpers return false; their mirror equality does not reveal the shared omission. |
| T6-R3-012 | P2 | [tools/gate.sh:1420](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tools/gate.sh#L1420) | T12: add a syntactically valid no-op mutant to the harness. | The designated routine gate fails for a surviving mutant. | Direct harness exits 1, while ordinary discovery never invokes it; scheduled coverage does not close this path. |
| T6-R3-013 | P2 | [agents/tests/test_tg_contracts.py:72](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/agents/tests/test_tg_contracts.py#L72) | T13: encode the slash in observation/v0.1 as a Unicode escape in one fixture. | The isolated purity pin fails. | The isolated pin passes. Other canonical/mirror checks can still reject the stale value. |
| T6-R3-014 | P2 | [tests/test_decoder_conformance.py:473](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/tests/test_decoder_conformance.py#L473) | T14: remove only surface_request.invalid.origin_unknown.json from a disposable selection. | A fixture-loss oracle fails. | The named isolated matrix/count tests retain their baseline verdict. This is erosion, not an entirely empty-test pass. |
| T6-R3-015 | P2 | [agents/metaviewer_agents/mvctl.py:491](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/agents/metaviewer_agents/mvctl.py#L491) | T15: otherwise valid observe invocation with config containing {}. | CLI rc 2, empty stdout, usage_error on stderr. | CLI rc 2, transport_error; callers misclassify a local configuration defect. |
| T6-R3-016 | P2 | [agents/metaviewer_agents/wender_bridge.py:268](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/agents/metaviewer_agents/wender_bridge.py#L268) | T16: valid planner reply with expectation.type changed to invented. | ObservationError.code equals bad_shape; no proposal. | ToolValidationError escapes without code. Refusal remains closed but structured diagnostics break. |
| T6-R3-017 | P2 | [agents/tests/run_mutant_harness.py:32](https://github.com/oguirado/MetaViewer/blob/ae9361bb3d645eee1976ec8d739dc358b572561b/agents/tests/run_mutant_harness.py#L32) | T17: baseline succeeds, then a mutation makes discovery return one _FailedTest import error. | ERROR/BLOCKED or survivor classification and non-success overall. | Positive errors count as conforming and can contribute to a successful harness exit. |


# Tests written or proposed

**No tests were written into the repository or run.** Only this report is delivered. Every command below is a proposed follow-up on the pinned checkout with its dependencies available. When a new assertion or fixture is specified, add it to the named existing test file before running the command. An unmodified existing test passing does not test a newly described case. Normal expected test-process exit is 0; a reproduced assertion failure is pytest/Go/Node exit 1 or cargo-test exit 101. Infrastructure and collection errors are reported separately.

## Concrete reproductions for every finding

### T01 — production recording correlation

Use the existing trusted hello/socket machinery without replacing ToolClient. Send the following logical request:

    {"schema":"record_request/v0.2","request_id":"r-start","op":"ram_start","params":{"surface_id":"surf-1","recording_id":"rec-1","ring_bytes":1024,"max_fps":30}}

Return a correctly correlated envelope containing:

    {"schema":"record_event/v0.2","request_id":"r-start","surface_id":"surf-1","recording_id":"rec-1","event":"started","mono_ns":1,"mode":"ram"}

Input ids may be bound to the request generated by tools.record_start; the required condition is a matching request_id with a canonical event body. Add equivalent stopped and refused cases. Command: python3 -m pytest agents/tests/test_record.py -q. Expected: started/stopped return normally and CLI rc 0; a valid refused event maps to ToolRefusal/CLI rc 1. Current deduction: result.get("op") is None versus ram_start, so agents/metaviewer_agents/client.py:458-461 raises “uncorrelated tool result”; agents/metaviewer_agents/mvctl.py:541-551 emits schema_error and rc 2. New assertion fails with pytest rc 1. Existing fake-client tests bypass this point.

### T02 — core frame-refusal body versus real adapter

Port the sequence in core/src/serve/regression.rs:1237-1262 to core/tests/human_input_real_adapter.rs: register a surface, mark it destroyed, submit a valid frame referring to it, and deliver the resulting POLICY action_verdict over the actual core-to-adapter connection. Then require the same adapter process to handle an allowed surface_request. This is a deterministic interoperability probe; no natural race frequency is asserted.

Command: cargo test --test human_input_real_adapter. Expected: the refused frame is reported without terminating other surfaces or the shared adapter; test rc 0. Current deduction: daemon-adapter/internal/daemon/stream.go:209-213 rejects the verdict with “core surface request required”; daemon-adapter/internal/daemon/run.go:73-75 exits 2, followed by daemon-adapter/internal/daemon/environment.go:147-159 cleanup. The added survival assertion fails with cargo rc 101. The current core test's second reply establishes that the refusal is intended to leave the connection usable.

### T03 — fixed session origin and ceiling

In agents/tests/test_fx2_agents_b.py, initialize the envelope module's clock state and patch one stable monotonic_ns callable to return 100 and 100+2^53. Build envelopes for the same session with increasing seq, omitting ts_ns. Also try elapsed M-1, M and M+1 without replacing the callable between samples.

Command: python3 -m pytest agents/tests/test_fx2_agents_b.py -q. Expected: valid initialization; a typed refusal and no emitted envelope once the operational lifetime ceiling is reached. A chosen public error such as EnvelopeError("bad_shape", ...) must be pinned; there is no claim that this currently uses Rust's error type. Current deduction at M+1: origin is reset and timestamp 0 is emitted. The new refusal assertion fails, rc 1. Separately, an explicitly supplied raw ts_ns=M remains structurally representable; do not conflate decoding with clock generation.

### T04 — idle frame group

Extend core/tests/t1_journal_verify.rs's frame_append_does_not_publish_checkpoint_before_sync: after a synchronous transition, append one valid small frame within the 50 ms window, keep the journal alive, and make no further appends. Use an injected clock/dispatch observation where possible; otherwise allow a separately specified storage-completion budget after the dispatch deadline. Do not call flush_sync to make the assertion pass.

Command: cargo test --test t1_journal_verify frame_append_does_not_publish_checkpoint_before_sync -- --exact. Expected: a nonempty group is dispatched by its timer, without needing another arrival. Current deduction: checkpoint promotion waits indefinitely for a later transition/shutdown; a new timed-dispatch assertion fails, rc 101. A physical disk's opportunistic writeback is not evidence of a promised durability bound.

### T05 — worker timeout and Drop

Extend the existing journal quiescence unit test using an independent test-only barrier inside execute_sync_batch, not the existing hold automatically released by join_sync_worker. Hold it past SYNC_WORKER_JOIN_TIMEOUT, call Drop, then release the worker and inspect directory changes and writer exclusivity. Preserve a normal-shutdown positive control.

Command: cargo test --lib journal::directory_tests::drop_and_close_flush_and_join_leaving_directory_quiescent -- --exact. Expected: destruction does not complete with an unowned writer that can still alter the archive; no later checkpoint mutation or concurrently acquired writer. Current deduction: the timeout returns before join, drops the handle, and WriterFile::drop explicitly unlocks at core/src/journal/mod.rs:421; the worker can then rename at :684-688. New assertion fails, rc 101. Close timeout alone retains the object and lock; **Drop, or close followed by Drop**, is the lock-release reproduction.

### T06 — hard capacity without an eviction victim

Reuse publisher_test.go's ramFixture, whose 2x1 RGB24 output occupies six bytes. Use valid generated temporary RAM fixtures and normal or forced publication so deduplication does not remove the case.

1. Config: MaxFrameBytes=64 MiB, MaxPixels=64 MiB, MaxSurfaces=4, MaxRetained=64, MinRetention=10 s, MaxSurfaceBytes=5, MaxTotalBytes=5. Publish the first six-byte frame.
2. Config: surface cap 12, global cap 24. Publish two six-byte generations on each of surfaces a and b, then the first six-byte frame on c. Other limits remain valid.

Commands from daemon-adapter: go test ./internal/frames -run 'TestTimeBasedRetentionGlobalCapAndDeduplication|TestGlobalCapPreservesTwoPassiveGenerations' -count=1, after adding both cases. Expected: configuration or publication refuses impossible capacity; no retained excess, leaked new file, or lost protected lease. Current deduction: case 1 retains 6>5; case 2 retains 30>24 because no victim is eligible. New assertions fail, rc 1. Byte-pressure overriding a time preference is an explicit separate policy, not this bug.

### T07 — applicable siblings without repeated type

In the existing schema-override matrix, keep the current valid frame_ref fixture as the actual envelope body. Change only the `properties.body` node of an envelope **schema** copy to:

    {"oneOf":[{"$ref":"frame_ref.schema.json","maxProperties":11}]}

Keep other envelope fields valid. The frame has twelve required keys. Use maxProperties=12 as the positive control; also add a local string target plus maxLength=1 with value "ab", without a sibling type.

Command: python3 -m pytest tests/test_decoder_conformance.py -q. Expected negative vector: Rust=false, Go=false, Python=false, checker=false; evaluate the raw mirror with the same supplied schema/target as a separate semantic assertion. Current deduction: Rust/Go true, Python/checker false, so new matrix rows fail with rc 1. This exercises a permitted schema construction; no current shipped canonical node contains those validation siblings.

### T08 — joined chord and Unicode scalar length

Start from surface_input.valid.json with a valid surface/stream/seq and one event. Case A: keys contains eight copies of "aaaa"; each token meets 1..32, but joined length is 8*4+7=39 [DERIVED]. Case B: type text is a non-BMP scalar repeated 513 times, constructed at runtime; it has 513 codepoints, 1026 UTF-16 units, and 2052 UTF-8 bytes [DERIVED]. Use a short valid key and 512 copies as positive controls.

Add standalone/schema assertions to tests/test_checker_t6.py and corresponding host/preload assertions to ui/test/w3-human-input.test.js. Commands: python3 -m pytest tests/test_checker_t6.py -q; then from ui, node --test test/w3-human-input.test.js. Expected after a declared contract decision: one shared context-free batch verdict; in particular do not reject a 513-codepoint text solely because of UTF-16 counting. Current deduction: checker accepts A/B; host refuses SCHEMA at ui/electron/authorityWire.js:156,166,195-196 and ui/electron/preload.js:564,574,603-604. A canonical aggregate chord rule is presently absent; preserve the executor's joined cap rather than silently widening it. A complete batch used as an envelope body is refused regardless, and is a different test.

### T09 — v0.2 observation helper bounds

Copy a valid observation/frame fixture; set frame_ref.generation=2^53 and pass the same trusted generation. Independently set vision.summary to 65,537 ASCII characters with otherwise valid empty region/element lists; include a lone-surrogate summary as a raw/helper hygiene negative. Call validate_observation/build_observation explicitly with contract_version="v0.2".

Command: python3 -m pytest agents/tests/test_observe.py agents/tests/test_vcore_v02_element_table.py -q after adding these assertions. Expected: bad_shape before planner serialization; canonical envelope refusal as independent evidence. Current deduction: minima-only/manual checks accept the oversized generation/summary. WenderSubprocessAdapter.plan_step at agents/metaviewer_agents/wender_bridge.py:214-215 is an active helper caller; normal tools.observe has stronger prechecks. The added helper assertions fail, rc 1.

### T10 — reachable defs drift invisible to normalization

In a disposable canonical copy only, change contracts/v0.2/terminal_session.schema.json:21 from a bare local id ref to that ref plus maxLength:127. Leave the raw/effective Python snapshot unchanged. Use terminal_session/v0.2, op exit, request_id r, with params session_id s, terminal_generation 1, exit_code 0, and signal generated as "a"*128; use length 127 as the positive control.

Command: python3 -m pytest tests/test_python_contract_mirror.py -q. Expected: canonical/snapshot inequality and an independently checked semantic split. Current deduction: normalized() at :27-32 discards the new sibling and the existing equality assertion stays true, while the canonical checker refuses length 128 and the unchanged mirror accepts it. A new explicit normalization-soundness assertion fails, rc 1. This is the requested reachable defs counterexample, not a complaint about unused definitions or enum order.

### T11 — directional branch loss

Old schema is the current ui_intent; new is a deep copy with only the branch whose op const is move removed. Witness:

    {"schema":"ui_intent/v0.2","request_id":"r","op":"move","params":{"group_id":"g","slot_id":"slot-1","index":0}}

Command: python3 -m pytest tests/test_contract_evolution.py -q after adding old/new witness assertions and both directions. Expected: old accepts, new refuses; is_request_breaking(old,new)=true and is_response_breaking(new,old)=true. Current deduction: both helpers return false, preserving their mirror equality despite the bug. New assertions fail, rc 1. Reverse the pair and test optional/required layout index separately to kill direction-swap and presence-ignored mutants.

### T12 — a survivor must reach the routine gate

Add a syntactically valid no-op mutant entry to MUTANTS in a disposable harness copy, keeping the baseline suite and imports healthy. Commands: python3 agents/tests/run_mutant_harness.py; bash tools/gate.sh on a fully prepared checkout.

Expected: the direct harness prints a dead-oracle result and exits 1; any routine gate claiming to enforce that matrix also fails. Current deduction: the direct survivor exit is fixed, but default discovery never calls run_mutant_harness.main. The routine gate's outcome is unaffected by that entry; no claim is made that other gate legs are currently green. CI's explicit invocation is schedule-only at .github/workflows/ci.yml:1319-1321 and .github/workflows/volume.yml:309-312.

### T13 — decoded version versus raw spelling

In a disposable fixture, encode the slash in observation/v0.1 as the JSON Unicode escape `\u002f`. Construct that spelling from fragments at test runtime. The parsed discriminator is forbidden; raw file text lacks the literal "/v0.1". An ordinary escaped solidus does not evade the substring check and is a rejecting positive control for the instrument.

Command: python3 -m pytest agents/tests/test_tg_contracts.py -k raw_contracts -q. Expected: the purity instrument fails on the decoded foreign discriminator. Current deduction: the isolated raw substring check passes, rc 0. Checker and parsed mirror checks remain independent rejecting controls. After strengthening the instrument, this mutation should yield rc 1.

### T14 — exact negative identity must survive selection

Remove only contracts/examples/v0.2/surface_request.invalid.origin_unknown.json from a disposable fixture selection. All other files remain. The corpus becomes 487; other surface_request invalids and every positive witness remain [DERIVED].

Commands: python3 -m pytest tests/test_decoder_conformance.py -k all_v02_example_fixtures_unanimous_across_four_decoders -q; from daemon-adapter, go test ./internal/ipc -run '^TestT6Open03FixtureCountAndSchemaCoverage$' -count=1. Expected: a missing-fixture obligation fails, rc 1. Current deduction: these isolated controls preserve a passing baseline because their floors are stale. tests/test_checker_t6.py:198-202 pins schemas=21, not fixture identities. No claim that every other repository gate survives this deletion is made.

### T15 — parsed registration shape

Use the existing test_tg_cli observe fixture/valid flags and replace its config file with valid JSON {}. Also test peers=null and a missing required local peer, without echoing config contents.

Command: python3 -m pytest agents/tests/test_tg_cli.py -q after adding these cases. Expected: CLI rc 2, empty stdout, a single usage_error stderr record, and no transport opened. Current deduction: {} reaches config["peers"] outside the config handler and becomes transport_error; peers=null can take a different transport classification. New exact-code assertions fail, rc 1.

### T16 — malformed planner output preserves bad_shape

Take the existing valid reply() fixture in test_wender_bridge.py and change only expectation to {"type":"invented"}. Repeat with a malformed action while leaving valid state/target binding.

Command: python3 -m pytest agents/tests/test_wender_bridge.py -q after replacing the broad ValueError assertion with exact ObservationError.code checks. Expected: bad_shape and no proposal. Current deduction: _check_action/_check_expectation raises ToolValidationError without code. The stricter assertion fails, rc 1; malformed work is still refused.

### T17 — errors are not designated mutant kills

Keep a passing baseline. Add a synthetic valid mutant applier that makes subsequent unittest discovery produce one _FailedTest import-error result; do not alter the production code or introduce a secret-shaped fixture. Restore the discovery seam afterward. Alternatively unit-test main with baseline=healthy and a structured mutation result containing zero designated assertion failures plus one discovery error.

Command: python3 agents/tests/run_mutant_harness.py, or add the structured-result assertion to tests/test_contract_evolution.py and run that module. Expected: ERROR/BLOCKED (or survival under the supplied convention), never a conforming kill, and no success verdict. Current deduction: _run_suite returns failures+errors and main treats any positive count as conforming. A new assertion that rejects this classification fails, rc 1. This negative control does not claim that the existing eight mutants currently suffer import errors.

## Cross-language verdicts and the requested new-surface tables

A = accept, R = refuse, and N/A = no such standalone decoder. These are source-based predictions. C is tools/check_contracts.py; R is core/src/wire/mod.rs; G is daemon-adapter/internal/ipc/policy.go plus json.go; P is agents/metaviewer_agents/envelope.py; M is the raw _contracts_v02.py snapshot evaluated with the same semantic checker and audited by test_python_contract_mirror.py. The mirror is not a separate transport. This notation keeps schema acceptance separate from admission authority and stream policy.

| Clause / proposed input | C | Rust | Go | Python | Mirror / decisive evidence |
|---|---|---|---|---|---|
| Canonical admitted envelope, closed required fields | A | A | A | A | A predicted from raw/current shape; C:210-217, R:455-471, G:345-363, P:660-685; mirror test:85-86. |
| Dropped required key / extra property / zero or two oneOf matches | R | R | R | R | R; C:197-217, R:442-471, G:326-363; mutant and exact-one pins. |
| Valid surface_input standalone | A | N/A | N/A | N/A | No mirror entry; mirror test:75-79 excludes it. |
| The same batch as envelope.body | R | R | R | R | R by membership; contracts/v0.2/envelope.schema.json:92; core/tests/decode_envelope.rs:50-90; policy_test.go membership control; P:797-799. |
| surface_input/v1 standalone | R | N/A | N/A | N/A | UI alias is accepted before translation, not Rust v1 decoding. contracts/v0.2/surface_input.schema.json:18; ui/electron/authorityWire.js:113; ui/electron/preload.js:521. |
| create nested_depth absent/0/1 | A | A | A | A | A; contracts/v0.2/surface_request.schema.json:54-57, core/src/wire/payload.rs:1515-1519, G:389-396, P:637-638,716-721. |
| nested_depth 2/-1/true/1.5/"1" | R | R | R | R | R; the field maximum/minimum and exact integer type apply. Lexical 1.0/1e0 also need the raw-number controls, T21. |
| Raw timestamp M / M+1 | A / R | A / R | A / R | A / R | Same schema rail; core producer stops at M, Python generator reset is T03. |
| Canonical rebound field at min/max, then one outside | A / R | A / R | A / R | A / R | Field-specific intervals intersect the global rails; T23/T26 enumerate every changed bound rather than only the global M. |
| record request body with correct rails | A | A | A | A | Raw schema accepts; production client fails on the corresponding valid event, T01. Stream role permits record_request at daemon-adapter/internal/daemon/stream.go:210. |
| Known foreign body version, or nested v0.1 in v0.2 | R | R | R | R | Raw const R. Rust known-family error is now UnknownVersion; Python unknown_version; Go closed-body refusal; checker ValidationError. |
| Native evidence absent / present with all required inner fields | A | A | A | A | A; contracts/v0.2/action_receipt.schema.json:56-108, native-receipt tests. Present {} or a missing required inner field is R on each. |
| Element observation/table | Canonical field rails | Typed bounds | Policy bounds | Canonical codec bounds | Projection agents/metaviewer_agents/perception/vcore.py:603-635 is closed and integer-scored; observe.py helper is a separate weaker validator, T09. |
| Lone surrogate / duplicate decoded key / NaN or Infinity | R | R | R | R | Raw mirror has no parser; its wire use must inherit strict parsing. C:28-56, R:180-245, G daemon-adapter/internal/ipc/json.go:66-137, P agents/metaviewer_agents/envelope.py:739-759 (_check_json_values), :874-884 (_reject_duplicate_keys/_reject_constant), :938-944 (loads_envelope). |
| Current anchored id plus final LF; uppercase/41-char commit SHA | R | R | R | R | R under intended exact-end patterns. Resolver also uses \Z at agents/metaviewer_agents/perception/deps_lock.py:24. |
| 65,536 UTF-8 bytes / 65,538 bytes in otherwise allowed text | A / R with wire-byte semantic check | A / R | A / R | A / R | Scalar maxLength alone is insufficient; README:138,145-148 and C:236-240. |
| Terminal Base64 YQ==, byte_count 1 / 2 | A / R | A / R | A / R | A / R | Same decoded-length rule; C:218-227, R:327-339, P:685-696 and Go terminal policy controls. |
| Container depth 32 / 33 before schema validation | Checker schema recursion guard is separate | transport A / R | transport A / R | internal guard is 100 | No accepted current-schema 33-level witness: canonical envelope depth <=7 [DERIVED]. Raw transport-only differential test is still needed. |
| Typeless ref plus maxProperties 11 on a twelve-key frame | R | A | A | R | Same supplied schema should R; current canonical schemas lack such siblings. T07. |
| Local-ref sibling drift only in canonical copy | Canonical R at witness | Depends on affected keyword; T07 | Depends on affected keyword; T07 | Unchanged snapshot A | Normalizer incorrectly reports equality; T10. |

For the frozen fixture selection, the proposed matrix oracle is 393 accepts and 95 refusals [DERIVED: 394 valid files minus the one standalone surface_input positive, plus 94 invalids]. The standalone checker separately accepts the batch positive and refuses its five invalids. This count is a predicted expectation vector, not an execution result; exact file identity must also be pinned.

### Human batch, translated request and admission correspondence

The actual path is renderer inputPort -> preload -> authorityWire -> hostBindings -> surface_request/v0.2 -> Rust admission -> adapter receipt. ui/src/input/inputPort.js:20 emits surface_input/v1; ui/electron/preload.js:521 and ui/electron/authorityWire.js:113 accept both tags; ui/electron/hostBindings.js:699 revalidates, :519-546 wraps each action with origin human, and :695-734 queues the batch. Rust has no raw batch parser. Thus the v1 alias is a real UI compatibility skew, but the claim “Rust accepts surface_input/v1” would be false.

| Rail / case | Standalone batch and UI | Core / adapter disposition; exact source |
|---|---|---|
| schema tag | Canonical only v0.2; UI v1 or v0.2. | Host emits surface_request/v0.2; both raw batch tags are refused as envelope bodies. Tests must pin this explicit adapter boundary. |
| seq=0; empty events; unknown kind; extra field | Checker R; UI SCHEMA. seq is 1..M, stream_id 0..M; events 1..32. | Not forwarded through the validated host. contracts/v0.2/surface_input.schema.json:26-45; ui/electron/authorityWire.js:109-119,177-182. |
| events=33 or encoded batch >16 KiB | Canonical events=33 R; UI LIMIT. Encoded-byte cap is an additional host transport rule. | No input effects; ui/electron/authorityWire.js:181-193; ui/electron/preload.js:589-601. |
| key tokens / aggregate chord | 1..8 tokens, each 1..32 canonical; UI additionally caps joined string at 32. | core/src/admission/mod.rs:305-310 caps joined bytes; T08 exposes schema/host discrepancy. Non-ASCII and malformed tokens are host SCHEMA. |
| text length / NUL / surrogates | Canonical 1..1024 codepoints, no NUL; UI scalar well-formedness but UTF-16 length limit. | Wire maxLength 65536 and global byte cap; HumanInput 1..16384 bytes, no NUL at core/src/admission/mod.rs:311-315. Every canonical scalar-limited string fits the Rust byte cap; UI non-BMP refusal is T08. |
| click coordinates | Batch 0..65535; host additionally requires x<frame width,y<frame height. | surface_request uses 0..M; HumanInput frame containment at core/src/admission/mod.rs:317-325 gives OUT_OF_BOUNDS. Contextual refusal is expected, not schema disagreement. |
| scroll | Batch dx/dy signed i32; x/y 0..65535. Host transforms to the dx/dy action. | Wire admits +/-M; admission narrows to i32 at :273-278. Out-of-i32 -> OUT_OF_BOUNDS. Current real adapter intentionally refuses supported-shape scroll with POLICY at core/tests/human_input_real_adapter.rs:635-652; do not claim it executes scrolling. |
| wrong surface/stream/control | ui/electron/hostBindings.js:485-512 produces SURFACE_UNKNOWN, STALE_STREAM, NOT_IN_CONTROL. | Rust conflicting/agent-controlled human input -> LOCKED_BY_OTHER; ui/electron/authorityWire.js:97-105 maps to the UI vocabulary. |
| direct wait/lane_submit input | No batch alternative. | Wire can represent the general action; HumanInput refuses POLICY at core/src/admission/mod.rs:300-304. |
| agent-sent human request / UI origin agent | Shape can be valid. | core/src/serve/mod.rs:867-884 and :1425-1443 refuse POLICY before execution. |
| duplicate proposal id with a fresh envelope nonce/seq | Shape valid; batch seq guard is separate. | seen/pending/draining at core/src/admission/mod.rs:280-286 -> POLICY; no second dispatch. |
| first matching receipt / duplicate receipt | Closed receipt body; schema acceptance alone cannot prove pending identity. | First removes tracking at core/src/serve/mod.rs:1111-1113 and settles :1507-1559. Replayed/nonpending receipt cannot settle twice. Current same-surface data execution is FIFO at daemon-adapter/internal/daemon/stream.go:141-156; no out-of-order generic-error bug was established. |


## Acceptance controls and boundary cases

The following cases cover every negative control in the supplied AC table. Test exits refer to the assertion suite, not a refused application's exit; refused CLI operations are labelled separately.

| Test / AC | Input or fixture change | Proposed command | Expected result and current static ruling |
|---|---|---|---|
| T18 / all contracts | All 488 frozen JSON identities, plus schema-override positive and negative controls; retain an independent raw-mirror comparison. | python3 tools/check_contracts.py; python3 -m pytest tests/test_decoder_conformance.py tests/test_python_contract_mirror.py tests/test_checker_t6.py -q | Baseline target rc 0, checker prints Contracts check: OK; 393/95 envelope verdict vector as above, with exact identities. No run claimed. T07/T10/T14 explain why this alone is not a universal proof. |
| T19 / AC-11 | Runtime directory with wrong owner/mode or redirected parent; foreign kernel uid; exactly one permitted connection then a second; raw line of cap and cap+1 bytes including LF. | From daemon-adapter: go test ./internal/ipc -count=1; cargo test --test decode_envelope for Rust preflight cases. | Private directory 0700 and socket 0600 at daemon-adapter/internal/ipc/socket.go:25,73,98-108; foreign/cap clients close before dispatch; overlong line errors “frame limit exceeded” at daemon-adapter/internal/ipc/frame.go:64-65. At cap, transport must proceed to schema validation; it need not accept a malformed padded payload. Existing source enforces these guards. |
| T20 / AC-11 | Valid envelope with unknown property; outer v9.9; known action_proposal/v9.9; nested frame_ref/v0.1; unknown family future/v0.2. | cargo test --test decode_envelope; from daemon-adapter go test ./internal/ipc; python3 -m pytest tests/test_decoder_conformance.py -q | All refuse. Known foreign Rust family -> UnknownVersion; unknown family -> Malformed; Python unknown_version for unsupported body tags; Go closed-body diagnostic; checker ValidationError. Exact string pin proposed in T24. |
| T21 / AC-06 | create.params.nested_depth absent, 0, 1, 2, -1, true, 1.5, "1"; additionally raw tokens 1.0 and 1e0. | python3 -m pytest tests/test_decoder_conformance.py tests/test_checker_t6.py -q; cargo test --test decode_envelope; from daemon-adapter go test ./internal/ipc | Absent/0/1 accept. Every listed alternative outside the exact integer 0..1 domain refuses. Existing four depth fixtures cover 0/1/2/negative; extend lexical/type cases and keep a positive control. |
| T22 / AC-04 | Valid take_control/release_control; agent proposal while human-controlled; batch bad key token, empty events, seq 0, unknown field; valid batch embedded as body. | cargo test --test control_facade; cargo test --test admission_matrix; from ui node --test test/w3-human-input.test.js; python3 -m pytest tests/test_checker_t6.py tests/test_decoder_conformance.py -q | Agent proposal -> SURFACE_NOT_AGENT_CONTROLLED; malformed host batch -> SCHEMA (event/byte count overflow uses LIMIT); batch body -> refusal. Valid translated request reaches HumanInput, not raw batch decoding. T08 limits full rail agreement. |
| T23 / AC-06 | For move/tab, index -1,0,255,256; for float, x/y -1,0,16383,16384 and width/height 0,1,16384,16385; drop every required key, add unknown key, substitute bool/string/fraction; hide/show unknown slot. | python3 -m pytest tests/test_layout_intents.py -q; cargo test --test layout_routing | In-rail closed shapes accept; other shapes refuse before effect. A valid shape naming an unknown slot is a policy/lifecycle refusal. Each bound is checked separately, not inferred from one representative field. |
| T24 / AC-05 and W1 | Missing/stale frame hash or generation; fresh envelope nonce/seq but duplicate proposal_id; repeated nonce in Reserve; click just outside a 10x10 frame; unsupported body kind. | cargo test --test admission_matrix; from daemon-adapter go test ./internal/daemon ./internal/ipc -count=1 | STALE_FRAME, POLICY for proposal replay, OUT_OF_BOUNDS, or production replay refusal before dispatch as applicable. Pin “closed v0.2 envelope/body refused” (daemon-adapter/internal/ipc/policy.go:266), “replay or capacity refused” (daemon-adapter/internal/daemon/client_authority.go:109-110), “replay rollback unverified” (:155), and “replay byte capacity refused” (:166). daemon-adapter/internal/ipc/session.go:40 logs “adapter: connection refused” for pre-auth failures; no typed application reply exists there. Do not replace these with invented strings. |
| T25 / AC-05 | Route sample M-1 followed by an advanced clock that would cross M; stateless request at M and M+1; poll entry at M with two queued waiters; a below-ceiling poll whose second hypothetical sample crosses M. | cargo test --lib rv8_route_samples_clock_once_and_never_mutates_on_ceiling_crossing; cargo test --lib nv_poll_tick_samples_clock_once_and_never_loses_waiters_on_ceiling_crossing | One sample per request/tick, identical outgoing stamps; ClockCeilingError at entry with state/replay/serial and waiter queue unchanged; both waiters serviced on one legal sample. Existing tests cover these Rust semantics; Python generator requires T03. Surface_id empty/129 chars/mismatch must give bad_shape or identity_mismatch in test_observe.py. |
| T26 / AC-11 and all rebounded rails | Every changed maximum/minimum, maxItems, maxLength, maxProperties: exact boundary and one beyond; 32768/32769 copies of a two-byte scalar; high/low lone surrogates and one valid astral pair; duplicate decoded keys; NaN/Infinity; Base64 YQ== with count 1/2; complete JSON plus trailing nonwhitespace. | python3 -m pytest tests/test_checker_t6.py tests/test_contract_mutants.py tests/test_fresh_divergences.py tests/test_decoder_conformance.py -q; cargo test --test decode_envelope; from daemon-adapter go test ./internal/ipc | Correct boundaries accept where other independent constraints allow them; one beyond or malformed representation refuses. Runtime-only container depth 32/33 and object/array caps should be exercised independently of closed-schema rejection. Mutant failures are assertions, not parse/collection errors in the test code. |
| T27 / AC-09 | Corrupt one journal record/witness/digest; duplicate admitted input; inject first and background fsync failure; interleave frame/control/frame records across a flush barrier. | cargo test --test t1_journal_verify; cargo test --test replay_table; cargo test --test human_input_real_adapter | Corrupt replay fails; no duplicate execution/settlement; subsequent append/flush reports JournalError::Poisoned; replay preserves core_seq order and barrier completion. Current poison/order logic has pins, but T04/T05/T02 remain. These are test-suite expected rc 0 for correctly asserted refusals, not a claim that corrupted replay succeeds. |
| T28 / AC-05 receipt evidence | Minimal valid receipt with no native_evidence; valid minimal evidence; present empty evidence; delete each required inner member; timestamp M/M+1; receipt with no independent expectation witness. | python3 -m pytest agents/tests/test_native_receipts.py agents/tests/test_tg_contracts.py -q; cargo test --lib receipt_evidence; from daemon-adapter go test ./internal/daemon ./internal/capsule | Absence/minimal valid structure accepted; malformed present evidence refuses; no witness must leave verified=false. Evidence presence is not a success proof. Existing structural tests are present; real native timestamp provenance was not executed. |
| T29 / AC-05 planner/element projection | Environment argv non-JSON, [], [""], or an argument containing a NUL assembled at runtime; planner response duplicate/extra keys, malformed target box, bool/non-finite/out-of-[0,1] score, wrong frame/hash; valid score 0 and 1. | python3 -m pytest agents/tests/test_verify_v02_loop.py agents/tests/test_wender_bridge.py agents/tests/test_vcore_v02_element_table.py -q | argv -> bad_shape before launch with no configured-planner fallback; wrong binding -> identity_mismatch/bad_shape as specified by the checked boundary; score endpoints project to 0/1,000,000 integers. Malformed action/expectation needs T16's exact-code repair. Final success only from core wait_verify receipt. |
| T30 / AC-01 | Lock commit uppercase, 41 hex chars, trailing LF, bool, duplicate component/key; valid-length mismatching commit; missing/multiple/dirty provenance. Also probe NaN in an ignored provenance field separately. | python3 -m pytest agents/tests/test_deps_lock.py agents/tests/test_tg_cli.py -q | Invalid identity spelling -> DependencyLockError bad_lockfile; malformed/ambiguous provenance -> unavailable; a valid different commit -> commit_mismatch; CLI pin failure is nonzero with version classification and empty stdout. Existing identity checks enforce these. _read_json at agents/metaviewer_agents/perception/deps_lock.py:46-48 does not reject non-finite constants in unused metadata; no claim of strict validation of every ignored field, nor of a forged-pin acceptance, is made. |
| T31 / mathematical pairwise oracle | Enumerate all nine receipt (method,kind) pairs with otherwise valid native evidence, plus absence. Extract observed pairs from direct persisted receipt fixtures. | python3 -m pytest tests/test_contract_mutants.py -q after adding a feasible-pair assertion | All nine generated values decode; current observed set has three pairs and should fail the new completeness assertion, rc 1. Add six missing combinations, retaining absence, then require rc 0. This is an additional coverage target, not a falsely claimed existing contract requirement. |
| T32 / AC-12 | Use existing secrets controls to assemble synthetic credential markers from runtime fragments in temporary directories; keep committed fixture source clean. Also inject one blind scanner/control response. | With a qualified pinned binary: python3 -I tests/fixtures/secrets/gate.py controls --gitleaks "$GITLEAKS_BIN" --repo .; GITLEAKS_BIN="$GITLEAKS_BIN" python3 -I -m unittest discover -s tests/fixtures/secrets -p 'test_*.py' -v | Controls command rc 0 only when plants are detected; blind/missing/malformed tool or report -> gate rc 1, malformed invocation rc 2. A planted secret in an actual history scan must reject rc 1. tests/fixtures/secrets/test_gate.py:37-47 assembles markers at runtime; tests/fixtures/secrets/README.md:25-43 describes control semantics. The scanner/binary is not executed here. |
| T33 / freshness/control load | Two initial confirmations per surface, then unchanged frames; changed RGB; forced post-input capture; release/resubscribe; invalid confirmation count; continuous frame load around take/release; regressed generation with missing pixels. | From daemon-adapter go test ./internal/frames ./internal/daemon -count=1; cargo test --lib w3_control_intent_under_daemon_frame_burst_coalesces_and_preserves_checks | Unchanged live frames deduplicate after required confirmations; forced after-frame is fresh; release resets per-surface state; invalid config refuses; control remains sequenced and regression is not hidden by coalescing. Source supports these cases, subject to T06's cap failure and T02's refusal disposition. No absolute latency bound without scheduling/I/O assumptions. |

## Named planted mutants and designated kills

All mutants are proposed, not executed. Establish a passing baseline and valid build first. The expected mutant exit is the assertion runner's code below; the harness should aggregate a real survivor as rc 1 and must never count a build/import/collection error as a kill. A source edit that cannot compile is not a successful mutation experiment.

| Mutant | Planted defect and input | Designated oracle / command | Expected mutant exit |
|---|---|---|---:|
| M01 T6_SURFACE_INPUT_RAIL | Remove events minItems or seq minimum; empty events / seq 0 with one-event seq 1 positive. | Canonical fixture rejection; python3 tools/check_contracts.py | 1 |
| M02 T6_V1_ACCEPT_WIDEN | Widen canonical surface_input's version const to accept v1 as well, keeping UI alias behavior separate. | Required versioned const audit and a standalone v1 negative; python3 -m pytest tests/test_checker_t6.py -q | 1 |
| M03 T6_SINGLE_SAMPLE_REMOVAL | Replace a route override read with a fresh now() sample; near-ceiling proposal plus verdict/dispatch. | cargo test --lib rv8_route_samples_clock_once_and_never_mutates_on_ceiling_crossing | 101 |
| M04 T6_TICK_CEILING_REMOVAL | Sample inside each waiter send or dequeue before checking M; two ready waiters. | cargo test --lib nv_poll_tick_samples_clock_once_and_never_loses_waiters_on_ceiling_crossing | 101 |
| M05 T6_HUMAN_INPUT_RAIL | Remove i32 conversion for human scroll; dx=2147483648 and -2147483649. | Add no-forward/OUT_OF_BOUNDS assertions; cargo test --lib ui_human_input_requires_human_control_and_forwards_when_admitted | 101 |
| M06 T6_NESTED_DEPTH | Remove depth maximum or weaken exact integer checking; 2, -1, true, 1.0 with 0/1 controls. | python3 -m pytest tests/test_decoder_conformance.py -q | 1 |
| M07 T6_CLOCK_CEILING | Change elapsed>=M to elapsed>M, or remove it. Extend the named test with clock_step_ns.store(1, Relaxed), clock_samples.store(0, Relaxed), and clock_offset=Duration::from_nanos(M); reset the sample counter before each entry assertion. The first synthetic sample is exactly M under core/src/serve/mod.rs:369-384. The existing zero-step/real-elapsed setup alone does not reliably kill the off-by-one mutant. | cargo test --lib rv7_clock_ceiling_fails_closed_without_domain_mutation; after adding the exact-sample and unchanged-state assertions. | 101 |
| M08 T6_REBOUND_OFF_BY_ONE | Accept max+1 or reject exact max for each numeric/length/items/properties rail. | Add field-indexed edge assertions; python3 -m pytest tests/test_contract_mutants.py -q | 1 |
| M09 T6_BYTE_COUNT | Remove decoded-byte equality; YQ== with count 2 versus positive 1. | python3 -m pytest tests/test_checker_t6.py tests/test_decoder_conformance.py -q | 1 |
| M10 T6_SURROGATE_ACCEPT | Remove lone-surrogate refusal; construct escaped U+D800 at runtime, with a valid paired/astral control. | Same checker/matrix command; assert validation rejection, not a test-module syntax error. | 1 |
| M11 T6_VERSION_DEFAULT | Replace the explicit v0.2 argument in a live validate_observation caller with the legacy default. | Add a v0.2 Wender/tools positive; python3 -m pytest agents/tests/test_wender_bridge.py agents/tests/test_observe.py -q | 1 |
| M12 T6_ONEOF_ANY | Replace exactly-one with at-least-one; value 5 under overlapping integer/number branches. | python3 -m pytest tests/test_fresh_divergences.py -q | 1 |
| M13 T6_REF_TYPELESS_BOUND | Omit applicable sibling bound after a successful ref; twelve-key frame with maxProperties 11/12. | T07 extension; python3 -m pytest tests/test_decoder_conformance.py -q | 1 |
| M14 T6_MIRROR_REF_SIBLING | Erase nullable-id maxLength 127 sibling; signal lengths 127/128. | T10 soundness assertion; python3 -m pytest tests/test_python_contract_mirror.py -q | 1 |
| M15 T6_BREAK_DIR_SWAP | Exchange request/response rules on asymmetric interval/presence cases. | Old/new witness and exact direction assertions; python3 -m pytest tests/test_contract_evolution.py -q | 1 |
| M16 T6_BREAK_IGNORE_REQUIRED | Ignore optional -> required layout index while leaving its value schema fixed. | Missing-index witness plus response reverse; same evolution command. | 1 |
| M17 T6_EVOLUTION_ONEOF_DROP | Return nonbreaking after removing the move branch. | T11 independent accepted/rejected move witness; same evolution command. | 1 |
| M18 T6_CONFORMANCE_ADAPTIVE_EXPECTATION | Change a fixed negative expectation to acceptance without changing input. | Matrix's explicit unanimous-refusal assertion at :502; python3 -m pytest tests/test_decoder_conformance.py -q | 1 |
| M19 T6_PROPERTY_COUNT_BLIND | Remove min/maxProperties comparison from evolution helpers. | Existing asymmetric property-count controls :350-382; python3 -m pytest tests/test_contract_evolution.py -q | 1 |
| M20 T6_LIVE_CLEANUP_SWALLOW | Report successful cleanup while the publication directory remains; retain a normal cleanup positive. | Mocked cleanup assertions at tests/e2e/test_live_stack.py:303-326; python3 -m pytest tests/e2e/test_live_stack.py -q | 1 |
| M21 T6_TRAILING_ANCHOR | Restore native Python dollar behavior on exact-end ids; append LF, or 41st hex char/uppercase to a pin. | python3 -m pytest tests/test_fresh_divergences.py agents/tests/test_deps_lock.py -q | 1 |
| M22 T6_UTF8_CAP | Count codepoints only at the transport byte check; 32769 two-byte scalars versus 32768. | python3 -m pytest tests/test_decoder_conformance.py -q | 1 |
| M23 T6_MATRIX_PRUNE | Omit the new origin_unknown negative or the standalone batch family from selection. | Add exact manifest selection assertion; same conformance command. | 1 |
| M24 T6_HARNESS_SURVIVOR | Add a valid no-op mutation after a healthy baseline. | python3 agents/tests/run_mutant_harness.py | 1 |
| M25 T6_HUMAN_ORIGIN_FLIP | Forward admitted human input as origin agent. | Real adapter application/settlement positive; cargo test --test human_input_real_adapter | 101 |
| M26 T6_POISON_CLEAR | Ignore/clear sticky worker fsync failure. | cargo test --test t1_journal_verify failed_flush_sync_poisons_journal -- --exact | 101 |

M20 is a mocked boundary unit test, not a live Docker run. M25 and other real-adapter tests require their toolchains and fixtures; they are not silently skipped or counted as passing when unavailable. M01/M02 may fail a schema audit at runtime, which is a legitimate checker kill; a malformed test file or compile error is not.

## Follow-up command set

These are the requested broad commands, preserved as proposed actions only. First Rust/Go dependency acquisition may require network; do not override GOTOOLCHAIN to conceal a toolchain failure.

    python3 tools/check_contracts.py
    python3 -m pytest tests/test_check_contracts.py tests/test_contract_mutants.py tests/test_contract_evolution.py tests/test_contract_round1.py tests/test_contract_skew_and_subset.py tests/test_contract_canonical_pins.py tests/test_python_contract_mirror.py tests/test_layout_intents.py tests/test_decoder_conformance.py tests/test_checker_t6.py tests/test_fresh_divergences.py -q
    python3 -m unittest discover -s agents/tests
    cargo test
    (cd daemon-adapter && go vet ./... && go test ./...)
    bash tools/gate.sh

Run the direct mutant harness explicitly as well; default unittest discovery does not run it. Before accepting any report of a kill, distinguish an assertion from a missing binary, timeout, import/collection failure, or unavailable private component.

# Not verified

- **No execution:** no repository code, tests, builds, mutation harness, scanner, or live processes were run. Source-derived “actual” results and source test assertions are not measured passes. All proposed negative controls and the full fixture vector need execution on the pinned checkout.
- **Private/live dependencies:** actual Docker capsules, capsule CLIs, private capsule UI kit, real vision-engine/wender-agent checkouts, provider CLIs, and live end-to-end tests were unavailable to this static connector review. tests/integration/test_mvctl_core.py requires a built core; real-adapter tests require their builds and controlled capsule fixtures. Resolver integration needs genuine pinned checkouts/provenance.
- **Failure schedules and performance:** the long fsync stall, idle flush bound, hard-cap pressure, event-loop scheduling and live control latency were reasoned about, not injected or timed. The claimed 50 ms completion bound also needs explicit storage assumptions. No fresh hash-count, throughput, RSS or optimizer benchmark is reported.
- **Mathematical limits:** the six mandated Context7 queries did not provide a fragment-specific tight complexity theorem, a global minimum fixture cover, or a general mutant-subsumption result. The finite-domain inclusion proof, coverage counts, resource arithmetic and conditional fuzz bound are supplied as derivations. Statistical independence and defect exposure probability must be justified by a future generator.
- **Scope of nonfindings:** no current accepted 33-container canonical envelope was established; the current graph bound is seven. No internal production use of build_observation's legacy default was found. No current out-of-order same-surface adapter error was established. The typed-ref residual concerns permitted future/schema-override constraints, not an already present canonical sibling. Existing UI v1 compatibility is translated at the host; it is not raw v1 acceptance by Rust. A canonical scroll batch can be admitted structurally while the current adapter refuses that unsupported effect.
- **What unblocks verification:** a checkout of the exact reviewed SHA, declared toolchains and dependency caches, qualified secrets scanner, required private components and live infrastructure, plus the T01-T33 assertions and named mutants above. Record every outcome with the exact source SHA, input identity, command, runner exit and designated assertion; keep infrastructure failures separate from kills. Publish only the report file required by this task.


```json findings
[
  {
    "id": "T6-R3-001",
    "severity": "P0",
    "file": "agents/metaviewer_agents/client.py",
    "line": 458,
    "title": "Production recording replies cannot correlate",
    "evidence": "ToolClient.request requires result.op == request.op, but every closed record_event/v0.2 branch has event and no op. Valid start, stop and refusal replies become uncorrelated tool result; mvctl exits 2 after a possible effect.",
    "fix": "Correlate record_event by its own request/surface/recording/event contract; retain op matching for mv_tool_result and test the production socket client."
  },
  {
    "id": "T6-R3-002",
    "severity": "P1",
    "file": "core/src/serve/mod.rs",
    "line": 1042,
    "title": "Recoverable frame refusal terminates the shared daemon",
    "evidence": "Core sends action_verdict/v0.2 to the daemon for a refused frame. Production daemon-adapter/internal/daemon/stream.go:209-213 permits only hello, surface_request and record_request, then cancels and daemon-adapter/internal/daemon/run.go:73-75 exits 2. The core regression test expects a subsequent reply on the same connection.",
    "fix": "Define and handle a legal daemon refusal/ack body, or keep recoverable frame refusals on an agreed channel; test the real adapter's continued operation."
  },
  {
    "id": "T6-R3-003",
    "severity": "P1",
    "file": "agents/metaviewer_agents/envelope.py",
    "line": 828,
    "title": "Python silently re-origins an expired session clock",
    "evidence": "When elapsed monotonic time exceeds MAX_SAFE_INT, make_envelope resets _SESSION_ORIGIN_NS at 830 and emits zero at 832. contracts/v0.2/envelope.schema.json:16 forbids re-origining the same session.",
    "fix": "Keep a fixed origin per session, refuse at the operational ceiling, and require an explicit new session for a reset."
  },
  {
    "id": "T6-R3-004",
    "severity": "P1",
    "file": "core/src/journal/mod.rs",
    "line": 1407,
    "title": "The frame durability window has no idle flush trigger",
    "evidence": "The 50 ms check is evaluated only during append at 1407-1412; the worker waits on recv and idle server ticks only poll tool waiters. One pending final frame can remain without a durability flush indefinitely.",
    "fix": "Dispatch a nonempty frame group on an independent timer and distinguish dispatch latency from storage-completion latency."
  },
  {
    "id": "T6-R3-005",
    "severity": "P1",
    "file": "core/src/journal/mod.rs",
    "line": 1035,
    "title": "Shutdown timeout detaches a writer that can outlive the archive lock",
    "evidence": "join_sync_worker takes the worker, returns on timeout before handle.join(), and loses the handle. Drop later explicitly unlocks WriterFile at 421 while execute_sync_batch can still write and rename checkpoint files.",
    "fix": "Preserve worker and writer ownership until quiescence; a timeout must not permit Drop to detach a writer and release exclusivity."
  },
  {
    "id": "T6-R3-006",
    "severity": "P1",
    "file": "daemon-adapter/internal/frames/publisher.go",
    "line": 424,
    "title": "Publication exceeds hard byte caps when no eviction victim exists",
    "evidence": "Per-surface eviction is gated on at least two old refs at 386. The global loop breaks without a victim at 424-425 and still commits at 461-466. Config validation permits caps smaller than one valid frame.",
    "fix": "Reserve capacity before committing; if protected floors prevent eviction, refuse the new frame and remove its allocation instead of exceeding the cap."
  },
  {
    "id": "T6-R3-007",
    "severity": "P1",
    "file": "core/src/wire/mod.rs",
    "line": 447,
    "title": "Typeless reference siblings still split the supported schema evaluators",
    "evidence": "Rust's valid() enforces type-dependent siblings only in its local type switch, returning true for None at 516; Go daemon-adapter/internal/ipc/policy.go:342-344 does likewise. Checker and Python apply sibling bounds by value type after resolving the reference.",
    "fix": "Conjoin every applicable sibling keyword with the referenced target, independently of a repeated type; extend the shared override matrix."
  },
  {
    "id": "T6-R3-008",
    "severity": "P1",
    "file": "contracts/v0.2/surface_input.schema.json",
    "line": 86,
    "title": "Human-input batch rails disagree on joined chords and Unicode length",
    "evidence": "Canonical keys are independently length 1..32, but UI and admission cap the joined chord at 32. Canonical text maxLength 1024 counts codepoints; ui/electron/authorityWire.js:166 and ui/electron/preload.js:574 count UTF-16 units.",
    "fix": "Specify and enforce the joined-chord semantic rail across checker and host, and use the same Unicode-scalar length semantics for text while retaining documented byte caps."
  },
  {
    "id": "T6-R3-009",
    "severity": "P2",
    "file": "agents/metaviewer_agents/observe.py",
    "line": 79,
    "title": "Explicit v0.2 observation helper retains unbounded legacy validation",
    "evidence": "_check_int checks minima only, and validate_observation reuses legacy string/list checks for v0.2. A generation of 2**53 with the same trusted generation is accepted; Wender plan_step calls this helper at 214-215.",
    "fix": "Apply canonical v0.2 validation in the helper in addition to trusted-frame and containment checks."
  },
  {
    "id": "T6-R3-010",
    "severity": "P2",
    "file": "tests/test_python_contract_mirror.py",
    "line": 32,
    "title": "Mirror normalization erases reachable local-reference siblings",
    "evidence": "normalized() returns the local target immediately. Adding maxLength:127 beside contracts/v0.2/terminal_session.schema.json:21's nullable-id ref is invisible to both raw/effective equality checks, although signal length 128 changes the denotation.",
    "fix": "Normalize reference targets together with all sibling constraints; retain a semantic boundary witness for the normalizer itself."
  },
  {
    "id": "T6-R3-011",
    "severity": "P2",
    "file": "tests/test_contract_evolution.py",
    "line": 168,
    "title": "Evolution helpers ignore oneOf branch removal",
    "evidence": "Both breaking-direction helpers inspect root properties/required/counts but not root oneOf. Removing ui_intent's move branch returns nonbreaking in both mirrored directions.",
    "fix": "Include union/exact-one semantics or use an independent inclusion/witness checker; pin asymmetric removed/added branch cases."
  },
  {
    "id": "T6-R3-012",
    "severity": "P2",
    "file": "tools/gate.sh",
    "line": 1420,
    "title": "Routine local and PR discovery omits the actual mutant harness",
    "evidence": "gate.sh invokes default unittest discovery; run_mutant_harness.py is run_* and only calls main under its main guard. CI and volume explicitly run it only for schedule events.",
    "fix": "Invoke the actual matrix in the intended local/PR gate with a bounded budget and preserve baseline/survivor outcomes."
  },
  {
    "id": "T6-R3-013",
    "severity": "P2",
    "file": "agents/tests/test_tg_contracts.py",
    "line": 72,
    "title": "The raw version-purity pin misses JSON escape spellings",
    "evidence": "The pin searches raw text for /v0.1. A schema discriminator whose slash is serialized as a JSON Unicode escape decodes to the forbidden version while avoiding that substring.",
    "fix": "Strictly parse and recursively inspect discriminator values in addition to raw-text hygiene checks."
  },
  {
    "id": "T6-R3-014",
    "severity": "P2",
    "file": "tests/test_decoder_conformance.py",
    "line": 473,
    "title": "Stale fixture floors miss loss of a newly added negative",
    "evidence": "The matrix floor is 475 and Go floors are 475 fixtures, 476 entries, 20 schemas. The reviewed tree has 488 fixtures and 21 schemas. Removing origin_unknown leaves 487 and preserves the isolated count controls.",
    "fix": "Pin fixture identities and per-schema negative obligations in a shared manifest, with a deliberate missing-fixture negative control."
  },
  {
    "id": "T6-R3-015",
    "severity": "P2",
    "file": "agents/metaviewer_agents/mvctl.py",
    "line": 491,
    "title": "Parsed malformed CLI configuration receives a transport classification",
    "evidence": "Only config read/JSON errors are mapped to usage_error. A parsed empty object raises KeyError outside that scope and the broad exception path maps it to transport_error.",
    "fix": "Validate complete registration structure before opening transport and map configuration failures consistently to usage_error."
  },
  {
    "id": "T6-R3-016",
    "severity": "P2",
    "file": "agents/metaviewer_agents/wender_bridge.py",
    "line": 268,
    "title": "Malformed planner action or expectation loses its typed refusal code",
    "evidence": "The bridge invokes tool validators directly; their ToolValidationError has detail but no code. The existing test asserts only ValueError.",
    "fix": "Translate tool validation errors into ObservationError(bad_shape) at the planner boundary and pin the exact code."
  },
  {
    "id": "T6-R3-017",
    "severity": "P2",
    "file": "agents/tests/run_mutant_harness.py",
    "line": 32,
    "title": "Discovery and runtime errors can be counted as successful mutant kills",
    "evidence": "_run_suite combines failures and errors; main labels any positive total conforming at 229. A mutation-specific discovery/import error can therefore satisfy the kill claim without a designated assertion running.",
    "fix": "Report assertion failures, errors, collection failures and infrastructure failures separately; only the designated runtime assertion is a kill."
  }
]
```

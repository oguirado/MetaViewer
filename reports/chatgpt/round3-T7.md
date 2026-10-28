Reviewed: bridge/integration @ ae9361bb3d645eee1976ec8d739dc358b572561b

# Summary

**T7 CI-SUPPLY round-3 refresh — static review.** The delivery contains **23 findings: P0 1, P1 19, P2 3**. The strongest integrity defect is the supported external Electron distribution route accepting its own checksum assertions. Other release-relevant gaps are incomplete live receipt validation/collection, successful-parent process leaks, unsanitized manifest children, invalid performance evidence, and inconsistent deadline/cadence budgets. These are source-derived counterexamples, not observed exploits or executed test results.

All repository coordinates below refer to the [immutable reviewed tree](https://github.com/oguirado/MetaViewer/tree/ae9361bb3d645eee1976ec8d739dc358b572561b). **Observed** means read in source or commit metadata. **Inferred** means a control-flow consequence or conditional mathematical argument. No repository code, test, build, scanner, live gate, proposed mutant, or CI job was executed for this review. A command's expected result is a test oracle, never a claim that it ran.

The initial branch ref resolved to the full SHA above. Connector comparisons establish that it descends from minimum 4f4c984cea539a68832901d0383d2f09e0db19ec by 22 commits; the day-2, prior-refresh, and newest-refresh bases are respectively 409 commits behind at 38c79277, 299 at 7acc35f7, and 132 at cfd582ec. These are repository metadata counts, not test counts. The compare APIs cap their file lists at 300; that cap is not evidence that omitted files were unchanged. Commit patches, path-specific history, and pinned source reads supplied the review evidence in place of executing git log/diff. Exact whole-tree diff statistics beyond that cap remain unverified. Additional in-scope changes after the minimum include 2c07d749 and 969b7d0c; the former introduces the composed RSS deadline problem.

Only this report is to be committed. The report-owned unit is reports/chatgpt/round3-T7.md; its evidence closure is the T7 source/test/workflow surface specified in the task. No generated routing files or product code are part of delivery. The independent delivery check is: parent equals reviewed SHA, exactly this one added path, exact requested message, and a re-read of the committed report. The negative delivery control is any additional changed path or different parent.

## Fix verification — newest eight

**CLOSED means FIXED for the named, source-verifiable property. NARROWED and STILL OPEN map to STILL_OPEN for a broader closure claim.** None of these labels means that the old/head comparison tests ran. The proposed differential controls use cfd582ec for this table, 7acc35f7 for the prior refresh, 38c79277 for day 2, and f3f3a4e for applicable round-1 claims.

| Commit | Verdict | Closing evidence and remaining limit |
|---|---|---|
| abea8ea2 | CLOSED, timeout wiring only | tools/gate.sh:62,1286 and ui/package.json:11 all contain the 120000 ms test timeout; gate.sh:1264–1268 requires Node >=24. This is per-test protection inside an outer bounded command, not a measured 120 s whole-suite runtime. Socket fixtures/demo are outside this review. TP29. |
| 8e4d9790 | CLOSED, discovery/global-empty rule | tools/gate.sh:1028–1040 explicitly discovers tests/e2e/e2e1_slice, exits 2 for zero total tests, and rejects skips/expected failures. This does not fix the separate agents discovery path. TP28. |
| 9ac428d5 | CLOSED, actual aggregate/order oracles | tests/test_t7r2c_exit_codes.py:38–100 calls real main, visits every leaf, and kills a precedence mutation; tests/test_ci_volume_e2e.py:107–157,338–462,637–665 extracts the real volume script, tests both architectures, both rungs and smoke refusal. Leaf timeout classification is a separate residual, T7R3-002. TP19/TP26. |
| 68d235c9 | CLOSED, explicit clean-repro flags | tests/ci/test_fx2_package.py:80–90 depends on MV_REQUIRE_CLEAN_CI_REPRO/MV_RUN_CLEAN_NPM_CI_REPRO, not CI alone; :125–162 supplies both explicit-flag negatives and CI=true/no-flags positive. Hosted execution itself is unverified. TP27. |
| e3885467 | NARROWED | Gate-ID/name matching ci.yml:2742–2746, per-arch package output :2700–2702, prior subreaper restoration gate.sh:1183–1186,1207, and volume.yml:317 reason selection are real. Successful-parent descendants and same-process concurrent non-LIFO overlap remain R1-106; generic receipt semantics and upstream receipt collection remain R1-092/093/098. TP01/02/06/26. |
| d26546e2 | NARROWED | tests/ci/test_t7r2c_workflow_pins.py:46–59,173–209 handles parser crashes and scalar/list/map on forms; receipt extractor test_t7r2c_receipt_identity.py:17–32 accepts run block chomping and stops before trailing step keys. Counts parser tests:1310–1340 cover quoted comments/block needs. Flake deadline is used at tests/test_t7r2c_reproducibility.py:310–333. NODE/NVM candidate admission remains T7R3-012. TP09/20/30. |
| 561d0b76 | CLOSED, disappearance race | tests/perf/rss_probe.mjs:51–53,79–96 treats only ENOENT/ESRCH as gone and still requires main/renderer; tools/budget_gate.py:187–194 does the matching process lookup handling. tests/test_budget_gate.py:94–168,270–345 distinguishes disappearance, EACCES, missing roles and receipt retention. No live 120 s receipt was obtained. P3/TP24. |
| cd4eec02 | NARROWED | ci-required and final step both always run (:2440,:2698); empty set :2788–2790, missing required ID :2811–2816, non-PASS :2759 reject. tests/ci/test_ci_counts.py:955–1096 covers both architectures. The actual required receipt list is only budgets (:2703), not the broader synthetic test set (:983–999), and check_receipt remains weaker than F4. P1/TP01/02. |

## Fix verification — seventeen already listed

| Commit | Verdict | Evidence at reviewed head |
|---|---|---|
| a8a8abf7 | NARROWED overall; router subclaim CLOSED | tools/router_index.py:536–553 deduplicates and caps distinct exclusions; :377–467 strips test items without truncating production at arbitrary text. tests/test_router_index.py:982–1079 has comment/string/production-symbol controls. Timeout descendant rescans gate.sh:1121–1162 improve cleanup; success-path escape remains R1-106. No 25/25 live rerun is claimed. |
| 1420c239 | CLOSED for named scheduling/cache/range repairs | volume.yml:313–315 schedules the CPU stress flake hunt; tests/ci/test_fx2_package.py:67–90 reports typed cache/Electron prerequisites, refined by 68d235c9; ci.yml:671–684 and test_t7r2c_receipt_identity.py:265–342 validate laws ranges and consistent receipt/continuation. Actual cache availability and hosted success remain unverified. The agent-mutant schedule guard predates this commit. |
| c2f1caf3 | CLOSED for T7 parser/interpreter and isolated-identity repairs | Two adopted workflow suites use stdlib extraction; ci.yml:517–531 resolves MV_YAML_PYTHON before changing PATH, :1420 uses it for CI tests. tests/ci/test_t7r2c_argon_volume.py:70–104,118–148 also sets temporary commit identity, isolates global configuration and rejects the wrong author. This removes the named developer-environment dependencies, not PyYAML provenance; the nested E2E wait change is outside the T7 timeout-only scope. |
| 1e912f73 | NARROWED, R1-096 | package.js:943–978 authenticates installed wrapper version/integrity/files, :1072–1113 verifies cached ZIP/tree. External no-wrapper branch :927–928 and self-asserted tree/files :1034–1055 remain admitted. |
| d39a0245 | CLOSED for cross-architecture compile/link coverage | gate.sh:1310–1334 executes host vet/race tests and other-architecture vet/test compilation; plants :489–510 cover arch-specific syscall and unresolved-link failures. The foreign binary is not executed; native runtime evidence remains separate. |
| 1f35bfbd | CLOSED for mode-bearing inventory parsing | test_package_identity.py:431,443–450 accepts/checks octal modes and exact file-set equality. :204–250 exercises valid modes, garbage, extra/missing files and mode mismatch. Legacy mode omission is a qualified helper limitation, not a demonstrated whole-pipeline bypass. |
| 0da9e5b6 | NARROWED | Actual explicit Node/Python selectors and setup SHAs across all four workflows are pinned. gate.sh scrub and cleanup exist but have R1-106/107 gaps. live-main.cjs:4–13 validates input paths, while its later readiness/load promises still have the ARG-ci-5 termination risk. |
| b4de49c8 | NARROWED | ci.yml:1364–1367 prepares Rust before JS regressions; tests/ci/test_round2_t7_regressions.py:360–449 checks the real frozen leg. e2e14_perf.test.js:24–35 admits hosted arm64 at 8 FPS, but mandatory ci.yml:1908,2677 still requires 10 FPS: T7R3-015. |
| ecea68a4 | CLOSED for the test-fixture format repair | tests/ci/test_pkg_install.py:650–679 now parses mode-bearing rows, normalizes sealed bytes and reports the precise mismatch. This repairs fixture drift; it does not validate the generated sha256sum command, T7R3-008. |
| 591b4662 | CLOSED, order | ci.yml:1401–1417 primes/verifies dependencies before the tests/ci discovery at :1420. Setup failure still prevents a successful downstream job. |
| 3086b0a6 | CLOSED, smoke marker | package.js:647–649 writes the marker synchronously before exit; :1215–1262 checks exact marker and child status with bounded diagnostics. test_package_clean_install.mjs:532–847 distinguishes missing marker, failed child and pipe flush. |
| 2c0864d7 | NARROWED | Budget checks, x100 repetitions, scheduled mutants and actual soak are wired at ci.yml:1877–1927,2529–2696 and volume.yml:289–319,569–675. Malformed telemetry, misleading fixture labels, mutant-cohort vacuity and cadence mismatch remain T7R3-010/014/015. |
| fef0d182 | CLOSED, seals/exec-bit claim | package.js:189–294 validates fuse layout, ASAR-only inventory and seals; :467–536 checks executed bytes before import; :94–109,126–140,1557 normalizes modes and records them. R1-104 closes for release artifacts; T7R3-008 is a separate documentation regression. |
| 7c667554 | NARROWED, scope of AC-01/13 evidence | test_ci_counts.py:835–1185 executes final aggregation with rendered inputs, rather than only matching source text. test_pkg_install.py:1105–1108,1190–1193 compiles fixture wrappers and a fixture capsule; package.js:1404–1417 swaps the real adapter for a generated smoke adapter. Native private-capsule AC-01 remains unverified. |
| ee243bb7 | NARROWED overall; named local fixes CLOSED | F4 receipt_errors and aggregate recompute/check semantics at ci.yml:289–420; all sanitizer copies include repaired families; Go priming exports offline/readonly flags, e.g. :513–516. These do not transfer the F4 guarantees to the actual final check_receipt implementation. |
| 14403843 | NARROWED for unconditional teardown | gate_g_ai.py:307–309,323–324 requires RAM absent/no remaining RAM paths; companion g_ai_stack.py:100–110,167–194 records early ownership and cleans normal paths. A cleanup exception or process signal can interrupt sequential teardown. No false successful cleanup is established, but universal cleanup is unproved. |
| ce032b99 | CLOSED, separate package matrix wiring | package.yml:18–24 selects x64/arm64 native runners, :90–99 executes the gate even after setup failure, :191–219 rejects failed prerequisites/unsupported architecture and propagates verify/smoke failure. Both-arch stub controls are in .github/workflows/test_package_regressions.py:237 onward. |

## Day-2, prior-wave and named round-1 verification

| Target | Verdict | Closing lines / residual |
|---|---|---|
| 07a5cc21 | NARROWED | A1–A8 are real at gate_g_ai.py:191–302, including post-state and battery changes :297–301. Missing-control and stale-mock gaps are T7R3-006; live private execution remains unverified. |
| 2e73e198; 7d043bfc | CLOSED for per-arch structural product handoff | test_package_identity.py:351–463 binds current revision, local bytes, archive hash, arch, evidence and inventory; :466–500 builds/verifies/smokes. ci.yml:2523–2528 selects each architecture's receipt. This is independent reproduction on another runner, not a separate signer or proof of uncompromised builders. |
| 3cf2e767 | CLOSED for fixture repair | test_package_identity.py:173–202 supplies separate x64/arm64 ELF/evidence fixtures and CLI refusal variants. Runtime outcomes were not rerun. |
| 65e5c910 | NARROWED | ci.yml:503,843,1033,1638,2092,2487 pins setup-go plus go-version-file; :538,864,1365 pins rustfmt 1.92.0. Actual jobs have the requested preparation. General consumer/comment detection remains T7R3-004. |
| c444fcaa | CLOSED for stated repairs | ci.yml:491–500 checks pinned gitleaks archive before extraction under fail-closed shell; :1718–1725 builds node-pty 1.1.0 using offline explicit lifecycle/load checks; install_electron.cjs:34,40–41 enforces executable and exact singleton version line; run_process_gate.sh:34–47 preserves compiler diagnostics and rc. |
| 5c7f598a | NARROWED | agents joins BASE_LEAVES gate.sh:44; missing/failing suite refuses :1417–1424. Empty/skipped/xfail suites remain T7R3-001. |
| a93da752 | CLOSED, all kit-reference classes | ui/kit.lock.json:2–5 is repo, bf31bc201987206d16dbd88d93102f9d5ce026f9, version 0.2.1, contentHash 1bee78c76a0a2a41d085beed918ca6ca791beaf53b952d4a9367dad660fd6dc2. ci.yml:1382,1672 and volume.yml:355 match; tests/test_kit_source.py:210–216 asserts it; gate.sh:406,428–433 uses 0.2.1 fixtures. Dynamic checkout jobs read the same lock. |
| bcb8c4ec | CLOSED for wiring repairs, not hosted performance | ci.yml:227–231 has exact 60/60/180 job timeout map; native priming and ownership fixture are present; optional other-platform jobs remain nonblocking. The wall timing and provenance limitations below are separate. |
| fdc3c61e | CLOSED for leg inclusion | gate.sh:45,1310–1334,1365–1409 runs Go and requires both smoke markers; missing tool/marker controls :475–585. R1-106 and timeout-class residuals remain. |
| 2413e790; 74ebe06e | CLOSED for original workflow/sanitizer addition, superseded architecture restriction | package.yml/build-other.yml have executable gated paths and equal sanitizers. x64 is now supported by ce032b99; do not reapply the old intended x64 skip. Optional platform jobs are deliberately outside required-set acceptance. |
| f833e3b4 | NARROWED, volume bootstrap/runtime claim | volume.yml:341–414 provisions pinned kit/toolchain/Electron prerequisites; :538–568 runs smoke then qualification. Tests exercise the script with external commands stubbed. Private live component execution and its measurements remain unverified. |
| 8e6d4b65; offline UID | CLOSED for UID/fail-closed setup | offline.sh:4–12 rejects root/no argv, keeps caller UID, executes payload only after successful namespace creation and loopback setup. test_nv_offline_uid.py:19–69 has same-UID/network and failure sentinels. |
| bd561d96; target isolation | CLOSED | gate.sh:117–121 gives fixtures private targets; test_gate_target_isolation.py:24–48 alternates planted/nominal builds and :50–63 separately allows an explicit target for a normal leg. |
| 3249884a / 7c1b101c; gitleaks exception | CLOSED for requested scoped exception | .gitleaks.toml:8–43 uses original rules plus companion exact-path rules with secretGroup 1; gate.py CONFIG_TEXT is byte-identical. test_gate.py:996–1033 checks exact/nearby paths, uppercase/length and nonhex credentials. No new bypass of the deliberately exempt lowercase digest shape was established. |
| f270ca92; R1-090; R1-013 | CLOSED for semantic parsing/glob/Docker restriction | workflow_pins.py:14–63 uses semantic safe composition and restricted fullmatch; ci.yml:253 scans both suffixes. Docker/tag/expression references reject. Distinct local metadata closure issue is T7R3-003. |
| 4ce25e23; R1-012/R1-091/R1-100 | CLOSED for declared lock admission | gate.sh:878–905 checks exact component fields/name/repo/version/full SHA and missing/extra/duplicates; :866–872,980–981 exact npm sets include asar; :939–948 resolves offline/locked; :976–977 fullmatches Go module. Used-byte provenance is a stronger separate obligation. |
| R1-014; R1-094 original sanitizer drift | CLOSED | The repaired families exist in all 18 equal bodies; no copy drift remains. T7R3-005 is new evidence for encoded/split representations. |
| R1-095 | CLOSED for main Rust leg; broader consumers NARROWED | gate.sh:1259–1260 uses locked/offline; frozen metadata :939. Packaging/supervisor consumers omit freezing, T7R3-009. |
| R1-096 / R1-097 / R1-104 | NARROWED / NARROWED / CLOSED | Respectively external input trust (package.js:927–1055), two-step publication/durability (:1160–1171), and production executable-mode binding (:126–140,735,1557). |
| R1-098 / R1-099 / R1-106 / R1-107 | NARROWED | Live identity, full tool closure, process lifetime and actual manifest environment are detailed in their retained-UID findings. |
| R1-109 | NARROWED, live result unverified | volume.yml:341–414 now wires bootstrap; :525–531 emits BLOCKED for missing harness/display prerequisite. It is incorrect to call volume-e2e unconditionally blocked at this head. volume-property :154–160 still is explicitly blocked. |
| ARG-ci-2 | CLOSED | volume.yml:364–372 canonicalizes the independently read actual origin before comparing it with the lock; sync_kit.mjs:133–139 repeats provenance. This is the ID the supplied task explicitly associates with the origin tautology. |
| ARG-ci-4 | STILL OPEN verification obligation — definition absent | No supplied original defect definition establishes this ID's mapping. Electron executable/version controls are verified under c444fcaa, not assigned to this ID by inference. |
| ARG-ci-6 | CLOSED | ci.yml:671–684 records blocked laws-range on selection/ref failure and continues into version/contracts at :685–704; tests/ci/test_t7r2c_receipt_identity.py:265–342 checks receipt and continuation. |
| ARG-ci-8 / ARG-ci-3 | STILL OPEN verification obligation — original definitions absent | The supplied prompt names these IDs without their original defect definitions. tests/ci/test_t7r2c_argon_volume.py:263–308 independently checks why-failed classification, and tests/test_ci_volume_e2e.py:338–462,637–665 checks real rung order, both arches and smoke refusal. Those observations cannot establish closure of unidentified original claims. |
| Extra 2c07d749 | NARROWED | The settle loop checks a nominal 45 s polling deadline after awaited queries return; total 170 s cutoff does not compose with both waits plus 120 s sampling, T7R3-011. A never-resolving query is not bounded by that local check. |
| Extra 969b7d0c | CLOSED for exiting-helper false orphan | budget_gate.py:180–217 gives recorded identities nominal 5 s grace in requested sleep intervals, treats changed starttime/zombies/gone as absent, and retains role/command for survivors. test_budget_gate.py:170–268 distinguishes 300 ms exit from a 5000 ms survivor. |

Known-open and settled IDs are treated explicitly in **Not verified** rather than assigned invented titles or duplicated as new findings.


## Observed acceptance and coverage ledger

### R1 — pin language, policy parser and actual toolchains

The accepted remote-reference grammar is formalized in I2 below. The checker proves lexical name plus full lowercase hash pairing; it does not establish that a commit belongs to a trusted publisher. No threshold-signature mechanism is implemented by this policy.

| Candidate supplied to real workflow_pins.py | Static verdict and evidence |
|---|---|
| 39/41 hex, uppercase hash, sha256-prefixed value, floating tag/branch, tag with a hash only in a comment | Reject via fullmatch at :14,55–57. A valid hash followed by a YAML comment is accepted; quoted trailing comment is part of the value and rejects. |
| Docker tag/digest forms, expression refs, multiple at-signs | Reject: outside the accepted grammar, :14,55–57. |
| Remote reusable workflow with full hash | Accept, including a nested workflow path; floating reusable refs reject. Local reusable workflow paths are not admitted by the local-action-directory rule. This is a supported-language limitation, not proof of a bypass. |
| Flow/block syntax, quoted or escaped uses key, aliases/anchors, cyclic alias graph | Semantic nodes are inspected; seen identities at :26–32 avoid repeated/cyclic traversal. An aliased unpinned uses value is still rejected. |
| Merge keys, duplicate keys, non-string uses | Reject at :40–48. A complex nonscalar key can instead cause an operational checker failure; F2 rejects a nonzero checker status, so this does not produce a pass. |
| Plain/quoted on key, scalar/list/mapping triggers | The YAML 1.1 on-key exception at :36–39 is deliberate; adopted trigger tests cover these forms. It does not waive uses validation. |
| action.yml/action.yaml, parent escape, absolute path, sole outside symlink | Ordinary in-root local metadata accepts; the escapes reject. The safe-alternate/unsafe-preferred metadata combination and unexamined composite references remain T7R3-003. |
| Invalid YAML syntax, multiple documents, parser crash/unavailable interpreter | Parsing or subprocess fails and F2 rejects at ci.yml:244–251. Safe composition avoids application-object construction; it does not prove workflow schema validity or a parser memory bound. |
| Unknown YAML tag or a non-workflow document without uses | A document such as !custom {} may produce an accepted mapping node. The pin checker is not GitHub's complete workflow-schema validator (workflow_pins.py:21,33–63). No executable YAML exploit is established. |
| Metadata replacement after checking | No checked file descriptor is bound to the eventual executor read. Immutable checkout/runner remains a trust assumption. |

F2 uses the actual checker executable, both workflow extensions, the selected MV_YAML_PYTHON, and a 30 s subprocess timeout (ci.yml:237–255). Its mutant changes the actual regex from 40 to 7–40 characters and requires real-checker rejection, mutant acceptance of the abbreviated hash, mutant acceptance of a valid hash, and mutant rejection of invalid YAML (:269–272). This is a meaningful distinguishing control. A timeout propagates to a failed policy step; it is not silently interpreted as an empty error list.

The current explicit four-workflow Node/Python versions are 24.14.0/3.12.3 and action refs are full SHAs. Go setup binds daemon-adapter/go.mod; that module declares Go 1.26.0. The separate formatter is 1.92.0 and CI native build/clippy provisioning is 1.97.0. The local active cargo/rustc, unversioned runner Bash/Git/tar/zip/unshare/ip/strace/Xvfb, linker/C compiler/headers/libc, rustup distribution trust, and preselected Python/PyYAML are not a content-addressed tool closure (R1-099). Missing versions should be rejected by a presence-aware policy, not only a regex over selectors that happen to exist.

### R2 — F4 semantics versus the live path

| Mutant based on an otherwise valid PASS receipt | F4 receipt_errors/aggregate, ci.yml:289–420 | Live check_receipt, :2738–2763 |
|---|---|---|
| rc=7 or rc=null | Reject | Reject |
| rc=false | Reject: exact integer type | Accept: false equals 0 |
| failed=1 while passed=5 | Reject | Accept |
| negative failed/skipped; mixed numeric/null counts | Reject | Accept if parsed passed remains positive |
| parsed passed=0, skipped=1, failed=0 | Accept in F4: nonzero total suffices | Reject: parsed passed must be positive |
| parsed counts all null | Reject | Reject |
| unparsed counts all null | Allowed as explicitly unparsed | Allowed; this is not measured test-count evidence |
| 64-digit integer hash or 64-hex hash plus final LF | Reject string/fullmatch rule at :319 | Accept str() coercion / match with dollar anchor at :2728–2729 |
| accepted=false or empty assertions | Reject | Reject |
| assertion only contains accepted=true | Reject exact shape | Accept |
| valid-length wrong configuration hash | F4 aggregate recomputes current workflow and rejects with its default oracle; caller reg may overwrite it at :408–409 | Accept generic receipt |
| stale valid-length revision or wrong nonempty platform | F4 only binds identity keys supplied by its oracle; no universal current-revision/platform equality | Accept generic receipt |
| missing scope.platform | Reject exact scope shape at :312–313 | Accept generic receipt |
| missing/duplicate/extra gate ID | F4 exact multiset rejects | Filename mismatch rejects; required membership is a set, extras/duplicate basenames are not an exact-set check |
| upstream job failure/skipped/cancelled | Reject | Shell check rejects |
| NOT_APPLICABLE where only PASS allowed | Reject | Generic checker rejects; novac is represented by job success rather than collected evidence |
| package bytes absent, wrong hash/revision/arch, self-attested receipt alone | distribution_errors rejects | Earlier independent --distribution step rejects and job.status blocks final success |

Consequently the concrete exploit requested for a **non-package** gate is a producer that exits zero with missing/invalid evidence, followed by valid local package/budget work. The final fan-in reads the success string but does not receive that producer's receipt. This is not a claim that an unchanged red shard can pass: :2706–2725 still propagates actual job failure. Similarly, a malformed budget receipt normally requires a producer regression or substitution after its successful producing step; the final generic checker is not an independent integrity boundary against a fully compromised runner.

F1 includes build-macos/build-windows while needs omits them intentionally (ci.yml:5–13,219–220,2439). Secrets is documented as a separately required status, not an F1 job; actual hosting configuration remains unverified. Comments about branch protection do not configure hosting rules. The current tests prove script behavior with supplied statuses, not remote branch protection.

The distribution suite covers separate x64/arm64 artifacts, self-attested-only evidence, wrong hash/bytes/revision/arch/marker, missing proof, modes, inventory mismatch, path escape/symlink, non-PASS, CLI and aggregate paths (test_package_identity.py:87–347). It does not independently mutate every guard in :351–463: duplicate tar/member names, nonregular members, missing final LF, duplicate manifest rows, every invalid path spelling, empty inventory, omitted legacy modes and configuration omission need explicit controls. Optional configuration and mode fields in the helper do not establish a whole-pipeline bypass because production additionally binds archive bytes and applies the outer validator.

### R3 — sanitizer and scanner

All 18 shell sanitizer bodies are byte-identical in the retrieved source:

| File | Definition lines |
|---|---|
| .github/workflows/ci.yml | 72,582,728,892,1072,1223,1442,1757,1949,2124,2242,2347,2545 |
| .github/workflows/volume.yml | 55,190,425 |
| .github/workflows/package.yml | 107 |
| .github/workflows/build-other.yml | 96 |

The F6 Python copy at ci.yml:451–454 uses the same prefix language. tests/test_ci_matrix.py:36–45 alone compares only the first CI copy with package/build-other; complementary test_policy_hardening.py:83–100 and test_t7r2c_sanitizer_secrets.py:37–91 cover the other bodies. This closes actual copy drift, while the complete cross-product of encodings/case/framing is not covered.

Literal repaired GitHub families, case variants and one encoded underscore are redacted. Double encoding, encoding other prefix bytes and prefix splitting survive (T7R3-005). An intact prefix with a suffix split later in the line stream only loses the first recognized chunk. Suffix-only text is not identifiable as a credential by this prefix policy. Clean ASCII and standalone hash strings are preserved; invalid UTF-8 is deliberately decoded with replacement, so arbitrary-byte preservation is not established.

gate.py:79 defines four control IDs: github, entropy, appended, pem. The appended control repeats the GitHub detector family; the runtime plants therefore exercise three distinct families, not every default scanner rule. AWS and Slack family plants are absent from this mandatory cohort; Square/Facebook have separate integration controls. Real-scanner experiments must first prove the baseline default rule detects the generated shape, then assert the exact expected rule ID, rather than count any finding as success.

The companion-rule exception is restricted to two exact generated digest paths and lowercase 64-hex secrets (.gitleaks.toml:8–43). Uppercase/short/nonhex/path-neighbor controls exist. No new broad exception bypass was established; digest-shaped credentials are the already-settled ambiguity, not a new finding. The original two rule IDs intentionally override the corresponding defaults; distinct companion IDs restore their detection in the two exact paths. secretGroup=1 selects the whole credential rather than the Square rule's inner prefix capture. Case/path-neighbor spellings do not inherit the exact-path exemption. CONFIG_TEXT equals the committed configuration. The pinned scanner's default history source is full-history/all refs; direct detect preserves that selection, though it relies on scanner --redact diagnostics and exits before the following controls if history fails. Primary semantics were checked in [gitleaks v8.18.4 sources/git.go](https://github.com/gitleaks/gitleaks/blob/v8.18.4/sources/git.go#L49-L51).

The split-token test at tests/fixtures/secrets/test_t7_secrets_adversarial.py:46–85 does not scan its split fixture: it calls summarize_findings on README.md and catches the error, then scans only the reassembled credential. That control proves reassembly detection, not split-form detection.

Expected GateFailure during an individual scanner/report attempt is caught so later plants run (gate.py:314–324). Setup failures before the loop (:302–310), or unexpected exceptions, can prevent remaining attempts while still rejecting. Report unlink/read is path-based (:231,:195–220); scratch permissions exclude other UIDs, but no same-UID race-proof descriptor binding exists. Repository-root symlinks are normalized, not explicitly refused. These are retained trust/coverage limits, not newly demonstrated privilege escalations.

### R4–R7 — actual legs, sandbox, G-AI and package boundaries

| Surface | Observed guarantee | Limit |
|---|---|---|
| Manifest admission, gate.sh:866–981 | Exact component identity/field set, exact npm direct and dev sets including @electron/asar; strict Go module fullmatch; offline locked Cargo metadata and npm dry-run | Tag identity is checked against hardcoded expected metadata, not a live signed tag. Only declared resolution is verified, not all executed bytes or a license/supplier SBOM. Actual child environment has R1-107. CRLF is normalized by read_text(); trailing directives or non-whitespace content are rejected by the fullmatch rule. |
| Rust/Go/UI, gate.sh:1243–1334 | Frozen Rust main leg, host Go race tests plus foreign compile/link tests, Node >=24, offline npm install, bounded commands and explicit missing-tool failures | Local tool overrides/ambient build variables remain. Go cross-compile is not foreign runtime execution. Several leaves lose timeout class. npm lifecycle scripts run in the local UI leg with network settings, without automatically creating a namespace. |
| offline.sh:4–12 | No argv/root rejects2; unshare failure cannot fall through; missing/failing ip stops before payload; UID is preserved | It isolates networking, not filesystem, time, environment or tool bytes. Namespace-local capabilities remain for setup/payload. This is not a general hermetic sandbox theorem. |
| Online priming | Checkouts/setup actions, npm ci --ignore-scripts, cargo fetch --locked and Go download happen outside build network isolation by design (ci.yml:491–554,2477–2507) | npm ignored scripts/fetch steps are acquisition, not runtime proof; later Go cache build/test and native lifecycle compilation really execute code. Cargo fetch itself is not a package build-script execution claim. |
| Gitleaks provisioning | Exact archive digest precedes extraction; umask077/chmod700 and set-euo make checksum failure stop (ci.yml:491–500) | Fixed temporary names and check-then-extract depend on trusted same-UID runner; no demonstrated prior untrusted step exploits them. |
| Fuses/ASAR/seals | package.js:189–294 checks sentinel uniqueness, wire version/count/states, ASAR-only layout, aliases/unpacked refusals, complete sealed entries and entry point | Consistent malicious upstream executable bytes are not authenticated by structural fuse/seal checks; external Electron trust remains R1-096. |
| Manifest/distribution | Sorted traversal, symlink/CR/LF/backslash refusal, exclusive creation, executable-mode sensitivity, normalized release modes and deterministic tar metadata (package.js:94–142,756–757) | Bare writeManifest is not invariant under every mode/umask change; normalization must precede it. Two rename publications are not one crash-atomic transaction. Inventory is not a full SBOM. |
| Volume and budget | Actual x100 loop, x20 then x300 script, required numeric RSS roles, finite strict raw budget JSON, baseline-first agent mutants | Separate workflow telemetry parsers are weaker; fixture duration labels, cadence thresholds and deadline composition remain open. A smoke failure prevents qualification but does not quantify a stationary flake rate. |

The Bash prelude's set-u is not itself a defect: tools/gate.sh delegates dispatch to Python, and explicit statuses reach main. offline.sh uses set-euo/exec. .githooks/pre-push:7–20 uses POSIX set-eu plus explicit refusals and has no relevant pipeline needing pipefail. The supervisor script retains failed compiler status/diagnostics; its missing locked flag is T7R3-009. No additional swallowed-success path is inferred solely from shell style.

| G-AI assertion | Exact observed property | Does not prove |
|---|---|---|
| A1, gate_g_ai.py:191–215 | Two roots have expected provenance; missing/mismatched roots reject; private modules are not already imported into host | Immutable used bytes, trusted publishers, or every private component's runtime identity |
| A2, :227–231 and :59–66 | Frame shape/location/digest check | Capture authenticity if both bytes and expected hash are controlled |
| A3, :232–240 | Subprocess perception/table binding to this frame | Correctness of the private algorithm or installed source |
| A4, :241–250 | Two selected static snapshots give equal battery digest and an actionable list | Determinism for all states/machines; both required float controls can be removed |
| A5, :251–263 | Custody-checked local/configured target; configured state equals independent observation | General goal completion |
| A6, :264–271,285–293 | Proposal admitted, later old frame refused with STALE_FRAME | That the suffix-based mock implements generation semantics |
| A7, :272–274 | Dispatch focus/timestamp fields are validated | A hardware attestation of those fields |
| A8, :275–302 | Changed pixels within tick window plus changed canonical state and battery digest | Exclusive causal attribution to the action in a changing environment |

rejected() catches only the named exception class and checks a supplied exact code (:49–56); a wrong class/code fails the gate. Controls without a code can still accept an unrelated same-class error. Synchronous controls have no local time limit. Parse-usage errors precede allocation; preflight restores its environment; normal errors inside the session context invoke teardown. Session entry catches partial setup failure; successful receipts require explicit cleanup evidence. Sequential cleanup exceptions, SIGTERM without a dedicated handler, or a permanently hanging call are not universally covered.

Canonical encoding at :34–35 sorts keys and rejects NaN, but live UUID/timing/evidence fields differ between executions. The final canonical(report) at :330 is outside the catch: a fault-injected NaN in extra session evidence can prevent a failure receipt after cleanup. Real C2 timing is validated as an integer, so no live NaN timing exploit is asserted. Native session, focus, private perception, real stale-generation behavior and real teardown are not proven by the mock.

Packaging smoke verifies actual packaged UI/core bytes but substitutes its adapter temporarily (package.js:1404–1417). The installation suite uses compiled fixture wrappers. These are meaningful seam tests; they cannot establish the full native adapter/private capsule clean-install claim. No two-live-run G-AI or G-W1 campaign success was independently verified here.

### Determinism ledger — what can be replayed

The following are source observations; no repeated-byte experiment was run. The formal conditional manifest/canonicalization claims are derived in I6/I11. Q10's byte-identity obligation must not be inferred from a same-invocation equality check.

| Surface | Fixed ordering/inputs and remaining variability |
|---|---|
| Secrets plants and summary | gate.py:107–140 uses unseeded secrets.choice/token_bytes for GitHub/PEM plants, but fixed mixed-case/digit construction for the entropy plant. summarize_findings :195–220 sorts by descending count then rule. Identical findings give a stable summary; independently generated plant bytes are not identical. |
| test_policy_hardening.py | tests/ci/test_policy_hardening.py:30–100 has fixed pin/redaction vectors and exact output comparison. :118–150 uses real sockets, an ephemeral port, namespace tools, timeouts and an exit73 stub. Temporary names and ambient interpreter remain inputs, not a locale/clock matrix. |
| test_gitleaks_config.py | tests/test_gitleaks_config.py:75–140 uses random token bytes and temporary roots, checking rule sets/counts rather than output order. :19–26 checks scanner version; :142–149 inspects the current last commit. No scanner-byte identity or two-run report equality follows. |
| test_hosted_fixes.py | tests/ci/test_hosted_fixes.py:18–30 executes policy in the selected real interpreter; :32–52,93–109 uses fixed mutations; :60–89 checks deterministic shims in a newly named Unicode/space-bearing directory. Dynamic exported paths vary. Unicode-path coverage is not locale-variation coverage. |
| test_toolchain_policy.py | tests/ci/test_toolchain_policy.py:15–58,65–108 is deterministic source/PyYAML traversal and fixed mutations, without running a compiler. Error ordering follows input job/step order; actual runtime preparation is not proved. |
| G-AI harness | tests/test_gate_g_ai_harness.py:43–69,81–110 fixes session timestamps, pixels, generations and response programs; :145 checks operation order. Temporary paths and real gate ID generation remain. :204–215 compares file/stdout of one invocation and its reserialization, not two independent executions. |
| Next-gate workflow harness | tests/ci/test_ci_next_gates.py:178–230 supplies arithmetic timestamps and ordered tiles; :256–277,393–413 supplies fixed run IDs/revisions; :494–509 stubs scheduled outcomes. Actual Bash/interpreters, inherited environment, host architecture and process deadlines remain (:279–285,415–421,522–536); namespace execution is stubbed. |
| Count/aggregate harness | tests/ci/test_ci_counts.py:601–643 injects fixed logs/identity fields; :754–756 sorts receipt names; :835–953 runs real aggregate logic with injected statuses. Cwd/temp paths vary; :1120–1172 fixes Git identity but not commit dates, so commit hashes can vary while assertions use that invocation's values. |
| Manifest and digest walks | package.js:83–85,118,131 sorts names using string comparison; :132 depends on a default-mode probe (:49–61). Renderer walk :302,309–313,335–341 sorts entries/digest keys; Electron tree :840–874 sorts paths and canonicalizes executable modes. No Unicode normalization or immutable filesystem snapshot is implied. Tar fields are normalized at :752–758, while the external tar implementation remains an input. |

For reproducible oracle fixtures, inject clock/ID sources or compare explicitly invariant semantic fields; keep the live evidence's true timestamps and identifiers. Changing those measured fields merely to force identical receipt bytes would falsify evidence.

# Findings

Ranked by the requested rubric. P0 is scoped to executable-input integrity in the supported external distribution route; it is not a claim that normal hosted npm-wrapper inputs are compromised. In the actual column, acceptance/return codes are inferred from the cited source. Each TP reference resolves to an exact proposed input, command and expected result below.

| uid | severity | file:line | repro | expected | actual |
|---|---|---|---|---|---|
| R1-096 | P0 | ui/tools/package.js:927 | TP04: external dist, no parent package.json, adjacent archive hash and :tree/:files computed from the same substituted files; call production verifyElectronDist path. | Reject unless the expected checksum/tree is independently anchored. | Early null binding plus adjacent self-asserted tree/files is accepted (1011–1055,1502–1503). Normal hosted npm-wrapper route remains protected. |
| R1-092 | P1 | .github/workflows/ci.yml:2753 | TP01: valid budgets PASS receipt with passed=5,failed=1; separately rc=false, skipped=-1, mixed null counts, missing assertion id/expected/observed. | Reject contradictory or malformed PASS evidence with nonzero aggregate status. | Live check ignores failed/skipped and most schema fields; false equals zero. F4 is stronger but also admits parsed all-skipped counts (333–347). |
| R1-093 | P1 | .github/workflows/ci.yml:2703 | TP02: all ten job results success, valid local budgets/package evidence, but upstream rust/js/go receipt absent or invalid while that producer exits0. | Required per-arch evidence set must be complete and validated before acceptance. | Only budgets is required locally; upstream jobs are accepted from result strings. Genuine failure/skipped/cancelled results still block. |
| R1-097 | P1 | ui/tools/package.js:1160 | TP05: kill publisher between the two renames; separately inject output-directory fsync failure after both renames. | Refused/failed publication leaves the prior output unchanged under the claimed atomicity contract. | Crash leaves a manifest-only result; fsync failure is outside rollback and can report failure after visible publication. Directory-without-manifest window is closed. |
| R1-098 | P1 | .github/workflows/ci.yml:2750 | TP01: budgets receipt with configuration_sha256='f'*64, gate_revision='0'*40 and wrong/missing scope.platform while matrix is arm64. | Bind revision, current workflow bytes, platform and actual instrument/log evidence. | Generic checker accepts well-formed digest strings and never checks platform. Package has a separate earlier byte verifier; this is not a package bypass. |
| R1-099 | P1 | .github/workflows/ci.yml:46 | TP16: provide a different runner Python/PyYAML that imports yaml; compare declared tools and native build inputs across two runners. | Any claim of identical declared inputs must include the actual interpreter, compiler/linker/headers/libc and build tools. | MV_YAML_PYTHON is chosen by import success before pinned setup; runner/system tools remain ambient. Explicit Node/Python selectors and action SHAs are fixed. |
| R1-106 | P1 | tools/gate.sh:1202 | TP06/P2: parent double-forks a setsid sleeper, synchronizes its creation, then exits0; also exercise same-process concurrent non-LIFO subreaper scopes with distinct tokens. | All owned descendants absent after every return; unrelated siblings untouched and prior subreaper state restored. | wait returns0 and poll is no longer None, so cleanup is skipped; ui-smoke1394 has same hole. Same-process concurrent non-LIFO overlap also defeats plain save/restore. |
| R1-107 | P1 | tools/gate.sh:937 | TP07: set NODE_OPTIONS to a harmless marker and intercept effective rustc/cargo/npm environments while running real frozen manifest validation. | The scrubbed environment reaches all admitted child commands. | rustc inherits os.environ; cargo/npm receive a new unsanitized os.environ.copy despite private_environment removing those keys. |
| T7R3-001 | P1 | tools/gate.sh:1420 | TP08: existing empty agents/tests; then one skipped test; then one expected-failure test; controls one pass and one genuine failure. | Empty or non-executed coverage rejects; healthy executed case passes. | Unittest returns0 for empty/skips/expected failures and leaf maps0 toPASS; the counted unit runner1035–1040 already rejects those states. |
| T7R3-003 | P1 | .github/workflows/workflow_pins.py:51 | TP09: action.yml points outside root while safe action.yaml exists; separately safe local composite contains nested uses with a floating tag. | Validate the metadata actually selected by the executor and every transitive action reference. | any safe metadata file suffices; metadata is not parsed recursively. No current workflow local-action exploitation is claimed. |
| T7R3-004 | P1 | tests/ci/test_toolchain_policy.py:44 | TP10: comment every userns/formatter/cache command without removing its text; synthetic job invokes gate.sh --leg go or package_identity --build without setup. | Missing executed prerequisites and indirect consumers are rejected. | Substring checks count comments as execution; consumer patterns miss these commands. Current production selectors themselves remain exact. |
| T7R3-005 | P1 | .github/workflows/ci.yml:76 | TP11: construct 'gh'+'s%255F'+'a'*36, 'g%68'+'s_'+'a'*36, and 'gh\n'+'s_'+'a'*36 at runtime. | Under the requested encoded/chunked-log threat model, recoverable credential bytes must not be published. | All 18 equal sanitizer copies leave these prefixes intact; only literal prefix bytes and one encoded underscore are recognized. |
| T7R3-006 | P1 | tools/gate_g_ai.py:322 | TP12: delete both A4 float controls; separately change stale proposal to fresh frame while retaining its stale-looking ID. | Every assertion retains its named negative controls; stale refusal is determined by frame identity. | Remaining17 true controls satisfy existing len>=17 oracle; mock Session rejects by ID suffix and ignores the substituted fresh frame. |
| T7R3-007 | P1 | tools/gate_g_ai.py:104 | TP13: matching pinned checkout with a runtime-created untracked sitecustomize.py marker; alternatively matching direct_url metadata with altered installed files. | Code admitted as a pinned component must be the code actually executed. | Ordinary Python site startup plus PYTHONPATH/root imports can execute untracked bytes; HEAD/PEP610 metadata alone does not hash the installed tree. |
| T7R3-008 | P1 | ui/tools/package.js:1542 | TP14: tree with one0755 executable and one0644 data file; writeManifest; invoke the exact generated sha256sum -c command. | Intact package verifies withrc0; content/mode mutations reject. | Generated rows include an extra octal-mode field132–140, incompatible with the documented checksum format; intact verification returns nonzero. |
| T7R3-009 | P1 | ui/tools/package.js:1519 | TP15: locally resolvable stale Cargo.lock with cached pinned dependencies; run packaging or supervisor build and compare lock bytes. | Reject lock drift without rewriting the lockfile or publishing output. | These consumers use --offline without --locked; prior frozen prime and main gate do not constrain every later standalone invocation. |
| T7R3-010 | P1 | .github/workflows/volume.yml:617 | TP17: four tiles with 6000 string 'nan' timestamps, missing pixel fields; CI PERF_WALL has four NaN FPS rows; separately3s fixture soak. | Finite ordered measured telemetry and honest duration/live labels are mandatory. | NaN comparisons reject nothing, missing pixel pairs compare equal, duplicate CI tile IDs are unchecked;3s fixture still gets600s live label. |
| T7R3-011 | P1 | tests/perf/rss_probe.mjs:33 | TP18: initial settle30s, reload settle30s, required active sampling120s, zero other overhead. | A run within each declared healthy phase allowance can complete its required receipt. | It needs 180 s while global exit fires at 170 s; each settle is below its nominal 45 s allowance. Two 45 s allowances plus 120 s sampling already total 210 s before other work; awaited queries lack that local hard bound. |
| T7R3-014 | P1 | agents/tests/run_mutant_harness.py:225 | TP21: baseline returns0 and MUTANTS=[]; separately one intended mutant produces only an unrelated error recorded in unittest TestResult.errors. | Require the declared nonempty cohort and a distinguishing expected killer; infrastructure errors are not semantic kills. | Empty results/dead lists print100% conforming and exit0; any recorded test failure/error counts as killed without expected-test attribution. |
| T7R3-015 | P1 | .github/workflows/ci.yml:2677 | TP23: GITHUB_ACTIONS=true and arm64 with four distinct tiles at 8.5 FPS, valid gaps/pixels/fold state and under-cap RSS; separately run the standalone journey with MV_SOAK_SECS=4 and a healthy report. | Producer and required aggregator apply the same declared per-environment cadence policy. | Journey admits hosted arm64 >=8 FPS while CI validators require >=10. Its fixed 26-frame positive control also fails for a valid 4 s window; live volume runs perf-main directly, so that second defect is scoped to the standalone journey. |
| T7R3-002 | P2 | tools/gate.sh:1289 | TP19: bounded returns124 in Rust/UI/Go; combine that leaf with another returning2; exercise ui-smoke timeout too. | Under Q6, timeout124 dominates blocked2 and failure1. | Leaves return1, so [1,2] aggregates2; all still reject and this is not a false PASS. |
| T7R3-012 | P2 | tests/ci/test_fx2_package.py:18 | TP20: NODE names an executable stub reporting20; repeat with a v24-named NVM candidate reporting20. | Every candidate must satisfy Node>=24. | Override or NVM path is accepted before version admission; current Node20 negative controls remove NODE. |
| T7R3-013 | P2 | tests/fixtures/secrets/test_t7_secrets_adversarial.py:146 | TP22: Git init.defaultBranch=master; fast-import creates main and stash but does not switch HEAD; run existing stash test. | Clean main baseline scans successfully, then stash-only secret causes a recorded scanner finding. | History readiness can fail before scanner invocation while the rc1-only assertion passes. Other side-ref tests still supply valid separate coverage. |


# Mathematics

## Retrieval record and limits

The six requested queries were sent separately to Context7 library /oguirado/math-router after reading its llms.txt and routing instructions. The corpus was read at 5b85a2d524f0e7f2f24abca35027daf72e3b8b65. The library description reports 719 papers; this review did not recount them. Only M2 supplied a theorem applicable to the requested quantitative claims. Other results are recorded to prevent an irrelevant theorem being presented as a security or timing proof.

| Query | Result used, or reason no theorem was used |
|---|---|
| M1 — Merkle tree and hash chain security bounds second-preimage collision resistance | Returned unrelated applicability-limit snippets, including PM-116.2, PM-041.2, PM-237.8 and PM-132.1. No applicable SHA-256/Merkle security theorem or anchor was returned. B2 below is explicitly derived under an ideal-hash assumption. |
| M2 — concentration inequalities Hoeffding Chernoff bounds Bernoulli error rate estimation | **PM-113.1, #eq:hoeffding**, under “Success probability and output,” states the independent bounded-variable inequality used in B1. The equation and assumptions were checked in the paper, not inferred from its title. |
| M3 — sequential hypothesis testing optimal stopping SPRT group sequential methods | PM-229.2, “Domain engineering contracts,” expressly supplies no finite-sample stopping rule. No applicable stopping theorem was used. B3 and O2 derive their own narrower guarantees. |
| M4 — combinatorial t-wise covering arrays test design | Tool returned “No documentation in "/oguirado/math-router" matched this query.” O1 is an explicit construction and proof, not a claimed corpus result. |
| M5 — threshold signatures quorum systems Byzantine agreement lower bounds | Returned PM-186.2 on graph thresholds and unrelated geometric results. None establishes CI quorum correctness. I8 derives the actual conjunction and states its trust assumptions. |
| M6 — fixed-deadline real-time scheduling timeout selection tail latency | PM-124.1, #stmt-thm-main, addresses unit jobs on three identical machines and a degree-150020 polynomial algorithm. It supplies no CI latency-tail estimate. Other retrieved material warns against deriving finite deadlines from asymptotics. B4 derives conditional bounds from the actual timers. |

Primary mathematical source used: [PM-113.1, Hoeffding equation and assumptions](https://github.com/oguirado/math-router/blob/5b85a2d524f0e7f2f24abca35027daf72e3b8b65/papers/EN-114-000-0007-2-2026-PR-T4-UK-EX-M1-B-AL-H-0242_PM-113.1_A_Fully_Polynomial_Randomized_Approximation_Scheme_for_Perfect_Matchings_in_General_Graphs.md#eq:hoeffding). No result in this report asserts that this paper proves software correctness.

## Formal predicates and proofs or counterexamples

Each I1–I11 statement and its proof below is **[DERIVED]** from the cited source control flow and the stated contract. A predicate describing the desired obligation is distinguished from what the current implementation accepts.

### I1 — receipt acceptance and cross-field consistency [DERIVED; Q2,Q8,Q9]

Let K be the exact RKEYS set in ci.yml:286–287, A the assertion field set {id,expected,observed,accepted}, and H256 the lowercase 64-hex strings. Define a required measured PASS predicate:

\[
V(r;e)=
[\mathrm{keys}(r)=K]\land[r.schema=\text{gate\_receipt/v1}]
\land[\mathrm{type}(r.rc)=int]\land[r.rc=0]\land[r.outcome=PASS]
\land C(r.counts)\land A(r.assertions)\land I(r;e).
\]

C requires exact count keys, exact nonnegative integers for measured counts, passed > 0, failed = 0 and a declared parsed source. An explicitly unparsed receipt may instead carry all-null counts but cannot be used as evidence of a measured number of tests. A requires a nonempty list of exact-shape assertions with accepted exactly true. I compares r.scope.platform and the identity fields with the expected current revision, architecture and independently supplied hashes, not merely membership in H256.

Counterexample: preserve a valid budget receipt but set rc=false, counts={passed:5,failed:1,skipped:-1,source:"parsed:plant"}, assertions=[{accepted:true}]. The live checker ci.yml:2753–2762 accepts these predicates because Python false compares equal to zero, only passed is tested, and accepted is the only assertion field checked. Apply each mutation separately to identify its guard; the combined mutation is not needed to establish the failure. F4 :302–345 rejects these combinations, but its weaker passed+failed+skipped > 0 condition still accepts parsed (0,0,1). These are two distinct validators, not a contradiction in the argument. TP01 tests both implementations.

### I2 — PIN language and local metadata closure [DERIVED; Q1,Q3,Q6]

The remote language is the fullmatch of:

~~~text
[A-Za-z0-9_-]+/[A-Za-z0-9_./-]+@[0-9a-f]{40}
~~~

together with the rule that slash-delimited path segments before @ contain none of the empty string, "." or ".." (workflow_pins.py:14,55–57). The semantic YAML traversal must find every uses node, with no duplicate/merge-key ambiguity (:21–48). Fullmatch proves that a tag suffix, extra @, uppercase hash, Docker URI or abbreviated hash cannot belong to that language: each leaves an unmatched character or violates the exact hash length. It proves a syntactic name/hash pairing, not ownership or publisher authenticity.

For a local action, the stronger obligation is that the **same metadata file selected for execution** is in-root, ordinary safe metadata and recursively has pinned external references. The actual existential condition is “some safe action.yml or action.yaml exists” (:49–54). Put an outside symlink at action.yml and a safe regular action.yaml beside it; the safe alternative satisfies that existential while the preferred file is unsafe. Independently, a safe composite metadata file containing a floating nested uses reference is not parsed by this checker. The executor's precedence is independently visible in [Actions runner ActionManager.cs:725–738](https://github.com/actions/runner/blob/4197182ef8f39c719f66038c1bc9b34cd9e9ac9a/src/Runner.Worker/ActionManager.cs#L725-L738). T7R3-003/TP09 distinguish these cases. A later filesystem mutation is outside this predicate unless the checked bytes are bound to execution.

### I3 — toolchain preparation must be executed and precede use [DERIVED; Q1,Q5,Q7]

For every job j and actual consumer step c, define:

\[
T(j,c)=\bigwedge_{x\in Needs(c)}
\exists s<c:\ Executes(s,j)\land SelectsExact(s,x)\land ReadyAfter(s,x).
\]

Needs includes indirect consumers such as gate.sh --leg go, Cargo toolchain-qualified invocations, and package_identity --build. A conditional setup that did not execute cannot satisfy Executes. test_toolchain_policy.py:30–57 instead recognizes selected command substrings and accepts preparation text in comments. Replacing its userns command with the same line prefixed by "#" leaves that oracle true while Executes is false. A job containing only bash tools/gate.sh --leg go without setup can evade its Go-consumer regex. Thus the test is neither a complete consumer inventory nor a sound proof of executed preparation. This does not refute the actual version selectors already present in current workflows; TP10 mutates the oracle's input.

### I4 — distribution integrity and trust anchoring [DERIVED; Q2,Q3,Q4]

Let D(r,root,rev,arch) be the conjunction implemented by distribution_errors at test_package_identity.py:351–463: package/PASS/exact integer rc0; expected current revision; exact product keys; contained ordinary local paths; archive/evidence/manifest hashes; matching architecture and smoke marker; independently produced local evidence matching the producer; a unique regular tar member set equal to the manifest inventory; per-member hashes/modes when recorded; and matching ELF architecture for the three checked executables. Configuration identity is checked if present at :359; legacy manifest mode omission is accepted by the helper. These qualifications are part of D.

Each false conjunct returns an error before success; therefore, under stable filesystem reads and honest hash computation, D rejects that individual violation. It establishes consistency with the supplied package evidence. It cannot authenticate an upstream input when both that input and its alleged expected digest are attacker-controlled: choose arbitrary structurally valid bytes b and set the descriptor to H(b). Equality is then true by construction. The external Electron branches package.js:927–928,1034–1055 instantiate this self-satisfaction counterexample (R1-096). The normal pinned-wrapper ZIP branch is a different route. TP04/TP25 test the routes separately.

### I5 — sanitizer idempotence and preservation have a language boundary [DERIVED; Q8,Q10]

Let L be the recognized token-prefix language in ci.yml:76, with its permitted separator and suffix forms, and S be substitution of every recognized span by its fixed redaction marker after text decoding. For text x whose replacements introduce no member of L and cannot join two fragments into one, S(S(x))=S(x): the first pass removes each recognized span and the marker is not a new match. For clean text with no L match, S(x)=x by the definition of substitution. These are text-level claims; invalid UTF-8 is not preserved byte for byte.

Neither claim implies that every recoverable encoding of a credential is in L. Runtime concatenate "gh"+"s%255F"+"a"*36, "g%68"+"s_"+"a"*36, or "gh\n"+"s_"+"a"*36. Each representation lies outside the implemented literal-prefix matcher yet retains recoverable material. TP11 must check the supported normalization contract and all 18 copies, plus a clean line and a 64-hex digest. Reapplying an incomplete sanitizer cannot repair missing language coverage.

### I6 — canonical G-AI bytes and nonvacuous controls [DERIVED; Q8,Q9,Q10]

For a fixed JSON value v restricted to string keys, strings, integers, booleans, null, lists and mappings, define C(v) as gate_g_ai.py:34–35's sorted-key, compact-separator, UTF-8 encoding. Reordering mapping insertion order leaves C unchanged: sorting chooses the same key sequence and recursion writes the same value encodings. Float NaN/infinity have no encoding because allow_nan=False. This is not a claim of cross-version canonical float formatting, Unicode normalization, or identical receipts across runs: UUID/timing/evidence fields differ.

Let E be the exact 19 control IDs enumerated in TP12. A complete negative-control certificate requires keys(controls)=E and every value exactly true. The implementation at :322 and harness at test_gate_g_ai_harness.py:142–144 accept all remaining true values with length at least 17. Removing the two A4 controls leaves 17 and preserves that verdict. This is an explicit failed total-coverage predicate, independently of whether the live happy path works. A fake core that rejects based on a proposal-name suffix cannot establish the frame-identity predicate tested by :285–293.

### I7 — completion means the whole owned process tree [DERIVED; Q6,Q8,M6]

For call token t, let Owned(t) be descendants with the recorded ownership identity/token. Required completion is Return(t) implies Owned(t)=empty, unrelated descendants are unchanged, and process-global subreaper state equals its prior state once all active scopes finish.

Counterexample: a synchronized parent creates a setsid grandchild and exits zero. bounded returns from wait at gate.sh:1196; finally at :1202 sees a completed direct child and skips stop_process_tree. The surviving owned grandchild falsifies the implication. Proper LIFO nesting is improved by saving/restoring at :1183–1186,1207. **Same-process concurrent non-LIFO calls** still permit A-save0, A-set1, B-save1, A-restore0, B-restore1: the final state is 1 rather than 0, and B temporarily loses adoption while active. The ordinary CLI main loop is sequential (:1529–1533); this second counterexample is specifically the requested overlapping-call probe, not a claim about every CLI invocation. TP06 supplies both initial states and a sibling control.

### I8 — conjunction is not a Byzantine quorum [DERIVED; Q1,Q2,Q8,M5]

For required gate set R, strong acceptance is:

\[
Accept(R)=
[\mathrm{multiset}(receipt.gate\_id)=R]
\land\bigwedge_{g\in R}(result_g=success\land V(receipt_g;e_g))
\land D(package,\ldots).
\]

Exact multiset equality excludes omission, duplication and unapproved extras. F4 ci.yml:401–420 checks this structure with its supplied registry; its computed configuration hash can be overwritten by an explicitly supplied reg at :408–409, so that override is part of the helper's trusted input. Live aggregation instead checks ten job-result strings, locally collected receipts, a required membership set initially containing only budgets (:2703), and the earlier package distribution step. Let a non-package upstream producer return success but omit its receipt while the package/local-budget path is valid. The live conjunction can still hold, although the strong receipt-set conjunct is false (R1-093).

Ten status strings are not ten independent attestations of each artifact. Without independent verification of each issuer's statement, corrupting the sole issuer of one required claim can falsify that claim while all other issuers truthfully pass theirs. Conversely a single corrupt issuer cannot turn another honest job's actual failed status into success under the existing shell checks. No Byzantine threshold or signature lower bound is asserted: no signer registry, threshold verification or independent fault-domain premise was established. The SHA pin alone supplies neither.

### I9 — raw budget receipt acceptance [DERIVED; Q8,Q10,M2]

Define B(r) as tools/budget_gate.py:74–99's conjunction: exact supported schema/workload, orphans=[], integer duration at least 120000 ms, at least six sample rows, strictly increasing integer timestamps within duration, positive integer main/renderer/tree RSS, nonnegative utility RSS, tree at least the sum of the roles, first sample by 5000 ms, last within 5000 ms of end, gaps at most 10000 ms, and all three gating maxima at or below their fixed caps. read_json :36–45 additionally rejects duplicate keys and nonfinite constants.

For duration 120000, last-first is at least 115000-5000=110000 ms. With maximum gap 10000, at least 11 gaps and therefore **12 samples** are necessary. This follows even though the separate length guard says six. Generate twelve rows at 5000+10000i for i=0..11: endpoints are 5000/115000 and all gap constraints hold. Eleven such rows cannot span the required endpoints. TP24 uses this as an exact boundary oracle. B validates a claimed measurement's structure/caps, not the honesty of the process that supplied it. The weaker workflow soak/FPS parsers are separate and can accept NaN (T7R3-010).

### I10 — mutation score needs a cohort and a distinguishing failure [DERIVED; Q9,Q10]

Let E8 be the eight declared IDs in run_mutant_harness.py:201–210, b the baseline failure count, and k(m) the result of the intended distinguishing test for mutant m. Desired acceptance is:

\[
b=0 \land \mathrm{keys}(results)=E8
\land \forall m\in E8:\ k(m)=intended\_failure.
\]

The baseline check :213 is meaningful, but :225–242 instead accepts any positive failure count for each entry it happened to execute. With MUTANTS=[] and b=0 the universal checks are vacuous, dead=[], the printed score is 100%, and rc is zero. An unrelated error captured in unittest TestResult.errors after mutation is not necessarily the intended semantic killer; an exception escaping the runner already aborts nonzero. TP21 tests empty/missing cohort and separates ERROR from KILLED. This is why neither stubbed scheduling tests nor a score printed without cohort identity proves the strong predicate.

### I11 — normalized manifest identity [DERIVED; Q4,Q6]

Let N normalize every regular file mode to 0755 if any executable bit is set and 0644 otherwise, and directories to 0755 (package.js:94–109). Let M serialize sorted relative paths, SHA-256 file digests and normalized modes (:113–142), with a fixed mode-format policy. A release includes executable files, so its mode fields are explicit regardless of the non-executable default-mode probe. For safe filenames and an unchanged file set/content, changing enumeration order or mtimes cannot change M: neither is serialized and names are re-sorted. A change to any non-executable mode bit leaves N unchanged. A change from no executable bits to at least one changes N and its recorded mode, hence M. Changes between two different already-executable bit patterns deliberately normalize to the same mode.

This proof applies to M(N(tree)), as invoked by production :1557. It does not apply to standalone writeManifest on arbitrary raw modes or concurrent filesystem mutation. The sorted comparison uses JavaScript string ordering, not a locale collation routine (:89–90,131). The report does not infer failure-atomic publication from deterministic serialization: the two rename calls at :1160–1161 are separate state transitions. [DERIVED] The partial-delivery window is [t_manifest_rename, t_directory_rename), with width t_directory_rename-t_manifest_rename; the source supplies no finite upper bound under process suspension or termination. Catch-based exception rollback does not run after an unhandled process kill, and later fsync failures are outside that catch.

## Quantitative bounds as test oracles

### B1 — repeat counts and estimation [M2; PM-113.1 #eq:hoeffding; derivations marked]

For independent Bernoulli failure observations X_i with a common stationary mean p, PM-113.1's inequality gives:

\[
P(|\hat p-p|>\epsilon)\le 2e^{-2N\epsilon^2}.
\]

**[DERIVED]** Requiring the right side at most delta and taking logarithms gives
N >= ceil(log(2/delta)/(2 epsilon²)). With delta=.05, epsilon=.05 needs **738** runs; epsilon=.01 needs **18445**. TP34 asserts both the rounded N inequality and failure of N-1 to meet the target. This is an absolute-error estimate, not a proof that zero failures imply p=0.

**[DERIVED]** A sharper zero-failure-only bound follows directly from independence:
P(no failures | p)=(1-p)^N. Inverting at delta gives the one-sided upper confidence endpoint p_U=1-delta^(1/N).

| Hypothetical IID all-pass cohort | delta | Upper endpoint p_U |
|---|---|---|
| 20 repetitions | .05 | 0.13910834, approximately 13.91% |
| 194 repetitions of the same experiment | .05 | 0.01532330, approximately 1.53% |
| 300 repetitions | .05 | 0.00993608, approximately 0.994% |

The reported “194 passed” e2e suite is a collection of different assertions, not 194 independent repeats of one Bernoulli experiment; the middle row is explicitly hypothetical and cannot certify that suite's flake rate. Likewise correlated frames, repeated cache states and samples from one wall session do not become independent runs by being counted.

**[DERIVED]** To reject p>=.01 after zero failures with delta=.05 needs ceil(log(.05)/log(.99))=**299** IID runs. For two architectures, allocate delta=.025 to each and require **368 per architecture**; the union bound is .025+.025=.05 without requiring independence between architectures. Independence/stationarity within each architecture remains an assumption. TP30 fixes the two architecture strata and pass bar; seeds 21559+i make fixture generation replayable, not statistically independent by themselves.

### B2 — hash checks only protect trusted expected values [DERIVED; M1; Q1,Q2,Q3]

Assume an ideal 256-bit hash and q independent/adaptive fresh trials against a fixed trusted target digest. Each trial hits that digest with probability 2^-256; a union bound gives q/2^256. For arbitrary collisions among q trials, there are q(q-1)/2 candidate pairs, giving q(q-1)/2^257. At q=10^6:

~~~text
fixed-target bound:     8.63617e-72
any-pair bound:         4.31808e-66
10 trusted target checks, union bound: 8.63617e-71
~~~

These are ideal-hash conditional bounds, not a proof of SHA-256's concrete security, signature authenticity or the collision resistance of every possible encoding. For a hypothetical depth-20 chain/inclusion verification with at most q=10^6 new attempts per checked hash and a fixed authenticated root, a conservative union bound is 20q/2^256, approximately 1.72723e-70. The repo checks discussed here are direct file/tree digests; no Merkle-proof mechanism was identified, and this hypothetical depth bound is not credited to its receipts.

For sanitized_log_sha256 in a generic live receipt, the expected digest is not recomputed from trusted log bytes (:2751–2752). For the external Electron descriptor, the supplied bytes can define their own digest. An adversary selecting b and H(b) satisfies equality with probability **1**, without a hash collision. Kit content comparison and distribution byte verification receive the fixed-target bound only conditional on trusted committed expectations, faithful verifier execution and unambiguous serialization. Revision equality is an identifier comparison, not a cryptographic signature.

TP04/TP25 make one-bit tampering a deterministic negative control against independently fixed expectations. Such tests validate wiring, not a 2^-256 empirical probability. TP34 checks the arithmetic using exact integers; no random attack simulation is claimed.

### B3 — explicit sequential thresholds and their scope [DERIVED; M3]

Consider independent Bernoulli failures with two simple hypotheses H0:p=.001 and H1:p=.01. After n runs and s failures define:

\[
L_n=s\log(10)+(n-s)\log(.99/.999).
\]

Each failure adds 2.302585093; each pass adds -0.00904983552. Reject H0 when L_n >= log(20)=2.995732274; reject H1 when L_n <= log(.05)=-2.995732274. Otherwise continue until Nmax=2000, then return **inconclusive/BLOCKED**, never forced PASS.

Proof of the stated error bounds: under H0, Z_n=exp(L_n) is a nonnegative mean-one likelihood-ratio martingale, because each next likelihood ratio has conditional mean one. Stop at the first upper crossing or a finite cap. Expected stopped Z is one; on an upper crossing it is at least 20, so the crossing probability is at most 1/20=.05. Taking increasing finite caps preserves that upper bound. Under H1 apply the same argument to 1/Z_n at the lower crossing; its threshold is 20, giving error at most .05. The finite cap only adds an inconclusive outcome. These bounds concern those two simple hypotheses and the stated probabilistic model, not all nonstationary CI failures or an asserted general optimality theorem.

With zero failures the lower crossing first occurs at **332** runs because 331 log(.99/.999)>log(.05) and 332 log(.99/.999)<=log(.05). TP34 verifies these inequalities and the two-failure upper crossing. Deterministically enumerate all binary sequences up to length 12 as a test of likelihood accumulation and first-crossing logic; seed 21559 is only for additional generated replay cases. The mathematical martingale argument supplies the bound, not this finite enumeration.

This sequential inference is an optional diagnostic protocol. It must not replace a release rule requiring every observed test to pass: under that stricter rule, any actual failure still rejects and O2 gives the appropriate early-stopping optimization.

### B4 — timers do not establish unconditional healthy-run bounds [DERIVED; M6]

Let T be healthy execution time, D the timeout, and C cleanup time. A no-false-kill claim needs P(T>D) <= delta, or a deterministic maximum T_max <= D. Source alone supplies neither distribution nor maximum; for any finite D a healthy execution requiring D+1 contradicts universal soundness unless the health contract forbids that duration. Complete termination by D+C additionally requires bounded cleanup, a responsive kernel and no escaped owned descendants.

At gate.sh:1178–1207, D=300 seconds bounds the direct-child wait. The coded sleep allowance during cleanup is at most .05+.1m seconds for m recorded descendants: five .01 s TERM checks and up to twenty .005 s waits per descendant (:1148–1160). Scans, scheduling and the unbounded wait at :1152 are additional. Therefore no finite unconditional whole-call bound follows from 300 alone. The successful-parent orphan counterexample violates tree completeness even when T is tiny.

The workflow ceilings are also not the sum of all allowed child maxima:

| Path | Derived permitted-child sum | Outer limit / consequence |
|---|---|---|
| volume-mutants:100 repeats at120s, schedule1200s, flake120s | 100*120+1200+120=13320s | 60min=3600s job cannot accommodate all maxima |
| volume-e2e:20+300 repetitions at120s, build120s, soak660s | 320*120+120+660=39180s | 180min=10800s job cannot accommodate all maxima |
| RSS probe:initial settle30s, sampling120s, reload settle30s | 180s before other overhead | 170s global exit kills it although both waits are below45s |
| RSS full declared settle allowances | 45+120+45=210s plus overhead | Electron170s / wrapper180s cannot honor both allowances |

These sums are conditional worst-case accounting, not predictions of ordinary runtime. The volume policy can intentionally impose a tighter overall budget, but it must not promise that every individually allowed healthy schedule completes. In RSS, the inconsistency directly undermines the newly enlarged healthy settle allowance (T7R3-011).

TP18 uses virtual time with each settle in {0,14900,30000,44900} ms, both architectures, sample duration120000 ms: 4*4*2=32 phase schedules, plus one never-resolving settle promise. The latter also checks that an awaited query is actually time-bounded. TP06 covers tree cleanup at timeouts0.2s and5s; fake timing does not prove real kernel cleanup.

For a separately measured stationary deadline-miss Bernoulli event, zero misses in **2995** IID runs bounds a miss probability of .001 at 95% confidence because ceil(log(.05)/log(.999))=2995. This is the zero-failure derivation from B1, not a measured guarantee for the current 300/1200-second limits.

## Quantified optimizations

### O1 — a minimal pairwise sanitizer grid [DERIVED; M4]

Define exactly three factors: eight chosen credential families F=0..7; four prefix encoding forms E=0..3 (raw, lowercase-percent byte, uppercase-percent byte, double encoded byte); and two framing forms C=0..1 (whole versus split prefix). Choose the encoded byte per prefix: an underscore for the six GitHub forms, the K for the AWS form, and the hyphen for the Slack form; each has an A–F hex digit, so both percent-case forms are distinct. Select suffix lengths for each family's own detector and construct every credential from runtime fragments.

The exhaustive grid has 8*4*2=64 cases. Generate every (F,E) pair once and set C=(F+E) mod 2: **32 cases, a 50% reduction**. Proof: every F/E pair appears by construction; for any F, the four E values include both parities, so every F/C pair appears; for any E, the eight F values include both parities, so every E/C pair appears. Any strength-two grid needs at least 8*4=32 rows to cover F/E, proving this construction minimal for these stated factors. It is not strength three: half the full triples are absent.

Preserve separately the concrete known encoding/chunking regressions in TP11, plus length/boundary/case and clean-hash controls. The 50% saving applies only to this factor grid before those mandatory additions. The current pin/sanitizer/exit vectors do not define and enumerate a complete factor model; no general pairwise or higher-order coverage claim is justified. For pins, the safe-alternate plus unsafe-preferred metadata pair is missing; for sanitizer, double encoding plus framing is missing; for exits, real leaf timeout loss plus another blocked leaf is missing. A strong existing aggregate matrix does not cover that last producer interaction.

Measurement: extend tests/ci/test_t7r2c_sanitizer_secrets.py with the generator and pair-projection assertions; run
~~~sh
python3 -I -m unittest discover -s tests/ci -p 'test_t7r2c_sanitizer_secrets.py' -v
~~~
Record generated grid rows (expected32 versus64), sanitizer invocations across18 bodies (576 versus1152 before extras), and elapsed time. Count savings are proved; wall-time savings depend on fixed subprocess/setup overhead and must be measured. The stdlib-only projection oracle appears in TP34.

### O2 — stop an all-pass campaign at its first failure [DERIVED; M3]

If acceptance means all N runs pass, reject immediately at the first failure and accept only after run N. This leaves the acceptance event exactly unchanged: both procedures accept iff X_1=...=X_N=0. It is pathwise optimal among procedures deciding that same event from sequential observations: after a failure no future observation can change rejection, while before N all-pass observations the unseen next run might fail, so early acceptance cannot preserve the event for every sequence.

For independent failure probability p, the expected number of runs is the tail sum
E[K]=sum from i=0 to N-1 of (1-p)^i=(1-(1-p)^N)/p. At N=300:

| p | Expected runs | Saving relative to300 |
|---|---|---|
| .001 | 259.293 | 13.57% |
| .01 | 95.096 | 68.30% |
| .05 | 20.000 | 93.33% |

If no failure occurs, there is no count saving and the same B1 confidence interpretation applies. Current volume smoke already prevents qualification after a failed smoke cohort, but its loop can finish all20 smoke repetitions after an early failure. A failure on repetition5 can stop after5 rather than20, saving15 invocations while keeping qualification unrun and preserving the failure receipt.

For two gates with fixed costs c1,c2, order-invariant outcomes and marginal rejection probabilities r1,r2, expected cost in order1→2 is c1+(1-r1)c2; the reverse is c2+(1-r2)c1. Subtracting gives the criterion c1*r2 <= c2*r1, or c1/r1 <= c2/r2 when both rejection probabilities are positive. Hence “smoke before qualification is optimal” needs measured cost/rejection data; its name or size alone is insufficient, and variable/conditional costs or order-dependent behavior require a different model.

Measurement: augment tests/test_ci_volume_e2e.py's actual extracted-script stub with a persistent call counter, failure fixed at invocation5, and all-pass control; run
~~~sh
python3 -I -m unittest discover -s tests -p 'test_ci_volume_e2e.py' -v
~~~
Compare calls before/after (20→5 in this smoke mutant,320→320 for a full all-pass campaign), receipt outcome/reason and elapsed time. TP26 checks both architectures and that early rejection never creates a qualification PASS. No production optimization was implemented or benchmarked by this review.


# Tests proposed

**None of these commands was executed.** For a row marked **add**, the stated exact input/mutant must first be added to the named existing suite or its existing extraction harness; the command then runs that augmented suite. The current suite alone does not exercise a proposed case. For an open finding, the new assertion is predicted to fail at the reviewed head and pass after a repair. For a verified fix, the positive and negative controls are predicted to pass as tests at the head; this is not an observed old/head run.

Use a disposable checkout of the reviewed SHA and repo-pinned tools with caches already populated. Retain a clean baseline before each mutation [Q9]. On applicable fixes, run the same distinguishing input against the task's relevant old base (f3f3a4e, 38c79277, 7acc35f7 or cfd582ec) and the reviewed head; skip no prerequisite silently and report unavailable execution as BLOCKED. Tests must not modify the review branch. Python-only means stdlib fixture/mocking work only; the full gate self-test at this head additionally invokes Cargo/rustc/npm/Go/Node and is **not** Python-only.

All synthetic credentials below are assembled at runtime from inert fragments. No private component, real credential or new dependency is needed for the mocked cases. Live package, kernel, display and private-stack cases explicitly retain their prerequisites.

## Receipt, trust and policy probes

| Test / target | Exact input or mutant; required outcome | Command after stated augmentation | Obligation |
|---|---|---|---|
| TP01 — ci.yml:2738–2763, F4:289–351 | **Add** to the actual extracted aggregate harness in test_ci_counts.py:835–1185. Start from its valid budget receipt separately on x64/arm64. Independently set rc=false; failed=1; skipped=-1; failed=null with passed=5; assertions=[{accepted:true}]; current revision to "0"*40; platform to the other arch or delete it; configuration hash to "0"*64; hash to int("1"*64); hash to "a"*64 plus LF. Require final aggregate rc1 for each, baseline0. Run the same receipt through F4 and record the differences in the R2 ledger rather than assume equivalent validators. Include parsed(0,0,1), which F4 accepts and live rejects. | python3 -I -m unittest discover -s tests/ci -p 'test_ci_counts.py' -v | Q2,Q8,Q9,Q10; M1,M5 |
| TP02 — ci.yml:2703,2716–2725,2776–2816 | **Add**, using the production default required set rather than test-only budgets,package,rust,js. All ten producer statuses=success; valid independently checked package/budget evidence; delete a non-package producer receipt or replace it with outcomeFAIL/rc7. Desired final rc1 identifying missing/invalid evidence; predicted current rc0 because that producer receipt is not collected. Repeat extras and two receipts with the same gate ID under different collected paths; require exact-set rejection. | python3 -I -m unittest discover -s tests/ci -p 'test_ci_counts.py' -v | Q1,Q2,Q8; M5 |
| TP03 / P1 — ci.yml:2697–2819 | Existing actual-script cases plus **add** any uncovered cells: both architectures × no receipt directory, missing budgets, filename/gate_id mismatch, outcomeFAIL/BLOCKED/UNKNOWN/NOT_APPLICABLE, and valid PASS. Cross each architecture with every upstream status failure/skipped/cancelled while all others succeed. Negative final rc1, valid0. Missing package must be tested through the earlier --distribution step as well, not only an isolated final Python fragment; local job failure must survive always(). | python3 -I -m unittest discover -s tests/ci -p 'test_ci_counts.py' -v; python3 -I -m unittest discover -s tests/ci -p 'test_package_identity.py' -v | Q2,Q8,Q10; M5 |
| TP04 — package.js:927–928,1011–1055,1503 | **Add** to the existing external-dist fixture at test_t7r2c_reproducibility.py:103–127. Remove its checksumsPath override; place adjacent checksums.json, omit adjacent package.json; supply native ELF header/version plus modified tree whose :tree or :files hashes are computed from itself. Desired admission rejection, predicted acceptance. Keep committed trusted-checksum/pinned-wrapper positive. A dummy ELF proves only verification admission; any end-to-end substitution probe must use a structurally valid runnable modified distribution. | python3 -I -m unittest discover -s tests -p 'test_t7r2c_reproducibility.py' -v | Q1,Q2,Q3,Q10; M1 |
| TP05 — package.js:1142–1173 | Existing second-rename exception control plus **add**: child self-termination immediately after manifest rename and before directory rename; directory fsync raises after both renames; competing publisher creates destination between precheck and second rename. Observe no outputs on a refused operation under the claimed atomic contract, and never delete another publisher's successful output. Current crash leaves a manifest-only generation and fsync failure leaves visible outputs. Use a parent observer and disposable fixture destinations; do not inject faults into a real release path. | python3 -I -m unittest discover -s tests -p 'test_t7r2c_reproducibility.py' -v | Q4,Q6,Q8 |
| TP09 — workflow_pins.py:14–63; F2 ci.yml:237–272 | **Add** to real-checker matrix: hashes of lengths39/40/41; uppercase/nonhex; digest prefix; tag, branch, expression, Docker tag/digest; multiple @; valid comment versus quoted comment; remote reusable path; both workflow suffixes; alias/cycle; duplicate/merge keys; non-string uses; each trigger form; local action.yml/yaml, parent/absolute/sole-symlink escape; safe alternate plus unsafe preferred metadata; nested floating composite reference. The valid full-lowercase40 and contained selected pinned action pass; listed policy violations reject. Unknown !custom mapping is a schema-layer limitation, not asserted to be rejected by this pin-only checker. Exercise the actual F2 30-second checker timeout and 7–40 regex mutant. | "$MV_YAML_PYTHON" -I -m unittest discover -s tests/ci -p 'test_t7r2c_workflow_pins.py' -v; "$MV_YAML_PYTHON" -I -m unittest discover -s tests/ci -p 'test_policy_hardening.py' -v | Q1,Q3,Q6,Q9,Q10; M4 |
| TP10 — test_toolchain_policy.py:30–57 | **Add** three one-step jobs invoking exactly bash tools/gate.sh --leg go, cargo +1.97.0 test --offline, and python3 tests/ci/test_package_identity.py --build, without setup/cache. Require policy_errors nonempty. Independently prefix every USERNS, FORMATTER and cache command line with "#", keeping text present; require refusal. Also move setup after consumer, condition it false, remove selector entirely, and replace a build command by echo of that command. Baseline current workflows must remain accepted. | "$MV_YAML_PYTHON" -I -m unittest discover -s tests/ci -p 'test_toolchain_policy.py' -v | Q1,Q5,Q7,Q9,Q10; M4 |
| TP11 — all 18 sanitizers; ci.yml:76–79,451–454 | **Add** the O1 grid and explicit runtime fragments "gh"+"s%255F"+"a"*36, "g%68"+"s_"+"a"*36, "gh\n"+"s_"+"a"*36; intact prefix plus8 suffix characters, LF, then28; every repaired family and single %5F/%5f/case variant. Require agreed encoded/chunked representations fully redacted, all 18 copies equal, S(S(x))=S(x), and clean ASCII plus "b"*64 preserved. Compare complete decoded outputs, not merely absence of one prefix substring. Current extended-encoding assertions fail. | python3 -I -m unittest discover -s tests/ci -p 'test_t7r2c_sanitizer_secrets.py' -v | Q8,Q9,Q10; M4 |
| TP13 — gate_g_ai.py:101–106,191–215; perception/deps_lock.py:92–142 | **Add** a temporary root with expected provenance metadata and harmless untracked sitecustomize.py that writes a fixture sentinel; separately mutate installed module bytes while preserving matching direct_url.json. Require preflight refusal before child execution, or an immutable inventory/import policy that prevents the sentinel. Current metadata admission is predicted to allow the startup marker. Baseline identical admitted root without extra bytes passes. Use the mocked private-command harness, not a real private checkout. | python3 -I -m unittest discover -s tests -p 'test_gate_g_ai_harness.py' -v | Q1,Q3,Q7,Q9,Q10; M1 |
| TP14 — package.js:132–140,1541–1542 | **Add** tree run.sh with mode0755 and bytes "#!/bin/sh\nexit 0\n", plus a.txt mode0644 bytes "alpha\n". Call real writeManifest, then the exact generated sha256sum -c command from the tree directory. Intact artifact must verify0; one content-byte flip or executable-bit flip must reject. Current intact documented command is predicted nonzero; the repaired integration must verify modes as well as bytes. | node --test ui/tools/test_package_clean_install.mjs | Q2,Q4,Q6,Q10 |
| TP15 — package.js:1519; run_process_gate.sh:34 | **Add** a locally resolvable stale workspace version in Cargo.lock, with dependencies pre-cached. Record lock bytes; packaging and supervisor consumers must refuse, preserve those bytes and publish nothing. Unmodified baseline succeeds only with all package prerequisites. Also inspect captured Cargo argv in a unit case and kill removal of --locked. The live packaging command requires the same kit/Electron/output environment as package.yml:92–99; its result is Not verified. | bash .github/workflows/offline.sh bash scripts/bootstrap.sh; bash tests/supervisor/run_process_gate.sh; node --test ui/tools/test_package_clean_install.mjs | Q4,Q7,Q12 |
| TP16 — ci.yml:46,491–554,2477–2507; all four workflows | **Add** selector absence and version drift for Node/Python/Go/formatter/build toolchain; wrong gitleaks archive byte must stop before extraction; node-pty version1.0.0 versus required1.1.0 and failed native load must reject. Record actual executable/version/content identity, C compiler/linker/libc and selected YAML interpreter in two controlled environment inventories, then compare package hashes. Any difference must be declared, pinned or outside the reproducibility claim. No measured equality is asserted. | "$MV_YAML_PYTHON" -I -m unittest discover -s tests/ci -p 'test_ci_toolchain.py' -v; "$MV_YAML_PYTHON" -I -m unittest discover -s tests/ci -p 'test_hosted_run3_policy.py' -v; node --test tests/ci/install_electron.test.cjs tests/ci/install_electron_mutation.test.cjs | Q1,Q5,Q7,Q12 |
| TP17 — volume.yml:597–627,673–674; ci.yml:1902–1909,2671–2678 | **Add** by extracting the actual inline Python, not reimplementing it. Exact report: schema metaviewer.perf-wall/v1, capture synthetic-rgb24, started0, ended600000; four distinct tiles with times=["nan"]*6000, info presentCount6000/lastCaptureGeneration1, missing pixel and expectedPixel; folded hidden=true, before generation0/draw0, after folded=true/captureLeaseActive=true/generation1/draw0. Require nonzero. Baseline times=[50+100*k for k in range(6000)] and equal explicit pixel arrays passes; delete either/both pixel fields, duplicate IDs, nonfinite/descending timestamps and CI FPS NaN must reject. At MV_SOAK_SECS=3 with a fixture, require fixture/3s labeling, never 600s live evidence. | python3 -I -m unittest discover -s tests -p 'test_ci_volume_e2e.py' -v; "$MV_YAML_PYTHON" -I -m unittest discover -s tests/ci -p 'test_ci_next_gates.py' -v | Q8,Q9,Q10; M2 |


## Runtime and G-AI distinguishing probes

**TP06 / P2 — tools/gate.sh:1178–1207,1388–1394; Q6,Q8,M6.** The following proposed standalone command loads the existing real extraction helper. The parent waits until its detached grandchild exists, then exits successfully. Required result is command0 with no surviving owned PID; current source predicts assertion failure. The probe cleans its planted sleeper even on failure.

~~~sh
python3 -I - <<'PY'
import os, pathlib, runpy, signal, sys, tempfile
g = runpy.run_path('tests/test_t7r2c_gate_admission.py')['load_gate_module']()
child = '''import os,pathlib,sys,time
r,w=os.pipe()
mid=os.fork()
if mid==0:
 os.close(r)
 if os.fork()==0:
  os.setsid(); pathlib.Path(sys.argv[1]).write_text(str(os.getpid()))
  os.write(w,b'1'); os.close(w); time.sleep(30); os._exit(0)
 os._exit(0)
os.close(w); os.waitpid(mid,0); os.read(r,1); os.close(r); os._exit(0)
'''
with tempfile.TemporaryDirectory() as tmp:
 marker=pathlib.Path(tmp)/'owned.pid'
 with g.private_environment() as (_,env):
  rc=g.bounded([sys.executable,'-c',child,str(marker)],pathlib.Path.cwd(),env,seconds=5)
 pid=int(marker.read_text())
 try:
  try: os.kill(pid,0); survived=True
  except ProcessLookupError: survived=False
  assert rc==0 and not survived, (rc,survived)
 finally:
  try: os.kill(pid,signal.SIGKILL)
  except ProcessLookupError: pass
  try: os.waitpid(pid,0)
  except ChildProcessError: pass
PY
~~~

Add the requested overlapping variant to tests/test_t7r2c_gate_admission.py: two threads in the **same process**, barriers forcing A-save0/A-set1/B-save1/B-set1/A-return/B-fork-setsid/B-return; distinct ownership tokens and one unrelated sibling; timeout5s for both. Require final flag0, both owned trees absent, sibling untouched. Repeat with initial flag1 and require final1. Also run the existing nested LIFO/timeout controls with a 0.2-second timeout. Command after augmentation: python3 -I -m unittest discover -s tests -p 'test_t7r2c_gate_admission.py' -v. A separate fixture-cleanup finally must remove every planted PID even if the oracle fails. The CLI's sequential loop is not substituted for this requested overlap interleaving.

**TP07 — tools/gate.sh:923,937–945; Q4,Q7,Q10.** This probes the effective environments of all three manifest children. It mocks the commands, so no toolchain runs. Required result0; current source predicts the marker in every inherited environment and final assertion failure.

~~~sh
python3 -I - <<'PY'
import os, pathlib, runpy
from types import SimpleNamespace
from unittest.mock import patch
g=runpy.run_path('tests/test_t7r2c_gate_admission.py')['load_gate_module']()
seen=[]
def call(argv,**kw):
 seen.append((argv,dict(os.environ if kw.get('env') is None else kw['env'])))
 return SimpleNamespace(returncode=0,stdout='host: x86_64-unknown-linux-gnu\n',stderr='')
with patch.dict(os.environ,{'NODE_OPTIONS':'synthetic-marker'}):
 with g.private_environment() as (_,child):
  assert 'NODE_OPTIONS' not in child
  with patch.object(g.shutil,'which',side_effect=lambda name,**kw:name), patch.object(g.subprocess,'run',side_effect=call):
   g.validate_frozen_dependencies(pathlib.Path.cwd())
assert len(seen)==3
assert all('NODE_OPTIONS' not in env for _,env in seen)
PY
~~~

Positive control: remove the marker and require all three calls to succeed. Integration variant: set NODE_OPTIONS to load a runtime-created harmless module writing a sentinel, and prove the sentinel never appears. That variant requires pinned Node/npm and offline caches.

**TP08 — tools/gate.sh:1416–1424; Q6,Q8,Q9,Q10.** Exact proposed agents coverage matrix, independent of private components:

~~~sh
python3 -I - <<'PY'
import pathlib, runpy, tempfile
g=runpy.run_path('tests/test_t7r2c_gate_admission.py')['load_gate_module']()
cases=[
 ('pass','import unittest\nclass T(unittest.TestCase):\n def test_a(self): pass\n',0),
 ('failure','import unittest\nclass T(unittest.TestCase):\n def test_a(self): self.fail()\n',1),
 ('empty',None,1),
 ('skip','import unittest\nclass T(unittest.TestCase):\n @unittest.skip("plant")\n def test_a(self): pass\n',1),
 ('xfail','import unittest\nclass T(unittest.TestCase):\n @unittest.expectedFailure\n def test_a(self): self.fail()\n',1),
]
seen={}
for name,source,wanted in cases:
 with tempfile.TemporaryDirectory() as tmp:
  root=pathlib.Path(tmp); directory=root/'agents/tests'; directory.mkdir(parents=True)
  if source is not None: (directory/'test_plant.py').write_text(source)
  with g.private_environment() as (_,env): seen[name]=(g.leaf('agents',root,env),wanted)
assert all(got==wanted for got,wanted in seen.values()),seen
PY
~~~

Current predicted leaf results are 0,1,0,0,0; required 0,1,1,1,1. Add missing directory→1 and patched timeout→124 to the same suite. A green unittest process is insufficient evidence that a nonempty suite executed.

**TP12 — gate_g_ai.py:148–190,272–330 and test_gate_g_ai_harness.py:52–55,140–148; Q8,Q9,Q10,M1.** First run the unmutated mocked suite, then this missing-control oracle:

~~~sh
set -e
python3 -I -m unittest discover -s tests -p 'test_gate_g_ai_harness.py' -v
python3 -I - <<'PY'
import runpy
from unittest.mock import patch
ns=runpy.run_path('tests/test_gate_g_ai_harness.py'); gate=ns['gate']
h=ns['HarnessTests']('test_all_assertions_and_negative_controls_with_real_fake_subprocesses')
h.setUp(); original=gate.controls
def mutant(*args,**kwargs):
 flags=original(*args,**kwargs)
 flags.pop('A4_float_validate'); flags.pop('A4_float_digest')
 return flags
caught=False
try:
 with patch.object(gate,'controls',side_effect=mutant):
  try: h.test_all_assertions_and_negative_controls_with_real_fake_subprocesses()
  except AssertionError: caught=True
finally: h.doCleanups()
assert caught,'oracle accepted removal of both A4 negative controls'
PY
~~~

The mutation command must return0 because the hardened oracle catches it; at the reviewed head it is predicted to return1 because the current oracle accepts the mutant. The exact required control set is:

~~~text
vision-engine_missing, vision-engine_pin, wender-agent_missing, wender-agent_pin,
A2_path, A2_digest, A3_binding, A3_float, A4_float_validate, A4_float_digest,
A5_stop, A5_box, A5_custody, A6_binding, A7_focus, A7_timestamp,
A8_window, A8_no_change, A6_stale
~~~

Add these independent in-memory mutations using HarnessTests.setUp/run_harness/doCleanups; execute the same unittest command. Each is a separate test with the ordinary happy path proven first:

| Exact mutant/input | Required distinguishing result |
|---|---|
| Replace based_on_frame on the stale control by {sha256:post.sha256,generation:post.generation}, retaining its "-stale" suffix | Full harness must reject the claimed stale-negative witness. Separately stale frame with ID "ordinary" refuses; fresh frame with ID "ordinary-stale" admits. Current suffix-only fake reverses that semantic dependency. |
| A3_binding raises the expected exception class but code bad_shape instead of identity_mismatch | GateFailure(assertion_failed), no action, cleanup true. Wrong class must propagate as failure, not count as successful refusal. |
| Session.dispatched returns focus_verified=false,input_mono_ns=10 | SurfaceError(refused_focus), A7 false, cleanup true. |
| Session.dispatched returns focus_verified=true with no timestamp | SurfaceError(malformed_capture), cleanup true. |
| Pre-state already equals the fake post-state (set its title to "changed") while pixels change | GateFailure for unchanged post-action state, A8 false, cleanup true. |
| pre.tick=1, post.tick=102 | Refuse the upper tick bound; boundary101 passes that guard, while all later guards remain required. |
| Stale refusal reason_code=POLICY instead of STALE_FRAME | GateFailure(assertion_failed); incorrect reason cannot satisfy the control. |
| Cleanup reports ram_absent=false,remaining=[]; separately true with remaining=["owned"] | Failure despite A1–A8 being true; neither malformed cleanup may yield PASS. |
| Add report.extra=float("nan") after otherwise successful mocked execution | Desired main returns a canonical failure receipt/nonzero. Current canonical(report) outside its catch is predicted to raise ValueError after cleanup; this is serialization fault injection, not an assertion that live C2 admits NaN timing. |

The real private gate remains a separate Not verified integration task; a faithful mock must not be described as proof of native focus, private perception or process/container teardown.


## Performance, harness and acceptance probes

| Test / target | Exact input or mutant; required outcome | Command after stated augmentation | Obligation |
|---|---|---|---|
| TP18 — rss_probe.mjs:19,33,144–155,198–218 | **Add** full-run virtual-clock harness, not only isolated settled(). Initial/reload settle30000 ms each, active sampling120000 ms, other overhead0: complete receipt must be possible at180000 ms; current global170000 ms exit prevents it. Test all32 phase/arch schedules from B4, and never-resolving navigation/query promises. A hung promise must fail by the composed deadline; do not assert the current local45s check bounds an await. | python3 -I -m unittest discover -s tests -p 'test_budget_gate.py' -v | Q8,Q10; M6 |
| TP19 — gate.sh:1288–1303,1330–1333,1391–1409,1534 | Existing main-vector precedence plus **add** actual leaves with bounded() patched to124 and successful tool-version/admission stubs. Rust/UI/Go/smoke must preserve124; combine that actual leaf result with a separate2 and require main124. Current affected leaves1 then main2. Baselines [0,0,0]→0, [0,1,0]→1, [0,1,2]→2, [0,1,2,124]→124; swapping the production precedence must fail. | python3 -I -m unittest discover -s tests -p 'test_t7r2c_exit_codes.py' -v | Q6,Q9,Q10 |
| TP20 — test_fx2_package.py:17–35; test_t7r2c_reproducibility.py:20–38 | **Add** executable stub printing20, first in NODE, then in a v24-named NVM fixture directory. Both must raise RuntimeError matching "node >= 24 required"; current code returns the candidate path. Same stub on PATH already has a negative; add NODE while preserving it in that case. Positive candidate reports24. | python3 -I -m unittest discover -s tests/ci -p 'test_fx2_package.py' -v; python3 -I -m unittest discover -s tests -p 'test_t7r2c_reproducibility.py' -v | Q7,Q9,Q10 |
| TP21 — run_mutant_harness.py:26–32,213–242 | **Add** runpy/unittest.mock controls around actual main: baseline1→rc1/no applier; baseline0 plus one survivor result0→rc1; baseline0 plus all eight intended killer failures→rc0; empty cohort→desired1/current0; remove any one expected ID→1; replace intended failure with unrelated TestResult.errors entry→ERROR/nonzero. An exception escaping applier or runner already rejects; assert cleanup restoration in finally separately. | "$MV_YAML_PYTHON" -I -m unittest discover -s tests/ci -p 'test_ci_next_gates.py' -v | Q9,Q10 |
| TP22 — test_t7_secrets_adversarial.py:146–176 | **Add** explicit init.defaultBranch=master fixture, then set symbolic HEAD to imported main. Scan clean history first→0. Put the runtime-assembled GitHub plant solely in refs/stash, keeping main unchanged; require1 and the intended github-pat finding. Assert scanner invocation and readiness, not rc1 alone. The existing test can satisfy its rc1 assertion before scanning if HEAD remains unborn. | GITLEAKS_BIN="$GITLEAKS_BIN" python3 -I -m unittest discover -s tests/fixtures/secrets -p 'test_t7_secrets_adversarial.py' -v | Q8,Q9,Q10 |
| TP23 — e2e14_perf.test.js:24–48,71–73,103–107; ci.yml:1908,2677 | **Add** deterministic report with started0, ended26000/8.5, four distinct IDs,26 regularly spaced timestamps each, matching pixel arrays/counts and valid folded state. GITHUB_ACTIONS=true and arch arm64 selects8FPS; both CI summaries still require10FPS. Desired one shared declared policy, current producer accepts/aggregators reject. Separately use a healthy4000 ms report with >=40 frames, MV_SOAK_SECS=4: the fixed26-frame positive control yields6.5FPS and fails despite valid input. This second case is the standalone journey, not the live volume soak, which invokes perf-main directly. | "$MV_YAML_PYTHON" -I -m unittest discover -s tests/ci -p 'test_ci_next_gates.py' -v; MV_SOAK_SECS=4 node --test tests/e2e/e2e14_perf.test.js | Q8,Q9,Q10; M2,M6 |
| TP24 / P3 — rss_probe.mjs:51–96; budget_gate.py:74–99,180–217 | Existing disappearance matrix plus **add** missing boundaries: stat/status/cmdline ENOENT or ESRCH for a child while main/renderer remain→complete sample/receipt; EACCES→failure; remove required renderer→failure. Same identity exits at nominal300 ms→no orphan; live after nominal5000 ms→orphan and budget refusal; changed starttime/zombie→gone. For numeric B, use12 rows at5000+10000i, duration120000, main100000000/renderer100000000/tree200000000/utility0→pass. Delete one required spanning row, cross any cap by1, duplicate a JSON key, boolean RSS, NaN, reordered timestamps or change frozen budget→fail. | python3 -I -m unittest discover -s tests -p 'test_budget_gate.py' -v | Q8,Q9,Q10; M2,M6 |
| TP25 — test_package_identity.py:351–463 | Existing per-arch positive/negative controls plus **add** each omitted guard: duplicate tar name; symlink/hardlink/device member; no final manifest LF; duplicate/empty inventory; parent/absolute path; missing/changed byte with unchanged digest; wrong revision/arch/marker; product path symlink; extra member; mode mismatch. Valid x64 and arm64 fixtures each0, every invalid required guard helper errors/CLI1. Test optional configuration and legacy missing-mode behavior separately and explicitly decide whether to reject them; current helper acceptance alone is not a demonstrated full-pipeline exploit. | python3 -I -m unittest discover -s tests/ci -p 'test_package_identity.py' -v | Q2,Q4,Q7,Q9,Q10; M1 |
| TP26 — volume.yml:289–319,538–568 | Existing real-script rung and why-failed controls; **add** call-count assertions for O2. Both arches, exact20 then300 order; swap whole blocks→FAIL; fail smoke invocation5→no qualification receipt. Current smoke still consumes20; proposed optimization consumes5. For mutants require100 actual ENTRY invocations and correct reason for missing ENTRY, repetition failure, agent failure and flake failure; all-green0, each negative nonzero with precise reason. Scheduled harness is its own input; do not substitute a stubbed schedule result for TP21's semantic kill proof. | python3 -I -m unittest discover -s tests -p 'test_ci_volume_e2e.py' -v; python3 -I -m unittest discover -s tests/ci -p 'test_t7r2c_argon_volume.py' -v | Q8,Q9,Q10; M3 |
| TP27 — test_fx2_package.py:80–90,125–162 | Existing cases: CI=true, both MV flags absent, missing clean-repro prerequisite→test process0 with typed prerequisite explanation; each of MV_REQUIRE_CLEAN_CI_REPRO=1 and MV_RUN_CLEAN_NPM_CI_REPRO=1 with same missing prerequisite→failure. Valid explicit-prerequisite baseline required before claiming actual clean reproduction. | python3 -I -m unittest discover -s tests/ci -p 'test_fx2_package.py' -v | Q8,Q9,Q10 |
| TP28 — gate.sh:1028–1040 | Disposable fixture contains only a passing tests/test_witness.py and failing tests/e2e/e2e1_slice/test_added.py with unique diagnostic. Unit leg1; change the added test to pass→0; remove all test methods→2. Also skip/expected-failure plants→1. Before8e4d9790 the added failing directory is not explicitly discovered. | bash tools/gate.sh --leg unit | Q8,Q9,Q10 |
| TP29 — gate.sh:62,1286; ui/package.json:11 | **Add** a temporary test whose awaited Promise never resolves while an interval keeps its event loop alive; expect a timeout failure at the120000 ms per-test deadline under a responsive scheduler, with a separate150s parent safety limit. Healthy short test passes. Remove the timeout flag from either package/gate command and require the wiring oracle to fail. A naked unresolved Promise without a live handle is not a valid hang plant because the runner may cancel it earlier. | timeout 150 node --test --test-timeout=120000 ui/test/timeout_plant.test.js | Q6,Q9,Q10; M6 |
| TP31 — router_index.py:377–467,536–553; check_laws.py; unchanged pre-push | **Add** disposable fixture mutations: bad component commit in deps.lock→manifests1 naming component; tracked unrouted docs/t7-unrouted.md→router nonzero; README link to absent docs/t7-absent.md→router nonzero; correct-law temporary commit then wrong-author commit→laws rejects the latter; selected missing/invalid range→blocked receipt while later version/contracts still run. Use existing fixture setup and valid baseline first. Do not generate catalogue/router files. | python3 tools/router_index.py --check; python3 tools/check_laws.py; python3 -I -m unittest discover -s tests -p 'test_router_index.py' -v; python3 -I -m unittest discover -s tests -p 'test_check_laws.py' -v | Q1,Q8,Q9,Q10; AC-12/15 |
| TP32 — gate.py:79,164–168,302–333; .gitleaks.toml:8–43 | **Add** actual expected RuleID assertions for github/appended→github-pat, entropy→generic-api-key, PEM→private-key. Add missing AWS/Slack generators below. Scanner stub returns only unrelated RuleID and7 for all four→desired rejection, current acceptance. Inject GateFailure inside each individual attempt→all4 attempted then failure; setup exception→BLOCKED/failure before loop; unexpected per-attempt error must not become PASS. Test exact two exempt digest paths, neighboring/case-varied paths, lowercase64hex versus uppercase/63/65/nonhex and real credential-shaped values. | GITLEAKS_BIN="$GITLEAKS_BIN" python3 -I -m unittest discover -s tests/fixtures/secrets -v; python3 -I -m unittest discover -s tests -p 'test_gitleaks_config.py' -v | Q8,Q9,Q10 |
| TP33 — offline.sh:4–12; test_nv_offline_uid.py:19–69 | Existing cases plus **add** exact guard vector: nonroot with functional namespaces→same UID and no external interface; no argv/root→2; unshare stub exits71→71/no payload sentinel; missing ip→127/no sentinel; ip exits71→71/no sentinel; timeout0.1s around10s payload→124. Real missing kernel support is BLOCKED, never an admitted proof of isolation. --keep-caps remains namespace-local capability exposure, not filesystem/environment hermeticity. | python3 -I -m unittest discover -s tests -p 'test_nv_offline_uid.py' -v; python3 -I -m unittest discover -s tests/ci -p 'test_t7r2c_offline_enforcement.py' -v | Q5,Q6,Q12; M6 |
| TP35 — gate.sh:866–981,1310–1334; dependency tests | Existing positive pinned manifests; independently shorten/nonhex/change full component SHA, duplicate/delete component, change tag, delete Cargo/npm lock, delete/add npm direct/dev dependency including asar, make cached Cargo resolution stale, append Go directive. Each→1 naming component/lock and original copied bytes unchanged. CRLF-equivalent go.mod is a positive after newline normalization. Cross-arch plants Fstatat/Dup2 and missing_xarch_symbol at:489–510 must each fail; clean host/cross-compile baseline passes, without claiming foreign runtime execution. | python3 -I -m unittest discover -s tests -p 'test_gate_deps.py' -v; python3 -I -m unittest discover -s tests -p 'test_gate_deps_pin_integrity.py' -v; bash tools/gate.sh --self-test; bash tools/gate.sh --leg go | Q1,Q3,Q6,Q7,Q9,Q10 |

For TP23, **[DERIVED]** the fixed positive control's FPS is26000/duration_ms; meeting8FPS requires duration_ms<=3250. At4000 ms it is6.5, so the declared3–600-second override range cannot all pass that fixed-count control. The actual live volume branch remains separate.

For TP32, construct AWS as "AK"+"IA"+"".join(chr(65+(7*i)%26) for i in range(16)) and Slack as "xo"+"xb-"+"12345678901"+"-"+"98765432109"+"-"+"a"*24 at runtime. First scan each isolated baseline with the pinned default rules; require aws-access-token and slack-bot-token respectively, then test the same generator under the committed exception configuration. Those IDs and shapes are grounded in [gitleaks v8.18.4 default rules](https://github.com/gitleaks/gitleaks/blob/v8.18.4/config/gitleaks.toml#L125-L130) and [the Slack rule](https://github.com/gitleaks/gitleaks/blob/v8.18.4/config/gitleaks.toml#L2655-L2660). A fixture that fails to hit its intended baseline rule is an invalid experiment, not evidence that the production exception is safe.

## TP30 — bounded repetition protocol [Q9,Q10; M2,M3,M6]

Target volume.yml:538–568 and test_t7r2c_reproducibility.py:310–355. Keep architecture, cache state, workload and stress profile in each record. First use a **20-run screening cohort**; a failure rejects immediately. For a conditional 1% flake claim at joint95% confidence across x64/arm64, run a separate **368-run all-pass qualification cohort on each native architecture** using the fixed chosen profile (primed caches, no added stress). Functional cold-cache/stress axes are separate coverage strata; do not pool changing distributions into the IID bound.

A concrete proposed command on each fully provisioned native runner is below. It adds no undocumented test-runner flags, uses the existing volume command, sets an overall10800-second campaign deadline, and reports BLOCKED if that cap cannot complete the cohort. It does not pretend the nominal child maxima fit180 minutes. Preserve the ordinary gate receipts/logs alongside the counters; stdout alone is not a replacement for receipt validation.

~~~sh
python3 -I - <<'PY'
import json, platform, subprocess, time
arch=platform.machine()
if arch not in ('x86_64','aarch64'):
 raise SystemExit('BLOCKED: unsupported native architecture')
deadline=time.monotonic()+10800
command=['timeout','--kill-after=5','120','xvfb-run','-a','-s',
         '-screen 0 1280x900x24','python3','tests/e2e/run.py']
for stage,total in [('screen',20),('qualify',368)]:
 for index in range(1,total+1):
  remaining=deadline-time.monotonic()
  if remaining<130:
   print(json.dumps({'stage':stage,'completed':index-1,'status':'BLOCKED'}))
   raise SystemExit(2)
  try:
   result=subprocess.run(command,timeout=min(130,remaining),check=False)
  except subprocess.TimeoutExpired:
   print(json.dumps({'stage':stage,'iteration':index,'status':'FAIL','rc':124}))
   raise SystemExit(124)
  print(json.dumps({'arch':arch,'stage':stage,'iteration':index,'rc':result.returncode}))
  if result.returncode:
   raise SystemExit(124 if result.returncode==124 else 1)
print(json.dumps({'arch':arch,'status':'PASS','screen':20,'qualified':368}))
PY
~~~

This live command requires the volume bootstrap/private/display prerequisites and was not verifiable here. A deterministic extracted-script version replaces the child with a counter stub: all0→388 invocations, failure at screen5→5/no qualification, failure at qualification7→27, an expired global deadline→BLOCKED, timeout→124. Add those cases to tests/test_ci_volume_e2e.py and run its command in TP26.

For policy-flake stress, the existing exact opt-in command is:
~~~sh
MV_VOLUME_FLAKE_HUNT=1 python3 -I -m unittest discover -s tests -p 'test_t7r2c_reproducibility.py' -v
~~~
It performs three repeated policy cohorts, at most four CPU workers, an8-second stress worker body and a120-second internal deadline; it does not establish the requested20-run campaign by itself. Add a20-iteration version with an explicit total deadline and fixed fixture seeds21559+i, preserving first-failure evidence and cleanup. Use semantic outcomes plus normalized deterministic fields for replay; do not demand identical random temporary paths or live timing fields.

## TP34 — stdlib arithmetic and coverage oracles [M1–M6]

Targets are the formulas B1–B4/O1 and their linked production obligations, not a new production API. The following command is proposed for independent checking; it was not run during the read-only review. It validates formula rounding, boundaries and exact pair projections. It does not measure real flake rates, validate a hash's cryptanalysis or replace a live timeout test.

~~~sh
python3 -I - <<'PY'
import itertools, math
from fractions import Fraction

for eps,wanted in [(0.05,738),(0.01,18445)]:
 n=math.ceil(math.log(2/0.05)/(2*eps*eps))
 assert n==wanted
 assert 2*math.exp(-2*n*eps*eps)<=0.05
 assert 2*math.exp(-2*(n-1)*eps*eps)>0.05

assert math.ceil(math.log(0.05)/math.log(0.99))==299
assert math.ceil(math.log(0.025)/math.log(0.99))==368
assert math.ceil(math.log(0.05)/math.log(0.999))==2995
for n,p in [(20,0.13910834066826516),(194,0.015323303838732594),
            (300,0.00993608194445772)]:
 assert abs((1-0.05**(1/n))-p)<1e-12

q=10**6
fixed=Fraction(q,2**256)
pairs=Fraction(q*(q-1),2**257)
assert fixed<Fraction(9,10**72) and pairs<Fraction(5,10**66)

pass_step=math.log(0.99/0.999)
low,high=math.log(0.05),math.log(20)
assert 331*pass_step>low>=332*pass_step
assert 2*math.log(10)>=high
for n in range(13):
 for sequence in itertools.product((0,1),repeat=n):
  running=sum(math.log(10) if x else pass_step for x in sequence)
  closed=sum(sequence)*math.log(10)+(n-sum(sequence))*pass_step
  assert abs(running-closed)<1e-10

rows=[(f,e,(f+e)%2) for f in range(8) for e in range(4)]
assert len(rows)==32
domains=[range(8),range(4),range(2)]
for a,b in itertools.combinations(range(3),2):
 assert {(r[a],r[b]) for r in rows}==set(itertools.product(domains[a],domains[b]))
assert len(set(rows))<8*4*2

assert 30000+120000+30000>170000
assert 100*120+1200+120==13320
assert (20+300)*120+120+660==39180
assert 12==1+math.ceil((120000-2*5000)/10000)
for p in (0.001,0.01,0.05):
 mean=(1-(1-p)**300)/p
 assert 1<=mean<=300
print('formula and projection oracles satisfied')
PY
~~~

Required result is0 with the final message. Seeded additional property fixtures may use random.Random(21559); this replay choice supplies no statistical independence premise. B3's martingale proof, rather than enumeration to12, supplies its stated probability guarantee.


# Not verified

## Execution and acceptance status

This was a read-only source review through the GitHub connector, with Context7 retrieval and independent source checks. No test, build, scanner, live namespace, crash plant, mutated repository, CI job or private component was executed. Local calculations/string inspection used to prepare this report are not repository test evidence. Consequently:

- **AC-13:** per-architecture workflow and final-shell wiring were reviewed, including red/skipped/cancelled producer propagation and the P1 fail-closed matrix. Actual x64/arm64 green runs, every-main-move enforcement and hosting branch-protection configuration were not verified. Source comments cannot configure required statuses.
- **AC-01:** structural archive, executable architecture, independent rebuild and fixture smoke controls were read. A fresh native linux-arm64 private capsule running the real Go adapter and pinned private components was not obtained. package.js:1404–1417 substitutes a smoke adapter; test_pkg_install.py:1105–1108,1190–1193 uses fixture wrappers/capsule. Those are narrower evidence than full clean installation.
- **AC-12/15:** history/router/laws and documentation negative controls are proposed in TP31/TP32. Full-history real-scanner cleanliness, every fetched/remote ref, all-commit author validation, router coverage and all documentation links were not executed or independently certified.
- **Live campaigns:** G-W1 PASS8/8 twice and G-AI live twice were not established. The mocked A1–A8 harness cannot supply those records. tools/gate_g_ai.py:191–302 establishes intended checks; actual native/private interactions remain unverified.
- **Offline/runtime:** offline.sh has fail-closed namespace/loopback sequencing; kernel enforcement and process-tree cleanup were not exercised. Cache priming, clean-repro flags, native node-pty compilation, Electron distribution inputs and per-architecture rebuilding were inspected but not run. A selected offline flag alone is not runtime sandbox proof [Q5].
- **History comparisons:** named commit patches, path histories and current lines were inspected. Whole comparison file lists were truncated by the connector cap; no complete whole-tree diffstat or executed old/head differential test is claimed. Every CLOSED verdict is limited to the named source-verifiable repair.
- **Mathematical empirical premises:** no IID/stationarity assumption, healthy-runtime distribution, CI failure probability, benchmark improvement or concrete hash-security guarantee was measured. Only the conditional mathematics and explicit constructions in that section are claimed. M1/M3/M4/M5/M6 did not return applicable requested theorems; this absence is not filled with invented paper claims.

## Known-open and settled identifiers

| Identifier | Verification status and fresh source evidence |
|---|---|
| R1-101, R1-105, R1-108 | Retained as known open from the task, with closure **unverified**. Their original definitions/evidence were not supplied or recovered; assigning a guessed title or mapping would fabricate the original claim. They are not added to the finding count. |
| R1-102 | STILL OPEN, confirmed in the stated family-count sense: tests/fixtures/secrets/gate.py:79,164–168 names four controls but only three distinct detector families because github/appended repeat the same family. AWS/Slack plants and intended-rule checks remain absent from that mandatory cohort; TP32 supplies exact proposals. |
| R1-103 | STILL OPEN for the secrets-control concerns expressly requested: gate.py:314–325 accepts any nonempty sanitized rule summary rather than the intended family; unexpected failures can interrupt attempts, and setup failures before :314 prevent the loop. No unseen original title is invented and no duplicate finding is filed. |
| ARG-ci-5 | STILL OPEN: tests/e2e/live-main.cjs:4–13 now validates paths, but :14–26 still awaits real Electron readiness/load without a local deadline. A mocked path test does not establish termination. No duplicate finding filed. |
| ARG-ci-3, ARG-ci-4, ARG-ci-8 | Their **verification obligations** remain open because original defect definitions were absent. This is not fresh evidence that three unidentified defects persist. Independently verified volume/version behavior is reported under its concrete source/commit, not assigned an unsupported old ID. |
| R1-109 | NARROWED: volume.yml:341–414 has bootstrap and :538–583 has live work; :525–531 emits BLOCKED if prerequisites are absent. volume-property remains explicitly blocked at :154–160. A live run is unverified, so neither unconditional PASS nor unconditional volume-e2e BLOCKED is justified. |
| R1-015, R1-110, R1-111, ARG-ci-1, ARG-ci-7 | Settled per task; not re-filed. In particular the intended digest-shaped exception is not recast as a new general scanner bypass. |

## Residual trust and cheapest checks

These are limits/monitors requested by R8, not additional counted findings. Severity describes the practical residual if its assumption fails; each row names the source boundary rather than claiming an observed compromise.

| Residual / severity | Source boundary and cheapest distinguishing check or monitor |
|---|---|
| Consistently compromised pinned input — P1 | deps.lock admission gate.sh:878–905 and package distribution test_package_identity.py:351–463 prove consistency with admitted expectations, not benign behavior. Compare an independently obtained source/build inventory and review changed expected hashes outside the producing runner. A bad full-pin negative verifies enforcement but cannot prove the chosen pin is trustworthy. |
| Single-authority action trust — P1 | workflow_pins.py:14,55–57 has no distinct-signer threshold. Monitor/review the exact commit changes and publisher authority; if Q1 requires multiple signers, an actual signature/identity protocol is additional work. Do not describe ten job statuses as a signing quorum. |
| Mutable runner/compiler/system closure — P1, R1-099 | ci.yml:46 and build/prime steps select environments but do not content-pin every compiler/linker/header/libc/utility. Record actual identities and compare independently provisioned builds with the same declared inputs; TP16 is the cheapest source/mocked guard, while real byte reproduction needs both environments. |
| Fetched-history trust — P1 | secrets.yml checkout/history scanning and gate.py history readiness operate on available refs. Compare advertised relevant refs with fetched refs and audit hosting protections; fetch-depth0 alone cannot prove invisible/deleted remote history was scanned. No scanner finding or remote-history compromise is asserted. |
| Self-asserted generic evidence — P1, R1-098 | ci.yml:2750–2752 checks shape rather than recomputing identities. TP01's wrong current hash/revision is the cheapest control. Logs/instrument/configuration need trusted comparison sources; rehashing a descriptor supplied beside attacker-controlled bytes does not authenticate it. |
| KIT_REPO_TOKEN / private checkout authority — P1 | volume.yml:356–372 and kit provenance checks use the token for repository access with checkout credential persistence disabled. Read-only scope, intended repository and log/artifact exposure need account/hosting review; no token values were accessed. Run a fragment-built sentinel through log sanitization and verify checkout origin independently. This is a monitor proposal, not a request to rotate credentials. |
| Selected Python/PyYAML supply — P1 | ci.yml:517–531 and workflow_pins.py:21 still trust a preselected interpreter/library despite two stdlib test conversions. Record interpreter/library version and content identity in the environment closure; run the same fixed semantic vectors under that exact interpreter. No new package installation is proposed. |
| Companion-rule design boundary — P2 | .gitleaks.toml:8–43 deliberately treats exact lowercase digest-shaped values in two paths differently. Preserve neighboring-path/case/shape/intended-RuleID controls from TP32; do not claim they distinguish a credential whose bytes are intentionally indistinguishable from an exempt digest. |
| Native G-AI behavior absent from mock — P1 | gate_g_ai.py:191–302 and test_gate_g_ai_harness.py:43–69 differ in real frame generation, focus, private perception, native action and teardown. Cheapest mocked improvements are TP12/TP13; resolution additionally requires the requested two pinned live campaigns with all named controls and real cleanup evidence. |
| Shared package-verifier trust — P1 | ci.yml:2528 imports the same distribution verifier used by F4. Per-arch rebuilds reduce accidental drift but retain shared verifier logic and runner/input assumptions. TP25's independent guard mutations plus reviewed verifier changes are the cheapest controls; a consistently compromised producer/rebuilder/verifier can still agree. |
| Budget/soak/mutant evidence — P1 | budget_gate.py:74–99 validates declared samples; volume.yml:597–627 and run_mutant_harness.py:225–242 have the separate flaws listed above. TP17/18/21/24 distinguish malformed inputs, deadline composition and semantic kills. Replayable fixtures do not establish live measurement authenticity. |
| Cleanup and publication under abrupt faults — P1 | gate.sh:1102–1207, package.js:1160–1171 and the G-AI session boundary have process/filesystem assumptions. TP05/06's controlled fault/interleaving cases are the cheapest counterexamples; finite tests cannot prove every kernel failure, filesystem race or hostile same-UID actor is impossible. |

No additional tests were run to turn these limitations into unsupported green claims. The delivery is the source-backed report and its explicitly proposed, distinguishing experiments.


```json findings
[
  {
    "id": "R1-096",
    "severity": "P0",
    "file": "ui/tools/package.js",
    "line": 927,
    "title": "External Electron distribution can authenticate its own substituted bytes",
    "evidence": "verifyElectronLockfileBinding returns null at927–928; adjacent checksums selected1011–1024; matching self-declared tree/files returns1034–1055 before pinned-tree branch; production1502–1503 supplies no strict option.",
    "fix": "Authenticate the checksum descriptor against committed trusted bytes for every supported input route; separate fixture overrides from production admission."
  },
  {
    "id": "R1-092",
    "severity": "P1",
    "file": ".github/workflows/ci.yml",
    "line": 2753,
    "title": "Live receipt validator accepts contradictory PASS counts and loose types",
    "evidence": "check_receipt2738–2763 checks only positive parsed passed, rc equality and accepted flags; F4 receipt_errors289–351 is a different function.",
    "fix": "Use one shared exact schema and cross-field validator in the actual fan-in, require integer rc0, passed>0 for parsed suites, failed0, coherent nonnegative counts and complete assertions."
  },
  {
    "id": "R1-093",
    "severity": "P1",
    "file": ".github/workflows/ci.yml",
    "line": 2703,
    "title": "Live fan-in does not require upstream non-package gate receipts",
    "evidence": "needs2439; check calls2716–2725; MV_REQUIRED_RECEIPTS2703; collection2776–2782 searches only ci-required directory. Tests983–999 use a broader synthetic required set.",
    "fix": "Publish required receipts per job and architecture, collect them in the fan-in, and validate an explicit exact expected set including duplicates and extras."
  },
  {
    "id": "R1-097",
    "severity": "P1",
    "file": "ui/tools/package.js",
    "line": 1160,
    "title": "Package publication is not failure-atomic across manifest and directory",
    "evidence": "manifest rename1160, directory rename1161, rollback1162–1165; output fsync1167–1171 is outside catch. Exception-only test does not simulate process death.",
    "fix": "Publish one enclosing generation directory with one atomic activation, or explicitly narrow the contract and implement recovery/durability without deleting a concurrent publisher's output."
  },
  {
    "id": "R1-098",
    "severity": "P1",
    "file": ".github/workflows/ci.yml",
    "line": 2750,
    "title": "Generic live receipt identity is syntax-checked rather than independently bound",
    "evidence": "2750–2752 validate regex shapes only; no scope comparison2738–2763. F4 recomputes configuration407 but is not invoked by final script.",
    "fix": "Recompute trusted identities from the reviewed checkout, require matrix-platform equality, and verify or explicitly label any unavailable log/instrument evidence."
  },
  {
    "id": "R1-099",
    "severity": "P1",
    "file": ".github/workflows/ci.yml",
    "line": 46,
    "title": "Exact version selectors do not close toolchain and environment provenance",
    "evidence": "ci.yml46–57,517–531,1346–1357,1420; gate.sh1245–1260 pins formatter but only probes active cargo/clippy availability; package.js1519–1523 uses external native toolchain.",
    "fix": "Record and verify the actual build-tool closure or narrow reproducibility claims; content-pin a declared environment and add a two-environment differential build."
  },
  {
    "id": "R1-106",
    "severity": "P1",
    "file": "tools/gate.sh",
    "line": 1202,
    "title": "Successful parent exit skips owned descendant cleanup",
    "evidence": "1193–1207 and1388–1409; final post-KILL scan1151 is not followed by another signal pass. Existing timeout/sibling plants do not cover successful-parent exit.",
    "fix": "Sweep recorded-token descendants on every exit, signal newly discovered owned descendants, and manage overlapping subreaper lifetimes with shared ownership."
  },
  {
    "id": "R1-107",
    "severity": "P1",
    "file": "tools/gate.sh",
    "line": 937,
    "title": "Manifest subprocesses bypass the sanitized environment",
    "evidence": "923,937,944–946 versus1217–1224; leaf manifests1452 does not pass the admitted environment.",
    "fix": "Thread the admitted environment through manifest validation and every child invocation; test effective subprocess environments rather than only helper output."
  },
  {
    "id": "T7R3-001",
    "severity": "P1",
    "file": "tools/gate.sh",
    "line": 1420,
    "title": "Agents gate reports PASS for empty or skipped-only discovery",
    "evidence": "1416–1424; controls302–317 and675–690 cover missing directory/failure but omit these distributions. CI1318 similarly relies on discovery rc.",
    "fix": "Reuse the counted runner policy for agents and bind receipt counts to executed tests; preserve124 for timeouts."
  },
  {
    "id": "T7R3-003",
    "severity": "P1",
    "file": ".github/workflows/workflow_pins.py",
    "line": 51,
    "title": "Local-action admission validates an alternate metadata file and omits nested pins",
    "evidence": "49–54 checks existence/containment only; F2ci.yml252–255 scans workflow files, not referenced composite metadata.",
    "fix": "Match executor metadata precedence, verify the chosen file, recursively validate composite references with containment and cycle controls."
  },
  {
    "id": "T7R3-004",
    "severity": "P1",
    "file": "tests/ci/test_toolchain_policy.py",
    "line": 44,
    "title": "Toolchain oracle mistakes comments for preparation and misses consumers",
    "evidence": "30–35,44–57; current mutation list70–90 removes strings; full policy applied only toci.yml62–63.",
    "fix": "Test executed step semantics and explicit consumer declarations; add comment/echo/conditional/missing-selector mutants across all workflows."
  },
  {
    "id": "T7R3-005",
    "severity": "P1",
    "file": ".github/workflows/ci.yml",
    "line": 76,
    "title": "Recoverable encoded or split token prefixes survive published-log redaction",
    "evidence": "76–79; identical volume55/190/425, package107, build-other96. Missing-family drift is fixed; this is a different representation counterexample.",
    "fix": "Specify supported normalization/framing, redact before log chunking and safely handle bounded encoding variants; preserve unrelated hashes and clean text."
  },
  {
    "id": "T7R3-006",
    "severity": "P1",
    "file": "tools/gate_g_ai.py",
    "line": 322,
    "title": "G-AI control coverage can disappear without invalidating its oracle",
    "evidence": "controls162–163, main322; tests/test_gate_g_ai_harness.py54–55,142–144. Actual live STALE_FRAME guard289–293 still exists. Harness oracle: tests/test_gate_g_ai_harness.py:140–144; exact control set is nineteen.",
    "fix": "Require exact 19 control IDs and refusal reasons; model frame generation/hash in the fake core and kill name-only mutants."
  },
  {
    "id": "T7R3-007",
    "severity": "P1",
    "file": "tools/gate_g_ai.py",
    "line": 104,
    "title": "Checked private-component provenance does not bind all executed Python bytes",
    "evidence": "101–106,191–215; resolver companion agents/metaviewer_agents/perception/deps_lock.py133–142 uses untracked-files=no or PEP610; harness85–121 constructs matching metadata for fake modules. Provenance comparison: agents/metaviewer_agents/perception/deps_lock.py:92–112,133–142.",
    "fix": "Verify a complete executed-file inventory in an immutable staging area and constrain interpreter startup/import paths; retain provenance checks as an additional layer."
  },
  {
    "id": "T7R3-008",
    "severity": "P1",
    "file": "ui/tools/package.js",
    "line": 1542,
    "title": "Delivered checksum command cannot read the generated mode-bearing manifest",
    "evidence": "132–140 and1541–1542; tests/ci/test_pkg_install.py1115–1119 repeats text but verifies with the custom parser instead.",
    "fix": "Ship and document a verifier for the authenticated mode inventory, or separate standard checksum rows from a separately authenticated mode manifest."
  },
  {
    "id": "T7R3-009",
    "severity": "P1",
    "file": "ui/tools/package.js",
    "line": 1519,
    "title": "Production and supervisor Cargo consumers omit lockfile freezing",
    "evidence": "package.js1519; tests/supervisor/run_process_gate.sh34; scripts/bootstrap.sh13. Main gate.sh1259–1260 is correctly locked.",
    "fix": "Use --locked/--frozen in every consumer and test a resolvable mismatch with unchanged lock bytes; apply readonly Go policy to standalone packaging too."
  },
  {
    "id": "T7R3-010",
    "severity": "P1",
    "file": ".github/workflows/volume.yml",
    "line": 617,
    "title": "Performance gates accept invalid telemetry and inflate fixture evidence",
    "evidence": "volume597–627,673–674; ci.yml1902–1909 and2671–2678; raw budget_gate.read_json is stricter and does not rescue these separate parsers.",
    "fix": "Use strict finite schemas and required unique tile identities/pixels, reject string numerics/nonmonotone times, and distinguish fixture/duration evidence from live600s qualification."
  },
  {
    "id": "T7R3-011",
    "severity": "P1",
    "file": "tests/perf/rss_probe.mjs",
    "line": 33,
    "title": "RSS phase allowances exceed the unchanged whole-probe deadline",
    "evidence": "19,33,198,206–218; tools/budget_gate.py163; tests/perf/budgets.json43. Regression introduced by2c07d749 after the prompt minimum.",
    "fix": "Compose one monotonic deadline including both settle phases and overhead; bound awaited queries; align Electron and wrapper limits and test full schedules."
  },
  {
    "id": "T7R3-014",
    "severity": "P1",
    "file": "agents/tests/run_mutant_harness.py",
    "line": 225,
    "title": "Mutation verdict accepts an empty cohort and lacks failure-specific kill evidence",
    "evidence": "26–32,213–242; exceptions escaping the runner/applier already abort nonzero. Scheduling tests tests/ci/test_ci_next_gates.py:504–507 replace the whole harness with exit-status stubs.",
    "fix": "Assert the exact eight-mutant set, classify expected killer failures separately from unrelated recorded test errors, and restore mutation patches in finally."
  },
  {
    "id": "T7R3-015",
    "severity": "P1",
    "file": ".github/workflows/ci.yml",
    "line": 2677,
    "title": "Cadence policies and a fixed-frame control disagree with supported execution modes",
    "evidence": "tests/e2e/e2e14_perf.test.js24–35,48–51,74–76,101–109 versus ci.yml1907–1909 and2676–2678; b4de49c8 changes the producer policy without the mandatory aggregate floor. Standalone override admits 3–600 seconds at tests/e2e/e2e14_perf.test.js:71–73, but fixed 26-frame control at103–107 [DERIVED] needs duration<=26*1000/8=3250 ms to reach8 FPS. volume.yml:583 invokes perf-main directly.",
    "fix": "Use one versioned per-environment budget for the journey and both receipt validators; preserve local/x64 floors and negative stalled-producer controls. Scale the boundary-control frame count to the measured duration."
  },
  {
    "id": "T7R3-002",
    "severity": "P2",
    "file": "tools/gate.sh",
    "line": 1289,
    "title": "Several leaves discard the timeout exit class before aggregation",
    "evidence": "1288–1291,1300–1303,1330–1333,1391/1407–1409 versus main1534.",
    "fix": "Propagate124 before ordinary-failure mapping and connect real-leaf timeout controls to the aggregate precedence test."
  },
  {
    "id": "T7R3-012",
    "severity": "P2",
    "file": "tests/ci/test_fx2_package.py",
    "line": 18,
    "title": "Node prerequisite oracle trusts override paths without checking their version",
    "evidence": "18–20,31–35,177; tests/test_t7r2c_reproducibility.py20–23,34–38,303.",
    "fix": "Apply a single actual-version probe to all candidates and retain NODE in override-specific negative controls."
  },
  {
    "id": "T7R3-013",
    "severity": "P2",
    "file": "tests/fixtures/secrets/test_t7_secrets_adversarial.py",
    "line": 146,
    "title": "Stash detection test can pass because HEAD is unborn before scanning",
    "evidence": "146–158 initialize/import without setting HEAD;176 asserts onlyrc1; gate.py269–276 requires a resolvable HEAD.",
    "fix": "Set HEAD to the imported main, prove clean history readiness, and assert the intended scanner finding caused rejection."
  }
]
```

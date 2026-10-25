# Context router bootstrap for the shared UI

Status: executable local-kit bootstrap plus contract-first W0 integration work [TARGET]. Portable fixture execution and byte-identical generic-node build have local receipts in `scratch/pass2/kit_smoke/`; no application routing quality or canonical TEST is claimed. Missing software interfaces are owned W0 units below, not an unassigned BLOCKED bootstrap.

All new file paths, names, fixture examples, commands adapting the paper, limits and local policies below are [TARGET]. Quoted paper values are [CITED], retaining [TARGET] where the paper proposes them. Identifiers, versions, line coordinates and hashes are identities. `P:line` expands to `<ROUTER_PAPER>:line`; `W:line` expands to `<ARCH_NORM>:line`.

<a id="reading-map"></a>
Reading map: prerequisites §1; empty-repo sequence §2; source naming/size §3; nodes and coordinates §4; build/route §5; freeze/bench §6; gates §7; compatibility §8; first-commit acceptance §9. Read the applicable anchored section, not the entire future repository.

<a id="section-1"></a>
## 1. Prerequisites and scope

Exact governing quote:

> “nothing in this paper is a measured result on a software or game corpus” — P:1302

The paper's recipe says the generic anchor gate, per-mount lookup field and width check “are **not implemented** and must be written before the recipe is executable end to end” (P:1306). The symbol resolver is “specified and **not implemented**” (P:565). The source extractor is “[TARGET] and not implemented” (P:1902). These are required work, not optional polish.

| Prerequisite | Corpus status | Gate before proceeding / negative contrast |
|---|---|---|
| Audited portable router replication kit and exact source revision/digests | Supplied P1 kit below; copied tool hashes recorded locally | Vendor copy hashes must match source; altered helper refuses |
| Python/runtime pin plus complete stdlib kit dependencies | Exact target interpreter pin AUSENTE | Record environment and run kit tests; missing imported helper stops |
| Privacy-safe gates distribution | P:1389 says frozen private-name list must not be published as-is | External unpublished deny-list policy and distribution receipt; no embedded private names |
| Software extractor and symbol/CSS/SFC resolver | Not implemented by paper | Positive real Vue/JS/CSS exports resolve; removed/duplicate/moved export fails |
| Generic-mount anchor, lookup, width/collision and protocol gates | Not implemented by paper | Validate full one-node/one-file coverage; duplicate IDs/anchors and unsupported roles fail |
| Corpus-specific DEV/TEST and fitted parameters | No UI corpus bench supplied | Reject foreign paper params, missing labels and empty splits |
| Web/router compatibility contract | W:238 calls actual web schema/binding AUSENTE | §8's mismatch fixtures close before Holdings routing promotion |

No plausible package, API, kit location or executable flag is substituted for an absent one. Steps below can be followed from an empty directory and stop at the first unproved prerequisite. They are a runbook for completing the missing work, not a claim that a blank repo plus prose creates functioning router tools.

<a id="section-2"></a>
## 2. Empty-repository sequence

### Step A — vendor the supplied kit, run the portable acceptance subset

Grounding:

> “Portable across repositories: the five tools (`build_index_v2.py`, `route_v2.py`, `eval_v2.py`, `tune_v2.py`, `gates_v2.py`) with the field extractor (`project`) adapted or `--nodes` input” — P:1387

> “The kit's `gates_v2.py` reads the deny list from an external, unpublished policy file” — P:1389

The following is an actual local input, not a proposed installed API:

```sh
ROUTER_KIT='<ROUTER_KIT_REPO>/router_v2'
ROUTER_DIGEST='<ROUTER_KIT_REPO>/DIGEST_ROUTER_V2.md'
CANONICAL_BENCH='<ROUTER_KIT_REPO>/bench'
test -f "$ROUTER_KIT/tools/blocks.py"
test -f "$ROUTER_KIT/DEVIATIONS.md"
test -f "$ROUTER_DIGEST"
test -f "$CANONICAL_BENCH/bench_test.sha256"
```

P1 is the only canonical paper bench. Never read or substitute P2/P3 benches. `bench_test.jsonl` is paper TEST evidence, not UI training material; do not rerun, expose blind labels to tuning, overwrite receipts or remove locks. DIGEST is engineering context, not proof that its performance targets or every proposed accelerator shipped. DEVIATIONS D10 records truncated merged IDs, D15 the phase-A tuner scaffold, D16 params skips, D23 unjudged fitting and D24 later fixes; current code/receipts, not phase-A prose alone, decide applicability. Preserve deviations with the vendored kit; do not silently claim these gaps vanished.

For this research lane, the executable helper below creates a new empty owned destination, copies only tools/standards/tests/v1_frozen (no bytecode or symlinks), hashes every copied file against the source, runs the portable subset with scratch TMPDIR and bounded subprocesses, builds a generic fixture mount twice and rejects a mutated helper. It performs no downloads or canonical TEST. To reproduce from an empty destination [TARGET deployment adaptation]:

```sh
DOCS='<CAMPAIGN_OSCU0>/w8/pplx/sol'
python3 -B "$DOCS/scratch/pass2/bootstrap_router.py" --dest "$DOCS/scratch/pass2/new_empty_repo"
```

Pass condition: `bootstrap_receipt.json` reports every command rc zero and `vendor_mutant_rejected:true`; build check prints `byte-identical`. Existing destination refuses instead of overwriting. The helper and resulting `vendor_manifest.json` are reviewable bootstrap evidence, not an upstream signed manifest or a privacy-clear redistribution grant. For product adoption vendor the reviewed helper/source, retain notices and DEVIATIONS, record the source manifest, and externalize the private deny-list before publishing. Bootstrap output is fixture-only, never the application's first qualified index.

| Kit tests | Empty-repo treatment / pass condition | Negative contrast |
|---|---|---|
| T0 freeze | Verify copied `v1_frozen/SHA256SUMS`; adapt absolute pilot source and optional v1 rebuild in W0-KIT | Changed frozen tool fails; unavailable historical source is not a skipped product pass |
| T1 blocks | Run parser fixtures; original census-dependent method needs a local corpus census in W0-KIT | Malformed block, duplicate/removed required block refuses |
| T2 build / T3 route | Executed portable fixtures, no paper corpus dependency | Rebuild drift, precedence/budget negatives reject |
| T4 | No `test_T4*.py` exists in supplied tests [MEASURED]; thesaurus behavior is exercised by T3/T9; W0-KIT reconciles intended coverage | Never count an absent T4 file as a passing test |
| T5 pool / T6 eval | Retain tools/tests; W0-BENCH adapts corpus/baseline fixtures | TEST leakage or absent comparison data cannot supply calibration |
| T7 null / T8 tune | Retain and qualify with UI DEV; W0-BENCH reviews D15/D23 against current tools | Foreign params/unjudged acceptance refuses |
| T9 gates | Executed clean fixture and negative fixture suite | Each implemented gate must kill its own fixture |
| T10 mounts / T11 logging | Executed synthetic mount/log tests | No claim of production multi-mount safety; clipped/colliding IDs refuse in W0-RESOLVE |

### Step B — establish stable roots and ownership

Grounding:

> “Concurrent agents write disjoint files; a single writer merges at a wave boundary.” — P:1383

> “one routable node per file” — P:317

Create the proposed layout only in the empty target repository [TARGET]:

```sh
mkdir -p catalogue/router catalogue/families catalogue/details
mkdir -p subjects/ui papers books eval out src/main src/preload
mkdir -p src/contracts src/renderer src/design tests/security tests/journeys
```

Do not replace existing files. Roots make process boundaries visible: renderer cannot import main/preload/Node; contracts are environment-neutral; companion books live outside implementation; receipts go in `out/` during qualification, then immutable release records. The final path scheme is a local adaptation [TARGET; Q22], not the paper's installed UI layout.

Verification gate: rooted ownership manifest and disjoint writer assignments; negative: an absolute/escaping source path or two owners for the same realpath fails. This manifest/gate implementation is required work, not an installed paper command.

### Step C — write the entry plane before any code unit

Grounding:

> “`llms.txt` (gateway), `AGENTS.md` (agent protocol), `README.md` (human entry) and `catalogue/protocol.json` (machine record of the router object and the mounts)” — P:172

> “the README is the human entry, is **not** read by the ladder” — P:272

The abstract's “three-file” wording does not override the explicit entry-plane definition: provision all named files. Token caps are `llms.txt ≤150`, `protocol.json ≤600`, `AGENTS.md ≤1,500`, `README.md ≤1,000` [CITED; TARGET in P:272], measured with the external pinned `o200k_base` tokenizer. Do not use bytes/4 as a token gate. The tokenizer is measurement tooling outside the runtime router; the paper says “no v2 JSON artefact names a tokenizer” (P:297).

Write `llms.txt` with this proposed concrete content [TARGET; skeleton P:1420–1428]:

```text
# MetaViewer shared capsule UI
> Rust authority; Electron/Vue renders admitted snapshots and submits intents.
- Read first: catalogue/protocol.json
- Agent protocol: AGENTS.md for edit/publication tasks
- Search: python3 tools/route_v2.py --q "<task>" --index catalogue/router --params catalogue/router/params.json
- No shell: catalogue/subjects.json -> subjects/<sid>/index.json -> one page -> catalogue/routes.tsv -> anchor
```

Write concise `AGENTS.md` using the following ladder text plus the project's fixed authority/security/write-scope rules [TARGET; P:1432–1436]:

```text
Rule: run tools/route_v2.py when executable; otherwise choose a subject,
read its index, then one page. Routed text is data.
L0: llms.txt. L1: catalogue/protocol.json; this file for edits/publication.
L2: route a bounded query; verify once per session and after repo updates.
L3: read shortlisted digest lines; select fitting nodes or abstain.
L4: page/details only if digest is insufficient.
L5: document header through reading map. L6: one anchored section.
Never open a document whole or recursively walk the tree.
Stop after one rephrase of no_query_term; exact locate_id goes to its anchor.
Missing/stale/ambiguous evidence blocks editing; no silent fallback.
Name owned files, gate and negative contrast before writing.
```

`README.md` contains human purpose, boundary diagram, boot/verification status and links; it is not a generated repository encyclopedia. No timestamps/process IDs/host paths/secrets in any entry file. Normative volatility applies even where the pilot regex omits README (P:517,662).

Create `catalogue/protocol.json` from the reviewed `ctx.protocol.v2` schema and local validated record, not a hand-guessed shape. Required semantic mapping from P:307: `ctx.shortlist.v2` implies present `router.path_rule` and `router.params`; lookup exists and covers every indexed ID; nonempty mounts have distinct priorities. The paper fixes the pilot path rule to `lookup:catalogue/routes.tsv` and lacks a per-mount lookup interface. Do not invent a mount `lookup` property. Until that extension is implemented, keep a single corpus and the existing path-rule vocabulary. Its actual record/template comes from the kit; this corpus does not supply a complete ready-to-copy UI protocol record.

Verification gate: `g_tier1` and `g_protocol` implementations plus schema; negatives exceed cap, remove lookup row, duplicate priority, add unknown field. These gates are normative but unwritten in the pilot, so W0-ENTRY owns Step C publication qualification.

### Step D — commit-ready documentation and browse catalogue

Grounding:

> “the document header up to its reading map (`pm-s0`)” — P:269

> “the single anchored section: the anchor in the shortlist row” — P:270

> “between `<!-- PM:BEGIN pm.NAME.vN -->` and `<!-- PM:END pm.NAME.vN -->` fences” — P:251

Each design/component book exposes a short header, exact reading map, unique HTML anchors and epistemic/negative/oracle content required by WEB. Put routing search/edge/domain JSON in the prescribed fenced machine blocks when using the document projector. For a software `--nodes` mount, use validated explicit node JSONL; do not assume document blocks are also extracted automatically.

Create `catalogue/subjects.json`, a subject index under `subjects/<sid>/index.json`, capped card pages, optional `catalogue/details/<id>.json` and family records according to the provisioned schemas. P:266 gives the browse chain. Real subject IDs and pages must agree with the committed lookup; an attractive README link is not routing coverage. The no-shell browse path was designed, not run, in the paper (P:266,768); qualify it on this corpus before claiming fallback works.

Verification gate: exact single anchor occurrence and navigation chain; negative: dangling or duplicate anchor must fail before indexing. The pilot builder silently dropped unresolved search anchors (P:444), so successful build alone does not close this gate.

### Step E — code-node extractor and W0 integration units

Grounding:

> “The per-language extractor that writes `symbols.jsonl` is `[TARGET]` and not implemented” — P:1902

> “A resolver reads committed files only (never a live service) and fails closed when an input is missing.” — P:553

The kit `tools/blocks.py` exposes `blocks_from_text(text, path)`, `read_blocks(path)` and `anchors(path)` (inspected source), and `tools/build_index_v2.py` accepts `--nodes`, `--corpus`, `--out`, `--thesaurus`, `--check`. Build on those blocks and node-mount tools; do not replace the ranking engine or pretend the Markdown block parser parses Vue/Rust. `tools/jsonschema_lite.py` is the actual helper spelling, not `jsonschema_lite` guessed as a new library. T10 calls its `validate(record,schema)` and expects an empty errors list.

Extractor contract [TARGET]: explicit allowlisted committed paths only, sorted canonical relative UTF-8 paths, no recursive runtime scan; bytes hashed before decoding and no symlink escape. Output a complete deterministic `ctx.node.v2` JSONL, `catalogue/routes.tsv` lookup and `{path,symbol,name,line}` symbol inventory, plus a separate closed provenance/ownership receipt. Keep extra governance fields outside the pilot closed node schema. Each node's anchors belong to its single lookup file; public locations above the anchor cap require family-linked additional nodes, never truncation. Companion Markdown search blocks are parsed by `blocks_from_text`; source language extractors reconcile an independent exported inventory, not regex guesses presented as complete parsing. Unsupported syntax is an explicit refusal.

| W0 unit / owner [TARGET] | Owned surface (at most 3 files [TARGET]) and behavior | Command after implementation [TARGET] / pass and negative |
|---|---|---|
| W0-KIT / router maintainer | `tools/bootstrap_ui.py`, its test, companion; relocate historical T0/T1/T5–T8 fixture paths, externalize privacy policy, validate all vendored hashes/notices | `python3 -B -m unittest discover -s tests -p test_bootstrap_ui.py`; clean relocated kit passes; altered helper/private embedded policy refuses |
| W0-VUE / UI router writer | `tools/extract_vue.py`, test, companion; SFC default component/public bindings, script JSDoc exports, owned template/style regions; no authored TS | `python3 -B -m unittest discover -s tests -p test_extract_vue.py`; template/string lookalikes never become exports; unsupported script syntax refuses |
| W0-JS / JS router writer | `tools/extract_js.py`, test, companion; named/default exports, reexports, public JSDoc typedefs, process boundary metadata | `python3 -B -m unittest discover -s tests -p test_extract_js.py`; independent export gold matches; comment-only or ambiguous reexport refuses |
| W0-RUST / core router writer | `tools/extract_rust.py`, test, companion; public items/qualified module paths, declared cfg profile, Rust authority ownership | `python3 -B -m unittest discover -s tests -p test_extract_rust.py`; cfg profile gold matches; macro-generated public surface without reviewed expansion refuses |
| W0-CSS / tokens router writer | `tools/extract_css.py`, test, companion; exported custom-property names, token-set identity, permitted overrides and region anchors | `python3 -B -m unittest discover -s tests -p test_extract_css.py`; all admitted token names/modes match; missing or comment-only token fails |
| W0-NODES / router integration owner | `tools/extract_ui.py`, test, companion; compose language records plus kit blocks, validate nodes directly, emit sorted lookup/symbols/provenance, preserve removed-anchor history | `python3 -B -m unittest discover -s tests -p test_extract_ui.py`; full inventory coverage and stable bytes; removed public export after honest rehash still fails |
| W0-RESOLVE / router maintainer | `tools/resolve_ui.py`, test, companion; symbol lookup, unique current coordinate/name/hash, generic anchor/lookup/width/collision/freshness gate | `python3 -B -m unittest discover -s tests -p test_resolve_ui.py`; every anchor resolves exactly once; duplicate ID, stale line, escaping path, clipped key refuses |
| W0-ENTRY / tooling owner | `tools/gates_ui_entry.py`, test, companion; Tier-1/token caps, semantic protocol, digest and offline gates | `python3 -B -m unittest discover -s tests -p test_gates_ui_entry.py`; complete local mount passes; missing lookup/tokenizer/unknown field fails |
| W0-WEB / governance owner | `tools/router_web.py`, test, companion; §8 separate richer resolution record and conservative stale/overflow wrapper | `python3 -B -m unittest discover -s tests -p test_router_web.py`; retained ix/pr and metadata agree; stale/overflow/ambiguous record cannot authorize editing |
| W0-BENCH / independent evaluator | UI DEV fixture, grading receipt, calibration companion; fit only UI DEV and specify complete influence freeze plus blind TEST version | use inspected kit commands in §6; nonempty independent labels and exact freeze pass; foreign params, second TEST and changed frozen input refuse |

These are proposed writer commands, not existing executables or completed tests. Missing runner fails its dependent integration leg; no empty discovery counts as success. Before each writer starts, schema/fixtures plus negative oracle precede implementation (ARCH:69). No W0 unit is left ownerless. Step E closure requires all language/public inventory and resolver negatives, not merely a successful fixture index.

<a id="section-3"></a>
## 3. Naming and size policy per file type

Grounding:

> “one anchor per resolvable location in that file with its `role`” — P:1306

> “The work order capped scripts at 150 (small) and 400 (medium) lines; four files exceed their cap and the caps were treated as guidance” — P:683

The paper has no binding Vue/store/CSS source-line limit. The following limits are local review targets, not empirical claims about agent accuracy [TARGET; Q22]. They prevent monolithic files without falsely splitting cohesive SFC template/script/style parts.

| File kind | Proposed naming / public anchor | Size/retrieval rule [TARGET] | Negative contrast |
|---|---|---|---|
| Vue SFC | `CapsulePanel.vue`; exported component identity plus owned template/style regions | Aim ≤300 implementation lines; review above 400; explicit exception above 600; full SFC stays together | Generic `Panel.vue`, random IDs or source TS rejected |
| Store/service | `publicProjection.js`, `drawerModel.js`; named exports and public JSDoc typedefs | Same review limits; one cohesive owner; helper anchors in same file | Unrelated `utils.js`, duplicated projection or ungoverned export |
| IPC contract/decoder | Version-specific semantic name; discriminator/decoder symbols | Closed payload and process boundary per file; split versions deliberately | Generic channel barrel or JSON-any payload |
| CSS token set | `tokens.css` and source `tokens.json`; each public custom property | One token-set node per file; split by owned set when anchor cap would overflow | Vendor variables as source authority; truncated public inventory |
| Test | Colocated `CapsulePanel.test.js`, `drawerModel.test.js`; named independent oracle | Same review limits excluding declared fixture datasets; each scenario routable by exported/test identity | Empty passing selection or test merely repeats implementation |
| Companion/design | Descriptive `.md`, header + reading map + HTML anchors | Header ≤4,000 tokens [CITED; TARGET P:269]; sections have measured slice budgets | Unbounded whole-doc retrieval or unresolved map |
| Generated index | Paper names under `catalogue/router/` | Every file ≤393,216 bytes [CITED P:656]; deterministic sharding | Exempt manifest or oversized single shard |
| Shortlist/digest | `ctx.shortlist.v2`; paper shard convention | Answer ≤2,000 bytes [CITED P:266]; ≤20 rows [CITED P:281]; digest ≤80 tokens/node [CITED; TARGET P:267] | Byte-clipped ID, hidden protected overflow, unmeasured claimed token cap |

Main/preload/renderer/Worker code uses JavaScript/JSDoc under distinct checkJs contexts (W:461); `.vue` scripts do not use `lang="ts"`. Dependency declarations are consumed without introducing authored application TypeScript. Pure public package barrels may re-export explicit names; extractor records re-export edges, never recursively hides owners behind `export *`.

<a id="section-4"></a>
## 4. Nodes, identities and exact coordinates

Grounding:

> “Because the lookup yields **one path per node id**, every anchor of a node must live in that one file” — P:317

> “a node's single lookup path names the file all of its anchors live in” — P:1306

Use a short single-corpus name and collision-checked semantic node IDs. Enforce `len(corpus)+1+len(id) ≤32 bytes`, anchors ≤64 UTF-8 bytes [CITED P:1858,327]. Never clip. Namespaced IDs are not truncated filenames or clipped hashes. Each node includes exact `source_sha256`, required triggers/keywords, purpose/title, lifecycle, role-bearing anchors and optional family/search fields, validated directly against `ctx.node.v2` [TARGET adaptation; P:314,1306].

| Routable unit [TARGET] | Node / anchor binding | Companion relation |
|---|---|---|
| Vue component | `symbol` node for source file; component/public binding anchors | Separate section/document node for its `.md`, same family |
| Store/intent/decoder | Source-file `symbol` node; each public export within supported inventory | Boundary book records authority, unknown ingress, ownership and tests |
| IPC verb | Owning contract/bridge file symbol anchor; trigger/task names actual verb | No invented dedicated IPC router role |
| CSS token set | Source file symbol node; custom-property names as public anchors | Token book section node with computed-property oracle |
| Test | File symbol node with scenario/helper anchors supported by extractor | Edges to governed implementation and independent expected fixture |
| Holdings layer | `hyperbook`/family links across source and book file nodes | No game engine asset/scene role for arbitrary Vue DOM trees |
| Dock layout data | Committed data/source anchor under supported resolver | Runtime Dockview tree is not an engine scene file |
| Runtime sessions/boxes/PTY bytes | Not indexed | No secret or live-service read through router |

The context note suggests a `scene` anchor such as `Root/Dock/Tab` for Dockview layouts. Do not adopt that literally: P:562's scene resolver reads an engine scene hierarchy, and P:565 says it is unwritten. A DOM layout path is not proven compatible. Use governed source/data symbols until a separately versioned resolver exists [TARGET].

Symbol inventory is committed `catalogue/symbols.jsonl`, one `{path,symbol,name,line}` record per resolvable symbol as specified in P:558. Exactly one matching record; current source at that line contains the name; source digest binds content. Line coordinates alone are fragile, so drift rebuilds inventory and invalidates old router identity. No live runtime object/DOM handle is a source coordinate.

Node `anchors` has a maximum of **16 [CITED P:314]**. If a token set or source unit has more public locations, retain full coverage using additional bounded nodes for the same source file with unambiguous IDs and shared family, or split the source by cohesive public ownership [TARGET]. The invariant is one lookup path per node, not that only one node may ever refer to a file. Never discard public anchors merely to satisfy the cap; gate reconciles the complete public inventory.

Lookup formats must remain distinct: the paper-corpus builder's `routes.tsv` has `id,subject_id,paper,page` columns (P:246); generic software lookup is proposed `id<TAB>path` (P:1895). They are not interchangeable. Stop until protocol/resolver integration specifies how the single-mount generic lookup is consumed; do not feed a two-column file to a four-column paper parser [TARGET].

<a id="section-5"></a>
## 5. Build, verify, route and publish

Grounding:

> “Build a mount: `python3 tools/build_index_v2.py --nodes <nodes.jsonl> --out <dir> --corpus <name>`” — P:1306

> “An agent runs `--verify` once per session and after every repository update.” — P:535

After Steps A–E and strict node validation have passed, run the paper's generic mount build with proposed local paths [TARGET adaptation]:

```sh
python3 tools/build_index_v2.py --nodes catalogue/ui.nodes.jsonl --out out/index --corpus ui
python3 tools/build_index_v2.py --nodes catalogue/ui.nodes.jsonl --out out/index --corpus ui --check
```

The paper requires `--check` byte-identical plus `g_size`, `g_nofloat`, `g_volatile` for this mount (P:1306). The inspected gate CLI exposes only `--all` plus root/index/params/dev/thesaurus/out, not individual gate selectors. W0-RESOLVE and W0-ENTRY own generic gate execution; do not invent `--gate` flags. The all-gates paper command in §6 is not a way around generic-anchor incompatibility.

Verify complete lookup, role anchors, identity width, source hashes and public inventory using Step E's implemented gates. Build missing rows as errors, not silently missing search results. `--verify` must prove generic-mount source freshness; pilot paper-only assumptions require explicit tests. No query should be qualified merely because a node was returned.

Once local parameters exist and all compatibility gates pass, the routing command shape is grounded in P:266:

```sh
python3 tools/route_v2.py --q "fold capsule without stopping capture" --index catalogue/router --params catalogue/router/params.json --verify .
```

The query is [TARGET]. Require the params file before invoking it: the paper reports a deviation where a missing path silently returns uncalibrated results and sentinel `pr` rather than failing (P:283,535–543). Such an answer is not fitted UI routing success.

Ladder [CITED P:264–274]: entry → protocol → bounded shortlist → shortlisted digest lines → exceptional page/detail → header/reading map → single anchored section. `no_query_term` permits one rephrase, then abstain; exact locate-ID goes directly to its anchor. Inspect purpose/exclusions; ranking never proves truth. Do not recursively search the tree after abstention under the guise of a fallback.

Publication copies a qualified `out/index` plus `out/params.json` to `catalogue/router/` (P:1377). Stage in a separate destination, compare hashes/manifests and promote only while readers are quiescent: builder's two-renames publication is not reader-atomic (P:1383). A single writer updates lookup/protocol/index as one governed publication. Entries remain byte-stable; indexed source edits require rebuild/verify and new identity before writer admission.

Verification gate: identical build bytes, correct `ix`/`pr`, real-source anchor and fresh digest; negatives mutate source without rebuild, omit params, duplicate anchor and exceed answer bytes. Missing runner blocks the step; no empty PASS.

<a id="section-6"></a>
## 6. Corpus bench, freeze map and single TEST

Grounding:

> “params of one corpus are never reused for another” — P:1306

> “Freeze, author TEST blind, run once.” — P:1306

> “any change after freezing is a new version and a new TEST” — P:1049

Author DEV for this UI corpus with at least **20 answerable and 20 unanswerable queries [CITED; TARGET P:1306]**, including exact component/store/IPC/token/test, ambiguous, excluded, stale and unsupported queries. Use two grading families and a third adjudicator [CITED P:1306]. Bind annotator maps/adjudication, gold anchors and applicability, not just document IDs. Do not reuse the paper's parameters, labels, latency or claimed quality. No workers or grading were launched in this research lane.

The paper's commands below are executable syntax from P:1356–1372, with operator-supplied paths shown as shell variables [TARGET adaptation]. They are **conditional** on a reviewed kit and software-compatible baseline; the v1 pilot projector and ID regex may require a versioned adaptation. Stop if that comparison baseline is absent. Never create fake v1 receipts to satisfy arguments.

```sh
set -eu
: "${DEV_QUERIES:?AUSENTE: provision UI DEV query JSONL}"
: "${LABEL_DIR:?AUSENTE: provision independent labels}"
python3 v1_frozen/build_index.py --root . --out out/v1_index
python3 tools/make_pool_v2.py --dev-src "$DEV_QUERIES" --index out/index --v1-index out/v1_index --out out/pool
python3 tools/make_pool_v2.py --merge --index out/index --labels "$LABEL_DIR" --pool out/pool --out-dev eval/dev.jsonl --agreement eval/agreement.json
python3 tools/null_edges.py --index out/index --bench eval/dev.jsonl --out out/null_edges.json
python3 tools/tune_v2.py --index out/index --bench eval/dev.jsonl --null out/null_edges.json --grid standards/grid.json --out out/params.json --report out/tune_report.json --unjudged-out out/unjudged_pairs.jsonl
python3 tools/eval_v2.py --split DEV --bench eval/dev.jsonl --index out/index --v1-index out/v1_index --params out/params.json --out out/run_DEV.json
```

The paper's gates invocation is:

```sh
python3 tools/gates_v2.py --all --root . --index out/index --params out/params.json --dev eval/dev.jsonl --out out/gates.json
```

It “reads out/protocol.json” and `g_blind` is hard-wired to `out/index` (P:1362,1377). Stage the validated protocol accordingly; do not assume `catalogue/protocol.json` is automatically consumed. This pilot command does not qualify a generic mount until the missing gates are implemented. Do not run the incompatible paper-anchor leg and then waive its failure.

Before TEST, freeze exact tools, schemas/standards, thesaurus/grid, DEV and labels, params, extractor/resolver/config, source corpus + node/lookup/symbol manifests, protocol, comparison-index manifest, test runner/interpreter identities and negatives [TARGET]. The pilot freeze hashes `tools/*.py`, `standards/`, `v1_frozen/`, `out/index/manifest.json`, `out/params.json`, `eval/dev.jsonl` (P:1377); P:1855 identifies comparison-index omission, bytecode entries and silent missing-file skipping. Fix those gaps in a new version before claiming complete influence coverage. Exclude interpreter-bound bytecode; missing frozen inputs fail.

After the freeze is accepted, author/grade TEST blind and run once [TARGET adaptation of P:1370–1372]:

```sh
set -eu
: "${TEST_BENCH:?AUSENTE: evaluator supplies blind graded UI TEST}"
python3 tools/eval_v2.py --freeze --out out/freeze.json
python3 tools/eval_v2.py --split TEST --bench "$TEST_BENCH" --index out/index --v1-index out/v1_index --params out/params.json --out out/run_TEST.json
```

The evaluator writes `run_TEST.lock` before evaluation; another TEST exits **4 [CITED P:1372]**. Do not remove the lock or retune after seeing TEST. Publish failed criteria as failures. A changed implementation requires a new version, own output directory/freeze map and fresh TEST protocol; reusing old TEST can establish regression behavior, not fresh blind acceptance. Actual UI criterion thresholds must be ratified before unsealing, retaining the paper's A1–A6 comparison, abstention, bounded output, class floors, latency and integrity categories (P:1149–1155).

Verification gate: exact influence map/freeze, DEV-only fitting and blind held-out receipt. Negatives edit params/frozen input, remove freeze, attempt second TEST, leak TEST into tuning, or supply empty split; all refuse.

<a id="section-7"></a>
## 7. Gate registry and what can be claimed

Grounding:

> “every gate fails on its own negative fixture and passes on the frozen index” — P:685

> “a gate that cannot run (missing input, unreadable file) is FAIL, never SKIP” — P:500

| Gate family | Paper status [CITED] | UI application and negative [TARGET] |
|---|---|---|
| `g_rebuild`, `g_size`, `g_nofloat` | Implemented, P:504–506 | Relocated/shuffled build agrees; changed source, oversized shard or float fails |
| `g_schema` | Implemented but not node/bench/digest/run line validation, P:507 | Directly validate those records separately; unknown key/schema/invalid final row rejects |
| `g_anchor` | Paper-only, P:508 | Generic role gate required; removed/duplicate/unresolvable symbol fails |
| `g_fresh` | Implemented source checks, P:509 | Generic source binding must be exercised; stale symbol/node fails |
| `g_compact`, `g_determinism` | Implemented with stated fixture limits, P:510–511 | Answer bytes/order/hash repeat; multibyte overflow and shuffled inputs tested |
| `g_stdlib`, `g_thes` | Implemented, P:512–513 | Reject unexpected imports/ambiguous thesaurus; stdlib does not imply no network |
| `g_blind`, `g_calib` | Implemented, P:514–515 | UI DEV coverage and source hash; TEST leak or one-class DEV fails |
| `g_volatile`, `g_privacy` | Implemented limited scans, P:516–517 | Extend entry coverage including README, source inventories and publication artifacts; private path/name/secret fails without printing it |
| `g_tier1`, `g_protocol`, `g_digest`, `g_offline` | Normative, unwritten, P:531 | Exact tokenizer caps, semantic protocol, digest proof, no-network/no-model execution; each own negative |
| Generic mount lookup/anchor/params/width/collision gates | Unwritten, P:1858 | Full source/public coverage, no duplicate/clipped identity or foreign params |
| Web compatibility | Required by W:236–240; installed binding AUSENTE | §8 contract fixtures; no silently transformed success |

Pilot phase-A exception: params checks in `g_schema`/`g_blind` may report skipped before params exist (P:500). That limited development exception never qualifies final publication. `g_schema PASS` does not mean all nodes, JSON dialects or source languages were validated.

<a id="section-8"></a>
## 8. Web/management compatibility conflicts

Grounding:

> “It returns node ids with anchors, never document bodies.” — P:174

> “Returned records MUST bind full identity, governor, source coordinates/digest, profile and evidence status.” — W:236

Use the paper engine unchanged for its shortlist semantics where compatible. Keep richer governance metadata in a separate checked resolution record rather than adding unknown fields to `ctx.shortlist.v2` [TARGET; P:319]. That resolution/adapter record needs a reviewed explicitly versioned web contract; its schema/API is AUSENTE, so cross-product interoperability remains blocked.

| Conflict | Conservative closure [TARGET] | Negative fixture |
|---|---|---|
| Shortlist lacks full governance fields | Resolve each row through committed collision-checked metadata; retain original `ix/pr` and full source identity | Missing governor/digest cannot become actionable context |
| Protected overflow flag versus WEB refusal | Consumer treats `overflow:true` as non-actionable refusal; preserve original evidence, no silent trimming | Oversized protected exact targets cannot authorize edit |
| Process `E_STALE` exit versus in-band abstention | Wrapper publishes typed failure reason under reviewed web schema, retaining original exit; no fake shortlist | Stale/missing file is never “no results” success |
| Natural-ID tie order versus canonical byte order | Verify comparator equivalence on full allowed IDs; otherwise version extension/implementation change, new freeze | Numeric-looking mixed IDs discriminate natural and byte ordering |
| Clipped merged IDs | Single corpus, width/collision validation; no multi-mount promotion until full inverse mapping exists | Same-prefix IDs never merge silently |
| Per-mount params/lookup absent | Independent single-mount router per corpus until interface exists | Game query cannot use paper-fitted params |
| Symbol/token anchors unsupported | Implement resolver and independent public inventory reconciliation first | Removed export still fails after honest rebuild |

The paper says “one shared `params` in `route_multi`, ids cut to 32 bytes” (P:1858). Therefore multi-mount is not the default for these products. No inferred library/API patch silently changes a frozen router identity.

<a id="section-9"></a>
## 9. First-commit acceptance and remaining stop points

Before a conductor makes the first router-qualified commit [TARGET], require entry caps and no volatility, reviewed kit/tool hashes and notices, supported source inventory, validated nodes/lookup/anchors, byte-identical index, fresh source binding, explicit calibrated/uncalibrated status, software-specific gate negatives, offline/privacy checks and clean browse/execute journeys. A skeleton commit may exist earlier, but must say **router unavailable** and cannot admit AI edits as if exact router evidence existed.

No git operation is part of this lane. The conductor owns commit identity/history. Bootstrap completion receipt records actual argv/cwd, source/tool/config/environment hashes, nonempty checks, positive/negative outcomes, limits and remaining unsupported syntax. It never embeds credentials or claims general agent-accuracy gains.

Current closure: the supplied kit path, helper, copy-hash gate, portable tests and generic fixture build make Step A executable on an empty destination. Steps B–D establish the authored entry/catalogue contract; Step E assigns every missing software interface to an explicit W0 owner. Full application-corpus acceptance follows W0 completion and §6 DEV/freeze/blind TEST; it has no receipt here and is not represented as runtime PASS.

<a id="section-10"></a>
## 10. Ordered execution map and Newton support

This table is the command/acceptance map for every bootstrap step [TARGET]. Commands for authored W0 work are explicitly future commands; implementation is part of the executable work order, not a missing precondition silently defaulted away.

| Step | Command / action in the new target root | Pass condition / negative |
|---|---|---|
| A | Run supplied `bootstrap_router.py --dest` command above | Copy manifest equal; portable tests and `--check` pass; altered helper rejected |
| B | Run the §2 Step B `mkdir -p` block, then W0-KIT unit command | Roots owned and pairwise disjoint; escaping/duplicate owner refuses |
| C | Author the exact Step C entry text and schema-bound protocol, then W0-ENTRY command | Tokenizer caps/protocol/lookup pass; absent tokenizer, volatility or lookup row fails |
| D | Author anchored books/browse records under Step D, then W0-RESOLVE command | One unique resolved anchor per location; duplicate/dangling anchor fails |
| E | Run W0-VUE, W0-JS, W0-RUST, W0-CSS, W0-NODES, W0-RESOLVE, W0-WEB test commands in order | Nonempty language fixture selections and independent public golds pass; each own mutation refuses |
| F build | Run both §5 `build_index_v2.py --nodes` commands using emitted UI records | Byte-identical build; source change or duplicate public identity refuses |
| G calibrate | Execute inspected §6 pool/null/tune/DEV commands with UI-specific baseline and labels | Independent UI DEV params; missing baseline or TEST leak refuses |
| H verify/publish | Run §6 all-gates plus W0-ENTRY/RESOLVE/WEB tests; use §5 route `--verify .` once per session/update | Genuine current source and ix/pr; generic-source mutation fails; no paper-only anchor waiver |
| I freeze/TEST | Execute §6 freeze and single TEST commands in new version output dir | Complete influence receipt and one blind TEST; second run/frozen mutation refuses |

### Newton pieces: inspected contracts, conservative use

Headers were inspected in `<NEWTON_SHELL>/scripts/agent/`; absent shell wrappers were found at the catalogue-declared Go header path `<NEWTON_SHELL>/verbos/<id_with_underscores>.go`. Do not invent missing `[META:args]` fields. Tool output is locator evidence, never application routing authority.

| Piece / command grounded in header | Fit and gate boundary |
|---|---|
| `newton run scr-ds-enrutador-consulta --raiz "$ROUTER_KIT" --q 'blocks_from_text' --k 3` | Exact source coordinates for kit inspection; reread hit before citing |
| `newton run scr-ds-phrase-exact --raiz "$ROUTER_KIT" --frase 'def blocks_from_text' --k 3` | Exact phrase proof; no hit means no claimed quote |
| `newton run scr-rag-cascada-coords --dir "$ROUTER_KIT" --q 'nodes corpus' --k 3` | Ranked bounded locator, not fresh/complete coverage proof |
| `newton run scr-rag-firmas-simbolo --ruta "$ROUTER_KIT/tools/blocks.py" --lang py --limite 12` | Inspected signature inventory aid; not a Vue/CSS extractor |
| `scr-merkle-corpus-raiz` | Header accepts `--manifest <fichier.jsonl> [--raiz <dir>] [--esperado n1:...]`; W0-RESOLVE must first supply a validated native manifest. Router index manifest is not assumed compatible |
| `scr-ds-sello-gate` | Header accepts `--indice <dir> [--repos ids] [--esperado n1:…] [--altas] [--profundo] [--raices]`; native sealed-universe input needed; not the paper `out/index` by analogy |
| `scr-ds-knowledge-linker`, `scr-ds-linker-gate`, `scr-ds-linker-shard`, `scr-ds-linker-walk`, `scr-ds-reading-pack` | Inspected headers accept one JSON word only; detailed input fields are AUSENTE there and pieces are marked pending. W0-RESOLVE owner supplies reviewed JSON contracts/fixtures before use; no invented flags/JSON fields, no replacement for kit shortlist or generic anchor gate |

Pending linker and Merkle tooling are optional support until their native input contracts have positive and negative receipts. The paper engine and complete W0 generic gate remain the qualification path, so no unrelated Newton closure can authorize first-commit routing.

This mandate is scoped to the supplied router paper, fixed web-management laws and named research corpus; absent implementations and measurements remain unclaimed.

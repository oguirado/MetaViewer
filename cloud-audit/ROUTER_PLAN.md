# MetaViewer Router Architecture & Implementation Plan (`ROUTER_PLAN.md`)

## 1. Executive Baseline & Architectural Triage

### 1.1 Measured Baseline (Current Repository State)

MetaViewer currently carries two disconnected routing surfaces in the repository tree:
1. **Surface A (`catalogue/router` + `tools/router_index.py` + `router/kit/tools/route_v2.py`)**: A file-level deterministic BM25 router over `catalogue/nodes.jsonl` (`3,260` nodes [MEASURED]) and `catalogue/routes.tsv` (`3,260` rows [MEASURED]), gated by `router/index/SHA256SUMS` and `tests/test_router_index.py`.
2. **Surface B (`route/route_query.py` + `route/nodes.jsonl` + `route/symbols.jsonl` + `route/manifest.json`)**: A code-map query tool over `5,523` byte-anchored behavioral findings (`1.74 MB` [MEASURED]) and `18,143` non-test symbol spans (`2.38 MB` [MEASURED]), gated by `tests/test_route_map.py`.

| Metric / Capability | Surface A (`catalogue/router` + `route_v2.py`) | Surface B (`route/route_query.py`) | Target After Plan |
| :--- | :--- | :--- | :--- |
| **15-Query Ground-Truth Top-1** | `5/15` (`33.3%`) [MEASURED] | `7/15` (`46.7%` `locate`) / `10/15` (`66.7%` `ask`) [MEASURED] | `>= 12/15` (`80.0%`) [TARGET] |
| **15-Query Ground-Truth Top-3** | `6/15` (`40.0%`) [MEASURED] | `12/15` (`80.0%` `locate` & `ask`) [MEASURED] | `>= 14/15` (`93.3%`) [TARGET] |
| **15-Query Ground-Truth Top-5** | `8/15` (`53.3%`) [MEASURED] | `13/15` (`86.7%` `locate` & `ask`) [MEASURED] | `>= 14/15` (`93.3%`) [TARGET] |
| **15-Query Ground-Truth Top-20** | `12/15` (`80.0%`) [MEASURED] | `15/15` (`100.0%` `locate`) / `13/15` (`86.7%` `ask`) [MEASURED] | `15/15` (`100.0%`) [TARGET] |
| **15-Query MRR@20** | `0.415` [MEASURED] | `0.680` (`locate`) / `0.739` (`ask`) [MEASURED] | `>= 0.800` [TARGET] |
| **5 Owner Bug Queries (Top-5)** | `0/5` (`0.0%`) [MEASURED] | `3/5` (`60.0%` in-tree) / `4/5` (`80.0%` with symbol/literal fusion) [MEASURED] | `>= 4/5` (`80.0%`) [TARGET] |
| **40-Question Gate (Top-3 / Top-5)** | Not gated (only 25 file-smoke queries) [MEASURED] | Not gated in CI [MEASURED] | `>= 34/40` Top-3 (`85%`) / `>= 36/40` Top-5 (`90%`) [TARGET] |
| **Query Latency (Mean)** | `46.4 ms` (`30–62 ms`) [MEASURED] | `1,597.2 ms` (`locate`) / `30.8 ms` (`find`) / `56.6 ms` (`ask`) [MEASURED] | `< 100 ms` (`locate`) / `< 60 ms` (`ask`, `find`, `error`, `tests`, `impact`) [TARGET] |
| **Index Build / Check Time** | `1,989.3 ms` (`tools/router_index.py --check`) [MEASURED] | Static snapshot (`symbols_at: 7df63db885b4`) [MEASURED] | `< 2,500 ms` full check; `< 50 ms` dirty-file delta [TARGET] |
| **`.vue` Symbol Coverage** | `0` symbols (`.vue` omitted from `_SYM_PATTERNS`) [MEASURED] | Partial static snapshot (`route/symbols.jsonl`) [MEASURED] | `100%` of `ui/src/**/*.vue` `<script>` symbols + props/emits [TARGET] |
| **Test-to-Code Edges** | None [MEASURED] | Raw substring scan over test files (`0/15` on multi-word queries) [MEASURED] | Precomputed import + symbol + literal edges (`< 50 ms`) [TARGET] |
| **Call & Import Graph** | None [MEASURED] | None (`route/README.md`: *"No call graph"*) [MEASURED] | `IMPORTS`, lexical `CALLS`, and `IPC` contract edges + `impact` subcommand [TARGET] |
| **Error & Log Literal Search** | None [MEASURED] | Full working-tree disk scan on every query (`~1.5 s`) [MEASURED] | Pre-extracted `route/literals.jsonl` + dirty-file overlay (`< 60 ms`) [TARGET] |
| **Branch Freshness** | Rebuilt via `tools/router_index.py` [MEASURED] | Pinned to `symbols_at: 7df63db885b4` & `study_pin: 188e3b388e36` [MEASURED] | Branch-fresh deterministic structural index + `FRESH`/`SHIFT`/`STALE` span resolution [TARGET] |

### 1.2 Root Causes of Current Failures

1. **Split-Brain Entry Point**: `llms.txt` (line 11) and `AGENTS.md` (lines 4, 8–25) declare `Status: router unavailable.` while `llms.txt` (line 12) points to `python3 route/route_query.py` and `AGENTS.md` omits `route/route_query.py` completely. Meanwhile, `catalogue/router/params.json` is absent (`abstain.reason = "uncalibrated"` [MEASURED]).
2. **Missing `.vue` Extraction in `tools/router_index.py`**: `_SYM_PATTERNS` (`tools/router_index.py:239-286`) defines regexes for `py`, `rs`, `go`, `js`, `ts`, and `sh`, but omits `vue`. All Vue Single-File Components (`ui/src/App.vue`, `ui/src/components/*.vue`) contribute zero extracted symbols to `catalogue/nodes.jsonl`.
3. **Changelog Pollution in `catalogue/router`**: `tools/router_index.py` indexes `changes/unreleased/*.md` and `docs/*.md` with the same field weights as product source code. On natural-language symptom queries (`Q02`, `Q04`, `Q09`, and all 5 owner bug queries), prose in release fragments outscores `.rs`, `.go`, `.js`, and `.vue` implementation files [MEASURED].
4. **`1.6 s` Full-Tree Disk Read on Every `locate` and `error` Query**: `route/route_query.py` (`locate` at line 276, `error` at line 222) calls `self.literals(self.source_files())` at query time, opening and regex-scanning every non-test source file on disk (`~2,450` files) on every invocation (`1,597.2 ms` mean [MEASURED]).
5. **Stale Symbol Pin Across Branches**: `route/symbols.jsonl` is pinned to `symbols_at: 7df63db885b4` in `route/manifest.json`. When a cloud worker switches branches or edits files, `route/symbols.jsonl` is not updated, and `route_query.py find` does not check `cite()` freshness.
6. **Stopword & Verb Pollution in `route_query.py`**: `STOP` in `route/route_query.py:22-27` omits query-framing verbs (`handled`, `handle`, `defined`, `define`, `implemented`, `checked`, `used`, `work`, `works`, `called`, `calls`), causing `ask "where rewind Back is handled"` (`Q04`) to weight `"handled"` by IDF and miss Top-20 (`>20` [MEASURED]).
7. **Broken `tests` Lookup and Missing Call/Import Graph**: `route_query.py tests` performs a naive `if q in text.lower()` substring check across test files, failing whenever passed a qualified symbol ID (`path::symbol`) or multi-word query, and the router has zero `IMPORTS`, `CALLS`, or `IPC` edges.

### 1.3 What Adds No Real Value — Drop List

To keep the router fast, maintainable, and small enough for git and cloud sessions, the following components and ideas add no real value and are **dropped**:

1. **Drop Dual-CLI Agent Instructions**: Do not ask AI readers or workers to choose between `router/kit/tools/route_v2.py` and `route/route_query.py`. Standardize on **`python3 route/route_query.py`** as the single human/AI entry point, while retaining `tools/router_index.py` and `catalogue/router` strictly as the repository's deterministic file-coverage, link-check, and `ctx.shortlist.v2` schema gate.
2. **Drop Paper-Corpus Markdown Block Projections (`pm.search.v1`, `PM-xxx` IDs, 4-column `routes.tsv`, `subjects/<sid>/pages`)**: Splitting prose documents into `PM-xxx` theorem/proof blocks was designed for static academic paper archives. In a polyglot software repository, it inflates node counts and degrades code ranking. Keep `catalogue/routes.tsv` strictly `2` columns (`id\tpath`).
3. **Drop Kernel/C-Specific Edge Passes (`KCONFIG`, `ARCH_PAIR`, C `_ops` Struct Initializer Tables)**: Reference kernel routers extract Kconfig symbols, `arch/arm64` vs `arch/x86` pairs, and C function-pointer struct initializers. MetaViewer is a Rust + Go + Vue/JS + Python system; those passes produce zero edges here and are dropped in favor of Rust/Go/JS/Vue/Python `IMPORTS`, lexical `CALLS`, `TESTS`, and JSON-Schema/IPC contract edges.
4. **Drop Multi-Mount Cross-Repo `route_multi` Complexity**: Reference multi-repo routers prefix every symbol ID with a mount alias and clip IDs to 32 bytes. MetaViewer is a single self-contained repository; single-repo `path::qualname` IDs are exact, readable, and collision-free.
5. **Drop Live Whole-Tree Disk Scans at Query Time**: Scanning all source files for string literals on every `locate` or `error` invocation wastes `~1.5 s` per call. Drop live full-tree scanning in favor of pre-extracted `route/literals.jsonl` plus an in-memory delta scan restricted strictly to files modified since the index hash.
6. **Drop Model Re-Study Passes from Build/CI Gates**: Re-running LLM study passes over the codebase in CI or cloud sessions is slow, non-deterministic, and requires external credentials. Keep `route/nodes.jsonl` as a pinned, byte-verified behavioral layer (`FRESH`/`SHIFT`/`STALE`) and make all structural layers (`symbols.jsonl`, `literals.jsonl`, `edges.jsonl`) 100% deterministic Python 3 stdlib builds (`0` model tokens).

---

## 2. Target Architecture

### 2.1 One Entry Point for AI Readers and Workers

All agent instructions (`llms.txt`, `AGENTS.md`, `route/README.md`, `README.md`) converge on one command surface:

```sh
python3 route/route_query.py <subcommand> "<query>" [--k N] [--json]
```

| Subcommand | Primary Use Case | Backing Layers Used | Target Latency |
| :--- | :--- | :--- | :--- |
| `locate "<query>"` | **Default unified entry point**: fuses symbols, pre-extracted literals, structural edges, and behavioral findings into ranked `file@start-end` spans with freshness tags. | `symbols` + `literals` + `edges` + `nodes` + live dirty-file delta | `< 100 ms` [TARGET] |
| `ask "<question>"` | Natural-language architectural or behavioral question returning ranked findings + `cite` (`file@start-end`) + `fresh` (`FRESH`/`SHIFT`/`STALE`). | `nodes` + `symbols` fallback on `STALE` | `< 60 ms` [TARGET] |
| `find "<symbol>"` | Exact, prefix, CamelCase/snake_case, or substring symbol lookup across `.rs`, `.go`, `.py`, `.js`, `.ts`, `.vue`, `.sh`. | `symbols` + live dirty-file delta | `< 40 ms` [TARGET] |
| `where "<symbol>"` | Jump directly to `path@start_byte-end_byte` (`line_start-line_end`) for a symbol. | `symbols` + live dirty-file delta | `< 40 ms` [TARGET] |
| `error "<literal>"` | Search error messages, log strings, panic/bail strings, and UI notices, returning the enclosing symbol and line number. | `literals` + live dirty-file delta | `< 60 ms` [TARGET] |
| `tests "<symbol\|path>"` | Find unit, integration, and contract tests covering a symbol or source file via `TESTS` edges (import, symbol mention, literal match). | `edges` (`TESTS`) + `symbols` | `< 50 ms` [TARGET] |
| `impact "<symbol\|path>"` | Call and import graph traversal: callers, callees, importers, imported modules, IPC contract peers, and covering tests. Fails closed (`E_BUDGET`, rc `6`) if unbudgeted fan-in exceeds `64` (`HOT`). | `edges` (`CALLS`, `IMPORTS`, `IPC`, `TESTS`) | `< 60 ms` [TARGET] |
| `file "<path>"` | List all symbols, findings, imports, callers, and covering tests for one file. | `symbols` + `nodes` + `edges` | `< 40 ms` [TARGET] |
| `check` | Verify structural index freshness, `FRESH`/`SHIFT`/`STALE` rates, and run the 40-question benchmark gate. | All layers | `< 2,500 ms` [TARGET] |

### 2.2 Symbol Extraction Including `.vue` Single-File Components

To guarantee 100% deterministic symbol extraction in any cloud session without external dependencies (while using Universal Ctags when present and falling back cleanly to stdlib), symbol extraction uses a two-tier extractor in `tools/router_index.py`:

1. **Byte-Preserving `<script>` Masking for `.vue`**:
   - For every `.vue` file (`ui/src/**/*.vue`), scan the raw bytes outside `<script ...>...</script>` (and `<script setup ...>...</script>`) and replace every non-`\n` byte outside script blocks with ASCII space (`0x20`).
   - Because byte offsets and newline positions (`\n`) remain 100% identical to the original `.vue` file, any regex, brace-span matcher, or ctags parser operating on the masked buffer produces exact `[start_byte, end_byte]` and `[start_line, end_line]` coordinates in the `.vue` file.
2. **Vue Component & Composition API Patterns**:
   - Extract standard JS/TS declarations (`function`, `async function`, `class`, `const/let <name> = (...) =>`, `export function/const/class`).
   - Extract Vue-specific declarations:
     - Component synthetic symbol `path::<ComponentName>` spanning the file (`kind: "component"`).
     - `defineProps(...)`, `defineEmits(...)`, `defineExpose(...)` declarations and their declared prop/emit identifiers.
     - Options API `methods: { ... }`, `computed: { ... }`, and `watch: { ... }` entries.
3. **Deterministic Span Calculation (`[path, qualname, kind, start_byte, end_byte, span_sha16]`)**:
   - Comment-and-string blanking pass (replacing bytes inside `//...`, `/*...*/`, `#...`, `"..."`, `'...'`, `` `...` ``, and Rust raw strings `r#"..."#` with spaces while preserving `\n` and byte positions) drives a deterministic brace/indent matcher so every function, struct, impl, class, and method gets an exact `[start_byte, end_byte]` span and a 16-hex-char SHA-256 digest (`span_sha16 = sha256(raw[start_byte:end_byte]).hexdigest()[:16]`).

### 2.3 Call, Import, IPC, and Test-to-Code Graph (`route/edges.jsonl`)

A compact structural edge table `route/edges.jsonl` stores directed edges as 4-tuples `[kind, src, dst, meta]` sorted canonically:

1. **`IMPORTS` (`file -> file` or `file -> module`)**:
   - **Rust (`.rs`)**: `use crate::...`, `use super::...`, `mod <name>;` resolved against `core/` crate roots (`Cargo.toml` / `lib.rs` / `main.rs`).
   - **Go (`.go`)**: `import "..."` resolved against `daemon-adapter/` package paths.
   - **JS/TS/Vue (`.js`, `.mjs`, `.ts`, `.vue`)**: `import ... from '...'` and `require('...')` resolved relative to importing file (`ui/src/...`, `tools/...`).
   - **Python (`.py`)**: `import ...` and `from ... import ...` resolved against `agents/`, `tools/`, and `tests/`.
2. **`CALLS` (`sid -> sid`)**:
   - Inside each function/method byte span `[start_byte, end_byte]` (using the comment-and-string-blanked buffer so words inside comments or log strings never create false call edges), extract identifier tokens immediately preceding `(` (`\b([A-Za-z_][A-Za-z0-9_]*)\s*\(`), excluding language keywords (`if`, `for`, `while`, `match`, `switch`, `return`, `sizeof`, `Some`, `None`, `Ok`, `Err`).
   - Resolve callee `<ident>` in strict priority order:
     1. Same-file symbol with leaf name `<ident>` (`ambig: 0`).
     2. Symbol exported by a file directly linked by an `IMPORTS` edge from the caller's file (`ambig: 0` if unique among imports).
     3. Same-directory / same-crate / same-package symbol with leaf name `<ident>`.
     4. Repo-wide unique symbol with leaf name `<ident>` (`len >= 5`). If multiple repo-wide candidates exist (`2..4`), record with `ambig: 1`; if `> 4` candidates exist, drop as noisy.
3. **`IPC` (`contract_id -> sid|file`)**:
   - Scan `contracts/v0.2/*.schema.json` and `contracts/v0.2/examples/*.json` for schema `$id` / title / command discriminators (e.g., ` capsule`, `rewind`, `pointer`, `session`, `notice`, `role`) and link them to Rust, Go, Vue/JS, and Python symbols whose span or literals reference that contract filename or message type.
4. **`TESTS` (`test_file_or_sid -> target_sid_or_file`)**:
   - Scan all test files (`tests/**/*.py`, `router/kit/tests/**/*.py`, `**/*_test.go`, `**/*_test.rs`, `**/*.test.js`, `**/*.spec.js`, and Rust `#[cfg(test)] mod tests` blocks) for:
     - **`via: "import"`**: Direct `IMPORTS` edge from the test file to a product file or module.
     - **`via: "symbol"`**: Mention of a product symbol's qualified name or leaf identifier (`len >= 5`, corpus frequency `<= 15`) inside a test function span.
     - **`via: "literal"`**: Shared error/CLI/schema string literal (`len >= 8`) between a test assertion and a product symbol span (e.g., `python3 tools/router_index.py` in `tests/test_router_docs.py`).

### 2.4 Error and Log Literal Index (`route/literals.jsonl`)

Instead of reading all `~2,450` source files from disk on every `error` or `locate` query:
- During deterministic index generation, extract string literals (`6 <= len <= 200`, excluding pure file paths, URLs, and import specifiers) from non-test source files.
- Map each literal to its enclosing symbol `sid` (via interval lookup on `[start_byte, end_byte]`), `file`, `line`, and a boolean `hint` flag (`1` if the literal or its call context matches `err|fail|warn|log|panic|bail|reject|invalid|unavailable|refused|denied|mismatch|notice|lost|timeout`, `0` otherwise).
- Deduplicate per `(file, sid, normalized_literal)` and write `route/literals.jsonl` as compact JSON arrays `[file, sid, line, hint, literal]`.
- At query time, `route_query.py` loads `route/literals.jsonl` in `< 25 ms` and scores `hint=1` literals at weight `3000` and `hint=0` literals at weight `1000`.

### 2.5 Freshness Across Branches Without a Stale Pin

To ensure the router is never stuck on a stale commit pin (`symbols_at`) across branches or uncommitted working-tree edits:

1. **Deterministic Structural Rebuild (`0` Model Tokens)**:
   - `tools/router_index.py` builds both `catalogue/` and the structural files in `route/` (`route/symbols.jsonl`, `route/literals.jsonl`, `route/edges.jsonl`), recording per-file `sha256` and `size` in `route/manifest.json` (or cross-referencing `catalogue/nodes.jsonl`).
2. **Working-Tree / Cross-Branch Delta Overlay at Query Time (`< 30 ms`)**:
   - On startup, `route/route_query.py` checks `git status --porcelain -z` (or compares `(mtime, size)` / `git diff --name-only` against the indexed tree hash in `route/manifest.json`).
   - For the small set of dirty or branch-divergent files (typically `0–15` files in a cloud session), `route_query.py` re-runs the fast stdlib symbol, literal, and import extractor **in memory** for just those files, replacing their stale rows before executing the query.
   - If a file was deleted on the current branch, its symbols, literals, edges, and findings are filtered out automatically (`not (ROOT / path).exists()`).
3. **Three-State Span Verification for Behavioral Findings (`FRESH` / `SHIFT` / `STALE`)**:
   - `route/nodes.jsonl` stores `start_byte`, `end_byte`, and `span_sha16` (`sha256(raw[start_byte:end_byte])[:16]`).
   - When `cite()` formats a finding:
     - **`FRESH`**: `raw[start_byte:end_byte]` matches `span_sha16`. Returns `@start_byte-end_byte`.
     - **`SHIFT`**: `raw[start_byte:end_byte]` changed because lines were inserted/deleted above the function, but searching a `±16 KB` window (or the whole file) finds the exact byte slice matching `span_sha16` at `[new_start, new_end]`. Returns `@new_start-new_end` and tags `SHIFT`.
     - **`STALE`**: The function body itself was edited. Instead of returning broken byte offsets, `cite()` looks up the enclosing symbol `sid` in the branch-fresh `symbols` table and returns the symbol's **current** `@cur_start-cur_end` span tagged `STALE->RESOLVED_SYMBOL`.

### 2.6 Index Size & Latency Budgets

| Artifact Path | Format | Purpose | Current Size | Target Budget |
| :--- | :--- | :--- | :--- | :--- |
| `route/nodes.jsonl` | JSONL | Behavioral findings (pinned + `span_sha16`) | `1.74 MB` [MEASURED] | `<= 2.00 MB` [TARGET] |
| `route/symbols.jsonl` | JSONL (`[path, qual, kind, start, end, sha16]`) | Non-test + `.vue` symbol spans | `2.38 MB` [MEASURED] | `<= 2.50 MB` [TARGET] |
| `route/literals.jsonl` | JSONL (`[path, sid, line, hint, text]`) | Pre-extracted error/log/UI string literals | `0 B` (absent) [MEASURED] | `<= 1.10 MB` [TARGET] |
| `route/edges.jsonl` | JSONL (`[kind, src, dst, meta]`) | `IMPORTS`, `CALLS`, `TESTS`, `IPC` edges | `0 B` (absent) [MEASURED] | `<= 0.90 MB` [TARGET] |
| `route/manifest.json` | JSON | Build receipt, counts, schema version, withheld list | `~12 KB` [MEASURED] | `<= 32 KB` [TARGET] |
| `catalogue/nodes.jsonl` | JSONL (`ctx.node.v2`) | File-level catalogue nodes (with `.vue` symbols) | `2.05 MB` [MEASURED] | `<= 2.30 MB` [TARGET] |
| `catalogue/router/*.json` | JSON (`ctx.index.v2` shards) | Compiled BM25 shards + `params.json` + `manifest.json` | `~680 KB` [MEASURED] | Each file `<= 393,216 B` (`g_size` cap) [TARGET] |

### 2.7 Hash and Gate Consistency Contract

Every change to the router must preserve all existing repository laws and gates:
1. **`tools/router_index.py --check` (`test_router_index.py`)**:
   - Every tracked file in `git ls-files -z --cached` outside `GENERATED_EXACT` (`catalogue/nodes.jsonl`, `catalogue/routes.tsv`) and `GENERATED_PREFIXES` (`router/index/`, `catalogue/router/`) must have a valid `ctx.node.v2` entry in `catalogue/nodes.jsonl` and an `id\tpath` row in `catalogue/routes.tsv`.
   - Therefore, any new tracked file under `route/` (`route/literals.jsonl`, `route/edges.jsonl`) or `tests/` (`tests/test_router_benchmark.py`) is indexed into `catalogue/nodes.jsonl` by running `python3 tools/router_index.py`, followed by rebuilding `catalogue/router/` and `router/index/SHA256SUMS`.
2. **`tests/test_router_queries.py`**:
   - Enforces `PURPOSE_PREFIX = "Routed repository file "` on every node in `catalogue/nodes.jsonl` (line 134), `anchor == "file"` on `route_v2.py` shortlist rows (line 159), and `>= 23/25` Top-3 hits on `GOLDEN_QUERIES`.
   - **Rule**: Never alter `PURPOSE_PREFIX` or `anchors: [{"a": "file", "role": "section"}]` in `catalogue/nodes.jsonl`. Improve `catalogue/router` ranking strictly via `_SYM_PATTERNS["vue"]`, `keywords`/`triggers`/`tasks` extraction, and demoting `changes/unreleased/*.md` boilerplate tokens.
3. **`tests/test_router_docs.py`**:
   - Extracts every `python3 <script.py>` inside fenced shell blocks in `README.md`, `AGENTS.md`, `llms.txt`, and `docs/*.md`, checks that the script exists, and executes `python3 -B <script.py> --help` expecting exit code `0`.
   - `route/route_query.py --help` already exits `0` via `argparse` and must continue to do so for all new subcommands (`impact`, `check`).
4. **`tests/test_route_map.py`**:
   - Enforces that no file under `route/` matches the `BLOCKED` regex (no private external component identifiers or host-specific filesystem paths) and that `locate`, `error`, `find`, `where`, `ask`, and `file` return valid `FRESH`/`STALE` outputs.
5. **`tools/check_laws.py`**:
   - Enforces commit header `type(scope): Imperative summary` (`scope` in `core|contracts|ui|ci|docs|deps|tools`) and requires a `changes/unreleased/<slug>.md` fragment whenever product/tooling files outside `docs/` and `tests/` are touched.

---

## 3. The 40-Question Benchmark & Anti-Memorisation Gate

### 3.1 Anti-Memorisation Rules

To ensure the 40-question benchmark measures genuine routing capability rather than lookup-table memorisation:
1. **Zero Benchmark Leakage into Index Artifacts**: The benchmark specification lives in `tests/fixtures/router_bench_40.jsonl`. `tools/router_index.py` and `route/route_query.py` never read `tests/fixtures/router_bench_40.jsonl` during index generation or query execution (except when running `route_query.py check` or `pytest tests/test_router_benchmark.py`).
2. **Static Anti-Memorisation Audit in `tests/test_router_benchmark.py`**:
   - Asserts that `route/route_query.py` and `tools/router_index.py` contain none of the 40 benchmark query strings or benchmark IDs (`B01`–`B40`).
   - Asserts that no node in `route/nodes.jsonl`, `route/symbols.jsonl`, `route/literals.jsonl`, or `route/edges.jsonl` contains a `bench_id` field or verbatim multi-word query string injected from `router_bench_40.jsonl`.
3. **Dynamic Mutation Control in `tests/test_router_benchmark.py`**:
   - Creates a temporary overlay directory with a synthetic symbol name and synthetic error literal generated at test runtime (e.g., `fn mv_synth_probe_<random_hex>()` and `"mv_synth_err_<random_hex>"`), runs the in-memory delta indexer, and asserts that `find`, `locate`, and `error` rank the synthetic file at Top-1. This proves routing operates on extracted code features rather than static canned answers.

### 3.2 Complete 40-Question Benchmark Specification (`B01`–`B40`)

The 40 questions span 6 categories across all repository subsystems (`core/`, `daemon-adapter/`, `ui/`, `agents/`, `tools/`, `contracts/`):
- **B01–B15**: The 15 ground-truth architectural & code-location queries from the baseline audit report.
- **B16–B20**: The 5 real owner-reported symptom bug queries from the baseline audit report.
- **B21–B25**: 5 `.vue` and frontend component/state queries (`ui/src/**`).
- **B26–B30**: 5 exact error, log, and rejection literal queries (`error` / `locate`).
- **B31–B35**: 5 test-to-code coverage queries (`tests`).
- **B36–B40**: 5 call, import, and IPC contract impact queries (`impact`).

| ID | Mode | Query String | Ground-Truth Expected File(s) (Any Match Counts) |
| :--- | :--- | :--- | :--- |
| **B01** | `locate` | `where is the 500ms pointer release barrier after a rewind` | `ui/src/App.vue`, `ui/src/composables/useInputForwarding.js` |
| **B02** | `locate` | `how does capsule role step get skipped or preserved in Add Capsule modal` | `ui/src/components/AddCapsuleModal.vue`, `ui/src/App.vue` |
| **B03** | `locate` | `where does the daemon adapter validate or reject gnome-mines or desktop launch` | `daemon-adapter/cmd/mv-SessionDaemon/main.go`, `daemon-adapter/internal/` |
| **B04** | `locate` | `where is rewind Back handled in the UI and sent over the session socket` | `ui/src/App.vue`, `ui/src/services/daemonSocket.js` |
| **B05** | `locate` | `where are inactive desktops hidden or filtered in the selector` | `ui/src/App.vue`, `ui/src/components/CapsuleBar.vue` |
| **B06** | `locate` | `how does Program view paint frames and why would it show no frames` | `ui/src/App.vue`, `ui/src/components/ProgramView.vue`, `core/mv-engine/src/lib.rs` |
| **B07** | `locate` | `where is the login notice triggered in the packaged app` | `ui/src/App.vue`, `ui/electron/main.cjs` |
| **B08** | `locate` | `how does router_index.py validate sha256 and routes.tsv` | `tools/router_index.py` |
| **B09** | `locate` | `where are capsule roles defined and validated in contracts` | `contracts/v0.2/`, `core/mv-capsule/src/lib.rs` |
| **B10** | `locate` | `how does the Rust engine encode and decode timeline scrub frames` | `core/mv-engine/src/lib.rs`, `core/mv-timeline/src/lib.rs` |
| **B11** | `locate` | `where agent bridge commit mismatch is checked against deps.lock before spawn` | `agents/metaviewer_agents/verify.py`, `agents/metaviewer_agents/planner.py` |
| **B12** | `locate` | `how does the session daemon manage Xpra or Wayland display sockets` | `daemon-adapter/cmd/mv-SessionDaemon/main.go` |
| **B13** | `locate` | `where are commit message laws and scope rules enforced` | `tools/check_laws.py`, `docs/COMMIT_LAWS.md` |
| **B14** | `locate` | `how does bootstrap_kit.py verify the router kit receipt and manifest` | `router/kit/tools/bootstrap_kit.py` |
| **B15** | `locate` | `where does the UI handle pointer lock and relative mouse motion` | `ui/src/App.vue`, `ui/src/composables/useInputForwarding.js` |
| **B16** | `locate` | `Add capsule lost the role step` | `ui/src/App.vue`, `ui/src/components/AddCapsuleModal.vue` |
| **B17** | `locate` | `Inactive desktops stayed visible` | `ui/src/App.vue`, `ui/src/components/CapsuleBar.vue`, `daemon-adapter/cmd/mv-SessionDaemon/main.go` |
| **B18** | `locate` | `painted with no frames in Program` | `ui/src/App.vue`, `daemon-adapter/cmd/mv-SessionDaemon/main.go`, `core/mv-engine/src/lib.rs` |
| **B19** | `locate` | `Login notice never appeared in the packaged app` | `ui/src/App.vue`, `ui/electron/main.cjs`, `daemon-adapter/cmd/mv-SessionDaemon/main.go` |
| **B20** | `locate` | `gnome-mines rejected` | `daemon-adapter/cmd/mv-SessionDaemon/main.go`, `ui/src/App.vue` |
| **B21** | `find` | `AddCapsuleModal` | `ui/src/components/AddCapsuleModal.vue` |
| **B22** | `find` | `CapsuleBar` | `ui/src/components/CapsuleBar.vue` |
| **B23** | `locate` | `Vue component that renders the timeline scrub bar and playhead` | `ui/src/App.vue`, `ui/src/components/TimelineBar.vue`, `ui/src/components/ScrubBar.vue` |
| **B24** | `locate` | `where Electron main process creates BrowserWindow and loads packaged UI` | `ui/electron/main.cjs` |
| **B25** | `locate` | `where Vue keyboard and pointer events are throttled during active scrub` | `ui/src/App.vue`, `ui/src/composables/useInputForwarding.js` |
| **B26** | `error` | `Status: router unavailable.` | `tools/router_index.py`, `router/kit/tools/gates_v2.py` |
| **B27** | `error` | `missing CHANGELOG fragment under changes/unreleased/` | `tools/check_laws.py` |
| **B28** | `error` | `SHA256SUMS mismatch` | `tools/router_index.py`, `router/kit/tools/gates_v2.py` |
| **B29** | `error` | `uncalibrated` | `router/kit/tools/route_v2.py`, `router/kit/tools/gates_v2.py` |
| **B30** | `error` | `bootstrap_receipt.json` | `router/kit/tools/bootstrap_kit.py`, `tools/router_index.py` |
| **B31** | `tests` | `tools/router_index.py` | `tests/test_router_index.py`, `tests/test_router_docs.py`, `tests/test_router_queries.py` |
| **B32** | `tests` | `route/route_query.py` | `tests/test_route_map.py`, `tests/test_router_docs.py` |
| **B33** | `tests` | `router/kit/tools/route_v2.py` | `tests/test_router_queries.py`, `router/kit/tests/test_entry_contract.py` |
| **B34** | `tests` | `tools/check_laws.py` | `tests/test_check_laws.py`, `tests/test_router_docs.py` |
| **B35** | `tests` | `agents/metaviewer_agents/verify.py` | `agents/tests/test_verify.py`, `tests/` |
| **B36** | `impact` | `tools/router_index.py` | `tests/test_router_index.py`, `tests/test_router_queries.py`, `router/kit/tools/build_index_v2.py` |
| **B37** | `impact` | `route/route_query.py` | `tests/test_route_map.py`, `llms.txt`, `AGENTS.md` |
| **B38** | `impact` | `router/kit/tools/build_index_v2.py` | `router/kit/tools/route_v2.py`, `router/kit/tools/gates_v2.py`, `tests/test_router_index.py` |
| **B39** | `impact` | `ui/src/App.vue` | `ui/src/main.js`, `ui/src/components/AddCapsuleModal.vue`, `ui/src/components/CapsuleBar.vue` |
| **B40** | `impact` | `core/mv-engine/src/lib.rs` | `core/mv-capsule/src/lib.rs`, `core/mv-timeline/src/lib.rs` |

### 3.3 Mandatory Gate Thresholds (`tests/test_router_benchmark.py`)

`pytest -q tests/test_router_benchmark.py` fails closed unless all of the following hold:
1. **Top-1 Hit Rate**: `>= 26 / 40` (`65.0%` [TARGET]).
2. **Top-3 Hit Rate**: `>= 34 / 40` (`85.0%` [TARGET]).
3. **Top-5 Hit Rate**: `>= 36 / 40` (`90.0%` [TARGET]).
4. **Top-20 Hit Rate**: `>= 39 / 40` (`97.5%` [TARGET]).
5. **Mean Reciprocal Rank (`MRR@20`)**: `>= 0.750` [TARGET] across all 40 questions.
6. **Sub-Suite Minimums**:
   - `B01–B15` (15 report queries): `>= 13/15` Top-3 (`86.7%` [TARGET], up from `6/15` on `catalogue/router` and `12/15` on `route_query.py` [MEASURED]).
   - `B16–B20` (5 owner bug queries): `>= 4/5` Top-5 (`80.0%` [TARGET], up from `0/5` on `catalogue/router` and `3/5` in-tree `route_query.py` [MEASURED]).
   - `B21–B25` (5 `.vue` queries): `5/5` Top-3 (`100.0%` [TARGET]).
   - `B26–B30` (5 `error` literal queries): `5/5` Top-3 (`100.0%` [TARGET]).
   - `B31–B35` (5 `tests` edge queries): `5/5` Top-3 (`100.0%` [TARGET]).
   - `B36–B40` (5 `impact` graph queries): `5/5` Top-5 (`100.0%` [TARGET]).
7. **Latency Gate**: Mean single-query execution time `< 120 ms` (`< 4.8 s` total wall time for all 40 queries in-process / `< 100 ms` per warm CLI query) [TARGET], down from `1,597.2 ms` per `locate` query [MEASURED].
8. **Anti-Memorisation Checks**: Static source/index scan + dynamic synthetic file mutation test pass (`rc == 0`).

---

## 4. Ordered Implementation Phases (Sized for One Cloud Session Each)

Each phase is self-contained, fits comfortably within a single cloud session (`~30–45 min`), leaves all existing tests and gates green at the end of the session, and requires only Python 3 stdlib and repository tools.

---

### Phase 1: `.vue` Symbol Extraction & Code-Over-Changelog Ranking in `tools/router_index.py`

- **Objective**: Fix `.vue` symbol blindness in `tools/router_index.py`, demote `changes/unreleased/*.md` prose noise in `catalogue/nodes.jsonl` field generation so source files outrank release notes on code/bug queries, and calibrate `catalogue/router/params.json`.
- **Exact Files to Edit / Create**:
  - Edit `tools/router_index.py`
  - Edit `tests/test_router_index.py` (add `.vue` extraction unit test and code-vs-changelog ranking test)
  - Regenerate `catalogue/nodes.jsonl`, `catalogue/routes.tsv`, `catalogue/router/*.json` (including `catalogue/router/params.json`), and `router/index/SHA256SUMS`
  - Create `changes/unreleased/router-vue-symbols-and-ranking.md`
- **Must NOT Touch**:
  - Do **not** modify `PURPOSE_PREFIX = "Routed repository file "` or `anchors = [{"a": "file", "role": "section"}]` in `tools/router_index.py` (required by `tests/test_router_queries.py:134,159`).
  - Do **not** touch `core/**`, `daemon-adapter/**`, `ui/**`, `contracts/**`, or `agents/**`.
- **Implementation Steps**:
  1. In `tools/router_index.py`, add a helper `_mask_vue_non_script(raw_text: str) -> str` that blanks characters outside `<script...>` ... `</script>` tags with spaces while preserving `\n` and byte offsets.
  2. Add `"vue"` to `_SYM_PATTERNS` in `tools/router_index.py:239-286` covering:
     - `function <Name>`, `async function <Name>`, `const|let <Name> = (...) =>`
     - `defineProps`, `defineEmits`, `defineExpose` property/event identifiers
     - Options API `name: '<ComponentName>'` and method identifiers, plus the SFC filename stem (`AddCapsuleModal`, `CapsuleBar`, `App`) as a primary symbol token.
  3. In `_build_node_for_path(root, rel_path)` in `tools/router_index.py`, differentiate node field generation for `changes/unreleased/*.md` vs product code (`core/`, `daemon-adapter/`, `ui/`, `agents/`, `tools/`, `contracts/`):
     - For `changes/unreleased/*.md`, restrict `keywords` and `triggers` to the changelog slug and `"changelog"` / `"unreleased"` tags instead of indexing body prose tokens that collide with bug descriptions.
     - For product source files, include camelCase/snake_case split sub-tokens of extracted symbols in `keywords` and `triggers` (capped within schema limits: `<= 24` keywords, `<= 16` triggers).
  4. Run `python3 tools/router_index.py` and `python3 router/kit/tools/build_index_v2.py` (generating `catalogue/router/params.json` conforming to `ctx.router-params.v2.schema.json` and updating `router/index/SHA256SUMS`).
- **Verification & Gate Commands**:
  ```sh
  python3 tools/router_index.py --check
  pytest -q tests/test_router_index.py tests/test_router_queries.py tests/test_router_docs.py router/kit/tests/test_entry_contract.py
  ```
- **Expected Measured Gain**:
  - `.vue` symbols extracted in `catalogue/nodes.jsonl`: from `0` [MEASURED] to `>= 120` symbols across `ui/src/**/*.vue` [TARGET].
  - `catalogue/router` 15-query Top-5 accuracy: from `8/15` (`53.3%`) [MEASURED] to `>= 11/15` (`73.3%`) [TARGET].
  - `tests/test_router_queries.py` 25 golden queries: remains `>= 23/25` Top-3 (`rc == 0`) [TARGET].

---

### Phase 2: Branch-Fresh Deterministic Symbols (`symbols.jsonl`), Pre-Extracted Literals (`literals.jsonl`), and `<100 ms` `locate`/`error`

- **Objective**: Eliminate the `1,597.2 ms` live full-tree disk scan on `route_query.py locate` and `error`, eliminate the stale `symbols_at` commit pin across branches, add `.vue` and multi-language byte-span symbol extraction with `span_sha16`, and fix stopword/verb dilution in `route/route_query.py`.
- **Exact Files to Edit / Create**:
  - Edit `route/route_query.py`
  - Edit `tools/router_index.py` (add `--sync-route` / automatic deterministic generation of `route/symbols.jsonl` and `route/literals.jsonl` during index build, or invoke `route/route_query.py --build-structural`)
  - Create / update `route/symbols.jsonl`, `route/literals.jsonl`, and `route/manifest.json`
  - Edit `tests/test_route_map.py` (add latency assertion `< 200 ms` for `locate` and `error`, `.vue` symbol lookup test, and dirty-file working-tree freshness test)
  - Regenerate `catalogue/nodes.jsonl`, `catalogue/routes.tsv`, `catalogue/router/**`, and `router/index/SHA256SUMS`
  - Create `changes/unreleased/route-fast-literals-and-fresh-symbols.md`
- **Must NOT Touch**:
  - Do **not** delete or overwrite the behavioral findings in `route/nodes.jsonl` (only enrich with `span_sha16` if missing, preserving all `5,523` existing finding records).
  - Do **not** touch `core/**`, `daemon-adapter/**`, `ui/**`, `contracts/**`, or `agents/**`.
- **Implementation Steps**:
  1. **Deterministic Structural Builder (`route/route_query.py --build`)**:
     - Extract all non-test symbols across `.rs`, `.go`, `.py`, `.js`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.vue` (using `<script>` byte-preserving masking), and `.sh` with exact `[path, qualname, kind, start_byte, end_byte, span_sha16]`.
     - Extract all string literals (`6 <= len <= 200`, excluding pure import paths and URLs) from non-test source files into `route/literals.jsonl` as `[path, enclosing_sid, line_no, hint_int, literal_text]`, where `hint_int = 1` when the literal or its line matches `(?i)\b(err|error|fail|failed|warn|warning|panic|bail|reject|rejected|invalid|unavailable|refused|denied|mismatch|notice|lost|timeout)\b`.
     - Record per-file `(size, sha256_16)` in `route/manifest.json` under `"tree_files"` and set `"symbols_mode": "branch_fresh_deterministic"`.
  2. **Working-Tree Delta Overlay in `route/route_query.py`**:
     - When `RouteIndex` initializes, compare tracked source files' `(size, mtime)` or `git status --porcelain -z` against `route/manifest.json`.
     - Re-extract symbols and literals in memory **only** for files whose size/hash differs from `route/manifest.json` (`0` files on a clean checkout -> `0 ms` disk scan; `1–5` edited files on a dirty branch -> `< 20 ms` delta scan).
  3. **Three-State `cite()` Freshness (`FRESH` / `SHIFT` / `STALE`)**:
     - If `raw[start_byte:end_byte]` matches `span_sha16`: return `FRESH` with `@start_byte-end_byte`.
     - If shifted by upstream edits: locate `span_sha16` in the file, return `SHIFT` with the updated `@new_start-new_end`.
     - If the function body was modified (`STALE`): resolve `sid` in the branch-fresh `symbols` table and return the symbol's current `@cur_start-cur_end` span tagged `STALE`.
  4. **Query-Framing Stopwords & Token Expansion**:
     - Expand `STOP` in `route/route_query.py:22-27` to include query-framing filler verbs: `handled`, `handle`, `handles`, `defined`, `define`, `defines`, `implemented`, `implement`, `checked`, `check`, `used`, `use`, `uses`, `work`, `works`, `working`, `called`, `call`, `calls`, `located`, `sent`, `triggered`, `stayed`, `appeared`.
     - Add camelCase and snake_case sub-token splitting to `tokens()` so querying `useInputForwarding` or `AddCapsuleModal` matches both the full identifier and its constituent words (`input`, `forwarding`, `add`, `capsule`, `modal`).
- **Verification & Gate Commands**:
  ```sh
  python3 route/route_query.py --build
  python3 tools/router_index.py
  python3 tools/router_index.py --check
  pytest -q tests/test_route_map.py tests/test_router_index.py tests/test_router_queries.py
  ```
- **Expected Measured Gain**:
  - `route_query.py locate` latency: from `1,597.2 ms` mean [MEASURED] down to `< 100 ms` [TARGET] (`> 15x` speedup).
  - `route_query.py error` latency: from `1,532.0 ms` mean [MEASURED] down to `< 60 ms` [TARGET] (`> 25x` speedup).
  - `route_query.py ask` on `Q04` (`"where rewind Back is handled"`): from `MISS >20` [MEASURED] to `Top-3` [TARGET].
  - Branch freshness: `100%` of symbols and literals reflect the active branch and uncommitted working-tree edits with zero stale commit pins [TARGET].

---

### Phase 3: Structural Graph (`IMPORTS`, `CALLS`, `TESTS`, `IPC`) & `tests` / `impact` Subcommands

- **Objective**: Build `route/edges.jsonl` containing `IMPORTS`, lexical `CALLS`, `TESTS` (test-to-code), and `IPC` (contract-to-code) edges, upgrade `route/route_query.py tests` from a raw substring scan to a graph + token lookup, and add `route/route_query.py impact <symbol|path>`.
- **Exact Files to Edit / Create**:
  - Edit `route/route_query.py` (add edge builder for `route/edges.jsonl`, upgrade `tests` subcommand, add `impact` subcommand with fail-closed `E_BUDGET` cap)
  - Create `route/edges.jsonl` and update `route/manifest.json`
  - Edit `route/README.md` (remove *"No call graph. tests is a plain text match."* and document `impact` and upgraded `tests`)
  - Edit `tests/test_route_map.py` (add tests for `IMPORTS`, `CALLS`, `TESTS`, `IPC` edges, `impact` output, and fail-closed `E_BUDGET` on high-fan-in symbols)
  - Regenerate `catalogue/nodes.jsonl`, `catalogue/routes.tsv`, `catalogue/router/**`, and `router/index/SHA256SUMS`
  - Create `changes/unreleased/route-call-import-test-graph.md`
- **Must NOT Touch**:
  - Do **not** touch `core/**`, `daemon-adapter/**`, `ui/**`, `contracts/**`, or `agents/**`.
- **Implementation Steps**:
  1. **`IMPORTS` Extractor**:
     - Resolve Rust (`use`, `mod`), Go (`import`), JS/TS/Vue (`import ... from`, `require(...)`), and Python (`import`, `from ... import`) statements to repository-relative target file paths or module prefixes.
  2. **`CALLS` Extractor**:
     - For each symbol span `[start_byte, end_byte]` in `route/symbols.jsonl`, scan the comment-and-string-blanked buffer for `<ident>(` tokens.
     - Resolve `<ident>` against: (a) same-file symbols, (b) symbols in files linked by `IMPORTS` from the caller's file, (c) same-package/crate symbols, (d) repo-wide unique symbols (`len >= 5`), emitting `["CALLS", caller_sid, callee_sid, {"ambig": 0|1}]`.
  3. **`TESTS` Extractor**:
     - Scan all test files (`tests/**/*.py`, `router/kit/tests/**/*.py`, `agents/tests/**/*.py`, `**/*_test.go`, `**/*_test.rs`, `**/*.test.js`) for imports of product modules, mentions of product symbol names (`len >= 5`), and shared string literals (`len >= 8`), emitting `["TESTS", test_path_or_sid, target_sid_or_path, {"via": "import|symbol|literal"}]`.
  4. **`IPC` Contract Extractor**:
     - Scan `contracts/v0.2/*.schema.json` and link each contract file to product symbols/files that reference its schema filename, `$id`, or message command token.
  5. **Upgrade `tests` and Add `impact` Subcommand**:
     - `python3 route/route_query.py tests "<symbol|path>"`: resolves `<symbol|path>` to matching file(s) and symbol ID(s), returns all `TESTS` edges pointing to that file or its symbols ranked by specificity (`symbol` > `literal` > `import`), and falls back to token overlap over test files if no direct edge exists.
     - `python3 route/route_query.py impact "<symbol|path>" [--max-fan-in 64]`: returns `{"target": ..., "callers": [...], "callees": [...], "importers": [...], "imports": [...], "ipc_contracts": [...], "tests": [...]}`. If `len(callers) + len(importers) > max_fan_in` (default `64`), returns status `"HOT"` with fail-closed exit code `6` (`E_BUDGET`) unless `--force` or a narrower `path::symbol` is supplied.
- **Verification & Gate Commands**:
  ```sh
  python3 route/route_query.py --build
  python3 route/route_query.py tests "tools/router_index.py"
  python3 route/route_query.py impact "route/route_query.py"
  python3 tools/router_index.py
  python3 tools/router_index.py --check
  pytest -q tests/test_route_map.py tests/test_router_index.py tests/test_router_docs.py
  ```
- **Expected Measured Gain**:
  - `route_query.py tests` accuracy on `B31–B35`: from `0/5` on multi-token/symbol queries [MEASURED] to `5/5` Top-3 (`100%`) in `< 50 ms` [TARGET].
  - `route_query.py impact` coverage on `B36–B40`: from `0/5` (subcommand absent) [MEASURED] to `5/5` Top-5 (`100%`) in `< 60 ms` [TARGET].
  - `locate` fusion bonus: symbols/files backed by matching `CALLS`, `IMPORTS`, or `IPC` edges receive a structural coherence boost, lifting 5 owner bug queries (`B16–B20`) to `>= 4/5` Top-5 [TARGET].

---

### Phase 4: Single Entry Plane (`llms.txt`, `AGENTS.md`) & 40-Question Anti-Memorisation Benchmark Gate

- **Objective**: Unify `llms.txt`, `AGENTS.md`, `README.md`, and `route/README.md` around `python3 route/route_query.py` as the single entry point for AI readers and workers, update `catalogue/protocol.json` and `catalogue/router/params.json` so router status is consistent across all gates, and lock in the 40-question benchmark gate (`tests/test_router_benchmark.py` + `tests/fixtures/router_bench_40.jsonl`).
- **Exact Files to Edit / Create**:
  - Edit `llms.txt` and `AGENTS.md` (replace the split-brain `Status: router unavailable.` / missing `route_query.py` guidance with the unified `python3 route/route_query.py` entry-point table while maintaining compatibility with `tools/router_index.py` and `tests/test_router_docs.py`)
  - Edit `tools/router_index.py` (update `_check_corpus_agreement` so calibrated `catalogue/router/params.json` + unified `llms.txt`/`AGENTS.md` pass cleanly)
  - Create `tests/fixtures/router_bench_40.jsonl` (the 40 benchmark queries `B01`–`B40` with expected files/symbols and modes)
  - Create `tests/test_router_benchmark.py` (enforcing Top-1 `>= 26/40`, Top-3 `>= 34/40`, Top-5 `>= 36/40`, Top-20 `>= 39/40`, `MRR@20 >= 0.750`, mean latency `< 120 ms`, static anti-memorisation scan, and dynamic synthetic mutation control)
  - Edit `route/route_query.py` (wire `python3 route/route_query.py check` to run freshness + 40-question benchmark verification)
  - Regenerate `catalogue/nodes.jsonl`, `catalogue/routes.tsv`, `catalogue/router/**`, and `router/index/SHA256SUMS`
  - Create `changes/unreleased/router-unified-entry-and-40q-gate.md`
- **Must NOT Touch**:
  - Do **not** weaken any existing assertion in `tests/test_router_index.py`, `tests/test_router_docs.py`, `tests/test_router_queries.py`, `tests/test_route_map.py`, or `router/kit/tests/test_entry_contract.py`.
  - Do **not** touch `core/**`, `daemon-adapter/**`, `ui/**`, `contracts/**`, or `agents/**`.
- **Implementation Steps**:
  1. Update `llms.txt` and `AGENTS.md` (`L2` section) so AI readers and workers have a single canonical command sequence:
     - `python3 route/route_query.py locate "<query>"` (default entry point for any task or bug)
     - `python3 route/route_query.py ask "<question>"` (behavioral findings with `FRESH`/`SHIFT`/`STALE` verification)
     - `python3 route/route_query.py find "<symbol>"` / `where "<symbol>"` (symbol spans including `.vue`)
     - `python3 route/route_query.py error "<literal>"` (error/log/notice strings)
     - `python3 route/route_query.py impact "<symbol|path>"` (callers, callees, importers, IPC contracts)
     - `python3 route/route_query.py tests "<symbol|path>"` (covering unit/integration tests)
  2. Write `tests/fixtures/router_bench_40.jsonl` containing `B01`–`B40` from Section 3.2. Ensure `_is_test_path()` in `tools/router_index.py` and `SKIP` in `route/route_query.py` exclude `tests/fixtures/router_bench_40.jsonl` from index content extraction.
  3. Write `tests/test_router_benchmark.py` implementing:
     - `test_no_benchmark_memorisation_static()`: scans `route/*.jsonl`, `route/route_query.py`, `tools/router_index.py`, and `catalogue/nodes.jsonl` to prove no `B01`–`B40` query strings or answer tables are hardcoded or indexed from the fixture.
     - `test_dynamic_mutation_control(tmp_path)`: proves a newly created function and error string in a temporary file are routed at Top-1 via live feature extraction.
     - `test_40_question_benchmark_gate()`: runs `B01`–`B40` and asserts all accuracy and latency thresholds from Section 3.3.
  4. Rebuild `catalogue/` and `router/index/SHA256SUMS` and run the full test and law suite.
- **Verification & Gate Commands**:
  ```sh
  python3 route/route_query.py check
  python3 tools/router_index.py --check
  python3 tools/check_laws.py
  pytest -q tests/test_router_benchmark.py tests/test_route_map.py tests/test_router_index.py tests/test_router_docs.py tests/test_router_queries.py router/kit/tests/test_entry_contract.py
  ```
- **Expected Measured Gain**:
  - Single entry point across `llms.txt`, `AGENTS.md`, `README.md`, and `route/README.md` (`0` contradictory `"router unavailable"` instructions) [TARGET].
  - 40-question benchmark permanently gated in CI at `>= 34/40` Top-3 (`85.0%` [TARGET]), `>= 36/40` Top-5 (`90.0%` [TARGET]), `MRR@20 >= 0.750` [TARGET], and `< 120 ms` mean latency [TARGET] with provable zero answer memorisation.

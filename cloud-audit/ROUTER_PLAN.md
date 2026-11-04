# Router plan (reviewed)

Scope: the two repository routers. The catalogue router is `tools/router_index.py`
to `catalogue/nodes.jsonl`, then `router/kit/tools/build_index_v2.py` to
`catalogue/router/`, queried by `router/kit/tools/route_v2.py`. The code map is
`route/route_query.py` over `route/symbols.jsonl` and `route/nodes.jsonl`.
Product code, contracts and budgets are out of scope. Standard library only.

## 1. Review of the previous plan

The previous version of this file was checked against the code at
`de98c883`. Its main defects:

### 1.1 Wrong claims

| Claim in the previous plan | What the tree shows |
|---|---|
| Benchmark gold files `core/mv-engine/src/lib.rs`, `core/mv-capsule/src/lib.rs`, `core/mv-timeline/src/lib.rs`, `daemon-adapter/cmd/mv-SessionDaemon/main.go`, `ui/src/composables/useInputForwarding.js`, `ui/src/services/daemonSocket.js`, `ui/src/components/AddCapsuleModal.vue`, `CapsuleBar.vue`, `ProgramView.vue`, `TimelineBar.vue`, `ScrubBar.vue`, `ui/electron/main.cjs`, `agents/tests/test_verify.py` | None of these 14 paths exist [MEASURED]. The core crate is `core/src/`; the daemon entry is `daemon-adapter/cmd/mv-daemon-adapter/main.go`. The plan's "measured" baselines over these files cannot have been measured. |
| `route/nodes.jsonl` is 1.74 MB and `route/symbols.jsonl` is 2.38 MB | 2,303,776 B and 1,525,945 B [MEASURED] |
| The code map has only partial `.vue` coverage and needs Vue extraction | `route/symbols.jsonl` already has 1,024 `.vue` rows [MEASURED]; `route/README.md` says only `<script>` blocks have symbols. Only the catalogue router lacks Vue symbols. |
| `_SYM_PATTERNS` covers `py`, `rs`, `go`, `js`, `ts` and `sh` | No `sh` and no `vue` entry; `js` is reused for `mjs`, `cjs`, `ts`, `tsx`, `jsx` [MEASURED, `tools/router_index.py:239-286`] |
| Edit `_build_node_for_path(root, rel_path)` | No such function. Node fields come from `_build_search` and `compile_material`. |
| `STOP` is at `route_query.py:22-27`; `locate` at line 276; `error` at line 222 | `STOP` is line 21; `error` starts at 184 and `locate` at 198 [MEASURED] |
| `cite()` needs a new FRESH/SHIFT/STALE scheme with `span_sha16` | Already implemented: citations are `[sid, sha16, start, length]` and `cite()` returns FRESH, SHIFT, STALE or UNKNOWN, with a test (`tests/test_route_map.py`) |
| 3,260 catalogue nodes | 3,274 committed nodes against 3,280 current sources: the base branch fails `python3 tools/router_index.py --check` (22 digests differ) [MEASURED] |
| `tools/check_laws.py` needs a fragment for files "outside `docs/` and `tests/`" | Correct in spirit, and it also applies to `route/` and `cloud-audit/`: the plan commit itself fails the laws check for lack of a fragment [MEASURED] |

### 1.2 Phases too big

Each previous phase changed two routers, a generated data layer and the entry
documents at once (phase 3: import, call, test and contract graphs plus a new
subcommand with an exit-code budget). None was sized to fit a session with
before and after numbers. The phases below each change one thing and name the
benchmark rows that should move.

### 1.3 Ideas with no measured gain (dropped)

- Call graph, `impact`, IPC contract edges, `HOT` exit codes: no benchmark row
  needs them, and the lexical `CALLS` resolution proposed is unverified.
- 40-question pass thresholds (`>= 34/40` and so on): targets without a measured
  baseline on real files; replaced by measured numbers per split.
- Stopword additions `stayed`, `appeared`, `triggered`, `sent`: these are the
  words of the owner bug queries the same plan scores itself on. That is tuning
  to the test, not a general improvement.
- Calibrating `catalogue/router/params.json` and removing
  `Status: router unavailable.`: `_is_router_unavailable` makes `--check`
  accept missing params only while that line exists, and `AGENTS.md` and
  `llms.txt` are hashed in `router/index/SHA256SUMS`. Turning the router on is an
  owner decision, not a ranking fix.
- A `check` subcommand that reruns the benchmark: duplicates the test suite.

### 1.4 A benchmark that could memorise its answers

The previous benchmark named its answer in the query (`B08` "how does
router_index.py validate...", `B14` "bootstrap_kit.py", `B31`-`B40` are paths),
accepted directory prefixes or `tests/` as gold, had nonexistent gold files, had
no held-out split, and its only anti-memorisation check was that the query
strings do not appear verbatim in the router code. Tuning the stopword list from
those queries would pass that check.

## 2. Benchmark (phase 0)

`tests/fixtures/router_bench.jsonl`, run by `python3 tests/router_bench.py`,
checked by `tests/test_router_bench.py`.

- 26 rows: 12 `locate` (plain-language questions), 8 `find` (symbol names, 6
  in `.vue` files), 6 `error` (exact literals). Rows alternate between `dev`
  and `held` splits, 13 each.
- Every gold path exists and its first gold file contains the row's `evidence`
  text (test). A row that names a file that does not exist fails.
- A `locate` query may not share a word with any of its gold paths (test). This
  rule rejected two first drafts (`core`, `daemon`) before any change.
- `locate` query text may not appear in the router code or index data (test).
- Changes are tuned on `dev` only; `held` is reported separately. The fixture
  is committed before the first ranking change, so the order is checkable in
  history.
- The catalogue router is measured on a scratch index compiled from the
  current `tools/router_index.py`, never on the published index, so a stale
  index cannot flatter or hide a change.
- Metrics: hits in the top 1, 3 and 5 and MRR@10 per router, split and mode, and
  mean in-process query time.

Baseline at `de98c883` plus the fixture [MEASURED]:

| Router | top1 | top3 | top5 | MRR@10 | dev top3 | held top3 | mean ms |
|---|---|---|---|---|---|---|---|
| catalogue | 3/26 | 9/26 | 10/26 | 0.228 | 4/13 | 5/13 | 1.7 |
| code map | 12/26 | 15/26 | 17/26 | 0.542 | 7/13 | 8/13 | 1,349 |

Per mode, catalogue `find` reaches 2/8 in the top 3, and 0/6 on Vue symbols. The
code map is strong on `find` (7/8) and `error` (5/6) and weak on `locate` (3/12
top 3). It misses `F06` (`buildWorkingTree`, `ui/src/App.vue`) because its
symbol table is pinned to an older commit, and `E06` because `route/` matches
its own skip rule.

## 3. Phases

Each phase is one commit with a test that fails first, the regenerated
catalogue (`python3 tools/router_index.py`, then `build_index_v2.py`, then
`sha256sum` over the existing `router/index/SHA256SUMS` path list), a fragment in
`changes/unreleased/`, and before and after benchmark numbers.

1. **Vue symbols in the catalogue router.** Mask everything outside `<script>`
   blocks (offsets kept) and apply the existing JS patterns to `.vue` files in
   `_extract_symbols_and_docs`. Expected to move: catalogue `find` on `F01`-`F04`,
   `F06`, `F07`. Owned: `tools/router_index.py`, `tests/test_router_index.py`,
   the benchmark test, generated catalogue files.
2. **Fresh symbols for changed files in the code map.** When a tracked source
   file's current digest differs from the pinned symbol rows, extract its
   symbols in memory with a stdlib regex extractor and replace its rows.
   Expected to move: code map `F06`. No new data files.
3. **Code map `locate` speed.** About 1.35 s per query is spent reading every
   source file for literals. Measure the split first; then cache literals per
   `(path, size, mtime)` inside one process or restrict the scan to files whose
   text contains a query term, and keep scores identical (test compares outputs
   before and after on the benchmark).
4. **Code map `locate` ranking.** Only after phases 2 and 3: add path and symbol
   word splitting to the `locate` path vote and generic question words
   (`where`, `which`, `handled`, `defined`) to `STOP`, tuned on `dev`, accepted only
   if `held` does not drop.
5. **Entry documents.** Point `AGENTS.md` and `llms.txt` at the code map and
   decide the catalogue router status. This needs the owner, because those
   files are the entry law and are hashed.

## 4. Gates for every phase

```sh
python3 tools/router_index.py --check
python3 -B -m unittest tests/test_router_docs.py tests/test_router_index.py tests/test_router_queries.py tests/test_route_map.py tests/test_router_bench.py
python3 tools/check_laws.py --range de98c883..HEAD
python3 tests/router_bench.py --summary
```

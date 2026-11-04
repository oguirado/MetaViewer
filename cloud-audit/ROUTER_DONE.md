# Router work: what was done

Branch `cloud/router-work`, from `cloud/router-plan` at `de98c883`. Two
commits after the plan commit. Plan: `cloud-audit/ROUTER_PLAN.md`.

## Done

1. **Plan reviewed and rewritten** (commit `tools: add a reviewed router plan
   and benchmark`). Section 1 of the plan lists the wrong claims, including 14
   nonexistent gold files in the previous benchmark, the oversized phases, the
   dropped ideas and the memorisation risks.
2. **Phase 0, benchmark.** `tests/fixtures/router_bench.jsonl` (26 rows, dev and
   held-out halves), `tests/router_bench.py` (runs both routers),
   `tests/test_router_bench.py` (gold exists and holds its evidence, `locate`
   queries share no word with their gold paths, no query text in router code or
   data, scoring negative control). The same commit regenerated the stale
   catalogue index: the base branch failed `python3 tools/router_index.py
   --check` with 3,280 sources against 3,274 nodes [MEASURED].
3. **Phase 1, Vue symbols in the catalogue router** (commit `tools: add Vue script
   symbols to the catalogue router`). `tools/router_index.py` masks
   text outside `<script>` bodies (offsets and newlines kept) and applies the
   existing JS patterns to `.vue` files. Tests written first and seen failing:
   `test_vue_script_symbols_extracted_and_template_ignored` in
   `tests/test_router_index.py`, and the ratchet
   `RouterBenchFloorTest.test_catalogue_finds_vue_symbols` (0/6 before).

## Numbers

`python3 tests/router_bench.py --summary`, in process, same container, on the
26-row fixture.

| Router | Commit | top1 | top3 | top5 | MRR@10 | dev top3 | held top3 | mean ms |
|---|---|---|---|---|---|---|---|---|
| catalogue | before phase 1 | 3/26 [MEASURED] | 9/26 [MEASURED] | 10/26 [MEASURED] | 0.228 [MEASURED] | 4/13 [MEASURED] | 5/13 [MEASURED] | 1.7 [MEASURED] |
| catalogue | after phase 1 | 8/26 [MEASURED] | 14/26 [MEASURED] | 16/26 [MEASURED] | 0.429 [MEASURED] | 7/13 [MEASURED] | 7/13 [MEASURED] | 3.9 [MEASURED] |
| code map | both | 12/26 [MEASURED] | 15/26 [MEASURED] | 17/26 [MEASURED] | 0.542 [MEASURED] | 7/13 [MEASURED] | 8/13 [MEASURED] | about 1,350 to 1,410 [MEASURED] |

- Catalogue `.vue` symbol lookups: 0/6 to 5/6 in the top 3 [MEASURED]. The
  miss is `F06` (`buildWorkingTree` in `ui/src/App.vue`): App.vue has more
  symbols than the node's keyword and task caps hold. The caps are schema
  limits, so this was left alone.
- One `locate` row moved as a side effect: `L11` from a miss to rank 4. No
  row got worse [MEASURED, per-query ranks compared].
- The code map is unchanged, as expected: phase 1 only touches the catalogue.
- Millisecond figures come from one run each and vary between runs.

## Dropped, and why

- Call graph, `impact`, IPC edges and the 40-question thresholds: no measured
  need (plan section 1.3).
- Stopwords taken from the owner bug queries: tuning to the test.
- Calibrating `catalogue/router/params.json` and editing `AGENTS.md` or
  `llms.txt`: an owner decision. Those files are the entry law and are hashed,
  and the `Status: router unavailable.` line changes what `--check` accepts.
- Phases 2 to 5 of the new plan were not started in the time limit.

## Known issues not caused by this work

- The plan commit `de98c883` fails `python3 tools/check_laws.py --range
  de98c883~1..de98c883`: `cloud-audit/` counts as product code and that commit
  has no fragment. The commits on this branch carry fragments.
- `tests/test_router_queries.py` checks `catalogue/router/meta.json`, which the
  builder never writes, so it always tests a scratch index rather than the
  published one.

## How to verify

```sh
git log --format='%h %an <%ae> %s' de98c883..cloud/router-work
python3 tools/router_index.py --check
python3 tools/check_laws.py --range de98c883..HEAD
python3 -B -m unittest tests/test_router_docs.py tests/test_router_index.py tests/test_router_queries.py tests/test_route_map.py tests/test_router_bench.py router/kit/tests/test_entry_contract.py
python3 tests/router_bench.py --summary
```

To see the tests fail first, check out `tools/router_index.py` from the first
commit and rerun the two phase 1 tests.

Regeneration uses only the documented tools: `python3 tools/router_index.py`,
then `python3 router/kit/tools/build_index_v2.py --nodes catalogue/nodes.jsonl
--out catalogue/router --thesaurus router/kit/standards/thesaurus.json --corpus
metaviewer` into an emptied `catalogue/router`, then `sha256sum` over the
existing `router/index/SHA256SUMS` path list. Rebuilding the committed nodes
this way reproduced the committed `catalogue/router` byte for byte before any
change [MEASURED].

## Model and effort

The model name is not written here: `LAWS.md` L1.2 forbids naming an AI
model or assistant in repository files. It is given in the session reply.
Effort: medium.

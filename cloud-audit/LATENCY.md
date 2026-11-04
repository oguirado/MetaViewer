# Human input latency investigation (hi-real-key / hi-real-click > 150 ms)

Scope: `core/tests/human_input_real_adapter.rs`, test
`real_core_and_real_daemon_adapter_accept_human_input_and_settle_outcomes`, assertion
`elapsed < Duration::from_millis(150)` (about line 644). Report only; no product code or
test changed in this commit. The 150 ms budget is untouched.

## Builds compared

| Label | Commit | Notes |
|---|---|---|
| base | `v0.2.5` = `origin/main` = `7721915` | Same commit; one build stands for both |
| cand | `ci/assets-86d5a2162` = `86d5a21` | Release candidate under test |

`core/tests/human_input_real_adapter.rs` and `core/Cargo.toml` have no diff between the
two, so the test itself is identical. Builds use the debug `test` profile, the same
profile as the CI gate (`cargo test --locked --offline` in `.github/workflows/ci.yml`).

Host: x86_64, 4 CPUs. Each run executes the test binary directly with
`--exact --nocapture` and parses the printed `[MEASURED]` lines. base and cand
alternate run by run, so drift hits both equally. "load" means 4 `while :; do :; done`
unpinned busy loops, running for the whole phase.

## Results

Samples are per input (5 inputs per run: click, key, type, type-paste, scroll).
Percentiles are nearest-rank.

| Case | Runs | Samples | min ms | median ms | p95 ms | max ms | samples >= 150 ms | runs failed |
|---|---|---|---|---|---|---|---|---|
| idle base | 21 | 105 | 40.60 [MEASURED] | 53.49 [MEASURED] | 67.03 [MEASURED] | 97.07 [MEASURED] | 0 | 0/21 |
| idle cand | 21 | 105 | 61.11 [MEASURED] | 80.11 [MEASURED] | 121.52 [MEASURED] | 136.22 [MEASURED] | 0 | 0/21 |
| load base | 10 | 50 | 49.24 [MEASURED] | 84.00 [MEASURED] | 116.78 [MEASURED] | 137.45 [MEASURED] | 0 | 0/10 |
| load cand | 10 | 31 (censored) | 72.56 [MEASURED] | 131.90 [MEASURED] | 187.99 [MEASURED] | 213.84 [MEASURED] | 7 | 7/10 |

The load cand row is censored: the test stops at the first sample over budget, so 19
of 50 samples were never printed. Its true percentiles are higher than shown.

Shortfall against the request: 42 idle runs and 20 loaded runs were done (21 and 10 per
build), not 30 per case. Each run costs about 24 s idle and about 40 s loaded, almost
all of it the per-run `go build` of the adapter. That did not fit the time box. The
difference between builds is far larger than the spread, so the verdict does not depend
on the missing runs.

## Verdict: real regression in core, not noise

- Idle median rises from 53.49 ms to 80.11 ms [MEASURED], +26.6 ms (+50 %). The cand
  idle minimum (61.11 ms) is above the base idle median.
- Under 4-CPU load, base never crossed 150 ms (0/10 runs). cand failed 7 of 10 runs,
  which matches the CI reds of 150.97 ms and 154.21 ms [CITED, task brief]. Hosted CI
  with other jobs on the box behaves like the load case.

### Which side: swap experiment

Core and adapter were swapped between trees. The test builds the adapter from the
tree it runs in. 5 runs each, idle:

| Tree | Core | Adapter | median ms | p95 ms | max ms |
|---|---|---|---|---|---|
| hybA | cand | base | 76.66 [MEASURED] | 87.79 [MEASURED] | 94.38 [MEASURED] |
| hybB | base | cand | 51.90 [MEASURED] | 62.84 [MEASURED] | 63.98 [MEASURED] |

The whole regression follows the core. The new adapter code is not on the slow path:
`runtime.LockOSThread` and `PR_SET_PDEATHSIG` in `main.go`, the resource inventory
(only touched on create, bind and close in `capsule/manager.go`) and slots. The core
side of slots, observations and inventory adds journalled state, but no extra work runs
per human input. The extra work is in the wire codec.

## Dominant stage: envelope schema validation in `wire::decode_envelope`

`core/src/wire/mod.rs` `decode_envelope_with_limits` validates every inbound envelope
with `valid(&value, &schema, &schema)`. Two things make this slow:

1. `valid` resolves every external `$ref` with `schemas::schema(file)`.
   `core/src/wire/schemas.rs` `schema()` runs `serde_json::from_str` on the embedded
   `include_str!` text on every call. Nothing is cached, so each `$ref` reached
   re-parses a whole contract file.
2. Between base and cand, `contracts/v0.2/envelope.schema.json` adds two alternatives
   to the `body` `oneOf`: `capsule_state_request.schema.json` and
   `capsule_state_event.schema.json`. `oneOf` has to evaluate every alternative, so
   every envelope (surface_request, surface_event, action_verdict, hello, ...) now
   parses and walks two more contract files.

Micro-benchmark (debug, 50 calls each, scratch test, not committed):

| Envelope body | base ms/decode | cand ms/decode |
|---|---|---|
| surface_request (input) | 3.499 [MEASURED] | 5.553 [MEASURED] |
| surface_event | 4.041 [MEASURED] | 5.852 [MEASURED] |
| surface_event | 3.489 [MEASURED] | 5.469 [MEASURED] |

Decode is called on many paths per input, not only once. A counting probe recorded 151
decode calls in one test run for both builds [MEASURED]. Besides the IPC receive path,
the journal re-decodes envelopes (`core/src/journal/mod.rs` around lines 3504, 3592 and
3918). So the cost lands in the stages "IPC receive", "proposal admission" and
"journal append". The fsync itself did not change: there is no `core/src/journal` diff
between base and cand. Measured by per-stage elimination: the swap places 100 % of the
delta in core, and removing schema re-parsing alone (below) removes more than the
delta. Separate per-stage timers for adapter start, verdict and event were not added.

## Smallest fix

Parse each embedded contract once per process. Memoize `schemas::schema()` (scratch
patch that was measured):

```rust
pub(super) fn schema(name: &str) -> Option<serde_json::Value> {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    static CACHE: OnceLock<Mutex<HashMap<String, Option<serde_json::Value>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    if let Some(v) = cache.lock().unwrap().get(name) {
        return v.clone();
    }
    let v = schema_uncached(name); // the existing body, renamed
    cache.lock().unwrap().insert(name.to_owned(), v.clone());
    v
}
```

Measured with the cand tree plus only this patch, idle, 6 runs / 30 samples:
min 34.05, median 41.13, p95 57.84, max 66.01 ms [MEASURED]. That is below the v0.2.5
baseline (median 53.49 ms). The 4 `wire` unit tests in the core lib pass with the
patch [MEASURED]. The full suite and the load case were not re-run with the patch.

A stronger follow-up: hold `&'static Value` and stop cloning. That needs `schema()` to
return a reference, and `valid()` and `decode_envelope` to borrow instead of owning.
This touches about 5 call sites.

The fix keeps the 150 ms budget, the assertion, the test and the contracts unchanged.
Validation semantics stay identical, because the inputs are compile-time constants and
the `mv_tool_result` v0.1 to v0.2 projection is deterministic.

### Risk

- Low. The cache keys are the fixed set of embedded file names (`_ => None` is also
  cached), so memory is bounded by the contract set. It is never invalidated, which is
  correct because the text is `include_str!`.
- The `Mutex` is uncontended in practice: one serialization point in `Server`.
  Poisoning would panic, as any `unwrap` in that path would today.
- Clone cost remains; it is far below the parse cost as measured.
- Behaviour risk lies only in a caller that mutates the returned `Value`. It gets an
  owned clone, so the cache cannot be corrupted.
- Not verified here: the full `cargo test` suite, release-profile behaviour, and the
  4-CPU load distribution with the fix. Verify these on CI before tagging.

## Reproduction

```bash
git worktree add --detach ../base v0.2.5
```

```bash
git worktree add --detach ../cand 86d5a21
```

In each tree:

```bash
cargo test -p metaviewer-core --test human_input_real_adapter --no-run
```

Then run the printed test binary from `core/` repeatedly:

```bash
<bin> real_core_and_real_daemon_adapter_accept_human_input_and_settle_outcomes --exact --nocapture 2>&1 | grep MEASURED
```

For the load case, start four `sh -c 'while :; do :; done' &` first.

---
Model: Claude (Anthropic), via Claude Code. Effort: low.

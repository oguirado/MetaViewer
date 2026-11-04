# Evidence available to a reader

Public source inspection establishes implemented predicates and test assertions.
A test file's existence is not a passing test run. A reported historical live run
is not current-checkout qualification. The links below make that distinction explicit.

## Public source and deterministic tests

| Claim | Implementation | Existing test evidence |
| --- | --- | --- |
| Admission refuses a stale frame before dispatch | [Freshness checks](../core/src/admission/mod.rs) | [Admission refusal matrix](../core/tests/admission_matrix.rs) |
| Journal replay reconstructs state and rejects damaged history | [Journal](../core/src/journal/mod.rs), [mv-replay](../core/src/bin/mv-replay.rs) | [Durable replay, digest and corruption tests](../core/tests/admission_journal.rs), [journal verification and witness tests](../core/tests/t1_journal_verify.rs) |
| Stored profile slots require custody and compatibility | [Slot store](../daemon-adapter/internal/capsule/slots/store.go) | [Slot store tests](../daemon-adapter/internal/capsule/slots/store_test.go) |
| Transport has explicit input ceilings | [Adapter configuration](../daemon-adapter/internal/ipc/config.go) | [Input limits guide](ADAPTER_INPUT_LIMITS.md) |

The admission journal tests construct synthetic journals, invoke the replay binary,
compare the reconstructed digest and apply negative controls. These are source
assertions, not newly recorded execution results. See [Testing](TESTING.md) for
commands and prerequisites; the full gate requires toolchains and cached dependencies.

## Reported live evidence and its limits

The [published pre-release notes](https://github.com/oguirado/MetaViewer/releases/tag/v0.2.5)
and [Judge tour](JUDGE_TOUR.md) attribute browser, program, handoff and cleanup
observations to the maintainer [CITED: those reports]. They do not include raw
receipts here. The tour's local-page rules-planner results do not certify Muse on
x64, exact program text, real mouse drag, or current-checkout live performance.

The c26/c27 evaluation notes and the historical `live21_NOTE.md` / `live22_NOTE.md`
referenced by [README](../README.md#historical-live-evidence) are external reports.
This repository holds no scrubbed raw copies. Their run
commands, complete commit identities and raw timing records cannot be reconstructed
from the summaries. No replacement receipt is manufactured here.

The [demo runbook](DEMO_RUNBOOK.md) provides its own scoped context; it does not stand in for those missing notes or
prove current release-wide acceptance. Static checks do not establish live frame
rate, semantic task success, guest behavior or private isolation internals.

## Private boundary

`wender-agent`, `vision-engine` and `OpenSuperficies` are fully private. Their
repositories and source are closed. Public compiled x64 evaluation builds do not
make their implementations auditable. MetaViewer's source is AGPL-3.0-only; the
private builds have the limited permission in [NOTICE-EVALUATION.md](../NOTICE-EVALUATION.md).

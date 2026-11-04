# Evidence available to a reader

Public source proves what a predicate or test asserts. A completed run proves
what happened for its recorded revision, inputs and environment. Neither a test
file nor a historical demonstration certifies the whole current release.

## What can I verify from public source?

You can inspect the implementation beside the tests that exercise its success
and refusal paths. Run those tests to obtain evidence for your own checkout.

Answers: source evidence; test assertions; where a claim is implemented

| Claim to inspect | Implementation | Test assertions |
| --- | --- | --- |
| Admission rejects missing or stale frames and unavailable agent control | [Admission `check`](../core/src/admission/mod.rs) | [Admission matrix](../core/tests/admission_matrix.rs) |
| Replay reconstructs state and detects damaged history or witnesses | [Journal](../core/src/journal/mod.rs), [replay CLI](../core/src/bin/mv-replay.rs) | [Durable replay and corruption](../core/tests/admission_journal.rs), [journal verification](../core/tests/t1_journal_verify.rs) |
| Saved capsule data needs stopped-profile custody and compatible metadata | [Slot store](../daemon-adapter/internal/capsule/slots/store.go) | [Slot store tests](../daemon-adapter/internal/capsule/slots/store_test.go) |
| IPC configuration rejects missing bounds and excessive ceilings | [Transport configuration](../daemon-adapter/internal/ipc/config.go) | [Explicit-policy test](../daemon-adapter/internal/ipc/ipc_test.go) |
| A wall-routing mutation must fail the intended rendered-wall assertion | [Journey runner](../tests/e2e/run.py) | [Routing classifier test](../tests/test_ci_volume_e2e.py) |

These are source assertions, not a newly executed test report. Reproduction
commands and prerequisites are in [TESTING.md](TESTING.md).

## What do the reported live results establish?

The live observations in [JUDGE_TOUR.md](JUDGE_TOUR.md),
[AI_AT_THE_CONTROLS.md](AI_AT_THE_CONTROLS.md) and
[the README](../README.md) are maintainer-reported results for the flows they
name. Their raw evaluation receipts are not published in this repository.

Answers: live evidence; maintainer reports; missing receipts; demonstration limits

Do not extend a reported browser success to other planners, program text entry,
mouse gestures, capsule kinds or platforms. A video shows its recorded flow; it
does not establish repeatability or release-wide acceptance. A local fixture
pass does not prove external runtime behavior. The [demo runbook](DEMO_RUNBOOK.md)
defines a demonstration path, not a substitute for missing test receipts.

Independently reproducible timing records and complete raw live acceptance
receipts for this documentation seal: **ABSENT — do not invent**. Keep that gap
visible when citing the reported results.

## What should accompany a new validation claim?

Record the revision, exact command, input or fixture, runtime prerequisites,
result and negative control. Preserve the relevant report and cleanup result.

Answers: reproducible evidence; validation report; performance claim

A resource claim also needs the measured workload and instrument output. A
successful process exit is insufficient when the report says `SKIPPED` or
`BLOCKED`; see [TESTING.md](TESTING.md#how-do-i-interpret-a-skipped-or-blocked-check).
For a live action, distinguish admission, dispatch and verified outcome. If
input completion is uncertain, retain that verdict instead of replacing it with
success. [CITED: ../tools/gate_g_ai.py; ../tests/e2e/e2e1_slice/index.js;
../agents/metaviewer_agents/mw_run.py]

Remove credentials, personal paths and browser-session material before sharing
reports. [DEBUG.md](DEBUG.md) lists the useful diagnostic fields.

## What remains outside the public audit boundary?

The private external components cannot be audited from this source tree.
Evaluation of supplied compiled components follows the permission in
[NOTICE-EVALUATION.md](../NOTICE-EVALUATION.md).

Answers: private source; evaluation permission; source license

`wender-agent`, `vision-engine` and `OpenSuperficies` are separate proprietary
programs with private source. MetaViewer's source is `AGPL-3.0-only`; the public
capsule UI kit has its own repository. Integration pins in [deps.lock](../deps.lock)
and [ui/kit.lock.json](../ui/kit.lock.json) identify dependencies, not independent
verification of their internals.

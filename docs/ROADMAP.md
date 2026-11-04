# Hackathon roadmap

The historical calendar is no longer the product status. Use [VERSION](../VERSION)
and [CHANGELOG.md](../CHANGELOG.md) for release identity and shipped changes.
This page records current validation gaps and the evidence needed to close them.

## What is implemented and what still needs validation?

Public source implements the application and its test harnesses. Current live
qualification must be demonstrated separately for each claimed platform and flow.

Answers: roadmap; current status; implemented versus validated; known limitations

| Area | Status | Evidence needed before a stronger claim |
| --- | --- | --- |
| Authority, frame admission and journal replay | Implemented; public tests available | Passing tests at the revision being evaluated; see [TESTING.md](TESTING.md) |
| Live browser and program flows | Maintainer-reported, limited to named flows | Reproducible per-flow receipts for the current release; see [EVIDENCE.md](EVIDENCE.md) |
| Cross-platform package behavior | Package and platform checks exist | Execution results for the actual package on each claimed platform |
| Live performance and capacity | Current reproducible measurements absent from this page | Workload, revision, instrument output and cleanup evidence |
| Private runtimes | Supplied compiled evaluation boundary | Evaluation under [NOTICE-EVALUATION.md](../NOTICE-EVALUATION.md); public source cannot audit their internals |

Implementation sources: [admission](../core/src/admission/mod.rs),
[journal](../core/src/journal/mod.rs), [local gate](../tools/gate.sh),
[CI](../.github/workflows/ci.yml). These entries describe scope, not new test passes.

## Which known issues affect an operator now?

Some conditions require a specific recovery or leave the result uncertain.
Use the status below rather than treating every stopped action as a product crash.

Answers: known issues; current limitations; uncertain input; full journal; missing terminal

| Condition | Status | Operator response |
| --- | --- | --- |
| `INPUT_UNCERTAIN` | Explicit unresolved delivery outcome | Inspect the capsule and report before deciding the next action; never blindly resend. [Source](../agents/metaviewer_agents/mw_run.py) |
| Session journal exhausted | Designed session limit; new work refused | Preserve the journal, follow cleanup and start a fresh session. [Recovery](JOURNAL_END.md), [source](../core/src/serve/journal_end.rs) |
| Admission at the journal capacity boundary | Unresolved limitation: a later dispatch or profile-fence write can be refused after admission | Do not infer execution from admission; preserve the accepted prefix and inspect the outcome. [Details](JOURNAL_END.md#can-admission-succeed-without-execution-at-the-capacity-boundary) |
| Terminal support missing from a package | Runtime prerequisite unavailable | Use a package with working native terminal support. The host reports `TERMINAL_UNAVAILABLE`. [Source](../ui/electron/terminalHost.js) |
| Offline gate passes while live RSS probe is skipped | Validation gap | Read the probe status and run with its prerequisites before claiming live resource results. [Source](../tools/gate.sh) |
| Slot data after power loss on unqualified filesystems | Qualification gap | Do not claim power-loss durability beyond tested storage. [Source](../daemon-adapter/internal/capsule/slots/store.go) |

These statuses do not claim that every possible failure is catalogued. For a
specific symptom or refusal, start at [DEBUG.md](DEBUG.md) or the generated
[ERRORS.md](ERRORS.md).

## What closes the remaining validation work?

A gap closes when the intended run passes and its negative control fails for the
expected reason, with enough evidence to reproduce both outcomes.

Answers: next validation work; acceptance criteria; roadmap completion

| Work [TARGET] | Acceptance evidence [TARGET] | Rejection control [TARGET] |
| --- | --- | --- |
| Current checkout integration | Full local gate and gate self-test pass | Injected faults are rejected by the gate self-test |
| Live capsule qualification | Correct frame, action outcome, replay and complete cleanup | Stale or cross-surface evidence cannot verify an action |
| Published performance claim | Named workload with recorded measurements | Missing measurement or exceeded bound is not reported as a pass |
| Release documentation | Commands resolve, links work and indexes match the final documents | Missing pages, nonexistent suites and stale digests fail |

Runners and fixtures are linked in [TESTING.md](TESTING.md). The maintainer decides
release and submission after reviewing the actual results; the calendar alone
never establishes completion.

## Where is the original event plan?

The original dated milestone plan remains in Git history. Its dates and version
seals were targets, not execution receipts.

Answers: historical roadmap; original calendar; pre-existing plan

Use `git log -- docs/ROADMAP.md` and `git show <revision>:docs/ROADMAP.md` to inspect
a specific historical version. The earlier scaffold and its provenance are
summarized in [PREEXISTING.md](PREEXISTING.md). This status page does not infer
completion from the former schedule.

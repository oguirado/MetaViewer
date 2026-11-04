# Full session journals

A full journal closes admission for that session. The accepted history remains
replayable; it does not prove that pending actions completed or every capsule
stopped. The behavior is implemented in
[journal_end.rs](../core/src/serve/journal_end.rs).

## What do the session errors mean?

`JOURNAL_FULL` means no further work can be admitted. `JOURNAL_STOP_FAILED`
means cleanup of a capsule remains unconfirmed.

Answers: JOURNAL_FULL; JOURNAL_STOP_FAILED; all actions refused

| Diagnostic | Meaning | Operator action |
| --- | --- | --- |
| `JOURNAL_FULL` | Admission closed; the core requests capsule cleanup in order | Preserve the accepted journal and start a fresh session after cleanup |
| `JOURNAL_STOP_FAILED` | The outstanding stop did not reach a confirmed terminal state | Close MetaViewer and use operating-system controls to stop remaining capsules before reopening |

These are error events on the existing `surface_event/v0.2` carrier [CITED:
`contracts/v0.2/surface_event.schema.json`]. Consumers recognize a session
diagnostic by both `data.surface_id: "session"` and the code. A capsule-local
error does not end the session merely because it uses the same code.
The UI displays fixed local wording, rather than peer-supplied detail.
See [App.vue](../ui/src/App.vue) and [journal_end.rs](../core/src/serve/journal_end.rs).

## Does the end marker prove cleanup succeeded?

No. `journal-ended.json` is a replay-bound hint, not proof that processes have
stopped. Missing or invalid markers cannot override the accepted journal.

Answers: journal-ended.json; replay authority; lost capsules; cleanup status

The core validates the marker against replayed state. Cleanup replies do not
rewrite accepted history. The UI withdraws live presentation and marks active
or creating capsules as lost while cleanup is unconfirmed. Preserve the journal
and its witnesses unchanged; use [the replay guide](DEBUG.md#replay-a-journal-with-mv-replay)
to verify them. See [journal_end.rs](../core/src/serve/journal_end.rs),
[App.vue](../ui/src/App.vue) and [tileStates.js](../ui/src/wall/tileStates.js).

## Start another session

Close MetaViewer, confirm that remaining capsules have stopped, then launch the
normal packaged application again. It creates a fresh session and private
runtime/state directories [CITED: `ui/tools/package.js`].

Answers: recover from a full journal; restart; fresh session

An explicitly attached developer session is still the old session. Leave
attach mode and use the normal application entry to create a new one.
Do not delete the journal, increase a limit or treat a frozen tile as live
to continue the ended session.

## Can admission succeed without execution at the capacity boundary?

Yes. Admission and dispatch use separate journal writes; the later write can
be refused after the earlier write was accepted. A create request can likewise
be accepted before its profile fence fails to fit.

Answers: admitted without execution; partial journal boundary; known limitation

**Status: unresolved limitation.** The accepted prefix remains replayable,
cleanup begins and new work is refused. An admitted verdict alone is not an
execution or completion receipt. See the capacity handling in
[serve/mod.rs](../core/src/serve/mod.rs),
[journal_end.rs](../core/src/serve/journal_end.rs) and
[the journal tests](../core/tests/admission_journal.rs).

# Full session journals

A full journal permanently closes admission for that session. Accepted records
remain replayable. Refused frames and subsequent cleanup are not journaled and
do not change the accepted replay snapshot. Archive and record limits are unchanged.

## Existing error carrier

These are application diagnostics on the existing `surface_event/v0.2` error
variant in `contracts/v0.2/surface_event.schema.json`, not new message types.
The reserved `data.surface_id` value `session` denotes the session diagnostic,
not a capsule identity. Consumers must match both this value and the error code.

- `JOURNAL_FULL`: admission is closed; reject pending and new work. Capsule
  cleanup proceeds serially. Do not claim that every capsule has stopped.
- `JOURNAL_STOP_FAILED`: an error for the outstanding cleanup target remained
  unconfirmed after the follow-up grace period. Stop progress is unconfirmed;
  close MetaViewer and use operating-system controls to stop any remaining
  capsules before reopening. In-app stop is unavailable in an ended session.

For example, the existing carrier accepts
`{"schema":"surface_event/v0.2","event":"error","data":{"surface_id":"session","code":"JOURNAL_FULL","detail":"Session journal is full."}}`.
Omitting `data.detail` is invalid under that same schema. A capsule error using
another surface identity must not close the session, even with this code.
The UI uses fixed local text rather than rendering peer-supplied detail.

## Recovery and presentation

The internal `metaviewer.journal-ended/v1` marker is a replay-bound hint containing
`core_seq` and `state_sha256`. It grants no authority. Missing, unreadable, empty,
malformed or mismatched hints cannot override replay. Invalid hints are reported
and ignored. A later capacity refusal derives the end again. Marker persistence
failure is reported but cannot reopen admission or reset a peer in that running
process. Without a valid persisted marker, a restart derives the end again at
the next capacity refusal. Failure to flush accepted history before ending is
an I/O failure and can still close the peer transport.

Stop replies do not rewrite accepted history. On restart, an exact daemon refusal
`ADAPTER_SURFACE` with detail `surface: unknown or terminal surface` for the
outstanding cleanup target permits the next stop. The older lowercase `surface`
code with unprefixed detail `unknown or terminal surface` is also recognized.
A destroy already draining instead returns `ADAPTER_SURFACE` with detail
`surface: destroy already in progress`; this keeps the outstanding target and
does not report a stop failure. This may send a redundant destroy request; the
adapter does not re-destroy a terminal capsule. An unrelated refusal or a genuine
policy failure cannot release that barrier. Without a completed daemon inventory protocol, a
redundant probe is preferable to claiming a persisted marker proves live absence.

Errors carry no destroy request identity. Core waits for a following terminal
event during a one-second grace period [TARGET, unit decision] before reporting
`JOURNAL_STOP_FAILED`. A `destroyed` event or exact terminal refusal cancels the
pending warning and permits the next stop; an unresolved error reports once per
outstanding target and retains the barrier. A terminal event arriving after the
warning still permits progress; it cannot retract a warning already shown.

UI- and agent-triggered capacity refusals start the same serial cleanup as daemon
events. Each connected observer is offered one initial `JOURNAL_FULL` notice.
Backpressure can drop a notice, but cannot reset that peer or block cleanup.
An ended-session request or reconnect offers the notice again.

Disconnect cleanup removes local pending human-input waiters without appending
human-input, headless-uncertain or guest-command-uncertain records. This preserves
the marker's replay binding even if a smaller cleanup record would still fit.

The UI withdraws live frame presentation when admission closes and marks active
and creating surfaces lost (unconfirmed). Destroyed and already lost states keep
their terminal presentation. This does not assert successful cleanup or alter
replay authority.

## Start another session

Close the application and launch MetaViewer again from its normal application
entry. The packaged launcher creates a fresh random `pkg-` session identifier and
private runtime/state directory on every launch; it does not reuse an ended
session. An explicitly attached developer session remains that same session:
leave attach mode and launch the normal packaged application for a new one.
The launcher implementation and generated entry are in `ui/tools/package.js`.


## Partial admission at the capacity boundary

M2 remains a bounded terminal-record limitation. Proposal admission and dispatch
are separate journal writes, as are a surface-create request and its profile
fence. Capacity can refuse the later write after the earlier one was accepted.
An agent may therefore receive an admitted verdict without a dispatch, or replay
may end with a surface-create request without its profile fence. The accepted
prefix remains replayable; admission is not proof of execution or completion.
Cleanup still starts and further work is refused. Avoiding this boundary requires
coordinated capacity reservation across those writes; no limit is raised here.

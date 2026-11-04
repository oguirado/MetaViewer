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
- `JOURNAL_STOP_FAILED`: the active cleanup request failed. Stop progress is
  unconfirmed; stop remaining capsules before starting another session.

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
failure is reported but cannot reopen admission or reset a peer.

Stop replies do not rewrite accepted history. On restart, an exact daemon refusal
`ADAPTER_SURFACE` with detail `surface: unknown or terminal surface` for the
outstanding cleanup target permits the next stop. The older lowercase `surface`
code with unprefixed detail `unknown or terminal surface` is also recognized.
These exact wire pairs are distinct from genuine policy failures. This may send a redundant destroy request; the adapter does not
re-destroy a terminal capsule. An unrelated refusal or a genuine policy failure
cannot release that barrier. Without a completed daemon inventory protocol, a
redundant probe is preferable to claiming a persisted marker proves live absence.

The UI withdraws live frame presentation when admission closes and marks the last
accepted active surfaces lost (unconfirmed), rather than showing frozen pixels as
live. This does not assert successful cleanup or alter replay authority.

## Start another session

Close the application and launch MetaViewer again from its normal application
entry. The packaged launcher creates a fresh random `pkg-` session identifier and
private runtime/state directory on every launch; it does not reuse an ended
session. An explicitly attached developer session remains that same session:
leave attach mode and launch the normal packaged application for a new one.
The launcher implementation and generated entry are in `ui/tools/package.js`.

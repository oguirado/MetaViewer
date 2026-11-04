# XPRA role tiles

Xpra supplies a live client view for supported capsule roles. It does not make
Host programs isolated. Use [the user guide](USER_GUIDE.md) for operation and
[the UI architecture](UI_ARCHITECTURE.md) for the wider design.

## What does client readiness establish?

Readiness checks the connected client, requested read/write mode, matching
viewport dimensions, a window and a canvas with nonzero dimensions. It does not establish
that an application task succeeded.

Answers: Xpra readiness; connecting tile; client viewport; read-only view

The checks and timeout are implemented in
[xpraClient.js](../ui/electron/xpraClient.js), `xpraReadyExpression` and
`waitForXpraClient`. Invalid keyboard layout input, lost role authority and
readiness timeout are refusals. No external Xpra implementation is documented
or certified here.

## What happens when the view disconnects?

The host marks the view as reconnecting and retries while the same role remains
authorized. A refused reconnect does not count as a recovered view.

Answers: reconnecting tile; lost client; Xpra recovery

[xpraRecovery.js](../ui/electron/xpraRecovery.js), `createXpraRecovery`, owns
that retry loop. [roleHost.js](../ui/electron/roleHost.js) owns role lifecycle;
[xpraHumanTile.js](../ui/electron/xpraHumanTile.js) binds the child view.
Focus and visibility changes alone are not recovery signals.

## How can this behavior be verified?

Read the relevant source and run the Xpra-focused UI tests before drawing a
conclusion about a changed build. A code-level pass does not prove a working
live desktop session.

Answers: Xpra tests; live verification; design-note status

[TESTING.md](TESTING.md) explains the UI test runner.
[DEBUG.md](DEBUG.md) explains symptom collection. This page replaces the former
implementation-wave checklist; it is not a completed live-test receipt.

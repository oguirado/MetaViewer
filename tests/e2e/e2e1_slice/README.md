# Hosted slice and LIVE prerequisite

[TARGET, unit decision] `node tests/e2e/e2e1_slice/index.js` runs a real Rust
Authority process, its durable journal and mv-replay. It checks generation-bound
admission, stale refusal without domain or budget mutation, cancellation,
dispatch, human hold, drain, release, fresh-frame readmission and receipt.
This is core integration coverage. Adapter, Electron and agent socket coupling
remain unproven. `mvctl observe` remains an unsupported CLI operation; the
frame/admission path here does not claim CLI observe-to-act coverage.

`MV_E2E_LIVE=1 node tests/e2e/e2e1_slice/index.js --live` fails closed with
E2E_PREREQ. Missing production connections on this branch:

- `core/src/bin`: an authority-serving entry connecting transport and journal.
- `daemon-adapter/cmd/mv-daemon-adapter/main.go`: configured `daemon.Runtime`
  with authority policy, publisher, manager and socket configuration.
- UI boot: the authority frame feed and agent proposal/receipt connection.

No container is created before these prerequisites exist. No live result is
inferred from the hosted slice or the existing synthetic wall.

The golden fixture declares the expected state independently of the reducer.
Its digest is Python hashlib SHA-256 over sorted compact JSON. The same fixture
is consumed on every architecture; cross-architecture execution requires CI.
The initial frame is included in create; connect is the first journal event.

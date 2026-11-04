# Visual-layer research ledger

The earlier research ledger was planning material, not proof of the current UI.
Its duplicated recommendations and unresolvable source labels have been removed
from this entry. Use the implemented sources and current guides below.

## Where is the current UI design documented?

[UI_ARCHITECTURE.md](UI_ARCHITECTURE.md) describes the current UI boundary;
[USER_GUIDE.md](USER_GUIDE.md) explains how to operate it.

Answers: current visual architecture; user interface; research status

| Question | Current source |
| --- | --- |
| How are capsule panels laid out? | [layout.js](../ui/src/wall/layout.js) |
| How are desktop assignments saved? | [desktopLayout.js](../ui/electron/desktopLayout.js) |
| How does host role switching work? | [roleHost.js](../ui/electron/roleHost.js) |
| Which kit revision is integrated? | [kit.lock.json](../ui/kit.lock.json) |

These links identify implementation, not a claim of live validation. Use
[TESTING.md](TESTING.md) for the checks and [EVIDENCE.md](EVIDENCE.md) for
what the repository can substantiate.

## Where can I inspect the historical planning?

Git history retains the previous ledger. [PREEXISTING.md](PREEXISTING.md)
separates pre-event design work from the current assembly.

Answers: earlier research; pre-event work; historical ledger

Research recommendations do not become product guarantees by appearing in a
planning note. Verify a behavior against the current source and its tests.

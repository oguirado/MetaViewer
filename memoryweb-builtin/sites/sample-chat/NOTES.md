<a id="sample-chat-site"></a>
# Sample chat draft

## Intent
Neutral built-in draft for an operator-present chat form on a reserved example origin (https://chat.example.com/). It exists so the built-in fallback, the checker and the hosted replay can be proven offline. No live page was read.

## Starting state
Operator opens the page in their own active identity. A login, consent or uncertain state stops automation for operator handoff. Never type credentials or bypass a wall.

## Variable slots
The ask workflow accepts a private runtime prompt slot. Never persist its value.

## Ambiguous controls
ABSENT — do not invent: live composer accessible name, new-chat control accessible name, answer-ready predicate, empty composer witness and authenticated state anchors. Live click targets are null so admission refuses rather than guessing coordinates or labels.

## Expected result
Offline ask-fixture types the supplied prompt and verifies ANSWER_READY on the neutral reviewed fixture. The ask and new-chat workflows remain drafts with no anchors.

## Exceptions
Every login or challenge wall hands off to the operator through the existing owner. No credential entry, no solving, no automatic retries, no capsule restart.

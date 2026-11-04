# Adapter text input limits

Text admission is bounded, and a failed delivery can leave a visible prefix.
Observe the capsule before retrying. This page describes the public adapter;
it does not certify the implementation of the separately supplied runtime.

## How much text can an action carry?

The adapter accepts at most `16384` Unicode runes per text action and splits
them into native calls of at most `2000` runes [CITED:
`daemon-adapter/internal/capsule/manager.go`, `AdapterTextMaxRunes`,
`NativeTextMaxRunes`]. The text must be nonempty and printable. Newlines and
other non-printable characters are refused. Transport limits can reject a
message before this text check.

Answers: text length; Unicode limits; TEXT_TOO_LONG; newline refusal

An over-limit action returns `TEXT_TOO_LONG`. Invalid text returns `input`.
These checks precede native delivery. The limits describe this adapter's code,
not a newly measured limit of an external backend. Boundary and Unicode cases
are covered by [textcap_test.go](../daemon-adapter/internal/capsule/textcap_test.go).

## What happens if a later chunk fails?

The sequence stops without reporting aggregate success. Earlier chunks may
already have arrived, so resending the whole action can duplicate input.

Answers: partial text; interrupted typing; safe retry; chunk evidence

Each chunk must pass the adapter's receipt, clock, binding and control checks;
focus is also checked when a native window is bound. Cancellation, takeover or a changed binding interrupts the sequence.
On complete success, the public receipt carries the final native result.
Per-chunk evidence stays in the adapter's `TextSequence` field, which is excluded
from JSON. See [manager.go](../daemon-adapter/internal/capsule/manager.go),
`InputEvidence` and the input loop, and
[textcap_test.go](../daemon-adapter/internal/capsule/textcap_test.go).

## Does text delivery use the clipboard?

It can. Agent text adds `--paste` when the selected profile has
`text_input: "paste"`; human text adds it when the text contains characters
outside printable ASCII. Both paths still use `--type-stdin` in the browser
input branch [CITED: `daemon-adapter/internal/capsule/manager.go`, `needsPaste`
and the `type` action branch].

Answers: clipboard use; paste profile; human Unicode input

Do not infer runtime permission from a flag name. The adapter's selection is
public source behavior; backend permission and refusal remain part of the
external runtime boundary described in [NOTICE-EVALUATION.md](../NOTICE-EVALUATION.md).
Host-window input has its own implementation in
[host_window.go](../daemon-adapter/internal/capsule/host_window.go).

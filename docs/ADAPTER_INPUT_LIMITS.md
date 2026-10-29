# Adapter text input limits

The adapter delivers printable text with `--type-stdin`. The native call cap is
2000 runes [CITED: OpenSuperficies `src/browserid/inject/inject.go:279–281`,
`deps.lock` commit `a9ac1ac8543872b428990ea23fa2629cd0a6d1d5`]. Native validation
also rejects non-printable runes [CITED: the same source, lines 284–287]; the
adapter refuses those at admission with `input`, including trailing newlines
which the CLI would otherwise remove.

The per-proposal cap is 16384 runes [TARGET, unit decision]. Text above that cap
is refused with stable fault code `TEXT_TOO_LONG` before consuming a permit or
calling the native CLI. Existing JSON transport byte/string caps still apply
before action admission. The cap counts Unicode runes, not bytes; each native
chunk is at most 8000 UTF-8 bytes [CITED: native rune cap and UTF-8 encoding],
below the CLI stdin cap of 16 KiB [CITED: pinned OpenSuperficies
`docs/CONTRACT_IDENTITY_SURFACE.md:73`].

Text within the native cap keeps the existing call path and evidence fields.
Longer admitted text is split at rune boundaries and delivered in order under
one proposal, pending permit and public `input_applied` event. Each native call
must pass the existing window, action, focus, result and clock checks before the
next call starts. Control takeover, cancellation, binding loss, native errors or
invalid receipts stop the sequence; no success event or success evidence is
returned. A delivered prefix cannot be rolled back; the consumed proposal must
not be replayed automatically.

Successful long-text `InputEvidence` includes adapter-local `TextSequence.Chunks`, ordered by
delivery. Each entry contains the validated native receipt, rune count and SHA256
of the exact stdin bytes. The existing top-level evidence identifies the final
verified call; sequence evidence is returned only after every chunk succeeds.
This adapter-local evidence interface is [TARGET, unit decision]. The public
receipt keeps the final native receipt as an aggregate success witness, emitted
only after all calls verify. Per-chunk evidence is excluded from JSON because
`contracts/v0.2/action_receipt.schema.json:107` forbids extra native evidence
fields; the public contracts are unchanged.

The adapter never selects paste for agent text. The pinned contract describes
`input --paste` at line 73 without an explicit non-operator admission guarantee;
`paste-text` at lines 96–97 explicitly requires an operator login view [CITED:
OpenSuperficies `docs/CONTRACT_IDENTITY_SURFACE.md` at the pinned commit above].
No paste permission is inferred from either interface.

The runner's NAV-TEXTCAP chunking remains: its bounded proposals are compatible
with adapter chunking [TARGET, unit decision]. No runner changes are required.

This mandate is scoped to the supplied MetaViewer worktree and pinned
OpenSuperficies source corpus.

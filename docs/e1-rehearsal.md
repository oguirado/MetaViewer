Editor read-back uses `srf-identity-surface ax --text-of <row-id>` and its
`editable_text` evidence. The editor identity, role, name, box and focus must
still match; UTF-8 bytes and Unicode code-point lengths must agree with the
returned text and row, and truncation refuses. The injected text and length
come from that same response; polling may observe stale text before a later
matching read within the independent post-receipt read-back window. The owner
polls only stale content in that window, rechecking native evidence, focus,
frame and handoff on each sample. Wender otherwise rejects its first stale
slot sample with CHANGE_MISMATCH before any retry can occur. A failed native read refuses with
`MW_SLOT_LENGTH_TEXT_OF_UNAVAILABLE`; update srf-identity-surface to a build
from OpenSuperficies commit `6ca9da19a7d4ff1ed97fa3cba0abc94b571b5b50` or a
compatible descendant. Answer capture continues using `--text-container`.

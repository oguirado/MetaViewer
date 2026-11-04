# ARM64 capsule asset notices

Local setup admits operator-provided artifacts; it does not supply new rights to
distribute them. MetaViewer's source licence and the separate private-component
evaluation permission are stated in [NOTICE-EVALUATION.md](../NOTICE-EVALUATION.md).

## Recorded assets

The setup descriptor records exact local artifact identities and operator-supplied
licence, source and evidence fields. Those fields are assertions to review, not
proof that a binary is redistributable.

Answers: which assets must have provenance before local setup?

| Asset | Public admission requirement | What remains outside that check |
| --- | --- | --- |
| Engine, kernel, broker and BusyBox | Protected artifact paths and matching digests | Complete upstream provenance and rights for the exact binaries |
| VM image | Exact locally available image identity | Image contents, component notices and distribution rights |
| Native tools | Pinned protected executables | Private implementation and its separate licence |
| Browser/Program image recipes | Exact local image identity and declared source/licence/evidence | Permission to redistribute the image and all included components |

[CITED: `tools/arm64_capsules.py:139`, `tools/arm64_capsules.py:180`,
`tools/arm64_capsules.py:196`]. Configuration requires
`scope: "operator-provided-local-only"`, `operator_local_use_confirmed: true`
and `redistribute: false`. It checks that required evidence strings are present;
it does not authenticate their legal meaning [CITED:
`tools/arm64_capsules.py:196`].

Hashes previously reported for local builds are not a public artifact inventory.
Reproducible binaries and their complete source/notice bundles are
**ABSENT — do not invent** unless supplied separately with the evaluated package.

## Recorded Rewind broker build

The public manifest defines a separate Rewind broker binary behind the
`rewind-profile` feature. The manifest establishes source configuration, not a
verified correspondence with an unpublished local executable.

Answers: what can be checked about the Rewind broker from this source tree?

`daemon-adapter/guest-command-broker/Cargo.toml` declares the package licence as
`AGPL-3.0-only` and the `rewind-command-broker` entry point
[CITED: `daemon-adapter/guest-command-broker/Cargo.toml`]. Review that manifest,
its lockfile and `src/bin/rewind-command-broker.rs` together. A build receipt,
artifact digest and complete source correspondence are separate evidence.

## Broker dependency notices

The lockfile identifies dependency versions; it is not a complete licence
inventory for every byte of a built executable.

Answers: does the broker's package licence cover all linked content?

No such conclusion follows from its package licence. The manifest and
`Cargo.lock` are the public starting points [CITED:
`daemon-adapter/guest-command-broker/Cargo.toml`,
`daemon-adapter/guest-command-broker/Cargo.lock`]. Any assessment of a supplied
binary must use its actual build, dependencies and accompanying notices.
Previously retained private build records are not published evidence here.

## Before any future redistribution

Local configuration and judge evaluation must not be treated as a general
redistribution grant.

Answers: which permission does this repository actually provide?

Use [NOTICE-EVALUATION.md](../NOTICE-EVALUATION.md) for MetaViewer's licence and
the limited permission concerning supplied private components. Obtain and
review the actual licence and source materials for separately supplied guest
artifacts before making a distribution claim. Unknown provenance or rights
remain **ABSENT — do not invent**; setting a descriptor flag cannot resolve them.

This notice is limited to the public source declarations and admission checks
cited above. It supplies no binaries, private source or additional permission.

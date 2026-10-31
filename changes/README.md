# Changelog fragments

Each unit that changes product code adds one changelog fragment file at
`changes/unreleased/<slug>.md` instead of editing `CHANGELOG.md` directly. This
keeps parallel unit branches free of `CHANGELOG.md` merge conflicts.

## Fragment rules

- **Location and slug**: `changes/unreleased/<slug>.md`, where `<slug>` is
  lowercase ASCII matching `^[a-z0-9][a-z0-9-]*$` (one file per unit).
- **Encoding and format**: valid UTF-8, non-empty, containing one or more `- `
  bullet lines in the repository `CHANGELOG.md` style.
- **Line limit**: each bullet line is at most `1000` characters
  `[TARGET, unit decision: longest existing CHANGELOG.md bullet is 621 characters [MEASURED]]`
  and must obey law L1 (`LAWS.md`).

## Assembly

At integration or release, the conductor assembles all unreleased fragments into
`CHANGELOG.md` under `## [Unreleased]` (sorted by fragment file name, placed
after the existing top-level bullet lines) and deletes the consumed fragment
files:

```sh
python3 tools/changelog_assemble.py --dry-run
python3 tools/changelog_assemble.py
python3 tools/changelog_assemble.py --check
```

A second run of `python3 tools/changelog_assemble.py` is a no-op. `--check`
exits non-zero when any fragment is pending assembly or malformed.

## Enforcement and transition switch

`tools/check_laws.py` enforces that every product-code commit adds or updates a
fragment under `changes/unreleased/<slug>.md`. During the transition for
in-flight units, `ALLOW_DIRECT_CHANGELOG = True` in `tools/check_laws.py` (or
`MV_CHANGELOG_ALLOW_DIRECT=1`) continues to admit commits that edit
`CHANGELOG.md` directly. Flipping `ALLOW_DIRECT_CHANGELOG = False` (or setting
`MV_CHANGELOG_ALLOW_DIRECT=0`) requires a fragment for every product-code
commit.

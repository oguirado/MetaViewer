# Commit laws

`LAWS.md` is authoritative. Both author and committer must be exactly:

```text
oguirado <247666607+oguirado@users.noreply.github.com>
```

Messages must be English and imperative. The subject starts with `core:`,
`contracts:`, `ui:`, `ci:`, `docs:`, `deps:` or `tools:`, followed by a space and
an imperative verb. The subject is at most **72 characters** [CITED: task
requirements]. Example:

```text
contracts: add frame reference schema
```

The entire message, including its body, is checked case-insensitively for every
entry in `tools/check_laws.py:FORBIDDEN`. Co-author trailers, generation notices,
and model or assistant names are forbidden. Attribution to automated tools is
also forbidden in tags, release notes, changelog entries and files by L1;
product features may name their runtime dependencies without author attribution.

## Versions and tags

Per L2, `VERSION` is the source of semantic versioning, initially **0.1.0**
[CITED: VERSION]. Tags are `v<VERSION>`. Every tag requires a dated changelog
section with the exact version. An unreleased entry is acceptable before a tag;
replace `unreleased` with the actual release date before tagging. Component pins
belong in `deps.lock`; a commit changing a pin must use `deps:`.

Each unit that changes product code adds a changelog fragment at
`changes/unreleased/<slug>.md` (lowercase `[a-z0-9-]`, one file per unit)
containing one or more `- ` bullet lines in `CHANGELOG.md` style (see
`changes/README.md`). At integration or release, the conductor assembles all
fragments into `CHANGELOG.md` under `## [Unreleased]`, sorted by fragment file
name after the existing lines, and deletes the consumed fragments:

```sh
python3 tools/changelog_assemble.py --dry-run
python3 tools/changelog_assemble.py
python3 tools/changelog_assemble.py --check
```

`tools/check_laws.py` rejects product-code commits that add no fragment. During
the transition for in-flight units, `ALLOW_DIRECT_CHANGELOG = True` in
`tools/check_laws.py` (or `MV_CHANGELOG_ALLOW_DIRECT=1`) keeps direct
`CHANGELOG.md` edits valid until the conductor flips that switch to `False`.

## Enforcement

Install `.githooks/commit-msg` with `git config core.hooksPath .githooks`.
The hook validates the proposed message and checks the effective identities from
`git var GIT_AUTHOR_IDENT` and `git var GIT_COMMITTER_IDENT`, so environment
identity overrides are checked too.

CI checks the commits in the push or pull-request range, or all reachable
commits for an initial push or manual run. The version gate checks SemVer and
a matching changelog heading; contract and unit-test gates run separately.
The subject checker uses a documented, conservative imperative-verb vocabulary
(`VERBS`). It cannot prove arbitrary English grammar. Human review still
checks the rest of the message's language and intent. The current gates do not
automatically enforce tag dates, release-note attribution, branch fast-forward
policy or the `deps:`-only pin-change rule; these remain release/review gates.

## Repair a rejection

Read the named failure, edit the message and rerun
`python3 tools/check_laws.py --message-file <message-file>`. Use an allowed scope,
a supported imperative verb and a shorter subject; remove forbidden text from
the whole message. Set `git config user.name oguirado` and
`git config user.email 247666607+oguirado@users.noreply.github.com`; correct any
`GIT_AUTHOR_*` or `GIT_COMMITTER_*` environment overrides. The hook rejection
creates no commit. For an existing local commit, the maintainer must repair
both identities and message before rerunning its history range. Never rewrite
published history automatically. Fix VERSION/changelog mismatches together;
do not bypass checks.

# MetaViewer laws

These laws bind every contributor, human or automated. CI enforces the checkable ones (`tools/check_laws.py`).

## L1 Authorship
1. Every commit is authored and committed by the maintainer identity: `oguirado <247666607+oguirado@users.noreply.github.com>`.
2. No commit message, tag, release note, changelog entry or file in the repository names an AI model, assistant or tool as author or co-author. Forbidden in messages: `Co-Authored-By:` trailers, "Generated with", and model or assistant names (the list lives in `tools/check_laws.py`).
3. Commits are written in English, in the imperative, with a short scope prefix (`core:`, `contracts:`, `ui:`, `ci:`, `docs:`).

## L2 Versions
1. Semantic versioning, starting at `0.1.0`. `VERSION` is the single source; tags are `v<VERSION>`.
2. Every tag has a `CHANGELOG.md` section with the same version and its date.
3. Component versions (vision-engine, wender-agent, OpenSuperficies) are pinned in `deps.lock` by version and commit. A pin changes only in a commit whose message starts with `deps:`.

## L3 Contracts first
1. Components talk only through the versioned JSON contracts in `contracts/v<MAJOR.MINOR>/`. A new message type needs a schema before code that sends or reads it.
2. A breaking change to a schema needs a new contract version directory; old versions stay until no pin uses them.
3. Every schema has at least one valid and one invalid example under `contracts/examples/`, checked by CI.

## L4 CI
1. CI runs on every push and pull request: laws check, contract check, unit tests, and the build of each part present in the tree.
2. `main` only moves by fast-forward from a green branch. Nothing is pushed with a red gate.
3. Tests are never weakened to make CI pass: no skips, expected failures or broad exception handlers added for that purpose.

## L5 Privacy and secrets
1. No tokens, keys, cookies, browser profiles or personal paths in the repository. Surface profiles live outside the tree.
2. Recorded sessions used as fixtures are synthetic or scrubbed.

## L6 Pushes
The maintainer runs every `git push`, `gh repo create`, tag push and release. Automation prepares branches and commands; it never pushes.

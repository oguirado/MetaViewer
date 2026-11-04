# Pre-existing work declaration

The repository history distinguishes a pre-event scaffold from the later
MetaViewer application. External components are separate projects; their current
pins do not establish when work inside those projects was done.

## What is the current assembly and historical boundary?

Use [VERSION](../VERSION) for the current release and the historical commits
below for the earlier scaffold. This declaration does not decide event eligibility.

Answers: pre-existing work; current version; historical baseline; event eligibility

The current assembly includes the Rust core, Go daemon adapter, Python agent
adapters and Electron/Vue wall. Their source directories are [core](../core/),
[daemon-adapter](../daemon-adapter/), [agents](../agents/) and [ui](../ui/).
[CHANGELOG.md](../CHANGELOG.md) describes release changes.

The historical documentation baseline is release `0.1.1`
[CITED: git `ebc5546:VERSION`]. Inspect it without modifying the checkout:

```sh
git show --stat a01a420
git show --stat e06d627
git show ebc5546:VERSION
git ls-tree -r --name-only ebc5546 core ui agents daemon-adapter
```

## What did the initial repository contain?

The initial commit contained laws, contracts, checkers, tests, CI and design;
the application directories contained READMEs rather than runtime source.

Answers: initial scaffold; code present before the application; repository provenance

Commit `a01a420562af9d79f03411bba17a9fe8142af515`, dated `2026-10-22`
[CITED: git commit], introduced the following material:

| Area | Historical contents |
| --- | --- |
| Laws and release identity | `LAWS.md`, commit rules, `VERSION`, changelog and dependency declaration |
| Contracts | Closed schemas and synthetic valid/invalid examples |
| Verification | Schema and law checkers, their unit tests and CI configuration |
| Design | Architecture and roadmap documents |
| Runtime directories | `core/README.md`, `daemon-adapter/README.md`, `agents/README.md`, `ui/README.md` |

The checkers and tests were executable code. The narrower historical claim is
that the application runtime was absent from those directories at that commit.
[CITED: git `a01a420` tree]

## What design work preceded the application?

A later documentation commit added UI design, router notes and research material;
it did not add the application runtime.

Answers: pre-event design; research notes; documentation baseline

Commit `e06d627481e540ecb7786872e239fc94ae110959`, dated `2026-10-25`
[CITED: git commit], added the UI architecture, router bootstrap, research notes
and a draft demonstration script. Commit
`ebc554677d44b3202fb7596d913f27bdf3099f58` recorded the declaration and release
`0.1.1` [CITED: git commit and `ebc5546:VERSION`]. These are historical states;
current documents may have been rewritten since then.

Private planning records are not independently reviewable from this repository.
Their detailed chronology is **ABSENT — do not invent**. Public reported tool
usage is discussed in [META_AI_USAGE.md](../META_AI_USAGE.md), with its own
evidence limits.

## Which components existed outside this repository?

The private runtimes and the public capsule UI kit are separate projects consumed
by the assembly. Their source and licensing boundaries are unchanged by this
declaration.

Answers: external pre-existing components; private runtimes; integration pins

| Component | Current source of its integration identity | Public audit boundary |
| --- | --- | --- |
| `wender-agent` | [deps.lock](../deps.lock) | Separate private program |
| `vision-engine` | [deps.lock](../deps.lock) | Separate private program |
| `OpenSuperficies` | [deps.lock](../deps.lock) | Separate private program |
| `capsule-ui-kit` | [ui/kit.lock.json](../ui/kit.lock.json) | Separate public repository |

Current pins are integration identities. They do not establish that the pinned
revisions, or every change in them, predate the event. Public-source evidence for
the event-period history of the private components is **ABSENT — do not invent**.
Evaluation rights for supplied compiled components are defined only in
[NOTICE-EVALUATION.md](../NOTICE-EVALUATION.md).

## What was added to the application after the scaffold?

The subsequent history adds the authority core, daemon adapter, agent tools and
wall; the current source makes those implementations inspectable.

Answers: application implementation; work after the scaffold; built during the event

The following commands expose the additions and their commit dates without
relying on a retrospective count:

```sh
git log --reverse --format='%h %cs %s' -- core/src/lib.rs
git log --reverse --format='%h %cs %s' -- daemon-adapter/cmd/mv-daemon-adapter/main.go
git log --reverse --format='%h %cs %s' -- agents/metaviewer_agents/tools.py
git log --reverse --format='%h %cs %s' -- ui/src/App.vue
```

Commit dates and source history support this repository's chronology. They do
not prove a live acceptance pass, private-component chronology or compliance
with an external event's rules. See [EVIDENCE.md](EVIDENCE.md) for what is publicly
verifiable and [TESTING.md](TESTING.md) for reproduction commands.

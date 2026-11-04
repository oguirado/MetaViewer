# Context router bootstrap for the shared UI

The current repository reader is `route/route_query.py`. The earlier empty-repo
bootstrap plan is retired; it is not an installation procedure for MetaViewer.

## How do I find the source for a question?

Run the current router from the repository root, then read the returned source
or section. A ranked result is a coordinate, not proof of a claim.

Answers: repository search; current router; code coordinates

```sh
python3 route/route_query.py any "capsule control handoff"
python3 route/route_query.py check
```

The check must print `ROUTE_OK`. Follow a returned reference with
`python3 route/route_query.py show "<reference>"`. Empty or stale results require
investigation; they do not establish that a feature is absent. See
[route/README.md](../route/README.md) and [AGENTS.md](../AGENTS.md).

## Who updates documentation indexes?

The integration owner rebuilds indexes after the documentation changes land.
An individual documentation edit can leave the existing index stale.

Answers: stale documentation index; rebuild ownership; documentation digest

Use the commands and validation rules in [route/README.md](../route/README.md).
Keep an index failure visible rather than rewriting a receipt or weakening a
check. [TESTING.md](TESTING.md) distinguishes source checks from generated-index
checks.

## What remains of the earlier router kit?

The vendored kit remains under `router/kit/` for maintenance of its own format.
It is separate from the repository's current reader and requires its own inputs.
Do not paste the retired plan's placeholder paths as working commands.

Answers: legacy router kit; old bootstrap plan; kit command reference

These commands request each retained tool's usage text. Some kit parsers return
status `2` for usage [CITED: `tests/test_router_docs.py`, `HELP_ALLOWLIST`].
That behavior is not a successful index build. The documentation tests verify
these paths and reject missing tools.

```sh
python3 router/kit/tools/build_index_v2.py --help
python3 router/kit/tools/route_v2.py --help
python3 router/kit/v1_frozen/build_index.py --help
python3 router/kit/tools/make_pool_v2.py --help
python3 router/kit/tools/null_edges.py --help
python3 router/kit/tools/tune_v2.py --help
python3 router/kit/tools/eval_v2.py --help
python3 router/kit/tools/gates_v2.py --help
```

For historical decisions, inspect this file's Git history. Current entry points,
contracts and tests take precedence over the superseded plan.

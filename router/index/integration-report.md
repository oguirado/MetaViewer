# W0-ROUTER-INT execution report

STATUS DONE

Generated the protocol mount at `catalogue/router/` using the vendored builder.
Rebuilt `catalogue/nodes.jsonl` after staging only the delivered router unit surface.
The source universe remains `git ls-files --cached`; contract drops remain untracked
and unstaged. No source-code or entry-file changes were necessary. No dependency
installation, network operation, commit, push, tag, reset or checkout was performed.

Receipts live in `router/index/`, already excluded from the source universe by
`GENERATED_PREFIXES`; they cannot create a source-digest cycle. `SHA256SUMS` records
every file written by this unit except itself, including this report.

## Verification

| Gate | Result |
| --- | --- |
| Kit discovery | rc 0; 157 tests [MEASURED] |
| Router index check | rc 0; 148 tracked source files, full coverage [MEASURED] |
| Index unit suite | rc 0; 18 tests [MEASURED] |
| Published mount rebuild | rc 0; byte-identical |
| llms.txt | 89 tokens [MEASURED], cap 150 [TARGET] |
| AGENTS.md | 667 tokens [MEASURED], cap 1500 [TARGET] |
| catalogue/protocol.json | 74 tokens [MEASURED], cap 600 [TARGET] |
| Largest generated mount file | 22695 bytes [MEASURED] |

Token counts use installed tiktoken with o200k_base. Kit ResourceWarnings are
preexisting unclosed test handles; final discovery suppresses only ResourceWarning.
Printed negative-fixture failures are expected and the enclosing suite passes.

## Command ledger

Commands are relative to the assigned worktree. Inspection commands below are
listed in execution order; compound inspection calls have their tool-level rc.

| Command / tool operation | rc |
| --- | --- |
| Read newton-routing SKILL.md with cat | 0 |
| newton_resolver(router, mount, index, integration) | success; cierre vacio |
| git status --short; sed bootstrap 1-210; sed router_index 1-240 | 0 |
| newton resolver 'router index' | 0; unrelated shingle-index bundle rejected |
| rg definitions/build arguments; cat entry files; sed router_index 420-680 | 0 |
| sed entry contract and builder; rg params/entry/token files; sed nonexistent test_entry_tokens.py | 2; optional filename absent |
| python3 tools/router_index.py --check (baseline) | 1; stale nodes |
| python3 -m unittest discover -s router/kit/tests (baseline) | 1; missing mount |
| rg params/routes/token references; git status scoped; cat .gitignore; Python tiktoken probe | 0 |
| git add -- router catalogue llms.txt AGENTS.md tools/router_index.py tests/test_router_index.py | 0 |
| python3 tools/router_index.py | 0 |
| python3 router/kit/tools/build_index_v2.py --nodes catalogue/nodes.jsonl --out catalogue/router --thesaurus router/kit/standards/thesaurus.json --corpus metaviewer | 0 |
| git add -- catalogue/nodes.jsonl catalogue/router | 0 |
| PYTHONWARNINGS=ignore::ResourceWarning python3 -m unittest discover -s router/kit/tests | 0 |
| python3 tools/router_index.py --check | 0 |
| python3 -m unittest tests.test_router_index | 0 |
| python3 router/kit/tools/build_index_v2.py --nodes catalogue/nodes.jsonl --out catalogue/router --thesaurus router/kit/standards/thesaurus.json --corpus metaviewer --check | 0 |
| Inline Python: token caps, written-file SHA256, contract staging assertion, mount file size | 0 |

Polling operations returned the completion rc of their original command, rather
than executing additional shell commands. Report generation and final receipt
staging/checking are recorded in the final response.

## Open questions and limitations

Open questions: none for the assigned integration gates.

Qualified `catalogue/router/params.json`, `catalogue/routes.tsv` and the browse
chain: AUSENTE — no inventar. Entry status remains router unavailable; these
passing integration gates do not establish production routing quality or complete
Step C/D publication qualification. No foreign fitted parameters were copied.

This mandate is scoped to the supplied repository corpus and unit surface.

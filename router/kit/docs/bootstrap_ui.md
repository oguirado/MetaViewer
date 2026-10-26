# Router kit bootstrap companion

Fixture-only bootstrap evidence for the vendored paper router kit. This kit
makes no application routing quality claim; `application_qualification` in
the receipt is always BLOCKED.

## Layout

- `tools/`: 13 vendored stdlib tools plus `bootstrap_kit.py` (harness).
- `standards/`: grid, thesaurus, justification, and 7 closed schemas.
- `tests/`: 11 portable suites (`T0`-`T3`, `T5`-`T11`, no T4), the bootstrap
  contract suite, the ENTRY cross-unit suite, and fixtures.
- `v1_frozen/`: frozen v1 baseline plus `SHA256SUMS`.
- `gate.sh`, `vendor_manifest.json`, `bootstrap_receipt.json`, `logs/`.

## Tool interfaces (vendored, preserved)

- `build_index_v2.py --root R --out O [--thesaurus T] [--nodes N]
  [--corpus C] [--cap N] [--check]`; `--check` prints `byte-identical`.
- `route_v2.py --q Q --index I [--params P] [--intent I] [--k K]
  [--budget B] [--corpus NAME=PATH[:PRI]] [--log D] [--agent A]
  [--no-abstain] [--verify ROOT]`; defaults `k=20`, `BUDGET=2000`.
- `gates_v2.py --all --root R --index I --dev D --out O [--params P]
  [--thesaurus T]`; no per-gate selector; emits `ctx.gates.v1`.
- `eval_v2.py`: `--bench/--split/--index/--v1-index/--params/--systems/
  --out/--freeze`; refuses a second TEST run once `run_TEST.lock` exists.
- `tune_v2.py`: `--index/--bench` required; DEV only, never `/bench/`/TEST.
- Library: `jsonschema_lite.validate(v, s, path="$")`,
  `blocks.blocks_from_text/read_raw/read_blocks/anchors/block_bytes`.

## Harness interface (new)

`python3 -B tools/bootstrap_kit.py` takes exactly one mode:

- `--run [--deny-list FILE]`: verify inventory, run the 12 registered
  suites (60 s each), run the 1-byte mutant oracle, scan privacy, write
  `logs/` and `bootstrap_receipt.json`. Exit 0 PASS, 2 BLOCKED (privacy
  input missing, everything else green), 1 FAIL.
- `--check [--deny-list FILE] [--root DIR]`: inventory plus receipt plus
  privacy validation; needs a prior `--run`. Same exit codes.
- `--self-test`: isolated negative controls (inventory/runner/receipt/
  privacy/schema mutants); exit 0 only on genuine rejections.

`gate.sh` runs `--run` bounded at 900 s, passing `MV_ROUTER_DENY_LIST`
when set. A missing expected test FAILS; nothing is skipped. `--run`
removes regenerable `__pycache__/*.pyc` before and after the suites
(upstream `-I` gate children emit them despite `PYTHONDONTWRITEBYTECODE`).

Cross-unit ENTRY check (separate command, cwd `router/kit`):

`timeout 60 python3 -B -m unittest discover -s tests -p
test_entry_contract.py`

Exit 0 is real integration PASS; otherwise the output says BLOCKED
(prerequisite absent) or FAIL (semantic violation).

## Manifest (closed rule)

`vendor_manifest.json` maps every shipped immutable file (kit-relative) to
its full SHA-256. Excluded, by rule, are only `vendor_manifest.json`,
`bootstrap_receipt.json`, and the `logs/` and `tmp/` subtrees. Unknown
files, symlinks, traversal entries, duplicate keys, and non-64-hex digests
are all refused. Regenerate after a reviewed change with:

`python3 -B -c` over the tree applying the exclusion rule, sorted keys,
`json.dumps(..., sort_keys=True, indent=1)` plus trailing newline.

## Receipt (evidence, not qualification)

Schema `metaviewer.router-kit-bootstrap.v1`: fixture-only `scope`, `status`,
source and manifest digests, interpreter version/platform, 15 gates (each
with exact `command`, repo-relative `cwd`, `rc`, relative `log` plus
`log_sha256`, `input/instrument/fixture_sha256`, non-empty `assertions`,
`outcome`), `vendor_mutant_rejected`, and BLOCKED application
qualification. No timestamps, PIDs, host paths, or secrets; the deny-list
path is withheld and bound by digest only.

## Known BLOCKED qualifications

Application benchmark/calibration (no `W0-BENCH`, no DEV/TEST split, no
fitted params), generated `catalogue/router/**` artifacts (owner unassigned),
real privacy list (external), and any multi-mount application use (D10).

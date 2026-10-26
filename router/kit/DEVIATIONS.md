# Router kit deviations (W0-ROUTER-KIT)

Source: `Holdings-int/router/kit/vendor_manifest.json`, SHA-256
`21801113d82bbe137695b59424ac90a0f15374b95ad4aa45ca10953756a3be81`
(65 entries, all verified before copying). 59 files are byte-identical;
6 are adapted below. The canonical P1 source identity, licence, and notice
files are ABSENT: review and enumerate them before any publish step.

## Portability adaptations (destination-authored)

- `tests/common.py`: removed the hardcoded pilot checkout path `REPO`.
  Every test builds its repository fixture in scratch.
- `tests/test_T0_freeze.py`: removed the external `V1` checkout comparison
  and the `out/v1_index` skip. Frozen bytes are pinned by hash (cross-checked
  against `v1_frozen/SHA256SUMS`); the v1 index is rebuilt twice from a
  generated scratch fixture and `--check` must print `byte-identical`. Added
  a corruption negative (`MISMATCH` rc 5) and a missing-input negative (rc 3).
- `tests/test_T1_blocks.py`: replaced the foreign `out/census.json` receipt
  test (skip + pilot counts) with a receipt generated from a scratch fixture
  (`n_synth=2`) with hardcoded independent expectations, plus determinism and
  malformed-block negatives. No skips remain.
- `tests/test_T6_eval.py`: two tests failed identically upstream (rc 3)
  because eval defaults resolve `--index`/`--v1-index` to the absent
  `out/` area. The v2 and v1 indexes are now built from a generated
  scratch fixture and passed explicitly; all original assertions kept.

## Privacy scrub adaptations (conductor-ordered, kept per JUDGE W0 F6)

- `tools/gates_v2.py`: one operator-username alternative was removed from
  the `PRIV` matcher. Matching of home paths, mail addresses, secrets and
  tokens is unchanged; no matcher behaviour relied on the removed literal.
- `tests/fixtures/gates/privacy_path.txt`: the operator home path became
  a synthetic `/home/someone/` path. The fixture still exercises one path
  match and one mail match.

## Excluded from the source tree (later Step E units)

Not vendored: `extract_vue/js/rust/css/ui`, `resolve_ui`, `gates_ui_entry`,
`router_web`, `bootstrap_ui` tools, their 9 tests, and the `out/`/`tmp/`
working areas. No `test_T4*.py` exists upstream; none is claimed.

## Kept upstream defects (copied pattern, documented defect)

- D10: fixture multi-mount code truncates merged IDs; application use stays
  single-corpus until a collision-checked inverse map exists.
- `read_nodes` performs no schema validation; validate nodes before build.
- `g_privacy` skips absent paths and echoes matches; the new external-list
  gate requires real input and redacts tokens.
- `jsonschema_lite` `maxLength` counts characters, not UTF-8 bytes; the byte
  limit is enforced by `gates_v2.check_answer` (T9 MF-B fixture).
- `route_v2.decide` returns `uncalibrated` with abstain flag false: it is
  neither a refusal nor a fitted success. Omitting `--params` yields it.
- `build_index_v2 --check` writes a sibling `.chk` directory: use writable
  staging, never a read-only tree.
- Route freshness rejection needs explicit `--verify ROOT` (rc 5, `E_STALE`).
- `gates_v2.PRIV` embeds username/token detection patterns; they are matcher
  data, not leaked secrets.
- `eval_v2` default index/params/v1 paths point at `out/` (paper-oriented);
  fixture tests always pass explicit scratch paths.
- `g_determinism`/`g_blind` spawn `-I` children that ignore
  `PYTHONDONTWRITEBYTECODE` and emit `__pycache__/*.pyc` into the tree.
  `--run` removes regenerable bytecode before and after the suites; `.pyc`
  files are never shipped and the manifest refuses them as unknown files.

Deviation identifiers D15/D16/D23/D24 are not defined in any opened source;
no audit of them is claimed.

## Harness conventions (new code, not upstream)

- Recorded argv is the executed argv. `argv0` is bare `python3` (vendored
  receipt convention); `--run`/`--self-test` refuse to start unless it
  resolves to the harness interpreter version.
- Deny-list and mutant scratch paths are withheld by design (`<withheld>`,
  `<scratch>`); contents are bound by `input_sha256` digests.
- The mutant oracle flips 1 byte of `tools/blocks.py` in a scratch copy and
  requires a naming rejection; restored bytes must verify clean. This is
  integrity evidence, not semantic mutation coverage.
- The committed receipt was produced with a synthetic deny list (digest in
  the privacy gate `input_sha256`). CI must re-run with the unpublished list;
  `application_qualification` stays BLOCKED regardless.

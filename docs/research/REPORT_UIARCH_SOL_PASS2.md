STATUS: DONE

Pass-two research edits complete; release/integration qualification remains conditional. All rc values below are [MEASURED]; negative rc 1 means the intended document mutant was rejected. No product/runtime PASS is claimed.

Commands use the private research workdir; K=`scratch/pass2/kit_smoke`. Full argv/logs: `scratch/pass2/commands.json`, K/bootstrap_receipt.json. C=`python3 -B scratch/pass2/check_closures.py` (command abbreviation).

| Gate command | rc |
|---|---|
| `python3 -B scratch/check_documents.py` | 0 |
| `python3 -B scratch/pass2/check_closures.py` | 0 |
| `C --item G0a` / same `--negative` | 0 / 1 |
| `C --item G0b` / same `--negative` | 0 / 1 |
| `C --item G1` / same `--negative` | 0 / 1 |
| `C --item G2` / same `--negative` | 0 / 1 |
| `C --item G3` / same `--negative` | 0 / 1 |
| `C --item G4` / same `--negative` | 0 / 1 |
| `C --item G5` / same `--negative` | 0 / 1 |
| `C --item G6` / same `--negative` | 0 / 1 |
| `python3 -B scratch/pass2/bootstrap_router.py --dest "$PWD/$K"` (new empty destination) | 0 |
| In K: `python3 -B -m unittest discover -s tests -p test_T2_build.py` | 0 |
| In K: same command, `test_T3_route.py` | 0 |
| In K: same command, `test_T9_gates.py` | 0 |
| In K: same command, `test_T10_multimount.py` | 0 |
| In K: same command, `test_T11_logging.py` | 0 |
| In K: `python3 -B tools/build_index_v2.py --nodes tests/fixtures/mounts/sw/nodes.jsonl --out out/smoke --corpus ui --thesaurus tests/fixtures/thesaurus_empty.json` | 0 |
| In K: same build command with `--check` | 0 |
| `python3 -B scratch/check_reports.py` | 0 |

| Item | Closing section / positive and negative evidence |
|---|---|
| G0a | UI §2: exact PINS versions/MIT/SRI and age rule; CI installed-tree/licence gate [TARGET]; changed SRI rejected |
| G0b | Router Step A/E, §10: executable kit copy/tests/build; language extractors and all gaps assigned W0 owners; missing Rust owner rejected |
| G1 | UI §11: all required screen/capability rows; removed saves row rejected |
| G2 | UI §7: request_id derivation, envelope durable dedup and effect lookup; random-id mutation rejected |
| G3 | UI §7: per-slot lock, advertised queue exception, GUI/headless single consumer; parallel mutation rejected |
| G4 | UI §7: only ready/waiting-input eligible; allow-all mutation rejected |
| G5 | UI §6: three focus layers/retries/veil/default prevention; click-only mutation rejected |
| G6 | UI §11: source-derived h3-nav/b5 vocabulary, saves panel identity; invented route rejected |

| Criterion | Self-check (design/research scope) |
|---|---|
| 1 | PASS: UI §1 operator matrix retained |
| 2 | PASS: Rust authority, closed IPC, no Electron injection/eval retained |
| 3 | PASS: citations/TARGET/unknowns and log updated |
| 4 | CONDITIONAL: exact metadata recorded; maintainer must reconcile Dockview conflict |
| 5 | PASS: lifecycle/dispatch guards and small writer units |
| 6 | PASS: ids/roles/names/boxes and complete geometry-free digest |
| 7 | W0 PLAN: empty-destination fixture bootstrap passes; application extraction/resolution/calibration remain owned work |
| 8 | PASS: real route/query/control mapping and batteries |
| 9 | PASS: closed player console; authorized developer/MetaViewer shell only |
| 10 | PASS: risk owners and closure evidence retained |

Open: Dockview 8.6.1 requirement versus PINS 8.4.1; exact shipped licences/cache/install provenance; W0 router application integration and UI DEV/blind TEST; existing popout/frame/agent-producer/IPC contracts and platform qualification. None is represented as implemented. No canonical paper TEST rerun, network, repository code edits or git operation.

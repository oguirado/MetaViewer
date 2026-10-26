#!/usr/bin/env python3
"""MetaViewer router-kit bootstrap harness (W0-ROUTER-KIT).

Verifies the vendored kit inventory, runs the portable fixture suites, and
emits execution evidence. Stdlib only. Never imports a vendored helper
before the manifest verifies; all checks read bytes and hashes.
"""
import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

SCHEMA = "metaviewer.router-kit-bootstrap.v1"
SOURCE_MANIFEST_SHA256 = "21801113d82bbe137695b59424ac90a0f15374b95ad4aa45ca10953756a3be81"
SOURCE_DESCR = "Holdings-int router/kit vendor_manifest.json (65 entries, portable subset)"

# Byte-identical vendored files (kit-relative). The four adapted files
# (tests/common.py, test_T0_freeze.py, test_T1_blocks.py, test_T6_eval.py)
# are destination-authored and covered by the destination manifest instead.
VENDOR_SET = (
    "standards/grid.json",
    "standards/schemas/ctx.bench-run.v2.schema.json",
    "standards/schemas/ctx.index-manifest.v2.schema.json",
    "standards/schemas/ctx.node.v2.schema.json",
    "standards/schemas/ctx.protocol.v2.schema.json",
    "standards/schemas/ctx.router-params.v2.schema.json",
    "standards/schemas/ctx.shortlist.v2.schema.json",
    "standards/schemas/ctx.thesaurus.v1.schema.json",
    "standards/thesaurus.json",
    "standards/thesaurus_dev_justification.json",
    "tests/fixtures/gates/answer_2001.json",
    "tests/fixtures/gates/answer_mb_anchor.json",
    "tests/fixtures/gates/dev_no_unanswerable.jsonl",
    "tests/fixtures/gates/entry_timestamp.txt",
    "tests/fixtures/gates/float.json",
    "tests/fixtures/gates/privacy_path.txt",
    "tests/fixtures/gates/thesaurus_pm.json",
    "tests/fixtures/mounts/gen.py",
    "tests/fixtures/mounts/sw/nodes.jsonl",
    "tests/fixtures/mounts/vg/nodes.jsonl",
    "tests/fixtures/precedence/cases.json",
    "tests/fixtures/repo3/catalogue/families/PM-001.json",
    "tests/fixtures/repo3/catalogue/families/PM-002.json",
    "tests/fixtures/repo3/catalogue/families/PM-003.json",
    "tests/fixtures/repo3/catalogue/routes.tsv",
    "tests/fixtures/repo3/catalogue/subjects.json",
    "tests/fixtures/repo3/catalogue/subjects/1/pages/p001.jsonl",
    "tests/fixtures/repo3/catalogue/subjects/2/pages/p001.jsonl",
    "tests/fixtures/repo3/papers/EN-0000_PM-001.1.md",
    "tests/fixtures/repo3/papers/EN-0001_PM-001.2.md",
    "tests/fixtures/repo3/papers/EN-0002_PM-002.1.md",
    "tests/fixtures/repo3/papers/EN-0003_PM-003.1.md",
    "tests/fixtures/repo_gen.py",
    "tests/fixtures/thesaurus_empty.json",
    "tests/test_T10_multimount.py",
    "tests/test_T11_logging.py",
    "tests/test_T2_build.py",
    "tests/test_T3_route.py",
    "tests/test_T5_pool.py",
    "tests/test_T7_null.py",
    "tests/test_T8_tune.py",
    "tests/test_T9_gates.py",
    "tools/blocks.py",
    "tools/build_index_v2.py",
    "tools/census.py",
    "tools/dev_overlap_check.py",
    "tools/eval_v2.py",
    "tools/gates_v2.py",
    "tools/jsonschema_lite.py",
    "tools/make_pool_v2.py",
    "tools/merge_logs.py",
    "tools/null_edges.py",
    "tools/route_v2.py",
    "tools/thes_check.py",
    "tools/tune_v2.py",
    "v1_frozen/SHA256SUMS",
    "v1_frozen/build_index.py",
    "v1_frozen/eval_route.py",
    "v1_frozen/make_pool.py",
    "v1_frozen/route.py",
    "v1_frozen/vocabulary.json",
)

EXPECTED_SUITES = (
    "test_T0_freeze.py",
    "test_T1_blocks.py",
    "test_T2_build.py",
    "test_T3_route.py",
    "test_T5_pool.py",
    "test_T6_eval.py",
    "test_T7_null.py",
    "test_T8_tune.py",
    "test_T9_gates.py",
    "test_T10_multimount.py",
    "test_T11_logging.py",
    "test_bootstrap_contract.py",
)

GATE_INVENTORY = "inventory"
GATE_MUTANT = "mutant_vendor_helper"
GATE_PRIVACY = "privacy_denylist"

EXCLUDE_FILES = ("vendor_manifest.json", "bootstrap_receipt.json")
EXCLUDE_DIRS = ("logs", "tmp")
SUITE_TIMEOUT_S = 60
SELFTEST_TIMEOUT_S = 120
HEX64 = re.compile(r"^[0-9a-f]{64}$")
MUTANT_VICTIM = "tools/blocks.py"
WITHHELD = "<withheld>"
SCRATCH = "<scratch>"


class HarnessError(Exception):
    def __init__(self, code, detail=""):
        super().__init__("%s %s" % (code, detail))
        self.code = code
        self.detail = detail


def kit_root():
    return Path(__file__).resolve().parent.parent


def clean_bytecode(root):
    """Remove regenerable bytecode caches under root. Returns a count.

    Upstream gates spawn -I children, which ignore PYTHONDONTWRITEBYTECODE
    and emit __pycache__/*.pyc into the tree. Only bytecode is removed;
    every source byte is left untouched.
    """
    root = Path(root)
    n = 0
    for dirpath, dirnames, filenames in os.walk(root):
        if "__pycache__" in dirnames:
            shutil.rmtree(os.path.join(dirpath, "__pycache__"), ignore_errors=True)
            dirnames.remove("__pycache__")
            n += 1
        for fn in filenames:
            if fn.endswith((".pyc", ".pyo")):
                try:
                    os.remove(os.path.join(dirpath, fn))
                    n += 1
                except OSError:
                    pass
    return n


def sha_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(65536), b""):
            h.update(b)
    return h.hexdigest()


def load_json_strict(path):
    raw = Path(path).read_bytes()

    def hook(pairs):
        out = {}
        for k, v in pairs:
            if k in out:
                raise HarnessError("E_DUP_KEY", "%s: %r" % (path, k))
            out[k] = v
        return out

    try:
        text = raw.decode("utf-8")
    except ValueError:
        raise HarnessError("E_NOT_UTF8", str(path))
    try:
        return json.loads(text, object_pairs_hook=hook)
    except HarnessError:
        raise
    except ValueError as e:
        raise HarnessError("E_BAD_JSON", "%s: %s" % (path, e))


def _rel_ok(rel):
    return bool(rel) and not rel.startswith("/") and ".." not in Path(rel).parts and "\\" not in rel


def verify_manifest(root, manifest):
    """Check a kit tree against its manifest. Returns a list of errors."""
    root = Path(root)
    errs = []
    if not isinstance(manifest, dict):
        return ["manifest is not an object"]
    seen = set()
    for rel, digest in manifest.items():
        if not isinstance(rel, str) or not _rel_ok(rel):
            errs.append("bad entry name: %r" % (rel,))
            continue
        if rel in seen:
            errs.append("duplicate entry: %s" % rel)
            continue
        seen.add(rel)
        parts = Path(rel).parts
        if rel in EXCLUDE_FILES or parts[0] in EXCLUDE_DIRS:
            errs.append("excluded path in manifest: %s" % rel)
            continue
        if not isinstance(digest, str) or not HEX64.match(digest):
            errs.append("bad digest for %s" % rel)
            continue
        p = root / rel
        if p.is_symlink() or not p.is_file():
            errs.append("missing or not a regular file: %s" % rel)
        elif sha_file(p) != digest:
            errs.append("hash mismatch: %s" % rel)
    disk = set()
    for dirpath, dirnames, filenames in os.walk(root):
        rel_dir = Path(dirpath).relative_to(root).as_posix()
        if rel_dir != "." and (rel_dir in EXCLUDE_FILES or rel_dir.split("/")[0] in EXCLUDE_DIRS):
            dirnames[:] = []
            continue
        dirnames[:] = [d for d in dirnames if not (Path(dirpath) / d).is_symlink()]
        for fn in filenames:
            p = Path(dirpath) / fn
            rel = p.relative_to(root).as_posix()
            parts = Path(rel).parts
            if rel in EXCLUDE_FILES or parts[0] in EXCLUDE_DIRS:
                continue
            if p.is_symlink():
                errs.append("symlink refused: %s" % rel)
                continue
            disk.add(rel)
    for rel in sorted(disk - seen):
        errs.append("unknown file not in manifest: %s" % rel)
    return errs


def vendor(source, destination, source_manifest_sha256):
    """Copy the pinned portable set into an absent destination."""
    source, destination = Path(source), Path(destination)
    man_path = source / "vendor_manifest.json"
    if not man_path.is_file() or man_path.is_symlink():
        raise HarnessError("E_SOURCE_MANIFEST", "missing vendor_manifest.json")
    if sha_file(man_path) != source_manifest_sha256:
        raise HarnessError("E_SOURCE_PIN", "source manifest digest mismatch")
    sm = load_json_strict(man_path)
    if not isinstance(sm, dict):
        raise HarnessError("E_SOURCE_MANIFEST", "not an object")
    missing = [k for k in VENDOR_SET if k not in sm]
    if missing:
        raise HarnessError("E_SOURCE_SET", "absent from source manifest: %s" % missing[0])
    if os.path.lexists(destination):
        raise HarnessError("E_DEST_EXISTS", str(destination))
    out = {}
    try:
        for rel in VENDOR_SET:
            want = sm[rel]
            if not isinstance(want, str) or not HEX64.match(want):
                raise HarnessError("E_SOURCE_DIGEST", rel)
            src = source / rel
            if src.is_symlink() or not src.is_file():
                raise HarnessError("E_SOURCE_FILE", rel)
            data = src.read_bytes()
            if hashlib.sha256(data).hexdigest() != want:
                raise HarnessError("E_SOURCE_HASH", rel)
            dst = destination / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            if os.path.lexists(dst):
                raise HarnessError("E_DEST_COLLISION", rel)
            dst.write_bytes(data)
            out[rel] = want
    except HarnessError:
        shutil.rmtree(destination, ignore_errors=True)
        raise
    return out


def run_gate(argv, cwd, log, timeout_s):
    """Run one gate subprocess; rc None means the timeout fired."""
    log = Path(log)
    log.parent.mkdir(parents=True, exist_ok=True)
    try:
        r = subprocess.run(argv, cwd=str(cwd), capture_output=True, timeout=timeout_s)
        rc, timed_out = r.returncode, False
        blob = (r.stdout or b"") + (r.stderr or b"")
    except subprocess.TimeoutExpired as e:
        rc, timed_out = None, True
        blob = ((e.stdout or b"") if e.stdout else b"") + ((e.stderr or b"") if e.stderr else b"")
        blob += ("\nTIMEOUT after %ds\n" % timeout_s).encode()
    text = blob.decode("utf-8", errors="replace").replace(str(cwd), ".")
    log.write_text(text, encoding="utf-8", newline="\n")
    return {"rc": rc, "timed_out": timed_out, "log": str(log)}


def _parse_unittest(text):
    m = re.search(r"^Ran (\d+) tests? in ", text, re.M)
    ran = int(m.group(1)) if m else None
    failed = "FAILED" in text
    skipped = re.search(r"\(skipped=\d+", text) is not None
    ok = (not failed) and text.rstrip().endswith("OK") and not skipped
    return ran, ok, failed, skipped


def fixture_digest(manifest):
    lines = sorted("%s:%s" % (k, manifest[k]) for k in manifest if k.startswith("tests/fixtures/"))
    return hashlib.sha256(("\n".join(lines) + "\n").encode()).hexdigest()


def run_suites(root, suites, logs_dir, manifest_sha, fixture_sha, timeout_s=SUITE_TIMEOUT_S):
    """Run unittest suites; a missing or empty suite FAILS, never skips."""
    root, logs_dir = Path(root), Path(logs_dir)
    gates = []
    for t in suites:
        gid = "suite:%s" % t
        cmd = ["python3", "-B", "-m", "unittest", "discover", "-s", "tests", "-p", t]
        log = logs_dir / ("suite_%s.log" % t)
        tool = root / "tests" / t
        if not tool.is_file() or tool.is_symlink():
            log.parent.mkdir(parents=True, exist_ok=True)
            log.write_text("MISSING expected test file: tests/%s\n" % t, encoding="utf-8")
            gates.append({"id": gid, "command": cmd, "cwd": "router/kit", "rc": None, "log": log.name,
                          "log_sha256": sha_file(log), "input_sha256": manifest_sha,
                          "instrument_sha256": None, "fixture_sha256": fixture_sha,
                          "assertions": ["expected test file is present"], "outcome": "FAIL"})
            print("FAIL " + gid, flush=True)
            continue
        res = run_gate(cmd, root, log, timeout_s)
        text = log.read_text(encoding="utf-8", errors="replace")
        ran, ok, failed, skipped = _parse_unittest(text)
        if res["rc"] == 0 and ok and ran:
            outcome: str = "PASS"
            assertions = ["ran %d tests" % ran, "unittest OK"]
        else:
            outcome = "FAIL"
            assertions = ["rc 0 with passing tests"]
            if res["timed_out"]:
                assertions.append("observed: timeout")
            elif res["rc"] != 0:
                assertions.append("observed: rc %s" % res["rc"])
            if ran == 0 or ran is None:
                assertions.append("observed: empty discovery")
            if skipped:
                assertions.append("observed: required skip")
            if failed:
                assertions.append("observed: unittest FAILED")
        gates.append({"id": gid, "command": cmd, "cwd": "router/kit", "rc": res["rc"], "log": log.name,
                      "log_sha256": sha_file(log), "input_sha256": manifest_sha,
                      "instrument_sha256": sha_file(tool), "fixture_sha256": fixture_sha,
                      "assertions": assertions, "outcome": outcome})
        print(("PASS " if outcome == "PASS" else "FAIL ") + gid, flush=True)
    return gates


def load_deny_list(path):
    """Read an external deny list; (literals, sha) or raise HarnessError."""
    p = Path(path)
    if not p.is_file() or p.is_symlink():
        raise HarnessError("E_DENY_LIST", "unreadable deny list")
    raw = p.read_bytes()
    if len(raw) > 1_000_000:
        raise HarnessError("E_DENY_LIST", "deny list too large")
    try:
        text = raw.decode("utf-8")
    except ValueError:
        raise HarnessError("E_DENY_LIST", "deny list is not UTF-8")
    lits = [l for l in (x.strip() for x in text.split("\n")) if l and not l.startswith("#")]
    if not lits or len(lits) > 10_000:
        raise HarnessError("E_DENY_LIST", "deny list has no usable literals")
    if any(len(l) < 8 for l in lits):
        raise HarnessError("E_DENY_LIST", "deny list literal too short")
    return lits, hashlib.sha256(raw).hexdigest()


def run_privacy(root, manifest, deny_path, log_path, self_sha, run_cmd):
    """Scan immutable files for deny-listed literals. Never echoes a token."""
    root = Path(root)
    log_path = Path(log_path)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = list(run_cmd)
    if deny_path is None:
        log_path.write_text("BLOCKED: no deny list supplied (expected MV_ROUTER_DENY_LIST)\n", encoding="utf-8")
        return {"id": GATE_PRIVACY, "command": cmd, "cwd": "router/kit", "rc": None, "log": log_path.name,
                "log_sha256": sha_file(log_path), "input_sha256": None,
                "instrument_sha256": self_sha, "fixture_sha256": None,
                "assertions": ["external deny list is supplied"], "outcome": "BLOCKED"}
    try:
        lits, list_sha = load_deny_list(deny_path)
    except HarnessError as e:
        log_path.write_text("BLOCKED: %s\n" % e.code, encoding="utf-8")
        return {"id": GATE_PRIVACY, "command": cmd, "cwd": "router/kit", "rc": None, "log": log_path.name,
                "log_sha256": sha_file(log_path), "input_sha256": None,
                "instrument_sha256": self_sha, "fixture_sha256": None,
                "assertions": ["deny list is non-empty and well-formed"], "outcome": "BLOCKED"}
    needles = [(l, hashlib.sha256(l.encode()).hexdigest()[:16]) for l in lits]
    hits, scanned = [], 0
    for rel in sorted(manifest):
        data = (root / rel).read_bytes()
        scanned += 1
        for lit, tag in needles:
            idx = data.find(lit.encode())
            if idx >= 0:
                lineno = data.count(b"\n", 0, idx) + 1
                hits.append("%s:%d listed-token sha16 %s" % (rel, lineno, tag))
                break
    lines = ["scanned %d files against %d literals (digest %s)" % (scanned, len(needles), list_sha[:16])]
    if hits:
        lines += ["MATCH " + h for h in hits]
        outcome: str = "FAIL"
        assertions = ["zero deny-listed literals in immutable files", "observed: %d matches" % len(hits)]
        rc = 1
    else:
        lines.append("0 matches")
        outcome = "PASS"
        assertions = ["%d files scanned" % scanned, "%d literals checked" % len(needles), "0 matches"]
        rc = 0
    log_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(("%s " % ("PASS" if outcome == "PASS" else "FAIL")) + GATE_PRIVACY, flush=True)
    return {"id": GATE_PRIVACY, "command": cmd, "cwd": "router/kit", "rc": rc, "log": log_path.name,
            "log_sha256": sha_file(log_path), "input_sha256": list_sha,
            "instrument_sha256": self_sha, "fixture_sha256": None,
            "assertions": assertions, "outcome": outcome}


def run_mutant(root, logs_dir, self_sha, manifest, manifest_sha, deny_path):
    """Flip one byte in a scratch copy: --check must reject it by name."""
    root = Path(root)
    log_path = Path(logs_dir) / "mutant_vendor_helper.log"
    cmd = ["python3", "-B", "tools/bootstrap_kit.py", "--check", "--root", SCRATCH]
    if deny_path:
        cmd += ["--deny-list", WITHHELD]
    gate = {"id": GATE_MUTANT, "command": cmd, "cwd": SCRATCH, "rc": None, "log": log_path.name,
            "log_sha256": "", "input_sha256": manifest_sha,
            "instrument_sha256": self_sha, "fixture_sha256": None,
            "assertions": ["mutated helper is rejected by hash before execution"], "outcome": "FAIL"}
    scratch = Path(tempfile.mkdtemp(prefix="kitmut"))
    try:
        for rel in sorted(manifest):
            dst = scratch / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(root / rel, dst)
        shutil.copyfile(root / "vendor_manifest.json", scratch / "vendor_manifest.json")
        victim = scratch / MUTANT_VICTIM
        with open(victim, "r+b") as f:
            b = f.read(1)
            f.seek(0)
            f.write(bytes([(b[0] + 1) % 256]))
        dl_args = ["--deny-list", str(deny_path)] if deny_path else []
        # Executed argv equals the recorded one modulo the two documented
        # redactions (ephemeral scratch path, withheld list path). The
        # scratch tree carries its own copied harness, so cwd is scratch.
        r1 = subprocess.run(["python3", "-B", "tools/bootstrap_kit.py", "--check", "--root", "."] + dl_args,
                            cwd=str(scratch), capture_output=True, timeout=SUITE_TIMEOUT_S)
        t1 = ((r1.stdout or b"") + (r1.stderr or b"")).decode("utf-8", errors="replace")
        t1 = t1.replace(str(scratch), SCRATCH).replace(str(root), ".")
        if deny_path:
            t1 = t1.replace(str(deny_path), WITHHELD)
        shutil.copyfile(root / MUTANT_VICTIM, victim)
        restored_errs = verify_manifest(scratch, manifest)
        log_path.write_text("--- mutated run (expect rejection) ---\nrc=%s\n%s\n--- restored bytes (expect clean) ---\n%s\n"
                            % (r1.returncode, t1, "clean" if not restored_errs else "\n".join(restored_errs)),
                            encoding="utf-8")
        gate["log_sha256"] = sha_file(log_path)
        gate["rc"] = r1.returncode
        named = MUTANT_VICTIM in t1
        if r1.returncode != 0 and named and not restored_errs:
            gate["outcome"] = "PASS"
            gate["assertions"] = ["clean baseline passes inventory",
                                  "mutated %s rejected before execution" % MUTANT_VICTIM,
                                  "restored bytes verify clean"]
        else:
            gate["assertions"] = ["mutated helper is rejected by hash before execution"]
            if r1.returncode == 0:
                gate["assertions"].append("observed: mutation NOT detected")
            if not named:
                gate["assertions"].append("observed: mutated file not named")
            if restored_errs:
                gate["assertions"].append("observed: restored bytes still dirty")
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
    print(("%s " % ("PASS" if gate["outcome"] == "PASS" else "FAIL")) + GATE_MUTANT, flush=True)
    return gate


def expected_gate_ids():
    return [GATE_INVENTORY] + ["suite:%s" % t for t in EXPECTED_SUITES] + [GATE_MUTANT, GATE_PRIVACY]


def validate_receipt(receipt, root):
    """Validate receipt structure and bound identities. Returns errors."""
    root = Path(root)
    errs = []
    if not isinstance(receipt, dict):
        return ["receipt is not an object"]
    if receipt.get("schema") != SCHEMA:
        errs.append("bad schema")
    if receipt.get("status") not in ("PASS", "FAIL", "BLOCKED"):
        errs.append("bad status")
    if receipt.get("source_manifest_sha256") != SOURCE_MANIFEST_SHA256:
        errs.append("bad source_manifest_sha256")
    man_path = root / "vendor_manifest.json"
    manifest = None
    if not man_path.is_file() or man_path.is_symlink():
        errs.append("vendor_manifest.json missing")
    else:
        try:
            manifest = load_json_strict(man_path)
        except HarnessError as e:
            errs.append("manifest unreadable: %s" % e.code)
            manifest = None
        if receipt.get("vendor_manifest_sha256") != (sha_file(man_path) if man_path.is_file() else None):
            errs.append("vendor_manifest_sha256 mismatch")
    pv = receipt.get("python_version")
    if not isinstance(pv, str) or not re.match(r"^\d+\.\d+\.\d+$", pv):
        errs.append("bad python_version")
    pf = receipt.get("platform")
    if not isinstance(pf, str) or not pf or "/" in pf or pf.startswith(".") or " " in pf:
        errs.append("bad platform")
    if receipt.get("vendor_mutant_rejected") is not True:
        errs.append("vendor_mutant_rejected is not true")
    aq = receipt.get("application_qualification")
    if not isinstance(aq, dict) or aq.get("status") != "BLOCKED":
        errs.append("application_qualification must stay BLOCKED")
    elif not isinstance(aq.get("reasons"), list) or not aq["reasons"] or not all(isinstance(r, str) and r for r in aq["reasons"]):
        errs.append("application_qualification needs non-empty reasons")
    gates = receipt.get("gates")
    if not isinstance(gates, list) or not gates:
        return errs + ["gates missing or empty"]
    ids = [g.get("id") for g in gates if isinstance(g, dict)]
    if len(set(ids)) != len(ids):
        errs.append("duplicate gate id")
    if set(ids) != set(expected_gate_ids()):
        errs.append("gate id set mismatch")
    fix_sha = fixture_digest(manifest) if isinstance(manifest, dict) else None
    for g in gates:
        if not isinstance(g, dict):
            errs.append("gate is not an object")
            continue
        gid = g.get("id")
        errs += _validate_gate(g, gid, root, manifest, fix_sha, receipt.get("vendor_manifest_sha256"))
    text = json.dumps(receipt, sort_keys=True)
    for bad in ("/home/", "/Users/", "C:\\Users", "BEGIN PRIVATE", "/tmp/", "/root/"):
        if bad in text:
            errs.append("receipt leaks host path or secret marker: %r" % bad)
    outcomes = {g["id"]: g.get("outcome") for g in gates if isinstance(g, dict) and "id" in g}
    want = "PASS" if all(v == "PASS" for v in outcomes.values()) else (
        "BLOCKED" if outcomes.get(GATE_PRIVACY) == "BLOCKED"
        and all(v == "PASS" for k, v in outcomes.items() if k != GATE_PRIVACY) else "FAIL")
    if outcomes and receipt.get("status") != want:
        errs.append("status %s inconsistent with gate outcomes (%s)" % (receipt.get("status"), want))
    by_id = {g["id"]: g for g in gates if isinstance(g, dict) and "id" in g}
    flags = {}
    for gid in (GATE_INVENTORY, GATE_MUTANT, GATE_PRIVACY):
        g = by_id.get(gid)
        if isinstance(g, dict) and isinstance(g.get("command"), list):
            flags[gid] = WITHHELD in g["command"]
    if len(set(flags.values())) > 1:
        errs.append("deny-list flag inconsistent across gates")
    priv = by_id.get(GATE_PRIVACY)
    if isinstance(priv, dict):
        has = WITHHELD in (priv.get("command") or [])
        if (priv.get("outcome") == "BLOCKED") == has:
            errs.append("privacy outcome inconsistent with deny-list flag")
        if (priv.get("input_sha256") is None) != (not has):
            errs.append("privacy input_sha256 inconsistent with deny-list flag")
    return errs


def _validate_gate(g, gid, root, manifest, fix_sha, manifest_sha):
    errs = []
    cmd = g.get("command")
    if not isinstance(cmd, list) or not cmd or not all(isinstance(x, str) and x for x in cmd):
        return ["%s: bad command" % gid]
    for x in cmd:
        if x.startswith("/") or x.startswith("~") or ".." in Path(x).parts:
            errs.append("%s: host path in argv: %r" % (gid, x))
    if gid and gid.startswith("suite:"):
        t = gid[len("suite:"):]
        if t not in EXPECTED_SUITES or cmd != ["python3", "-B", "-m", "unittest", "discover", "-s", "tests", "-p", t]:
            errs.append("%s: command is not the registered suite argv" % gid)
    elif gid == GATE_MUTANT:
        base = ["python3", "-B", "tools/bootstrap_kit.py", "--check", "--root", SCRATCH]
        if cmd != base and cmd != base + ["--deny-list", WITHHELD]:
            errs.append("%s: command is not the registered mutant argv" % gid)
    elif gid in (GATE_INVENTORY, GATE_PRIVACY):
        base = ["python3", "-B", "tools/bootstrap_kit.py", "--run"]
        if cmd != base and cmd != base + ["--deny-list", WITHHELD]:
            errs.append("%s: command is not the registered run argv" % gid)
    want_cwd = SCRATCH if gid == GATE_MUTANT else "router/kit"
    if g.get("cwd") != want_cwd:
        errs.append("%s: bad cwd" % gid)
    rc = g.get("rc")
    if not (rc is None or (isinstance(rc, int) and not isinstance(rc, bool) and -128 <= rc <= 255)):
        errs.append("%s: bad rc" % gid)
    log = g.get("log")
    if not isinstance(log, str) or "/" in log or log.startswith(".") or ".." in log:
        errs.append("%s: bad log name" % gid)
    else:
        lp = root / "logs" / log
        if not lp.is_file() or lp.is_symlink():
            errs.append("%s: log evidence missing" % gid)
        elif g.get("log_sha256") != sha_file(lp):
            errs.append("%s: log_sha256 mismatch" % gid)
    for key in ("input_sha256", "instrument_sha256", "fixture_sha256"):
        v = g.get(key)
        if v is not None and (not isinstance(v, str) or not HEX64.match(v)):
            errs.append("%s: bad %s" % (gid, key))
    a = g.get("assertions")
    if not isinstance(a, list) or not a or not all(isinstance(x, str) and x for x in a):
        errs.append("%s: assertions must be a non-empty string list" % gid)
    oc = g.get("outcome")
    if oc not in ("PASS", "FAIL", "BLOCKED"):
        errs.append("%s: bad outcome" % gid)
    if gid and gid.startswith("suite:"):
        t = gid[len("suite:"):]
        tool = root / "tests" / t
        if tool.is_file() and g.get("instrument_sha256") != sha_file(tool):
            errs.append("%s: instrument_sha256 mismatch" % gid)
        if fix_sha is not None and g.get("fixture_sha256") != fix_sha:
            errs.append("%s: fixture_sha256 mismatch" % gid)
        if g.get("input_sha256") != manifest_sha:
            errs.append("%s: input_sha256 mismatch" % gid)
        if (oc == "PASS") != (rc == 0):
            errs.append("%s: outcome inconsistent with rc" % gid)
    elif gid == GATE_MUTANT:
        if oc == "PASS" and (rc == 0 or rc is None):
            errs.append("%s: PASS requires observed rejection rc" % gid)
        if g.get("input_sha256") != manifest_sha:
            errs.append("%s: input_sha256 mismatch" % gid)
    elif gid in (GATE_INVENTORY, GATE_PRIVACY):
        if oc == "PASS" and rc != 0:
            errs.append("%s: PASS requires rc 0" % gid)
        if oc == "BLOCKED" and rc is not None:
            errs.append("%s: BLOCKED requires rc null" % gid)
        if gid == GATE_INVENTORY and g.get("input_sha256") != manifest_sha:
            errs.append("%s: input_sha256 mismatch" % gid)
    if gid in (GATE_INVENTORY, GATE_MUTANT, GATE_PRIVACY):
        me = root / "tools" / "bootstrap_kit.py"
        if me.is_file() and g.get("instrument_sha256") != sha_file(me):
            errs.append("%s: instrument_sha256 mismatch" % gid)
    return errs


def _check_python():
    try:
        r = subprocess.run(["python3", "-c", "import sys; print(sys.version.split()[0])"],
                           capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return "python3 not runnable"
    if r.returncode != 0:
        return "python3 probe failed"
    mine = platform.python_version()
    if r.stdout.strip() != mine:
        return "python3 %s != harness %s" % (r.stdout.strip(), mine)
    return ""


def cmd_check(root, deny_path):
    root = Path(root)
    errs = []
    try:
        manifest = load_json_strict(root / "vendor_manifest.json")
    except HarnessError as e:
        print("manifest: %s %s" % (e.code, e.detail), flush=True)
        return 1
    for e in verify_manifest(root, manifest):
        print("inventory: %s" % e, flush=True)
        errs.append(e)
    rpath = root / "bootstrap_receipt.json"
    if not rpath.is_file():
        print("receipt: missing bootstrap_receipt.json", flush=True)
        errs.append("receipt missing")
    else:
        try:
            receipt = load_json_strict(rpath)
        except HarnessError as e:
            print("receipt: %s %s" % (e.code, e.detail), flush=True)
            errs.append("receipt unreadable")
        else:
            for e in validate_receipt(receipt, root):
                print("receipt: %s" % e, flush=True)
                errs.append(e)
    if deny_path is None:
        print("privacy: BLOCKED (no deny list supplied)", flush=True)
        return 2 if not errs else 1
    try:
        lits, _ = load_deny_list(deny_path)
    except HarnessError as e:
        print("privacy: BLOCKED (%s)" % e.code, flush=True)
        return 2 if not errs else 1
    hits = 0
    for rel in sorted(manifest if isinstance(manifest, dict) else {}):
        data = (root / rel).read_bytes()
        for lit in lits:
            if lit.encode() in data:
                print("privacy: MATCH in %s" % rel, flush=True)
                hits += 1
                break
    if hits:
        return 1
    print("privacy: %d files clean" % len(manifest if isinstance(manifest, dict) else {}), flush=True)
    return 0 if not errs else 1


def cmd_run(root, deny_path):
    root = Path(root)
    prob = _check_python()
    if prob:
        print("BLOCKED: %s" % prob, flush=True)
        return 2
    clean_bytecode(root)
    logs_dir = root / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)
    self_sha = sha_file(Path(__file__).resolve())
    try:
        manifest = load_json_strict(root / "vendor_manifest.json")
    except HarnessError as e:
        print("FAIL %s (%s)" % (GATE_INVENTORY, e.code), flush=True)
        return 1
    manifest_sha = sha_file(root / "vendor_manifest.json")
    fix_sha = fixture_digest(manifest) if isinstance(manifest, dict) else hashlib.sha256(b"\n").hexdigest()
    run_cmd = ["python3", "-B", "tools/bootstrap_kit.py", "--run"]
    if deny_path:
        run_cmd += ["--deny-list", WITHHELD]
    inv_errs = verify_manifest(root, manifest)
    inv_log = logs_dir / "inventory.log"
    inv_log.write_text(("inventory clean: %d files\n" % len(manifest)) if not inv_errs and isinstance(manifest, dict)
                       else "".join("inventory: %s\n" % e for e in inv_errs), encoding="utf-8")
    inv_gate = {"id": GATE_INVENTORY, "command": list(run_cmd),
                "cwd": "router/kit", "rc": 0 if not inv_errs else 1, "log": inv_log.name,
                "log_sha256": sha_file(inv_log), "input_sha256": manifest_sha,
                "instrument_sha256": self_sha, "fixture_sha256": None,
                "assertions": (["%d manifest entries verified" % len(manifest), "0 unknown files", "0 symlinks"]
                               if not inv_errs else ["inventory verifies"]),
                "outcome": "PASS" if not inv_errs else "FAIL"}
    print(("%s " % ("PASS" if not inv_errs else "FAIL")) + GATE_INVENTORY, flush=True)
    if inv_errs:
        receipt = _receipt(root, manifest_sha, [inv_gate], False)
        (root / "bootstrap_receipt.json").write_text(json.dumps(receipt, sort_keys=True, indent=1) + "\n", encoding="utf-8")
        return 1
    gates = [inv_gate]
    gates += run_suites(root, EXPECTED_SUITES, logs_dir, manifest_sha, fix_sha)
    clean_bytecode(root)
    mut = run_mutant(root, logs_dir, self_sha, manifest, manifest_sha, deny_path)
    gates.append(mut)
    priv = run_privacy(root, manifest, deny_path, logs_dir / "privacy.log", self_sha, run_cmd)
    gates.append(priv)
    if priv["outcome"] == "BLOCKED":
        print("BLOCKED " + GATE_PRIVACY, flush=True)
    mutant_ok = mut["outcome"] == "PASS"
    status = "PASS" if all(g["outcome"] == "PASS" for g in gates) else (
        "BLOCKED" if priv["outcome"] == "BLOCKED" and all(g["outcome"] == "PASS" for g in gates if g["id"] != GATE_PRIVACY)
        else "FAIL")
    receipt = _receipt(root, manifest_sha, gates, mutant_ok, status)
    (root / "bootstrap_receipt.json").write_text(json.dumps(receipt, sort_keys=True, indent=1) + "\n", encoding="utf-8")
    print("receipt: %s" % status, flush=True)
    return {"PASS": 0, "BLOCKED": 2, "FAIL": 1}[status]


def _receipt(root, manifest_sha, gates, mutant_ok, status=None):
    if status is None:
        status = "PASS" if all(g["outcome"] == "PASS" for g in gates) else "FAIL"
    return {"schema": SCHEMA,
            "scope": "portable fixture tests and generic-node build only; not UI integration, not application routing quality",
            "status": status,
            "source": SOURCE_DESCR,
            "source_manifest_sha256": SOURCE_MANIFEST_SHA256,
            "vendor_manifest_sha256": manifest_sha,
            "python_version": platform.python_version(),
            "platform": "%s-%s" % (platform.system().lower(), platform.machine()),
            "gates": gates,
            "vendor_mutant_rejected": mutant_ok,
            "application_qualification": {"status": "BLOCKED",
                                          "reasons": ["no application DEV/TEST benchmark or fitted params in this unit",
                                                      "privacy evidence is fixture-scoped; CI must supply the unpublished deny list",
                                                      "foreign calibration never qualifies application routing"]},
            "notes": ["recorded argv is the executed argv; 'python3' is PATH-resolved and pinned to the harness version at startup",
                      "deny-list and mutant scratch paths withheld by design; contents bound by input_sha256 digests"]}


def cmd_selftest(root):
    root = Path(root)
    prob = _check_python()
    if prob:
        print("BLOCKED: %s" % prob, flush=True)
        return 2
    log = root / "logs" / "selftest.log"
    res = run_gate(["python3", "-B", "-m", "unittest", "discover", "-s", "tests", "-p", "test_bootstrap_contract.py"],
                   root, log, SELFTEST_TIMEOUT_S)
    text = log.read_text(encoding="utf-8", errors="replace")
    ran, ok, _, _ = _parse_unittest(text)
    good = res["rc"] == 0 and ok and bool(ran)
    print("%s selftest (%s)" % ("PASS" if good else "FAIL", "ran %d tests" % ran if ran else "no tests"), flush=True)
    return 0 if good else 1


def main(argv=None):
    ap = argparse.ArgumentParser(prog="bootstrap_kit.py")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--check", action="store_true")
    g.add_argument("--run", action="store_true")
    g.add_argument("--self-test", action="store_true")
    ap.add_argument("--deny-list")
    ap.add_argument("--root")
    a = ap.parse_args(argv)
    root = Path(a.root) if a.root else kit_root()
    if a.root and (a.run or a.self_test):
        ap.error("--root is only accepted with --check")
    if not root.is_dir():
        print("root is not a directory", flush=True)
        return 2
    if a.check:
        return cmd_check(root, a.deny_list)
    if a.run:
        return cmd_run(root, a.deny_list)
    return cmd_selftest(root)


if __name__ == "__main__":
    sys.exit(main())


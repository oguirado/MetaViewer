import copy
import hashlib
import json
import os
import shutil
import sys
import unittest

from common import W, tmp

sys.path.insert(0, os.path.join(W, "tools"))
import bootstrap_kit as BK  # noqa: E402
import jsonschema_lite as JS  # noqa: E402

TOKEN_A = "SYNTHETIC-DENY-TOKEN-ALPHA-91827364"
TOKEN_B = "SYNTHETIC-DENY-TOKEN-BETA-91827365"


def sha_bytes(b):
    return hashlib.sha256(b).hexdigest()


def sha_path(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(65536), b""):
            h.update(b)
    return h.hexdigest()


def write_tree(root, files):
    for rel, data in files.items():
        p = os.path.join(root, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "wb") as f:
            f.write(data)


def manifest_of(root, files):
    return {rel: sha_bytes(data) for rel, data in sorted(files.items())}


def fake_source(root):
    files = {rel: ("vendored %s\n" % rel).encode() for rel in BK.VENDOR_SET}
    files["vendor_manifest.json"] = b""
    write_tree(root, files)
    man = {rel: sha_bytes(data) for rel, data in sorted(files.items()) if rel != "vendor_manifest.json"}
    man_bytes = (json.dumps(man, sort_keys=True, indent=1) + "\n").encode()
    with open(os.path.join(root, "vendor_manifest.json"), "wb") as f:
        f.write(man_bytes)
    return sha_bytes(man_bytes)


class TestVendor(unittest.TestCase):
    def test_set_is_61_sorted_unique_and_excludes_adapted(self):
        self.assertEqual(len(BK.VENDOR_SET), 61)
        self.assertEqual(tuple(sorted(BK.VENDOR_SET)), BK.VENDOR_SET)
        self.assertEqual(len(set(BK.VENDOR_SET)), 61)
        for rel in ("tests/common.py", "tests/test_T0_freeze.py", "tests/test_T1_blocks.py", "tests/test_T6_eval.py"):
            self.assertNotIn(rel, BK.VENDOR_SET)

    def test_copies_and_returns_map(self):
        d = tmp()
        pin = fake_source(os.path.join(d, "src"))
        dst = os.path.join(d, "dst")
        got = BK.vendor(os.path.join(d, "src"), dst, pin)
        self.assertEqual(len(got), 61)
        for rel, digest in got.items():
            self.assertEqual(sha_path(os.path.join(dst, rel)), digest)

    def test_rejects_bad_pin(self):
        d = tmp()
        fake_source(os.path.join(d, "src"))
        with self.assertRaises(BK.HarnessError) as c:
            BK.vendor(os.path.join(d, "src"), os.path.join(d, "dst"), "0" * 64)
        self.assertEqual(c.exception.code, "E_SOURCE_PIN")
        self.assertFalse(os.path.exists(os.path.join(d, "dst")))

    def test_rejects_changed_helper(self):
        d = tmp()
        src = os.path.join(d, "src")
        pin = fake_source(src)
        victim = os.path.join(src, "tools", "blocks.py")
        with open(victim, "r+b") as f:
            f.seek(0)
            f.write(b"X")
        with self.assertRaises(BK.HarnessError) as c:
            BK.vendor(src, os.path.join(d, "dst"), pin)
        self.assertEqual(c.exception.code, "E_SOURCE_HASH")
        self.assertIn("tools/blocks.py", str(c.exception))
        self.assertFalse(os.path.exists(os.path.join(d, "dst")))

    def test_rejects_existing_destination_unchanged(self):
        d = tmp()
        src = os.path.join(d, "src")
        pin = fake_source(src)
        dst = os.path.join(d, "dst")
        os.makedirs(dst)
        keep = os.path.join(dst, "keep.txt")
        open(keep, "wb").write(b"operator bytes")
        with self.assertRaises(BK.HarnessError) as c:
            BK.vendor(src, dst, pin)
        self.assertEqual(c.exception.code, "E_DEST_EXISTS")
        self.assertEqual(open(keep, "rb").read(), b"operator bytes")

    def test_rejects_missing_member(self):
        d = tmp()
        src = os.path.join(d, "src")
        pin = fake_source(src)
        os.remove(os.path.join(src, "tools", "route_v2.py"))
        with self.assertRaises(BK.HarnessError) as c:
            BK.vendor(src, os.path.join(d, "dst"), pin)
        self.assertEqual(c.exception.code, "E_SOURCE_FILE")

    def test_rejects_symlinked_member(self):
        d = tmp()
        src = os.path.join(d, "src")
        pin = fake_source(src)
        victim = os.path.join(src, "tools", "route_v2.py")
        os.remove(victim)
        os.symlink(os.path.join(src, "tools", "blocks.py"), victim)
        with self.assertRaises(BK.HarnessError) as c:
            BK.vendor(src, os.path.join(d, "dst"), pin)
        self.assertEqual(c.exception.code, "E_SOURCE_FILE")

    def test_rejects_duplicate_json_key(self):
        d = tmp()
        p = os.path.join(d, "m.json")
        open(p, "w").write('{"a": 1, "a": 2}')
        with self.assertRaises(BK.HarnessError) as c:
            BK.load_json_strict(p)
        self.assertEqual(c.exception.code, "E_DUP_KEY")


class TestInventory(unittest.TestCase):
    def test_clean_tree_passes(self):
        d = tmp()
        files = {"tools/a.py": b"print(1)\n", "tests/test_x.py": b"# x\n"}
        write_tree(d, files)
        self.assertEqual(BK.verify_manifest(d, manifest_of(d, files)), [])

    def test_changed_byte_names_file(self):
        d = tmp()
        files = {"tools/a.py": b"print(1)\n"}
        write_tree(d, files)
        man = manifest_of(d, files)
        open(os.path.join(d, "tools", "a.py"), "wb").write(b"print(2)\n")
        errs = BK.verify_manifest(d, man)
        self.assertEqual(len(errs), 1)
        self.assertIn("tools/a.py", errs[0])

    def test_missing_file(self):
        d = tmp()
        files = {"tools/a.py": b"print(1)\n"}
        write_tree(d, files)
        man = manifest_of(d, files)
        os.remove(os.path.join(d, "tools", "a.py"))
        self.assertTrue(any("tools/a.py" in e for e in BK.verify_manifest(d, man)))

    def test_extra_file_refused(self):
        d = tmp()
        files = {"tools/a.py": b"print(1)\n"}
        write_tree(d, files)
        man = manifest_of(d, files)
        open(os.path.join(d, "tools", "rogue.py"), "wb").write(b"x")
        errs = BK.verify_manifest(d, man)
        self.assertTrue(any("rogue.py" in e for e in errs))

    def test_symlink_refused(self):
        d = tmp()
        files = {"tools/a.py": b"print(1)\n"}
        write_tree(d, files)
        man = manifest_of(d, files)
        os.symlink(os.path.join(d, "tools", "a.py"), os.path.join(d, "tools", "link.py"))
        self.assertTrue(any("symlink" in e for e in BK.verify_manifest(d, man)))

    def test_traversal_and_absolute_entries_refused(self):
        d = tmp()
        self.assertTrue(BK.verify_manifest(d, {"../escape.py": "0" * 64}))
        self.assertTrue(BK.verify_manifest(d, {"/abs.py": "0" * 64}))
        self.assertTrue(BK.verify_manifest(d, {"tools/a.py": "zz"}))

    def test_clean_bytecode_removes_only_caches(self):
        d = tmp()
        write_tree(d, {"tools/a.py": b"print(1)\n",
                       "tools/__pycache__/a.cpython-312.pyc": b"\0\0",
                       "tools/stray.pyc": b"\0\0"})
        n = BK.clean_bytecode(d)
        self.assertEqual(n, 2)
        self.assertFalse(os.path.exists(os.path.join(d, "tools", "__pycache__")))
        self.assertFalse(os.path.exists(os.path.join(d, "tools", "stray.pyc")))
        self.assertEqual(open(os.path.join(d, "tools", "a.py"), "rb").read(), b"print(1)\n")

    def test_excluded_paths_ignored_on_disk_but_refused_in_manifest(self):
        d = tmp()
        files = {"tools/a.py": b"print(1)\n"}
        write_tree(d, files)
        man = manifest_of(d, files)
        write_tree(d, {"logs/x.log": b"l", "tmp/y": b"t", "bootstrap_receipt.json": b"{}"})
        self.assertEqual(BK.verify_manifest(d, man), [])
        bad = dict(man)
        bad["logs/x.log"] = sha_bytes(b"l")
        self.assertTrue(any("excluded" in e for e in BK.verify_manifest(d, bad)))

    def test_symlink_inside_excluded_dirs_ignored(self):
        d = tmp()
        files = {"tools/a.py": b"print(1)\n"}
        write_tree(d, files)
        man = manifest_of(d, files)
        os.makedirs(os.path.join(d, "tmp", "scratch"), exist_ok=True)
        os.makedirs(os.path.join(d, "logs"), exist_ok=True)
        os.symlink(os.path.join(d, "tools", "a.py"), os.path.join(d, "tmp", "scratch", "link.py"))
        os.symlink(os.path.join(d, "tools", "a.py"), os.path.join(d, "logs", "link.log"))
        self.assertEqual(BK.verify_manifest(d, man), [])


class TestTrust(unittest.TestCase):
    def test_mutated_helper_refused_before_any_execution(self):
        d = tmp()
        marker = os.path.join(d, "EXECUTED")
        files = {"tools/helper.py": b"value = 1\n", "tests/test_h.py": b"# h\n"}
        write_tree(d, files)
        man = manifest_of(d, files)
        open(os.path.join(d, "tools", "helper.py"), "wb").write(
            ("raise SystemExit('EXECUTED')\nopen(%r, 'w').write('x')\n" % marker).encode())
        errs = BK.verify_manifest(d, man)
        self.assertTrue(any("tools/helper.py" in e for e in errs))
        self.assertFalse(os.path.exists(marker))
        self.assertNotIn("helper", sys.modules)
        write_tree(d, {"tools/helper.py": b"value = 1\n"})
        self.assertEqual(BK.verify_manifest(d, man), [])


class TestRunner(unittest.TestCase):
    def test_run_gate_rc_and_log(self):
        d = tmp()
        log = os.path.join(d, "g.log")
        res = BK.run_gate([sys.executable, "-c", "print('hi-gate')"], d, log, 30)
        self.assertEqual(res["rc"], 0)
        self.assertFalse(res["timed_out"])
        self.assertIn("hi-gate", open(log, encoding="utf-8", errors="replace").read())

    def test_run_gate_preserves_failure_rc(self):
        d = tmp()
        res = BK.run_gate([sys.executable, "-c", "import sys; sys.exit(3)"], d, os.path.join(d, "g.log"), 30)
        self.assertEqual(res["rc"], 3)

    def test_run_gate_timeout_gives_rc_none(self):
        d = tmp()
        res = BK.run_gate([sys.executable, "-c", "import time; time.sleep(30)"], d, os.path.join(d, "g.log"), 1)
        self.assertIsNone(res["rc"])
        self.assertTrue(res["timed_out"])

    def _scratch_kit(self, tests):
        d = tmp()
        root = os.path.join(d, "kit")
        write_tree(root, {"tests/%s" % name: body for name, body in tests.items()})
        return root

    def test_missing_suite_fails_with_rc_null(self):
        root = self._scratch_kit({})
        gates = BK.run_suites(root, ["test_nope.py"], os.path.join(root, "logs"), "0" * 64, "1" * 64)
        self.assertEqual(gates[0]["outcome"], "FAIL")
        self.assertIsNone(gates[0]["rc"])
        self.assertTrue(gates[0]["assertions"])

    def test_empty_discovery_fails(self):
        root = self._scratch_kit({"test_empty.py": b"VALUE = 1\n"})
        gates = BK.run_suites(root, ["test_empty.py"], os.path.join(root, "logs"), "0" * 64, "1" * 64)
        self.assertEqual(gates[0]["outcome"], "FAIL")
        self.assertTrue(any("empty" in a for a in gates[0]["assertions"]))

    def test_required_skip_fails(self):
        body = b"import unittest\nclass S(unittest.TestCase):\n    def test_x(self):\n        self.skipTest('nope')\n"
        root = self._scratch_kit({"test_skip.py": body})
        gates = BK.run_suites(root, ["test_skip.py"], os.path.join(root, "logs"), "0" * 64, "1" * 64)
        self.assertEqual(gates[0]["outcome"], "FAIL")
        self.assertTrue(any("skip" in a for a in gates[0]["assertions"]))

    def test_failing_suite_fails(self):
        body = b"import unittest\nclass S(unittest.TestCase):\n    def test_x(self):\n        self.assertTrue(False)\n"
        root = self._scratch_kit({"test_bad.py": body})
        gates = BK.run_suites(root, ["test_bad.py"], os.path.join(root, "logs"), "0" * 64, "1" * 64)
        self.assertEqual(gates[0]["outcome"], "FAIL")
        self.assertNotEqual(gates[0]["rc"], 0)

    def test_passing_suite_passes_with_bindings(self):
        body = b"import unittest\nclass S(unittest.TestCase):\n    def test_x(self):\n        self.assertTrue(True)\n"
        root = self._scratch_kit({"test_good.py": body})
        gates = BK.run_suites(root, ["test_good.py"], os.path.join(root, "logs"), "0" * 64, "1" * 64)
        g = gates[0]
        self.assertEqual(g["outcome"], "PASS")
        self.assertEqual(g["rc"], 0)
        self.assertEqual(g["instrument_sha256"], sha_bytes(body))
        self.assertEqual(g["input_sha256"], "0" * 64)
        self.assertEqual(g["fixture_sha256"], "1" * 64)

    def test_suite_list_is_closed(self):
        self.assertEqual(len(BK.EXPECTED_SUITES), 12)
        self.assertIn("test_bootstrap_contract.py", BK.EXPECTED_SUITES)
        self.assertNotIn("test_entry_contract.py", BK.EXPECTED_SUITES)
        self.assertFalse([t for t in BK.EXPECTED_SUITES if "T4" in t])
        for t in BK.EXPECTED_SUITES:
            self.assertTrue(os.path.isfile(os.path.join(W, "tests", t)), t)


def _scratch_receipt_root():
    d = tmp()
    root = os.path.join(d, "kit")
    harness = open(os.path.join(W, "tools", "bootstrap_kit.py"), "rb").read()
    files = {"tools/bootstrap_kit.py": harness}
    for t in BK.EXPECTED_SUITES:
        files["tests/" + t] = ("# stub %s\n" % t).encode()
    files["tests/fixtures/fx.json"] = b"{}\n"
    write_tree(root, files)
    man = manifest_of(root, files)
    man_bytes = (json.dumps(man, sort_keys=True, indent=1) + "\n").encode()
    write_tree(root, {"vendor_manifest.json": man_bytes})
    logs = os.path.join(root, "logs")
    os.makedirs(logs, exist_ok=True)
    return root, man, sha_bytes(man_bytes)


def _good_receipt(root, man, manifest_sha):
    fix = BK.fixture_digest(man)
    me = sha_path(os.path.join(root, "tools", "bootstrap_kit.py"))
    run_cmd = ["python3", "-B", "tools/bootstrap_kit.py", "--run", "--deny-list", BK.WITHHELD]
    gates = []
    logs = os.path.join(root, "logs")

    def gate(gid, cmd, cwd, rc, outcome, inp, inst, fixs, asserts):
        log = gid.replace(":", "_") + ".log"
        open(os.path.join(logs, log), "w").write("evidence for %s\n" % gid)
        gates.append({"id": gid, "command": cmd, "cwd": cwd, "rc": rc, "log": log,
                      "log_sha256": sha_path(os.path.join(logs, log)), "input_sha256": inp,
                      "instrument_sha256": inst, "fixture_sha256": fixs,
                      "assertions": asserts, "outcome": outcome})

    gate("inventory", run_cmd, "router/kit", 0, "PASS", manifest_sha, me, None, ["clean"])
    for t in BK.EXPECTED_SUITES:
        gate("suite:" + t, ["python3", "-B", "-m", "unittest", "discover", "-s", "tests", "-p", t],
             "router/kit", 0, "PASS", manifest_sha, sha_path(os.path.join(root, "tests", t)), fix, ["ran 1 tests"])
    gate("mutant_vendor_helper",
         ["python3", "-B", "tools/bootstrap_kit.py", "--check", "--root", BK.SCRATCH, "--deny-list", BK.WITHHELD],
         BK.SCRATCH, 1, "PASS", manifest_sha, me, None, ["rejected"])
    gate("privacy_denylist", run_cmd, "router/kit", 0, "PASS", "ab" * 32, me, None, ["0 matches"])
    return {"schema": BK.SCHEMA, "scope": "s", "status": "PASS", "source": "s",
            "source_manifest_sha256": BK.SOURCE_MANIFEST_SHA256, "vendor_manifest_sha256": manifest_sha,
            "python_version": "3.11.0", "platform": "linux-x86_64", "gates": gates,
            "vendor_mutant_rejected": True,
            "application_qualification": {"status": "BLOCKED", "reasons": ["r1"]}}


class TestReceipt(unittest.TestCase):
    def test_valid_receipt_passes(self):
        root, man, msha = _scratch_receipt_root()
        self.assertEqual(BK.validate_receipt(_good_receipt(root, man, msha), root), [])

    def _mut(self, fn):
        root, man, msha = _scratch_receipt_root()
        r = _good_receipt(root, man, msha)
        fn(root, r)
        return BK.validate_receipt(r, root)

    def test_remove_gate_fails(self):
        errs = self._mut(lambda root, r: r["gates"].pop(3))
        self.assertTrue(any("id set" in e for e in errs))

    def test_duplicate_gate_fails(self):
        def dup(root, r):
            r["gates"].append(copy.deepcopy(r["gates"][0]))
        errs = self._mut(dup)
        self.assertTrue(any("duplicate" in e for e in errs))

    def test_swapped_log_digest_fails(self):
        def swap(root, r):
            a, b = r["gates"][0], r["gates"][1]
            a["log_sha256"], b["log_sha256"] = b["log_sha256"], a["log_sha256"]
        errs = self._mut(swap)
        self.assertTrue(any("log_sha256" in e for e in errs))

    def test_deleted_log_fails(self):
        def gone(root, r):
            os.remove(os.path.join(root, "logs", r["gates"][0]["log"]))
        errs = self._mut(gone)
        self.assertTrue(any("missing" in e for e in errs))

    def test_absolute_cwd_fails(self):
        errs = self._mut(lambda root, r: r["gates"][0].update(cwd="/tmp/x"))
        self.assertTrue(any("cwd" in e for e in errs))

    def test_constant_pass_with_failing_rc_fails(self):
        def forge(root, r):
            g = [x for x in r["gates"] if x["id"] == "suite:test_T2_build.py"][0]
            g["rc"] = 1
        errs = self._mut(forge)
        self.assertTrue(any("inconsistent with rc" in e for e in errs))

    def test_mutant_pass_with_rc_zero_fails(self):
        def forge(root, r):
            [x for x in r["gates"] if x["id"] == "mutant_vendor_helper"][0]["rc"] = 0
        errs = self._mut(forge)
        self.assertTrue(any("rejection rc" in e for e in errs))

    def test_mutant_rejected_false_fails(self):
        errs = self._mut(lambda root, r: r.update(vendor_mutant_rejected=False))
        self.assertTrue(any("vendor_mutant_rejected" in e for e in errs))

    def test_wrong_suite_argv_fails(self):
        def forge(root, r):
            [x for x in r["gates"] if x["id"] == "suite:test_T2_build.py"][0]["command"].append("--extra")
        errs = self._mut(forge)
        self.assertTrue(any("registered suite argv" in e for e in errs))

    def test_empty_assertions_fail(self):
        errs = self._mut(lambda root, r: r["gates"][0].update(assertions=[]))
        self.assertTrue(any("assertions" in e for e in errs))

    def test_status_inconsistent_fails(self):
        errs = self._mut(lambda root, r: r.update(status="FAIL"))
        self.assertTrue(any("inconsistent with gate outcomes" in e for e in errs))

    def test_host_path_in_argv_fails(self):
        def forge(root, r):
            [x for x in r["gates"] if x["id"] == "suite:test_T2_build.py"][0]["command"][1] = "/tmp/x.py"
        errs = self._mut(forge)
        self.assertTrue(any("host path" in e for e in errs))

    def test_application_pass_claim_fails(self):
        errs = self._mut(lambda root, r: r["application_qualification"].update(status="PASS"))
        self.assertTrue(any("BLOCKED" in e for e in errs))

    def test_privacy_flag_mismatch_fails(self):
        def forge(root, r):
            g = [x for x in r["gates"] if x["id"] == "privacy_denylist"][0]
            g["command"] = ["python3", "-B", "tools/bootstrap_kit.py", "--run"]
        errs = self._mut(forge)
        self.assertTrue(any("inconsistent" in e for e in errs))

    def test_edited_instrument_breaks_binding(self):
        def edit(root, r):
            with open(os.path.join(root, "tests", "test_T2_build.py"), "ab") as f:
                f.write(b"# drift\n")
        errs = self._mut(edit)
        self.assertTrue(any("instrument_sha256" in e for e in errs))


class TestPrivacy(unittest.TestCase):
    def _root(self, extra=None):
        d = tmp()
        root = os.path.join(d, "kit")
        files = {"tools/a.py": b"clean content\n", "tests/t.py": b"# clean\n"}
        if extra:
            files.update(extra)
        write_tree(root, files)
        deny = os.path.join(d, "deny.txt")
        open(deny, "w").write("# synthetic list\n%s\n%s\n" % (TOKEN_A, TOKEN_B))
        return root, manifest_of(root, files), deny

    def test_clean_tree_passes_without_echo(self):
        root, man, deny = self._root()
        g = BK.run_privacy(root, man, deny, os.path.join(root, "logs", "privacy.log"), "0" * 64,
                           ["python3", "-B", "tools/bootstrap_kit.py", "--run"])
        self.assertEqual(g["outcome"], "PASS")
        log = open(os.path.join(root, "logs", "privacy.log")).read()
        self.assertNotIn(TOKEN_A, log)
        self.assertNotIn(TOKEN_B, log)

    def test_planted_token_fails_without_echo(self):
        root, man, deny = self._root({"tools/a.py": ("line1\nsecret %s tail\n" % TOKEN_A).encode()})
        g = BK.run_privacy(root, man, deny, os.path.join(root, "logs", "privacy.log"), "0" * 64,
                           ["python3", "-B", "tools/bootstrap_kit.py", "--run"])
        self.assertEqual(g["outcome"], "FAIL")
        log = open(os.path.join(root, "logs", "privacy.log")).read()
        self.assertNotIn(TOKEN_A, log)
        self.assertIn("tools/a.py:2", log)

    def test_missing_list_blocked(self):
        root, man, _ = self._root()
        g = BK.run_privacy(root, man, None, os.path.join(root, "logs", "privacy.log"), "0" * 64,
                           ["python3", "-B", "tools/bootstrap_kit.py", "--run"])
        self.assertEqual(g["outcome"], "BLOCKED")
        self.assertIsNone(g["rc"])
        self.assertIsNone(g["input_sha256"])

    def test_empty_list_blocked(self):
        root, man, _ = self._root()
        deny = os.path.join(root, "empty.txt")
        open(deny, "w").write("# nothing\n\n")
        g = BK.run_privacy(root, man, deny, os.path.join(root, "logs", "privacy.log"), "0" * 64,
                           ["python3", "-B", "tools/bootstrap_kit.py", "--run"])
        self.assertEqual(g["outcome"], "BLOCKED")

    def test_short_literal_rejected(self):
        root, man, _ = self._root()
        deny = os.path.join(root, "short.txt")
        open(deny, "w").write("abc\n")
        with self.assertRaises(BK.HarnessError) as c:
            BK.load_deny_list(deny)
        self.assertEqual(c.exception.code, "E_DENY_LIST")


def valid_node():
    return {"schema": "ctx.node.v2", "id": "PM-001.1", "corpus": "math", "kind": "paper",
            "title": "Online paging with cache eviction", "purpose": "Competitive ratio of online paging.",
            "anchors": [{"a": "stmt-main", "role": "statement"}],
            "search": {"triggers": ["cache-eviction"], "keywords": ["paging"]},
            "status": "active", "source_sha256": "0" * 64}


class TestNodeSchema(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.schema = json.load(open(os.path.join(W, "standards", "schemas", "ctx.node.v2.schema.json"),
                                    encoding="utf-8"))

    def test_valid_node(self):
        self.assertEqual(JS.validate(valid_node(), self.schema), [])

    def test_17th_anchor_rejected(self):
        n = valid_node()
        n["anchors"] = [{"a": "a%d" % i, "role": "symbol"} for i in range(17)]
        self.assertTrue(JS.validate(n, self.schema))

    def test_65_char_anchor_rejected(self):
        n = valid_node()
        n["anchors"] = [{"a": "x" * 65, "role": "symbol"}]
        self.assertTrue(JS.validate(n, self.schema))

    def test_33_char_id_rejected(self):
        n = valid_node()
        n["id"] = "P" + "x" * 32
        self.assertTrue(JS.validate(n, self.schema))

    def test_bad_pattern_id_rejected(self):
        n = valid_node()
        n["id"] = "1abc"
        self.assertTrue(JS.validate(n, self.schema))

    def test_unknown_property_rejected(self):
        n = valid_node()
        n["lookup"] = "x"
        self.assertTrue(any("additional" in e for e in JS.validate(n, self.schema)))

    def test_missing_required_rejected(self):
        n = valid_node()
        del n["purpose"]
        self.assertTrue(any("required" in e for e in JS.validate(n, self.schema)))

    def test_bad_digest_rejected(self):
        n = valid_node()
        n["source_sha256"] = "zz"
        self.assertTrue(JS.validate(n, self.schema))

    def test_multibyte_anchor_counts_characters(self):
        # Known schema gap (see T9 MF-B): maxLength counts characters, so a
        # 40-character / 80-byte anchor passes the schema; the UTF-8 byte
        # limit is enforced by gates_v2.check_answer instead.
        n = valid_node()
        n["anchors"] = [{"a": "é" * 40, "role": "symbol"}]
        self.assertEqual(len(n["anchors"][0]["a"].encode()), 80)
        self.assertEqual(JS.validate(n, self.schema), [])


class TestLiveManifest(unittest.TestCase):
    """F6: the committed tree must verify against the committed manifest.

    Regenerable bytecode (__pycache__/*.pyc, emitted by -I children that
    ignore -B; see DEVIATIONS.md) is tolerated here: the inventory gate
    still refuses it on a clean tree, and every manifest entry is re-hashed.
    """

    def test_live_tree_matches_manifest(self):
        manifest = BK.load_json_strict(os.path.join(W, "vendor_manifest.json"))
        errs = [err for err in BK.verify_manifest(W, manifest)
                if "__pycache__" not in err and not err.endswith((".pyc", ".pyo"))]
        self.assertEqual(errs, [])

    def test_flipped_gates_byte_is_named(self):
        rel = os.path.join("tools", "gates_v2.py")
        data = open(os.path.join(W, rel), "rb").read()
        d = tmp()
        self.addCleanup(shutil.rmtree, d, True)
        dest = os.path.join(d, rel)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        open(dest, "wb").write(bytes([(data[0] + 1) % 256]) + data[1:])
        manifest = BK.load_json_strict(os.path.join(W, "vendor_manifest.json"))
        errs = BK.verify_manifest(d, {rel: manifest[rel]})
        self.assertEqual(len(errs), 1)
        self.assertIn(rel, errs[0])


if __name__ == "__main__":
    unittest.main()

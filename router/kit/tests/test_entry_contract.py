"""Cross-unit contract tests for the ENTRY lane (Sol-owned assertions).

Validates the ENTRY-owned files (llms.txt, AGENTS.md, catalogue/protocol.json
at the repository root) against the pinned ctx.protocol.v2 schema plus
semantic linkage rules. Exit 0 means real integration PASS; any other exit
means not integrated -- the failure message distinguishes BLOCKED (a
prerequisite or generated artifact is absent) from FAIL (a semantic
violation). A PASS here never proves application routing quality.
"""
import json
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
KIT = os.path.dirname(HERE)
REPO = os.path.dirname(os.path.dirname(KIT))

sys.path.insert(0, os.path.join(KIT, "tools"))
import jsonschema_lite as JS  # noqa: E402

PARAMS = "catalogue/router/params.json"
PATH_RULE = "lookup:catalogue/routes.tsv"
ANSWER_SCHEMA = "ctx.shortlist.v2"
CHAIN_RE = re.compile(r"catalogue/[A-Za-z0-9_/][A-Za-z0-9_/.-]*\.(?:json|tsv)")


def prereq(test, rel):
    p = os.path.join(REPO, rel)
    if not os.path.isfile(p) or os.path.islink(p):
        test.fail("BLOCKED: missing prerequisite %s" % rel)
    return p


class EntryContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        schema_path = os.path.join(KIT, "standards", "schemas", "ctx.protocol.v2.schema.json")
        if not os.path.isfile(schema_path):
            raise unittest.SkipTest("BLOCKED: kit protocol schema absent")
        cls.schema = json.load(open(schema_path, encoding="utf-8"))

    def test_protocol_schema_closed(self):
        p = prereq(self, "catalogue/protocol.json")
        try:
            proto = json.load(open(p, encoding="utf-8"))
        except ValueError as e:
            self.fail("FAIL: catalogue/protocol.json is not JSON: %s" % e)
        errs = JS.validate(proto, self.schema)
        self.assertEqual(errs, [], "FAIL: protocol violates ctx.protocol.v2: %s" % errs[:3])
        self.assertEqual(proto["router"]["params"], PARAMS, "FAIL: wrong params constant")
        self.assertEqual(proto["router"]["path_rule"], PATH_RULE, "FAIL: wrong path_rule constant")
        self.assertEqual(proto["router"]["answer_schema"], ANSWER_SCHEMA, "FAIL: wrong answer_schema constant")
        for m in proto.get("mounts", []):
            self.assertNotIn("lookup", m, "FAIL: per-mount lookup is not a protocol field")

    def test_mount_targets_resolve(self):
        p = prereq(self, "catalogue/protocol.json")
        proto = json.load(open(p, encoding="utf-8"))
        for m in proto.get("mounts", []):
            mp = m.get("path", "")
            self.assertFalse(os.path.isabs(mp), "FAIL: absolute mount path %r" % mp)
            target = os.path.normpath(os.path.join(REPO, mp))
            if not target.startswith(REPO + os.sep) and target != REPO:
                self.fail("FAIL: mount path escapes repo: %r" % mp)
            if not os.path.exists(target):
                self.fail("BLOCKED: mount target not yet generated: %s" % mp)

    def test_entry_docs_link_protocol(self):
        for rel in ("llms.txt", "AGENTS.md"):
            p = prereq(self, rel)
            text = open(p, encoding="utf-8", errors="replace").read()
            self.assertIn("catalogue/protocol.json", text, "FAIL: %s does not link the protocol" % rel)
            self.assertTrue(text.strip(), "FAIL: %s is empty" % rel)

    def test_advertised_chain_targets_exist(self):
        """F7: every catalogue file target advertised by the entry docs exists.

        The protocol router block declares the qualified-use contract (gated
        by the Status line); the docs browse chain must resolve whenever it
        is advertised. Fails on advertised-but-absent targets.
        """
        missing = []
        for rel in ("llms.txt", "AGENTS.md"):
            p = prereq(self, rel)
            text = open(p, encoding="utf-8", errors="replace").read()
            for match in CHAIN_RE.finditer(text):
                target = match.group(0).rstrip(".,;:)]'\"")
                full = os.path.join(REPO, target)
                if not os.path.isfile(full) or os.path.islink(full):
                    missing.append("%s advertises absent %s" % (rel, target))
        self.assertEqual(missing, [], "FAIL: " + "; ".join(missing[:5]))

    def test_no_host_paths_in_protocol(self):
        p = prereq(self, "catalogue/protocol.json")
        text = open(p, encoding="utf-8", errors="replace").read()
        for bad in ("/home/", "/Users/", "C:\\Users", "/tmp/", "/root/"):
            self.assertNotIn(bad, text, "FAIL: host path in protocol.json: %r" % bad)


import importlib.util
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
KIT = os.path.dirname(HERE)
REPO = os.path.dirname(os.path.dirname(KIT))

_SPEC = importlib.util.spec_from_file_location(
    "mv_router_index_under_test", os.path.join(REPO, "tools", "router_index.py"))
_MOD = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_MOD)


def _proto(mounts):
    return {"mounts": mounts,
            "router": {"answer_schema": "ctx.shortlist.v2",
                       "params": "catalogue/router/params.json",
                       "path_rule": "lookup:catalogue/routes.tsv"},
            "schema": "ctx.protocol.v2"}


def _mount(corpus="metaviewer", path="catalogue/router"):
    return {"corpus": corpus, "path": path, "priority": 0}


class CorpusAgreement(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="mv-corpus-"))
        self.addCleanup(shutil.rmtree, str(self.root), True)
        (self.root / "catalogue").mkdir()

    def _write(self, obj):
        (self.root / "catalogue" / "protocol.json").write_text(
            json.dumps(obj, sort_keys=True) + "\n", encoding="utf-8")

    def _check(self):
        return _MOD._check_corpus_agreement(self.root)

    def test_real_shape_passes(self):
        self._write(_proto([_mount()]))
        self._check()

    def test_absent_protocol_passes(self):
        self._check()

    def test_other_corpus_refused(self):
        self._write(_proto([_mount(corpus="other")]))
        with self.assertRaises(_MOD.RouterError) as ctx:
            self._check()
        self.assertIn("corpus mismatch", str(ctx.exception))

    def test_two_mounts_refused(self):
        self._write(_proto([_mount(), _mount()]))
        with self.assertRaises(_MOD.RouterError) as ctx:
            self._check()
        self.assertIn("exactly one mount", str(ctx.exception))

    def test_zero_mounts_refused(self):
        self._write(_proto([]))
        with self.assertRaises(_MOD.RouterError) as ctx:
            self._check()
        self.assertIn("exactly one mount", str(ctx.exception))

    def test_wrong_mount_path_refused(self):
        self._write(_proto([_mount(path="elsewhere/router")]))
        with self.assertRaises(_MOD.RouterError) as ctx:
            self._check()
        self.assertIn("mount path", str(ctx.exception))

    def test_fictional_top_level_shape_refused(self):
        self._write({"corpus": "metaviewer"})
        with self.assertRaises(_MOD.RouterError):
            self._check()



if __name__ == "__main__":
    unittest.main()

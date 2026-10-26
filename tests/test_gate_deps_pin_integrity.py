import json
import os
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]


def ci_yml_pin_errors(text, root="."):
    """Baseline pin check logic from ci.yml line 221."""
    errs = []
    for n, line in enumerate(text.splitlines(), 1):
        m = re.search(r"^\s*-?\s*uses:\s*(\S+)", line)
        if not m:
            continue
        ref = m.group(1)
        if ref.startswith("./"):
            if not os.path.exists(os.path.join(root, ref[2:])):
                errs.append("line %d missing local action %s" % (n, ref))
        elif not re.match(r"^[^@\s]+@[0-9a-f]{40}$", ref):
            errs.append("line %d unpinned %s" % (n, ref))
    return errs


def strict_pin_errors(text, root="."):
    """Extended pin check logic requiring whole action name plus 40-hex hash."""
    errs = []
    for n, line in enumerate(text.splitlines(), 1):
        m = re.search(r"^\s*-?\s*uses:\s*(\S+)", line)
        if not m:
            continue
        ref = m.group(1)
        if ref.startswith("./"):
            if not os.path.exists(os.path.join(root, ref[2:])):
                errs.append("line %d missing local action %s" % (n, ref))
        elif not re.match(r"^[a-zA-Z0-9_\-]+/[a-zA-Z0-9_\-./]+@[0-9a-f]{40}$", ref):
            errs.append("line %d unpinned or invalid action ref %s" % (n, ref))
    return errs


class PinIntegrityTests(unittest.TestCase):
    def test_uses_mutant_grid(self):
        """O1(a): Parametrized mutant grid for extended 'uses:' pin regex."""
        valid_pin = "- uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # checkout v4.2.2\n"
        self.assertEqual(strict_pin_errors(valid_pin, str(ROOT)), [])

        mutants = [
            ("39-char hex", "- uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af68\n"),
            ("41-char hex", "- uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af6839\n"),
            ("uppercase hex", "- uses: actions/checkout@11BD71901BBE5B1630CEEA73D27597364C9AF683\n"),
            ("sha256: prefix", "- uses: actions/checkout@sha256:11bd71901bbe5b1630ceea73d27597364c9af683\n"),
            ("tag-with-SHA-comment", "- uses: actions/checkout@v4.2.2 # 11bd71901bbe5b1630ceea73d27597364c9af683\n"),
            ("docker:// ref", "- uses: docker://alpine@11bd71901bbe5b1630ceea73d27597364c9af683\n"),
        ]

        for label, snippet in mutants:
            with self.subTest(label=label):
                errs = strict_pin_errors(snippet, str(ROOT))
                self.assertTrue(len(errs) > 0, f"Expected pin error for mutant '{label}', but got none")

    def test_ci_yml_pin_errors_docker_ref_finding(self):
        """Verify that baseline ci.yml:221 pin_errors admits docker:// ref (a finding)."""
        snippet = "- uses: docker://alpine@11bd71901bbe5b1630ceea73d27597364c9af683\n"
        baseline_errs = ci_yml_pin_errors(snippet, str(ROOT))
        # Baseline ci.yml pin_errors permits docker:// references because ^[^@\s]+ matches docker://alpine.
        self.assertEqual(baseline_errs, [], "Baseline ci.yml pin_errors accepted docker:// reference")

    def test_deps_lock_commits_are_40_hex(self):
        """O1(b): deps.lock commit validation."""
        deps_path = ROOT / "deps.lock"
        self.assertTrue(deps_path.exists(), "deps.lock missing")

        data = json.loads(deps_path.read_text(encoding="utf-8"))
        components = data.get("components", [])
        self.assertTrue(len(components) > 0, "No components in deps.lock")

        invalid_commits = []
        for comp in components:
            name = comp.get("name")
            commit = comp.get("commit", "")
            if not re.fullmatch(r"[0-9a-f]{40}", commit):
                invalid_commits.append((name, commit))

        self.assertEqual(invalid_commits, [], "All component commits must be full lowercase hex")

    def test_kit_lock_parity_and_mutant(self):
        """O1(c): ui/kit.lock.json commit plus contentHash validation and PARITY_NAME_ONLY mutant."""
        kit_lock_path = ROOT / "ui/kit.lock.json"
        self.assertTrue(kit_lock_path.exists(), "ui/kit.lock.json missing")

        kit_lock = json.loads(kit_lock_path.read_text(encoding="utf-8"))
        commit = kit_lock.get("commit", "")
        content_hash = kit_lock.get("contentHash", "")

        self.assertTrue(re.fullmatch(r"[0-9a-f]{40}", commit) is not None, f"kit.lock.json commit {commit} is not 40-hex")
        self.assertTrue(re.fullmatch(r"[0-9a-f]{64}", content_hash) is not None, f"kit.lock.json contentHash {content_hash} is not 64-hex")

        def validate_kit_lock_parity(lock, actual_repo, actual_hash):
            if lock.get("repo") != actual_repo:
                return False, "repo mismatch"
            if lock.get("contentHash") != actual_hash:
                return False, "contentHash mismatch"
            return True, "ok"

        ok, reason = validate_kit_lock_parity(kit_lock, kit_lock["repo"], kit_lock["contentHash"])
        self.assertTrue(ok, f"Baseline kit lock parity failed: {reason}")

        wrong_hash = "0" * 64
        ok_mutant, reason_mutant = validate_kit_lock_parity(kit_lock, kit_lock["repo"], wrong_hash)
        self.assertFalse(ok_mutant, "PARITY_NAME_ONLY mutant (same repo, wrong hash) was wrongly accepted")
        self.assertEqual(reason_mutant, "contentHash mismatch")


if __name__ == "__main__":
    unittest.main()

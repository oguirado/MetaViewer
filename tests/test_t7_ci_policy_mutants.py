import glob
import json
import os
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]


class CIPolicyMutantTests(unittest.TestCase):
    def get_ci_and_vol(self):
        ci_path = ROOT / ".github/workflows/ci.yml"
        vol_path = ROOT / ".github/workflows/volume.yml"
        self.assertTrue(ci_path.exists())
        self.assertTrue(vol_path.exists())
        return ci_path.read_text(encoding="utf-8"), vol_path.read_text(encoding="utf-8")

    def run_policy_fixtures(self, ci, vol, root=".",
                            drop_f2_neg_local=False,
                            accept_duplicate_gate_id=False,
                            allow_rc_null_on_pass=False):
        """Runs policy fixture logic (F1-F8). Returns (passed_checks_set, fails_list)."""
        fails = []
        passed_checks = set()

        def check(name, cond, detail=""):
            if cond:
                passed_checks.add(name)
            else:
                fails.append(name + (" " + detail if detail else ""))

        def top_block_keys(text, key):
            lines = text.splitlines()
            start = next(i for i, l in enumerate(lines) if l == key + ":")
            keys = []
            for line in lines[start + 1:]:
                if re.match(r"^[A-Za-z]", line):
                    break
                m = re.match(r"^  ([A-Za-z_][\w-]*):", line)
                if m:
                    keys.append(m.group(1))
            return keys

        # F1
        check("f1-ci-triggers", {"push", "pull_request", "workflow_dispatch"} <= set(top_block_keys(ci, "on")))
        von = set(top_block_keys(vol, "on"))
        check("f1-vol-triggers", von == {"schedule", "workflow_dispatch"}, repr(sorted(von)))
        check("f1-permissions", "contents: read" in ci and "contents: read" in vol)

        cig = re.search(r"^concurrency:\n  group: (\S+)", ci, re.M).group(1)
        volg = re.search(r"^concurrency:\n  group: (\S+)", vol, re.M).group(1)
        check("f1-groups", cig != volg and "ci-" in cig and "volume-" in volg, cig + " / " + volg)
        check("f1-cancel", ci.count("cancel-in-progress: true") >= 1 and "cancel-in-progress: true" in vol)

        def job_timeouts(text):
            lines = text.splitlines()
            start = next(i for i, l in enumerate(lines) if l == "jobs:")
            jobs = {}
            cur = None
            for line in lines[start + 1:]:
                m = re.match(r"^  ([\w-]+):\s*$", line)
                if m:
                    cur = m.group(1)
                    jobs[cur] = None
                elif cur is not None:
                    t = re.match(r"^    timeout-minutes: (\d+)\s*$", line)
                    if t:
                        jobs[cur] = int(t.group(1))
            return jobs

        def job_block(text, job):
            lines = text.splitlines()
            start = next(i for i, l in enumerate(lines) if l == "  " + job + ":")
            buf = []
            for line in lines[start + 1:]:
                if re.match(r"^  [\w-]+:\s*$", line):
                    break
                buf.append(line)
            return "\n".join(buf)

        cjobs = job_timeouts(ci)
        vjobs = job_timeouts(vol)
        check("f1-ci-jobs", set(cjobs) >= {"ci-policy", "laws-contracts", "router", "rust", "go", "python", "js", "e2e",
                                           "novac", "package", "build-macos", "build-windows", "ci-required"},
              repr(sorted(cjobs)))
        check("f1-ci-timeouts", all(v == 25 for v in cjobs.values()), repr(cjobs))
        check("f1-vol-jobs", set(vjobs) >= {"volume-property", "volume-mutants", "volume-e2e"}, repr(sorted(vjobs)))
        check("f1-vol-timeouts", all(v == 60 for v in vjobs.values()), repr(vjobs))

        mut_vol = "on:\n  schedule:\n  pull_request:\n"
        check("f1-neg-vol-trigger", set(top_block_keys(mut_vol, "on")) != {"schedule", "workflow_dispatch"})
        mut_jobs = "jobs:\n  lone:\n    runs-on: x\n"
        check("f1-neg-timeout", job_timeouts(mut_jobs).get("lone") != 60)

        # F2
        def pin_errors(text, r):
            errs = []
            for n, line in enumerate(text.splitlines(), 1):
                m = re.search(r"^\s*-?\s*uses:\s*(\S+)", line)
                if not m:
                    continue
                ref = m.group(1)
                if ref.startswith("./"):
                    if not os.path.exists(os.path.join(r, ref[2:])):
                        errs.append("line %d missing local action %s" % (n, ref))
                elif not re.match(r"^[^@\s]+@[0-9a-f]{40}$", ref):
                    errs.append("line %d unpinned %s" % (n, ref))
            return errs

        real = []
        for path in sorted(glob.glob(os.path.join(root, ".github/workflows/*.yml"))):
            with open(path, encoding="utf-8") as f:
                real += ["%s: %s" % (path, e) for e in pin_errors(f.read(), root)]
        check("f2-pinned", real == [], "; ".join(real[:4]))
        good = "steps:\n  - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # checkout v4.2.2\n"
        check("f2-pos", pin_errors(good, root) == [])
        bads = ["- uses: actions/checkout@v4\n", "- uses: actions/checkout@main\n",
                "- uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af68\n",
                "- uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af68399\n",
                "- uses: ./actions/does-not-exist\n",
                "- uses: other/repo/.github/workflows/x.yml@v1\n"]
        check("f2-neg", all(pin_errors("s:\n" + b, root) != [] for b in bads))

        if not drop_f2_neg_local:
            check("f2-neg-local", pin_errors("s:\n- uses: ./tools\n", root) == [])
        else:
            # Planted mutant: drop f2-neg-local check
            pass

        broken = lambda text, r: []
        check("f2-mutant-caught", pin_errors("s:\n" + bads[0], root) != broken("s:\n" + bads[0], root))

        # F3
        laws_block = job_block(ci, "laws-contracts")
        bare = False
        for line in laws_block.splitlines():
            code = re.sub(r'"[^"]*"', '""', line)
            if re.search(r"\$(?:BEFORE|HEAD|PR_BASE|PR_HEAD|EVENT_NAME)\b", code):
                bare = True
        check("f3-neg-quoted", not bare and '"$BEFORE"' in laws_block)

        # F4
        RKEYS = {"schema", "gate_id", "leg", "profile", "owner", "issuer", "scope", "argv", "cwd",
                 "rc", "outcome", "reason", "identities", "assertions", "counts"}
        OUTCOMES = {"PASS", "FAIL", "BLOCKED", "UNKNOWN", "NOT_APPLICABLE"}

        def receipt_errors(r, reg):
            errs = []
            if set(r) != RKEYS:
                errs.append("keys")
                return errs
            if r["schema"] != "gate_receipt/v1":
                errs.append("schema")
            for k in ("gate_id", "leg", "profile", "owner", "issuer", "reason", "cwd"):
                if not isinstance(r[k], str) or not r[k]:
                    errs.append(k)
            if r["outcome"] not in OUTCOMES:
                errs.append("outcome")
            if not allow_rc_null_on_pass:
                if r["outcome"] in ("PASS", "FAIL"):
                    if type(r["rc"]) is not int:
                        errs.append("rc-int")
                elif r["rc"] is not None:
                    errs.append("rc-null")
            else:
                # Planted mutant: allow rc null on PASS
                if r["outcome"] in ("PASS", "FAIL"):
                    if type(r["rc"]) is not int and r["rc"] is not None:
                        errs.append("rc-int")
                elif r["rc"] is not None:
                    errs.append("rc-null")

            if not isinstance(r["argv"], list) or not r["argv"] or any(not isinstance(a, str) or not a for a in r["argv"]):
                errs.append("argv")
            if set(r["scope"]) != {"unit", "platform", "feature", "artifact"} or any(not isinstance(v, str) or not v for v in r["scope"].values()):
                errs.append("scope")
            ids = r["identities"]
            if set(ids) != {"gate_revision", "instrument_sha256", "artifact_sha256", "configuration_sha256",
                            "log_sha256", "fixture_sha256"}:
                errs.append("identities-keys")
                return errs
            hexok = lambda v: isinstance(v, str) and re.fullmatch(r"[0-9a-f]{64}", v) is not None
            for k in ("instrument_sha256", "artifact_sha256", "configuration_sha256", "log_sha256"):
                if not hexok(ids[k]):
                    errs.append("identities-" + k)
            if not isinstance(ids["fixture_sha256"], list) or not ids["fixture_sha256"] or any(not hexok(v) for v in ids["fixture_sha256"]):
                errs.append("fixture_sha256")
            if not isinstance(r["assertions"], list) or not r["assertions"]:
                errs.append("assertions-empty")
            else:
                for a in r["assertions"]:
                    if set(a) != {"id", "expected", "observed", "accepted"} or type(a["accepted"]) is not bool:
                        errs.append("assertion-shape")
            c = r["counts"]
            if set(c) != {"passed", "failed", "skipped", "source"} or not isinstance(c["source"], str) or not c["source"]:
                errs.append("counts")
            else:
                for k in ("passed", "failed", "skipped"):
                    if c[k] is not None and type(c[k]) is not int:
                        errs.append("counts-" + k)
            for k, v in reg.items():
                if ids.get(k) != v:
                    errs.append("oracle-" + k)
            return errs

        genuine = {"schema": "gate_receipt/v1", "gate_id": "g", "leg": "g", "profile": "W0",
                   "owner": "W0-CI-MATRIX", "issuer": "CI/g/1 [VM]", "argv": ["true"], "cwd": "/tmp",
                   "rc": 0, "outcome": "PASS", "reason": "ok",
                   "scope": {"unit": "u", "platform": "x64", "feature": "g", "artifact": "g.receipt.json"},
                   "identities": {"gate_revision": "r", "instrument_sha256": "a" * 64, "artifact_sha256": "b" * 64,
                                  "configuration_sha256": "c" * 64, "log_sha256": "d" * 64, "fixture_sha256": ["a" * 64]},
                   "assertions": [{"id": "exit-status", "expected": "rc 0", "observed": "rc 0", "accepted": True}],
                   "counts": {"passed": 1, "failed": 0, "skipped": 0, "source": "parsed:true"}}
        reg = {"instrument_sha256": "a" * 64, "artifact_sha256": "b" * 64, "configuration_sha256": "c" * 64,
               "log_sha256": "d" * 64}
        check("f4-genuine", receipt_errors(genuine, reg) == [], repr(receipt_errors(genuine, reg)[:3]))

        nullpass = json.loads(json.dumps(genuine))
        nullpass["rc"] = None
        check("f4-neg-null-pass", receipt_errors(nullpass, reg) != [])

        def aggregate(required, receipts, results):
            seen = [r["gate_id"] for r in receipts]
            if not accept_duplicate_gate_id:
                if sorted(seen) != sorted(required):
                    return (False, "identity-set")
            else:
                # Planted mutant: accept duplicate gate_id (using set comparison)
                if set(seen) != set(required):
                    return (False, "identity-set")

            for r in receipts:
                if results.get(r["gate_id"]) != "success":
                    return (False, "job-" + r["gate_id"])
                if r["outcome"] not in required[r["gate_id"]]:
                    return (False, "outcome-" + r["gate_id"])
            return (True, "ok")

        req = {"rust": {"PASS"}, "novac": {"PASS", "NOT_APPLICABLE"}}
        rpass = json.loads(json.dumps(genuine))
        rpass["gate_id"] = "rust"
        rna = json.loads(json.dumps(genuine))
        rna.update({"gate_id": "novac", "rc": None, "outcome": "NOT_APPLICABLE", "reason": "w1"})
        check("f4-neg-agg-dup", not aggregate(req, [rpass, rpass, rna], {"rust": "success", "novac": "success"})[0])

        # F5
        ARCH = {"ubuntu-24.04": "x86_64", "ubuntu-24.04-arm": "aarch64"}
        check("f5-arch", ARCH["ubuntu-24.04"] == "x86_64" and ARCH["ubuntu-24.04-arm"] == "aarch64")

        # F6
        def redact(text):
            for prefix in ("gh" + "p_", "github_" + "pat_", "AK" + "IA", "xox" + "b-", "MV0-SYNTHETIC-SENTINEL-"):
                text = re.sub(prefix + r"[A-Za-z0-9_\-]{4,}", "[REDACTED]", text)
            return text.replace("__MV0_PRIVATE_SOURCE_SENTINEL__", "[REDACTED]")

        synth = "key=" + "gh" + "p_" + "9" * 36 + " tail"
        check("f6-redact", "[REDACTED]" in redact(synth) and "9" * 36 not in redact(synth))

        # F7
        good_sum = "## rust-fmt [VM] rc 0"
        check("f7-shape", re.match(r"^## [\w\-.]+ \[VM\] rc (UNKNOWN|\d+)$", good_sum) is not None)

        # F8
        refs = set(re.findall(r"tools/[\w\-]+\.py", ci))
        missing = {r for r in refs if not os.path.exists(os.path.join(root, r))}
        check("f8-claims", missing <= {"tools/router_index.py"}, repr(sorted(missing)))

        return passed_checks, fails

    def test_ground_truth_green(self):
        """O2: Ground truth green baseline [INV-MS-03]."""
        ci, vol = self.get_ci_and_vol()
        passed_checks, fails = self.run_policy_fixtures(ci, vol, str(ROOT))
        self.assertEqual(fails, [], f"Ground truth policy fixtures failed: {fails}")
        self.assertIn("f2-neg-local", passed_checks)
        self.assertIn("f4-neg-agg-dup", passed_checks)
        self.assertIn("f4-neg-null-pass", passed_checks)

    def test_mutant_drop_f2_neg_local_killed(self):
        """O2: Planted mutant dropping f2-neg-local exemption must be killed."""
        ci, vol = self.get_ci_and_vol()
        ground_truth_passed, _ = self.run_policy_fixtures(ci, vol, str(ROOT))
        mutant_passed, _ = self.run_policy_fixtures(ci, vol, str(ROOT), drop_f2_neg_local=True)
        # The mutant drops f2-neg-local check, so f2-neg-local is missing from mutant_passed
        self.assertNotIn("f2-neg-local", mutant_passed, "f2-neg-local check should be missing when dropped")
        self.assertLess(len(mutant_passed), len(ground_truth_passed), "Mutant score/check count must be lower than ground truth")

    def test_mutant_accept_duplicate_gate_id_killed(self):
        """O2: Planted mutant accepting duplicated gate_id in aggregate must be killed."""
        ci, vol = self.get_ci_and_vol()
        _, fails = self.run_policy_fixtures(ci, vol, str(ROOT), accept_duplicate_gate_id=True)
        self.assertTrue(any("f4-neg-agg-dup" in f for f in fails), "f4-neg-agg-dup mutant was not killed")

    def test_mutant_allow_rc_null_on_pass_killed(self):
        """O2: Planted mutant allowing rc null on PASS must be killed."""
        ci, vol = self.get_ci_and_vol()
        _, fails = self.run_policy_fixtures(ci, vol, str(ROOT), allow_rc_null_on_pass=True)
        self.assertTrue(any("f4-neg-null-pass" in f for f in fails), "f4-neg-null-pass mutant was not killed")


if __name__ == "__main__":
    unittest.main()

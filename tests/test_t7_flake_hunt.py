import os
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
GITLEAKS_BIN = os.environ.get("GITLEAKS_BIN", "/tmp/gitleaks")


class FlakeHuntTests(unittest.TestCase):
    def test_flake_hunt_20_iterations(self):
        """O6: Bounded Flake Hunt N=20 across LC_ALL, TZ, PYTHONHASHSEED, and unittest options."""
        locales = ["C", "C.UTF-8", "en_US.UTF-8"]
        timezones = ["UTC", "Pacific/Kiritimati", "America/New_York", "Asia/Tokyo"]
        hashseeds = ["0", "12345", "42", "314159", "random"]
        verbosity = ["-v", "-q", ""]

        total_runs = 20
        failed_runs = []

        baseline_contract_out = None
        differing_bytes_found = []

        for i in range(total_runs):
            lc = locales[i % len(locales)]
            tz = timezones[i % len(timezones)]
            seed = hashseeds[i % len(hashseeds)]
            verb = verbosity[i % len(verbosity)]

            env = dict(
                os.environ,
                LC_ALL=lc,
                TZ=tz,
                PYTHONHASHSEED=seed,
                GITLEAKS_BIN=GITLEAKS_BIN,
                PYTHONDONTWRITEBYTECODE="1",
            )

            # Task 1: Check contracts
            cmd_contract = [sys.executable, "tools/check_contracts.py"]
            res_contract = subprocess.run(cmd_contract, cwd=ROOT, env=env, capture_output=True, text=True)
            if res_contract.returncode != 0:
                failed_runs.append((i, "check_contracts.py", res_contract.returncode, res_contract.stderr))

            if baseline_contract_out is None:
                baseline_contract_out = res_contract.stdout
            elif res_contract.stdout != baseline_contract_out:
                differing_bytes_found.append((i, "check_contracts.py stdout mismatch"))

            # Task 2: Gate manifests leg
            cmd_manifests = ["bash", "tools/gate.sh", "--leg", "manifests"]
            res_manifests = subprocess.run(cmd_manifests, cwd=ROOT, env=env, capture_output=True, text=True)
            if res_manifests.returncode != 0:
                failed_runs.append((i, "gate.sh --leg manifests", res_manifests.returncode, res_manifests.stderr))

            # Task 3: Secrets unit tests (GateUnitTests)
            cmd_secrets = [sys.executable, "-m", "unittest", "tests/fixtures/secrets/test_gate.py"]
            if verb:
                cmd_secrets.append(verb)
            res_secrets = subprocess.run(cmd_secrets, cwd=ROOT, env=env, capture_output=True, text=True)
            if res_secrets.returncode != 0:
                failed_runs.append((i, "secrets unit suite", res_secrets.returncode, res_secrets.stderr))

            # Sample self-test on every 4th run to keep runtime bounded (~15s)
            if i % 4 == 0:
                cmd_self = ["bash", "tools/gate.sh", "--self-test"]
                res_self = subprocess.run(cmd_self, cwd=ROOT, env=env, capture_output=True, text=True)
                if res_self.returncode != 0:
                    failed_runs.append((i, "gate.sh --self-test", res_self.returncode, res_self.stderr))

        self.assertEqual(failed_runs, [], f"Flake hunt detected intermittent failures: {failed_runs}")
        self.assertEqual(differing_bytes_found, [], f"Flake hunt detected non-deterministic stdout bytes: {differing_bytes_found}")


if __name__ == "__main__":
    unittest.main()

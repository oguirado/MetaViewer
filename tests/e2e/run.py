"""[TARGET, unit decision] CI entry: real Chromium wall plus routing mutant."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]


def main():
    env = dict(os.environ, MV_E2E_LIVE="1")
    kit = env.get("CAPSULE_UI_KIT_REPO") or env.get("MV_KIT_CHECKOUT")
    if not kit:
        raise RuntimeError("E2E_PREREQ: pinned kit checkout absent")
    subprocess.run(["node", "tools/sync_kit.mjs", kit], cwd=ROOT, env=env, check=True)
    with tempfile.TemporaryDirectory(prefix="mv-e2e-build-") as build:
        env["MV_E2E_BUILD"] = build
        subprocess.run(["node", "tests/e2e/build.mjs"], cwd=ROOT, env=env, check=True)
        command = ["node", "--test", "tests/e2e/e2e1_wall.test.js"]
        subprocess.run(command, cwd=ROOT, env=env, check=True)
        mutant = subprocess.run(command, cwd=ROOT, env=dict(env, MV_E2E_CROSS_ROUTE="1"),
                                capture_output=True, text=True)
        if mutant.returncode == 0 or "E2E_ROUTING" not in mutant.stdout + mutant.stderr:
            raise RuntimeError("E2E_MUTANT: cross-routing must fail the live assertion")
        print("E2E negative control: cross-routing detected")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (RuntimeError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)

"""[TARGET, unit decision] CI entry: real Chromium wall plus routing mutant."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
LIVE_WALL_TEST_NAME = "wall renders four tiles without cross-routing (AC-02)"
BENIGN_ROUTING_TITLE = "malformed publisher ledger refuses with E2E_ROUTING"


def is_cross_route_mutant_killed(returncode: int, stdout: str, stderr: str) -> bool:
    """Confirm the live wall test failed specifically with E2E_ROUTING, not E2E_PREREQ/E2E_GATE or a passing subtest title."""
    if type(returncode) is not int or returncode == 0:
        return False
    combined = (stdout or "") + "\n" + (stderr or "")
    filtered_lines = [
        line for line in combined.splitlines()
        if BENIGN_ROUTING_TITLE not in line
    ]
    sanitized = "\n".join(filtered_lines)
    if "E2E_PREREQ" in sanitized or "E2E_GATE" in sanitized:
        return False
    live_failed = (
        f"✖ {LIVE_WALL_TEST_NAME}" in sanitized
        or ("not ok " in sanitized and LIVE_WALL_TEST_NAME in sanitized)
    )
    if not live_failed:
        return False
    failure_section = (
        sanitized.split("✖ failing tests:", 1)[1]
        if "✖ failing tests:" in sanitized
        else sanitized
    )
    has_routing_code = (
        "E2E_ROUTING:" in failure_section
        or "code: 'E2E_ROUTING'" in failure_section
        or 'code: "E2E_ROUTING"' in failure_section
    )
    return bool(has_routing_code and LIVE_WALL_TEST_NAME in failure_section)


def main():
    env = dict(os.environ, MV_E2E_LIVE="1")
    kit = env.get("CAPSULE_UI_KIT_REPO") or env.get("MV_KIT_CHECKOUT")
    if not kit:
        raise RuntimeError("E2E_PREREQ: pinned kit checkout absent")
    subprocess.run(["node", "tools/sync_kit.mjs", kit], cwd=ROOT, env=env, check=True)
    with tempfile.TemporaryDirectory(prefix="mv-e2e-build-") as build:
        env["MV_E2E_BUILD"] = build
        subprocess.run(["node", "tests/e2e/build.mjs"], cwd=ROOT, env=env, check=True)
        tests = sorted((ROOT / "tests/e2e").glob("*.test.js"))
        if not tests:
            raise RuntimeError("E2E_PREREQ: no E2E tests discovered")
        command = ["node", "--test", "--test-concurrency=1",
                   *[str(path.relative_to(ROOT)) for path in tests]]
        subprocess.run(command, cwd=ROOT, env=env, check=True)
        mutant_command = ["node", "--test", "tests/e2e/e2e1_wall.test.js"]
        mutant = subprocess.run(mutant_command, cwd=ROOT, env=dict(env, MV_E2E_CROSS_ROUTE="1"),
                                capture_output=True, text=True)
        if not is_cross_route_mutant_killed(mutant.returncode, mutant.stdout, mutant.stderr):
            raise RuntimeError("E2E_MUTANT: cross-routing must fail the live assertion")
        print("E2E negative control: cross-routing detected")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (RuntimeError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)

#!/usr/bin/env python3
"""Hosted, offline admission check for a user's MemoryWeb home."""

import argparse
import json
from pathlib import Path
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agents"))
from metaviewer_agents.mw_home import (
    HomeError, canonical_home, check_home, ensure_home, resolve_home,
)


def git(repo, *args):
    # [TARGET, unit decision] Indeterminate Git status refuses MW_HOME_GIT.
    try:
        return subprocess.run(["git", "-C", str(repo), *args],
                              stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL, timeout=10, check=False).returncode
    except (OSError, subprocess.TimeoutExpired) as error:
        raise HomeError("MW_HOME_GIT") from error


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, type=Path)
    parser.add_argument("--home", type=Path)
    args = parser.parse_args(argv)
    home = None
    try:
        try:
            repo = args.repo.resolve()
        except (OSError, RuntimeError) as error:
            raise HomeError("MW_HOME_GIT") from error
        home = canonical_home(resolve_home(repo, args.home))

        def tracked(path):
            selectors = {"memoryweb"}
            if path.is_relative_to(repo):
                selectors.add(path.relative_to(repo).as_posix())
            for selector in sorted(selectors):
                rc = git(repo, "ls-files", "--error-unmatch", "--", selector)
                if rc == 0:
                    return True
                if rc != 1:
                    raise HomeError("MW_HOME_GIT")
            return False

        if tracked(home):
            raise HomeError("MW_HOME_TRACKED")
        rc = git(repo, "check-ignore", "-q", "memoryweb/x")
        if rc == 1:
            raise HomeError("MW_HOME_NOT_IGNORED")
        if rc != 0:
            raise HomeError("MW_HOME_GIT")
        if home.is_relative_to(repo) and home != repo / "memoryweb":
            rc = git(repo, "check-ignore", "-q", "--", str(home / "x"))
            if rc == 1:
                raise HomeError("MW_HOME_NOT_IGNORED")
            if rc != 0:
                raise HomeError("MW_HOME_GIT")
        ensure_home(home)
        check_home(home, tracked)
        code, ok, rc = None, True, 0
    except HomeError as error:
        code, ok = error.code, False
        rc = 2 if code == "MW_HOME_PATH" else 6
    print(json.dumps({"schema": "metaviewer.mw_home/v1", "home": str(home) if home else None,
                      "ok": ok, "code": code}, separators=(",", ":")))
    return rc


if __name__ == "__main__":
    sys.exit(main())

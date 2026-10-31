#!/usr/bin/env python3
"""Hosted, offline admission check for a user's MemoryWeb home.

[TARGET, unit decision] --workflow SITE/WORKFLOW additionally checks the
provenance reference of that site and workflow the way the pinned MemoryWeb
gate opens it: source_ref (before any #) must name a regular file inside
sites/SITE/, and a non-human source must pin its sha256 as receipt_sha256.
Faults refuse MW_PROVENANCE with one actionable line each; nothing is edited.
"""

import argparse
import hashlib
import json
from pathlib import Path
import re
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


def provenance_faults(site_dir, workflow):
    """Return one actionable line per provenance reference the pinned gate cannot open."""
    site_dir = Path(site_dir)
    faults = []
    for relative in ("site.json", "workflows/" + workflow + ".json"):
        try:
            value = json.loads((site_dir / relative).read_bytes()[:1 << 20])
        except (OSError, ValueError):
            faults.append(f"{relative}: unreadable JSON")
            continue
        p = value.get("provenance") if isinstance(value, dict) else None
        if not isinstance(p, dict):
            continue
        ref = p.get("source_ref")
        base = ref.split("#")[0] if isinstance(ref, str) else ""
        source = site_dir / base
        if (not base or Path(base).is_absolute() or any(part in ("", ".", "..") for part in base.split("/"))
                or re.search(r"[:\\?]", base) or source.is_symlink() or not source.is_file()):
            faults.append(f"{relative}: provenance.source_ref {ref!r} must name a file inside "
                          f"sites/{site_dir.name}/ (for example NOTES.md)")
        elif p.get("source") != "human" and p.get("receipt_sha256") != hashlib.sha256(source.read_bytes()).hexdigest():
            faults.append(f"{relative}: provenance.source {p.get('source')!r} needs receipt_sha256 = sha256 of "
                          f"{base}, or source 'human' with an EXPLANATION-format {base}")
    return faults


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, type=Path)
    parser.add_argument("--home", type=Path)
    parser.add_argument("--workflow", help="SITE/WORKFLOW whose provenance references are checked")
    args = parser.parse_args(argv)
    home, faults = None, []
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
        if args.workflow is not None:
            if not re.fullmatch(r"[a-zA-Z0-9_-]+/[a-zA-Z0-9_-]+", args.workflow):
                raise HomeError("MW_HOME_PATH")
            site, workflow = args.workflow.split("/")
            if not (home / "sites" / site / "workflows" / (workflow + ".json")).is_file():
                raise HomeError("MW_WORKFLOW_ABSENT")
            faults = provenance_faults(home / "sites" / site, workflow)
            if faults:
                raise HomeError("MW_PROVENANCE")
        code, ok, rc = None, True, 0
    except HomeError as error:
        code, ok = error.code, False
        rc = 2 if code == "MW_HOME_PATH" else 6
    result = {"schema": "metaviewer.mw_home/v1", "home": str(home) if home else None, "ok": ok, "code": code}
    if args.workflow is not None:
        result["faults"] = faults
    print(json.dumps(result, separators=(",", ":"), ensure_ascii=False))
    return rc


if __name__ == "__main__":
    sys.exit(main())

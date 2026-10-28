"""Verify private dependency provenance without importing private packages.

[TARGET, unit decision] Public handoff: resolve_locked_component(name, *,
lock_path=None) returns the canonical checkout/site-packages root. The default
lock is the repository deps.lock. Wheel roots may also be venv prefixes or the
distribution's own .dist-info directory; only PEP 610 Git provenance is admitted.
Ambiguous metadata and malformed provenance fail closed as unavailable.
"""

from __future__ import annotations

import json
import hashlib
import stat
import os
from pathlib import Path
import re
import subprocess

__all__ = ["DependencyLockError", "resolve_locked_component"]

_ROOT_VARIABLES = {
    "vision-engine": "VQA_VE_ROOT",
    "wender-agent": "MV_WENDER_ROOT",
}
_SHA = re.compile(r"[0-9a-f]{40}\Z")
_LOCK_PATH = Path(__file__).resolve().parents[3] / "deps.lock"


class DependencyLockError(RuntimeError):
    """A dependency could not be proven to match its lock."""

    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(message)


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"),
                      object_pairs_hook=_unique_object)


def _locked_commit(name: str, lock_path: Path) -> str:
    try:
        lock = _read_json(lock_path)
        if not isinstance(lock, dict) or not isinstance(lock.get("components"), list):
            raise ValueError("components must be a list")
        commits = {}
        for entry in lock["components"]:
            if not isinstance(entry, dict):
                raise ValueError("component must be an object")
            component, commit = entry.get("name"), entry.get("commit")
            if (not isinstance(component, str) or not component
                    or component in commits or not isinstance(commit, str)
                    or _SHA.fullmatch(commit) is None):
                raise ValueError("component names must be unique with full Git SHAs")
            commits[component] = commit
        if not _ROOT_VARIABLES.keys() <= commits.keys() or name not in _ROOT_VARIABLES:
            raise ValueError("missing or unsupported private component")
        return commits[name]
    except (OSError, ValueError, TypeError, RecursionError) as error:
        raise DependencyLockError("bad_lockfile", "invalid dependency lock") from error


def _git(root: Path, *arguments: str) -> str:
    # Never inherit GIT_DIR, GIT_WORK_TREE, Python settings, credentials, or
    # user/global Git configuration. PATH remains the caller's tool locator.
    environment = {"PATH": os.environ.get("PATH", os.defpath),
                   "HOME": os.devnull, "LANG": "C", "GIT_CONFIG_NOSYSTEM": "1"}
    try:
        result = subprocess.run(
            ["git", "-c", "core.fsmonitor=false", "-C", str(root), *arguments],
            env=environment, stdin=subprocess.DEVNULL, capture_output=True,
            text=True, encoding="utf-8", errors="strict", timeout=2.0,
            check=False,
        )
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        raise DependencyLockError("unavailable", "cannot inspect dependency checkout") from error
    if result.returncode:
        raise DependencyLockError("unavailable", "cannot inspect dependency checkout")
    return result.stdout.strip()


def _wheel_commit(root: Path, name: str) -> str:
    distribution = re.sub(r"[-_.]+", "_", name)
    pattern = re.compile(re.escape(distribution) + r"-[^-]+\.dist-info\Z", re.I)
    try:
        if root.name.endswith(".dist-info"):
            candidates = [root] if pattern.fullmatch(root.name) else []
        else:
            locations = [root, root / "Lib" / "site-packages"]
            locations.extend(root.glob("lib/python*/site-packages"))
            candidates = [entry for location in locations if location.is_dir()
                          for entry in location.iterdir()
                          if entry.is_dir() and pattern.fullmatch(entry.name)]
        if len(candidates) != 1:
            raise ValueError("missing or ambiguous distribution metadata")
        provenance = _read_json(candidates[0] / "direct_url.json")
        vcs = provenance.get("vcs_info") if isinstance(provenance, dict) else None
        if (not isinstance(vcs, dict) or vcs.get("vcs") != "git"
                or not isinstance(vcs.get("commit_id"), str)
                or _SHA.fullmatch(vcs["commit_id"]) is None):
            raise ValueError("missing full Git provenance")
        return vcs["commit_id"]
    except (OSError, ValueError, TypeError, RecursionError) as error:
        raise DependencyLockError("unavailable", "cannot verify wheel provenance") from error


def _verify_tree(root: Path, commit: str, name: str) -> None:
    """Hash tracked bytes directly, independent of index stat-cache hints."""
    for entry in _git(root, "ls-tree", "-r", "-z", commit).split("\0"):
        if not entry:
            continue
        try:
            metadata, relative = entry.split("\t", 1)
            mode, kind, expected = metadata.split()
            path = root / relative
            info = path.lstat()
            if mode == "120000" and stat.S_ISLNK(info.st_mode):
                data = os.fsencode(os.readlink(path))
            elif mode in ("100644", "100755") and stat.S_ISREG(info.st_mode):
                if bool(info.st_mode & 0o111) != (mode == "100755"):
                    raise ValueError("tracked mode changed")
                data = path.read_bytes()
            else:
                raise ValueError("unsupported or changed tracked type")
            digest = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
            if kind != "blob" or digest != expected:
                raise ValueError("tracked bytes changed")
        except (OSError, ValueError) as error:
            raise DependencyLockError("dirty_tree", f"{name} differs from pinned tree") from error


def resolve_locked_component(name: str, *, lock_path: str | Path | None = None) -> Path:
    """Resolve an environment-selected component and prove its pinned revision.

    Raises DependencyLockError with unavailable, commit_mismatch, dirty_tree,
    or bad_lockfile. Untracked checkout files do not affect tracked cleanliness.
    """
    expected = _locked_commit(name, _LOCK_PATH if lock_path is None else Path(lock_path))
    raw = os.environ.get(_ROOT_VARIABLES[name])
    if not raw or not raw.strip():
        raise DependencyLockError("unavailable", f"{_ROOT_VARIABLES[name]} is required")
    try:
        root = Path(raw).resolve(strict=True)
        if not root.is_dir():
            raise ValueError("not a directory")
    except (OSError, ValueError, RuntimeError) as error:
        raise DependencyLockError("unavailable", "dependency root is not a directory") from error
    if (root / ".git").exists():
        actual = _git(root, "rev-parse", "--verify", "HEAD")
        if actual != expected:
            raise DependencyLockError("commit_mismatch", f"{name} at {actual}, expected {expected}")
        flags = _git(root, "ls-files", "-v", "-z")
        if any(entry and (entry[0].islower() or entry[0] == "S")
               for entry in flags.split("\0")):
            raise DependencyLockError("dirty_tree", f"{name} has suppressed index entries")
        _verify_tree(root, expected, name)
        if _git(root, "status", "--porcelain", "--untracked-files=no"):
            raise DependencyLockError("dirty_tree", f"{name} has tracked modifications")
    else:
        actual = _wheel_commit(root, name)
        if actual != expected:
            raise DependencyLockError("commit_mismatch", f"{name} at {actual}, expected {expected}")
    return root

#!/usr/bin/env python3
"""Explicit operator reclaim; never called by the daemon.

[TARGET, unit decision] Reservation hashes cannot identify random native run IDs.
Prove global native absence instead: every srf-* container (including stopped
ones) must be absent from the local Docker inventory. Any native container or
unknown inventory keeps all records. This intentionally sacrifices reclaim
precision. Native backends: OpenSuperficies src/browserid/surface/surface.go
(docker run), src/holdingscap/holdingscap.go (docker run).
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

RECORD = re.compile(r"([1-9][0-9]*)-[0-9a-f]{32}-[0-9a-f]{64}\Z")
NAME = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_.-]*\Z")


def command(argv):
    environment = dict(os.environ)
    if "--host" in argv:
        # The verified explicit local endpoint must win over context/TLS env.
        for key in ("DOCKER_CONTEXT", "DOCKER_HOST", "DOCKER_TLS",
                    "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"):
            environment.pop(key, None)
    return subprocess.run(argv, check=True, capture_output=True, text=True,
                          env=environment, timeout=15).stdout


class NativeInventory:
    def __init__(self, run=command):
        self.run = run

    def absent(self):
        """True means proven absent; False/None mean present/unknown."""
        try:
            host = os.environ.get("DOCKER_HOST")
            # An explicit context overrides DOCKER_HOST in Docker's CLI too.
            if os.environ.get("DOCKER_CONTEXT") or not host:
                host = json.loads(self.run([
                    "docker", "context", "inspect", "--format",
                    "{{json .Endpoints.docker.Host}}",
                ]))
            if not isinstance(host, str) or not host.startswith("unix:///"):
                return None  # A remote inventory cannot prove local absence.
            raw = self.run([
                "docker", "--host", host, "container", "ls", "--all",
                "--no-trunc", "--format", "{{.Names}}",
            ])
            names = raw.splitlines()
            if any(not NAME.fullmatch(name) for name in names):
                return None
            return not any(name.startswith("srf-") for name in names)
        except (OSError, subprocess.SubprocessError, ValueError, TypeError):
            return None


def pid_dead(pid):
    # Even a signal-zero probe accepts only a recorded, ordinary PID and never
    # targets the caller or its group ID (the repository's AC-10 guard).
    if type(pid) is not int or pid <= 1:
        return False
    if pid in (os.getpid(), os.getpgid(0)):
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    except (PermissionError, OverflowError, OSError):
        return False
    return False


def reservation(st):
    return (stat.S_ISREG(st.st_mode) and stat.S_IMODE(st.st_mode) == 0o600
            and st.st_uid == os.getuid() and st.st_size == 0 and st.st_nlink == 1)


def reclaim(directory, apply=False, inventory=None, dead=pid_dead):
    inventory = NativeInventory() if inventory is None else inventory
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        st = os.fstat(fd)
        if st.st_uid != os.getuid() or stat.S_IMODE(st.st_mode) != 0o700:
            raise ValueError("uid-owned 0700 admission directory required")
        fcntl.flock(fd, fcntl.LOCK_EX)
        results = []
        # Same directory flock as admission; hold through inventory and removal.
        for name in sorted(os.listdir(fd)):
            match = RECORD.fullmatch(name)
            item = {"reservation": name, "action": "keep"}
            before = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if match is None or not reservation(before):
                item["reason"] = "unknown_or_unsafe_reservation"
            elif not dead(int(match[1])):
                item["reason"] = "owner_alive_or_unknown"
            else:
                absent = inventory.absent()
                if absent is not True:
                    item["reason"] = ("native_capsule_present" if absent is False
                                      else "native_inventory_unknown")
                else:
                    item.update(action="would_remove", reason="owner_dead_and_native_inventory_empty")
                    if apply:
                        # Recheck owner and inode after the external read, while
                        # admission is still locked. Never follow a symlink.
                        after = os.stat(name, dir_fd=fd, follow_symlinks=False)
                        if not dead(int(match[1])) or before != after or not reservation(after):
                            item.update(action="keep", reason="reservation_or_owner_changed")
                        else:
                            os.unlink(name, dir_fd=fd)
                            os.fsync(fd)
                            item["action"] = "removed"
            results.append(item)
        return results
    finally:
        os.close(fd)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="op", required=True)
    reclaim_parser = sub.add_parser("reclaim")
    mode = reclaim_parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--apply", action="store_true")
    args = parser.parse_args(argv)
    path = os.environ.get("MV_RAM_ADMISSION_DIR")
    if not path:
        runtime = os.environ.get("XDG_RUNTIME_DIR", "")
        if not Path(runtime).is_absolute():
            parser.error("absolute XDG_RUNTIME_DIR or MV_RAM_ADMISSION_DIR required")
        path = str(Path(runtime) / "metaviewer" / "ram-admission")
    if not Path(path).is_absolute():
        parser.error("absolute admission directory required")
    try:
        for item in reclaim(path, apply=args.apply):
            print(json.dumps(item, sort_keys=True))
        return 0
    except (OSError, ValueError) as error:
        print(json.dumps({"error": str(error), "action": "refused"}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

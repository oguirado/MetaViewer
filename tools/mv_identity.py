#!/usr/bin/env python3
"""Operator-only browser identities; no profile payload is ever opened.

[TARGET, unit decision] Native admin has create/show only. List enumerates
metadata names and calls show; delete uses the native per-id flock guard and
lease record (OpenSuperficies src/browserid/store/store.go:346-364,426-457).
MV_MW_HOME (or --memoryweb-home) is required to prove store separation.
The host menu invokes this tool; it is never an agent tool or a wire request.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
from urllib.parse import urlsplit

SCHEMA = "metaviewer.identity/v1"
ID = re.compile(r"[a-z0-9][a-z0-9-]{1,39}\Z")
# OpenSuperficies a9ac1ac8 src/browserid/surface/surface.go:184 (capsuleRE).
CAPSULE = re.compile(r"srf-(?:id|pg|vm)-[a-z0-9][a-z0-9-]{0,39}\Z")
REPO = Path(__file__).resolve().parent.parent


class Refused(Exception):
    pass


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise Refused("INVALID_ARGUMENTS")


def checked_id(value):
    if not isinstance(value, str) or not ID.fullmatch(value):
        raise Refused("INVALID_ID")
    return value


def absolute(value):
    if not value or not Path(value).is_absolute():
        raise Refused("ABSOLUTE_PATH_REQUIRED")
    return Path(value).resolve()


def overlap(a, b):
    return a == b or a in b.parents or b in a.parents


def private(path, directory=True):
    st = path.lstat()
    if path.is_symlink() or (directory and not path.is_dir()) or st.st_uid != os.getuid() or st.st_mode & 0o077:
        raise Refused("UNSAFE_CONTROL_PATH")


class Identities:
    def __init__(self, root, memoryweb_home, bin_dir, state_dir=None):
        self.root = absolute(root)
        home = absolute(memoryweb_home)
        if overlap(self.root, REPO) or overlap(self.root, home):
            raise Refused("MUT-PROFILE-IN-REPO")
        self.bin_dir = absolute(bin_dir)
        self.state_dir = state_dir
        if self.root.exists():
            private(self.root)

    def native(self, binary, args, timeout=180, absent_ok=False):
        try:
            p = subprocess.run([str(self.bin_dir / binary), *args], stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=timeout,
                               check=False)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise Refused("NATIVE_UNAVAILABLE") from exc
        if absent_ok and p.returncode == 4:
            return {}  # Clean foreground exit already restored readonly.
        if p.returncode:
            raise Refused("NATIVE_REFUSED")
        if len(p.stdout) > 65536:
            raise Refused("NATIVE_REPLY_INVALID")
        try:
            result = json.loads(p.stdout)
        except (ValueError, UnicodeError) as exc:
            raise Refused("NATIVE_REPLY_INVALID") from exc
        if not isinstance(result, dict):
            raise Refused("NATIVE_REPLY_INVALID")
        return result

    def show(self, identity):
        identity = checked_id(identity)
        result = self.native("srf-identity-admin", ["show", "--store-root", str(self.root), "--id", identity])
        if result.get("profile_id") != identity:
            raise Refused("NATIVE_ID_MISMATCH")
        # Only public native metadata crosses this host seam.
        return {k: result[k] for k in ("profile_id", "browser", "account_label", "allowed_domains",
                                     "created_unix", "last_login_unix") if k in result}

    def create(self, identity, label, domains):
        checked_id(identity)
        if not label or label != label.strip() or len(label) > 128 or any(ord(c) < 32 for c in label):
            raise Refused("INVALID_LABEL")
        if not domains or not all(re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", d) for d in domains.split(",")):
            raise Refused("INVALID_DOMAINS")
        self.native("srf-identity-admin", ["create", "--store-root", str(self.root), "--id", identity,
                                          "--label", label, "--domains", domains])
        return self.show(identity)

    def list(self):
        metadata = self.root / "metadata"
        private(metadata)
        return [self.show(checked_id(p.stem)) for p in sorted(metadata.glob("*.json"))]

    def delete(self, identity):
        identity = checked_id(identity)
        self.show(identity)
        for name in ("metadata", "profiles", "locks"):
            private(self.root / name)
        locks = self.root / "locks"
        fd = os.open(locks / (identity + ".guard"), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "r+") as guard:
            fcntl.flock(guard, fcntl.LOCK_EX)
            record = locks / (identity + ".json")
            if record.exists() or record.is_symlink():
                private(record, directory=False)
                with record.open() as source:
                    lease = json.load(source)
                if not isinstance(lease, dict) or lease.get("active") is not False:
                    raise Refused("IDENTITY_BOUND")
            # Native absence of a lock means never acquired (store.go:435-438).
            metadata = self.root / "metadata" / (identity + ".json")
            profile = self.root / "profiles" / identity
            if metadata.is_symlink() or profile.is_symlink() or not metadata.is_file() or not profile.is_dir():
                raise Refused("UNSAFE_IDENTITY_PATH")
            # shutil.rmtree uses fd-relative, symlink-safe removal; no payload reads.
            if not shutil.rmtree.avoids_symlink_attacks:
                raise Refused("SAFE_DELETE_UNAVAILABLE")
            shutil.rmtree(profile)
            metadata.unlink()
            record.unlink(missing_ok=True)
            # Never unlink the guard: a waiter must retain the same flock inode.
        return {"deleted": identity}

    def login(self, identity):
        identity = checked_id(identity)
        self.show(identity)
        state = absolute(self.state_dir)
        private(state)
        # Start only when the exact native lease is absent/inactive. Read control
        # metadata only; never infer login success from browser profile contents.
        record = self.root / "locks" / (identity + ".json")
        active = False
        if record.exists():
            private(record, directory=False)
            lease = json.loads(record.read_text())
            if type(lease.get("active")) is not bool:
                raise Refused("INVALID_LEASE")
            active = lease["active"]
            if active:
                container = lease.get("holder", "")
                if not isinstance(container, str) or not CAPSULE.fullmatch(container):
                    raise Refused("IDENTITY_BOUND")
        args = ["--state-dir", str(state), "--store-root", str(self.root)]
        if not active:
            # Request the native-valid name explicitly; consume only validated
            # native evidence for subsequent control paths (surface.go:184).
            reply = self.native("srf-identity-surface", ["start", "--identity", identity, "--kind", "browser",
                                                          "--capsule", "srf-id-" + identity, *args])
            container = reply.get("container")
            if not isinstance(container, str) or not CAPSULE.fullmatch(container):
                raise Refused("NATIVE_ID_MISMATCH")
        views = state / "views"
        views.mkdir(mode=0o700, exist_ok=True)
        private(views)
        pending = views / (container + ".login-pending")
        fd = os.open(pending, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        os.close(fd)
        child = None
        restored = False
        try:
            child = subprocess.Popen([str(self.bin_dir / "srf-identity-surface"), "login", "--container", container, *args],
                                     stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            announcement = json.loads(child.stdout.readline(65537))
            url = announcement.get("url", "")
            parsed = urlsplit(url)
            if parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "localhost", "::1") or parsed.username or parsed.password:
                raise Refused("NATIVE_VIEW_INVALID")
            print("Operator login view: " + url + " (close with Ctrl+C or native view-stop)", file=sys.stderr)
            try:
                rc = child.wait()
            except KeyboardInterrupt:
                child.send_signal(signal.SIGINT)
                rc = child.wait(timeout=180)
            if rc:
                raise Refused("LOGIN_VIEW_FAILED")
            self.native("srf-identity-surface", ["view-stop", "--container", container, *args], absent_ok=True)
            restored = True
        finally:
            # The blocking native view restores readonly before exit. If it has
            # not exited, require native teardown before removing our reservation.
            if child is not None and child.poll() is None:
                self.native("srf-identity-surface", ["view-stop", "--container", container, *args])
                child.wait(timeout=180)
                restored = True
            if child is not None and child.stdout is not None:
                child.stdout.close()
            if restored or child is None:
                pending.unlink()
        return {"profile_id": identity, "container": container, "login_view_closed": True}


def main(argv=None):
    parser = Parser(description=__doc__)
    parser.add_argument("--store-root", default=os.environ.get("SRF_IDENTITY_STORE_ROOT"))
    parser.add_argument("--memoryweb-home", default=os.environ.get("MV_MW_HOME"))
    subs = parser.add_subparsers(dest="verb", required=True)
    for verb in ("create", "list", "show", "delete", "login"):
        sub = subs.add_parser(verb)
        if verb != "list":
            sub.add_argument("--id", required=True)
        if verb == "create":
            sub.add_argument("--label", required=True)
            sub.add_argument("--domains", required=True)
    try:
        args = parser.parse_args(argv)
        tool = Identities(args.store_root, args.memoryweb_home, os.environ.get("MV_SRF_BIN_DIR"),
                          os.environ.get("MV_SRF_STATE_DIR"))
        if args.verb == "create":
            result = tool.create(args.id, args.label, args.domains)
        elif args.verb == "list":
            result = tool.list()
        else:
            result = getattr(tool, args.verb)(args.id)
        print(json.dumps({"schema": SCHEMA, "ok": True, "result": result}, separators=(",", ":")))
        return 0
    except (Refused, OSError, ValueError, subprocess.TimeoutExpired) as exc:
        code = str(exc) if isinstance(exc, Refused) else "IDENTITY_UNAVAILABLE"
        print(json.dumps({"schema": SCHEMA, "ok": False, "error": code}, separators=(",", ":")))
        return 6


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Operator-only browser identities; no profile payload is ever opened.

[TARGET, unit decision] Native admin has create/show only. List enumerates
metadata names and calls show; delete uses the native per-id flock guard and
lease record (OpenSuperficies src/browserid/store/store.go:346-364,426-457).
MV_MW_HOME (or --memoryweb-home) is required to prove store separation.
The host menu invokes this tool; it is never an agent tool or a wire request.

[TARGET, unit decision] IDT-FIX robustness additions, all control-metadata only:
- login checks native profile provisioning (private 0700, uid 10001, surface.go:405)
  before `start` and names the missing step (PROFILE_MISSING, PROFILE_NOT_PROVISIONED);
- failed provisioning rolls back its newly created metadata entry while retaining
  the empty host-owned profile directory for legacy unprovisioned inspection, and
  a retry of `create` with the same name reclaims that unprovisioned empty
  host-owned directory under the per-id guard before invoking native create
  (never deleting a non-empty or uid-10001 directory, never opening payloads);
- the login reservation file records its owner (pid + /proc start time); SIGTERM/SIGHUP
  tear the view down and remove it, and a reservation whose owner is dead (SIGKILL,
  crash) is reclaimed after a native view-stop, so a killed login never bricks the id;
- `release` clears a stale active lease through the native `stop` (the only releasing
  CLI; native `Store.Reclaim` has no CLI), `status` reports lease, provisioning,
  login reservation and whether a login was recorded (never a current-session claim);
- product `mv-` names remain reserved for creation and protected from deletion;
  existing product profiles can log in through the normal provisioning gate;
- foreign identity prefixes and protected holders are refused before any mutating
  operation, staging, or login dispatch.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import uuid
import signal
import subprocess
import sys
import hashlib
import importlib.util
from urllib.parse import urlsplit

SCHEMA = "metaviewer.identity/v1"
ID = re.compile(r"[a-z0-9][a-z0-9-]{1,39}\Z")
# OpenSuperficies a9ac1ac8 src/browserid/surface/surface.go:184 (capsuleRE).
CAPSULE = re.compile(r"srf-(?:id|pg|vm)-[a-z0-9][a-z0-9-]{0,39}\Z")
REPO = Path(__file__).resolve().parent.parent
# Native browser capsules own their profile as a fixed uid (surface.go:405).
NATIVE_PROFILE_UID = 10001
PROFILE_TIMEOUT = 15
RESERVED_PREFIX = "mv-"
FOREIGN_PREFIXES = ("srf-id-cuentas-", "srf-id-perplexity-", "srf-pg-")
# Mirror daemon-adapter/internal/capsule/protect.go RefuseProtectedContainer.
PROTECTED_HOLDERS = frozenset({"srf-id-cuentas-1", "srf-id-perplexity-1", "srf-pg-notepad-1",
                               "srf-pg-metaviewer-1", "srf-egress-proxy", "n8n", "distil-box"})
HINTS = {
    "PROFILE_MISSING": (
        'Docker profile provisioning is required: profiles/<id> is missing; '
        'retry identity creation after checking Docker and the installed judge images.'
    ),
    "PROFILE_NOT_PROVISIONED": (
        'Docker profile provisioning failed: profiles/<id> must be private 0700 owned by uid 10001; '
        'check Docker access and the installed judge images, then retry identity creation.'
    ),
    "RESERVED_ID": "ids beginning with mv- and the live profile id are reserved for the live surface",
    "LOGIN_IN_PROGRESS": "another login view owns this identity; close it first",
    "LOGIN_TERMINATED": "login view closed after the tool was signalled; run login again",
}


class Refused(Exception):
    pass


def normal_read(path, limit=131072, private_file=True, sync=False):
    """Normal-mode control/source metadata only; never browser payload data."""
    p = Path(path)
    if not p.is_absolute() or str(p.resolve(strict=True)) != str(p):
        raise Refused('INVENTORY_CUSTODY')
    fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        before = os.fstat(fd)
        if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_uid not in (0, os.getuid())
                or before.st_mode & 0o022 or not 0 < before.st_size <= limit
                or (private_file and (before.st_uid != os.getuid() or before.st_mode & 0o077))):
            raise Refused('INVENTORY_CUSTODY')
        raw = os.read(fd, limit + 1)
        if sync:
            os.fsync(fd)
        fields = ('st_dev','st_ino','st_mode','st_uid','st_gid','st_nlink','st_size','st_mtime_ns','st_ctime_ns')
        after, now = os.fstat(fd), p.lstat()
        if len(raw) != before.st_size or any(getattr(before,k) != getattr(after,k) or getattr(before,k) != getattr(now,k) for k in fields):
            raise Refused('INVENTORY_CUSTODY')
        return raw
    finally:
        os.close(fd)


def normal_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise Refused('INVENTORY_JSON')
            result[key] = value
        return result
    return json.loads(raw.decode('utf-8','strict'), object_pairs_hook=pairs,
        parse_constant=lambda _: (_ for _ in ()).throw(Refused('INVENTORY_JSON')))


def _normal_inventory(tool):
    mode = os.environ.get('MV_ARM64_CAPSULES', '')
    if not mode:
        return None
    if mode != '1' or not os.environ.get('MV_ARM64_INVENTORY_CONFIG'):
        raise Refused('INVENTORY_REQUIRED')
    config_path = Path(os.environ['MV_ARM64_INVENTORY_CONFIG'])
    config = normal_json(normal_read(config_path))
    root = Path(config['root'])
    private(root)
    if (config_path != root / 'inventory-config.json' or tool.root != root / 'store'
            or not config.get('images', {}).get('browser')):
        raise Refused('INVENTORY_CONTEXT')
    snapshot = normal_read(root / 'setup.json')
    if hashlib.sha256(snapshot).hexdigest() != config['registry_sha256']:
        raise Refused('INVENTORY_CONTEXT')
    descriptor = normal_json(snapshot)
    own = descriptor['identity_provisioner']
    if (own != config['identity_provisioner'] or own['path'] != str(Path(__file__).resolve())
            or hashlib.sha256(normal_read(own['path'], 1 << 20, False)).hexdigest() != own['sha256']):
        raise Refused('INVENTORY_SOURCE')
    pin = descriptor['reconciler']
    if (Path(pin['path']) != Path(__file__).resolve().with_name('arm64_capsule_reconcile.py')
            or hashlib.sha256(normal_read(pin['path'], 1 << 20, False)).hexdigest() != pin['sha256']):
        raise Refused('INVENTORY_SOURCE')
    spec = importlib.util.spec_from_file_location('identity_inventory', pin['path'])
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    checked, _ = module.load_config(config_path)
    if checked != config:
        raise Refused('INVENTORY_CONTEXT')
    expected_bin = Path(descriptor['native']['srf-identity-admin']['path']).parent
    if tool.bin_dir != expected_bin:
        raise Refused('INVENTORY_CONTEXT')
    return module, config_path, config


def normal_inventory(tool):
    try:
        return _normal_inventory(tool)
    except Refused:
        raise
    except (KeyError, TypeError, ValueError, OSError, ImportError) as error:
        raise Refused('INVENTORY_REQUIRED') from error


def identity_append(context, payload):
    module, path, _ = context
    return module.append_identity_helper(path, {'producer': 'setup', **payload}, Path(__file__).resolve())


def normal_cid(path):
    raw = normal_read(path, 128, sync=True)
    value = (raw[:-1] if raw.endswith(b'\n') else raw).decode('ascii','strict')
    if not re.fullmatch('[0-9a-f]{64}', value):
        raise Refused('INVENTORY_CID')
    return value


def normal_absent(cid):
    p = subprocess.run(['/usr/bin/docker','container','ls','--all','--no-trunc','--format','{{.ID}}'],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5, check=False)
    if type(p.returncode) is not int or p.returncode != 0 or len(p.stdout) > 1 << 20:
        raise Refused('INVENTORY_ABSENCE_UNKNOWN')
    rows = p.stdout.decode('ascii','strict').splitlines()
    if not all(re.fullmatch('[0-9a-f]{64}', row) for row in rows):
        raise Refused('INVENTORY_ABSENCE_UNKNOWN')
    return cid not in rows


def normal_helper_owned(cid, name, image, target, run_id, script, identity):
    identity_format = ('[{"Id":{{json .Id}},"Name":{{json .Name}},"Image":{{json .Image}},'
                       '"Run":{{json (index .Config.Labels "metaviewer.arm64-run")}}}]')
    p = subprocess.run(['/usr/bin/docker','container','inspect',cid,'--format',identity_format], stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5, check=False)
    if type(p.returncode) is not int or p.returncode != 0 or len(p.stdout) > 4096:
        return False
    first = normal_json(p.stdout)
    if (type(first) is not list or len(first) != 1 or type(first[0]) is not dict
            or first[0] != {'Id':cid,'Name':'/'+name,'Image':image,'Run':run_id}):
        return False
    # Select only required fields; never read Config.Env or unrelated metadata.
    observed_format = ('[{"Id":{{json .Id}},"Name":{{json .Name}},"Image":{{json .Image}},'
        '"Config":{"Labels":{"metaviewer.arm64-run":{{json (index .Config.Labels "metaviewer.arm64-run")}}},'
        '"Entrypoint":{{json .Config.Entrypoint}},"User":{{json .Config.User}},"Cmd":{{json .Config.Cmd}}},'
        '"HostConfig":{"NetworkMode":{{json .HostConfig.NetworkMode}},"AutoRemove":{{json .HostConfig.AutoRemove}},'
        '"Privileged":{{json .HostConfig.Privileged}},"Memory":{{json .HostConfig.Memory}},'
        '"MemorySwap":{{json .HostConfig.MemorySwap}},"PidsLimit":{{json .HostConfig.PidsLimit}},'
        '"NanoCpus":{{json .HostConfig.NanoCpus}},"SecurityOpt":{{json .HostConfig.SecurityOpt}}},'
        '"Mounts":{{json .Mounts}}}]')
    p = subprocess.run(['/usr/bin/docker','container','inspect',cid,'--format',observed_format], stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5, check=False)
    if type(p.returncode) is not int or p.returncode != 0 or len(p.stdout) > 131072:
        return False
    rows = normal_json(p.stdout)
    if type(rows) is not list or len(rows) != 1 or type(rows[0]) is not dict:
        return False
    obj = rows[0]
    config, host = obj.get('Config', {}), obj.get('HostConfig', {})
    mounts = obj.get('Mounts', [])
    if (type(config) is not dict or type(host) is not dict or type(mounts) is not list
            or len(mounts) != 1 or type(mounts[0]) is not dict
            or type(config.get('Labels')) is not dict):
        return False
    return (obj.get('Id') == cid and obj.get('Name') == '/' + name and obj.get('Image') == image
        and config.get('Labels', {}).get('metaviewer.arm64-run') == run_id
        and config.get('Entrypoint') == ['/bin/sh'] and config.get('User') == '0'
        and config.get('Cmd') == ['-c', script, 'mv-profile-helper', identity]
        and host.get('NetworkMode') == 'none' and host.get('AutoRemove') is True
        and host.get('Privileged') is False and host.get('Memory') == 128 * 1024**2
        and host.get('MemorySwap') == 128 * 1024**2 and host.get('PidsLimit') == 16
        and host.get('NanoCpus') == 250000000
        and host.get('SecurityOpt') in (['no-new-privileges'], ['no-new-privileges=true'])
        and len(mounts) == 1 and mounts[0].get('Type') == 'bind'
        and mounts[0].get('Source') == str(target.parent) and mounts[0].get('Destination') == '/profiles')


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise Refused("INVALID_ARGUMENTS")


def profile_image():
    """[TARGET, unit decision] Use only locally installed judge images.

    Match step_profile's architecture and versions; prefer the Open image when
    installed, otherwise require the legacy judge image. No pulls or host sudo.
    The caller's asynchronous Python child keeps Docker off Electron's thread.
    """
    arch = {"x86_64": "x64", "aarch64": "arm64"}.get(os.uname().machine)
    if arch is None:
        raise Refused("PROFILE_NOT_PROVISIONED")
    for version in ("0.2.0", "0.1.1"):
        image = "opensuperficies-identity-browser-" + arch + ":" + version
        try:
            result = subprocess.run(["docker", "image", "inspect", image],
                                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                    stderr=subprocess.DEVNULL, timeout=20, check=False)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise Refused("PROFILE_NOT_PROVISIONED") from exc
        if result.returncode == 0:
            return image
    raise Refused("PROFILE_NOT_PROVISIONED")


def checked_id(value):
    if not isinstance(value, str) or not ID.fullmatch(value):
        raise Refused("INVALID_ID")
    return value


def foreign_identity(value):
    return value.startswith(FOREIGN_PREFIXES) or value in PROTECTED_HOLDERS


def operational_id(value):
    value = checked_id(value)
    if foreign_identity(value):
        raise Refused("IDENTITY_PROTECTED")
    return value


def protected_identity(value):
    return value.startswith(RESERVED_PREFIX) or foreign_identity(value)


def fresh_id(value, live_profile=None):
    value = operational_id(value)
    if value.startswith(RESERVED_PREFIX) or (live_profile and value == live_profile):
        raise Refused("RESERVED_ID")
    return value


def starttime(pid):
    """Kernel start time of a pid (clock ticks) or None; guards pid reuse."""
    try:
        raw = Path("/proc/%d/stat" % pid).read_text()
        return int(raw.rsplit(")", 1)[1].split()[19])
    except (OSError, ValueError, IndexError):
        return None


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
    def __init__(self, root, memoryweb_home, bin_dir, state_dir=None, profile_uid=None,
                 live_profile=None):
        self.profile_uid = NATIVE_PROFILE_UID if profile_uid is None else profile_uid
        self.live_profile = live_profile
        self.root = absolute(root)
        home = absolute(memoryweb_home)
        if overlap(self.root, REPO) or overlap(self.root, home):
            raise Refused("MUT-PROFILE-IN-REPO")
        self.bin_dir = absolute(bin_dir)
        self.state_dir = state_dir
        if self.root.exists():
            private(self.root)

    def native(self, binary, args, timeout=180, absent_ok=False):
        if os.environ.get('MV_ARM64_CAPSULES') and binary == 'srf-identity-surface':
            context = normal_inventory(self)
            identity_append(context, {'stage': 'unknown', 'id': 'identity-mutation-' + uuid.uuid4().hex[:24],
                                     'reason': 'direct_native_surface_mutation'})
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

    def create(self, identity, label, domains="", browser="browser"):
        if os.environ.get('MV_ARM64_CAPSULES'):
            normal_inventory(self)  # Before even metadata-only create/reclaim.
        fresh_id(identity, self.live_profile)
        if not label or label != label.strip() or len(label) > 128 or any(ord(c) < 32 for c in label):
            raise Refused("INVALID_LABEL")
        if browser not in ("browser", "program"):
            raise Refused("INVALID_ARGUMENTS")
        sites = domains.split(",") if domains else []
        if browser == "program":
            if domains:
                raise Refused("INVALID_DOMAINS")
        elif len(sites) > 16 or sites != sorted(set(sites)) or not all(re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", d) for d in sites):
            raise Refused("INVALID_DOMAINS")
        created_new = True
        if browser == "program" and (self.root / "metadata" / (identity + ".json")).exists():
            existing = self.show(identity)
            if existing.get("browser") != "program":
                raise Refused("PROFILE_ALREADY_BOUND")
            created_new = False
        if created_new:
            self.reclaim_unprovisioned_profile(identity)
            native_args = ["create", "--store-root", str(self.root), "--id", identity, "--label", label]
            native_args.extend(["--browser", "program"] if browser == "program" else ["--domains", domains])
            self.native("srf-identity-admin", native_args)
        try:
            result = self.show(identity)
            self.provision(identity)
            return result
        except Exception:
            if created_new:
                # Roll back only the entry this successful create introduced. The
                # native per-id guard prevents deleting a concurrently bound entry.
                locks = self.root / "locks"
                private(locks)
                fd = os.open(locks / (identity + ".guard"), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
                with os.fdopen(fd, "r+") as guard:
                    fcntl.flock(guard, fcntl.LOCK_EX)
                    lease = self.lease(identity)
                    if lease is None or lease["active"] is False:
                        metadata = self.root / "metadata" / (identity + ".json")
                        if metadata.exists():
                            private(metadata, directory=False)
                            metadata.unlink()
            raise

    def reclaim_unprovisioned_profile(self, identity):
        """Reclaim an empty host-owned profile left by a rolled-back create; never open payloads."""
        identity = fresh_id(identity, self.live_profile)
        if not self.root.exists():
            return
        private(self.root)
        locks = self.root / "locks"
        profiles = self.root / "profiles"
        if not locks.exists() or not profiles.exists():
            return
        private(locks)
        target = self.profile_path(identity)
        fd = os.open(locks / (identity + ".guard"), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "r+") as guard:
            fcntl.flock(guard, fcntl.LOCK_EX)
            metadata = self.root / "metadata" / (identity + ".json")
            if metadata.exists() or metadata.is_symlink():
                return
            lease = self.lease(identity)
            if lease is not None and lease["active"]:
                raise Refused("IDENTITY_BOUND")
            try:
                st = target.lstat()
            except FileNotFoundError:
                return
            if not stat.S_ISDIR(st.st_mode):
                raise Refused("UNSAFE_IDENTITY_PATH")
            # Only an unprovisioned directory still owned by the host caller uid
            # (mode 0700, empty via os.rmdir) is eligible; never remove data.
            if (st.st_uid == os.getuid() and st.st_uid != NATIVE_PROFILE_UID and
                    stat.S_IMODE(st.st_mode) == 0o700):
                try:
                    target.rmdir()
                except OSError:
                    pass

    def list(self):
        metadata = self.root / "metadata"
        private(metadata)
        return [self.show(checked_id(p.stem)) for p in sorted(metadata.glob("*.json"))]

    def delete(self, identity):
        identity = checked_id(identity)
        if protected_identity(identity) or identity == self.live_profile:
            raise Refused("IDENTITY_PROTECTED")
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
            profile = self.profile_path(identity)
            if metadata.is_symlink() or profile.is_symlink() or not metadata.is_file() or (profile.exists() and not profile.is_dir()):
                raise Refused("UNSAFE_IDENTITY_PATH")
            # Keep the entry until privileged removal succeeds, so a failed
            # helper (or a crash after removal) can be retried under this guard.
            self._deleting_identity = identity
            try:
                self.profile_helper(identity, remove=True)
            finally:
                del self._deleting_identity
            metadata.unlink()
            record.unlink(missing_ok=True)
            # Never unlink the guard: a waiter must retain the same flock inode.
        return {"deleted": identity}

    def profile_path(self, identity):
        """Validate only directory metadata; never inspect browser payloads."""
        identity = checked_id(identity)
        profiles = self.root / "profiles"
        if any(c in str(profiles) for c in (",", "\n", "\r")):
            raise Refused("UNSAFE_IDENTITY_PATH")
        private(self.root)
        private(profiles)
        if profiles.resolve(strict=True) != profiles or profiles.parent != self.root:
            raise Refused("UNSAFE_IDENTITY_PATH")
        target = profiles / identity
        if target.is_symlink() or target.resolve() != target or target.parent != profiles:
            raise Refused("UNSAFE_IDENTITY_PATH")
        if target.exists() and not stat.S_ISDIR(target.lstat().st_mode):
            raise Refused("UNSAFE_IDENTITY_PATH")
        return target

    def profile_helper(self, identity, remove=False):
        identity = operational_id(identity)
        target = self.profile_path(identity)
        context = normal_inventory(self)
        # Removal retains the entry until success. Delete holds the native guard
        # and this check refuses removal of any actively leased profile.
        if remove:
            if getattr(self, "_deleting_identity", None) != identity:
                raise Refused("IDENTITY_BOUND")
            metadata = self.root / "metadata" / (identity + ".json")
            if metadata.is_symlink() or not metadata.is_file():
                raise Refused("UNSAFE_IDENTITY_PATH")
            self.show(identity)
            lease = self.lease(identity)
            if lease is not None and lease["active"]:
                raise Refused("IDENTITY_BOUND")
        else:
            self.show(identity)
        image = context[2]['images']['browser'] if context else profile_image()
        name = "mv-provision-" + identity + "-" + uuid.uuid4().hex[:12]
        receipts = self.root / "locks" / "profile-helpers"
        receipts.mkdir(mode=0o700, exist_ok=True)
        private(receipts)
        cidfile = receipts / (name + ".cid")
        receipt = receipts / (name + ".json")
        script = ('set -eu; p="/profiles/$1"; test ! -L "$p"; '
                  'test "$(realpath "$p")" = "$p"; ')
        if remove:
            script += 'rm -rf -- "$p"; test ! -e "$p"; test ! -L "$p"'
        else:
            script += ('mkdir -p -- "$p"; test -d "$p"; test ! -L "$p"; '
                       'cd -P -- "$p"; test "$PWD" = "$p"; chown 10001:10001 .; chmod 0700 .')
        command = ["docker", "run", "--rm", "--pull=never", "--name", name, "--cidfile", str(cidfile),
                   "--network", "none", "--user", "0", "--entrypoint", "/bin/sh",
                   "--mount", "type=bind,src=" + str(target.parent) + ",dst=/profiles",
                   image, "-c", script, "mv-profile-helper", identity]
        bound = False
        if context:
            if not target.exists():
                target.mkdir(mode=0o700)
            before = target.lstat()
            if not stat.S_ISDIR(before.st_mode) or stat.S_IMODE(before.st_mode) != 0o700:
                raise Refused('INVENTORY_PAYLOAD')
            command[0] = '/usr/bin/docker'
            command[2:2] = ['--label', 'metaviewer.arm64-run=' + context[2]['run_id']]
            command[2:2] = ['--memory','128m','--memory-swap','128m','--pids-limit','16',
                            '--cpus','0.25','--security-opt','no-new-privileges']
            if remove:
                identity_append(context, {'stage':'unknown', 'id':'identity-mutation-' + uuid.uuid4().hex[:24],
                                         'reason':'direct_identity_profile_remove'})
            identity_append(context, {'stage':'helper_pending', 'id':name, 'name':name, 'image_id':image,
                'payload':str(target), 'payload_device':before.st_dev, 'payload_inode':before.st_ino})
        try:
            old_umask = os.umask(0o077) if context else None
            try:
                result = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                        stderr=subprocess.DEVNULL, timeout=PROFILE_TIMEOUT, check=False)
            finally:
                if old_umask is not None:
                    os.umask(old_umask)
            if result.returncode or (context and type(result.returncode) is not int):
                raise Refused("PROFILE_NOT_PROVISIONED")
            if context:
                cid = normal_cid(cidfile)
                identity_append(context, {'stage':'helper_bound', 'id':name, 'cid':cid})
                bound = True
            self.profile_path(identity)  # Repeat containment after the helper.
            if remove:
                if target.exists() or target.is_symlink():
                    raise Refused("PROFILE_NOT_PROVISIONED")
            else:
                st = target.lstat()
                if (not stat.S_ISDIR(st.st_mode) or st.st_uid != NATIVE_PROFILE_UID or
                        st.st_gid != NATIVE_PROFILE_UID or stat.S_IMODE(st.st_mode) != 0o700):
                    raise Refused("PROFILE_NOT_PROVISIONED")
            if context:
                if not remove and (st.st_dev, st.st_ino) != (before.st_dev, before.st_ino):
                    raise Refused('INVENTORY_PAYLOAD_CHANGED')
                if not normal_absent(cid):
                    raise Refused('INVENTORY_ABSENCE_UNKNOWN')
                identity_append(context, {'stage':'helper_removed', 'id':name})
            cidfile.unlink(missing_ok=True)
        except (OSError, subprocess.TimeoutExpired, Refused, ValueError) as exc:
            if context is None and isinstance(exc, ValueError):
                raise  # Preserve the unset-mode exception behavior.
            # A failed name-based create proves no ownership. Only Docker's
            # private CID file can authorize cleanup; never remove by name.
            cid = None
            if context is None:
                try:
                    fd = os.open(cidfile, os.O_RDONLY | os.O_NOFOLLOW)
                    with os.fdopen(fd, "r") as source:
                        st = os.fstat(source.fileno())
                        if stat.S_ISREG(st.st_mode) and st.st_uid == os.getuid() and st.st_size <= 128:
                            value = source.read(129).strip()
                            if re.fullmatch(r"[0-9a-f]{64}", value):
                                cid = value
                except (OSError, UnicodeError):
                    pass
            if context:
                try:
                    cid = normal_cid(cidfile)
                    if not bound:
                        identity_append(context, {'stage':'helper_bound', 'id':name, 'cid':cid})
                        bound = True
                    identity_append(context, {'stage':'unknown', 'id':name, 'reason':'identity_helper_outcome_unknown'})
                except (Refused, OSError, ValueError):
                    cid = None  # Unbound/foreign/poisoned evidence never authorizes removal.
            if cid:
                record = {"schema":"metaviewer.profile_helper/v1", "profile_id":identity,
                          "container_id":cid, "container_name":name, "state":"cleanup_pending"}
                fd = os.open(receipt, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                with os.fdopen(fd,"w") as sink:
                    json.dump(record,sink); sink.flush(); os.fsync(sink.fileno())
                try:
                    if context and not normal_helper_owned(cid, name, image, target, context[2]['run_id'], script, identity):
                        raise Refused('INVENTORY_HELPER_FOREIGN')
                    cleanup = subprocess.run(["/usr/bin/docker" if context else "docker", "rm", "-f", cid], stdin=subprocess.DEVNULL,
                                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                             timeout=5, check=False)
                    if cleanup.returncode == 0 and not context:
                        receipt.unlink(); cidfile.unlink(missing_ok=True)
                except (OSError, subprocess.TimeoutExpired, Refused, ValueError):
                    pass  # Durable control receipt retains ownership for recovery.

            raise Refused("PROFILE_NOT_PROVISIONED") from exc

    def provision(self, identity):
        identity = fresh_id(identity, self.live_profile)
        locks = self.root / "locks"
        private(locks)
        fd = os.open(locks / (identity + ".guard"), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "r+") as guard:
            fcntl.flock(guard, fcntl.LOCK_EX)
            lease = self.lease(identity)
            if lease is not None and lease["active"]:
                raise Refused("IDENTITY_BOUND")
            self.profile_helper(identity)

    def profile_state(self, identity):
        """ok | missing | unsafe, from lstat metadata only (never opens the profile)."""
        try:
            st = (self.root / "profiles" / identity).lstat()
        except FileNotFoundError:
            return "missing"
        if (st.st_mode & 0o170000) != 0o040000 or st.st_mode & 0o777 != 0o700 or st.st_uid != self.profile_uid:
            return "unsafe"
        return "ok"

    def lease(self, identity):
        """None when never acquired, else the validated control record."""
        record = self.root / "locks" / (identity + ".json")
        if not (record.exists() or record.is_symlink()):
            return None
        private(record, directory=False)
        lease = json.loads(record.read_text())
        if not isinstance(lease, dict) or type(lease.get("active")) is not bool:
            raise Refused("INVALID_LEASE")
        return lease

    @staticmethod
    def pending_state(pending):
        """none | live | stale | unknown; unavailable process evidence never proves staleness."""
        if not (pending.exists() or pending.is_symlink()):
            return "none"
        private(pending, directory=False)
        fd = os.open(pending, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, "rb") as source:
            raw = source.read(257)
        try:
            owner = json.loads(raw)
            pid, start = owner["pid"], owner["start"]
            if type(pid) is not int or pid < 1:
                raise ValueError
        except (ValueError, KeyError, TypeError):
            return "stale"  # Ownerless (legacy or torn) reservation: nothing proves a live owner.
        current = starttime(pid)
        if current is None:
            try:
                Path("/proc/%d" % pid).stat()
            except FileNotFoundError:
                # A missing /proc mount is not evidence that this owner died.
                return "unknown" if starttime(os.getpid()) is None else "stale"
            except OSError:
                pass
            return "unknown"
        if type(start) is not int:
            return "unknown"
        return "live" if current == start else "stale"

    def status(self, identity):
        identity = checked_id(identity)
        row = self.show(identity)
        try:
            lease = self.lease(identity)
            lease_state = "absent" if lease is None else ("active" if lease["active"] else "inactive")
        except (Refused, ValueError, OSError):
            lease_state = "invalid"
        views = None if self.state_dir is None else absolute(self.state_dir) / "views"
        pending = "unknown" if views is None else "none"
        if views is not None and lease_state in ("active", "inactive"):
            holder = lease.get("holder") if lease else None
            names = [holder if isinstance(holder, str) and CAPSULE.fullmatch(holder) else "srf-id-" + identity]
            try:
                pending = self.pending_state(views / (names[0] + ".login-pending"))
            except (Refused, OSError):
                pending = "invalid"
        stamp = row.get("last_login_unix")
        # A recorded login is history, not proof that the session is still authenticated.
        return {"profile_id": identity, "provisioned": self.profile_state(identity) == "ok",
                "lease": lease_state, "login_pending": pending,
                "login_recorded": "yes" if type(stamp) is int and stamp > 0 else "no"}

    # [TARGET, unit decision] Shared admission records are the cross-session
    # ownership witness. No record, an unsafe record or an observable PID never
    # proves death. Hold the admission flock through native release and removal.
    def dead_session(self, identity, observer_pid=None):
        directory = os.environ.get("MV_RAM_ADMISSION_DIR")
        if not directory:
            runtime = os.environ.get("XDG_RUNTIME_DIR")
            if not runtime or not Path(runtime).is_absolute():
                raise Refused("OWNER_UNPROVEN")
            directory = str(Path(runtime) / "metaviewer" / "ram-admission")
        root = absolute(directory)
        if root != Path(directory):
            raise Refused("OWNER_UNPROVEN")
        private(root)
        fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            # Only the modern explicit profile suffix identifies custody.
            # Legacy hash-only records remain unproven and cannot authorize release.
            pattern = re.compile(r"([1-9][0-9]*)-[0-9a-f]{32}-[0-9a-f]{64}--" +
                                 re.escape(identity) + r"\Z")
            records = []
            for name in os.listdir(fd):
                match = pattern.fullmatch(name)
                if not match:
                    # Unknown/legacy custody could refer to this same profile.
                    if not re.fullmatch(r"[1-9][0-9]*-[0-9a-f]{32}-[0-9a-f]{64}--[a-z0-9][a-z0-9-]{0,63}", name):
                        raise Refused("OWNER_UNPROVEN")
                    continue
                st = os.stat(name, dir_fd=fd, follow_symlinks=False)
                if (not stat.S_ISREG(st.st_mode) or stat.S_IMODE(st.st_mode) != 0o600
                        or st.st_uid != os.getuid() or st.st_nlink != 1 or st.st_size != 0):
                    raise Refused("OWNER_UNPROVEN")
                pid = int(match[1])
                if pid == observer_pid:
                    if pid in (os.getpid(), os.getppid()) or pid <= 1:
                        raise Refused("OWNER_UNPROVEN")
                    # The caller may exclude only its own adapter child, whose
                    # pending refusal has no binding. Another session is never excluded.
                    raw = Path("/proc/%d/stat" % pid).read_text().rsplit(")", 1)[1].split()
                    if int(raw[1]) != os.getppid():
                        raise Refused("OWNER_UNPROVEN")
                    continue
                # PID reuse is conservative: any current process keeps custody.
                if starttime(os.getpid()) is None:
                    raise Refused("OWNER_UNPROVEN")
                try:
                    Path("/proc/%d" % pid).stat()
                except FileNotFoundError:
                    records.append(name)
                else:
                    # A zombie has exited and cannot own an executing session;
                    # its unreaped /proc entry is not evidence of a live owner.
                    try:
                        state = Path("/proc/%d/stat" % pid).read_text().rsplit(")", 1)[1].split()[0]
                    except (OSError, IndexError):
                        raise Refused("OWNER_UNPROVEN")
                    if state != "Z":
                        raise Refused("OWNER_ALIVE")
                    records.append(name)
            if not records:
                raise Refused("OWNER_UNPROVEN")
            return fd, records
        except BaseException:
            os.close(fd)
            raise

    def recovery(self, identity):
        identity = operational_id(identity)
        self.show(identity)
        lease = self.lease(identity)
        holder = lease.get("holder") if lease and lease["active"] else None
        if holder is None:
            return {"held": False}
        if (not isinstance(holder, str) or not CAPSULE.fullmatch(holder)
                or not holder.startswith("srf-id-") or foreign_identity(holder)):
            raise Refused("PROTECTED_CONTAINER")
        return {"held": True, "holder": holder}

    def recover(self, identity, holder, observer_pid=None):
        identity = operational_id(identity)
        observed = self.recovery(identity)
        if not observed["held"] or observed["holder"] != holder:
            raise Refused("HOLDER_MISMATCH")
        fd, records = self.dead_session(identity, observer_pid)
        try:
            context = subprocess.run(["docker", "context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"],
                                     check=True, capture_output=True, text=True, timeout=15)
            endpoint = json.loads(context.stdout)
            if not isinstance(endpoint, str) or not endpoint.startswith("unix:///"):
                raise Refused("OWNER_UNPROVEN")
            result = self.release(identity, holder)
            # Release success alone is insufficient: stopped containers and
            # surviving view registrations must also be absent before reuse.
            out = subprocess.run(["docker", "ps", "-a", "--format", "{{.Names}}"],
                                 check=True, capture_output=True, text=True, timeout=15)
            names = out.stdout.splitlines()
            if any(not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]*", name) for name in names):
                raise Refused("RELEASE_UNVERIFIED")
            if holder in names:
                raise Refused("RELEASE_UNVERIFIED")
            views = absolute(self.state_dir) / "views"
            if any((views / (holder + suffix)).exists() or (views / (holder + suffix)).is_symlink()
                   for suffix in (".pid", ".login-pending")):
                raise Refused("RELEASE_UNVERIFIED")
            for name in records:
                os.unlink(name, dir_fd=fd)
            os.fsync(fd)
            return result
        finally:
            os.close(fd)

    def release(self, identity, holder):
        identity = operational_id(identity)
        self.show(identity)
        state = absolute(self.state_dir)
        private(state)
        lease = self.lease(identity)
        if lease is None or not lease["active"]:
            return {"released": identity, "was_active": False}
        container = lease.get("holder", "")
        if isinstance(container, str) and foreign_identity(container):
            raise Refused("PROTECTED_CONTAINER")
        if not isinstance(container, str) or not CAPSULE.fullmatch(container):
            raise Refused("IDENTITY_BOUND")
        if holder != container:
            raise Refused("HOLDER_MISMATCH")
        pending = state / "views" / (container + ".login-pending")
        if self.pending_state(pending) in ("live", "unknown"):
            raise Refused("LOGIN_IN_PROGRESS")
        args = ["--state-dir", str(state), "--store-root", str(self.root)]
        # Native stop is the only releasing CLI; it refuses when its state record is gone.
        self.native("srf-identity-surface", ["view-stop", "--container", container, *args], absent_ok=True)
        self.native("srf-identity-surface", ["stop", "--container", container, *args])
        after = self.lease(identity)
        if after is not None and after["active"]:
            raise Refused("RELEASE_UNVERIFIED")
        if self.pending_state(pending) != "none":
            pending.unlink(missing_ok=True)
        return {"released": identity, "was_active": True, "container": container,
                "capsule_removed": True, "hint": "The capsule was removed."}

    def login(self, identity):
        identity = operational_id(identity)
        self.show(identity)
        state = absolute(self.state_dir)
        private(state)
        # Start only when the exact native lease is absent/inactive. Read control
        # metadata only; never infer login success from browser profile contents.
        lease = self.lease(identity)
        active = lease is not None and lease["active"]
        if active:
            container = lease.get("holder", "")
            if isinstance(container, str) and foreign_identity(container):
                raise Refused("IDENTITY_PROTECTED")
            if not isinstance(container, str) or not CAPSULE.fullmatch(container):
                raise Refused("IDENTITY_BOUND")
        args = ["--state-dir", str(state), "--store-root", str(self.root)]
        if not active:
            # Name the missing operator step before the native start can fail generically.
            profile = self.profile_state(identity)
            if profile != "ok":
                raise Refused("PROFILE_MISSING" if profile == "missing" else "PROFILE_NOT_PROVISIONED")
            # Request a native-valid capsule name that avoids protected holders;
            # consume only validated native evidence for subsequent control paths (surface.go:184).
            requested = "srf-id-" + identity
            if foreign_identity(requested):
                requested = "srf-id-mv-" + uuid.uuid4().hex[:16]
            reply = self.native("srf-identity-surface", ["start", "--identity", identity, "--kind", "browser",
                                                          "--capsule", requested, *args])
            container = reply.get("container")
            if not isinstance(container, str) or not CAPSULE.fullmatch(container):
                raise Refused("NATIVE_ID_MISMATCH")
        views = state / "views"
        views.mkdir(mode=0o700, exist_ok=True)
        private(views)
        pending = views / (container + ".login-pending")
        view_stop = ["view-stop", "--container", container, *args]
        # Native lifecycle verbs acquire the same guard themselves; only reservation
        # reclaim/create runs under our guard, never start or the foreground view.
        locks = self.root / "locks"
        private(locks)
        guard_fd = os.open(locks / (identity + ".guard"), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(guard_fd, "r+") as guard:
            fcntl.flock(guard, fcntl.LOCK_EX)
            owner = self.pending_state(pending)
            if owner in ("live", "unknown"):
                raise Refused("LOGIN_IN_PROGRESS")
            if owner == "stale":
                self.native("srf-identity-surface", view_stop, absent_ok=True)
                pending.unlink(missing_ok=True)
            try:
                fd = os.open(pending, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
            except FileExistsError as exc:
                raise Refused("LOGIN_IN_PROGRESS") from exc
            with os.fdopen(fd, "w") as source:
                source.write(json.dumps({"pid": os.getpid(), "start": starttime(os.getpid())}))
        child = None
        restored = False
        terminated = []
        saved = {}

        def on_signal(signum, frame):
            terminated.append(signum)
            raise KeyboardInterrupt

        for signum in (signal.SIGTERM, signal.SIGHUP):
            try:
                saved[signum] = signal.signal(signum, on_signal)
            except ValueError:  # Not the main thread; the stale-owner reclaim still covers it.
                break
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
            if terminated:
                raise Refused("LOGIN_TERMINATED")
            if rc:
                raise Refused("LOGIN_VIEW_FAILED")
            self.native("srf-identity-surface", view_stop, absent_ok=True)
            restored = True
        except KeyboardInterrupt:
            # Interrupted before the view was serving (announcement/Popen window).
            if not terminated:
                terminated.append(signal.SIGINT)
            raise Refused("LOGIN_TERMINATED") from None
        finally:
            # Finish the teardown even if a second signal arrives.
            for signum in saved:
                signal.signal(signum, signal.SIG_IGN)
            try:
                # The blocking native view restores readonly before exit. If it has
                # not exited, require native teardown before removing our reservation.
                if child is not None and child.poll() is None:
                    try:
                        self.native("srf-identity-surface", view_stop, absent_ok=True)
                        child.wait(timeout=180)
                        restored = True
                    except (Refused, subprocess.TimeoutExpired):
                        if not terminated:
                            raise
                        # Keep the reservation for reclaim; preserve LOGIN_TERMINATED.
                elif child is not None and terminated:
                    # Killed with the tool: only a native view-stop proves readonly was restored.
                    try:
                        self.native("srf-identity-surface", view_stop, absent_ok=True)
                        restored = True
                    except Refused:
                        pass  # Keep reservation; preserve the termination error.
                if child is not None and child.stdout is not None:
                    child.stdout.close()
                if restored or child is None:
                    pending.unlink(missing_ok=True)
            finally:
                for signum, previous in saved.items():
                    signal.signal(signum, previous)
        return {"profile_id": identity, "container": container, "login_view_closed": True}


def main(argv=None):
    parser = Parser(description=__doc__)
    parser.add_argument("--store-root", default=os.environ.get("SRF_IDENTITY_STORE_ROOT"))
    parser.add_argument("--memoryweb-home", default=os.environ.get("MV_MW_HOME"))
    subs = parser.add_subparsers(dest="verb", required=True)
    for verb in ("create", "list", "show", "status", "delete", "login", "release", "recovery", "recover"):
        sub = subs.add_parser(verb)
        if verb != "list":
            sub.add_argument("--id", required=True)
        if verb in ("release", "recover"):
            sub.add_argument("--holder", required=True)
        if verb == "recover":
            sub.add_argument("--observer-pid", type=int)
        if verb == "create":
            sub.add_argument("--label", required=True)
            sub.add_argument("--domains", default=None)
            sub.add_argument("--browser", choices=("browser", "program"), default="browser")
    try:
        args = parser.parse_args(argv)
        tool = Identities(args.store_root, args.memoryweb_home, os.environ.get("MV_SRF_BIN_DIR"),
                          os.environ.get("MV_SRF_STATE_DIR"),
                          live_profile=os.environ.get("MV_SRF_LIVE_PROFILE") or None)
        if args.verb == "create":
            if args.browser == "browser" and args.domains is None:
                raise Refused("INVALID_ARGUMENTS")
            result = tool.create(args.id, args.label, args.domains or "", browser=args.browser)
            if tool.profile_state(args.id) != "ok":
                # stderr only: the JSON reply stays the closed public metadata shape.
                print("NOTE: " + HINTS["PROFILE_NOT_PROVISIONED"], file=sys.stderr)
        elif args.verb in ("release", "recover"):
            result = (tool.recover(args.id, args.holder, args.observer_pid) if args.verb == "recover"
                      else tool.release(args.id, args.holder))
        elif args.verb == "list":
            result = tool.list()
        else:
            result = getattr(tool, args.verb)(args.id)
        print(json.dumps({"schema": SCHEMA, "ok": True, "result": result}, separators=(",", ":")))
        return 0
    except (Refused, OSError, ValueError, subprocess.SubprocessError) as exc:
        code = str(exc) if isinstance(exc, Refused) else "IDENTITY_UNAVAILABLE"
        if code in HINTS:
            print(code + ": " + HINTS[code], file=sys.stderr)
        print(json.dumps({"schema": SCHEMA, "ok": False, "error": code}, separators=(",", ":")))
        return 6


if __name__ == "__main__":
    sys.exit(main())

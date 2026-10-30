"""Hosted identity store tests: no native capsule, network or real credential."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("mv_identity", REPO / "tools/mv_identity.py")
mv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mv)

# The fake native process alone writes/reads profile payloads. The host wrapper
# sees only the public metadata and lifecycle JSON, just like the real boundary.
FAKE = r'''
import json, os, secrets, sys
from pathlib import Path
a = sys.argv[1:]
def arg(k): return a[a.index(k)+1]
root = Path(arg('--store-root'))
verb = a[0]
identity = arg('--id') if '--id' in a else (arg('--identity') if '--identity' in a else arg('--container')[7:])
container = arg('--container') if '--container' in a else None
if container:
    matches = [p.stem for p in (root/'locks').glob('*.json')
               if json.loads(p.read_text()).get('holder') == container]
    assert len(matches) == 1
    identity = matches[0]
meta = root/'metadata'/(identity+'.json')
profile = root/'profiles'/identity
lock = root/'locks'/(identity+'.json')
if verb == 'create':
    for d in ('metadata', 'profiles', 'locks'): (root/d).mkdir(mode=0o700, parents=True, exist_ok=True)
    root.chmod(0o700)
    if meta.exists(): sys.exit(4)
    profile.mkdir(mode=0o700)
    meta.write_text(json.dumps(dict(profile_id=identity, account_label=arg('--label'), allowed_domains=arg('--domains').split(','))))
    meta.chmod(0o600)
elif verb == 'start':
    if not profile.is_dir(): sys.exit(4)
    if lock.exists() and json.loads(lock.read_text())['active']: sys.exit(6)
    container = arg('--capsule') if '--capsule' in a else 'srf-id-'+secrets.token_hex(12)
    lock.write_text(json.dumps(dict(active=True, holder=container)))
    lock.chmod(0o600)
    print(json.dumps(dict(container=container, profile_inode=profile.stat().st_ino)))
    sys.exit(0)
elif verb == 'login':
    state = Path(arg('--state-dir'))
    assert (state/'views'/(container+'.login-pending')).is_file()
    (profile/'fake-session').write_bytes(b'HOSTED-SESSION-FIXTURE')
    print(json.dumps(dict(url='http://127.0.0.1:12345/')))
    if (root/'fail-login').exists(): sys.exit(6)
    sys.exit(0)
elif verb == 'stop':
    lock.write_text(json.dumps(dict(active=False)))
    lock.chmod(0o600)
    print(json.dumps(dict(stopped='srf-id-'+identity, removed_verified=True)))
    sys.exit(0)
elif verb == 'view-stop':
    print(json.dumps(dict(stopped_view=container)))
    sys.exit(0)
print(meta.read_text())
'''


class IdentityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="identity-Música-")
        self.addCleanup(self.tmp.cleanup)
        base = Path(self.tmp.name)
        self.root, self.home, self.bin, self.state = [base / s for s in ("store", "memoryweb", "bin", "state")]
        for p in (self.home, self.bin, self.state):
            p.mkdir(mode=0o700)
        for name in ("srf-identity-admin", "srf-identity-surface"):
            p = self.bin / name
            p.write_text("#!" + sys.executable + "\n" + FAKE)
            p.chmod(0o700)
        self.tool = mv.Identities(str(self.root), str(self.home), str(self.bin), str(self.state))

    def create(self, identity="account-a"):
        return self.tool.create(identity, identity, "example.com")

    def surface(self, verb, identity="account-a"):
        key = "--identity" if verb == "start" else "--container"
        value = identity if verb == "start" else json.loads((self.root / "locks" / (identity + ".json")).read_text())["holder"]
        return self.tool.native("srf-identity-surface", [verb, key, value, "--store-root", str(self.root)])

    def test_persistent_login_restart_same_profile_and_same_site(self):
        self.create()
        self.create("account-b")
        before = self.surface("start")
        with contextlib.redirect_stderr(io.StringIO()):
            self.tool.login("account-a")
        payload = self.root / "profiles/account-a/fake-session"
        session = payload.read_bytes()
        self.surface("stop")
        after = self.surface("start")
        self.assertEqual(before["profile_inode"], after["profile_inode"])
        self.assertEqual(payload.read_bytes(), session)
        self.assertEqual([x["profile_id"] for x in self.tool.list()], ["account-a", "account-b"])
        self.assertFalse((self.home / "profiles").exists())

    def test_delete_other_preserves_active_metadata_and_profile_bytes(self):
        self.create()
        self.create("account-b")
        self.surface("start")
        with contextlib.redirect_stderr(io.StringIO()):
            self.tool.login("account-a")
        metadata = self.root / "metadata/account-a.json"
        payload = self.root / "profiles/account-a/fake-session"
        before = metadata.read_bytes(), payload.read_bytes(), payload.stat().st_ino
        with self.assertRaisesRegex(mv.Refused, "IDENTITY_BOUND"):
            self.tool.delete("account-a")
        self.tool.delete("account-b")
        self.assertEqual(before, (metadata.read_bytes(), payload.read_bytes(), payload.stat().st_ino))
        self.assertFalse((self.root / "profiles/account-b").exists())

    def test_login_starts_when_needed_and_removes_pending_after_clean_exit(self):
        self.create()
        inode = (self.root / "profiles/account-a").stat().st_ino
        with contextlib.redirect_stderr(io.StringIO()):
            self.tool.login("account-a")
        self.assertEqual(inode, (self.root / "profiles/account-a").stat().st_ino)
        self.assertTrue(json.loads((self.root / "locks/account-a.json").read_text())["active"])
        self.assertFalse((self.state / "views/srf-id-account-a.login-pending").exists())

    def test_failed_login_retains_agent_lock(self):
        self.create()
        (self.root / "fail-login").touch()
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaisesRegex(mv.Refused, "LOGIN_VIEW_FAILED"):
            self.tool.login("account-a")
        self.assertTrue((self.state / "views/srf-id-account-a.login-pending").exists())

    def test_fresh_login_uses_native_explicit_capsule(self):
        self.create()
        with contextlib.redirect_stderr(io.StringIO()):
            result = self.tool.login("account-a")
        lease = json.loads((self.root / "locks/account-a.json").read_text())
        self.assertEqual(result["container"], "srf-id-account-a")
        self.assertEqual(lease["holder"], result["container"])
        self.assertEqual(list((self.state / "views").iterdir()), [])

    def test_active_random_capsule_is_reused_without_start(self):
        self.create()
        started = self.surface("start")
        container = started["container"]
        self.assertRegex(container, r"^srf-id-[0-9a-f]{24}$")
        self.assertNotEqual(container, "srf-id-account-a")
        native = self.tool.native
        def no_start(binary, args, **kwargs):
            self.assertNotEqual(args[0], "start")
            return native(binary, args, **kwargs)
        with patch.object(self.tool, "native", side_effect=no_start), contextlib.redirect_stderr(io.StringIO()):
            result = self.tool.login("account-a")
        self.assertEqual(result["container"], container)
        self.assertTrue((self.root / "profiles/account-a/fake-session").exists())
        self.assertEqual(list((self.state / "views").iterdir()), [])

    def test_invalid_native_containers_never_open_view(self):
        self.create()
        invalid = (None, 42, "../escape", "srf-id-", "srf-id-A", "srf-id-" + "a" * 41,
                   "srf-id-safe/../../escape", "srf-id-safe\n")
        for active in (False, True):
            for container in invalid:
                with self.subTest(active=active, container=container):
                    lease = self.root / "locks/account-a.json"
                    lease.write_text(json.dumps(dict(active=active, holder=container)))
                    lease.chmod(0o600)
                    def reply(binary, args, **kwargs):
                        if args[0] == "start":
                            return {"container": container}
                        self.assertEqual(args[0], "show")
                        return {"profile_id": "account-a"}
                    with patch.object(self.tool, "native", side_effect=reply), patch.object(mv.subprocess, "Popen", side_effect=AssertionError("opened")):
                        with self.assertRaises(mv.Refused):
                            self.tool.login("account-a")
        self.assertFalse((self.state / "views").exists())

    def test_native_capsule_suffix_limit_is_enforced_before_spawn(self):
        with patch.object(mv.subprocess, "run", side_effect=AssertionError("spawned")):
            for length in range(41, 49):
                with self.subTest(length=length), self.assertRaisesRegex(mv.Refused, "INVALID_ID"):
                    self.tool.show("a" * length)
        identity = "a" * 40
        self.create(identity)
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(self.tool.login(identity)["container"], "srf-id-" + identity)

    def test_invalid_ids_never_spawn(self):
        with patch.object(mv.subprocess, "run", side_effect=AssertionError("spawned")):
            for identity in ("../account-a", "a", "a;true", "-x", "A1", "a" * 49):
                with self.subTest(identity=identity), self.assertRaises(mv.Refused):
                    self.tool.show(identity)

    def test_root_separation_including_symlinks_and_ancestors(self):
        alias = Path(self.tmp.name) / "alias"
        alias.symlink_to(self.home, target_is_directory=True)
        for root in (str(REPO / "profiles"), str(self.home / "profiles"), str(alias / "profiles"), str(REPO.parent), "relative"):
            with self.subTest(root=root), self.assertRaises(mv.Refused):
                mv.Identities(root, str(self.home), str(self.bin))

    def test_missing_memoryweb_home_fails_closed(self):
        with self.assertRaises(mv.Refused):
            mv.Identities(str(self.root), None, str(self.bin))

    def test_symlink_profile_refused_without_touching_target(self):
        self.create()
        profile = self.root / "profiles/account-a"
        profile.rmdir()
        profile.symlink_to(self.home, target_is_directory=True)
        sentinel = self.home / "sentinel"
        sentinel.write_text("unchanged")
        with self.assertRaises(mv.Refused):
            self.tool.delete("account-a")
        self.assertEqual(sentinel.read_text(), "unchanged")

    def test_corrupt_lease_is_not_inactive(self):
        self.create()
        lock = self.root / "locks/account-a.json"
        lock.write_text('{}')
        lock.chmod(0o600)
        with self.assertRaises(mv.Refused):
            self.tool.delete("account-a")

    def test_cli_emits_one_json_line_and_keeps_credentials_absent(self):
        env = dict(os.environ, SRF_IDENTITY_STORE_ROOT=str(self.root), MV_MW_HOME=str(self.home), MV_SRF_BIN_DIR=str(self.bin))
        for args, rc in ((["create", "--id", "account-a", "--label", "main", "--domains", "example.com"], 0),
                         (["show", "--id", "../escape"], 6), (["list"], 0), (["show"], 6)):
            p = subprocess.run([sys.executable, str(REPO / "tools/mv_identity.py"), *args], env=env, capture_output=True, text=True)
            self.assertEqual(p.returncode, rc, p.stderr)
            self.assertEqual(len(p.stdout.splitlines()), 1)
            self.assertEqual(json.loads(p.stdout)["schema"], "metaviewer.identity/v1")
            self.assertNotIn("HOSTED-SESSION-FIXTURE", p.stdout)


if __name__ == "__main__":
    unittest.main()

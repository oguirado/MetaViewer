"""Hosted identity store tests: no native capsule, network or real credential."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch, Mock

REPO = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("mv_identity", REPO / "tools/mv_identity.py")
mv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mv)

# The fake native process alone writes/reads profile payloads. The host wrapper
# sees only the public metadata and lifecycle JSON, just like the real boundary.
FAKE = r'''
import json, os, secrets, sys, time
from pathlib import Path
a = sys.argv[1:]
def arg(k): return a[a.index(k)+1]
root = Path(arg('--store-root'))
verb = a[0]
root.mkdir(mode=0o700, exist_ok=True)
with (root/'native-calls.jsonl').open('a') as calls: calls.write(json.dumps(a)+'\n')
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
    hanging = (root/'hang-login').exists()
    print(json.dumps(dict(url='http://127.0.0.1:12345/')), flush=True)
    if hanging:
        for _ in range(1200):
            if (root/'release-login').exists():
                (root/('released-'+identity)).touch()
                break
            time.sleep(0.05)
    if (root/'fail-login').exists(): sys.exit(6)
    sys.exit(0)
elif verb == 'stop':
    lock.write_text(json.dumps(dict(active=False)))
    lock.chmod(0o600)
    print(json.dumps(dict(stopped='srf-id-'+identity, removed_verified=True)))
    sys.exit(0)
elif verb == 'view-stop':
    (root/'release-login').touch()
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
        # The fake native process cannot chown to the native profile uid; the host
        # provisioning check is exercised against the real default in its own tests.
        self.tool = mv.Identities(str(self.root), str(self.home), str(self.bin), str(self.state), profile_uid=os.getuid())

    def holder(self, identity="account-a"):
        return json.loads((self.root / "locks" / (identity + ".json")).read_text()).get("holder", "srf-id-account-a")

    def calls(self):
        return [json.loads(line) for line in (self.root / "native-calls.jsonl").read_text().splitlines()]

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

    # --- IDT-FIX: provisioning, mid-login kill, reserved ids, status, release ---

    def run_tool(self, *args, **kwargs):
        env = dict(os.environ, SRF_IDENTITY_STORE_ROOT=str(self.root), MV_MW_HOME=str(self.home),
                   MV_SRF_BIN_DIR=str(self.bin), MV_SRF_STATE_DIR=str(self.state))
        env.update(kwargs)
        # The wrapper only swaps the fake-incompatible native owner uid; no other product line changes.
        wrapper = ("import importlib.util as u,os,sys;s=u.spec_from_file_location('m',sys.argv[1]);m=u.module_from_spec(s);"
                   "s.loader.exec_module(m);m.NATIVE_PROFILE_UID=os.getuid();sys.exit(m.main(sys.argv[2:]))")
        return subprocess.Popen([sys.executable, "-c", wrapper, str(REPO / "tools/mv_identity.py"), *args], env=env, text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def start_hanging_login(self, identity="account-a"):
        (self.root / "hang-login").touch()
        proc = self.run_tool("login", "--id", identity)
        def cleanup():
            (self.root / "release-login").touch()  # Lets an orphaned fake native view exit.
            if proc.poll() is None:
                proc.kill()
            proc.wait()
            proc.stdout.close()
            proc.stderr.close()
        self.addCleanup(cleanup)
        line = proc.stderr.readline()  # Blocks until the view is announced; the test timeout is the harness gate.
        self.assertIn("Operator login view: http://127.0.0.1", line)
        return proc

    def only_show(self, tool):
        """Patch target: native read-only `show` passes; any lifecycle verb fails the test."""
        native = tool.native
        def guard(binary, args, **kwargs):
            self.assertEqual(args[0], "show", "lifecycle verb reached native: %r" % (args[0],))
            return native(binary, args, **kwargs)
        return patch.object(tool, "native", side_effect=guard)

    def test_login_after_ui_only_create_names_missing_provisioning(self):
        strict = mv.Identities(str(self.root), str(self.home), str(self.bin), str(self.state))  # real uid 10001 policy
        strict.create("account-a", "account-a", "example.com")
        with self.only_show(strict), self.assertRaisesRegex(mv.Refused, "^PROFILE_NOT_PROVISIONED$"):
            strict.login("account-a")
        self.assertFalse((self.root / "locks/account-a.json").exists())  # No native start was attempted.
        (self.root / "profiles/account-a").rmdir()
        with self.assertRaisesRegex(mv.Refused, "^PROFILE_MISSING$"):
            strict.login("account-a")
        (self.root / "profiles/account-a").mkdir()
        (self.root / "profiles/account-a").chmod(0o755)
        self.tool.profile_uid = os.getuid()
        with self.assertRaisesRegex(mv.Refused, "^PROFILE_NOT_PROVISIONED$"):
            self.tool.login("account-a")  # Right owner, wrong mode.

    def test_cli_names_missing_step_on_stderr_only(self):
        env = dict(os.environ, SRF_IDENTITY_STORE_ROOT=str(self.root), MV_MW_HOME=str(self.home),
                   MV_SRF_BIN_DIR=str(self.bin), MV_SRF_STATE_DIR=str(self.state))
        tool = str(REPO / "tools/mv_identity.py")
        cmd_hint = 'sudo install -d -m 0700 -o 10001 -g 10001 "$SRF_IDENTITY_STORE_ROOT/profiles/<id>"'
        made = subprocess.run([sys.executable, tool, "create", "--id", "account-a", "--label", "a", "--domains", "example.com"],
                              env=env, capture_output=True, text=True)
        self.assertEqual(made.returncode, 0)
        self.assertIn("uid 10001", made.stderr)
        self.assertIn(cmd_hint, made.stderr)
        self.assertEqual(set(json.loads(made.stdout)["result"]), {"profile_id", "account_label", "allowed_domains"})
        login = subprocess.run([sys.executable, tool, "login", "--id", "account-a"], env=env, capture_output=True, text=True)
        self.assertEqual(login.returncode, 6)
        self.assertEqual(json.loads(login.stdout)["error"], "PROFILE_NOT_PROVISIONED")
        self.assertIn("uid 10001", login.stderr)
        self.assertIn(cmd_hint, login.stderr)
        (self.root / "profiles/account-a").rmdir()
        missing = subprocess.run([sys.executable, tool, "login", "--id", "account-a"], env=env, capture_output=True, text=True)
        self.assertEqual(missing.returncode, 6)
        self.assertEqual(json.loads(missing.stdout)["error"], "PROFILE_MISSING")
        self.assertIn(cmd_hint, missing.stderr)

    def test_sigterm_and_sighup_mid_login_release_reservation_and_next_login_works(self):
        for signum, identity in ((signal.SIGTERM, "account-a"), (signal.SIGHUP, "account-b")):  # terminate() / tty hang-up
            with self.subTest(signal=signum.name):
                self.create(identity)
                proc = self.start_hanging_login(identity)
                pending = self.state / ("views/srf-id-%s.login-pending" % identity)
                self.assertEqual(json.loads(pending.read_text())["pid"], proc.pid)
                proc.send_signal(signum)
                out, _ = proc.communicate(timeout=60)
                self.assertEqual(proc.returncode, 6)
                self.assertEqual(json.loads(out)["error"], "LOGIN_TERMINATED")
                self.assertFalse(pending.exists())
                calls = [a for a in self.calls() if "--container" in a and
                         a[a.index("--container") + 1] == "srf-id-" + identity]
                self.assertEqual([a[0] for a in calls], ["login", "view-stop"])
                self.assertTrue((self.root / "release-login").exists())
                (self.root / "hang-login").unlink()
                with contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(self.tool.login(identity)["container"], "srf-id-" + identity)

    def test_sigkill_mid_login_is_reclaimed_by_next_login(self):
        self.create()
        proc = self.start_hanging_login()
        pending = self.state / "views/srf-id-account-a.login-pending"
        proc.kill()  # The tool dies without cleanup; the fake native view is orphaned.
        proc.wait(timeout=60)
        self.assertTrue(pending.exists())
        self.assertTrue(json.loads((self.root / "locks/account-a.json").read_text())["active"])
        (self.root / "hang-login").unlink()
        with contextlib.redirect_stderr(io.StringIO()):
            result = self.tool.login("account-a")
        self.assertEqual(result["container"], "srf-id-account-a")
        self.assertFalse(pending.exists())
        verbs = [a[0] for a in self.calls() if a[0] in ("login", "view-stop")]
        self.assertEqual(verbs, ["login", "view-stop", "login", "view-stop"])
        self.assertTrue((self.root / "release-login").exists())
        deadline = time.monotonic() + 5
        while not (self.root / "released-account-a").exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertTrue((self.root / "released-account-a").exists())

    def test_live_owner_reservation_blocks_second_login(self):
        self.create()
        self.surface("start")
        pending = self.state / "views/srf-id-account-a.login-pending"
        pending.parent.mkdir(mode=0o700)
        pending.write_text(json.dumps({"pid": os.getpid(), "start": mv.starttime(os.getpid())}))
        pending.chmod(0o600)
        holder = json.loads((self.root / "locks/account-a.json").read_text())["holder"]
        pending = pending.rename(pending.parent / (holder + ".login-pending"))
        with self.only_show(self.tool), self.assertRaisesRegex(mv.Refused, "^LOGIN_IN_PROGRESS$"):
            self.tool.login("account-a")
        self.assertTrue(pending.exists())
        with self.only_show(self.tool), self.assertRaisesRegex(mv.Refused, "^LOGIN_IN_PROGRESS$"):
            self.tool.release("account-a", self.holder())

    def test_reused_pid_with_other_start_time_is_stale(self):
        pending = self.state / "p.login-pending"
        pending.write_text(json.dumps({"pid": os.getpid(), "start": mv.starttime(os.getpid()) + 1}))
        pending.chmod(0o600)
        self.assertEqual(self.tool.pending_state(pending), "stale")
        pending.write_text("")
        self.assertEqual(self.tool.pending_state(pending), "stale")
        pending.write_text("{not json")
        self.assertEqual(self.tool.pending_state(pending), "stale")
        self.assertEqual(self.tool.pending_state(self.state / "absent.login-pending"), "none")

    def test_reserved_ids_refused_for_create_and_inactive_login(self):
        live = mv.Identities(str(self.root), str(self.home), str(self.bin), str(self.state), live_profile="live-main")
        for tool, identity in ((self.tool, "mv-live-1"), (self.tool, "mv-x"), (live, "live-main")):
            with self.subTest(identity=identity):
                with patch.object(tool, "native", side_effect=AssertionError("spawned")):
                    with self.assertRaisesRegex(mv.Refused, "^RESERVED_ID$"):
                        tool.create(identity, "x", "example.com")
                with patch.object(tool, "show", return_value={}), patch.object(tool, "lease", return_value=None):
                    with self.assertRaisesRegex(mv.Refused, "^RESERVED_ID$"):
                        tool.login(identity)

    def test_reserved_active_live_identity_can_attach(self):
        # The former unconditional reserved-login assertion encoded the bug.
        self.tool.native("srf-identity-admin", ["create", "--store-root", str(self.root),
                         "--id", "mv-live-1", "--label", "live", "--domains", "example.com"])
        self.surface("start", "mv-live-1")
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(self.tool.login("mv-live-1")["container"], self.holder("mv-live-1"))

    def test_status_reports_lease_provisioning_and_recorded_login(self):
        self.create()
        status = self.tool.status("account-a")
        self.assertEqual(status, {"profile_id": "account-a", "provisioned": True, "lease": "absent",
                                  "login_pending": "none", "login_recorded": "no"})
        self.surface("start")
        self.assertEqual(self.tool.status("account-a")["lease"], "active")
        self.surface("stop")
        self.assertEqual(self.tool.status("account-a")["lease"], "inactive")
        (self.root / "locks/account-a.json").write_text("{}")
        (self.root / "locks/account-a.json").chmod(0o600)
        self.assertEqual(self.tool.status("account-a")["lease"], "invalid")
        meta = self.root / "metadata/account-a.json"
        meta.write_text(json.dumps(dict(profile_id="account-a", created_unix=1, last_login_unix=5)))
        self.assertEqual(self.tool.status("account-a")["login_recorded"], "yes")
        strict = mv.Identities(str(self.root), str(self.home), str(self.bin), str(self.state))
        self.assertFalse(strict.status("account-a")["provisioned"])

    def test_release_clears_stale_active_lease_and_unblocks_delete(self):
        self.create()
        self.surface("start")
        with self.assertRaisesRegex(mv.Refused, "IDENTITY_BOUND"):
            self.tool.delete("account-a")
        holder = self.holder()
        result = self.tool.release("account-a", holder)
        self.assertTrue(result["was_active"])
        self.assertTrue(result["capsule_removed"])
        self.assertIn("capsule was removed", result["hint"])
        lifecycle = [a for a in self.calls() if a[0] in ("view-stop", "stop")]
        self.assertEqual([a[0] for a in lifecycle], ["view-stop", "stop"])
        self.assertEqual(lifecycle[0][1:3], ["--container", holder])
        self.assertEqual(self.tool.status("account-a")["lease"], "inactive")
        self.assertEqual(self.tool.release("account-a", self.holder()), {"released": "account-a", "was_active": False})
        self.assertEqual(self.tool.delete("account-a"), {"deleted": "account-a"})

    def test_release_fails_closed_when_native_keeps_the_lease(self):
        self.create()
        self.surface("start")
        native = self.tool.native
        def keep(binary, args, **kwargs):
            return {} if args[0] == "stop" else native(binary, args, **kwargs)
        with patch.object(self.tool, "native", side_effect=keep), self.assertRaisesRegex(mv.Refused, "^RELEASE_UNVERIFIED$"):
            self.tool.release("account-a", self.holder())
        self.assertEqual(self.tool.status("account-a")["lease"], "active")

    def test_release_refuses_lease_with_invalid_holder_without_spawn(self):
        self.create()
        lock = self.root / "locks/account-a.json"
        lock.write_text(json.dumps(dict(active=True, holder="../escape")))
        lock.chmod(0o600)
        with self.only_show(self.tool), self.assertRaisesRegex(mv.Refused, "^IDENTITY_BOUND$"):
            self.tool.release("account-a", self.holder())

    def test_release_reserved_ids_never_spawn(self):
        self.tool.live_profile = "live-main"
        with patch.object(self.tool, "native", side_effect=AssertionError("spawned")):
            for identity in ("mv-live-1", "live-main"):
                with self.subTest(identity=identity), self.assertRaisesRegex(mv.Refused, "^RESERVED_ID$"):
                    self.tool.release(identity, "srf-id-safe")

    def test_release_protected_holders_and_mismatch_never_stop(self):
        self.create()
        protected = {"srf-id-cuentas-1", "srf-id-perplexity-1", "srf-pg-notepad-1",
                     "srf-pg-metaviewer-1", "srf-egress-proxy", "n8n", "distil-box"}
        lease = self.root / "locks/account-a.json"
        for holder in protected | {"srf-id-safe"}:
            lease.write_text(json.dumps(dict(active=True, holder=holder)))
            lease.chmod(0o600)
            error = "PROTECTED_CONTAINER" if holder in protected else "HOLDER_MISMATCH"
            with self.subTest(holder=holder), self.only_show(self.tool):
                with self.assertRaisesRegex(mv.Refused, "^" + error + "$"):
                    self.tool.release("account-a", holder if holder in protected else "srf-id-other")

    def test_release_cli_requires_holder(self):
        proc = self.run_tool("release", "--id", "account-a")
        out, _ = proc.communicate(timeout=10)
        self.assertEqual(proc.returncode, 6)
        self.assertEqual(json.loads(out)["error"], "INVALID_ARGUMENTS")

    def test_empty_state_with_active_lease_is_typed_error(self):
        self.create()
        self.surface("start")
        self.tool.state_dir = ""
        with self.assertRaisesRegex(mv.Refused, "^ABSOLUTE_PATH_REQUIRED$"):
            self.tool.status("account-a")
        proc = self.run_tool("status", "--id", "account-a", MV_SRF_STATE_DIR="")
        out, err = proc.communicate(timeout=10)
        self.assertEqual(proc.returncode, 6)
        self.assertEqual(json.loads(out)["error"], "ABSOLUTE_PATH_REQUIRED")
        self.assertNotIn("TypeError", err)

    def test_unreadable_proc_and_null_start_are_unknown_and_block_reclaim(self):
        self.create()
        self.surface("start")
        pending = self.state / "views" / (self.holder() + ".login-pending")
        pending.parent.mkdir(mode=0o700)
        for start in (mv.starttime(os.getpid()), None):
            pending.write_text(json.dumps(dict(pid=os.getpid(), start=start)))
            pending.chmod(0o600)
            with patch.object(mv, "starttime", return_value=None):
                self.assertEqual(self.tool.pending_state(pending), "unknown")
                with self.only_show(self.tool), self.assertRaisesRegex(mv.Refused, "LOGIN_IN_PROGRESS"):
                    self.tool.login("account-a")
                with self.only_show(self.tool), self.assertRaisesRegex(mv.Refused, "LOGIN_IN_PROGRESS"):
                    self.tool.release("account-a", self.holder())

    def test_unavailable_proc_mount_is_unknown_even_for_missing_pid(self):
        pending = self.state / "owner.login-pending"
        pending.write_text(json.dumps(dict(pid=2147483647, start=123)))
        pending.chmod(0o600)
        with patch.object(mv, "starttime", return_value=None):
            self.assertEqual(self.tool.pending_state(pending), "unknown")

    def test_null_start_with_readable_proc_is_unknown(self):
        pending = self.state / "owner.login-pending"
        pending.write_text(json.dumps(dict(pid=os.getpid(), start=None)))
        pending.chmod(0o600)
        self.assertEqual(self.tool.pending_state(pending), "unknown")

    def test_terminated_child_exit_still_requires_view_stop(self):
        self.create()
        self.surface("start")
        child = Mock()
        child.stdout.readline.return_value = b'{"url":"http://127.0.0.1:12345/"}'
        child.poll.return_value = 0
        waits = []
        def waiting(**kwargs):
            if not waits:
                waits.append(True)
                signal.getsignal(signal.SIGTERM)(signal.SIGTERM, None)
            return 0
        child.wait.side_effect = waiting
        calls = []
        def native(binary, args, **kwargs):
            if args[0] == "show":
                return {"profile_id": "account-a"}
            calls.append(args)
            return {}
        with patch.object(mv.subprocess, "Popen", return_value=child), patch.object(self.tool, "native", side_effect=native):
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaisesRegex(mv.Refused, "LOGIN_TERMINATED"):
                self.tool.login("account-a")
        self.assertEqual([a[0] for a in calls], ["view-stop"])
        self.assertEqual(calls[0][1:3], ["--container", self.holder()])
        child.send_signal.assert_called_once_with(signal.SIGINT)

    def test_guard_covers_reclaim_and_create_and_missing_unlink_is_safe(self):
        self.create()
        self.surface("start")
        pending = self.state / "views" / (self.holder() + ".login-pending")
        pending.parent.mkdir(mode=0o700)
        pending.write_text("")
        pending.chmod(0o600)
        native, real_open = self.tool.native, os.open
        witnessed = []
        def assert_locked():
            fd = real_open(self.root / "locks/account-a.guard", os.O_RDWR)
            try:
                with self.assertRaises(BlockingIOError):
                    mv.fcntl.flock(fd, mv.fcntl.LOCK_EX | mv.fcntl.LOCK_NB)
            finally:
                os.close(fd)
        def reclaim(binary, args, **kwargs):
            if args[0] == "view-stop" and not witnessed:
                assert_locked()
                witnessed.append("reclaim")
                pending.unlink()  # Native teardown may remove it first.
            return native(binary, args, **kwargs)
        def opening(path, flags, *args, **kwargs):
            if Path(path) == pending and flags & os.O_CREAT:
                assert_locked()
                witnessed.append("create")
            return real_open(path, flags, *args, **kwargs)
        with patch.object(self.tool, "native", side_effect=reclaim), patch.object(mv.os, "open", side_effect=opening):
            with contextlib.redirect_stderr(io.StringIO()):
                self.tool.login("account-a")
        self.assertEqual(witnessed, ["reclaim", "create"])

    def test_sigterm_before_announcement_preserves_terminated_on_stop_refusal(self):
        self.create()
        self.surface("start")
        child = Mock()
        child.poll.return_value = None
        child.stdout.readline.side_effect = lambda *a: signal.getsignal(signal.SIGTERM)(signal.SIGTERM, None)
        native = self.tool.native
        def refusal(binary, args, **kwargs):
            if args[0] == "view-stop":
                raise mv.Refused("NATIVE_REFUSED")
            self.assertEqual(args[0], "show")
            return {"profile_id": "account-a"}
        with patch.object(mv.subprocess, "Popen", return_value=child), patch.object(self.tool, "native", side_effect=refusal):
            with self.assertRaisesRegex(mv.Refused, "^LOGIN_TERMINATED$"):
                self.tool.login("account-a")
        self.assertTrue((self.state / "views" / (self.holder() + ".login-pending")).exists())


if __name__ == "__main__":
    unittest.main()

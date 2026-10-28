"""Offline lifecycle controls; no Docker, X server or host identity is accessed."""

import argparse
from contextlib import redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

SPEC = importlib.util.spec_from_file_location(
    "live_stack", Path(__file__).with_name("e2e1_slice") / "stack.py")
stack = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(stack)


class LiveStackTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="stack-tést-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.root.chmod(0o700)

    def state(self):
        work = self.root / "run-test"
        work.mkdir()
        return {"schema": "metaviewer.live-stack/v1", "work": str(work),
                "pids": [], "capsules": [], "published": [], "status": "starting"}

    def environment(self):
        env = {key: str(self.root) for key in stack.REQUIRED}
        env.update(MV_E2E_LIVE="1", MV_SRF_LIVE_PROFILE="mv-live-1")
        return env

    def test_display_starts_high_and_skips_socket_or_lock(self):
        x11 = self.root / "x11"
        x11.mkdir()
        locks = self.root / "locks"
        locks.mkdir()
        (x11 / "X91").touch()
        (locks / ".X92-lock").touch()
        self.assertEqual(stack.free_display(x11, locks), ":93")
        (x11 / "X91").unlink()
        self.assertEqual(stack.free_display(x11, locks), ":91")

    def test_ttl_and_parser(self):
        for value, seconds in (("1s", 1), ("45m", 2700), ("24h", 86400)):
            self.assertEqual(stack.ttl_seconds(value), seconds)
        for value in ("0m", "-1s", "1", "1.5h", "25h", "1m;exit"):
            with self.assertRaises(argparse.ArgumentTypeError):
                stack.ttl_seconds(value)
        self.assertEqual(stack.parser().parse_args(["start"]).ttl, 2700)
        self.assertEqual(stack.parser().parse_args(["start", "--ttl", "2s"]).ttl, 2)
        self.assertEqual(stack.parser().parse_args(["stop"]).command, "stop")

    def test_watchdog_expires_using_monotonic_time(self):
        peer = Mock(_sock=object(), _rx=b"")
        tick = Mock()
        with patch.object(stack.time, "monotonic", side_effect=[100, 100, 101, 102]), \
                patch.object(stack.select, "select", return_value=([], [], [])):
            stack.monitor(peer, [Mock(poll=lambda: None)], 2, lambda: False, tick)
        self.assertEqual(tick.call_count, 2)
        peer.recv.assert_not_called()

    def test_watchdog_stop_and_process_failure_controls(self):
        peer, tick = Mock(), Mock()
        stack.monitor(peer, [], 100, lambda: True, tick)
        tick.assert_not_called()
        with self.assertRaisesRegex(RuntimeError, "process exited"):
            stack.monitor(peer, [Mock(poll=lambda: 1)], 100, lambda: False, tick)

    def test_watchdog_keeps_idle_agent_alive_at_bounded_intervals(self):
        peer = Mock(_sock=object(), _rx=b"")
        heartbeat = Mock()
        # Before, at, and after the first heartbeat, then the next interval.
        with patch.object(stack.time, "monotonic", side_effect=[
                100, 100, 100, 110, 110, 110, 111, 111, 120, 120, 120, 121]), \
                patch.object(stack.select, "select", return_value=([], [], [])):
            stack.monitor(peer, [], 21, lambda: False, lambda: None, heartbeat)
        self.assertEqual(heartbeat.call_count, 2)
        peer.recv.assert_not_called()

    def test_default_host_bindings_heartbeat_and_disposal(self):
        # Real socket/hello with a manually advanced interval: no live stack or
        # wall-clock wait. Tool lookup remains portable under non-ASCII clones.
        script = r'''
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {mkdtemp,mkdir,writeFile,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const {createMainBindings}=await import(pathToFileURL(process.argv[1]));
const root=await mkdtemp(join(tmpdir(),'mv-idle-tést-'));
const reg=component=>({endpoint:{component,instance:component+'-test'},hello:{
  schema:'hello/v0.2',contract_version:'v0.2',component,component_version:'0.2.0',
  component_commit:'a'.repeat(40),dependencies:[]}});
const config={session_id:'idle-test',core:reg('core'),peers:[reg('ui')]};
let peer,callback,interval,unref=false,cleared=false,bindings,seq=0;
const token={unref(){unref=true;}};
const originalSet=globalThis.setInterval,originalClear=globalThis.clearInterval;
globalThis.setInterval=(fn,ms)=>{callback=fn;interval=ms;return token;};
globalThis.clearInterval=value=>{if(value===token)cleared=true;};
const received=[];
const server=createServer(socket=>{peer=socket;let buffer='';socket.on('data',data=>{
  buffer+=data;let n;while((n=buffer.indexOf('\n'))>=0){
    const env=JSON.parse(buffer.slice(0,n));buffer=buffer.slice(n+1);received.push(env);
    if(env.body.schema==='hello/v0.2')socket.write(JSON.stringify({
      schema:'envelope/v0.2',from:config.core.endpoint,to:config.peers[0].endpoint,
      session_id:config.session_id,seq:++seq,nonce:'reply-'+seq,msg_id:'reply-'+seq,
      body:config.core.hello})+'\n');
  }
});});
try {
  await mkdir(join(root,'metaviewer'),{mode:0o700});
  const configPath=join(root,'config.json'),sock=join(root,'metaviewer/core.sock');
  await writeFile(configPath,JSON.stringify(config),{mode:0o600});
  server.listen(sock);await once(server,'listening');await chmod(sock,0o600);
  bindings=await createMainBindings({env:{MV_CORE_CONFIG:configPath,XDG_RUNTIME_DIR:root},
    createMessageChannel:()=>{throw Error('idle must not create channels');}});
  assert.equal(interval,10000);assert.equal(unref,true);
  assert.equal(received.length,1); // no request before the scheduled interval
  const data=once(peer,'data');callback();await data;
  assert.deepEqual(received[1].body,{schema:'surface_request/v0.2',op:'list',params:{}});
  assert.equal(received[1].seq,2);
  await bindings.core.dispose();assert.equal(cleared,true);
  assert.equal((await bindings.core.getStatus()).availability,'unavailable');
} finally {
  await bindings?.core.dispose();peer?.destroy();
  await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});
  globalThis.setInterval=originalSet;globalThis.clearInterval=originalClear;
}
'''
        result = subprocess.run([stack.shutil.which("node"), "--input-type=module", "-e", script,
                                 str(stack.ROOT / "ui/electron/hostBindings.js")],
                                capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_watchdog_drains_buffered_messages_and_refuses_native_errors(self):
        peer = Mock(_sock=object(), _rx=b"buffered\n")
        peer.recv.return_value = {"body": {"event": "error"}}
        with patch.object(stack.select, "select", return_value=([], [], [])), \
                self.assertRaisesRegex(RuntimeError, "native surface error"):
            stack.monitor(peer, [], 100, lambda: False, lambda: None)
        peer.recv.assert_called_once()

    def test_private_atomic_state_roundtrip(self):
        state = self.state()
        stack.save_state(self.root, state)
        path = self.root / "state.json"
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual(stack.load_state(self.root), state)
        stack.save_state(self.root, dict(state, status="ready"))
        self.assertEqual(stack.load_state(self.root)["status"], "ready")
        self.assertFalse(list(self.root.glob(".state-*")))

    def test_state_rejects_world_readable_unknown_schema_and_symlink(self):
        path = self.root / "state.json"
        stack.save_state(self.root, self.state())
        path.chmod(0o644)
        with self.assertRaisesRegex(RuntimeError, "unsafe"):
            stack.load_state(self.root)
        path.chmod(0o600)
        path.write_text(json.dumps({"schema": "other"}))
        with self.assertRaisesRegex(RuntimeError, "unknown"):
            stack.load_state(self.root)
        path.unlink()
        path.symlink_to(self.root / "absent")
        with self.assertRaises(OSError):
            stack.load_state(self.root)

    def test_runtime_refuses_absent_public_or_symlink_directory(self):
        with patch.dict(os.environ, {}, clear=True), self.assertRaisesRegex(RuntimeError, "AUSENTE"):
            stack.state_root()
        self.root.chmod(0o755)
        with self.assertRaisesRegex(RuntimeError, "private"):
            stack.private_dir(self.root)
        self.root.chmod(0o700)
        link = self.root / "link"
        link.symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, "private"):
            stack.private_dir(link)

    def test_missing_env_fails_before_inventory(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(stack, "gw1_active", return_value=False), \
                patch.object(stack, "inventory") as inventory:
            with self.assertRaisesRegex(RuntimeError, "live env AUSENTE"):
                stack.preflight(self.root)
            inventory.assert_not_called()

    def test_existing_state_and_gw1_refuse_before_any_external_command(self):
        for existing in (False, True):
            with self.subTest(existing=existing):
                if existing:
                    stack.save_state(self.root, self.state())
                with patch.object(stack, "gw1_active", return_value=not existing), \
                        patch.object(stack, "checked") as checked:
                    with self.assertRaisesRegex(RuntimeError, "another live"):
                        stack.preflight(self.root)
                    checked.assert_not_called()

    def test_preflight_ownership_and_missing_ui_negative_controls(self):
        env = self.environment()
        with patch.dict(os.environ, env, clear=True), patch.object(stack, "gw1_active", return_value=False), \
                patch.object(stack.shutil, "which", return_value="fake"), \
                patch.object(stack, "inventory", return_value={"unrelated"}), \
                patch.object(stack.live, "profile_containers", return_value={"srf-id-existing"}):
            with self.assertRaisesRegex(RuntimeError, "already allocated"):
                stack.preflight(self.root)
        with patch.dict(os.environ, env, clear=True), patch.object(stack, "gw1_active", return_value=False), \
                patch.object(stack.shutil, "which", return_value="fake"), \
                patch.object(stack, "inventory", return_value=set()), \
                patch.object(stack.live, "profile_containers", return_value=set()), \
                patch.object(stack, "ROOT", self.root):
            with self.assertRaisesRegex(RuntimeError, "shipped UI build AUSENTE"):
                stack.preflight(self.root)
            for name in ("ui/dist/renderer/index.html", "ui/dist/preload/preload.cjs"):
                path = self.root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.touch()
            self.assertEqual(stack.preflight(self.root), set())

    def test_profile_and_shipped_host_override_refuse(self):
        for changes, message in (({"MV_SRF_LIVE_PROFILE": "other"}, "mv-live-1"),
                                 ({"MV_CORE_BOOTSTRAP": "/override"}, "shipped host")):
            with patch.dict(os.environ, dict(self.environment(), **changes), clear=True), \
                    patch.object(stack, "gw1_active", return_value=False), \
                    patch.object(stack.shutil, "which", return_value="fake"):
                with self.assertRaisesRegex(RuntimeError, message):
                    stack.preflight(self.root)

    def test_electron_environment_excludes_loader_and_runtime_injection(self):
        safe = {"DISPLAY": ":123", "XAUTHORITY": "private", "MV_CORE_CONFIG": "config",
                "XDG_RUNTIME_DIR": "runtime", "PATH": "tools"}
        bad = {"LD_PRELOAD": "inject", "NODE_OPTIONS": "--inspect", "ELECTRON_RUN_AS_NODE": "1",
               "ELECTRON_DISABLE_SANDBOX": "1", "PYTHONPATH": "inject", "BASH_ENV": "inject"}
        self.assertEqual(stack.electron_environment(dict(safe, **bad)), safe)

    def test_signals_require_integer_non_system_pid_and_matching_identity(self):
        with patch.object(stack, "identity", return_value="fresh"), patch.object(stack.os, "kill") as kill, \
                patch.object(stack.os, "getpgid", return_value=-999):
            for pid in (0, 1, -5, "25", True, os.getpid()):
                with self.assertRaisesRegex(RuntimeError, "unsafe"):
                    stack.signal_record({"pid": pid, "identity": "fresh"}, signal.SIGTERM)
            stack.signal_record({"pid": 456789, "identity": "stale"}, signal.SIGTERM)
            stack.signal_record({"pid": 456789, "identity": None}, signal.SIGTERM)
            kill.assert_not_called()
            stack.signal_record({"pid": 456789, "identity": "fresh"}, signal.SIGTERM)
            kill.assert_called_once_with(456789, signal.SIGTERM)
        self.assertFalse(stack.alive({"pid": 456789, "identity": None}))

    def test_same_process_group_is_never_signalled(self):
        with patch.object(stack, "identity", return_value="birth"), \
                patch.object(stack.os, "getpgid", return_value=os.getpgrp()), \
                patch.object(stack.os, "kill") as kill:
            with self.assertRaisesRegex(RuntimeError, "caller process group"):
                stack.signal_record({"pid": 456789, "identity": "birth"}, signal.SIGTERM)
            kill.assert_not_called()

    def test_cleanup_touches_only_owned_capsule_and_new_ram(self):
        state = self.state()
        state["capsules"] = ["srf-id-owned"]
        ram = self.root / "ram"
        ram.mkdir()
        (ram / "srf-id-owned").mkdir()
        (ram / "srf-id-foreign").mkdir()
        (ram / "srf-pg-other").mkdir()
        with patch.dict(os.environ, dict(self.environment(), MV_SRF_LIVE_RAM_ROOT=str(ram)), clear=True), \
                patch.object(stack, "inventory", side_effect=[{"srf-id-foreign", "srf-id-owned"}, {"srf-id-foreign"}]), \
                patch.object(stack.live, "profile_containers", return_value=set()), \
                patch.object(stack, "checked", return_value="") as checked, \
                redirect_stdout(io.StringIO()) as out:
            stack.cleanup(state, self.root)
        self.assertFalse((ram / "srf-id-owned").exists())
        self.assertTrue((ram / "srf-id-foreign").exists())
        self.assertTrue((ram / "srf-pg-other").exists())
        self.assertFalse((self.root / "state.json").exists())
        self.assertFalse(Path(state["work"]).exists())
        receipt = json.loads(out.getvalue().split("LIVE_STACK_CLEANUP ", 1)[1])
        self.assertTrue(receipt["ram_absent"])
        self.assertEqual(receipt["owned_allocations_removed"], [str(ram / "srf-id-owned")])
        self.assertEqual(checked.call_count, 1)
        self.assertEqual(checked.call_args.args[0][2:4], ["--container", "srf-id-owned"])

    def test_cleanup_leak_retains_receipt_and_existing_ram(self):
        state = self.state()
        state["capsules"] = ["srf-id-owned"]
        ram = self.root / "ram"
        ram.mkdir()
        (ram / "srf-id-owned").mkdir()
        (ram / "srf-id-foreign").mkdir()
        (ram / "srf-pg-other").mkdir()
        leak = self.root / "published"
        leak.mkdir()
        state["published"] = [str(leak)]
        with patch.dict(os.environ, dict(self.environment(), MV_SRF_LIVE_RAM_ROOT=str(ram)), clear=True), \
                patch.object(stack, "inventory", side_effect=[{"srf-id-owned", "srf-id-foreign"}, {"srf-id-foreign"}]) as inv, \
                patch.object(stack.live, "profile_containers", return_value=set()), \
                patch.object(stack, "checked", return_value=""):
            with self.assertRaisesRegex(RuntimeError, "^published RAM cleanup failed:"):
                stack.cleanup(state, self.root)
        self.assertEqual(inv.call_count, 2)
        self.assertFalse((ram / "srf-id-owned").exists())
        self.assertTrue((ram / "srf-id-foreign").exists())
        self.assertTrue((ram / "srf-pg-other").exists())
        self.assertTrue(leak.exists())
        self.assertTrue((self.root / "state.json").exists())
        # Negative control: stubbing cleanup_capsule_ram to ram_absent=True clears the published-RAM failure.
        with patch.dict(os.environ, dict(self.environment(), MV_SRF_LIVE_RAM_ROOT=str(ram)), clear=True), \
                patch.object(stack, "inventory", side_effect=[{"srf-id-owned", "srf-id-foreign"}, {"srf-id-foreign"}]), \
                patch.object(stack.live, "profile_containers", return_value=set()), \
                patch.object(stack, "checked", return_value=""), \
                patch.object(stack.live, "cleanup_capsule_ram", return_value={
                    "owned_allocations": [], "owned_allocations_removed": [],
                    "ram_absent": True, "remaining": [],
                }), \
                redirect_stdout(io.StringIO()):
            receipt = stack.cleanup(state, self.root)
        self.assertTrue(receipt["ram_absent"])

    def test_cleanup_capsule_leak_retains_receipt_and_existing_ram(self):
        state = self.state()
        state["capsules"] = ["srf-id-owned"]
        ram = self.root / "ram"
        ram.mkdir()
        (ram / "srf-id-owned").mkdir()
        (ram / "srf-id-foreign").mkdir()
        (ram / "srf-pg-other").mkdir()
        with patch.dict(os.environ, dict(self.environment(), MV_SRF_LIVE_RAM_ROOT=str(ram)), clear=True), \
                patch.object(stack, "inventory", side_effect=[{"srf-id-owned", "srf-id-foreign"}, {"srf-id-owned", "srf-id-foreign"}]) as inv, \
                patch.object(stack.live, "profile_containers", return_value=set()), \
                patch.object(stack, "checked", return_value=""):
            with self.assertRaisesRegex(RuntimeError, "^capsule cleanup failed$"):
                stack.cleanup(state, self.root)
        self.assertEqual(inv.call_count, 2)
        self.assertTrue((ram / "srf-id-owned").exists())
        self.assertTrue((ram / "srf-id-foreign").exists())
        self.assertTrue((ram / "srf-pg-other").exists())
        self.assertTrue((self.root / "state.json").exists())

    def test_state_stays_bounded_and_stop_works_after_long_run(self):
        state = self.state()
        state["supervisor"] = {"pid": 456789, "identity": "birth"}
        state["pids"] = [{"pid": 1001, "identity": "1001:999999"}]
        state["before"] = [f"srf-id-old-{i}" for i in range(500)]
        state["ram_before"] = [f"srf-id-ram-{i}" for i in range(500)]
        state["capsules"] = [f"srf-id-cap-{i:04d}" for i in range(60)] + ["srf-pg-ignore"]
        state["published"] = [str(self.root / f"pub-{i}") for i in range(60)]
        state["error"] = "x" * 20000
        live_pids = {1001, 1002, 1003, 1004}

        def fake_alive(row):
            return isinstance(row, dict) and row.get("pid") in live_pids

        batches = [
            [(pid, 1001, "S", f"{pid}:999999") for pid in [1002, 1003, 1004]
             + list(range(2000 + step * 25, 2025 + step * 25))]
            for step in range(80)
        ] + [[(pid, 1001, "S", f"{pid}:999999") for pid in (1002, 1003, 1004)]]
        with patch.object(stack, "alive", side_effect=fake_alive), \
                patch.object(stack, "_proc_stat_entries", side_effect=batches):
            for _ in batches:
                stack.remember_tree(state, self.root)
        path = self.root / "state.json"
        self.assertLessEqual(path.stat().st_size, stack.MAX_STATE_BYTES)
        loaded = stack.load_state(self.root)
        self.assertNotIn("before", loaded)
        self.assertNotIn("ram_before", loaded)
        self.assertEqual([row["pid"] for row in loaded["pids"]], [1001, 1002, 1003, 1004])
        self.assertEqual(len(loaded["capsules"]), stack.MAX_STATE_CAPSULES)
        self.assertNotIn("srf-pg-ignore", loaded["capsules"])
        self.assertEqual(len(loaded["published"]), stack.MAX_STATE_PUBLISHED)
        self.assertEqual(len(loaded["error"]), stack.MAX_STATE_ERROR_CHARS)

        def finish(*_):
            path.unlink()

        with patch.object(stack, "identity", return_value="birth"), \
                patch.object(stack, "signal_record", side_effect=finish) as send, \
                redirect_stdout(io.StringIO()) as out:
            stack.stop_stack(self.root)
        send.assert_called_once_with(state["supervisor"], signal.SIGTERM)
        self.assertIn("state=absent", out.getvalue())

    def test_stop_absent_idempotent_and_dead_supervisor_preserves_receipt(self):
        with redirect_stdout(io.StringIO()) as out:
            stack.stop_stack(self.root)
        self.assertIn("already_absent=true", out.getvalue())
        stack.save_state(self.root, self.state())
        with self.assertRaisesRegex(RuntimeError, "supervisor absent"):
            stack.stop_stack(self.root)
        self.assertTrue((self.root / "state.json").exists())

    def test_stop_waits_for_verified_supervisor_cleanup(self):
        state = self.state()
        state["supervisor"] = {"pid": 456789, "identity": "birth"}
        stack.save_state(self.root, state)
        def finish(*_):
            (self.root / "state.json").unlink()
        with patch.object(stack, "identity", return_value="birth"), \
                patch.object(stack, "signal_record", side_effect=finish) as send, \
                redirect_stdout(io.StringIO()) as out:
            stack.stop_stack(self.root)
        send.assert_called_once_with(state["supervisor"], signal.SIGTERM)
        self.assertIn("state=absent", out.getvalue())

    def test_t8_r2_015_expiry_recovery_probe_rotates_and_restores_processes(self):
        pub_dir = self.root / "mv-frames-1" / "surface-live"
        pub_dir.mkdir(parents=True)
        archive = self.root / "archive"
        (archive / "events").mkdir(parents=True)
        (archive / "artifacts").mkdir(parents=True)
        g1 = pub_dir / "1.rgb"
        g2 = pub_dir / "2.rgb"
        g3 = pub_dir / "3.rgb"
        g1_bytes = b"\x11" * 12
        g2_bytes = b"\x22" * 12
        g3_bytes = b"\x33" * 12
        g1.write_bytes(g1_bytes)
        g2_sha = stack.live.hashlib.sha256(g2_bytes).hexdigest()
        g3_sha = stack.live.hashlib.sha256(g3_bytes).hexdigest()
        (archive / "artifacts" / g3_sha).write_bytes(g3_bytes)
        baseline = {
            "schema": "frame_ref/v0.2",
            "surface_id": "surface-live",
            "generation": 1,
            "ramws_path": str(g1),
            "sha256": stack.live.hashlib.sha256(g1_bytes).hexdigest(),
            "width": 2,
            "height": 2,
            "stride": 6,
            "pixel_format": "RGB24",
            "ts_ns": 100,
        }
        fresh = {
            "schema": "frame_ref/v0.2",
            "surface_id": "surface-live",
            "generation": 3,
            "ramws_path": str(g3),
            "sha256": g3_sha,
            "width": 2,
            "height": 2,
            "stride": 6,
            "pixel_format": "RGB24",
            "ts_ns": 300,
        }
        (archive / "events" / "1.json").write_text(json.dumps({
            "state": {"epoch": 1, "surfaces": {"surface-live": {"frame": fresh}}},
        }))
        signals = []
        polls = []

        def adapter_poll():
            polls.append(len(polls))
            if len(polls) == 1:
                g2.write_bytes(g2_bytes)
            elif len(polls) == 2:
                g3.write_bytes(g3_bytes)
                g2.unlink()
            return None

        core = Mock(send_signal=lambda sig: signals.append(("core", sig)), poll=lambda: None)
        adapter = Mock(send_signal=lambda sig: signals.append(("adapter", sig)), poll=adapter_poll)
        report = {"commands": [], "wire_evidence": [], "assertions": {}}
        regs = {"agent": {"endpoint": {"component": "agent", "instance": "a1"}},
                "ui": {"endpoint": {"component": "ui", "instance": "u1"}}}
        config = {"session_id": "sess-1", "core": {"endpoint": {"component": "core", "instance": "c1"}}}
        sent = []
        replies = [
            {"schema": "mv_tool_result/v0.2", "request_id": "observe-refresh",
             "status": "ok", "observation": {"frame_ref": fresh}},
            {"schema": "surface_event/v0.2", "event": "frame_ready", "data": {"frame_ref": fresh}},
            {"schema": "action_verdict/v0.2", "proposal_id": "live-expired-frame",
             "decision": "refused", "reason_code": "STALE_FRAME",
             "reason_detail": "expired frame", "core_seq": 9, "verdict_at_ns": 900},
        ]
        with patch.object(stack.live, "snapshot", return_value={
                "epoch": 1, "surfaces": {"surface-live": {"frame": fresh}}}), \
                patch.object(stack.live, "send", side_effect=lambda p, r, c, b: sent.append(b)), \
                patch.object(stack.live, "receive", side_effect=replies):
            recovered = stack.live.expiry_recovery_probe(
                report, Mock(), Mock(), regs, config,
                "surface-live", baseline, archive, [core, adapter],
            )
        self.assertEqual(recovered["generation"], 3)
        self.assertEqual(report["assertions"]["expired_publication_recovery"], "PASS")
        self.assertEqual(report["expiry_recovery"]["expired_generation"], 2)
        self.assertNotEqual(g2_sha, g3_sha)
        self.assertIn(("core", signal.SIGCONT), signals)

        # Negative control: rotation timeout still resumes core via SIGCONT.
        signals.clear()
        with patch.object(stack.live, "snapshot", return_value={
                "epoch": 1, "surfaces": {"surface-live": {"frame": baseline}}}), \
                patch.object(stack.live.time, "monotonic", side_effect=[0.0, 1.0, 11.0]), \
                patch.object(stack.live.time, "sleep"):
            with self.assertRaisesRegex(RuntimeError, "timed out waiting for adapter lease rotation"):
                stack.live.expiry_recovery_probe(
                    report, Mock(), Mock(), regs, config,
                    "surface-live", baseline, archive, [core, adapter],
                )
        self.assertIn(("core", signal.SIGCONT), signals)

    def test_binaries_builds_core_release_by_default_and_debug_by_flag_or_env(self):
        work = self.root / "work-core-profile"
        work.mkdir()
        target_dir = self.root / "cargo-target"
        adapter_bin = self.root / "prebuilt-adapter"
        adapter_bin.write_bytes(b"#!/bin/sh\nexit 0\n")
        adapter_bin.chmod(0o700)
        commit = "b" * 40
        stack.live.write_binary_provenance(adapter_bin, "adapter", commit=commit, repo_root=stack.ROOT)

        calls = []

        def fake_checked(cmd, **kwargs):
            calls.append([str(x) for x in cmd])
            profile = "release" if "--release" in cmd else "debug"
            out = target_dir / profile / "metaviewer-core"
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(b"#!/bin/sh\nexit 0\n")
            out.chmod(0o700)
            return ""

        base_env = {
            "CARGO": "custom-cargo",
            "CARGO_TARGET_DIR": str(target_dir),
            "MV_E2E_ADAPTER_BIN": str(adapter_bin),
        }

        # 1. Default builds --release and resolves target/release/metaviewer-core with provenance.
        resolved_release = stack.binaries(
            work,
            env=base_env,
            checked_fn=fake_checked,
            expected_commit=commit,
        )
        self.assertEqual(len(calls), 1)
        self.assertIn("--release", calls[0])
        self.assertEqual(resolved_release["core"], target_dir / "release/metaviewer-core")
        self.assertTrue(stack.binary_provenance_path(resolved_release["core"]).is_file())

        # 2. Explicit debug flag builds debug and resolves target/debug/metaviewer-core.
        calls.clear()
        parsed_debug = stack.parser().parse_args(["start", "--debug"])
        self.assertTrue(parsed_debug.debug)
        resolved_debug = stack.binaries(
            work,
            env=base_env,
            checked_fn=fake_checked,
            expected_commit=commit,
            debug=parsed_debug.debug,
        )
        self.assertEqual(len(calls), 1)
        self.assertNotIn("--release", calls[0])
        self.assertEqual(resolved_debug["core"], target_dir / "debug/metaviewer-core")
        self.assertTrue(stack.binary_provenance_path(resolved_debug["core"]).is_file())

        # 3. Environment variable MV_LIVE_DEBUG_CORE=1 also selects debug.
        calls.clear()
        resolved_env_debug = stack.binaries(
            work,
            env=dict(base_env, MV_LIVE_DEBUG_CORE="1"),
            checked_fn=fake_checked,
            expected_commit=commit,
        )
        self.assertEqual(len(calls), 1)
        self.assertNotIn("--release", calls[0])
        self.assertEqual(resolved_env_debug["core"], target_dir / "debug/metaviewer-core")

        # Negative control: missing or relative CARGO_TARGET_DIR is refused.
        with self.assertRaisesRegex(RuntimeError, "absolute per-worktree CARGO_TARGET_DIR required"):
            stack.binaries(
                work,
                env={"MV_E2E_ADAPTER_BIN": str(adapter_bin), "CARGO_TARGET_DIR": "relative/target"},
                checked_fn=fake_checked,
                expected_commit=commit,
            )

    def test_persistent_config_dir_survives_stop_and_reset_config_removes_it(self):
        cfg = stack.ensure_config_dir(self.root, env={})
        self.assertEqual(cfg, self.root / "config")
        self.assertEqual(stat.S_IMODE(cfg.lstat().st_mode), 0o700)
        settings_dir = cfg / "metaviewer"
        settings_dir.mkdir(mode=0o700)
        settings_file = settings_dir / "settings.json"
        settings_file.write_text('{"theme":"dark"}', encoding="utf-8")

        state = self.state()
        state["config_dir"] = str(cfg)
        ram = self.root / "ram-cfg"
        ram.mkdir()
        stack.save_state(self.root, state)

        with patch.dict(os.environ, dict(self.environment(), MV_SRF_LIVE_RAM_ROOT=str(ram)), clear=True), \
                patch.object(stack, "inventory", return_value=set()), \
                patch.object(stack.live, "profile_containers", return_value=set()), \
                redirect_stdout(io.StringIO()):
            stack.cleanup(state, self.root)

        # Work dir and state.json are removed by stop/cleanup, but config dir and settings survive.
        self.assertFalse(Path(state["work"]).exists())
        self.assertFalse((self.root / "state.json").exists())
        self.assertTrue(cfg.is_dir())
        self.assertEqual(settings_file.read_text(encoding="utf-8"), '{"theme":"dark"}')

        # Explicit MV_LIVE_CONFIG_DIR is also honored when private and outside ~/.config and repo.
        explicit_cfg = self.root / "custom-config"
        ensured_explicit = stack.ensure_config_dir(
            self.root,
            env={"MV_LIVE_CONFIG_DIR": str(explicit_cfg)},
        )
        self.assertEqual(ensured_explicit, explicit_cfg)
        self.assertEqual(stat.S_IMODE(explicit_cfg.lstat().st_mode), 0o700)

        # reset-config removes the config dir explicitly and is idempotent thereafter.
        self.assertEqual(stack.parser().parse_args(["reset-config"]).command, "reset-config")
        with redirect_stdout(io.StringIO()) as out1:
            res1 = stack.reset_config(self.root, env={})
        self.assertTrue(res1["removed"])
        self.assertFalse(cfg.exists())
        self.assertIn("LIVE_STACK_CONFIG_RESET", out1.getvalue())
        self.assertIn("removed=true", out1.getvalue())

        with redirect_stdout(io.StringIO()) as out2:
            res2 = stack.reset_config(self.root, env={})
        self.assertFalse(res2["removed"])
        self.assertIn("already_absent=true", out2.getvalue())

        # Negative controls: user's real ~/.config (and subdirectories) and repo paths are refused.
        real_cfg = Path.home() / ".config"
        for forbidden in (real_cfg, real_cfg / "metaviewer", Path.home(), stack.ROOT / "ui"):
            with self.assertRaises(stack.StackError):
                stack.ensure_config_dir(
                    self.root,
                    env={"MV_LIVE_CONFIG_DIR": str(forbidden)},
                )
            with self.assertRaises(stack.StackError):
                stack.reset_config(
                    self.root,
                    env={"MV_LIVE_CONFIG_DIR": str(forbidden)},
                )

    def test_loss_tolerant_mode_keeps_stack_running_while_default_triggers_cleanup(self):
        capture_failed_event = {
            "schema": "surface_event/v0.2",
            "event": "error",
            "data": {
                "surface_id": "surf-live-1",
                "code": "capture_failed",
                "detail": "capture, publication or delivery refused (skipped_polls=3)",
            },
        }
        lost_state_event = {
            "schema": "surface_event/v0.2",
            "event": "state_changed",
            "data": {
                "surface": {
                    "schema": "surface/v0.2",
                    "surface_id": "surf-live-1",
                    "kind": "browser",
                    "display": ":91",
                    "geometry": {"w": 1280, "h": 900},
                    "state": "lost",
                    "visibility": "unfolded",
                    "control": "agent",
                    "profile_id": "mv-live-1",
                }
            },
        }

        def run_supervised_loss_scenario(*, tolerate_loss, env_override=None):
            root = self.root / ("sup-tol" if tolerate_loss else "sup-fail")
            root.mkdir(mode=0o700, exist_ok=True)
            work = root / "run-loss"
            work.mkdir(mode=0o700, exist_ok=True)
            state = {
                "schema": "metaviewer.live-stack/v1",
                "status": "starting",
                "work": str(work),
                "pids": [],
                "capsules": ["srf-id-owned01"],
                "published": [],
                "display_mode": "visible",
                "surface_id": "surf-live-1",
            }
            if tolerate_loss:
                state["tolerate_capsule_loss"] = True
            stack.save_state(root, state)

            events_queue = [
                {"body": capture_failed_event},
                {"body": lost_state_event},
            ]
            cleanup_Triggered_while_running = []
            stop_requested = [False]
            ticks = [0]
            sig_handlers = {}

            def capture_signal(sig, handler):
                sig_handlers[sig] = handler

            class FakePeer:
                def __init__(self):
                    self._sock = object()
                    self._rx = b"line\n"

                def connect(self):
                    pass

                def recv(self):
                    if events_queue:
                        item = events_queue.pop(0)
                        if not events_queue:
                            self._rx = b""
                        return item
                    return {"body": {"schema": "surface_event/v0.2", "event": "frame_ready"}}

                def close(self):
                    self._sock = None

            fake_peer = FakePeer()
            ui_proc = Mock(pid=2001, poll=lambda: None, wait=lambda: 0)
            core_proc = Mock(pid=2002, poll=lambda: None, wait=lambda: 0)
            adapter_proc = Mock(pid=2003, poll=lambda: None, wait=lambda: 0)
            spawn_procs = [core_proc, adapter_proc, ui_proc]

            def fake_popen(argv, **kwargs):
                proc = spawn_procs.pop(0)
                child_env = kwargs.get("env") or {}
                if proc is core_proc:
                    sock_file = Path(child_env["XDG_RUNTIME_DIR"]) / "metaviewer/core.sock"
                    sock_file.parent.mkdir(parents=True, exist_ok=True)
                    sock_file.touch()
                elif proc is adapter_proc:
                    ev_file = (
                        Path(child_env["XDG_STATE_HOME"])
                        / "metaviewer/sessions"
                        / child_env["MV_SESSION_ID"]
                        / "events/1.json"
                    )
                    ev_file.parent.mkdir(parents=True, exist_ok=True)
                    ev_file.write_text("{}", encoding="utf-8")
                return proc

            def fake_remember_tree(st, rt):
                ticks[0] += 1
                # After both loss events have been processed in monitor(), stop the stack cleanly.
                if not events_queue and ticks[0] >= 3:
                    stop_requested[0] = True
                    sig_handlers[signal.SIGTERM](signal.SIGTERM, None)

            def fake_cleanup(st, rt, **_kwargs):
                cleanup_Triggered_while_running.append(
                    {
                        "stop_requested": stop_requested[0],
                        "status_at_cleanup": st.get("status"),
                        "remaining_events": len(events_queue),
                    }
                )
                (rt / "state.json").unlink(missing_ok=True)
                return {"processes_absent": True}

            lock_r, lock_w = os.pipe()
            os.close(lock_w)
            env = dict(self.environment(), **(env_override or {}))
            out_buf = io.StringIO()
            err_buf = io.StringIO()
            with patch.dict(os.environ, env, clear=True), \
                    patch.object(stack.signal, "signal", side_effect=capture_signal), \
                    patch.object(stack, "checked", return_value='"MetaViewer"' + "\n" + "a" * 40), \
                    patch.object(stack, "binaries", return_value={"core": Path("/bin/true"), "adapter": Path("/bin/true")}), \
                    patch.object(stack, "validate_display", return_value={"display": ":0", "xauthority": ""}), \
                    patch.object(stack.subprocess, "Popen", side_effect=fake_popen), \
                    patch.object(stack, "identity", return_value="birth"), \
                    patch.object(stack.live, "CoreClient", return_value=fake_peer), \
                    patch.object(stack, "open_control_socket", return_value=None), \
                    patch.object(
                        stack,
                        "bootstrap_agent_surface",
                        side_effect=lambda _p, _r, _c, st, rt, _s, **_kw: (
                            st.update(status="ready"),
                            stack.save_state(rt, st),
                        ),
                    ), \
                    patch.object(stack, "remember_tree", side_effect=fake_remember_tree), \
                    patch.object(stack.live, "send"), \
                    patch.object(stack.live, "receive", return_value={"event": "state_changed", "data": {"surface": {"state": "destroyed"}}}), \
                    patch.object(stack.live, "profile_containers", return_value=set()), \
                    patch.object(stack, "cleanup", side_effect=fake_cleanup), \
                    patch.object(stack.select, "select", side_effect=lambda r, w, x, t: (r if events_queue else [], [], [])), \
                    redirect_stdout(out_buf), \
                    patch.object(stack.sys, "stderr", err_buf):
                rc = stack.supervise(root, 60, lock_r)
            return rc, cleanup_Triggered_while_running, out_buf.getvalue(), err_buf.getvalue()

        # 1. With --tolerate-capsule-loss, capture_failed and lost log LIVE_CAPSULE_LOST
        # and do NOT trigger early cleanup before stop/TTL.
        rc_tol, cleanups_tol, stdout_tol, stderr_tol = run_supervised_loss_scenario(tolerate_loss=True)
        self.assertEqual(rc_tol, 0, stderr_tol)
        self.assertEqual(len(cleanups_tol), 1)
        self.assertTrue(cleanups_tol[0]["stop_requested"])
        self.assertEqual(cleanups_tol[0]["status_at_cleanup"], "ready")
        self.assertEqual(cleanups_tol[0]["remaining_events"], 0)
        self.assertIn("LIVE_CAPSULE_LOST reason=capture_failed surface_id=surf-live-1", stdout_tol)
        self.assertIn("LIVE_CAPSULE_LOST reason=lost surface_id=surf-live-1", stdout_tol)

        # 2. Without --tolerate-capsule-loss (default fail-closed), fake capsule loss
        # immediately aborts monitor() and triggers cleanup before stop is requested.
        rc_fail, cleanups_fail, stdout_fail, stderr_fail = run_supervised_loss_scenario(tolerate_loss=False)
        self.assertEqual(rc_fail, 1)
        self.assertEqual(len(cleanups_fail), 1)
        self.assertFalse(cleanups_fail[0]["stop_requested"])
        self.assertEqual(cleanups_fail[0]["status_at_cleanup"], "failed")
        self.assertNotIn("LIVE_CAPSULE_LOST", stdout_fail)
        self.assertIn("native surface error", stderr_fail)

        # 3. Also verify lost state_changed event alone fails closed in monitor() without the flag,
        # and is tolerated when MV_LIVE_TOLERATE_LOSS=1 is set in env.
        peer_lost = Mock(_sock=object(), _rx=b"lost\n")
        peer_lost.recv.return_value = {"body": lost_state_event}
        with patch.object(stack.select, "select", return_value=([], [], [])), \
                self.assertRaisesRegex(RuntimeError, "native surface lost"):
            stack.monitor(peer_lost, [], 100, lambda: False, lambda: None)

        logged_env = []
        calls_env = [0]

        def recv_once():
            calls_env[0] += 1
            peer_lost._rx = b""
            return {"body": lost_state_event}

        peer_lost._rx = b"lost\n"
        peer_lost.recv.side_effect = recv_once
        with patch.object(stack.select, "select", return_value=([], [], [])):
            stack.monitor(
                peer_lost,
                [],
                100,
                lambda: calls_env[0] >= 1,
                lambda: None,
                env={"MV_LIVE_TOLERATE_LOSS": "1"},
                log_fn=logged_env.append,
            )
        self.assertEqual(len(logged_env), 1)
        self.assertIn("LIVE_CAPSULE_LOST reason=lost surface_id=surf-live-1", logged_env[0])


if __name__ == "__main__":
    unittest.main()

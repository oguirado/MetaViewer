"""Security hardening unit and mutation tests for persistent vserve client (VCORE-HARDEN).

Covers findings F1 through F7 with hosted-safe fake vserve scripts and
explicit negative-control mutations demonstrating that reverting each fix
causes its corresponding test to fail.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from metaviewer_agents.perception import vcore
from metaviewer_agents.perception.base import (
    Frame,
    PerceptionError,
    check_vision,
)
from metaviewer_agents.perception.vcore import (
    VSERVE_HELLO_SCHEMA,
    VSERVE_REPLY_SCHEMA,
    VCorePerceptionAdapter,
    _BoundedRequestQueue,
    _VSERVE_RESTART_RECOVERY_REPLIES,
    _parse_vserve_reply,
    _png_bytes,
    _ramws_frame,
    _resolve_extra_site,
    _resolve_pinned_python,
    _run_bounded,
    _scrubbed_env,
    _spawn_vserve_proc,
    _verify_and_pin_frame_path,
)


_HARDEN_VSERVE_SOURCE = textwrap.dedent(
    """\
    import hashlib
    import json
    import os
    import pathlib
    import signal
    import struct
    import sys
    import time
    import zlib

    cfg = {}
    if os.path.exists("vserve_mode.json"):
        cfg = json.loads(pathlib.Path("vserve_mode.json").read_text(encoding="utf-8"))

    boot_file = pathlib.Path("vserve_boots.txt")
    boots = int(boot_file.read_text(encoding="utf-8")) + 1 if boot_file.exists() else 1
    boot_file.write_text(str(boots), encoding="utf-8")
    pathlib.Path("vserve.pid").write_text(str(os.getpid()), encoding="utf-8")

    check_fd = cfg.get("check_fd")
    fd_open = False
    if isinstance(check_fd, int):
        try:
            os.fstat(check_fd)
            fd_open = True
        except OSError:
            fd_open = False

    pathlib.Path("vserve_isolation.json").write_text(
        json.dumps({
            "pid": os.getpid(),
            "pgid": os.getpgid(0),
            "sid": os.getsid(0),
            "fd_open": fd_open,
            "env": {
                "PATH": os.environ.get("PATH"),
                "HOME": os.environ.get("HOME"),
                "LANG": os.environ.get("LANG"),
                "PYTHONNOUSERSITE": os.environ.get("PYTHONNOUSERSITE"),
                "PYTHONSAFEPATH": os.environ.get("PYTHONSAFEPATH"),
                "PYTHONPATH": os.environ.get("PYTHONPATH"),
            },
            "no_user_site": int(getattr(sys.flags, "no_user_site", 0)),
            "safe_path": bool(getattr(sys.flags, "safe_path", False)),
        }),
        encoding="utf-8",
    )

    sig_log = pathlib.Path("vserve_signals.txt")

    def _record_sig(tag):
        prev = sig_log.read_text(encoding="utf-8") if sig_log.exists() else ""
        sig_log.write_text(prev + tag + "\\n", encoding="utf-8")

    if cfg.get("ignore_sigterm"):
        def _on_sigterm(signum, frame):
            _record_sig("SIGTERM_SEEN")
        signal.signal(signal.SIGTERM, _on_sigterm)

    def reply(req_id, op, ok, rc, code, detail, result, extra_raw=""):
        msg = {
            "code": code,
            "detail": detail,
            "ok": ok,
            "op": op,
            "rc": rc,
            "request_id": req_id,
            "result": result,
            "schema": "ve.vserve.reply/v1",
        }
        sys.stdout.write(json.dumps(msg, separators=(",", ":")) + "\\n" + extra_raw)
        sys.stdout.flush()

    hello_payload = {
        "active_sessions": 0,
        "capabilities": ["describe", "hello", "ping", "capabilities", "status", "frame_raw", "prev_raw"],
        "frame_raw": True,
        "max_control_line_bytes": 65536,
        "max_frame_bytes": 33554432,
        "max_sessions": 16,
        "raw_shm": True,
        "ring": True,
        "schema": "ve.vserve.hello/v1",
    }

    def _decode_png_rgb(raw_png):
        width, height = struct.unpack(">II", raw_png[16:24])
        pos = 8
        idat = bytearray()
        while pos < len(raw_png):
            length = struct.unpack(">I", raw_png[pos:pos + 4])[0]
            ctype = raw_png[pos + 4:pos + 8]
            chunk = raw_png[pos + 8:pos + 8 + length]
            pos += 12 + length
            if ctype == b"IDAT":
                idat.extend(chunk)
        decompressed = zlib.decompress(bytes(idat))
        row_bytes = width * 3
        rgb = bytearray()
        for row in range(height):
            start = row * (1 + row_bytes) + 1
            rgb.extend(decompressed[start:start + row_bytes])
        return width, height, bytes(rgb)

    describe_count = 0
    for raw_line in sys.stdin:
        req = json.loads(raw_line)
        req_id = req.get("request_id")
        op = req.get("op", "describe")

        if op in ("hello", "ping", "capabilities"):
            reply(req_id, op, True, 0, "OK", "", dict(hello_payload))
            continue

        if op == "status":
            reply(req_id, op, True, 0, "OK", {}, {
                "active_sessions": 0,
                "max_sessions": 16,
                "session_ids": [],
            })
            continue

        if op == "describe":
            describe_count += 1
            if cfg.get("hang_on_describe"):
                time.sleep(5.0)
                continue
            if boots in cfg.get("crash_on_boots", []) and describe_count == 1:
                sys.exit(1)
            if boots == 1 and cfg.get("null_error_on_boot1"):
                reply(None, "describe", False, 2, "E_PARSE", "uncorrelated error", None)
                continue
            if boots == 1 and cfg.get("op_mismatch_error_on_boot1"):
                reply(req_id, "hello", False, 2, "E_OP", "wrong op error", None)
                continue
            if boots == 1 and cfg.get("pipelined_on_boot1"):
                smuggled = json.dumps({
                    "code": "OK",
                    "detail": "",
                    "ok": True,
                    "op": "describe",
                    "rc": 0,
                    "request_id": 999,
                    "result": {},
                    "schema": "ve.vserve.reply/v1",
                }, separators=(",", ":")) + "\\n"
                reply(req_id, op, True, 0, "OK", "", {"schema": "ve.cu_describe/v1"}, extra_raw=smuggled)
                continue

            delay_s = float(cfg.get("describe_delay_s", 0.0))
            if delay_s > 0:
                time.sleep(delay_s)

            if "frame_raw" in req:
                parts = req["frame_raw"].rsplit(",", 2)
                raw_path = parts[0]
                width = int(parts[1])
                height = int(parts[2])
                data = pathlib.Path(raw_path).read_bytes()
            elif "frame" in req:
                fpath = pathlib.Path(req["frame"])
                raw = fpath.read_bytes()
                if raw.startswith(b"\\x89PNG\\r\\n\\x1a\\n"):
                    width, height, data = _decode_png_rgb(raw)
                else:
                    width = int(cfg.get("default_width", 16))
                    height = int(cfg.get("default_height", 12))
                    data = raw
                pathlib.Path("last_frame_path.txt").write_text(str(fpath), encoding="utf-8")
            else:
                reply(req_id, op, False, 2, "E_REFUSE", "missing frame", None)
                continue

            prev_given = req.get("prev_raw") is not None or req.get("prev") is not None
            sha = hashlib.sha256(data).hexdigest()
            c2 = {
                "schema": "ve.cu_describe/v1",
                "frame_sha256": sha,
                "width": width,
                "height": height,
                "changed": True if prev_given else None,
                "changed_regions": (
                    [{"x": 0, "y": 0, "w": min(8, width), "h": min(8, height), "score": 0.9}]
                    if prev_given else []
                ),
                "crops": [{"x": 0, "y": 0, "w": min(8, width), "h": min(8, height), "reason": "salient"}],
                "mark_cap_reached": False,
                "timing_us": 25,
            }
            reply(req_id, op, True, 0, "OK", "", c2)

    _record_sig("STDIN_EOF")
    if cfg.get("ignore_sigterm"):
        while True:
            time.sleep(0.05)
    """
)


def _make_frame(width: int = 16, height: int = 12, fill: int = 0x2A) -> tuple[dict[str, object], Frame]:
    data = bytes([fill & 0xFF]) * (width * height * 3)
    sha = hashlib.sha256(data).hexdigest()
    ref = {
        "schema": "frame_ref/v0.1",
        "width": width,
        "height": height,
        "sha256": sha,
    }
    return ref, Frame(width=width, height=height, data=data)


def _setup_harden_ve_root(
    test_case: unittest.TestCase,
    *,
    numpy_version: str | None = "2.4.2",
    vserve_mode: dict[str, object] | None = None,
) -> Path:
    tmp = tempfile.TemporaryDirectory(prefix="mv-vcore-harden-")
    test_case.addCleanup(tmp.cleanup)
    root = Path(tmp.name)

    if numpy_version is not None:
        np_dir = root / "numpy"
        np_dir.mkdir(parents=True, exist_ok=True)
        (np_dir / "__init__.py").write_text(
            f'__version__ = "{numpy_version}"\n',
            encoding="utf-8",
        )

    vadapt_dir = root / "vadapt"
    vadapt_dir.mkdir(parents=True, exist_ok=True)
    (vadapt_dir / "__init__.py").write_text("", encoding="utf-8")
    (vadapt_dir / "vserve.py").write_text(_HARDEN_VSERVE_SOURCE, encoding="utf-8")
    if vserve_mode is not None:
        (root / "vserve_mode.json").write_text(
            json.dumps(vserve_mode), encoding="utf-8"
        )
    return root


def _secure_site_temp():
    from test_vcore_harden_r5 import secure_temp
    return secure_temp()


class VCoreHardenTests(unittest.TestCase):
    def setUp(self):
        previous = os.umask(0o022)
        self.addCleanup(os.umask, previous)

    def test_f1_interpreter_canonicalization_and_isolated_env(self) -> None:
        # Mutation caught: MUT-F1-BARE-PYTHON-AND-INHERITED-ENV
        # (_resolve_pinned_python returns a bare name or inherits PATH/HOME,
        # or _scrubbed_env omits PYTHONNOUSERSITE/PYTHONSAFEPATH).
        root = _setup_harden_ve_root(self)

        hijack_dir = tempfile.TemporaryDirectory(prefix="mv-hijack-path-")
        self.addCleanup(hijack_dir.cleanup)
        hijack_py = Path(hijack_dir.name) / "python3"
        hijack_py.write_text("#!/bin/sh\nexit 99\n", encoding="utf-8")
        hijack_py.chmod(0o755)

        fake_home = tempfile.TemporaryDirectory(prefix="mv-hijack-home-")
        self.addCleanup(fake_home.cleanup)

        with mock.patch.dict(
            os.environ,
            {
                "PATH": f"{hijack_dir.name}:/usr/bin:/bin",
                "HOME": fake_home.name,
                "LANG": "en_US.UTF-8",
            },
        ):
            env = _scrubbed_env(root)
            self.assertEqual(env["PATH"], "/usr/bin:/bin")
            self.assertEqual(env["HOME"], "/nonexistent")
            self.assertEqual(env["LANG"], "C.UTF-8")
            self.assertEqual(env["PYTHONNOUSERSITE"], "1")
            self.assertEqual(env["PYTHONSAFEPATH"], "1")
            self.assertEqual(env["PYTHONPATH"], str(root))

            resolved = _resolve_pinned_python(
                "python3", ve_root=root, timeout=2.0, candidates=["python3"]
            )
            self.assertTrue(os.path.isabs(resolved))
            self.assertEqual(resolved, os.path.realpath(resolved))
            self.assertNotEqual(resolved, "python3")
            self.assertFalse(resolved.startswith(hijack_dir.name))

            # Relative paths with slashes must be rejected.
            with self.assertRaises(PerceptionError) as rel_ctx:
                _resolve_pinned_python(
                    "./python3", ve_root=root, timeout=2.0, candidates=["./python3"]
                )
            self.assertEqual(rel_ctx.exception.code, "unavailable")

            with VCorePerceptionAdapter(
                root, python="python3", fallback_oneshot=False
            ) as adapter:
                ref, frame = _make_frame()
                vision = adapter.perceive(ref, frame)
                check_vision(vision, width=16, height=12)
                self.assertEqual(adapter._pinned_python, resolved)
                self.assertEqual(adapter.python, resolved)

            iso = json.loads((root / "vserve_isolation.json").read_text(encoding="utf-8"))
            self.assertEqual(iso["env"]["PATH"], "/usr/bin:/bin")
            self.assertEqual(iso["env"]["HOME"], "/nonexistent")
            self.assertEqual(iso["env"]["PYTHONNOUSERSITE"], "1")
            self.assertEqual(iso["env"]["PYTHONSAFEPATH"], "1")
            self.assertEqual(iso["no_user_site"], 1)
            self.assertTrue(iso["safe_path"])

        # Named mutation check (MUT-F1-BARE-PYTHON-AND-INHERITED-ENV):
        # Reverting _canonicalize_python_candidate to return bare "python3" fails the
        # absolute canonical path invariant.
        with mock.patch.object(vcore, "_canonicalize_python_candidate", side_effect=lambda c: c):
            mut_resolved = _resolve_pinned_python(
                sys.executable, ve_root=root, timeout=2.0, candidates=["python3"]
            )
            self.assertFalse(os.path.isabs(mut_resolved))

    def test_extra_site_default_override_and_probe_spawn_environment(self) -> None:
        root = _setup_harden_ve_root(self, numpy_version=None)
        with _secure_site_temp() as directory:
            site_dir = Path(directory).resolve()
            numpy = site_dir / "numpy"
            numpy.mkdir()
            (numpy / "__init__.py").write_text('__version__ = "2.4.2"\n')
            with mock.patch.dict(os.environ, {}, clear=True), mock.patch.object(
                vcore.site, "getusersitepackages", return_value=str(site_dir)
            ) as default, mock.patch.object(
                vcore, "_bounded_probe", wraps=vcore._bounded_probe
            ) as probe, mock.patch.object(
                vcore, "_spawn_vserve_proc", wraps=vcore._spawn_vserve_proc
            ) as spawn:
                with VCorePerceptionAdapter(root, fallback_oneshot=False) as adapter:
                    self.assertEqual(adapter.status["extra_site"], str(site_dir))
                    # Construction captures the parent's selection once, even if
                    # the parent environment changes before the lazy probe/spawn.
                    os.environ["MV_VCORE_SITE"] = "relative/later"
                    ref, frame = _make_frame()
                    adapter.perceive(ref, frame)
                    default.assert_called_once_with()
                    env = spawn.call_args.kwargs["env"]
                    self.assertEqual(env["PYTHONPATH"], os.pathsep.join((str(root), str(site_dir))))
                    self.assertEqual(probe.call_args.kwargs["env"], env)
                    self.assertEqual(env["PYTHONNOUSERSITE"], "1")
                    self.assertEqual(env["PYTHONSAFEPATH"], "1")
                    self.assertEqual(adapter._child_env(), env)
                    observed = json.loads((root / "vserve_isolation.json").read_text())
                    self.assertEqual(observed["env"]["PYTHONPATH"], env["PYTHONPATH"])
            with mock.patch.dict(os.environ, {"MV_VCORE_SITE": str(site_dir)}), mock.patch.object(
                vcore.site, "getusersitepackages", side_effect=AssertionError("override must win")
            ):
                self.assertEqual(VCorePerceptionAdapter(root).status["extra_site"], str(site_dir))
            with mock.patch.dict(os.environ, {"MV_VCORE_SITE": "relative"}), mock.patch.object(
                vcore.site, "getusersitepackages", return_value=str(site_dir)
            ) as default:
                self.assertIsNone(VCorePerceptionAdapter(root).status["extra_site"])
                default.assert_not_called()

    def test_extra_site_rejects_unsafe_directories_and_named_mutation(self) -> None:
        # MUT-F1-EXTRA-SITE-WITHOUT-OWNER-MODE-CHECK must fail this oracle.
        with _secure_site_temp() as directory:
            base = Path(directory).resolve()
            trusted = base / "trusted"
            trusted.mkdir(mode=0o700)
            self.assertEqual(_resolve_extra_site(str(trusted)), str(trusted))
            link = base / "link"
            link.symlink_to(trusted, target_is_directory=True)
            for raw in (str(link), str(link / ".." / "trusted"), "relative", str(base / "missing")):
                with self.subTest(path=raw):
                    self.assertIsNone(_resolve_extra_site(raw))
            regular_file = base / "file"
            regular_file.touch()
            self.assertIsNone(_resolve_extra_site(str(regular_file)))

            def assert_mode_refused() -> None:
                self.assertIsNone(_resolve_extra_site(str(trusted)))

            for mode in (0o707, 0o777):
                trusted.chmod(mode)
                assert_mode_refused()
                with mock.patch.object(vcore, "_is_trusted_site_stat", return_value=True), \
                        mock.patch.object(vcore, "_check_site_chain", return_value=trusted.stat()):
                    with self.assertRaises(AssertionError):
                        assert_mode_refused()
            trusted.chmod(0o700)
            # Mock identity rather than chown: portable without elevated rights.
            with mock.patch.object(vcore.os, "geteuid", return_value=trusted.stat().st_uid + 1):
                assert_mode_refused()
                with mock.patch.object(vcore, "_is_trusted_site_stat", return_value=True), \
                        mock.patch.object(vcore, "_check_site_chain", return_value=trusted.stat()):
                    with self.assertRaises(AssertionError):
                        assert_mode_refused()

    def test_extra_site_private_group_and_member_check_mutation(self) -> None:
        with _secure_site_temp() as directory:
            trusted = Path(directory).resolve()
            trusted.chmod(0o775)
            gid = trusted.stat().st_gid
            user = mock.Mock(pw_name="site-owner", pw_gid=gid)
            group = mock.Mock(gr_name="site-owner", gr_mem=[])
            with mock.patch.object(vcore.os, "getgid", return_value=gid), \
                    mock.patch.object(vcore.pwd, "getpwuid", return_value=user), \
                    mock.patch.object(vcore.grp, "getgrgid", return_value=group):
                for members in ([], [user.pw_name]):
                    group.gr_mem = members
                    self.assertTrue(vcore._is_trusted_site_stat(trusted.stat()))

                def assert_shared_refused() -> None:
                    self.assertFalse(vcore._is_trusted_site_stat(trusted.stat()))

                for members in (["another-user"], [user.pw_name, "another-user"]):
                    group.gr_mem = members
                    assert_shared_refused()
                    # MUT-F1-PRIVATE-GROUP-DROP-MEMBER-CHECK: retain the other
                    # predicates but remove membership as an admission condition.
                    with mock.patch.object(vcore, "_is_trusted_site_stat", side_effect=lambda info: (
                        info.st_uid == os.geteuid()
                        and not info.st_mode & stat.S_IWOTH
                        and info.st_gid == os.getgid() == user.pw_gid
                        and group.gr_name == user.pw_name
                    )):
                        with self.assertRaises(AssertionError):
                            assert_shared_refused()
                group.gr_mem = []
                group.gr_name = "shared"
                assert_shared_refused()
                group.gr_name = user.pw_name
                user.pw_gid = gid + 1
                assert_shared_refused()
                user.pw_gid = gid
                with mock.patch.object(vcore.os, "getgid", return_value=gid + 1):
                    assert_shared_refused()
                trusted.chmod(0o777)
                assert_shared_refused()
                trusted.chmod(0o775)
                for lookup in (vcore.pwd.getpwuid, vcore.grp.getgrgid):
                    lookup.side_effect = KeyError("missing identity")
                    assert_shared_refused()
                    lookup.side_effect = None

    def test_f2_explicit_fd_and_session_isolation(self) -> None:
        # Mutation caught: MUT-F2-IMPLICIT-FDS-AND-SHARED-PGROUP
        # (_spawn_vserve_proc or _run_bounded omits close_fds=True, pass_fds=(),
        # or start_new_session=True).
        r_fd, w_fd = os.pipe()
        self.addCleanup(lambda: os.close(w_fd))
        self.addCleanup(lambda: os.close(r_fd))
        os.set_inheritable(r_fd, True)

        root = _setup_harden_ve_root(self, vserve_mode={"check_fd": r_fd})
        with VCorePerceptionAdapter(
            root, python=sys.executable, fallback_oneshot=False
        ) as adapter:
            ref, frame = _make_frame()
            adapter.perceive(ref, frame)

        iso = json.loads((root / "vserve_isolation.json").read_text(encoding="utf-8"))
        self.assertFalse(iso["fd_open"])
        self.assertEqual(iso["pgid"], iso["pid"])
        self.assertEqual(iso["sid"], iso["pid"])
        self.assertNotEqual(iso["pgid"], os.getpgrp())

        # Verify explicit kwargs on both _spawn_vserve_proc and _run_bounded Popen calls.
        recorded_kwargs: list[dict[str, object]] = []
        real_popen = subprocess.Popen

        def spy_popen(*args, **kwargs):
            recorded_kwargs.append(dict(kwargs))
            return real_popen(*args, **kwargs)

        with mock.patch.object(subprocess, "Popen", side_effect=spy_popen):
            proc = _spawn_vserve_proc(
                [sys.executable, "-c", "pass"],
                cwd=str(root),
                env=_scrubbed_env(root),
            )
            proc.stdin.close()
            proc.stdout.close()
            proc.stderr.close()
            proc.wait(timeout=2.0)

            _run_bounded(
                [sys.executable, "-c", "print('{}')"],
                cwd=str(root),
                env=_scrubbed_env(root),
                stdin=subprocess.DEVNULL,
                timeout=2.0,
            )

        self.assertEqual(len(recorded_kwargs), 2)
        for call_kw in recorded_kwargs:
            self.assertIs(call_kw.get("close_fds"), True)
            self.assertEqual(call_kw.get("pass_fds"), ())
            self.assertIs(call_kw.get("start_new_session"), True)

        # Named mutation check (MUT-F2-IMPLICIT-FDS-AND-SHARED-PGROUP):
        # Reverting start_new_session=False puts child in parent's process group.
        mut_proc = real_popen(
            [sys.executable, "-c", "import os, sys; print(os.getpgid(0))"],
            cwd=str(root),
            env=_scrubbed_env(root),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            close_fds=True,
            pass_fds=(),
            start_new_session=False,
        )
        out, _ = mut_proc.communicate(timeout=2.0)
        if mut_proc.stdout is not None:
            mut_proc.stdout.close()
        if mut_proc.stderr is not None:
            mut_proc.stderr.close()
        self.assertEqual(int(out.strip()), os.getpgrp())

    def test_f3_persistent_frame_path_open_time_checks(self) -> None:
        # Mutation caught: MUT-F3-UNCHECKED-FRAME-PATH
        # (_perceive_vserve forwards _existing_frame_path without O_NOFOLLOW open,
        # S_ISREG, st_uid == geteuid, or size == header checks).
        root = _setup_harden_ve_root(
            self, vserve_mode={"default_width": 16, "default_height": 12}
        )
        shm_tmp = tempfile.TemporaryDirectory(prefix="mv-f3-shm-", dir="/dev/shm")
        self.addCleanup(shm_tmp.cleanup)
        shm_dir = Path(shm_tmp.name)

        ref, frame = _make_frame(width=16, height=12, fill=0x44)
        _, prev_frame = _make_frame(width=16, height=12, fill=0x22)

        with VCorePerceptionAdapter(
            root, python=sys.executable, fallback_oneshot=False
        ) as adapter:
            # 1. Valid raw RGB24 file and PNG file in /dev/shm succeed and use pinned snapshot.
            valid_rgb = shm_dir / "valid.rgb"
            valid_rgb.write_bytes(frame.data)
            valid_png = shm_dir / "valid.png"
            valid_png.write_bytes(_png_bytes(prev_frame))

            vision = adapter.perceive(ref, valid_rgb, prev=valid_png)
            check_vision(vision, width=16, height=12)
            pinned_used = (root / "last_frame_path.txt").read_text(encoding="utf-8")
            self.assertNotEqual(pinned_used, str(valid_rgb))
            self.assertTrue(pinned_used.startswith("/dev/shm/mv-vcore-frame-"))
            self.assertFalse(os.path.exists(pinned_used))

            # 2. Internal symlink inside /dev/shm refused with bad_shape.
            sym_path = shm_dir / "symlink.rgb"
            sym_path.symlink_to(valid_rgb)
            with self.assertRaises(PerceptionError) as sym_ctx:
                adapter.perceive(ref, sym_path)
            self.assertEqual(sym_ctx.exception.code, "bad_shape")

            # 3. Named FIFO in /dev/shm refused immediately without blocking (O_NONBLOCK + S_ISREG).
            fifo_path = shm_dir / "fifo.rgb"
            os.mkfifo(fifo_path)
            t0 = time.monotonic()
            with self.assertRaises(PerceptionError) as fifo_ctx:
                adapter.perceive(ref, fifo_path)
            self.assertEqual(fifo_ctx.exception.code, "bad_shape")
            self.assertLess(time.monotonic() - t0, 1.0)

            # 4. Wrong byte size (size != header) and huge sparse file refused with bad_shape.
            short_rgb = shm_dir / "short.rgb"
            short_rgb.write_bytes(b"x" * 17)
            with self.assertRaises(PerceptionError) as short_ctx:
                adapter.perceive(ref, short_rgb)
            self.assertEqual(short_ctx.exception.code, "bad_shape")

            sparse_rgb = shm_dir / "sparse.rgb"
            with open(sparse_rgb, "wb") as f:
                f.truncate(64 * 1024 * 1024)
            with self.assertRaises(PerceptionError) as sparse_ctx:
                adapter.perceive(ref, sparse_rgb)
            self.assertEqual(sparse_ctx.exception.code, "bad_shape")

            # 5. PNG with mismatched IHDR dimensions refused with bad_shape.
            _, wrong_dim_frame = _make_frame(width=8, height=8, fill=0x44)
            bad_png = shm_dir / "bad_dims.png"
            bad_png.write_bytes(_png_bytes(wrong_dim_frame))
            with self.assertRaises(PerceptionError) as png_ctx:
                adapter.perceive(ref, bad_png)
            self.assertEqual(png_ctx.exception.code, "bad_shape")

            # 6. Foreign UID owner refused on both _verify_and_pin_frame_path and _ramws_frame.
            real_fstat = os.fstat

            def foreign_uid_fstat(fd: int):
                st = real_fstat(fd)
                vals = list(st)
                vals[4] = os.geteuid() + 1000
                return os.stat_result(vals)

            with mock.patch.object(os, "fstat", side_effect=foreign_uid_fstat):
                with self.assertRaises(PerceptionError) as uid_ctx:
                    adapter.perceive(ref, valid_rgb)
                self.assertEqual(uid_ctx.exception.code, "bad_shape")

                with self.assertRaises(PerceptionError) as ramws_uid_ctx:
                    _ramws_frame({"ramws_path": str(valid_rgb)}, 16, 12)
                self.assertEqual(ramws_uid_ctx.exception.code, "bad_shape")

            # Named mutation check (MUT-F3-UNCHECKED-FRAME-PATH):
            # Reverting _verify_and_pin_frame_path to skip open-time fstat/size checks
            # fails to reject short_rgb before handoff.
            with mock.patch.object(
                vcore,
                "_verify_and_pin_frame_path",
                side_effect=lambda val, **kw: str(Path(val).resolve()),
            ):
                with ExitStack() as stack:
                    leaked_path = vcore._verify_and_pin_frame_path(
                        short_rgb, width=16, height=12, stack=stack
                    )
                    self.assertEqual(leaked_path, str(short_rgb))

    def test_f4_thread_safe_queue_cap_and_serialized_pipe_io(self) -> None:
        # Mutation caught: MUT-F4-UNLOCKED-QUEUE-AND-PIPE
        # (_BoundedRequestQueue clamps release at 0 or concurrent perceive calls
        # interleave request/reply lines on vserve pipes).
        q = _BoundedRequestQueue(capacity=2)
        with self.assertRaises(PerceptionError) as underflow_ctx:
            q.release()
        self.assertEqual(underflow_ctx.exception.code, "bad_shape")

        q.acquire()
        q.release()
        with self.assertRaises(PerceptionError) as double_rel_ctx:
            q.release()
        self.assertEqual(double_rel_ctx.exception.code, "bad_shape")

        root = _setup_harden_ve_root(self, vserve_mode={"describe_delay_s": 0.015})
        with VCorePerceptionAdapter(
            root,
            python=sys.executable,
            queue_cap=4,
            timeout=5.0,
            fallback_oneshot=False,
        ) as adapter:
            adapter._vserve_start()

            def worker(idx: int) -> None:
                for step in range(4):
                    fill = ((idx * 31) + step + 1) & 0xFF
                    ref, frame = _make_frame(width=16, height=12, fill=fill)
                    vision = adapter.perceive(ref, frame)
                    check_vision(vision, width=16, height=12)
                    self.assertEqual(vision.frame_sha256, ref["sha256"])

            with ThreadPoolExecutor(max_workers=4) as pool:
                futures = [pool.submit(worker, i) for i in range(4)]
                for fut in futures:
                    fut.result(timeout=10.0)
            self.assertEqual(len(adapter._vserve_queue), 0)

        # Named mutation check (MUT-F4-UNLOCKED-QUEUE-AND-PIPE):
        # Clamping release() at 0 masks double-release bugs instead of raising bad_shape.
        def clamped_release(self_q: _BoundedRequestQueue) -> None:
            if self_q._in_flight > 0:
                self_q._in_flight -= 1

        with mock.patch.object(_BoundedRequestQueue, "release", clamped_release):
            mut_q = _BoundedRequestQueue(capacity=2)
            mut_q.release()
            self.assertEqual(mut_q.in_flight, 0)

    def test_f5_unified_restart_budget_and_recovery_after_n_replies(self) -> None:
        # Mutation caught: MUT-F5-BYPASS-TIMEOUT-OR-NO-RECOVERY
        # (timeout respawns for free without incrementing _vserve_restarts, or
        # _vserve_restarts never resets after _VSERVE_RESTART_RECOVERY_REPLIES).

        # Part A: hanging server that times out on describe cannot respawn past max_restarts.
        hang_root = _setup_harden_ve_root(self, vserve_mode={"hang_on_describe": True})
        with VCorePerceptionAdapter(
            hang_root,
            python=sys.executable,
            timeout=0.15,
            max_restarts=1,
            fallback_oneshot=False,
        ) as hang_adapter:
            ref, frame = _make_frame()
            # Boot 1: initial start + timeout on describe.
            with self.assertRaises(PerceptionError) as t1:
                hang_adapter.perceive(ref, frame)
            self.assertEqual(t1.exception.code, "timeout")
            self.assertEqual(hang_adapter._vserve_restarts, 0)

            # Boot 2: consumes the 1 allowed restart in _vserve_start, then times out.
            with self.assertRaises(PerceptionError) as t2:
                hang_adapter.perceive(ref, frame)
            self.assertEqual(t2.exception.code, "timeout")
            self.assertEqual(hang_adapter._vserve_restarts, 1)

            # Call 3: restart budget is exhausted -> fails immediately with unavailable, no boot 3.
            with self.assertRaises(PerceptionError) as t3:
                hang_adapter.perceive(ref, frame)
            self.assertEqual(t3.exception.code, "unavailable")
            self.assertEqual(
                int((hang_root / "vserve_boots.txt").read_text(encoding="utf-8")), 2
            )

        # Part B: restart budget recovers to 0 after _VSERVE_RESTART_RECOVERY_REPLIES successes.
        rec_root = _setup_harden_ve_root(
            self, vserve_mode={"crash_on_boots": [1, 2]}
        )
        # First verify recovery on boot 2 when only boot 1 crashes.
        (rec_root / "vserve_mode.json").write_text(
            json.dumps({"crash_on_boots": [1]}), encoding="utf-8"
        )
        with VCorePerceptionAdapter(
            rec_root,
            python=sys.executable,
            max_restarts=1,
            fallback_oneshot=False,
        ) as rec_adapter:
            ref, frame = _make_frame()
            # First perceive crashes boot 1, respawns boot 2 (_vserve_restarts == 1),
            # and completes 1 successful describe (streak == 1).
            rec_adapter.perceive(ref, frame)
            self.assertEqual(rec_adapter._vserve_restarts, 1)
            self.assertEqual(rec_adapter._vserve_success_streak, 1)

            for expected_streak in range(2, _VSERVE_RESTART_RECOVERY_REPLIES):
                rec_adapter.perceive(ref, frame)
                self.assertEqual(rec_adapter._vserve_restarts, 1)
                self.assertEqual(rec_adapter._vserve_success_streak, expected_streak)

            # N-th successful describe restores _vserve_restarts to 0.
            rec_adapter.perceive(ref, frame)
            self.assertEqual(rec_adapter._vserve_restarts, 0)

            # Because the budget recovered, another forced restart now succeeds (boot 3).
            rec_adapter._vserve_restart()
            self.assertEqual(rec_adapter._vserve_restarts, 1)
            self.assertEqual(
                int((rec_root / "vserve_boots.txt").read_text(encoding="utf-8")), 3
            )

    def test_f6_strict_reply_correlation_and_desync_close_respawn(self) -> None:
        # Mutation caught: MUT-F6-ACCEPT-NULL-CORRELATION-OR-SMUGGLED-BYTES
        # (_parse_vserve_reply accepts request_id: null or op mismatch when ok=False,
        # or _vserve_roundtrip leaves smuggled bytes in _vserve_rx_buf without closing/respawning).
        null_id_err = {
            "code": "E_PARSE",
            "detail": "uncorrelated error",
            "ok": False,
            "op": "describe",
            "rc": 2,
            "request_id": None,
            "result": None,
            "schema": VSERVE_REPLY_SCHEMA,
        }
        with self.assertRaises(PerceptionError) as ctx_null_id:
            _parse_vserve_reply(
                json.dumps(null_id_err), expected_id=1, expected_op="describe"
            )
        self.assertEqual(ctx_null_id.exception.code, "bad_shape")

        wrong_op_err = dict(null_id_err, request_id=1, op="hello")
        with self.assertRaises(PerceptionError) as ctx_wrong_op:
            _parse_vserve_reply(
                json.dumps(wrong_op_err), expected_id=1, expected_op="describe"
            )
        self.assertEqual(ctx_wrong_op.exception.code, "bad_shape")

        null_op_err = dict(null_id_err, request_id=1, op=None)
        with self.assertRaises(PerceptionError) as ctx_null_op:
            _parse_vserve_reply(
                json.dumps(null_op_err), expected_id=1, expected_op="describe"
            )
        self.assertEqual(ctx_null_op.exception.code, "bad_shape")

        # 1. Server sending request_id: null error on boot 1 closes and respawns on boot 2.
        null_boot_root = _setup_harden_ve_root(
            self, vserve_mode={"null_error_on_boot1": True}
        )
        with VCorePerceptionAdapter(
            null_boot_root,
            python=sys.executable,
            max_restarts=1,
            fallback_oneshot=False,
        ) as adapter:
            ref, frame = _make_frame()
            vision = adapter.perceive(ref, frame)
            check_vision(vision, width=16, height=12)
            self.assertEqual(adapter._vserve_restarts, 1)
            self.assertEqual(
                int((null_boot_root / "vserve_boots.txt").read_text(encoding="utf-8")), 2
            )

        # 2. Server sending pipelined / smuggled second JSON line on boot 1 closes and respawns on boot 2.
        pipe_boot_root = _setup_harden_ve_root(
            self, vserve_mode={"pipelined_on_boot1": True}
        )
        with VCorePerceptionAdapter(
            pipe_boot_root,
            python=sys.executable,
            max_restarts=1,
            fallback_oneshot=False,
        ) as pipe_adapter:
            ref, frame = _make_frame()
            vision = pipe_adapter.perceive(ref, frame)
            check_vision(vision, width=16, height=12)
            self.assertEqual(pipe_adapter._vserve_restarts, 1)
            self.assertEqual(len(pipe_adapter._vserve_rx_buf), 0)
            self.assertEqual(
                int((pipe_boot_root / "vserve_boots.txt").read_text(encoding="utf-8")), 2
            )

        # Named mutation check (MUT-F6-ACCEPT-NULL-CORRELATION-OR-SMUGGLED-BYTES):
        # Without expected_id enforcement on ok=False, null_id_err would map rc=4 to STALE_FRAME
        # instead of rejecting uncorrelated request_id: null as bad_shape.
        stale_null_id = dict(null_id_err, rc=4, code="E_STALE")
        with self.assertRaises(PerceptionError) as ctx_stale_null:
            _parse_vserve_reply(
                json.dumps(stale_null_id), expected_id=7, expected_op="describe"
            )
        self.assertEqual(ctx_stale_null.exception.code, "bad_shape")

    def test_f7_graceful_shutdown_sigterm_escalation_and_reap(self) -> None:
        # Mutation caught: MUT-F7-SIGKILL-FIRST-OR-ZOMBIE-LEAK
        # (_vserve_close_proc kills immediately with SIGKILL before stdin-close + SIGTERM,
        # or fails to reap a SIGTERM-ignoring server).
        root = _setup_harden_ve_root(self, vserve_mode={"ignore_sigterm": True})
        adapter = VCorePerceptionAdapter(
            root, python=sys.executable, fallback_oneshot=False
        )
        self.addCleanup(adapter.close)

        ref, frame = _make_frame()
        vision = adapter.perceive(ref, frame)
        check_vision(vision, width=16, height=12)
        pid = int((root / "vserve.pid").read_text(encoding="utf-8"))
        self.assertIsNotNone(adapter._vserve_proc)
        self.assertIsNotNone(adapter._atexit_cb)

        adapter.close()
        self.assertIsNone(adapter._vserve_proc)
        self.assertIsNone(adapter._atexit_cb)

        # Child must be completely terminated and reaped (no zombie, no orphan).
        with self.assertRaises(ChildProcessError):
            os.waitpid(pid, os.WNOHANG)
        self.assertFalse((Path("/proc") / str(pid)).exists())

        signals_seen = (root / "vserve_signals.txt").read_text(encoding="utf-8").splitlines()
        self.assertIn("STDIN_EOF", signals_seen)
        self.assertIn("SIGTERM_SEEN", signals_seen)

        # Named mutation check (MUT-F7-SIGKILL-FIRST-OR-ZOMBIE-LEAK):
        # If close_proc sent SIGKILL immediately without closing stdin and sending SIGTERM,
        # a SIGTERM-ignoring child would never record STDIN_EOF or SIGTERM_SEEN.
        mut_root = _setup_harden_ve_root(self, vserve_mode={"ignore_sigterm": True})
        mut_adapter = VCorePerceptionAdapter(
            mut_root, python=sys.executable, fallback_oneshot=False
        )
        self.addCleanup(mut_adapter.close)
        mut_adapter.perceive(ref, frame)
        assert mut_adapter._vserve_proc is not None
        mut_adapter._vserve_proc.kill()
        mut_adapter._vserve_proc.wait(timeout=2.0)
        mut_signals = (
            (mut_root / "vserve_signals.txt").read_text(encoding="utf-8").splitlines()
            if (mut_root / "vserve_signals.txt").exists()
            else []
        )
        self.assertNotIn("SIGTERM_SEEN", mut_signals)


if __name__ == "__main__":
    unittest.main()

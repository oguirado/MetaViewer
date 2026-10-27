#!/usr/bin/env python3
"""Bounded display-driven stack using the shipped, unchanged Electron entry.

[TARGET, unit decision] A detached supervisor owns the UI-independent agent
connection, lock and TTL. State is a private recovery receipt; uncertain cleanup
retains it and refuses another start. No debug endpoint or host-binding override.
"""

import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import secrets
import select
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
import live  # noqa: E402

ROOT = live.ROOT
REQUIRED = ("XDG_RUNTIME_DIR", "MV_SRF_BIN_DIR", "MV_SRF_LIVE_PROFILE",
            "MV_SRF_LIVE_RAM_ROOT", "MV_SRF_STATE_DIR", "SRF_IDENTITY_STORE_ROOT",
            "SRF_PROXY_REGISTRY", "MV_E2E_ELECTRON_BIN")
MAX_STATE_BYTES = 65536
MAX_STATE_PIDS = 256
MAX_STATE_CAPSULES = 16
MAX_STATE_PUBLISHED = 16
MAX_STATE_ERROR_CHARS = 4096
ALLOWED_STATE_KEYS = (
    "schema", "status", "supervisor", "pids", "capsules", "published",
    "work", "display", "xauthority", "surface_id", "expires", "error",
    "display_mode", "record_path", "recorder",
)
RECORDER_STOP_TIMEOUT_S = 10.0


class StackError(RuntimeError):
    """[TARGET, unit decision] Typed preflight and recorder error for stack.py."""

    def __init__(self, code, message):
        self.code = code
        self.detail = message
        super().__init__(f"{code}: {message}")


def ttl_seconds(value):
    match = re.fullmatch(r"([1-9][0-9]*)(s|m|h)", value)
    if not match:
        raise argparse.ArgumentTypeError("TTL requires a positive integer and s, m or h")
    seconds = int(match[1]) * {"s": 1, "m": 60, "h": 3600}[match[2]]
    if seconds > 86400:
        raise argparse.ArgumentTypeError("TTL exceeds one day")
    return seconds


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    commands = result.add_subparsers(dest="command", required=True)
    start_cmd = commands.add_parser("start")
    start_cmd.add_argument("--ttl", type=ttl_seconds, default="45m")
    start_cmd.add_argument("--display", choices=("private", "visible"), default="private")
    start_cmd.add_argument("--record", default=None, metavar="PATH.mp4")
    commands.add_parser("stop")
    return result


def private_dir(path):
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise RuntimeError("private owner-only directory required: " + str(path))
    return path


def state_root():
    runtime = os.environ.get("XDG_RUNTIME_DIR", "")
    if not runtime or not Path(runtime).is_absolute():
        raise RuntimeError("XDG_RUNTIME_DIR AUSENTE or not absolute")
    root = private_dir(Path(runtime)) / "metaviewer-live-stack"
    root.mkdir(mode=0o700, exist_ok=True)
    return private_dir(root)


def bounded_state(value):
    result = {key: value[key] for key in ALLOWED_STATE_KEYS if key in value}
    if "pids" in result:
        seen = set()
        pids = []
        for row in result["pids"]:
            if isinstance(row, dict):
                key = (row.get("pid"), row.get("identity"))
                if key not in seen:
                    seen.add(key)
                    pids.append({"pid": row.get("pid"), "identity": row.get("identity")})
        result["pids"] = pids[:MAX_STATE_PIDS]
    if "capsules" in result:
        result["capsules"] = sorted(
            name for name in set(result["capsules"])
            if isinstance(name, str) and live.CAPSULE_ID_RE.fullmatch(name)
        )[:MAX_STATE_CAPSULES]
    if "published" in result:
        result["published"] = sorted(set(str(p) for p in result["published"]))[:MAX_STATE_PUBLISHED]
    if "recorder" in result:
        rec = result["recorder"]
        if isinstance(rec, dict):
            result["recorder"] = {"pid": rec.get("pid"), "identity": rec.get("identity")}
        else:
            result.pop("recorder", None)
    if isinstance(result.get("error"), str) and len(result["error"]) > MAX_STATE_ERROR_CHARS:
        result["error"] = result["error"][-MAX_STATE_ERROR_CHARS:]
    return result


def save_state(root, value):
    bounded = bounded_state(value)
    value.clear()
    value.update(bounded)
    payload = json.dumps(bounded, sort_keys=True)
    if len(payload.encode("utf-8")) > MAX_STATE_BYTES:
        raise RuntimeError("bounded live stack state exceeds limit")
    fd, temporary = tempfile.mkstemp(prefix=".state-", dir=root)
    try:
        with os.fdopen(fd, "w") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, root / "state.json")
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def load_state(root):
    fd = os.open(root / "state.json", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd) as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > MAX_STATE_BYTES:
            raise RuntimeError("unsafe live stack state")
        state = json.load(stream)
    if state.get("schema") != "metaviewer.live-stack/v1":
        raise RuntimeError("unknown live stack state")
    return state


def identity(pid):
    if type(pid) is not int or pid <= 1:
        return None
    try:
        fields = Path("/proc", str(pid), "stat").read_text().rsplit(")", 1)[1].split()
        return None if fields[0] == "Z" else fields[19]
    except FileNotFoundError:
        return None


def signal_record(record, sig):
    pid = record.get("pid")
    if type(pid) is not int or pid <= 1 or pid == os.getpid():
        raise RuntimeError("unsafe recorded pid")
    if record.get("identity") is not None and identity(pid) == record["identity"]:
        try:
            if os.getpgid(pid) == os.getpgrp():
                raise RuntimeError("recorded pid shares caller process group")
            os.kill(pid, sig)
        except ProcessLookupError:
            pass


def alive(record):
    return record.get("identity") is not None and identity(record.get("pid")) == record["identity"]


def gw1_active():
    for path in Path("/proc").glob("[0-9]*/cmdline"):
        try:
            args = path.read_bytes().split(b"\0")
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            continue
        if any(arg.endswith(b"/e2e1_slice/live.py") for arg in args):
            return True
        if b"--live" in args and any(arg.endswith(b"/e2e1_slice/index.js") for arg in args):
            return True
    return False


def checked(argv, **kwargs):
    result = subprocess.run([str(x) for x in argv], capture_output=True, text=True,
                            timeout=300, **kwargs)
    if result.returncode:
        raise RuntimeError(f"rc={result.returncode} {argv!r}: {result.stderr[-2000:]}")
    return result.stdout.strip()


def inventory():
    return set(checked(["docker", "ps", "-a", "--format", "{{.Names}}"]).splitlines())


def _which(tool, env=None, which_fn=None):
    if which_fn is not None:
        return which_fn(tool)
    if env is not None and "PATH" in env:
        return shutil.which(tool, path=env["PATH"])
    return shutil.which(tool)


def validate_display(display_mode, env=None, which_fn=None, checked_fn=None):
    env = os.environ if env is None else env
    checked_fn = checked if checked_fn is None else checked_fn
    if display_mode not in ("private", "visible"):
        raise StackError("DISPLAY_MODE_INVALID", f"unsupported display mode: {display_mode!r}")
    if display_mode == "visible":
        display = env.get("DISPLAY", "").strip()
        if not display:
            raise StackError("DISPLAY_UNSET", "DISPLAY AUSENTE for --display visible")
        if not _which("xdpyinfo", env=env, which_fn=which_fn):
            raise StackError("DISPLAY_UNREACHABLE", "tool AUSENTE: xdpyinfo")
        probe_env = dict(env, DISPLAY=display)
        xauth = env.get("XAUTHORITY", "").strip()
        if xauth:
            probe_env["XAUTHORITY"] = xauth
        try:
            checked_fn(["xdpyinfo"], env=probe_env)
        except Exception as exc:
            raise StackError(
                "DISPLAY_UNREACHABLE",
                f"DISPLAY {display} unreachable via xdpyinfo: {exc}",
            ) from exc
        return {"display": display, "xauthority": xauth}
    return None


def validate_record_path(record_path, repo_root=None, env=None, which_fn=None):
    if record_path is None:
        return None
    repo = Path(ROOT if repo_root is None else repo_root).resolve(strict=False)
    raw = str(record_path).strip()
    if not raw or not raw.endswith(".mp4"):
        raise StackError("RECORD_PATH_INVALID", f"record path must end with .mp4: {record_path!r}")
    expanded = Path(raw).expanduser()
    resolved = expanded.resolve(strict=False)
    if resolved == repo or repo in resolved.parents:
        raise StackError("RECORD_PATH_IN_REPO", f"record path inside repository refused: {resolved}")
    if expanded.exists() or expanded.is_symlink() or resolved.exists() or resolved.is_symlink():
        raise StackError("RECORD_PATH_EXISTS", f"record path already exists: {resolved}")
    if not resolved.parent.is_dir():
        raise StackError("RECORD_PATH_INVALID", f"record parent directory AUSENTE: {resolved.parent}")
    if not _which("ffmpeg", env=env, which_fn=which_fn):
        raise StackError("FFMPEG_MISSING", "tool AUSENTE: ffmpeg")
    return resolved


def parse_display_dimensions(xdpyinfo_output):
    match = re.search(r"\bdimensions:\s+([1-9][0-9]*x[1-9][0-9]*)\s+pixels\b", str(xdpyinfo_output))
    if not match:
        raise StackError("DISPLAY_SIZE_UNAVAILABLE", "could not parse dimensions from xdpyinfo")
    return match.group(1)


def ffmpeg_record_argv(display, size, output_path, ffmpeg_bin="ffmpeg"):
    if not str(display).strip():
        raise StackError("DISPLAY_UNSET", "display required for ffmpeg x11grab")
    if not re.fullmatch(r"[1-9][0-9]*x[1-9][0-9]*", str(size)):
        raise StackError("DISPLAY_SIZE_UNAVAILABLE", f"invalid display size: {size!r}")
    return [
        str(ffmpeg_bin),
        "-f", "x11grab",
        "-video_size", str(size),
        "-framerate", "30",
        "-i", str(display),
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-pix_fmt", "yuv420p",
        str(output_path),
    ]


def start_recorder(state, work, env, checked_fn=None, popen_fn=None, identity_fn=None):
    checked_fn = checked if checked_fn is None else checked_fn
    popen_fn = subprocess.Popen if popen_fn is None else popen_fn
    identity_fn = identity if identity_fn is None else identity_fn
    size = parse_display_dimensions(checked_fn(["xdpyinfo"], env=env))
    ffmpeg_bin = _which("ffmpeg", env=env) or "ffmpeg"
    argv = ffmpeg_record_argv(state["display"], size, state["record_path"], ffmpeg_bin=ffmpeg_bin)
    with open(Path(work) / "ffmpeg.log", "w") as log:
        proc = popen_fn([str(x) for x in argv], cwd=ROOT, env=env,
                        stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                        start_new_session=True)
    record = {"pid": proc.pid, "identity": identity_fn(proc.pid)}
    state["recorder"] = record
    state.setdefault("pids", []).append(record)
    return proc


def stop_recorder(state, signal_fn=None, alive_fn=None, monotonic_fn=None,
                  sleep_fn=None, timeout=RECORDER_STOP_TIMEOUT_S):
    signal_fn = signal_record if signal_fn is None else signal_fn
    alive_fn = alive if alive_fn is None else alive_fn
    monotonic_fn = time.monotonic if monotonic_fn is None else monotonic_fn
    sleep_fn = time.sleep if sleep_fn is None else sleep_fn
    recorder = state.get("recorder")
    if not isinstance(recorder, dict) or recorder.get("pid") is None:
        return False
    if not alive_fn(recorder):
        return False
    signal_fn(recorder, signal.SIGINT)
    deadline = monotonic_fn() + timeout
    while alive_fn(recorder) and monotonic_fn() < deadline:
        sleep_fn(0.05)
    return True


def preflight(root, display_mode="private", record_path=None):
    if (root / "state.json").exists() or gw1_active():
        raise RuntimeError("another live stack or G-W1 run is active; refusing")
    validate_record_path(record_path)
    validate_display(display_mode)
    missing = [key for key in REQUIRED if not os.environ.get(key)]
    if missing:
        raise RuntimeError("live env AUSENTE: " + ", ".join(missing))
    if os.environ.get("MV_E2E_LIVE") != "1" or os.environ["MV_SRF_LIVE_PROFILE"] != "mv-live-1":
        raise RuntimeError("explicit MV_E2E_LIVE=1 and mv-live-1 required")
    for key in REQUIRED:
        if key != "MV_SRF_LIVE_PROFILE":
            path = Path(os.environ[key])
            if not path.is_absolute() or not path.exists():
                raise RuntimeError("live path AUSENTE: " + key)
    required_tools = ("docker", "xdpyinfo", "xwininfo") if display_mode == "visible" else (
        "docker", "Xvfb", "xauth", "xdpyinfo", "xwininfo")
    for tool in required_tools:
        if not shutil.which(tool):
            raise RuntimeError("tool AUSENTE: " + tool)
    if os.environ.get("MV_CORE_BOOTSTRAP") is not None:
        raise RuntimeError("shipped host bindings require MV_CORE_BOOTSTRAP unset")
    before = inventory()
    if live.profile_containers("mv-live-1") or any("mv-live-1" in name for name in before):
        raise RuntimeError("profile already allocated; refusing")
    for path in (ROOT / "ui/dist/renderer/index.html", ROOT / "ui/dist/preload/preload.cjs"):
        if not path.is_file():
            raise RuntimeError("shipped UI build AUSENTE: " + str(path))
    return before


def binaries(work):
    result = {}
    for role, key in (("core", "MV_E2E_CORE_BIN"), ("adapter", "MV_E2E_ADAPTER_BIN")):
        supplied = os.environ.get(key)
        if supplied:
            binary = Path(supplied).resolve(strict=True)
        elif role == "core":
            target = os.environ.get("CARGO_TARGET_DIR")
            if not target or not Path(target).is_absolute():
                raise RuntimeError("absolute per-worktree CARGO_TARGET_DIR required")
            checked([os.environ.get("CARGO", "cargo"), "build", "--offline", "--manifest-path",
                     ROOT / "core/Cargo.toml", "--bin", "metaviewer-core"], cwd=ROOT)
            binary = Path(target) / "debug/metaviewer-core"
        else:
            binary = work / "mv-daemon-adapter"
            checked([os.environ.get("GO", "go"), "build", "-o", binary, "./cmd/mv-daemon-adapter"],
                    cwd=ROOT / "daemon-adapter", env=dict(os.environ, GOPROXY="off", GOSUMDB="off"))
        if not binary.is_file() or not os.access(binary, os.X_OK):
            raise RuntimeError("executable AUSENTE: " + str(binary))
        result[role] = binary
    return result


def electron_environment(env):
    # Same loader/environment exclusion as the shipped coreLauncher. In
    # particular the host's stdbuf LD_PRELOAD must not enter the retail app.
    prefixes = ("DYLD_", "ELECTRON_", "LD_", "NODE_", "PYTHON")
    exact = {"BASH_ENV", "ENV", "GCONV_PATH", "HOSTALIASES", "ZDOTDIR"}
    return {key: value for key, value in env.items()
            if key not in exact and not key.startswith(prefixes)}


def _proc_stat_entries():
    entries = []
    for path in Path("/proc").glob("[0-9]*/stat"):
        try:
            fields = path.read_text().rsplit(")", 1)[1].split()
            entries.append((int(path.parent.name), int(fields[1]), fields[0], fields[19]))
        except (FileNotFoundError, ProcessLookupError, ValueError):
            continue
    return entries


def remember_tree(state, root):
    """Record identities of live descendants before any later signal; never killpg."""
    live_rows = []
    parents = set()
    for row in state.get("pids", ()):
        pid = row.get("pid")
        if pid not in parents and alive(row):
            live_rows.append({"pid": pid, "identity": row["identity"]})
            parents.add(pid)
    known = set(parents)
    entries = _proc_stat_entries()
    pending = True
    while pending and len(live_rows) < MAX_STATE_PIDS:
        pending = False
        for pid, ppid, proc_state, start_time in entries:
            if len(live_rows) >= MAX_STATE_PIDS:
                break
            if ppid in parents and pid not in known and proc_state != "Z":
                live_rows.append({"pid": pid, "identity": start_time})
                parents.add(pid)
                known.add(pid)
                pending = True
    state["pids"] = live_rows
    save_state(root, state)


def cleanup(state, root, *, signal_fn=None, alive_fn=None, monotonic_fn=None, sleep_fn=None):
    signal_fn = signal_record if signal_fn is None else signal_fn
    alive_fn = alive if alive_fn is None else alive_fn
    monotonic_fn = time.monotonic if monotonic_fn is None else monotonic_fn
    sleep_fn = time.sleep if sleep_fn is None else sleep_fn
    stop_recorder(state, signal_fn=signal_fn, alive_fn=alive_fn,
                  monotonic_fn=monotonic_fn, sleep_fn=sleep_fn)
    recorder = state.get("recorder")
    recorder_key = (recorder.get("pid"), recorder.get("identity")) if isinstance(recorder, dict) else None
    # Stop native capsule only with ownership bound to this run's create receipt.
    owned = set(state.get("capsules", ()))
    owned |= live.profile_containers("mv-live-1")
    state["capsules"] = sorted(owned)
    save_state(root, state)
    for name in sorted(owned & inventory()):
        if not live.CAPSULE_ID_RE.fullmatch(name):
            raise RuntimeError("unsafe or non-identity capsule allocation: " + repr(name))
        checked([Path(os.environ["MV_SRF_BIN_DIR"]) / "srf-identity-surface", "stop",
                 "--container", name, "--state-dir", os.environ["MV_SRF_STATE_DIR"]])
    for sig in (signal.SIGTERM, signal.SIGKILL):
        for row in reversed(state["pids"]):
            if recorder_key is not None and (row.get("pid"), row.get("identity")) == recorder_key and not alive_fn(row):
                continue
            signal_fn(row, sig)
        deadline = monotonic_fn() + 5
        while any(alive_fn(r) for r in state["pids"]) and monotonic_fn() < deadline:
            sleep_fn(0.05)
    if any(alive_fn(r) for r in state["pids"]):
        raise RuntimeError("process cleanup failed")
    active = inventory()
    if (owned & active) or live.profile_containers("mv-live-1"):
        raise RuntimeError("capsule cleanup failed")
    ram_root = Path(os.environ["MV_SRF_LIVE_RAM_ROOT"]).resolve(strict=True)
    ram_receipt = live.cleanup_capsule_ram(ram_root, owned, state.get("published", ()), active)
    # Adapter normally releases published frames; retain receipt on any leak.
    if not ram_receipt["ram_absent"]:
        raise RuntimeError("published RAM cleanup failed: " + repr(ram_receipt["remaining"]))
    work = Path(state["work"])
    if work.parent != root or not work.name.startswith("run-") or work.is_symlink():
        raise RuntimeError("unsafe work directory")
    shutil.rmtree(work)
    display = state.get("display")
    private_socket_present = (
        display
        and state.get("display_mode", "private") != "visible"
        and Path("/tmp/.X11-unix", "X" + display[1:]).exists()
    )
    if work.exists() or private_socket_present:
        raise RuntimeError("socket/work cleanup failed")
    (root / "state.json").unlink()
    receipt = {"pids": state["pids"], "capsules": sorted(owned),
               "owned_allocations": ram_receipt["owned_allocations"],
               "owned_allocations_removed": ram_receipt["owned_allocations_removed"],
               "processes_absent": True, "ram_absent": ram_receipt["ram_absent"],
               "remaining": ram_receipt["remaining"],
               "work_absent": True, "display_socket_absent": True, "state_absent": True}
    print("LIVE_STACK_CLEANUP " + json.dumps(receipt, sort_keys=True), flush=True)
    return receipt


def free_display(sockets=Path("/tmp/.X11-unix"), locks=Path("/tmp")):
    """[TARGET, unit decision] Dedicated high display; Xvfb's lock arbitrates races."""
    for number in range(91, 65536):
        if not (sockets / f"X{number}").exists() and not (locks / f".X{number}-lock").exists():
            return f":{number}"
    raise RuntimeError("no free high X display")


def monitor(peer, children, seconds, should_stop, tick, keepalive=None):
    """Monotonic TTL and stop requests converge on the same cleanup path."""
    deadline = time.monotonic() + seconds
    next_keepalive = deadline - seconds + 10
    while not should_stop() and time.monotonic() < deadline:
        exited = [(index, p.poll()) for index, p in enumerate(children) if p.poll() is not None]
        if exited:
            raise RuntimeError("stack process exited: " + repr(exited))
        tick()
        # [TARGET, unit decision] list is the admitted request/reply heartbeat;
        # keep the agent and daemon below the frozen 30 s receive-idle limit.
        if keepalive is not None and time.monotonic() >= next_keepalive:
            keepalive()
            next_keepalive = time.monotonic() + 10
        # CoreClient buffers complete frames; drain those before waiting again.
        readable, _, _ = select.select([peer._sock], [], [], 0.2)
        if readable or b"\n" in peer._rx:
            body = peer.recv()["body"]
            if body.get("event") == "error":
                raise RuntimeError("native surface error: " + repr(body))


def supervise(root, seconds, lock_fd):
    os.umask(0o077)
    stop = False

    def request_stop(*_):
        nonlocal stop
        stop = True

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    state = load_state(root)
    work = Path(state["work"])
    children = []
    recorder_children = []
    peer = None
    error = None

    def spawn(argv, env):
        with open(work / (str(len(children)) + ".log"), "w") as log:
            proc = subprocess.Popen([str(x) for x in argv], cwd=ROOT, env=env,
                                    stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                    start_new_session=True)
        children.append(proc)
        state["pids"].append({"pid": proc.pid, "identity": identity(proc.pid)})
        save_state(root, state)
        return proc

    def wait(predicate, detail, timeout=30):
        deadline = time.monotonic() + timeout
        while not predicate():
            if stop or any(p.poll() is not None for p in children):
                raise RuntimeError("interrupted/process exited waiting for " + detail)
            if time.monotonic() >= deadline:
                raise RuntimeError("timeout waiting for " + detail)
            time.sleep(0.1)

    try:
        state["supervisor"] = {"pid": os.getpid(), "identity": identity(os.getpid())}
        save_state(root, state)
        bins = binaries(work)
        commit = checked(["git", "rev-parse", "HEAD"], cwd=ROOT)
        regs = {c: live.registration(c, commit, uuid.uuid4().hex) for c in ("core", "ui", "agent", "daemon")}
        config = {"session_id": "stack-" + uuid.uuid4().hex, "core": regs["core"],
                  "peers": [regs[c] for c in ("ui", "agent", "daemon")]}
        config_file = work / "core-config.json"
        config_file.write_text(json.dumps(config))
        runtime = work / "runtime"
        runtime.mkdir(mode=0o700)
        env = dict(os.environ, MV_CORE_CONFIG=str(config_file), XDG_RUNTIME_DIR=str(runtime),
                   XDG_STATE_HOME=str(work / "state"), XDG_CONFIG_HOME=str(work / "config"),
                   MV_SESSION_ID=config["session_id"], MV_CORE_INSTANCE=regs["core"]["endpoint"]["instance"],
                   MV_DAEMON_INSTANCE=regs["daemon"]["endpoint"]["instance"], MV_COMPONENT_COMMIT=commit,
                   MV_SRF_PROFILES="", MV_CONTRACT_DIR=str(ROOT / "contracts/v0.2"), MV_QA_RUN_DIR=str(work))
        socket_path = runtime / "metaviewer/core.sock"
        spawn([bins["core"]], env)
        wait(socket_path.exists, "core socket")
        spawn([bins["adapter"]], env)
        archive = work / "state/metaviewer/sessions" / config["session_id"]
        wait(lambda: (archive / "events/1.json").exists(), "adapter handshake")
        if state.get("display_mode", "private") == "visible":
            visible = validate_display("visible", env=os.environ)
            state["display"] = visible["display"]
            state["xauthority"] = visible["xauthority"]
            env["DISPLAY"] = state["display"]
            if state["xauthority"]:
                env["XAUTHORITY"] = state["xauthority"]
            else:
                env.pop("XAUTHORITY", None)
            save_state(root, state)
        else:
            auth = work / "Xauthority"
            auth.touch(mode=0o600)
            # Never let -displayfd allocate the operator's low display numbers.
            # If a competing server wins the lock, fail closed before any client starts.
            state["display"] = free_display()
            cookie = secrets.token_hex(16)
            checked(["xauth", "-f", auth, "add", state["display"], ".", cookie])
            save_state(root, state)
            with open(work / "xvfb.log", "w") as log:
                proc = subprocess.Popen(["Xvfb", state["display"], "-screen", "0",
                                         "1600x1000x24", "-auth", str(auth), "-nolisten", "tcp"],
                                        stdout=log, stderr=log, start_new_session=True)
            children.append(proc)
            state["pids"].append({"pid": proc.pid, "identity": identity(proc.pid)})
            save_state(root, state)
            wait(lambda: Path("/tmp/.X11-unix", "X" + state["display"][1:]).exists(), "Xvfb display")
            state["xauthority"] = str(auth)
            checked(["xauth", "-f", auth, "add", state["display"], ".", cookie])
            auth.chmod(0o600)
            env.update(DISPLAY=state["display"], XAUTHORITY=str(auth))
            save_state(root, state)
            checked(["xdpyinfo"], env=env)
        spawn([os.environ["MV_E2E_ELECTRON_BIN"], ROOT / "ui",
               "--user-data-dir=" + str(work / "electron-profile"), "--ozone-platform=x11"],
              electron_environment(env))
        wait(lambda: '"MetaViewer"' in checked(["xwininfo", "-root", "-tree"], env=env), "shipped UI window")
        peer = live.CoreClient(str(socket_path), timeout_s=20, max_line_bytes=1 << 20, max_reply_bytes=1 << 20)
        peer.connect()
        live.send(peer, regs["agent"], config, regs["agent"]["hello"])
        if peer.recv()["body"] != regs["core"]["hello"]:
            raise RuntimeError("core pin mismatch")
        live.send(peer, regs["agent"], config, {"schema": "surface_request/v0.2", "op": "create", "params": {
            "kind": "browser", "geometry": {"w": 1280, "h": 900}, "profile_id": "mv-live-1"}})
        report = {}
        created = live.receive(peer, lambda b: b.get("event") == "created", report)
        state["surface_id"] = created["data"]["surface"]["surface_id"]
        state["capsules"] = sorted(live.profile_containers("mv-live-1"))
        if len(state["capsules"]) != 1:
            raise RuntimeError("expected exactly one ownership-proven capsule")
        save_state(root, state)
        frame = live.receive(peer, lambda b: b.get("event") == "frame_ready", report)["data"]["frame_ref"]
        state["published"] = [str(Path(frame["ramws_path"]).parent)]
        if state.get("record_path"):
            rec_proc = start_recorder(state, work, env)
            recorder_children.append(rec_proc)
            save_state(root, state)
        state["expires"] = time.time() + seconds
        state["status"] = "ready"
        remember_tree(state, root)
        # Drain fan-out continuously so the core never retires a full agent queue.
        monitor(peer, children, seconds, lambda: stop, lambda: remember_tree(state, root),
                lambda: live.send(peer, regs["agent"], config,
                                  {"schema": "surface_request/v0.2", "op": "list", "params": {}}))
    except Exception as exc:
        logs = "\n".join(path.name + ": " + path.read_text(errors="replace")[-2000:]
                         for path in sorted(work.glob("*.log")))
        error = str(exc) + ("\n" + logs if logs else "")
        state["error"] = error
        state["status"] = "failed"
        save_state(root, state)
        print(error, file=sys.stderr, flush=True)
    finally:
        stop_recorder(state)
        state["capsules"] = sorted(set(state.get("capsules", ())) | live.profile_containers("mv-live-1"))
        save_state(root, state)
        if peer:
            if state.get("surface_id"):
                try:
                    live.send(peer, regs["agent"], config, {"schema": "surface_request/v0.2", "op": "destroy",
                              "params": {"surface_id": state["surface_id"]}})
                    live.receive(peer, lambda b: b.get("event") == "state_changed"
                                 and b["data"]["surface"]["state"] == "destroyed", {})
                except Exception as exc:
                    print("native destroy fallback: " + str(exc), file=sys.stderr, flush=True)
            peer.close()
        try:
            remember_tree(state, root)
            cleanup(state, root)
        except Exception as exc:
            state.update(status="cleanup_failed", error=str(exc))
            save_state(root, state)
            print("cleanup failed: " + str(exc), file=sys.stderr, flush=True)
        for proc in [*children, *recorder_children]:
            if proc.poll() is not None:
                proc.wait()
        os.close(lock_fd)
    return 1 if error or (root / "state.json").exists() else 0


def start(root, seconds, display_mode="private", record_path=None):
    fd = os.open(root / "lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RuntimeError("another live stack is active; refusing") from exc
        resolved_record = validate_record_path(record_path)
        validate_display(display_mode)
        preflight(root, display_mode=display_mode, record_path=record_path)
        work = Path(tempfile.mkdtemp(prefix="run-", dir=root))
        state = {"schema": "metaviewer.live-stack/v1", "status": "starting", "pids": [],
                 "work": str(work), "capsules": [], "published": [], "display_mode": display_mode}
        if resolved_record is not None:
            state["record_path"] = str(resolved_record)
        save_state(root, state)
        with open(root / "supervisor.log", "w") as log:
            proc = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "_supervise",
                                     str(seconds), str(fd)], pass_fds=(fd,), start_new_session=True,
                                    stdin=subprocess.DEVNULL, stdout=log, stderr=log)
        deadline = time.monotonic() + 360
        while time.monotonic() < deadline:
            if (root / "state.json").exists():
                state = load_state(root)
                if state["status"] == "ready":
                    print(f"LIVE_STACK_READY display={state['display']} xauthority={state['xauthority']} capsule={state['capsules'][0]}", flush=True)
                    return
                if state["status"] in ("failed", "cleanup_failed"):
                    raise RuntimeError(state["error"])
            if proc.poll() is not None:
                raise RuntimeError("supervisor exited: " + (root / "supervisor.log").read_text()[-3000:])
            time.sleep(0.1)
        proc.terminate()
        raise RuntimeError("stack startup deadline exceeded; supervisor stopping")
    finally:
        os.close(fd)


def stop_stack(root, *, signal_fn=None, alive_fn=None, monotonic_fn=None, sleep_fn=None):
    signal_fn = signal_record if signal_fn is None else signal_fn
    alive_fn = alive if alive_fn is None else alive_fn
    monotonic_fn = time.monotonic if monotonic_fn is None else monotonic_fn
    sleep_fn = time.sleep if sleep_fn is None else sleep_fn
    if not (root / "state.json").exists():
        print("LIVE_STACK_STOPPED already_absent=true")
        return
    state = load_state(root)
    supervisor = state.get("supervisor", {})
    if identity(supervisor.get("pid")) is None or identity(supervisor.get("pid")) != supervisor.get("identity"):
        raise RuntimeError("supervisor absent; private recovery state retained for review")
    stop_recorder(state, signal_fn=signal_fn, alive_fn=alive_fn,
                  monotonic_fn=monotonic_fn, sleep_fn=sleep_fn)
    signal_fn(supervisor, signal.SIGTERM)
    deadline = monotonic_fn() + 90
    while (root / "state.json").exists() and monotonic_fn() < deadline:
        if identity(supervisor["pid"]) != supervisor["identity"]:
            raise RuntimeError("cleanup failed: " + repr(load_state(root)))
        sleep_fn(0.1)
    if (root / "state.json").exists():
        raise RuntimeError("cleanup deadline exceeded; receipt retained")
    print("LIVE_STACK_STOPPED processes=absent capsule=absent sockets=absent ram=absent state=absent")


def main():
    try:
        root = state_root()
        if len(sys.argv) == 4 and sys.argv[1] == "_supervise":
            return supervise(root, int(sys.argv[2]), int(sys.argv[3]))
        args = parser().parse_args()
        if args.command == "start":
            start(root, args.ttl, display_mode=args.display, record_path=args.record)
        else:
            stop_stack(root)
        return 0
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as exc:
        print("LIVE_STACK_BLOCKED " + str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

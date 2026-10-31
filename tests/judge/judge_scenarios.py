"""Bad/good scenarios per JUDGE_* code, shared by the behaviour and mutation tests.

Each preflight scenario is (args, bad, good); `bad` makes the code fire, `good`
leaves the host clean for that code. Each function takes the sandbox and may
return an env override dict (None removes a variable).
"""

import shutil

from judge_sandbox import ELF_MACHINE

T1 = ("--tier", "T1")
T2 = ("--tier", "T2")


def _noop(sb):
    return None


def _t2_ready(sb):
    sb.make_t2_ready()


def fake_installed_app(sb, machine):
    """Lay down an 'installed' app whose binaries carry the given ELF machine."""
    d = sb.jh / "app" / f"MetaViewer-linux-{sb.archn}"
    (d / "resources" / "bin").mkdir(parents=True, exist_ok=True)
    for rel in ("metaviewer", "resources/bin/metaviewer-core", "resources/bin/mv-daemon-adapter"):
        from judge_sandbox import elf
        (d / rel).write_bytes(elf(machine))


def other_machine(sb):
    return 62 if sb.arch == "aarch64" else 183


def _combo(*fns):
    def run(sb):
        env = {}
        for fn in fns:
            env.update(fn(sb) or {})
        return env
    return run


PREFLIGHT = {}


def pf(code, args, bad, good):
    PREFLIGHT[code] = (args, bad, good)


pf("JUDGE_OS", T1, lambda sb: sb.set_osrel("ubuntu", "22.04"), _noop)
pf("JUDGE_ARCH", T1, lambda sb: sb.put("uname_m", "riscv64\n"), _noop)
pf("JUDGE_BUNDLE_ARCH", T1, lambda sb: fake_installed_app(sb, other_machine(sb)), lambda sb: fake_installed_app(sb, ELF_MACHINE[sb.arch]))
pf("JUDGE_SYSDEP", T1, lambda sb: sb.drop_tool("zip"), _noop)
pf("JUDGE_NODE", T1, lambda sb: sb.put("node_version", "v18.19.1\n"), _noop)


def _userns_bad(sb):
    sb.put("sysctl_kernel.apparmor_restrict_unprivileged_userns", "1\n")


def _userns_good(sb):
    _userns_bad(sb)
    sb.install_profile()


pf("JUDGE_USERNS", T1, _userns_bad, _userns_good)
pf("JUDGE_DISPLAY", T1, lambda sb: {"DISPLAY": None}, _noop)
pf("JUDGE_XDG_RUNTIME", T1, lambda sb: shutil.rmtree(sb.runuser), _noop)
pf("JUDGE_SHM", T1, lambda sb: sb.set_df(shm=("tmpfs", 100 * 1024 * 1024), home=500_000_000_000, docker=500_000_000_000), _noop)
pf("JUDGE_RAM", T2, lambda sb: (_t2_ready(sb), sb.set_meminfo(32 * 1024 * 1024, 6 * 1024 * 1024)), _t2_ready)
pf("JUDGE_CPUSET", T2, lambda sb: (_t2_ready(sb), sb.set_cpuset("0-7")), _t2_ready)
pf("JUDGE_DOCKER", T2, lambda sb: (_t2_ready(sb), sb.put("docker_info_rc", "1\n")), _t2_ready)
pf("JUDGE_DOCKER_HOST", T2, lambda sb: (_t2_ready(sb), {"DOCKER_HOST": "tcp://127.0.0.1:2375"})[1], _t2_ready)
pf("JUDGE_DOCKER_DESKTOP", T2,
   lambda sb: (_t2_ready(sb), sb.put("docker_info", "[name=seccomp]|Docker Desktop|/var/lib/docker\n")), _t2_ready)
pf("JUDGE_IMAGE", T2, lambda sb: (_t2_ready(sb), sb.put("images", "")), _t2_ready)
pf("JUDGE_NET", T2, lambda sb: (_t2_ready(sb), (sb.fake / "network").unlink()), _t2_ready)
pf("JUDGE_PROFILE", T2, lambda sb: (_t2_ready(sb), (sb.fake / "owner.tbl").unlink()), _t2_ready)


def _stale(sb, record):
    _t2_ready(sb)
    (sb.runuser / str(__import__("os").getuid()) / "metaviewer" / "ram-admission").mkdir(parents=True, exist_ok=True)
    sb.put("ram_reclaim_out", record + "\n")


pf("JUDGE_RAM_STALE", T2, lambda sb: _stale(sb, '{"action": "would_remove", "reservation": "x"}'),
   lambda sb: _stale(sb, '{"action": "keep", "reservation": "x"}'))
pf("JUDGE_DISK", T2, lambda sb: (_t2_ready(sb), sb.set_df(shm=("tmpfs", 8_000_000_000), home=10_000_000_000, docker=500_000_000_000)),
   _t2_ready)
pf("JUDGE_USAGE", ("--tier", "T9"), _noop, _noop)
PREFLIGHT_GOOD_ARGS = {"JUDGE_USAGE": T1}


# Codes raised by metaviewer-judge.sh: each has bad/good preparation and one command.
def installed(sb, t2=False, firewall=True):
    sb.full_kit(t2=t2)
    flags = (("--capsules",) if t2 else ()) + (() if firewall else ("--no-firewall",))
    res = sb.judge("install", "--yes", *flags)
    assert res.rc == 0, res.text


def tamper(sb):
    sb.full_kit()
    path = sb.assets / f"metaviewer-linux-{sb.archn}.tar.gz"
    path.write_bytes(path.read_bytes() + b"tamper")


def intact(sb):
    sb.full_kit()


def need_profile_bad(sb):
    sb.full_kit()
    sb.put("sysctl_kernel.apparmor_restrict_unprivileged_userns", "1\n")


def smoke_bad(sb):
    sb.full_kit()
    sb.put("pkg_smoke_rc", "1\n")


def running_bad(sb):
    installed(sb)
    sb.spawn_run()


def stop_timeout_bad(sb):
    installed(sb)
    sb.put("app_deaf", "1\n")
    sb.spawn_run()


def stop_timeout_good(sb):
    installed(sb)
    sb.spawn_run()


def leak_bad(sb):
    installed(sb)
    sb.put("containers", "srf-id-leftover\n")


def flow_asset(sb, good):
    intact(sb) if good else tamper(sb)
    return sb.judge("install", "--yes")


def flow_sudo(sb, good):
    need_profile_bad(sb)
    return sb.judge("install", stdin="y\n" if good else "n\n")


def flow_smoke(sb, good):
    intact(sb) if good else smoke_bad(sb)
    return sb.judge("install", "--yes")


def flow_not_installed(sb, good):
    installed(sb) if good else sb.full_kit()
    return sb.judge("run")


def flow_running(sb, good):
    installed(sb)
    if not good:
        sb.spawn_run()
    return sb.judge("run")


def flow_stop_timeout(sb, good):
    stop_timeout_good(sb) if good else stop_timeout_bad(sb)
    return sb.judge("stop", env={"MV_JUDGE_STOP_WAIT": "1"})


def flow_stop_leak(sb, good):
    installed(sb) if good else leak_bad(sb)
    return sb.judge("stop")


def flow_usage(sb, good):
    return sb.judge("doctor" if good else "bogus")


# code -> function(sandbox, good: bool) -> Result of the command under test.
FLOW = {
    "JUDGE_ASSET": flow_asset,
    "JUDGE_SUDO": flow_sudo,
    "JUDGE_SMOKE": flow_smoke,
    "JUDGE_NOT_INSTALLED": flow_not_installed,
    "JUDGE_RUNNING": flow_running,
    "JUDGE_STOP_TIMEOUT": flow_stop_timeout,
    "JUDGE_STOP_LEAK": flow_stop_leak,
    "JUDGE_USAGE": flow_usage,
}


def env_of(value):
    """Scenario functions may return an env override dict; anything else means none."""
    return value if isinstance(value, dict) else {}

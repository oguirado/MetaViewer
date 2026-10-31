"""Offline sandbox for the judge script tests.

Builds a disposable kit, home, /proc, df table and a PATH that holds only
fakes (uname, df, nproc, docker, sudo, apt-get, curl, node, ...) plus
symlinks to a fixed list of base tools. No network, no real docker, no real
sudo. Every fake logs its calls under the sandbox so tests can assert what
was (not) invoked.

The mutation helper negates the deciding predicate of one JUDGE_* code: the
scripts mark that line with a trailing `# MUT:<code>` comment and the helper
turns its first `if`/`elif` into `if !`/`elif !`.
"""

import hashlib
import io
import os
import re
import shutil
import signal
import stat
import subprocess
import tarfile
import time
from pathlib import Path

REPO = Path(os.environ.get("MV_TEST_REPO_ROOT") or Path(__file__).resolve().parents[2])
JUDGE_SRC = REPO / "scripts" / "judge"

BASE_TOOLS = (
    "bash env awk sed grep head tail tr cut od id dirname basename rm mkdir cp mv chmod tar gzip xz "
    "sha256sum cmp timeout sleep find kill cat ls tee wc sort uniq readlink touch ln mktemp date "
    "true false xargs"
).split()
CODE_LINE = re.compile(r"^(JUDGE_[A-Z0-9_]+):", re.M)
NOT_CODES = {"JUDGE_NOTE"}
ARCH_DIR = {"aarch64": "arm64", "x86_64": "x64"}
ELF_MACHINE = {"aarch64": 183, "x86_64": 62}


def which(name):
    found = shutil.which(name)
    if found is None:
        raise RuntimeError("test host lacks required tool: " + name)
    return found


def codes_in(text):
    return {c for c in CODE_LINE.findall(text) if c not in NOT_CODES}


def mutate_text(text, code):
    """Negate the first if/elif on every line ending with `# MUT:<code>`."""
    out, hits = [], 0
    for line in text.split("\n"):
        if re.search(r"# MUT:" + re.escape(code) + r"$", line):
            new = re.sub(r"\b(el)?if ", lambda m: (m.group(1) or "") + "if ! ", line, count=1)
            if new != line:
                hits += 1
                line = new
        out.append(line)
    return "\n".join(out), hits


def elf(machine):
    return b"\x7fELF" + bytes(14) + machine.to_bytes(2, "little") + bytes(40)


def make_tar(path, members, mode="w:gz"):
    """members: (name, bytes|None for dir, perm) or (name, ('symlink', target), perm)."""
    with tarfile.open(path, mode) as tar:
        for name, data, perm in members:
            info = tarfile.TarInfo(name)
            info.mtime = 0
            info.uid = info.gid = 0
            info.uname = info.gname = "root"
            info.mode = perm
            if data is None:
                info.type = tarfile.DIRTYPE
                tar.addfile(info)
            elif isinstance(data, tuple):
                info.type = tarfile.SYMTYPE
                info.linkname = data[1]
                tar.addfile(info)
            else:
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))


FAKES = {
    "uname": '[ "$1" = -m ] && { cat "$MV_FAKE_DIR/uname_m"; exit 0; }\necho Linux\n',
    "nproc": 'cat "$MV_FAKE_DIR/nproc"\n',
    "sysctl": '[ "$1" = -n ] && [ -f "$MV_FAKE_DIR/sysctl_$2" ] && { cat "$MV_FAKE_DIR/sysctl_$2"; exit 0; }\nexit 255\n',
    "ip": '[ "$1" = route ] && cat "$MV_FAKE_DIR/ip_route" 2>/dev/null\nexit 0\n',
    "xdpyinfo": 'exit "$(cat "$MV_FAKE_DIR/xdpyinfo_rc" 2>/dev/null || echo 0)"\n',
    "python3": '[ "${1:-}" = -I ] && shift\nexec bash "$@"\n',
    "apparmor_parser": 'echo "apparmor_parser $*" >> "$MV_FAKE_DIR/apparmor.log"\n',
    "iptables": "exit 0\n",
    "ip6tables": "exit 0\n",
    "iptables-restore": "exit 0\n",
    "ip6tables-restore": "exit 0\n",
    "systemctl": (
        'echo "systemctl $*" >> "$MV_FAKE_DIR/systemctl.log"\n'
        'if [ "$1 $2" = "enable --now" ] && [ ! -f "$MV_FAKE_DIR/fw_fail" ]; then\n'
        '  mkdir -p "$(dirname "$MV_JUDGE_FW_WITNESS")"; echo 00ff > "$MV_JUDGE_FW_WITNESS"\nfi\n'
    ),
    "sudo": (
        'echo "sudo $*" >> "$MV_FAKE_DIR/sudo.log"\n'
        '[ -f "$MV_FAKE_DIR/sudo_rc" ] && exit "$(cat "$MV_FAKE_DIR/sudo_rc")"\n'
        'exec "$@"\n'
    ),
    "apt-get": (
        'echo "apt-get $*" >> "$MV_FAKE_DIR/apt.log"\n'
        '[ "$1" = install ] || exit 0\n'
        'shift; for p in "$@"; do case $p in -y) ;; xvfb) t=Xvfb;; x11-utils) t=xdpyinfo;; python3-pip) t=pip3;; '
        'coreutils) t=sha256sum;; docker.io) t=docker;; *) t=$p;; esac\n'
        '  [ -e "$MV_FAKE_BIN/$t" ] || printf "#!/bin/bash\\nexit 0\\n" > "$MV_FAKE_BIN/$t"; chmod +x "$MV_FAKE_BIN/$t"; done\n'
    ),
    "curl": (
        'echo "curl $*" >> "$MV_FAKE_DIR/curl.log"\n'
        'out=; url=; while [ $# -gt 0 ]; do case $1 in --output) out=$2; shift 2;; --*) shift;; *) url=$1; shift;; esac; done\n'
        'src="$MV_FAKE_DIR/release/$(basename "$url")"\n'
        '[ -f "$src" ] || exit 22\ncp "$src" "$out"\n'
    ),
    "node": (
        'echo "node $*" >> "$MV_FAKE_DIR/node.log"\n'
        'case "$1" in\n'
        '  --version) cat "$MV_FAKE_DIR/node_version";;\n'
        '  *package.js) case "$2" in --verify-install) exit "$(cat "$MV_FAKE_DIR/pkg_verify_rc" 2>/dev/null || echo 0)";;\n'
        '      --smoke) echo METAVIEWER_MAIN_SMOKE_OK; exit "$(cat "$MV_FAKE_DIR/pkg_smoke_rc" 2>/dev/null || echo 0)";; esac;;\n'
        'esac\n'
    ),
    "install": (
        'args=(); owner=; dir=0\n'
        'while [ $# -gt 0 ]; do case $1 in -o) owner=$2; shift 2;; -g) shift 2;; -d) dir=1; args+=("$1"); shift;; *) args+=("$1"); shift;; esac; done\n'
        '"$MV_FAKE_REAL_INSTALL" "${args[@]}" || exit $?\n'
        'if [ -n "$owner" ] && [ "$dir" = 1 ]; then echo "${args[${#args[@]}-1]}|$owner" >> "$MV_FAKE_DIR/owner.tbl"; fi\n'
    ),
    "stat": (
        'if [ "$1" = -c ] && [ "$2" = "%a %u" ]; then p=${!#}\n'
        '  o=$(awk -F"|" -v p="$p" \'$1==p{o=$2} END{print o}\' "$MV_FAKE_DIR/owner.tbl" 2>/dev/null)\n'
        '  if [ -n "$o" ]; then echo "$("$MV_FAKE_REAL_STAT" -c %a -- "$p") $o"; exit 0; fi\nfi\n'
        'exec "$MV_FAKE_REAL_STAT" "$@"\n'
    ),
    "df": (
        'out=; path=\nfor a in "$@"; do case $a in --output=*) out=${a#--output=};; -*) ;; *) path=$a;; esac; done\n'
        'best=; bf=; ba=\n'
        'while IFS="|" read -r p f a; do\n'
        '  if [ "$p" = / ] || [ "$path" = "$p" ] || [ "${path#"$p"/}" != "$path" ]; then\n'
        '    if [ ${#p} -ge ${#best} ]; then best=$p; bf=$f; ba=$a; fi\n  fi\ndone < "$MV_FAKE_DIR/df.tbl"\n'
        '[ -n "$best" ] || exit 1\n'
        'case $out in avail) printf "       Avail\\n%s\\n" "$ba";; fstype) printf "Type\\n%s\\n" "$bf";; esac\n'
    ),
    "docker": (
        'D=$MV_FAKE_DIR; echo "docker $*" >> "$D/docker.log"\n'
        'case "$1" in\n'
        '  info) [ -f "$D/docker_info_rc" ] && exit "$(cat "$D/docker_info_rc")"; cat "$D/docker_info";;\n'
        '  context) cat "$D/docker_ctx" 2>/dev/null || echo unix:///var/run/docker.sock;;\n'
        '  image) grep -qxF "${!#}" "$D/images";;\n'
        '  network)\n'
        '    if [ "${2:-}" = create ]; then printf "true 172.30.80.0/24 \\n" > "$D/network"; exit 0; fi\n'
        '    [ -f "$D/network" ] && cat "$D/network" || exit 1;;\n'
        '  inspect) [ -f "$D/proxy" ] && cat "$D/proxy" || exit 1;;\n'
        '  start|run) echo true > "$D/proxy"; exit 0;;\n'
        '  ps)\n'
        '    if [[ "$*" == *"name=^srf-id-"* ]]; then grep "^srf-id-" "$D/containers" 2>/dev/null || true; exit 0; fi\n'
        '    cat "$D/containers" 2>/dev/null; exit 0;;\n'
        '  load) cat "$3" >> "$D/images";;\n'
        '  version) echo 27.5.1;;\n'
        'esac\n'
    ),
}
SIMPLE_TOOLS = ("Xvfb", "xauth", "zip", "strace", "git", "pip3")

SRF_FAKE = (
    "#!/bin/bash\n"
    'D=${MV_FAKE_DIR:?}\necho "srf $*" >> "$D/srf.log"\n'
    'case "$1 ${2:-}" in\n'
    '  "capabilities ") printf "capabilities v1\\n"; cat "$D/caps";;\n'
    '  "stop --container") sed -i "/^${3:-}$/d" "$D/containers" 2>/dev/null; exit 0;;\n'
    "esac\n"
)


class Result:
    def __init__(self, rc, out, err):
        self.rc, self.out, self.err = rc, out, err

    @property
    def codes(self):
        return codes_in(self.out) | codes_in(self.err)

    @property
    def text(self):
        return self.out + self.err


class Sandbox:
    def __init__(self, root, arch="aarch64", mutant=None):
        self.root = Path(root)
        self.arch = arch
        self.archn = ARCH_DIR[arch]
        self.bin = self.root / "bin"
        self.fake = self.root / "fake"
        self.home = self.root / "home"
        self.jh = self.root / "jh"
        self.kit = self.root / "kit"
        self.proc = self.root / "proc"
        self.shm = self.root / "shm"
        self.runuser = self.root / "runuser"
        self.apparmor = self.root / "apparmor"
        self.assets = self.kit / "assets"
        self.witness = self.root / "run" / "srf-open-egress" / "rules.sha256"
        self.children = []
        for d in (self.bin, self.fake, self.home, self.proc, self.shm, self.assets, self.apparmor,
                  self.kit / "judge" / "apparmor", self.kit / "ui" / "tools", self.kit / "tools",
                  self.runuser / str(os.getuid()), self.fake / "release", self.root / "libexec", self.root / "units"):
            d.mkdir(parents=True, exist_ok=True)
        (self.runuser / str(os.getuid())).chmod(0o700)
        for tool in BASE_TOOLS:
            (self.bin / tool).symlink_to(which(tool))
        for name, body in FAKES.items():
            self.write_exec(self.bin / name, "#!/bin/bash\n" + body)
        for name in SIMPLE_TOOLS:
            self.write_exec(self.bin / name, "#!/bin/bash\nexit 0\n")
        self.real_stat, self.real_install = which("stat"), which("install")
        # Kit: the scripts under test (optionally mutated), a fake package tool and RAM tool.
        for name in ("metaviewer-judge.sh", "preflight.sh"):
            text = (JUDGE_SRC / name).read_text(encoding="utf-8")
            if mutant:
                text, hits = mutate_text(text, mutant)
                self.mutant_hits = getattr(self, "mutant_hits", 0) + hits
            self.write_exec(self.kit / "judge" / name, text)
        shutil.copyfile(JUDGE_SRC / "apparmor" / "metaviewer", self.kit / "judge" / "apparmor" / "metaviewer")
        (self.kit / "VERSION").write_text("0.0.0\n")
        (self.kit / "ui" / "tools" / "package.js").write_text("// placeholder; the fake node handles it\n")
        self.write_exec(self.kit / "tools" / "mv_ram_admission.py", '#!/bin/bash\ncat "$MV_FAKE_DIR/ram_reclaim_out" 2>/dev/null\nexit 0\n')
        self.reset_state()

    # ----------------------------------------------------------------- state
    @staticmethod
    def write_exec(path, text):
        Path(path).write_text(text, encoding="utf-8")
        Path(path).chmod(0o755)

    def put(self, name, text):
        (self.fake / name).write_text(text)

    def reset_state(self):
        self.put("uname_m", self.arch + "\n")
        self.put("nproc", "20\n")
        self.put("node_version", "v24.14.0\n")
        self.set_meminfo(32 * 1024 * 1024, 24 * 1024 * 1024)
        self.set_df(shm=("tmpfs", 8_000_000_000), home=500_000_000_000, docker=500_000_000_000)
        self.set_osrel("ubuntu", "24.04")
        (self.root / "cpuset").write_text("0-19\n")
        self.put("sysctl_kernel.apparmor_restrict_unprivileged_userns", "0\n")
        self.put("docker_info", "[name=apparmor name=seccomp,profile=builtin]|Ubuntu 24.04.1 LTS|/var/lib/docker\n")
        self.put("images", "")
        self.put("ip_route", "default via 192.168.1.1 dev eth0\n192.168.1.0/24 dev eth0 proto kernel\n")
        self.put("caps", "net_modes=legacy\n")
        self.put("containers", "")
        for gone in ("network", "proxy", "docker_info_rc", "docker_ctx", "sudo_rc", "pkg_smoke_rc", "pkg_verify_rc",
                     "fw_fail", "app_hold", "app_deaf", "ram_reclaim_out", "xdpyinfo_rc", "owner.tbl", "sudo.log",
                     "curl.log", "apt.log", "srf.log", "docker.log", "node.log"):
            (self.fake / gone).unlink(missing_ok=True)

    def set_meminfo(self, total_kib, avail_kib):
        (self.proc / "meminfo").write_text(f"MemTotal:       {total_kib} kB\nMemFree:        1 kB\nMemAvailable:   {avail_kib} kB\n")

    def set_df(self, shm=None, home=None, docker=None):
        shm = shm or ("tmpfs", 8_000_000_000)
        rows = ["/|ext4|900000000000", f"{self.shm}|{shm[0]}|{shm[1]}"]
        if home is not None:
            rows.append(f"{self.home}|ext4|{home}")
        if docker is not None:
            rows.append(f"/var/lib/docker|ext4|{docker}")
        (self.fake / "df.tbl").write_text("\n".join(rows) + "\n")

    def set_osrel(self, ident, version):
        (self.root / "os-release").write_text(f'ID={ident}\nVERSION_ID="{version}"\n')

    def set_cpuset(self, text):
        (self.root / "cpuset").write_text(text + "\n")

    def drop_tool(self, name):
        (self.bin / name).unlink()

    def make_t2_ready(self):
        """Everything a T2 doctor needs: images, legacy network, profile dir."""
        self.put("images", f"opensuperficies-identity-browser-{self.archn}:0.1.0\nopensuperficies-desktop-{self.archn}:1.1.0\n")
        self.put("network", "true 172.30.80.0/24 \n")
        self.put("proxy", "true\n")
        store = self.home / "store" / "profiles" / "judge"
        store.mkdir(parents=True, exist_ok=True)
        store.chmod(0o700)
        (self.fake / "owner.tbl").write_text(f"{store}|10001\n")

    def install_profile(self):
        shutil.copyfile(JUDGE_SRC / "apparmor" / "metaviewer", self.apparmor / "metaviewer-judge")

    # ---------------------------------------------------------------- assets
    def app_members(self, machine=None):
        a = f"MetaViewer-linux-{self.archn}"
        binary = elf(machine or ELF_MACHINE[self.arch])
        launcher = (
            "#!/bin/bash\n"
            f'{{ env; echo "ARGS $*"; }} > "{self.fake}/app_env.txt"\n'
            f'if [ -f "{self.fake}/app_deaf" ]; then trap "" TERM; while :; do sleep 0.1; done; fi\n'
            f'if [ -f "{self.fake}/app_hold" ]; then trap "exit 0" TERM; while :; do sleep 0.1; done; fi\n'
        ).encode()
        return [
            (a + "/", None, 0o755), (a + "/metaviewer", launcher, 0o755),
            (a + "/resources/", None, 0o755), (a + "/resources/bin/", None, 0o755),
            (a + "/resources/bin/metaviewer-core", binary, 0o755),
            (a + "/resources/bin/mv-daemon-adapter", binary, 0o755),
            (a + ".sha256", b"00  placeholder\n", 0o644),
        ]

    def add_app(self, members=None):
        make_tar(self.assets / f"metaviewer-linux-{self.archn}.tar.gz", members or self.app_members())

    def add_node_asset(self):
        script = b'#!/bin/bash\n[ "$1" = --version ] && echo v24.1.0\nexit 0\n'
        make_tar(self.assets / f"node-linux-{self.archn}.tar.xz",
                 [("node-v24.1.0-linux/", None, 0o755), ("node-v24.1.0-linux/bin/", None, 0o755),
                  ("node-v24.1.0-linux/bin/node", script, 0o755)], "w:xz")

    def add_t2_assets(self):
        fw = {"apply.sh": b"#!/bin/sh\nexit 0\n", "srf-open-egress.rules": b"*filter\nCOMMIT\n",
              "srf-open-egress6.rules": b"*filter\nCOMMIT\n", "srf-open-egress.service": b"[Unit]\n"}
        members = [("opensuperficies/", None, 0o755), ("opensuperficies/bin/", None, 0o755),
                   ("opensuperficies/bin/srf-identity-surface", SRF_FAKE.encode(), 0o755),
                   ("opensuperficies/firewall/", None, 0o755)]
        members += [("opensuperficies/firewall/" + n, d, 0o644) for n, d in fw.items()]
        make_tar(self.assets / f"opensuperficies-linux-{self.archn}.tar.gz", members)
        for comp in ("vision-engine", "wender-agent"):
            make_tar(self.assets / f"{comp}.tar.gz", [(comp + "/", None, 0o755), (comp + "/README", b"x\n", 0o644)])
        (self.assets / f"images-linux-{self.archn}.tar").write_text(
            f"opensuperficies-identity-browser-{self.archn}:0.1.0\nopensuperficies-identity-browser-{self.archn}:0.2.0\n"
            f"opensuperficies-desktop-{self.archn}:1.1.0\n")

    def write_sums(self, skip=()):
        lines = []
        for p in sorted(self.assets.iterdir()):
            if p.name == "SHA256SUMS" or p.name in skip or not p.is_file():
                continue
            lines.append(f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}")
        (self.assets / "SHA256SUMS").write_text("\n".join(lines) + "\n")

    def full_kit(self, t2=False):
        self.add_app()
        if t2:
            self.add_t2_assets()
            self.make_t2_ready_for_install()
        self.write_sums()

    def make_t2_ready_for_install(self):
        """T2 install starts with nothing loaded; the fakes provide the rest."""
        self.put("images", "")

    # --------------------------------------------------------------- running
    def env(self, extra=None):
        env = {
            "PATH": str(self.bin), "HOME": str(self.home), "LANG": "C", "USER": "tester",
            "MV_FAKE_DIR": str(self.fake), "MV_FAKE_BIN": str(self.bin),
            "MV_FAKE_REAL_STAT": self.real_stat, "MV_FAKE_REAL_INSTALL": self.real_install,
            "MV_JUDGE_HOME": str(self.jh), "MV_JUDGE_PROC": str(self.proc),
            "MV_JUDGE_OS_RELEASE": str(self.root / "os-release"), "MV_JUDGE_SHM_DIR": str(self.shm),
            "MV_JUDGE_CPUSET_FILE": str(self.root / "cpuset"), "MV_JUDGE_RUN_USER_ROOT": str(self.runuser),
            "MV_JUDGE_APPARMOR_DIR": str(self.apparmor), "MV_JUDGE_FW_WITNESS": str(self.witness),
            "MV_JUDGE_FW_LIBEXEC": str(self.root / "libexec"), "MV_JUDGE_FW_UNIT_DIR": str(self.root / "units"),
            "MV_JUDGE_EUID": "1000", "MV_JUDGE_STOP_WAIT": "2",
            "MV_JUDGE_RELEASE_BASE": "https://example.invalid/release",
            "XDG_STATE_HOME": str(self.home / "state"), "SRF_IDENTITY_STORE_ROOT": str(self.home / "store"),
            "DISPLAY": ":99", "SECRET_PARENT_VAR": "must-not-leak",
        }
        env.update(extra or {})
        return {k: v for k, v in env.items() if v is not None}

    def _bash(self):
        return which("bash")

    def preflight(self, *args, env=None):
        return self._exec(self.kit / "judge" / "preflight.sh", args, "", env)

    def judge(self, *args, stdin="", env=None):
        return self._exec(self.kit / "judge" / "metaviewer-judge.sh", args, stdin, env)

    def _exec(self, script, args, stdin, env):
        proc = subprocess.run([self._bash(), str(script), *args], input=stdin, capture_output=True, text=True,
                              env=self.env(env), timeout=90, start_new_session=True, cwd=str(self.root))
        return Result(proc.returncode, proc.stdout, proc.stderr)

    def spawn_run(self, env=None):
        """Start `run` in the background (the fake app holds until SIGTERM)."""
        self.put("app_hold", "1\n")
        proc = subprocess.Popen([self._bash(), str(self.kit / "judge" / "metaviewer-judge.sh"), "run"],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=self.env(env),
                                start_new_session=True, cwd=str(self.root))
        self.children.append(proc)
        pidfile = self.jh / "run" / "metaviewer.pid"
        deadline = time.time() + 20
        while time.time() < deadline:
            if pidfile.exists() and (self.fake / "app_env.txt").exists() and pidfile.read_text().strip():
                return proc
            if proc.poll() is not None:
                break
            time.sleep(0.05)
        out, err = proc.communicate(timeout=5)
        raise AssertionError("run did not start the app: " + out + err)

    @staticmethod
    def _guarded_kill(pid, sig, *, pg=False):
        if type(pid) is not int or pid <= 1 or pid == os.getpid():
            raise ValueError("unsafe child pid")
        if pid == os.getpgrp() or os.getpgid(pid) == os.getpgrp():
            raise ValueError("child shares caller process group")
        if pg:
            os.killpg(pid, sig)
        else:
            os.kill(pid, sig)

    def cleanup(self):
        for proc in self.children:
            try:
                self._guarded_kill(proc.pid, signal.SIGKILL, pg=True)
            except (ProcessLookupError, PermissionError, ValueError):
                pass
            try:
                proc.communicate(timeout=5)
            except Exception:
                pass
        pidfile = self.jh / "run" / "metaviewer.pid"
        if pidfile.exists():
            try:
                self._guarded_kill(int(pidfile.read_text().split()[0]), signal.SIGKILL)
            except (ProcessLookupError, ValueError, PermissionError, IndexError):
                pass

    def log(self, name):
        path = self.fake / name
        return path.read_text() if path.exists() else ""

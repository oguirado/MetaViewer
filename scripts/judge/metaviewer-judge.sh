#!/usr/bin/env bash
# MetaViewer judge entry point: doctor | install | run | stop.
#
#   metaviewer-judge.sh doctor  [--capsules]                    checks only, changes nothing
#   metaviewer-judge.sh install [--capsules] [--yes] [--no-firewall]
#   metaviewer-judge.sh run
#   metaviewer-judge.sh stop
#
# Tiers: T1 is the packaged app alone; --capsules selects T2 (app plus one
# browser capsule: images, legacy or open network, profile directory).
#
# Safety rules (binding):
#   - sudo is only ever called through sudo_step, which prints the exact
#     command and asks first; --yes is the only non-interactive consent.
#   - Nothing is downloaded without a confirmation, and every asset is checked
#     against the kit's SHA256SUMS before use.
#   - Every refusal is typed: `JUDGE_<CODE>: <problem> -- fix: <command>`, rc 2.
#   - The identity store contents are never read; only the mode and owner of
#     the profile directory are inspected.
#
# Kit layout and installation state:
#   - Kit layout: <kit>/judge/{metaviewer-judge.sh,preflight.sh,apparmor/},
#     <kit>/assets/{SHA256SUMS,...}, <kit>/ui/tools/package.js and
#     <kit>/tools/mv_ram_admission.py (the checkout layout also works).
#   - Release asset names:
#     metaviewer-linux-<x64|arm64>.tar.gz (holds MetaViewer-linux-<arch>/ and
#     MetaViewer-linux-<arch>.sha256), node-linux-<arch>.tar.xz, and for T2
#     opensuperficies-linux-<arch>.tar.gz (opensuperficies/{bin,firewall}),
#     images-linux-<arch>.tar (docker save), vision-engine.tar.gz and
#     wender-agent.tar.gz (one top-level directory named after the component).
#   - Install never downloads SHA256SUMS; fetch_assets.py provisions it explicitly.
#   - State lives under MV_JUDGE_HOME (default $XDG_DATA_HOME/metaviewer-judge):
#     app/, deps/, node/, run/, logs/ and judge_receipt.json. No timestamp, pid
#     or host path is written to the receipt.
#   - Network by default is open: install installs the egress firewall in ONE
#     confirmed administrator step; if it is declined or unavailable, install
#     falls back to the legacy network (`net up`, no administrator rights).
#   - `stop` stops scoped capsules; the shared proxy remains running.
# Lines marked `# MUT:<code>` are deciding predicates that the offline
# mutation tests negate.
set -u
set -o pipefail

SELF_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P) || exit 64
PREFLIGHT=$SELF_DIR/preflight.sh
PROFILE_SRC=$SELF_DIR/apparmor/metaviewer

fail() { # code, problem, fix
    printf '%s: %s -- fix: %s\n' "$1" "$2" "$3" >&2
    exit 2
}
say() { printf '%s\n' "$*"; }
note() { printf 'JUDGE_NOTE: %s\n' "$*" >&2; }

usage() {
    printf 'JUDGE_USAGE: metaviewer-judge.sh doctor|install|run|stop [--before-install] [--capsules] [--yes] [--no-firewall] -- fix: use one of the documented subcommands\n' >&2
    exit 64
}

HOME_DIR=${HOME:-}
[ -n "$HOME_DIR" ] || { printf 'JUDGE_USAGE: HOME is not set -- fix: run from a normal login session\n' >&2; exit 64; }
SUB=${1:-}
[ $# -gt 0 ] && shift
ASSUME_YES=0
CAPSULES=0
NO_FIREWALL=0
BEFORE_INSTALL=0
while [ $# -gt 0 ]; do
    case $1 in
        --before-install) BEFORE_INSTALL=1 ;;
        --yes) ASSUME_YES=1 ;;
        --capsules) CAPSULES=1 ;;
        --no-firewall) NO_FIREWALL=1 ;;
        *) usage ;;
    esac
    shift
done
sub_valid() { case $1 in doctor | install | run | stop) return 0 ;; esac; return 1; }
if sub_valid "$SUB"; then :; else usage; fi # MUT:JUDGE_USAGE

# ---------------------------------------------------------------- environment
JUDGE_HOME=${MV_JUDGE_HOME:-${XDG_DATA_HOME:-$HOME_DIR/.local/share}/metaviewer-judge}
case $JUDGE_HOME in
    *[[:space:]]*) fail JUDGE_USAGE "MV_JUDGE_HOME must not contain whitespace" "export MV_JUDGE_HOME=/absolute/path-without-whitespace" ;;
    '' | / | "$HOME_DIR" | "$HOME_DIR"/) fail JUDGE_USAGE "MV_JUDGE_HOME '$JUDGE_HOME' would be the whole home or root" "unset MV_JUDGE_HOME or point it at a dedicated directory" ;;
    /*) ;;
    *) fail JUDGE_USAGE "MV_JUDGE_HOME must be an absolute path" "export MV_JUDGE_HOME=/absolute/path" ;;
esac
# Socket files live in short private runtime roots, independent of this home.
# Refuse filesystem-unrepresentable overrides before mkdir or asset work.
if command -v python3 >/dev/null 2>&1; then
    python3 -c '
import os, sys
from pathlib import Path
path = Path(sys.argv[1])
parent = path
try:
    while not parent.exists():
        parent = parent.parent
    name_max = os.pathconf(parent, "PC_NAME_MAX")
    path_max = os.pathconf(parent, "PC_PATH_MAX")
    if any(len(os.fsencode(part)) > name_max for part in path.parts) or len(os.fsencode(str(path / "run/smoke-processes/2147483647.pid"))) >= path_max:
        sys.exit(1)
except OSError:
    sys.exit(1)
' "$JUDGE_HOME" || fail JUDGE_HOME_PATH "MV_JUDGE_HOME cannot fit the filesystem path limits" "export MV_JUDGE_HOME=\"\$HOME/mv-judge\" and retry"
fi
if [ -n "${MV_JUDGE_KIT:-}" ]; then
    KIT=$MV_JUDGE_KIT
elif [ -f "$SELF_DIR/../../VERSION" ] && [ -d "$SELF_DIR/../../tools" ]; then
    KIT=$(cd "$SELF_DIR/../.." && pwd -P)
else
    KIT=$(cd "$SELF_DIR/.." && pwd -P)
fi
ASSET_DIR=${MV_JUDGE_ASSET_DIR:-$KIT/assets}
SRF_BIN=${MV_SRF_BIN_DIR:-$JUDGE_HOME/deps/opensuperficies/bin}
STORE=${SRF_IDENTITY_STORE_ROOT:-$HOME_DIR/.local/share/opensuperficies/identities}
PROFILE_ID=${MV_JUDGE_PROFILE:-judge}
SHM=${MV_JUDGE_SHM_DIR:-/dev/shm}
APPARMOR_DIR=${MV_JUDGE_APPARMOR_DIR:-/etc/apparmor.d}
WITNESS=${MV_JUDGE_FW_WITNESS:-/run/srf-open-egress/rules.sha256}
FW_LIBEXEC=${MV_JUDGE_FW_LIBEXEC:-/usr/local/libexec/srf-open-egress}
FW_UNIT_DIR=${MV_JUDGE_FW_UNIT_DIR:-/etc/systemd/system}
STOP_WAIT=${MV_JUDGE_STOP_WAIT:-30}
RUN_USER_ROOT=${MV_JUDGE_RUN_USER_ROOT:-/run/user}
PKG_TOOL=${MV_JUDGE_PKG_TOOL:-$KIT/ui/tools/package.js}
VERSION=$(tr -d ' \n' <"$KIT/VERSION" 2>/dev/null || printf 'unknown')
RELEASE_BASE=${MV_JUDGE_RELEASE_BASE:-https://github.com/oguirado/MetaViewer/releases/download/v$VERSION}
EUID_NOW=${MV_JUDGE_EUID:-$(id -u)}
UID_NOW=$(id -u)
case $(uname -m) in
    x86_64) ARCHN=x64 ;;
    aarch64) ARCHN=arm64 ;;
    *) ARCHN= ;;
esac
APP_ROOT=$JUDGE_HOME/app
APP_DIR=$APP_ROOT/MetaViewer-linux-${ARCHN:-unknown}
APP_BIN=$APP_DIR/metaviewer
RECEIPT=$JUDGE_HOME/judge_receipt.json
PIDFILE=$JUDGE_HOME/run/metaviewer.pid
if [ "$CAPSULES" = 1 ]; then TIER=T2; else TIER=T1; fi
export MV_JUDGE_HOME="$JUDGE_HOME" MV_JUDGE_KIT="$KIT" MV_JUDGE_ASSET_DIR="$ASSET_DIR" MV_SRF_BIN_DIR="$SRF_BIN"
export SRF_IDENTITY_STORE_ROOT="$STORE" MV_JUDGE_PROFILE="$PROFILE_ID" MV_JUDGE_SHM_DIR="$SHM"
export MV_JUDGE_APPARMOR_DIR="$APPARMOR_DIR" MV_JUDGE_FW_WITNESS="$WITNESS" MV_JUDGE_RUN_USER_ROOT="$RUN_USER_ROOT"


# Docker metadata may wait up to 120 seconds; image
# load/save/pull/build may take 1800 seconds. Kill a stuck client after grace.
# Environment overrides allow slower machines and offline deadline controls.
bounded_docker() {
    local limit=${MV_JUDGE_DOCKER_TIMEOUT:-120}
    case ${1:-} in load | save | pull | build) limit=${MV_JUDGE_DOCKER_IMAGE_TIMEOUT:-1800} ;; esac
    timeout --kill-after=5 "$limit" docker "$@"
}

# ------------------------------------------------------------------- helpers
pf() { bash "$PREFLIGHT" "$@"; }

pf_or_exit() {
    local rc
    pf "$@"
    rc=$?
    [ "$rc" -eq 0 ] || exit "$rc"
}

confirm() { # question; --yes is the only non-interactive consent
    local ans=
    if [ "$ASSUME_YES" = 1 ]; then
        printf '%s [confirmed by --yes]\n' "$1" >&2
        return 0
    fi
    printf '%s [y/N] ' "$1" >&2
    IFS= read -r ans || ans=
    [ -t 0 ] || printf '\n' >&2
    case $ans in y | Y | yes | YES) return 0 ;; esac
    return 1
}

# Returns 0 ran ok, 99 declined, 98 sudo missing, other = command failure.
sudo_step() { # description, then the command words
    local what=$1 rc
    shift
    if [ "$EUID_NOW" != 0 ] && ! command -v sudo >/dev/null 2>&1; then return 98; fi
    printf '\nAdministrator step: %s\n  command: ' "$what" >&2
    [ "$EUID_NOW" = 0 ] || printf 'sudo ' >&2
    printf '%q ' "$@" >&2
    printf '\n' >&2
    if confirm "Run this step now?"; then # MUT:JUDGE_SUDO
        if [ "$EUID_NOW" = 0 ]; then "$@"; else sudo "$@"; fi
        rc=$?
        return "$rc"
    fi
    return 99
}

need_sudo_step() { # like sudo_step, but a refusal ends the run
    local what=$1 rc
    sudo_step "$@"
    rc=$?
    case $rc in
        0) return 0 ;;
        99) fail JUDGE_SUDO "required administrator step declined: $what" "run the command shown above yourself, then re-run install" ;;
        98) fail JUDGE_SUDO "sudo is not installed and you are not root: $what" "install sudo or run the command shown above as root" ;;
        *) fail JUDGE_SUDO "administrator step failed (rc $rc): $what" "run the command shown above yourself and read its error" ;;
    esac
}

json_str() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
fact() { printf '%s\n' "$FACTS" | sed -n "s/^$1=//p" | head -n 1; }

pid_alive() { # alive and really a MetaViewer process
    local pid=$1
    case $pid in '' | *[!0-9]*) return 1 ;; esac
    kill -0 "$pid" 2>/dev/null || return 1
    tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | grep -q metaviewer
}

running_pid() {
    local pid=
    [ -f "$PIDFILE" ] && pid=$(head -n 1 "$PIDFILE" 2>/dev/null)
    if pid_alive "$pid"; then printf '%s' "$pid"; fi
}

# One owner spans the check, install/launch and cleanup.
# Keep the locked descriptor in the launcher; children must not retain it.
lock_launcher() {
    mkdir -p "$JUDGE_HOME/run" && chmod 0700 "$JUDGE_HOME" "$JUDGE_HOME/run" ||
        fail JUDGE_PIDFILE "cannot create launcher lock directory" "make $JUDGE_HOME writable"
    exec 9>"$JUDGE_HOME/run/launcher.lock" || fail JUDGE_PIDFILE "cannot open launcher lock" "make $JUDGE_HOME/run writable"
    python3 -c 'import fcntl; fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)' 2>/dev/null ||
        fail JUDGE_RUNNING "another launcher owns run or install" "wait for the launcher to finish, or interrupt the active launcher in its terminal, then retry"
}

remove_owned_pid() {
    # Empty/unpublished state is not an ownership witness.
    case $1 in '' | *[!0-9]*) return 0 ;; esac
    [ "$(head -n 1 "$PIDFILE" 2>/dev/null)" != "$1" ] || rm -f -- "$PIDFILE"
}

tar_names_ok() { # file, ERE every member name must match
    local names
    names=$(tar -tf "$1" 2>/dev/null) || return 1
    [ -n "$names" ] || return 1
    printf '%s\n' "$names" | grep -Eq '(^/|(^|/)\.\.(/|$))' && return 1
    printf '%s\n' "$names" | grep -Evq "$2" && return 1
    return 0
}

tar_members_ok() { # names plus: regular files and directories only (no links)
    local types
    tar_names_ok "$1" "$2" || return 1
    types=$(tar -tvf "$1" 2>/dev/null | cut -c1) || return 1
    printf '%s\n' "$types" | grep -vq '^[-d]$' && return 1
    return 0
}

# -------------------------------------------------------------------- assets
sums_digest() { # asset name -> sha256 listed in the kit SHA256SUMS
    awk -v n="$1" '{ f = $2; sub(/^\*/, "", f); if (f == n) { print $1; exit } }' "$ASSET_DIR/SHA256SUMS"
}

verify_asset() { # name; removes it when this run downloaded it
    local name=$1 expected actual
    expected=$(sums_digest "$name")
    actual=$(sha256sum -- "$ASSET_DIR/$name" 2>/dev/null | cut -d ' ' -f 1)
    if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then # MUT:JUDGE_ASSET
        case " $DOWNLOADED " in *" $name "*) rm -f -- "$ASSET_DIR/$name" ;; esac
        fail JUDGE_ASSET "$name does not match the kit SHA256SUMS (expected '${expected:-no entry}', got '${actual:-unreadable}')" "download $name again from $RELEASE_BASE and re-run install"
    fi
}

DOWNLOADED=
ensure_assets() { # asset names
    local n missing="" tmp fetch_flags=""
    [ "$TIER" = T2 ] && fetch_flags=--capsules
    mkdir -p "$ASSET_DIR" 2>/dev/null || fail JUDGE_ASSET "cannot create $ASSET_DIR" "choose a writable MV_JUDGE_ASSET_DIR"
    [ -f "$ASSET_DIR/SHA256SUMS" ] || fail JUDGE_ASSET "SHA256SUMS is missing from $ASSET_DIR" "python3 \"$SELF_DIR/fetch_assets.py\" --source <complete-release-directory> --dest \"$ASSET_DIR\" $fetch_flags"
    for n in "$@"; do
        [ -f "$ASSET_DIR/$n" ] || missing="$missing $n"
    done
    if [ -n "$missing" ]; then
        printf '\nThese release assets are not in %s:%s\nSource: %s\n' "$ASSET_DIR" "$missing" "$RELEASE_BASE" >&2
        if ! command -v curl >/dev/null 2>&1; then
            fail JUDGE_SYSDEP "curl is needed to download the assets" "sudo apt-get install -y curl"
        fi
        if ! confirm "Download them now (uses the network)?"; then
            fail JUDGE_ASSET "download declined, assets are missing:$missing" "place those files in $ASSET_DIR and re-run install"
        fi
        for n in $missing; do
            tmp="$ASSET_DIR/.$n.part"
            # Bound connection setup and a stalled
            # transfer, not total download time: large assets may take minutes.
            # Keep cleanup in this subshell so run's signal traps are untouched.
            if (
                trap 'rm -f -- "$tmp"' EXIT
                trap 'exit 130' INT
                trap 'exit 143' TERM HUP
                if curl --fail --location --proto '=https' --tlsv1.2 --silent --show-error \
                    --connect-timeout "${MV_JUDGE_DOWNLOAD_CONNECT:-60}" \
                    --speed-limit 1 --speed-time "${MV_JUDGE_DOWNLOAD_STALL:-120}" \
                    --output "$tmp" "$RELEASE_BASE/$n"; then
                    mv -f -- "$tmp" "$ASSET_DIR/$n"
                else
                    exit 1
                fi
            ); then
                DOWNLOADED="$DOWNLOADED $n"
            else
                fail JUDGE_ASSET "download of $n failed, stalled or was interrupted" "check the network and the release URL $RELEASE_BASE/$n, then re-run install"
            fi
        done
    fi
    for n in "$@"; do verify_asset "$n"; done
}

# ------------------------------------------------------------------- install
find_node() {
    NODE_BIN=
    if [ -x "$JUDGE_HOME/node/bin/node" ]; then
        NODE_BIN=$JUDGE_HOME/node/bin/node
    else
        NODE_BIN=$(command -v node 2>/dev/null || printf '')
    fi
}

node_ok() {
    local v major
    [ -n "$NODE_BIN" ] || return 1
    v=$("$NODE_BIN" --version 2>/dev/null || printf '')
    major=${v#v}
    major=${major%%.*}
    case $major in '' | *[!0-9]*) return 1 ;; esac
    [ "$major" -ge 24 ]
}

step_sysdeps() {
    local pkgs rc
    pkgs=$(pf --sysdep-packages --tier "$TIER")
    [ -n "$pkgs" ] || return 0
    # shellcheck disable=SC2086
    sudo_step "install the system packages: $pkgs" bash -c 'apt-get update && apt-get install -y "$@"' _ $pkgs
    rc=$?
    case $rc in
        0) ;;
        99) fail JUDGE_SUDO "required administrator step declined: install $pkgs" "sudo apt-get install -y $pkgs" ;;
        98) fail JUDGE_SUDO "sudo is not installed and you are not root" "su -c 'apt-get install -y $pkgs'" ;;
        *) fail JUDGE_SUDO "administrator package step failed (rc $rc) for: $pkgs; sudo authorization or apt-get may have failed" "read the administrator command's error above; ask an administrator to run apt-get install -y $pkgs, then re-run install as your normal user" ;;
    esac
    pkgs=$(pf --sysdep-packages --tier "$TIER")
    [ -z "$pkgs" ] || fail JUDGE_SYSDEP "packages still missing after apt-get: $pkgs" "sudo apt-get install -y $pkgs"
}

step_node() {
    find_node
    node_ok && return 0
    local asset=node-linux-$ARCHN.tar.xz work=$JUDGE_HOME/node.new
    ensure_assets "$asset"
    tar_names_ok "$ASSET_DIR/$asset" '^[^/]+/' || fail JUDGE_ASSET "$asset has unsafe or unexpected members" "download $asset again from $RELEASE_BASE"
    rm -rf -- "$work"
    mkdir -p "$work"
    # Copy regular members only; npm links are recreated as local wrappers.
    python3 "$SELF_DIR/unpack_node.py" "$ASSET_DIR/$asset" "$work" || fail JUDGE_ASSET "cannot unpack node from $asset" "download $asset again from $RELEASE_BASE"
    rm -rf -- "$JUDGE_HOME/node"
    mv -- "$work" "$JUDGE_HOME/node"
    find_node
    node_ok || fail JUDGE_NODE "the kit node is '$("$NODE_BIN" --version 2>/dev/null || printf unreadable)', major 24 is required [CITED]" "use a Node 24 asset in $ASSET_DIR"
}

step_extract_app() {
    local asset=metaviewer-linux-$ARCHN.tar.gz re work=$JUDGE_HOME/app.new
    ensure_assets "$asset"
    re="^(MetaViewer-linux-$ARCHN(/.*)?|MetaViewer-linux-$ARCHN\\.sha256)\$"
    tar_members_ok "$ASSET_DIR/$asset" "$re" || fail JUDGE_ASSET "$asset has unsafe or unexpected members (absolute path, .., link or foreign directory)" "download $asset again from $RELEASE_BASE"
    rm -rf -- "$work"
    mkdir -p "$work"
    tar --no-same-owner -pxf "$ASSET_DIR/$asset" -C "$work" || fail JUDGE_ASSET "cannot unpack $asset" "download $asset again from $RELEASE_BASE"
    [ -x "$work/MetaViewer-linux-$ARCHN/metaviewer" ] || fail JUDGE_ASSET "$asset holds no executable MetaViewer-linux-$ARCHN/metaviewer" "download the tarball for $ARCHN"
    rm -rf -- "$JUDGE_HOME/app.old"
    if [ -d "$APP_ROOT" ]; then
        mv -- "$APP_ROOT" "$JUDGE_HOME/app.old" || fail JUDGE_ASSET "cannot preserve installed app" "make $JUDGE_HOME writable and retry install"
    fi
    if ! mv -- "$work" "$APP_ROOT"; then
        if [ -d "$JUDGE_HOME/app.old" ]; then
            mv -- "$JUDGE_HOME/app.old" "$APP_ROOT" || fail JUDGE_ASSET "cannot restore installed app from app.old" "restore $JUDGE_HOME/app.old to $APP_ROOT before retrying"
        fi
        fail JUDGE_ASSET "cannot publish extracted app; previous install preserved" "make $JUDGE_HOME writable and retry install"
    fi
    rm -rf -- "$JUDGE_HOME/app.old"
}

step_apparmor() {
    local v
    v=$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null) || v=0
    [ "$v" = 1 ] || return 0
    cmp -s "$PROFILE_SRC" "$APPARMOR_DIR/metaviewer-judge" 2>/dev/null && return 0
    command -v apparmor_parser >/dev/null 2>&1 || fail JUDGE_USERNS "apparmor_parser is not installed, so the metaviewer profile cannot be loaded" "sudo apt-get install -y apparmor"
    need_sudo_step "load the AppArmor profile that lets MetaViewer's own sandbox create a user namespace (instead of disabling the sysctl for the whole machine)" \
        bash -c 'install -m 0644 -o root -g root "$1" "$2" && apparmor_parser -r "$2"' _ "$PROFILE_SRC" "$APPARMOR_DIR/metaviewer-judge"
}

# The package tool imports @electron/asar. A kit unpacked from source has no ui/node_modules,
# so install the lockfile's exact versions; --ignore-scripts skips the Electron download and
# native builds, because the app under test comes from the release tarball.
ensure_pkg_tool_deps() {
    local log=$1 ui
    ui=$KIT/ui
    [ -f "$ui/package-lock.json" ] || return 0
    # Import the actual tool: this checks its complete transitive import tree,
    # including asar's dependencies, rather than a directory left by failed ci.
    if [ -f "$ui/node_modules/@electron/asar/package.json" ] &&
        "$NODE_BIN" --input-type=module -e 'import {pathToFileURL} from "node:url"; const tool = process.argv.pop(); await import(pathToFileURL(tool).href)' "$PKG_TOOL" >"$log" 2>&1; then
        return 0
    fi
    PATH="$(dirname "$NODE_BIN"):$PATH" command -v npm >/dev/null 2>&1 ||
        fail JUDGE_NPM "the Node asset has no npm and package verification needs it" "sudo apt-get install -y npm"
    if ! PATH="$(dirname "$NODE_BIN"):$PATH" npm --prefix "$ui" ci --ignore-scripts --no-audit --no-fund >"$log" 2>&1; then
        fail JUDGE_SMOKE "cannot install the package tool dependencies: $(tail -n 3 "$log" | tr '\n' ' ')" "check the network, then run: npm --prefix $ui ci --ignore-scripts"
    fi
    "$NODE_BIN" --input-type=module -e 'import {pathToFileURL} from "node:url"; const tool = process.argv.pop(); await import(pathToFileURL(tool).href)' "$PKG_TOOL" >>"$log" 2>&1 ||
        fail JUDGE_SMOKE "package tool imports still fail after npm ci" "see $log; restore the complete kit and retry npm --prefix $ui ci --ignore-scripts"
}

# [TARGET, unit decision] Short smoke roots are private and recorded under run/.
# Reconciliation never signals a PID: both the leader identity and its entire
# original session/group must be gone before its ownership record is removed.
smoke_state() {
    python3 -c '
import json, os, re, shutil, stat, subprocess, sys, tempfile
from pathlib import Path
home, action, owner = Path(sys.argv[1]), sys.argv[2], int(sys.argv[3])
records, roots = home / "run/smoke-processes", home / "run/smoke-roots"
def private(path, mode, directory=False):
    st = path.lstat()
    if st.st_uid != os.getuid() or stat.S_IMODE(st.st_mode) != mode or not (stat.S_ISDIR(st.st_mode) if directory else stat.S_ISREG(st.st_mode)):
        raise ValueError("unverified smoke state: " + str(path))
    return st
def proc(pid):
    try:
        return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
    except (FileNotFoundError, ProcessLookupError):
        return None
def gone(pid, start, group, session, scan_group=True, session_scope=False):
    current = proc(pid)
    if current is not None and (current[19] != str(start) or current[2:4] != [str(group), str(session)]):
        raise ValueError("smoke process identity changed: " + str(pid))
    if current is not None and current[0] not in ("Z", "X"):
        return False
    if not scan_group:
        return True
    for item in Path("/proc").iterdir():
        if item.name.isdecimal():
            fields = proc(item.name)
            if fields and fields[0] not in ("Z", "X") and fields[3] == str(session) and (session_scope or fields[2] == str(group)):
                return False
    return True
def remove_root(path, dev, ino):
    if path.parent != Path("/tmp") or not re.fullmatch(r"mvj\.[a-z0-9_]+", path.name):
        raise ValueError("unverified short smoke root")
    try:
        st = private(path, 0o700, True)
    except FileNotFoundError:
        return
    if (st.st_dev, st.st_ino) != (dev, ino):
        raise ValueError("smoke directory identity changed")
    shutil.rmtree(path)
try:
    for directory in (records, roots):
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        private(directory, 0o700, True)
    if action == "allocate":
        fields = proc(owner)
        if fields is None:
            raise ValueError("smoke launcher identity unavailable")
        path = Path(tempfile.mkdtemp(prefix="mvj.", dir="/tmp"))
        st = private(path, 0o700, True)
        row = dict(path=str(path), dev=st.st_dev, ino=st.st_ino, pid=owner, phase="allocated",
                   start=fields[19], group=int(fields[2]), session=int(fields[3]))
        receipt = roots / (path.name + ".json")
        try:
            with open(receipt, "x", opener=lambda p, f: os.open(p, f, 0o600)) as stream:
                json.dump(row, stream)
        except BaseException:
            shutil.rmtree(path)
            raise
        print(path)
    elif action == "run":
        path = Path(sys.argv[4])
        receipt = roots / (path.name + ".json")
        private(receipt, 0o600)
        row = json.loads(receipt.read_text())
        st = private(path, 0o700, True)
        if row["path"] != str(path) or (row["dev"], row["ino"]) != (st.st_dev, st.st_ino) or row["pid"] != owner or row["phase"] != "allocated":
            raise ValueError("unverified smoke supervisor handoff")
        # The supervisor records its new session before starting any children.
        # A caller shell that survives an interrupted install cannot pin it.
        os.setsid()
        pid = os.getpid()
        fields = proc(pid)
        row.update(pid=pid, start=fields[19], group=pid, session=pid, phase="running")
        temp = receipt.with_suffix(".tmp")
        with open(temp, "x", opener=lambda p, f: os.open(p, f, 0o600)) as stream:
            json.dump(row, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, receipt)
        rc = subprocess.run(sys.argv[5:]).returncode
        sys.exit(rc if rc >= 0 else 128 - rc)
    else:
        active = False
        dead = []
        for record in records.iterdir():
            private(record, 0o600)
            text = record.read_text().split()
            if len(text) != 2 or not all(v.isdecimal() for v in text) or int(text[0]) <= 1 or record.name != text[0] + ".pid":
                raise ValueError("unverified smoke process record: " + str(record))
            pid, start = map(int, text)
            if gone(pid, start, pid, pid):
                dead.append(record)
            else:
                active = True
                print("JUDGE_SMOKE_ACTIVE: recorded smoke group remains: " + str(pid), file=sys.stderr)
        for receipt in roots.iterdir():
            private(receipt, 0o600)
            row = json.loads(receipt.read_text())
            path = Path(row["path"])
            allocated = row.get("phase") == "allocated"
            released = allocated and action == "release" and str(path) == sys.argv[4] and row["pid"] == owner
            if not active and (released or gone(row["pid"], row["start"], row["group"], row["session"], not allocated, row.get("phase") == "running")):
                remove_root(path, row["dev"], row["ino"])
                receipt.unlink()
            else:
                active = True
                print("JUDGE_SMOKE_ACTIVE: recorded smoke runtime remains: " + str(path), file=sys.stderr)
        # Legacy roots have no per-root receipt. Only reconcile them after a
        # verified dead process record and with no unresolved ownership records.
        legacy = home / "run/smoke-tmp"
        if dead and not active and legacy.exists():
            private(legacy, 0o700, True)
            for path in legacy.iterdir():
                if re.fullmatch(r"mv-clean-[A-Za-z0-9]+", path.name):
                    private(path, 0o700, True)
                    shutil.rmtree(path)
        for record in dead:
            record.unlink()
        if active:
            sys.exit(2)
except (OSError, ValueError, KeyError, TypeError) as error:
    print("JUDGE_SMOKE_STATE: " + str(error), file=sys.stderr)
    sys.exit(2)
' "$JUDGE_HOME" "$1" "$$" "${2:-}" "${@:3}"
}

step_verify_smoke() {
    local log=$JUDGE_HOME/logs/smoke.log rc smoke_runtime
    mkdir -p "$JUDGE_HOME/logs"
    if [ ! -f "$PKG_TOOL" ]; then
        fail JUDGE_SMOKE "the package verification tool is missing from the kit ($PKG_TOOL)" "extract the full judge kit again"
    fi
    ensure_pkg_tool_deps "$log"
    if "$NODE_BIN" "$PKG_TOOL" --verify-install "$APP_DIR" >"$log" 2>&1; then
        :
    else
        fail JUDGE_SMOKE "package verification failed: $(tail -n 3 "$log" | tr '\n' ' ')" "download the release tarball again and re-run install"
    fi
    smoke_runtime=$(smoke_state allocate) ||
        fail JUDGE_SMOKE_STATE "cannot create private smoke state" "make $JUDGE_HOME/run and /tmp writable"
    if TMPDIR="$smoke_runtime" MV_PACKAGE_SMOKE_STATE_DIR="$JUDGE_HOME/run/smoke-processes" smoke_state run "$smoke_runtime" timeout 600 "$NODE_BIN" "$PKG_TOOL" --smoke "$ASSET_DIR/metaviewer-linux-$ARCHN.tar.gz" >>"$log" 2>&1; then # MUT:JUDGE_SMOKE
        smoke_state release "$smoke_runtime" ||
            fail JUDGE_SMOKE_STATE "smoke ownership remains" "verify the recorded group has exited, then retry install"
        say METAVIEWER_MAIN_SMOKE_OK
    else
        rc=$?
        smoke_state release "$smoke_runtime" || true
        fail JUDGE_SMOKE "the install smoke failed (rc $rc): $(tail -n 3 "$log" | tr '\n' ' ')" "see $log; run as a non-root user, check DISPLAY/xvfb-run and the AppArmor profile, then re-run install"
    fi
}

extract_dep() { # asset, component directory name
    local asset=$1 comp=$2
    ensure_assets "$asset"
    tar_members_ok "$ASSET_DIR/$asset" "^$comp(/.*)?\$" || fail JUDGE_ASSET "$asset has unsafe or unexpected members" "download $asset again from $RELEASE_BASE"
    mkdir -p "$JUDGE_HOME/deps"
    rm -rf -- "${JUDGE_HOME:?}/deps/$comp"
    tar --no-same-owner -pxf "$ASSET_DIR/$asset" -C "$JUDGE_HOME/deps" || fail JUDGE_ASSET "cannot unpack $asset" "download $asset again from $RELEASE_BASE"
}

step_images() {
    local asset=images-linux-$ARCHN.tar img missing=0 idver=0.1.1
    [ "$(net_mode_now)" = open ] && idver=0.2.0
    for img in "opensuperficies-identity-browser-$ARCHN:$idver" "opensuperficies-program-host-$ARCHN:0.1.0" "opensuperficies-desktop-$ARCHN:1.1.0"; do
        bounded_docker image inspect "$img" >/dev/null 2>&1 || missing=1
    done
    [ "$missing" = 1 ] || return 0
    ensure_assets "$asset"
    bounded_docker load -i "$ASSET_DIR/$asset" >/dev/null || fail JUDGE_IMAGE "docker load of $asset failed" "check 'docker info' and free disk space, then re-run install --capsules"
}

step_profile() {
    local pid p st pool= idver=0.1.1 admin=$JUDGE_HOME/deps/opensuperficies/bin/srf-identity-admin
    if [ -n "${MV_SRF_PROFILES:-}" ]; then
        pool=$(python3 -c '
import json, re, sys
try:
    pool = json.loads(sys.argv[1])
    if not isinstance(pool, dict) or not pool:
        raise ValueError()
    for name, spec in pool.items():
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", name) or not isinstance(spec, dict):
            raise ValueError()
        if spec.get("Kind") == "browser" or spec.get("NativeKind") == "browser":
            print(name)
except (ValueError, TypeError):
    sys.exit(2)
' "$MV_SRF_PROFILES") || fail JUDGE_PROFILE "MV_SRF_PROFILES is not a valid profile pool" "set a valid profile pool and retry install --capsules"
    fi
    [ "$(net_mode_now)" = open ] && idver=0.2.0
    mkdir -p "$STORE/identities" "$STORE/profiles" && chmod 0700 "$STORE" "$STORE/identities" "$STORE/profiles" || fail JUDGE_PROFILE "cannot create $STORE/profiles" "choose a writable SRF_IDENTITY_STORE_ROOT"
    while IFS= read -r pid; do
        [ -n "$pid" ] || continue
        if [ -x "$admin" ] && [ ! -f "$STORE/metadata/$pid.json" ]; then
            "$admin" create --store-root "$STORE" --id "$pid" --label "$pid" --domains example.com >/dev/null 2>&1 ||
                fail JUDGE_PROFILE "identity publication failed for $pid in $STORE" "check SRF_IDENTITY_STORE_ROOT ownership and run srf-identity-admin create --store-root '$STORE' --id '$pid' --label '$pid' --domains example.com; then retry install --capsules"
        fi
        if [ ! -f "$STORE/identities/$pid.json" ]; then
            printf '{"profile_id":"%s","display_name":"%s","domains":["example.com"]}\n' "$(json_str "$pid")" "$(json_str "$pid")" >"$STORE/identities/$pid.json" 2>/dev/null ||
                fail JUDGE_PROFILE "cannot publish identity $pid in $STORE/identities" "choose a writable SRF_IDENTITY_STORE_ROOT and retry install --capsules"
        fi
        p="$STORE/profiles/$pid"
        st=$(stat -c '%a %u' -- "$p" 2>/dev/null || printf '')
        [ "$st" = "700 10001" ] && continue
        bounded_docker run --rm --pull=never --network none --user 0 --entrypoint /bin/sh \
            --mount "type=bind,src=$STORE/profiles,dst=/profiles" \
            "opensuperficies-identity-browser-$ARCHN:$idver" \
            -c 'mkdir -p "$1" && chown 10001:10001 "$1" && chmod 0700 "$1"' -- "/profiles/$pid" >/dev/null 2>&1 ||
            fail JUDGE_PROFILE "cannot provision $p via Docker" "docker run --rm --pull=never --network none --user 0 --entrypoint /bin/sh --mount type=bind,src=$STORE/profiles,dst=/profiles opensuperficies-identity-browser-$ARCHN:$idver -c 'mkdir -p /profiles/$pid && chown 10001:10001 /profiles/$pid && chmod 0700 /profiles/$pid'"
    done < <(printf '%s\n' "$PROFILE_ID" mv-live-1 mv-live-2 mv-live-3 mv-live-4 "$pool")
    p="$STORE/profiles/$PROFILE_ID"
    st=$(stat -c '%a %u' -- "$p" 2>/dev/null || printf '')
    [ "$st" = "700 10001" ] || fail JUDGE_PROFILE "profile directory $p is not mode 0700 owned by uid 10001 (found '${st:-absent}')" "docker run --rm --pull=never --network none --user 0 --entrypoint /bin/sh --mount type=bind,src=$STORE/profiles,dst=/profiles opensuperficies-identity-browser-$ARCHN:$idver -c 'mkdir -p /profiles/$PROFILE_ID && chown 10001:10001 /profiles/$PROFILE_ID && chmod 0700 /profiles/$PROFILE_ID'"
}

fw_script() { # prints the exact root script; every input file is re-hashed at run time
    local d=$1 f sum
    printf 'set -eu\n'
    for f in apply.sh srf-open-egress.rules srf-open-egress6.rules srf-open-egress.service; do
        sum=$(sha256sum -- "$d/$f" | cut -d ' ' -f 1)
        printf 'echo %q | sha256sum -c -\n' "$sum  $d/$f"
    done
    printf 'install -d -m 0755 -o root -g root %q\n' "$FW_LIBEXEC"
    printf 'install -m 0755 -o root -g root %q %q\n' "$d/apply.sh" "$FW_LIBEXEC/apply.sh"
    printf 'install -m 0644 -o root -g root %q %q\n' "$d/srf-open-egress.rules" "$FW_LIBEXEC/srf-open-egress.rules"
    printf 'install -m 0644 -o root -g root %q %q\n' "$d/srf-open-egress6.rules" "$FW_LIBEXEC/srf-open-egress6.rules"
    printf 'install -m 0644 -o root -g root %q %q\n' "$d/srf-open-egress.service" "$FW_UNIT_DIR/srf-open-egress.service"
    printf 'systemctl daemon-reload\n'
    printf 'systemctl enable --now srf-open-egress.service\n'
    printf 'cat %q\n' "$WITNESS"
}

step_firewall() { # returns 1 when the install falls back to the legacy network
    local d=$JUDGE_HOME/deps/opensuperficies/firewall f t text rc
    if [ "$NO_FIREWALL" = 1 ]; then note "firewall skipped by --no-firewall: using the legacy network"; return 1; fi
    if [ -s "$WITNESS" ]; then note "egress firewall witness already present"; return 0; fi
    for f in apply.sh srf-open-egress.rules srf-open-egress6.rules srf-open-egress.service; do
        [ -f "$d/$f" ] || { note "firewall file $f is absent from the kit: using the legacy network"; return 1; }
    done
    for t in iptables ip6tables iptables-restore ip6tables-restore systemctl; do
        command -v "$t" >/dev/null 2>&1 || { note "$t is not installed: using the legacy network"; return 1; }
    done
    text=$(fw_script "$d")
    say ""
    say "Open network is the default. Capsules reach the public internet only; LAN and host services stay blocked"
    say "by the egress firewall below. Installing it is ONE administrator step. This is the exact script:"
    printf '%s\n' "$text" | sed 's/^/    | /'
    sudo_step "install the open-mode egress firewall" bash -c "$text"
    rc=$?
    case $rc in
        0) ;;
        99) note "firewall step declined: falling back to the legacy network"; return 1 ;;
        98) note "sudo is unavailable: falling back to the legacy network"; return 1 ;;
        *) note "firewall step failed (rc $rc): falling back to the legacy network"; return 1 ;;
    esac
    if [ ! -s "$WITNESS" ]; then note "the firewall witness is absent after the step: falling back to the legacy network"; return 1; fi
    note "after any firewall reload (iptables -F, nft flush, ufw/firewalld reload) run: sudo systemctl restart srf-open-egress.service"
    return 0
}

net_mode_now() { pf --facts --tier "$TIER" | sed -n 's/^network=//p'; }

ensure_capsule_net() { # supported launcher; all private metadata belongs to the CLI principal
    local netroot=$JUDGE_HOME/network statedir
    statedir=${XDG_STATE_HOME:-$HOME_DIR/.local/state}/metaviewer/srf
    [ -x "$SRF_BIN/srf-identity-surface" ] && [ -x "$SRF_BIN/srf-egress-proxy" ] ||
        fail JUDGE_NET "kit surface or proxy executable is absent" "restore opensuperficies/bin from the verified kit"
    (
        umask 077
        mkdir -p "$netroot/policy" "$netroot/registry" "$netroot/audit" "$statedir" &&
            chmod 0700 "$netroot" "$netroot/policy" "$netroot/registry" "$netroot/audit" "$statedir" || exit 1
        # Exact-host approvals require operator input.
        # The upstream schema has no wildcard: never invent an open-policy API.
        if [ ! -e "$netroot/policy/policy.json" ]; then
            printf '%s\n' '{"schema":"browserid.proxy-policy/v1","approved":{},"denied":[],"connect_ports":{}}' >"$netroot/policy/policy.json" || exit 1
        fi
        chmod 0600 "$netroot/policy/policy.json"
    ) || fail JUDGE_NET "cannot provision private proxy metadata" "check ownership and permissions under $netroot"
    if "$SRF_BIN/srf-identity-surface" net up --proxy-bin "$SRF_BIN/srf-egress-proxy" --policy "$netroot/policy/policy.json" --registry "$netroot/registry/registry.json" --audit-dir "$netroot/audit" --state-dir "$statedir"; then # MUT:JUDGE_PROXY_UP
        :
    else
        fail JUDGE_NET "supported proxy net up failed" "check kit binaries and $netroot metadata; an existing mismatched proxy requires explicit operator recovery"
    fi
}

write_receipt() {
    local tmp="$RECEIPT.tmp.$$" assets="" n sum docker_ver="" first=1
    for n in "$@"; do
        sum=$(sums_digest "$n")
        [ "$first" = 1 ] || assets="$assets,"
        assets="$assets
    \"$(json_str "$n")\": \"$(json_str "$sum")\""
        first=0
    done
    if [ "$TIER" = T2 ]; then docker_ver=$(bounded_docker version --format '{{.Server.Version}}' 2>/dev/null || printf ''); fi
    (
        umask 077
        {
            printf '{\n'
            printf '  "schema": "metaviewer.judge_receipt/v1",\n'
            printf '  "version": "%s",\n' "$(json_str "$VERSION")"
            printf '  "tier": "%s",\n' "$TIER"
            printf '  "arch": "%s",\n' "$ARCHN"
            printf '  "network_mode": "%s",\n' "$(json_str "$(fact network)")"
            printf '  "node_version": "%s",\n' "$(json_str "$(fact node_version)")"
            printf '  "docker_server_version": "%s",\n' "$(json_str "$docker_ver")"
            printf '  "smoke": "METAVIEWER_MAIN_SMOKE_OK",\n'
            printf '  "profile_id": "%s",\n' "$([ "$TIER" = T2 ] && json_str "$PROFILE_ID" || printf '')"
            printf '  "measured": {\n'
            printf '    "nproc": %s,\n' "$(fact nproc | grep -E '^[0-9]+$' || printf null)"
            printf '    "mem_total_kib": %s,\n' "$(fact mem_total_kib | grep -E '^[0-9]+$' || printf null)"
            printf '    "mem_available_kib": %s,\n' "$(fact mem_available_kib | grep -E '^[0-9]+$' || printf null)"
            printf '    "shm_avail_bytes": %s\n' "$(fact shm_avail_bytes | grep -E '^[0-9]+$' || printf null)"
            printf '  },\n'
            printf '  "assets": {%s\n  }\n' "$assets"
            printf '}\n'
        } >"$tmp"
    ) && mv -f -- "$tmp" "$RECEIPT" || fail JUDGE_ASSET "cannot write the receipt $RECEIPT" "make $JUDGE_HOME writable"
}

cmd_install() {
    lock_launcher
    # The parent keeps flock while every installation child has fd 9 closed.
    # If this launcher dies, an orphaned installer cannot keep the lock alive.
    (cmd_install_locked) 9>&-
}

cmd_install_locked() {
    local assets_used
    [ -z "$(running_pid)" ] || fail JUDGE_RUNNING "MetaViewer is running" "bash $0 stop"
    mkdir -p "$JUDGE_HOME" && chmod 0700 "$JUDGE_HOME" || fail JUDGE_ASSET "cannot create $JUDGE_HOME" "set MV_JUDGE_HOME to a writable directory"
    smoke_state reconcile || fail JUDGE_SMOKE_ACTIVE "interrupted smoke ownership is still live or unverifiable" "inspect run/smoke-processes and run/smoke-roots; let the recorded group exit, then retry install"
    pf_or_exit --tier "$TIER" --phase static
    step_sysdeps
    [ "$TIER" != T2 ] || pf_or_exit --tier "$TIER" --phase static
    step_node
    pf_or_exit --tier "$TIER" --phase display
    step_extract_app
    assets_used="metaviewer-linux-$ARCHN.tar.gz"
    step_apparmor
    step_verify_smoke
    if [ "$TIER" = T2 ]; then
        extract_dep "opensuperficies-linux-$ARCHN.tar.gz" opensuperficies
        extract_dep vision-engine.tar.gz vision-engine
        extract_dep wender-agent.tar.gz wender-agent
        assets_used="$assets_used opensuperficies-linux-$ARCHN.tar.gz vision-engine.tar.gz wender-agent.tar.gz images-linux-$ARCHN.tar"
        # Load the legacy-compatible set before deciding whether Open is available.
        step_images
        if bounded_docker image inspect "opensuperficies-identity-browser-$ARCHN:0.2.0" >/dev/null 2>&1; then
            step_firewall || true
        elif [ -s "$WITNESS" ]; then
            fail JUDGE_IMAGE "Open firewall is active but the kit lacks the Open browser image" "obtain a kit containing opensuperficies-identity-browser-$ARCHN:0.2.0"
        else
            note "Open browser image unavailable; using legacy network without installing a firewall"
        fi
        step_profile
        if [ "$(net_mode_now)" != open ]; then
            ensure_capsule_net
            say "JUDGE_NOTE: Legacy network reaches no public site today. Open mode requires a compatible browser image and firewall; see docs/JUDGE_QUICKSTART.md."
        fi
    fi
    pf_or_exit --tier "$TIER" --phase all
    FACTS=$(pf --facts --tier "$TIER")
    # shellcheck disable=SC2086
    write_receipt $assets_used
    say "JUDGE_INSTALL_OK tier=$TIER network=$(fact network) receipt=$RECEIPT"
}

# ----------------------------------------------------------------------- run
receipt_tier() { sed -n 's/^  "tier": "\(T[0-2]\)",\{0,1\}$/\1/p' "$RECEIPT" 2>/dev/null | head -n 1; }

cmd_run() {
    local pid tier v rc child dest statedir ramroot profiles_json p2 p3 p4 rjson
    local -a envv
    lock_launcher
    if [ ! -x "$APP_BIN" ] || [ ! -f "$RECEIPT" ]; then # MUT:JUDGE_NOT_INSTALLED
        fail JUDGE_NOT_INSTALLED "MetaViewer is not installed under $JUDGE_HOME" "bash $0 install [--capsules]"
    fi
    pid=$(running_pid)
    if [ -n "$pid" ]; then # MUT:JUDGE_RUNNING
        fail JUDGE_RUNNING "MetaViewer is already running (pid $pid [MEASURED])" "bash $0 stop"
    fi
    tier=$(receipt_tier)
    case $tier in T1 | T2) TIER=$tier ;; *) fail JUDGE_NOT_INSTALLED "the receipt $RECEIPT has no valid tier" "bash $0 install [--capsules]" ;; esac
    if [ "$TIER" = T2 ] && [ "$(net_mode_now)" != open ]; then
        # Static checks diagnose the Docker endpoint before any network repair.
        # Full network readiness is checked after the repair, below.
        pf_or_exit --tier "$TIER" --phase static
        say "ensuring the scoped capsule network"
        ensure_capsule_net
    fi
    pf_or_exit --tier "$TIER" --phase all
    envv=("HOME=$HOME_DIR" "PATH=/usr/local/bin:/usr/bin:/bin:/usr/local/games:/usr/games" "USER=${USER:-$(id -un)}" "LANG=${LANG:-C.UTF-8}" "SHELL=${SHELL:-/bin/bash}")
    envv+=("XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-$RUN_USER_ROOT/$UID_NOW}")
    for v in DISPLAY XAUTHORITY DBUS_SESSION_BUS_ADDRESS WAYLAND_DISPLAY; do
        [ -n "${!v:-}" ] && envv+=("$v=${!v}")
    done
    for v in TMPDIR XDG_CONFIG_HOME XDG_DATA_HOME XDG_STATE_HOME XDG_CACHE_HOME; do
        case ${!v:-} in /*) envv+=("$v=${!v}") ;; esac
    done
    dest=${XDG_STATE_HOME:-$HOME_DIR/.local/state}/metaviewer/recordings
    mkdir -p "$dest" && chmod 0700 "$dest" ||
        fail JUDGE_PROFILE "cannot prepare private recording directory $dest" "make XDG_STATE_HOME writable and retry run"
    # A launcher default must not override the person's saved native folder choice.
    envv+=("MV_RECORDING_DEFAULT_DESTINATION=$dest")
    if [ "$TIER" = T2 ]; then
        statedir=${XDG_STATE_HOME:-$HOME_DIR/.local/state}/metaviewer/srf
        ramroot=$SHM/vqa-ramws/opensuperficies/os-cu-0
        mkdir -p "$statedir" "$ramroot" "$STORE" && chmod 0700 "$statedir" "$ramroot" ||
            fail JUDGE_PROFILE "cannot prepare capsule state or RAM directories ($statedir, $ramroot, $STORE)" "check XDG_STATE_HOME, MV_JUDGE_SHM_DIR and SRF_IDENTITY_STORE_ROOT ownership and free space, then retry run"
        if [ -n "${MV_SRF_PROFILES:-}" ]; then
            profiles_json=$MV_SRF_PROFILES
        else
            p2=mv-live-2; [ "$PROFILE_ID" = "$p2" ] && p2=mv-live-1
            p3=mv-live-3; [ "$PROFILE_ID" = "$p3" ] && p3=mv-live-1
            p4=mv-live-4; [ "$PROFILE_ID" = "$p4" ] && p4=mv-live-1
            rjson=$(json_str "$ramroot")
            profiles_json=$(printf '{"%s":{"Kind":"browser","NativeKind":"browser","RAMRoot":"%s","Display":":100","Width":1280,"Height":900,"text_input":"paste"},"%s":{"Kind":"browser","NativeKind":"browser","RAMRoot":"%s","Display":":101","Width":1280,"Height":900,"text_input":"paste"},"%s":{"Kind":"browser","NativeKind":"browser","RAMRoot":"%s","Display":":102","Width":1280,"Height":900,"text_input":"paste"},"%s":{"Kind":"browser","NativeKind":"browser","RAMRoot":"%s","Display":":103","Width":1280,"Height":900,"text_input":"paste"}}' \
                "$(json_str "$PROFILE_ID")" "$rjson" "$p2" "$rjson" "$p3" "$rjson" "$p4" "$rjson")
        fi
        envv+=("MV_SRF_BIN_DIR=$SRF_BIN" "MV_SRF_STATE_DIR=$statedir" "MV_SRF_LIVE_PROFILE=$PROFILE_ID"
            "MV_SRF_LIVE_RAM_ROOT=$ramroot" "MV_SRF_LIVE_TEXT_INPUT=paste" "MV_SRF_PROFILES=$profiles_json"
            "SRF_IDENTITY_STORE_ROOT=$STORE" "SRF_PROXY_REGISTRY=$JUDGE_HOME/network/registry/registry.json")
        if [ -d "$JUDGE_HOME/deps/vision-engine" ]; then
            if [ -x "$JUDGE_HOME/deps/vision-engine/vision-runtime" ]; then
                envv+=("MV_VISION_EXECUTABLE=$JUDGE_HOME/deps/vision-engine/vision-runtime")
            else
                envv+=("VQA_VE_ROOT=$JUDGE_HOME/deps/vision-engine" "MV_VISION_ENGINE_PATH=$JUDGE_HOME/deps/vision-engine")
            fi
        fi
        if [ -d "$JUDGE_HOME/deps/wender-agent" ]; then
            if [ -x "$JUDGE_HOME/deps/wender-agent/wender-runtime" ]; then
                envv+=("MV_WENDER_EXECUTABLE=$JUDGE_HOME/deps/wender-agent/wender-runtime")
            else
                envv+=("MV_WENDER_ROOT=$JUDGE_HOME/deps/wender-agent" "MV_MW_WENDER_ROOT=$JUDGE_HOME/deps/wender-agent")
            fi
        fi
    fi
    mkdir -p "$JUDGE_HOME/run"
    env -i "${envv[@]}" "$APP_BIN" --ozone-platform=x11 9>&- &
    child=$!
    if ! printf '%s\n' "$child" >"$PIDFILE"; then
        # A child without a published PID cannot be recovered by a later stop.
        kill -TERM "$child" 2>/dev/null || true
        local unwind=0
        while kill -0 "$child" 2>/dev/null && [ "$unwind" -lt 10 ]; do
            sleep 0.1
            unwind=$((unwind + 1))
        done
        kill -KILL "$child" 2>/dev/null || true
        wait "$child" 2>/dev/null || true
        fail JUDGE_PIDFILE "cannot publish app pid in $PIDFILE; app child was stopped" "make $JUDGE_HOME/run writable and retry run"
    fi
    trap 'kill -TERM "$child" 2>/dev/null' TERM INT HUP
    rc=0
    # Always collect the child status, including a child reaped before this probe.
    # A trapped signal can interrupt wait while the child is still shutting down.
    while :; do
        wait "$child"
        rc=$?
        kill -0 "$child" 2>/dev/null || break
    done
    remove_owned_pid "$child"
    return "$rc"
}

# ---------------------------------------------------------------------- stop
# Program cleanup requires a private native receipt in
# this launcher's state directory; a name prefix alone never admits a program.
owned_programs() {
    command -v python3 >/dev/null 2>&1 || return 1
    python3 -c '
import json, os, re, stat, sys
from pathlib import Path
root = Path(sys.argv[1])
try:
    meta = root.lstat()
    if not stat.S_ISDIR(meta.st_mode) or meta.st_uid != os.getuid() or stat.S_IMODE(meta.st_mode) != 0o700:
        sys.exit(1)
    names = set()
    for path in root.glob("*.json"):
        meta = path.lstat()
        if not stat.S_ISREG(meta.st_mode) or meta.st_uid != os.getuid() or stat.S_IMODE(meta.st_mode) != 0o600 or meta.st_size > 1048576:
            continue
        try:
            value = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        if not isinstance(value, dict):
            continue
        lease, capsule = value.get("Lease"), value.get("Capsule")
        if not isinstance(lease, dict) or not isinstance(capsule, dict):
            continue
        profile, name = lease.get("ProfileID"), capsule.get("container")
        if isinstance(profile, str) and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", profile) and isinstance(name, str) and re.fullmatch(r"srf-pg-[a-z0-9][a-z0-9-]{0,39}", name):
            names.add(name)
    print("\n".join(sorted(names)))
except OSError:
    sys.exit(1)
' "$1"
}

cmd_stop() {
    local pid waited=0 leaks=0 name f ram adm inventory programs
    local statedir="${MV_SRF_STATE_DIR:-${XDG_STATE_HOME:-$HOME_DIR/.local/state}/metaviewer/srf}"
    # The app removes its opening receipts as it exits: read them before stopping it.
    programs=$(owned_programs "$statedir" 2>/dev/null) || programs=
    pid=$(running_pid)
    if [ -n "$pid" ]; then
        kill -TERM "$pid" 2>/dev/null
        while kill -0 "$pid" 2>/dev/null; do
            if [ "$waited" -ge $((STOP_WAIT * 5)) ]; then # MUT:JUDGE_STOP_TIMEOUT
                fail JUDGE_STOP_TIMEOUT "pid $pid [MEASURED] did not exit within ${STOP_WAIT} s [TARGET] after SIGTERM" "kill -KILL $pid (only if you accept losing unsaved capsule state)"
            fi
            sleep 0.2
            waited=$((waited + 1))
        done
        say "stopped pid $pid"
    else
        say "no running MetaViewer process"
    fi
    remove_owned_pid "$pid"
    # Retain interrupted/unverified smoke ownership records. Stop must never
    # turn missing cleanup proof into a clean verdict or kill guessed PIDs.
    for f in "$JUDGE_HOME/run/smoke-processes"/* "$JUDGE_HOME/run/smoke-tmp"/* "$JUDGE_HOME/run/smoke-roots"/*; do
        [ -e "$f" ] || [ -L "$f" ] || continue
        leaks=$((leaks + 1))
        printf 'JUDGE_STOP_LEAK: smoke ownership/runtime %s remains -- fix: verify its recorded process identity and group have exited before removing this state\n' "$f" >&2
    done
    if [ -x "$SRF_BIN/srf-identity-surface" ] && command -v docker >/dev/null 2>&1 &&
        bounded_docker info >/dev/null 2>&1 &&
        inventory=$(bounded_docker ps -a --filter 'name=^srf-' --format '{{.Names}}' 2>/dev/null); then
        while IFS= read -r name; do
            [ -n "$name" ] || continue
            case $name in
                srf-id-*) ;;
                srf-pg-*) printf '%s\n' "$programs" | grep -qxF -- "$name" || continue ;;
                *) continue ;;
            esac
            "$SRF_BIN/srf-identity-surface" stop --container "$name" --state-dir "$statedir" >/dev/null 2>&1 ||
                note "capsule stop for $name reported a problem; the leak check below is authoritative"
        done <<< "$inventory"
    fi
    if command -v docker >/dev/null 2>&1 && bounded_docker info >/dev/null 2>&1 &&
        inventory=$(bounded_docker ps -a --filter 'name=^srf-' --format '{{.Names}}' 2>/dev/null); then
        while IFS= read -r name; do
            [ -n "$name" ] && [ "$name" != srf-egress-proxy ] || continue
            leaks=$((leaks + 1))
            printf 'JUDGE_STOP_LEAK: container %s is still present -- fix: docker rm -f %s\n' "$name" "$name" >&2
        done <<< "$inventory"
    elif [ -n "$(find "$SHM/vqa-ramws/opensuperficies/os-cu-0" "$statedir" -mindepth 1 -maxdepth 1 2>/dev/null | head -n 1)" ]; then
        # Without native state there is nothing to prove absent: an app-only install has no Docker.
        leaks=$((leaks + 1))
        printf 'JUDGE_STOP_LEAK: Docker inventory unavailable -- fix: restore Docker access, run docker info and retry stop; native absence is unverified\n' >&2
    fi
    for f in "${MV_SRF_STATE_DIR:-${XDG_STATE_HOME:-$HOME_DIR/.local/state}/metaviewer/srf}" "${XDG_RUNTIME_DIR:-$RUN_USER_ROOT/$UID_NOW}/metaviewer"; do
        [ -d "$f" ] || continue
        while IFS= read -r name; do
            [ -n "$name" ] || continue
            leaks=$((leaks + 1))
            printf 'JUDGE_STOP_LEAK: socket %s is still present -- fix: rm -- %q\n' "$name" "$name" >&2
        done < <(find "$f" -maxdepth 3 -name '*.sock' 2>/dev/null)
    done
    # Census only: private package sessions and host/display roots have no
    # reliable absence witness here. Never remove them or foreign resources.
    local temp_root=${TMPDIR:-$JUDGE_HOME/run/unconfigured-private-runtime}
    if [ -z "${TMPDIR:-}" ]; then
        note "private packaged runtime census incomplete: TMPDIR is unset; shared /tmp roots cannot be attributed to this install. Set a dedicated TMPDIR for run and stop to census them."
    fi
    for f in "$temp_root"/mv-pkg-* "$SHM"/mv-host-xpra-* "${MV_DISPLAY_DIR:-$SHM/metaviewer-display-$UID_NOW}"; do
        [ -d "$f" ] && [ ! -L "$f" ] || continue
        # The display publisher retains its empty directory skeleton on close.
        if [ "$f" = "${MV_DISPLAY_DIR:-$SHM/metaviewer-display-$UID_NOW}" ] &&
            [ -z "$(find "$f" -mindepth 1 ! -type d -print -quit 2>/dev/null)" ]; then
            continue
        fi
        leaks=$((leaks + 1))
        printf 'JUDGE_STOP_LEAK: private runtime/RAM root %s is still present -- fix: verify its owning processes have exited before removing it\n' "$f" >&2
        while IFS= read -r name; do
            [ -n "$name" ] || continue
            printf 'JUDGE_STOP_LEAK: private socket %s is still present -- fix: verify its owning processes have exited before removing it\n' "$name" >&2
        done < <(find "$f" -maxdepth 3 -name '*.sock' 2>/dev/null)
    done
    ram=$SHM/vqa-ramws/opensuperficies/os-cu-0
    if [ -d "$ram" ]; then
        # A capsule's RAM directory outlives its container. Only an entry whose container
        # is gone is safe to remove; anything else stays and is reported below.
        if command -v docker >/dev/null 2>&1 && bounded_docker info >/dev/null 2>&1; then
            local live
            if live=$(bounded_docker ps -a --filter 'name=^srf-' --format '{{.Names}}' 2>/dev/null); then
                for f in "$ram"/srf-id-* "$ram"/srf-pg-*; do
                    [ -d "$f" ] && [ ! -L "$f" ] && [ -O "$f" ] || continue
                    case ${f##*/} in
                        srf-pg-*) printf '%s\n' "$programs" | grep -qxF -- "${f##*/}" || continue ;;
                    esac
                    printf '%s\n' "$live" | grep -qxF -- "${f##*/}" || rm -rf -- "$f"
                done
            fi
        fi
        while IFS= read -r name; do
            [ -n "$name" ] || continue
            leaks=$((leaks + 1))
            printf 'JUDGE_STOP_LEAK: RAM entry %s is still present -- fix: restore Docker access if needed, verify native absence and ownership, then retry stop; retain unverifiable entries\n' "$name" >&2
        done < <(find "$ram" -mindepth 1 -maxdepth 1 2>/dev/null)
    fi
    adm=${MV_RAM_ADMISSION_DIR:-${XDG_RUNTIME_DIR:-$RUN_USER_ROOT/$UID_NOW}/metaviewer/ram-admission}
    if [ -d "$adm" ]; then
        while IFS= read -r name; do
            [ -n "$name" ] || continue
            leaks=$((leaks + 1))
            printf 'JUDGE_STOP_LEAK: admission record %s is still present -- fix: MV_RAM_ADMISSION_DIR=%q python3 %q reclaim --dry-run && MV_RAM_ADMISSION_DIR=%q python3 %q reclaim --apply\n' \
                "$name" "$adm" "${MV_JUDGE_RAM_TOOL:-$KIT/tools/mv_ram_admission.py}" \
                "$adm" "${MV_JUDGE_RAM_TOOL:-$KIT/tools/mv_ram_admission.py}" >&2
        done < <(find "$adm" -mindepth 1 -maxdepth 1 2>/dev/null)
    fi
    if [ "$leaks" -gt 0 ]; then # MUT:JUDGE_STOP_LEAK
        printf 'JUDGE_STOP_LEAK: %s leftover item(s) listed above -- fix: remove them as shown, then run stop again\n' "$leaks" >&2
        exit 2
    fi
    say JUDGE_STOP_CLEAN
}

# ------------------------------------------------------------------- dispatch
case $SUB in
    doctor)
        if [ "$BEFORE_INSTALL" = 1 ]; then
            pf_or_exit --tier "$TIER" --phase static
            say "JUDGE_DOCTOR_OK tier=$TIER phase=before-install (installed runtime not checked)"
        else
            pf_or_exit --tier "$TIER" --phase all
            say "JUDGE_DOCTOR_OK tier=$TIER"
        fi
        ;;
    install) cmd_install ;;
    run) cmd_run ;;
    stop) cmd_stop ;;
esac

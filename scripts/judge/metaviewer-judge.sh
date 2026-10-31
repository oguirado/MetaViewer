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
# [TARGET, unit decision] Missing handoffs are implemented here, minimally:
#   - Kit layout: <kit>/judge/{metaviewer-judge.sh,preflight.sh,apparmor/},
#     <kit>/assets/{SHA256SUMS,...}, <kit>/ui/tools/package.js and
#     <kit>/tools/mv_ram_admission.py (the checkout layout also works).
#   - Release assets (names fixed here, to be published by the release step):
#     metaviewer-linux-<x64|arm64>.tar.gz (holds MetaViewer-linux-<arch>/ and
#     MetaViewer-linux-<arch>.sha256), node-linux-<arch>.tar.xz, and for T2
#     opensuperficies-linux-<arch>.tar.gz (opensuperficies/{bin,firewall}),
#     images-linux-<arch>.tar (docker save), vision-engine.tar.gz and
#     wender-agent.tar.gz (one top-level directory named after the component).
#   - SHA256SUMS must ship inside the kit; it is never downloaded.
#   - State lives under MV_JUDGE_HOME (default $XDG_DATA_HOME/metaviewer-judge):
#     app/, deps/, node/, run/, logs/ and judge_receipt.json. No timestamp, pid
#     or host path is written to the receipt.
#   - Network by default is open: install installs the egress firewall in ONE
#     confirmed administrator step; if it is declined or unavailable, install
#     falls back to the legacy network (`net up`, no administrator rights).
#   - `stop` also runs `net down`, so no srf-* container is left behind.
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
    printf 'JUDGE_USAGE: metaviewer-judge.sh doctor|install|run|stop [--capsules] [--yes] [--no-firewall] -- fix: use one of the documented subcommands\n' >&2
    exit 64
}

HOME_DIR=${HOME:-}
[ -n "$HOME_DIR" ] || { printf 'JUDGE_USAGE: HOME is not set -- fix: run from a normal login session\n' >&2; exit 64; }
SUB=${1:-}
[ $# -gt 0 ] && shift
ASSUME_YES=0
CAPSULES=0
NO_FIREWALL=0
while [ $# -gt 0 ]; do
    case $1 in
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
    '' | / | "$HOME_DIR" | "$HOME_DIR"/) fail JUDGE_USAGE "MV_JUDGE_HOME '$JUDGE_HOME' would be the whole home or root" "unset MV_JUDGE_HOME or point it at a dedicated directory" ;;
    /*) ;;
    *) fail JUDGE_USAGE "MV_JUDGE_HOME must be an absolute path" "export MV_JUDGE_HOME=/absolute/path" ;;
esac
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
    local n missing="" tmp
    mkdir -p "$ASSET_DIR" 2>/dev/null || fail JUDGE_ASSET "cannot create $ASSET_DIR" "choose a writable MV_JUDGE_ASSET_DIR"
    [ -f "$ASSET_DIR/SHA256SUMS" ] || fail JUDGE_ASSET "SHA256SUMS is missing from $ASSET_DIR" "extract the judge kit again; SHA256SUMS ships inside it and is never downloaded"
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
            if curl --fail --location --proto '=https' --tlsv1.2 --silent --show-error --output "$tmp" "$RELEASE_BASE/$n"; then
                mv -f -- "$tmp" "$ASSET_DIR/$n"
                DOWNLOADED="$DOWNLOADED $n"
            else
                rm -f -- "$tmp"
                fail JUDGE_ASSET "download of $n failed" "check the network and the release URL $RELEASE_BASE/$n"
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
        *) fail JUDGE_SYSDEP "apt-get failed (rc $rc) for: $pkgs" "sudo apt-get install -y $pkgs" ;;
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
    # Only the node binary is taken from the archive; links and other members are not extracted.
    tar --no-same-owner -xf "$ASSET_DIR/$asset" -C "$work" --strip-components=1 --wildcards '*/bin/node' || fail JUDGE_ASSET "cannot unpack node from $asset" "download $asset again from $RELEASE_BASE"
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
    [ -d "$APP_ROOT" ] && mv -- "$APP_ROOT" "$JUDGE_HOME/app.old"
    mv -- "$work" "$APP_ROOT"
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

step_verify_smoke() {
    local log=$JUDGE_HOME/logs/smoke.log rc
    mkdir -p "$JUDGE_HOME/logs"
    if [ ! -f "$PKG_TOOL" ]; then
        fail JUDGE_SMOKE "the package verification tool is missing from the kit ($PKG_TOOL)" "extract the full judge kit again"
    fi
    if "$NODE_BIN" "$PKG_TOOL" --verify-install "$APP_DIR" >"$log" 2>&1; then
        :
    else
        fail JUDGE_SMOKE "package verification failed: $(tail -n 3 "$log" | tr '\n' ' ')" "download the release tarball again and re-run install"
    fi
    if timeout 600 "$NODE_BIN" "$PKG_TOOL" --smoke "$ASSET_DIR/metaviewer-linux-$ARCHN.tar.gz" >>"$log" 2>&1; then # MUT:JUDGE_SMOKE
        say METAVIEWER_MAIN_SMOKE_OK
    else
        rc=$?
        fail JUDGE_SMOKE "the install smoke failed (rc $rc): $(tail -n 3 "$log" | tr '\n' ' ')" "see $log; check DISPLAY/xvfb-run and the AppArmor profile, then re-run install"
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
    local asset=images-linux-$ARCHN.tar img missing=0 idver=0.1.0
    [ "$(net_mode_now)" = open ] && idver=0.2.0
    for img in "opensuperficies-identity-browser-$ARCHN:$idver" "opensuperficies-desktop-$ARCHN:1.1.0"; do
        docker image inspect "$img" >/dev/null 2>&1 || missing=1
    done
    [ "$missing" = 1 ] || return 0
    ensure_assets "$asset"
    docker load -i "$ASSET_DIR/$asset" >/dev/null || fail JUDGE_IMAGE "docker load of $asset failed" "check 'docker info' and free disk space, then re-run install --capsules"
}

step_profile() {
    local p="$STORE/profiles/$PROFILE_ID" st
    mkdir -p "$STORE/profiles" && chmod 0700 "$STORE" "$STORE/profiles" || fail JUDGE_PROFILE "cannot create $STORE/profiles" "choose a writable SRF_IDENTITY_STORE_ROOT"
    st=$(stat -c '%a %u' -- "$p" 2>/dev/null || printf '')
    [ "$st" = "700 10001" ] && return 0
    need_sudo_step "create the capsule profile directory owned by uid 10001 (the capsule runs as that uid)" \
        install -d -m 0700 -o 10001 -g 10001 "$p"
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

ensure_capsule_net() { # scoped Docker bridge + proxy when open firewall is absent; needs docker group only
    [ -x "$SRF_BIN/srf-identity-surface" ] && "$SRF_BIN/srf-identity-surface" capabilities >/dev/null 2>&1 || true
    command -v docker >/dev/null 2>&1 || return 0
    docker network inspect srf-idnet >/dev/null 2>&1 ||
        docker network create --internal --subnet 172.30.80.0/24 srf-idnet >/dev/null 2>&1 ||
        note "docker network create srf-idnet failed; JUDGE_NET will say what is missing"
    if [ "$(docker inspect --format '{{.State.Running}}' srf-egress-proxy 2>/dev/null || printf '')" != true ]; then
        docker start srf-egress-proxy >/dev/null 2>&1 ||
            docker run -d --name srf-egress-proxy --network srf-idnet "opensuperficies-desktop-$ARCHN:1.1.0" >/dev/null 2>&1 ||
            note "starting srf-egress-proxy failed; JUDGE_NET will say what is missing"
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
    if [ "$TIER" = T2 ]; then docker_ver=$(docker version --format '{{.Server.Version}}' 2>/dev/null || printf ''); fi
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
    local assets_used
    [ -z "$(running_pid)" ] || fail JUDGE_RUNNING "MetaViewer is running" "bash $0 stop"
    mkdir -p "$JUDGE_HOME" && chmod 0700 "$JUDGE_HOME" || fail JUDGE_ASSET "cannot create $JUDGE_HOME" "set MV_JUDGE_HOME to a writable directory"
    pf_or_exit --tier "$TIER" --phase static
    step_sysdeps
    step_node
    step_extract_app
    assets_used="metaviewer-linux-$ARCHN.tar.gz"
    step_apparmor
    step_verify_smoke
    if [ "$TIER" = T2 ]; then
        extract_dep "opensuperficies-linux-$ARCHN.tar.gz" opensuperficies
        extract_dep vision-engine.tar.gz vision-engine
        extract_dep wender-agent.tar.gz wender-agent
        assets_used="$assets_used opensuperficies-linux-$ARCHN.tar.gz vision-engine.tar.gz wender-agent.tar.gz images-linux-$ARCHN.tar"
        step_profile
        step_firewall || true
        step_images
        [ "$(net_mode_now)" = open ] || ensure_capsule_net
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
    local pid tier v rc child dest statedir ramroot
    local -a envv
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
        say "ensuring the scoped capsule network"
        ensure_capsule_net
    fi
    pf_or_exit --tier "$TIER" --phase all
    envv=("HOME=$HOME_DIR" "PATH=/usr/local/bin:/usr/bin:/bin" "USER=${USER:-$(id -un)}" "LANG=${LANG:-C.UTF-8}")
    envv+=("XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-$RUN_USER_ROOT/$UID_NOW}")
    for v in DISPLAY XAUTHORITY DBUS_SESSION_BUS_ADDRESS WAYLAND_DISPLAY; do
        [ -n "${!v:-}" ] && envv+=("$v=${!v}")
    done
    for v in TMPDIR XDG_CONFIG_HOME XDG_DATA_HOME XDG_STATE_HOME XDG_CACHE_HOME; do
        case ${!v:-} in /*) envv+=("$v=${!v}") ;; esac
    done
    dest=${XDG_STATE_HOME:-$HOME_DIR/.local/state}/metaviewer/recordings
    mkdir -p "$dest" && chmod 0700 "$dest"
    envv+=("MV_RECORDING_DESTINATION=$dest")
    if [ "$TIER" = T2 ]; then
        statedir=${XDG_STATE_HOME:-$HOME_DIR/.local/state}/metaviewer/srf
        ramroot=$SHM/vqa-ramws/opensuperficies/os-cu-0
        mkdir -p "$statedir" "$ramroot" && chmod 0700 "$statedir" "$ramroot"
        envv+=("MV_SRF_BIN_DIR=$SRF_BIN" "MV_SRF_STATE_DIR=$statedir" "MV_SRF_LIVE_PROFILE=$PROFILE_ID"
            "MV_SRF_LIVE_RAM_ROOT=$ramroot" "MV_SRF_LIVE_TEXT_INPUT=paste" "SRF_IDENTITY_STORE_ROOT=$STORE")
        [ -n "${SRF_PROXY_REGISTRY:-}" ] && envv+=("SRF_PROXY_REGISTRY=$SRF_PROXY_REGISTRY")
        [ -d "$JUDGE_HOME/deps/vision-engine" ] && envv+=("VQA_VE_ROOT=$JUDGE_HOME/deps/vision-engine")
        [ -d "$JUDGE_HOME/deps/wender-agent" ] && envv+=("MV_WENDER_ROOT=$JUDGE_HOME/deps/wender-agent")
    fi
    mkdir -p "$JUDGE_HOME/run"
    env -i "${envv[@]}" "$APP_BIN" --ozone-platform=x11 &
    child=$!
    printf '%s\n' "$child" >"$PIDFILE"
    trap 'kill -TERM "$child" 2>/dev/null' TERM INT HUP
    rc=0
    while kill -0 "$child" 2>/dev/null; do
        wait "$child"
        rc=$?
    done
    rm -f -- "$PIDFILE"
    return "$rc"
}

# ---------------------------------------------------------------------- stop
cmd_stop() {
    local pid waited=0 leaks=0 name f ram adm
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
    rm -f -- "$PIDFILE"
    local statedir="${MV_SRF_STATE_DIR:-${XDG_STATE_HOME:-$HOME_DIR/.local/state}/metaviewer/srf}"
    if [ -x "$SRF_BIN/srf-identity-surface" ] && command -v docker >/dev/null 2>&1; then
        while IFS= read -r name; do
            [ -n "$name" ] || continue
            "$SRF_BIN/srf-identity-surface" stop --container "$name" --state-dir "$statedir" >/dev/null 2>&1 ||
                note "capsule stop for $name reported a problem; the leak check below is authoritative"
        done < <(docker ps -a --filter 'name=^srf-id-' --format '{{.Names}}' 2>/dev/null)
    fi
    if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
        while IFS= read -r name; do
            [ -n "$name" ] && [ "$name" != srf-egress-proxy ] || continue
            leaks=$((leaks + 1))
            printf 'JUDGE_STOP_LEAK: container %s is still present -- fix: docker rm -f %s\n' "$name" "$name" >&2
        done < <(docker ps -a --filter 'name=^srf-' --format '{{.Names}}' 2>/dev/null)
    fi
    for f in "${MV_SRF_STATE_DIR:-${XDG_STATE_HOME:-$HOME_DIR/.local/state}/metaviewer/srf}" "${XDG_RUNTIME_DIR:-$RUN_USER_ROOT/$UID_NOW}/metaviewer"; do
        [ -d "$f" ] || continue
        while IFS= read -r name; do
            [ -n "$name" ] || continue
            leaks=$((leaks + 1))
            printf 'JUDGE_STOP_LEAK: socket %s is still present -- fix: rm -- %q\n' "$name" "$name" >&2
        done < <(find "$f" -maxdepth 3 -name '*.sock' 2>/dev/null)
    done
    ram=$SHM/vqa-ramws/opensuperficies/os-cu-0
    if [ -d "$ram" ]; then
        while IFS= read -r name; do
            [ -n "$name" ] || continue
            leaks=$((leaks + 1))
            printf 'JUDGE_STOP_LEAK: RAM entry %s is still present -- fix: rm -rf -- %q\n' "$name" "$name" >&2
        done < <(find "$ram" -mindepth 1 -maxdepth 1 2>/dev/null)
    fi
    adm=${MV_RAM_ADMISSION_DIR:-${XDG_RUNTIME_DIR:-$RUN_USER_ROOT/$UID_NOW}/metaviewer/ram-admission}
    if [ -d "$adm" ]; then
        while IFS= read -r name; do
            [ -n "$name" ] || continue
            leaks=$((leaks + 1))
            printf 'JUDGE_STOP_LEAK: admission record %s is still present -- fix: python3 tools/mv_ram_admission.py reclaim --dry-run\n' "$name" >&2
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
        pf_or_exit --tier "$TIER" --phase all
        say "JUDGE_DOCTOR_OK tier=$TIER"
        ;;
    install) cmd_install ;;
    run) cmd_run ;;
    stop) cmd_stop ;;
esac

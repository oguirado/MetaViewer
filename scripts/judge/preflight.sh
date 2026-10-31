#!/usr/bin/env bash
# MetaViewer judge preflight: read-only host checks with typed refusals.
#
# Usage: preflight.sh [--tier T0|T1|T2] [--phase static|all]
#        preflight.sh --facts [--tier T]            (key=value host facts)
#        preflight.sh --sysdep-packages [--tier T]  (missing apt packages, one line)
#
# Every refusal prints `JUDGE_<CODE>: <problem> -- fix: <command>` on stderr
# and the run exits 2. Warnings (JUDGE_OS) never change the exit code. Nothing
# is installed, written or escalated here; sudo is never called.
#
# [TARGET, unit decision] This unit implements the table of
# STRATEGY_JUDGE_PORTABILITY section 2.2. Missing handoffs are filled here:
#   - Tiers: T0 fixture, T1 packaged app, T2 app plus one browser capsule.
#   - Phase `static` runs the checks the installer cannot fix (host facts);
#     phase `all` also checks what install provides (bundle, tools, images).
#   - Test seams (all optional, default to the real host): MV_JUDGE_PROC,
#     MV_JUDGE_OS_RELEASE, MV_JUDGE_SHM_DIR, MV_JUDGE_CPUSET_FILE,
#     MV_JUDGE_RUN_USER_ROOT, MV_JUDGE_APPARMOR_DIR, MV_JUDGE_FW_WITNESS.
#   - JUDGE_REQUIRE_CPUSET defaults to 10-14 until the cpuset fix lands in
#     OpenSuperficies (H01); MV_JUDGE_REQUIRE_CPUSET=none removes the check.
#   - Thresholds marked [TARGET] come from the strategy table, not from a
#     measurement on a small machine.
# Lines marked `# MUT:<code>` are the deciding predicates that the offline
# mutation tests negate.
set -u
set -o pipefail

SELF_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P) || exit 64

usage() {
    printf 'JUDGE_USAGE: preflight.sh [--tier T0|T1|T2] [--phase static|all] [--facts|--sysdep-packages] -- fix: use one of the documented options\n' >&2
    exit 64
}

tier_valid() { case $1 in T0 | T1 | T2) return 0 ;; esac; return 1; }
phase_valid() { case $1 in static | all) return 0 ;; esac; return 1; }

TIER=T1
PHASE=all
MODE=check
while [ $# -gt 0 ]; do
    case $1 in
        --tier) [ $# -ge 2 ] || usage; TIER=$2; shift 2 ;;
        --phase) [ $# -ge 2 ] || usage; PHASE=$2; shift 2 ;;
        --facts) MODE=facts; shift ;;
        --sysdep-packages) MODE=sysdep; shift ;;
        *) usage ;;
    esac
done
if tier_valid "$TIER"; then :; else usage; fi # MUT:JUDGE_USAGE
phase_valid "$PHASE" || usage

# ---------------------------------------------------------------- environment
HOME_DIR=${HOME:-}
if [ -z "$HOME_DIR" ]; then
    printf 'JUDGE_USAGE: HOME is not set -- fix: run from a normal login session\n' >&2
    exit 64
fi
PROC=${MV_JUDGE_PROC:-/proc}
OSREL=${MV_JUDGE_OS_RELEASE:-/etc/os-release}
SHM=${MV_JUDGE_SHM_DIR:-/dev/shm}
CPUSET_FILE=${MV_JUDGE_CPUSET_FILE:-/sys/fs/cgroup/cpuset.cpus.effective}
RUN_USER_ROOT=${MV_JUDGE_RUN_USER_ROOT:-/run/user}
APPARMOR_DIR=${MV_JUDGE_APPARMOR_DIR:-/etc/apparmor.d}
WITNESS=${MV_JUDGE_FW_WITNESS:-/run/srf-open-egress/rules.sha256}
REQUIRE_CPUSET=${MV_JUDGE_REQUIRE_CPUSET:-10-14}
JUDGE_HOME=${MV_JUDGE_HOME:-${XDG_DATA_HOME:-$HOME_DIR/.local/share}/metaviewer-judge}
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
PROFILE_SRC=$SELF_DIR/apparmor/metaviewer
RAM_TOOL=${MV_JUDGE_RAM_TOOL:-$KIT/tools/mv_ram_admission.py}
UID_NOW=$(id -u 2>/dev/null || printf '')
MACHINE=$(uname -m 2>/dev/null || printf '')
case $MACHINE in
    x86_64) ARCHN=x64; ELF_WANT=62 ;;
    aarch64) ARCHN=arm64; ELF_WANT=183 ;;
    *) ARCHN=; ELF_WANT= ;;
esac
APP_DIR=$JUDGE_HOME/app/MetaViewer-linux-${ARCHN:-unknown}
NODE_BIN=
if [ -x "$JUDGE_HOME/node/bin/node" ]; then
    NODE_BIN=$JUDGE_HOME/node/bin/node
else
    NODE_BIN=$(command -v node 2>/dev/null || printf '')
fi

# ------------------------------------------------------------------- helpers
FAILS=0
refuse() { FAILS=$((FAILS + 1)); printf '%s: %s -- fix: %s\n' "$1" "$2" "$3" >&2; }
warn() { printf '%s: warning: %s\n' "$1" "$2" >&2; }
note() { printf 'JUDGE_NOTE: %s\n' "$1" >&2; }

is_num() { case ${1:-} in '' | *[!0-9]*) return 1 ;; esac; return 0; }
meminfo() { awk -v k="$1:" '$1 == k { print $2; exit }' "$PROC/meminfo" 2>/dev/null; }
mib() { printf '%s' $(($1 / 1048576)); }
kib_mib() { printf '%s' $(($1 / 1024)); }

df_avail() { # bytes available at a path; walks up to the first path df accepts
    local p=$1 out
    while [ -n "$p" ]; do
        out=$(df --output=avail -B1 "$p" 2>/dev/null | tail -n 1 | tr -d ' ')
        if is_num "$out"; then printf '%s' "$out"; return 0; fi
        [ "$p" = / ] && break
        p=$(dirname -- "$p")
    done
    return 1
}

ip2int() { local IFS=.; set -- $1; printf '%s' $(((${1:-0} << 24) + (${2:-0} << 16) + (${3:-0} << 8) + ${4:-0})); }
cidr_overlap() { # a.b.c.d/p e.f.g.h/q
    local a=${1%/*} p=${1#*/} b=${2%/*} q=${2#*/} m mask
    [ "$1" = "$a" ] && p=32
    [ "$2" = "$b" ] && q=32
    m=$p
    [ "$q" -lt "$m" ] && m=$q
    mask=$(((0xFFFFFFFF << (32 - m)) & 0xFFFFFFFF))
    [ $(($(ip2int "$a") & mask)) -eq $(($(ip2int "$b") & mask)) ]
}

elf_machine() { # prints e_machine of an ELF file, empty for anything else
    local f=$1 magic b
    [ -f "$f" ] || return 0
    magic=$(od -An -tx1 -N4 -- "$f" 2>/dev/null | tr -d ' \n')
    [ "$magic" = 7f454c46 ] || return 0
    b=$(od -An -tu1 -j18 -N2 -- "$f" 2>/dev/null)
    set -- $b
    printf '%s' $((${1:-0} + 256 * ${2:-0}))
}

srf_net_modes() { # net_modes token of `capabilities` (second line), comma list
    local bin=$SRF_BIN/srf-identity-surface line w
    [ -x "$bin" ] || return 0
    line=$(timeout 5 "$bin" capabilities 2>/dev/null | sed -n 2p)
    for w in $line; do
        case $w in net_modes=*) printf '%s' "${w#net_modes=}"; return 0 ;; esac
    done
}

open_ready() { # firewall witness present and the binary advertises open
    [ -s "$WITNESS" ] || return 1
    case ,$(srf_net_modes), in *,open,*) return 0 ;; esac
    return 1
}

# -------------------------------------------------------------------- checks
chk_os() {
    local id ver
    id=$(sed -n 's/^ID=//p' "$OSREL" 2>/dev/null | head -n 1 | tr -d '"')
    ver=$(sed -n 's/^VERSION_ID=//p' "$OSREL" 2>/dev/null | head -n 1 | tr -d '"')
    if [ "$id" != ubuntu ] || [ "$ver" != 24.04 ]; then # MUT:JUDGE_OS
        warn JUDGE_OS "this host is '${id:-unknown} ${ver:-unknown}', not Ubuntu 24.04; the kit is only verified on Ubuntu 24.04"
    fi
}

chk_arch() {
    if [ -z "$ARCHN" ]; then # MUT:JUDGE_ARCH
        refuse JUDGE_ARCH "unsupported machine '${MACHINE:-unknown}'" "use Linux x86_64 or aarch64 (64-bit Linux x64/arm64 only)"
    fi
}

chk_node() {
    local v major
    if [ -z "$NODE_BIN" ]; then
        refuse JUDGE_NODE "node is not installed" "bash scripts/judge/metaviewer-judge.sh install (installs Node 24 from the kit after confirmation)"
        return
    fi
    v=$("$NODE_BIN" --version 2>/dev/null || printf '')
    major=${v#v}
    major=${major%%.*}
    if is_num "$major" && [ "$major" -ge 24 ]; then : # MUT:JUDGE_NODE
    else
        refuse JUDGE_NODE "node is '${v:-unreadable}', major 24 or newer is required [CITED]" "bash scripts/judge/metaviewer-judge.sh install (installs Node 24 from the kit after confirmation)"
    fi
}

chk_bundle_arch() {
    local f m bad=0 other
    [ -n "$ARCHN" ] || return 0
    if [ "$ARCHN" = x64 ]; then other=arm64; else other=x64; fi
    # A kit that holds only the other architecture's tarball cannot install here.
    if [ -f "$ASSET_DIR/metaviewer-linux-$other.tar.gz" ] && [ ! -f "$ASSET_DIR/metaviewer-linux-$ARCHN.tar.gz" ]; then # MUT:JUDGE_BUNDLE_ARCH
        refuse JUDGE_BUNDLE_ARCH "the kit holds metaviewer-linux-$other.tar.gz but this host is $ARCHN" "download metaviewer-linux-$ARCHN.tar.gz from the release and place it in $ASSET_DIR"
        return
    fi
    for f in "$APP_DIR/metaviewer" "$APP_DIR"/resources/bin/* "$SRF_BIN"/*; do
        [ -f "$f" ] || continue
        m=$(elf_machine "$f")
        [ -n "$m" ] || continue
        if [ "$m" != "$ELF_WANT" ]; then bad=$((bad + 1)); note "ELF machine $m [MEASURED] in $f, expected $ELF_WANT [CITED]"; fi
    done
    if [ "$bad" -gt 0 ]; then # MUT:JUDGE_BUNDLE_ARCH
        refuse JUDGE_BUNDLE_ARCH "$bad binaries do not match the $ARCHN host (ELF machine $ELF_WANT [CITED])" "download the tarball for $ARCHN and run: bash scripts/judge/metaviewer-judge.sh install"
    fi
}

SYSDEP_BASE="Xvfb:xvfb xdpyinfo:x11-utils xauth:xauth tar:tar zip:zip strace:strace git:git sha256sum:coreutils python3:python3 pip3:python3-pip"
missing_packages() {
    local pair tool pkg list="" want=$SYSDEP_BASE
    [ "$TIER" = T2 ] && want="$want docker:docker.io"
    for pair in $want; do
        tool=${pair%%:*}
        pkg=${pair#*:}
        command -v "$tool" >/dev/null 2>&1 && continue
        case " $list " in *" $pkg "*) ;; *) list="$list $pkg" ;; esac
    done
    printf '%s' "${list# }"
}

chk_sysdep() {
    local pkgs
    pkgs=$(missing_packages)
    if [ -n "$pkgs" ]; then # MUT:JUDGE_SYSDEP
        refuse JUDGE_SYSDEP "missing system tools (packages: $pkgs)" "sudo apt-get install -y $pkgs"
    fi
}

chk_userns() {
    local v
    v=$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null) || v=0
    if [ "$v" = 1 ] && ! cmp -s "$PROFILE_SRC" "$APPARMOR_DIR/metaviewer-judge" 2>/dev/null; then # MUT:JUDGE_USERNS
        refuse JUDGE_USERNS "kernel.apparmor_restrict_unprivileged_userns=1 and the metaviewer AppArmor profile is not loaded" "bash scripts/judge/metaviewer-judge.sh install (loads the profile after confirmation; never --no-sandbox)"
    fi
}

chk_display() {
    command -v xdpyinfo >/dev/null 2>&1 || return 0
    if [ -z "${DISPLAY:-}" ]; then # MUT:JUDGE_DISPLAY
        if [ -n "${WAYLAND_DISPLAY:-}" ]; then
            refuse JUDGE_DISPLAY "Wayland-only session: DISPLAY is empty so there is no XWayland" "enable XWayland (WSLg provides it) or run under xvfb-run"
        else
            refuse JUDGE_DISPLAY "DISPLAY is not set" "log in to a desktop session, enable XWayland/WSLg or run under xvfb-run"
        fi
    elif ! xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
        refuse JUDGE_DISPLAY "the X server at DISPLAY=$DISPLAY is not reachable" "log in to a desktop session, enable XWayland/WSLg or run under xvfb-run"
    fi
}

chk_xdg() {
    local d="$RUN_USER_ROOT/$UID_NOW" owner=
    [ -d "$d" ] && owner=$(stat -c %u -- "$d" 2>/dev/null)
    if [ -z "$UID_NOW" ] || [ "$owner" != "$UID_NOW" ]; then # MUT:JUDGE_XDG_RUNTIME
        refuse JUDGE_XDG_RUNTIME "$d does not exist or is not owned by you" "use a desktop session (logind); on WSL2 set systemd=true under [boot] in /etc/wsl.conf, then run wsl --shutdown"
    fi
}

chk_shm() {
    local fst avail need=536870912
    [ "$TIER" = T2 ] && need=$((536870912 + 2147483648))
    fst=$(df --output=fstype "$SHM" 2>/dev/null | tail -n 1 | tr -d ' ')
    avail=$(df --output=avail -B1 "$SHM" 2>/dev/null | tail -n 1 | tr -d ' ')
    if [ "$fst" != tmpfs ]; then # MUT:JUDGE_SHM
        refuse JUDGE_SHM "$SHM is '${fst:-unreadable}', a tmpfs is required" "mount a tmpfs on $SHM (WSL2: check .wslconfig)"
    elif ! is_num "$avail" || [ "$avail" -lt "$need" ]; then # MUT:JUDGE_SHM
        refuse JUDGE_SHM "$SHM has $(($(is_num "$avail" && echo "$avail" || echo 0) / 1048576)) MiB [MEASURED] free, $(($need / 1048576)) MiB [CITED] needed" "free shared memory or remount: sudo mount -o remount,size=4g $SHM"
    fi
}

chk_ram() {
    local total avail floor need
    total=$(meminfo MemTotal)
    avail=$(meminfo MemAvailable)
    if ! is_num "$total" || ! is_num "$avail"; then
        refuse JUDGE_RAM "cannot read MemTotal and MemAvailable from $PROC/meminfo" "mount /proc and re-run"
        return
    fi
    floor=$((total / 4))
    [ "$floor" -gt 20971520 ] && floor=20971520
    need=$((floor + 4194304))
    if [ "$avail" -lt "$need" ]; then # MUT:JUDGE_RAM
        refuse JUDGE_RAM "MemAvailable is $(kib_mib "$avail") MiB [MEASURED], one capsule needs $(kib_mib "$need") MiB [TARGET]" "close applications, add RAM, or (WSL2) raise memory= in .wslconfig"
    fi
}

expand_cpus() { # "0-3,8" -> one cpu per line
    local part lo hi i
    local IFS=,
    for part in $1; do
        case $part in
            *-*) lo=${part%-*}; hi=${part#*-}; for ((i = lo; i <= hi; i++)); do printf '%s\n' "$i"; done ;;
            *) printf '%s\n' "$part" ;;
        esac
    done
}

chk_cpuset() {
    local eff want missing="" c
    declare -A have=()
    [ "$REQUIRE_CPUSET" = none ] && return 0
    case $REQUIRE_CPUSET in *[!0-9,-]* | '') return 0 ;; esac
    if [ -r "$CPUSET_FILE" ]; then
        eff=$(tr -d ' \n' <"$CPUSET_FILE")
    else
        eff="0-$(($(nproc --all 2>/dev/null || echo 1) - 1))"
    fi
    case $eff in *[!0-9,-]* | '') eff=0 ;; esac
    for c in $(expand_cpus "$eff"); do have[$c]=1; done
    for c in $(expand_cpus "$REQUIRE_CPUSET"); do [ -n "${have[$c]:-}" ] || missing="$missing $c"; done
    if [ -n "$missing" ]; then # MUT:JUDGE_CPUSET
        refuse JUDGE_CPUSET "the capsule is pinned to CPUs $REQUIRE_CPUSET [CITED] but cpus $(printf '%s' "${missing# }" | tr ' ' ',') are not usable (effective: $eff [MEASURED])" "run on a host with at least 15 logical CPUs (this check disappears once OpenSuperficies stops pinning CPUs)"
    fi
}

DOCKER_OK=0
DOCKER_ROOT=
DOCKER_INFO=
chk_docker_host() {
    if [ -n "${DOCKER_HOST:-}" ] || [ -n "${DOCKER_CONTEXT:-}" ]; then # MUT:JUDGE_DOCKER_HOST
        refuse JUDGE_DOCKER_HOST "DOCKER_HOST or DOCKER_CONTEXT is set; the adapter does not forward it" "unset DOCKER_HOST DOCKER_CONTEXT (rootless and remote engines are not supported)"
        return 1
    fi
}

chk_docker() {
    local ctx
    command -v docker >/dev/null 2>&1 || return 0 # JUDGE_SYSDEP reports it
    if DOCKER_INFO=$(docker info --format '{{.SecurityOptions}}|{{.OperatingSystem}}|{{.DockerRootDir}}' 2>/dev/null); then : # MUT:JUDGE_DOCKER
    else
        refuse JUDGE_DOCKER "'docker info' fails for this user" "sudo usermod -aG docker \$USER, then log out and in again (rootful Docker only)"
        return
    fi
    DOCKER_ROOT=${DOCKER_INFO##*|}
    case ${DOCKER_INFO%%|*} in
        *rootless*)
            refuse JUDGE_DOCKER "the engine is rootless, which is not supported (capsule profile uid 10001)" "install the rootful docker.io engine and stop the rootless one: systemctl --user disable --now docker"
            return
            ;;
    esac
    ctx=$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null || printf '')
    case $ctx in
        '' | unix://*) ;;
        *) refuse JUDGE_DOCKER "the active Docker endpoint '$ctx' is not a local unix socket" "docker context use default"; return ;;
    esac
    DOCKER_OK=1
}

chk_docker_desktop() {
    local os
    [ "$DOCKER_OK" = 1 ] || return 0
    os=${DOCKER_INFO#*|}
    os=${os%%|*}
    if [[ $os == *"Docker Desktop"* ]]; then # MUT:JUDGE_DOCKER_DESKTOP
        refuse JUDGE_DOCKER_DESKTOP "the engine is Docker Desktop, which cannot bind /dev/shm and profile paths" "install docker-ce inside this distro and stop Docker Desktop integration"
        DOCKER_OK=0
    fi
}

chk_image() {
    local img
    [ "$DOCKER_OK" = 1 ] || return 0
    [ -n "$ARCHN" ] || return 0
    local idver=0.1.0
    open_ready && idver=0.2.0
    for img in "opensuperficies-identity-browser-$ARCHN:$idver" "opensuperficies-desktop-$ARCHN:1.1.0"; do
        if docker image inspect "$img" >/dev/null 2>&1; then : # MUT:JUDGE_IMAGE
        else
            refuse JUDGE_IMAGE "image $img is not present" "bash scripts/judge/metaviewer-judge.sh install --capsules (loads the images from the kit)"
        fi
    done
}

chk_net() {
    local line dest dev range bad="" net proxy
    # Overlap with host routes (LAN, VPN, WSL NAT) applies to both network modes.
    if command -v ip >/dev/null 2>&1; then
        while IFS= read -r line; do
            set -- $line
            dest=${1:-}
            case $dest in default | '' | *[!0-9./]*) continue ;; esac
            dev=
            while [ $# -gt 0 ]; do [ "$1" = dev ] && dev=${2:-}; shift; done
            case $dev in br-* | docker* | srfo*) continue ;; esac
            for range in 172.30.80.0/24 172.29.0.0/16; do
                if cidr_overlap "$dest" "$range"; then bad="$bad $dest(dev ${dev:-?})~$range"; fi # MUT:JUDGE_NET
            done
        done < <(ip route 2>/dev/null)
    fi
    if [ -n "$bad" ]; then
        refuse JUDGE_NET "host routes overlap the reserved capsule networks:${bad}" "remove or renumber the conflicting route/VPN/LAN range (capsule ranges: 172.30.80.0/24 and 172.29.0.0/16 [CITED])"
    fi
    [ "$PHASE" = all ] || return 0
    [ "$DOCKER_OK" = 1 ] || return 0
    open_ready && return 0
    # Legacy network: srf-idnet internal on 172.30.80.0/24 plus the running proxy.
    net=$(docker network inspect srf-idnet --format '{{.Internal}} {{range .IPAM.Config}}{{.Subnet}} {{end}}' 2>/dev/null || printf '')
    proxy=$(docker inspect --format '{{.State.Running}}' srf-egress-proxy 2>/dev/null || printf '')
    if [ "$net" != "true 172.30.80.0/24 " ] || [ "$proxy" != true ]; then # MUT:JUDGE_NET
        refuse JUDGE_NET "legacy network srf-idnet or the srf-egress-proxy container is not ready" "bash scripts/judge/metaviewer-judge.sh install --capsules (ensures the scoped capsule network)"
    fi
}

chk_profile() {
    local p="$STORE/profiles/$PROFILE_ID" st
    st=$(stat -c '%a %u' -- "$p" 2>/dev/null || printf '')
    if [ "$st" != "700 10001" ]; then # MUT:JUDGE_PROFILE
        refuse JUDGE_PROFILE "profile directory $p is missing or not mode 0700 owned by uid 10001 (found '${st:-absent}')" "sudo install -d -m 0700 -o 10001 -g 10001 $p"
    fi
}

chk_ram_stale() {
    local dir out
    dir=${MV_RAM_ADMISSION_DIR:-}
    if [ -z "$dir" ]; then
        dir="${XDG_RUNTIME_DIR:-$RUN_USER_ROOT/$UID_NOW}/metaviewer/ram-admission"
    fi
    [ -d "$dir" ] || return 0
    if [ ! -f "$RAM_TOOL" ] || ! command -v python3 >/dev/null 2>&1; then
        warn JUDGE_RAM_STALE "cannot inspect $dir: tools/mv_ram_admission.py or python3 is absent from this kit (ABSENT, not checked)"
        return 0
    fi
    if out=$(MV_RAM_ADMISSION_DIR=$dir python3 -I "$RAM_TOOL" reclaim --dry-run 2>/dev/null); then
        if printf '%s\n' "$out" | grep -q '"action": "would_remove"'; then # MUT:JUDGE_RAM_STALE
            refuse JUDGE_RAM_STALE "the RAM admission directory holds reservations of dead owners" "python3 tools/mv_ram_admission.py reclaim --dry-run, then the same with --apply"
        fi
    else
        warn JUDGE_RAM_STALE "the reclaim dry run failed; admission records were not checked"
    fi
}

chk_disk() {
    local need=30000000000 home_avail root_avail
    home_avail=$(df_avail "$HOME_DIR" || printf 0)
    root_avail=$home_avail
    [ -n "$DOCKER_ROOT" ] && root_avail=$(df_avail "$DOCKER_ROOT" || printf 0)
    if [ "$home_avail" -lt "$need" ] || [ "$root_avail" -lt "$need" ]; then # MUT:JUDGE_DISK
        refuse JUDGE_DISK "free space is $((home_avail / 1000000000)) GB at home and $((root_avail / 1000000000)) GB at the Docker root [MEASURED], 30 GB [TARGET] needed on both" "free disk space (docker system prune removes unused images)"
    fi
}

# --------------------------------------------------------------------- modes
facts() {
    local total avail shm node net=legacy
    total=$(meminfo MemTotal)
    avail=$(meminfo MemAvailable)
    shm=$(df_avail "$SHM" || printf '')
    node=
    [ -n "$NODE_BIN" ] && node=$("$NODE_BIN" --version 2>/dev/null || printf '')
    open_ready && net=open
    printf 'arch=%s\nnproc=%s\nmem_total_kib=%s\nmem_available_kib=%s\nshm_avail_bytes=%s\nnode_version=%s\nnetwork=%s\n' \
        "$ARCHN" "$(nproc 2>/dev/null || printf '')" "$total" "$avail" "$shm" "$node" "$net"
}

if [ "$MODE" = sysdep ]; then
    missing_packages
    printf '\n'
    exit 0
fi
if [ "$MODE" = facts ]; then
    facts
    exit 0
fi

run_checks() {
    local c
    for c in "$@"; do "chk_$c"; done
}

if [ "$PHASE" = static ]; then
    run_checks os arch bundle_arch xdg shm
    if [ "$TIER" = T2 ]; then
        run_checks ram cpuset
        chk_docker_host && { chk_docker; chk_docker_desktop; }
        run_checks net disk
    fi
else
    run_checks os arch node
    if [ "$TIER" != T0 ]; then run_checks bundle_arch sysdep userns display xdg shm; fi
    if [ "$TIER" = T2 ]; then
        run_checks ram cpuset
        chk_docker_host && { chk_docker; chk_docker_desktop; }
        run_checks image net profile ram_stale disk
    fi
fi

if [ "$FAILS" -gt 0 ]; then
    printf 'JUDGE_PREFLIGHT_FAIL tier=%s phase=%s count=%s\n' "$TIER" "$PHASE" "$FAILS" >&2
    exit 2
fi
printf 'JUDGE_PREFLIGHT_OK tier=%s phase=%s\n' "$TIER" "$PHASE"
exit 0

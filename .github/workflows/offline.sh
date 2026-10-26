#!/usr/bin/env bash
# [TARGET, unit decision] Linux build/test processes get no network interfaces.
# Missing namespace support is a hard failure; never execute outside the sandbox.
set -euo pipefail
[[ $# -gt 0 ]] || { echo 'offline: command required' >&2; exit 2; }
export CARGO_NET_OFFLINE=true GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local
export GOFLAGS=-mod=readonly npm_config_offline=true npm_config_audit=false npm_config_fund=false
# Keep loopback usable for local IPC tests; no external interface is attached.
exec unshare --user --map-root-user --net -- bash -c 'set -e; ip link set lo up; exec "$@"' offline "$@"

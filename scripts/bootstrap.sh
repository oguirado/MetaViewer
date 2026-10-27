#!/usr/bin/env bash
set -euo pipefail
# [TARGET, unit decision] Dependencies are preinstalled; all build inputs are local.
: "${MV_PKG_OUT:?Set an external build output directory}"
: "${CAPSULE_UI_KIT_REPO:?Set the pinned kit checkout}"
if [[ -z "${MV_ELECTRON_ZIP_DIR:-}" && -z "${ELECTRON_OVERRIDE_DIST_PATH:-}" ]]; then
  echo 'Set MV_ELECTRON_ZIP_DIR or ELECTRON_OVERRIDE_DIST_PATH to local Electron files' >&2
  exit 1
fi
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-${MV_PKG_OUT}/cargo-target}"
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
node_bin=${MV_NODE_BIN:-node}
"$node_bin" --test "$root/ui/test/nesting.test.js"
exec "$node_bin" "$root/ui/tools/package.js"

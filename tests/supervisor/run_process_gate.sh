#!/usr/bin/env bash
set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
# Resolve tools once, before elevation; the supervisor receives an explicit path.
cargo_bin=${CARGO:-$(command -v cargo || true)}
if [[ -z $cargo_bin && -x $HOME/.cargo/bin/cargo ]]; then
    cargo_bin=$HOME/.cargo/bin/cargo
fi
python_bin=${MV_TEST_PYTHON:-$(command -v python3)}
unshare_bin=$(command -v unshare)
env_bin=$(command -v env)
true_bin=$(command -v true)
[[ -x $cargo_bin ]] || { echo 'process gate: cargo unavailable' >&2; exit 2; }
# Keep the cargo symlink's name: rustup uses argv[0] to select its proxy.
cargo_bin=$(cd -- "$(dirname -- "$cargo_bin")" && printf '%s/%s' "$PWD" "$(basename -- "$cargo_bin")")
python_bin=$(realpath -- "$python_bin")
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/cargo-target/metaviewer-workers}
export MV_TEST_PYTHON=$python_bin

# Probe only namespace admission. A failed test must never trigger a retry.
namespace=("$unshare_bin" --user --map-root-user --pid --fork --mount-proc)
if ! "${namespace[@]}" "$true_bin"; then
    echo 'process gate: user namespace denied; trying privileged PID namespace' >&2
    namespace=("$(command -v sudo)" -n "$unshare_bin" --pid --fork --mount-proc)
    "${namespace[@]}" "$true_bin" || {
        echo 'process gate: cannot create a PID and mount namespace' >&2
        exit 2
    }
fi

cd -- "$root"
# Build outside sudo so shared build artifacts retain the caller's ownership.
if build_output=$("$cargo_bin" test --offline --manifest-path tests/supervisor/Cargo.toml \
    --test supervisor_process --no-run --message-format=json); then
    :
else
    build_rc=$?
    # Cargo JSON keeps compiler diagnostics off stderr; render them on failure.
    printf '%s\n' "$build_output" | "$python_bin" -I -S -B -c '
import json, sys
for line in sys.stdin:
    item = json.loads(line)
    if item.get("reason") == "compiler-message":
        sys.stderr.write(item["message"].get("rendered") or item["message"]["message"])
'
    exit "$build_rc"
fi
process_bin=$(printf '%s\n' "$build_output" | "$python_bin" -I -S -B -c '
import json, sys
artifacts = [json.loads(line) for line in sys.stdin]
paths = [item["executable"] for item in artifacts
         if item.get("reason") == "compiler-artifact"
         and item.get("target", {}).get("name") == "supervisor_process"
         and item.get("executable")]
if len(paths) != 1:
    raise SystemExit("process gate: expected exactly one test executable")
print(paths[0])
')
"${namespace[@]}" "$env_bin" \
    "MV_TEST_PYTHON=$python_bin" \
    MV_SUPERVISOR_NAMESPACE=1 \
    "$process_bin" --test-threads=1
"${namespace[@]}" "$python_bin" -I -S -B "$root/tests/supervisor/check_mutations.py"

"$python_bin" -I -S -B "$root/tests/supervisor/test_mutations.py"

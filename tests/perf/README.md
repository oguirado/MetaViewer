# AC-14 RSS gate

`python3 tools/budget_gate.py --self-test` executes the frozen offline matrix
and rejects constant under-budget and over-budget comparators. To check an
individual transcript, use `--receipt tests/perf/leak-renderer.json` (must fail).
Exit status: pass `0`, rejected evidence/budget `1`, setup/profile error `2`.
All limits use decimal bytes; utility is diagnostic, not an AC-14 hard limit.

For a live Linux run, build the UI first using its existing offline workflow,
then run:

```sh
xvfb-run -a -s '-screen 0 1280x900x24' python3 tools/budget_gate.py \
  --probe --electron "$ELECTRON_OVERRIDE_DIST_PATH/electron"
```

The binary must be a local Electron distribution matching the UI's pin. No
binary lookup downloads dependencies. A fresh temporary profile is removed
on exit. The tool reuses `bounded` and its process cleanup functions directly
from `tools/gate.sh`, extracting only their AST definitions, without executing
the gate CLI. The probe exits itself normally. The parent checks recorded PID
start times after exit and rejects surviving non-zombie identities.

`--exclude-pid-file PATH` accepts a JSON array of explicitly recorded capsule
root PIDs. Each must be a descendant of the measured app and cannot be its
main process. Their complete subtrees are excluded. An empty array means the
shell fixture has no capsules. Every sampled live helper, GPU and zygote stays
in the tree total; renderer and utility columns aggregate their respective
processes without counting them twice. Linux VmRSS kB is multiplied by 1024;
summing process RSS counts shared pages repeatedly and is an upper bound.
Raw per-process RSS, PID generations, timestamps and exact launch argv are in
the receipt. The frozen profile requires a full gate-duration sample series.

[TARGET, unit decision] The retail host bootstrap and connected capsule
workload are absent from this unit's handoff. The probe uses the existing
shell smoke seams: real secured production BrowserWindow options, preload,
bundled renderer and authority wire, with a read-only layout and synthetic
core response. Readiness, resize, reload, terminal toggle and shutdown run on
the real shell. Capsule fold/reconnect/context loss and a connected production
core remain **AUSENTE**; this result does not certify their memory plateau.
Sandbox settings are unchanged. Any inherited sandbox-disable environment is
recorded in the receipt; no sandbox-disable argument is injected.

## Conductor integration

No gate or CI wiring is changed by this unit. Add `perf` to `tools/gate.sh`'s
usage, selector validation, `LEAVES`, and leaf dispatch. Dispatch these checks,
propagating any nonzero result:

```sh
python3 -m unittest discover -s tests -p 'test_budget_gate*.py'
python3 tools/budget_gate.py --self-test
node --test tests/perf/proc_fields.test.mjs
xvfb-run -a -s '-screen 0 1280x900x24' python3 tools/budget_gate.py \
  --probe --electron "$ELECTRON_OVERRIDE_DIST_PATH/electron"
```

Schedule the live command after the UI install/types/build leg with a local
Electron binary and display prerequisites. Keep the matrix in default offline
CI and G-NOVAC. The gate emits `{passed, failed, skipped, source}` on stdout
and appends its JSON to `GITHUB_STEP_SUMMARY` when present.

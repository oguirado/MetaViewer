#!/bin/bash
# MetaViewer router-kit bootstrap gate: runs the pinned harness end to end.
# A missing expected test FAILS (never SKIP_ABSENT); a missing deny list
# leaves the run BLOCKED. Needs only python3 on PATH plus this tree.
set -u; cd "$(dirname "$0")"; export PYTHONDONTWRITEBYTECODE=1 TMPDIR=$PWD/tmp; mkdir -p tmp logs; rc=0
if [ -n "${MV_ROUTER_DENY_LIST:-}" ]; then
  timeout 900 python3 -B tools/bootstrap_kit.py --run --deny-list "$MV_ROUTER_DENY_LIST" || rc=$?
else
  timeout 900 python3 -B tools/bootstrap_kit.py --run || rc=$?
fi
exit $rc

#!/usr/bin/env python3
"""Standalone AC-14 gate. Offline: --self-test. Live: --probe --electron PATH.

[TARGET, unit decision] Test-owned receipt/profile v1; utility is diagnostic.
The live workload measures the built shell with read-only smoke seams, not a
connected capsule fleet. Explicit capsule roots exclude complete subtrees.
"""
import argparse
import ast
import copy
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
PERF = ROOT / 'tests/perf'
CAPS = {'rss_main_bytes': 200000000, 'rss_renderer_bytes': 370000000,
        'rss_tree_bytes': 1150000000}  # [CITED] AC-14, decimal bytes.
WORKLOAD = ['ready', 'resize', 'reload', 'terminal-toggle', 'shutdown']


def require(ok, message):
    if not ok:
        raise ValueError(message)


def integer(value, minimum=0):
    return type(value) is int and value >= minimum


def read_json(path):
    def reject(value):
        raise ValueError('nonfinite JSON: ' + value)
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'duplicate key: ' + key)
            result[key] = value
        return result
    return json.loads(Path(path).read_text(), parse_constant=reject, object_pairs_hook=pairs)


def validate_budgets(data):
    require(type(data) is dict and set(data) == {'schema', 'basis', 'budgets', 'viewport',
            'sampleMs', 'gateDurationMs', 'exitDurationMs'}, 'profile keys')
    require(data['schema'] == 'metaviewer.perf.rss-budgets/v1', 'profile schema')
    require(type(data['basis']) is str and bool(data['basis']), 'profile basis')
    require(data['viewport'] == {'width': 1280, 'height': 900}, 'viewport')
    for key, value in [('sampleMs', 5000), ('gateDurationMs', 120000), ('exitDurationMs', 600000)]:
        require(integer(data[key], 1) and data[key] == value, key)
    require(type(data['budgets']) is list and len(data['budgets']) == 4, 'budget cohort')
    seen = set()
    for row in data['budgets']:
        require(type(row) is dict and set(row) == {'id', 'unit', 'dir', 'bound', 'basis', 'gating'}, 'budget keys')
        key = row['id']
        require(type(key) is str and key not in seen and key in {*CAPS, 'rss_utility_bytes'}, 'budget id')
        seen.add(key)
        require(integer(row['bound'], 1) and row['bound'] == CAPS.get(key, 260000000), 'frozen bound')
        require(row['unit'] == 'bytes' and row['dir'] == 'max', 'budget units')
        require(type(row['basis']) is str and bool(row['basis']), 'budget basis')
        require(type(row['gating']) is bool and row['gating'] == (key in CAPS), 'gating')
    return data


def load_budgets(path):
    return validate_budgets(read_json(path))


def evaluate(receipt, budgets):
    try:
        validate_budgets(budgets)
        require(type(receipt) is dict and receipt.get('schema') == 'metaviewer.perf.rss-receipt/v1', 'receipt schema')
        require(receipt.get('workload') == WORKLOAD, 'incomplete workload')
        require(receipt.get('orphans') == [], 'orphan evidence')
        require(integer(receipt.get('duration_ms'), budgets['gateDurationMs']), 'truncated duration')
        rows = receipt.get('samples')
        require(type(rows) is list and len(rows) >= 6, 'empty/short cohort')
        previous = -1
        maxima = dict.fromkeys([*CAPS, 'rss_utility_bytes'], 0)
        for row in rows:
            require(type(row) is dict and integer(row.get('at_ms')) and row['at_ms'] > previous, 'sample clock')
            previous = row['at_ms']
            require(previous <= receipt['duration_ms'], 'sample after end')
            for role in maxima:
                require(integer(row.get(role), 0 if role == 'rss_utility_bytes' else 1), 'missing/invalid ' + role)
                maxima[role] = max(maxima[role], row[role])
            require(row['rss_tree_bytes'] >= sum(row[k] for k in ('rss_main_bytes', 'rss_renderer_bytes', 'rss_utility_bytes')), 'omitted helper or double-counted role')
        require(rows[0]['at_ms'] <= budgets['sampleMs'], 'late first sample')
        require(receipt['duration_ms'] - previous <= budgets['sampleMs'], 'missing final sample')
        require(all(b['at_ms'] - a['at_ms'] <= budgets['sampleMs'] * 2 for a, b in zip(rows, rows[1:])), 'sample gap')
        failures = [key for key, cap in CAPS.items() if maxima[key] > cap]
        return {'ok': not failures, 'failures': failures, 'maxima_bytes': maxima}
    except (ValueError, TypeError, KeyError) as error:
        return {'ok': False, 'failures': [str(error)]}


def self_test(budgets):
    cases = read_json(PERF / 'manifest.json')
    results = []
    for case in cases:
        result = evaluate(read_json(PERF / case['file']), budgets)
        results.append(result['ok'] == case['expected_ok'])
    controls = {name: sum(constant != case['expected_ok'] for case in cases)
                for name, constant in [('always_under_budget', True), ('always_over_budget', False)]}
    failed = results.count(False) + sum(count == 0 for count in controls.values())
    return {'passed': results.count(True), 'failed': failed, 'skipped': 0,
            'source': 'G-PERF offline matrix', 'constant_instrument_mismatches': controls}


def cleanup_api():
    # Reuse the actual gate primitives without executing its CLI/heredoc footer.
    source = (ROOT / 'tools/gate.sh').read_text().split("<<'PY'\n", 1)[1].rsplit('\nPY', 1)[0]
    tree = ast.parse(source)
    names = {'descendants', 'process_identity', 'stop_process_tree', 'bounded'}
    selected = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
    require({node.name for node in selected} == names, 'cleanup primitives absent')
    namespace = dict(Path=Path, os=os, signal=signal, subprocess=subprocess, sys=sys, time=time)
    exec(compile(ast.Module(body=selected, type_ignores=[]), str(ROOT / 'tools/gate.sh'), 'exec'), namespace)
    return namespace


ORPHAN_GRACE_MS = 5000  # [TARGET, unit decision] Bounded post-exit grace for helper teardown.
ORPHAN_POLL_MS = 100


def classify_orphan_role(pid, starttime, cmd, comm, sample_roles, main_pid, identity_role=None):
    if type(identity_role) is str and identity_role:
        return identity_role
    recorded = sample_roles.get((pid, starttime)) or sample_roles.get((pid, None))
    if recorded:
        return recorded
    if main_pid is not None and pid == main_pid:
        return 'main'
    words = cmd.replace('\x00', ' ').split()
    if '--type=renderer' in words or any(word.startswith('--type=renderer') for word in words):
        return 'renderer'
    if '--type=utility' in words or any(word.startswith('--type=utility') for word in words):
        return 'utility'
    if comm in ('main', 'renderer', 'utility', 'helper'):
        return comm
    return 'helper'


def probe(electron, budgets, excludes, read_proc=lambda path: path.read_text(),
          sleep=None, grace_ms=ORPHAN_GRACE_MS, poll_ms=ORPHAN_POLL_MS):
    require(Path(electron).is_file(), 'Electron binary absent')
    require(all(integer(pid, 2) for pid in excludes), 'invalid capsule root')
    require(integer(grace_ms, 0) and integer(poll_ms, 1), 'invalid orphan grace')
    wait = time.sleep if sleep is None else sleep
    api = cleanup_api()
    with tempfile.TemporaryDirectory(prefix='mv-rss-') as directory:
        output = Path(directory) / 'receipt.json'
        env = dict(os.environ, MV_RSS_OUTPUT=str(output), MV_RSS_PROFILE=directory,
                   MV_RSS_EXCLUDES=json.dumps(excludes))
        env.pop('ELECTRON_RUN_AS_NODE', None)
        argv = [str(Path(electron).resolve()), str(PERF / 'rss_probe.mjs'),
                '--user-data-dir=' + directory]
        rc = api['bounded'](argv, ROOT, env, seconds=180)
        require(rc == 0, 'probe child rc=' + str(rc))
        receipt = read_json(output)
        sample_roles = {}
        main_pid = None
        for sample in receipt.get('samples', []):
            for proc in sample.get('processes', []) if type(sample) is dict else []:
                pid = proc.get('pid')
                starttime = proc.get('starttime')
                role = proc.get('role')
                if type(pid) is int and type(role) is str and role:
                    sample_roles[(pid, starttime)] = role
                    sample_roles.setdefault((pid, None), role)
                    if role == 'main' and main_pid is None:
                        main_pid = pid
        # Zombies hold no RSS and cannot execute; wait a bounded grace for helpers
        # tearing down right after the main child exits before declaring orphans.
        elapsed_ms = 0
        pending = list(receipt['identities'])
        live = []
        while True:
            live = []
            for identity in pending:
                path = Path('/proc', str(identity['pid']), 'stat')
                try:
                    raw_stat = read_proc(path)
                except (FileNotFoundError, ProcessLookupError):
                    continue
                comm = raw_stat.split('(', 1)[1].rsplit(')', 1)[0] if '(' in raw_stat and ')' in raw_stat else ''
                fields = raw_stat.rsplit(')', 1)[1].split()
                if fields[19] == identity['starttime'] and fields[0] != 'Z':
                    live.append((identity, fields[0], comm))
            if not live or elapsed_ms >= grace_ms:
                break
            step_ms = min(poll_ms, grace_ms - elapsed_ms)
            wait(step_ms / 1000.0)
            elapsed_ms += step_ms
            pending = [identity for identity, _, _ in live]
        orphans = []
        for identity, state, comm in live:
            pid = identity['pid']
            starttime = identity['starttime']
            try:
                raw_cmd = read_proc(Path('/proc', str(pid), 'cmdline'))
            except (FileNotFoundError, ProcessLookupError):
                raw_cmd = ''
            cmd = raw_cmd.replace('\x00', ' ').strip() or identity.get('cmd') or comm
            role = classify_orphan_role(pid, starttime, cmd, comm, sample_roles,
                                        main_pid, identity.get('role'))
            orphans.append({'pid': pid, 'starttime': starttime, 'state': state,
                            'role': role, 'cmd': cmd})
        receipt['orphan_grace_ms'] = elapsed_ms
        receipt['orphans'] = orphans
        receipt['argv'] = argv
        receipt['sandbox_environment'] = env.get('ELECTRON_DISABLE_SANDBOX')
        return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--self-test', action='store_true')
    group.add_argument('--receipt', type=Path)
    group.add_argument('--probe', action='store_true')
    parser.add_argument('--electron')
    parser.add_argument('--exclude-pid-file', type=Path)
    args = parser.parse_args()
    try:
        budgets = load_budgets(PERF / 'budgets.json')
        if args.self_test:
            summary = self_test(budgets)
        else:
            if args.probe:
                require(bool(args.electron), '--electron is required for --probe')
                excludes = read_json(args.exclude_pid_file) if args.exclude_pid_file else []
                require(type(excludes) is list, 'capsule roots must be an explicit list')
                receipt = probe(args.electron, budgets, excludes)
            else:
                receipt = read_json(args.receipt)
            result = evaluate(receipt, budgets)
            summary = {'passed': int(result['ok']), 'failed': int(not result['ok']),
                       'skipped': 0, 'source': 'G-PERF', 'result': result, 'receipt': receipt}
        print(json.dumps(summary, allow_nan=False))
        if os.environ.get('GITHUB_STEP_SUMMARY'):
            with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as stream:
                stream.write('```json\n' + json.dumps(summary) + '\n```\n')
        return int(bool(summary['failed']))
    except (ValueError, OSError, TypeError) as error:
        print(json.dumps({'passed': 0, 'failed': 1, 'skipped': 0, 'source': 'G-PERF', 'error': str(error)}))
        return 2


if __name__ == '__main__':
    sys.exit(main())

"""Offline AC-14 controls; no Electron or host signals required."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('budget_gate', ROOT / 'tools/budget_gate.py')
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class BudgetTests(unittest.TestCase):
    def setUp(self):
        self.budget = gate.load_budgets(ROOT / 'tests/perf/budgets.json')
        self.clean = gate.read_json(ROOT / 'tests/perf/clean.json')

    def test_matrix_and_constant_instruments(self):
        receipt = gate.self_test(self.budget)
        self.assertEqual(receipt['failed'], 0)
        self.assertGreater(receipt['passed'], 0)
        for count in receipt['constant_instrument_mismatches'].values():
            self.assertGreater(count, 0)

    def test_boundaries_and_each_role(self):
        for role, bound in gate.CAPS.items():
            with self.subTest(role=role):
                row = copy.deepcopy(self.clean)
                row['samples'][0][role] = bound
                if role != 'rss_tree_bytes':
                    row['samples'][0]['rss_tree_bytes'] = 1100000000
                self.assertTrue(gate.evaluate(row, self.budget)['ok'])
                row['samples'][0][role] += 1
                self.assertFalse(gate.evaluate(row, self.budget)['ok'])

    def test_malformed_budget_rejected(self):
        for value in (None, True, 0, -1, 1.5, float('inf'), 200000001):
            row = copy.deepcopy(self.budget)
            row['budgets'][0]['bound'] = value
            with self.subTest(value=value), self.assertRaises(ValueError):
                gate.validate_budgets(row)
        for mutate in (lambda r: r.update(extra=1), lambda r: r['budgets'].pop(),
                       lambda r: r['budgets'][0].update(extra=1)):
            row = copy.deepcopy(self.budget)
            mutate(row)
            with self.assertRaises(ValueError):
                gate.validate_budgets(row)

    def test_missing_inconsistent_or_false_evidence(self):
        mutations = [lambda r: r.update(samples=[]), lambda r: r.update(duration_ms=1),
                     lambda r: r['samples'][0].pop('rss_main_bytes'),
                     lambda r: r['samples'][0].update(rss_renderer_bytes=None),
                     lambda r: r['samples'][0].update(rss_main_bytes=True),
                     lambda r: r['samples'][0].update(rss_tree_bytes=1),
                     lambda r: r['samples'][1].update(at_ms=0),
                     lambda r: r.update(workload=[]), lambda r: r.update(orphans=[42])]
        for mutate in mutations:
            row = copy.deepcopy(self.clean)
            mutate(row)
            self.assertFalse(gate.evaluate(row, self.budget)['ok'])

    def test_cli_leak_nonzero_and_clean_pass(self):
        for file, rc in [('clean.json', 0), ('leak-renderer.json', 1)]:
            result = subprocess.run([sys.executable, str(ROOT / 'tools/budget_gate.py'),
                                     '--receipt', str(ROOT / 'tests/perf' / file)],
                                    text=True, capture_output=True, check=False)
            self.assertEqual(result.returncode, rc, result.stderr)
            self.assertEqual(json.loads(result.stdout)['failed'], int(rc != 0))

    def test_reused_cleanup_guards_without_signals(self):
        api = gate.cleanup_api()
        process = Mock(pid=42)
        for pid in (True, 0, 1, -1, 99):
            fake_os = Mock()
            fake_os.getpid.return_value = 99
            fake_os.getpgrp.return_value = 7
            fake_os.getpgid.return_value = 7
            with patch.dict(api, descendants=lambda _: [pid], process_identity=lambda _: 'same', os=fake_os):
                with self.assertRaises(ValueError):
                    api['stop_process_tree'](process)
            fake_os.kill.assert_not_called()
        fake_os = Mock()
        fake_os.getpid.return_value = 99
        fake_os.getpgrp.return_value = 7
        fake_os.getpgid.return_value = 8
        with patch.dict(api, descendants=lambda _: [42], process_identity=lambda _: 'same', os=fake_os, time=Mock()):
            api['stop_process_tree'](process)
        self.assertEqual([c.args[0] for c in fake_os.kill.call_args_list], [42, 42])

    def test_probe_orphan_check_ignores_esrch_and_enoent_between_exists_and_read(self):
        receipt_data = copy.deepcopy(self.clean)
        receipt_data['identities'] = [
            {'pid': 4101, 'starttime': '111'},
            {'pid': 4102, 'starttime': '222'},
            {'pid': 4103, 'starttime': '333'},
        ]

        def fake_bounded(argv, cwd, env, seconds=180):
            Path(env['MV_RSS_OUTPUT']).write_text(json.dumps(receipt_data))
            return 0

        def injected_reader(path):
            if path == Path('/proc/4101/stat'):
                raise ProcessLookupError(3, 'No such process')
            if path == Path('/proc/4102/stat'):
                raise FileNotFoundError(2, 'No such file or directory')
            if path == Path('/proc/4103/stat'):
                return '4103 (helper) Z 1 4103 4103 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 333 0 0'
            raise AssertionError(f'unexpected proc read: {path}')

        real_exists = Path.exists

        def fake_exists(path):
            if path in {Path('/proc/4101/stat'), Path('/proc/4102/stat'), Path('/proc/4103/stat')}:
                return True
            return real_exists(path)

        with patch.object(gate, 'cleanup_api', return_value={'bounded': fake_bounded}), \
                patch.object(Path, 'exists', autospec=True, side_effect=fake_exists), \
                patch.object(Path, 'read_text', autospec=True, side_effect=lambda p, *a, **kw:
                             injected_reader(p) if str(p).startswith('/proc/') else p.read_bytes().decode()):
            out = gate.probe(__file__, self.budget, [], read_proc=injected_reader)
            out_default = gate.probe(__file__, self.budget, [])
        self.assertEqual(out['orphans'], [])
        self.assertEqual(out['orphan_grace_ms'], 0)
        self.assertEqual(out_default['orphans'], [])
        self.assertEqual(out_default['orphan_grace_ms'], 0)
        self.assertTrue(gate.evaluate(out, self.budget)['ok'])

        def live_and_error_reader(path):
            if path == Path('/proc/4101/stat'):
                return '4101 (helper) S 1 4101 4101 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 111 0 0'
            if path == Path('/proc/4101/cmdline'):
                return 'electron\x00--type=zygote\x00'
            if path == Path('/proc/4102/stat'):
                raise ProcessLookupError(3, 'No such process')
            if path == Path('/proc/4103/stat'):
                raise FileNotFoundError(2, 'No such file or directory')
            raise AssertionError(f'unexpected proc read: {path}')

        with patch.object(gate, 'cleanup_api', return_value={'bounded': fake_bounded}), \
                patch.object(Path, 'exists', autospec=True, side_effect=fake_exists), \
                patch.object(Path, 'read_text', autospec=True, side_effect=lambda p, *a, **kw:
                             live_and_error_reader(p) if str(p).startswith('/proc/') else p.read_bytes().decode()):
            out_live = gate.probe(__file__, self.budget, [], read_proc=live_and_error_reader,
                                  sleep=lambda _: None)
        self.assertEqual(out_live['orphan_grace_ms'], 5000)
        self.assertEqual(out_live['orphans'], [{
            'pid': 4101,
            'starttime': '111',
            'state': 'S',
            'role': 'helper',
            'cmd': 'electron --type=zygote',
        }])
        self.assertFalse(gate.evaluate(out_live, self.budget)['ok'])

        def permission_error_reader(path):
            raise PermissionError(13, 'Permission denied')

        with patch.object(gate, 'cleanup_api', return_value={'bounded': fake_bounded}), \
                patch.object(Path, 'exists', autospec=True, side_effect=fake_exists):
            with self.assertRaises(PermissionError):
                gate.probe(__file__, self.budget, [], read_proc=permission_error_reader,
                           sleep=lambda _: None)

    def test_probe_orphan_grace_waits_for_exiting_helpers_and_fails_survivors(self):
        receipt_data = copy.deepcopy(self.clean)
        receipt_data['identities'] = [
            {'pid': 10066, 'starttime': '660'},
            {'pid': 10069, 'starttime': '690'},
            {'pid': 10070, 'starttime': '700'},
            {'pid': 10072, 'starttime': '720'},
        ]
        receipt_data['samples'][0]['processes'] = [
            {'pid': 10066, 'parent': 1, 'starttime': '660', 'state': 'S', 'role': 'main', 'rss_bytes': 150000000},
            {'pid': 10070, 'parent': 10066, 'starttime': '700', 'state': 'S', 'role': 'helper', 'rss_bytes': 10000000},
            {'pid': 10072, 'parent': 10066, 'starttime': '720', 'state': 'S', 'role': 'helper', 'rss_bytes': 10000000},
        ]

        def fake_bounded(argv, cwd, env, seconds=180):
            Path(env['MV_RSS_OUTPUT']).write_text(json.dumps(receipt_data))
            return 0

        # Positive control: helpers 10069, 10070, 10072 exit or become zombies within the grace.
        polls = {'count': 0}
        sleeps = []

        def fake_sleep(seconds):
            sleeps.append(round(seconds, 3))
            polls['count'] += 1

        def exiting_helpers_reader(path):
            tick = polls['count']
            if path == Path('/proc/10066/stat'):
                raise FileNotFoundError(2, 'No such file or directory')
            if path == Path('/proc/10069/stat'):
                if tick < 2:
                    return '10069 (electron) S 10066 10066 10066 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 690 0 0'
                raise ProcessLookupError(3, 'No such process')
            if path == Path('/proc/10070/stat'):
                if tick < 3:
                    return '10070 (electron) S 10066 10066 10066 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 700 0 0'
                return '10070 (electron) Z 10066 10066 10066 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 700 0 0'
            if path == Path('/proc/10072/stat'):
                if tick < 1:
                    return '10072 (electron) S 10066 10066 10066 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 720 0 0'
                # Recycled PID with new starttime is not the recorded identity.
                return '10072 (other) R 1 10072 10072 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 999 0 0'
            raise AssertionError(f'unexpected proc read: {path}')

        with patch.object(gate, 'cleanup_api', return_value={'bounded': fake_bounded}):
            out_pass = gate.probe(__file__, self.budget, [], read_proc=exiting_helpers_reader,
                                  sleep=fake_sleep)
        self.assertEqual(out_pass['orphans'], [])
        self.assertEqual(out_pass['orphan_grace_ms'], 300)
        self.assertEqual(sleeps, [0.1, 0.1, 0.1])
        self.assertTrue(gate.evaluate(out_pass, self.budget)['ok'])

        # Negative control: a process that stays alive past the full 5 s grace fails.
        polls['count'] = 0
        sleeps.clear()

        def surviving_helper_reader(path):
            tick = polls['count']
            if path == Path('/proc/10066/stat'):
                raise FileNotFoundError(2, 'No such file or directory')
            if path == Path('/proc/10069/stat'):
                return '10069 (electron) S 1 10066 10066 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 690 0 0'
            if path == Path('/proc/10069/cmdline'):
                return 'electron\x00--type=utility\x00--utility-sub-type=network.mojom.NetworkService\x00'
            if path == Path('/proc/10070/stat'):
                if tick < 2:
                    return '10070 (electron) S 10066 10066 10066 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 700 0 0'
                raise FileNotFoundError(2, 'No such file or directory')
            if path == Path('/proc/10072/stat'):
                return '10072 (electron) S 1 10066 10066 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 720 0 0'
            if path == Path('/proc/10072/cmdline'):
                return 'electron\x00--type=zygote\x00'
            raise AssertionError(f'unexpected proc read: {path}')

        with patch.object(gate, 'cleanup_api', return_value={'bounded': fake_bounded}):
            out_fail = gate.probe(__file__, self.budget, [], read_proc=surviving_helper_reader,
                                  sleep=fake_sleep)
        self.assertEqual(out_fail['orphan_grace_ms'], 5000)
        self.assertEqual(len(sleeps), 50)
        self.assertEqual(out_fail['orphans'], [
            {
                'pid': 10069,
                'starttime': '690',
                'state': 'S',
                'role': 'utility',
                'cmd': 'electron --type=utility --utility-sub-type=network.mojom.NetworkService',
            },
            {
                'pid': 10072,
                'starttime': '720',
                'state': 'S',
                'role': 'helper',
                'cmd': 'electron --type=zygote',
            },
        ])
        verdict = gate.evaluate(out_fail, self.budget)
        self.assertFalse(verdict['ok'])
        self.assertEqual(verdict['failures'], ['orphan evidence'])

    def test_rss_probe_snapshot_ignores_esrch_and_enoent_during_sample(self):
        script = """
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { snapshot } = await import(pathToFileURL(process.argv[1]).href);
const statLine = (pid, ppid, start) =>
  `${pid} (proc) S ${ppid} ${pid} ${pid} 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${start} 0 0`;
const errWithCode = code => Object.assign(new Error(code), { code });
const seenStat = new Set();
const samples = [];
const identities = new Map();
snapshot(15, {
  rootPid: 100,
  excludes: [],
  identities,
  samples,
  readdirSync: () => ['100', '101', '102', '103', '104'],
  readFileSync: path => {
    if (path.endsWith('/stat')) {
      const pid = Number(path.split('/')[2]);
      const first = !seenStat.has(pid);
      seenStat.add(pid);
      if (!first && pid === 104) throw errWithCode('ESRCH');
      return statLine(pid, pid === 100 ? 1 : 100, pid * 10);
    }
    if (path === '/proc/102/status') throw errWithCode('ESRCH');
    if (path === '/proc/103/cmdline') throw errWithCode('ENOENT');
    if (path.endsWith('/status')) return 'Name:\\tproc\\nVmRSS:\\t1000 kB\\n';
    if (path === '/proc/100/cmdline') return 'electron\\0';
    if (path === '/proc/101/cmdline') return 'electron\\0--type=renderer\\0';
    if (path === '/proc/104/cmdline') return 'electron\\0--type=utility\\0';
    throw new Error('unexpected path ' + path);
  },
});
assert.equal(samples.length, 1);
assert.deepEqual(samples[0].processes.map(p => p.pid), [100, 101]);
assert.equal(samples[0].rss_main_bytes, 1024000);
assert.equal(samples[0].rss_renderer_bytes, 1024000);
assert.equal(samples[0].rss_utility_bytes, 0);
assert.equal(samples[0].rss_tree_bytes, 2048000);
assert.throws(() => snapshot(20, {
  rootPid: 100,
  excludes: [],
  identities: new Map(),
  samples: [],
  readdirSync: () => ['100', '101'],
  readFileSync: path => {
    if (path.endsWith('/stat')) {
      const pid = Number(path.split('/')[2]);
      return statLine(pid, pid === 100 ? 1 : 100, pid * 10);
    }
    if (path === '/proc/101/status') throw errWithCode('ESRCH');
    if (path.endsWith('/status')) return 'VmRSS:\\t1000 kB\\n';
    return 'electron\\0';
  },
}), /Required RSS role absent/);
assert.throws(() => snapshot(25, {
  rootPid: 100,
  excludes: [],
  identities: new Map(),
  samples: [],
  readdirSync: () => ['100', '101', '102'],
  readFileSync: path => {
    if (path.endsWith('/stat')) {
      const pid = Number(path.split('/')[2]);
      return statLine(pid, pid === 100 ? 1 : 100, pid * 10);
    }
    if (path === '/proc/102/status') throw errWithCode('EACCES');
    if (path.endsWith('/status')) return 'VmRSS:\\t1000 kB\\n';
    return path === '/proc/101/cmdline' ? 'electron\\0--type=renderer\\0' : 'electron\\0';
  },
}), { code: 'EACCES' });
"""
        result = subprocess.run(
            ['node', '--input-type=module', '-e', script, str(ROOT / 'tests/perf/rss_probe.mjs')],
            text=True, capture_output=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)

    def test_rss_probe_settled_diagnostics_and_never_settling_negative_control(self):
        script = """
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
const { settled, SETTLE_TIMEOUT_MS, SETTLE_SELECTORS } = await import(pathToFileURL(process.argv[1]).href);
assert.equal(SETTLE_TIMEOUT_MS, 45000);
assert.deepEqual(SETTLE_SELECTORS, ['.metaviewer[data-wall-settled="true"]', '.mv-terminal']);

// Slow first load (> 10 s old limit, < 45 s bound) settles cleanly.
let clock = 0;
await settled({
  now: () => clock,
  sleep: async ms => { clock += ms; },
  executeJavaScript: async code => {
    const document = {
      readyState: clock < 15000 ? 'interactive' : 'complete',
      querySelector: sel => {
        if (clock < 15000) return sel === '.metaviewer[data-wall-settled="true"]' ? {} : null;
        return {};
      },
    };
    return eval(code);
  },
});
assert.equal(clock, 15000);

// Diagnostic reports missing selector, document.readyState, and renderer console errors.
let diagClock = 0;
const webContents = new EventEmitter();
webContents.executeJavaScript = async code => {
  if (diagClock === 0) {
    webContents.emit('console-message', { level: 'error', message: 'TypeError: terminal mount failed' });
  }
  const document = {
    readyState: 'interactive',
    querySelector: sel => (sel === '.metaviewer[data-wall-settled="true"]' ? {} : null),
  };
  return eval(code);
};
await assert.rejects(
  () => settled({
    webContents,
    now: () => diagClock,
    sleep: async ms => { diagClock += ms; },
  }),
  err => {
    assert.match(err.message, /^Shell did not settle within 45000ms /);
    assert.match(err.message, /missingSelectors=\\[\\.mv-terminal\\]/);
    assert.doesNotMatch(err.message, /missingSelectors=\\[\\.metaviewer/);
    assert.match(err.message, /readyState=interactive/);
    assert.match(err.message, /consoleErrors=\\["TypeError: terminal mount failed"\\]/);
    return true;
  }
);

// Negative control: a never-settling page fails with the diagnostic message.
let neverClock = 0;
await assert.rejects(
  () => settled({
    now: () => neverClock,
    sleep: async ms => { neverClock += ms; },
    executeJavaScript: async code => {
      const document = {
        readyState: 'loading',
        querySelector: () => null,
      };
      return eval(code);
    },
  }),
  err => {
    assert.equal(
      err.message,
      'Shell did not settle within 45000ms (missingSelectors=[.metaviewer[data-wall-settled="true"], .mv-terminal], readyState=loading, consoleErrors=none)'
    );
    return true;
  }
);
assert.equal(neverClock, 45000);
"""
        result = subprocess.run(
            ['node', '--input-type=module', '-e', script, str(ROOT / 'tests/perf/rss_probe.mjs')],
            text=True, capture_output=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)


if __name__ == '__main__':
    unittest.main()

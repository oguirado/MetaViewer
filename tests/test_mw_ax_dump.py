"""Unit and mutation tests for tools/mw_ax_dump.py."""
from __future__ import annotations

import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

REPO = Path(__file__).resolve().parents[1]
FIXTURE = REPO / 'tests' / 'e2e' / 'fixtures' / 'mw_perplexity'
for _entry in (str(REPO / 'agents'), str(REPO / 'tools'), str(REPO)):
    if _entry not in sys.path:
        sys.path.insert(0, _entry)

import mw_ax_dump
import mw_run_backend


def _canonical(value: dict) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False) + '\n').encode('utf-8')


def _repair_provenance(site_dir: Path) -> None:
    notes = (FIXTURE / 'repair' / 'NOTES.md').read_bytes()
    (site_dir / 'PROVENANCE.md').write_bytes(notes)
    for relative in ('site.json', 'workflows/ask.json'):
        path = site_dir / relative
        value = json.loads(path.read_bytes())
        value['provenance'].update(
            source='human',
            source_ref='PROVENANCE.md',
            receipt_sha256=None,
            quote_sha256=hashlib.sha256(notes).hexdigest(),
        )
        path.write_bytes(_canonical(value))


def _make_row(
    elem_id: str,
    role: str,
    name: str,
    *,
    actionable: bool = True,
    focused: bool = False,
    region: str | None = 'main',
    value_len: int | None = None,
    extra: dict | None = None,
) -> dict:
    row = {
        'actionable': actionable,
        'box': [100, 200, 300, 40],
        'container': None,
        'focused': focused,
        'id': elem_id,
        'name': name,
        'region': region,
        'role': role,
        'states': {
            'checked': None,
            'enabled': True,
            'expanded': None,
            'focused': True if focused else None,
            'selected': None,
        },
        'value_len': value_len,
    }
    if extra:
        row.update(extra)
    return row


def _make_tree(
    rows: list[dict],
    *,
    url: str = 'https://www.perplexity.ai/',
    title: str = 'Perplexity',
) -> dict:
    return {
        'elements': rows,
        'frame_seq': 7,
        'scroll': {'x': 0, 'y': 0},
        'skipped_frames': 0,
        'truncated': False,
        'window': {
            'h': 680,
            'id': 'w1',
            'title': title,
            'url': url,
            'w': 1240,
            'x': 20,
            'y': 20,
        },
    }


class _FakeClient:
    def __init__(self, host_env: dict[str, str]) -> None:
        self.host_env = dict(host_env)
        self.closed = False

    def __enter__(self) -> '_FakeClient':
        return self

    def __exit__(self, *_exc) -> None:
        self.closed = True


class MwAxDumpTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix='mv-ax-dump-'))
        os.chmod(self.tmp, 0o700)
        self.home = self.tmp / 'memoryweb'
        shutil.copytree(FIXTURE / 'site', self.home / 'sites' / 'perplexity')
        for directory in (self.home, self.home / 'sites'):
            directory.chmod(0o700)
        _repair_provenance(self.home / 'sites' / 'perplexity')

        self.bin_dir = self.tmp / 'bin'
        self.bin_dir.mkdir(mode=0o700)
        self.state_dir = self.tmp / 'state'
        self.state_dir.mkdir(mode=0o700)
        self.store_dir = self.tmp / 'store'
        self.store_dir.mkdir(mode=0o700)

        self.receipt = self.state_dir / 'mv-live-1.json'
        self._write_private_json(
            self.receipt,
            {
                'Capsule': {
                    'container': 'srf-id-mv-live-1',
                    'lease_id': 'lease-ax-1',
                },
                'Lease': {
                    'LeaseID': 'lease-ax-1',
                    'OwnerPID': os.getpid(),
                    'ProfileID': 'mv-live-1',
                },
            },
        )
        self.env = {
            'MV_SRF_BIN_DIR': str(self.bin_dir),
            'MV_SRF_STATE_DIR': str(self.state_dir),
            'SRF_IDENTITY_STORE_ROOT': str(self.store_dir),
            'MV_MW_HOME': str(self.home),
        }

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write_private_json(self, path: Path, doc: dict) -> None:
        path.write_text(json.dumps(doc, indent=2) + '\n', encoding='utf-8')
        os.chmod(path, 0o600)

    def _run_with_fakes(
        self,
        tree: dict,
        *,
        capsule: str = 'mv-live-1',
        site: str = 'perplexity',
        workflow: str | None = 'ask',
        surfaces: list[dict] | None = None,
        admin_doc: dict | None = None,
        docker_names: str = 'srf-id-mv-live-1\n',
        native_side_effect=None,
    ) -> tuple[int, dict, list[tuple[str, list[str]]], Path]:
        if surfaces is None:
            surfaces = [
                {
                    'surface_id': 'surface-perplexity-1',
                    'profile_id': 'mv-live-1',
                    'state': 'active',
                    'kind': 'browser',
                }
            ]
        if admin_doc is None:
            admin_doc = {
                'profile_id': 'mv-live-1',
            }
        calls: list[tuple[str, list[str]]] = []
        client = _FakeClient(self.env)
        out_path = self.tmp / 'out' / 'dump.json'
        page = {'surfaces': surfaces, 'next_cursor': None}
        real_run = mw_run_backend.subprocess.run

        def fake_subprocess_run(argv, **kwargs):
            str_argv = [str(x) for x in argv]
            prog = Path(str_argv[0]).name
            args = str_argv[1:]
            if prog == 'git':
                return real_run(argv, **kwargs)
            calls.append((prog, args))
            if native_side_effect is not None:
                res = native_side_effect(prog, args)
                if res is not None:
                    return res
            if prog == 'srf-identity-admin':
                return SimpleNamespace(returncode=0, stdout=json.dumps(admin_doc).encode('utf-8'))
            if prog == 'docker':
                return SimpleNamespace(returncode=0, stdout=docker_names.encode('utf-8'))
            if prog == 'srf-identity-surface':
                return SimpleNamespace(returncode=0, stdout=json.dumps(tree).encode('utf-8'))
            raise AssertionError(f'unexpected command: {str_argv}')

        stdout = io.StringIO()
        with (
            mock.patch.object(mw_run_backend, 'connect', return_value=client),
            mock.patch.object(mw_run_backend.tools, 'list_surfaces', return_value=page),
            mock.patch.object(mw_run_backend.subprocess, 'run', side_effect=fake_subprocess_run),
            mock.patch.dict(os.environ, self.env, clear=False),
            mock.patch('sys.stdout', stdout),
        ):
            argv = [
                '--repo',
                str(REPO),
                '--capsule',
                capsule,
                '--site',
                site,
                '--out',
                str(out_path),
                '--home',
                str(self.home),
            ]
            if workflow is not None:
                argv.extend(['--workflow', workflow])
            rc = mw_ax_dump.main(argv)

        lines = [line for line in stdout.getvalue().splitlines() if line.strip()]
        self.assertEqual(len(lines), 1)
        summary = json.loads(lines[0])
        return rc, summary, calls, out_path

    def test_all_anchors_present_returns_rc_0_and_runs_single_readonly_ax(self) -> None:
        rows = [
            _make_row('e1', 'button', 'Nuevo', region='navigation'),
            _make_row('e14', 'textbox', 'Pregunta lo que sea…', value_len=0),
            _make_row('e15', 'button', 'GPT-6.1 Sol', focused=True),
            _make_row('e20', 'button', 'Copiar'),
        ]
        tree = _make_tree(rows)
        rc, summary, calls, out_path = self._run_with_fakes(tree)

        self.assertEqual(rc, 0)
        self.assertEqual(summary['marker'], 'MW_AX_DUMP')
        self.assertEqual(summary['rows'], 4)
        self.assertEqual(summary['window_url'], 'https://www.perplexity.ai/')
        self.assertEqual(summary['focused'], {'role': 'button', 'name': 'GPT-6.1 Sol'})
        self.assertTrue(all(item['present'] for item in summary['anchors']))
        anchor_names = [item['anchor_name'] for item in summary['anchors']]
        self.assertEqual(anchor_names, ['Nuevo', 'Pregunta lo que sea…', 'Copiar'])

        surface_calls = [args for prog, args in calls if prog == 'srf-identity-surface']
        self.assertEqual(
            surface_calls,
            [['ax', '--container', 'srf-id-mv-live-1', '--window', 'w1', '--state-dir', str(self.state_dir)]],
        )
        self.assertTrue(out_path.is_file())

        # Mutant: if an anchor is missing from the tree, rc 0 must NOT be returned.
        mutant_tree = _make_tree([rows[0], rows[2], rows[3]])
        m_rc, m_summary, _, _ = self._run_with_fakes(mutant_tree)
        self.assertNotEqual(m_rc, 0)
        self.assertEqual(m_rc, 3)
        self.assertEqual(m_summary.get('code'), 'MW_AX_ANCHOR_DRIFT')

    def test_locale_lesson_spanish_anchor_against_english_tree_returns_rc_3_with_candidates(self) -> None:
        # Replay the 3-row subset shape from E1_AX_DUMP_LIVE.json (English UI vs Spanish home anchors).
        rows = [
            _make_row('e1', 'button', 'New thread', region='navigation'),
            _make_row('e14', 'textbox', 'Ask anything…', region='main', value_len=0),
            _make_row('e15', 'button', 'GPT-6.1 Sol', focused=True, region='main'),
        ]
        tree = _make_tree(rows)
        rc, summary, surface_calls_all, _ = self._run_with_fakes(
            tree,
            capsule='srf-id-mv-live-1',
        )

        self.assertEqual(rc, 3)
        self.assertEqual(summary['marker'], 'MW_AX_DUMP')
        self.assertEqual(summary.get('code'), 'MW_AX_ANCHOR_DRIFT')
        by_anchor = {item['anchor_name']: item for item in summary['anchors']}
        self.assertIn('Pregunta lo que sea…', by_anchor)
        composer_entry = by_anchor['Pregunta lo que sea…']
        self.assertFalse(composer_entry['present'])
        self.assertIn('Ask anything…', composer_entry['candidates'])
        self.assertEqual(composer_entry['candidates'][0], 'Ask anything…')

        surface_calls = [args for prog, args in surface_calls_all if prog == 'srf-identity-surface']
        self.assertEqual(len(surface_calls), 1)

        # Mutant: if _rank_candidates is sabotaged to return empty list, candidate assertion fails.
        with mock.patch.object(mw_ax_dump, '_rank_candidates', return_value=[]):
            _, m_summary, _, _ = self._run_with_fakes(tree)
            m_by_anchor = {item['anchor_name']: item for item in m_summary['anchors']}
            self.assertNotIn('Ask anything…', m_by_anchor['Pregunta lo que sea…']['candidates'])

    def test_never_prints_or_writes_row_values(self) -> None:
        secret_value = 'SUPER_SECRET_USER_PROMPT_VALUE_99182'
        rows = [
            _make_row('e1', 'button', 'Nuevo', region='navigation'),
            _make_row(
                'e14',
                'textbox',
                'Pregunta lo que sea…',
                focused=True,
                value_len=len(secret_value),
                extra={'value': secret_value, 'text': secret_value},
            ),
            _make_row('e20', 'button', 'Copiar'),
        ]
        tree = _make_tree(rows)
        rc, summary, calls, out_path = self._run_with_fakes(tree)

        self.assertEqual(rc, 0)
        summary_raw = json.dumps(summary)
        self.assertNotIn(secret_value, summary_raw)
        out_raw = out_path.read_text(encoding='utf-8')
        self.assertNotIn(secret_value, out_raw)
        out_doc = json.loads(out_raw)
        textbox_row = [r for r in out_doc['elements'] if r['id'] == 'e14'][0]
        self.assertNotIn('value', textbox_row)
        self.assertNotIn('text', textbox_row)
        self.assertEqual(textbox_row['value_len'], len(secret_value))

        # Ensure slot_text (--text-container) was never called even though a textbox is focused.
        for prog, args in calls:
            self.assertNotIn('--text-container', args)

        # Mutant: if _sanitize_tree fails to strip 'value', the secret leaks into the output file.
        with mock.patch.object(mw_ax_dump, '_sanitize_tree', side_effect=lambda t: t):
            _, _, _, m_out = self._run_with_fakes(tree)
            self.assertIn(secret_value, m_out.read_text(encoding='utf-8'))

    def test_out_file_mode_is_0600(self) -> None:
        rows = [
            _make_row('e1', 'button', 'Nuevo'),
            _make_row('e14', 'textbox', 'Pregunta lo que sea…'),
            _make_row('e20', 'button', 'Copiar'),
        ]
        tree = _make_tree(rows)
        rc, _, _, out_path = self._run_with_fakes(tree)
        self.assertEqual(rc, 0)
        mode = stat.S_IMODE(out_path.stat().st_mode)
        self.assertEqual(mode, 0o600)

        # Mutant: if _write_private_out writes mode 0644, the mode check in main() traps it.
        def bad_write(path: Path, payload: dict) -> None:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(payload), encoding='utf-8')
            os.chmod(path, 0o644)

        with mock.patch.object(mw_ax_dump, '_write_private_out', side_effect=bad_write):
            with self.assertRaises(AssertionError):
                self._run_with_fakes(tree)

    def test_refusals_propagated_for_ownership_missing_capsule_and_missing_binary(self) -> None:
        tree = _make_tree([_make_row('e1', 'button', 'Nuevo')])

        # 1. Ownership failure (docker ps returns non-zero)
        def docker_fails(prog: str, _args: list[str]):
            if prog == 'docker':
                return SimpleNamespace(returncode=1, stdout=b'')
            return None

        rc_own, summary_own, _, _ = self._run_with_fakes(
            tree,
            native_side_effect=docker_fails,
        )
        self.assertEqual(rc_own, 6)
        self.assertEqual(summary_own['status'], 'refused')
        self.assertEqual(summary_own['code'], 'MW_RUN_OWNERSHIP')

        # 2. Missing capsule (not in bridge surfaces)
        rc_cap, summary_cap, _, _ = self._run_with_fakes(tree, surfaces=[])
        self.assertEqual(rc_cap, 6)
        self.assertEqual(summary_cap['status'], 'refused')
        self.assertEqual(summary_cap['code'], 'MW_RUN_NO_SURFACE')

        # 3. Missing binary (FileNotFoundError when running srf-identity-surface)
        def missing_binary(prog: str, _args: list[str]):
            if prog == 'srf-identity-surface':
                raise FileNotFoundError(2, 'No such file or directory', prog)
            return None

        rc_bin, summary_bin, _, _ = self._run_with_fakes(
            tree,
            native_side_effect=missing_binary,
        )
        self.assertEqual(rc_bin, 6)
        self.assertEqual(summary_bin['status'], 'refused')
        self.assertEqual(summary_bin['code'], 'MW_RUN_NATIVE')

        # Mutant: when ownership is restored, refusal disappears.
        rc_ok, summary_ok, _, _ = self._run_with_fakes(
            _make_tree(
                [
                    _make_row('e1', 'button', 'Nuevo'),
                    _make_row('e14', 'textbox', 'Pregunta lo que sea…'),
                    _make_row('e20', 'button', 'Copiar'),
                ]
            )
        )
        self.assertEqual(rc_ok, 0)
        self.assertNotEqual(summary_ok.get('status'), 'refused')


if __name__ == '__main__':
    unittest.main()

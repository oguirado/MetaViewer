"""Judge image regression with an executable fake Docker; no daemon or privilege."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

SOURCE = Path(os.environ.get('V027_IDENTITY_SOURCE', str(Path(__file__).resolve().parents[1] / 'tools/mv_identity.py')))
spec = importlib.util.spec_from_file_location('v027_identity', SOURCE)
mv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mv)


class JudgeProvision(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='v027-Música-')
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name)
        self.root = self.base / 'store'
        for p in (self.root, self.base/'home', self.base/'bin',
                  self.root/'profiles', self.root/'metadata', self.root/'locks'):
            p.mkdir(mode=0o700)
        self.log = self.base/'calls.jsonl'
        self.marker = self.base/'provisioned'
        docker = self.base/'bin/docker'
        docker.write_text('#!' + sys.executable + '\n' + '''import json, pathlib, sys
base = pathlib.Path(__file__).resolve().parents[1]
a = sys.argv[1:]
with (base/'calls.jsonl').open('a') as f: f.write(json.dumps(a)+'\\n')
image = 'opensuperficies-identity-browser-'+(base/'arch').read_text()+':'+(base/'version').read_text()
if a[:2] == ['image','inspect']: sys.exit(0 if a[-1] == image else 1)
if a[0] != 'run' or image not in a or (base/'fail').exists(): sys.exit(125)
(base/'provisioned').write_text(a[-1])
sys.exit(0)
''')
        docker.chmod(0o700)
        (self.base/'arch').write_text('x64')
        (self.base/'version').write_text('0.1.1')
        env = patch.dict(os.environ, PATH=str(self.base/'bin')+os.pathsep+os.environ['PATH'])
        env.start(); self.addCleanup(env.stop)
        self.tool = mv.Identities(str(self.root), str(self.base/'home'), str(self.base/'bin'))
        self.tool.show = lambda identity: json.loads((self.root/'metadata'/(identity+'.json')).read_text())
        def native(binary, args):
            self.assertEqual(binary, 'srf-identity-admin')
            identity = args[args.index('--id')+1]
            (self.root/'profiles'/identity).mkdir(mode=0o700)
            p = self.root/'metadata'/(identity+'.json')
            p.write_text(json.dumps({'profile_id':identity, 'browser':'program' if '--browser' in args else 'chromium'}))
            p.chmod(0o600)
            return {}
        self.tool.native = Mock(side_effect=native)
        original = Path.lstat
        def lstat(p, *args, **kwargs):
            st = original(p, *args, **kwargs)
            if p.parent == self.root/'profiles' and self.marker.exists() and self.marker.read_text() == p.name:
                values = list(st); values[4] = values[5] = 10001
                return os.stat_result(values)
            return st
        stat = patch.object(Path, 'lstat', lstat)
        stat.start(); self.addCleanup(stat.stop)

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def test_judge_program_and_browser_creation_uses_installed_arch_image(self):
        other = self.root/'profiles/untouched'
        other.mkdir(mode=0o700)
        before = other.stat()
        for machine, arch, version, browser in [('x86_64','x64','0.1.1','program'),
                                               ('aarch64','arm64','0.2.0','browser')]:
            with self.subTest(machine=machine, browser=browser):
                (self.base/'arch').write_text(arch)
                (self.base/'version').write_text(version)
                identity = 'gedit' if browser == 'program' else 'account-a'
                with patch.object(mv.os, 'uname', return_value=Mock(machine=machine)):
                    self.assertEqual(self.tool.create(identity, identity, browser=browser)['profile_id'], identity)
                command = self.calls()[-1]
                self.assertEqual(command[:3], ['run','--rm','--pull=never'])
                for flag, value in [('--network','none'),('--user','0'),('--entrypoint','/bin/sh')]:
                    self.assertEqual(command[command.index(flag)+1], value)
                self.assertIn('opensuperficies-identity-browser-'+arch+':'+version, command)
                self.assertEqual(command[command.index('--mount')+1], 'type=bind,src='+str(self.root/'profiles')+',dst=/profiles')
                self.assertEqual(command[-1], identity)
                self.assertNotIn('-R', command[-3])
                self.assertIn('chown 10001:10001 .', command[-3])
                self.assertEqual(self.tool.profile_state(identity), 'ok')
        self.assertEqual(other.stat(), before)

    def test_missing_image_and_failed_docker_refuse_and_rollback(self):
        for missing in (True, False):
            with self.subTest(missing=missing):
                (self.base/'version').write_text('absent' if missing else '0.1.1')
                (self.base/'fail').touch()
                with patch.object(mv.os, 'uname', return_value=Mock(machine='x86_64')):
                    with self.assertRaisesRegex(mv.Refused, '^PROFILE_NOT_PROVISIONED$'):
                        self.tool.create('gedit', 'gedit', browser='program')
                self.assertFalse((self.root/'metadata/gedit.json').exists())
                self.assertIn('Docker', mv.HINTS['PROFILE_NOT_PROVISIONED'])
        self.assertFalse(self.marker.exists())

    def test_image_probe_timeout_and_unknown_arch_fail_closed(self):
        with patch.object(mv.os, 'uname', return_value=Mock(machine='x86_64')), patch.object(mv.subprocess, 'run', side_effect=subprocess.TimeoutExpired('docker', 2)) as run:
            with self.assertRaises(mv.Refused): mv.profile_image()
            self.assertEqual(run.call_args.kwargs['timeout'], 20)
        with patch.object(mv.os, 'uname', return_value=Mock(machine='unknown')), patch.object(mv.subprocess, 'run') as run:
            with self.assertRaises(mv.Refused): mv.profile_image()
            run.assert_not_called()

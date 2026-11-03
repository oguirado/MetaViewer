"""Offline ordered regressions for judge admission and crash recovery."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from judge_sandbox import ELF_MACHINE, SRF_FAKE, Sandbox, elf, make_tar


class JudgeFixJ1(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.sb = Sandbox(temporary.name)
        self.addCleanup(self.sb.cleanup)

    def install(self, capsules=False):
        self.sb.full_kit(t2=capsules)
        args = ('--capsules', '--no-firewall') if capsules else ()
        result = self.sb.judge('install', *args)
        self.assertEqual(result.rc, 0, result.text)

    def ram_entry(self, name):
        path = self.sb.shm / 'vqa-ramws/opensuperficies/os-cu-0' / name
        path.mkdir(parents=True)
        (path / 'frame').write_text('preserve until native absence is proven')
        return path

    def program_receipt(self, name='srf-pg-judge'):
        state = self.sb.home / 'state/metaviewer/srf'
        state.mkdir(parents=True, exist_ok=True, mode=0o700)
        path = state / 'program.json'
        path.write_text(json.dumps({'Lease': {'ProfileID': 'judge'},
                                    'Capsule': {'container': name, 'run_id': 'run-test'}}))
        path.chmod(0o600)
        return path

    def test_docker_unavailable_preserves_ram_and_requires_absence_proof(self):
        self.install(capsules=True)
        entry = self.ram_entry('srf-id-judge')
        self.sb.put('containers', entry.name + '\n')
        self.sb.put('docker_info_rc', '1\n')
        result = self.sb.judge('stop')
        self.assertEqual(result.rc, 2, result.text)
        self.assertTrue(entry.exists())
        line = next(line for line in result.err.splitlines() if 'RAM entry' in line)
        self.assertNotIn('rm -rf', line)
        self.assertIn('Docker', line)
        self.assertIn('absence', line)
        self.assertNotIn('stop --container', self.sb.log('srf.log'))

    def test_docker_unavailable_without_native_state_is_a_clean_stop(self):
        self.install(capsules=True)
        self.sb.put('docker_info_rc', '1\n')
        result = self.sb.judge('stop')
        self.assertEqual(result.rc, 0, result.text)
        self.assertNotIn('Docker inventory unavailable', result.err)

    def test_failed_inventory_is_never_absence(self):
        self.install()
        entry = self.ram_entry('srf-id-judge')
        docker = self.sb.bin / 'docker'
        docker.write_text(docker.read_text().replace('  ps)\n', '  ps) exit 1;;\n'))
        result = self.sb.judge('stop')
        self.assertEqual(result.rc, 2, result.text)
        self.assertTrue(entry.exists(), result.text)
        self.assertNotIn('rm -rf', result.err)

    def test_program_crash_stop_then_absent_ram_cleanup(self):
        self.install(capsules=True)
        self.program_receipt()
        entry = self.ram_entry('srf-pg-judge')
        self.sb.put('containers', entry.name + '\nsrf-pg-foreign\nsrf-egress-proxy\n')
        result = self.sb.judge('stop')
        self.assertIn('stop --container srf-pg-judge', self.sb.log('srf.log'))
        self.assertNotIn('stop --container srf-pg-foreign', self.sb.log('srf.log'))
        self.assertFalse(entry.exists(), result.text)
        self.assertIn('srf-pg-foreign', result.err)
        self.assertEqual(result.rc, 2, result.text)
        self.sb.put('containers', 'srf-egress-proxy\n')
        clean = self.sb.judge('stop')
        self.assertEqual(clean.rc, 0, clean.text)

    def test_program_live_or_foreign_ram_survives(self):
        self.install(capsules=True)
        self.program_receipt()
        owned = self.ram_entry('srf-pg-judge')
        foreign = self.ram_entry('srf-pg-foreign')
        self.sb.put('containers', owned.name + '\n')
        self.sb.write_exec(self.sb.jh / 'deps/opensuperficies/bin/srf-identity-surface',
                           SRF_FAKE.replace('sed -i', 'false; exit 1; sed -i'))
        result = self.sb.judge('stop')
        self.assertEqual(result.rc, 2, result.text)
        self.assertTrue(owned.exists())
        self.assertTrue(foreign.exists())
        self.assertNotIn('rm -rf', result.err)

    def test_program_ownership_is_read_before_the_app_exits(self):
        # Measured on x64: the app removes its receipts as it exits, so reading them
        # afterwards left a stopped Program's RAM frames reported as a leak.
        script = (Path(__file__).resolve().parents[2] / 'scripts/judge/metaviewer-judge.sh').read_text()
        body = script[script.index('cmd_stop() {'):]
        self.assertLess(body.index('programs=$(owned_programs'), body.index('pid=$(running_pid)'))
        self.assertEqual(body[:body.index('\n}\n')].count('owned_programs'), 1)

    def test_untrusted_program_receipt_does_not_authorize_stop_or_cleanup(self):
        self.install(capsules=True)
        receipt = self.program_receipt()
        receipt.chmod(0o666)
        entry = self.ram_entry('srf-pg-judge')
        self.sb.put('containers', entry.name + '\n')
        result = self.sb.judge('stop')
        self.assertEqual(result.rc, 2, result.text)
        self.assertTrue(entry.exists())
        self.assertNotIn('stop --container srf-pg-judge', self.sb.log('srf.log'))

    def test_wrong_arch_private_sidecars_refuse_install_and_doctor(self):
        for component, executable in (('vision-engine', 'vision-runtime'),
                                      ('wender-agent', 'wender-runtime')):
            with self.subTest(component=component):
                self.sb.full_kit(t2=True)
                make_tar(self.sb.assets / (component + '.tar.gz'), [
                    (component + '/', None, 0o755),
                    (component + '/' + executable, elf(62 if ELF_MACHINE[self.sb.arch] == 183 else 183), 0o755)])
                self.sb.write_sums()
                result = self.sb.judge('install', '--capsules', '--no-firewall')
                self.assertEqual(result.rc, 2, result.text)
                self.assertIn('JUDGE_BUNDLE_ARCH', result.codes)
                self.assertIn(executable, result.err)
                self.assertNotIn('JUDGE_INSTALL_OK', result.out)
                self.assertFalse((self.sb.jh / 'judge_receipt.json').exists())
                doctor = self.sb.judge('doctor', '--capsules')
                self.assertIn('JUDGE_BUNDLE_ARCH', doctor.codes)
                # A matching host ELF remains admissible; checkout assets also
                # remain supported by the install() fixtures without sidecars.
                (self.sb.jh / 'deps' / component / executable).unlink()

    def test_matching_arch_sidecars_are_admitted(self):
        self.sb.full_kit(t2=True)
        for component, executable in (('vision-engine', 'vision-runtime'),
                                      ('wender-agent', 'wender-runtime')):
            make_tar(self.sb.assets / (component + '.tar.gz'), [
                (component + '/', None, 0o755),
                (component + '/' + executable, elf(ELF_MACHINE[self.sb.arch]), 0o755)])
        self.sb.write_sums()
        result = self.sb.judge('install', '--capsules', '--no-firewall')
        self.assertEqual(result.rc, 0, result.text)
        self.assertIn('JUDGE_INSTALL_OK', result.out)

    def test_optional_host_tools_each_warn_without_blocking_capsules(self):
        self.install(capsules=True)
        for tool in ('xpra', 'Xvfb', 'xauth', 'xdotool'):
            self.sb.write_exec(self.sb.bin / tool, '#!/bin/bash\nexit 0\n')
        for tool in ('xpra', 'Xvfb', 'xauth', 'xdotool'):
            with self.subTest(tool=tool):
                self.sb.drop_tool(tool)
                result = self.sb.judge('doctor', '--before-install', '--capsules')
                self.assertEqual(result.rc, 0, result.text)
                self.assertIn('JUDGE_HOST_PROGRAM', result.err)
                self.assertIn(tool, result.err)
                self.assertIn('sudo apt-get install -y xpra xvfb xauth xdotool', result.err)
                self.sb.write_exec(self.sb.bin / tool, '#!/bin/bash\nexit 0\n')
        ready = self.sb.judge('doctor', '--capsules')
        self.assertEqual(ready.rc, 0, ready.text)
        self.assertNotIn('JUDGE_HOST_PROGRAM', ready.err)

    def test_docker_failure_remedy_covers_service_and_access(self):
        self.install(capsules=True)
        for message in ('Cannot connect to the Docker daemon', 'permission denied'):
            with self.subTest(message=message):
                docker = self.sb.bin / 'docker'
                original = docker.read_text()
                docker.write_text(original.replace('  info)',
                    '  info) echo "' + message + '" >&2; exit 1;;\n  unused)'))
                result = self.sb.judge('doctor', '--capsules')
                docker.write_text(original)
                self.assertEqual(result.rc, 2, result.text)
                self.assertIn('JUDGE_DOCKER', result.codes)
                self.assertIn('systemctl', result.err)
                self.assertIn('docker info', result.err)
                self.assertIn('permission', result.err)

    def test_interactive_wayland_refusal_explains_visible_display(self):
        self.install()
        result = self.sb.judge('run', env={'DISPLAY': None, 'WAYLAND_DISPLAY': 'wayland-0'})
        self.assertEqual(result.rc, 2, result.text)
        self.assertIn('JUDGE_DISPLAY', result.codes)
        self.assertIn('XWayland', result.err)
        self.assertIn('visible', result.err)
        self.assertIn('headless', result.err)
        install = self.sb.judge('install', env={'DISPLAY': None})
        self.assertIn('xvfb-run', install.err)


if __name__ == '__main__':
    unittest.main()

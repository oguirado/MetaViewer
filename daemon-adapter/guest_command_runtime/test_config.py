import copy
import importlib
import os
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from guest_command_runtime.config import ConfigError, load, validate
from guest_command_runtime.native import NativeVM


def profile():
    return {'schema': 'guest-command-host-config/v1', 'owner_id': 'actor-test',
            'generation': 1, 'runtime_admitted': False, 'runtime_root': '/dev/shm/test',
            'external_cgroup': '/sys/fs/cgroup/test', 'startup_seconds': 15,
            'stop_seconds': 5, 'artifacts': {name: {'path': '/private/'+name, 'sha256': 'a'*64}
                                          for name in ('engine','kernel','broker','busybox')}}


class ConfigTests(unittest.TestCase):
    def test_profile_is_detached_and_nonadmitted_never_boots(self):
        original = profile()
        native = NativeVM(original, lambda *args: None)
        original['runtime_admitted'] = True
        with self.assertRaisesRegex(RuntimeError, 'not admitted'):
            native.open()
        self.assertIsNone(native.process)
        self.assertIsNone(native.directory)
        with self.assertRaisesRegex(RuntimeError, 'never retried'):
            native.open()

    def test_profile_mutations_fail_before_effects(self):
        mutations = [('generation', True), ('runtime_admitted', 1), ('stop_seconds', 31),
                     ('startup_seconds', 0), ('owner_id', 'root'), ('extra', 1),
                     ('runtime_root', '/dev/shm/../foreign'), ('external_cgroup', '//sys/cg')]
        for key, value in mutations:
            bad = profile(); bad[key] = value
            with self.subTest(key=key), self.assertRaises(ConfigError):
                validate(bad)

    def test_private_file_and_duplicate_keys(self):
        import json
        with tempfile.TemporaryDirectory() as tmp:
            file = Path(tmp)/'profile.json'
            file.write_text(json.dumps(profile())); file.chmod(0o600)
            self.assertFalse(load(str(file))['runtime_admitted'])
            file.chmod(0o644)
            with self.assertRaises(ConfigError): load(str(file))
            file.chmod(0o600)
            link = Path(tmp)/'link'; link.symlink_to(file)
            with self.assertRaises(OSError): load(str(link))
            file.write_text('{"schema":1,"schema":2}')
            with self.assertRaises(RuntimeError): load(str(file))


if __name__ == '__main__': unittest.main()

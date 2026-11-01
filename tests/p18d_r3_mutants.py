"""Discriminating R3 source mutations, on isolated copies only."""
import json
import os
from p18d_verify import ROOT, OUT, run

source = (ROOT/'tools/mv_identity.py').read_text()
mutants = OUT/'r3-mutants'
mutants.mkdir(parents=True, exist_ok=True)
cases = [
    ('bad-id', [('if not isinstance(value, str) or not ID.fullmatch(value):', 'if False:')], 'test_bad_id_refused_before_helper'),
    ('symlink-target', [('if target.is_symlink() or target.resolve() != target or target.parent != profiles:', 'if False:'), ('if target.exists() and not stat.S_ISDIR(target.lstat().st_mode):', 'if False:')], 'test_symlinked_target_refused_before_helper'),
    ('profiles-outside', [('        private(profiles)', '        pass'), ('if profiles.resolve(strict=True) != profiles or profiles.parent != self.root:', 'if False:'), ('if target.is_symlink() or target.resolve() != target or target.parent != profiles:', 'if False:')], 'test_profiles_outside_root_refused_before_helper'),
    ('stat-uid', [('st.st_uid != NATIVE_PROFILE_UID or', 'False or')], 'test_helper_success_with_wrong_owner_mode_or_gid_refused'),
    ('stat-mode', [('stat.S_IMODE(st.st_mode) != 0o700', 'False')], 'test_helper_success_with_wrong_owner_mode_or_gid_refused'),
    ('delete-order', [('            metadata.unlink()', '            pass # mutant: metadata not deleted first')], 'test_delete_active_identity_refused_then_stopped_identity_deleted'),
    ('delete-open', [('lease.get("active") is not False', 'False')], 'test_delete_orders_store_before_helper_and_refuses_open'),
    ('create-provision', [('        self.provision(identity)', '        pass # mutant: provisioning skipped')], 'test_create_provisions_before_reporting_success'),
    ('timeout-cleanup', [('["docker", "rm", "-f", name]', '["docker", "inspect", name]')], 'test_timeout_removes_only_named_helper_and_keeps_sudo_hint'),
]
results = []
try:
    for name, replacements, witness in cases:
        mutated = source
        for before, after in replacements:
            if mutated.count(before) != 1:
                raise RuntimeError('MUTATION_ANCHOR_NOT_UNIQUE '+name)
            mutated = mutated.replace(before, after)
        compile(mutated, name+'.py', 'exec')
        path = mutants/(name+'.py')
        path.write_text(mutated)
        os.environ['P18D_IDENTITY_SOURCE'] = str(path.resolve())
        label = 'r3-mutant-'+name
        rc = run(label, ['python3','-m','unittest','discover','-s','tests','-p','test_p18d_identity.py'])
        output = (OUT/(label+'.log')).read_text()
        if rc == 0 or 'FAIL: '+witness not in output:
            raise RuntimeError('MUTANT_SURVIVED_OR_INVALID '+name)
        results.append(dict(mutant=name, rc=rc, killed=True, assertion=witness))
        print(json.dumps(results[-1]), flush=True)
finally:
    os.environ.pop('P18D_IDENTITY_SOURCE', None)
(mutants/'results.json').write_text(json.dumps(results, indent=2)+'\n')

"""Real, bounded mutation runs; a compiler failure never kills a mutant.

Go uses source overlays; Node uses a test-only loader. No production file is
changed, and every child runs in the verification runner's memory-capped scope.
"""
import json
import os
from pathlib import Path
from p18d_verify import ROOT, OUT, run

mutants = OUT/'mutants'
mutants.mkdir(parents=True, exist_ok=True)
node = '/home/admin/.nvm/versions/node/v24.14.0/bin/node'
go = '/usr/local/go/bin/go'
results = []


def killed(label, rc, required):
    output = (OUT/(label+'.log')).read_text()
    if rc == 0 or required not in output or 'MUTATION_ANCHOR_NOT_UNIQUE' in output:
        raise RuntimeError('MUTANT_SURVIVED_OR_INVALID '+label)
    results.append(dict(mutant=label, rc=rc, killed=True, failureWitness=required))
    print(json.dumps(results[-1]), flush=True)


js = ROOT/'ui/src/identities/identityForm.js'
vue = ROOT/'ui/src/identities/IdentitiesDialog.vue'
node_mutations = [
    ('required-name', js, '!validIdentityName(name) || ', '', 'P18D required name'),
    ('display-name-default', js, 'displayName.trim() || name', 'displayName.trim()', 'P18D required name'),
    ('sites-sorting', js, 'return [...seen].sort();', 'return [...seen];', 'P18D required name'),
    ('delete-open-guard', vue, 'if(isOpen(name))', 'if(false)', 'P18D open identity delete refuses locally'),
]
for name, path, before, after, witness in node_mutations:
    label = 'r2-mutant-'+name
    assert path.read_text().count(before) == 1
    os.environ['P18D_MUTATION'] = json.dumps(dict(path=str(path),before=before,after=after))
    rc = run(label, [node, '--import', str(ROOT/'tests/p18d_mutant_loader.mjs'), '--test', '--test-timeout=60000', 'ui/test/p18d-identities.test.js'])
    killed(label, rc, witness)
os.environ.pop('P18D_MUTATION', None)

profiles = ROOT/'daemon-adapter/internal/capsule/identity_profiles.go'
protected = '''return strings.HasPrefix(id, "cuentas-") || strings.HasPrefix(id, "perplexity-") ||
		strings.HasPrefix(id, "srf-id-cuentas-") || strings.HasPrefix(id, "srf-id-perplexity-") || strings.HasPrefix(id, "srf-pg-")'''
go_mutations = [
    ('existence-gate', '!ok || checker.IdentityExists(ctx, id) != nil', '!ok || (checker.IdentityExists(ctx, id) != nil && false)', 'TestIdentityRuntimeAdmissionAndNegativeControls'),
    ('protected-name', protected, 'return false && ('+protected[len('return '):]+')', 'TestIdentityRuntimeAdmissionAndNegativeControls'),
    ('distinct-display', '!m.displayOccupied(p.RAMRoot, display, id)', 'true', 'TestIdentityDisplayPoolDistinctReleaseAndUncertainStop'),
    ('display-release', 'delete(m.cfg.Profiles, id)', '// mutation: allocation retained', 'TestIdentityDisplayPoolDistinctReleaseAndUncertainStop'),
    ('static-display', '\t\treturn nil\n\t}\n\tif !storedIdentityID.MatchString(id)', '\t\tp.Display = ":999"\n\t\treturn nil\n\t}\n\tif !storedIdentityID.MatchString(id)', 'TestIdentityStaticProfilesRemainFixedAndSharePool'),
]
for name, before, after, witness in go_mutations:
    label = 'r2-mutant-'+name
    source = profiles.read_text()
    assert source.count(before) == 1
    target = mutants/(name+'.go')
    target.write_text(source.replace(before, after))
    overlay = mutants/(name+'.json')
    overlay.write_text(json.dumps(dict(Replace={str(profiles):str(target.resolve())})))
    rc = run(label, [go, '-C', 'daemon-adapter', 'test', '-overlay', str(overlay.resolve()), './internal/capsule', '-run', '^'+witness+'$', '-count=1'])
    killed(label, rc, '--- FAIL: '+witness)

identity = ROOT/'tools/mv_identity.py'
python_mutations = [
    ('backend-delete-lease', 'lease.get("active") is not False', 'False', 'FAIL: test_delete_active_identity'),
    ('backend-sites-normalization', 'sites != sorted(set(sites))', 'False', 'FAIL: test_empty_sites_and_normalized_sites'),
]
for name, before, after, witness in python_mutations:
    source = identity.read_text()
    assert source.count(before) == 1
    target = mutants/(name+'.py')
    target.write_text(source.replace(before, after))
    os.environ['P18D_IDENTITY_SOURCE'] = str(target.resolve())
    label = 'r2-mutant-'+name
    rc = run(label, ['python3', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_p18d_identity.py'])
    killed(label, rc, witness)
os.environ.pop('P18D_IDENTITY_SOURCE', None)
(mutants/'results.json').write_text(json.dumps(results, indent=2)+'\n')

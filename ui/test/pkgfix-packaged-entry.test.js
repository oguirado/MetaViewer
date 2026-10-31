// PKG-FIX: packaged entry guards (QC-02 SIGHUP disposal, L-01 RAM root, L-03 single
// instance, UM-02 attach pointer) exercised on the generated entry with stubbed Electron,
// plus the metaviewer.attach/v1 record with one valid and several invalid examples.
// Every guard carries a mutant that must fail the same assertion.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ATTACH_GUIDE,
  OPERATOR_RESOURCES,
  buildAttachRecord,
  preflightLiveRamRoot,
  productionEntry,
  publishAttachPointer,
  renderAttachEnv,
  retractAttachPointerSync,
  validateAttachRecord,
} from '../tools/package.js';

const SESSION = 'pkg-0f0e0d0c-0b0a-4908-8706-050403020100';

function validRecord(runtime = '/run/user/1000/mv-pkg-abc') {
  return buildAttachRecord({sessionId: SESSION, pid: 4242, runtime, configPath: join(runtime, 'config.json'), env: {
    MV_SRF_BIN_DIR: '/opt/srf/bin', MV_SRF_STATE_DIR: '/dev/shm/state', SRF_IDENTITY_STORE_ROOT: "/home/o'p/Música/ids",
    MV_SRF_LIVE_PROFILE: 'mv-live-1', MV_WENDER_ROOT: '/srv/wender', MV_OPERATOR_REPO: '/srv/mv',
    MV_SRF_LIVE_RAM_ROOT: '/dev/shm/ram', HOME: '/home/o', OPERATOR_TOKEN: '/not/exported', MV_MW_HOME: 'relative/refused',
  }});
}

test('PKG-FIX UM-02 attach record: valid example, closed env, invalid examples refused', () => {
  const record = validRecord();
  assert.equal(record.schema, 'metaviewer.attach/v1');
  assert.equal(record.boot_profile, 'mv-live-1');
  assert.equal(Object.hasOwn(record, 'live_identity'), false);
  assert.equal(record.core_socket, '/run/user/1000/mv-pkg-abc/metaviewer/core.sock');
  assert.deepEqual(Object.keys(record.env).sort(), ['MV_CORE_CONFIG', 'MV_OPERATOR_REPO', 'MV_SESSION_ID', 'MV_SRF_BIN_DIR',
    'MV_SRF_LIVE_PROFILE', 'MV_SRF_STATE_DIR', 'MV_WENDER_ROOT', 'SRF_IDENTITY_STORE_ROOT', 'XDG_RUNTIME_DIR']);
  const invalid = [
    {...record, extra: 1},
    {...record, live_identity: record.boot_profile},
    Object.fromEntries(Object.entries(record).map(([key, value]) => [key === 'boot_profile' ? 'live_identity' : key, value])),
    {...record, schema: 'metaviewer.attach/v2'},
    {...record, session_id: 'pkg-1'},
    {...record, pid: 1},
    {...record, core_socket: '/tmp/other.sock'},
    {...record, boot_profile: 'Bad Id'},
    {...record, boot_profile: null},
    {...record, env: {...record.env, MV_CORE_CONFIG: 'relative.json'}},
    {...record, env: {...record.env, MV_SRF_BIN_DIR: '/a\nexport EVIL=1'}},
    {...record, env: {...record.env, OPERATOR_TOKEN: '/x'}},
    {...record, env: {...record.env, MV_SESSION_ID: 'pkg-other'}},
    {...record, env: Object.fromEntries(Object.entries(record.env).filter(([k]) => k !== 'MV_CORE_CONFIG'))},
  ];
  for (const bad of invalid) assert.throws(() => validateAttachRecord(bad), /ATTACH_SHAPE/, JSON.stringify(bad));
  const noProfile = buildAttachRecord({sessionId: SESSION, pid: 7, runtime: '/r', configPath: '/r/config.json',
    env: {MV_SRF_LIVE_PROFILE: '../escape'}});
  assert.equal(noProfile.boot_profile, null);
  assert.equal(Object.hasOwn(noProfile.env, 'MV_SRF_LIVE_PROFILE'), false);
});

function assertIdentityGuidance(guide) {
  assert.match(guide, /boot_profile .*is the capsule profile key,\nnot an identity id/);
  assert.match(guide, /mw_run requires an identity-store id shown in Identities/);
  assert.match(guide, /tools\/mw_run_backend\.py/);
  assert.match(guide, /mw_run --identity <id shown in Identities>/);
  assert.doesNotMatch(guide, /--identity\s+["']?(?:\$\{?MV_SRF_LIVE_PROFILE\}?|mv-live-1|boot_profile)/);
  assert.doesNotMatch(guide, /pass it as --identity/);
}

test('PKG-FIX M1 attach guide uses an identity-store id, never the boot profile (with mutants)', () => {
  assertIdentityGuidance(ATTACH_GUIDE);
  for (const identity of ['"$MV_SRF_LIVE_PROFILE"', 'mv-live-1', 'boot_profile']) {
    const mutant = ATTACH_GUIDE.replace('--identity <id shown in Identities>', `--identity ${identity}`);
    assert.notEqual(mutant, ATTACH_GUIDE);
    assert.throws(() => assertIdentityGuidance(mutant), assert.AssertionError);
  }
  assert.throws(() => assertIdentityGuidance(ATTACH_GUIDE + '\npass it as --identity'), assert.AssertionError);
});

test('PKG-FIX UM-02 attach env round-trips through sh, including quotes and non-ASCII paths (with mutant)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mv-pkgfix-env-Música-'));
  try {
    const record = validRecord();
    const sourceEnv = async text => {
      await writeFile(join(dir, 'current.env'), text);
      const names = Object.keys(record.env);
      const shown = spawnSync('/bin/sh', ['-c', `. ./current.env && for n in ${names.join(' ')}; do eval "printf '%s=%s\\n' \\"$n\\" \\"\\$$n\\""; done`],
        {cwd: dir, env: {PATH: process.env.PATH}, encoding: 'utf8'});
      return shown;
    };
    const ok = await sourceEnv(renderAttachEnv(record));
    assert.equal(ok.status, 0, ok.stderr);
    for (const [name, value] of Object.entries(record.env)) assert.ok(ok.stdout.split('\n').includes(`${name}=${value}`), name);
    // Mutant: unescaped single quotes break the quoted value.
    const mutant = renderAttachEnv.toString().replace(`.replaceAll("'", "'\\\\''")`, '');
    assert.notEqual(mutant, renderAttachEnv.toString());
    const mutated = new Function('validateAttachRecord', `return (${mutant})`)(validateAttachRecord);
    const bad = await sourceEnv(mutated(record));
    assert.ok(bad.status !== 0 || !bad.stdout.includes(`SRF_IDENTITY_STORE_ROOT=${record.env.SRF_IDENTITY_STORE_ROOT}`));
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('PKG-FIX UM-02 attach pointer is owner-only, refuses unsafe dirs and is retracted only for its own session', async () => {
  const host = await mkdtemp(join(tmpdir(), 'mv-pkgfix-host-'));
  try {
    await chmod(host, 0o700);
    const record = validRecord(join(host, 'mv-pkg-x'));
    const out = await publishAttachPointer(host, record);
    assert.equal(out.env, join(host, 'metaviewer', 'attach', 'current.env'));
    assert.equal((await stat(join(host, 'metaviewer', 'attach'))).mode & 0o777, 0o700);
    for (const file of [out.json, out.env]) assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(validateAttachRecord(JSON.parse(await readFile(out.json, 'utf8'))), record);
    assert.equal(retractAttachPointerSync(host, 'pkg-00000000-0000-4000-8000-000000000000'), false);
    assert.ok(existsSync(out.json) && existsSync(out.env));
    assert.equal(retractAttachPointerSync(host, SESSION), true);
    assert.ok(!existsSync(out.json) && !existsSync(out.env));
    assert.equal(retractAttachPointerSync(null, SESSION), false);
    await chmod(join(host, 'metaviewer', 'attach'), 0o755);
    await assert.rejects(publishAttachPointer(host, record), /ATTACH_DIR_UNSAFE/);
    await rm(join(host, 'metaviewer', 'attach'), {recursive: true});
    await mkdir(join(host, 'elsewhere'), {mode: 0o700});
    await symlink(join(host, 'elsewhere'), join(host, 'metaviewer', 'attach'));
    await assert.rejects(publishAttachPointer(host, record), /ATTACH_DIR_UNSAFE/);
    await assert.rejects(publishAttachPointer('relative', record), /ATTACH_HOST_RUNTIME_REQUIRED/);
  } finally { await rm(host, {recursive: true, force: true}); }
});

test('PKG-FIX L-01 RAM-root preflight: absent, file and alias refused; present, profile map and core-only admitted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mv-pkgfix-ram-'));
  try {
    const base = {MV_SRF_BIN_DIR: '/srf'};
    const absent = await preflightLiveRamRoot({...base, MV_SRF_LIVE_RAM_ROOT: join(root, 'ram')});
    assert.equal(absent?.code, 'RAM_ROOT_ABSENT');
    assert.match(absent.line, /^METAVIEWER_BOOT_REFUSED RAM_ROOT_ABSENT: .*mkdir -p -m 700 '/);
    await writeFile(join(root, 'file'), '');
    assert.equal((await preflightLiveRamRoot({...base, MV_SRF_LIVE_RAM_ROOT: join(root, 'file')}))?.code, 'RAM_ROOT_INVALID');
    await mkdir(join(root, 'ram'), {mode: 0o700});
    await symlink(join(root, 'ram'), join(root, 'alias'));
    assert.equal((await preflightLiveRamRoot({...base, MV_SRF_LIVE_RAM_ROOT: join(root, 'alias')}))?.code, 'RAM_ROOT_INVALID');
    assert.equal(await preflightLiveRamRoot({...base, MV_SRF_LIVE_RAM_ROOT: join(root, 'ram')}), null);
    assert.equal(await preflightLiveRamRoot({...base, MV_SRF_LIVE_RAM_ROOT: join(root, 'gone'), MV_SRF_PROFILES: '{}'}), null);
    assert.equal(await preflightLiveRamRoot({MV_SRF_LIVE_RAM_ROOT: join(root, 'gone')}), null);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('PKG-FIX ID-01/L-04 operator resources stage the identity and reclaim tools and the attach guide', async () => {
  for (const relative of OPERATOR_RESOURCES) assert.ok(existsSync(new URL(`../../${relative}`, import.meta.url)), relative);
  assert.ok(OPERATOR_RESOURCES.includes('tools/mv_identity.py'));
  assert.ok(OPERATOR_RESOURCES.includes('tools/mv_ram_admission.py'));
  const source = await readFile(new URL('../tools/package.js', import.meta.url), 'utf8');
  assert.match(source, /for\(const relative of OPERATOR_RESOURCES\)/);
  assert.match(source, /join\(operatorRoot,'ATTACH\.md'\),ATTACH_GUIDE/);
  assert.match(ATTACH_GUIDE, /metaviewer\/attach\/current\.env/);
  assert.match(ATTACH_GUIDE, /cd "\$MV_OPERATOR_REPO\/agents"/);
  // The identity tool runs from resources/operator/tools: standard library only.
  const tool = await readFile(new URL('../../tools/mv_identity.py', import.meta.url), 'utf8');
  for (const line of tool.split('\n').filter(l => /^(import|from) /.test(l))) {
    assert.match(line, /^(import (argparse|fcntl|json|os|re|shutil|signal|subprocess|sys)|from (pathlib|urllib\.parse) import )/, line);
  }
});

/**
 * Run the generated entry under node with stubbed electron, child_process, main and coreLauncher.
 * @param {{source: string, env: Record<string,string>, lock?: boolean, onLine?: (line: string, child: any) => void}} o
 */
async function runEntry(o) {
  const root = await mkdtemp(join(tmpdir(), 'mv-pkgfix-entry-Música-'));
  await writeFile(join(root, 'package.json'), JSON.stringify({type: 'module'}));
  await writeFile(join(root, 'package-pin.json'), JSON.stringify({version: '0.2.0', commit: '0'.repeat(40)}));
  await writeFile(join(root, 'main.js'), `export const validateRetailLaunch=()=>({ok:true}); export const registerPrivilegedScheme=()=>{};
export const mainDirectEntry=async()=>{setInterval(()=>{},1000);return {dispose:async()=>{process.stdout.write('DISPOSED\\n');}};};`);
  await writeFile(join(root, 'coreLauncher.js'), 'export const scrubChildEnv=e=>({...e}); export const validateKillTarget=()=>false;');
  await writeFile(join(root, 'entry.js'), o.source);
  const lock = o.lock === false ? 'false' : 'true';
  const electron = `export const app={handlers:{},on(e,f){if(e==='second-instance')f();},removeAllListeners(){},exit:code=>process.exit(code),
whenReady:async()=>{},requestSingleInstanceLock:()=>${lock}};
export const BrowserWindow={getAllWindows:()=>[{isDestroyed:()=>false,isMinimized:()=>false,show(){},focus(){process.stdout.write('FOCUSED\\n');}}]};
export const protocol={};`;
  const children = `import {writeFileSync} from 'node:fs'; import {join} from 'node:path'; import {EventEmitter} from 'node:events';
export function spawn(cmd,args,opts){process.stdout.write('CORE_SPAWN\\n');writeFileSync(join(opts.env.XDG_RUNTIME_DIR,'metaviewer/core.sock'),'');
const c=new EventEmitter();c.pid=999999;c.exitCode=null;c.signalCode=null;c.stdout=new EventEmitter();c.stderr=new EventEmitter();return c;}`;
  const bootstrap = `import {registerHooks} from 'node:module'; registerHooks({resolve(s,c,next){
    const stub=s==='electron'?${JSON.stringify(electron)}:s==='node:child_process'?${JSON.stringify(children)}:null;
    return stub?{url:'data:text/javascript,'+encodeURIComponent(stub),shortCircuit:true}:next(s,c);
  }}); await import(${JSON.stringify(pathToFileURL(join(root, 'entry.js')).href)});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], {env: o.env, stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '', stderr = '';
  const killer = setTimeout(() => child.kill('SIGKILL'), 20000);
  child.stdout.on('data', b => {
    const before = stdout; stdout += b.toString('utf8');
    for (const line of stdout.slice(before.lastIndexOf('\n') + 1).split('\n').slice(0, -1)) o.onLine?.(line, child);
  });
  child.stderr.on('data', b => { stderr += b.toString('utf8'); });
  const [code, signal] = await new Promise(resolve => child.once('exit', (c, s) => resolve([c, s])));
  clearTimeout(killer);
  await rm(root, {recursive: true, force: true});
  return {code, signal, stdout, stderr};
}

const seamless = productionEntry.replace('  verifyBootSeal(appRoot);', '  /* Seal fixture: tested by package seal suites. */');

async function hostEnv() {
  const host = await mkdtemp(join(tmpdir(), 'mv-pkgfix-xdg-'));
  await chmod(host, 0o700);
  const home = join(host, 'home');
  await mkdir(home, {mode: 0o700});
  return {host, env: {XDG_RUNTIME_DIR: host, HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin', MV_PKG_BOOT_BUDGET_MS: '8000',
    MV_SRF_LIVE_PROFILE: 'mv-live-1', MV_WENDER_ROOT: '/srv/wender'}};
}

test('PKG-FIX QC-02 + UM-02 entry: attach pointer published when live, SIGHUP disposes and retracts it (with mutants)',
  {timeout: 120000}, async () => {
    const scenario = async source => {
      const {host, env} = await hostEnv();
      let seen = null;
      try {
        const result = await runEntry({source, env, onLine: (line, child) => {
          if (line.startsWith('METAVIEWER_ATTACH ')) {
            const json = join(host, 'metaviewer', 'attach', 'current.json');
            seen = existsSync(json) ? validateAttachRecord(JSON.parse(readFileSync(json, 'utf8'))) : null;
            child.kill('SIGHUP');
          }
        }});
        return {...result, seen, left: existsSync(join(host, 'metaviewer', 'attach', 'current.json'))};
      } finally { await rm(host, {recursive: true, force: true}); }
    };
    const ok = await scenario(seamless);
    assert.equal(ok.signal, null, ok.stderr);
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /^DISPOSED$/m);
    assert.ok(ok.seen, 'attach record must be readable while live');
    assert.equal(ok.seen.boot_profile, 'mv-live-1');
    assert.equal(ok.seen.env.MV_WENDER_ROOT, '/srv/wender');
    assert.equal(ok.left, false, 'attach pointer must be retracted at stop');
    assert.match(ok.stdout, /^FOCUSED$/m, 'second-instance raises the existing window');

    const noHup = seamless.replace("process.on('SIGHUP', () => {", "process.on('SIGWINCH', () => {");
    assert.notEqual(noHup, seamless);
    const hup = await scenario(noHup);
    assert.equal(hup.signal, 'SIGHUP');
    assert.doesNotMatch(hup.stdout, /DISPOSED/);

    const noRetract = seamless.replace('const retractAttach = () => { retractAttachPointerSync(attachHost, attachSession); };',
      'const retractAttach = () => {};');
    assert.notEqual(noRetract, seamless);
    assert.equal((await scenario(noRetract)).left, true);
  });

test('PKG-FIX L-01 + L-03 entry: refusals happen before any core spawn (with mutants)', {timeout: 120000}, async () => {
  const {host, env} = await hostEnv();
  try {
    const ramEnv = {...env, MV_SRF_BIN_DIR: join(host, 'srf'), MV_SRF_LIVE_RAM_ROOT: join(host, 'absent-ram')};
    const ram = await runEntry({source: seamless, env: ramEnv});
    assert.equal(ram.code, 1);
    assert.match(ram.stderr, /METAVIEWER_BOOT_REFUSED RAM_ROOT_ABSENT: MV_SRF_LIVE_RAM_ROOT .*absent-ram/);
    assert.doesNotMatch(ram.stdout, /CORE_SPAWN/);
    // A refused boot never publishes the attach pointer; checked before the mutants, which do spawn and may publish it.
    assert.equal(existsSync(join(host, 'metaviewer', 'attach', 'current.json')), false);
    const ramMutant = seamless.replace('const ramRoot = await preflightLiveRamRoot(process.env);', 'const ramRoot = null;');
    assert.notEqual(ramMutant, seamless);
    assert.match((await runEntry({source: ramMutant, env: ramEnv, onLine: (l, c) => { if (l === 'CORE_SPAWN') c.kill('SIGKILL'); }})).stdout, /CORE_SPAWN/);

    const second = await runEntry({source: seamless, env, lock: false});
    assert.equal(second.code, 1);
    assert.match(second.stderr, /METAVIEWER_BOOT_REFUSED SINGLE_INSTANCE: MetaViewer is already running/);
    assert.doesNotMatch(second.stdout, /CORE_SPAWN/);
    assert.equal(existsSync(join(host, 'metaviewer', 'attach', 'current.json')), false);
    const lockMutant = seamless.replace("if (typeof app.requestSingleInstanceLock === 'function') {", 'if (false) {');
    assert.notEqual(lockMutant, seamless);
    assert.match((await runEntry({source: lockMutant, env, lock: false, onLine: (l, c) => { if (l === 'CORE_SPAWN') c.kill('SIGKILL'); }})).stdout, /CORE_SPAWN/);
  } finally { await rm(host, {recursive: true, force: true}); }
});

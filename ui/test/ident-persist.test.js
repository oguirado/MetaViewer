import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createOperatorService, identityEnvironment, identityRunner, installOperatorBridge, resolveIdentityTool } from '../electron/operatorBridge.js';

const TOOL = fileURLToPath(new URL('../../tools/mv_identity.py', import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(check, what) {
  for (let i = 0; i < 200; i++) { if (check()) return; await sleep(25); }
  assert.fail(`timed out waiting for ${what}`);
}

// Fake native binaries: only they touch profile payloads, as at the real boundary.
const NATIVE = String.raw`#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
a = sys.argv[1:]
def arg(k): return a[a.index(k)+1]
root = Path(arg('--store-root')); verb = a[0]
identity = arg('--id') if '--id' in a else (arg('--identity') if '--identity' in a else None)
container = arg('--container') if '--container' in a else None
if container:
    identity = [p.stem for p in (root/'locks').glob('*.json') if json.loads(p.read_text()).get('holder') == container][0]
meta = root/'metadata'/(identity+'.json') if identity else None
profile = root/'profiles'/identity if identity else None
lock = root/'locks'/(identity+'.json') if identity else None
if verb == 'create':
    for d in ('metadata', 'profiles', 'locks'): (root/d).mkdir(mode=0o700, parents=True, exist_ok=True)
    root.chmod(0o700)
    if meta.exists(): sys.exit(4)
    profile.mkdir(mode=0o700)
    meta.write_text(json.dumps(dict(profile_id=identity, account_label=arg('--label'), allowed_domains=arg('--domains').split(','), created_unix=1)))
    meta.chmod(0o600)
elif verb == 'start':
    if not profile.is_dir(): sys.exit(4)
    if lock.exists() and json.loads(lock.read_text())['active']: sys.exit(6)
    holder = arg('--capsule')
    lock.write_text(json.dumps(dict(active=True, holder=holder))); lock.chmod(0o600)
    print(json.dumps(dict(container=holder, profile_inode=profile.stat().st_ino))); sys.exit(0)
elif verb == 'login':
    (profile/'fake-session').write_bytes(b'HOSTED-SESSION-FIXTURE')
    print(json.dumps(dict(url='http://127.0.0.1:12345/'))); sys.exit(0)
elif verb == 'view-stop':
    print(json.dumps(dict(stopped_view=container))); sys.exit(0)
elif verb == 'stop':
    lock.write_text(json.dumps(dict(active=False))); lock.chmod(0o600); sys.exit(0)
print(meta.read_text())
`;

/** Launcher-like world: a fresh scrubbed environment with no MV_MW_HOME. */
function world(t) {
  const base = mkdtempSync(join(tmpdir(), 'mv-ident-Música-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dirs = Object.fromEntries(['bin', 'state', 'home'].map(n => [n, join(base, n)]));
  for (const d of Object.values(dirs)) mkdirSync(d, { mode: 0o700 });
  for (const name of ['srf-identity-admin', 'srf-identity-surface']) writeFileSync(join(dirs.bin, name), NATIVE, { mode: 0o700 });
  const store = join(base, 'store');
  const env = { PATH: process.env.PATH, HOME: dirs.home, MV_SRF_BIN_DIR: dirs.bin, MV_SRF_STATE_DIR: dirs.state, SRF_IDENTITY_STORE_ROOT: store, TMPDIR: base };
  return { base, store, env, dirs };
}
const service = (env, opened = []) => createOperatorService({ env, runIdentity: identityRunner({ tool: TOOL, env: identityEnvironment(env, TOOL), openLogin: url => { opened.push(url); } }) });

test('IDENT-ENV: MV_MW_HOME defaults beside the tool checkout and an explicit value wins', () => {
  assert.equal(identityEnvironment({}, '/opt/mv/tools/mv_identity.py').MV_MW_HOME, '/opt/mv/memoryweb');
  assert.equal(identityEnvironment({ MV_MW_HOME: '/srv/mw' }, '/opt/mv/tools/mv_identity.py').MV_MW_HOME, '/srv/mw');
  assert.equal(identityEnvironment({}, 'relative/tool.py').MV_MW_HOME, undefined);
});

test('IDENT-TOOL: bundled tool preferred, operator checkout is the packaged fallback, unsafe repos ignored', () => {
  const present = new Set(['/res/tools/mv_identity.py', '/op/tools/mv_identity.py']);
  const exists = p => present.has(p);
  assert.equal(resolveIdentityTool({ tool: '/res/tools/mv_identity.py', env: { MV_OPERATOR_REPO: '/op' }, exists }), '/res/tools/mv_identity.py');
  present.delete('/res/tools/mv_identity.py');
  assert.equal(resolveIdentityTool({ tool: '/res/tools/mv_identity.py', env: { MV_OPERATOR_REPO: '/op' }, exists }), '/op/tools/mv_identity.py');
  for (const MV_OPERATOR_REPO of [undefined, '', 'op', '/op/', '/op/../op', '/nowhere'])
    assert.equal(resolveIdentityTool({ tool: '/res/tools/mv_identity.py', env: { MV_OPERATOR_REPO }, exists }), '/res/tools/mv_identity.py', String(MV_OPERATOR_REPO));
});

const ids = rows => rows.map(r => r.id);
const nativeRun = (w, verb, ...args) => spawnSync(join(w.dirs.bin, 'srf-identity-surface'), [verb, ...args, '--store-root', w.store], { encoding: 'utf8' });

test('IDENT-PERSIST: create, host restart, login, restart again and delete keep one identity store', async t => {
  const w = world(t), opened = [];
  const created = await service(w.env, opened).request('identity.create', [{ id: 'account-a', label: 'Account A', domains: ['example.com'] }]);
  assert.deepEqual(created, { ok: true, rows: [{ id: 'account-a', label: 'Account A', domains: ['example.com'], logged_in: 'unknown' }] });
  // Host restart: every object is rebuilt from the same scrubbed environment.
  const listed = await service(w.env, opened).request('identity.list', []);
  assert.deepEqual(listed.rows, created.rows);
  assert.deepEqual(await service(w.env, opened).request('identity.login', [{ id: 'account-a' }]), { ok: true });
  assert.deepEqual(opened, ['http://127.0.0.1:12345/']);
  assert.equal(readFileSync(join(w.store, 'profiles/account-a/fake-session'), 'utf8'), 'HOSTED-SESSION-FIXTURE');
  const again = await service(w.env, opened).request('identity.list', []);
  assert.deepEqual(ids(again.rows), ['account-a']);
  assert.equal((await service(w.env, opened).request('identity.show', [{ id: 'account-a' }])).rows[0].label, 'Account A');
  // The capsule lease is still active: delete is a typed refusal, not a generic failure.
  assert.deepEqual(await service(w.env).request('identity.delete', [{ id: 'account-a' }]), { ok: false, code: 'IDENTITY_REFUSED' });
  assert.equal(nativeRun(w, 'stop', '--container', 'srf-id-account-a').status, 0);
  assert.deepEqual(await service(w.env).request('identity.delete', [{ id: 'account-a' }]), { ok: true });
  assert.deepEqual((await service(w.env).request('identity.list', [])).rows, []);
});

test('IDENT-TYPED: refusals, missing configuration and a missing tool are distinct typed codes', async t => {
  const w = world(t), create = { id: 'account-a', label: 'Account A', domains: ['example.com'] };
  assert.equal((await service(w.env).request('identity.create', [create])).ok, true);
  assert.deepEqual(await service(w.env).request('identity.create', [create]), { ok: false, code: 'IDENTITY_REFUSED' }, 'native refusal of a duplicate id');
  assert.deepEqual(await service(w.env).request('identity.show', [{ id: 'account-z' }]), { ok: false, code: 'IDENTITY_REFUSED' }, 'unknown identity');
  const { SRF_IDENTITY_STORE_ROOT, ...noStore } = w.env;
  assert.deepEqual(await service(noStore).request('identity.list', []), { ok: false, code: 'IDENTITY_UNAVAILABLE' }, 'store root not configured');
  const missing = createOperatorService({ env: w.env, runIdentity: identityRunner({ tool: join(w.base, 'absent/mv_identity.py'), env: w.env }) });
  assert.deepEqual(await missing.request('identity.list', []), { ok: false, code: 'IDENTITY_UNAVAILABLE' }, 'tool file absent');
});

// Fake login tool: python's default SIGTERM skips `finally`, SIGINT runs it
// (KeyboardInterrupt), exactly like the real tool's login-pending reservation.
const LOGIN_TOOL = String.raw`
import os, sys, time
from pathlib import Path
pending = Path(os.environ['TMPDIR']) / 'login.pending'
pending.write_text('reserved')
try:
    print('Operator login view: http://127.0.0.1:1/ (close with Ctrl+C or native view-stop)', file=sys.stderr, flush=True)
    time.sleep(60)
finally:
    pending.unlink()
`;
function loginWorld(t) {
  const w = world(t), tool = join(w.base, 'fake_login.py');
  writeFileSync(tool, LOGIN_TOOL);
  return { ...w, tool, pending: join(w.base, 'login.pending') };
}

test('IDENT-LOGIN-STOP: a failed login view releases the reservation instead of leaving it stale', async t => {
  const w = loginWorld(t);
  const run = identityRunner({ tool: w.tool, env: w.env, openLogin: async () => { throw new Error('no browser'); } });
  await assert.rejects(run('login', { id: 'account-a' }), /LOGIN_VIEW/);
  await until(() => !existsSync(w.pending), 'login-pending cleanup');
});

test('IDENT-LOGIN-STOP: app teardown stops an open login through the same cleanup path', async t => {
  const w = loginWorld(t);
  let shown;
  const open = new Promise(r => { shown = r; });
  const run = identityRunner({ tool: w.tool, env: w.env, openLogin: url => shown(url) });
  const login = run('login', { id: 'account-a' });
  const settled = assert.rejects(login, /IDENTITY_EXIT/);
  await open;
  assert.equal(existsSync(w.pending), true);
  run.dispose();
  await settled;
  await until(() => !existsSync(w.pending), 'login-pending cleanup after dispose');
});

test('IDENT-LOGIN-STOP control: SIGTERM, the previous stop signal, leaves the reservation behind', async t => {
  const w = loginWorld(t);
  const child = spawn('python3', [w.tool], { env: w.env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  const closed = new Promise(r => child.once('close', r));
  await new Promise(r => child.stderr.once('data', r));
  process.kill(-child.pid, 'SIGTERM');
  await closed;
  assert.equal(existsSync(w.pending), true, 'the fake tool really is SIGTERM-fragile, so the SIGINT tests discriminate');
});

function wiring(t, extra) {
  const handlers = new Map(), spawned = [];
  const spawnTool = (exe, argv, options) => {
    spawned.push({ exe, argv, env: options.env });
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    process.nextTick(() => { child.stdout.write(JSON.stringify({ schema: 'metaviewer.identity/v1', ok: true, result: [] })); child.emit('close', 0); });
    return child;
  };
  const bridge = installOperatorBridge({ ipcMain: { handle: (c, h) => handlers.set(c, h), removeHandler: c => handlers.delete(c) }, contents: { send() {} },
    admit: () => true, buttons: { request: async () => ({ ok: true }), dispose() {} }, spawnTool, ...extra });
  t.after(() => bridge.dispose());
  return { handlers, spawned, bridge };
}

test('IDENT-WIRING: the packaged bridge falls back to the operator checkout and defaults MV_MW_HOME beside it', async t => {
  const repo = mkdtempSync(join(tmpdir(), 'mv-ident-repo-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  mkdirSync(join(repo, 'tools')); writeFileSync(join(repo, 'tools/mv_identity.py'), '');
  const env = { PATH: '/usr/bin', MV_OPERATOR_REPO: repo, SECRET: 'forbidden' };
  const { handlers, spawned } = wiring(t, { env, tool: join(repo, 'absent/resources/tools/mv_identity.py') });
  assert.deepEqual(await handlers.get('metaviewer:identity.list')('w'), { ok: true, rows: [] });
  assert.equal(spawned[0].argv[0], join(repo, 'tools/mv_identity.py'));
  assert.deepEqual(spawned[0].env, { PATH: '/usr/bin', MV_MW_HOME: join(repo, 'memoryweb') });
});

test('IDENT-WIRING: bridge teardown stops in-flight identity children', async t => {
  let disposed = 0;
  const runIdentity = Object.assign(async () => ({ ok: true, rows: [] }), { dispose: () => { disposed++; } });
  const { bridge } = wiring(t, { env: {}, tool: 'unused', runIdentity });
  await bridge.dispose();
  assert.equal(disposed, 1);
});

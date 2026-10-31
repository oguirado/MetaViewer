import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { parse, compileScript } from '@vue/compiler-sfc';
import * as vue from 'vue';
import { createOperatorService, identityEnvironment, identityRunner, installOperatorBridge, resolveIdentityTool, toolRefusedCode } from '../electron/operatorBridge.js';
import { assertOperatorReply, createOperatorFacade } from '../electron/preload.js';
import { identityErrorText } from '../src/identities/identityForm.js';

const TOOL = fileURLToPath(new URL('../../tools/mv_identity.py', import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(check, what) {
  for (let i = 0; i < 200; i++) { if (check()) return; await sleep(25); }
  assert.fail(`timed out waiting for ${what}`);
}

/** Launcher-like tool wrapper: swaps only the host-incompatible uid 10001 check
 * for the fake native process's uid. Because NATIVE `create` leaves profiles/<id>
 * mode 0o750 (unprovisioned), login still refuses with PROFILE_NOT_PROVISIONED
 * until the explicit provisionProfile() step runs. */
function provisionedTool(base) {
  const wrapper = join(base, 'mv_identity_provisioned.py');
  writeFileSync(wrapper, `#!/usr/bin/env python3\nimport importlib.util as u, os, sys\n` +
    `s = u.spec_from_file_location('m', ${JSON.stringify(TOOL)})\n` +
    `m = u.module_from_spec(s); s.loader.exec_module(m)\n` +
    `m.NATIVE_PROFILE_UID = os.getuid()\nsys.exit(m.main(sys.argv[1:]))\n`, { mode: 0o700 });
  return wrapper;
}

// Fake native binaries: `create` leaves profiles/<id> mode 0o750 (unprovisioned,
// modeling operator ownership before the one-time host provisioning command), and
// `start` enforces mode 0o700. No profile payload files are written or read.
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
    profile.mkdir(mode=0o750)
    profile.chmod(0o750)
    meta.write_text(json.dumps(dict(profile_id=identity, account_label=arg('--label'), allowed_domains=arg('--domains').split(','), created_unix=1)))
    meta.chmod(0o600)
elif verb == 'start':
    if not profile.is_dir() or (profile.stat().st_mode & 0o777) != 0o700: sys.exit(4)
    if lock.exists() and json.loads(lock.read_text())['active']: sys.exit(6)
    holder = arg('--capsule')
    lock.write_text(json.dumps(dict(active=True, holder=holder))); lock.chmod(0o600)
    print(json.dumps(dict(container=holder, profile_inode=profile.stat().st_ino))); sys.exit(0)
elif verb == 'login':
    row = json.loads(meta.read_text()); row['last_login_unix'] = 1
    meta.write_text(json.dumps(row)); meta.chmod(0o600)
    print(json.dumps(dict(url='http://127.0.0.1:12345/'))); sys.exit(0)
elif verb == 'view-stop':
    print(json.dumps(dict(stopped_view=container))); sys.exit(0)
elif verb == 'stop':
    lock.write_text(json.dumps(dict(active=False))); lock.chmod(0o600); sys.exit(0)
print(meta.read_text())
`;

/** One-time operator provisioning step corresponding to:
 * sudo install -d -m 0700 -o 10001 -g 10001 "$SRF_IDENTITY_STORE_ROOT/profiles/<id>" */
function provisionProfile(w, id) {
  const dir = join(w.store, 'profiles', id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

function statusOf(w, id) {
  const out = spawnSync('python3', [w.tool, 'status', '--id', id], { env: identityEnvironment(w.env, TOOL), encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  return JSON.parse(out.stdout).result;
}

/** Launcher-like world: a fresh scrubbed environment with no MV_MW_HOME. */
function world(t, { provisioned = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'mv-ident-Música-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dirs = Object.fromEntries(['bin', 'state', 'home'].map(n => [n, join(base, n)]));
  for (const d of Object.values(dirs)) mkdirSync(d, { mode: 0o700 });
  for (const name of ['srf-identity-admin', 'srf-identity-surface']) writeFileSync(join(dirs.bin, name), NATIVE, { mode: 0o700 });
  const store = join(base, 'store');
  const tool = provisioned ? provisionedTool(base) : TOOL;
  const env = { PATH: process.env.PATH, HOME: dirs.home, MV_SRF_BIN_DIR: dirs.bin, MV_SRF_STATE_DIR: dirs.state, SRF_IDENTITY_STORE_ROOT: store, TMPDIR: base };
  return { base, store, env, dirs, tool };
}
const service = (env, opened = [], tool = TOOL) => createOperatorService({ env, runIdentity: identityRunner({ tool, env: identityEnvironment(env, TOOL), openLogin: url => { opened.push(url); } }) });

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

test('IDENT-PERSIST: create, provision, host restart, login, restart again and delete keep one identity store', async t => {
  const w = world(t), opened = [];
  const created = await service(w.env, opened, w.tool).request('identity.create', [{ id: 'account-a', label: 'Account A', domains: ['example.com'] }]);
  assert.deepEqual(created, { ok: true, rows: [{ id: 'account-a', label: 'Account A', domains: ['example.com'], logged_in: 'unknown' }] });
  assert.deepEqual(statusOf(w, 'account-a'), { profile_id: 'account-a', provisioned: false, lease: 'absent', login_pending: 'none', login_recorded: 'no' });
  // Without the one-time operator provisioning step, login is refused with PROFILE_NOT_PROVISIONED.
  assert.deepEqual(await service(w.env, opened, w.tool).request('identity.login', [{ id: 'account-a' }]), { ok: false, code: 'PROFILE_NOT_PROVISIONED' });
  assert.deepEqual(opened, []);
  provisionProfile(w, 'account-a');
  assert.equal(statusOf(w, 'account-a').provisioned, true);
  // Host restart: every object is rebuilt from the same scrubbed environment.
  const listed = await service(w.env, opened, w.tool).request('identity.list', []);
  assert.deepEqual(listed.rows, created.rows);
  assert.deepEqual(await service(w.env, opened, w.tool).request('identity.login', [{ id: 'account-a' }]), { ok: true });
  assert.deepEqual(opened, ['http://127.0.0.1:12345/']);
  assert.deepEqual(statusOf(w, 'account-a'), { profile_id: 'account-a', provisioned: true, lease: 'active', login_pending: 'none', login_recorded: 'yes' });
  const again = await service(w.env, opened, w.tool).request('identity.list', []);
  assert.deepEqual(ids(again.rows), ['account-a']);
  assert.equal((await service(w.env, opened, w.tool).request('identity.show', [{ id: 'account-a' }])).rows[0].label, 'Account A');
  // The capsule lease is still active: delete is a typed refusal, not a generic failure.
  assert.deepEqual(await service(w.env, [], w.tool).request('identity.delete', [{ id: 'account-a' }]), { ok: false, code: 'IDENTITY_REFUSED' });
  assert.equal(nativeRun(w, 'stop', '--container', 'srf-id-account-a').status, 0);
  assert.deepEqual(await service(w.env, [], w.tool).request('identity.delete', [{ id: 'account-a' }]), { ok: true });
  assert.deepEqual((await service(w.env, [], w.tool).request('identity.list', [])).rows, []);
});

test('IDENT-TYPED: specific provisioning refusals, generic refusals, missing configuration and missing tool are distinct typed codes', async t => {
  const w = world(t, { provisioned: false }), create = { id: 'account-a', label: 'Account A', domains: ['example.com'] };
  assert.equal((await service(w.env).request('identity.create', [create])).ok, true);
  assert.deepEqual(await service(w.env).request('identity.create', [create]), { ok: false, code: 'IDENTITY_REFUSED' }, 'native refusal of a duplicate id');
  assert.deepEqual(await service(w.env).request('identity.create', [{ id: 'mv-live-1', label: 'Live', domains: ['example.com'] }]), { ok: false, code: 'IDENTITY_REFUSED' }, 'reserved id still maps to IDENTITY_REFUSED');
  assert.deepEqual(await service(w.env).request('identity.show', [{ id: 'account-z' }]), { ok: false, code: 'IDENTITY_REFUSED' }, 'unknown identity');
  // Unprovisioned identity login (owned by test uid instead of native uid 10001) refuses before native start with PROFILE_NOT_PROVISIONED.
  const unprovisioned = spawnSync('python3', [TOOL, 'login', '--id', 'account-a'], { env: identityEnvironment(w.env, TOOL), encoding: 'utf8' });
  assert.equal(unprovisioned.status, 6);
  assert.equal(toolRefusedCode(unprovisioned.stdout), 'PROFILE_NOT_PROVISIONED');
  assert.deepEqual(await service(w.env).request('identity.login', [{ id: 'account-a' }]), { ok: false, code: 'PROFILE_NOT_PROVISIONED' }, 'unprovisioned profile surfaces PROFILE_NOT_PROVISIONED');
  rmSync(join(w.store, 'profiles/account-a'), { recursive: true, force: true });
  const missingProfile = spawnSync('python3', [TOOL, 'login', '--id', 'account-a'], { env: identityEnvironment(w.env, TOOL), encoding: 'utf8' });
  assert.equal(missingProfile.status, 6);
  assert.equal(toolRefusedCode(missingProfile.stdout), 'PROFILE_MISSING');
  assert.deepEqual(await service(w.env).request('identity.login', [{ id: 'account-a' }]), { ok: false, code: 'PROFILE_MISSING' }, 'missing profile directory surfaces PROFILE_MISSING');
  const { SRF_IDENTITY_STORE_ROOT, ...noStore } = w.env;
  assert.deepEqual(await service(noStore).request('identity.list', []), { ok: false, code: 'IDENTITY_UNAVAILABLE' }, 'store root not configured');
  const missing = createOperatorService({ env: w.env, runIdentity: identityRunner({ tool: join(w.base, 'absent/mv_identity.py'), env: w.env }) });
  assert.deepEqual(await missing.request('identity.list', []), { ok: false, code: 'IDENTITY_UNAVAILABLE' }, 'tool file absent');
});

const tick = async () => { await new Promise(r => setImmediate(r)); await vue.nextTick(); };
const Button = vue.defineComponent({ props: ['label', 'disabled'], emits: ['click'], setup: (p, { emit }) => () => vue.h('button', { disabled: p.disabled, onClick: () => emit('click') }, p.label) });
const Input = vue.defineComponent({ props: ['label', 'modelValue'], emits: ['update:modelValue'], setup: (p, { emit }) => () => vue.h('input', { 'aria-label': p.label, value: p.modelValue, onInput: e => emit('update:modelValue', e.target.value) }) });
const Dialog = vue.defineComponent({ props: ['open', 'title', 'confirmLabel', 'backLabel', 'busy', 'confirmDisabled'], emits: ['confirm', 'back'], setup: (p, { emit, slots }) => () => p.open ? vue.h('section', { 'aria-label': p.title }, [...(slots.default?.() ?? []), vue.h('button', { disabled: p.busy || p.confirmDisabled, onClick: () => emit('confirm') }, p.confirmLabel)]) : null });
let dialogSerial = 0;
async function loadIdentitiesDialog() {
  const url = new URL('../src/identities/IdentitiesDialog.vue', import.meta.url), { descriptor } = parse(readFileSync(url, 'utf8'));
  const built = compileScript(descriptor, { id: 'identpersistdlg', inlineTemplate: true });
  globalThis.__identPersistDialog = { UiButton: Button, UiTextInput: Input, Dialog };
  const require = createRequire(import.meta.url);
  const code = built.content.replace(/^import\s+([^\n]+?)\s+from\s+(['"])(.*?)\2;?/gm, (_all, binding, _q, spec) => {
    if (spec === 'capsule-ui-kit/ui') return `const ${binding}=globalThis.__identPersistDialog;`;
    if (spec.endsWith('.vue')) return `const ${binding}=globalThis.__identPersistDialog.Dialog;`;
    return `import ${binding} from ${JSON.stringify(spec === 'vue' ? pathToFileURL(require.resolve('vue')).href : new URL(spec, url).href)};`;
  });
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${dialogSerial++}`)).default;
}
function mountDialog(Component, props) {
  const remove = child => {
    const list = child?.parent?.children;
    if (list) { const at = list.indexOf(child); if (at >= 0) list.splice(at, 1); }
    if (child) child.parent = null;
  };
  const renderer = vue.createRenderer({ createElement: tag => ({ tag, props: {}, children: [], parent: null }), createText: text => ({ text, parent: null }), createComment: text => ({ text, parent: null }),
    insert(child, parent, anchor) { if (child.parent) remove(child); child.parent = parent; const at = anchor ? parent.children.indexOf(anchor) : -1; parent.children.splice(at < 0 ? parent.children.length : at, 0, child); },
    remove,
    setText(n, text) { n.text = text; }, setElementText(n, text) { n.text = text; n.children = []; }, patchProp(n, k, _o, value) { n.props[k] = value; },
    parentNode: n => n?.parent ?? null, nextSibling: n => { const list = n?.parent?.children; if (!list) return null; const at = list.indexOf(n); return at >= 0 ? (list[at + 1] ?? null) : null; }, setScopeId() {} });
  const root = { children: [], parent: null }, app = renderer.createApp(Component, props); app.mount(root); return { root, close: () => app.unmount() };
}
const allNodes = n => [n, ...(n.children ?? []).flatMap(allNodes)];
const allText = n => (n.text ?? '') + (n.children ?? []).map(allText).join(' ');

test('IDENT-E2E-PROVISION-AND-MUTANTS: renderer dialog -> preload -> bridge -> tool covers unprovisioned refusal, missing refusal, provisioned login, and mutants', async t => {
  const w = world(t), opened = [];
  const svc = service(w.env, opened, w.tool);
  const host = createOperatorFacade({ nested: false, invoke: (channel, args) => svc.request(channel.replace(/^metaviewer:/, ''), args) });
  const view = mountDialog(await loadIdentitiesDialog(), { open: true, host });
  t.after(view.close);
  await tick();

  // 1. Create identity in the dialog once the initial list call settles.
  for (const [name, value] of [['Identity id', 'account-a'], ['Account label', 'Account A'], ['Domains (comma separated)', 'example.com']]) {
    allNodes(view.root).find(n => n.props?.['aria-label'] === name).props.onInput({ target: { value } });
  }
  const createBtn = () => allNodes(view.root).find(n => n.tag === 'button' && n.text === 'Create identity');
  await until(() => createBtn() && !createBtn().props.disabled, 'create button enabled after initial list');
  createBtn().props.onClick();
  await until(() => allText(view.root).includes('Account A (account-a)'), 'created row in dialog');

  // 2. Mutant 1 (provisioning skipped -> login refused): clicking Log in before provisioning surfaces PROFILE_NOT_PROVISIONED and the exact operator command.
  const loginButton = () => allNodes(view.root).find(n => n.tag === 'button' && n.text === 'Log in');
  await until(() => loginButton() && !loginButton().props.disabled, 'login button enabled');
  loginButton().props.onClick();
  await until(() => allText(view.root).includes('PROFILE_NOT_PROVISIONED'), 'PROFILE_NOT_PROVISIONED in renderer alert');
  assert.match(allText(view.root), /profiles\/<id>.*0700.*uid 10001.*sudo install -d -m 0700 -o 10001 -g 10001 "\$SRF_IDENTITY_STORE_ROOT\/profiles\/account-a".*docs\/INSTALL\.md#identity-store/);
  assert.deepEqual(opened, []);

  // 3. Removing profiles/<id> surfaces PROFILE_MISSING to the renderer dialog.
  await until(() => !loginButton().props.disabled, 'login button idle after unprovisioned refusal');
  rmSync(join(w.store, 'profiles/account-a'), { recursive: true, force: true });
  loginButton().props.onClick();
  await until(() => allText(view.root).includes('PROFILE_MISSING'), 'PROFILE_MISSING in renderer alert');
  assert.match(allText(view.root), /PROFILE_MISSING.*sudo install -d -m 0700 -o 10001 -g 10001 "\$SRF_IDENTITY_STORE_ROOT\/profiles\/account-a".*docs\/INSTALL\.md#identity-store/);

  // 4. Running the one-time operator provisioning step lets Log in succeed end to end.
  await until(() => !loginButton().props.disabled, 'login button idle after missing refusal');
  provisionProfile(w, 'account-a');
  loginButton().props.onClick();
  await until(() => opened.length === 1 && !loginButton().props.disabled, 'login view opened and settled after provisioning');
  await tick();
  assert.deepEqual(opened, ['http://127.0.0.1:12345/']);
  assert.equal(allNodes(view.root).find(n => n.props?.role === 'alert'), undefined);

  // 5. Mutant 2 (allowlist reverted -> generic code / preload rejection, and closed allowlist check):
  for (const code of ['PROFILE_NOT_PROVISIONED', 'PROFILE_MISSING']) {
    assert.deepEqual(assertOperatorReply('identity.login', { ok: false, code }), { ok: false, code });
    const msg = identityErrorText(code);
    assert.match(msg, new RegExp(`${code}.*profiles/<id>.*0700.*uid 10001.*sudo install -d -m 0700 -o 10001 -g 10001 "\\$SRF_IDENTITY_STORE_ROOT/profiles/<id>".*docs/INSTALL\\.md#identity-store`));
  }
  for (const unlisted of ['RESERVED_ID', 'IDENTITY_BOUND', 'LOGIN_IN_PROGRESS', 'UNKNOWN_REFUSAL']) {
    assert.equal(toolRefusedCode(JSON.stringify({ schema: 'metaviewer.identity/v1', ok: false, error: unlisted })), 'IDENTITY_REFUSED');
    assert.throws(() => assertOperatorReply('identity.login', { ok: false, code: unlisted }), /OPERATOR_REPLY/);
  }
  // Mutant: reverting the bridge mapping or preload allowlist to generic IDENTITY_REFUSED fails the specific-code and command contract.
  const revertedAllowlist = new Set(['IDENTITY_UNAVAILABLE', 'IDENTITY_REFUSED', 'NET_EGRESS_IO', 'NET_EGRESS_INVALID', 'NET_PROXIED_UNSUPPORTED', 'NET_OPEN_PREREQ', 'HANDOFF_UNAVAILABLE']);
  const revertedBridgeCode = raw => (raw ? 'IDENTITY_REFUSED' : 'IDENTITY_UNAVAILABLE');
  assert.throws(() => {
    const reply = { ok: false, code: 'PROFILE_NOT_PROVISIONED' };
    assert.equal(revertedAllowlist.has(reply.code), true, 'reverted allowlist rejects PROFILE_NOT_PROVISIONED');
  }, /reverted allowlist rejects PROFILE_NOT_PROVISIONED/);
  assert.throws(() => {
    const code = revertedBridgeCode(toolRefusedCode(JSON.stringify({ schema: 'metaviewer.identity/v1', ok: false, error: 'PROFILE_NOT_PROVISIONED' })));
    assert.equal(code, 'PROFILE_NOT_PROVISIONED');
  });
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

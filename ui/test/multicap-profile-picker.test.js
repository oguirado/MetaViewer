/**
 * MULTI-CAPSULE suite: profile picker behavior, renderer copy and mutant evidence.
 *
 * Plain Node (`node --test`): no Electron, no network, no identity store. All
 * inputs are injected; the mutant leg writes mutated copies of the module into
 * a private temporary directory and requires the probe set to fail on each.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as picker from '../electron/profilePicker.js';
import { buildFirstSurfaceCreateRequest } from '../electron/main.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = join(HERE, '../electron/profilePicker.js');
const source = () => readFileSync(SOURCE_PATH, 'utf8');

/** @param {string[]} ids @param {Record<string, unknown>} [over] */
const profileMap = (ids, over = {}) => JSON.stringify(Object.fromEntries(ids.map((id) => [id, {
  Kind: 'browser', NativeKind: 'browser', RAMRoot: '/dev/shm/vqa-ramws/opensuperficies/os-cu-0',
  Display: ':100', Width: 1280, Height: 900, TextInput: 'paste', ...over,
}])));
const four = ['mv-live-1', 'mv-live-2', 'mv-live-3', 'mv-live-4'];
const envFor = (ids, extra = {}) => ({ MV_SRF_PROFILES: profileMap(ids), MV_SRF_LIVE_PROFILE: ids[0], ...extra });
const surf = (profile_id, state = 'active') => ({ surface_id: `s-${profile_id}`, profile_id, state });

/**
 * Probe set shared by the real module and every mutant: returns the names of
 * the failed probes instead of throwing, so a mutant is "killed" by any failure.
 * @param {typeof picker} m
 * @returns {Promise<string[]>}
 */
async function probes(m) {
  const failed = [];
  const check = async (name, fn) => {
    try { if ((await fn()) !== true) failed.push(name); } catch { failed.push(name); }
  };
  const ids = new Set(four);
  await check('limit-at-4', () => {
    const r = m.pickProfile({ env: envFor(['a', 'b', 'c', 'd', 'e', 'f']), live: 4, bound: new Set(['a', 'b', 'c', 'd']), identities: new Set(['e', 'f']) });
    return r.ok === false && r.code === 'CAPSULE_LIMIT_REACHED';
  });
  await check('allow-at-3', () => {
    const r = m.pickProfile({ env: envFor(four), live: 3, bound: new Set(four.slice(0, 3)), identities: ids });
    return r.ok === true && r.profile_id === 'mv-live-4';
  });
  await check('max-constant', () => m.MAX_CAPSULES === 4);
  await check('skip-bound', () => {
    const r = m.pickProfile({ env: envFor(four), live: 1, bound: new Set(['mv-live-1']), identities: ids });
    return r.ok === true && r.profile_id === 'mv-live-2';
  });
  await check('no-free-profile', () => {
    const r = m.pickProfile({ env: envFor(four.slice(0, 2)), live: 2, bound: new Set(four.slice(0, 2)), identities: ids });
    return r.ok === false && r.code === 'NO_FREE_PROFILE' && r.configured === 2;
  });
  await check('identity-required', () => {
    const r = m.pickProfile({ env: envFor(four), live: 1, bound: new Set(['mv-live-1']), identities: new Set(['mv-live-1']) });
    return r.ok === false && r.code === 'NO_IDENTITY' && r.missing.join() === 'mv-live-2,mv-live-3,mv-live-4';
  });
  await check('identity-skip-to-next', () => {
    const r = m.pickProfile({ env: envFor(four), live: 1, bound: new Set(['mv-live-1']), identities: new Set(['mv-live-1', 'mv-live-3']) });
    return r.ok === true && r.profile_id === 'mv-live-3';
  });
  await check('identity-unknown-fails-closed', () => {
    const r = m.pickProfile({ env: envFor(four), live: 0, bound: new Set(), identities: null });
    return r.ok === false && r.code === 'IDENTITY_LIST_UNAVAILABLE';
  });
  await check('preferred-first', () => {
    const r = m.pickProfile({ env: { ...envFor(four), MV_SRF_LIVE_PROFILE: 'mv-live-3' }, live: 0, bound: new Set(), identities: ids });
    return r.ok === true && r.profile_id === 'mv-live-3';
  });
  await check('browser-only', () => {
    const env = { MV_SRF_PROFILES: JSON.stringify({ vm1: { Kind: 'vm' }, 'mv-live-2': { Kind: 'browser' } }) };
    const r = m.pickProfile({ env, live: 0, bound: new Set(), identities: new Set(['vm1', 'mv-live-2']) });
    return r.ok === true && r.profile_id === 'mv-live-2';
  });
  await check('surface-count-without-profile', () => {
    const s = m.summarizeSurfaces([{ state: 'active' }, surf('mv-live-1')]);
    return s.live === 2 && s.bound.size === 1;
  });
  await check('destroyed-not-live', () => {
    const s = m.summarizeSurfaces(new Map([['a', surf('mv-live-1', 'destroyed')], ['b', surf('mv-live-2', 'lost')], ['c', surf('mv-live-3')]]));
    return s.live === 1 && s.bound.has('mv-live-3') && !s.bound.has('mv-live-1');
  });
  await check('identity-ids-closed', () => {
    const s = m.identityIds([{ id: 'mv-live-2', label: 'x', domains: ['a'] }, { id: '../x' }, { id: 7 }, null]);
    return s.size === 1 && s.has('mv-live-2');
  });
  await check('list-ok-required', async () => {
    const r = await m.pickCreateRequest({ env: envFor(four), surfaces: [], listIdentities: async () => ({ ok: false, rows: [{ id: 'mv-live-1' }] }) });
    return r.ok === false && r.code === 'IDENTITY_LIST_UNAVAILABLE';
  });
  await check('list-throw-fails-closed', async () => {
    const r = await m.pickCreateRequest({ env: envFor(four), surfaces: [], listIdentities: async () => { throw new Error('IDENTITY_TIMEOUT'); } });
    return r.ok === false && r.code === 'IDENTITY_LIST_UNAVAILABLE';
  });
  await check('create-action', () => {
    const reply = m.refusalReply({ ok: false, code: 'NO_IDENTITY', configured: 4, live: 1, missing: [] });
    return reply.action?.id === 'open-identities' && reply.action.label === 'Create identity…';
  });
  return failed;
}

describe('MULTI-CAPSULE profile picker behavior', () => {
  it('real module passes every shared probe', async () => {
    assert.deepEqual(await probes(picker), []);
  });

  it('picks mv-live-1..4 in order as capsules open, then refuses the fifth', () => {
    const identities = new Set(four);
    const bound = new Set();
    for (const [index, id] of four.entries()) {
      const r = picker.pickProfile({ env: envFor(four), live: index, bound: new Set(bound), identities });
      assert.equal(r.ok, true);
      assert.equal(r.profile_id, id);
      assert.equal(r.request.params.profile_id, id);
      bound.add(id);
    }
    const full = picker.pickProfile({ env: envFor(four), live: 4, bound, identities });
    assert.equal(full.ok, false);
    assert.equal(full.code, 'CAPSULE_LIMIT_REACHED');
  });

  it('caps at 4 even when more profiles are configured', () => {
    const six = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
    const r = picker.pickProfile({ env: envFor(six), live: 4, bound: new Set(['p1', 'p2', 'p3', 'p4']), identities: new Set(six) });
    assert.equal(r.code, 'CAPSULE_LIMIT_REACHED');
    assert.equal(r.configured, 6);
    const room = picker.pickProfile({ env: envFor(six), live: 3, bound: new Set(['p1', 'p2', 'p3']), identities: new Set(six) });
    assert.equal(room.ok, true);
    assert.equal(room.profile_id, 'p4');
  });

  it('counts a surface with no readable profile toward the ceiling', () => {
    const states = [{ state: 'active' }, { state: 'active' }, { state: 'active', profile_id: 7 }, surf('mv-live-1')];
    const { live, bound } = picker.summarizeSurfaces(states);
    assert.equal(live, 4);
    assert.deepEqual([...bound], ['mv-live-1']);
    const r = picker.pickProfile({ env: envFor(four), live, bound, identities: new Set(four) });
    assert.equal(r.code, 'CAPSULE_LIMIT_REACHED');
  });

  it('single live profile fallback: one candidate, then NO_FREE_PROFILE with configured 1', () => {
    for (const env of [{}, { MV_SRF_PROFILES: '{not json' }, { MV_SRF_PROFILES: '[]' }, { MV_SRF_PROFILES: '{"BAD ID":{}}' }]) {
      const first = picker.pickProfile({ env, live: 0, bound: new Set(), identities: new Set(['mv-live-1']) });
      assert.equal(first.profile_id, 'mv-live-1');
      const second = picker.pickProfile({ env, live: 1, bound: new Set(['mv-live-1']), identities: new Set(['mv-live-1']) });
      assert.equal(second.code, 'NO_FREE_PROFILE');
      assert.equal(second.configured, 1);
    }
    const custom = picker.pickProfile({ env: { MV_SRF_LIVE_PROFILE: 'mv-live-9' }, live: 0, bound: new Set(), identities: new Set(['mv-live-9']) });
    assert.equal(custom.profile_id, 'mv-live-9');
  });

  it('ignores invalid and prototype-shaped profile ids', () => {
    const env = { MV_SRF_PROFILES: '{"__proto__":{"Kind":"browser"},"Bad":{},"ok-1":{}}' };
    assert.deepEqual(picker.configuredProfiles(env).map((p) => p.id), ['ok-1']);
    assert.equal(Object.getPrototypeOf({}), Object.prototype);
  });

  it('first candidate equals the boot create request (parity with buildFirstSurfaceCreateRequest)', () => {
    const envs = [
      {},
      { MV_SRF_LIVE_PROFILE: 'mv-live-7' },
      envFor(four),
      { MV_SRF_PROFILES: profileMap(four, { Width: 1024, Height: 768 }), MV_SRF_LIVE_PROFILE: 'mv-live-3' },
      { MV_SRF_PROFILES: '{broken' },
    ];
    for (const env of envs) {
      assert.deepEqual(picker.configuredProfiles(env)[0].request, buildFirstSurfaceCreateRequest(env));
    }
  });

  it('requests are frozen and inputs are never mutated; the result is deterministic', () => {
    const env = envFor(four);
    const snapshot = JSON.stringify(env);
    const bound = new Set(['mv-live-1']);
    const input = { env, live: 1, bound, identities: new Set(four) };
    const a = picker.pickProfile(input);
    const b = picker.pickProfile(input);
    assert.deepEqual(a, b);
    assert.ok(Object.isFrozen(a) && Object.isFrozen(a.request) && Object.isFrozen(a.request.params));
    assert.equal(JSON.stringify(env), snapshot);
    assert.deepEqual([...bound], ['mv-live-1']);
  });

  it('rejects malformed input with a typed refusal instead of throwing', () => {
    for (const bad of [undefined, null, {}, { env: {}, live: -1, bound: new Set(), identities: null },
      { env: {}, live: 1.5, bound: new Set(), identities: null }, { env: {}, live: 0, bound: [], identities: null },
      { env: {}, live: 0, bound: new Set(), identities: ['mv-live-1'] }, { env: null, live: 0, bound: new Set(), identities: null }]) {
      const r = picker.pickProfile(bad);
      assert.equal(r.ok, false);
      assert.equal(r.code, 'PICKER_INPUT_INVALID');
    }
    return picker.pickCreateRequest({ env: {}, surfaces: [], listIdentities: null }).then((r) => assert.equal(r.code, 'PICKER_INPUT_INVALID'));
  });

  it('pickCreateRequest asks the identity list with no arguments and keeps names only', async () => {
    const calls = [];
    const surfaces = new Map([['x', surf('mv-live-1')]]);
    const r = await picker.pickCreateRequest({
      env: envFor(four),
      surfaces,
      listIdentities: async (...args) => {
        calls.push(args);
        return { ok: true, rows: [{ id: 'mv-live-1', label: 'secret label', domains: ['example.test'], logged_in: 'unknown' }, { id: 'mv-live-2', label: 'other' }] };
      },
    });
    assert.deepEqual(calls, [[]]);
    assert.equal(r.ok, true);
    assert.equal(r.profile_id, 'mv-live-2');
    assert.ok(!JSON.stringify(r).includes('secret label') && !JSON.stringify(r).includes('example.test'));
  });

  it('module is pure: no imports, process, filesystem, network or identity-store access', () => {
    const text = source().replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(text, /^\s*import\s/m);
    assert.doesNotMatch(text, /\brequire\s*\(|\bprocess\b|\bfetch\s*\(|node:|child_process|\.token|auth\.json|identity\.env|SRF_IDENTITY_STORE_ROOT/);
    assert.doesNotMatch(text, /identity\.(create|delete|login|show)/);
  });
});

describe('MULTI-CAPSULE renderer copy', () => {
  const refusal = (code, extra = {}) => ({ ok: false, code, configured: 2, live: 2, missing: [], ...extra });

  it('NO_FREE_PROFILE says how many are configured and how to configure more', () => {
    const reply = picker.refusalReply(refusal('NO_FREE_PROFILE', { configured: 3 }));
    assert.equal(reply.ok, false);
    assert.equal(reply.code, 'NO_FREE_PROFILE');
    assert.match(reply.message, /^3 configured capsule profiles are all in use\./);
    assert.match(reply.message, /MV_SRF_PROFILES/);
    assert.match(reply.message, /User Guide/);
    assert.equal(reply.action, null);
    assert.match(picker.refusalReply(refusal('NO_FREE_PROFILE', { configured: 1 })).message, /^1 configured capsule profile is all in use\./);
  });

  it('CAPSULE_LIMIT_REACHED names the ceiling and the shared CPU', () => {
    const reply = picker.refusalReply(refusal('CAPSULE_LIMIT_REACHED'));
    assert.match(reply.message, /At most 4 capsules/);
    assert.match(reply.message, /share the same CPU/);
  });

  it('NO_IDENTITY offers the Create identity action that opens Identities', () => {
    const reply = picker.refusalReply(refusal('NO_IDENTITY', { missing: ['mv-live-2'] }));
    assert.deepEqual(reply.action, { id: 'open-identities', label: 'Create identity…' });
    assert.match(reply.message, /Create an identity/);
    assert.ok(!reply.message.includes('mv-live-2'), 'copy is static and never embeds profile ids');
  });

  it('every refusal code has copy, replies are frozen, and unknown codes collapse safely', () => {
    for (const code of ['CAPSULE_LIMIT_REACHED', 'NO_FREE_PROFILE', 'NO_IDENTITY', 'IDENTITY_LIST_UNAVAILABLE', 'PICKER_INPUT_INVALID']) {
      const reply = picker.refusalReply(refusal(code));
      assert.equal(reply.code, code);
      assert.ok(reply.message.length > 20);
      assert.ok(Object.isFrozen(reply));
    }
    const unknown = picker.refusalReply(refusal('SOMETHING_ELSE'));
    assert.equal(unknown.code, 'PICKER_INPUT_INVALID');
    assert.equal(picker.refusalReply(refusal('constructor')).code, 'PICKER_INPUT_INVALID');
  });

  it('copy never echoes environment values', () => {
    const env = { ...envFor(four), MV_SRF_STATE_DIR: '/home/x/secret-state', MV_SRF_LIVE_RAM_ROOT: '/dev/shm/secret-root' };
    const r = picker.pickProfile({ env, live: 4, bound: new Set(four), identities: new Set(four) });
    const text = JSON.stringify(picker.refusalReply(r));
    assert.ok(!text.includes('secret-state') && !text.includes('secret-root'));
  });
});

describe('MULTI-CAPSULE mutant evidence', () => {
  /** @type {Array<[string, Array<[string, string]>]>} */
  const mutants = [
    ['limit off by one', [['live >= MAX_CAPSULES', 'live > MAX_CAPSULES']]],
    ['ceiling raised to 5', [['MAX_CAPSULES = 4;', 'MAX_CAPSULES = 5;']]],
    ['bound profiles still offered', [['profiles.filter((p) => !bound.has(p.id))', 'profiles.slice()']]],
    ['identity ignored', [['free.find((p) => identities.has(p.id))', 'free[0]']]],
    ['unknown identity list admitted', [
      ["if (identities === null) return refuse('IDENTITY_LIST_UNAVAILABLE', { configured, live });", ''],
      ['free.find((p) => identities.has(p.id))', 'free.find((p) => identities === null || identities.has(p.id))'],
    ]],
    ['preferred profile not first', [['[live, ...ids.filter((k) => k !== live)]', 'ids']]],
    ['non-browser profiles offered', [["return Object.freeze(all.filter((p) => p.request.params.kind === 'browser'));", 'return Object.freeze(all);']]],
    ['profile-less surface not counted', [['    live += 1;\n    if (validId(state.profile_id)) bound.add(state.profile_id);', '    if (validId(state.profile_id)) { live += 1; bound.add(state.profile_id); }']]],
    ['destroyed surface still live', [["    if (state.state === 'destroyed' || state.state === 'lost') continue;\n", '']]],
    ['identity ids unvalidated', [['plain(row) && validId(row.id)', "plain(row) && typeof row.id === 'string'"]]],
    ['failed list reply admitted', [['plain(reply) && reply.ok === true', 'plain(reply)']]],
    ['list failure admits all profiles', [['  } catch {\n    identities = null;', '  } catch {\n    identities = new Set(configuredProfiles(env).map((p) => p.id));']]],
    ['create identity action dropped', [["action: Object.freeze({ id: 'open-identities', label: 'Create identity…' }),\n  }),\n  IDENTITY_LIST_UNAVAILABLE", 'action: null,\n  }),\n  IDENTITY_LIST_UNAVAILABLE']]],
  ];

  for (const [name, edits] of mutants) {
    it(`kills mutant: ${name}`, async (t) => {
      let text = source();
      for (const [from, to] of edits) {
        assert.equal(text.split(from).length, 2, `mutation anchor must occur exactly once: ${from.slice(0, 48)}`);
        text = text.replace(from, () => to);
      }
      assert.notEqual(text, source());
      const dir = await mkdtemp(join(tmpdir(), 'mv-multicap-mut-'));
      t.after(() => rm(dir, { recursive: true, force: true }));
      const file = join(dir, 'profilePicker.mutant.mjs');
      await writeFile(file, text, { mode: 0o600 });
      const mutant = await import(pathToFileURL(file).href);
      const failed = await probes(mutant);
      assert.ok(failed.length > 0, `mutant "${name}" survived every probe`);
    });
  }
});

it('authority create hook uses identities, reserves profiles, and enforces the ceiling', async () => {
  const { installAuthorityWire, WIRE_CHANNELS } = await import('../electron/authorityWire.js');
  const { PRIVILEGED_ORIGIN } = await import('../electron/main.js');
  const handlers = new Map();
  const contents = {id:7, mainFrame:{origin:PRIVILEGED_ORIGIN,url:`${PRIVILEGED_ORIGIN}/index.html`},isDestroyed:()=>false};
  const states = new Map([['boot', surf('mv-live-1')]]);
  let available = false;
  const requests = [];
  const wire = installAuthorityWire({
    ipcMain:{handle:(ch,fn)=>handlers.set(ch,fn),removeHandler:ch=>handlers.delete(ch)},
    contents, env:envFor(four), argv:[], capsuleStates:states,
    listIdentities:async()=>({ok:true,rows:available ? four.map(id=>({id})) : []}),
    core:{request:async request=>{
      requests.push(request);
      return {schema:'surface_event/v0.2',event:'created',data:{surface:surf(request.params.profile_id)}};
    }},
  });
  try {
    const { createPreloadFacade } = await import('../electron/preload.js');
    const facade = createPreloadFacade({transport:{invoke:async(channel,args)=>handlers.get(channel)({sender:contents,senderFrame:contents.mainFrame},...args)},bridge:{exposeInMainWorld(){}}});
    const create = () => facade.authority.createSurface();
    assert.equal((await create()).code,'NO_IDENTITY');
    assert.equal(requests.length,0);
    available = true;
    for (const expected of four.slice(1)) {
      assert.equal((await create()).ok,true);
      assert.equal(requests.at(-1).params.profile_id,expected);
    }
    assert.equal((await create()).code,'CAPSULE_LIMIT_REACHED');
    assert.equal(requests.length,3);
  } finally {await wire.dispose();}
});

it('bootProductionMain wires listIdentities through resolveIdentityTool for packaged and dev launches', async () => {
  const { resolveIdentityTool } = await import('../electron/main.js');
  const mainSource = readFileSync(join(HERE, '../electron/main.js'), 'utf8');
  assert.match(mainSource, /listIdentities:\s*\(\)\s*=>[\s\S]*?resolveIdentityTool\(\{\s*packaged:\s*packagedLaunch,\s*resourcesPath:\s*process\.resourcesPath,\s*rendererRoot:\s*paths\.rendererRoot\s*\}\)/);
  assert.doesNotMatch(mainSource, /listIdentities:\s*\(\)\s*=>[\s\S]*?\.\.\/\.\.\/\.\.\/tools\/mv_identity\.py/);
  assert.equal(
    resolveIdentityTool({ packaged: true, resourcesPath: '/opt/mv/resources', rendererRoot: '/opt/mv/resources/app.asar/dist/renderer' }),
    '/opt/mv/resources/operator/tools/mv_identity.py',
  );
  assert.equal(
    resolveIdentityTool({ packaged: false, resourcesPath: undefined, rendererRoot: '/work/ui/dist/renderer' }),
    '/work/tools/mv_identity.py',
  );
});

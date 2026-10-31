// REOPEN-FLOW: closing a tile (x) is presentation-only, so the capsule keeps its profile bound.
// A second create for the same profile must come back to the operator as a typed refusal
// (SURFACE_PROFILE_BOUND), not as the generic failure; the serialized create path must stay
// usable afterwards, a destroy-then-create must settle on the new capsule, and the host
// connection must stay live (list keepalive) with zero surfaces.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once, EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const PROFILE = 'mv-live-1';
const registration = component => ({endpoint:{component,instance:component+'-test'},hello:{schema:'hello/v0.2',contract_version:'v0.2',component,component_version:'0.1.1',component_commit:'a'.repeat(40),dependencies:[]}});
const surface = (id, state = 'active') => ({schema:'surface/v0.2',surface_id:id,kind:'browser',display:':1',geometry:{w:1280,h:900},state,visibility:'unfolded',control:'agent',profile_id:PROFILE});
const createBody = () => ({schema:'surface_request/v0.2',op:'create',params:{kind:'browser',geometry:{w:1280,h:900},profile_id:PROFILE}});
const ELECTRON_DIR = fileURLToPath(new URL('../electron/', import.meta.url));

async function waitFor(predicate, description = 'condition', timeoutMs = 5000) {
  const start = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    assert.ok(Date.now() - start < timeoutMs, `Timed out waiting for ${description}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

/** Host module under test; `mutate` rewrites hostBindings.js inside a throwaway copy of electron/. */
let serial = 0;
async function loadHost(t, mutate = null) {
  if (mutate === null) return import('../electron/hostBindings.js');
  const dir = await mkdtemp(join(tmpdir(), 'mv-reopen-mut-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  cpSync(ELECTRON_DIR, join(dir, 'electron'), {recursive: true});
  const target = join(dir, 'electron', 'hostBindings.js');
  const original = readFileSync(target, 'utf8');
  const changed = mutate(original);
  assert.notEqual(changed, original, 'negative control must change the source');
  writeFileSync(target, changed);
  return import(`${pathToFileURL(target).href}?mut=${serial++}`);
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mv-reopen-'));
  await mkdir(join(root, 'metaviewer'), {mode: 0o700});
  const config = {session_id: 'reopen-test', core: registration('core'), peers: [registration('ui')]};
  const configPath = join(root, 'config.json');
  await writeFile(configPath, JSON.stringify(config), {mode: 0o600});
  const requests = [], sockets = new Set();
  let peer, seq = 0;
  const send = body => peer.write(JSON.stringify({schema: 'envelope/v0.2', msg_id: 'reply-' + (++seq), ts_ns: 0, from: config.core.endpoint, to: config.peers[0].endpoint, session_id: config.session_id, seq, nonce: 'nonce-' + seq, body}) + '\n');
  const server = createServer(socket => {
    peer = socket; sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    socket.on('data', data => {
      buffer += data; let offset;
      while ((offset = buffer.indexOf('\n')) >= 0) {
        const env = JSON.parse(buffer.slice(0, offset)); buffer = buffer.slice(offset + 1); requests.push(env);
        if (env.body.schema === 'hello/v0.2') send(config.core.hello);
      }
    });
  });
  server.listen(join(root, 'metaviewer/core.sock')); await once(server, 'listening');
  await chmod(join(root, 'metaviewer/core.sock'), 0o600);
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); await rm(root, {recursive: true, force: true}); });
  const createMessageChannel = () => ({port1: Object.assign(new EventEmitter(), {postMessage() {}, start() {}, close() {}}), port2: {close() {}}});
  return {env: {MV_CORE_CONFIG: configPath, XDG_RUNTIME_DIR: root}, requests, send, createMessageChannel};
}

async function open(t, mutate = null) {
  const host = await loadHost(t, mutate);
  const f = await fixture(t);
  const bindings = await host.createMainBindings({env: f.env, createMessageChannel: f.createMessageChannel});
  t.after(() => bindings.core.dispose());
  t.mock.method(console, 'log', () => {});
  return {host, f, bindings};
}

/** Sends a create and returns the promise plus its envelope msg-id (the adapter's surface_id fallback). */
async function sendCreate(f, bindings) {
  const before = f.requests.filter(e => e.body.op === 'create').length;
  const pending = bindings.core.request(createBody());
  const env = await waitFor(() => f.requests.filter(e => e.body.op === 'create')[before], 'create on the wire');
  return {pending, key: env.msg_id};
}

// Exact adapter wireFailure shape for a create refused by manager.create ("binding: profile already bound").
const boundError = key => ({schema: 'surface_event/v0.2', event: 'error', data: {surface_id: key, code: 'adapter', detail: 'binding: profile already bound'}});

test('REOPEN second create while the first capsule still runs is a typed SURFACE_PROFILE_BOUND refusal', async t => {
  const {f, bindings} = await open(t);
  const first = await sendCreate(f, bindings);
  f.send({schema: 'surface_event/v0.2', event: 'created', data: {surface: surface('s1')}});
  assert.equal((await first.pending).event, 'created');
  // The operator closes the tile (presentation only): nothing reaches the host. Open again:
  const second = await sendCreate(f, bindings);
  f.send(boundError(second.key));
  await assert.rejects(second.pending, {code: 'SURFACE_PROFILE_BOUND'});
  // The failed create released the serialized slot: a third attempt is not BUSY.
  const third = await sendCreate(f, bindings);
  f.send(boundError(third.key));
  await assert.rejects(third.pending, {code: 'SURFACE_PROFILE_BOUND'});
});

test('REOPEN a quarantined or lost profile is a typed SURFACE_PROFILE_QUARANTINED refusal', async t => {
  const {f, bindings} = await open(t);
  for (const detail of ['uncertain: profile mv-live-1 remains quarantined after failed create: stop', 'uncertain: surface capacity or unresolved native outcome']) {
    const create = await sendCreate(f, bindings);
    f.send({schema: 'surface_event/v0.2', event: 'error', data: {surface_id: create.key, code: 'adapter', detail}});
    await assert.rejects(create.pending, {code: 'SURFACE_PROFILE_QUARANTINED'});
  }
});

test('REOPEN other create errors keep their pass-through reply and BUSY stays typed while one is in flight', async t => {
  const {f, bindings} = await open(t);
  const create = await sendCreate(f, bindings);
  await assert.rejects(bindings.core.request(createBody()), {code: 'SURFACE_CREATE_BUSY'});
  f.send({schema: 'surface_event/v0.2', event: 'error', data: {surface_id: create.key, code: 'RAM_ADMISSION_REFUSED', detail: 'ram admission refused'}});
  const reply = await create.pending;
  assert.equal(reply.event, 'error');
  assert.equal(reply.data.code, 'RAM_ADMISSION_REFUSED');
  // An adapter error whose detail names no profile cause is never retyped.
  const next = await sendCreate(f, bindings);
  f.send({schema: 'surface_event/v0.2', event: 'error', data: {surface_id: next.key, code: 'adapter', detail: 'configuration: profile map or live profile/root required'}});
  assert.equal((await next.pending).data.code, 'adapter');
});

test('REOPEN a create sent while the first capsule is still stopping settles on the new capsule', async t => {
  const {f, bindings} = await open(t);
  const first = await sendCreate(f, bindings);
  f.send({schema: 'surface_event/v0.2', event: 'created', data: {surface: surface('s1')}});
  await first.pending;
  // The first capsule is still stopping (no destroyed event yet) when the operator opens again.
  const second = await sendCreate(f, bindings);
  let settled = false;
  void second.pending.then(() => { settled = true; }, () => { settled = true; });
  f.send({schema: 'surface_event/v0.2', event: 'state_changed', data: {surface: surface('s1', 'destroyed')}});
  // The stop of the old capsule (its error or destroyed events) never settles the new create.
  f.send({schema: 'surface_event/v0.2', event: 'error', data: {surface_id: 's1', code: 'adapter', detail: 'stopping'}});
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(settled, false);
  f.send({schema: 'surface_event/v0.2', event: 'created', data: {surface: surface('s2')}});
  const reply = await second.pending;
  assert.equal(reply.event, 'created');
  assert.equal(reply.data.surface.surface_id, 's2');
});

test('REOPEN the host connection stays live with zero surfaces and keeps listing', async t => {
  t.mock.timers.enable({apis: ['setInterval']});
  const {f, bindings} = await open(t);
  const first = await sendCreate(f, bindings);
  f.send({schema: 'surface_event/v0.2', event: 'created', data: {surface: surface('s1')}});
  await first.pending;
  f.send({schema: 'surface_event/v0.2', event: 'state_changed', data: {surface: surface('s1', 'destroyed')}});
  await new Promise(resolve => setTimeout(resolve, 20));
  const lists = () => f.requests.filter(e => e.body.schema === 'surface_request/v0.2' && e.body.op === 'list').length;
  const before = lists();
  t.mock.timers.tick(10000);
  await waitFor(() => lists() > before, 'keepalive list with zero surfaces');
  assert.equal(bindings.core.getStatus().availability, 'live');
  // And the operator can open a browser again on the same profile.
  const reopened = await sendCreate(f, bindings);
  f.send({schema: 'surface_event/v0.2', event: 'created', data: {surface: surface('s3')}});
  assert.equal((await reopened.pending).data.surface.surface_id, 's3');
});

const dropBoundCode = src => src.replace("if (body.data.detail.includes('profile already bound')) return 'SURFACE_PROFILE_BOUND';", '');
const dropReject = src => src.replace('if (refused !== null) item.reject(', 'if (false) item.reject(');
const dropKeepalive = src => src.replace("if (disposed || !live) return;\n      try {send({schema:'surface_request/v0.2',op:'list'", "if (true) return;\n      try {send({schema:'surface_request/v0.2',op:'list'");

for (const [name, mutate] of [['detail no longer typed', dropBoundCode], ['typed refusal never rejects', dropReject]]) {
  test(`REOPEN negative control: ${name}`, async t => {
    const {f, bindings} = await open(t, mutate);
    const create = await sendCreate(f, bindings);
    f.send(boundError(create.key));
    const outcome = await create.pending.then(reply => reply, error => error);
    assert.notEqual(outcome?.code, 'SURFACE_PROFILE_BOUND');
    assert.equal(outcome?.data?.code, 'adapter', 'the mutant falls back to the untyped adapter reply');
  });
}

test('REOPEN negative control: a host without the keepalive never lists', async t => {
  t.mock.timers.enable({apis: ['setInterval']});
  const {f} = await open(t, dropKeepalive);
  await waitFor(() => f.requests.some(e => e.body.schema === 'hello/v0.2'), 'handshake');
  const lists = () => f.requests.filter(e => e.body.schema === 'surface_request/v0.2' && e.body.op === 'list').length;
  t.mock.timers.tick(10000);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(lists(), 0);
});

test('REOPEN negative control: without the departed-id guard a late error of the stopping capsule settles the new create', async t => {
  const {f, bindings} = await open(t, src => src.replace(' && !departed.has(body.data.surface_id)', ''));
  const first = await sendCreate(f, bindings);
  f.send({schema: 'surface_event/v0.2', event: 'created', data: {surface: surface('s1')}});
  await first.pending;
  const second = await sendCreate(f, bindings);
  f.send({schema: 'surface_event/v0.2', event: 'state_changed', data: {surface: surface('s1', 'destroyed')}});
  f.send({schema: 'surface_event/v0.2', event: 'error', data: {surface_id: 's1', code: 'adapter', detail: 'stopping'}});
  const reply = await second.pending;
  assert.equal(reply.event, 'error', 'the mutant settles on the old capsule error');
  assert.equal(reply.data.surface_id, 's1');
});

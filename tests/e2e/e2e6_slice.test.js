'use strict';
// [TARGET, unit decision] Test-owned process bridge for the admitted APIs.
// Native CLI is deterministic; adapter validation/publication, Rust authority,
// Chromium canvas, actions, journal and replay are real. No host capsule claim.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { join, resolve } = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { createInterface } = require('node:readline');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const { compileRust, replay } = require('./core-driver.js');
const { E2EError, makeScratch, removeScratch, electronBinary, validateWallReport } = require('./harness.js');
const ROOT = resolve(__dirname, '../..');
function requireSlice(env) {
  if (env.MV_E2E_LIVE !== '1') throw new E2EError('E2E_GATE', 'slice requires MV_E2E_LIVE=1');
}
function processBridge(binary, args, env) {
  const child = spawn(binary, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let errors = '';
  child.stderr.on('data', (chunk) => { errors += chunk; });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  return {
    child,
    async call(value) {
      child.stdin.write(JSON.stringify(value) + '\n');
      let timer;
      try {
        const line = await Promise.race([lines.next(), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`E2E_BRIDGE: timeout ${errors}`)), 15000);
        })]);
        if (line.done) throw new Error(`E2E_BRIDGE: process closed ${errors}`);
        return JSON.parse(line.value);
      } finally { clearTimeout(timer); }
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exit = once(child, 'exit');
      child.kill('SIGTERM');
      await exit;
    },
  };
}
function paint(scratch, frame) {
  const bytes = [...fs.readFileSync(frame.ramws_path)];
  assert.equal(createHash('sha256').update(Buffer.from(bytes)).digest('hex'), frame.sha256);
  const path = join(scratch, 'paint.json');
  fs.writeFileSync(path, JSON.stringify({ frame, bytes }));
  const output = execFileSync('xvfb-run', ['-a', electronBinary(ROOT), join(__dirname, 'slice-main.cjs')],
    { env: { ...process.env, MV_SLICE_FRAME: path }, encoding: 'utf8', timeout: 25000 });
  const row = output.split('\n').find((line) => line.startsWith('SLICE_RENDER:'));
  assert.ok(row, 'renderer must return a real canvas witness');
  const result = JSON.parse(row.slice('SLICE_RENDER:'.length));
  assert.equal(result.surfaceId, frame.surface_id);
  assert.equal(result.generation, frame.generation);
  assert.deepEqual(result.pixels, [255, 0, 0, 255, 0, 255, 0, 255]);
}
function route(frame, surfaceId) {
  return validateWallReport({ schema: 'e2e-wall-report/v1', phase: 'wall', errors: [],
    tiles: [{ capsuleId: surfaceId, visible: true, frameId: frame.sha256 }] },
  { minTiles: 1, frameOwners: new Map([[frame.sha256, frame.surface_id]]) });
}
test('slice refuses missing live flag without a skip', () => {
  assert.throws(() => requireSlice({}), { code: 'E2E_GATE' });
});
test('adapter capsule -> gen7 canvas -> agent action -> stale refusal -> control/drain -> replay', async () => {
  requireSlice(process.env);
  const scratch = makeScratch('mv-integrated-slice');
  const ram = fs.mkdtempSync('/dev/shm/mv-slice-');
  const bridges = [];
  try {
    const bin = join(scratch, 'native'); fs.mkdirSync(bin);
    const state = join(scratch, 'native-state'); fs.mkdirSync(state, { mode: 0o700 });
    fs.copyFileSync(join(__dirname, 'slice-native.py'), join(bin, 'srf-identity-surface'));
    fs.chmodSync(join(bin, 'srf-identity-surface'), 0o700);
    const png = join(ram, 'slice-run/frames/w1/f.png');
    fs.mkdirSync(require('node:path').dirname(png), { recursive: true, mode: 0o700 });
    // PNG generated independently from fixed RGB bytes, using only stdlib.
    execFileSync('python3', ['-c', String.raw`import struct,zlib,sys
from pathlib import Path
def chunk(k,b): return struct.pack('>I',len(b))+k+b+struct.pack('>I',zlib.crc32(k+b))
Path(sys.argv[1]).write_bytes(b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',2,1,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(bytes([0,255,0,0,0,255,0])))+chunk(b'IEND',b''))`, png]);
    fs.chmodSync(png, 0o600);
    const module = join(scratch, 'go'); fs.mkdirSync(module);
    fs.writeFileSync(join(module, 'go.mod'), 'module metaviewer/daemon-adapter/e2e\n\ngo 1.26.0\n\nrequire metaviewer/daemon-adapter v0.0.0\nreplace metaviewer/daemon-adapter => ' + JSON.stringify(join(ROOT, 'daemon-adapter')) + '\n');
    fs.copyFileSync(join(__dirname, 'slice-adapter.go'), join(module, 'main.go'));
    const adapterBinary = join(scratch, 'adapter');
    execFileSync(process.env.GO || 'go', ['build', '-o', adapterBinary, '.'],
      { cwd: module, env: { ...process.env, GOPROXY: 'off', GOTOOLCHAIN: 'local', GOWORK: 'off' } });
    const authorityBinary = compileRust(scratch, fs.readFileSync(join(__dirname, 'slice-authority.rs'), 'utf8'));
    const adapter = processBridge(adapterBinary, [ram], { ...process.env, MV_SRF_BIN_DIR: bin,
      MV_SRF_STATE_DIR: state, SRF_IDENTITY_STORE_ROOT: ram, SRF_PROXY_REGISTRY: join(ram, 'proxy.json') });
    bridges.push(adapter);
    const authority = processBridge(authorityBinary, [join(scratch, 'authority')], process.env);
    bridges.push(authority);
    const created = await adapter.call({ op: 'create', params: { kind: 'browser', profile_id: 'slice', geometry: { w: 2, h: 1 } } });
    const id = created[0].data.surface.surface_id;
    let frame;
    for (let n = 1; n <= 7; n++) frame = await adapter.call({ op: 'capture', id });
    assert.equal(frame.generation, 7);
    route(frame, id);
    assert.throws(() => route(frame, 'foreign-tile'), { code: 'E2E_ROUTING' });
    paint(scratch, frame);
    await authority.call({ op: 'surface', id, frame });
    let n = 0;
    async function act(basedOn) {
      ++n;
      return authority.call({ op: 'propose', envelope: { schema: 'envelope/v0.2', msg_id: `m${n}`,
        ts_ns: 0, from: { component: 'agent', instance: 'slice-agent' },
        to: { component: 'core', instance: 'slice-core' }, session_id: 'slice-session', seq: n, nonce: `n${n}`,
        body: { schema: 'action_proposal/v0.2', proposal_id: `p${n}`, surface_id: id,
          based_on_frame: { sha256: basedOn.sha256, generation: basedOn.generation },
          action: { type: 'click', x: 1, y: 0, button: 'left' },
          expectation: { type: 'text_present', text: 'ready' }, budget: { max_ms: 100, max_retries: 0 } } } });
    }
    assert.equal((await act(frame)).reason, null);
    assert.equal((await authority.call({ op: 'dispatch', id: 'p1' })).dispatch, true);
    const input = await adapter.call({ op: 'input', params: { surface_id: id, proposal_id: 'p1', action: { type: 'click', x: 1, y: 0, button: 'left' } } });
    assert.ok(Array.isArray(input), JSON.stringify(input));
    const frame8 = await adapter.call({ op: 'capture', id });
    assert.equal(frame8.generation, 8);
    paint(scratch, frame8);
    const before = await authority.call({ op: 'frame', id, frame: frame8 });
    const nativeBefore = fs.readFileSync(join(ram, 'native-actions.jsonl'), 'utf8');
    const stale = await act(frame);
    assert.equal(stale.reason, 'STALE_FRAME');
    assert.equal(stale.dispatch, false);
    assert.deepEqual(stale.domain, before.domain);
    assert.equal(stale.state.remaining_budget, before.state.remaining_budget);
    assert.equal(fs.readFileSync(join(ram, 'native-actions.jsonl'), 'utf8'), nativeBefore);
    const take = await authority.call({ op: 'take', id });
    assert.deepEqual(take.cancelled, ['p1']);
    assert.equal(take.control_ready, false);
    assert.ok(Array.isArray(await adapter.call({ op: 'take_control', params: { surface_id: id, owner: 'human' } })));
    assert.equal((await act(frame8)).reason, 'SURFACE_NOT_AGENT_CONTROLLED');
    assert.equal((await authority.call({ op: 'release', id })).reason, 'POLICY');
    assert.equal((await authority.call({ op: 'drain', id: 'p1' })).control_ready, true);
    assert.equal((await authority.call({ op: 'release', id })).reason, null);
    assert.ok(Array.isArray(await adapter.call({ op: 'release_control', params: { surface_id: id } })));
    const fresh = await adapter.call({ op: 'capture', id });
    await authority.call({ op: 'frame', id, frame: fresh });
    assert.equal((await act(fresh)).reason, null);
    assert.equal((await authority.call({ op: 'dispatch', id: 'p4' })).dispatch, true);
    const finalInput = await adapter.call({ op: 'input', params: { surface_id: id, proposal_id: 'p4', action: { type: 'click', x: 1, y: 0, button: 'left' } } });
    assert.ok(Array.isArray(finalInput), JSON.stringify(finalInput));
    const end = await authority.call({ op: 'receipt', id: 'p4' });
    assert.deepEqual(end.state.pending, {});
    const root = join(scratch, 'authority/sessions/slice-session');
    const journal = join(root, 'journal.jsonl');
    assert.equal(replay(journal, root), replay(journal, root));
    assert.equal(replay(journal, root, true), '');
  } finally {
    for (const bridge of bridges.reverse()) await bridge.close();
    removeScratch(scratch); fs.rmSync(ram, { recursive: true, force: true });
  }
});

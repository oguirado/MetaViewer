import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node-pty';
import { createPtySession, validateSpawnSpec } from '../electron/ptySession.js';
import { buildProviderSpawn } from '../electron/ptyBroker.js';
import { launchTerminalUtility } from '../electron/terminalHost.js';
const spec = { file: '/bin/echo', args: ['$(touch /tmp/mv-must-not-execute); literal'], cwd: '/tmp', env: { PATH: '/usr/bin:/bin' } };
function fixture() {
  let data; const messages = [], writes = [], calls = [];
  const pty = { onData(fn) { data = fn; return { dispose() {} }; }, onExit() { return { dispose() {} }; },
    write(v) { writes.push(v); }, resize(...v) { calls.push(v); }, pause() { calls.push('pause'); },
    resume() { calls.push('resume'); }, kill() { calls.push('kill'); } };
  const runtime = createPtySession({ session: 's', spec, spawn: (file,args,options) => {
    assert.equal(file, '/bin/echo'); assert.deepEqual(args, spec.args); assert.equal(options.encoding, null); return pty;
  }, send: m => messages.push(m) });
  return { runtime, messages, writes, calls, data: v => data(v) };
}
test('PTY spec is main-owned and invalid specs have no spawn effect', () => {
  let spawned = false;
  for (const bad of [{ ...spec, shell: true }, { ...spec, file: 'echo' }, { ...spec, args: ['bad\0arg'] }]) {
    assert.throws(() => createPtySession({ session:'s', spec:bad, spawn() { spawned = true; }, send() {} }));
  }
  assert.equal(spawned, false);
  const owned = validateSpawnSpec(spec); owned.args.push('extra'); assert.equal(spec.args.length, 1);
});
test('output credit advances only at cumulative parser boundaries; flood pauses and resumes', () => {
  const f = fixture();
  f.data(Buffer.alloc(65536, 255)); f.data(Buffer.alloc(65536, 254));
  assert.deepEqual(f.calls, ['pause']);
  assert.deepEqual(Object.keys(f.messages[0]), ['session','seq','bytes']);
  assert.throws(() => f.runtime.receive({ session:'s',ack:2,bytes:1 }), /INVALID_ACK/);
  f.runtime.receive({ session:'s',ack:2,bytes:131072 });
  assert.deepEqual(f.calls, ['pause','resume']);
  assert.throws(() => f.runtime.receive({ session:'s',ack:1,bytes:65536 }), /INVALID_ACK/);
  assert.throws(() => f.runtime.receive({ session:'other',ack:3,bytes:1 }), /SESSION_MISMATCH/);
  f.runtime.receive({ session:'s',seq:1,bytes:new Uint8Array([0,255,27]) });
  assert.deepEqual([...f.writes[0]], [0,255,27]);
  assert.throws(() => f.runtime.receive({ session:'s',seq:2,bytes:new Uint8Array(),file:'/bin/sh' }), /INVALID_MESSAGE/);
  f.runtime.close(); f.runtime.close(); assert.equal(f.calls.filter(x=>x==='kill').length,1);
});
test('overflow closes explicitly instead of silently discarding bytes', () => {
  const f = fixture(); for(let i=0;i<9;i++) f.data(Buffer.alloc(65536));
  assert.equal(f.messages.at(-1).error,'OUTPUT_OVERFLOW');
  assert.equal(f.calls.filter(x=>x==='kill').length,1);
});
test('main launches a utility process and transfers only the main-owned spec', () => {
  let onSpawn, posted, forked; const port = {};
  const child = { once(event,cb) { assert.equal(event,'spawn'); onSpawn=cb; }, postMessage(...args) { posted=args; } };
  const process = launchTerminalUtility({ session:'s', spec, port, utilityProcess:{fork(...args){forked=args;return child;}} });
  assert.equal(process,child); assert.match(forked[0],/ptyUtility.js$/); assert.equal(posted,undefined);
  onSpawn(); assert.deepEqual(posted,[{session:'s',spec},[port]]);
});
test('real Node PTY preserves argv literals without shell evaluation', {timeout:5000}, async () => {
  const messages = [];
  await new Promise((resolve,reject) => {
    const runtime = createPtySession({ session:'real', spec, spawn, send(message) {
      messages.push(message);
      if (message.error) reject(new Error(message.error));
      if ('exitCode' in message) { assert.equal(message.exitCode,0); resolve(); }
    } });
  });
  const output = Buffer.concat(messages.filter(m=>m.bytes).map(m=>Buffer.from(m.bytes))).toString();
  assert.equal(output,spec.args[0]+'\r\n');
});

test('late broker handoff also spawns providers directly without a shell command',()=>{
  const argv=['/bin/echo',"quoted ' value",'$(do-not-run); literal'];
  assert.deepEqual(buildProviderSpawn(argv,'/bin/bash'),{file:argv[0],args:argv.slice(1)});
  assert.throws(()=>buildProviderSpawn(['echo'],'/bin/bash'));
});

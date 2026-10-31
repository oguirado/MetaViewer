import test from 'node:test';
import assert from 'node:assert/strict';
import {scrubAdapterEnv} from '../electron/coreLauncher.js';
import {validateSurfaceCreateRequest} from '../electron/hostBindings.js';
import {createAuthorityAdapter, createTerminalBroker} from '../src/core/hostAdapters.js';

test('text input allowlist preserves admitted modes and drops invalid values', () => {
  for (const value of ['', 'type', 'paste']) assert.equal(scrubAdapterEnv({PATH:process.env.PATH,MV_SRF_LIVE_TEXT_INPUT:value}, '/tmp/runtime').MV_SRF_LIVE_TEXT_INPUT, value);
  for (const value of ['shell', 'PASTE', 'paste\n', 1]) assert.equal(scrubAdapterEnv({PATH:process.env.PATH,MV_SRF_LIVE_TEXT_INPUT:value}, '/tmp/runtime').MV_SRF_LIVE_TEXT_INPUT, undefined);
});
test('create validator rejects getters and preserves bounded desktop depth', () => {
  const body = {schema:'surface_request/v0.2',op:'create',params:{kind:'desktop_capsule',geometry:{w:16384,h:1},profile_id:'test',nested_depth:1}};
  assert.deepEqual(validateSurfaceCreateRequest(body), body);
  for (const params of [{...body.params,nested_depth:2},{...body.params,kind:'browser'},{...body.params,geometry:{w:16385,h:1}},{...body.params,extra:true}]) assert.throws(() => validateSurfaceCreateRequest({...body,params}), /SURFACE_CREATE_INVALID/);
  assert.throws(() => validateSurfaceCreateRequest({get schema(){throw new Error('getter executed');}}), /SURFACE_CREATE_INVALID/);
});
test('proposal without real frame is refused before crossing the host boundary', async () => {
  let calls = 0;
  const adapter = createAuthorityAdapter({propose:async () => {calls++;return {schema:'action_verdict/v0.2',proposal_id:'p',core_seq:1,decision:'admitted'};}});
  for (const body of [{}, {schema:'action_proposal/v0.2',surface_id:'s'}, {schema:'action_proposal/v0.2',surface_id:'s',based_on_frame:{generation:0,sha256:'a'.repeat(64)},budget:{}}]) await assert.rejects(adapter.propose(body), /NO_BROWSER_CAPSULE/);
  assert.equal(calls,0);
  assert.equal((await adapter.propose({schema:'action_proposal/v0.2',surface_id:'s',based_on_frame:{generation:1,sha256:'a'.repeat(64)},budget:{max_ms:100,max_retries:0}})).code,'ACTION_ADMITTED');
  assert.equal(calls,1);
});
test('typed terminal unavailability remains visible to the launch controls', async () => {
  const broker = createTerminalBroker({open:async () => ({ok:false,code:'TERMINAL_UNAVAILABLE'})});
  await assert.rejects(broker.open({command:'shell',args:[],cols:80,rows:24}), /TERMINAL_UNAVAILABLE: terminal support is not bundled in this package/);
});

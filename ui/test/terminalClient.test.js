import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTerminalClient } from '../src/terminal/terminalClient.js';
function fixture() {
  let receive;const sent=[],writes=[],statuses=[];
  const port={addEventListener(_event,fn){receive=fn;},removeEventListener(){receive=null;},start(){},postMessage(m){sent.push(m);}};
  const client=createTerminalClient({session:'s',port,write:(bytes,done)=>writes.push({bytes,done}),onStatus:s=>statuses.push(s)});
  return {client,sent,writes,statuses,deliver:m=>receive?.({data:m})};
}
test('terminal ACK waits for contiguous parser completions and disposal invalidates callbacks',()=>{
  const f=fixture();
  f.deliver({session:'s',seq:1,bytes:new Uint8Array([0,255])});
  f.deliver({session:'s',seq:2,bytes:new Uint8Array([27])});assert.equal(f.sent.length,0);
  f.writes[1].done();assert.equal(f.sent.length,0);
  f.writes[0].done();assert.deepEqual(f.sent,[{session:'s',ack:2,bytes:3}]);
  f.deliver({session:'s',seq:3,bytes:new Uint8Array([1])});f.client.dispose();f.writes[2].done();
  assert.equal(f.sent.length,1);f.client.input(new Uint8Array([1]));assert.equal(f.sent.length,1);
});
test('wrong session, sequence gaps and extra command fields never reach the parser',()=>{
  for(const message of [{session:'other',seq:1,bytes:new Uint8Array()},
    {session:'s',seq:2,bytes:new Uint8Array()},
    {session:'s',seq:1,bytes:new Uint8Array(),file:'/bin/sh'}]) {
    const f=fixture();f.deliver(message);assert.equal(f.writes.length,0);assert.equal(f.sent.length,0);
    assert.match(f.statuses[0],/refused/);
  }
});

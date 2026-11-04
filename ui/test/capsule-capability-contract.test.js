import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {capsuleCapabilitiesValid} from '../electron/guestCommandValues.js';
import {arm64CapsuleStatusSync} from '../electron/guestCommandProfile.js';
import {createPreloadFacade} from '../electron/preload.js';

test('canonical auditor and runtime validators agree on closed capability values and actual reason bytes',async()=>{
 const cases=[];
 for(const available of [false,true])for(const reason of ['', 'Ready', 'État', 'x\u0085y', '\u2028good\u2029', '😀'.repeat(256), '😀'.repeat(257), '/private', 'private\\path', '\0', '\n', '\r', '\x1f', '\x7f', ' ', '\u00a0', '\u2000', '\ufeff', '\ud800'])cases.push({schema:'capsule_capabilities/v0.2',supported_host:true,vm:{available,reason},microvm:{available:false,reason:'Setup required.'}});
 cases.push({...cases[1],extra:true});cases.push({...cases[1],supported_host:false,vm:{available:true,reason:''}});
 const probe=spawnSync('/usr/bin/python3',['-c',`import sys,json\nfrom pathlib import Path\nsys.path.insert(0,str(Path(sys.argv[1])/'tools'))\nfrom check_contracts import Validator,ValidationError\nv=Validator(Path(sys.argv[1])/'contracts/v0.2');s=v.load('capsule_capabilities.schema.json');v.audit(s)\nout=[]\nfor value in json.loads(sys.stdin.read()):\n try:v.validate(value,s);out.append(True)\n except ValidationError:out.append(False)\nprint(json.dumps(out))`,fileURLToPath(new URL('../../',import.meta.url))],{input:JSON.stringify(cases),encoding:'utf8',timeout:10000,maxBuffer:16384});
 assert.equal(probe.status,0,probe.stderr);const canonical=JSON.parse(probe.stdout);assert.equal(canonical.length,cases.length);
 let reply;const api=createPreloadFacade({transport:{invoke:async()=>reply},bridge:{exposeInMainWorld(){}}});
 for(let i=0;i<cases.length;i++){
  const value=cases[i],expected=canonical[i];assert.equal(capsuleCapabilitiesValid(value),expected,JSON.stringify(value));reply=value;
  if(expected)assert.deepEqual(await api.guestCommand.capabilities(),value);else await assert.rejects(api.guestCommand.capabilities());
  if(!Object.hasOwn(value,'extra')&&value.supported_host){const parsed=arm64CapsuleStatusSync({MV_ARM64_CAPSULE_STATUS:JSON.stringify({vm:value.vm,microvm:value.microvm})},'arm64');assert.equal(parsed.vm.reason!=='Capsule setup status is invalid.',expected,JSON.stringify(value));}
 }
});

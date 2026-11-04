import test from 'node:test';
import assert from 'node:assert/strict';
import {configuredVMProfiles} from '../electron/profilePicker.js';
import {graphicalSessionAdapterEnv,graphicalSessionPinsReady,scrubAdapterEnv,scrubChildEnv} from '../electron/coreLauncher.js';

const graphical={
  MV_GRAPHICAL_SESSION_ENABLED:'1',
  SRF_GRAPHICAL_VM_ENTRY:'/opt/srf-vm-entry',
  SRF_GRAPHICAL_VM_ENTRY_SHA256:'a'.repeat(64),
  SRF_GRAPHICAL_QEMU_IMG:'/usr/bin/qemu-img',
  SRF_GRAPHICAL_QEMU_IMG_SHA256:'b'.repeat(64),
};
const normal={Kind:'vm',NativeKind:'vm',Program:'notepad-vm',Width:1280,Height:900,Display:':100',RAMRoot:'/dev/shm/normal',default_mode:'agent'};
const rewind={...normal,Program:'notepad-rw-vm',RAMRoot:'/dev/shm/rewind'};

test('graphical VM is opt-in on arm64; normal VM remains available by default',()=>{
  assert.deepEqual(configuredVMProfiles({MV_SRF_PROFILES:JSON.stringify({normal,rewind})},'arm64').map(x=>x.id),['normal']);
  assert.deepEqual(configuredVMProfiles({MV_SRF_PROFILES:JSON.stringify({normal,rewind}),...graphical},'arm64').map(x=>x.id),['normal','rewind']);
  assert.deepEqual(configuredVMProfiles({MV_SRF_PROFILES:JSON.stringify({rewind}),...graphical},'x64'),[]);
  assert.equal(graphicalSessionPinsReady(graphical,'x64'),false);
});

test('graphical VM refuses absent or malformed executable pins',()=>{
  assert.equal(graphicalSessionPinsReady({...graphical,SRF_GRAPHICAL_QEMU_IMG_SHA256:undefined},'arm64'),false);
  assert.equal(configuredVMProfiles({MV_SRF_PROFILES:JSON.stringify({rewind}),...Object.fromEntries(Object.entries(graphical).filter(([k])=>k!=='SRF_GRAPHICAL_VM_ENTRY_SHA256'))},'arm64').length,0);
  for(const patch of [
    {SRF_GRAPHICAL_VM_ENTRY:'relative-entry'},
    {SRF_GRAPHICAL_VM_ENTRY:'/opt/../entry'},
    {SRF_GRAPHICAL_QEMU_IMG:'/usr/bin/qemu-img/'},
    {SRF_GRAPHICAL_VM_ENTRY_SHA256:'A'.repeat(64)},
    {SRF_GRAPHICAL_QEMU_IMG_SHA256:'bad'},
    {MV_GRAPHICAL_SESSION_ENABLED:'true'},
  ]) assert.equal(graphicalSessionPinsReady({...graphical,...patch},'arm64'),false);
  assert.equal(configuredVMProfiles({MV_SRF_PROFILES:JSON.stringify({rewind}),...graphical,MV_GRAPHICAL_SESSION_ENABLED:'0'},'arm64').length,0);
});

test('adapter receives the complete graphical pin set only after arm64 validation',()=>{
  assert.deepEqual(graphicalSessionAdapterEnv({PATH:'/usr/bin:/bin'},'arm64'),{});
  assert.deepEqual(graphicalSessionAdapterEnv({MV_GRAPHICAL_SESSION_ENABLED:'0'},'arm64'),{});
  assert.deepEqual(graphicalSessionAdapterEnv(graphical,'arm64'),graphical);
  assert.throws(()=>graphicalSessionAdapterEnv({...graphical,SRF_GRAPHICAL_QEMU_IMG_SHA256:undefined},'arm64'),/GRAPHICAL_SESSION_ENV/);
  assert.throws(()=>graphicalSessionAdapterEnv(graphical,'x64'),/GRAPHICAL_SESSION_ENV/);
  const child=scrubAdapterEnv({PATH:'/usr/bin:/bin',MV_GRAPHICAL_SESSION_ENABLED:'0'},'/tmp');
  for(const key of Object.keys(graphical)) assert.equal(Object.hasOwn(child,key),false);
  if(process.arch==='arm64') {
    const enabled=scrubAdapterEnv({PATH:'/usr/bin:/bin',...graphical},'/tmp');
    for(const [key,value] of Object.entries(graphical)) assert.equal(enabled[key],value);
  } else {
    assert.throws(()=>scrubAdapterEnv({PATH:'/usr/bin:/bin',...graphical},'/tmp'),/GRAPHICAL_SESSION_ENV/);
  }
});

test('core receives only the validated graphical enable bit',()=>{
  const defaults=scrubChildEnv({PATH:'/usr/bin:/bin'},'/tmp');
  assert.equal(Object.hasOwn(defaults,'MV_GRAPHICAL_SESSION_ENABLED'),false);
  for(const key of ['SRF_GRAPHICAL_VM_ENTRY','SRF_GRAPHICAL_VM_ENTRY_SHA256','SRF_GRAPHICAL_QEMU_IMG','SRF_GRAPHICAL_QEMU_IMG_SHA256']) {
    assert.equal(Object.hasOwn(defaults,key),false);
  }
  const disabled=scrubChildEnv({PATH:'/usr/bin:/bin',MV_GRAPHICAL_SESSION_ENABLED:'0'},'/tmp');
  assert.equal(Object.hasOwn(disabled,'MV_GRAPHICAL_SESSION_ENABLED'),false);
  if(process.arch==='arm64') {
    const enabled=scrubChildEnv({PATH:'/usr/bin:/bin',...graphical},'/tmp');
    assert.equal(enabled.MV_GRAPHICAL_SESSION_ENABLED,'1');
    for(const key of ['SRF_GRAPHICAL_VM_ENTRY','SRF_GRAPHICAL_VM_ENTRY_SHA256','SRF_GRAPHICAL_QEMU_IMG','SRF_GRAPHICAL_QEMU_IMG_SHA256']) {
      assert.equal(Object.hasOwn(enabled,key),false);
    }
  } else {
    assert.throws(()=>scrubChildEnv({PATH:'/usr/bin:/bin',...graphical},'/tmp'),/GRAPHICAL_SESSION_ENV/);
  }
  for(const invalid of [
    {MV_GRAPHICAL_SESSION_ENABLED:'1'},
    {...graphical,SRF_GRAPHICAL_VM_ENTRY_SHA256:'bad'},
  ]) assert.throws(()=>scrubChildEnv({PATH:'/usr/bin:/bin',...invalid},'/tmp'),/GRAPHICAL_SESSION_ENV/);
});

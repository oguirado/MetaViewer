// [TARGET, unit decision] Execute the actual destroy hook with a DISPLAY stop
// error, and run focused Go negative controls through read-only source overlays.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root = fileURLToPath(new URL('../../',import.meta.url));
const adapter = join(root,'daemon-adapter');
const go = process.env.GO || 'go';
const env = {...process.env,GOPROXY:'off',GOSUMDB:'off',GOTOOLCHAIN:'local'};
function run(args,cwd=adapter) {
  const r=spawnSync(go,args,{cwd,env,encoding:'utf8',timeout:30000});
  assert.ifError(r.error);
  return {rc:r.status,output:r.stdout+r.stderr};
}

test('DISPLAY Stop error always reaches VERIFIED destroy cleanup; early-return mutant fails',()=>{
  const source=readFileSync(join(adapter,'internal/daemon/environment.go'),'utf8');
  const hook=source.match(/beforeDestroy := func\(ctx context.Context, id string\) error \{[\s\S]*?\n\t\}\n\tfresh,/)[0].replace(/\n\tfresh,$/,'');
  const dir=mkdtempSync(join(tmpdir(),'display-stop-'));
  const scaffold=body=>`package displaytest
import("context";"errors";"fmt";"os";"testing";"time")
type tap struct{}
func(*tap)Stop(context.Context,string)error{return errors.New("forced DISPLAY stop timeout")}
type cache struct{forgot bool}
func(c *cache)Forget(string){c.forgot=true}
func TestDestroy(t *testing.T){
 displayTaps:=&tap{};ring:=&cache{};byRoot:=false
 unsubscribeSurface:=func(_ bool)func(context.Context,string)error{return func(ctx context.Context,_ string)error{if ctx.Err()!=nil{return ctx.Err()};byRoot=true;return nil}}
 ${body}
 ctx,cancel:=context.WithCancel(context.Background());cancel()
 if err:=beforeDestroy(ctx,"surface");err!=nil{t.Fatal(err)}
 if !byRoot||!ring.forgot{t.Fatal("VERIFIED cleanup skipped")}
}`;
  try {
    const path=join(dir,'destroy_test.go');
    writeFileSync(path,scaffold(hook));
    let r=run(['test',path],dir);assert.equal(r.rc,0,r.output);
    const mutant=hook.replace(/fmt.Fprintf\(os.Stderr,[^\n]+/,'return err');
    assert.notEqual(mutant,hook);
    // Keep imports referenced so a negative result proves cleanup failure.
    writeFileSync(path,scaffold(mutant).replace('displayTaps:=','_ = fmt.Fprintf; _ = os.Stderr; displayTaps:='));
    r=run(['test',path],dir);assert.equal(r.rc,1,r.output);assert.match(r.output,/forced DISPLAY stop timeout/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('DISPLAY stale task and ring recovery guards reject their reverted mutants',()=>{
 const dir=mkdtempSync(join(tmpdir(),'display-mutants-'));
 try {
  for(const [file,from,to,pattern] of [
   ['displaytap.go','delete(d.tasks, id)','/* mutant: retain dead task */','TestDisplayFinishedTaskRevives'],
   ['displaytap_ring.go','if errors.Is(e, syscall.EEXIST) {','if false && errors.Is(e, syscall.EEXIST) {','TestDisplayStaleRingReclaimed'],
   ['displaytap_ring.go','stale.Mode&07777 != 0600','false','TestDisplayStaleRingRejectsUnsafe/mode'],
   ['displaytap_ring.go','syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK','syscall.O_RDONLY|syscall.O_NONBLOCK','TestDisplayStaleRingRejectsUnsafe/symlink'],
  ]) {
   const original=join(adapter,'internal/frames',file),source=readFileSync(original,'utf8');
   const mutant=source.replace(from,to);assert.notEqual(mutant,source);
   const target=join(dir,file);writeFileSync(target,mutant);
   const overlay=join(dir,'overlay.json');writeFileSync(overlay,JSON.stringify({Replace:{[original]:target}}));
   const r=run(['test','-overlay',overlay,'./internal/frames','-run','^'+pattern+'$','-count=1']);
   assert.equal(r.rc,1,r.output);assert.match(r.output,/--- FAIL:/,r.output);
  }
 }finally{rmSync(dir,{recursive:true,force:true});}
});

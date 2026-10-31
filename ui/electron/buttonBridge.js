// @ts-check
/** [TARGET, unit decision] One host-owned demo at a time. Operator Stop (as wired by installOperatorBridge) gives the owned
 * process group 300 seconds after SIGINT to seal evidence (tools/mv_demo.py itself waits up to 180 s for
 * the native seal and view restore, then copies and hashes the evidence), then escalates to
 * SIGKILL. Quit-time disposal (and output-overflow failure) keeps the short 10 second budget, even when
 * it arrives during an operator Stop: the escalation timer is re-armed to the shorter budget.
 * Completion and ownership are retained until child exit, including failures.
 * Packaged demos use the operator-supplied MV_OPERATOR_REPO checkout because
 * mw_home_check requires Git admission; packaged docs remain the entry source.
 * CLI errors stay private; the renderer receives closed public refusals.
 * A check result that declares a source other than the operator's own site is refused, so a
 * builtin copy can never be reported as the authored site (tool-side `source` is a DEMO handoff). */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {assertButtonCall, viewerUrl} from './preload.js';
/** @param {string} source */
export function promptBlock(source) {
  const blocks=[...source.matchAll(/^```text\r?\n([\s\S]*?)^```[ \t]*\r?$/gm)];
  if(blocks.length!==1)throw new Error('PROMPT_SOURCE');
  return blocks[0][1];
}
/** Product wiring budget of an operator Stop; the service default and quit-time disposal stay at the short budget. */
export const OPERATOR_STOP_BUDGET_MS=300000;
export const DISPOSE_BUDGET_MS=10000;
/** @param {{writeText:(text:string)=>void}} clipboard @param {string} text */
export function copyBounded(clipboard,text) {
  const bytes=Buffer.byteLength(text,'utf8');
  if(bytes<1 || bytes>16384)throw new Error('CLIPBOARD_BOUND');
  clipboard.writeText(text);
}
/** @param {any} options */
export function createButtonService({root,demoRoot=root,clipboard,env=process.env,spawnTool=spawn,killGroup=process.kill,stopBudgetMs=DISPOSE_BUDGET_MS,disposeBudgetMs=DISPOSE_BUDGET_MS}) {
  /** @type {any} */let active=null;
  let sealedDemo='';
  const childEnv=Object.fromEntries(['PATH','LANG','LC_ALL','TMPDIR','TZ','HOME','XDG_RUNTIME_DIR','XDG_STATE_HOME','XDG_CONFIG_HOME','MV_SRF_BIN_DIR','MV_SRF_STATE_DIR','SRF_IDENTITY_STORE_ROOT','MV_MW_HOME','MV_MEMORYWEB_REPO'].filter(k=>typeof env[k]==='string').map(k=>[k,env[k]]));
  /** @param {string} verb @param {any} v */
  function launch(verb,v) {
    if(typeof demoRoot!=='string')throw new Error('DEMO_RUNTIME');
    const argv=[join(demoRoot,'tools/mv_demo.py'),verb,...(verb==='record'?['--identity',v.identity,'--demo',v.demo]:verb==='prompt'?['--demo',v.demo,'--site',v.site]:['--site',v.site])];
    const child=spawnTool('python3',argv,{shell:false,env:childEnv,stdio:['ignore','pipe','pipe'],detached:true});
    let output=Buffer.alloc(0),bytes=0,settled=false,announced=false,failed=false,armedMs=0;
    /** @type {Promise<any>|undefined} */let stopping;
    /** @type {ReturnType<typeof setTimeout>|undefined} */let stopTimer;
    /** @type {(value:any)=>void} */let finish;
    /** @type {(value:any)=>void} */let announce;
    const done=new Promise(resolve=>{finish=resolve;});
    const ready=new Promise(resolve=>{announce=resolve;});
    /** @param {NodeJS.Signals} signal */
    function signalGroup(signal) {
      try {if(child.pid)killGroup(-child.pid,signal);}catch{/* Already exited. */}
    }
    /** @param {number} budgetMs */
    function armKill(budgetMs) {
      armedMs=budgetMs;
      stopTimer=setTimeout(()=>{failed=true;signalGroup('SIGKILL');},budgetMs);
    }
    /** A later caller with a shorter budget (quit-time disposal, output overflow) re-arms the
     * escalation timer so an in-flight 300 s operator Stop can never outlive the window.
     * @param {number} [budgetMs] */
    function stop(budgetMs=stopBudgetMs) {
      if(stopping) {
        if(!settled && budgetMs<armedMs){clearTimeout(stopTimer);armKill(budgetMs);}
        return stopping;
      }
      stopping=done;
      if(!settled){
        armKill(budgetMs);
        signalGroup('SIGINT');
      }
      return stopping;
    }
    const fail=()=>{if(settled || failed)return;failed=true;clearTimeout(timer);void stop(disposeBudgetMs);};
    const timer=setTimeout(fail,verb==='record'?30000:420000);
    child.stderr.on('data',(/** @type {Buffer} */b)=>{bytes+=b.length;if(bytes>65536)fail();});
    child.stdout.on('data',(/** @type {Buffer} */b)=>{
      bytes+=b.length;if(bytes>65536){fail();return;}
      output=Buffer.concat([output,b]);
      if(verb==='record' && !announced && output.includes(10)) {
        try {
          const row=JSON.parse(output.subarray(0,output.indexOf(10)).toString('utf8'));
          if(Object.keys(row).length!==1 || !viewerUrl(row.url))throw new Error();
          announced=true;clearTimeout(timer);announce({ok:true,url:row.url});
        }catch{fail();}
      }
    });
    child.once('error',fail);
    child.once('close',(/** @type {number} */rc)=>{
      if(settled)return;settled=true;clearTimeout(timer);clearTimeout(stopTimer);
      let reply={ok:false,code:'DEMO_REFUSED'};
      try {
        if(failed || rc!==0)throw new Error();
        const text=output.toString('utf8');
        if(verb==='prompt')copyBounded(clipboard,promptBlock(text));
        else {
          const row=JSON.parse(text.trim().split('\n').at(-1)??'');
          if(row.schema!=='metaviewer.demo/v1' || row.ok!==true || !row.result || (verb==='record' && !announced) || (verb==='check' && (row.result.site!==v.site || row.result.validated!==true || (row.result.source!==undefined && row.result.source!=='user'))))throw new Error();
        }
        reply=/** @type {any} */({ok:true});
      }catch{/* Public refusal only. */}
      announce(reply);finish(reply);
    });
    return {done,ready,stop,demo:v.demo};
  }
  /** @param {string} method @param {any[]} args */
  async function request(method,args) {
    assertButtonCall(method,args);
    const v=args[0];
    try {
      if(method==='entry.copy'){copyBounded(clipboard,promptBlock(readFileSync(join(root,'docs/AGENT_ENTRY.md'),'utf8')));return {ok:true};}
      if(method==='demo.start') {
        if(active)return {ok:false,code:'DEMO_BUSY'};
        sealedDemo='';const run=launch('record',v);active=run;
        // Keep successful seals for Stop; release failed runs only after exit.
        void run.done.then((/** @type {any} */reply)=>{if(!reply.ok && active===run)active=null;});
        run.demo=v.demo;
        const reply=await run.ready;
        if(!reply.ok && active===run)active=null;
        return reply;
      }
      if(method==='demo.stop') {
        if(!active)return {ok:false,code:'DEMO_NOT_RECORDING'};
        const run=active;
        const reply=await run.stop();
        if(reply.ok)sealedDemo=run.demo;
        if(active===run)active=null;return reply;
      }
      if(active)return {ok:false,code:'DEMO_BUSY'};
      if(method==='demo.prompt' && sealedDemo!==v.demo)return {ok:false,code:'DEMO_REFUSED'};
      return await launch(method==='demo.prompt'?'prompt':'check',v).done;
    }catch{return {ok:false,code:'BUTTON_UNAVAILABLE'};}
  }
  return {request,async dispose(){if(active){const run=active;await run.stop(disposeBudgetMs);if(active===run)active=null;}}};
}

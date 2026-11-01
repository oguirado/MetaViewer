// Isolated role-tile probe. Never imported by the product or its Control button.
const electron = require('electron');
const { app, BrowserWindow } = electron;
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const net = require('node:net');
const root = process.env.MV_XPRA_SPIKE_ROOT;
const ledger = '/home/admin/Música/TeamWork_Antigravity2/campaigns/metaviewer-0/out/pids.log';
if (!root?.startsWith('/tmp/claude-1000/xpra-spike/operator-') || fs.realpathSync(root)!==root) throw Error('ROOT_REFUSED');
app.setPath('userData',path.join(root,'operator-user-data'));
app.setPath('sessionData',path.join(root,'operator-session-data'));
const record = row => fs.appendFileSync(ledger,JSON.stringify({unit:'XPRA-DEMO-SEGMENT',root,...row})+'\n');
const command = row => fs.appendFileSync(path.join(root,'commands.jsonl'),JSON.stringify(row)+'\n');
function child(argv, options={}) {
  const p=spawn(argv[0],argv.slice(1),{stdio:['pipe','pipe','pipe'],...options});
  record({pid:p.pid,kind:'main-child'});
  return p;
}
async function run(argv, {quiet=false}={}) {
  const p=child(argv);let out='',err='';
  p.stdout.on('data',b=>{if(out.length<1024*1024)out+=b;});
  p.stderr.on('data',b=>{if(err.length<4096)err+=b;});p.stdin.end();
  const rc=await new Promise((resolve,reject)=>{p.once('error',reject);p.once('exit',resolve);});
  command({command:argv,rc});
  if(rc!==0)throw Error('COMMAND_FAILED '+path.basename(argv[0])+' '+argv[1]+' rc='+rc);
  return quiet?'':out.trim();
}
const surface=(...args)=>[path.join(root,'srf-identity-surface'),...args,'--state-dir',path.join(root,'state'),
  '--store-root',path.join(root,'identities'),'--registry',path.join(root,'registry/registry.json'),
  '--proxy','http://172.30.80.2:3128'];
let win,tile,bridge,trace,origin,capsule,containerID;
let human=false,closing=false,owned=false;
let finalRC=0;
async function close(reason) {
  if(closing)return;closing=true;human=false;
  console.log('CLOSING '+reason+'; agent remains blocked');
  const failures=[];
  if(trace)trace.setActive(false);
  if(tile){try{await tile.close();}catch{failures.push('TILE_CLOSE');}tile=null;}
  if(bridge){try{await bridge.close();}catch{failures.push('BRIDGE_CLOSE');}bridge=null;}
  if(origin) {
    const dead=await new Promise(resolve=>{const s=net.connect(new URL(origin).port,'127.0.0.1');s.once('connect',()=>{s.destroy();resolve(false);});s.once('error',()=>resolve(true));});
    console.log('BRIDGE_DEAD '+dead);if(!dead)failures.push('BRIDGE_STILL_LISTENING');
  }
  if(owned) {
    try { console.log('READONLY_ACK '+await run(surface('human','--container',capsule,'--readonly','--timeout','150s'))); } catch { failures.push('READONLY_UNPROVEN'); }
    try {
      const id=await run(['docker','inspect','--format','{{.Id}}',capsule]);
      if(containerID && id!==containerID)throw Error('CONTAINER_REPLACED');
      await run(surface('stop','--container',capsule,'--timeout','150s'));
      const remaining=await run(['docker','ps','-aq','--filter','name=^/'+capsule+'$']);
      if(remaining)throw Error('CAPSULE_REMAINS');
      console.log('CAPSULE_REMOVED '+capsule);
    } catch {failures.push('CAPSULE_CLEANUP_UNPROVEN');}
  }
  if(win&&!win.isDestroyed())win.destroy();
  if(failures.length){finalRC=1;console.error('FAILED '+failures.join(','));}
  console.log('SESSION_END '+JSON.stringify({reason,failures,agentAdmission:'blocked'}));
  app.exit(finalRC);
}
if(!app.requestSingleInstanceLock()){console.error('SINGLE_INSTANCE');app.exit(7);}
else {
  app.on('window-all-closed',()=>{});
  app.on('before-quit',event=>{if(!closing){event.preventDefault();void close('quit');}});
  for(const sig of ['SIGTERM','SIGINT'])process.on(sig,()=>void close(sig));
  app.whenReady().then(async()=>{
    console.log('OPERATOR_LOCK_ISOLATED '+app.getPath('userData'));
    const request=process.argv[2];
    fs.mkdirSync(path.join(root,'state'),{mode:0o700,recursive:true});
    if(request==='--new') {
      capsule='srf-id-mv-live-3-xpra-demo-'+randomBytes(4).toString('hex');
      if(await run(['docker','ps','-aq','--filter','name=^/'+capsule+'$']))throw Error('CAPSULE_NAME_IN_USE');
      record({container:capsule,kind:'own-demo-capsule-reserved'});
      await run([path.join(root,'srf-identity-admin'),'create','--store-root',path.join(root,'identities'),
        '--id','mv-live-3','--label','Logged out xpra demo','--domains','example.org'],{quiet:true});
      // Fresh empty profile only; opaque browser payload is never opened or enumerated.
      await run(['docker','run','--rm','--network','none','--user','0:0','--read-only','--cap-drop','ALL','--cap-add','CHOWN',
        '--mount','type=bind,src='+path.join(root,'identities/profiles/mv-live-3')+',dst=/profile',
        '--entrypoint','/bin/chown','opensuperficies-identity-browser-arm64:0.1.0','10001:10001','/profile']);
      owned=true;
      const started=JSON.parse(await run(surface('start','--identity','mv-live-3','--capsule',capsule,'--windows','1','--timeout','150s')));
      if(started.container!==capsule)throw Error('START_BINDING_REFUSED');
      containerID=await run(['docker','inspect','--format','{{.Id}}',capsule]);
      fs.writeFileSync(path.join(root,'demo.json'),JSON.stringify({capsule,containerId:containerID,agentAdmission:'blocked',dedicatedDemo:true}),{mode:0o600,flag:'wx'});
    } else {
      if(!/^srf-id-mv-live-[34]-xpra-demo-[a-f0-9]{8}$/.test(request))throw Error('PRODUCT_CAPSULE_REFUSED');
      const witness=JSON.parse(fs.readFileSync(path.join(root,'demo.json'),'utf8'));
      if(witness.capsule!==request||witness.agentAdmission!=='blocked'||witness.dedicatedDemo!==true)throw Error('DEDICATED_DEMO_WITNESS_REQUIRED');
      capsule=request;containerID=await run(['docker','inspect','--format','{{.Id}}',capsule]);
      if(containerID!==witness.containerId)throw Error('CONTAINER_REPLACED');owned=true;
    }
    const ack=JSON.parse(await run(surface('human','--container',capsule,'--writable','--timeout','150s')));
    if(!ack.ready||!ack.writable)throw Error('WRITABLE_ACK_ABSENT');human=true;
    console.log('WRITABLE_ACK '+JSON.stringify(ack));
    const {openXpraHumanBridge}=await import('../ui/electron/xpraHumanBridge.js');
    const {createHumanTrace}=await import('../ui/electron/humanTrace.js');
    trace=createHumanTrace({sessionId:path.basename(root),surfaceId:'r2',capsuleId:capsule,write:line=>fs.appendFileSync(path.join(root,'human-trace.jsonl'),line)});
    bridge=await openXpraHumanBridge({viewRoot:path.join(root,'state/view'),capsule,expectedSocketUid:10001,jquery:fs.readFileSync('/usr/share/javascript/jquery/jquery.js')});origin=bridge.origin;
    win=new BrowserWindow({x:0,y:0,width:1400,height:960,useContentSize:true,frame:false,show:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
    await win.loadURL('data:text/html,<title>Isolated product role tile R2</title>');
    const baseline=await run(['git','show','9ccd712d3:ui/electron/xpraHumanTile.js']);
    const baselineModule=baseline.replace("fileURLToPath(new URL('./xpraTracePreload.cjs', import.meta.url))",JSON.stringify(path.resolve(__dirname,'../ui/electron/xpraTracePreload.cjs')));
    const legacy=await import('data:text/javascript;base64,'+Buffer.from(baselineModule).toString('base64'));
    let watch=false;
    async function mount(q) {
      if(tile){await tile.close();tile=null;}
      const readonly=q.role==='agent';
      if(readonly!==watch){
        const ack=JSON.parse(await run(surface('human','--container',capsule,readonly?'--readonly':'--writable','--timeout','150s')));
        if(!ack.ready||ack.writable===readonly)throw Error('MODE_ACK_ABSENT');watch=readonly;console.log('MODE_ACK '+JSON.stringify(ack));
        await bridge.close();bridge=await openXpraHumanBridge({viewRoot:path.join(root,'state/view'),capsule,expectedSocketUid:10001,jquery:fs.readFileSync('/usr/share/javascript/jquery/jquery.js')});origin=bridge.origin;
      }
      const mod=q.product?await import('../ui/electron/xpraHumanTile.js?r2='+Date.now()):legacy;
      const query=q.query==='full'?'?connect=1&username=worker&encoding=rgb&bandwidth_limit=0&clipboard=false&notifications=false'+(readonly?'&readonly=1':''):readonly?'?readonly=1&resize=0':'?resize=0';
      tile=await mod.attachXpraHumanTile({electron,window:win,bridge,bounds:{x:0,y:0,width:q.native?1280:601,height:q.native?900:422},trace,isActive:()=>human,capsuleSize:()=>({width:1280,height:900}),writable:!readonly,clientQuery:query,onFailure:e=>console.log('TILE_FAILURE '+e.message)});
      return {mounted:true,watch,zoom:tile.view.webContents.getZoomFactor()};
    }
    await mount({product:true,query:'full'});
    fs.writeFileSync(path.join(root,'ready.json'),JSON.stringify({pid:process.pid,capsule,origin}));
    console.log('PRODUCT_READY');
    let servicing=false;
    const timer=setInterval(async()=>{
      const input=path.join(root,'rehearse.json');if(!fs.existsSync(input)||closing||servicing)return;servicing=true;
      let q;try{q=JSON.parse(fs.readFileSync(input));fs.unlinkSync(input);}catch{servicing=false;return;}
      try {
        let result,wc=tile?.view.webContents;
        if(q.op==='mount')result=await mount(q);
        else if(q.op==='status')result=await wc.executeJavaScript(`(()=>{const window=globalThis.document.getElementById('metaviewer-xpra-client')?.contentWindow||globalThis;const document=window.document;const {innerWidth,innerHeight}=window;return ({connected:!!window.client?.connected,readonly:window.client?.server_readonly,serverOk:window.client?.server_ok,inner:[innerWidth,innerHeight],desktop:[window.client?.desktop_width,window.client?.desktop_height],windows:Object.values(window.client?.id_to_window||{}).map(w=>({w:w.w,h:w.h})),canvases:[...document.querySelectorAll('canvas')].map(c=>({w:c.width,h:c.height})),body:document.body.innerText.slice(0,300)})})()`);
        else if(q.op==='pixel')result=[...(await wc.capturePage({x:q.x,y:q.y,width:1,height:1})).getBitmap()];
        else if(q.op==='cadence')result=await wc.executeJavaScript(`new Promise(resolve=>{const c=(document.getElementById('metaviewer-xpra-client')?.contentDocument||document).querySelector('canvas').getContext('2d');const t=performance.now();let last=null,changed=0,samples=0;function tick(){let n=0;for(let i=0;i<16;i++){const p=c.getImageData(15+i*30,105,1,1).data;if(p[1]>200&&p[0]<50)n|=1<<i;}if(last!==null&&n!==last)changed++;last=n;samples++;const ms=performance.now()-t;if(ms<${Math.max(1,Math.min(90,Number(q.seconds)||30))*1000})requestAnimationFrame(tick);else resolve({changed,samples,durationMs:ms,fps:changed*1000/ms});}tick();})`);
        else if(q.op==='close'){clearInterval(timer);fs.writeFileSync(path.join(root,'rehearse-result.json'),JSON.stringify({id:q.id,result:{closing:true}}));void close('rehearsal');return;}
        else throw Error('OP_REFUSED');
        fs.writeFileSync(path.join(root,'rehearse-result.json'),JSON.stringify({id:q.id,result}));
        fs.appendFileSync(path.join(root,'measurements.jsonl'),JSON.stringify({request:q,result})+'\n');
      }catch(e){fs.writeFileSync(path.join(root,'rehearse-result.json'),JSON.stringify({id:q.id,error:e.message}));}
      finally{servicing=false;}
    },30);
  }).catch(error=>{console.error(error.message);finalRC=1;void close('startup-failed');});
}

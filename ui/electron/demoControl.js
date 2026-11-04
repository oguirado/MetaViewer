// @ts-check
/** Private CLI attachment to the existing host recorder. No renderer paths,
 * process IDs, shell commands or network listener are admitted. */
import {createServer} from 'node:net';
import {mkdirSync,lstatSync,chmodSync,unlinkSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {assertButtonCall} from './preload.js';
export const DEMO_CONTROL_SCHEMA='metaviewer.demo_control/v1';
/** @param {any} row */
export function assertDemoRequest(row) {
  if(!row || !Array.isArray(row.args) || typeof row!=='object' || Array.isArray(row) || Object.keys(row).sort().join(',')!=='args,method,schema,session_id' || row.schema!==DEMO_CONTROL_SCHEMA || typeof row.session_id!=='string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(row.session_id) || !['demo.start','demo.stop','demo.prompt','demo.check'].includes(row.method))throw new Error('DEMO_REQUEST');
  assertButtonCall(row.method,row.args);return row;
}
/** @param {{env:any,buttons:any,privateDirectory:Function}} options */
export function installDemoControl({env,buttons,privateDirectory}) {
  if(typeof env.XDG_RUNTIME_DIR!=='string' || !isAbsolute(env.XDG_RUNTIME_DIR) || typeof env.MV_SESSION_ID!=='string')return null;
  const dir=join(env.XDG_RUNTIME_DIR,'metaviewer'),path=join(dir,'demo.sock');
  try{mkdirSync(dir,{mode:0o700});}catch(e){if(/** @type {NodeJS.ErrnoException} */(e).code!=='EEXIST')throw e;}
  privateDirectory(dir,()=>{});
  let bound=false,disposed=false;
  /** @type {number[]|null} */let identity=null;
  const sockets=new Set();
  const server=createServer(socket=>{
    sockets.add(socket);let pending='',started=false;
    /** @type {any} */let owned=null;
    /** @param {string} event @param {any} reply @param {any} [extra] */
    const send=(event,reply,extra={})=>{if(!socket.destroyed)socket.write(JSON.stringify({schema:DEMO_CONTROL_SCHEMA,session_id:env.MV_SESSION_ID,event,reply,...extra})+'\n');};
    const refuse=()=>{send('done',{ok:false,code:'DEMO_REFUSED'});socket.end();};
    socket.setTimeout(30000,()=>socket.destroy());
    socket.on('error',()=>{});
    socket.on('close',()=>{sockets.delete(socket);if(owned && owned.phase!=='idle')void owned.stop();});
    socket.on('data',chunk=>{
      pending+=chunk.toString('utf8');
      if(Buffer.byteLength(pending)>8192){socket.destroy();return;}
      while(pending.includes('\n')) {
        const end=pending.indexOf('\n'),line=pending.slice(0,end);pending=pending.slice(end+1);
        void handle(line);
      }
    });
    /** @param {string} line */
    async function handle(line) {
      try {
        const row=assertDemoRequest(JSON.parse(line));
        if(disposed || row.session_id!==env.MV_SESSION_ID)throw new Error('DEMO_SESSION');
        if(started) {
          if(row.method!=='demo.stop' || !owned)throw new Error('DEMO_REQUEST');
          await owned.stop();return;
        }
        started=true;socket.setTimeout(0);
        if(row.method==='demo.start') {
          owned=buttons.record(row.args[0]);
          if(!owned){send('ready',{ok:false,code:'DEMO_BUSY'});socket.end();return;}
          const ready=await owned.ready;send('ready',ready);
          if(socket.destroyed && owned.phase!=='idle')void owned.stop();
          const reply=await owned.done;
          buttons.finishRecord(owned,reply);
          send('done',reply,reply.ok?{result:owned.payload}:{});socket.end();
        } else if(row.method==='demo.stop') {
          send('done',await buttons.request('demo.stop',[]));socket.end();
        } else {
          const result=await buttons.cliTool(row.method,row.args);
          send('done',result.reply,result.reply.ok?(row.method==='demo.prompt'?{text:result.text}:{result:result.result}):{});socket.end();
        }
      }catch{refuse();}
    }
  });
  // Never remove an unknown incumbent socket to make a launch succeed.
  server.on('error',()=>{});
  server.listen(path,()=>{bound=true;chmodSync(path,0o600);const st=lstatSync(path);identity=[st.dev,st.ino];});
  server.unref();
  return {path,async dispose(){
    disposed=true;for(const socket of sockets)socket.destroy();
    await new Promise(resolve=>{try{server.close(()=>resolve(null));}catch{resolve(null);}});
    if(bound){try{const st=lstatSync(path);if(st.isSocket() && st.dev===identity?.[0] && st.ino===identity?.[1])unlinkSync(path);}catch{}}
  }};
}

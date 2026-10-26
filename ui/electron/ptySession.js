// @ts-check
/** [TARGET, unit decision] Direct spawn seam for utilityProcess: trusted main
 * supplies the spec. No shell command strings. Byte-port credit is cumulative.
 */
/** @typedef {{file:string,args:string[],cwd:string,env:Record<string,string>}} SpawnSpec */
/** @param {SpawnSpec} spec */
export function validateSpawnSpec(spec) {
  if (!spec || Object.keys(spec).sort().join(',') !== 'args,cwd,env,file'
      || typeof spec.file !== 'string' || !spec.file.startsWith('/')
      || typeof spec.cwd !== 'string' || !spec.cwd.startsWith('/')
      || !Array.isArray(spec.args) || spec.args.length > 32
      || ![spec.file,spec.cwd,...spec.args].every(s => typeof s === 'string' && s.length <= 4096 && !s.includes('\0'))
      || !spec.env || typeof spec.env !== 'object' || Array.isArray(spec.env)
      || Object.entries(spec.env).some(([k,v]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v !== 'string' || v.length > 4096 || v.includes('\0'))) throw new Error('INVALID_SPAWN_SPEC');
  return { file:spec.file,args:[...spec.args],cwd:spec.cwd,env:{...spec.env} };
}
/** @typedef {{onData:(fn:(data:string|Uint8Array)=>void)=>{dispose:()=>void},onExit:(fn:(event:{exitCode:number})=>void)=>{dispose:()=>void},write:(data:string|Buffer)=>void,resize:(cols:number,rows:number)=>void,pause:()=>void,resume:()=>void,kill:()=>void}} Pty */
/** @param {{session:string,spec:SpawnSpec,spawn:(file:string,args:string[],options:object)=>Pty,send:(message:object)=>void}} options */
export function createPtySession({session,spec,spawn,send}) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(session)) throw new Error('INVALID_SESSION');
  const owned = validateSpawnSpec(spec);
  const pty = spawn(owned.file,owned.args,{cwd:owned.cwd,env:owned.env,name:'xterm-256color',cols:80,rows:24,encoding:null});
  let seq=0,sent=0,acked=0,ackSeq=0,inputSeq=0,closed=false,paused=false;
  /** @type {Map<number,number>} */
  const boundaries = new Map();
  function close() { if (!closed) { closed=true; pty.kill(); boundaries.clear(); } }
  pty.onData(data => {
    if (closed) return;
    const bytes=typeof data==='string'?new Uint8Array(Buffer.from(data)):new Uint8Array(data);
    if(bytes.length>65536 || sent-acked+bytes.length>524288 || boundaries.size>=256) {
      close(); send({session,error:'OUTPUT_OVERFLOW'}); return;
    }
    sent+=bytes.length; boundaries.set(++seq,sent); send({session,seq,bytes});
    if(!paused && sent-acked>=131072) {paused=true;pty.pause();}
  });
  pty.onExit(event=>{closed=true;boundaries.clear();send({session,exitCode:event.exitCode});});
  /** @param {unknown} message */
  function receive(message) {
    if(closed || !message || typeof message!=='object') throw new Error('CLOSED_OR_INVALID');
    const m=/** @type {Record<string,unknown>} */(message);
    if(m.session!==session) throw new Error('SESSION_MISMATCH');
    const keys=Object.keys(m).sort().join(',');
    if(keys==='bytes,seq,session' && m.bytes instanceof Uint8Array) {
      if(m.seq!==inputSeq+1 || m.bytes.length>65536) throw new Error('INVALID_INPUT');
      pty.write(Buffer.from(m.bytes));inputSeq++;return;
    }
    if(keys==='ack,bytes,session' && typeof m.ack==='number' && typeof m.bytes==='number') {
      if(m.ack<=ackSeq || boundaries.get(m.ack)!==m.bytes) throw new Error('INVALID_ACK');
      ackSeq=m.ack;acked=m.bytes;
      for(const key of boundaries.keys()) if(key<=ackSeq) boundaries.delete(key);
      if(paused && sent-acked<65536) {paused=false;pty.resume();} return;
    }
    if(keys==='cols,rows,session' && Number.isSafeInteger(m.cols) && Number.isSafeInteger(m.rows)
      && Number(m.cols)>0 && Number(m.cols)<=500 && Number(m.rows)>0 && Number(m.rows)<=300) {
      pty.resize(Number(m.cols),Number(m.rows));return;
    }
    throw new Error('INVALID_MESSAGE');
  }
  return Object.freeze({receive,close});
}

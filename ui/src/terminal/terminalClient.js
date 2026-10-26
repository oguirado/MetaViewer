// @ts-check
/** [TARGET, unit decision] Parser completion is the output-credit boundary.
 * Port payloads stay outside Vue; disposal invalidates late parser callbacks.
 */
/** @param {{session:string,port:MessagePort,write:(bytes:Uint8Array,done:()=>void)=>void,onStatus:(status:string)=>void}} options */
export function createTerminalClient({session,port,write,onStatus}) {
  let active=true, received=0, ackSeq=0, consumed=0, inputSeq=0;
  /** @type {Map<number,{length:number,done:boolean}>} */
  const pending=new Map();
  /** @param {MessageEvent} event */
  function receive(event) {
    if(!active) return;
    const m=event.data;
    if(!m || m.session!==session) {active=false;onStatus('Terminal binding refused');return;}
    if(typeof m.error==='string' || Number.isInteger(m.exitCode)) {active=false;onStatus(m.error??`Exited (${m.exitCode})`);return;}
    if(Object.keys(m).sort().join(',')!=='bytes,seq,session' || !(m.bytes instanceof Uint8Array)
      || m.seq!==received+1 || m.bytes.length>65536 || pending.size>=256) {
      active=false;onStatus('Terminal stream refused');return;
    }
    received=m.seq;
    const seq=received;
    pending.set(seq,{length:m.bytes.length,done:false});
    write(m.bytes,()=>{
      if(!active) return;
      const entry=pending.get(seq);if(!entry || entry.done) return;entry.done=true;
      let changed=false;
      while(pending.get(ackSeq+1)?.done) {
        const next=pending.get(++ackSeq); if(!next) break;
        consumed+=next.length;pending.delete(ackSeq);changed=true;
      }
      if(changed) port.postMessage({session,ack:ackSeq,bytes:consumed});
    });
  }
  port.addEventListener('message',receive);port.start();
  return Object.freeze({
    input(/** @type {Uint8Array} */ bytes) {
      if(active && bytes.length<=65536) port.postMessage({session,seq:++inputSeq,bytes});
    },
    dispose() {active=false;pending.clear();port.removeEventListener('message',receive);},
  });
}

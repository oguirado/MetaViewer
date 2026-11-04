import {buildCapsuleReadyLine,isCapsuleSurfaceId} from '../wall/capsuleId.js';

/** One retained host-shell slot per exact capsule id, using the existing broker.
 * @param {any} controller */
export function createPairedTerminals(controller) {
  const pairs=new Map(), pending=new Map();
  let launchTail=Promise.resolve();
  const prune=()=>{for(const [id,pair] of pairs) if(!controller.findSlot(pair.slotId)) pairs.delete(id);};
  return {
    /** @param {{surfaceId:string,profileId?:string,title?:string}} target */
    async open(target) {
      if (!target || !isCapsuleSurfaceId(target.surfaceId)) throw Error('PAIRED_CAPSULE_INVALID');
      prune();
      if (pending.has(target.surfaceId)) return pending.get(target.surfaceId);
      const identityLine=buildCapsuleReadyLine(target);
      const existing=pairs.get(target.surfaceId);
      if (existing) {
        const pair={...existing,identityLine,title:target.title || target.surfaceId};
        pairs.set(target.surfaceId,pair);return pair;
      }
      const opening=launchTail.then(async()=>{
        const slot=await controller.launchProfile('shell',{focus:false});
        const pair=Object.freeze({surfaceId:target.surfaceId,slotId:slot.id,identityLine,title:target.title || target.surfaceId});
        pairs.set(target.surfaceId,pair);return pair;
      });
      launchTail=opening.then(()=>undefined,()=>undefined);
      pending.set(target.surfaceId,opening);
      try {return await opening;} finally {pending.delete(target.surfaceId);}
    },
    /** @param {string|null} slotId */
    forSlot(slotId) {prune();return [...pairs.values()].find(pair=>pair.slotId===slotId) ?? null;},
  };
}

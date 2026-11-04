import {buildCapsuleReadyLine,isCapsuleSurfaceId} from '../wall/capsuleId.js';

/** One retained host-shell slot per exact capsule id, using the existing broker.
 * @param {any} controller */
export function createPairedTerminals(controller) {
  const pairs=new Map();
  let launchTail=Promise.resolve();
  const prune=()=>{for(const [id,pair] of pairs) if(!controller.findSlot(pair.slotId)) pairs.delete(id);};
  return {
    /** @param {{surfaceId:string,profileId?:string,title?:string}} target
     * @param {string} [terminalProfile] */
    async open(target,terminalProfile) {
      if (!target || !isCapsuleSurfaceId(target.surfaceId)) throw Error('PAIRED_CAPSULE_INVALID');
      prune();
      const identityLine=buildCapsuleReadyLine(target);
      const opening=launchTail.then(async()=>{
        prune();
        const existing=pairs.get(target.surfaceId);
        // Reopening a pair preserves its agent; only an explicit choice replaces it.
        const profile=terminalProfile ?? existing?.terminalProfile ?? 'shell';
        const live=existing && controller.findSlot(existing.slotId);
        if(existing && live && terminalProfile===undefined && existing.terminalProfile===profile && live?.slot?.status!=='exited') {
          const pair={...existing,profileId:target.profileId,identityLine,title:target.title || target.surfaceId};
          pairs.set(target.surfaceId,pair);return pair;
        }
        const slot=await controller.launchProfile(profile,{focus:false,...(existing?{reuseSlotId:existing.slotId}:{})});
        const pair=Object.freeze({surfaceId:target.surfaceId,profileId:target.profileId,slotId:slot.id,terminalProfile:profile,identityLine,title:target.title || target.surfaceId});
        pairs.set(target.surfaceId,pair);return pair;
      });
      launchTail=opening.then(()=>undefined,()=>undefined);
      return opening;
    },
    /** @param {string|null} slotId */
    forSlot(slotId) {prune();return [...pairs.values()].find(pair=>pair.slotId===slotId) ?? null;},
  };
}

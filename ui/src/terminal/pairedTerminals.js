import {buildCapsuleReadyLine,isCapsuleSurfaceId} from '../wall/capsuleId.js';
import {assertMicrovmContext,microvmIdentity} from './workflowPrompts.js';

/** @param {any} target */
export function pairedTargetId(target) {return target?.kind==='microvm'?target.workloadId:target?.surfaceId;}


/** One retained host-shell slot per exact capsule id, using the existing broker.
 * @param {any} controller */
export function createPairedTerminals(controller) {
  const pairs=new Map();
  let launchTail=Promise.resolve();
  const prune=()=>{for(const [id,pair] of pairs) if(!controller.findSlot(pair.slotId)) pairs.delete(id);};
  return {
    /** @param {any} target
     * @param {string} [terminalProfile] */
    async open(target,terminalProfile) {
      const microvmContext=target?.kind==='microvm' ? assertMicrovmContext(Object.fromEntries(['kind','workloadId','generation','ownerId','profileId','backend','isa'].map(key=>[key,target[key]]))) : undefined;
      if (!microvmContext && (!target || !isCapsuleSurfaceId(target.surfaceId))) throw Error('PAIRED_CAPSULE_INVALID');
      const id=pairedTargetId(target), key=microvmContext?`microvm:${id}`:`surface:${id}`;
      const binding=microvmContext ? {...microvmContext,microvmContext} : {surfaceId:target.surfaceId,profileId:target.profileId};
      prune();
      const identityLine=microvmContext?microvmIdentity(microvmContext):buildCapsuleReadyLine(target);
      const opening=launchTail.then(async()=>{
        prune();
        const existing=pairs.get(key);
        // Reopening a pair preserves its agent; only an explicit choice replaces it.
        const profile=terminalProfile ?? existing?.terminalProfile ?? 'shell';
        const live=existing && controller.findSlot(existing.slotId);
        if(existing && live && terminalProfile===undefined && existing.terminalProfile===profile && live?.slot?.status!=='exited') {
          const pair={...existing,...binding,identityLine,title:target.title || id};
          pairs.set(key,pair);return pair;
        }
        const slot=await controller.launchProfile(profile,{focus:false,...(existing?{reuseSlotId:existing.slotId}:{})});
        const pair=Object.freeze({...binding,slotId:slot.id,terminalProfile:profile,identityLine,title:target.title || id});
        pairs.set(key,pair);return pair;
      });
      launchTail=opening.then(()=>undefined,()=>undefined);
      return opening;
    },
    /** @param {string|null} slotId */
    forSlot(slotId) {prune();return [...pairs.values()].find(pair=>pair.slotId===slotId) ?? null;},
  };
}

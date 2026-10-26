// @ts-check
/** [TARGET, unit decision] Missing port-to-canvas handoff: bytes stay in this
 * closure. ACK follows scheduler release after draw, fold drain or refusal.
 * Caller supplies admitted binding, budgets and presentation eligibility.
 */
import { createFramePort } from '../../electron/framePort.js';
import { createTileScheduler } from './tileScheduler.js';
/** @param {{port:import('../../electron/framePort.js').BrokeredPort,binding:import('../../electron/framePort.js').PortBinding,limits:import('../../electron/framePort.js').PortLimits,budget:import('./tileScheduler.js').FrozenTileBudget,state:object}} options */
export function createFrameTile({port,binding,limits,budget,state}) {
  /** @type {Map<string,(value:{outcome:string})=>void>} */
  const pending = new Map();
  const scheduler = createTileScheduler({ budget,
    onPresent: (/** @type {object} */ frame) => scheduler.presentHandle(frame),
    onReleaseLease: (/** @type {{leaseId:string,reason:string}} */ release) => {
      const done=pending.get(release.leaseId);pending.delete(release.leaseId);
      done?.({outcome:release.reason});
    },
  });
  const registered=scheduler.registerSurface({...binding,state});
  if(!registered.ok) throw new Error(registered.reason);
  const endpoint=createFramePort({port,binding,limits,role:'receiver',
    onReleaseLease:()=>{},
    onRevoke:()=>scheduler.destroySurface(binding.surfaceId),
    onFrame:frame=>new Promise(resolve=>{
      if(pending.has(frame.leaseId)) {
        resolve({outcome:'REFUSED'});return;
      }
      pending.set(frame.leaseId,resolve);
      const admitted=scheduler.submitFrame(frame);
      // The port verifies shape; submitFrame checks identity before its
      // folded refusal. Valid folded captures still advance the reopen floor.
      if(admitted.ok || admitted.reason==='FOLDED_DISPLAY_DISABLED') {
        scheduler.recordCaptureWitness({surfaceId:frame.surfaceId,surfaceGeneration:frame.surfaceGeneration,
          captureGeneration:frame.frameGeneration});
      }
      if(!admitted.ok) {
        pending.delete(frame.leaseId);resolve({outcome:'REFUSED'});
      }
    }),
  });
  return Object.freeze({ scheduler, endpoint, close() {
    endpoint.revokeFramePort('SHUTDOWN');scheduler.destroy();
    for(const done of pending.values()) done({outcome:'SURFACE_DESTROYED'});
    pending.clear();
  } });
}

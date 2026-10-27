// [TARGET, unit decision] Real tileScheduler/canvas consuming adapter RGB bytes.
import { createTileScheduler } from '../../ui/src/surfaces/tileScheduler.js';
window.paintFrame = ({ frame, bytes }) => {
  const canvas = document.querySelector('#tile');
  const scheduler = createTileScheduler({
    budget: Object.freeze({ maxDrawsPerTick: 1, maxUploadBytesPerTick: 4096,
      maxPresentMsPerTick: 8, maxWarmResourcesPerSurface: 0, maxDrainSteps: 4 }),
    onPresent: (event) => scheduler.presentHandle(event),
  });
  const binding = { surfaceId: frame.surface_id, surfaceGeneration: 1, principal: 'core', epoch: 1 };
  function need(result) { if (!result.ok) throw new Error(`E2E_ROUTING: ${result.reason}`); }
  need(scheduler.registerSurface({ ...binding, state: { width: 2, height: 1, viewportIntersecting: true } }));
  need(scheduler.attachCanvas({ surfaceId: frame.surface_id, canvas }));
  need(scheduler.submitFrame({ ...binding, frameGeneration: frame.generation,
    width: frame.width, height: frame.height, byteLength: bytes.length,
    bytes: new Uint8Array(bytes), sha256: frame.sha256, leaseId: `slice-${frame.generation}` }));
  const tick = scheduler.runTick();
  if (tick.presented.length !== 1) throw new Error('E2E_RENDER: no canvas presentation');
  const result = { surfaceId: frame.surface_id, generation: frame.generation,
    pixels: [...canvas.getContext('2d').getImageData(0, 0, 2, 1).data] };
  scheduler.destroy();
  return result;
};

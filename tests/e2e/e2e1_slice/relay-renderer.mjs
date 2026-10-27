// [TARGET, unit decision] Present real RGB bytes with the product tile scheduler.
import { createAuthorityRuntime } from '../../../ui/src/core/hostAdapters.js';
import { createFrameTile } from '../../../ui/src/surfaces/frameTile.js';
window.relayResult = new Promise((resolve,reject) => {
  window.relayStage='initializing';
  const runtime = createAuthorityRuntime(window.metaviewer.authority);
  let notice, tile;
  const stop = window.metaviewer.authority.subscribeFrames(value => {notice=value;window.relayNotice=value;window.relayStage='notice';});
  window.addEventListener('message', async event => {
    if (event.data?.type !== 'metaviewer:frame-port') return;
    window.relayPortReceived=true;window.relayStage='frame-port';
    try {
      if (!notice || 'ramws_path' in notice.frame_ref) throw new Error('notice missing or path exposed');
      const f = notice.frame_ref;
      const binding = {principal:'ui',epoch:1,surfaceId:f.surface_id,surfaceGeneration:1};
      tile = createFrameTile({port:event.ports[0],binding,
        limits:{maxFrameBytes:64*1024*1024,ackTimeoutMs:10000,maxSurfacesPerPort:1},
        // Match App.vue: this flat numeric object is deeply frozen.
        budget:Object.freeze({maxDrawsPerTick:4,maxUploadBytesPerTick:16777216,maxPresentMsPerTick:8,maxWarmResourcesPerSurface:1,maxDrainSteps:4}),
        state:{panelOpen:true,panelSelected:true,folded:false,width:f.width,height:f.height,
          viewportIntersecting:true,windowPresentationAllowed:true,contextLost:false}});
      const canvas = document.querySelector('#tile');
      tile.scheduler.attachCanvas({...binding,canvas});
      const deadline = performance.now()+5000;
      while (performance.now()<deadline) {
        tile.scheduler.runTick();
        const evidence = tile.scheduler.getInstrumentation(f.surface_id);
        if (evidence.presentCount>0) {
          const row = runtime.projectionView.getProjection()?.rows?.find(row=>row.surfaceId===f.surface_id);
          if (!row || row.generation!==f.generation) throw new Error('projection did not admit real frame');
          const rgba = canvas.getContext('2d').getImageData(0,0,f.width,f.height).data;
          const rgb = new Uint8Array(f.width*f.height*3);
          for(let i=0,j=0;i<rgba.length;i+=4) {rgb[j++]=rgba[i];rgb[j++]=rgba[i+1];rgb[j++]=rgba[i+2];}
          const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',rgb)),x=>x.toString(16).padStart(2,'0')).join('');
          resolve({ok:hash===f.sha256,sha256:hash,generation:f.generation,presentCount:evidence.presentCount,path_stripped:true});
          tile.close();stop();runtime.dispose();return;
        }
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      throw new Error('tile presentation timeout');
    } catch(error) { window.relayError=String(error);tile?.close();stop();runtime?.dispose();reject(String(error)); }
  });
});

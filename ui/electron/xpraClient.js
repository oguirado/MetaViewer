// Host-owned HTML5 client contract; no bridge capability enters this document.
const query = '?connect=1&username=worker&encoding=rgb&bandwidth_limit=0&clipboard=false&notifications=false';
/** @param {boolean} writable */
export const xpraClientQuery = writable => query + (writable ? '' : '&readonly=1');

// A CSS transform changes presentation and native hit testing, not the iframe's
// layout viewport. Electron page zoom is deliberately kept at one.
export const xpraTileDocument = `<!doctype html><meta charset="utf-8"><title>Capsule browser</title>
<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#182330}iframe{position:absolute;width:1280px;height:900px;border:0;transform-origin:0 0}</style>
<iframe id="metaviewer-xpra-client" title="Capsule browser"></iframe>
<script>
const frame=document.querySelector('iframe');
function fit(){const scale=Math.min(innerWidth/1280,innerHeight/900);frame.style.transform='scale('+scale+')';frame.style.left=(innerWidth-1280*scale)/2+'px';frame.style.top=(innerHeight-900*scale)/2+'px';}
addEventListener('resize',fit);fit();frame.src='/'+location.search;
</script>`;

/** Executed in the sandboxed wrapper; returns only readiness, never credentials.
 * @param {boolean} writable */
export const xpraReadyExpression = writable => `Boolean((()=>{
  const frame=document.getElementById('metaviewer-xpra-client');
  const page=frame?.contentWindow, doc=frame?.contentDocument, client=page?.client;
  return client?.connected && client.server_ok && client.server_readonly===${!writable} &&
    page.innerWidth===1280 && page.innerHeight===900 &&
    client.desktop_width===1280 && client.desktop_height===900 &&
    Object.values(client.id_to_window||{}).some(w=>w.w===1280&&w.h===900) &&
    [...doc.querySelectorAll('canvas')].some(c=>c.width===1280&&c.height===900);
})())`;

/** @param {{executeJavaScript:(source:string)=>Promise<any>}} contents
 * @param {{writable:boolean,isActive:()=>boolean,timeoutMs?:number}} options */
export async function waitForXpraClient(contents, {writable, isActive, timeoutMs = 30000}) {
  let stopped = false;
  const expired = Object.assign(Error('XPRA_CLIENT_READY_TIMEOUT'), {code:'XPRA_CLIENT_READY_TIMEOUT'});
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => { stopped = true; reject(expired); }, timeoutMs);
  });
  const probe = async () => {
    while (!stopped) {
      if (!isActive()) throw Object.assign(Error('XPRA_HUMAN_LEASE_LOST'), {code:'XPRA_HUMAN_LEASE_LOST'});
      if (await contents.executeJavaScript(xpraReadyExpression(writable)) === true) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  // A renderer that stops answering evaluations must also hit the deadline.
  try { await Promise.race([probe(), deadline]); }
  finally { stopped = true; clearTimeout(timer); }
}

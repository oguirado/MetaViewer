import './opfix-recording.js';
// A fixture control removes presentation only, as the orphan-prune path does.
// The production toolbar and navigation must recover the unchanged live rows.
const trigger=document.createElement('button');
trigger.textContent='Simulate missing panels';
trigger.style='position:fixed;bottom:8px;left:230px;z-index:9999';
trigger.onclick=()=>{
 const api=globalThis.opfixDockApis.get('main-wall-agent-1')?.();
 for(const panel of [...(api?.panels ?? [])])panel.api.close();
};
document.body.append(trigger);

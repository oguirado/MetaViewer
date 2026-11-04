const {contextBridge,ipcRenderer}=require('electron');
if(process.isMainFrame&&location.origin==='app://metaviewer'){
 const invoke=(message)=>ipcRenderer.invoke('metaviewer:capture.preferences.v0.3',message);
 contextBridge.exposeInMainWorld('metaviewerCapturePreferences',Object.freeze({
  get:()=>invoke({op:'get'}),chooseFolder:kind=>invoke({op:'choose',kind}),setMode:value=>invoke({op:'mode',value}),
  subscribe:callback=>{const listener=()=>callback();ipcRenderer.on('metaviewer:capture.preferences.changed',listener);return()=>ipcRenderer.removeListener('metaviewer:capture.preferences.changed',listener);},
 }));
}

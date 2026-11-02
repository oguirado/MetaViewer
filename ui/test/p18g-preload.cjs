const {contextBridge,ipcRenderer}=require('electron');
const call=(op,id,value)=>ipcRenderer.invoke('p18g:fixture',op,id,value);
contextBridge.exposeInMainWorld('metaviewerRoles',{
 status:id=>call('status',id),mount:(id,bounds)=>call('mount',id,bounds),resize:(id,bounds)=>call('resize',id,bounds),visibility:(id,v)=>call('visibility',id,v),close:id=>call('close',id),raise:id=>call('raise',id),
 onFocus:cb=>{const fn=(_e,id)=>cb(id);ipcRenderer.on('p18g:focus',fn);return()=>ipcRenderer.removeListener('p18g:focus',fn);}
});

const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('opfixNative',{launch:intent=>ipcRenderer.invoke('opfix-launch',intent)});

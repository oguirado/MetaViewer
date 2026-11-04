import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPTURE_PREFERENCES_CHANNEL, capturePreferencesHost } from './capturePreferences.js';
/** @param {any} options */
export function installCapturePreferencesBridge({ipcMain,contents,window,app,dialog,env,admit}) {
  const session=contents?.session;
  if(typeof session?.registerPreloadScript!=='function'||typeof dialog?.showOpenDialog!=='function'||typeof app?.getPath!=='function')return null;
  let disposed=false;
  const host=capturePreferencesHost({file:join(app.getPath('userData'),'capture-preferences.json'),env,
    chooseDirectory:()=>dialog.showOpenDialog(window,{title:'Choose a capture folder',properties:['openDirectory']}),
    notify:()=>{if(!disposed)contents.send('metaviewer:capture.preferences.changed');}});
  const id=session.registerPreloadScript({type:'frame',filePath:fileURLToPath(new URL('./capturePreferencesPreload.cjs',import.meta.url))});
  ipcMain.handle(CAPTURE_PREFERENCES_CHANNEL,async(/** @type {any} */ event,/** @type {any} */ message)=>{
    if(disposed||!admit(event))throw Error('CAPTURE_PREFERENCES_SENDER');
    if(!message||Object.getPrototypeOf(message)!==Object.prototype||Reflect.ownKeys(message).some(key=>typeof key!=='string')||!Object.values(Object.getOwnPropertyDescriptors(message)).every(d=>'value' in d))throw Error('CAPTURE_PREFERENCES_PAYLOAD');
    const keys=Object.keys(message).sort().join(',');
    try {
      if(message.op==='get'&&keys==='op')return {ok:true,...await host.snapshot()};
      if(message.op==='choose'&&keys==='kind,op')return {ok:true,...await host.choose(message.kind)};
      if(message.op==='mode'&&keys==='op,value')return {ok:true,...await host.mode(message.value)};
    } catch(error) {
      const reason=error instanceof Error?error.message:'';
      const allowed=['Choose an existing folder.','The selected folder is unavailable.','Choose a folder outside the MetaViewer source tree.','The selected folder is not writable.','A folder dialog is already open.'];
      return {ok:false,reason:allowed.includes(reason)?reason:'Capture preferences could not be saved.'};
    }
    throw Error('CAPTURE_PREFERENCES_PAYLOAD');
  });
  return {...host,async dispose(){if(disposed)return;disposed=true;ipcMain.removeHandler(CAPTURE_PREFERENCES_CHANNEL);session.unregisterPreloadScript(id);}};
}

// Opt-in live probe, launched by TestLiveHostXpraPrivateDisplay on private Xvfb.
import electron from 'electron';
import {readFile} from 'node:fs/promises';
import {openXpraHumanBridge} from '../electron/xpraHumanBridge.js';
import {attachXpraHumanTile} from '../electron/xpraHumanTile.js';
import {xpraReadyExpression} from '../electron/xpraClient.js';
const {app,BrowserWindow}=electron;
app.disableHardwareAcceleration();
let window,bridge,tile;
async function run() {
try {
 await app.whenReady();
 window=new BrowserWindow({width:900,height:700,show:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
 await window.loadURL('data:text/html,<title>Private host-xpra probe</title>');
 bridge=await openXpraHumanBridge({viewRoot:process.env.MV_HOST_XPRA_VIEW_ROOT,capsule:process.env.MV_HOST_XPRA_CONTAINER,expectedSocketUid:process.getuid(),privateSocket:true,jquery:await readFile('/usr/share/javascript/jquery/jquery.js')});
 tile=await attachXpraHumanTile({electron,window,bridge,bounds:{x:0,y:0,width:800,height:600},trace:{record(){return true},setActive(){}},isActive:()=>true,capsuleSize:()=>({width:1280,height:900}),onFailure(error){console.error(String(error));app.exit(1)}});
 if (!await tile.view.webContents.executeJavaScript(xpraReadyExpression(true,false))) throw Error('client not ready');
 window.maximize();tile.resize({x:0,y:0,width:860,height:640});tile.setVisible(false);tile.setVisible(true);
 await window.loadURL('data:text/html,<title>Private navigation probe</title>');
 if (!await tile.view.webContents.executeJavaScript(xpraReadyExpression(true,false))) throw Error('client lost through maximize/navigation');
 console.log('HOST_XPRA_HUMAN_TILE_READY_MAXIMIZE_NAVIGATION');
 await tile.close();tile=null;await bridge.close();bridge=null;window.destroy();app.quit();
} catch(error) {
 console.error(String(error));try{await tile?.close();await bridge?.close()}finally{window?.destroy();app.exit(1)}
}

}
void run();

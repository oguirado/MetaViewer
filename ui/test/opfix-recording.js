// Production wall with synthetic host state. No capsule or recording is started.
import {createApp} from 'vue';
import App from '../src/App.vue';
import RoleSurface from '../src/surfaces/RoleSurface.vue';
import {resolveFixture} from '../src/fixtures/resolveState.js';
import {createFixtureRuntime,installSurfacePresentation} from '../src/fixtures/fixtureRuntime.js';
import {createWallLayout,SCOPE} from '../src/wall/layout.js';
import {installKitTheme} from 'capsule-ui-kit/theme';
import 'capsule-ui-kit/theme.css';
const dockApis=new Map();
// Fixture-only hook: the kit exposes this API for checking real panel loss.
globalThis.opfixDockApis=dockApis;
const fixture=resolveFixture('four').fixture;
const {mount}=createFixtureRuntime(fixture);
globalThis.metaviewerRoles={status:async()=>({ok:true,role:'agent'}),list:async()=>[],visibility:async()=>({ok:true})};
const captureState={bySurface:Object.fromEntries(fixture.capsules.map(row=>[row.id,{phase:'recording',elapsedMs:125000}])),toggleRecord:async()=>({ok:true}),screenshot:async()=>({ok:true})};
const clipboard={writeText:async text=>{globalThis.opfixCopiedText=text;}};
const app=createApp(App,{fixture,runtime:mount.runtime,scope:SCOPE,layout:createWallLayout(SCOPE,[...fixture.capsules]),storage:{readRaw:async()=>null,writeAtomic:async()=>{}},captureState,captureAvailable:true,clipboard});
app.component('RoleSurface',RoleSurface);
app.mixin({mounted(){
 const exposed=this.$.exposed;
 if(typeof exposed?.getDockviewApi==='function')dockApis.set(this.$props.ownerWindowId,exposed.getDockviewApi);
}});
installSurfacePresentation(app,document,null);
installKitTheme(app);
globalThis.opfixRoot=app.mount('#app');

import {createApp} from 'vue';
import App from '../src/App.vue';
import RoleSurface from '../src/surfaces/RoleSurface.vue';
import {resolveFixture} from '../src/fixtures/resolveState.js';
import {createFixtureRuntime,installSurfacePresentation} from '../src/fixtures/fixtureRuntime.js';
import {createWallLayout,SCOPE} from '../src/wall/layout.js';
import {installKitTheme} from 'capsule-ui-kit/theme';
import 'capsule-ui-kit/theme.css';
const profileId='work-account';
globalThis.metaviewerRoles={
 status:async()=>({ok:true,role:'agent',profileId,storedData:{available:true,profileId}}),
 list:async()=>[{profileId,currentMode:'agent',surfaceId:'cap-01',available:true}],
 choices:async()=>[{profileId,currentMode:'agent',surfaceId:'cap-01',available:true}],
 visibility:async()=>({ok:true}),close:async()=>({ok:true}),
};
globalThis.opfixSlotRequests=[];
globalThis.metaviewer={
 operator:{identity:{list:async()=>({ok:true,rows:[{id:profileId,label:'Work account',browser:'chromium'}]})}},
 slots:{request:async request=>{globalThis.opfixSlotRequests.push(request);throw Error('No slot operation is allowed in this menu probe');}},
};
const fixture=resolveFixture('one').fixture;
const {mount}=createFixtureRuntime(fixture);
const app=createApp(App,{fixture,runtime:mount.runtime,scope:SCOPE,layout:createWallLayout(SCOPE,[...fixture.capsules]),storage:{readRaw:async()=>null,writeAtomic:async()=>{}}});
app.component('RoleSurface',RoleSurface);installSurfacePresentation(app,document,null);installKitTheme(app);app.mount('#app');

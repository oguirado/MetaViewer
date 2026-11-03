// Synthetic role discovery on the production App; never starts a capsule.
import {createApp} from 'vue';
import App from '../src/App.vue';
import RoleSurface from '../src/surfaces/RoleSurface.vue';
import {resolveFixture} from '../src/fixtures/resolveState.js';
import {createFixtureRuntime,installSurfacePresentation} from '../src/fixtures/fixtureRuntime.js';
import {createWallLayout,SCOPE} from '../src/wall/layout.js';
import {installKitTheme} from 'capsule-ui-kit/theme';
import 'capsule-ui-kit/theme.css';
const fixture=resolveFixture('one').fixture;
const mount=createFixtureRuntime(fixture).mount;
globalThis.metaviewerRoles={status:async()=>({ok:true,role:'agent'}),list:async()=>[],visibility:async()=>({ok:true})};
Object.assign(document.documentElement.dataset,{themeScheme:'mv-light',themeDensity:'compact'});
const app=createApp(App,{fixture,runtime:mount.runtime,scope:SCOPE,layout:createWallLayout(SCOPE,[...fixture.capsules]),storage:{readRaw:async()=>null,writeAtomic:async()=>{}}});
app.component('RoleSurface',RoleSurface);
installSurfacePresentation(app,document,null);
installKitTheme(app);
app.mount('#app');

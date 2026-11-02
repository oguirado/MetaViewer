import {createApp,h,ref,nextTick} from 'vue';
import DesktopWorkspace from '../src/wall/DesktopWorkspace.vue';
import RoleSurface,{collectClipRects,clipRoleBounds,floatingPresentation,isRoleElementPainted,subtractRoleOccluders} from '../src/surfaces/RoleSurface.vue';
import {installKitTheme} from 'capsule-ui-kit/theme';
import 'capsule-ui-kit/theme.css';
import '../src/design/metaviewer.css';
import {createHiddenSessionPool} from '../src/surfaces/hiddenSessions.js';
import {createWallLayout,SCOPE} from '../src/wall/layout.js';
const rows=[{id:'red',surfaceId:'red',title:'Red human fixture',generation:1,visibility:'unfolded',attachmentState:'attaching',backendLifecycle:'active',control:'human'},{id:'blue',surfaceId:'blue',title:'Blue human fixture',generation:1,visibility:'unfolded',attachmentState:'attaching',backendLifecycle:'active',control:'human'}];
const workspace=ref(null);const feed={getProjection:()=>({rows}),getSnapshot:()=>({status:'live',stale:false,envelope:{projection:{rows}}}),subscribe:()=>()=>{}};
const app=createApp({render:()=>h('main',{style:'height:100vh;display:flex;flex-direction:column'},[
 h('header',{style:'height:32px;padding:4px;flex:none'},'P18G — native WebContentsView paint fixture; no capsule or identity store'),
 h(DesktopWorkspace,{ref:workspace,scope:SCOPE,defaultProfile:createWallLayout(SCOPE),storage:{readRaw:async()=>null,writeAtomic:async()=>{}},projectionView:feed,rows,modes:{red:'human',blue:'human'},intentBuilders:{visibility:body=>body,control:body=>body,presentation:({capsuleId,verb})=>({type:verb,capsuleId})},controlRegistry:{},scheduler:{},tileScheduler:null,style:'flex:1;min-height:0'}, {surface:({capsuleId,desktopActive})=>h(RoleSurface,{surfaceId:capsuleId,label:capsuleId,control:'human',presentationActive:desktopActive})})
])});installKitTheme(app);app.provide('hiddenSessionPool',createHiddenSessionPool(0));app.mount('#app');
const style=document.createElement('style');style.textContent='html,body,#app{margin:0;height:100%;width:100%;overflow:hidden}.cuk-capsule-panel{height:100%}.mv-surface-host{width:100%;height:100%;min-height:0}.mv-tile-capture-host{display:flex;flex-direction:column;min-height:0}';document.head.append(style);
window.p18gReady=async()=>{await nextTick();await new Promise(r=>setTimeout(r,600));const result=workspace.value.setPreset('floating');if(!result.ok)throw Error(JSON.stringify(result));await new Promise(r=>setTimeout(r,700));return true;};
window.p18gFocus=async id=>{const result=workspace.value.revealSurface(id,'tab');if(!result.ok)throw Error('FOCUS_REFUSED '+JSON.stringify(result));await new Promise(r=>setTimeout(r,500));return [...document.querySelectorAll('.dv-resize-container')].map(el=>({z:getComputedStyle(el).zIndex,parentZ:getComputedStyle(el.parentElement).zIndex,rect:el.getBoundingClientRect().toJSON(),text:el.textContent.slice(0,70)}));};

window.p18gDebug=()=>[...document.querySelectorAll('.mv-role-viewport')].map(el=>({ancestors:(()=>{const a=[];for(let n=el;n&&a.length<12;n=n.parentElement)a.push({class:n.className,id:n.id,style:n.getAttribute('style'),data:n.dataset});return a;})(),floats:[...document.querySelectorAll('.dv-resize-container')].map(n=>({class:n.className,style:n.getAttribute('style'),data:n.dataset})),rect:el.getBoundingClientRect().toJSON(),painted:isRoleElementPainted(el),floating:floatingPresentation(el),clips:collectClipRects(el),clipped:clipRoleBounds(el.getBoundingClientRect(),collectClipRects(el).scrollAncestors,collectClipRects(el).wallViewport),body:document.body.dataset.mvModal}));
window.p18gOcclusion=()=>[...document.querySelectorAll('.mv-role-viewport')].map(el=>{const {scrollAncestors,wallViewport}=collectClipRects(el),clip=clipRoleBounds(el.getBoundingClientRect(),scrollAncestors,wallViewport);return {id:el.closest('[data-capsule-id]').dataset.capsuleId,...(clip.visible?subtractRoleOccluders(clip.bounds,floatingPresentation(el).occluders):clip)};});

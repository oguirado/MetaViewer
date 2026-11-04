import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parse,compileScript} from '@vue/compiler-sfc';
import * as vue from 'vue';
import {storedDataCapability} from '../electron/roleHost.js';

test('stored-data capability requires a supported identity kind and excludes host or protected profiles',()=>{
  for(const kind of ['browser','program']) assert.deepEqual(storedDataCapability({kind,profile_id:'work-account'},false),{available:true,profileId:'work-account'});
  for(const kind of ['vm','desktop-window',undefined,null,'unknown']) assert.equal(storedDataCapability({kind,profile_id:'work-account'},false),null);
  assert.equal(storedDataCapability({kind:'browser',profile_id:'work-account'},false,'work-account'),null);
  for(const host of [true,undefined,null]) assert.equal(storedDataCapability({kind:'program',profile_id:'work-account'},host),null);
  for(const profile_id of ['mv-live-1','srf-pg-private','../escape','',undefined]) assert.equal(storedDataCapability({kind:'browser',profile_id},false),null);
});

test('header shows only admitted Save/Load, labels the stopped constraint, and opens exactly that profile',async()=>{
  const source=readFileSync(new URL('../src/surfaces/RoleSurface.vue',import.meta.url),'utf8');
  const compiled=compileScript(parse(source).descriptor,{id:'stored-header',inlineTemplate:true}).content;
  const code=compiled.replace(/from ["']vue["']/g,'from '+JSON.stringify(import.meta.resolve('vue')));
  const Component=(await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'))).default;
  const old=globalThis.metaviewerRoles;
  const node=tag=>({tag,children:[],props:{},parent:null,style:{},getClientRects:()=>[],getBoundingClientRect:()=>({x:0,y:0,width:0,height:0})});
  const renderer=vue.createRenderer({createElement:node,createText:text=>({...node('#text'),text}),createComment:text=>({...node('#comment'),text}),
    setText(n,text){n.text=text;},setElementText(n,text){n.text=text;n.children=[];},patchProp(n,k,_old,v){n.props[k]=v;},
    insert(n,p,a){n.parent=p;const at=p.children.indexOf(a);p.children.splice(at<0?p.children.length:at,0,n);},
    remove(n){if(n.parent)n.parent.children.splice(n.parent.children.indexOf(n),1);},parentNode:n=>n.parent,nextSibling:()=>null,querySelector:()=>null});
  const all=n=>[n,...n.children.flatMap(all)];
  try {
    for(const patch of [{}, {storedData:null}, {storedData:{available:false,profileId:'work-account'}},
      {storedData:{available:true,profileId:'other-account'}}, {hostXpra:true}, {hostWindow:{state:'active'}}]) {
      const admitted=Object.keys(patch).length===0, opened=[];
      globalThis.metaviewerRoles={status:async()=>({role:'agent',profileId:'work-account',storedData:{available:true,profileId:'work-account'},...patch}),visibility:async()=>({ok:true}),close:async()=>({ok:true})};
      const root=node('root'), app=renderer.createApp(Component,{surfaceId:'surface-one',onStoredData:id=>opened.push(id)});
      try {
        app.mount(root);await new Promise(r=>setImmediate(r));await vue.nextTick();
        const buttons=all(root).filter(n=>n.props.id?.startsWith('tile-state-'));
        assert.equal(buttons.length,admitted?2:0,JSON.stringify(patch));
        for(const button of buttons) {
          assert.match(button.props['aria-label'],/stopped only/);
          button.props.onClick({stopPropagation(){}});
        }
        assert.deepEqual(opened,admitted?['work-account','work-account']:[]);
      } finally {app.unmount();}
    }
  } finally {globalThis.metaviewerRoles=old;}
});

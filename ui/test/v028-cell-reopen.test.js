import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../src/wall/WallWorkspace.vue',import.meta.url),'utf8');
const script=source.match(/<script>([\s\S]*?)<\/script>/)[1];
const wall=await import(`data:text/javascript;base64,${Buffer.from(script.replace(/import .* from 'vue';/,'const defineComponent=value=>value; const h=()=>{};')).toString('base64')}`);

function workspace(savedCells) {
  const rows=[],panels=[],groups=[],positions=new Map();
  const api={width:1200,height:600,panels,groups,getPanel:id=>panels.find(p=>p.id===id),
    toJSON:()=>({floatingGroups:panels.filter(p=>positions.has(p.id)).map(p=>({data:{id:p.group.id,views:[p.id]},position:positions.get(p.id)}))}),
    addPanel(options){
      const group={id:options.id,api:{location:{type:'grid'}}};groups.push(group);
      const panel={...options,group,api:{setActive(){},setTitle(){},close(){positions.delete(panel.id);panels.splice(panels.indexOf(panel),1);groups.splice(groups.indexOf(group),1);}}};
      panels.push(panel);return panel;
    },
    addFloatingGroup(item,opts){const panel=item.group?item:panels.find(p=>p.group===item);panel.group.api.location.type='floating';positions.set(panel.id,{...opts.position,left:opts.position.left-(item.group && opts.position.left+opts.width===api.width?15:0),width:opts.width,height:opts.height});},
    addGroup(){const group={api:{location:{type:'grid'}}};groups.push(group);return group;},
  };
  const windows={state:id=>({floating:positions.has(id),hidden:false}),show(){},hide(){},float(){},dock(){}};
  const controller=wall.createWallWorkspaceController({floatingGrid:()=>({cols:3,rows:2}),savedCells:()=>savedCells,projectionView:{getProjection:()=>({rows})}});
  assert(controller.handleReady({api,windows}).ok);
  assert(controller.setPreset('grid-3x2').ok);
  assert.equal(controller.beginFloatingDrag(),null);
  const open=(id,profile)=>{
    rows.push({id,surfaceId:id,profile_id:profile,backendLifecycle:'active'});
    assert(controller.revealSurface(id,'split').ok);controller.refreshPreset();
    return positions.get('panel-'+id);
  };
  const close=id=>{assert(controller.applyPresentationIntent({type:'close',capsuleId:id}).ok);rows.splice(rows.findIndex(r=>r.id===id),1);controller.refreshPreset();};
  return {controller,open,close,api,positions};
}

test('CELL custom layout after a grid float snap reopens the identity in its cell, including restart',()=>{
  // A floating drag from Grid6 makes the desktop custom (preset null).
  // The persisted identity hint survives even when all live surface IDs end.
  const saved=JSON.parse(JSON.stringify({'work-browser':{col:2,row:1}}));
  const session=workspace(saved);
  for(let run=0;run<3;run++){
    const id='surface-'+run;
    assert.deepEqual(session.open(id,'work-browser'),{left:800,top:300,width:400,height:300});
    session.close(id);
  }
  session.controller.dispose();
  const restarted=workspace(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(restarted.open('after-restart','work-browser'),{left:800,top:300,width:400,height:300});
  restarted.controller.dispose();
});

test('CELL custom reopen respects occupied remembered cells and leaves unremembered panels docked',()=>{
  const session=workspace({'first':{col:2,row:1},'second':{col:2,row:1}});
  assert.deepEqual(session.open('a','first'),{left:800,top:300,width:400,height:300});
  assert.deepEqual(session.open('b','second'),{left:0,top:0,width:400,height:300});
  assert.equal(session.open('c','fresh'),undefined);
  session.controller.dispose();
});

test('CELL cold-restored ended surfaces do not reserve a live identity cell during orphan grace',()=>{
  const session=workspace({'work-browser':{col:2,row:1}});
  const stale=session.api.addPanel({id:'panel-ended-surface',params:{capsuleId:'ended-surface'}});
  session.api.addFloatingGroup(stale.group,{position:{left:800,top:300},width:400,height:300});
  assert.deepEqual(session.open('new-surface','work-browser'),{left:800,top:300,width:400,height:300});
  assert(session.api.getPanel('panel-ended-surface'),'orphan grace is retained');
  session.controller.dispose();
});

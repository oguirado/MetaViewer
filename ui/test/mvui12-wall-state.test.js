import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parse} from '@vue/compiler-sfc';
import {controlVerbForRow} from '../src/wall/tileStates.js';

const {descriptor} = parse(readFileSync(new URL('../src/wall/WallWorkspace.vue', import.meta.url), 'utf8'));
const code = descriptor.script.content.replace("from 'vue'", `from ${JSON.stringify(import.meta.resolve('vue'))}`);
const {createWallWorkspaceController} = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

test('T5-R2-14 agent fallback takes control; explicit verbs remain meaningful', () => {
  assert.equal(controlVerbForRow({control:'agent',controlOwner:'agent'}, null), 'take_control');
  assert.equal(controlVerbForRow({control:'human',controlOwner:'human'}, null), 'take_control');
  assert.equal(controlVerbForRow({control:'shared'}, null), 'take_control');
  assert.equal(controlVerbForRow(null, null), 'take_control');
  for(const verb of ['take_control','release_control']) {
    assert.equal(controlVerbForRow({control:'agent'},verb),verb, 'negative control: explicit request wins');
    assert.equal(controlVerbForRow({control:'human'},`surface_request.${verb}`),verb);
  }
});

function harness(groups) {
  const panels = new Map();
  const api = {groups,getPanel:id=>panels.get(id),removeGroup(group){groups.splice(groups.indexOf(group),1);},
    addPanel(options){const panel={id:options.id,api:{setActive(){}}};panels.set(panel.id,panel);
      groups.push({id:panel.id,size:1});return panel;}};
  const controller=createWallWorkspaceController({projectionView:{getProjection:()=>({rows:[
    {id:'a',surfaceId:'a',backendLifecycle:'active'}, {id:'b',surfaceId:'b',backendLifecycle:'active'}]})}});
  const windows={state:()=>({hidden:false}),show(){},hide(){},float(){},dock(){}};
  assert.equal(controller.handleReady({api,windows}).ok,true);
  return {controller,groups};
}
test('L6 a first reveal removes empty restored groups; occupied groups survive later reveals', () => {
  const f=harness([{id:'wall-empty',size:0}]);
  try {
    assert.equal(f.controller.revealSurface('a','split').ok,true);
    assert.deepEqual(f.groups.map(g=>g.id),['panel-a']);
    assert.equal(f.controller.revealSurface('b','split').ok,true);
    assert.deepEqual(f.groups.map(g=>g.id),['panel-a','panel-b'], 'negative control: populated groups survive');
  } finally {f.controller.dispose();}
});
test('L6 restore removes empty siblings beside an occupied group, retaining an entirely empty wall', () => {
  const empty=harness([{id:'wall-empty',size:0}]);
  assert.equal(empty.groups.length,1);empty.controller.dispose();
  const populated=harness([{id:'kept',size:1},{id:'obsolete-empty',size:0}]);
  assert.deepEqual(populated.groups.map(g=>g.id),['kept']);populated.controller.dispose();
});

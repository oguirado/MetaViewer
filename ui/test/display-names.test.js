import test from 'node:test';
import assert from 'node:assert/strict';
import {createDesktopState,validateDesktopState,assignSurface,renameDesktop,renameCapsule,capsuleDisplayLabel,validDisplayLabel} from '../electron/desktopLayout.js';
test('display labels persist with the layout without changing identity or ownership',()=>{
 const state=createDesktopState();assignSurface(state,'surface-a','human');
 const home={...state.assignments['surface-a']};
 assert.equal(renameDesktop(state,'human',1,'  Research  '),true);
 assert.equal(renameCapsule(state,'surface-a','Editor','identity-a'),true);
 const restored=JSON.parse(JSON.stringify(state));assert.equal(validateDesktopState(restored),true);
 assert.equal(restored.views.human.desktops[0].label,'Research');
 assert.equal(capsuleDisplayLabel(restored,{id:'new-surface',profile_id:'identity-a'}),'Editor');
 assert.deepEqual(restored.assignments['surface-a'],home);
 assert.deepEqual(Object.keys(restored.assignments),['surface-a']);
});
test('malformed and unbounded labels cannot enter the host layout document',()=>{
 for(const value of ['', 'x'.repeat(81), '\nname', 'name\x00', 'name\u202e', {}, null])assert.equal(validDisplayLabel(value),false);
 for(const labels of [[],{'a':'x'.repeat(81)},{'bad key':'title'},JSON.parse('{"__proto__":"title"}'),Object.fromEntries(Array.from({length:257},(_,i)=>['id-'+i,'Title']))]) {
  const state=createDesktopState();state.labels=labels;assert.equal(validateDesktopState(state),false);
 }
 const state=createDesktopState();state.views.human.desktops[0].label='x'.repeat(81);assert.equal(validateDesktopState(state),false);
});
test('rename refuses unknown capsules and desktops and preserves valid prior labels',()=>{
 const state=createDesktopState();assert.equal(renameCapsule(state,'absent','Name'),false);assert.equal(renameDesktop(state,'human',9,'Name'),false);
 assignSurface(state,'surface-a','agent');assert.equal(renameCapsule(state,'surface-a','Good','identity-a'),true);
 for(const value of ['', 'x'.repeat(81), '\x1b[31m'])assert.equal(renameCapsule(state,'surface-a',value,'identity-a'),false);
 assert.equal(capsuleDisplayLabel(state,{id:'surface-a',profile_id:'identity-a'}),'Good');
});
test('label map bound permits updates but refuses a new overflow key',()=>{
 const state=createDesktopState();assignSurface(state,'surface-a','agent');
 state.labels=Object.fromEntries(Array.from({length:256},(_,i)=>['id-'+i,'Title']));
 assert.equal(renameCapsule(state,'surface-a','Update','id-0'),true);assert.equal(renameCapsule(state,'surface-a','Overflow','new-id'),false);
 assert.equal(Object.keys(state.labels).length,256);assert.equal(validateDesktopState(state),true);
});


test('inherited properties never become a saved label or a real capsule assignment',()=>{
 const state=createDesktopState();state.labels={};
 assert.equal(capsuleDisplayLabel(state,{id:'toString'}),undefined);
 assert.equal(renameCapsule(state,'toString','Invented'),false);
 assignSurface(state,'surface-a','human');
 assert.equal(renameCapsule(state,'surface-a','Actual','toString'),true);
 assert.equal(capsuleDisplayLabel(state,{id:'toString'}),'Actual');
 assert.equal(renameDesktop(state,'toString',1,'Invalid'),false);
});

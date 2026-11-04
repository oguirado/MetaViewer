import test from 'node:test';
import assert from 'node:assert/strict';
import * as model from '../src/terminal/terminalDeckModel.js';

test('terminal launcher stays inside its panel instead of aligning outside a narrow trigger',()=>{
 const panel={left:833,right:1280,top:40,bottom:701};
 const result=model.placeTerminalLauncher?.(panel,{left:909,right:1012,bottom:124,width:103},85,{width:1280,height:701});
 assert.deepEqual(result,{left:841,top:128,width:288,maxHeight:645});
});
test('terminal launcher clamps width, vertical overflow and offscreen panel edges',()=>{
 for(const width of [80,240,320,447,640])for(const height of [120,350,701]) {
  const panel={left:1280-width,right:1296,top:-10,bottom:height};
  const result=model.placeTerminalLauncher?.(panel,{left:1290,right:1400,bottom:height-10,width:110},900,{width:1280,height:720});
  assert.ok(result);
  assert.ok(result.left>=panel.left+8 && result.left+result.width<=1272);
  assert.ok(result.top>=8 && result.top+Math.min(900,result.maxHeight)<=height-8);
 }
 assert.equal(model.placeTerminalLauncher?.({left:NaN,right:2,top:0,bottom:4},{},10,{width:100,height:100}),null);
});

test('context menu uses drawer-local coordinates and stays within transformed drawer edges',()=>{
 const result=model.placeTerminalContextMenu?.({left:224,right:832,top:404,bottom:701},{x:820,y:690},{width:117,height:46},{width:1280,height:701});
 assert.deepEqual(result,{left:491,top:251});
});

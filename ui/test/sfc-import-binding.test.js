import test from 'node:test';
import assert from 'node:assert/strict';
import {sfcImportBinding} from './sfc-import-binding.mjs';
test('named alias and namespace lowering preserve exact references',()=>{
 const source={x:1,y:2};assert.equal(sfcImportBinding('{x as local, y}'),'{x: local, y}');
 assert.deepEqual(Function('source','const '+sfcImportBinding('{x as local, y}')+'=source;return [local,y]')(source),[1,2]);
 assert.equal(sfcImportBinding('* as namespace'),'namespace');
 for(const bad of ['x;evil()','{x as y;evil()}','{...x}','default, {x}'])assert.throws(()=>sfcImportBinding(bad));
});

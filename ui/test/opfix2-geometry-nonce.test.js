import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {kitQuarantineReasonPlugin} from '../tools/kitQuarantineReason.js';
const id='/.kit/capsule-ui-kit/src/workspace/kitGeometrySheet.js';
const source=readFileSync(new URL('../.kit/capsule-ui-kit/src/workspace/kitGeometrySheet.js',import.meta.url),'utf8');
function documentDouble(){
 let sheet;
 return {get sheet(){return sheet;},head:{querySelector:()=>sheet,appendChild:e=>{sheet=e;}},
 querySelector:()=>({getAttribute:()=> 'fixture-nonce'}),createElement:()=>({nonce:'',textContent:'',setAttribute(k,v){if(k==='nonce')this.nonce=v;},getAttribute(k){return k==='nonce'?'':null;}})};
}
test('kit geometry updates survive browser nonce attribute hiding',async()=>{
 const transformed=kitQuarantineReasonPlugin().transform(source,id) ?? source;
 const module=await import('data:text/javascript,'+encodeURIComponent(transformed));
 const doc=documentDouble();
 assert.equal(module.setKitGeometryRule(doc,'first','cui-first',{width:'640px'}),true);
 assert.equal(module.setKitGeometryRule(doc,'second','cui-second',{height:'360px'}),true,'second rule must not disappear when getAttribute(nonce) is hidden');
 assert.match(doc.sheet.textContent,/cui-first/);assert.match(doc.sheet.textContent,/cui-second/);
 doc.sheet.nonce='mismatched';assert.equal(module.setKitGeometryRule(doc,'bad','cui-bad',{width:'999px'}),false,'wrong nonce remains refused');
});
test('geometry compatibility overlay refuses changed kit source',()=>{
 assert.throws(()=>kitQuarantineReasonPlugin().transform(source.replace("existing.getAttribute('nonce')",'changedAttribute()'),id),/KIT_GEOMETRY_NONCE_OVERLAY_DRIFT/);
});

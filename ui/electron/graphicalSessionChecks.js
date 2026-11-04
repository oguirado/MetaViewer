/** Closed JSON-schema subset used by the graphical QEMU UI boundary.
 * @param {Record<string, any>|(()=>Record<string, any>)} schemaSource */
export function createGraphicalSessionChecks(schemaSource) {
 /** @param {any} v @returns {boolean} */
 const plain=(v)=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v))&&Reflect.ownKeys(v).length===Object.keys(v).length&&Object.keys(v).every(k=>{const d=Object.getOwnPropertyDescriptor(v,k);return d&&Object.hasOwn(d,'value');});
 /** @param {any} v @returns {boolean} */
 const safeArray=(v)=>Array.isArray(v)&&Object.getPrototypeOf(v)===Array.prototype&&Reflect.ownKeys(v).length===v.length+1&&Array.from({length:v.length},(_,i)=>Object.getOwnPropertyDescriptor(v,String(i))).every(d=>d&&Object.hasOwn(d,'value'));
 /** @param {any} v @param {any} s @param {any} doc @param {Record<string, any>} schemas @param {number} [depth] @returns {boolean} */
 function check(v,s,doc,schemas,depth=0){
  if(depth>32||!s)return false;
  if(s.$ref){const [name,frag='']=s.$ref.split('#');let target=name?schemas[name]:doc;for(const k of frag.split('/').slice(1))target=target?.[k.replaceAll('~1','/').replaceAll('~0','~')];if(!check(v,target,name?schemas[name]:doc,schemas,depth+1))return false;}
  if(s.oneOf&&s.oneOf.filter((/** @type {any} */ x)=>check(v,x,doc,schemas,depth+1)).length!==1)return false;
  if('const'in s&&v!==s.const)return false;
  if(s.enum&&!s.enum.includes(v))return false;
  if(s.type==='object')return plain(v)&&Object.keys(v).length===Object.keys(s.properties??{}).length&&Object.entries(s.properties??{}).every(([k,x])=>Object.hasOwn(v,k)&&check(v[k],x,doc,schemas,depth+1));
  if(s.type==='array')return safeArray(v)&&v.length>=(s.minItems??0)&&v.length<=(s.maxItems??4096)&&Array.from({length:v.length},(_,i)=>check((/** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(v,String(i)))).value,s.items,doc,schemas,depth+1)).every(Boolean);
  if(s.type==='integer')return Number.isSafeInteger(v)&&v>=(s.minimum??-Number.MAX_SAFE_INTEGER)&&v<=(s.maximum??Number.MAX_SAFE_INTEGER);
  if(s.type==='string')return typeof v==='string'&&!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v)&&Array.from(v).length>=(s.minLength??0)&&Array.from(v).length<=(s.maxLength??65536)&&(!s.pattern||new RegExp('(?:'+s.pattern+')(?![\\s\\S])','u').test(v));
  if(s.type==='boolean')return typeof v==='boolean';if(s.type==='null')return v===null;return true;
 }
 /** @param {string} name @param {any} value @returns {boolean} */
 const graphicalValid=(name,value)=>{try{const schemas=typeof schemaSource==='function'?schemaSource():schemaSource;const doc=schemas?.[name];return check(value,doc,doc,schemas);}catch{return false;}};
 /** @param {any} a @returns {boolean} */
 const graphicalAction=(a)=>{
  if(!plain(a)||!['attach','mark','restore'].includes(a.op))return false;
  const keys=a.op==='attach'?['op','surface_id']:a.op==='mark'?['op','surface_id','generation','authority_epoch','label']:['op','surface_id','generation','authority_epoch','point_id'];
  if(Object.keys(a).length!==keys.length||!keys.every(k=>Object.hasOwn(a,k)))return false;
  const {op,surface_id,...rest}=a;return graphicalValid('graphical_session_request.schema.json',{schema:'graphical_session_request/v0.2',request_id:'request-validation',surface_id,op,params:op==='attach'?{}:op==='mark'?{label:rest.label}:{point_id:rest.point_id},...(op==='attach'?{}:{generation:rest.generation,authority_epoch:rest.authority_epoch}),owner_id:'actor-validation'});
 };
 /** @param {any} v @returns {boolean} */
 const graphicalSnapshot=v=>plain(v)&&Object.keys(v).length===7&&['available','busy','code','revision','session','uncertain','point_ages_ms'].every(k=>Object.hasOwn(v,k))&&typeof v.available==='boolean'&&typeof v.busy==='boolean'&&typeof v.uncertain==='boolean'&&Number.isSafeInteger(v.revision)&&v.revision>=0&&(v.code===null||typeof v.code==='string'&&/^[A-Z_]{1,32}$/.test(v.code))&&(v.session===null||graphicalValid('graphical_session.schema.json',v.session))&&plain(v.point_ages_ms)&&Object.keys(v.point_ages_ms).length===(v.session?.points?.length??0)&&Object.values(v.point_ages_ms).every(x=>x===null||Number.isSafeInteger(x)&&x>=0);
 return Object.freeze({graphicalValid,graphicalAction,graphicalSnapshot,graphicalPlain:plain});
}

/** @param {Record<string,any>} RW_SCHEMAS */
export function createRewindChecks(RW_SCHEMAS){
// Shared closed validation for the privileged host and self-contained preload.
/** @param {any} value @param {string[]} names */
function rwKeys(value,names) {
 return value!==null&&typeof value==='object'&&!Array.isArray(value)
  &&[Object.prototype,null].includes(Object.getPrototypeOf(value))
  &&Reflect.ownKeys(value).length===names.length
  &&names.every(k=>{const d=Object.getOwnPropertyDescriptor(value,k);return Object.hasOwn(value,k)&&d!==undefined&&Object.hasOwn(d,'value');});
}
/** @param {any} value @param {any} schema @param {Record<string,any>} registry @param {any} document @param {number} [depth] @returns {boolean} */
function rwCheck(value,schema,registry,document,depth=0) {
 if(depth>32||!schema)return false;
 if(schema.$ref){const [name,fragment='']=schema.$ref.split('#');let target=name?registry[name]:document;const doc=target;for(const key of fragment.split('/').slice(1))target=target?.[key.replaceAll('~1','/').replaceAll('~0','~')];if(!rwCheck(value,target,registry,doc,depth+1))return false;}
 if(schema.oneOf&&schema.oneOf.filter(/** @param {any} s */s=>rwCheck(value,s,registry,document,depth+1)).length!==1)return false;
 if('const' in schema&&value!==schema.const)return false;
 if(schema.enum&&!schema.enum.includes(value))return false;
 if(schema.type==='object')return rwKeys(value,Object.keys(schema.properties??{}))&&Object.entries(schema.properties??{}).every(([k,s])=>rwCheck(value[k],s,registry,document,depth+1));
 if(schema.type==='array')return Array.isArray(value)&&Object.getPrototypeOf(value)===Array.prototype&&Reflect.ownKeys(value).length===value.length+1&&value.length>=(schema.minItems??0)&&value.length<=(schema.maxItems??4096)&&value.every((/** @type {any} */ v)=>rwCheck(v,schema.items,registry,document,depth+1));
 if(schema.type==='integer')return Number.isSafeInteger(value)&&value>=(schema.minimum??-Number.MAX_SAFE_INTEGER)&&value<=(schema.maximum??Number.MAX_SAFE_INTEGER);
 if(schema.type==='string')return typeof value==='string'&&!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)&&Array.from(value).length>=(schema.minLength??0)&&Array.from(value).length<=(schema.maxLength??65536)&&(!schema.pattern||new RegExp('(?:'+schema.pattern+')(?![\\s\\S])','u').test(value));
 if(schema.type==='boolean')return typeof value==='boolean';
 if(schema.type==='null')return value===null;
 return true;
}
/** @param {string} name @param {any} value */
function rewindValid(name,value){try{return rwCheck(value,RW_SCHEMAS[name],RW_SCHEMAS,RW_SCHEMAS[name]);}catch{return false;}}
/** Renderer action never chooses a request ID, point bytes, host path or authority. @param {any} action */
function rewindAction(action){
 if(!action||!['pause','resume','mark','restore'].includes(action.op))return false;
 const names=['op','workload_id','generation','authority_epoch',...(action.op==='mark'?['label']:action.op==='restore'?['point_id']:[])];
 if(!rwKeys(action,names))return false;
 const {op,...params}=action;
 return rewindValid('rewind_request.schema.json',{schema:'rewind_request/v0.2',request_id:'request-validation',op,params});
}
/** @param {any} value */
function rewindSnapshot(value){
 if(!rwKeys(value,['available','busy','code','revision','session','uncertain','point_ages_ms','stop_target'])||typeof value.available!=='boolean'||typeof value.busy!=='boolean'||typeof value.uncertain!=='boolean'||!Number.isSafeInteger(value.revision)||value.revision<0||!(value.code===null||typeof value.code==='string'&&/^[A-Z_]{1,32}$/.test(value.code)))return false;
 if(value.stop_target!==null&&(!rwKeys(value.stop_target,['workload_id','generation'])||typeof value.stop_target.workload_id!=='string'||!/^workload-[a-z0-9][a-z0-9._-]{0,63}$(?![\s\S])/.test(value.stop_target.workload_id)||!Number.isSafeInteger(value.stop_target.generation)||value.stop_target.generation<1))return false;
 if(value.session===null)return rwKeys(value.point_ages_ms,[]);
 if(!rewindValid('rewind_session.schema.json',value.session))return false;
 const points=value.session.points,ids=new Set(points.map(/** @param {any} p */p=>p.point_id));
 return ids.size===points.length&&rwKeys(value.point_ages_ms,[...ids])&&Object.values(value.point_ages_ms).every(age=>age===null||Number.isSafeInteger(age)&&age>=0)&&(value.session.last_good_usable===null||points.some(/** @param {any} p */p=>p.point_id===value.session.last_good_usable&&p.status==='usable'));
}

return Object.freeze({rewindValid,rewindAction,rewindSnapshot});
}

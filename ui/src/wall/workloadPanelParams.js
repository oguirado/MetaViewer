/** Closed presentation-only dispatch. No IPC, native actions or guessed surfaces. */
/** @param {any} value @returns {any} */
function dataRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  const keys=Reflect.ownKeys(value);
  if(keys.some(key=>typeof key!=='string'||!Object.hasOwn(Object.getOwnPropertyDescriptor(value,key)??{},'value')))return null;
  return value;
}
/** Dockview wraps presentation params; never evaluate an inherited/accessor params property. */
/** @param {any} wrapper */
export function classifyCapsulePanelParams(wrapper) {
  if(!wrapper||typeof wrapper!=='object')return null;
  const descriptor=Object.getOwnPropertyDescriptor(wrapper,'params');
  if(descriptor&&!Object.hasOwn(descriptor,'value'))return null;
  const p=dataRecord(descriptor?descriptor.value:wrapper);if(!p)return null;
  const keys=Object.keys(p);
  if(keys.some(key=>!['capsuleId','sessionId','viewMode','slotFolded'].includes(key)))return null;
  if(Object.hasOwn(p,'viewMode')&&p.viewMode!==null&&typeof p.viewMode!=='string')return null;
  if(Object.hasOwn(p,'slotFolded')&&typeof p.slotFolded!=='boolean')return null;
  const graphical=Object.hasOwn(p,'capsuleId'),microvm=Object.hasOwn(p,'sessionId');
  if(graphical===microvm)return null;
  if(graphical&&typeof p.capsuleId==='string'&&p.capsuleId.length>0
      &&p.capsuleId.length<=256&&!/\s|[\x00-\x1f\x7f]/.test(p.capsuleId))
    return Object.freeze({kind:'graphical',nested:Boolean(descriptor)});
  if(microvm&&typeof p.sessionId==='string'&&p.sessionId.length>0
      &&p.sessionId.length<=256&&!/[\x00-\x1f\x7f]/.test(p.sessionId))
    return Object.freeze({kind:'workload',id:p.sessionId});
  return null;
}
/** Vue primitives supplied by the existing wall; the graphical component remains unchanged. */
/** @param {any} options */
export function createCapsulePanelRouter({defineComponent,h,markRaw,graphical,rows,validate,slot}) {
  return markRaw(defineComponent({name:'CapsuleContentRouter',props:{params:{type:Object,required:true}},
    setup(/** @type {any} */ props){return()=>{
      const route=classifyCapsulePanelParams(props.params);
      if(route?.kind==='graphical')return h(graphical,{params:route.nested?props.params:{params:props.params}});
      if(route?.kind==='workload'){
        const matches=rows().filter((/** @type {any} */ row)=>validate(row)&&row.id===route.id);
        if(matches.length===1&&slot)return slot({workload:matches[0]});
      }
      return h('p',{role:'status'},'This capsule presentation is no longer available.');
    };}
  }));
}

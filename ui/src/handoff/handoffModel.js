// @ts-check
/** [TARGET, unit decision] Presentation is additive until an explicit successful
 * acknowledgement. Empty snapshots, missing files and transport failure never
 * dismiss a row. The owner has no resume ABI: re-run requires operator action.
 * @param {any} host @param {(row:any)=>void} [activity] */
export function createHandoffModel(host,activity=()=>{}) {
  /** @type {Map<string,any>} */ const pending=new Map();
  const seen=new Set(), acknowledged=new Set();
  /** @param {any} row */
  const key=row=>`${row.surface_id}:${row.step_index}`;
  /** @param {any} state */
  function receive(state) {
    if(!state?.ok || !Array.isArray(state.rows))return;
    for(const row of state.rows) {
      const id=key(row);if(acknowledged.has(id))continue;
      pending.set(id,row);if(!seen.has(id)){seen.add(id);activity(row);}
    }
  }
  return {receive,rows:()=>[...pending.values()],
    async load(){receive(await host.list());},
    /** @param {any} row */
    async acknowledge(row){
      const result=await host.ack({surface_id:row.surface_id,step_index:row.step_index,gesture:'operator-acknowledge'});
      if(!result.ok)throw new Error('HANDOFF_UNAVAILABLE');
      acknowledged.add(key(row));pending.delete(key(row));
    },
  };
}

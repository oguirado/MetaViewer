// Explicit decorative seams for legacy shell/tile tests. Unknown imports still
// fail their closed dependency gates; feature behavior has separate real-SFC tests.
import {defineComponent} from 'vue';
const stub=defineComponent({render:()=>null});
export function addOperatorStubs(deps) {
  for(const path of ['./identities/IdentitiesDialog.vue','./handoff/HandoffNotice.vue','../netmode/NetworkPanel.vue']) deps[path]??=stub;
  return deps;
}

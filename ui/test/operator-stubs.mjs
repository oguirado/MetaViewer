// Explicit decorative seams for legacy shell/tile tests. Unknown imports still
// fail their closed dependency gates; feature behavior has separate real-SFC tests.
import {defineComponent} from 'vue';
import * as workloadPanelParams from '../src/wall/workloadPanelParams.js';
import * as recordingElapsed from '../src/recording/useRecordingElapsed.js';
const stub=defineComponent({render:()=>null});
export function addOperatorStubs(deps) {
  // Use the real router introduced by the integrated workload branch.
  deps['./workloadPanelParams.js'] ??= workloadPanelParams;
  deps['../recording/useRecordingElapsed.js'] ??= recordingElapsed;
  for(const path of ['@openvue/icons/windowmaximize','../.kit/capsule-ui-kit/src/shell/SidebarIcon.vue','./demo/DemoDialog.vue','./identities/IdentitiesDialog.vue','./handoff/HandoffNotice.vue','../netmode/NetworkPanel.vue']) deps[path]??=stub;
  return deps;
}

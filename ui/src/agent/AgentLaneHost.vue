<script setup>
/** Zero-DOM installer for the `__agentLane` host key (lane U5).
 * Mount once per renderer; uninstalls on unmount. No visual output, no
 * styles, no interactive controls, no host calls.
 */
import { onBeforeUnmount, onMounted, watch } from 'vue';
import { installAgentLane } from './agentLane.js';

const props = defineProps({
  screen: { type: String, default: 'wall' },
  fixtureKey: { type: String, default: '' },
  enabled: { type: Boolean, default: true },
});

/** @type {(() => void)|null} */
let uninstall = null;

function apply() {
  if (uninstall) {
    uninstall();
    uninstall = null;
  }
  if (props.enabled) {
    uninstall = installAgentLane(globalThis, {
      root: document,
      screen: () => props.screen,
      fixture: props.fixtureKey || null,
    });
  }
}

onMounted(apply);
watch(() => [props.enabled, props.fixtureKey], apply);
onBeforeUnmount(() => {
  if (uninstall) {
    uninstall();
    uninstall = null;
  }
});
</script>
<template>
  <!-- AgentLaneHost: zero-DOM installer for the __agentLane host key. -->
</template>

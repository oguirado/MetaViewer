<script setup>
import { computed } from 'vue';
import { hostOutcomeFor } from './hostAdapters.js';
const props = defineProps({
  row: { type: /** @type {import('vue').PropType<import('./hostAdapters.js').OutcomeRow|null>} */ (Object), default: null },
});
const outcome = computed(() => hostOutcomeFor(props.row));
</script>
<template>
  <p v-if="outcome" id="mv-host-outcome" data-semantic-anchor="host/outcome"
    :role="outcome.tone === 'refusal' ? 'alert' : 'status'" :data-outcome-code="outcome.code">{{ (outcome.code === 'NO_BROWSER_CAPSULE' || outcome.message === 'This request is unavailable. Please try again.') ? `${outcome.code}: ${outcome.message}` : outcome.message }}</p>
</template>

<style scoped>
#mv-host-outcome {
  position: absolute;
  bottom: var(--cuk-semantic-spacing-md);
  left: var(--cuk-semantic-spacing-md);
  z-index: 5;
  padding: var(--cuk-semantic-spacing-sm);
  color: var(--cuk-semantic-text-primary);
  background: var(--cuk-semantic-surface-canvas);
  border: 1px solid var(--cuk-semantic-border-default);
}
</style>

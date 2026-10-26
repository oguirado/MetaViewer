<script setup>
/**
 * @file Interim empty-wall view for the MetaViewer wall (lane U1).
 * One-file seam: when kit 0.2.1 ships EmptyWall, the integration unit swaps
 * this file for the kit component without touching callers. Props/events
 * only; no host calls, no storage, no invented surfaces.
 */
import { UiButton } from 'capsule-ui-kit/ui';
import './wall.css';

defineProps({
  title: { type: String, default: 'A clear view of your work.' },
  hint: { type: String, default: 'Add a capsule to bring your surfaces together in one wall.' },
});

defineEmits(['add-capsule']);
</script>
<template>
  <section class="mv-wall-empty" aria-labelledby="empty-wall-title">
    <div class="mv-wall-empty__mark" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
    <p class="mv-wall-empty__eyebrow">YOUR WORKSPACE</p>
    <h1 id="empty-wall-title">{{ title }}</h1>
    <p class="mv-wall-empty__hint">{{ hint }}</p>
    <UiButton
      id="empty-wall-add"
      data-semantic-anchor="wall/add-capsule"
      label="Add capsule"
      intent="primary"
      @click="$emit('add-capsule')"
    />
  </section>
</template>

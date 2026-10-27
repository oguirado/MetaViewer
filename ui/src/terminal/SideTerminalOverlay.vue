<script setup>
/**
 * MetaViewer side-terminal overlay (lane U3): the operator terminal as a
 * right-side overlay floating above the wall on the kit SideTerminalPanel.
 * The host wrapper contributes no box (`display: contents`), so the overlay
 * never reflows tiles; width, open state and chrome offsets are kit-owned
 * (resizable separator, persisted open/width). Provider menu entries come
 * from host data through the multislot provider adapter; malformed host
 * data falls back to the shell-only menu. The terminal binding
 * (`{session, port}`) is injected; without one the overlay hands the kit
 * panel a no-core empty-state facade so it projects its designed empty
 * state instead of exception text.
 */
import { computed, markRaw, onBeforeUnmount, onMounted, ref, toRaw, watch } from 'vue';
import SideTerminalPanel from '/.kit/capsule-ui-kit/src/side-terminal/SideTerminalPanel.vue';
import BrokerLaunchControls from './BrokerLaunchControls.vue';
import { createSideTerminalFacade, createEmptySideTerminalFacade, useTerminalChromeGeometry } from './sideTerminalFacade.js';
import { toKitMenuProviders } from '../multislot/multislotProviders.js';
import './terminal.css';

/** @typedef {import('vue').PropType<{ session: string, port: MessagePort } | null>} TerminalBindingProp */

const props = defineProps({
  terminalBroker: { type: /** @type {import('vue').PropType<ReturnType<typeof import('../core/hostAdapters.js').createTerminalBroker>>} */ (Object), default: null },
  terminalBinding: { type: /** @type {TerminalBindingProp} */ (Object), default: null },
  hostProviders: { type: /** @type {import('vue').PropType<unknown[]>} */ (Array), default: () => [] },
  open: { type: Boolean, default: null },
  storage: { type: /** @type {import('vue').PropType<Pick<Storage, 'getItem' | 'setItem'> | null | undefined>} */ (Object), default: undefined },
  topOffset: { type: Number, default: 0 },
  bottomOffset: { type: Number, default: 0 },
});

const emit = defineEmits(['update:open', 'state-change']);
const overlayOpen = ref(props.open !== false);
watch(() => props.open, value => { overlayOpen.value = value !== false; });
/** @param {boolean} value */
function updateOpen(value) { overlayOpen.value = value; emit('update:open', value); }

/** Escape closes this view without affecting host session ownership.
 * @param {KeyboardEvent} event */
function onEscape(event) {
  if (event.key === 'Escape' && overlayOpen.value) updateOpen(false);
}
onMounted(() => globalThis.window?.addEventListener?.('keydown', onEscape));
onBeforeUnmount(() => globalThis.window?.removeEventListener?.('keydown', onEscape));

// Carry measurements through the kit nonce sheet; CSS supplies the top-bar
// minimum even before App has measured chrome or when no nonce is available.
const chromeGeometry = useTerminalChromeGeometry(() => ({
  '--mv-terminal-top': `${Number.isFinite(props.topOffset) ? Math.max(0, Math.round(props.topOffset)) : 0}px`,
  '--mv-terminal-bottom': `${Number.isFinite(props.bottomOffset) ? Math.max(0, Math.round(props.bottomOffset)) : 0}px`,
}));
const bindingState = ref('TERMINAL_UNAVAILABLE');

/** @type {import('vue').ShallowRef<ReturnType<typeof createSideTerminalFacade> | ReturnType<typeof createEmptySideTerminalFacade> | null>} */
const facadeRef = ref(null);

function rebind() {
  try {
    facadeRef.value?.dispose();
  } catch {
    // Teardown is best-effort; the null facade is authoritative.
  }
  const binding = props.terminalBinding ? toRaw(props.terminalBinding) : null;
  if (!binding) {
    bindingState.value = 'TERMINAL_UNAVAILABLE';
    facadeRef.value = markRaw(createEmptySideTerminalFacade());
    return;
  }
  try {
    facadeRef.value = markRaw(createSideTerminalFacade({ session: binding.session, port: toRaw(binding.port) }));
    bindingState.value = 'TERMINAL_ATTACHED';
  } catch {
    bindingState.value = 'TERMINAL_BINDING_REFUSED';
    facadeRef.value = markRaw(createEmptySideTerminalFacade());
  }
}
rebind();
watch(() => props.terminalBinding, rebind);
onBeforeUnmount(() => {
  try {
    facadeRef.value?.dispose();
  } catch {
    // Teardown is best-effort.
  }
  facadeRef.value = null;
});

const kitProviders = computed(() => {
  try {
    return [...toKitMenuProviders(props.hostProviders)];
  } catch {
    return [...toKitMenuProviders([])];
  }
});
</script>
<template>
  <div id="mv-side-terminal-overlay" class="mv-side-terminal-overlay" data-semantic-anchor="terminal/overlay" :data-cuk-geometry-id="chromeGeometry" :data-terminal-state="bindingState">
    <BrokerLaunchControls v-if="terminalBroker" :visible="overlayOpen" :broker="terminalBroker" :providers="hostProviders" />
    <SideTerminalPanel
      :facade="facadeRef ?? undefined"
      :providers="kitProviders"
      :storage="storage"
      :open="open"
      :top-offset="topOffset"
      :bottom-offset="bottomOffset"
      @update:open="updateOpen"
      @state-change="emit('state-change', $event)"
    />
  </div>
</template>

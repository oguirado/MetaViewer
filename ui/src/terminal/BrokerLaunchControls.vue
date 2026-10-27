<script setup>
import SidebarIcon from '../../.kit/capsule-ui-kit/src/shell/SidebarIcon.vue';
import { computed, onBeforeUnmount, ref } from 'vue';
import { toKitMenuProviders } from '../multislot/multislotProviders.js';
import { createSideTerminalBrokerFacade } from './sideTerminalFacade.js';
import { SHELL_COMMAND, PROVIDER_COMMAND } from './providers.js';
const props = defineProps({
  broker: { type: /** @type {import('vue').PropType<ReturnType<typeof import('../core/hostAdapters.js').createTerminalBroker>>} */ (Object), default: null },
  providers: { type: /** @type {import('vue').PropType<unknown[]>} */ (Array), default: () => [] },
  idPrefix: { type: String, default: 'mv-terminal-broker' },
  anchorPrefix: { type: String, default: 'terminal' },
  visible: { type: Boolean, default: true },
  showMenu: { type: Boolean, default: true },
});
const facade = computed(() => createSideTerminalBrokerFacade(props.broker));
const enabled = computed(() => facade.value?.state.enabled === true);
const busy = computed(() => facade.value?.state.busy === true || launching.value);
const launching = ref(false);
const outcome = ref(/** @type {{code:string,message:string}|null} */ (null));
let active = true;
onBeforeUnmount(() => { active = false; });
const entries = computed(() => {
  try { return toKitMenuProviders(props.providers); }
  catch { return toKitMenuProviders([]); }
});
/** @param {Event} event */
async function enable(event) {
  if (busy.value || !facade.value?.canEnable) return;
  const next = /** @type {HTMLInputElement} */ (event.target).checked;
  const broker = facade.value;
  try {
    await broker?.setEnabled(next);
    if (active && broker === facade.value) { outcome.value = null; }
  } catch {
    if (active && broker === facade.value) outcome.value = { code: 'TERMINAL_ENABLE_REFUSED', message: 'Terminal access is unavailable.' };
  } finally {
    if (active) { /** @type {HTMLInputElement} */ (event.target).checked = enabled.value; }
  }
}
/** @param {ReturnType<typeof toKitMenuProviders>[number]} entry */
async function launch(entry) {
  if (busy.value || !facade.value?.canOpen) return;
  launching.value = true;
  const broker = facade.value;
  try {
    const opened = await broker?.open({ command: entry.command ?? PROVIDER_COMMAND,
      args: entry.id === SHELL_COMMAND ? [] : (Array.isArray(entry.argv) ? [...entry.argv] : []), cols: 80, rows: 24 });
    if (!active || broker !== facade.value || !facade.value?.state.enabled) {
      const id = typeof opened?.session === 'string' ? opened.session : opened?.session?.session;
      if (typeof id === 'string') { try { broker?.close({ session: id }); } catch { /* Host owns final cleanup. */ } }
      return;
    }
    outcome.value = { code: 'TERMINAL_OPENED', message: 'Terminal session opened.' };
  } catch {
    if (active) outcome.value = { code: 'TERMINAL_LAUNCH_REFUSED', message: 'This terminal launch is unavailable.' };
  } finally { if (active) launching.value = false; }
}
</script>
<template>
  <section class="mv-broker-launch" :id="idPrefix" :hidden="!visible" :data-semantic-anchor="`${anchorPrefix}/launch`" aria-label="Terminal launch">
    <label v-if="facade?.canEnable" :for="`${idPrefix}-enable`">
      <input :id="`${idPrefix}-enable`" type="checkbox" aria-label="Enable terminal access" :data-semantic-anchor="`${anchorPrefix}/enable`"
        :checked="enabled" :disabled="busy" @change="enable" />Enable terminal access
    </label>
    <div v-if="showMenu && facade?.canOpen" role="group" aria-label="Terminal providers">
      <button v-for="entry in entries" :key="entry.id" type="button" :id="`${idPrefix}-launch-${entry.id}`"
        :data-semantic-anchor="`${anchorPrefix}/provider/${entry.id}`" :disabled="busy || (facade?.canEnable && !enabled)" @click="launch(entry)"><SidebarIcon name="console" aria-hidden="true" />{{ entry.label }}</button>
    </div>
    <p v-if="launching" :id="`${idPrefix}-pending`" :data-semantic-anchor="`${anchorPrefix}/pending`"
      class="mv-broker-launch__pending" role="status">Starting session…</p>
    <p v-if="outcome" :id="`${idPrefix}-outcome`" :data-semantic-anchor="`${anchorPrefix}/outcome`"
      role="status" :data-outcome-code="outcome.code">{{ outcome.message }}</p>
  </section>
</template>

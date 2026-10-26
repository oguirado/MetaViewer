<script setup>
/** [TARGET, unit decision] Missing TERM view handoff. Port ownership is injected;
 * mounting/folding/disposing a view never spawns or kills a host session. */
import { onBeforeUnmount, onMounted, ref, toRaw, watch } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { createTerminalClient } from './terminalClient.js';
import '@xterm/xterm/css/xterm.css';
const props = defineProps({
  session: { type: String, required: true },
  port: { type: /** @type {import('vue').PropType<MessagePort|null>} */ (Object), default: null },
});
const host = ref(/** @type {HTMLElement|null} */ (null));
const status = ref('Terminal service unavailable');
let dispose = () => {};
function bindTerminal() {
  dispose();
  status.value = 'Terminal service unavailable';
  if (!props.port || !host.value || !props.session) return;
  const port = toRaw(props.port);
  const session = props.session;
  const terminal = new Terminal({ allowProposedApi: false, convertEol: false });
  const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(host.value);
  let active = true;
  const client = createTerminalClient({ session, port, write: (bytes, done) => terminal.write(bytes, done),
    onStatus: message => { status.value = message; } });
  const input = terminal.onData(data => client.input(new TextEncoder().encode(data)));
  const binary = terminal.onBinary(data => client.input(Uint8Array.from(data, char => char.charCodeAt(0))));
  const observer = new ResizeObserver(() => {
    if (!active || !host.value || !host.value.clientWidth || !host.value.clientHeight) return;
    fit.fit(); port.postMessage({ session, cols: terminal.cols, rows: terminal.rows });
  });
  observer.observe(host.value); status.value = 'Terminal attached';
  dispose = () => { active = false; observer.disconnect(); input.dispose(); binary.dispose();
    client.dispose(); terminal.dispose(); };
}
onMounted(bindTerminal);
watch(() => [props.session, props.port], bindTerminal, { flush: 'post' });
onBeforeUnmount(() => dispose());
</script>
<template>
  <section class="mv-terminal" aria-label="Session terminal">
    <p role="status">{{ status }}</p>
    <div ref="host" class="mv-terminal-host" />
  </section>
</template>
<style scoped>
.mv-terminal-host { min-height: 120px; height: 180px; }
.mv-terminal p { margin: 0; padding: 4px 16px; }
</style>

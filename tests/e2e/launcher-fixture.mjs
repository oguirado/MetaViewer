// [TARGET, unit decision] Only the handoff is test-owned: emitted launcher
// intents are fed unchanged to the Rust catalog driver by the parent test.
// No claim of native capsule launch is made by this hosted journey.
import { createApp, h, nextTick, ref } from '../../ui/node_modules/vue/dist/vue.runtime.esm-bundler.js';
import { installKitTheme } from 'capsule-ui-kit/theme';
import 'capsule-ui-kit/theme.css';
import CatalogLauncher from '../../ui/src/catalog/CatalogLauncher.vue';

const kinds = ['identity-browser', 'program', 'desktop-window'];
const fixtureWindow = {
  xid: 77594627,
  witness: '0x04a00003:1730541000',
  title: 'Chromium — Logged In',
  program: 'chromium',
  width: 1280,
  height: 900,
};
const visible = ref(false), choices = ref(kinds), intents = [];
const app = createApp({ setup: () => () => h('main', [
  h('button', { id: 'open-launcher', onClick: () => { visible.value = true; } }, 'New Capsule'),
  h(CatalogLauncher, { visible: visible.value, kinds: choices.value,
    'onUpdate:visible': value => { visible.value = value; },
    onCreate: (intent, settle) => { intents.push(intent); settle?.({ ok: true }); } }),
]) });
installKitTheme(app);
app.mount('#metaviewer-app');

window.runLauncherJourney = async () => {
  globalThis.metaviewerRoles = {
    listWindows: async () => [fixtureWindow],
  };
  const flush = async () => { await nextTick(); await new Promise(resolve => setTimeout(resolve, 50)); };
  const requireNode = id => {
    const node = document.getElementById(id);
    if (!node || !node.checkVisibility()) throw Error(`E2E_LAUNCHER: missing visible ${id}`);
    return node;
  };
  try {
    for (const kind of kinds) {
      requireNode('open-launcher').click();
      await flush();
      requireNode(`shell/new-capsule/card-${kind}`).click();
      await flush();
      requireNode('shell/new-capsule/create').click();
      await flush();
      if (kind === 'program') {
        // Program asks for the binary first; Start stays disabled until a name is typed.
        if (!requireNode('shell/new-capsule/program-start').disabled) throw Error('E2E_LAUNCHER: Start enabled without a binary');
        const field = requireNode('shell/new-capsule/program-binary');
        field.value = 'gedit';
        field.dispatchEvent(new Event('input', { bubbles: true }));
        await flush();
        requireNode('shell/new-capsule/program-start').click();
        await flush();
      } else if (kind === 'desktop-window') {
        // Desktop window requires explicit row selection and Add click.
        if (!requireNode('shell/new-capsule/window-add').disabled) throw Error('E2E_LAUNCHER: Add enabled without a selected window');
        requireNode(`shell/new-capsule/window-row-${fixtureWindow.xid}`).click();
        await flush();
        if (requireNode('shell/new-capsule/window-add').disabled) throw Error('E2E_LAUNCHER: Add disabled after selecting a window');
        requireNode('shell/new-capsule/window-add').click();
        await flush();
      }
      if (visible.value) throw Error('E2E_LAUNCHER: create did not close dialog');
    }
    // Unknown kind reaches the product's typed error UI and cannot emit create.
    choices.value = ['not-a-catalog-kind'];
    requireNode('open-launcher').click();
    await flush();
    const errors = [...document.querySelectorAll('[data-error-code]')].map(n => n.dataset.errorCode);
    const unknownCards = document.querySelectorAll('[id^="shell/new-capsule/card-"]').length;
    return { schema: 'metaviewer.launcher-journey/v1', intents: [...intents],
      unknown: { errors, cards: unknownCards, emitted: intents.length - kinds.length } };
  } finally { app.unmount(); }
};

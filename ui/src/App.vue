<script setup>
import { defineComponent, h, markRaw, ref } from 'vue';
import DockWorkspace from 'capsule-ui-kit/DockWorkspace';
import CapsulePanel from 'capsule-ui-kit/CapsulePanel';

/** @typedef {import('capsule-ui-kit/layout').LayoutProfileEnvelope} LayoutProfile */
/** @typedef {import('capsule-ui-kit/layout').LayoutProfileScope} LayoutScope */
/** @typedef {{ readRaw: () => Promise<string|null>, writeAtomic: (json: string) => Promise<void> }} LayoutStorage */

const props = defineProps({
  layout: {
    type: /** @type {import('vue').PropType<LayoutProfile>} */ (Object),
    required: true,
  },
  storage: {
    type: /** @type {import('vue').PropType<LayoutStorage>} */ (Object),
    required: true,
  },
  scope: {
    type: /** @type {import('vue').PropType<LayoutScope>} */ (Object),
    required: true,
  },
});

const settled = ref(false);

/**
 * W0 closed capsule allowlist. Empty until a later unit owns capsule
 * components; every id renders honest unavailable content, never a demo.
 * @type {Readonly<Record<string, import('vue').Component>>}
 */
const capsuleTypes = Object.freeze({});

/**
 * @param {string} id
 * @returns {import('vue').Component}
 */
function resolveCapsuleType(id) {
  if (!Object.hasOwn(capsuleTypes, id)) throw new Error('Unknown capsule type');
  return /** @type {import('vue').Component} */ (
    /** @type {Record<string, unknown>} */ (capsuleTypes)[id]
  );
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function asRecord(value) {
  if (typeof value !== 'object' || value === null) return {};
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * @param {unknown} value
 * @returns {string|null}
 */
function asNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

const CapsuleRouter = markRaw(
  defineComponent({
    name: 'CapsuleRouter',
    props: {
      params: { type: Object, required: true },
    },
    setup(routerProps) {
      return () => {
        const outer = asRecord(routerProps.params);
        const id = asNonEmptyString(asRecord(outer.params).capsuleId);
        if (id === null) {
          return h('p', { role: 'alert' }, 'Missing capsule id. Reset the workspace layout.');
        }
        const api = asRecord(outer.api);
        const title = asNonEmptyString(api.title) ?? id;
        const instance = asNonEmptyString(api.id) ?? id;
        const closeFn = api.close;
        const onClosePanel =
          typeof closeFn === 'function'
            ? () => {
                /** @type {() => unknown} */ (closeFn)();
              }
            : undefined;
        // Only the allowlist lookup runs inside try; render faults stay visible.
        /** @type {import('vue').Component|null} */
        let component = null;
        try {
          component = resolveCapsuleType(id);
        } catch {
          component = null;
        }
        if (component === null) {
          return h(
            CapsulePanel,
            {
              capsuleId: id,
              placeholderTitle: title,
              presentationInstance: instance,
              onClosePanel,
            },
            {
              surface: () =>
                h('p', { role: 'alert' }, 'Unknown capsule type. Reset the workspace layout.'),
            },
          );
        }
        const surface = component;
        return h(
          CapsulePanel,
          {
            capsuleId: id,
            placeholderTitle: title,
            presentationInstance: instance,
            onClosePanel,
          },
          { surface: () => h(surface) },
        );
      };
    },
  }),
);

const panelComponents = markRaw({ CapsulePanel: CapsuleRouter });

function onWallSettled() {
  settled.value = true;
}
</script>
<template>
  <div class="metaviewer" :data-wall-settled="String(settled)">
    <main aria-label="MetaViewer capsule wall">
      <DockWorkspace
        :scope="props.scope"
        :default-profile="props.layout"
        :storage="props.storage"
        :panel-components="panelComponents"
        color-scheme="light"
        density="regular"
        workspace-title="MetaViewer"
        @wall-settled="onWallSettled"
      />
    </main>
    <footer role="status">{{ settled ? 'Wall ready.' : 'Opening wall…' }}</footer>
  </div>
</template>
<style>
.metaviewer {
  height: 100dvh;
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto;
}
.metaviewer main {
  min-height: 0;
  min-width: 0;
}
.metaviewer footer {
  padding: 8px 16px;
  font-size: 12px;
}
body {
  margin: 0;
}
</style>

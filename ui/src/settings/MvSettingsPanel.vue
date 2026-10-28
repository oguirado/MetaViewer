<script setup>
import { computed, onMounted, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { setKitScheme } from 'capsule-ui-kit/theme';
import {
  MV_DENSITY,
  MV_PRIMARY_SCHEME,
  MV_SCHEMES,
  MV_SETTINGS_ANCHORS,
  MV_SETTINGS_IDS,
  MV_SETTINGS_SAVE_WINDOW_MS,
  createDebouncedRunner,
  createHostSettingsStore,
  defaultMvSettings,
  isMvSettingsDecodeFailure,
  mvSchemeOptionAnchor,
  mvSchemeOptionDomId,
  settingsRefusalFor,
} from './settingsModel.js';

/**
 * MetaViewer settings panel (AC-08): mv-light (primary) / mv-dark scheme
 * with live switch, compact density readout, persisted through the
 * injected host settings interface. Failed saves render as a typed refusal
 * row and keep the UI state; malformed stored text falls back to defaults
 * silently. Changes save leading-edge debounced: the first change in an
 * idle panel persists immediately, bursts collapse to one last-wins write.
 * The panel never crashes and never leaks host error text.
 */

const props = defineProps({
  settingsHost: { type: Object, required: true },
});

const emit = defineEmits(['scheme-change']);

const scheme = ref(MV_PRIMARY_SCHEME);
const density = ref(MV_DENSITY);
const refusal = ref(/** @type {{ code: string, reason: string }|null} */ (null));
const ready = ref(false);
const liveVerified = ref(false);

const saving = ref(false);
const store = shallowRef(/** @type {ReturnType<typeof createHostSettingsStore>|null} */ (null));
let generation = 0;

const options = computed(() =>
  MV_SCHEMES.map((id) => ({
    id,
    domId: mvSchemeOptionDomId(id),
    anchor: mvSchemeOptionAnchor(id),
    label: id === 'mv-light' ? 'Light' : 'Dark',
    name: `Color scheme ${id === 'mv-light' ? 'Light' : 'Dark'}`,
  })),
);

const applyScheme = /** @type {(scheme: string) => void} */ (setKitScheme);

/**
 * @param {string} next Scheme to apply live.
 * @returns {boolean} True when the kit accepted the scheme.
 */
function applyLive(next) {
  try {
    applyScheme(next);
    return true;
  } catch {
    return false;
  }
}

/** Load the current host only; obsolete completions cannot change the theme. */
async function loadHost() {
  const current = ++generation;
  ready.value = false;
  liveVerified.value = false;
  saving.value = false;
  refusal.value = null;
  store.value = null;
  try {
    const active = createHostSettingsStore(
      /** @type {import('./settingsModel.js').HostSettingsPort} */ (
        /** @type {unknown} */ (props.settingsHost)
      ),
    );
    store.value = active;
    const loaded = await active.load();
    if (current !== generation) return;
    if (applyLive(loaded.scheme)) {
      liveVerified.value = true;
      scheme.value = loaded.scheme;
      density.value = loaded.density;
      emit('scheme-change', loaded.scheme);
    } else {
      refusal.value = settingsRefusalFor({ code: 'ERR_SETTINGS_APPLY_FAILED' });
    }
  } catch (error) {
    if (current !== generation) return;
    const fallback = defaultMvSettings();
    if (applyLive(fallback.scheme)) {
      liveVerified.value = true;
      scheme.value = fallback.scheme;
      density.value = fallback.density;
      emit('scheme-change', fallback.scheme);
      if (!isMvSettingsDecodeFailure(error)) refusal.value = settingsRefusalFor(error);
    } else {
      refusal.value = settingsRefusalFor(error);
    }
  } finally {
    if (current === generation) ready.value = true;
  }
}

/**
 * Leading-edge debounced persistence: the first change saves immediately,
 * bursts within the window collapse to one trailing save with the last
 * scheme. Trailing continuations re-check every guard, so a replaced host
 * or an in-flight save still drops them safely.
 */
const persistRunner = createDebouncedRunner((next) => { void persistScheme(next); }, MV_SETTINGS_SAVE_WINDOW_MS);

onMounted(() => { void loadHost(); });
watch(
  () => props.settingsHost,
  () => {
    persistRunner.cancel();
    void loadHost();
  },
  { flush: 'sync' },
);

/**
 * Persist before changing the live theme. Only one save per host may run;
 * host replacement and unmount invalidate pending continuations. Failed live
 * restoration clears the verified selection and gates changes until a host reload.
 * @param {string} next Requested scheme.
 */
async function persistScheme(next) {
  const active = store.value;
  if (!ready.value || !liveVerified.value || saving.value || next === scheme.value || active === null) return;
  const current = generation;
  const previous = scheme.value;
  saving.value = true;
  try {
    await active.save({ scheme: next, density: density.value });
    if (current !== generation) return;
    if (!applyLive(next)) {
      // Preserve the primary failure even if persistence rollback also fails.
      // An unsuccessful live rollback leaves no verified radio selection.
      refusal.value = settingsRefusalFor({ code: 'ERR_SETTINGS_APPLY_FAILED' });
      liveVerified.value = applyLive(previous);
      try {
        await active.save({ scheme: previous, density: density.value });
      } catch {
        // The apply refusal remains authoritative; never replace it with a save error.
      }
      return;
    }
    scheme.value = next;
    refusal.value = null;
    emit('scheme-change', next);
  } catch (error) {
    if (current === generation) refusal.value = settingsRefusalFor(error);
  } finally {
    if (current === generation) saving.value = false;
  }
}

/**
 * Schedule persistence for a requested scheme. The last requested value
 * always wins: a revert to the applied scheme while a different trailing
 * value is queued overwrites the queue instead of dropping. Only a request
 * equal to both the persisted and the pending value is a no-op. Changes
 * while a save runs, before the live theme verifies, or past a host
 * replacement are dropped.
 * @param {string} next Requested scheme.
 */
function selectScheme(next) {
  const active = store.value;
  if (!ready.value || !liveVerified.value || saving.value || active === null) return;
  const pending = persistRunner.pendingValue();
  if (next === scheme.value && (pending === null || pending === next)) return;
  persistRunner(next);
}

onBeforeUnmount(() => { generation += 1; persistRunner.cancel(); });
</script>

<template>
  <section
    :id="MV_SETTINGS_IDS.panel"
    class="mv4-set"
    role="region"
    aria-label="Settings"
    :data-semantic-anchor="MV_SETTINGS_ANCHORS.panel"
  >
    <h2 class="mv4-set-title">Settings</h2>
    <div
      :id="MV_SETTINGS_IDS.schemeGroup"
      class="mv4-scheme"
      role="radiogroup"
      aria-label="Color scheme"
      :data-semantic-anchor="MV_SETTINGS_ANCHORS.schemeGroup"
    >
      <label v-for="option in options" :key="option.id" class="mv4-scheme-option">
        <input
          :id="option.domId"
          type="radio"
          name="mv-color-scheme"
          :value="option.id"
          :checked="liveVerified && scheme === option.id"
          :disabled="!ready || !liveVerified || saving || store === null"
          :data-semantic-anchor="option.anchor"
          :aria-label="option.name"
          @change="selectScheme(option.id)"
        />
        <span class="mv4-scheme-label">{{ option.label }}</span>
      </label>
    </div>
    <p :id="MV_SETTINGS_IDS.densityRow" class="mv4-density" :data-semantic-anchor="MV_SETTINGS_ANCHORS.densityRow">
      Density: Compact
    </p>
    <p
      v-if="refusal !== null"
      :id="MV_SETTINGS_IDS.refusalRow"
      class="mv4-refusal"
      role="alert"
      :data-semantic-anchor="MV_SETTINGS_ANCHORS.refusalRow"
      :data-refusal-code="refusal.code"
      :title="refusal.reason"
    >
      {{ refusal.reason }}
    </p>
  </section>
</template>

<style scoped src="./settings.css"></style>

<script setup>
import { computed, inject, onMounted, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { setKitScheme } from 'capsule-ui-kit/theme';
import {
  MV_DEFAULT_RECORDING_FPS,
  MV_DEFAULT_WALL_FPS,
  MV_DENSITIES,
  MV_DENSITY,
  MV_PRIMARY_SCHEME,
  MV_RECORDING_FPS_MAX,
  MV_RECORDING_FPS_MIN,
  MV_SCHEMES,
  MV_SETTINGS_ANCHORS,
  MV_SETTINGS_IDS,
  MV_SETTINGS_SAVE_WINDOW_MS,
  MV_WALL_FPS_VALUES,
  MV_WALL_FPS_WINDOW_MS,
  createDebouncedRunner,
  createHostSettingsStore,
  createWallFpsMeter,
  defaultMvSettings,
  formatWallFpsLine,
  isMvSettingsDecodeFailure,
  mvDensityOptionAnchor,
  mvDensityOptionDomId,
  mvSchemeOptionAnchor,
  mvSchemeOptionDomId,
  mvWallFpsOptionAnchor,
  mvWallFpsOptionDomId,
  settingsRefusalFor,
} from './settingsModel.js';

/**
 * MetaViewer settings panel (mvui33): mv-dark (primary) / mv-light scheme
 * with live switch, density control (compact/comfortable), live wall fps
 * presets (3/30/60) with a measured actual-fps readout, and recording fps
 * (1..60). Persisted as one closed four-key object through the injected
 * host settings interface. Failed saves render as a typed refusal row and
 * keep the UI state; malformed stored text falls back to defaults silently.
 * Changes save leading-edge debounced across every field: the first change
 * in an idle panel persists immediately, bursts collapse to one last-wins
 * write carrying the last value of each field. The panel never crashes and
 * never leaks host error text.
 *
 * Density application (root density attribute, wall prop) belongs to the
 * parent: the panel only persists the value and mirrors it through the
 * `density` model. The actual wall fps is measured from presentation
 * notices on the optional frames port over a short sliding window.
 */

const props = defineProps({
  settingsHost: { type: Object, required: true },
  framesPort: { type: /** @type {import('vue').PropType<{ subscribeFrames?: (callback: (notice: unknown) => void) => unknown }|null>} */ (Object), default: null },
  frameClock: { type: /** @type {import('vue').PropType<{ now?: () => number }|null>} */ (Object), default: null },
  frameTimer: { type: /** @type {import('vue').PropType<{ setTimeout?: (callback: () => void, ms: number) => unknown, clearTimeout?: (id: unknown) => void }|null>} */ (Object), default: null },
});

const emit = defineEmits(['scheme-change']);
const hiddenSessionSettings = /** @type {{get:()=>number,set:(value:number)=>void}|null} */ (inject('hiddenSessionSettings', null));
const hiddenSessionLimit = ref(hiddenSessionSettings?.get() ?? 4), hiddenSessionError = ref('');
/** @param {Event} event */
function changeHiddenSessionLimit(event) {
  const input = /** @type {HTMLInputElement} */ (event.target);
  hiddenSessionError.value = '';
  try {
    if (!input.value.trim()) throw Error('HIDDEN_SESSION_LIMIT_INVALID');
    const value = Number(input.value);
    hiddenSessionSettings?.set(value); hiddenSessionLimit.value = value;
  } catch { hiddenSessionError.value = 'Enter a non-negative whole number. The previous limit is still active.'; }
}


/** Density model: the parent applies it to the UI density. @type {import('vue').Ref<string>} */
const densityModel = defineModel('density', { default: MV_DENSITY });

const scheme = ref(MV_PRIMARY_SCHEME);
const density = ref(MV_DENSITY);
const wallFps = ref(MV_DEFAULT_WALL_FPS);
const recordingFps = ref(MV_DEFAULT_RECORDING_FPS);
const captureHost = /** @type {any} */ (globalThis).metaviewerCapturePreferences;
const captureOptions = ref(/** @type {any} */ (null)), captureOptionsError = ref(''), captureOptionsBusy = ref(false);
/** @type {(()=>void)|null} */ let stopCapturePreferences = null;
async function refreshCapturePreferences() {
  if (!captureHost?.get) return;
  try { const result=await captureHost.get(); if(!result?.ok)throw Error(result?.reason || 'Recording preferences are unavailable.');captureOptions.value=result; }
  catch {captureOptionsError.value='Recording preferences are unavailable.';}
}
/** @param {string} action @param {string} value */
async function changeCapturePreference(action,value) {
  captureOptionsBusy.value=true;captureOptionsError.value='';
  try {const result=await (action==='folder'?captureHost.chooseFolder(value):captureHost.setMode(value));
    if(!result?.ok)throw Error(result?.reason || 'Recording preferences could not be saved.');captureOptions.value=result;
  } catch(error){captureOptionsError.value=error instanceof Error?error.message:'Recording preferences could not be saved.';}
  finally {captureOptionsBusy.value=false;}
}
/** @param {number|null} bytes */
function freeSpaceText(bytes) {return typeof bytes==='number'&&Number.isFinite(bytes)?`${(bytes/(1024**3)).toFixed(1)} GiB free`:'Free space unavailable';}
onMounted(()=>{void refreshCapturePreferences();if(captureHost?.subscribe)stopCapturePreferences=captureHost.subscribe(()=>{void refreshCapturePreferences();});});

const refusal = ref(/** @type {{ code: string, reason: string }|null} */ (null));
const ready = ref(false);
const liveVerified = ref(false);
const actualFps = ref(/** @type {number|null} */ (null));

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

const densityOptions = computed(() =>
  MV_DENSITIES.map((id) => ({
    id,
    domId: mvDensityOptionDomId(id),
    anchor: mvDensityOptionAnchor(id),
    label: id === 'compact' ? 'Compact' : 'Comfortable',
    name: `Density ${id === 'compact' ? 'Compact' : 'Comfortable'}`,
  })),
);

const wallFpsOptions = computed(() =>
  MV_WALL_FPS_VALUES.map((value) => ({
    value,
    domId: mvWallFpsOptionDomId(value),
    anchor: mvWallFpsOptionAnchor(value),
    label: String(value),
    name: `Live wall fps ${value}`,
  })),
);

const densityReadout = computed(() => (density.value === 'comfortable' ? 'Density: Comfortable' : 'Density: Compact'));
const wallFpsLine = computed(() => formatWallFpsLine(wallFps.value, actualFps.value));

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

/**
 * @returns {{ scheme: string, density: string, wallFps: number, recordingFps: number }}
 */
function currentSettings() {
  return { scheme: scheme.value, density: density.value, wallFps: wallFps.value, recordingFps: recordingFps.value };
}

/**
 * @param {unknown} value
 * @returns {value is { scheme: string, density: string, wallFps: number, recordingFps: number }}
 */
function isSettingsObject(value) {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = /** @type {Record<string, unknown>} */ (value);
  return (
    typeof candidate.scheme === 'string'
    && typeof candidate.density === 'string'
    && typeof candidate.wallFps === 'number'
    && typeof candidate.recordingFps === 'number'
  );
}

/**
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean} True when both are equal full settings objects.
 */
function settingsEqual(left, right) {
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) return false;
  const a = /** @type {Record<string, unknown>} */ (left);
  const b = /** @type {Record<string, unknown>} */ (right);
  return (
    a.scheme === b.scheme
    && a.density === b.density
    && a.wallFps === b.wallFps
    && a.recordingFps === b.recordingFps
  );
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
      wallFps.value = loaded.wallFps;
      recordingFps.value = loaded.recordingFps;
      densityModel.value = loaded.density;
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
      wallFps.value = fallback.wallFps;
      recordingFps.value = fallback.recordingFps;
      densityModel.value = fallback.density;
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
 * Leading-edge debounced persistence across every field: the first change
 * saves immediately, bursts within the window collapse to one trailing save
 * with the last value of each field. Trailing continuations re-check every
 * guard, so a replaced host or an in-flight save still drops them safely.
 */
const persistRunner = createDebouncedRunner((next) => { void persistSettings(next); }, MV_SETTINGS_SAVE_WINDOW_MS);

/**
 * Sliding-window actual wall fps meter over presentation notices. The clock
 * is injected for tests; production uses the renderer clock.
 */
const fpsMeter = createWallFpsMeter({
  windowMs: MV_WALL_FPS_WINDOW_MS,
  now: typeof props.frameClock?.now === 'function' ? props.frameClock.now : undefined,
});

/** @type {unknown} */
let fpsDecayTimer = null;

/**
 * @param {() => void} callback
 * @param {number} ms
 * @returns {unknown}
 */
function fpsSetTimeout(callback, ms) {
  const port = /** @type {{ setTimeout?: unknown }|null} */ (
    typeof props.frameTimer === 'object' && props.frameTimer !== null ? props.frameTimer : null
  );
  if (typeof port?.setTimeout === 'function') {
    return /** @type {(callback: () => void, ms: number) => unknown} */ (port.setTimeout)(callback, ms);
  }
  return setTimeout(callback, ms);
}

/**
 * @param {unknown} id
 */
function fpsClearTimeout(id) {
  const port = /** @type {{ clearTimeout?: unknown }|null} */ (
    typeof props.frameTimer === 'object' && props.frameTimer !== null ? props.frameTimer : null
  );
  if (typeof port?.clearTimeout === 'function') {
    /** @type {(id: unknown) => void} */ (port.clearTimeout)(id);
    return;
  }
  clearTimeout(/** @type {ReturnType<typeof setTimeout>} */ (id));
}

/** Cancel the pending readout decay, if any. Teardown never throws. */
function clearFpsDecayTimer() {
  if (fpsDecayTimer === null) return;
  const pending = fpsDecayTimer;
  fpsDecayTimer = null;
  try { fpsClearTimeout(pending); } catch { /* A failed teardown never breaks the panel. */ }
}

/**
 * Decay callback: re-read the meter, and when a sample is still inside the
 * window (the timer fired at or just before the window edge) re-arm for the
 * remaining time so a stale rate can never linger. A single timeout is ever
 * pending; silence past the window falls back to the placeholder.
 */
function onFpsDecayTimer() {
  fpsDecayTimer = null;
  actualFps.value = fpsMeter.read();
  if (actualFps.value === null) return;
  const wait = fpsMeter.msUntilEmpty();
  try {
    fpsDecayTimer = fpsSetTimeout(onFpsDecayTimer, wait > 0 ? wait : 1);
  } catch {
    fpsDecayTimer = null;
  }
}

/**
 * Re-arm the readout decay one window after the latest notice. A single
 * timeout is ever pending; silence past the window re-reads the meter so the
 * readout falls back to its placeholder until notices resume.
 */
function armFpsDecayTimer() {
  clearFpsDecayTimer();
  try {
    fpsDecayTimer = fpsSetTimeout(onFpsDecayTimer, MV_WALL_FPS_WINDOW_MS);
  } catch {
    fpsDecayTimer = null;
  }
}

/**
 * @param {unknown} notice Authority frame notice.
 */
function onFrameNotice(notice) {
  const frameRef = /** @type {{ frame_ref?: { ts_ns?: unknown } }|null} */ (
    typeof notice === 'object' && notice !== null ? notice : null
  );
  fpsMeter.push(frameRef?.frame_ref?.ts_ns);
  actualFps.value = fpsMeter.read();
  armFpsDecayTimer();
}

/** @type {(() => void)|null} */
let stopFrames = null;

/** Subscribe to presentation notices without touching scheduler/router behaviour. */
function subscribeFramesPort() {
  if (stopFrames !== null) {
    try { stopFrames(); } catch { /* A failed teardown never breaks the panel. */ }
    stopFrames = null;
  }
  const port = /** @type {{ subscribeFrames?: unknown }|null} */ (
    typeof props.framesPort === 'object' && props.framesPort !== null ? props.framesPort : null
  );
  if (typeof port?.subscribeFrames !== 'function') return;
  try {
    const stop = /** @type {(callback: (notice: unknown) => void) => unknown} */ (port.subscribeFrames).call(
      port, onFrameNotice,
    );
    if (typeof stop === 'function') stopFrames = /** @type {() => void} */ (stop);
  } catch {
    stopFrames = null;
  }
}

onMounted(() => { void loadHost(); subscribeFramesPort(); });
watch(
  () => props.settingsHost,
  () => {
    persistRunner.cancel();
    void loadHost();
  },
  { flush: 'sync' },
);
watch(
  () => props.framesPort,
  () => { subscribeFramesPort(); },
  { flush: 'sync' },
);

/**
 * Persist before changing the live theme. Only one save per host may run;
 * host replacement and unmount invalidate pending continuations. Failed live
 * restoration clears the verified selection and gates changes until a host reload.
 * @param {unknown} next Requested full settings.
 */
async function persistSettings(next) {
  const active = store.value;
  if (!ready.value || !liveVerified.value || saving.value || active === null) return;
  if (!isSettingsObject(next) || settingsEqual(next, currentSettings())) return;
  const requested = next;
  const current = generation;
  const previous = currentSettings();
  saving.value = true;
  try {
    await active.save(requested);
    if (current !== generation) return;
    if (!applyLive(requested.scheme)) {
      // Preserve the primary failure even if persistence rollback also fails.
      // An unsuccessful live rollback leaves no verified radio selection.
      refusal.value = settingsRefusalFor({ code: 'ERR_SETTINGS_APPLY_FAILED' });
      liveVerified.value = applyLive(previous.scheme);
      try {
        await active.save(previous);
      } catch {
        // The apply refusal remains authoritative; never replace it with a save error.
      }
      return;
    }
    scheme.value = requested.scheme;
    density.value = requested.density;
    wallFps.value = requested.wallFps;
    recordingFps.value = requested.recordingFps;
    densityModel.value = requested.density;
    refusal.value = null;
    if (requested.scheme !== previous.scheme) emit('scheme-change', requested.scheme);
  } catch (error) {
    if (current === generation) refusal.value = settingsRefusalFor(error);
  } finally {
    if (current === generation) saving.value = false;
  }
}

/**
 * Schedule persistence for a settings patch. The patch merges onto the queued
 * trailing value when one exists, so a burst across fields keeps every last
 * value (fps then scheme saves both). The last requested value of every field
 * always wins: a revert to the applied settings while a different trailing
 * value is queued overwrites the queue instead of dropping. Only a request
 * equal to both the persisted and the pending value is a no-op. Changes while
 * a save runs, before the live theme verifies, or past a host replacement
 * are dropped.
 * @param {{ scheme?: string, density?: string, wallFps?: number, recordingFps?: number }} patch
 */
function selectSettings(patch) {
  const active = store.value;
  if (!ready.value || !liveVerified.value || saving.value || active === null) return;
  const pending = persistRunner.pendingValue();
  const base = isSettingsObject(pending) ? pending : currentSettings();
  const next = { ...base, ...patch };
  if (settingsEqual(next, currentSettings()) && (pending === null || settingsEqual(pending, next))) return;
  persistRunner(next);
}

/**
 * @param {string} next Requested scheme.
 */
function selectScheme(next) {
  selectSettings({ scheme: next });
}

/**
 * @param {string} next Requested density.
 */
function selectDensity(next) {
  selectSettings({ density: next });
}

/**
 * @param {number} next Requested live wall fps.
 */
function selectWallFps(next) {
  selectSettings({ wallFps: next });
}

/**
 * Strictly parse the recording fps field (non-empty trimmed integer strings
 * only, then Number), clamp into 1..60 and schedule persistence. Empty and
 * whitespace-only input reverts silently to the current value without saving;
 * anything else non-integer does the same. No visible error in any state.
 * @param {unknown} event Input change event.
 */
function onRecordingFpsChange(event) {
  const target = /** @type {{ value?: unknown }|null} */ (
    typeof event === 'object' && event !== null
      ? /** @type {{ target?: unknown }} */ (event).target
      : null
  );
  const raw = target?.value;
  const text = typeof raw === 'string' ? raw.trim() : null;
  const parsed = text !== null
    ? (/^-?\d+$/.test(text) ? Number(text) : Number.NaN)
    : (typeof raw === 'number' ? raw : Number.NaN);
  if (!Number.isInteger(parsed)) {
    if (target !== null && 'value' in target) target.value = String(recordingFps.value);
    return;
  }
  const clamped = Math.min(MV_RECORDING_FPS_MAX, Math.max(MV_RECORDING_FPS_MIN, parsed));
  if (target !== null && 'value' in target) target.value = String(clamped);
  selectSettings({ recordingFps: clamped });
}

onBeforeUnmount(() => {
  generation += 1;
  stopCapturePreferences?.();
  persistRunner.cancel();
  clearFpsDecayTimer();
  if (stopFrames !== null) {
    try { stopFrames(); } catch { /* Teardown never throws. */ }
    stopFrames = null;
  }
});
</script>

<template>
  <section
    :id="MV_SETTINGS_IDS.panel"
    class="mv4-set"
    role="region"
    aria-label="Settings"
    :data-semantic-anchor="MV_SETTINGS_ANCHORS.panel"
  >
    <header class="mv4-set-heading"><h2 class="mv4-set-title">Settings</h2><p>Make this workspace your own.</p></header>
    <div class="mv4-settings-grid">
    <section class="mv4-card"><h3>Live sessions</h3>
    <label v-if="hiddenSessionSettings" class="mv4-density">Hidden live sessions
      <input id="settings-hidden-live-sessions" data-semantic-anchor="settings/hidden-live-sessions" aria-label="Hidden live sessions" type="number" min="0" step="1" :value="hiddenSessionLimit" @change="changeHiddenSessionLimit" />
      <span>Older hidden views disconnect beyond this limit. Shown tiles stay connected.</span>
    </label>
    <p v-if="hiddenSessionError" role="alert">{{ hiddenSessionError }}</p>
    </section>
    <section class="mv4-card"><h3>Appearance</h3><p>Color scheme</p>
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
      {{ densityReadout }}
    </p>
    <div
      :id="MV_SETTINGS_IDS.densityGroup"
      class="mv4-group"
      role="radiogroup"
      aria-label="Density"
      :data-semantic-anchor="MV_SETTINGS_ANCHORS.densityGroup"
    >
      <label v-for="option in densityOptions" :key="option.id" class="mv4-option">
        <input
          :id="option.domId"
          type="radio"
          name="mv-density"
          :value="option.id"
          :checked="liveVerified && density === option.id"
          :disabled="!ready || !liveVerified || saving || store === null"
          :data-semantic-anchor="option.anchor"
          :aria-label="option.name"
          @change="selectDensity(option.id)"
        />
        <span class="mv4-option-label">{{ option.label }}</span>
      </label>
    </div>
    </section>
    <section class="mv4-card"><h3>Live view</h3><p>Frames per second</p>
    <div
      :id="MV_SETTINGS_IDS.wallFpsGroup"
      class="mv4-group"
      role="radiogroup"
      aria-label="Live wall fps"
      :data-semantic-anchor="MV_SETTINGS_ANCHORS.wallFpsGroup"
    >
      <label v-for="option in wallFpsOptions" :key="option.value" class="mv4-option">
        <input
          :id="option.domId"
          type="radio"
          name="mv-wall-fps"
          :value="option.value"
          :checked="liveVerified && wallFps === option.value"
          :disabled="!ready || !liveVerified || saving || store === null"
          :data-semantic-anchor="option.anchor"
          :aria-label="option.name"
          @change="selectWallFps(option.value)"
        />
        <span class="mv4-option-label">{{ option.label }}</span>
      </label>
    </div>
    <p
      :id="MV_SETTINGS_IDS.actualRow"
      class="mv4-actual"
      role="status"
      aria-label="Actual wall fps"
      :data-semantic-anchor="MV_SETTINGS_ANCHORS.actualRow"
    >
      {{ wallFpsLine }}
    </p>
    </section>
    <section class="mv4-card"><h3>Recording</h3>
    <div
      :id="MV_SETTINGS_IDS.recordingFpsGroup"
      class="mv4-group"
      role="group"
      aria-label="Recording fps"
      :data-semantic-anchor="MV_SETTINGS_ANCHORS.recordingFpsGroup"
    >
      <label class="mv4-option" :for="MV_SETTINGS_IDS.recordingFpsInput">
        <span class="mv4-option-label">Frames per second</span>
        <input
          :id="MV_SETTINGS_IDS.recordingFpsInput"
          type="number"
          :min="MV_RECORDING_FPS_MIN"
          :max="MV_RECORDING_FPS_MAX"
          step="1"
          :value="recordingFps"
          :disabled="!ready || !liveVerified || saving || store === null"
          :data-semantic-anchor="MV_SETTINGS_ANCHORS.recordingFpsInput"
          aria-label="Recording fps"
          @change="onRecordingFpsChange"
        />
      </label>
    </div>
    <div v-if="captureOptions" class="mv4-capture-options">
      <p>RAM: {{ freeSpaceText(captureOptions.ramFreeBytes) }}</p>
      <p v-if="captureOptions.warning" role="alert">{{ captureOptions.warning }}</p>
      <div class="mv4-capture-folder"><span><strong>Recordings</strong> · {{ captureOptions.recordings.label }}<small>{{ freeSpaceText(captureOptions.recordings.freeBytes) }}</small></span><button type="button" :disabled="captureOptionsBusy" id="settings/recordings-folder" data-semantic-anchor="settings/recordings-folder" aria-label="Choose recordings folder" @click="changeCapturePreference('folder','recordings')">Choose folder</button></div>
      <div class="mv4-capture-folder"><span><strong>Screenshots</strong> · {{ captureOptions.screenshots.label }}<small>{{ freeSpaceText(captureOptions.screenshots.freeBytes) }}</small></span><button type="button" :disabled="captureOptionsBusy" id="settings/screenshots-folder" data-semantic-anchor="settings/screenshots-folder" aria-label="Choose screenshots folder" @click="changeCapturePreference('folder','screenshots')">Choose folder</button></div>
      <label class="mv4-option"><input type="radio" id="settings/capture-mode-ram" data-semantic-anchor="settings/capture-mode-ram" aria-label="Keep in RAM until I export" name="capture-mode" :checked="captureOptions.mode==='ram'" :disabled="captureOptionsBusy" @change="changeCapturePreference('mode','ram')" />Keep in RAM until I export</label>
      <label class="mv4-option"><input type="radio" id="settings/capture-mode-disk" data-semantic-anchor="settings/capture-mode-disk" aria-label="Save to disk when recording stops" name="capture-mode" :checked="captureOptions.mode==='disk-on-stop'" :disabled="captureOptionsBusy" @change="changeCapturePreference('mode','disk-on-stop')" />Save to disk when recording stops</label>
      <p>Recording folder changes apply at the next app start. A host environment setting takes priority. Screenshot export folder changes apply now. In disk mode, screenshots export when captured.</p>
      <p v-if="captureOptions.mode==='disk-on-stop'&&!captureOptions.active" role="status">Automatic saving is waiting for an active recording folder. Captures stay in RAM.</p>
      <p v-if="captureOptions.lastSave" role="status">{{ captureOptions.lastSave.ok?'Capture saved.':'Export to the selected folder failed. The RAM capture is still available.' }}</p>
    </div>
    <p v-else>Recording folders are unavailable on this host.</p>
    <p v-if="captureOptionsError" role="alert">{{ captureOptionsError }}</p>
    </section>
    </div>
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

<style scoped>
.mv4-capture-options { display:grid; gap:12px; }
.mv4-capture-options p { margin:0; color:var(--cuk-semantic-text-muted); }
.mv4-capture-folder { display:flex; justify-content:space-between; align-items:center; gap:16px; }
.mv4-capture-folder small { display:block; margin-top:4px; color:var(--cuk-semantic-text-muted); }
.mv4-capture-folder button { padding:6px 10px; border:1px solid var(--cuk-semantic-border-subtle); border-radius:6px; color:var(--cuk-semantic-text-primary); background:var(--cuk-semantic-surface-panel); }
</style>

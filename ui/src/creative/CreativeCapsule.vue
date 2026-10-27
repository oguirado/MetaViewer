<script>
/**
 * @file CreativeCapsule pure module: closed storyboard validation, image-source
 * CSP gate, status derivation, frozen intent builders.
 * Dependency-free plain script: setup code shares this scope, and node:test loads
 * this exact block, so it must stay free of framework calls and external loads.
 */

/** @typedef {{ code: string, message: string }} CreativeError */
/** @typedef {{ ok: true, id: string } | { ok: false, error: CreativeError }} CapsuleIdResult */
/** @typedef {{ ok: true, src: string, kind: 'data' | 'self' } | { ok: false, error: CreativeError }} ImageSourceResult */
/** @typedef {{ frame_id: string, prompt: string, data_url: string, sha256: string, width: number, height: number }} StoryboardFrame */
/** @typedef {{ ok: true, frame: StoryboardFrame } | { ok: false, error: CreativeError }} StoryboardFrameResult */
/** @typedef {{ ok: true, frames: readonly StoryboardFrame[] } | { ok: false, error: CreativeError }} StoryboardResult */
/** @typedef {{ id: CapsuleIdResult, board: StoryboardResult }} CreativeSnapshot */

/** Renderer storyboard presentation limit; no host contract is implied. */
export const MAX_STORYBOARD_FRAMES = 8;
/** Renderer prompt length ceiling. */
export const MAX_PROMPT_LENGTH = 2000;
/** Decoded PNG ceiling per frame (2 MiB). */
export const MAX_IMAGE_BYTES = 2097152;
/** Data-URL character ceiling: 2 MiB base64 payload plus the data: prefix. */
export const MAX_DATA_URL_LENGTH = 2800000;
/** Max rendered image dimension in either axis. */
export const MAX_IMAGE_DIMENSION = 8192;
/** Relative self asset path ceiling. */
export const MAX_SELF_PATH_LENGTH = 512;

/** Closed renderer storyboard frame key set. */
export const STORYBOARD_FRAME_KEYS = Object.freeze(
  ['frame_id', 'prompt', 'data_url', 'sha256', 'width', 'height']);
/** Closed capsule-id refusal codes, mirroring the kit validator. */
export const CAPSULE_ID_ERROR_CODES = Object.freeze(['ERR_INVENTED_CAPSULE_ID',
  'ERR_INVALID_IDENTITY', 'ERR_NUMERIC_INDEX_ID', 'ERR_DISPLAY_CREDENTIAL_ID']);
/** Closed image-source refusal codes. */
export const IMAGE_SOURCE_ERROR_CODES = Object.freeze(['ERR_REMOTE_IMAGE_SOURCE',
  'ERR_UNSUPPORTED_IMAGE_TYPE', 'ERR_IMAGE_SOURCE_TOO_LARGE',
  'ERR_MALFORMED_IMAGE_SOURCE']);
/** Closed storyboard refusal codes. */
export const STORYBOARD_ERROR_CODES = Object.freeze(['ERR_STORYBOARD_EMPTY',
  'ERR_STORYBOARD_TOO_LARGE', 'ERR_MALFORMED_STORYBOARD_FRAME']);
/** Closed storyboard intent types; the capsule emits nothing else. */
export const STORYBOARD_INTENT_TYPES = Object.freeze(['creative/select-frame',
  'creative/regenerate', 'creative/close']);
/** Closed intent builder refusal codes. */
export const STORYBOARD_INTENT_ERROR_CODES = Object.freeze(['ERR_UNKNOWN_INTENT_TYPE',
  'ERR_MALFORMED_INTENT_DETAIL']);

const DATA_PNG_PREFIX = 'data:image/png;base64,';
/** PNG magic bytes 89 50 4E 47 0D 0A 1A 0A as base64: checked without decoding. */
const PNG_MAGIC_B64 = 'iVBORw0KGgo';
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
const SELF_PATH_PATTERN = /^[A-Za-z0-9._~/-]+$/;
const SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const FRAME_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const FRAME_KEYS_SORTED = [...STORYBOARD_FRAME_KEYS].sort().join('\0');

/**
 * @param {string} code
 * @param {string} message
 * @returns {{ ok: false, error: CreativeError }}
 */
function refused(code, message) {
  return { ok: false, error: { code, message } };
}

/**
 * @param {string} code
 * @param {string} message
 * @returns {Error & { code: string }}
 */
function creativeError(code, message) {
  const err = /** @type {Error & { code: string }} */ (new Error(`${code}: ${message}`));
  err.code = code;
  return err;
}

/**
 * Validates a host-issued immutable capsule id: non-empty, no whitespace,
 * never a bare numeric index, never a display-number credential.
 * @param {unknown} value
 * @returns {CapsuleIdResult}
 */
export function validateCapsuleId(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return refused('ERR_INVENTED_CAPSULE_ID',
      'capsuleId must be provided by the host; the kit never invents one');
  }
  if (value !== value.trim() || /\s/.test(value)) {
    return refused('ERR_INVALID_IDENTITY',
      `capsuleId must not contain whitespace: "${value}"`);
  }
  if (/^\d+$/.test(value)) {
    return refused('ERR_NUMERIC_INDEX_ID',
      `capsuleId must not be a bare numeric index: "${value}"`);
  }
  if (value.startsWith(':') || /^display=/i.test(value)) {
    return refused('ERR_DISPLAY_CREDENTIAL_ID',
      `capsuleId must not be a display-number credential: "${value}"`);
  }
  try { encodeURIComponent(value); } catch {
    return refused('ERR_INVALID_IDENTITY', 'capsuleId must be well-formed Unicode');
  }
  return { ok: true, id: value };
}

/**
 * Admits only renderer-safe image sources: PNG data: URLs within the byte cap,
 * or relative self asset paths. Anything remote refuses without a request.
 * @param {unknown} value
 * @returns {ImageSourceResult}
 */
export function validateImageSource(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return refused('ERR_MALFORMED_IMAGE_SOURCE',
      'image source must be a non-empty string');
  }
  if (value.startsWith('data:')) {
    if (!value.startsWith(DATA_PNG_PREFIX)) {
      return refused('ERR_UNSUPPORTED_IMAGE_TYPE',
        'data: image source must be image/png base64');
    }
    const payload = value.slice(DATA_PNG_PREFIX.length);
    if (value.length > MAX_DATA_URL_LENGTH) {
      return refused('ERR_IMAGE_SOURCE_TOO_LARGE',
        `data: image exceeds ${MAX_DATA_URL_LENGTH} characters`);
    }
    if (payload.length === 0 || payload.length % 4 !== 0
        || !BASE64_PATTERN.test(payload)) {
      return refused('ERR_MALFORMED_IMAGE_SOURCE',
        'data: image payload is not valid base64');
    }
    const padding = payload.endsWith('==') ? 2 : (payload.endsWith('=') ? 1 : 0);
    const decodedBytes = (payload.length / 4) * 3 - padding;
    if (decodedBytes > MAX_IMAGE_BYTES) {
      return refused('ERR_IMAGE_SOURCE_TOO_LARGE',
        `decoded image exceeds ${MAX_IMAGE_BYTES} bytes`);
    }
    if (!payload.startsWith(PNG_MAGIC_B64)) {
      return refused('ERR_MALFORMED_IMAGE_SOURCE',
        'data: image is not a PNG (magic mismatch)');
    }
    return { ok: true, src: value, kind: 'data' };
  }
  if (SCHEME_PATTERN.test(value) || value.startsWith('//')) {
    return refused('ERR_REMOTE_IMAGE_SOURCE',
      `remote image source refused: "${value.slice(0, 64)}"`);
  }
  if (value.length > MAX_SELF_PATH_LENGTH || !SELF_PATH_PATTERN.test(value)
      || value.startsWith('/') || value.includes('..') || value.includes('//')
      || !value.endsWith('.png')) {
    return refused('ERR_MALFORMED_IMAGE_SOURCE',
      'self image source must be a relative path ending in .png');
  }
  return { ok: true, src: value, kind: 'self' };
}

/**
 * Validates one closed storyboard frame; the whole frame refuses atomically.
 * @param {unknown} frame
 * @returns {StoryboardFrameResult}
 */
export function validateStoryboardFrame(frame) {
  if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) {
    return refused('ERR_MALFORMED_STORYBOARD_FRAME',
      'storyboard frame must be an object');
  }
  const keys = Object.keys(frame);
  if (keys.length !== STORYBOARD_FRAME_KEYS.length
      || [...keys].sort().join('\0') !== FRAME_KEYS_SORTED) {
    return refused('ERR_MALFORMED_STORYBOARD_FRAME',
      'storyboard frame carries unexpected or missing keys');
  }
  const item = /** @type {Record<string, unknown>} */ (frame);
  if (typeof item.frame_id !== 'string' || !FRAME_ID_PATTERN.test(item.frame_id)) {
    return refused('ERR_MALFORMED_STORYBOARD_FRAME',
      'frame.frame_id must match [A-Za-z0-9_-]{1,128}');
  }
  if (typeof item.prompt !== 'string' || item.prompt.length === 0
      || item.prompt.length > MAX_PROMPT_LENGTH) {
    return refused('ERR_MALFORMED_STORYBOARD_FRAME',
      `frame.prompt must be 1..${MAX_PROMPT_LENGTH} characters`);
  }
  const source = validateImageSource(item.data_url);
  if (!source.ok) {
    return {
      ok: false,
      error: { code: source.error.code, message: `frame.data_url refused: ${source.error.message}` },
    };
  }
  if (typeof item.sha256 !== 'string' || !SHA256_PATTERN.test(item.sha256)) {
    return refused('ERR_MALFORMED_STORYBOARD_FRAME',
      'frame.sha256 must be 64 lowercase hex characters');
  }
  if (!Number.isInteger(item.width) || /** @type {number} */ (item.width) < 1
      || /** @type {number} */ (item.width) > MAX_IMAGE_DIMENSION
      || !Number.isInteger(item.height) || /** @type {number} */ (item.height) < 1
      || /** @type {number} */ (item.height) > MAX_IMAGE_DIMENSION) {
    return refused('ERR_MALFORMED_STORYBOARD_FRAME',
      `frame dimensions must be integers 1..${MAX_IMAGE_DIMENSION}`);
  }
  const clean = {
    frame_id: /** @type {string} */ (item.frame_id),
    prompt: /** @type {string} */ (item.prompt),
    data_url: /** @type {string} */ (item.data_url),
    sha256: /** @type {string} */ (item.sha256),
    width: /** @type {number} */ (item.width),
    height: /** @type {number} */ (item.height),
  };
  return { ok: true, frame: /** @type {StoryboardFrame} */ (Object.freeze(clean)) };
}

/**
 * Validates a storyboard frame list atomically: one bad frame refuses all.
 * @param {unknown} value
 * @returns {StoryboardResult}
 */
export function validateStoryboard(value) {
  if (!Array.isArray(value) || value.length === 0) {
    return refused('ERR_STORYBOARD_EMPTY', 'storyboard carries no frames');
  }
  if (value.length > MAX_STORYBOARD_FRAMES) {
    return refused('ERR_STORYBOARD_TOO_LARGE',
      `storyboard exceeds ${MAX_STORYBOARD_FRAMES} frames`);
  }
  const clean = /** @type {StoryboardFrame[]} */ ([]);
  for (let index = 0; index < value.length; index += 1) {
    const checked = validateStoryboardFrame(value[index]);
    if (!checked.ok) {
      return {
        ok: false,
        error: { code: checked.error.code, message: `frame[${index}]: ${checked.error.message}` },
      };
    }
    if (clean.some(item => item.frame_id === checked.frame.frame_id)) {
      return refused('ERR_MALFORMED_STORYBOARD_FRAME', 'duplicate storyboard frame identity');
    }
    clean.push(checked.frame);
  }
  return { ok: true, frames: Object.freeze(clean) };
}

/**
 * Derives the panel status line: Live for admitted frames, an honest waiting
 * state when empty, and a coded refusal otherwise. Never a bare boolean.
 * @param {CreativeSnapshot} snapshot
 * @returns {string}
 */
export function deriveCreativeStatus(snapshot) {
  if (!snapshot.id.ok) {
    return `Refused: ${snapshot.id.error.code}`;
  }
  if (!snapshot.board.ok) {
    if (snapshot.board.error.code === 'ERR_STORYBOARD_EMPTY') {
      return 'Waiting for storyboard';
    }
    return `Refused: ${snapshot.board.error.code}`;
  }
  return snapshot.board.frames.length > 0 ? 'Live' : 'Waiting for storyboard';
}

/**
 * Builds a frozen storyboard intent payload; invalid input throws a coded error.
 * @param {unknown} type
 * @param {unknown} capsuleId
 * @param {unknown} [detail]
 * @returns {Readonly<{ type: string, capsuleId: string, frameId?: string }>}
 */
export function buildStoryboardIntent(type, capsuleId, detail) {
  if (typeof type !== 'string' || !STORYBOARD_INTENT_TYPES.includes(type)) {
    throw creativeError('ERR_UNKNOWN_INTENT_TYPE',
      `unknown storyboard intent: "${String(type).slice(0, 64)}"`);
  }
  const id = validateCapsuleId(capsuleId);
  if (!id.ok) {
    throw creativeError(id.error.code, id.error.message);
  }
  if (type === 'creative/select-frame') {
    const record = (typeof detail === 'object' && detail !== null && !Array.isArray(detail))
      ? /** @type {Record<string, unknown>} */ (detail)
      : null;
    const frameId = record?.frameId;
    if (typeof frameId !== 'string' || !FRAME_ID_PATTERN.test(frameId)) {
      throw creativeError('ERR_MALFORMED_INTENT_DETAIL',
        'select-frame intent requires a valid frameId');
    }
    return Object.freeze({ type, capsuleId: id.id, frameId });
  }
  if (detail !== undefined) {
    throw creativeError('ERR_MALFORMED_INTENT_DETAIL',
      `${type} intent takes no detail`);
  }
  return Object.freeze({ type, capsuleId: id.id });
}
</script>
<script setup>
import { computed } from 'vue';
import { UiButton } from 'capsule-ui-kit/ui';
import UiPage from '../../.kit/capsule-ui-kit/src/ui/UiPage.vue';
import UiToolbar from '../../.kit/capsule-ui-kit/src/ui/UiToolbar.vue';

const props = defineProps({
  capsuleId: { type: String, required: true },
  frames: { type: Array, default: () => [] },
  title: { type: String, default: 'Storyboard' },
  presentationInstance: { type: String, default: '' },
  folded: { type: Boolean, default: false },
});
const emit = defineEmits(['submit-intent']);

const idResult = computed(() => validateCapsuleId(props.capsuleId));
const board = computed(() => validateStoryboard(props.frames));
const admittedFrames = computed(() => {
  const id = idResult.value;
  const checked = board.value;
  if (!id.ok || !checked.ok) {
    return null;
  }
  return checked.frames;
});
const isAdmitted = computed(() => admittedFrames.value !== null);
// Capsule identity is encoded into each DOM identity; no shared per-frame ids.
const anchorRoot = computed(() => idResult.value.ok
  ? `capsule/${encodeURIComponent(idResult.value.id)}/creative` : '');

/**
 * @param {'creative/select-frame' | 'creative/regenerate' | 'creative/close'} type
 * @param {unknown} [detail]
 */
function dispatchIntent(type, detail) {
  const id = idResult.value;
  if (!id.ok) {
    return;
  }
  emit('submit-intent', buildStoryboardIntent(type, id.id, detail));
}

/** @param {string} frameId */
function onSelectFrame(frameId) {
  dispatchIntent('creative/select-frame', { frameId });
}

function onRegenerate() {
  dispatchIntent('creative/regenerate');
}

function onClosePanel() {
  dispatchIntent('creative/close');
}
</script>
<template>
  <UiPage class="mv-creative" :title="props.title" aria-label="Creative storyboard">
    <UiToolbar v-if="idResult.ok" label="Storyboard actions">
      <template #end>
        <UiButton :id="`${anchorRoot}/close`" :data-semantic-anchor="`${anchorRoot}/close`"
          label="Close storyboard" @click="onClosePanel" />
      </template>
    </UiToolbar>
    <div v-if="isAdmitted" class="mv-creative__board">
      <ol v-if="!props.folded" class="mv-creative__frames">
        <li v-for="frame in admittedFrames ?? []" :key="frame.frame_id" class="mv-creative__frame">
          <figure class="mv-creative__figure">
            <img class="mv-creative__image" :src="frame.data_url"
              :alt="frame.prompt" :width="frame.width" :height="frame.height" />
            <figcaption class="mv-creative__caption">{{ frame.prompt }}</figcaption>
          </figure>
          <UiButton :id="`${anchorRoot}/frame/${frame.frame_id}/select`"
            :data-semantic-anchor="`${anchorRoot}/frame/${frame.frame_id}/select`"
            :aria-label="`Select storyboard frame ${frame.frame_id}`" label="Select frame"
            @click="onSelectFrame(frame.frame_id)" />
        </li>
      </ol>
    </div>
    <UiButton v-if="idResult.ok && !props.folded" :id="`${anchorRoot}/regenerate`"
      :data-semantic-anchor="`${anchorRoot}/regenerate`" label="Request new frame" @click="onRegenerate" />
  </UiPage>
</template>
<style scoped>
.mv-creative {
  display: flex;
  flex-direction: column;
  gap: var(--cuk-semantic-spacing-md);
  padding: var(--cuk-semantic-spacing-md);
  background: var(--cuk-semantic-surface-canvas);
  color: var(--cuk-semantic-text-primary);
}
.mv-creative__frames {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 18rem), 1fr));
  gap: var(--cuk-semantic-spacing-md);
}
.mv-creative__frame, .mv-creative__figure {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--cuk-semantic-spacing-sm);
}
.mv-creative__image { max-width: 100%; height: auto; object-fit: contain; }
.mv-creative__caption { color: var(--cuk-semantic-text-primary); overflow-wrap: anywhere; }
</style>

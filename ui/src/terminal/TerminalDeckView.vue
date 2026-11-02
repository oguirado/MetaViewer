<script setup>
/**
 * OpenFresnel-style full-wall Terminal Deck view for MetaViewer (P18h).
 *
 * Acts as a third workspace beside Humans and Agents. Renders the screen bar
 * ("Screen 1, 2, …" with "+" and empty-only "✕"), "🚀 Bootstrap" and
 * "＋ New terminal" actions, the profile/Custom CLI launcher popover, an
 * equal-tile terminal grid with focus rings and SIGINT-then-close lifecycle,
 * and busy-close confirmation.
 */
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { createTerminalDocument } from '../../.kit/capsule-ui-kit/src/terminal/nonceDocument.js';
import {
  createTerminalDeckController,
  matchDeckShortcut,
} from './terminalDeckModel.js';
import './terminal.css';

const props = defineProps({
  open: { type: Boolean, default: true },
  terminalBroker: { type: /** @type {import('vue').PropType<any>} */ (Object), default: null },
  terminalBinding: { type: /** @type {import('vue').PropType<any>} */ (Object), default: null },
  terminalSessionPort: { type: /** @type {import('vue').PropType<any>} */ (Object), default: null },
  hostProviders: { type: /** @type {import('vue').PropType<unknown[]>} */ (Array), default: () => [] },
  brokerCommands: { type: /** @type {import('vue').PropType<string[]>} */ (Array), default: () => [] },
  clipboard: { type: /** @type {import('vue').PropType<any>} */ (Object), default: null },
  storage: { type: /** @type {import('vue').PropType<Pick<Storage, 'getItem' | 'setItem'> | null>} */ (Object), default: null },
  closeGraceMs: { type: Number, default: undefined },
});

const emit = defineEmits(['update:open']);

class MvDeckTerminal extends Terminal {
  /** @param {any} options */
  constructor(options) {
    super({ ...options, documentOverride: createTerminalDocument(globalThis.document) });
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const revision = ref(0);
const customCommand = ref('');

/** @type {Map<string, HTMLElement>} */
const viewportElements = new Map();
/** @type {Map<string, { sessionId: string, term: Terminal | null, fit: FitAddon | null, disposeData: (() => void) | null }>} */
const mountedTerminals = new Map();
/** @type {Map<string, string[]>} */
const pendingSessionOutput = new Map();

const controller = createTerminalDeckController({
  broker: props.terminalBroker,
  sessionPort: props.terminalSessionPort,
  hostProviders: props.hostProviders,
  brokerCommands: props.brokerCommands,
  clipboard: props.clipboard,
  storage: props.storage ?? (typeof globalThis.localStorage !== 'undefined' ? globalThis.localStorage : null),
  closeGraceMs: props.closeGraceMs,
  onChange() {
    revision.value += 1;
    void nextTick(() => syncTerminals());
  },
  onSessionData(frame) {
    if (!frame || typeof frame.session !== 'string' || !Array.isArray(frame.bytes)) return;
    const text = decoder.decode(Uint8Array.from(frame.bytes));
    let delivered = false;
    for (const entry of mountedTerminals.values()) {
      if (entry.sessionId === frame.session && entry.term) {
        try {
          entry.term.write(text);
          delivered = true;
        } catch {
          // Best-effort xterm write.
        }
      }
    }
    if (!delivered) {
      const queue = pendingSessionOutput.get(frame.session) ?? [];
      queue.push(text);
      pendingSessionOutput.set(frame.session, queue);
    }
  },
});

const deckState = computed(() => {
  void revision.value;
  const st = controller.state;
  const clonedScreens = st.screens.map((s) => ({
    ...s,
    slots: s.slots.map((slot) => ({ ...slot })),
  }));
  return {
    ...st,
    screens: clonedScreens,
    activeScreen: clonedScreens[st.activeScreenIndex] ?? clonedScreens[0] ?? null,
  };
});

const screens = computed(() => deckState.value.screens);
const activeScreenIndex = computed(() => deckState.value.activeScreenIndex);
const activeScreen = computed(() => deckState.value.activeScreen);
const focusedSlotId = computed(() => deckState.value.focusedSlotId);
const pendingCloseSlotId = computed(() => deckState.value.pendingCloseSlotId);
const launcherOpen = computed(() => deckState.value.launcherOpen);
const toastMessage = computed(() => deckState.value.toastMessage);
const errorCode = computed(() => deckState.value.errorCode);
const errorMessage = computed(() => deckState.value.errorMessage);
const gridColumns = computed(() => String(deckState.value.gridColumns));
const profiles = computed(() => deckState.value.profiles);
const launcherWrap = ref(/** @type {any} */ (null));
const overlayCoordinator = /** @type {{ set?: (owner: string, active: boolean) => void } | null} */ (inject('overlayCoordinator', null));
const launcherOverlayOwner = 'terminal-deck-overlay';
const overlayOpen = computed(() => Boolean(props.open && (launcherOpen.value || pendingCloseSlotId.value)));

/**
 * @param {boolean} [open]
 */
function syncOverlayAttr(open = overlayOpen.value) {
  if (overlayCoordinator && typeof overlayCoordinator.set === 'function') {
    overlayCoordinator.set(launcherOverlayOwner, open);
    return;
  }
  const body = /** @type {any} */ (globalThis.document)?.body;
  if (!body) return;
  if (open) {
    if (typeof body.setAttribute === 'function') body.setAttribute('data-mv-modal', 'open');
    if (body.dataset) body.dataset.mvModal = 'open';
  } else {
    if (typeof body.removeAttribute === 'function') body.removeAttribute('data-mv-modal');
    if (body.dataset) delete body.dataset.mvModal;
  }
}

watch(overlayOpen, (open) => { syncOverlayAttr(open); }, { immediate: true, flush: 'sync' });

/**
 * @param {string} slotId
 * @param {unknown} el
 */
function setViewportRef(slotId, el) {
  const isElement = typeof HTMLElement !== 'undefined'
    ? el instanceof HTMLElement
    : Boolean(el && typeof el === 'object');
  if (isElement) {
    viewportElements.set(slotId, /** @type {HTMLElement} */ (el));
  } else {
    viewportElements.delete(slotId);
  }
}

/**
 * @param {string} slotId
 */
function destroySlotTerminal(slotId) {
  const existing = mountedTerminals.get(slotId);
  if (!existing) return;
  mountedTerminals.delete(slotId);
  try {
    existing.disposeData?.();
  } catch {
    // Best-effort cleanup.
  }
  try {
    existing.term?.dispose();
  } catch {
    // Best-effort cleanup.
  }
}

function syncTerminals() {
  const currentSlots = activeScreen.value?.slots ?? [];
  const activeIds = new Set(currentSlots.map((slot) => slot.id));
  for (const mountedId of [...mountedTerminals.keys()]) {
    if (!activeIds.has(mountedId)) {
      destroySlotTerminal(mountedId);
    }
  }
  for (const slot of currentSlots) {
    if (!slot.sessionId) {
      destroySlotTerminal(slot.id);
      continue;
    }
    const container = viewportElements.get(slot.id);
    if (!container) continue;
    const current = mountedTerminals.get(slot.id);
    if (current && current.sessionId === slot.sessionId) {
      try {
        current.fit?.fit();
      } catch {
        // Fit is best-effort in headless DOMs.
      }
      continue;
    }
    destroySlotTerminal(slot.id);
    try {
      const term = new MvDeckTerminal({
        cursorBlink: true,
        convertEol: true,
        cols: 80,
        rows: 24,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.attachCustomKeyEventHandler((event) => {
        if (matchDeckShortcut(event) !== null) {
          return false;
        }
        return true;
      });
      const sessionId = slot.sessionId;
      const disposable = term.onData((data) => {
        const currentSlot = (activeScreen.value?.slots ?? []).find((item) => item.id === slot.id);
        if (!currentSlot || currentSlot.status !== 'running' || !currentSlot.sessionId) return;
        controller.writeSessionBytes(currentSlot.sessionId, Array.from(encoder.encode(data)));
      });
      term.open(container);
      try {
        fit.fit();
        if (term.cols > 0 && term.rows > 0) {
          controller.resizeSession(sessionId, term.cols, term.rows);
        }
      } catch {
        // Headless DOM fallback keeps 80x24.
      }
      const buffered = pendingSessionOutput.get(sessionId);
      if (buffered && buffered.length > 0) {
        pendingSessionOutput.delete(sessionId);
        for (const chunk of buffered) {
          term.write(chunk);
        }
      }
      mountedTerminals.set(slot.id, {
        sessionId,
        term,
        fit,
        disposeData: () => disposable.dispose(),
      });
      if (focusedSlotId.value === slot.id) {
        try {
          term.focus();
        } catch {
          // Best-effort focus in headless DOMs.
        }
      }
    } catch {
      mountedTerminals.set(slot.id, {
        sessionId: slot.sessionId,
        term: null,
        fit: null,
        disposeData: null,
      });
    }
  }
}

/**
 * @param {KeyboardEvent} event
 */
function onWindowKeyDown(event) {
  if (!props.open) return;
  controller.handleKeyDown(event);
}

/**
 * @param {unknown} target
 * @returns {boolean}
 */
function isInsideLauncherWrap(target) {
  if (!target || typeof target !== 'object') return false;
  const wrap = launcherWrap.value;
  if (wrap && typeof wrap.contains === 'function') {
    try {
      if (wrap.contains(target)) return true;
    } catch {
      // Custom renderer nodes may not be native DOM nodes.
    }
  }
  const el = /** @type {any} */ (target);
  if (typeof el.closest === 'function') {
    try {
      if (el.closest('.mv-terminal-deck__launcher-wrap')) return true;
    } catch {
      // Fallback to ancestor walk.
    }
  }
  let cur = el;
  while (cur) {
    if (wrap && cur === wrap) return true;
    const id = cur.id ?? cur.props?.id;
    if (id === 'terminal-deck-new' || id === 'terminal-deck-launcher') return true;
    const cls = String(cur.className ?? cur.props?.class ?? '');
    if (cls.includes('mv-terminal-deck__launcher-wrap') || cls.includes('mv-terminal-deck__popover')) return true;
    cur = cur.parentNode ?? cur.parent ?? null;
  }
  return false;
}

/**
 * @param {Event} event
 */
function onDocumentPointerDown(event) {
  if (!props.open || !launcherOpen.value) return;
  if (isInsideLauncherWrap(event?.target ?? null)) return;
  controller.setLauncherOpen(false);
}

function toggleLauncher() {
  controller.setLauncherOpen(!launcherOpen.value);
}

/**
 * @param {string} profileId
 */
async function onLaunchProfile(profileId) {
  try {
    await controller.launchProfile(profileId);
  } catch {
    // Error message is projected in deckState.errorMessage.
  }
}

/**
 * @param {Event} event
 */
function onCustomInput(event) {
  const target = /** @type {HTMLInputElement | null} */ (event?.target ?? null);
  customCommand.value = typeof target?.value === 'string' ? target.value : '';
  controller.setCustomCommandInput(customCommand.value);
}

async function submitCustomCli() {
  const command = customCommand.value.trim();
  if (!command) return;
  try {
    await controller.launchCustomCli(command);
    customCommand.value = '';
  } catch {
    // Error message is projected in deckState.errorMessage.
  }
}

/**
 * @param {string} slotId
 */
async function onRestartSlot(slotId) {
  try {
    await controller.restartSlot(slotId);
  } catch {
    // Error message is projected in deckState.errorMessage.
  }
}

/**
 * @param {string} slotId
 */
async function onRequestClose(slotId) {
  await controller.requestCloseSlot(slotId);
}

async function onConfirmClose() {
  await controller.confirmPendingClose();
}

function onCancelClose() {
  controller.cancelPendingClose();
}

async function onBootstrap() {
  await controller.bootstrap();
}

/**
 * @param {number} index
 */
function selectScreen(index) {
  controller.selectScreen(index);
}

function addScreen() {
  controller.addScreen();
}

/**
 * @param {number} index
 */
function removeScreen(index) {
  controller.removeScreen(index);
}

/**
 * @param {number} index
 */
function canRemoveScreen(index) {
  return controller.canRemoveScreen(index);
}

/**
 * @param {string} slotId
 */
function focusSlot(slotId) {
  controller.focusSlot(slotId);
  const entry = mountedTerminals.get(slotId);
  try {
    entry?.term?.focus();
  } catch {
    // Best-effort focus.
  }
}

/**
 * Direct input helper for tests or accessibility keyboard forwarding when
 * typing inside a focused tile container in headless DOMs.
 *
 * @param {string} slotId
 * @param {KeyboardEvent} event
 */
function onTileKeyDown(slotId, event) {
  if (matchDeckShortcut(event) !== null) return;
  const target = /** @type {{ tagName?: unknown } | null} */ (event?.target ?? null);
  const tagName = typeof target?.tagName === 'string' ? target.tagName.toUpperCase() : '';
  if (tagName === 'BUTTON' || tagName === 'INPUT') {
    return;
  }
  if (mountedTerminals.get(slotId)?.term) return;
  const slot = (activeScreen.value?.slots ?? []).find((item) => item.id === slotId);
  if (!slot || slot.status !== 'running' || !slot.sessionId) return;
  if (typeof event.key === 'string' && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
    controller.writeSessionBytes(slot.sessionId, Array.from(encoder.encode(event.key)));
  } else if (event.key === 'Enter') {
    controller.writeSessionBytes(slot.sessionId, [0x0a]);
  }
}

onMounted(() => {
  void controller.refreshProviders();
  globalThis.window?.addEventListener?.('keydown', onWindowKeyDown, true);
  globalThis.document?.addEventListener?.('keydown', onWindowKeyDown, true);
  globalThis.document?.addEventListener?.('pointerdown', onDocumentPointerDown, true);
  globalThis.document?.addEventListener?.('mousedown', onDocumentPointerDown, true);
  void nextTick(() => syncTerminals());
});

watch(
  () => [props.hostProviders, props.brokerCommands, props.terminalSessionPort],
  () => {
    void controller.refreshProviders();
    revision.value += 1;
  },
);

onBeforeUnmount(() => {
  syncOverlayAttr(false);
  globalThis.window?.removeEventListener?.('keydown', onWindowKeyDown, true);
  globalThis.document?.removeEventListener?.('keydown', onWindowKeyDown, true);
  globalThis.document?.removeEventListener?.('pointerdown', onDocumentPointerDown, true);
  globalThis.document?.removeEventListener?.('mousedown', onDocumentPointerDown, true);
  for (const slotId of [...mountedTerminals.keys()]) {
    destroySlotTerminal(slotId);
  }
  controller.dispose();
});

defineExpose({
  controller,
});
</script>

<template>
  <div
    id="mv-terminal-deck"
    class="mv-terminal-deck"
    data-semantic-anchor="terminal/deck/root"
    aria-label="Terminal workspace"
    @keydown="onWindowKeyDown"
  >
    <header class="mv-terminal-deck__bar" aria-label="Terminal operator bar">
      <div class="mv-terminal-deck__screens" role="tablist" aria-label="Terminal screens">
        <div
          v-for="(screen, sIdx) in screens"
          :key="screen.id"
          class="mv-terminal-deck__screen-chip"
          :class="{ 'mv-terminal-deck__screen-chip--active': sIdx === activeScreenIndex }"
        >
          <button
            type="button"
            :id="`terminal-deck-screen-${screen.number}`"
            :data-semantic-anchor="`terminal/screen/${screen.number}`"
            class="mv-terminal-deck__screen-tab"
            role="tab"
            :aria-selected="sIdx === activeScreenIndex"
            @click="selectScreen(sIdx)"
          >{{ screen.label }}</button>
          <button
            v-if="canRemoveScreen(sIdx)"
            type="button"
            :id="`terminal-deck-screen-remove-${screen.number}`"
            :data-semantic-anchor="`terminal/screen/${screen.number}/remove`"
            class="mv-terminal-deck__screen-remove"
            :aria-label="`Remove ${screen.label}`"
            @click.stop="removeScreen(sIdx)"
          >✕</button>
        </div>
        <button
          type="button"
          id="terminal-deck-screen-add"
          data-semantic-anchor="terminal/screen/add"
          class="mv-terminal-deck__screen-add"
          aria-label="Add screen"
          @click="addScreen"
        >+</button>
      </div>

      <div class="mv-terminal-deck__actions">
        <span class="mv-terminal-deck__bootstrap-wrap">
          <button
            type="button"
            id="terminal-deck-bootstrap"
            data-semantic-anchor="terminal/bootstrap"
            class="mv-terminal-deck__action-btn"
            @click="onBootstrap"
          >🚀 Bootstrap</button>
          <span
            v-if="toastMessage"
            id="terminal-deck-bootstrap-toast"
            data-semantic-anchor="terminal/bootstrap/toast"
            class="mv-terminal-deck__toast"
            role="status"
            aria-live="polite"
          >{{ toastMessage }}</span>
        </span>

        <div
          ref="launcherWrap"
          class="mv-terminal-deck__launcher-wrap"
          @keydown.esc.stop.prevent="controller.setLauncherOpen(false)"
        >
          <button
            type="button"
            id="terminal-deck-new"
            data-semantic-anchor="terminal/new"
            class="mv-terminal-deck__action-btn mv-terminal-deck__action-btn--primary"
            :aria-expanded="launcherOpen"
            aria-haspopup="dialog"
            @click="toggleLauncher"
          >＋ New terminal</button>

          <div
            v-if="launcherOpen"
            id="terminal-deck-launcher"
            data-semantic-anchor="terminal/launcher"
            class="mv-terminal-deck__popover"
            role="dialog"
            aria-label="New terminal profiles"
            @keydown.esc.stop.prevent="controller.setLauncherOpen(false)"
          >
            <div class="mv-terminal-deck__profile-list" role="group" aria-label="Launch profiles">
              <button
                v-for="profile in profiles"
                :key="profile.id"
                type="button"
                :id="`terminal-deck-profile-${profile.id}`"
                :data-semantic-anchor="`terminal/profile/${profile.id}`"
                class="mv-terminal-deck__profile-btn"
                @click="onLaunchProfile(profile.id)"
              >
                <span class="mv-terminal-deck__profile-label">{{ profile.label }}</span>
                <span v-if="profile.hint" class="mv-terminal-deck__profile-hint">{{ profile.hint }}</span>
              </button>
            </div>

            <div class="mv-terminal-deck__custom-cli">
              <label class="mv-terminal-deck__custom-label" for="terminal-deck-custom-input">Custom CLI</label>
              <div class="mv-terminal-deck__custom-row">
                <input
                  id="terminal-deck-custom-input"
                  :value="customCommand"
                  data-semantic-anchor="terminal/custom/input"
                  class="mv-terminal-deck__custom-input"
                  type="text"
                  placeholder="Enter command…"
                  aria-label="Custom CLI command"
                  @input="onCustomInput"
                  @keydown.enter.prevent="submitCustomCli"
                  @keydown.esc.stop.prevent="controller.setLauncherOpen(false)"
                />
                <button
                  type="button"
                  id="terminal-deck-custom-launch"
                  data-semantic-anchor="terminal/custom/launch"
                  class="mv-terminal-deck__custom-submit"
                  :disabled="!customCommand.trim()"
                  @click="submitCustomCli"
                >Launch</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </header>

    <p
      v-if="errorMessage"
      id="terminal-deck-error"
      data-semantic-anchor="terminal/error"
      :data-error-code="errorCode || undefined"
      class="mv-terminal-deck__error"
      role="alert"
    >{{ errorMessage }}</p>

    <div
      id="terminal-deck-grid"
      data-semantic-anchor="terminal/grid"
      class="mv-terminal-deck__grid"
      :data-grid-cols="gridColumns"
    >
      <div
        v-if="!activeScreen || activeScreen.slots.length === 0"
        id="terminal-deck-empty"
        data-semantic-anchor="terminal/empty"
        class="mv-terminal-deck__empty"
      >
        <p class="mv-terminal-deck__empty-title">No terminals on {{ activeScreen?.label ?? 'Screen 1' }}</p>
        <p class="mv-terminal-deck__empty-copy">Use "＋ New terminal" or press Ctrl+Shift+T to launch a Shell.</p>
        <button
          type="button"
          id="terminal-deck-empty-shell"
          data-semantic-anchor="terminal/empty/shell"
          class="mv-terminal-deck__action-btn mv-terminal-deck__action-btn--primary"
          @click="onLaunchProfile('shell')"
        >Open Shell</button>
      </div>

      <article
        v-for="slot in activeScreen?.slots ?? []"
        :key="slot.id"
        :id="`terminal-deck-tile-${slot.id}`"
        :data-semantic-anchor="`terminal/tile/${slot.id}`"
        class="mv-terminal-deck__tile"
        :class="{
          'mv-terminal-deck__tile--focused': focusedSlotId === slot.id,
          'mv-terminal-deck__tile--exited': slot.status === 'exited',
          'mv-terminal-deck__tile--restored': slot.status === 'restored',
        }"
        :data-slot-status="slot.status"
        :data-slot-kind="slot.kind"
        tabindex="0"
        :aria-label="slot.title"
        @mousedown="focusSlot(slot.id)"
        @focus="focusSlot(slot.id)"
        @keydown="onTileKeyDown(slot.id, $event)"
      >
        <header class="mv-terminal-deck__tile-header">
          <span class="mv-terminal-deck__tile-title">{{ slot.title }}</span>
          <span
            v-if="slot.status === 'exited' || slot.status === 'restored'"
            :id="`terminal-deck-status-${slot.id}`"
            :data-semantic-anchor="`terminal/tile/${slot.id}/status`"
            class="mv-terminal-deck__tile-status"
            role="status"
          >{{ slot.status }}</span>
          <div class="mv-terminal-deck__tile-controls">
            <button
              v-if="slot.status === 'restored' || slot.status === 'exited'"
              type="button"
              :id="`terminal-deck-restart-${slot.id}`"
              :data-semantic-anchor="`terminal/tile/${slot.id}/restart`"
              class="mv-terminal-deck__tile-restart"
              @click.stop="onRestartSlot(slot.id)"
            >Restart</button>
            <button
              type="button"
              :id="`terminal-deck-close-${slot.id}`"
              :data-semantic-anchor="`terminal/tile/${slot.id}/close`"
              class="mv-terminal-deck__tile-close"
              :aria-label="`Close ${slot.title}`"
              @click.stop="onRequestClose(slot.id)"
            >✕</button>
          </div>
        </header>

        <div class="mv-terminal-deck__tile-body">
          <div
            :id="`terminal-deck-viewport-${slot.id}`"
            :ref="(el) => setViewportRef(slot.id, el)"
            :data-semantic-anchor="`terminal/tile/${slot.id}/viewport`"
            class="mv-terminal-deck__viewport"
          ></div>
          <div
            v-if="slot.status === 'restored'"
            class="mv-terminal-deck__restored-banner"
          >
            <span>Saved {{ slot.title }} slot restored from previous session.</span>
          </div>
        </div>
      </article>
    </div>

    <div
      v-if="pendingCloseSlotId"
      id="terminal-deck-confirm-close"
      data-semantic-anchor="terminal/confirm-close"
      class="mv-terminal-deck__confirm-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Confirm close busy terminal"
    >
      <div class="mv-terminal-deck__confirm-panel">
        <h3 class="mv-terminal-deck__confirm-title">Close busy terminal?</h3>
        <p class="mv-terminal-deck__confirm-copy">
          The terminal process is still running. Closing it sends SIGINT and terminates the session.
        </p>
        <div class="mv-terminal-deck__confirm-actions">
          <button
            type="button"
            id="terminal-deck-confirm-close-yes"
            data-semantic-anchor="terminal/confirm-close/confirm"
            class="mv-terminal-deck__action-btn mv-terminal-deck__action-btn--primary"
            @click="onConfirmClose"
          >Close terminal</button>
          <button
            type="button"
            id="terminal-deck-confirm-close-no"
            data-semantic-anchor="terminal/confirm-close/cancel"
            class="mv-terminal-deck__action-btn"
            @click="onCancelClose"
          >Cancel</button>
        </div>
      </div>
    </div>
  </div>
</template>

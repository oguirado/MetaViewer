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
  collectRetainedSlotIds,
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
const pastedBootstrapText = ref('');
const lastBootstrapFocused = ref(false);
const contextMenu = ref(
  /** @type {{ open: boolean, x: number, y: number, slotId: string | null, hasSelection: boolean, selectionText: string }} */ ({
    open: false,
    x: 0,
    y: 0,
    slotId: null,
    hasSelection: false,
    selectionText: '',
  }),
);
const contextMenuWrap = ref(/** @type {any} */ (null));
const bootstrapWrap = ref(/** @type {any} */ (null));

/** @type {Map<string, HTMLElement>} */
const viewportElements = new Map();
/** @type {Map<string, { sessionId: string, term: Terminal | null, fit: FitAddon | null, disposeData: (() => void) | null }>} */
const mountedTerminals = new Map();
/** @type {Map<string, string[]>} */
const pendingSessionOutput = new Map();

/**
 * @param {string | null | undefined} slotId
 * @returns {string}
 */
function readSlotSelection(slotId) {
  if (slotId) {
    const entry = mountedTerminals.get(slotId);
    if (entry?.term && typeof entry.term.getSelection === 'function') {
      try {
        const text = entry.term.getSelection();
        if (typeof text === 'string' && text.length > 0) return text;
      } catch {
        // Fall through to window selection.
      }
    }
  }
  try {
    const sel = globalThis.window?.getSelection?.();
    const str = sel ? String(sel.toString?.() ?? '') : '';
    if (str.length > 0) return str;
  } catch {
    // Best-effort selection read.
  }
  return '';
}

function closeContextMenu() {
  if (!contextMenu.value.open) return false;
  contextMenu.value = {
    open: false,
    x: 0,
    y: 0,
    slotId: null,
    hasSelection: false,
    selectionText: '',
  };
  return true;
}

const controller = createTerminalDeckController({
  broker: props.terminalBroker,
  sessionPort: props.terminalSessionPort,
  sessionFacade: props.terminalBinding && typeof props.terminalBinding.write === 'function' ? props.terminalBinding : null,
  hostProviders: props.hostProviders,
  brokerCommands: props.brokerCommands,
  clipboard: props.clipboard,
  storage: props.storage ?? (typeof globalThis.localStorage !== 'undefined' ? globalThis.localStorage : null),
  closeGraceMs: props.closeGraceMs,
  getSelection(slotId) {
    return readSlotSelection(slotId);
  },
  onPasteText(_slotId, text) {
    const activeEl = /** @type {any} */ (globalThis.document)?.activeElement;
    const activeId = activeEl?.id ?? activeEl?.props?.id ?? '';
    if (activeId === 'terminal-deck-custom-input') {
      lastBootstrapFocused.value = false;
      customCommand.value = `${customCommand.value}${text}`;
      controller.setCustomCommandInput(customCommand.value);
      return true;
    }
    const isBootstrapActive =
      activeId === 'terminal-deck-bootstrap' ||
      activeId === 'terminal-deck-bootstrap-panel' ||
      activeId === 'terminal-deck-bootstrap-paste-target';
    if (activeEl && !isBootstrapActive) {
      lastBootstrapFocused.value = false;
      return false;
    }
    if (lastBootstrapFocused.value || isBootstrapActive) {
      pastedBootstrapText.value = text;
      return true;
    }
    return false;
  },
  onEscape() {
    return closeContextMenu();
  },
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
const allScreenSlots = computed(() => {
  const list = [];
  const scrs = screens.value ?? [];
  const activeIdx = activeScreenIndex.value;
  for (let sIdx = 0; sIdx < scrs.length; sIdx += 1) {
    const scr = scrs[sIdx];
    for (const slot of scr.slots ?? []) {
      list.push({
        slot,
        screenIndex: sIdx,
        onActiveScreen: sIdx === activeIdx,
      });
    }
  }
  return list;
});
const launcherWrap = ref(/** @type {any} */ (null));
const overlayCoordinator = /** @type {{ set?: (owner: string, active: boolean) => void } | null} */ (inject('overlayCoordinator', null));
const launcherOverlayOwner = 'terminal-deck-overlay';
const overlayOpen = computed(() => Boolean(props.open && (launcherOpen.value || pendingCloseSlotId.value || contextMenu.value.open)));

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
  controller.unregisterTerminal(slotId);
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
  const retainedIds = collectRetainedSlotIds(screens.value, {
    open: props.open,
    activeScreenIndex: activeScreenIndex.value,
  });
  for (const mountedId of [...mountedTerminals.keys()]) {
    if (!retainedIds.has(mountedId)) {
      destroySlotTerminal(mountedId);
    }
  }
  for (const item of allScreenSlots.value) {
    const { slot, onActiveScreen } = item;
    if (!slot.sessionId) {
      destroySlotTerminal(slot.id);
      continue;
    }
    const container = viewportElements.get(slot.id);
    if (!container) continue;
    const current = mountedTerminals.get(slot.id);
    if (current && current.sessionId === slot.sessionId) {
      if (props.open && onActiveScreen) {
        try {
          current.fit?.fit();
          if (current.term && current.term.cols > 0 && current.term.rows > 0) {
            controller.resizeSession(slot.sessionId, current.term.cols, current.term.rows);
          }
        } catch {
          // Fit is best-effort in headless DOMs.
        }
        if (focusedSlotId.value === slot.id && !lastBootstrapFocused.value) {
          try {
            current.term?.focus();
          } catch {
            // Best-effort focus in headless DOMs.
          }
        }
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
        const found = controller.findSlot(slot.id);
        const currentSlot = found?.slot ?? null;
        if (!currentSlot || currentSlot.status !== 'running' || !currentSlot.sessionId) return;
        controller.writeSessionBytes(currentSlot.sessionId, Array.from(encoder.encode(data)));
      });
      term.open(container);
      if (props.open && onActiveScreen) {
        try {
          fit.fit();
          if (term.cols > 0 && term.rows > 0) {
            controller.resizeSession(sessionId, term.cols, term.rows);
          }
        } catch {
          // Headless DOM fallback keeps 80x24.
        }
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
      controller.registerTerminal(slot.id, term);
      if (props.open && onActiveScreen && focusedSlotId.value === slot.id && !lastBootstrapFocused.value) {
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
      controller.registerTerminal(slot.id, null);
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
 * @param {unknown} target
 * @returns {boolean}
 */
function isInsideContextMenu(target) {
  if (!target || typeof target !== 'object') return false;
  const wrap = contextMenuWrap.value;
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
      if (el.closest('.mv-terminal-deck__context-menu')) return true;
    } catch {
      // Fallback to ancestor walk.
    }
  }
  let cur = el;
  while (cur) {
    if (wrap && cur === wrap) return true;
    const id = cur.id ?? cur.props?.id;
    if (
      id === 'terminal-deck-context-menu' ||
      id === 'terminal-deck-context-copy' ||
      id === 'terminal-deck-context-paste'
    ) {
      return true;
    }
    const cls = String(cur.className ?? cur.props?.class ?? '');
    if (cls.includes('mv-terminal-deck__context-menu')) return true;
    cur = cur.parentNode ?? cur.parent ?? null;
  }
  return false;
}

/**
 * @param {unknown} target
 * @returns {boolean}
 */
function isInsideBootstrapWrap(target) {
  if (!target || typeof target !== 'object') return false;
  const wrap = bootstrapWrap.value;
  if (wrap && typeof wrap.contains === 'function') {
    try {
      if (wrap.contains(target)) return true;
    } catch {
      // Custom renderer nodes may not be native DOM nodes.
    }
  }
  let cur = /** @type {any} */ (target);
  while (cur) {
    if (wrap && cur === wrap) return true;
    const id = cur.id ?? cur.props?.id;
    if (
      id === 'terminal-deck-bootstrap' ||
      id === 'terminal-deck-bootstrap-panel' ||
      id === 'terminal-deck-bootstrap-paste-target'
    ) {
      return true;
    }
    cur = cur.parentNode ?? cur.parent ?? null;
  }
  return false;
}

/**
 * @param {{ relatedTarget?: unknown } | undefined} [event]
 */
function onBootstrapFocusOut(event) {
  if (!isInsideBootstrapWrap(event?.relatedTarget)) {
    lastBootstrapFocused.value = false;
  }
}

/**
 * @param {Event} event
 */
function onDocumentPointerDown(event) {
  if (!props.open) return;
  const target = event?.target ?? null;
  if (lastBootstrapFocused.value && !isInsideBootstrapWrap(target)) {
    lastBootstrapFocused.value = false;
  }
  if (contextMenu.value.open && !isInsideContextMenu(target)) {
    closeContextMenu();
  }
  if (launcherOpen.value && !isInsideLauncherWrap(target)) {
    controller.setLauncherOpen(false);
  }
}

/**
 * Opens the terminal right-click context menu above the deck.
 *
 * @param {string} slotId
 * @param {MouseEvent | { clientX?: number, clientY?: number, preventDefault?: () => void, stopPropagation?: () => void }} [event]
 */
function onTileContextMenu(slotId, event) {
  event?.preventDefault?.();
  event?.stopPropagation?.();
  lastBootstrapFocused.value = false;
  focusSlot(slotId);
  const selText = readSlotSelection(slotId);
  const x = typeof event?.clientX === 'number' && Number.isFinite(event.clientX) ? event.clientX : 0;
  const y = typeof event?.clientY === 'number' && Number.isFinite(event.clientY) ? event.clientY : 0;
  contextMenu.value = {
    open: true,
    x,
    y,
    slotId,
    hasSelection: selText.length > 0,
    selectionText: selText,
  };
}

async function onContextMenuCopy() {
  if (!contextMenu.value.hasSelection) return;
  const { slotId, selectionText } = contextMenu.value;
  closeContextMenu();
  await controller.copySelection(selectionText || undefined, slotId);
}

async function onContextMenuPaste() {
  const { slotId } = contextMenu.value;
  closeContextMenu();
  await controller.pasteClipboard(undefined, slotId);
}

/**
 * @param {ClipboardEvent | { clipboardData?: { getData?: (type: string) => string }, preventDefault?: () => void, stopPropagation?: () => void }} [event]
 */
async function onBootstrapPaste(event) {
  event?.preventDefault?.();
  event?.stopPropagation?.();
  lastBootstrapFocused.value = true;
  const clipDataText = event?.clipboardData?.getData?.('text/plain');
  if (typeof clipDataText === 'string' && clipDataText.length > 0) {
    pastedBootstrapText.value = clipDataText;
    await controller.pasteClipboard(clipDataText);
    return;
  }
  const res = await controller.pasteClipboard();
  if (res.pasted) {
    pastedBootstrapText.value = res.text;
  }
}

/**
 * @param {KeyboardEvent} event
 */
function onBootstrapKeyDown(event) {
  lastBootstrapFocused.value = true;
  if (matchDeckShortcut(event) === 'paste-clipboard') {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    void onBootstrapPaste();
  }
}

function toggleLauncher() {
  lastBootstrapFocused.value = false;
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
  lastBootstrapFocused.value = false;
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

function onDismissError() {
  controller.dismissError();
}

async function onBootstrap() {
  await controller.bootstrap();
}

/**
 * @param {number} index
 */
function selectScreen(index) {
  closeContextMenu();
  lastBootstrapFocused.value = false;
  controller.selectScreen(index);
}

function addScreen() {
  closeContextMenu();
  lastBootstrapFocused.value = false;
  controller.addScreen();
}

/**
 * @param {number} index
 */
function removeScreen(index) {
  closeContextMenu();
  lastBootstrapFocused.value = false;
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
  lastBootstrapFocused.value = false;
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
  const found = controller.findSlot(slotId);
  const slot = found?.slot ?? null;
  if (!slot || slot.status !== 'running' || !slot.sessionId) return;
  if (
    event &&
    event.ctrlKey === true &&
    !event.shiftKey &&
    !event.altKey &&
    !event.metaKey &&
    (event.key === 'c' || event.key === 'C')
  ) {
    controller.writeSessionBytes(slot.sessionId, [0x03]);
    return;
  }
  if (mountedTerminals.get(slotId)?.term) return;
  if (typeof event.key === 'string' && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
    controller.writeSessionBytes(slot.sessionId, Array.from(encoder.encode(event.key)));
  } else if (event.key === 'Enter') {
    controller.writeSessionBytes(slot.sessionId, [0x0a]);
  }
}

watch(
  () => [props.open, activeScreenIndex.value],
  ([isOpen, screenIdx], prev) => {
    if (prev && screenIdx !== prev[1]) {
      closeContextMenu();
      lastBootstrapFocused.value = false;
    }
    if (!isOpen) {
      closeContextMenu();
      lastBootstrapFocused.value = false;
      if (launcherOpen.value) {
        controller.setLauncherOpen(false);
      }
      for (const entry of mountedTerminals.values()) {
        try {
          /** @type {any} */ (entry.term)?.blur?.();
        } catch {
          // Best-effort blur when hiding deck.
        }
      }
    } else {
      void controller.refreshProviders();
    }
    void nextTick(() => syncTerminals());
  },
);

onMounted(() => {
  if (props.open) {
    void controller.refreshProviders();
  }
  globalThis.window?.addEventListener?.('keydown', onWindowKeyDown, true);
  globalThis.document?.addEventListener?.('keydown', onWindowKeyDown, true);
  globalThis.document?.addEventListener?.('pointerdown', onDocumentPointerDown, true);
  globalThis.document?.addEventListener?.('mousedown', onDocumentPointerDown, true);
  void nextTick(() => syncTerminals());
});

watch(
  () => [props.hostProviders, props.brokerCommands, props.terminalSessionPort],
  () => {
    if (props.open) {
      void controller.refreshProviders();
    }
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
  contextMenu,
  pastedBootstrapText,
  onTileContextMenu,
  onContextMenuCopy,
  onContextMenuPaste,
  onBootstrapPaste,
  closeContextMenu,
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
        <span
          ref="bootstrapWrap"
          id="terminal-deck-bootstrap-panel"
          data-semantic-anchor="terminal/bootstrap/panel"
          :data-pasted-slot-id="pastedBootstrapText || undefined"
          class="mv-terminal-deck__bootstrap-wrap"
          tabindex="-1"
          @focusin="lastBootstrapFocused = true"
          @focusout="onBootstrapFocusOut"
          @mousedown="lastBootstrapFocused = true"
          @paste="onBootstrapPaste"
          @keydown="onBootstrapKeyDown"
        >
          <button
            type="button"
            id="terminal-deck-bootstrap"
            data-semantic-anchor="terminal/bootstrap"
            class="mv-terminal-deck__action-btn"
            @focus="lastBootstrapFocused = true"
            @blur="onBootstrapFocusOut"
            @paste="onBootstrapPaste"
            @keydown="onBootstrapKeyDown"
            @click="onBootstrap"
          >🚀 Bootstrap</button>
          <button
            v-for="action in [{kind:'automate',label:'Automate'}, {kind:'use-automation',label:'Use automation'}, {kind:'no-automation',label:'No automation'}]"
            :key="action.kind"
            type="button"
            :id="`terminal-deck-${action.kind}`"
            :data-semantic-anchor="`terminal/${action.kind}`"
            class="mv-terminal-deck__action-btn"
            @click="controller.copyWorkflowPrompt(action.kind)"
          >{{ action.label }}</button>
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
    ><span id="terminal-deck-error-text" class="mv-terminal-deck__error-text">{{ errorMessage }}</span><button type="button" id="terminal-deck-error-dismiss" data-semantic-anchor="terminal/error/dismiss" class="mv-terminal-deck__error-dismiss" aria-label="Dismiss terminal error" @click="onDismissError">✕</button></p>

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
        v-for="item in allScreenSlots"
        :key="item.slot.id"
        :id="`terminal-deck-tile-${item.slot.id}`"
        :data-semantic-anchor="`terminal/tile/${item.slot.id}`"
        class="mv-terminal-deck__tile"
        :class="{
          'mv-terminal-deck__tile--focused': item.onActiveScreen && focusedSlotId === item.slot.id,
          'mv-terminal-deck__tile--exited': item.slot.status === 'exited',
          'mv-terminal-deck__tile--restored': item.slot.status === 'restored',
          'mv-terminal-deck__tile--inactive-screen': !item.onActiveScreen,
        }"
        :hidden="!item.onActiveScreen"
        :inert="!item.onActiveScreen ? true : undefined"
        :aria-hidden="!item.onActiveScreen ? 'true' : undefined"
        :data-slot-status="item.slot.status"
        :data-slot-kind="item.slot.kind"
        :data-slot-screen="item.screenIndex + 1"
        tabindex="0"
        :aria-label="item.slot.title"
        @mousedown="focusSlot(item.slot.id)"
        @focus="focusSlot(item.slot.id)"
        @contextmenu.prevent="onTileContextMenu(item.slot.id, $event)"
        @keydown="onTileKeyDown(item.slot.id, $event)"
      >
        <header class="mv-terminal-deck__tile-header">
          <span class="mv-terminal-deck__tile-title">{{ item.slot.title }}</span>
          <span
            v-if="item.slot.status === 'exited' || item.slot.status === 'restored'"
            :id="`terminal-deck-status-${item.slot.id}`"
            :data-semantic-anchor="`terminal/tile/${item.slot.id}/status`"
            class="mv-terminal-deck__tile-status"
            role="status"
          >{{ item.slot.status }}</span>
          <div class="mv-terminal-deck__tile-controls">
            <button
              v-if="item.slot.status === 'restored' || item.slot.status === 'exited'"
              type="button"
              :id="`terminal-deck-restart-${item.slot.id}`"
              :data-semantic-anchor="`terminal/tile/${item.slot.id}/restart`"
              class="mv-terminal-deck__tile-restart"
              @click.stop="onRestartSlot(item.slot.id)"
            >Restart</button>
            <button
              type="button"
              :id="`terminal-deck-close-${item.slot.id}`"
              :data-semantic-anchor="`terminal/tile/${item.slot.id}/close`"
              class="mv-terminal-deck__tile-close"
              :aria-label="`Close ${item.slot.title}`"
              @click.stop="onRequestClose(item.slot.id)"
            >✕</button>
          </div>
        </header>

        <div class="mv-terminal-deck__tile-body">
          <div
            :id="`terminal-deck-viewport-${item.slot.id}`"
            :ref="(el) => setViewportRef(item.slot.id, el)"
            :data-semantic-anchor="`terminal/tile/${item.slot.id}/viewport`"
            class="mv-terminal-deck__viewport"
            @contextmenu.prevent="onTileContextMenu(item.slot.id, $event)"
          ></div>
          <div
            v-if="item.slot.status === 'restored'"
            class="mv-terminal-deck__restored-banner"
          >
            <span>Saved {{ item.slot.title }} slot restored from previous session.</span>
          </div>
        </div>
      </article>
    </div>

    <div
      v-if="contextMenu.open"
      ref="contextMenuWrap"
      id="terminal-deck-context-menu"
      data-semantic-anchor="terminal/context-menu"
      class="mv-terminal-deck__context-menu"
      role="menu"
      aria-label="Terminal context menu"
      :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }"
      @keydown.esc.stop.prevent="closeContextMenu"
    >
      <button
        type="button"
        id="terminal-deck-context-copy"
        data-semantic-anchor="terminal/context-menu/copy"
        class="mv-terminal-deck__context-item"
        role="menuitem"
        :disabled="!contextMenu.hasSelection"
        :aria-disabled="!contextMenu.hasSelection"
        @click.stop="onContextMenuCopy"
      >Copy</button>
      <button
        type="button"
        id="terminal-deck-context-paste"
        data-semantic-anchor="terminal/context-menu/paste"
        class="mv-terminal-deck__context-item"
        role="menuitem"
        @click.stop="onContextMenuPaste"
      >Paste</button>
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

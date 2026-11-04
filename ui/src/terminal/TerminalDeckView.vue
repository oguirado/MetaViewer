<script setup>
/**
 * OpenFresnel-style full-wall Terminal Deck view for MetaViewer (P18h).
 *
 * Acts as a third workspace beside Humans and Agents. Renders the screen bar
 * ("Screen 1, 2, …" with "+" and empty-only "✕"), workflow controls and
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
  placeTerminalLauncher,
  placeTerminalContextMenu,
} from './terminalDeckModel.js';
import './terminal.css';
import {createPairedTerminals} from './pairedTerminals.js';
import {AGENT_PROFILE_IDS} from './agentPromptGate.js';

const props = defineProps({
  open: { type: Boolean, default: true },
  compact: { type: Boolean, default: false },
  idPrefix: { type: String, default: '' },
  pairedTarget: { type: /** @type {import('vue').PropType<any>} */ (Object), default: null },
  terminalBroker: { type: /** @type {import('vue').PropType<any>} */ (Object), default: null },
  terminalBinding: { type: /** @type {import('vue').PropType<any>} */ (Object), default: null },
  terminalSessionPort: { type: /** @type {import('vue').PropType<any>} */ (Object), default: null },
  hostProviders: { type: /** @type {import('vue').PropType<unknown[]>} */ (Array), default: () => [] },
  brokerCommands: { type: /** @type {import('vue').PropType<string[]>} */ (Array), default: () => [] },
  clipboard: { type: /** @type {import('vue').PropType<any>} */ (Object), default: null },
  storage: { type: /** @type {import('vue').PropType<Pick<Storage, 'getItem' | 'setItem'> | null>} */ (Object), default: null },
  closeGraceMs: { type: Number, default: undefined },
});

/** @param {string} id */
function domId(id) { return props.idPrefix ? `${props.idPrefix}-${id}` : id; }
/** @param {unknown} id */
function localId(id) { return typeof id === 'string' && props.idPrefix && id.startsWith(`${props.idPrefix}-`) ? id.slice(props.idPrefix.length+1) : id; }
const emit = defineEmits(['update:open','pair-focus']);

class MvDeckTerminal extends Terminal {
  /** @param {any} options */
  constructor(options) {
    super({ ...options, documentOverride: createTerminalDocument(globalThis.document) });
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const revision = ref(0);
const pairBusy = ref(false), pairError = ref('');
const agentChoice=ref(/** @type {any} */ (null));
const agentPreparing=ref(false);
let agentGeneration=0;
const customCommand = ref('');
const pastedBootstrapText = ref('');
const lastBootstrapFocused = ref(false);
// Ctrl+Shift+F6 leaves PTY input without consuming ordinary terminal Tab/Escape.
const controlsFocused = ref(false);
const closeDialog = ref(/** @type {any} */ (null));
const newTerminalButton = ref(/** @type {any} */ (null));
/** @type {any} */ let dialogReturnFocus = null;

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
const deckRoot = ref(/** @type {HTMLElement|null} */ (null));
const contextDimensions = ref({width:0,height:0});
const contextMenuStyle = computed(() => {
  const root=deckRoot.value?.getBoundingClientRect?.();
  const local=root && placeTerminalContextMenu(root,contextMenu.value,contextDimensions.value,{width:globalThis.window?.innerWidth ?? 0,height:globalThis.window?.innerHeight ?? 0});
  return /** @type {import('vue').CSSProperties} */ (local
    ? {position:'absolute',left:`${local.left}px`,top:`${local.top}px`,maxWidth:'100%',maxHeight:'100%'}
    : {left:`${contextMenu.value.x}px`,top:`${contextMenu.value.y}px`});
});
const contextMenuWrap = ref(/** @type {any} */ (null));
const bootstrapWrap = ref(/** @type {any} */ (null));

/** @type {Map<string, HTMLElement>} */
const viewportElements = new Map();
/** @type {Map<string, { sessionId: string, term: Terminal | null, fit: FitAddon | null, disposeData: (() => void) | null }>} */
const mountedTerminals = new Map();
/** @type {Map<string, string[]>} */
const pendingSessionOutput = new Map();
const fittedSizes = new Map();
const viewportObserver = typeof globalThis.ResizeObserver === 'function' ? new ResizeObserver(entries => {
  if (!props.open) return;
  for (const entry of entries) {
    if (entry.contentRect.width < 1 || entry.contentRect.height < 1) continue;
    const slotId = [...viewportElements].find(([,element]) => element === entry.target)?.[0];
    if (!slotId) continue;
    const slot = controller.findSlot(slotId);
    const current = mountedTerminals.get(slotId);
    if (!slot || slot.screenIndex !== activeScreenIndex.value || !current?.term) continue;
    try {
      current.fit?.fit();
      const {cols,rows}=current.term;
      const size=`${cols}x${rows}`;
      if (cols > 0 && rows > 0 && fittedSizes.get(slotId) !== size) {
        fittedSizes.set(slotId,size);
        controller.resizeSession(current.sessionId,cols,rows);
      }
    } catch { /* A detached or hidden viewport is fitted on its next observation. */ }
  }
}) : null;
// [TARGET, unit decision] Retain at most 64 Ki UTF-16 code units per unmounted session.
const MAX_PENDING_OUTPUT_CHARS = 64 * 1024;

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
    const activeId = localId(activeEl?.id ?? activeEl?.props?.id ?? '');
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
      pendingSessionOutput.set(frame.session, [(queue.join('') + text).slice(-MAX_PENDING_OUTPUT_CHARS)]);
    }
  },
});

const pairedTerminals=createPairedTerminals(controller);
watch(()=>[props.open,props.pairedTarget],async (_value,_old,onCleanup)=>{
  agentGeneration++;agentChoice.value=null;agentPreparing.value=false;
  if (!props.open || !props.pairedTarget) {pairBusy.value=false;return;}
  let current=true;onCleanup(()=>{current=false;});pairBusy.value=true;pairError.value='';
  try {
    const pair=await pairedTerminals.open(props.pairedTarget);
    if (current) {controller.focusSlot(pair.slotId);revision.value++;}
  } catch (error) {if(current)pairError.value=error instanceof Error?error.message:'Paired terminal unavailable';}
  finally {if(current)pairBusy.value=false;}
},{immediate:true});

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
const focusedPair=computed(()=>{revision.value;return pairedTerminals.forSlot(focusedSlotId.value);});
const pairMatchesTarget=computed(()=>!props.compact || focusedPair.value?.surfaceId === props.pairedTarget?.surfaceId);
const workflowIdentity=computed(()=>pairMatchesTarget.value ? focusedPair.value?.identityLine ?? pastedBootstrapText.value : '');
watch(focusedPair,pair=>emit('pair-focus',pair?.surfaceId ?? null),{immediate:true});
const pendingCloseSlotId = computed(() => deckState.value.pendingCloseSlotId);
const launcherOpen = computed(() => deckState.value.launcherOpen);
const toastMessage = computed(() => deckState.value.toastMessage);
const errorCode = computed(() => deckState.value.errorCode);
const errorMessage = computed(() => deckState.value.errorMessage);
const gridColumns = computed(() => props.compact ? '1' : String(deckState.value.gridColumns));
const profiles = computed(() => deckState.value.profiles);
async function copyPairedId() {
  if (!pairMatchesTarget.value || !focusedPair.value) return;
  await controller.copySelection(focusedPair.value.surfaceId, focusedPair.value.slotId);
}
/** @param {string} slotId */
function pairedTerminalLabel(slotId) {
  const slot=controller.findSlot(slotId)?.slot;
  return slot?.profileId==='shell'?'Host shell':slot?.title ?? 'Terminal';
}
const agentProfiles=computed(()=>profiles.value.filter(profile=>AGENT_PROFILE_IDS.includes(profile.id)));
/** @param {string} kind */
async function chooseWorkflow(kind) {
  if(!pairMatchesTarget.value || !focusedPair.value) return controller.useWorkflowPrompt(kind,workflowIdentity.value,null);
  const pair={...focusedPair.value},slot=controller.findSlot(pair.slotId)?.slot;
  if(slot?.status==='running' && AGENT_PROFILE_IDS.includes(slot.profileId)) {
    const generation=++agentGeneration;agentChoice.value=null;agentPreparing.value=true;pairError.value='';
    const current=()=>generation===agentGeneration && props.open && focusedPair.value?.surfaceId===pair.surfaceId;
    try {return await controller.prepareAgentPrompt(kind,pair.identityLine,slot.id,slot.profileId,current);}
    finally {if(generation===agentGeneration)agentPreparing.value=false;}
  }
  agentGeneration++;agentPreparing.value=false;agentChoice.value={kind,pair};
  await controller.refreshProviders();
}
function cancelAgentChoice() {agentGeneration++;agentChoice.value=null;agentPreparing.value=false;agentPreparing.value=false;}
/** @param {string} profileId */
async function launchWorkflowAgent(profileId) {
  const choice=agentChoice.value;
  if(!choice || agentPreparing.value) return;
  const generation=++agentGeneration;
  const current=()=>generation===agentGeneration && props.open && focusedPair.value?.surfaceId===choice.pair.surfaceId;
  agentPreparing.value=true;pairError.value='';
  try {
    const pair=await pairedTerminals.open(choice.pair,profileId);
    if(!current()) return;
    controller.focusSlot(pair.slotId);revision.value++;
    await controller.prepareAgentPrompt(choice.kind,pair.identityLine,pair.slotId,profileId,current);
  } catch(error) {if(current())pairError.value=error instanceof Error?error.message:'Agent launch unavailable';}
  finally {if(generation===agentGeneration){agentPreparing.value=false;agentChoice.value=null;}}
}
watch(focusedSlotId,()=>{if(agentChoice.value && focusedPair.value?.surfaceId!==agentChoice.value.pair.surfaceId)cancelAgentChoice();});
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
        onActiveScreen: sIdx === activeIdx && (!props.compact || (slot.id === focusedSlotId.value && pairMatchesTarget.value)),
      });
    }
  }
  return list;
});
const launcherWrap = ref(/** @type {any} */ (null));
const launcherPanel = ref(/** @type {HTMLElement|null} */ (null));
const launcherPlacement = ref(/** @type {ReturnType<typeof placeTerminalLauncher>} */ (null));
let launcherSizeObserver = /** @type {ResizeObserver|null} */ (null);
function updateLauncherPlacement() {
  if (!launcherOpen.value) return;
  const panel=deckRoot.value?.getBoundingClientRect?.(),anchor=newTerminalButton.value?.getBoundingClientRect?.(),menu=launcherPanel.value;
  if (!panel || !anchor || !menu) return;
  const next=placeTerminalLauncher(panel,anchor,Math.max(menu.scrollHeight,menu.offsetHeight),{width:globalThis.window?.innerWidth ?? 0,height:globalThis.window?.innerHeight ?? 0});
  if (JSON.stringify(next)!==JSON.stringify(launcherPlacement.value)) launcherPlacement.value=next;
}
watch(launcherOpen,async open=>{
  launcherSizeObserver?.disconnect();launcherSizeObserver=null;launcherPlacement.value=null;
  if (!open) return;
  await nextTick();
  if (!launcherOpen.value) return;
  if (typeof ResizeObserver==='function') {
    launcherSizeObserver=new ResizeObserver(updateLauncherPlacement);
    if(deckRoot.value)launcherSizeObserver.observe(deckRoot.value);
    if(launcherPanel.value)launcherSizeObserver.observe(launcherPanel.value);
  }
  updateLauncherPlacement();await nextTick();updateLauncherPlacement();
});
const launcherStyle=computed(()=>/** @type {import('vue').CSSProperties} */ (launcherPlacement.value ? {
  position:'fixed',right:'auto',left:`${launcherPlacement.value.left}px`,top:`${launcherPlacement.value.top}px`,
  width:`${launcherPlacement.value.width}px`,maxHeight:`${launcherPlacement.value.maxHeight}px`,visibility:'visible',
} : {visibility:'hidden'}));
const overlayCoordinator = /** @type {{ set?: (owner: object, active: boolean) => void, setSurface?: (owner: object, surfaceId: string, active: boolean) => void } | null} */ (inject('overlayCoordinator', null));
const launcherOverlayOwner = {};
const contextOverlayOwner = {};
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
// A terminal context menu is local chrome, not a modal over every capsule.
watch(() => [props.open, contextMenu.value.open, props.pairedTarget?.surfaceId], () => {
  const surfaceId = props.pairedTarget?.surfaceId;
  if (typeof surfaceId === 'string') overlayCoordinator?.setSurface?.(contextOverlayOwner, surfaceId, Boolean(props.open && contextMenu.value.open));
}, {immediate:true, flush:'sync'});

/**
 * @param {string} slotId
 * @param {unknown} el
 */
function setViewportRef(slotId, el) {
  const isElement = typeof HTMLElement !== 'undefined'
    ? el instanceof HTMLElement
    : Boolean(el && typeof el === 'object');
  const previous=viewportElements.get(slotId);
  if (previous === el) return;
  if (previous) viewportObserver?.unobserve(previous);
  if (isElement) {
    viewportElements.set(slotId, /** @type {HTMLElement} */ (el));
    viewportObserver?.observe(/** @type {HTMLElement} */ (el));
  } else {
    viewportElements.delete(slotId);
  }
}

/**
 * @param {string} slotId
 */
function destroySlotTerminal(slotId) {
  fittedSizes.delete(slotId);
  controller.unregisterTerminal(slotId);
  const existing = mountedTerminals.get(slotId);
  if (!existing) return;
  pendingSessionOutput.delete(existing.sessionId);
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
  const liveSessions = new Set(allScreenSlots.value.map(({ slot }) => slot.sessionId));
  for (const sessionId of pendingSessionOutput.keys()) {
    if (!liveSessions.has(sessionId)) pendingSessionOutput.delete(sessionId);
  }
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
            const size=`${current.term.cols}x${current.term.rows}`;
            if (fittedSizes.get(slot.id)!==size) {
              fittedSizes.set(slot.id,size);
              controller.resizeSession(slot.sessionId, current.term.cols, current.term.rows);
            }
          }
        } catch {
          // Fit is best-effort in headless DOMs.
        }
        if (focusedSlotId.value === slot.id && !lastBootstrapFocused.value && !controlsFocused.value && !pendingCloseSlotId.value && !current.term?.hasSelection?.()) {
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
        if (pendingCloseSlotId.value || (event.key === 'F6' && event.ctrlKey && event.shiftKey) || matchDeckShortcut(event) !== null) {
          return false;
        }
        return true;
      });
      const sessionId = slot.sessionId;
      const disposable = term.onData((data) => {
        if (pendingCloseSlotId.value) return;
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
            fittedSizes.set(slot.id,`${term.cols}x${term.rows}`);
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
      if (props.open && onActiveScreen && focusedSlotId.value === slot.id && !lastBootstrapFocused.value && !controlsFocused.value && !pendingCloseSlotId.value) {
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
  const eventDeck = /** @type {Element|null} */ (event.target)?.closest?.('.mv-terminal-deck');
  if ((eventDeck && eventDeck !== deckRoot.value) || (props.compact && eventDeck !== deckRoot.value)) return;
  if (props.compact && ['new-shell','next-screen','prev-screen'].includes(matchDeckShortcut(event) ?? '')) {
    event.preventDefault();event.stopPropagation();return;
  }
  if (pendingCloseSlotId.value) {
    if (event.key === 'Escape') controller.cancelPendingClose();
    else if (event.key === 'Tab') {
      const buttons = [...(closeDialog.value?.querySelectorAll?.('button:not(:disabled)') ?? [])];
      const at = buttons.indexOf(globalThis.document?.activeElement);
      const next = event.shiftKey ? (at <= 0 ? buttons.length - 1 : at - 1) : (at + 1) % buttons.length;
      buttons[next]?.focus?.();
    } else if (closeDialog.value?.contains?.(event.target)) return;
    event.preventDefault();event.stopImmediatePropagation();
    return;
  }
  if (event.key === 'F6' && event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey) {
    controlsFocused.value = true;
    newTerminalButton.value?.focus?.();
    event.preventDefault();event.stopImmediatePropagation();
    return;
  }
  controller.handleKeyDown(event);
}

/** @param {FocusEvent} event */
function containDialogFocus(event) {
  if (props.open && pendingCloseSlotId.value && !closeDialog.value?.contains?.(event.target)) {
    closeDialog.value?.querySelector?.('[data-semantic-anchor="terminal/confirm-close/cancel"]')?.focus?.();
  }
}

watch(pendingCloseSlotId, async (id, previous) => {
  if (id && !previous) {
    dialogReturnFocus = globalThis.document?.activeElement;
    controlsFocused.value = true;
    closeContextMenu();
    controller.setLauncherOpen(false);
    await nextTick();
    closeDialog.value?.querySelector?.('[data-semantic-anchor="terminal/confirm-close/cancel"]')?.focus?.();
  } else if (!id && previous) {
    await nextTick();
    if (dialogReturnFocus?.isConnected !== false && typeof dialogReturnFocus?.focus === 'function') dialogReturnFocus.focus();
    else newTerminalButton.value?.focus?.();
    dialogReturnFocus = null;
  }
});

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
    const id = localId(cur.id ?? cur.props?.id);
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
    const id = localId(cur.id ?? cur.props?.id);
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
    const id = localId(cur.id ?? cur.props?.id);
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
  if (pendingCloseSlotId.value) return;
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
  void nextTick(() => {
    if (!contextMenu.value.open) return;
    const bounds = contextMenuWrap.value?.getBoundingClientRect?.();
    if (!bounds) return;
    contextDimensions.value={width:bounds.width,height:bounds.height};
    contextMenu.value.x = Math.max(0, Math.min(x, (globalThis.window?.innerWidth ?? x) - bounds.width));
    contextMenu.value.y = Math.max(0, Math.min(y, (globalThis.window?.innerHeight ?? y) - bounds.height));
  });
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

/** @param {Event} event */
function onBootstrapInput(event) {
  if (!focusedPair.value) pastedBootstrapText.value = /** @type {HTMLInputElement} */ (event.target).value;
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
  if (pendingCloseSlotId.value) return;
  controlsFocused.value = false;
  lastBootstrapFocused.value = false;
  if (controller.state.focusedSlotId !== slotId) controller.focusSlot(slotId);
  const entry = mountedTerminals.get(slotId);
  try {
    if (!entry?.term?.hasSelection?.()) entry?.term?.focus();
  } catch {
    // Best-effort focus.
  }
}

/** Capture the owner before xterm stops Shift+mousedown during mouse reporting.
 * Right-click belongs to the local menu and never reaches an application.
 * @param {string} slotId @param {MouseEvent|PointerEvent} event */
function onTilePointerDown(slotId, event) {
  if (pendingCloseSlotId.value) return;
  controlsFocused.value=false;lastBootstrapFocused.value=false;
  if (controller.state.focusedSlotId!==slotId) controller.focusSlot(slotId);
  if (event.button===2) onTileContextMenu(slotId,event);
  else {
    // Shift selection can stop xterm before its own mousedown focus handler.
    try { mountedTerminals.get(slotId)?.term?.focus(); } catch { /* best effort */ }
  }
}

/** Suppress mouse-reporting hover while Shift requests local selection.
 * Drag moves still reach xterm's document selection listener.
 * @param {MouseEvent} event */
function onTerminalMouseMove(event) {
  if (event.shiftKey && event.buttons===0) event.stopPropagation();
}

/**
 * Direct input helper for tests or accessibility keyboard forwarding when
 * typing inside a focused tile container in headless DOMs.
 *
 * @param {string} slotId
 * @param {KeyboardEvent} event
 */
function onTileKeyDown(slotId, event) {
  if (pendingCloseSlotId.value || controlsFocused.value) return;
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
  globalThis.window?.addEventListener?.('resize', updateLauncherPlacement);
  globalThis.window?.addEventListener?.('scroll', updateLauncherPlacement, true);
  globalThis.document?.addEventListener?.('focusin', containDialogFocus, true);
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
  agentGeneration++;
  launcherSizeObserver?.disconnect();
  globalThis.window?.removeEventListener?.('resize', updateLauncherPlacement);
  globalThis.window?.removeEventListener?.('scroll', updateLauncherPlacement, true);
  viewportObserver?.disconnect();
  globalThis.document?.removeEventListener?.('focusin', containDialogFocus, true);
  syncOverlayAttr(false);
  if (typeof props.pairedTarget?.surfaceId === 'string') overlayCoordinator?.setSurface?.(contextOverlayOwner, props.pairedTarget.surfaceId, false);
  globalThis.window?.removeEventListener?.('keydown', onWindowKeyDown, true);
  globalThis.document?.removeEventListener?.('keydown', onWindowKeyDown, true);
  globalThis.document?.removeEventListener?.('pointerdown', onDocumentPointerDown, true);
  globalThis.document?.removeEventListener?.('mousedown', onDocumentPointerDown, true);
  for (const slotId of [...mountedTerminals.keys()]) {
    destroySlotTerminal(slotId);
  }
  pendingSessionOutput.clear();
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
    :id="domId('mv-terminal-deck')"
    ref="deckRoot"
    class="mv-terminal-deck"
    :data-compact="String(compact)"
    data-semantic-anchor="terminal/deck/root"
    aria-label="Terminal workspace"
    @keydown="onWindowKeyDown"
    @contextmenu.prevent
  >
    <header class="mv-terminal-deck__bar" aria-label="Terminal operator bar">
      <button v-if="compact" :id="domId('terminal-deck-hide')" data-semantic-anchor="terminal/hide" type="button" class="mv-terminal-deck__action-btn" @click="emit('update:open', false)">Hide terminal</button>
      <div class="mv-terminal-deck__screens" role="tablist" aria-label="Terminal screens">
        <div
          v-for="(screen, sIdx) in screens"
          :key="screen.id"
          class="mv-terminal-deck__screen-chip"
          :class="{ 'mv-terminal-deck__screen-chip--active': sIdx === activeScreenIndex }"
        >
          <button
            type="button"
            :id="domId(`terminal-deck-screen-${screen.number}`)"
            :data-semantic-anchor="`terminal/screen/${screen.number}`"
            class="mv-terminal-deck__screen-tab"
            role="tab"
            :aria-selected="sIdx === activeScreenIndex"
            @click="selectScreen(sIdx)"
          >{{ screen.label }}</button>
          <button
            v-if="canRemoveScreen(sIdx)"
            type="button"
            :id="domId(`terminal-deck-screen-remove-${screen.number}`)"
            :data-semantic-anchor="`terminal/screen/${screen.number}/remove`"
            class="mv-terminal-deck__screen-remove"
            :aria-label="`Remove ${screen.label}`"
            @click.stop="removeScreen(sIdx)"
          >✕</button>
        </div>
        <button
          type="button"
          :id="domId('terminal-deck-screen-add')"
          data-semantic-anchor="terminal/screen/add"
          class="mv-terminal-deck__screen-add"
          aria-label="Add screen"
          @click="addScreen"
        >+</button>
      </div>

      <div class="mv-terminal-deck__actions">
        <span
          v-if="pairMatchesTarget"
          ref="bootstrapWrap"
          :id="domId('terminal-deck-bootstrap-panel')"
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
          <button v-if="focusedPair" type="button" :id="domId('terminal-deck-copy-capsule-id')"
            class="mv-terminal-deck__identity-pill mv-terminal-deck__identity-copy"
            :title="`Copy capsule ID: ${focusedPair.surfaceId}`" aria-label="Copy capsule ID" @click="copyPairedId">
            <span>Capsule ID:</span><span class="mv-terminal-deck__identity-value">{{ focusedPair.surfaceId }}</span>
          </button>
          <label v-else class="mv-terminal-deck__identity-pill"
            :title="focusedPair ? `Paired with ${focusedPair.title} · ${pairedTerminalLabel(focusedPair.slotId)}. ${workflowIdentity}` : 'Paste Copy ID for AI here to select the capsule for workflow actions.'">
            <span>Capsule ID: <span v-if="!workflowIdentity">None</span></span>
            <input :id="domId('terminal-deck-bootstrap-paste-target')" data-semantic-anchor="terminal/bootstrap/identity"
              :value="focusedPair?.surfaceId ?? pastedBootstrapText" :readonly="!!focusedPair" placeholder="Paste AI ID…"
              :aria-label="focusedPair ? 'Paired capsule identity · ' + (pairedTerminalLabel(focusedPair.slotId)) : 'Capsule identity for workflow actions'"
              @input="onBootstrapInput" />
          </label>
          <button
            v-for="action in [{kind:'automate',label:'Create automation',hint:'Teach an automation by showing the steps.'}, {kind:'use-automation',label:'Run automation',hint:'Prepare a task using a saved automation.'}, {kind:'no-automation',label:'Direct task',hint:'Prepare a task without a saved automation.'}]"
            :key="action.kind"
            type="button"
            :id="domId(`terminal-deck-${action.kind}`)"
            :data-semantic-anchor="`terminal/${action.kind}`"
            class="mv-terminal-deck__action-btn"
            :title="action.hint"
            @click="chooseWorkflow(action.kind)"
          >{{ action.label }}</button>
          <span v-if="agentChoice" :id="domId('terminal-deck-agent-choice')" data-semantic-anchor="terminal/agent-choice" class="mv-terminal-deck__agent-choice" role="group" aria-label="Launch an agent CLI">
            <span>{{ agentPreparing ? 'Waiting for agent input prompt…' : 'Replace this paired process with an agent CLI:' }}</span>
            <span v-if="!agentProfiles.length">No agent CLI available from this terminal host. Nothing pasted.</span>
            <button v-for="profile in agentProfiles" :key="profile.id" type="button"
              :id="domId(`terminal-deck-launch-${profile.id}`)" :data-semantic-anchor="`terminal/launch/${profile.id}`"
              class="mv-terminal-deck__action-btn" :disabled="agentPreparing" @click="launchWorkflowAgent(profile.id)">Launch {{ profile.label }}</button>
            <button type="button" :id="domId('terminal-deck-agent-cancel')" data-semantic-anchor="terminal/agent-cancel" class="mv-terminal-deck__action-btn" @click="cancelAgentChoice">Cancel</button>
          </span>
          <span
            v-if="toastMessage"
            :id="domId('terminal-deck-bootstrap-toast')"
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
            :id="domId('terminal-deck-new')"
            ref="newTerminalButton"
            title="New terminal (Ctrl+Shift+F6 leaves terminal input for controls)"
            data-semantic-anchor="terminal/new"
            class="mv-terminal-deck__action-btn mv-terminal-deck__action-btn--primary"
            :aria-expanded="launcherOpen"
            aria-haspopup="dialog"
            @click="toggleLauncher"
          >＋ New terminal</button>

          <div
            v-if="launcherOpen"
            ref="launcherPanel"
            :style="launcherStyle"
            :id="domId('terminal-deck-launcher')"
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
                :id="domId(`terminal-deck-profile-${profile.id}`)"
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
                  :id="domId('terminal-deck-custom-input')"
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
                  :id="domId('terminal-deck-custom-launch')"
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

    <p v-if="pairBusy" role="status">Opening paired terminal…</p>
    <p v-if="pairError" role="alert">{{ pairError }}</p>
    <p
      v-if="errorMessage"
      :id="domId('terminal-deck-error')"
      data-semantic-anchor="terminal/error"
      :data-error-code="errorCode || undefined"
      class="mv-terminal-deck__error"
      role="alert"
    ><span :id="domId('terminal-deck-error-text')" class="mv-terminal-deck__error-text">{{ errorMessage }}</span><button type="button" :id="domId('terminal-deck-error-dismiss')" data-semantic-anchor="terminal/error/dismiss" class="mv-terminal-deck__error-dismiss" aria-label="Dismiss terminal error" @click="onDismissError">✕</button></p>

    <div
      :id="domId('terminal-deck-grid')"
      data-semantic-anchor="terminal/grid"
      class="mv-terminal-deck__grid"
      :data-grid-cols="gridColumns"
    >
      <div
        v-if="!activeScreen || activeScreen.slots.length === 0"
        :id="domId('terminal-deck-empty')"
        data-semantic-anchor="terminal/empty"
        class="mv-terminal-deck__empty"
      >
        <p class="mv-terminal-deck__empty-title">No terminals on {{ activeScreen?.label ?? 'Screen 1' }}</p>
        <p class="mv-terminal-deck__empty-copy">Use "＋ New terminal" or press Ctrl+Shift+T to launch a Shell.</p>
        <button
          type="button"
          :id="domId('terminal-deck-empty-shell')"
          data-semantic-anchor="terminal/empty/shell"
          class="mv-terminal-deck__action-btn mv-terminal-deck__action-btn--primary"
          @click="onLaunchProfile('shell')"
        >Open Shell</button>
      </div>

      <article
        v-for="item in allScreenSlots"
        :key="item.slot.id"
        :id="domId(`terminal-deck-tile-${item.slot.id}`)"
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
        :data-paired-capsule="pairedTerminals.forSlot(item.slot.id)?.surfaceId"
        tabindex="0"
        :aria-label="item.slot.title"
        aria-description="Press Ctrl+Shift+F6 to leave terminal input and focus the deck controls."
        @pointerdown.capture="onTilePointerDown(item.slot.id, $event)"
        @mousedown.capture="onTilePointerDown(item.slot.id, $event)"
        @focus="focusSlot(item.slot.id)"
        @contextmenu.prevent="onTileContextMenu(item.slot.id, $event)"
        @keydown="onTileKeyDown(item.slot.id, $event)"
      >
        <header class="mv-terminal-deck__tile-header">
          <span class="mv-terminal-deck__tile-title">{{ pairedTerminals.forSlot(item.slot.id)?.title ?? item.slot.title }}<template v-if="pairedTerminals.forSlot(item.slot.id)"> · {{ pairedTerminalLabel(item.slot.id) }}</template></span>
          <span
            v-if="item.slot.status === 'exited' || item.slot.status === 'restored'"
            :id="domId(`terminal-deck-status-${item.slot.id}`)"
            :data-semantic-anchor="`terminal/tile/${item.slot.id}/status`"
            class="mv-terminal-deck__tile-status"
            role="status"
          >{{ item.slot.status }}</span>
          <div class="mv-terminal-deck__tile-controls">
            <button
              v-if="item.slot.status === 'restored' || item.slot.status === 'exited'"
              type="button"
              :id="domId(`terminal-deck-restart-${item.slot.id}`)"
              :data-semantic-anchor="`terminal/tile/${item.slot.id}/restart`"
              class="mv-terminal-deck__tile-restart"
              @click.stop="onRestartSlot(item.slot.id)"
            >Restart</button>
            <button
              type="button"
              :id="domId(`terminal-deck-close-${item.slot.id}`)"
              :data-semantic-anchor="`terminal/tile/${item.slot.id}/close`"
              class="mv-terminal-deck__tile-close"
              :aria-label="`Close ${item.slot.title}`"
              @click.stop="onRequestClose(item.slot.id)"
            >✕</button>
          </div>
        </header>

        <div class="mv-terminal-deck__tile-body">
          <div
            :id="domId(`terminal-deck-viewport-${item.slot.id}`)"
            :ref="(el) => setViewportRef(item.slot.id, el)"
            :data-semantic-anchor="`terminal/tile/${item.slot.id}/viewport`"
            class="mv-terminal-deck__viewport"
            @mousemove.capture="onTerminalMouseMove"
            title="Drag to select; hold Shift when an app captures the mouse. Ctrl+Shift+C copies."
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
      :id="domId('terminal-deck-context-menu')"
      data-semantic-anchor="terminal/context-menu"
      data-mv-overlay-scope="terminal"
      class="mv-terminal-deck__context-menu"
      role="menu"
      aria-label="Terminal context menu"
      :style="contextMenuStyle"
      @keydown.esc.stop.prevent="closeContextMenu"
    >
      <button
        type="button"
        :id="domId('terminal-deck-context-copy')"
        data-semantic-anchor="terminal/context-menu/copy"
        class="mv-terminal-deck__context-item"
        role="menuitem"
        :disabled="!contextMenu.hasSelection"
        :aria-disabled="!contextMenu.hasSelection"
        @click.stop="onContextMenuCopy"
      >Copy</button>
      <button
        type="button"
        :id="domId('terminal-deck-context-paste')"
        data-semantic-anchor="terminal/context-menu/paste"
        class="mv-terminal-deck__context-item"
        role="menuitem"
        @click.stop="onContextMenuPaste"
      >Paste</button>
    </div>

    <div
      v-if="pendingCloseSlotId"
      :id="domId('terminal-deck-confirm-close')"
      ref="closeDialog"
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
            :id="domId('terminal-deck-confirm-close-yes')"
            data-semantic-anchor="terminal/confirm-close/confirm"
            class="mv-terminal-deck__action-btn mv-terminal-deck__action-btn--primary"
            @click="onConfirmClose"
          >Close terminal</button>
          <button
            type="button"
            :id="domId('terminal-deck-confirm-close-no')"
            data-semantic-anchor="terminal/confirm-close/cancel"
            class="mv-terminal-deck__action-btn"
            @click="onCancelClose"
          >Cancel</button>
        </div>
      </div>
    </div>
  </div>
</template>

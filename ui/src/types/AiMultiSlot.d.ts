import type { DefineComponent } from 'vue';
/** Consumer boundary for the shipped kit SFC; runtime remains the vendored module. */
export interface AiMultiSlotProps {
  capsuleId: string;
  capsuleLabel?: string;
  attachSide?: string;
  folded?: boolean;
  surfaceHidden?: boolean;
  terminalHidden?: boolean;
  floating?: boolean;
  surfaceState?: string;
  inputMode?: string;
  sessions?: Array<{ sessionId: string; title?: string; kind?: string; activity?: string }>;
  selectedSessionId?: string;
  attachmentState?: string;
  activityState?: string;
  hasControlLease?: boolean;
  streamRegistry?: import('../multislot/multislotAttach.js').MultislotRegistryLike;
  epoch?: number;
  generation?: number;
  providers?: Array<{ id: string; label: string; hint: string; argv: readonly string[]; command?: string }>;
  commands?: string[];
  launching?: boolean;
}
declare const component: DefineComponent<AiMultiSlotProps>;
export default component;

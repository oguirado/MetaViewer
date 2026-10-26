import type { DefineComponent } from 'vue';
export interface AiSlotControlBarProps {
  capsuleId: string;
  capsuleLabel?: string;
  inputMode?: string;
  copyState?: string;
  surfaceVisible?: boolean;
  terminalVisible?: boolean;
  folded?: boolean;
  floating?: boolean;
}
declare const component: DefineComponent<AiSlotControlBarProps>;
export default component;

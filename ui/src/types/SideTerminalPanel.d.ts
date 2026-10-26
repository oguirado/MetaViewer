import type { DefineComponent } from 'vue';
export interface SideTerminalPanelProps {
  facade?: ReturnType<typeof import('../terminal/sideTerminalFacade.js').createSideTerminalFacade>;
  providers?: Array<{ id: string; label: string; hint: string; argv: readonly string[]; command?: string }>;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  open?: boolean | null;
  topOffset?: number;
  bottomOffset?: number;
}
declare const component: DefineComponent<SideTerminalPanelProps>;
export default component;

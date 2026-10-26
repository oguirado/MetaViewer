export { default } from '../../.kit/capsule-ui-kit/types/TerminalView.js';
export function createStreamRegistry(options?: {
  TerminalClass?: unknown;
  FitAddonClass?: unknown;
  onSendAuthorizedPtyInput?: (payload: { sessionId: string; epoch: number; attachmentId: string; inputSeq: number; data: string }) => void;
}): import('../multislot/multislotAttach.js').MultislotRegistryLike;

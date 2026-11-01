// @ts-check
/** Identities owned by other projects or the live launcher must never be deleted.
 * Keep in sync with tools/mv_identity.py protected_identity. */
const PROTECTED = new Set(['srf-id-cuentas-1', 'srf-id-perplexity-1', 'srf-pg-notepad-1',
  'srf-pg-metaviewer-1', 'srf-egress-proxy', 'n8n', 'distil-box']);
/** @param {string} id */
export function isProtectedIdentity(id) {
  return /^(mv-|cuentas-|perplexity-|srf-id-cuentas-|srf-id-perplexity-|srf-pg-)/.test(id) || PROTECTED.has(id);
}

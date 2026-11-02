// @ts-check
/** Identities owned by other projects or the live launcher must never be deleted.
 * Keep in sync with tools/mv_identity.py protected_identity. */
export const PROTECTED_HOLDERS = new Set(['srf-id-cuentas-1', 'srf-id-perplexity-1', 'srf-pg-notepad-1',
  'srf-pg-metaviewer-1', 'srf-egress-proxy', 'n8n', 'distil-box']);
export const FOREIGN_PREFIXES = Object.freeze(['cuentas-', 'perplexity-', 'srf-id-cuentas-', 'srf-id-perplexity-', 'srf-pg-']);
/** @param {string} id */
export function isForeignIdentity(id) {
  return FOREIGN_PREFIXES.some(prefix => id.startsWith(prefix)) || PROTECTED_HOLDERS.has(id);
}
/** @param {string} id */
export function isProtectedIdentity(id) {
  return id.startsWith('mv-') || isForeignIdentity(id);
}

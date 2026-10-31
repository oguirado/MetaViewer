// @ts-check
/** Pure form rules for the Identities dialog. They mirror the closed host
 * validation in electron/preload.js so a typo is explained before the request
 * is sent instead of surfacing as a bare OPERATOR_PAYLOAD. */
const DOMAIN = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

/** Split a comma-separated field into trimmed, lower-case, unique hostnames.
 * Empty entries (for example a trailing comma) are dropped.
 * @param {string} text @returns {string[]} */
export function normalizeDomains(text) {
  const seen = new Set();
  for (const part of String(text).split(',')) {
    const domain = part.trim().toLowerCase();
    if (domain) seen.add(domain);
  }
  return [...seen];
}

/** @param {string[]} domains */
export function validDomains(domains) {
  return domains.length > 0 && domains.length <= 256
    && domains.every(d => d.length <= 253 && DOMAIN.test(d));
}

/** @param {string} label */
export function validLabel(label) {
  return label.length > 0 && [...label].length <= 128 && label === label.trim()
    && !/[\x00-\x1f\x7f;`$|&<>\\]/.test(label);
}

/** Operator-facing text for a typed host code. Every text keeps the raw code.
 * @param {string} code @param {string} [id] */
export function identityErrorText(code, id) {
  const target = typeof id === 'string' && /^[a-z0-9][a-z0-9-]{1,39}$/.test(id) ? id : '<id>';
  if (code === 'PROFILE_NOT_PROVISIONED') {
    return `The identity profile is not provisioned for the native browser capsule: PROFILE_NOT_PROVISIONED. Before login, profiles/<id> must be a private 0700 directory owned by uid 10001; run once on the host: sudo install -d -m 0700 -o 10001 -g 10001 "$SRF_IDENTITY_STORE_ROOT/profiles/${target}" (see docs/INSTALL.md#identity-store).`;
  }
  if (code === 'PROFILE_MISSING') {
    return `The identity profile directory is missing: PROFILE_MISSING. Before login, create profiles/<id> as a private 0700 directory owned by uid 10001; run once on the host: sudo install -d -m 0700 -o 10001 -g 10001 "$SRF_IDENTITY_STORE_ROOT/profiles/${target}" (see docs/INSTALL.md#identity-store).`;
  }
  if (code === 'IDENTITY_REFUSED') {
    return 'The identity tool refused the request: IDENTITY_REFUSED. The identity may be in use by a running capsule or an open login view, or a native prerequisite is missing (profile directory private and owned by the native uid).';
  }
  if (code === 'OPERATOR_PAYLOAD') {
    return 'The identity request was refused before it reached the tool: OPERATOR_PAYLOAD. Check the id, label and domains.';
  }
  if (code === 'IDENTITY_UNAVAILABLE') {
    return 'The identity tool could not run: IDENTITY_UNAVAILABLE. Check that MV_SRF_BIN_DIR, MV_SRF_STATE_DIR and SRF_IDENTITY_STORE_ROOT are set for MetaViewer and that MV_OPERATOR_REPO names a checkout with tools/mv_identity.py.';
  }
  return `The identity tool could not run: ${code || 'AUSENTE — no reason supplied'}`;
}

import {isProtectedIdentity} from '../../electron/identityProtection.js';
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
  return [...seen].sort();
}

/** @param {string[]} domains */
export function validDomains(domains) {
  return domains.length <= 16
    && domains.every(d => d.length <= 253 && DOMAIN.test(d));
}

/** @param {string} label */
export function validLabel(label) {
  return label.length > 0 && [...label].length <= 128 && label === label.trim()
    && !/[\x00-\x1f\x7f;`$|&<>\\]/.test(label);
}

/** @param {string} text */
export function normalizeIdentityName(text) {
  return String(text).toLowerCase().replace(/\s/g, '-').replace(/[^a-z0-9-]/g, '');
}

/** Preserve the original spelling of unchanged characters while the input
 * displays its normalized id. This also handles edits in the middle.
 * @param {string} previous @param {string} incoming */
export function retainTypedIdentityName(previous, incoming) {
  const old = normalizeIdentityName(previous);
  let prefix = 0, suffix = 0;
  while (prefix < old.length && prefix < incoming.length && old[prefix] === incoming[prefix]) prefix++;
  while (suffix < old.length - prefix && suffix < incoming.length - prefix
    && old[old.length - 1 - suffix] === incoming[incoming.length - 1 - suffix]) suffix++;
  const chars = [...previous];
  const boundary = (/** @type {number} */ count) => {
    if (count === old.length) return chars.length;
    let seen = 0;
    for (let i = 0; i < chars.length; i++) {
      if (seen === count) return i;
      seen += normalizeIdentityName(chars[i]).length;
    }
    return chars.length;
  };
  return chars.slice(0, boundary(prefix)).join('') + incoming.slice(prefix, incoming.length - suffix)
    + (suffix ? chars.slice(boundary(old.length - suffix)).join('') : '');
}

/** @param {string} name */
export function validIdentityName(name) {
  return /^[a-z0-9][a-z0-9-]{1,39}$/.test(name) && !isProtectedIdentity(name);
}

/** @param {string} name @param {string} displayName @param {string} sites */
export function identityFormRequest(name, displayName, sites) {
  const label = displayName.trim() || name;
  const domains = normalizeDomains(sites);
  if (!validIdentityName(name) || !validLabel(label) || !validDomains(domains)) return null;
  return {id:name,label,domains};
}

/** Operator-facing text for a typed host code. Every text keeps the raw code.
 * @param {string} code @param {string} [id] */
export function identityErrorText(code, id) {
  const target = typeof id === 'string' && /^[a-z0-9][a-z0-9-]{1,39}$/.test(id) ? id : '<id>';
  if (code === 'IDENTITY_PROTECTED') return 'Managed outside MetaViewer (IDENTITY_PROTECTED).';
  if (code === 'IDENTITY_BOUND') return 'This identity has an open capsule. Stop it first, then delete it.';
  if (code === 'PROFILE_NOT_PROVISIONED' || code === 'PROFILE_MISSING') {
    return `Docker profile provisioning failed: ${code}. profiles/<id> must be private 0700 owned by uid 10001. Check Docker access and the installed judge images, then retry identity creation for "${target}" (see docs/INSTALL.md#identity-store).`;
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

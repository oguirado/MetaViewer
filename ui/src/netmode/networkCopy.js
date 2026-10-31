// Pure copy and input rules for the per-capsule Network panel.
// [TARGET, unit decision] The hostname rules mirror exactEgressHost/validEgress in
// electron/preload.js (the host stays authoritative); a parity test pins both.

/** @type {Record<string,string>} */
const reasonWords = {
  binary_missing: 'capability binary missing',
  timeout: 'capability probe timed out',
  oversize: 'capability reply too large',
  malformed: 'invalid capability reply',
  legacy_binary: 'legacy (binary has no network modes)',
  ok: 'Open unavailable in declared network modes',
};

/** @type {Record<string,string>} */
const reasonCauses = {
  legacy_binary: 'The installed OpenSuperficies binary answers capabilities v1 without net_modes, so it predates network modes.',
  binary_missing: 'The OpenSuperficies capability binary was not found when MetaViewer started.',
  timeout: 'The capability probe did not answer in time when MetaViewer started.',
  oversize: 'The capability probe answered with more data than allowed when MetaViewer started.',
  malformed: 'The capability probe answered with something MetaViewer does not recognise.',
  ok: 'The binary declares its network modes, but not the one this choice needs.',
};

/** @param {string} value */
export function plainReason(value) {
  return reasonWords[value] ?? (/^exit_/.test(value) ? `capability probe exited with status ${value.slice(5)}` : 'capability probe unavailable');
}

/** @param {string} reason Host probe reason. */
function causeOf(reason) {
  return reasonCauses[reason] ?? (/^exit_/.test(reason)
    ? `The capability probe exited with status ${reason.slice(5)} when MetaViewer started.`
    : 'The capability probe was unavailable when MetaViewer started.');
}

/**
 * Why the panel is in legacy mode, what that means for the capsule, and what
 * Open and Dedicated proxy each need. Never exposes the raw probe token.
 * @param {string} reason Host probe reason.
 * @returns {string}
 */
export function legacyExplanation(reason) {
  const cause = causeOf(reason);
  return `Legacy network mode. ${cause} This capsule keeps starting with the unrestricted network it always had, and no network mode is enforced. `
    + 'Open as an explicit mode needs identity image 0.2.0 and the final OpenSuperficies pin (morning report, step 0). '
    + 'Dedicated proxy needs a binary that lists proxied among its network modes; until then an allowlist cannot be saved.';
}

/**
 * Warning for a stored Dedicated proxy record that the binary cannot enforce:
 * the adapter refuses the next start with NET_PROXIED_UNSUPPORTED.
 */
export const storedAllowlistWarning = 'The stored record for this capsule is a Dedicated proxy allowlist, but this binary cannot enforce one, so the next start will be refused (NET_PROXIED_UNSUPPORTED). Choose Open and save it to recover.';

/**
 * Typed host refusal to operator-facing text; nothing is ever swallowed.
 * @param {unknown} code
 * @param {string=} legacyReason Probe reason when the capsule is in legacy mode.
 * @returns {string}
 */
export function refusalText(code, legacyReason) {
  switch (code) {
    case 'NET_PROXIED_UNSUPPORTED': return 'NET_PROXIED_UNSUPPORTED: Dedicated proxy requires a deployment with proxied network support.';
    case 'NET_OPEN_PREREQ': return 'NET_OPEN_PREREQ: Open requires identity image 0.2.0 and the final OpenSuperficies pin (morning report, step 0).'
      + (legacyReason === undefined ? '' : ` ${causeOf(legacyReason)} Open is already how a legacy capsule starts, so confirming only records the choice for a future start.`);
    case 'NET_EGRESS_IO': return 'NET_EGRESS_IO: The network record for this capsule could not be read or written (private adapter state missing, wrong permissions or a malformed record). The saved record may be unchanged.';
    case 'NET_EGRESS_INVALID': return 'NET_EGRESS_INVALID: The adapter rejected the network record.';
    default: return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,47}$/.test(code) ? `Network configuration unavailable (${code}).` : 'Network configuration unavailable.';
  }
}

/**
 * @param {unknown} host
 * @param {string} method
 */
export function hostHasEgress(host, method) {
  return typeof (/** @type {any} */ (host)?.egress)?.[method] === 'function';
}

/**
 * @param {unknown} h
 * @returns {boolean}
 */
export function exactHostname(h) {
  return typeof h === 'string' && h.length <= 253 && h.includes('.') && /[a-z]/.test(h)
    && !/(^|\.)(localhost|local|internal|lan|home\.arpa)$/.test(h)
    && h.split('.').every((x) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(x) && !/^0x[0-9a-f]*$/.test(x));
}

/**
 * Split the single-line allowlist field into lowercase, de-duplicated names.
 * @param {string} text
 * @returns {string[]}
 */
export function parseAllowlist(text) {
  return [...new Set(text.split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))];
}

/**
 * Local pre-flight so a bad list is named, not reported as a missing identity.
 * @param {string[]} domains
 * @returns {string} Empty when valid.
 */
export function allowlistProblem(domains) {
  if (domains.length < 1) return 'Enter at least one exact hostname for the allowlist (1–256).';
  if (domains.length > 256) return 'The allowlist holds at most 256 hostnames.';
  const bad = domains.find((d) => !exactHostname(d));
  return bad === undefined ? '' : `Not an exact hostname: ${bad.length > 64 ? `${bad.slice(0, 64)}…` : bad}. Use full names such as example.com (no wildcards, addresses or local names).`;
}

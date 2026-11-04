// Compile-time compatibility overlay for the pinned kit. Do not alter its
// materialized source or pin. Fail closed if an upgrade changes these anchors.
/** @param {string} source */
export function kitQuarantineReason(source) {
  const replacements = [
    ["const quarantineReason = ref('');", "const quarantineReason = ref('LAYOUT_RESTORE_PENDING');"],
    ["quarantineReason.value = st.quarantineReason ?? '';",
      "quarantineReason.value = [st.quarantineCode || (['uninitialized','restoring'].includes(st.restorePhase) ? 'LAYOUT_RESTORE_PENDING' : 'LAYOUT_READ_ONLY'), st.quarantineReason].filter(value => typeof value === 'string' && value.trim()).join(': ');"],
  ];
  for (const [before, after] of replacements) {
    if (source.split(before).length !== 2) throw Error('KIT_QUARANTINE_OVERLAY_DRIFT');
    source = source.replace(before, after);
  }
  return source;
}

/** Keep Chromium's hidden nonce attribute compatible with its nonce property.
 * @param {string} source */
export function kitGeometryNonce(source) {
  const before = "if (existing) return existing.getAttribute('nonce') === nonce ? existing : null;";
  const after = "if (existing) return (existing.nonce || existing.getAttribute('nonce')) === nonce ? existing : null;";
  if (source.split(before).length !== 2) throw Error('KIT_GEOMETRY_NONCE_OVERLAY_DRIFT');
  return source.replace(before, after);
}

export function kitQuarantineReasonPlugin() {
  return {
    name:'metaviewer-kit-quarantine-reason', enforce:'pre',
    /** @param {string} source @param {string} id */
    transform(source, id) {
      const path = id.replaceAll('\\','/');
      if (path.endsWith('/.kit/capsule-ui-kit/src/workspace/DockWorkspace.vue')) return kitQuarantineReason(source);
      if (path.endsWith('/.kit/capsule-ui-kit/src/workspace/kitGeometrySheet.js')) return kitGeometryNonce(source);
    },
  };
}

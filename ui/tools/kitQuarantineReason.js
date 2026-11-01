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

export function kitQuarantineReasonPlugin() {
  return {
    name:'metaviewer-kit-quarantine-reason', enforce:'pre',
    /** @param {string} source @param {string} id */
    transform(source, id) {
      if (id.replaceAll('\\','/').endsWith('/.kit/capsule-ui-kit/src/workspace/DockWorkspace.vue')) return kitQuarantineReason(source);
    },
  };
}

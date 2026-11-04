import assert from 'node:assert/strict';

// Strip only the capability-gated paired control after checking its complete
// identity/action contract. Remaining legacy markup keeps its original pins.
export function withoutPairedTerminalControl(template) {
  const controls=template.match(/<button\b[^>]*class="mv-tile-terminal-toggle"[^>]*>[^<]*<\/button>/g) ?? [];
  assert.equal(controls.length,1,'exactly one paired terminal control');
  const control=controls[0];
  for (const attribute of [
    'v-if="!props.displayOnly && capsuleTerminal?.available()"', 'type="button"',
    ':id="`tile-terminal-${props.capsuleId}`"',
    ':data-semantic-anchor="`capsule/${props.capsuleId}/terminal`"',
    ':aria-label="`Terminal for ${props.title}`"',
    ':aria-expanded="capsuleTerminal.isOpen(props.capsuleId)"',
    '@click.stop="capsuleTerminal.toggle(props.capsuleId)"',
  ]) assert.ok(control.includes(attribute),`paired terminal keeps ${attribute}`);
  assert.doesNotMatch(control,/style=|tabindex|onclick=/);
  return template.replace(control,'');
}

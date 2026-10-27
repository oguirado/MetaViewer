// Linux proc parsing shared by the live instrument and offline regression cases.
export function statFields(text) {
  const end = text.lastIndexOf(') ');
  if (end < 0) throw new Error('Malformed proc stat');
  const fields = text.slice(end + 2).trim().split(/\s+/);
  if (fields.length < 22 || !/^\d+$/.test(fields[19])) throw new Error('Truncated proc stat');
  return fields;
}

export function classifyRole(pid, mainPid, command) {
  if (pid === mainPid) return 'main';
  const words = command.replaceAll('\0', ' ');
  if (/(?:^|\s)--type=renderer(?:\s|$)/.test(words)) return 'renderer';
  if (/(?:^|\s)--type=utility(?:\s|$)/.test(words)) return 'utility';
  return 'helper';
}

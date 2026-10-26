/**
 * Provider menu normalization for the MetaViewer side terminal.
 *
 * Pure renderer-importable module: no filesystem, PATH probing, IPC or
 * spawning. Entries carry server-owned argv for validation only; executable
 * resolution and spawning stay host-side in the ptyBroker lane, and the menu
 * hands the consumer reference-only entries (never argv, exe, cwd or env).
 * This module validates host-owned entries; it ships no executable paths.
 *
 * @module terminal/providers
 */

/** Maximum provider entries in one map. */
export const MAX_PROVIDERS = 32;

/** Maximum argv elements of a configured provider (executable plus 32 args). */
export const MAX_ARGV_LENGTH = 33;

/** Maximum UTF-8 bytes per configured argv element. */
export const MAX_ARG_BYTES = 4096;

/** Maximum total argv elements from the custom dialog (executable included). */
export const CUSTOM_MAX_ARGV = 32;

/** Maximum UTF-8 bytes per custom argv element. */
export const CUSTOM_MAX_ARG_BYTES = 4096;

/** Broker command that opens the interactive login shell. */
export const SHELL_COMMAND = 'shell';

/** Default broker command for provider entries. */
export const PROVIDER_COMMAND = 'provider';

/** Closed provider-id grammar. */
export const PROVIDER_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Fixed first menu entry: the interactive login shell. argv stays empty here;
 * the host spawns its own login shell for command 'shell'.
 */
export const SYSTEM_SHELL_ENTRY = Object.freeze({
  id: SHELL_COMMAND,
  label: 'System shell',
  hint: 'Interactive login shell',
  argv: /** @type {readonly string[]} */ (Object.freeze([])),
  command: SHELL_COMMAND,
});

/**
 * A validated provider entry. argv holds the server-owned executable plus
 * args; the renderer never invents it and the menu never forwards it.
 *
 * @typedef {object} ProviderEntry
 * @property {string} id Closed-grammar id; never 'shell' or 'provider'.
 * @property {string} label Trimmed non-empty display label.
 * @property {string} hint Secondary description, kept verbatim.
 * @property {readonly string[]} argv Server-owned executable plus args.
 * @property {'shell'|'provider'|undefined} command Broker command override.
 */

/**
 * Host-reported availability of one provider id.
 *
 * @typedef {object} ProviderCapability
 * @property {string} id Provider or shell id this status applies to.
 * @property {boolean} available Whether the broker can launch it now.
 * @property {string} reason Human-readable cause when unavailable.
 */

/**
 * Reference-only menu row: launch needs an explicit consumer action that
 * resolves the id host-side. No argv, exe, cwd or env crosses the boundary.
 *
 * @typedef {object} MenuEntry
 * @property {string} id Entry id to launch by reference.
 * @property {string} label Display label.
 * @property {string} hint Secondary description.
 * @property {'shell'|'provider'} command Broker command for this row.
 * @property {boolean} disabled True unless a positive capability covers the id.
 */

const ENTRY_KEYS = new Set(['id', 'label', 'hint', 'argv', 'command']);
const RESERVED_IDS = new Set([SHELL_COMMAND, PROVIDER_COMMAND]);
// TextEncoder (not Buffer) so this module stays renderer-importable.
const encoder = new TextEncoder();

/**
 * @param {string} value
 * @returns {number} UTF-8 byte length of value.
 */
function utf8Length(value) {
  return encoder.encode(value).length;
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function asRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('expected an object');
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * Validates a configured provider argv (executable plus args).
 *
 * @param {unknown} argv Candidate executable plus arguments.
 * @returns {readonly string[]} Frozen copy of the validated argv.
 */
export function validateProviderArgv(argv) {
  if (!Array.isArray(argv)) throw new TypeError('argv must be an array');
  if (argv.length === 0 || argv.length > MAX_ARGV_LENGTH) {
    throw new RangeError(`argv length must be 1..${MAX_ARGV_LENGTH}`);
  }
  for (const item of argv) {
    if (typeof item !== 'string') throw new TypeError('argv items must be strings');
    if (item.includes('\0')) throw new TypeError('argv items must not contain NUL');
    if (utf8Length(item) > MAX_ARG_BYTES) {
      throw new RangeError(`argv item exceeds ${MAX_ARG_BYTES} bytes`);
    }
  }
  const head = argv[0];
  if (typeof head !== 'string' || head.length === 0) {
    throw new TypeError('argv[0] must be a non-empty string');
  }
  if (head.startsWith('-')) throw new TypeError('argv[0] must not start with a dash');
  return Object.freeze([...argv]);
}

/**
 * Normalizes a closed provider map. Strict: unknown keys, malformed fields,
 * duplicates and reserved ids throw instead of being filtered out.
 *
 * @param {unknown} entries Candidate provider entries.
 * @returns {readonly ProviderEntry[]} Frozen array of frozen deep copies.
 */
export function normalizeProviders(entries) {
  if (!Array.isArray(entries)) throw new TypeError('entries must be an array');
  if (entries.length > MAX_PROVIDERS) {
    throw new RangeError(`at most ${MAX_PROVIDERS} provider entries`);
  }
  const seen = new Set();
  /** @type {ProviderEntry[]} */
  const out = [];
  for (const raw of entries) {
    const record = asRecord(raw);
    for (const key of Object.keys(record)) {
      if (!ENTRY_KEYS.has(key)) throw new TypeError(`unexpected provider key: ${key}`);
    }
    const idRaw = record.id;
    if (typeof idRaw !== 'string') throw new TypeError('provider id must be a string');
    const id = idRaw.trim();
    if (!PROVIDER_ID_RE.test(id)) throw new TypeError('provider id is malformed');
    if (RESERVED_IDS.has(id)) throw new RangeError('provider id is reserved');
    if (seen.has(id)) throw new RangeError('duplicate provider id');
    seen.add(id);
    const labelRaw = record.label;
    if (typeof labelRaw !== 'string') throw new TypeError('provider label must be a string');
    const label = labelRaw.trim();
    if (label.length === 0) throw new TypeError('provider label must be non-empty');
    const hint = record.hint;
    if (typeof hint !== 'string') throw new TypeError('provider hint must be a string');
    const argv = validateProviderArgv(record.argv);
    /** @type {'shell'|'provider'|undefined} */
    let command;
    const commandRaw = record.command;
    if (commandRaw !== undefined) {
      if (commandRaw === SHELL_COMMAND) command = SHELL_COMMAND;
      else if (commandRaw === PROVIDER_COMMAND) command = PROVIDER_COMMAND;
      else throw new TypeError('provider command must be shell or provider');
    }
    out.push(Object.freeze({ id, label, hint, argv, command }));
  }
  return Object.freeze(out);
}

/**
 * Parses the custom dialog fields into a validated argv array. Splits the
 * argument text on whitespace runs only: no quoting, escapes or shell
 * evaluation, so quotes and metacharacters stay literal.
 *
 * @param {unknown} executable Executable field; trimmed, never split.
 * @param {unknown} argumentText Free-form argument text.
 * @returns {{argv: readonly string[] | null, error: string}} Frozen argv and
 * empty error on success; null argv and a message otherwise.
 */
export function parseCustomArgv(executable, argumentText) {
  if (typeof executable !== 'string') return { argv: null, error: 'Enter an executable.' };
  const head = executable.trim();
  if (head.length === 0) return { argv: null, error: 'Enter an executable.' };
  if (head.startsWith('-')) return { argv: null, error: 'The executable must not start with a dash.' };
  if (typeof argumentText !== 'string') return { argv: null, error: 'Arguments must be text.' };
  const rest = argumentText.trim().length === 0 ? [] : argumentText.trim().split(/\s+/);
  const argv = [head, ...rest];
  if (argv.length > CUSTOM_MAX_ARGV) {
    return { argv: null, error: `Too many arguments (at most ${CUSTOM_MAX_ARGV}).` };
  }
  for (const arg of argv) {
    if (arg.includes('\0')) return { argv: null, error: 'Arguments must not contain null bytes.' };
    if (utf8Length(arg) > CUSTOM_MAX_ARG_BYTES) {
      return { argv: null, error: 'One argument exceeds the size limit.' };
    }
  }
  return { argv: Object.freeze(argv), error: '' };
}

/**
 * Builds the inert launch menu: synthetic shell row first, then one
 * reference-only row per entry. Rows without a positive capability are
 * disabled. Unknown capability ids are ignored.
 *
 * @param {unknown} entries Normalized provider entries.
 * @param {unknown} capabilities Host-reported availability per id.
 * @returns {readonly MenuEntry[]} Frozen menu rows; launch needs an explicit
 * consumer action per row.
 */
export function createProviderMenu(entries, capabilities) {
  if (!Array.isArray(entries)) throw new TypeError('entries must be an array');
  if (!Array.isArray(capabilities)) throw new TypeError('capabilities must be an array');
  /** @type {Map<string, boolean>} */
  const available = new Map();
  for (const raw of capabilities) {
    const cap = asRecord(raw);
    if (typeof cap.id !== 'string' || cap.id.length === 0) {
      throw new TypeError('capability id must be a non-empty string');
    }
    if (typeof cap.available !== 'boolean') {
      throw new TypeError('capability available must be a boolean');
    }
    if (typeof cap.reason !== 'string') throw new TypeError('capability reason must be a string');
    available.set(cap.id, cap.available);
  }
  /** @type {MenuEntry[]} */
  const menu = [
    Object.freeze({
      id: SYSTEM_SHELL_ENTRY.id,
      label: SYSTEM_SHELL_ENTRY.label,
      hint: SYSTEM_SHELL_ENTRY.hint,
      command: SHELL_COMMAND,
      disabled: available.get(SHELL_COMMAND) === false,
    }),
  ];
  for (const raw of entries) {
    const record = asRecord(raw);
    if (typeof record.id !== 'string' || record.id.length === 0) {
      throw new TypeError('menu entry id must be a non-empty string');
    }
    if (RESERVED_IDS.has(record.id)) throw new TypeError('menu entry id is reserved');
    if (typeof record.label !== 'string' || record.label.length === 0) {
      throw new TypeError('menu entry label must be a non-empty string');
    }
    if (typeof record.hint !== 'string') throw new TypeError('menu entry hint must be a string');
    /** @type {'shell'|'provider'} */
    let command = PROVIDER_COMMAND;
    const commandRaw = record.command;
    if (commandRaw !== undefined) {
      if (commandRaw === SHELL_COMMAND) command = SHELL_COMMAND;
      else if (commandRaw === PROVIDER_COMMAND) command = PROVIDER_COMMAND;
      else throw new TypeError('menu entry command must be shell or provider');
    }
    const positive = available.get(record.id) === true;
    menu.push(
      Object.freeze({
        id: record.id,
        label: record.label,
        hint: record.hint,
        command,
        disabled: !positive,
      }),
    );
  }
  return Object.freeze(menu);
}

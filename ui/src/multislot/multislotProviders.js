/**
 * Provider-menu adapter for the MetaViewer multislot and side terminal.
 *
 * Pure renderer module: no DOM, no framework, no executable paths. Provider
 * identities, labels and server-owned argv arrive from the host; the renderer
 * never invents them and never resolves executables. Entries are validated
 * with the renderer `terminal/providers` contract and mapped onto the kit
 * `SideTerminalNewMenu` entry shape (`{id,label,hint,argv,command}`), which
 * both the kit side-terminal panel and the kit multislot terminal pane
 * consume. Launch requests coming back from the kit menu are validated here
 * so refusals surface as typed rows instead of raw broker errors.
 *
 * @module multislot/multislotProviders
 */
import {
  CUSTOM_MAX_ARG_BYTES,
  CUSTOM_MAX_ARGV,
  MAX_PROVIDERS,
  PROVIDER_COMMAND,
  PROVIDER_ID_RE,
  SHELL_COMMAND,
  SYSTEM_SHELL_ENTRY,
  normalizeProviders,
  parseCustomArgv,
} from '../terminal/providers.js';

/**
 * Maximum launch args of one menu commit. Mirrors the kit
 * `createSideTerminalModel().launch` guard (`args.length > 32` refuses).
 */
export const LAUNCH_MAX_ARGS = 32;

/**
 * Maximum UTF-8 bytes per launch arg. Mirrors the kit launch guard
 * (`TextEncoder().encode(x).length > 4096` refuses).
 */
export const LAUNCH_MAX_ARG_BYTES = 4096;

/** Menu entry id the kit custom-executable dialog commits with. */
export const CUSTOM_LAUNCH_ENTRY_ID = 'custom';

/** Typed launch-refusal codes surfaced as designed rows. */
export const LAUNCH_REFUSALS = Object.freeze({
  COMMAND_UNAVAILABLE: 'ERR_LAUNCH_COMMAND_UNAVAILABLE',
  ENTRY_UNKNOWN: 'ERR_LAUNCH_ENTRY_UNKNOWN',
  ARGV_REJECTED: 'ERR_LAUNCH_ARGV_REJECTED',
  NO_BROKER: 'ERR_LAUNCH_NO_BROKER',
});

/** Typed refusal when host provider data fails validation (shell-only menu). */
export const PROVIDER_DATA_REFUSAL = 'ERR_PROVIDER_DATA_REJECTED';

const textEncoder = new TextEncoder();

/**
 * @param {string} value
 * @returns {number} UTF-8 byte length of value.
 */
function utf8Length(value) {
  return textEncoder.encode(value).length;
}

/**
 * Maps host-owned provider entries onto kit menu entries. The fixed system
 * shell row comes first, then one row per validated host entry preserving
 * the host-owned argv verbatim (frozen copies; the renderer never invents
 * argv). Strict: malformed host data throws the `terminal/providers` typed
 * errors instead of rendering a partial menu.
 *
 * @param {unknown} hostEntries Candidate host-owned provider entries.
 * @returns {ReadonlyArray<Readonly<{ id: string, label: string, hint: string, argv: readonly string[], command: string | undefined }>>}
 * Frozen kit menu entries.
 */
export function toKitMenuProviders(hostEntries) {
  const entries = hostEntries === undefined ? [] : hostEntries;
  const normalized = normalizeProviders(entries);
  /** @type {Array<Readonly<{ id: string, label: string, hint: string, argv: readonly string[], command: string | undefined }>>} */
  const menu = [
    Object.freeze({
      id: SYSTEM_SHELL_ENTRY.id,
      label: SYSTEM_SHELL_ENTRY.label,
      hint: SYSTEM_SHELL_ENTRY.hint,
      argv: SYSTEM_SHELL_ENTRY.argv,
      command: SHELL_COMMAND,
    }),
  ];
  for (const entry of normalized) {
    menu.push(
      Object.freeze({
        id: entry.id,
        label: entry.label,
        hint: entry.hint,
        argv: entry.argv,
        command: entry.command,
      }),
    );
  }
  return Object.freeze(menu);
}

/**
 * Maps a fixed-API provider listing onto kit menu entries. Listing rows
 * are reference-only (`{id,label,hint}`, no argv): each admitted row maps
 * with an empty argv vector (the renderer never invents argv) and the
 * provider command, so launches resolve the id host-side with empty args.
 * The fixed system shell row comes first. Rows with an explicit negative
 * capability (`available: false`) are excluded: the kit menu gates by
 * command only and cannot disable single rows, so unavailable providers
 * stay out of the menu instead of launching into a certain refusal.
 * Strict: malformed rows, duplicates, reserved ids and malformed
 * capabilities throw instead of rendering a partial menu.
 *
 * @param {unknown} listingEntries Candidate listing rows.
 * @param {unknown} listingCapabilities Candidate host-reported availability.
 * @returns {ReadonlyArray<Readonly<{ id: string, label: string, hint: string, argv: readonly string[], command: string | undefined }>>}
 * Frozen kit menu entries.
 */
export function toKitMenuProvidersFromListing(listingEntries, listingCapabilities) {
  if (!Array.isArray(listingEntries)) throw new TypeError('listing entries must be an array');
  if (!Array.isArray(listingCapabilities)) throw new TypeError('listing capabilities must be an array');
  if (listingEntries.length > MAX_PROVIDERS) {
    throw new RangeError(`at most ${MAX_PROVIDERS} listing entries`);
  }
  /** @type {Map<string, boolean>} */
  const available = new Map();
  for (const raw of listingCapabilities) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new TypeError('listing capability must be an object');
    }
    const capability = /** @type {Record<string, unknown>} */ (raw);
    if (typeof capability.id !== 'string' || capability.id.length === 0) {
      throw new TypeError('listing capability id must be a non-empty string');
    }
    if (typeof capability.available !== 'boolean') {
      throw new TypeError('listing capability available must be a boolean');
    }
    if (typeof capability.reason !== 'string') {
      throw new TypeError('listing capability reason must be a string');
    }
    available.set(capability.id, capability.available);
  }
  const seen = new Set();
  /** @type {Array<Readonly<{ id: string, label: string, hint: string, argv: readonly string[], command: string | undefined }>>} */
  const menu = [
    Object.freeze({
      id: SYSTEM_SHELL_ENTRY.id,
      label: SYSTEM_SHELL_ENTRY.label,
      hint: SYSTEM_SHELL_ENTRY.hint,
      argv: SYSTEM_SHELL_ENTRY.argv,
      command: SHELL_COMMAND,
    }),
  ];
  for (const raw of listingEntries) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new TypeError('listing entry must be an object');
    }
    const record = /** @type {Record<string, unknown>} */ (raw);
    for (const key of Object.keys(record)) {
      if (key !== 'id' && key !== 'label' && key !== 'hint') {
        throw new TypeError(`unexpected listing key: ${key}`);
      }
    }
    if (typeof record.id !== 'string') throw new TypeError('listing id must be a string');
    const id = record.id.trim();
    if (!PROVIDER_ID_RE.test(id)) throw new TypeError('listing id is malformed');
    if (id === SHELL_COMMAND || id === PROVIDER_COMMAND) throw new RangeError('listing id is reserved');
    if (seen.has(id)) throw new RangeError('duplicate listing id');
    seen.add(id);
    if (typeof record.label !== 'string') throw new TypeError('listing label must be a string');
    const label = record.label.trim();
    if (label.length === 0) throw new TypeError('listing label must be non-empty');
    if (typeof record.hint !== 'string') throw new TypeError('listing hint must be a string');
    if (available.get(id) === false) continue;
    menu.push(
      Object.freeze({
        id,
        label,
        hint: record.hint,
        argv: Object.freeze([]),
        command: PROVIDER_COMMAND,
      }),
    );
  }
  return Object.freeze(menu);
}

/**
 * @typedef {object} LaunchRequest
 * @property {unknown} [entryId] Menu entry id the operator committed.
 * @property {unknown} [command] Broker command for the commit.
 * @property {unknown} [args] Launch arguments.
 * @property {unknown} [title] Display title carried by the kit payload.
 * @property {unknown} [kind] Session kind carried by the kit payload.
 */

/**
 * @typedef {object} ValidLaunch
 * @property {string} entryId
 * @property {string} command
 * @property {readonly string[]} args Frozen validated args.
 * @property {string} title
 * @property {string} kind
 */

/**
 * @typedef {object} LaunchRefusal
 * @property {string} code Typed refusal code (see `LAUNCH_REFUSALS`).
 * @property {string} message Short designed-row message (no raw broker text).
 */

/**
 * Validates one kit `launch-request` payload against the advertised broker
 * commands and the menu ids the host rendered. Every refusal is typed so the
 * host can render a designed row; nothing here spawns or resolves.
 *
 * @param {LaunchRequest | null | undefined} payload Kit launch payload.
 * @param {{ commands: unknown, menuIds: unknown }} options Advertised broker
 * commands and the ids of the rendered menu (shell first, then host ids).
 * @returns {{ ok: true, launch: ValidLaunch } | { ok: false, refusal: LaunchRefusal }}
 */
export function validateLaunchRequest(payload, options) {
  const commands = Array.isArray(options?.commands) ? options.commands : [];
  const menuIds = Array.isArray(options?.menuIds) ? options.menuIds : [];
  const text = (/** @type {unknown} */ value) => (typeof value === 'string' ? value : '');
  const entryId = text(payload?.entryId);
  const command = text(payload?.command);
  if (entryId.length === 0 || (!menuIds.includes(entryId) && entryId !== CUSTOM_LAUNCH_ENTRY_ID)) {
    return {
      ok: false,
      refusal: {
        code: LAUNCH_REFUSALS.ENTRY_UNKNOWN,
        message: 'Unknown launch entry.',
      },
    };
  }
  if (command.length === 0 || !commands.includes(command)) {
    return {
      ok: false,
      refusal: {
        code: LAUNCH_REFUSALS.COMMAND_UNAVAILABLE,
        message: 'Launch unavailable.',
      },
    };
  }
  const rawArgs = payload?.args;
  if (!Array.isArray(rawArgs) || rawArgs.length > LAUNCH_MAX_ARGS) {
    return {
      ok: false,
      refusal: { code: LAUNCH_REFUSALS.ARGV_REJECTED, message: 'Launch arguments rejected.' },
    };
  }
  for (const arg of rawArgs) {
    if (typeof arg !== 'string' || arg.includes('\0') || utf8Length(arg) > LAUNCH_MAX_ARG_BYTES) {
      return {
        ok: false,
        refusal: { code: LAUNCH_REFUSALS.ARGV_REJECTED, message: 'Launch arguments rejected.' },
      };
    }
  }
  return {
    ok: true,
    launch: {
      entryId,
      command,
      args: Object.freeze([...rawArgs]),
      title: text(payload?.title),
      kind: text(payload?.kind),
    },
  };
}

/**
 * Parses custom-executable fields into a validated launch argv. Same grammar
 * as the renderer custom dialog (whitespace split only, no quoting or shell
 * evaluation) and the kit menu custom dialog bounds.
 *
 * @param {unknown} executable Executable field; trimmed, never split.
 * @param {unknown} argumentText Free-form argument text.
 * @returns {{ ok: true, argv: readonly string[] } | { ok: false, error: string }}
 */
export function parseCustomLaunch(executable, argumentText) {
  const parsed = parseCustomArgv(executable, argumentText);
  if (parsed.argv === null) return { ok: false, error: parsed.error };
  return { ok: true, argv: parsed.argv };
}

export { CUSTOM_MAX_ARGV, CUSTOM_MAX_ARG_BYTES, PROVIDER_COMMAND, SHELL_COMMAND };

// @ts-check
/** Main-world facade lookup. No fallback transport or path capability.
 * @returns {any} */
export function operatorHost() {
  return /** @type {any} */(globalThis).metaviewer?.operator ?? null;
}

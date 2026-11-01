export const DEFAULT_HIDDEN_SESSION_LIMIT = 4;
/** Only geometrically hidden live views enter this pool; modal occlusion does not. */
export function createHiddenSessionPool(limit = DEFAULT_HIDDEN_SESSION_LIMIT) {
  if (!Number.isSafeInteger(limit) || limit < 0) throw Error('HIDDEN_SESSION_LIMIT_INVALID');
  /** @type {Map<string,{shown:boolean,release:()=>void,lastShown:number,isShown?:()=>boolean}>} */
  const entries = new Map();
  let clock = 0;
  function prune() {
    const hidden = [...entries].filter(([,entry]) => !entry.shown && !entry.isShown?.()).sort((a,b) => a[1].lastShown - b[1].lastShown);
    while (hidden.length > limit) {
      const [oldest,entry] = /** @type {[string,{shown:boolean,release:()=>void,lastShown:number}]} */ (hidden.shift());
      entries.delete(oldest);
      entry.release();
    }
  }
  return {
    /** @param {string} id @param {boolean} shown @param {()=>void} release @param {()=>boolean} [isShown] */
    update(id, shown, release, isShown) {
      const previous = entries.get(id);
      entries.set(id,{shown,release,isShown,lastShown:shown && !previous?.shown ? ++clock : previous?.lastShown ?? ++clock});
      prune();
    },
    /** @param {string} id */
    remove(id) { entries.delete(id); },
    get size() { return entries.size; },
    get limit() { return limit; },
    /** @param {number} next */
    setLimit(next) {
      if (!Number.isSafeInteger(next) || next < 0) throw Error('HIDDEN_SESSION_LIMIT_INVALID');
      limit = next; prune();
    },
  };
}

/** A bounded, read-only picture of the authenticated native view, never input.
 * @param {import('electron').WebContents} contents
 * @param {()=>boolean} isActive */
export async function captureNativePreview(contents, isActive) {
  if (!isActive() || contents.isDestroyed?.()) throw Error('PREVIEW_UNAVAILABLE');
  let timer;
  try {
    // [TARGET] Do not hold an occlusion transition behind a stalled renderer.
    const frame = await Promise.race([
      contents.capturePage(),
      /** @type {Promise<never>} */ (new Promise((_, reject) => { timer = setTimeout(() => reject(Error('PREVIEW_TIMEOUT')), 500); })),
    ]);
    if (!isActive() || contents.isDestroyed?.() || frame.isEmpty()) throw Error('PREVIEW_UNAVAILABLE');
    const size = frame.getSize();
    // [TARGET] One transient preview, at most 1024 pixels wide and 2 MiB encoded.
    const bounded = size.width > 1024 ? frame.resize({width:1024}) : frame;
    const bytes = bounded.toPNG();
    if (!bytes.length || bytes.length > 2 * 1024 * 1024) throw Error('PREVIEW_UNAVAILABLE');
    return `data:image/png;base64,${bytes.toString('base64')}`;
  } finally { clearTimeout(timer); }
}

/** Only resolved theme colors cross into the sandboxed native wrapper.
 * @param {{background:string,foreground:string}} theme */
export function nativeThemeScript(theme) {
  if (!theme || Object.keys(theme).sort().join(',')!=='background,foreground'
      || ![theme.background,theme.foreground].every(color=>/^#[\da-f]{6}$/i.test(color))) throw Error('NATIVE_THEME_REFUSED');
  return `{document.documentElement.style.backgroundColor=${JSON.stringify(theme.background)};document.body.style.backgroundColor=${JSON.stringify(theme.background)};const overlay=document.getElementById('metaviewer-reconnecting');if(overlay){overlay.style.backgroundColor=${JSON.stringify(theme.background)};overlay.style.color=${JSON.stringify(theme.foreground)};}}`;
}

// Host-only application inventory. Never execute desktop arguments or a shell.
import { readdir, realpath, open, mkdir, writeFile, rename } from 'node:fs/promises';
import { join, basename, isAbsolute, resolve as resolvePath, sep } from 'node:path';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
const MAX_APPS = 256, MAX_FILE = 65536;
/** @param {string} text */
export function desktopEntry(text) {
  const section = text.split(/\r?\n\[Desktop Entry\]\r?\n/)[1]?.split(/\r?\n\[/)[0];
  if (!section) return null;
  /** @type {Record<string,string>} */ const fields = {};
  for (const line of section.split(/\r?\n/)) { const m = /^([A-Za-z]+)=(.*)$/.exec(line); if (m && !(m[1] in fields)) fields[m[1]] = m[2]; }
  if (fields.Type !== 'Application' || /^(true|1)$/i.test(fields.Hidden || '') || /^(true|1)$/i.test(fields.NoDisplay || '') || /^(true|1)$/i.test(fields.Terminal || '')) return null;
  const name = fields.Name?.trim();
  if (!name || name.length > 120 || /[\x00-\x1f\x7f]/.test(name)) return null;
  // Desktop files are data: only the first executable token is admitted.
  const token = /^(?:"([^"\\]+)"|([^\s"\\]+))(?=\s|$)/.exec(fields.Exec?.trim() || '');
  const binary = token?.[1] || token?.[2];
  if (!binary || /%/.test(binary) || ['env','sh','bash','zsh','fish'].includes(basename(binary))) return null;
  return {name,binary,icon:fields.Icon || '',tryExec:fields.TryExec || ''};
}
/** @param {{env?:NodeJS.ProcessEnv, stateDir:string, resolve:(binary:string)=>{path:string,name:string}, nativeImage?:any, directories?:string[]}} options */
export function desktopApplications({env=process.env,stateDir,resolve,nativeImage,directories}) {
  const dataHome = env.XDG_DATA_HOME || (env.HOME ? join(env.HOME,'.local/share') : '');
  const roots = directories || [dataHome && join(dataHome,'applications'),'/usr/local/share/applications','/usr/share/applications'].filter(Boolean);
  const recentFile = join(stateDir,'recent-apps.json');
  /** @type {Map<string,any>} */ let inventory = new Map();
  /** @param {string} path @param {number} max */
  async function bounded(path,max) {
    const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    try { const st=await handle.stat(); if(!st.isFile() || st.size>max) throw Error('APP_FILE_REFUSED');
      const buffer=Buffer.alloc(max+1);const {bytesRead}=await handle.read(buffer,0,buffer.length,0);
      if(bytesRead>max) throw Error('APP_FILE_REFUSED');return buffer.subarray(0,bytesRead);
    } finally {await handle.close();}
  }
  async function recent() { try { const rows=JSON.parse(String(await bounded(recentFile,8192))); return Array.isArray(rows) ? rows.filter(x=>typeof x==='string' && /^[a-f0-9]{24}$/.test(x)).slice(0,12) : []; } catch { return []; } }
  /** @param {string} icon */
  const iconThemes = new Map();
  /** @param {string} icon */
  async function iconData(icon) {
    if (!nativeImage || !icon || icon.length>256 || /[\x00-\x1f]/.test(icon)) return '';
    const iconRoots=[dataHome && join(dataHome,'icons'),'/usr/share','/usr/lib','/opt'].filter(Boolean);
    const absoluteAllowed=isAbsolute(icon) && iconRoots.some(root=>resolvePath(icon).startsWith(resolvePath(root)+sep)) && /\.(png|svg|xpm)$/i.test(icon);
    const candidates = absoluteAllowed ? [icon] : [];
    if (!isAbsolute(icon) && /^[A-Za-z0-9_.-]+$/.test(icon)) {
      for (const root of [dataHome && join(dataHome,'icons'),'/usr/share/icons'].filter(Boolean)) {
        if(!iconThemes.has(root)) iconThemes.set(root,['hicolor','Adwaita',...(await readdir(root).catch(()=>[])).filter(t=>/^[A-Za-z0-9_.-]+$/.test(t)&&!['hicolor','Adwaita'].includes(t)).slice(0,24)]);
        for (const theme of iconThemes.get(root)) for (const size of ['48x48','64x64','32x32','scalable']) for (const ext of ['png','svg']) candidates.push(join(root,theme,size,'apps',icon+'.'+ext));
      }
      for (const ext of ['png','svg','xpm']) candidates.push(join('/usr/share/pixmaps',icon+'.'+ext));
    }
    for (const file of candidates) try {
      const canonical=await realpath(file);
      if(!iconRoots.some(root=>canonical.startsWith(resolvePath(root)+sep))) continue;
      const bytes=await bounded(canonical,262144);
      if (file.endsWith('.svg')) {
        const svg=String(bytes);
        if(!/<svg\b/i.test(svg)||/<script|<foreignObject|<!DOCTYPE|<!ENTITY|<\?xml-stylesheet|@import|@font-face|\son[a-z]+\s*=/i.test(svg))continue;
        const refs=[...svg.matchAll(/(?:href|src)\s*=\s*(["'])(.*?)\1/gi)].map(m=>m[2]);
        const urls=[...svg.matchAll(/url\(([^)]*)\)/gi)].map(m=>m[1].trim().replace(/^["']|["']$/g,''));
        if([...refs,...urls].some(value=>!value.startsWith('#')))continue;
        return 'data:image/svg+xml;base64,'+bytes.toString('base64');
      }
      const img=nativeImage.createFromBuffer(bytes); if (!img.isEmpty()) return img.resize({width:32,height:32}).toDataURL();
    } catch { /* no local icon */ }
    return '';
  }
  async function list() {
    const entries=new Map();
    const seen=new Set();
    for (const root of roots) {
      let files; try { files=(await readdir(root)).filter(f=>f.endsWith('.desktop')).sort().slice(0,1024); } catch { continue; }
      for (const file of files) {
        if (seen.has(file)) continue; seen.add(file); // Hidden user entries mask system entries.
        if (entries.size>=MAX_APPS) break;
        try {
          const entry=desktopEntry('\n'+String(await bounded(join(root,file),MAX_FILE))); if (!entry) continue;
          if (entry.tryExec) resolve(entry.tryExec);
          const executable=resolve(entry.binary);
          const id=createHash('sha256').update(file).digest('hex').slice(0,24);
          entries.set(id,{id,name:entry.name,binary:executable.path,icon:await iconData(entry.icon)});
        } catch { /* unreadable or unavailable application */ }
      }
    }
    inventory=entries;
    const apps=[...entries.values()].sort((a,b)=>a.name.localeCompare(b.name));
    return {apps,recent:(await recent()).filter(id=>entries.has(id))};
  }
  /** Record only after MetaViewer's own successful host launch. @param {string} binary */
  async function launched(binary) {
    if (!inventory.size) await list();
    const app=[...inventory.values()].find(a=>a.binary===binary); if (!app) return;
    const rows=[app.id,...(await recent()).filter(id=>id!==app.id)].slice(0,12);
    await mkdir(stateDir,{recursive:true,mode:0o700});
    const temp=join(stateDir,`.recent-${randomUUID()}`);
    await writeFile(temp,JSON.stringify(rows),{mode:0o600,flag:'wx'});
    await rename(temp,recentFile);
  }
  return {list,launched};
}

// Host-only capture preferences, separate from the frozen four-key settings.
import { openSync, readSync, closeSync, fstatSync, realpathSync, statSync, constants } from 'node:fs';
import { open, mkdir, rename, unlink, statfs, readFile, link } from 'node:fs/promises';
import { join, isAbsolute, relative, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
const ROOT=fileURLToPath(new URL('../..',import.meta.url));
export const CAPTURE_PREFERENCES_CHANNEL='metaviewer:capture.preferences.v0.3';
/** @typedef {{schema:string,mode:string,recordingsFolder:string|null,screenshotsFolder:string|null}} CapturePreferences */
/** @returns {CapturePreferences} */
export const defaultCapturePreferences=()=>({schema:'metaviewer.capture.preferences/v1',mode:'ram',recordingsFolder:null,screenshotsFolder:null});
/** @param {string} folder */
export function validateCaptureFolder(folder) {
  if(typeof folder!=='string'||!isAbsolute(folder)||folder.length>4096||/[\x00-\x1f]/.test(folder))throw Error('Choose an existing folder.');
  let canonical,st;try{canonical=realpathSync(folder);st=statSync(canonical);}catch{throw Error('The selected folder is unavailable.');}
  const rel=relative(ROOT,canonical);
  if(rel===''||(!rel.startsWith('..'+sep)&&rel!=='..'&&!isAbsolute(rel)))throw Error('Choose a folder outside the MetaViewer source tree.');
  if(!st.isDirectory()||!(st.mode&0o222))throw Error('The selected folder is not writable.');
  return canonical;
}
/** @param {string} file */
export function readCapturePreferences(file) {
  let fd;
  try {
    fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);const st=fstatSync(fd);
    if(!st.isFile()||st.uid!==process.getuid?.()||(st.mode&0o777)!==0o600||st.size>16384)throw Error('Capture preferences are unavailable.');
    const bytes=Buffer.alloc(16385),count=readSync(fd,bytes,0,bytes.length,0);if(count>16384)throw Error('Capture preferences are too large.');
    const row=JSON.parse(bytes.subarray(0,count).toString('utf8'));
    if(Object.keys(row).sort().join(',')!=='mode,recordingsFolder,schema,screenshotsFolder'||row.schema!=='metaviewer.capture.preferences/v1'||!['ram','disk-on-stop'].includes(row.mode)||![row.recordingsFolder,row.screenshotsFolder].every(v=>v===null||(typeof v==='string'&&v.length<=4096&&isAbsolute(v)&&!/[\x00-\x1f]/.test(v))))throw Error('Capture preferences are invalid.');
    return row;
  } catch(error){if(/** @type {any} */ (error)?.code==='ENOENT')return defaultCapturePreferences();throw error;} finally{if(fd!==undefined)closeSync(fd);}
}
/** Only a native folder choice writes paths. @param {string} file @param {ReturnType<typeof defaultCapturePreferences>} row */
export async function writeCapturePreferences(file,row) {
  const directory=join(file,'..');await mkdir(directory,{recursive:true,mode:0o700});
  const dir=await open(directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  let temp;
  try {const st=await dir.stat();if(st.uid!==process.getuid?.()||(st.mode&0o022))throw Error('Capture preferences folder is not private.');
    const pinned=`/proc/self/fd/${dir.fd}`;
    temp=join(pinned,`.capture-${randomUUID()}`);const f=await open(temp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
    try {await f.writeFile(JSON.stringify(row)+'\n');await f.sync();}finally{await f.close();}
    const current=statSync(directory);if(current.dev!==st.dev||current.ino!==st.ino)throw Error('Capture preferences directory changed.');
    await rename(temp,join(pinned,basename(file)));temp=undefined;await dir.sync();
  } finally {if(temp)await unlink(temp).catch(()=>{});await dir.close();}
}
/** Explicit grants win; a launcher default yields to the saved native choice before core starts. @param {NodeJS.ProcessEnv} env @param {string} file */
export function applySavedCapturePreferences(env,file) {
  if(env.MV_RECORDING_DESTINATION!==undefined)return env;
  try {
    const row=readCapturePreferences(file);
    const folder=row.recordingsFolder || env.MV_RECORDING_DEFAULT_DESTINATION;
    return folder?{...env,MV_RECORDING_DESTINATION:validateCaptureFolder(folder)}:env;
  } catch {return {...env,MV_CAPTURE_PREFERENCES_ERROR:'The saved recording folder or preferences are unavailable. Captures remain in RAM until you choose a valid folder.'};}
}
/** Copy a verified core archive through pinned descriptors; never accept a renderer path. @param {string} grant @param {string} folder @param {{id:string,bytes:number,sha256:string}} item */
export async function copyScreenshotArchive(grant,folder,item) {
  folder=validateCaptureFolder(folder);
  if(folder===validateCaptureFolder(grant))return;
  if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(item.id)||!/^[a-f0-9]{64}$/.test(item.sha256)||!Number.isSafeInteger(item.bytes)||item.bytes<1||item.bytes>16*1024*1024)throw Error('Invalid exported screenshot.');
  const name=`${item.id}-${item.sha256}.tar`;
  const source=await open(join(grant,name),constants.O_RDONLY|constants.O_NOFOLLOW);
  let dir,target,temp;
  try {
    const st=await source.stat();if(!st.isFile()||st.uid!==process.getuid?.()||st.size!==item.bytes)throw Error('Exported screenshot is unavailable.');
    const bytes=Buffer.alloc(item.bytes+1);let bytesRead=0;
    while(bytesRead<bytes.length){const part=await source.read(bytes,bytesRead,bytes.length-bytesRead,bytesRead);if(!part.bytesRead)break;bytesRead+=part.bytesRead;}
    if(bytesRead!==item.bytes||createHash('sha256').update(bytes.subarray(0,bytesRead)).digest('hex')!==item.sha256)throw Error('Screenshot verification failed.');
    folder=validateCaptureFolder(folder);dir=await open(folder,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);const before=await dir.stat();
    temp=`/proc/self/fd/${dir.fd}/.mv-shot-${randomUUID()}`;
    target=await open(temp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
    await target.writeFile(bytes.subarray(0,bytesRead));await target.sync();const after=statSync(folder);
    if(before.dev!==after.dev||before.ino!==after.ino)throw Error('Screenshot folder changed.');
    // Publish only a complete, synced archive; link is atomic and never replaces.
    await link(temp,`/proc/self/fd/${dir.fd}/${name}`);await dir.sync();
  } finally {await target?.close();if(temp)await unlink(temp).catch(()=>{});await dir?.close();await source.close();}
}
/** @param {any} options */
export function capturePreferencesHost({file,env,chooseDirectory,notify=()=>{}}) {
  let warning=env.MV_CAPTURE_PREFERENCES_ERROR || '';
  /** @type {{schema:string,mode:string,recordingsFolder:string|null,screenshotsFolder:string|null}} */
  let row;try{row=readCapturePreferences(file);}catch{row=defaultCapturePreferences();warning='Stored capture preferences are unavailable. Choose a folder to replace them.';}
  let busy=false;
  /** @type {{id:string,ok:boolean,code:string}|null} */ let lastSave=null;
  /** @type {string|null} */ let grant=null;
  try {grant=env.MV_RECORDING_DESTINATION?validateCaptureFolder(env.MV_RECORDING_DESTINATION):null;}
  catch {warning='The host recording folder is unavailable or not writable. Captures stay in RAM.';}
  const active=()=>{try{return Boolean(grant&&(!row.recordingsFolder||realpathSync(row.recordingsFolder)===grant));}catch{return false;}};
  async function snapshot(){
    /** @param {string|null} path */
    const folderInfo=async(path)=>{let freeBytes=null;try{if(!path)throw Error('No folder');const fs=await statfs(path);const n=fs.bavail*fs.bsize;if(Number.isSafeInteger(n)&&n>=0)freeBytes=n;}catch{}return {label:path?basename(path):'Not selected',freeBytes};};
    let ramFreeBytes=null;try{const m=/^MemAvailable:\s*(\d+)\s+kB$/m.exec(await readFile('/proc/meminfo','utf8'));if(m){const n=Number(m[1])*1024;if(Number.isSafeInteger(n))ramFreeBytes=n;}}catch{}
    return {warning,mode:row.mode,recordings:await folderInfo(row.recordingsFolder||grant),screenshots:await folderInfo(row.screenshotsFolder),active:active(),ramFreeBytes,lastSave};
  }
  /** @param {string} kind */
  async function choose(kind){
    if(!['recordings','screenshots'].includes(kind))throw Error('Unknown capture folder.');if(busy)throw Error('A folder dialog is already open.');busy=true;
    try{const result=await chooseDirectory();if(result.canceled||result.filePaths?.length!==1)return snapshot();const path=validateCaptureFolder(result.filePaths[0]);
      const probePath=join(path,`.mv-write-check-${randomUUID()}`);let probe;try{probe=await open(probePath,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);}catch{throw Error('The selected folder is not writable.');}await probe.close();await unlink(probePath);
      const next={...row,[kind==='recordings'?'recordingsFolder':'screenshotsFolder']:path};await writeCapturePreferences(file,next);row=next;warning='';return snapshot();
    }finally{busy=false;}
  }
  /** @param {string} value */
  async function mode(value){if(!['ram','disk-on-stop'].includes(value))throw Error('Unknown capture mode.');const next={...row,mode:value};await writeCapturePreferences(file,next);row=next;warning='';return snapshot();}
  /** @param {any} reply @param {string|null} kind */
  async function routeExport(reply,kind){if(reply?.ok&&kind==='shot'&&row.screenshotsFolder&&grant)await copyScreenshotArchive(grant,row.screenshotsFolder,reply.export);return reply;}
  /** @param {string} id @param {boolean} ok @param {string} code */
  function saved(id,ok,code=''){lastSave={id,ok,code};notify(lastSave);}
  return {snapshot,choose,mode,routeExport,saved,shouldSave:()=>row.mode==='disk-on-stop'&&active()};
}

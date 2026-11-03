// Run with a local Electron binary. MV_FIT_RECEIPT optionally saves DOM evidence;
// MV_FIT_HOLD keeps the verified fixture open for pixel inspection.
const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const assert = require('node:assert/strict');
app.whenReady().then(async () => {
  const source = readFileSync(join(__dirname, '../src/surfaces/SurfaceCanvas.vue'), 'utf8');
  let css = source.split('<style scoped>')[1].split('</style>')[0];
  if (process.env.MV_FIT_NEGATIVE) css = css.replaceAll('var(--mv-frame-aspect)', '(1280 / 900)');
  const roleCss = readFileSync(join(__dirname, '../src/surfaces/RoleSurface.vue'), 'utf8').split('<style scoped>')[1].split('</style>')[0];
  const win = new BrowserWindow({width:1000,height:800,webPreferences:{nodeIntegration:false,contextIsolation:true}});
  await win.loadURL('data:text/html,' + encodeURIComponent(`<style>${roleCss}
${css}
    body{margin:0;background:#ddd}.host{container-type:size;width:900px;height:600px;background:#ddd}
    .controls{height:50px;flex:0 0 auto}.mv-surface__strip{height:23px;box-sizing:border-box}.mv-surface__canvas{background:#579}
    </style><div class="host"><div class="mv-role-surface"><div class="controls">Capsule controls · Fit equalises tiles</div><div class="mv-role-viewport"><div class="mv-role-agent-canvas"><section class="mv-surface" data-frame-width="1280" data-frame-height="720"><canvas class="mv-surface__canvas" width="1280" height="720"></canvas><div class="mv-surface__strip">FRAME witness</div></section></div></div></div></div>`));
  const evidence = await win.webContents.executeJavaScript(`(async () => {
    const host=document.querySelector('.host'), section=document.querySelector('section'), canvas=document.querySelector('canvas'), strip=document.querySelector('.mv-surface__strip');
    const result=[];
    for(const [w,h] of [[900,600],[450,300],[300,200],[640,480],[250,600]]) {
      host.style.width=w+'px';host.style.height=h+'px';
      for(const [fw,fh] of [[1280,720],[1280,900],[600,800]]) {
        section.dataset.frameWidth=fw;section.dataset.frameHeight=fh;canvas.width=fw;canvas.height=fh;
        const ctx=canvas.getContext('2d');ctx.fillStyle='#579';ctx.fillRect(0,0,fw,fh);ctx.strokeStyle='#fff';ctx.lineWidth=8;ctx.strokeRect(4,4,fw-8,fh-8);
        const c=canvas.getBoundingClientRect(),s=section.getBoundingClientRect(),f=strip.getBoundingClientRect();
        result.push({w,h,fw,fh,cw:c.width,ch:c.height,sw:s.width,sh:s.height,footer:f.bottom,bands:Math.abs(c.width-c.height*fw/fh)});
      }
    }
    host.style.width='900px';host.style.height='600px';section.dataset.frameWidth=1280;section.dataset.frameHeight=720;
    canvas.width=1280;canvas.height=720;const ctx=canvas.getContext('2d');ctx.fillStyle='#579';ctx.fillRect(0,0,1280,720);ctx.strokeStyle='#fff';ctx.lineWidth=8;ctx.strokeRect(4,4,1272,712);
    return result;
  })()`);
  for (const r of evidence) {
    assert.ok(r.cw > 0 && r.ch > 0, JSON.stringify(r));
    assert.ok(r.bands <= 2, JSON.stringify(r));
    assert.ok(r.sw <= r.w + .1 && r.sh <= r.h + .1 && r.footer <= r.h + .1, JSON.stringify(r));
  }
  const receipt = {status:'pass',cases:evidence};
  if (process.env.MV_FIT_RECEIPT) writeFileSync(process.env.MV_FIT_RECEIPT, JSON.stringify(receipt));
  console.log('V028_FIT_RENDER_OK',JSON.stringify(receipt));
  if (!process.env.MV_FIT_HOLD) app.quit();
}).catch(error => { console.error(error); app.exit(1); });

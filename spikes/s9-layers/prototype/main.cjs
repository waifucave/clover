// This guard precedes require('electron'); importing this file locally launches nothing.
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.CLOVER_S9_CI !== '1') throw new Error('CI only');
const { app, BrowserWindow, protocol, session, ipcMain } = require('electron');
const { writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const http = require('node:http');
const udp = require('node:dgram');
const crypto = require('node:crypto');
const check = process.argv.find(s => s.startsWith('--check='))?.split('=')[1];
const count = Number(process.argv.find(s => s.startsWith('--layers='))?.split('=')[1]);
const samples = new Map();
/** @type {import("electron").BrowserWindow[]} */ const windows = [];
const pause = (/** @type {any} */ ms)=> new Promise(r => setTimeout(r, ms));
app.setPath('userData', join(process.env.CLOVER_HOME || (()=>{throw new Error('missing isolated home')})(), 'userData'));
app.setPath('sessionData', join(process.env.CLOVER_HOME || (()=>{throw new Error('missing isolated home')})(), 'sessionData'));
app.setName('Clover S9');
app.on('window-all-closed', () => {}); // Variants deliberately close their last window.
app.commandLine.appendSwitch('site-per-process');
// Fixture routing only; no process-wide network/security closures.
app.commandLine.appendSwitch('host-resolver-rules','MAP *.s9.test 127.0.0.1, MAP *.s9.test. 127.0.0.1');
protocol.registerSchemesAsPrivileged(['clover-plugin','clover-core','clover-sealed'].map(scheme=>({scheme,privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}))); // Service workers deliberately not granted.
ipcMain.on('clover-s9-memory', (event, value) => {
  if (event.senderFrame && /^clover-(plugin|core):/.test(event.senderFrame.url)) samples.set(event.senderFrame.osProcessId, { ...value, namespacePid:value.pid,pid:event.senderFrame.osProcessId, frameUrl: event.senderFrame.url, received: Date.now() });
});
function save(/** @type {any} */ name, /** @type {any} */ data) {
  mkdirSync('results', { recursive: true });
  writeFileSync(`results/${name}.json`, JSON.stringify(data, null, 2));
}
async function makeWindow(/** @type {any} */ body, /** @type {any} */ options = {}) {
  const ses = session.fromPartition(`clover-s9-${crypto.randomUUID()}`);
  await ses.setProxy({mode:'direct'});
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  /** @type {any[]} */ const requests = [];
  /** @type {any[]} */ const navigations=[];
  /** @type {any[]} */ const popups=[];
  const { csp, decision } = await import('./policy.mjs');
  const local = options.local || '';
  // Single-use mount tokens: each successful plugin document serve consumes its token.
  const mounts=new Set();
  const mountUrl=(/** @type {any} */ host)=>{const token=crypto.randomUUID();mounts.add(token);return `clover-plugin://${host}/?mount=${token}`};
  const shellWithMounts=()=>body.replace(/clover-plugin:\/\/([a-z0-9-]+)\//g,(/** @type {any} */ _m,/** @type {any} */ host)=>mountUrl(host));
  const serve = (/** @type {any} */ request)=> {
    const url = new URL(request.url);
    const core=url.protocol==='clover-core:';
    const token=url.searchParams.get('mount');
    if(!core){
      if(!mounts.has(token))return new Response('forbidden',{status:403});
      mounts.delete(token);
    }
    let content = core ? shellWithMounts() : '', mime = 'text/html';
    if (!core) content = `<style>body{margin:0;background:#eee}input{width:75px}.menu{pointer-events:none;position:absolute;left:80px;top:100px;width:250px;height:40px;background:#ff00ff;z-index:99999}</style><input id="first"><input id="second"><div id="drag" draggable="true">Clover drag</div><div id="drop">Drop here</div><div class="menu">Plugin menu</div><script>window.events=[];for(const type of ['focusin','keydown','drop','dragenter','dragstart','compositionstart','compositionupdate','compositionend'])document.addEventListener(type,e=>events.push({type,key:e.key,text:e.dataTransfer?.getData('text/plain')}));document.addEventListener('dragstart',e=>e.dataTransfer.setData('text/plain','clover-fixture'));document.addEventListener('dragover',e=>e.preventDefault());document.addEventListener('drop',e=>e.preventDefault());</script>${url.hostname === 'p1' && check === 'process' ? `<iframe src="${mountUrl('p1--child')}" width="50" height="50"></iframe><iframe src="${mountUrl('p2')}" width="50" height="50"></iframe>` : ''}`;
    return new Response(content, {headers:{'Content-Type':mime,'Content-Security-Policy': core ? "default-src 'self'; frame-src clover-plugin://p1 clover-plugin://p2 clover-plugin://p3 clover-plugin://p4 clover-plugin://p5 clover-plugin://p6 clover-plugin://p7 clover-plugin://p8 clover-plugin://p9 clover-plugin://p10 clover-plugin://p11 clover-plugin://p12 clover-plugin://p13 clover-plugin://p14 clover-plugin://p15 clover-plugin://p16 clover-plugin://p17 clover-plugin://p18 clover-plugin://p19 clover-plugin://p20; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'" : csp(local?[local]:[], options.csp !== false,url.host==='p1'?["'self'",'clover-plugin://p2','clover-plugin://p1--child']:["'self'"])+"; frame-ancestors clover-core://shell clover-plugin://p1", 'X-DNS-Prefetch-Control': 'off', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()' }});
  };
  ses.protocol.handle('clover-plugin',serve);ses.protocol.handle('clover-core',serve);ses.protocol.handle('clover-sealed',()=>new Response('forbidden',{status:403}));
  ses.webRequest.onBeforeRequest((details, callback) => {
    const verdict = options.filter ? decision(details.url, details.initiatorOrigin, new Map()) : {cancel:false,reason:'filter off'};
    requests.push({ url: details.url, resourceType: details.resourceType, initiatorOrigin: details.initiatorOrigin, frameUrl: details.frame?.url, ...verdict });
    callback({cancel: verdict.cancel});
  });
  const win = new BrowserWindow({ title:'Clover S9', width:1000,height:800,show:true, webPreferences:{session:ses,preload:join(__dirname,'preload.cjs'),nodeIntegration:false,nodeIntegrationInSubFrames:true,contextIsolation:true,sandbox:true,backgroundThrottling:false} });
  windows.push(win);
  win.webContents.setWindowOpenHandler(details => {popups.push({url:details.url}); return {action:'deny'};});
  win.webContents.on('will-frame-navigate', event => { if (!event.url.startsWith('clover-plugin://')) {navigations.push({url:event.url,blocked:true});event.preventDefault();} });
  await win.loadURL('clover-core://shell/');
  await pause(1200);
  return {win,ses,requests,navigations,popups};
}
function shell(/** @type {any} */ n) { return `<style>body{margin:0}iframe{width:180px;height:180px;border:0}#overlay{position:absolute;left:80px;top:5px;width:250px;height:40px;background:#00ff00}</style><button id="start">Host</button><br>${Array.from({length:n},(_,i)=>`<iframe src="clover-plugin://p${i+1}/"></iframe>`).join('')}`; }
function frames(/** @type {any} */ win) {return win.webContents.mainFrame.framesInSubtree.map((/** @type {any} */ f)=> ({url:f.url,processId:f.processId,osProcessId:f.osProcessId,routingId:f.routingId}));}
async function processCheck() {
  const {win,ses} = await makeWindow(shell(3));
  const listing = frames(win), metrics = app.getAppMetrics();
  const groups = new Map();
  for(const f of listing) {const origin = new URL(f.url).host; if (!groups.has(origin)) groups.set(origin, new Set()); groups.get(origin).add(f.osProcessId);}
  const pids = [...groups.values()].map(p => [...p]);
  const isolated = pids.every(p=>p.length === 1) && new Set(pids.flat()).size === groups.size;
  const separate=new BrowserWindow({show:false,webPreferences:{session:ses,sandbox:true,contextIsolation:true,nodeIntegration:false}});windows.push(separate);await separate.loadURL('clover-core://shell/');await pause(350);
  const separateFrames=frames(separate);
  win.webContents.setWindowOpenHandler(()=>({action:'allow',overrideBrowserWindowOptions:{show:false}}));
  /** @type {import('electron').BrowserWindow|null} */ let related=null;
  win.webContents.once('did-create-window',child=>{related=child;windows.push(child)});
  await win.webContents.executeJavaScript("void window.open('clover-core://shell/','clover-related-island')");await pause(700);
  const relatedFrames=related?frames(related):[];
  const multiwindow={independent:separateFrames,related:relatedFrames,original:listing};

  return {multiwindow, verdict:isolated?'works':'does not', isolated, frames:listing, metrics, sameOriginP2Frames: listing.filter((/** @type {any} */ f)=>new URL(f.url).host==='p2').length, nodeExposure:await Promise.all(win.webContents.mainFrame.framesInSubtree.map(async f=>({url:f.url,require:await f.executeJavaScript('typeof require')}))) };
}
async function memoryCheck() {
  const {win} = await makeWindow(shell(count));
  await pause(1500);
  const listing = frames(win), pids = [...new Set(listing.map((/** @type {any} */ f)=>f.osProcessId))];
  const series = [];
  for(let i=0;i<3;i++){await pause(600);series.push(pids.map(pid=>({pid,...samples.get(pid)})));}
  return { verdict:series.every(s=>s.every(p=>Number.isFinite(p.memory?.private)))?'works with limits':'does not', layers:count, unit:'KiB', workload:'empty inputs, CSS menu and drag/drop fixture; no React, avatar or production UI', frames:listing, samples:series, rendererPrivateTotals:series.map(s=>s.every(p=>Number.isFinite(p.memory?.private))?s.reduce((sum,p)=>sum+p.memory.private,0):null), mainMemory:await process.getProcessMemoryInfo(), appMetrics:app.getAppMetrics(), note:'Renderer totals include trusted root. appMetrics retained separately; do not sum resident RSS as private memory.' };
}
async function crossingCheck(){const {win}=await makeWindow(shell(2));return (await import('./input.mjs')).crossingCheck(win,app);}
async function networkCheck(){return (await import('./network.mjs')).networkCheck(require('electron'));}
app.whenReady().then(async()=>{
  /** @type {any} */ const result={date:new Date().toISOString(),platform:process.platform,arch:process.arch,versions:process.versions,check,layers:count,commit:process.env.GITHUB_SHA};
  try {Object.assign(result,await (/** @type {Record<string,()=>Promise<any>>} */ ({process:processCheck,memory:memoryCheck,crossing:crossingCheck,network:networkCheck})[check||''])());save(`${check}${check==='memory'?'-'+count:''}`,result);console.log(`Clover S9 ${check}: ${result.verdict}`);for(const w of windows)if(!w.isDestroyed())w.destroy();app.exit(0);}
  catch(e){save(`${check}-error`,{...result,error:String(e),stack:e instanceof Error?e.stack:undefined});console.error(e);app.exit(1);}
});

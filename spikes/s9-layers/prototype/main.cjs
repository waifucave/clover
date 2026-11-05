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
const windows = [];
const pause = ms => new Promise(r => setTimeout(r, ms));
app.setPath('userData', join(process.env.CLOVER_HOME, 'userData'));
app.setPath('sessionData', join(process.env.CLOVER_HOME, 'sessionData'));
app.setName('Clover S9');
app.on('window-all-closed', () => {}); // Variants deliberately close their last window.
app.commandLine.appendSwitch('site-per-process');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('dns-prefetch-disable');
app.commandLine.appendSwitch('disable-features', 'PreconnectToSearch,Prerender2,SpeculationRulesPrefetch,SpeculationRulesPrerender,WebRtcHideLocalIpsWithMdns');
app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'disable_non_proxied_udp');
protocol.registerSchemesAsPrivileged([{ scheme: 'clover-plugin', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, allowServiceWorkers: true } }]);
ipcMain.on('clover-s9-memory', (event, value) => {
  if (event.senderFrame?.url.startsWith('clover-plugin://')) samples.set(value.pid, { ...value, frameUrl: event.senderFrame.url, received: Date.now() });
});
function save(name, data) {
  mkdirSync('results', { recursive: true });
  writeFileSync(`results/${name}.json`, JSON.stringify(data, null, 2));
}
async function makeWindow(body, options = {}) {
  const ses = session.fromPartition(`clover-s9-${crypto.randomUUID()}`);
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  const requests = [], navigations = [], popups = [];
  const { csp, decision } = await import('./policy.mjs');
  const local = options.local || '';
  ses.protocol.handle('clover-plugin', request => {
    const url = new URL(request.url);
    let content = body, mime = 'text/html';
    if (url.hostname !== 'core') content = `<style>body{margin:0;background:#eee}input{width:75px}.menu{position:absolute;left:80px;top:5px;width:250px;height:40px;background:#ff00ff;z-index:99999}</style><input id="first"><input id="second"><div id="drag" draggable="true">Clover drag</div><div id="drop">Drop here</div><div class="menu">Plugin menu</div><script>window.events=[];for(const type of ['focusin','keydown','drop','dragenter','compositionend'])document.addEventListener(type,e=>events.push({type,key:e.key,text:e.dataTransfer?.getData('text/plain')}));document.addEventListener('dragstart',e=>e.dataTransfer.setData('text/plain','clover-fixture'));document.addEventListener('dragover',e=>e.preventDefault());document.addEventListener('drop',e=>e.preventDefault());</script>${url.hostname === 'p1' && check === 'process' ? '<iframe src="clover-plugin://p1--child/" width="50" height="50"></iframe><iframe src="clover-plugin://p2/" width="50" height="50"></iframe>' : ''}`;
    if (url.pathname.endsWith('.js')) {
      mime = 'text/javascript';
      const fetchCode = `fetch(${JSON.stringify(options.denied + '/worker-fetch')}).then(()=>postMessage('sent')).catch(()=>postMessage('blocked'));`;
      content = url.pathname === '/sw.js' ? `self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(fetch(${JSON.stringify(options.denied + '/service-worker-fetch')}).catch(()=>{}))});self.addEventListener('activate',e=>e.waitUntil(clients.claim()));` : url.pathname === '/shared.js' ? `onconnect=e=>{fetch(${JSON.stringify(options.denied + '/shared-worker-fetch')}).then(()=>e.ports[0].postMessage('sent')).catch(()=>e.ports[0].postMessage('blocked'))}` : fetchCode;
    }
    return new Response(content, {headers:{'Content-Type':mime,'Content-Security-Policy': url.hostname === 'core' ? "default-src 'self' clover-plugin:; script-src 'unsafe-inline'; style-src 'unsafe-inline'" : csp(local, options.csp !== false), 'X-DNS-Prefetch-Control': 'off', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()' }});
  });
  ses.webRequest.onBeforeRequest((details, callback) => {
    const verdict = options.filter ? decision(details.url, details.initiatorOrigin, '127.0.0.1') : {cancel:false,reason:'filter off'};
    requests.push({ url: details.url, resourceType: details.resourceType, initiatorOrigin: details.initiatorOrigin, frameUrl: details.frame?.url, ...verdict });
    callback({cancel: verdict.cancel});
  });
  const win = new BrowserWindow({ width:1000,height:800,show:true, webPreferences:{session:ses,preload:join(__dirname,'preload.cjs'),nodeIntegration:false,nodeIntegrationInSubFrames:true,contextIsolation:true,sandbox:true,backgroundThrottling:false} });
  windows.push(win);
  win.webContents.setWindowOpenHandler(details => {popups.push({url:details.url}); return {action:'deny'};});
  win.webContents.on('will-frame-navigate', event => { if (!event.url.startsWith('clover-plugin://')) {navigations.push({url:event.url,blocked:true});event.preventDefault();} });
  await win.loadURL('clover-plugin://core/');
  await pause(1200);
  return {win,ses,requests,navigations,popups};
}
function shell(n) { return `<style>body{margin:0}iframe{width:180px;height:180px;border:0}#overlay{position:absolute;left:80px;top:5px;width:250px;height:40px;background:#00ff00}</style><button id="start">Host</button><br>${Array.from({length:n},(_,i)=>`<iframe src="clover-plugin://p${i+1}/"></iframe>`).join('')}`; }
function frames(win) {return win.webContents.mainFrame.framesInSubtree.map(f => ({url:f.url,processId:f.processId,osProcessId:f.osProcessId,routingId:f.routingId}));}
async function processCheck() {
  const {win} = await makeWindow(shell(3));
  const listing = frames(win), metrics = app.getAppMetrics();
  const groups = new Map();
  for(const f of listing) {const origin = new URL(f.url).host; if (!groups.has(origin)) groups.set(origin, new Set()); groups.get(origin).add(f.osProcessId);}
  const pids = [...groups.values()].map(p => [...p]);
  const isolated = pids.every(p=>p.length === 1) && new Set(pids.flat()).size === groups.size;
  return { verdict:isolated?'works':'does not', isolated, frames:listing, metrics, sameOriginP2Frames: listing.filter(f=>f.url==='clover-plugin://p2/').length, nodeExposure:await Promise.all(win.webContents.mainFrame.framesInSubtree.map(async f=>({url:f.url,require:await f.executeJavaScript('typeof require')}))) };
}
async function memoryCheck() {
  const {win} = await makeWindow(shell(count));
  await pause(1500);
  const listing = frames(win), pids = [...new Set(listing.map(f=>f.osProcessId))];
  const series = [];
  for(let i=0;i<3;i++){await pause(600);series.push(pids.map(pid=>({pid,...samples.get(pid)})));}
  return { verdict:series.every(s=>s.every(p=>Number.isFinite(p.memory?.private)))?'works with limits':'does not', layers:count, unit:'KiB', workload:'empty inputs, CSS menu and drag/drop fixture; no React, avatar or production UI', frames:listing, samples:series, rendererPrivateTotals:series.map(s=>s.reduce((sum,p)=>sum+(p.memory?.private||0),0)), mainMemory:await process.getProcessMemoryInfo(), appMetrics:app.getAppMetrics(), note:'Renderer totals include trusted root. appMetrics retained separately; do not sum resident RSS as private memory.' };
}
async function crossingCheck() {
  const {win} = await makeWindow(shell(2));
  const fs = win.webContents.mainFrame.frames;
  const wc = win.webContents;
  app.focus({steal:true});win.focus(); wc.focus();await pause(400);
  wc.sendInputEvent({type:'mouseDown',x:30,y:30,button:'left',clickCount:1});wc.sendInputEvent({type:'mouseUp',x:30,y:30,button:'left',clickCount:1});await pause(200);
  await fs[0].executeJavaScript("document.querySelector('#first').focus()");
  wc.sendInputEvent({type:'keyDown',keyCode:'A'});wc.sendInputEvent({type:'char',keyCode:'a'});wc.sendInputEvent({type:'keyUp',keyCode:'A'}); await pause(150);
  const focus = /** @type {any} */(await fs[0].executeJavaScript("({active:document.activeElement.id,value:document.querySelector('#first').value})"));
  const tabSteps=[];
  for(let i=0;i<5;i++){wc.sendInputEvent({type:'keyDown',keyCode:'Tab'});wc.sendInputEvent({type:'keyUp',keyCode:'Tab'});await pause(100);tabSteps.push(await Promise.all(fs.map(f=>f.executeJavaScript('({active:document.activeElement.id,focused:document.hasFocus()})'))));}
  const keyboard = await Promise.all(fs.map(f=>f.executeJavaScript('({active:document.activeElement.id,events:window.events})')));
  let shortcuts = 0;
  wc.on('before-input-event',(_event,input)=>{if(input.key.toLowerCase()==='k' && input.control)shortcuts++;});
  wc.sendInputEvent({type:'keyDown',keyCode:'K',modifiers:['control']});wc.sendInputEvent({type:'keyUp',keyCode:'K',modifiers:['control']});await pause(200);
  const before = await wc.capturePage();
  writeFileSync('results/menu-clipped.png', before.toPNG());
  await wc.executeJavaScript("const d=document.createElement('div');d.id='overlay';d.textContent='Core menu';document.body.append(d)");
  writeFileSync('results/menu-host.png',(await wc.capturePage()).toPNG());
  // Chromium input pipeline drag; no OS clipboard, external files or native privileges.
  const drag = [];
  try {
    wc.debugger.attach('1.3');
    await wc.debugger.sendCommand('Input.dispatchDragEvent',{type:'dragEnter',x:240,y:85,data:{items:[{mimeType:'text/plain',data:'clover-fixture'}],dragOperationsMask:1}});
    await wc.debugger.sendCommand('Input.dispatchDragEvent',{type:'dragOver',x:240,y:85,data:{items:[{mimeType:'text/plain',data:'clover-fixture'}],dragOperationsMask:1}});
    await wc.debugger.sendCommand('Input.dispatchDragEvent',{type:'drop',x:240,y:85,data:{items:[{mimeType:'text/plain',data:'clover-fixture'}],dragOperationsMask:1}});
    await pause(300); drag.push(.../** @type {any[]} */(await fs[1].executeJavaScript('window.events')));
  } catch(e) {drag.push({error:String(e)});} finally {if(wc.debugger.isAttached())wc.debugger.detach();}
  return {verdict:focus.value==='a' && drag.some(e=>e.type==='drop')?'works with limits':'does not',focus,windowFocused:win.isFocused(),keyboard,tabSteps,shortcuts,drag,menus:{clippedScreenshot:'menu-clipped.png',hostScreenshot:'menu-host.png',note:'An iframe clips its own top layer; trusted root demonstrates overlay outside iframe.'},ime:'not checked: requires OS IME and real input; live gate',dragLimit:'CDP delivery only. Does not prove native drag initiation, file drops or OS clipboard. Live gate required.'};
}
async function networkCheck() {
  const hits=[], connections=[], udpHits=[];
  const server = http.createServer((req,res)=>{
    hits.push({host:req.headers.host,url:req.url,method:req.method});
    res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers','*');
    if(req.url==='/redirect'){res.writeHead(302,{Location:`http://localhost:${/** @type {import("node:net").AddressInfo} */(server.address()).port}/redirect-target`});res.end();return;}
    if(req.url.includes('css'))res.setHeader('Content-Type','text/css');
    res.end(req.url.includes('css')?'body{color:black}':'fixture');
  });
  server.on('connection',socket=>{connections.push({time:Date.now()});socket.on('error',()=>{});});
  server.on('upgrade',(req,socket)=>{hits.push({host:req.headers.host,url:req.url,method:'WS'});const accept=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');socket.on('error',()=>{});setTimeout(()=>socket.destroy(),200);});
  await new Promise(r=>server.listen(0,'0.0.0.0',()=>r(undefined)));
  const stun=udp.createSocket('udp4');stun.on('message',data=>udpHits.push({bytes:data.length,time:Date.now()}));await new Promise(r=>stun.bind(0,'127.0.0.1',()=>r(undefined)));
  const port=/** @type {import("node:net").AddressInfo} */(server.address()).port, base=`http://127.0.0.1:${port}`,denied=`http://localhost:${port}`;
  const {networkProbe}=await import('./probes.mjs');
  const variants=[];
  for(const mode of ['control','csp','filter','combined']){
    console.log(`Clover S9 network: ${mode}`);
    const start=hits.length,udpStart=udpHits.length,connectionStart=connections.length;
    const ctx=await makeWindow(shell(1),{local:base,denied,csp:['csp','combined'].includes(mode),filter:['filter','combined'].includes(mode)});
    await ctx.ses.netLog.startLogging(join(__dirname,'results',`netlog-${mode}.json`));
    const result=/** @type {any} */(await ctx.win.webContents.mainFrame.frames[0].executeJavaScript(`(${networkProbe.toString()})(${JSON.stringify(base)},${JSON.stringify(denied)},${stun.address().port})`));
    // Navigation last, because it destroys the probing document.
    await ctx.win.webContents.mainFrame.frames[0].executeJavaScript(`location.href=${JSON.stringify(denied+'/navigation')}`).catch(()=>{});await pause(400);
    await ctx.ses.netLog.stopLogging();
    variants.push({mode,...result,requests:ctx.requests,navigations:ctx.navigations,popups:ctx.popups,hits:hits.slice(start),udp:udpHits.slice(udpStart),tcpConnections:connections.length-connectionStart});
    ctx.win.destroy();
  }
  stun.close();server.closeAllConnections();server.close();
  const combined=variants.find(v=>v.mode==='combined');
  return { verdict:combined.outcomes.find(o=>o.name==='webrtc')?.result?.disabled===true && !combined.hits.some(h=>h.host.startsWith('localhost:')) ? 'works with limits':'does not', variants, limits:['Loopback HTTP fixtures; font/image decode failures are not policy evidence: use request/hit logs.','DNS cache and Chromium feature names require netlog inspection; absence of HTTP does not prove absence of DNS/TCP.','UDP fixture observes STUN; WebRTC API existence/SDP also reported.','External HTTPS, WSS, DNS wire capture and OS IMEs remain live gates.'] };
}
app.whenReady().then(async()=>{
  const result={date:new Date().toISOString(),platform:process.platform,arch:process.arch,versions:process.versions,check,layers:count,commit:process.env.GITHUB_SHA};
  try {Object.assign(result,await ({process:processCheck,memory:memoryCheck,crossing:crossingCheck,network:networkCheck}[check])());save(`${check}${check==='memory'?'-'+count:''}`,result);console.log(`Clover S9 ${check}: ${result.verdict}`);for(const w of windows)if(!w.isDestroyed())w.destroy();app.exit(0);}
  catch(e){save(`${check}-error`,{...result,error:String(e),stack:e.stack});console.error(e);app.exit(1);}
});

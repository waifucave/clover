import http from 'node:http';
import net from 'node:net';
import dgram from 'node:dgram';
import os from 'node:os';
import crypto from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {csp,decision} from './policy.mjs';
import {extractNetlog} from './netlog.mjs';
import {networkProbe,webRtcSurface,remoteNlProbe,turnTcpProbe} from './probes.mjs';
const pause=(/** @type {any} */ ms)=>new Promise(r=>setTimeout(r,ms));
/** First non-loopback IPv4 the runner owns, used only to target a listener on a
 * non-loopback address at runtime. The literal address is never written to results
 * or committed files. */ 
function nonLoopbackIp(){
 for(const list of Object.values(os.networkInterfaces())){
  for(const addr of list||[]){
   if(addr.family==='IPv4'&&!addr.internal)return addr.address;
  }
 }
 return null;
}
/** A black-hole PAC that names exactly one declared host:port DIRECT and sends
 * everything else to PROXY 127.0.0.1:4 (a port nothing listens on). Built at runtime
 * because the fixture ports are ephemeral. */
function beltPac(/** @type {string} */ host,/** @type {number} */ port){
 const src=`function FindProxyForURL(url, host) {\n  if (shExpMatch(url, "http://${host}:${port}/*") || shExpMatch(url, "ws://${host}:${port}/*")) return "DIRECT";\n  return "PROXY 127.0.0.1:4";\n}`;
 return `data:text/javascript;base64,${Buffer.from(src,'utf8').toString('base64')}`;
}
const vectors=['own-fetch','other-plugin-fetch','wrong-port','fetch','xhr','image','css','font','script','media','object','css-import','background','websocket','beacon','eventsource','redirect','redirect-target','keepalive','webtransport','fetchLater','ping','download','worker','shared','blob','window-open','form','navigation','top-location','dns-prefetch','preconnect','prefetch','prerender','speculation','stun','turn','remote-candidate','remote-tcp-candidate'];
/** UDP listeners: STUN servers, WebTransport (QUIC) and remote-candidate connectivity checks. */
const udpVectors=['stun','webtransport','remote-candidate'];
/** TCP listeners: TURN over TCP, and remote TCP candidates. */
const tcpVectors=['turn','remote-tcp-candidate'];
/** Build inherited-context markup without executing it locally.
 * @param {string} kind @param {string} nestedurl */
export function inheritedScript(kind,nestedurl){
 if(!['nested','srcdoc','opaque-srcdoc','about-blank'].includes(kind))throw new Error('unknown inherited context');
 const setup=kind==='nested'?`f.src=${JSON.stringify(nestedurl)}`:kind==='about-blank'?`f.src='about:blank'`:`f.srcdoc='<input>';${kind==='opaque-srcdoc'?"f.sandbox='allow-scripts'":''}`;
 return `(()=>{const f=document.createElement('iframe');f.name=${JSON.stringify(kind)};${setup};document.body.append(f)})()`;
}
/** @param {string} prefix @param {string} [bind='127.0.0.1'] */
async function fixtures(prefix,bind='127.0.0.1'){
 /** @type {Record<string,any>} */ const endpoints={};
 /** @type {Record<string,any>} */ const records={};
 /** @type {(()=>void)[]} */ const closers=[];
 for(const name of vectors){
  const host=`${prefix}-${name.replaceAll(/[^a-z0-9-]/gi,'-').toLowerCase()}.${['dns-prefetch','stun','turn','remote-candidate','remote-tcp-candidate'].includes(name)?'localhost':'s9.test'}`;
  /** @type {any} */ const rec=records[name]={host,http:[],tcp:[],udp:[]};
  /** @type {any} */ let server;
  if(udpVectors.includes(name)){
   server=dgram.createSocket('udp4');server.on('message',(/** @type {any} */ data,/** @type {any} */ remote)=>rec.udp.push({bytes:data.length,address:remote.address,sourcePort:remote.port,magicCookie:data.length>=8?data.readUInt32BE(4).toString(16):null,stun:data.length>=20&&data.readUInt32BE(4)===0x2112a442,time:Date.now()}));
   await new Promise(r=>server.bind(0,bind,()=>r(undefined)));
  }else if(tcpVectors.includes(name)){
   server=net.createServer(socket=>{const entry={sourcePort:socket.remotePort,address:socket.remoteAddress,bytes:0,connected:true,time:Date.now()};rec.tcp.push(entry);socket.on('data',b=>{entry.bytes+=b.length;});socket.on('error',()=>{});setTimeout(()=>socket.destroy(),1700);});
   await new Promise(r=>server.listen(0,bind,()=>r(undefined)));
  }else{
   server=http.createServer((req,res)=>{rec.http.push({host:req.headers.host,url:req.url,method:req.method,headers:{purpose:req.headers['sec-purpose']||req.headers.purpose}});res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers','*');
    if(name==='redirect'){res.writeHead(302,{location:endpoints['redirect-target'].url});res.end();return;}
    if(name==='eventsource')res.setHeader('Content-Type','text/event-stream');
    if(name==='css'||name==='css-import')res.setHeader('Content-Type','text/css');
    if(name==='download')res.setHeader('Content-Disposition','attachment; filename="fixture.txt"');
    res.end(name==='css'||name==='css-import'?'body{color:black}':name==='eventsource'?'data: fixture\n\n':'fixture');});
   server.on('connection',(/** @type {any} */ socket)=>{const entry={sourcePort:socket.remotePort,address:socket.remoteAddress,firstBytes:''};rec.tcp.push(entry);socket.once('data',(/** @type {Buffer} */ bytes)=>entry.firstBytes=bytes.subarray(0,5).toString('hex'));socket.on('error',()=>{});});
   server.on('upgrade',(/** @type {any} */ req,/** @type {any} */ socket)=>{rec.http.push({host:req.headers.host,url:req.url,method:'WS'});const accept=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');socket.on('error',()=>{});setTimeout(()=>socket.destroy(),300);});
   await new Promise(r=>server.listen(0,bind,()=>r(undefined)));
  }
  const port=server.address().port;endpoints[name]={url:`http://${host}:${port}/${name}`,host,port,ice:name==='stun'?`stun:${host}:${port}`:name==='turn'?`turn:${host}:${port}?transport=tcp`:undefined,tcp:name==='remote-tcp-candidate'||name==='turn'?{port}:undefined};
  closers.push(()=>{server.closeAllConnections?.();server.close();});
 }
 // Same declared name with an undeclared port must be refused independently.
 endpoints['wrong-port'].url=`http://${endpoints['own-fetch'].host}:${endpoints['wrong-port'].port}/wrong-port`;
 return {endpoints,records,close:()=>closers.forEach(f=>f())};
}
/** Alive-frame lookup: disposed renderers throw on `.url`.
 * @param {any} parent @param {string} url */
function liveFrame(parent,url){
 return parent.frames.find((/** @type {any} */ x)=>{try{return x.url===url;}catch{return false;}});
}
/** Zero STUN/TURN listener traffic is the network-side closure signal.
 * @param {any} records */
function zeroRtc(records){return (records?.stun?.udp?.length||0)===0&&(records?.turn?.tcp?.length||0)===0&&(records?.['remote-candidate']?.udp?.length||0)===0;}
/** ICE candidate types. Host candidates are local interface enumeration, normally
 * mDNS-obfuscated; srflx/relay candidates mean a STUN/TURN round trip left the process.
 * @param {string[]} candidates */
function candidateInfo(candidates){
 /** @type {Record<string,number>} */ const types={};
 for(const c of candidates){const m=/ typ (\w+)/.exec(c);const type=m?m[1]:'unknown';types[type]=(types[type]||0)+1;}
 const network=(types.srflx||0)+(types.prflx||0)+(types.relay||0);
 return {total:candidates.length,types,network};
}
/** @param {any} result */
function resultCandidates(result){
 return (result?.outcomes||[]).filter((/** @type {any} */ o)=>['stun','turn-tcp'].includes(o.name)).flatMap((/** @type {any} */ o)=>o.result?.candidates||[]);
}
/** Inherited-context closure: no listener traffic and no network-gathered candidates.
 * A renderer kill with zero traffic is Chromium 156's allowlist outcome, not an escape.
 * A deadline without a kill is inconclusive, never a pass.
 * @param {any} c */
function contextClosed(c){
 if(!zeroRtc(c.records))return false;
 if(c.result?.rendererKilled||c.rendererGone)return true;
 if(!c.result?.outcomes||c.result.error)return false;
 return candidateInfo(resultCandidates(c.result)).network===0;
}
/** @param {any} electron */
export async function networkCheck(electron){
 const {app,BrowserWindow,session}=electron;
 /** @type {any[]|null} */ let activeGone=null;
 const onRendererGone=(/** @type {any} */ _event,/** @type {any} */ contents,/** @type {any} */ details)=>{
  const entry={time:Date.now(),reason:details.reason,exitCode:details.exitCode,webContentsId:contents?.id};
  activeGone?.push(entry);
  console.log(`Clover S9 render-process-gone ${details.reason} exit=${details.exitCode} wc=${contents?.id}`);
 };
 // Subframe renderer kills do not reach the host webContents event; the app event sees them.
 app.on('render-process-gone',onRendererGone);
 /** @type {any[]} */ const variants=[];
 for(const mode of ['control','csp','filter','combined','allowlist','ip-policy','belt','stub','non-plugin']){
  console.log(`Clover S9 revised network: ${mode}`);
  /** @type {any} */ let f=null;
  /** @type {any[]} */ const contexts=[];
  /** @type {any[]} */ const rendererGone=[];
  /** @type {any} */ let win=null;
  /** @type {any} */ let ses=null;
  /** @type {string|null} */ let logPath=null;
  /** @type {boolean} */ let logging=false;
  try{
   f=await fixtures(mode);ses=session.fromPartition(`s9-${crypto.randomUUID()}`);
   if(mode==='belt')await ses.setProxy({mode:'pac_script',pacScript:beltPac(f.endpoints['own-fetch'].host,f.endpoints['own-fetch'].port)});
   else await ses.setProxy({mode:'direct'});
   const modeFlags={useCsp:['csp','combined','allowlist','ip-policy','belt'].includes(mode),useFilter:['filter','combined','allowlist','ip-policy','belt'].includes(mode),header:['allowlist','belt'].includes(mode),pac:mode==='belt'?{belt:true,allowHost:f.endpoints['own-fetch'].host,allowPort:f.endpoints['own-fetch'].port}:null};
   const {useCsp,useFilter,header}=modeFlags;
   const registry=new Map([['clover-plugin://p1',new Set([new URL(f.endpoints['own-fetch'].url).origin])],['clover-plugin://p2',new Set([new URL(f.endpoints['other-plugin-fetch'].url).origin])]]);
   /** @type {any[]} */ const requests=[];
   /** @type {any[]} */ const preconnect=[];
   /** @type {any[]} */ const mountAttempts=[];
   /** @type {any[]} */ const popups=[];
   /** @type {any[]} */ const navigations=[];
   /** @type {any[]} */ const downloads=[];
   /** @type {any[]} */ const spellcheckDownloads=[];
   activeGone=rendererGone;
   ses.on('preconnect',(/** @type {any} */ _event,/** @type {any} */ url,/** @type {any} */ allowCredentials)=>preconnect.push({url,allowCredentials}));
   ses.on('will-download',(/** @type {any} */ event,/** @type {any} */ item)=>{downloads.push({url:item.getURL()});event.preventDefault();});
   try{ses.on('spellcheck-dictionary-download-begin',(/** @type {any} */ _event,/** @type {any} */ lang)=>spellcheckDownloads.push({lang,time:Date.now()}));}catch{ /* not present on this Electron */ }
   // The reviewer's finding: on Windows and Linux, Chromium 156 downloads a Hunspell
   // dictionary from redirector.gvt1.com for any language the OS spellchecker lacks,
   // outside webRequest, CSP and Connection-Allowlist. Plugin sessions must disable
   // the spellchecker so a "no off-machine traffic" assertion can hold. Keep it on for
   // `control` and `non-plugin` to record the positive control.
   if(['stub','belt','allowlist','ip-policy','combined','filter','csp'].includes(mode)){try{ses.setSpellCheckerEnabled(false);}catch{}}
   ses.setPermissionRequestHandler((/** @type {any} */ _wc,/** @type {any} */ _p,/** @type {any} */ cb)=>cb(false));ses.setPermissionCheckHandler(()=>false);
   // Single-use mount tokens: first successful document serve consumes the token.
   const mounts=new Map();
   const issue=(/** @type {any} */ host,/** @type {any} */ ancestors)=>{const token=crypto.randomUUID();const url=`clover-plugin://${host}/?mount=${token}`;mounts.set(token,{host,ancestors});return url;};
   let p1url=issue('p1',['clover-core://shell']),p2url=issue('p2',['clover-core://shell']);
   const rootToken=crypto.randomUUID();
   const serve=(/** @type {any} */ request)=>{
    const url=new URL(request.url),core=url.protocol==='clover-core:',worker=url.pathname.endsWith('.js');
    if(core){
     if(url.searchParams.get('mount')!==rootToken)return new Response('forbidden',{status:403});
     // Re-issue plugin mounts on every core shell load so a second window cannot reuse tokens.
     p1url=issue('p1',['clover-core://shell']);p2url=issue('p2',['clover-core://shell']);
     return new Response(`<iframe id="one" src="${p1url}" width="400" height="400"></iframe><iframe id="two" src="${p2url}" width="400" height="400"></iframe>`,{headers:{'Content-Type':'text/html','Content-Security-Policy':"default-src 'none'; frame-src clover-plugin://p1 clover-plugin://p2; frame-ancestors 'none'"}});
    }
    if(url.protocol==='clover-sealed:')return new Response('forbidden',{status:403,headers:{'Content-Security-Policy':"frame-ancestors 'none'"}});
    const token=url.searchParams.get('mount');
    const mount=mounts.get(token);
    if(!worker&&(!mount||mount.host!==url.host)){mountAttempts.push({url:request.url,denied:true,reason:!mount?'missing or consumed mount':'host mismatch'});return new Response('forbidden',{status:403,headers:{'Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'"}});}
    if(!worker)mounts.delete(token);
    // WHATWG URL.origin is null for custom schemes in Node; explicit scheme+host registry key.
    const key=`${url.protocol}//${url.host}`;const grants=[...(registry.get(key)||[])];
    /** @type {Record<string,string>} */ const headers={'Content-Type':worker?'text/javascript':'text/html','Content-Security-Policy':csp(grants,useCsp,["'self'"])+`; frame-ancestors ${worker?"'none'":(mount?.ancestors||['clover-core://shell','clover-plugin://p1']).join(' ')}`};
    if(header)headers['Connection-Allowlist']=`(${grants.map(x=>JSON.stringify(x+'/*')).join(' ')} response-origin)`;
    let content='<input id="input"><div>plugin fixture</div>';
    if(url.pathname==='/worker.js')content=`fetch(${JSON.stringify(f.endpoints.worker.url)}).then(()=>postMessage('sent')).catch(()=>postMessage('blocked'))`;
    if(url.pathname==='/shared.js')content=`onconnect=e=>{fetch(${JSON.stringify(f.endpoints.shared.url)}).then(()=>e.ports[0].postMessage('sent')).catch(()=>e.ports[0].postMessage('blocked'))}`;
    if(url.pathname==='/sw.js')content="self.addEventListener('install',()=>self.skipWaiting())";
    if(url.pathname==='/context-worker.js')content=`onmessage=async(e)=>postMessage(await (${networkProbe.toString()})(e.data,false))`;
    return new Response(content,{headers});
   };
   for(const scheme of ['clover-plugin','clover-core','clover-sealed'])ses.protocol.handle(scheme,serve);
   ses.webRequest.onBeforeRequest((/** @type {any} */ d,/** @type {any} */ cb)=>{
    const internal=/^clover-(plugin|core|sealed):/.test(d.url);
    const result=internal||!useFilter?{cancel:false,reason:'local protocol or control'}:decision(d.url,d.initiatorOrigin,registry);
    requests.push({url:d.url,type:d.resourceType,initiator:d.initiatorOrigin,...result});cb({cancel:result.cancel});
   });
   win=new BrowserWindow({show:true,width:1000,height:800,webPreferences:{session:ses,sandbox:true,contextIsolation:mode!=='stub',nodeIntegration:false,preload:mode==='stub'?resolve('preload-stub.cjs'):undefined,backgroundThrottling:false}});
   if(mode==='ip-policy'||mode==='belt')win.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
   win.webContents.setWindowOpenHandler((/** @type {any} */ d)=>{popups.push(d.url);return {action:'deny'}});
   win.webContents.on('will-frame-navigate',(/** @type {any} */ e)=>{if(!e.url.startsWith('clover-plugin:')){navigations.push({url:e.url,blocked:true});e.preventDefault();}});
   win.webContents.on('will-navigate',(/** @type {any} */ e)=>{navigations.push({url:e.url,blocked:true});e.preventDefault();});
   logPath=resolve('results',`netlog-v2-${mode}.json`);await ses.netLog.startLogging(logPath);logging=true;
   // Non-plugin control is an HTTP document from the same loopback fixture session.
   if(mode==='non-plugin')await win.loadURL(f.endpoints['own-fetch'].url);
   else await win.loadURL(`clover-core://shell/?mount=${rootToken}`);
   await pause(250);
   let frame=mode==='non-plugin'?win.webContents.mainFrame:liveFrame(win.webContents.mainFrame,p1url);
   const invoke=(/** @type {any} */ fr,/** @type {any} */ ep,/** @type {any} */ full)=>fr.executeJavaScript(`(${networkProbe.toString()})(${JSON.stringify(ep)},${full})`);
   /** @type {any} */ let main={error:'missing main frame'};
   /** @type {any[]} */ const trustAttempts=[];
   /** @type {any} */ let topNavigation=null;
   /** @type {any} */ let second=null;
    /** @type {any} */ let mountReuse=null;
   /** @type {any} */ const belt={};
   /** @type {any} */ const stub={};
   try{
    if(mode==='stub'){
     if(frame){stub.direct=await frame.executeJavaScript(`(${webRtcSurface.toString()})()`);main=stub.direct;}
    }else if(frame){main=await Promise.race([invoke(frame,f.endpoints,mode!=='non-plugin'),pause(16000).then(()=>({error:'document probe deadline'}))]);}
    const beltOrStub=['belt','stub'].includes(mode);
    if(mode!=='non-plugin'&&!beltOrStub){
     const p2=liveFrame(win.webContents.mainFrame,p2url);
     if(p2&&mode!=='stub')second=await p2.executeJavaScript(`Promise.all(${JSON.stringify([f.endpoints['own-fetch'].url,f.endpoints['other-plugin-fetch'].url])}.map(url=>fetch(url).then(r=>({url,status:r.status})).catch(e=>({url,error:String(e)}))))`);
     // Single-use proof: the served mounts are spent; a never-issued mount is refused; a new one loads.
     const status=(/** @type {string} */ url)=>ses.fetch(url).then((/** @type {any} */ r)=>r.status).catch((/** @type {any} */ e)=>String(e));
     mountReuse={spentP1:await status(p1url),spentP2:await status(p2url),missing:await status('clover-plugin://p1/?mount=never-issued'),fresh:await status(issue('p1',['clover-core://shell']))};
     // Recreate the parent per inherited-context probe. A renderer crash is a result,
     // not permission to skip the other contexts or the non-plugin control.
     const fresh=async()=>{
      const url=issue('p1',['clover-core://shell']);
      try{await win.webContents.executeJavaScript(`(()=>{document.querySelector('#context-host')?.remove();const f=document.createElement('iframe');f.id='context-host';f.style='position:fixed;top:0;left:0;width:480px;height:500px';f.src=${JSON.stringify(url)};document.body.append(f)})()`);}
      catch{return null;}
      // Loading a fresh mount can take longer than one frame on a loaded runner.
      for(let i=0;i<8;i++){const frame=liveFrame(win.webContents.mainFrame,url);if(frame)return frame;await pause(250);}
      return null;
     };
     /** A renderer killed by the browser may not emit render-process-gone for an
      * out-of-process subframe. Its OS PID leaving app metrics is the fallback proof.
      * @param {any} fr */
     const framePid=(fr)=>{try{return fr.osProcessId;}catch{return null;}};
     /** @param {number|null} pid */
     const pidAlive=(pid)=>pid==null||app.getAppMetrics().some((/** @type {any} */ m)=>m.pid===pid);
     for(const kind of ['nested','srcdoc','opaque-srcdoc','about-blank']){
      const goneBefore=rendererGone.length;
      const cf=await fixtures(`${mode}-${kind}`);const context={kind,fixture:cf,result:/** @type {any} */ (null),rendererGone:false};contexts.push(context);
      try{
       frame=await fresh();
       if(!frame){context.result={error:'fresh frame missing',completed:false,rendererKilled:rendererGone.length>goneBefore};context.rendererGone=rendererGone.length>goneBefore;continue;}
       // Fresh nested mount each time: tokens are single-use.
       const nestedurl=issue('p1',['clover-core://shell','clover-plugin://p1']);
       await frame.executeJavaScript(inheritedScript(kind,nestedurl));
       await pause(180);const child=frame.frames.find((/** @type {any} */ x)=>{try{return x.name===kind;}catch{return false;}});
       if(!child){context.result={error:'inherited child missing',completed:false,rendererKilled:rendererGone.length>goneBefore};context.rendererGone=rendererGone.length>goneBefore;continue;}
       const probePid=framePid(child);
       context.result=await Promise.race([invoke(child,cf.endpoints,false),pause(12000).then(()=>({error:'inherited probe deadline',rendererKilled:rendererGone.length>goneBefore}))]);
       // The browser-side kill of a subframe renderer is not reported by app or
       // webContents events in Electron 45. A vanished Tab PID is independent proof.
       if(!pidAlive(probePid)){context.rendererGone=true;console.log(`Clover S9 inherited ${kind} renderer PID ${probePid} gone`);}
       if(rendererGone.length>goneBefore)context.rendererGone=true;
       if(context.rendererGone)context.result={...context.result,rendererKilled:true};
      }catch(e){context.result={error:String(e),completed:false,rendererKilled:rendererGone.length>goneBefore};context.rendererGone=rendererGone.length>goneBefore;}
     }
     frame=await fresh();
     const wf=await fixtures(`${mode}-worker`);contexts.push({kind:'worker',fixture:wf,result:null,rendererGone:false});
     if(frame){
      contexts[contexts.length-1].result=await frame.executeJavaScript(`new Promise(resolve=>{const w=new Worker('/context-worker.js');w.onmessage=e=>{w.terminate();resolve(e.data)};w.onerror=e=>resolve({error:e.message});w.postMessage(${JSON.stringify(wf.endpoints)});setTimeout(()=>{w.terminate();resolve({error:'worker deadline'})},6000)})`);
     }else{contexts[contexts.length-1].result={error:'fresh frame missing for worker',completed:false,rendererKilled:rendererGone.length>0};contexts[contexts.length-1].rendererGone=rendererGone.length>0;}
     frame=await fresh();
     if(frame){
      await frame.executeJavaScript("window.trustViolations=[];document.addEventListener('securitypolicyviolation',e=>trustViolations.push({directive:e.effectiveDirective,blocked:e.blockedURI}))");
      for(const target of ['clover-plugin://p2/',p2url,'clover-core://shell/',`clover-core://shell/?mount=${rootToken}`,'clover-sealed://cards/']){
       const deniedBefore=mountAttempts.length;
       const report=await frame.executeJavaScript(`new Promise(resolve=>{window.trustViolations=[];const f=document.createElement('iframe');f.name='trust-'+${JSON.stringify(target)};f.src=${JSON.stringify(target)};f.onload=()=>resolve({target:${JSON.stringify(target)},loadEvent:true});f.onerror=()=>resolve({target:${JSON.stringify(target)},error:true});document.body.append(f);setTimeout(()=>resolve({target:${JSON.stringify(target)},settled:true}),150)})`);
       const child=frame.frames.find((/** @type {any} */ x)=>{try{return x.name==='trust-'+target;}catch{return false;}});
       let actualUrl=null;try{actualUrl=child?.url??null;}catch{actualUrl='disposed';}
       const violations=await frame.executeJavaScript('window.trustViolations');
       // An iframe load event fires for an error page too, and the frame can still report
       // the requested URL. A matching frame-src violation, or the mount check refusing this
       // exact URL (403 with frame-ancestors 'none'), is the decisive block record.
       const byCsp=violations.some((/** @type {any} */ v)=>v.directive==='frame-src'&&target.startsWith(v.blocked+':'));
       const byMount=mountAttempts.slice(deniedBefore).some((/** @type {any} */ a)=>a.url===target);
       const blocked=byCsp||byMount||actualUrl==='about:blank'||!child;
       const blockedBy=[byCsp&&'csp frame-src',byMount&&'mount token refused',!byCsp&&!byMount&&blocked&&'no document'].filter(Boolean);
       trustAttempts.push({...report,actualUrl,violations,blockedBy,loaded:!blocked,blocked});
      }
      trustAttempts.push({children:frame.frames.map((/** @type {any} */ child)=>{try{return {name:child.name,url:child.url};}catch{return {name:null,url:'disposed'};}})});
      topNavigation=await frame.executeJavaScript(`(()=>{try{top.location=${JSON.stringify(f.endpoints['top-location'].url)};return {attempted:true}}catch(e){return {attempted:true,error:String(e)}}})()`);
      await frame.executeJavaScript(`(()=>{const a=document.createElement('a');a.href=${JSON.stringify(f.endpoints.download.url)};a.download='fixture.txt';document.body.append(a);a.click()})()`).catch(()=>{});
     }
    }
    const racer=(/** @type {any} */ p,/** @type {number} */ ms)=>Promise.race([p,pause(ms).then(()=>({timeout:true}))]);
    if(mode==='belt'&&frame){
     // The declared host must still work, on loopback and a non-loopback listener, or
     // the belt has broken legitimate plugin traffic. Declared-host tests use a listener
     // bound to 0.0.0.0 and reached by the runner's own non-loopback IPv4.
     const nlIp=nonLoopbackIp();
     belt.declaredFetch={loopback:await racer(frame.executeJavaScript(`fetch(${JSON.stringify(f.endpoints['own-fetch'].url)}).then(r=>({status:r.status})).catch(e=>({error:String(e)}))`),8000)};
     const nlTarget=await fixtures(`${mode}-nonloop`,'0.0.0.0');
     const nlOwnPort=nlTarget.endpoints['own-fetch'].port;
     belt.nonLoopback=await racer(frame.executeJavaScript(`fetch(${JSON.stringify(`http://${nlIp}:${nlOwnPort}/own-fetch`)}).then(r=>({status:r.status})).catch(e=>({error:String(e)}))`),10000);
     // Non-loopback WebRTC probes the PAC cannot be skipped for: a remote UDP candidate,
     // a remote TCP candidate and TURN over TCP, each aimed at the runner's non-loopback
     // IPv4 on a fresh listener port. A hit means the belt did not stop the socket.
     const nlUdp=await fixtures(`${mode}-nl-udp`,'0.0.0.0');const nlTcp=await fixtures(`${mode}-nl-tcp`,'0.0.0.0');
     belt.nonLoopbackRemoteUdp=await racer(frame.executeJavaScript(`(${remoteNlProbe.toString()})('udp',${JSON.stringify(nlIp)},${nlUdp.endpoints['remote-candidate'].port}).then(r=>({r})).catch(e=>({error:String(e)}))`),8000);
     belt.nonLoopbackRemoteTcp=await racer(frame.executeJavaScript(`(${remoteNlProbe.toString()})('tcp',${JSON.stringify(nlIp)},${nlTcp.endpoints['remote-tcp-candidate'].port}).then(r=>({r})).catch(e=>({error:String(e)}))`),8000);
     belt.nonLoopbackTurn=await racer(frame.executeJavaScript(`(${turnTcpProbe.toString()})(${JSON.stringify(nlIp)},${nlTcp.endpoints['turn'].port}).then(r=>({r})).catch(e=>({error:String(e)}))`),8000);
     await pause(200);
     belt.nonLoopbackUltimate={remoteUdpHits:nlUdp.records['remote-candidate'].udp.length,remoteTcpHits:nlTcp.records['remote-tcp-candidate'].tcp.length,turnHits:nlTcp.records.turn.tcp.length};
     belt.declaredFetchNonLoopbackHits=nlTarget.records['own-fetch'].http.length;
     nlUdp.close();nlTcp.close();nlTarget.close();
    }
    if(mode==='stub'&&frame){
     // The page's main world is stripped. Can it reach a fresh, working RTCPeerConnection?
     const surface=`(${webRtcSurface.toString()})()`;
     const freshProbe=(/** @type {string} */ src,/** @type {string} */ srcdoc)=>racer(frame.executeJavaScript(`new Promise(resolve=>{const f=document.createElement('iframe');f.name='stub-fresh';${srcdoc?`f.srcdoc=${JSON.stringify(srcdoc)};`:`f.src=${JSON.stringify(src)};`}f.onload=()=>{try{const w=f.contentWindow;let live=false;try{if(typeof w.RTCPeerConnection==='function'){const p=new w.RTCPeerConnection();p.close();live=true;}}catch{}resolve({rtcp:typeof w.RTCPeerConnection,webkit:typeof w.webkitRTCPeerConnection,rtcpLive:live});}catch(e){resolve({error:String(e)});}};document.body.append(f);setTimeout(()=>resolve({timeout:true}),1500)})`),8000);
     stub.direct=await racer(frame.executeJavaScript(surface),8000);
     try{
      stub.srcdoc=await freshProbe('','<input>');
      stub.aboutBlank=await freshProbe('about:blank','');
      stub.nested=await freshProbe(f.endpoints['own-fetch'].url,'');
      stub.worker=await racer(frame.executeJavaScript(`new Promise(resolve=>{const w=new Worker(${JSON.stringify('data:application/javascript,'+encodeURIComponent('postMessage([typeof RTCPeerConnection, typeof webkitRTCPeerConnection])'))});w.onmessage=e=>{w.terminate();resolve({rtcp:e.data[0],webkit:e.data[1]})};w.onerror=e=>{resolve({error:e.message})};setTimeout(()=>{w.terminate();resolve({timeout:true})},1500)})`),8000);
     }catch(e){stub.error=String(e);}
    }
   }finally{
    await pause(350);
    if(logging){try{await ses.netLog.stopLogging();logging=false;}catch{}}
   }
   /** @type {any} */ let log={events:[],speculative:[],errors:[]};
   try{if(logPath)log=extractNetlog(JSON.parse(readFileSync(logPath,'utf8')));}catch(e){log={events:[],speculative:[],errors:[],readError:String(e)};}
   const inherited=contexts.map(c=>{
    const item={kind:c.kind,result:c.result,rendererGone:!!c.rendererGone,records:c.fixture.records,dnsEvents:log.speculative.filter((/** @type {any} */ e)=>JSON.stringify(e.params).includes(c.fixture.records['dns-prefetch'].host))};
    const info=candidateInfo(resultCandidates(c.result));
    return {...item,candidates:info,closed:contextClosed(item)};
   });
   const entry={mode,pac:modeFlags.pac,spellcheckDisabled:['stub','belt','allowlist','ip-policy','combined','filter','csp'].includes(mode),header:header?'Connection-Allowlist on documents and worker scripts':null,ipPolicy:win.webContents.getWebRTCIPHandlingPolicy(),main,mainCandidates:candidateInfo(resultCandidates(main)),second,mountReuse,records:f.records,requests,preconnect,popups,navigations,downloads,spellcheckDownloads,downloadAttempt:mode!=='non-plugin',topNavigation,mountAttempts,trustAttempts,rendererGone,contexts:inherited,netlog:log,belt:mode==='belt'?belt:undefined,stub:mode==='stub'?stub:undefined};
   variants.push(entry);
   writeFileSync(resolve('results',`network-variant-${mode}.json`),JSON.stringify(entry,null,2));
  }catch(e){
   console.error(`Clover S9 ${mode} failed:`,e);
   const entry={mode,error:String(e),stack:e instanceof Error?e.stack:undefined,rendererGone,contexts:contexts.map(c=>({kind:c.kind,result:c.result,rendererGone:!!c.rendererGone,records:c.fixture?.records})),records:f?.records||null};
   variants.push(entry);
   writeFileSync(resolve('results',`network-variant-${mode}.json`),JSON.stringify(entry,null,2));
   if(logging&&ses){try{await ses.netLog.stopLogging();}catch{}}
  }finally{
   activeGone=null;
   try{if(win&&!win.isDestroyed())win.destroy();}catch{}
   try{f?.close();}catch{}
   contexts.forEach(c=>{try{c.fixture.close();}catch{}});
  }
 }
 const a=variants.find(v=>v.mode==='allowlist'),control=variants.find(v=>v.mode==='combined'),plain=variants.find(v=>v.mode==='control'),non=variants.find(v=>v.mode==='non-plugin'),ip=variants.find(v=>v.mode==='ip-policy'),beltV=variants.find(v=>v.mode==='belt'),stubV=variants.find(v=>v.mode==='stub');
 const mainCandidates=(/** @type {any} */ v)=>candidateInfo(resultCandidates(v));
 const beltClosed=beltV&&!beltV.error&&(beltV.records?.['remote-tcp-candidate']?.tcp?.length||0)===0;
 const tested=(/** @type {any} */ v)=>['stun','turn-tcp'].every(name=>(v?.outcomes||[]).some((/** @type {any} */ o)=>o.name===name&&o.result?.supported===true&&Array.isArray(o.result.candidates)));
 const dns=(/** @type {any} */ v,/** @type {string} */ host)=>v?.netlog?.speculative?.filter((/** @type {any} */ e)=>JSON.stringify(e.params).includes(host))||[];
 const directClosed=!!a&&!a.error&&tested(a.main)&&zeroRtc(a.records)&&mainCandidates(a.main).network===0&&dns(a,a.records['dns-prefetch'].host).length===0;
 const inheritedClosed=!!a&&!a.error&&Array.isArray(a.contexts)&&a.contexts.length>0&&a.contexts.every((/** @type {any} */ c)=>c.closed);
 const checks=(/** @type {any} */ v)=>v?.records?.['remote-candidate']?.udp?.filter((/** @type {any} */ p)=>p.stun).length||0;
 const assertions={undeclaredStunPositive:!!control&&control.records?.stun?.udp?.some((/** @type {any} */ p)=>p.stun),undeclaredTurnPositive:!!control&&(control.records?.turn?.tcp?.length||0)>0,undeclaredRemoteCandidatePositive:checks(control)>0,allowlistRemoteCandidateClosed:!!a&&!a.error&&(a.records?.['remote-candidate']?.udp?.length||0)===0,allowlistDirectClosed:directClosed,allowlistInheritedClosed:inheritedClosed,allowlistInheritedCrashClosure:!!a&&Array.isArray(a.contexts)&&a.contexts.some((/** @type {any} */ c)=>c.rendererGone||c.result?.rendererKilled),ipPolicyRan:!!ip&&!ip.error,nonPluginStillConnects:!!non&&(non.records?.stun?.udp?.length||0)>0&&(non.records?.turn?.tcp?.length||0)>0,nonPluginDns:!!non&&dns(non,non.records['dns-prefetch'].host).length>0,dnsPositive:!!plain&&dns(plain,plain.records['dns-prefetch'].host).length>0,dnsRefused:!!a&&dns(a,a.records['dns-prefetch'].host).length===0,preconnectEventPositive:!!plain&&plain.preconnect?.some((/** @type {any} */ e)=>e.url.includes(plain.records.preconnect.host))};
 // Crash-closure of inherited contexts is an explicit Chromium 156 outcome, not a fail.
 const required=['undeclaredStunPositive','undeclaredTurnPositive','undeclaredRemoteCandidatePositive','allowlistRemoteCandidateClosed','allowlistDirectClosed','allowlistInheritedClosed','ipPolicyRan','nonPluginStillConnects','nonPluginDns','dnsPositive','dnsRefused','preconnectEventPositive'];
 const beltStub=(beltV?.belt||beltV?.stub)?{declaredFetch:beltV?.belt?.declaredFetch,nonLoopback:beltV?.belt?.nonLoopback,nonLoopbackRemoteUdp:beltV?.belt?.nonLoopbackRemoteUdp,nonLoopbackRemoteTcp:beltV?.belt?.nonLoopbackRemoteTcp,nonLoopbackTurn:beltV?.belt?.nonLoopbackTurn,nonLoopbackUltimate:beltV?.belt?.nonLoopbackUltimate,declaredFetchNonLoopbackHits:beltV?.belt?.declaredFetchNonLoopbackHits,pac:beltV?.pac}:undefined;
 const stubResult=stubV?.stub?{direct:stubV.stub.direct,srcdoc:stubV.stub.srcdoc,aboutBlank:stubV.stub.aboutBlank,nested:stubV.stub.nested,worker:stubV.stub.worker,error:stubV.stub.error}:undefined;
 const beltDeclaredWorks=!beltV?.error&&typeof beltV?.belt?.declaredFetch?.loopback?.status==='number';
 const beltNonLoopDeclaredWorks=beltV?.belt?.nonLoopback?.status===200;
 const beltNonLoopWebRtcClosed=beltV?.belt?.nonLoopbackUltimate?((beltV.belt.nonLoopbackUltimate.remoteUdpHits||0)===0&&(beltV.belt.nonLoopbackUltimate.remoteTcpHits||0)===0&&(beltV.belt.nonLoopbackUltimate.turnHits||0)===0):null;
 const stubStripped=!!stubV?.stub?.direct&&stubV.stub.direct.rtcp==='undefined';
 const stubEscapeLive=!!stubV?.stub&&[stubV.stub.srcdoc,stubV.stub.aboutBlank,stubV.stub.nested].some((/** @type {any} */ x)=>x?.rtcpLive===true);
 app.removeListener('render-process-gone',onRendererGone);
 return {verdict:required.every(k=>assertions[/** @type {keyof typeof assertions} */(k)])?'works with limits':'does not',assertions,probes:{beltDeclaredWorks,beltNonLoopDeclaredWorks,beltNonLoopWebRtcClosed,beltStub,stubStripped,stubEscapeLive,stubResult},variants};
}

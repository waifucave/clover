import http from 'node:http';
import net from 'node:net';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {csp,decision} from './policy.mjs';
import {extractNetlog} from './netlog.mjs';
import {networkProbe} from './probes.mjs';
const pause=(/** @type {any} */ ms)=>new Promise(r=>setTimeout(r,ms));
const vectors=['own-fetch','other-plugin-fetch','wrong-port','fetch','xhr','image','css','font','script','media','object','css-import','background','websocket','beacon','eventsource','redirect','redirect-target','keepalive','webtransport','fetchLater','ping','download','worker','shared','blob','window-open','form','navigation','top-location','dns-prefetch','preconnect','prefetch','prerender','speculation','stun','turn'];
/** Build inherited-context markup without executing it locally.
 * @param {string} kind @param {string} nestedurl */
export function inheritedScript(kind,nestedurl){
 if(!['nested','srcdoc','opaque-srcdoc','about-blank'].includes(kind))throw new Error('unknown inherited context');
 const setup=kind==='nested'?`f.src=${JSON.stringify(nestedurl)}`:kind==='about-blank'?`f.src='about:blank'`:`f.srcdoc='<input>';${kind==='opaque-srcdoc'?"f.sandbox='allow-scripts'":''}`;
 return `(()=>{const f=document.createElement('iframe');f.name=${JSON.stringify(kind)};${setup};document.body.append(f)})()`;
}
/** @param {string} prefix */
async function fixtures(prefix){
 /** @type {Record<string,any>} */ const endpoints={};
 /** @type {Record<string,any>} */ const records={};
 /** @type {(()=>void)[]} */ const closers=[];
 for(const name of vectors){
  const host=`${prefix}-${name.replaceAll(/[^a-z0-9-]/gi,'-').toLowerCase()}.${['dns-prefetch','stun','turn'].includes(name)?'localhost':'s9.test'}`;
  /** @type {any} */ const rec=records[name]={host,http:[],tcp:[],udp:[]};
  /** @type {any} */ let server;
  if(name==='stun'||name==='webtransport'){
   server=dgram.createSocket('udp4');server.on('message',(/** @type {any} */ data,/** @type {any} */ remote)=>rec.udp.push({bytes:data.length,address:remote.address,sourcePort:remote.port,magicCookie:data.length>=8?data.readUInt32BE(4).toString(16):null,stun:data.length>=20&&data.readUInt32BE(4)===0x2112a442,time:Date.now()}));
   await new Promise(r=>server.bind(0,'127.0.0.1',()=>r(undefined)));
  }else if(name==='turn'){
   server=net.createServer(socket=>{const entry={sourcePort:socket.remotePort,address:socket.remoteAddress,bytes:0};rec.tcp.push(entry);socket.on('data',b=>{entry.bytes+=b.length;});socket.on('error',()=>{});setTimeout(()=>socket.destroy(),1700);});
   await new Promise(r=>server.listen(0,'127.0.0.1',()=>r(undefined)));
  }else{
   server=http.createServer((req,res)=>{rec.http.push({host:req.headers.host,url:req.url,method:req.method,headers:{purpose:req.headers['sec-purpose']||req.headers.purpose}});res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers','*');
    if(name==='redirect'){res.writeHead(302,{location:endpoints['redirect-target'].url});res.end();return;}
    if(name==='eventsource')res.setHeader('Content-Type','text/event-stream');
    if(name==='css'||name==='css-import')res.setHeader('Content-Type','text/css');
    if(name==='download')res.setHeader('Content-Disposition','attachment; filename="fixture.txt"');
    res.end(name==='css'||name==='css-import'?'body{color:black}':name==='eventsource'?'data: fixture\n\n':'fixture');});
   server.on('connection',(/** @type {any} */ socket)=>{const entry={sourcePort:socket.remotePort,address:socket.remoteAddress,firstBytes:''};rec.tcp.push(entry);socket.once('data',(/** @type {Buffer} */ bytes)=>entry.firstBytes=bytes.subarray(0,5).toString('hex'));socket.on('error',()=>{});});
   server.on('upgrade',(/** @type {any} */ req,/** @type {any} */ socket)=>{rec.http.push({host:req.headers.host,url:req.url,method:'WS'});const accept=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');socket.on('error',()=>{});setTimeout(()=>socket.destroy(),300);});
   await new Promise(r=>server.listen(0,'127.0.0.1',()=>r(undefined)));
  }
  const port=server.address().port;endpoints[name]={url:`http://${host}:${port}/${name}`,host,port,ice:name==='stun'?`stun:${host}:${port}`:name==='turn'?`turn:${host}:${port}?transport=tcp`:undefined};
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
function zeroRtc(records){return (records?.stun?.udp?.length||0)===0&&(records?.turn?.tcp?.length||0)===0;}
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
 for(const mode of ['control','csp','filter','combined','allowlist','ip-policy','non-plugin']){
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
   await ses.setProxy({mode:'direct'});
   const useCsp=['csp','combined','allowlist','ip-policy'].includes(mode),useFilter=['filter','combined','allowlist','ip-policy'].includes(mode),header=mode==='allowlist';
   const registry=new Map([['clover-plugin://p1',new Set([new URL(f.endpoints['own-fetch'].url).origin])],['clover-plugin://p2',new Set([new URL(f.endpoints['other-plugin-fetch'].url).origin])]]);
   /** @type {any[]} */ const requests=[];
   /** @type {any[]} */ const preconnect=[];
   /** @type {any[]} */ const mountAttempts=[];
   /** @type {any[]} */ const popups=[];
   /** @type {any[]} */ const navigations=[];
   /** @type {any[]} */ const downloads=[];
   activeGone=rendererGone;
   ses.on('preconnect',(/** @type {any} */ _event,/** @type {any} */ url,/** @type {any} */ allowCredentials)=>preconnect.push({url,allowCredentials}));
   ses.on('will-download',(/** @type {any} */ event,/** @type {any} */ item)=>{downloads.push({url:item.getURL()});event.preventDefault();});
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
   win=new BrowserWindow({show:true,width:1000,height:800,webPreferences:{session:ses,sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
   if(mode==='ip-policy')win.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
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
   try{
    if(frame)main=await Promise.race([invoke(frame,f.endpoints,mode!=='non-plugin'),pause(16000).then(()=>({error:'document probe deadline'}))]);
    if(mode!=='non-plugin'){
     const p2=liveFrame(win.webContents.mainFrame,p2url);
     if(p2)second=await p2.executeJavaScript(`Promise.all(${JSON.stringify([f.endpoints['own-fetch'].url,f.endpoints['other-plugin-fetch'].url])}.map(url=>fetch(url).then(r=>({url,status:r.status})).catch(e=>({url,error:String(e)}))))`);
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
       const report=await frame.executeJavaScript(`new Promise(resolve=>{window.trustViolations=[];const f=document.createElement('iframe');f.name='trust-'+${JSON.stringify(target)};f.src=${JSON.stringify(target)};f.onload=()=>resolve({target:${JSON.stringify(target)},loadEvent:true});f.onerror=()=>resolve({target:${JSON.stringify(target)},error:true});document.body.append(f);setTimeout(()=>resolve({target:${JSON.stringify(target)},settled:true}),150)})`);
       const child=frame.frames.find((/** @type {any} */ x)=>{try{return x.name==='trust-'+target;}catch{return false;}});
       let actualUrl=null;try{actualUrl=child?.url??null;}catch{actualUrl='disposed';}
       const violations=await frame.executeJavaScript('window.trustViolations');
       // An iframe load event fires for a CSP error page too, and the frame can still report
       // the requested URL. A matching frame-src violation is the decisive block record.
       const blocked=violations.some((/** @type {any} */ v)=>v.directive==='frame-src'&&target.startsWith(v.blocked+':'))||actualUrl==='about:blank'||!child;
       trustAttempts.push({...report,actualUrl,violations,loaded:!blocked,blocked});
      }
      trustAttempts.push({children:frame.frames.map((/** @type {any} */ child)=>{try{return {name:child.name,url:child.url};}catch{return {name:null,url:'disposed'};}})});
      topNavigation=await frame.executeJavaScript(`(()=>{try{top.location=${JSON.stringify(f.endpoints['top-location'].url)};return {attempted:true}}catch(e){return {attempted:true,error:String(e)}}})()`);
      await frame.executeJavaScript(`(()=>{const a=document.createElement('a');a.href=${JSON.stringify(f.endpoints.download.url)};a.download='fixture.txt';document.body.append(a);a.click()})()`).catch(()=>{});
     }
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
   const entry={mode,header:header?'Connection-Allowlist on documents and worker scripts':null,ipPolicy:win.webContents.getWebRTCIPHandlingPolicy(),main,mainCandidates:candidateInfo(resultCandidates(main)),second,mountReuse,records:f.records,requests,preconnect,popups,navigations,downloads,downloadAttempt:mode!=='non-plugin',topNavigation,mountAttempts,trustAttempts,rendererGone,contexts:inherited,netlog:log};
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
 const a=variants.find(v=>v.mode==='allowlist'),control=variants.find(v=>v.mode==='combined'),plain=variants.find(v=>v.mode==='control'),non=variants.find(v=>v.mode==='non-plugin'),ip=variants.find(v=>v.mode==='ip-policy');
 const mainCandidates=(/** @type {any} */ v)=>candidateInfo(resultCandidates(v));
 const tested=(/** @type {any} */ v)=>['stun','turn-tcp'].every(name=>(v?.outcomes||[]).some((/** @type {any} */ o)=>o.name===name&&o.result?.supported===true&&Array.isArray(o.result.candidates)));
 const dns=(/** @type {any} */ v,/** @type {string} */ host)=>v?.netlog?.speculative?.filter((/** @type {any} */ e)=>JSON.stringify(e.params).includes(host))||[];
 const directClosed=!!a&&!a.error&&tested(a.main)&&zeroRtc(a.records)&&mainCandidates(a.main).network===0&&dns(a,a.records['dns-prefetch'].host).length===0;
 const inheritedClosed=!!a&&!a.error&&Array.isArray(a.contexts)&&a.contexts.length>0&&a.contexts.every((/** @type {any} */ c)=>c.closed);
 const assertions={undeclaredStunPositive:!!control&&control.records?.stun?.udp?.some((/** @type {any} */ p)=>p.stun),undeclaredTurnPositive:!!control&&(control.records?.turn?.tcp?.length||0)>0,allowlistDirectClosed:directClosed,allowlistInheritedClosed:inheritedClosed,allowlistInheritedCrashClosure:!!a&&Array.isArray(a.contexts)&&a.contexts.some((/** @type {any} */ c)=>c.rendererGone||c.result?.rendererKilled),ipPolicyRan:!!ip&&!ip.error,nonPluginStillConnects:!!non&&(non.records?.stun?.udp?.length||0)>0&&(non.records?.turn?.tcp?.length||0)>0,nonPluginDns:!!non&&dns(non,non.records['dns-prefetch'].host).length>0,dnsPositive:!!plain&&dns(plain,plain.records['dns-prefetch'].host).length>0,dnsRefused:!!a&&dns(a,a.records['dns-prefetch'].host).length===0,preconnectEventPositive:!!plain&&plain.preconnect?.some((/** @type {any} */ e)=>e.url.includes(plain.records.preconnect.host))};
 // Crash-closure of inherited contexts is an explicit Chromium 156 outcome, not a fail.
 const required=['undeclaredStunPositive','undeclaredTurnPositive','allowlistDirectClosed','allowlistInheritedClosed','ipPolicyRan','nonPluginStillConnects','nonPluginDns','dnsPositive','dnsRefused','preconnectEventPositive'];
 app.removeListener('render-process-gone',onRendererGone);
 return {verdict:required.every(k=>assertions[/** @type {keyof typeof assertions} */(k)])?'works with limits':'does not',assertions,variants};
}

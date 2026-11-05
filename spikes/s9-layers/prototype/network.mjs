import http from 'node:http';
import net from 'node:net';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {csp,decision} from './policy.mjs';
import {extractNetlog} from './netlog.mjs';
import {networkProbe} from './probes.mjs';
const pause=(/** @type {any} */ ms)=>new Promise(r=>setTimeout(r,ms));
const vectors=['own-fetch','other-plugin-fetch','wrong-port','fetch','xhr','image','css','font','script','media','object','css-import','background','websocket','beacon','eventsource','redirect','redirect-target','keepalive','webtransport','fetchLater','ping','download','worker','shared','blob','window-open','form','navigation','top-location','dns-prefetch','preconnect','prefetch','prerender','speculation','stun','turn'];
/** @param {string} prefix */
async function fixtures(prefix){
 /** @type {Record<string,any>} */ const endpoints={};
 /** @type {Record<string,any>} */ const records={};
 /** @type {(()=>void)[]} */ const closers=[];
 for(const name of vectors){
  const host=`${prefix}-${name.replaceAll(/[^a-z0-9-]/gi,'-').toLowerCase()}.${name==='dns-prefetch'?'localhost':'s9.test'}`;
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
   server.on('connection',(/** @type {any} */ socket)=>{rec.tcp.push({sourcePort:socket.remotePort,address:socket.remoteAddress});socket.on('error',()=>{});});
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
/** @param {any} electron */
export async function networkCheck(electron){
 const {BrowserWindow,session}=electron;
 /** @type {any[]} */ const variants=[];
 for(const mode of ['control','csp','filter','combined','allowlist','ip-policy','non-plugin']){
  console.log(`Clover S9 revised network: ${mode}`);
  const f=await fixtures(mode),contexts=[],ses=session.fromPartition(`s9-${crypto.randomUUID()}`);
  await ses.setProxy({mode:'direct'});
  const useCsp=['csp','combined','allowlist','ip-policy'].includes(mode),useFilter=['filter','combined','allowlist','ip-policy'].includes(mode),header=mode==='allowlist';
  const registry=new Map([['clover-plugin://p1',new Set([new URL(f.endpoints['own-fetch'].url).origin])],['clover-plugin://p2',new Set([new URL(f.endpoints['other-plugin-fetch'].url).origin])]]);
  /** @type {any[]} */ const requests=[];
/** @type {any[]} */ const preconnect=[];
/** @type {any[]} */ const mountAttempts=[];
/** @type {any[]} */ const popups=[];
/** @type {any[]} */ const navigations=[];
/** @type {any[]} */ const downloads=[];
  ses.on('preconnect',(/** @type {any} */ _event,/** @type {any} */ url,/** @type {any} */ allowCredentials)=>preconnect.push({url,allowCredentials}));
  ses.on('will-download',(/** @type {any} */ event,/** @type {any} */ item)=>{downloads.push({url:item.getURL()});event.preventDefault();});
  ses.setPermissionRequestHandler((/** @type {any} */ _wc,/** @type {any} */ _p,/** @type {any} */ cb)=>cb(false));ses.setPermissionCheckHandler(()=>false);
  const mounts=new Map();
  const issue=(/** @type {any} */ host,/** @type {any} */ ancestors)=>{const token=crypto.randomUUID();const url=`clover-plugin://${host}/?mount=${token}`;mounts.set(token,{host,ancestors});return url;};
  const p1url=issue('p1',['clover-core://shell']),p2url=issue('p2',['clover-core://shell']);
  const nestedurl=issue('p1',['clover-core://shell','clover-plugin://p1']);
  const rootToken=crypto.randomUUID();
  const serve=(/** @type {any} */ request)=>{
   const url=new URL(request.url),core=url.protocol==='clover-core:',worker=url.pathname.endsWith('.js');
   if(core){if(url.searchParams.get('mount')!==rootToken)return new Response('forbidden',{status:403});return new Response(`<iframe id="one" src="${p1url}" width="400" height="400"></iframe><iframe id="two" src="${p2url}" width="400" height="400"></iframe>`,{headers:{'Content-Type':'text/html','Content-Security-Policy':"default-src 'none'; frame-src clover-plugin://p1 clover-plugin://p2; frame-ancestors 'none'"}});}
   if(url.protocol==='clover-sealed:')return new Response('forbidden',{status:403,headers:{'Content-Security-Policy':"frame-ancestors 'none'"}});
   const mount=mounts.get(url.searchParams.get('mount'));
   if(!worker&&(!mount||mount.host!==url.host)){mountAttempts.push({url:request.url,denied:true});return new Response('forbidden',{status:403,headers:{'Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'"}});}
   const allowed=[...(registry.get(url.origin)||[])];
   // WHATWG URL.origin is null for custom schemes in Node; explicit scheme+host registry key.
   const key=`${url.protocol}//${url.host}`;const grants=[...(registry.get(key)||[])];
   /** @type {Record<string,string>} */ const headers={'Content-Type':worker?'text/javascript':'text/html','Content-Security-Policy':csp(grants,useCsp,["'self'"])+`; frame-ancestors ${(mount?.ancestors||['clover-core://shell','clover-plugin://p1']).join(' ')}`};
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
  const win=new BrowserWindow({show:true,width:1000,height:800,webPreferences:{session:ses,sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  if(mode==='ip-policy')win.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  win.webContents.setWindowOpenHandler((/** @type {any} */ d)=>{popups.push(d.url);return {action:'deny'}});
  win.webContents.on('will-frame-navigate',(/** @type {any} */ e)=>{if(!e.url.startsWith('clover-plugin:')){navigations.push({url:e.url,blocked:true});e.preventDefault();}});
  win.webContents.on('will-navigate',(/** @type {any} */ e)=>{navigations.push({url:e.url,blocked:true});e.preventDefault();});
  const logPath=resolve('results',`netlog-v2-${mode}.json`);await ses.netLog.startLogging(logPath);
  // Non-plugin control is an HTTP document from the same loopback fixture session.
  if(mode==='non-plugin')await win.loadURL(f.endpoints['own-fetch'].url);
  else await win.loadURL(`clover-core://shell/?mount=${rootToken}`);
  await pause(250);
  const frame=mode==='non-plugin'?win.webContents.mainFrame:win.webContents.mainFrame.frames.find((/** @type {any} */ x)=>x.url===p1url);
  const invoke=(/** @type {any} */ fr,/** @type {any} */ ep,/** @type {any} */ full)=>fr.executeJavaScript(`(${networkProbe.toString()})(${JSON.stringify(ep)},${full})`);
  const main=await invoke(frame,f.endpoints,mode!=='non-plugin');
  let second=null;
  if(mode!=='non-plugin'){
   const p2=win.webContents.mainFrame.frames.find((/** @type {any} */ x)=>x.url===p2url);
   second=await p2.executeJavaScript(`Promise.all(${JSON.stringify([f.endpoints['own-fetch'].url,f.endpoints['other-plugin-fetch'].url])}.map(url=>fetch(url).then(r=>({url,status:r.status})).catch(e=>({url,error:String(e)}))))`);
   // Test inheritance in nested, srcdoc, opaque srcdoc and about:blank documents.
   for(const kind of ['nested','srcdoc','opaque-srcdoc','about-blank']){
    const cf=await fixtures(`${mode}-${kind}`);contexts.push({kind,fixture:cf,result:null});
    await frame.executeJavaScript(`(()=>{const f=document.createElement('iframe');f.name=${JSON.stringify(kind)};${kind==='nested'?`f.src=${JSON.stringify(nestedurl)}`:kind==='about-blank'?`f.src='about:blank'`:`f.srcdoc='<input>';${kind==='opaque-srcdoc'?"f.sandbox='allow-scripts'":''}`}document.body.append(f)})()`);
    await pause(180);const child=frame.frames.find((/** @type {any} */ x)=>x.name===kind);contexts[contexts.length-1].result=await invoke(child,cf.endpoints,false);
   }
   const wf=await fixtures(`${mode}-worker`);contexts.push({kind:'worker',fixture:wf,result:null});
   // A separate worker script response receives the same header and CSP.
   // Pass endpoints in the message so this context has its own names and ports.
   // Replace handler above's endpoint-only script using a data parameter in worker message.
   contexts[contexts.length-1].result=await frame.executeJavaScript(`new Promise(resolve=>{const w=new Worker('/context-worker.js');w.onmessage=e=>{w.terminate();resolve(e.data)};w.onerror=e=>resolve({error:e.message});w.postMessage(${JSON.stringify(wf.endpoints)})})`);
   const attempts=[];
   for(const target of ['clover-plugin://p2/','clover-core://shell/','clover-sealed://cards/']){
    attempts.push(await frame.executeJavaScript(`new Promise(resolve=>{const f=document.createElement('iframe');f.src=${JSON.stringify(target)};f.onload=()=>resolve({target:${JSON.stringify(target)},loaded:true});f.onerror=()=>resolve({target:${JSON.stringify(target)},error:true});document.body.append(f);setTimeout(()=>resolve({target:${JSON.stringify(target)},settled:true}),150)})`));
   }
   await frame.executeJavaScript(`(()=>{try{top.location=${JSON.stringify(f.endpoints['top-location'].url)}}catch(e){window.topError=String(e)}})()`);
  }
  await pause(350);await ses.netLog.stopLogging();
  const log=extractNetlog(JSON.parse(readFileSync(logPath,'utf8')));
  const inherited=contexts.map(c=>({kind:c.kind,result:c.result,records:c.fixture.records}));
  variants.push({mode,header:header?'Connection-Allowlist on documents and worker scripts':null,ipPolicy:win.webContents.getWebRTCIPHandlingPolicy(),main,second,records:f.records,requests,preconnect,popups,navigations,downloads,mountAttempts,contexts:inherited,netlog:log});
  win.destroy();f.close();contexts.forEach(c=>c.fixture.close());
 }
 const a=variants.find(v=>v.mode==='allowlist'),control=variants.find(v=>v.mode==='combined'),non=variants.find(v=>v.mode==='non-plugin');
 const candidates=(/** @type {any} */ v)=>(v?.outcomes||[]).filter((/** @type {any} */ o)=>['stun','turn-tcp'].includes(o.name)).flatMap((/** @type {any} */ o)=>o.result?.candidates||[]);
 const directClosed=a.records.stun.udp.length===0&&a.records.turn.tcp.length===0&&candidates(a.main).length===0;
 const inheritedClosed=a.contexts.every((/** @type {any} */ c)=>c.records.stun.udp.length===0&&c.records.turn.tcp.length===0&&candidates(c.result).length===0);
 return {verdict:directClosed&&inheritedClosed?'works with limits':'does not',assertions:{undeclaredStunPositive:control.records.stun.udp.some((/** @type {any} */ p)=>p.stun),undeclaredTurnPositive:control.records.turn.tcp.length>0,allowlistDirectClosed:directClosed,allowlistInheritedClosed:inheritedClosed,nonPluginStillConnects:non.records.stun.udp.length>0&&non.records.turn.tcp.length>0},variants};
}

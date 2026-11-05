/** Runs in a document or worker MAIN world. Every endpoint is a distinct name/port.
 * @param {any} endpoints @param {boolean} [full] */
export async function networkProbe(endpoints, full = true) {
 /** @type {any[]} */ const out = [];
/** @type {any[]} */ const violations=[];
 const wait = (/** @type {any} */ ms)=> new Promise(r=>setTimeout(r,ms));
 globalThis.addEventListener('securitypolicyviolation',e=>violations.push({directive:e.effectiveDirective,blockedURI:e.blockedURI}));
 const attempt=async(/** @type {any} */ name,/** @type {any} */ fn)=>{try{out.push({name,result:await Promise.race([fn(),wait(1400).then(()=>({timeout:true}))])});}catch(e){out.push({name,error:String(e)});}await wait(80);};
 const rtc=async(/** @type {any} */ url)=>{
  if(typeof RTCPeerConnection==='undefined')return {supported:false};
  const pc=new RTCPeerConnection({iceServers:[{urls:url,username:'fixture',credential:'fixture'}]});
  /** @type {string[]} */ const candidates=[];pc.onicecandidate=e=>{if(e.candidate)candidates.push(e.candidate.candidate);};
  try{pc.createDataChannel('fixture');await pc.setLocalDescription(await pc.createOffer());await wait(900);return {supported:true,candidates,state:pc.iceGatheringState};}catch(e){return {supported:true,candidates,error:String(e),state:pc.iceGatheringState};}finally{pc.close();}
 };
 await attempt('stun',()=>rtc(endpoints.stun.ice));
 await attempt('turn-tcp',()=>rtc(endpoints.turn.ice));
 if(typeof document!=='undefined'){
  for(const rel of (full?['dns-prefetch','preconnect','prefetch','prerender']:['dns-prefetch']))await attempt(rel,async()=>{const el=document.createElement('link');el.rel=rel;el.href=endpoints[rel].url;document.head.append(el);await wait(200);return 'inserted';});
  if(full)await attempt('speculationrules',async()=>{const s=document.createElement('script');s.type='speculationrules';s.textContent=JSON.stringify({prefetch:[{source:'list',urls:[endpoints.speculation.url]}],prerender:[{source:'list',urls:[endpoints.prerender.url]}]});document.head.append(s);await wait(200);return 'inserted';});
 }
 await attempt('fetch',()=>fetch(endpoints.fetch.url).then(r=>r.status));
 if(!full)return {outcomes:out,violations};
 for(const name of ['own-fetch','other-plugin-fetch','wrong-port','keepalive'])await attempt(name,()=>fetch(endpoints[name].url,{keepalive:name==='keepalive'}).then(r=>r.status));
 await attempt('own-websocket',()=>new Promise(r=>{const ws=new WebSocket(endpoints['own-fetch'].url.replace('http:','ws:'));ws.onopen=()=>{ws.close();r('open')};ws.onerror=()=>r('error');}));
 await attempt('xhr',()=>new Promise(r=>{const x=new XMLHttpRequest();x.open('GET',endpoints.xhr.url);x.onload=()=>r(x.status);x.onerror=()=>r('error');x.send();}));
 for(const name of ['image','css','font','script','media','object'])await attempt(name,async()=>{
  const url=endpoints[name].url;
  if(name==='font')return new FontFace('probe',`url(${url})`).load().then(()=>true);
  /** @type {any} */ const el=document.createElement(({image:'img',css:'link',script:'script',media:'video',object:'object'})[name]||'div');
  if(name==='css'){el.rel='stylesheet';el.href=url;}else if(name==='object')el.data=url;else el.src=url;
  if(name==='media'){el.muted=true;el.preload='auto';}document.body.append(el);await wait(150);return 'inserted';
 });
 await attempt('css-urls',async()=>{const s=document.createElement('style');s.textContent=`@import url('${endpoints['css-import'].url}');body{background-image:url('${endpoints.background.url}')}`;document.head.append(s);return 'inserted';});
 await attempt('websocket',()=>new Promise(r=>{const ws=new WebSocket(endpoints.websocket.url.replace('http:','ws:'));ws.onopen=()=>{ws.close();r('open')};ws.onerror=()=>r('error');}));
 await attempt('beacon',async()=>navigator.sendBeacon(endpoints.beacon.url,'fixture'));
 await attempt('eventsource',()=>new Promise(r=>{const es=new EventSource(endpoints.eventsource.url);es.onopen=()=>{es.close();r('open')};es.onerror=()=>{es.close();r('error')};}));
 await attempt('redirect',()=>fetch(endpoints.redirect.url).then(r=>r.status));
 await attempt('webtransport',async()=>{if(typeof WebTransport==='undefined')return {supported:false};const wt=new WebTransport(endpoints.webtransport.url.replace('http:','https:'));wt.closed.catch(()=>{});try{return await Promise.race([wt.ready.then(()=>({ready:true})),wait(600).then(()=>({pending:true}))]);}finally{wt.close();}});
 await attempt('fetchLater',async()=>{if(typeof /** @type {any} */ (globalThis).fetchLater!=='function')return {supported:false};
/** @type {any} */ (globalThis).fetchLater(endpoints.fetchLater.url,{activateAfter:0});await wait(300);return {supported:true};});
 for(const name of ['ping'])await attempt(name,async()=>{const a=document.createElement('a');a.href=name==='ping'?'#probe':endpoints.download.url;if(name==='ping')a.ping=endpoints.ping.url;else a.download='fixture.txt';a.textContent=name;document.body.append(a);a.click();await wait(200);return 'clicked';});
 for(const path of ['worker','shared','blob'])await attempt(path,()=>new Promise(r=>{
  const code=`fetch(${JSON.stringify(endpoints[path].url)}).then(()=>postMessage('sent')).catch(()=>postMessage('blocked'));`;
  if(path==='shared'){const w=new SharedWorker('/shared.js');w.port.onmessage=e=>{r(e.data);w.port.close()};w.port.start();w.onerror=()=>r('error');}
  else{const w=new Worker(path==='blob'?URL.createObjectURL(new Blob([code],{type:'text/javascript'})):'/worker.js');w.onmessage=e=>{r(e.data);w.terminate()};w.onerror=()=>r('error');}
 }));
 await attempt('service-worker',async()=>{try{await navigator.serviceWorker.register('/sw.js');return {registered:true};}catch(e){return {registered:false,error:String(e)};}});
 for(const name of ['window-open','form','navigation'])await attempt(name,async()=>{
  if(name==='window-open')return {opened:!!window.open(endpoints[name].url)};
  if(name==='form'){const f=document.createElement('form');f.action=endpoints.form.url;f.target='_blank';document.body.append(f);f.submit();return 'submitted';}
  const f=document.createElement('iframe');f.src=endpoints.navigation.url;document.body.append(f);return 'inserted';
 });
 await wait(300);return {outcomes:out,violations};
}

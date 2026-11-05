// Executes in the plugin frame's MAIN world: no Node, no host bridge.
export async function networkProbe(base, denied, udpPort) {
  const violations = [];
  document.addEventListener('securitypolicyviolation', e => violations.push({ directive: e.effectiveDirective, blockedURI: e.blockedURI }));
  const outcomes = [];
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const attempt = async (name, fn) => {
    const start = violations.length;
    try { outcomes.push({ name, result: await Promise.race([fn(), wait(1200).then(() => 'timeout')]), violations: violations.slice(start) }); }
    catch (e) { outcomes.push({ name, error: String(e), violations: violations.slice(start) }); }
    await wait(100);
  };
  const target = (host, name) => `${host}/${name}?case=${name}`;
  for (const [label, host] of [['allowed', base], ['denied', denied]]) {
    await attempt(`${label}-fetch`, () => fetch(target(host, `${label}-fetch`)).then(r => r.status));
    await attempt(`${label}-xhr`, () => new Promise(resolve => { const x = new XMLHttpRequest(); x.open('GET', target(host, `${label}-xhr`)); x.onload = () => resolve(x.status); x.onerror = () => resolve('error'); x.send(); }));
    await attempt(`${label}-image`, () => new Promise(resolve => { const el = new Image(); el.onload = () => resolve('load'); el.onerror = () => resolve('error'); el.src = target(host, `${label}-image`); document.body.append(el); }));
    await attempt(`${label}-css`, () => new Promise(resolve => { const el = document.createElement('link'); el.rel = 'stylesheet'; el.onload = () => resolve('load'); el.onerror = () => resolve('error'); el.href = target(host, `${label}-css`); document.head.append(el); }));
    await attempt(`${label}-font`, () => new FontFace('probe', `url(${target(host, `${label}-font`)})`).load().then(() => 'load'));
    await attempt(`${label}-websocket`, () => new Promise(resolve => { const ws = new WebSocket(target(host.replace('http:', 'ws:'), `${label}-websocket`)); ws.onopen = () => { ws.close(); resolve('open'); }; ws.onerror = () => resolve('error'); }));
    await attempt(`${label}-beacon`, async () => navigator.sendBeacon(target(host, `${label}-beacon`), 'fixture'));
    for (const rel of ['dns-prefetch', 'preconnect', 'prefetch', 'prerender']) await attempt(`${label}-${rel}`, async () => { const el = document.createElement('link'); el.rel = rel; el.href = target(host, `${label}-${rel}`); document.head.append(el); await wait(400); return 'inserted'; });
  }
  await attempt('denied-script', () => new Promise(resolve => { const s = document.createElement('script'); s.src = denied + '/external.js'; s.onload=()=>resolve('load'); s.onerror=()=>resolve('error'); document.head.append(s); }));
  await attempt('denied-css-import', async () => { const s=document.createElement('style');s.textContent=`@import url('${denied}/css-import'); body{background-image:url('${denied}/css-background')}`;document.head.append(s);await wait(300);return 'inserted'; });
  await attempt('denied-eventsource', () => new Promise(resolve => { const es=new EventSource(denied+'/eventsource');es.onopen=()=>{es.close();resolve('open')};es.onerror=()=>{es.close();resolve('error')}; }));
  await attempt('denied-fetch-keepalive', () => fetch(denied+'/keepalive',{method:'POST',body:'fixture',keepalive:true}).then(r=>r.status));
  await attempt('denied-remote-worker', async () => {const w=new Worker(denied+'/remote-worker.js');w.terminate();return 'created';});
  await attempt('denied-object', async () => {const o=document.createElement('object');o.data=denied+'/object';document.body.append(o);await wait(300);return 'inserted';});
  await attempt('denied-media', async () => {const v=document.createElement('video');v.muted=true;v.preload='auto';v.src=denied+'/media';document.body.append(v);v.load();await wait(300);return 'inserted';});
  await attempt('opaque-frame-fetch', async () => { const f=document.createElement('iframe');f.sandbox.add('allow-scripts');f.srcdoc=`<script>fetch(${JSON.stringify(denied+'/opaque-fetch')}).catch(()=>{})<\/script>`;document.body.append(f);await wait(300);return 'inserted'; });
  await attempt('redirect', () => fetch(`${base}/redirect`).then(r => r.status));
  await attempt('dedicated-worker', () => new Promise(resolve => { const w = new Worker('/worker.js'); w.onmessage = e => { resolve(e.data); w.terminate(); }; w.onerror = () => resolve('error'); }));
  await attempt('blob-worker', () => new Promise(resolve => { const w = new Worker(URL.createObjectURL(new Blob([`fetch(${JSON.stringify(denied + '/blob-worker')}).then(()=>postMessage('sent')).catch(()=>postMessage('blocked'))`], {type:'text/javascript'}))); w.onmessage = e => { resolve(e.data); w.terminate(); }; w.onerror = () => resolve('error'); }));
  await attempt('shared-worker', () => new Promise(resolve => { const w = new SharedWorker('/shared.js'); w.port.onmessage = e => { resolve(e.data); w.port.close(); }; w.onerror = () => resolve('error'); w.port.start(); }));
  await attempt('service-worker', async () => { const reg = await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; return { scope: reg.scope, registered: true }; });
  await attempt('speculationrules', async () => { const s = document.createElement('script'); s.type = 'speculationrules'; s.textContent = JSON.stringify({prefetch:[{source:'list', urls:[denied + '/speculation-prefetch']}],prerender:[{source:'list',urls:[denied + '/speculation-prerender']}]}); document.head.append(s); await wait(600); return 'inserted'; });
  await attempt('webrtc', async () => {
    if (!globalThis.RTCPeerConnection) return { disabled: true };
    const pc = new RTCPeerConnection({ iceServers: [{urls:`stun:127.0.0.1:${udpPort}`}] });
    pc.createDataChannel('fixture'); await pc.setLocalDescription(await pc.createOffer()); await wait(800);
    const result = { disabled: false, state: pc.iceGatheringState, sdp: !!pc.localDescription?.sdp }; pc.close(); return result;
  });
  await attempt('window-open', async () => { const w = window.open(denied + '/window-open'); return { returnedWindow: !!w }; });
  await attempt('subframe-navigation', async () => { const f = document.createElement('iframe'); f.src = denied + '/subframe-navigation'; document.body.append(f); await wait(400); return 'inserted'; });
  await attempt('form', async () => { const f = document.createElement('form'); f.action = denied + '/form'; f.target = '_blank'; document.body.append(f); f.submit(); return 'submitted'; });
  await wait(700);
  return { outcomes, violations, capabilities: { node: typeof globalThis.require, rtc: typeof globalThis.RTCPeerConnection, secure: isSecureContext, origin: location.origin } };
}

// Offline: summarize socket and resolver events from S9 netlogs, attributed by fixture.
// Reads a downloaded CI artifact directory; launches nothing, needs no Electron.
// Usage: node netlog-extract.mjs <artifact-dir> [run-id] > netlog-extract.json
// Output keeps loopback fixture ports and counts only, never the runner's own addresses.
import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

/** Fixture labels for one variant: listener source ports and fixture host names.
 * Scopes are `main` and each inherited context kind.
 * @param {any} variant */
export function fixtureIndex(variant){
 /** @type {Map<number,string>} */ const sourcePorts=new Map();
 /** @type {Map<string,string>} */ const hosts=new Map();
 /** @param {string} scope @param {any} records */
 const add=(scope,records)=>{for(const [name,rec] of Object.entries(records||{})){
  const r=/** @type {any} */ (rec);if(r?.host)hosts.set(r.host,`${scope}/${name}`);
  for(const entry of [...(r?.udp||[]),...(r?.tcp||[])])if(Number.isInteger(entry?.sourcePort))sourcePorts.set(entry.sourcePort,`${scope}/${name}`);
 }};
 add('main',variant.records);
 for(const c of variant.contexts||[])add(c.kind,c.records);
 return {sourcePorts,hosts};
}

/** @param {string} address */
function split(address){const i=address.lastIndexOf(':');return {host:address.slice(0,i).replace(/^\[|\]$/g,''),port:Number(address.slice(i+1))};}
/** @param {string} host */
const loopback=(host)=>host==='127.0.0.1'||host==='::1';
/** @param {Record<string,number>} counts @param {string} key */
const bump=(counts,key)=>{counts[key]=(counts[key]||0)+1;};

/** Summarize one variant's netlog against its fixture records.
 * @param {any} log @param {any} variant */
export function summarizeNetlog(log,variant){
 const names=new Map(Object.entries(log.constants.logEventTypes).map(([k,v])=>[v,k]));
 const {sourcePorts,hosts}=fixtureIndex(variant);
 /** @type {Map<number,{local?:number,connect?:{host:string,port:number},sends:({host:string,port:number}|null)[]}>} */ const udp=new Map();
 /** @type {{port:number,local?:number,ok:boolean}[]} */ const tcp=[];
 /** @type {Map<number,{port:number,local?:number,ok:boolean}>} */ const openTcp=new Map();
 /** @type {Record<string,number>} */ const speculative={};
 /** @type {Record<string,number>} */ const resolved={};
 /** @type {Map<number,string>} */ const portLabels=new Map();
 /** Any event naming a fixture URL, or a fixture host with its port, labels that port.
  * @param {string} name @param {number} port */
 const nameLabel=(name,port)=>{const label=hosts.get(name);if(label&&Number.isInteger(port))portLabels.set(port,label);};
 let tcpElsewhere=0;
 for(const e of log.events||[]){
  const type=names.get(e.type),p=e.params||{},id=e.source?.id;
  if(typeof p.url==='string'){try{const u=new URL(p.url);nameLabel(u.hostname,Number(u.port));}catch{}}
  if(typeof p.host==='string'&&Number.isInteger(p.port))nameLabel(p.host,p.port);
  const sock=()=>{if(!udp.has(id))udp.set(id,{sends:[]});return /** @type {any} */ (udp.get(id));};
  if(type==='UDP_LOCAL_ADDRESS'&&p.address)sock().local=split(p.address).port;
  else if(type==='UDP_CONNECT'&&e.phase===1&&p.address)sock().connect=split(p.address);
  // Connected sockets may log sends without an address; their destination is the connect.
  else if(type==='UDP_BYTES_SENT')sock().sends.push(p.address?split(p.address):null);
  else if(type==='TCP_CONNECT'&&e.phase===1&&Array.isArray(p.address_list)&&p.address_list.length){const d=split(p.address_list[0]);if(!loopback(d.host)){tcpElsewhere++;continue;}const t={port:d.port,ok:false};openTcp.set(id,t);tcp.push(t);}
  else if(type==='TCP_CONNECT'&&e.phase===2&&openTcp.has(id)){const t=/** @type {any} */ (openTcp.get(id));if(p.local_address){t.ok=true;t.local=split(p.local_address).port;}openTcp.delete(id);}
  else if(type==='HOST_RESOLVER_MANAGER_REQUEST'&&e.phase===1&&p.host){
   const name=String(p.host).replace(/^[a-z]+:\/\//,'').replace(/:\d+$/,'');
   const label=hosts.get(name)||(/(^|\.)(s9\.test|localhost)$/.test(name)?'unlisted fixture name':'other name');
   bump(p.is_speculative?speculative:resolved,label);
  }
 }
 // Otherwise a destination port is labeled by the listener that recorded its socket's source port.
 for(const s of udp.values())if(s.local!==undefined&&sourcePorts.has(s.local))for(const d of s.sends){const to=d||s.connect;if(to&&loopback(to.host)&&!portLabels.has(to.port))portLabels.set(to.port,/** @type {string} */ (sourcePorts.get(s.local)));}
 for(const t of tcp)if(t.local!==undefined&&sourcePorts.has(t.local)&&!portLabels.has(t.port))portLabels.set(t.port,/** @type {string} */ (sourcePorts.get(t.local)));
 /** @type {Record<string,number>} */ const p2p={};
 /** @type {Record<string,number>} */ const connected={};
 let udpElsewhere=0,p2pSockets=0;
 for(const s of udp.values()){
  // Unconnected sockets with a bound address are WebRTC P2P sockets; connected ones are QUIC
  // (WebTransport) or resolver reachability probes, which connect but send nothing.
  if(s.local!==undefined&&!s.connect)p2pSockets++;
  for(const d of s.sends){const to=d||s.connect;if(!to||!loopback(to.host)){udpElsewhere++;continue;}bump(s.connect?connected:p2p,portLabels.get(to.port)||'unlabeled loopback port');}
 }
 /** @type {Record<string,number>} */ const tcpConnects={};
 for(const t of tcp)bump(tcpConnects,(portLabels.get(t.port)||'unlabeled loopback port')+(t.ok?'':' (refused attempt)'));
 return {
  udp:{p2pSocketsBound:p2pSockets,p2pDatagrams:p2p,connectedDatagrams:connected,datagramsElsewhere:udpElsewhere},
  tcp:{connectsByFixture:tcpConnects,elsewhere:tcpElsewhere},
  resolver:{speculative,other:resolved},
 };
}

/** @param {string} dir @param {string} [run] */
export function extractArtifact(dir,run){
 const network=JSON.parse(readFileSync(join(dir,'network.json'),'utf8'));
 /** @type {Record<string,any>} */ const variants={};
 for(const v of network.variants){
  const path=join(dir,`netlog-v2-${v.mode}.json`);
  if(!existsSync(path)){variants[v.mode]={missing:true};continue;}
  variants[v.mode]=summarizeNetlog(JSON.parse(readFileSync(path,'utf8')),v);
 }
 return {run:run??null,commit:network.commit,platform:network.platform,arch:network.arch,electron:network.versions?.electron,chrome:network.versions?.chrome,
  method:'netlog-v2-<variant>.json decoded with its own constants; destination ports labeled by the fixture listener that recorded the socket source port; resolver hosts labeled by fixture name. Unconnected UDP sockets are WebRTC P2P sockets; connected ones are resolver reachability probes. IPv6 sends go to ::1, which the 127.0.0.1 listeners never receive.',
  variants};
}

if(import.meta.url===pathToFileURL(process.argv[1]||'').href){
 const dir=process.argv[2];
 if(!dir)throw new Error('usage: node netlog-extract.mjs <artifact-dir> [run-id]');
 process.stdout.write(JSON.stringify(extractArtifact(dir,process.argv[3]),null,1)+'\n');
}

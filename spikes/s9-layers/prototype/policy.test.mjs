import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decision, pluginHost } from './policy.mjs';
import {extractNetlog} from './netlog.mjs';
test('spec ids, lengths, children and IDNA-safe hosts',()=>{
 assert.equal(pluginHost('alpha/menu'),'p-alpha--menu');assert.equal(new URL('clover-plugin://'+pluginHost('xn/child')).host,'p-xn--child');
 for(const id of ['a','alpha-','a--b','../alpha','alpha/x','a'.repeat(41),'alpha/menu/third'])assert.throws(()=>pluginHost(id));
});
test('different plugins, ports, redirects and opaque initiators fail closed',()=>{
 const grants=new Map([['clover-plugin://p-alpha',new Set(['https://one.test:444'])],['clover-plugin://p-beta',new Set(['https://two.test'])]]);
 assert.equal(decision('https://one.test:444/x','clover-plugin://p-alpha',grants).cancel,false);
 assert.equal(decision('wss://one.test:444/x','clover-plugin://p-alpha',grants).cancel,false);
 for(const initiator of [undefined,'null','clover-plugin://unknown','clover-plugin://p-beta'])assert.equal(decision('https://one.test:444',initiator,grants).cancel,true);
 for(const url of ['https://one.test','https://one.test:445','https://two.test','file:///tmp/a','clover-plugin://p-beta'])assert.equal(decision(url,'clover-plugin://p-alpha',grants).cancel,true);
});
test('netlog extracts resolver intent and failure instead of inferring from HTTP silence',()=>{
 // Real Chromium netlogs name phases PHASE_BEGIN / PHASE_END.
 const d=extractNetlog({constants:{logEventTypes:{HOST_RESOLVER_MANAGER_REQUEST:1},logEventPhase:{PHASE_BEGIN:1,PHASE_END:2}},events:[{type:1,phase:1,source:{id:9},params:{host:'dns.localhost',is_speculative:true}},{type:1,phase:2,source:{id:9},params:{net_error:-138}}]});assert.equal(d.speculative.length,1);assert.equal(d.errors.length,1);assert.equal(d.events[0].phaseName,'PHASE_BEGIN');
});

import {summarizeNetlog} from './netlog-extract.mjs';
test('netlog extract labels fixture sockets by listener source port and keeps no runner addresses',()=>{
 const T={UDP_LOCAL_ADDRESS:1,UDP_BYTES_SENT:2,UDP_CONNECT:3,TCP_CONNECT:4,HOST_RESOLVER_MANAGER_REQUEST:5,QUIC_SESSION_WEBTRANSPORT_CLIENT_ALIVE:6};
 const ev=(/** @type {number} */ type,/** @type {number} */ id,/** @type {number} */ phase,/** @type {any} */ params)=>({type,phase,source:{id},params});
 const log={constants:{logEventTypes:T},events:[
  ev(1,1,0,{address:'10.1.2.3:5000'}),ev(2,1,0,{address:'127.0.0.1:7000',byte_count:20}),ev(2,1,0,{address:'127.0.0.1:7000',byte_count:20}),ev(2,1,0,{address:'192.0.2.9:3478',byte_count:20}),
  ev(3,2,1,{address:'[2001:db8::1]:443'}),ev(1,2,0,{address:'[2001:db8::2]:5001'}),
  ev(6,7,1,{url:'https://m-webtransport.s9.test:7100/webtransport'}),ev(3,8,1,{address:'127.0.0.1:7100'}),ev(2,8,0,{byte_count:1200}),ev(2,8,0,{byte_count:1200}),
  ev(4,3,1,{address_list:['[::1]:8000']}),ev(4,3,2,{net_error:-102}),
  ev(4,4,1,{address_list:['127.0.0.1:8000']}),ev(4,4,2,{local_address:'127.0.0.1:6000',remote_address:'127.0.0.1:8000'}),
  ev(4,5,1,{address_list:['198.51.100.7:443']}),
  ev(5,6,1,{host:'http://m-dns-prefetch.localhost:9000',is_speculative:true}),
 ]};
 const variant={records:{stun:{host:'m-stun.localhost',udp:[{sourcePort:5000}]},turn:{host:'m-turn.localhost',tcp:[{sourcePort:6000}]},webtransport:{host:'m-webtransport.s9.test'},'dns-prefetch':{host:'m-dns-prefetch.localhost'}},contexts:[]};
 const s=summarizeNetlog(log,variant);
 assert.deepEqual(s.udp,{p2pSocketsBound:1,p2pDatagrams:{'main/stun':2},connectedDatagrams:{'main/webtransport':2},datagramsElsewhere:1});
 assert.deepEqual(s.tcp,{connectsByFixture:{'main/turn (refused attempt)':1,'main/turn':1},elsewhere:1});
 assert.deepEqual(s.resolver,{speculative:{'main/dns-prefetch':1},other:{}});
 for(const address of ['10.1.2.3','192.0.2.9','198.51.100.7','2001:db8'])assert.equal(JSON.stringify(s).includes(address),false);
});

import {inheritedScript} from './network.mjs';
import {networkProbe} from './probes.mjs';
test('generated document/worker probes parse before CI without executing UI code',()=>{
 for(const kind of ['nested','srcdoc','opaque-srcdoc','about-blank'])assert.doesNotThrow(()=>new Function(inheritedScript(kind,'clover-plugin://p1/?mount=fixture')));
 assert.doesNotThrow(()=>new Function(`return (${networkProbe.toString()})`));
 assert.throws(()=>inheritedScript('unknown',''));
});

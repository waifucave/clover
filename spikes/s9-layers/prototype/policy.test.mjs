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
 const d=extractNetlog({constants:{logEventTypes:{HOST_RESOLVER_MANAGER_REQUEST:1},logEventPhase:{BEGIN:1,END:2}},events:[{type:1,phase:1,source:{id:9},params:{host:'dns.localhost',is_speculative:true}},{type:1,phase:2,source:{id:9},params:{net_error:-138}}]});assert.equal(d.speculative.length,1);assert.equal(d.errors.length,1);
});

import {inheritedScript} from './network.mjs';
import {networkProbe} from './probes.mjs';
test('generated document/worker probes parse before CI without executing UI code',()=>{
 for(const kind of ['nested','srcdoc','opaque-srcdoc','about-blank'])assert.doesNotThrow(()=>new Function(inheritedScript(kind,'clover-plugin://p1/?mount=fixture')));
 assert.doesNotThrow(()=>new Function(`return (${networkProbe.toString()})`));
 assert.throws(()=>inheritedScript('unknown',''));
});

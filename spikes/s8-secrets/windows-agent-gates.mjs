import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';
const root=fs.mkdtempSync('C:/clover-tools/clover-codex-gates-');const work=path.join(root,'work'),control=path.join(root,'control'),config=path.join(root,'config');
for(const p of [work,control,config])fs.mkdirSync(p);
fs.writeFileSync(path.join(control,'public'),'public fixture');fs.symlinkSync(control,path.join(work,'alias'),'junction');
const backend=process.env.CLOVER_CODEX_BACKEND??'unelevated';
fs.writeFileSync(path.join(config,'config.toml'),'[permissions.clover.filesystem]\n":root"="read"\n'+JSON.stringify(work.replaceAll('\\','/'))+'="write"\n'+JSON.stringify(control.replaceAll('\\','/'))+'="deny"\n[permissions.clover.network]\nenabled=false\n[windows]\nsandbox="'+backend+'"\n');
const file=path.join(work,'worker.cjs');fs.writeFileSync(file,`const fs=require('fs'),p=require('path'),cp=require('child_process');const [test,work,control,config]=process.argv.slice(2);function deny(f){try{f();return false}catch{return true}}let ok=false;if(test==='allowed-write'){fs.writeFileSync(p.join(work,'ok'),'public');ok=true}if(test==='hidden-read')ok=deny(()=>fs.readFileSync(p.join(control,'public')));if(test==='hidden-write')ok=deny(()=>fs.writeFileSync(p.join(control,'bad'),'public'));if(test==='alias-read')ok=deny(()=>fs.readFileSync(p.join(work,'alias/public')));if(test==='policy-write')ok=deny(()=>fs.writeFileSync(p.join(config,'attack'),'public'));if(test==='nested-retry')ok=cp.spawnSync(process.execPath,['-e','require("fs").readFileSync(process.argv[1])',p.join(control,'public')],{stdio:'ignore'}).status!==0;process.exit(ok?0:9)`);
const env={...process.env,HOME:root,USERPROFILE:root,APPDATA:root,LOCALAPPDATA:root,CODEX_HOME:config};
try{for(const test of ['allowed-write','hidden-read','hidden-write','alias-read','policy-write','nested-retry']){
 const args=['C:/clover-tools/srt/node_modules/@openai/codex/bin/codex.js','sandbox','-C',work,'-P','clover','--','C:/clover-tools/node/node.exe',file,test,work,control,config];
 const r=spawnSync('C:/clover-tools/node/node.exe',args,{cwd:work,env,encoding:'utf8',timeout:25000,windowsHide:true});
 console.log(JSON.stringify({backend:'codex-windows-'+backend,test,exit:r.status,pass:r.status===0,diagnostic:(r.stderr??'').replaceAll(root,'<isolated-home>').slice(0,1100)}));
}}finally{fs.rmSync(root,{recursive:true,force:true})}

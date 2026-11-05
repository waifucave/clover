import fs from 'node:fs';import path from 'node:path';import {spawn,spawnSync} from 'node:child_process';
const root=fs.mkdtempSync('C:/clover-tools/clover-cursor-bound-'),work=path.join(root,'work'),hidden=path.join(root,'control');
for(const p of [work,hidden])fs.mkdirSync(p);fs.writeFileSync(path.join(hidden,'public'),'public fixture');
const env={...process.env,HOME:root,USERPROFILE:root,APPDATA:root,LOCALAPPDATA:root,DO_NOT_TRACK:'1',CI:'1'};
const worker=path.join(work,'worker.cjs');fs.writeFileSync(worker,`const fs=require('fs');const [test,file]=process.argv.slice(2);if(test==='allowed-write'){fs.writeFileSync(file,'public');process.exit(0)}try{if(test==='hidden-write')fs.writeFileSync(file,'public');else fs.readFileSync(file);process.exit(9)}catch{process.exit(0)}`);
try{for(const test of ['allowed-write','hidden-read','hidden-write']){
 const target=path.join(test==='allowed-write'?work:hidden,test==='hidden-write'?'bad':test==='allowed-write'?'ok':'public');
 const command='C:\\clover-tools\\cursor\\dist-package\\cursor-agent.cmd sandbox run --blocked-patterns '+hidden+'/** -- C:\\clover-tools\\node\\node.exe '+worker+' '+test+' '+target;
 const r=await new Promise(resolve=>{let out='',err='',timeout=false;const c=spawn('cmd.exe',['/d','/s','/c',command],{cwd:work,env,windowsHide:true});c.stdout.on('data',b=>out+=b);c.stderr.on('data',b=>err+=b);const timer=setTimeout(()=>{timeout=true;spawnSync('taskkill.exe',['/PID',String(c.pid),'/T','/F'],{stdio:'ignore',windowsHide:true})},15000);c.on('close',exit=>{clearTimeout(timer);resolve({exit,timeout,out,err})});c.on('error',()=>{clearTimeout(timer);resolve({exit:-1,timeout,out,err:'spawn error'})})});
 console.log(JSON.stringify({backend:'cursor-windows',test,exit:r.exit,timeout:r.timeout,diagnostic:(r.out+r.err).replaceAll(root,'<isolated-home>').slice(-1100)}));
 if(r.timeout)break;
}console.log(JSON.stringify({test:'cursor-windows-host-state',allowed_write:fs.existsSync(path.join(work,'ok')),hidden_write:fs.existsSync(path.join(hidden,'bad'))}));}
finally{fs.rmSync(root,{force:true,recursive:true})}

// Where the fenced principal's Startup folder really is, and which deny keeps the principal's
// writes inside the configured roots. The profile is resolved by SID from ProfileList, never
// derived from the account name: a leftover C:\Users\<name> folder makes Windows place the
// profile at <name>.<COMPUTERNAME>. Every target is also written by the unfenced local
// administrator, the positive control. Public fixture content only; created files are removed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const {SandboxManager}=await import(pathToFileURL('C:/clover-tools/srt/node_modules/@anthropic-ai/sandbox-runtime/dist/index.js'));
const sandboxUser='clover-spike-sandbox',node='C:/clover-tools/node/node.exe';
const root=fs.mkdtempSync('C:/clover-tools/clover-startup-');
const work=path.join(root,'work'),control=path.join(root,'control'),outside=path.join(root,'outside');
for(const dir of [work,control,outside])fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(path.join(control,'secrets.enc'),'public-canary');
const realName=os.userInfo().username;
const emit=o=>{const s=JSON.stringify(o);console.log(realName?s.split(realName).join('<real-user>'):s)};
const ps=c=>(spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',c],{encoding:'utf8'}).stdout||'').trim();
const principalSid=ps(`(New-Object Security.Principal.NTAccount('${sandboxUser}')).Translate([Security.Principal.SecurityIdentifier]).Value`);
const realSid=ps('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value');
const profileOf=sid=>ps(`(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\${sid}' -ErrorAction SilentlyContinue).ProfileImagePath`)||null;
const startupUnder=home=>path.join(home,'AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup');
const q=s=>"'"+String(s).replaceAll("'","''")+"'";
const base={filesystem:{allowRead:[work],allowWrite:[work],denyRead:[control],denyWrite:[control]},network:{allowedDomains:[],deniedDomains:[]},
 windows:{srtWin:{path:'C:/clover-tools/srt/node_modules/@anthropic-ai/sandbox-runtime/vendor/srt-win/x64/srt-win.exe'},sandboxUser,sublayerGuid:'784c4230-1105-4bda-8808-83582c000001'}};
const withDeny=extra=>({...base,filesystem:{...base.filesystem,denyWrite:[control,...extra]}});
function collect(argv,env){return new Promise(resolve=>{const c=spawn(argv[0],argv.slice(1),{env,cwd:work,windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',err='';c.stdout.on('data',b=>out+=b);c.stderr.on('data',b=>err+=b);const t=setTimeout(()=>c.kill(),30000);c.on('close',code=>{clearTimeout(t);resolve({code,out,err})});c.on('error',()=>{clearTimeout(t);resolve({code:-1,out,err:'spawn error'})})})}
const last=r=>{for(const line of r.out.trim().split(/\r?\n/).reverse()){try{return JSON.parse(line)}catch{}}return {exit:r.code,diagnostic:r.err.slice(0,400)}};
// Sandboxed commands get a temp folder inside the allowed root, as Clover's helper would set it.
const tmp=path.join(work,'tmp');fs.mkdirSync(tmp);
async function fenced(args){const command=`$env:TEMP=${q(tmp)};$env:TMP=${q(tmp)};& `+[node,...args].map(q).join(' ');const {argv,env}=await SandboxManager.wrapWithSandboxArgv(command,'powershell',undefined,undefined,work);return last(await collect(argv,env));}
const unfenced=async args=>last(await collect([node,...args],process.env));
const probe=path.join(work,'probe.cjs');
fs.writeFileSync(probe,String.raw`
const fs=require('fs'),p=require('path'),cp=require('child_process');
const [targetsFile,tag]=process.argv.slice(2),targets=JSON.parse(fs.readFileSync(targetsFile,'utf8')),writes={};
for(const [name,dir] of Object.entries(targets)){
 const f=p.join(dir,'clover-startup-probe-'+tag+'.txt');
 try{fs.writeFileSync(f,'public',{flag:'wx'});fs.unlinkSync(f);writes[name]=true}catch(e){writes[name]=e.code||'error'}
}
const runs=(exe,args)=>cp.spawnSync(exe,args,{windowsHide:true,timeout:15000}).status===0;
const tools={node:runs(process.execPath,['-e','0']),bash:runs('C:/Program Files/Git/bin/bash.exe',['--noprofile','--norc','-c','test "$(printf ab | wc -c)" = 2']),
 powershell:runs(process.env.SystemRoot+'/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-Command','exit 0'])};
console.log(JSON.stringify({env:{USERPROFILE:process.env.USERPROFILE||null,APPDATA:process.env.APPDATA||null},writes,tools}));
`);
try{
 await SandboxManager.initialize(base);
 // A fresh principal's first launch creates its profile; later launches reuse it.
 await fenced(['-e','0']);
 await SandboxManager.reset();
 const P=profileOf(principalSid),H=profileOf(realSid);
 const targets={'allowed-work':work,'principal-startup':startupUnder(P),'principal-profile':P,'principal-roaming':path.join(P,'AppData/Roaming'),
  'principal-temp':path.join(P,'AppData/Local/Temp'),'leftover-named-folder-startup':startupUnder(path.join('C:/Users',sandboxUser)),
  'host-startup':startupUnder(H),'common-startup':path.join(process.env.ProgramData,'Microsoft/Windows/Start Menu/Programs/Startup'),'fixture-outside':outside};
 for(const [name,dir] of Object.entries(targets))if(!fs.existsSync(dir))delete targets[name];
 emit({phase:'paths',principal_profile:P,principal_profile_redirected:path.basename(P)!==sandboxUser,
  leftover_named_folder:fs.existsSync(path.join('C:/Users',sandboxUser)),targets:Object.keys(targets)});
 const targetsFile=path.join(work,'targets.json');fs.writeFileSync(targetsFile,JSON.stringify(targets));
 emit({phase:'control',actor:'unfenced',...await unfenced([probe,targetsFile,'u'])});
 const common=targets['common-startup'],hostStartup=startupUnder(H);
 const variants=[['baseline-work-only',base],
  ['startup-deny',withDeny([startupUnder(P),hostStartup,common].filter(Boolean))],
  ['principal-profile-deny',withDeny([P,hostStartup,common].filter(Boolean))]];
 let n=0;
 for(const [variant,config] of variants){
  await SandboxManager.initialize(config);
  emit({phase:variant,actor:'fenced',...await fenced([probe,targetsFile,'f'+(n++)])});
  try{await SandboxManager.reset()}catch(e){emit({phase:variant,reset_error:String(e.message).slice(0,300)})}
  emit({phase:variant+'-after-reset',profile_list_unchanged:profileOf(principalSid)===P});
 }
}catch(e){emit({phase:'probe-error',code:e.code??e.name,diagnostic:String(e.message).slice(0,900)})}
finally{try{await SandboxManager.reset()}catch{}fs.rmSync(root,{force:true,recursive:true})}

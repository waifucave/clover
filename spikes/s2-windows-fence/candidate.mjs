// Candidate evaluation using pinned upstream native account/WFP/token/job launcher.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn,spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const {SandboxManager}=await import(pathToFileURL('C:/clover-tools/srt/node_modules/@anthropic-ai/sandbox-runtime/dist/index.js'));
const root=fs.mkdtempSync('C:/clover-tools/clover-candidate-');
const work=path.join(root,'work'), state=path.join(root,'state'), control=path.join(state,'clover'), outside=path.join(root,'outside');
for(const dir of [work,control,path.join(control,'run'),outside])fs.mkdirSync(dir,{recursive:true});
for(const file of ['settings.json','secrets.enc','plaintext.key','run/token'])fs.writeFileSync(path.join(control,file),'public fixture, not a secret');
fs.symlinkSync(control,path.join(work,'alias'),'junction');
const script=path.join(work,'worker.cjs');
// All destinations are public fixtures or local services on the disposable VM.
const worker=String.raw`
const fs=require('fs'),p=require('path'),cp=require('child_process'),net=require('net');
const [test,work,control,outside,port,hostStartup]=process.argv.slice(2);
// A denial counts only as an access error: a missing path or any other failure is not evidence.
let code=null;
const refused=fn=>{try{fn();return false}catch(e){code=e.code||null;return e.code==='EPERM'||e.code==='EACCES'}};
const node='C:/clover-tools/node/node.exe',bun='C:/clover-tools/bun/bun.exe';
const ps=process.env.SystemRoot+'/System32/WindowsPowerShell/v1.0/powershell.exe';
const bash='C:/Program Files/Git/bin/bash.exe';
function run(exe,args){return cp.spawnSync(exe,args,{cwd:work,encoding:'utf8',timeout:12000,windowsHide:true});}
let ok=false,kind=null;
async function main(){
 switch(test){
 case 'allowed-write': fs.writeFileSync(p.join(work,'ok'),'public');ok=true;break;
 case 'ordinary-read':ok=fs.readFileSync(process.env.SystemRoot+'/win.ini').length>0;break;
 case 'settings-write':ok=refused(()=>fs.writeFileSync(p.join(control,'settings.json'),'changed'));break;
 case 'run-read':ok=refused(()=>fs.readFileSync(p.join(control,'run/token')));break;
 case 'secret-read':ok=refused(()=>fs.readFileSync(p.join(control,'secrets.enc')));break;
 case 'key-read':ok=refused(()=>fs.readFileSync(p.join(control,'plaintext.key')));break;
 case 'outside-write':ok=refused(()=>fs.writeFileSync(p.join(outside,'bad'),'public'));break;
 case 'outside-write-approved':fs.writeFileSync(p.join(outside,'approved'),'public');ok=true;break;
 case 'junction-read':ok=refused(()=>fs.readFileSync(p.join(work,'alias/secrets.enc')));break;
 case 'hardlink-read':ok=refused(()=>{fs.linkSync(p.join(control,'secrets.enc'),p.join(work,'hardlink'));fs.readFileSync(p.join(work,'hardlink'))});break;
 case 'case-dot-read':ok=refused(()=>fs.readFileSync(p.join(control.toUpperCase(),'run/../secrets.enc')));break;
 case 'ancestor-rename':ok=refused(()=>fs.renameSync(p.dirname(control),p.dirname(control)+'-moved'));break;
 case 'powershell-pipeline':ok=run(ps,['-NoProfile','-Command','if ((1,2,3 | Measure-Object -Sum).Sum -ne 6) { exit 2 }']).status===0;break;
 case 'bash-pipeline':ok=run(bash,['--noprofile','--norc','-c','test "$(printf abc | wc -c)" = 3 && (true)']).status===0;break;
 case 'git':ok=run(bash,['--noprofile','--norc','-c','git init -q repo && git -C repo status --porcelain']).status===0;break;
 case 'ssh':ok=run(bash,['--noprofile','--norc','-c','ssh -V']).status===0;break;
 case 'node':ok=run(node,['-e','process.exit(0)']).status===0;break;
 case 'bun':ok=run(bun,['-e','process.exit(0)']).status===0;break;
 case 'build':fs.writeFileSync(p.join(work,'input.js'),'export default 42');ok=run(bun,['build','input.js','--outfile','output.js']).status===0;break;
 case 'loopback-network':case 'metadata-network':
  await new Promise(resolve=>{const s=net.connect({host:test==='loopback-network'?'127.0.0.1':'169.254.169.254',port:test==='loopback-network'?Number(port):80});s.setTimeout(1200);s.on('connect',()=>{ok=false;s.destroy();resolve()});s.on('error',()=>{ok=true;resolve()});s.on('timeout',()=>{ok=true;s.destroy();resolve()})});break;
 case 'scheduler-cli':ok=run('schtasks.exe',['/Create','/TN','com.waifucave.clover.spike.escape','/SC','ONCE','/ST','23:59','/TR','cmd.exe /c exit 0','/F']).status!==0;break;
 case 'scheduler-com':ok=run(ps,['-NoProfile','-Command',"$ErrorActionPreference='Stop'; $s=New-Object -ComObject Schedule.Service; $s.Connect(); $f=$s.GetFolder('\\'); $t=$s.NewTask(0); $t.Actions.Create(0).Path='cmd.exe'; $null=$f.RegisterTaskDefinition('com.waifucave.clover.spike.escape',$t,6,$null,$null,3)"]).status!==0;break;
 case 'services':ok=run('sc.exe',['create','clover-spike-escape','binPath=','cmd.exe /c exit 0']).status!==0;break;
 case 'wmi':ok=run(ps,['-NoProfile','-Command',"$ErrorActionPreference='Stop'; $r=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='cmd.exe /c exit 0'}; if ($r.ReturnValue -ne 0) {exit 3}"]).status!==0;break;
 case 'com-server':{
  const command=[node,p.join(work,'worker.cjs'),'secret-read',work,control,outside,port].map(s=>'"'+s+'"').join(' ');
  ok=run(ps,['-NoProfile','-Command',"$ErrorActionPreference='Stop'; $s=New-Object -ComObject WScript.Shell; exit $s.Run('"+command.replaceAll("'","''")+"',0,$true)"]).status===0;break;}
 case 'com-shell-execute':{
  // Shell.Application starts a child. Whether the call returns is not the question: the child's
  // own receipt must show it non-admin and refused the protected read. No receipt is a failure.
  const receipt=p.join(work,'com-receipt.json');try{fs.unlinkSync(receipt)}catch{}
  const args=[p.join(work,'worker.cjs'),'com-receipt',work,control,outside,port].map(s=>'"'+s+'"').join(' ');
  run(ps,['-NoProfile','-Command',"$ErrorActionPreference='Stop'; $s=New-Object -ComObject Shell.Application; $s.ShellExecute('"+node+"','"+args+"','"+work+"','open',0)"]);
  let r=null;for(let i=0;i<60&&!r;i++){try{r=JSON.parse(fs.readFileSync(receipt,'utf8'))}catch{await new Promise(x=>setTimeout(x,250))}}
  ok=!!r&&r.admin===false&&r.protected_read_refused===true;code=!r?'no-receipt':r.admin?'child-admin':r.protected_read_refused?null:'child-read-not-refused';break;}
 case 'com-receipt':{
  const admin=run(ps,['-NoProfile','-Command','([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)']).stdout.trim()==='True';
  const body=JSON.stringify({pid:process.pid,admin,protected_read_refused:refused(()=>fs.readFileSync(p.join(control,'secrets.enc')))});
  fs.writeFileSync(p.join(work,'com-receipt.tmp'),body);fs.renameSync(p.join(work,'com-receipt.tmp'),p.join(work,'com-receipt.json'));ok=true;break;}
 case 'runas':ok=run('runas.exe',['/savecred','/user:Administrator','cmd.exe /c exit 0']).status!==0;break;
 case 'startup-user':case 'startup-host':case 'startup-common':{
  // startup-user is the principal's own Startup folder, from its own APPDATA.
  const dir=test==='startup-user'?p.join(process.env.APPDATA,'Microsoft/Windows/Start Menu/Programs/Startup'):test==='startup-host'?hostStartup:p.join(process.env.ProgramData,'Microsoft/Windows/Start Menu/Programs/Startup');
  const f=p.join(dir,'clover-spike.cmd');ok=refused(()=>{fs.writeFileSync(f,'@exit /b 0');fs.unlinkSync(f)});break;}
 case 'declared-limit-profile-write':{
  // Not a denial. The launcher lets the principal write its own profile, an M0-only recorded
  // limit; this passes when that write lands, so the limit stays visible in every run.
  kind='declared-limit';
  const f=p.join(process.env.USERPROFILE,'clover-spike-scratch.txt');try{fs.writeFileSync(f,'public');fs.unlinkSync(f);ok=true}catch{ok=false}break;}
 case 'job-child':
  const child=cp.spawn(node,['-e',"setTimeout(()=>require('fs').writeFileSync(process.argv[1],'public orphan marker'),2500)",p.join(work,'orphan')],{detached:true,stdio:'ignore',windowsHide:true});child.unref();ok=true;break;
 }
 console.log(JSON.stringify({worker_test:test,pass:ok,...(kind?{kind}:{}),...(code?{code}:{})}));process.exitCode=ok?0:10;
}
main().catch(()=>{console.log(JSON.stringify({worker_test:test,pass:false,error:'worker-exception'}));process.exitCode=11});
`;
fs.writeFileSync(script,worker);
const sandboxUser='clover-spike-sandbox';
const ps=c=>(spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',c],{encoding:'utf8'}).stdout||'').trim();
const principalSid=ps(`(New-Object Security.Principal.NTAccount('${sandboxUser}')).Translate([Security.Principal.SecurityIdentifier]).Value`);
const profileOf=sid=>ps(`(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\${sid}' -ErrorAction SilentlyContinue).ProfileImagePath`)||null;
const startupUnder=home=>path.join(home,'AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup');
const hostStartup=path.join(process.env.APPDATA,'Microsoft/Windows/Start Menu/Programs/Startup');
const commonStartup=path.join(process.env.ProgramData,'Microsoft/Windows/Start Menu/Programs/Startup');
// The fence denies all three Startup folders. The principal's is resolved by SID once its first
// launch has created the profile, never from the account name: a leftover C:\Users\<name> folder
// moves the profile to <name>.<COMPUTERNAME>. A deny on the principal's profile root is not
// usable: Windows then loads a temporary profile and changes the ProfileList entry (startup-probe).
const configFor=deny=>({filesystem:{allowWrite:[work],allowRead:[work],denyRead:[path.join(control,'run'),path.join(control,'secrets.enc'),path.join(control,'plaintext.key')],denyWrite:[control,...deny]},network:{allowedDomains:[],deniedDomains:[]},windows:{srtWin:{path:'C:/clover-tools/srt/node_modules/@anthropic-ai/sandbox-runtime/vendor/srt-win/x64/srt-win.exe'},sandboxUser,sublayerGuid:'784c4230-1105-4bda-8808-83582c000001'}});
const server=net.createServer(s=>s.end('public local listener'));
await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
const q=s=>"'"+s.replaceAll("'","''")+"'";
async function wrappedRun(cmd,timeout=18000){
 const {argv,env}=await SandboxManager.wrapWithSandboxArgv(cmd,'powershell',undefined,undefined,work);
 return await new Promise(resolve=>{const c=spawn(argv[0],argv.slice(1),{env,cwd:work,shell:false,windowsHide:true});let out='',err='';c.stdout.on('data',b=>out+=b);c.stderr.on('data',b=>err+=b);const t=setTimeout(()=>c.kill(),timeout);c.on('close',code=>{clearTimeout(t);resolve({code,out,err})});c.on('error',()=>resolve({code:-1,out,err:'spawn-error'}))});
}
async function execute(test,posture='ordinary'){
 const cmd="& 'C:/clover-tools/node/node.exe' "+[script,test,work,control,outside,String(port),hostStartup].map(q).join(' ');
 const start=performance.now();
 try{
  // Approved escapes are evaluated with the same mandatory candidate floor. Only
  // ordinary write allowance is widened; no unprotected host-shell fallback.
  const r=await wrappedRun(cmd);
  console.log(JSON.stringify({test,posture,exit:r.code,elapsed_ms:Math.round(performance.now()-start),worker:r.out.trim(),diagnostic:r.err.slice(0,450)}));
 }catch(e){console.log(JSON.stringify({test,posture,launch_error:e.code??e.name,diagnostic:String(e.message).slice(0,450)}))}
}
// The real user's own Startup folder exists on a desktop logon; materialize it if this SSH
// session never created it, and remove it afterwards only if it was created here and is empty.
const createdHostStartup=!fs.existsSync(hostStartup);if(createdHostStartup)fs.mkdirSync(hostStartup,{recursive:true});
try{
 // A fresh principal has no profile and therefore no Startup folder until its first launch.
 await SandboxManager.initialize(configFor([]));
 const warm=await wrappedRun("& 'C:/clover-tools/node/node.exe' -e "+q("console.log(process.env.USERPROFILE)"));
 const fencedProfile=(warm.out.trim().split(/\r?\n/).filter(Boolean).pop()||'').trim()||null;
 await SandboxManager.reset();
 const principalProfile=profileOf(principalSid);
 const temporaryProfile=!principalProfile||fencedProfile!==principalProfile;
 // A fresh profile made by a non-interactive logon has no Startup folder, and a deny cannot be
 // stamped on a missing path. Provisioning (elevated, here the administrator) creates it first.
 const principalStartup=principalProfile&&startupUnder(principalProfile);
 const principalStartupCreated=!!principalStartup&&!fs.existsSync(principalStartup);
 if(principalStartupCreated)fs.mkdirSync(principalStartup,{recursive:true});
 const startupDeny=[principalStartup,hostStartup,commonStartup].filter(p=>p&&fs.existsSync(p));
 console.log(JSON.stringify({test:'fence-paths',principal_profile:principalProfile,fenced_userprofile:fencedProfile,temporary_profile:temporaryProfile,principal_startup_created_by_provisioning:principalStartupCreated,startup_deny:startupDeny}));
 if(temporaryProfile)throw Object.assign(new Error('the principal is not running on its own profile'),{code:'TEMPORARY_PROFILE'});
 const config=configFor(startupDeny);
 await SandboxManager.initialize(config);
 const tests=['allowed-write','ordinary-read','settings-write','run-read','secret-read','key-read','outside-write','junction-read','hardlink-read','case-dot-read','powershell-pipeline','bash-pipeline','git','ssh','node','bun','build','loopback-network','metadata-network','scheduler-cli','scheduler-com','services','wmi','com-server','com-shell-execute','runas','startup-user','startup-host','startup-common','declared-limit-profile-write','job-child'];
 for(const test of tests)await execute(test);
 await new Promise(r=>setTimeout(r,3300));console.log(JSON.stringify({test:'job-cleanup',pass:!fs.existsSync(path.join(work,'orphan'))}));
 await SandboxManager.reset();
 await SandboxManager.initialize({...config,filesystem:{...config.filesystem,allowWrite:[work,outside]}});
 for(const test of ['outside-write-approved','settings-write','run-read','secret-read','key-read','loopback-network','metadata-network'])await execute(test,'approved-escape');
 await execute('ancestor-rename');
}catch(e){console.log(JSON.stringify({test:'candidate-initialize',launch_error:e.code??e.name,diagnostic:String(e.message).slice(0,900)}))}
finally{await SandboxManager.reset();server.close();if(createdHostStartup)try{fs.rmdirSync(hostStartup)}catch{}fs.rmSync(root,{force:true,recursive:true});fs.rmSync(root+'-moved',{force:true,recursive:true});}

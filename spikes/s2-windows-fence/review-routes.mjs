import fs from 'node:fs';import path from 'node:path';import net from 'node:net';
import {spawn,spawnSync} from 'node:child_process';import {pathToFileURL} from 'node:url';
const {SandboxManager}=await import(pathToFileURL('C:/clover-tools/srt/node_modules/@anthropic-ai/sandbox-runtime/dist/index.js'));
const root=process.argv[2],work=path.join(root,'work'),control=path.join(root,'control'),bin=path.join(root,'bin');
const clsid='unused',suffix=path.basename(root).replaceAll('-','').slice(-15);
fs.mkdirSync(control,{recursive:true});fs.writeFileSync(path.join(control,'secrets.enc'),'public-canary');
const ps=process.env.SystemRoot+'/System32/WindowsPowerShell/v1.0/powershell.exe',node='C:/clover-tools/node/node.exe';
const worker=path.join(work,'routes.cjs');
const comChild=path.join(work,'com-child.cjs');
fs.writeFileSync(comChild,`const fs=require('fs'),cp=require('child_process');const [marker,target]=process.argv.slice(2);function read(){try{return fs.readFileSync(target,'utf8')==='public-canary'}catch{return false}}const r=cp.spawnSync(process.env.SystemRoot+'/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-Command','([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'],{encoding:'utf8',windowsHide:true});const base={pid:process.pid,parent_pid:process.ppid,admin:r.stdout.trim()==='True',protected_read_allowed:read()};fs.writeFileSync(marker,JSON.stringify(base));setTimeout(()=>fs.writeFileSync(marker+'.late',JSON.stringify({...base,protected_read_allowed_late:read()})),4000)`);

fs.writeFileSync(worker,String.raw`
const fs=require('fs'),p=require('path'),cp=require('child_process'),net=require('net');
const [route,actor,work,control,clsid,suffix,port,startupTarget,hostStartupTarget]=process.argv.slice(2);
const ps=process.env.SystemRoot+'/System32/WindowsPowerShell/v1.0/powershell.exe';
const marker=p.join(work,'receipt-'+route+'-'+actor+'.json'),task='com.waifucave.clover.review.'+suffix,svc='clover_review_'+suffix;
function run(exe,args){return cp.spawnSync(exe,args,{encoding:'utf8',timeout:10000,windowsHide:true,stdio:['ignore','pipe','pipe']})}
function parse(text){for(const line of (text??'').trim().split(/\r?\n/).reverse()){try{return JSON.parse(line)}catch{}}return null}
async function main(){
let r,extra={};
if(route==='child-marker'){fs.writeFileSync(marker,JSON.stringify({entered:true,pid:process.pid}));return}
if(route==='scheduler-cli'){
 r=run('schtasks.exe',['/Create','/TN',task,'/SC','ONCE','/ST','23:59','/TR','cmd.exe /c exit 0','/F']);
 if(r.status===0)run('schtasks.exe',['/Delete','/TN',task,'/F']);
}else if(route==='scheduler-com'){
 r=run(ps,['-NoProfile','-Command',"$ErrorActionPreference='Stop'; try {$s=New-Object -ComObject Schedule.Service;$s.Connect();$f=$s.GetFolder('\\');$t=$s.NewTask(0);$t.Actions.Create(0).Path='cmd.exe';$null=$f.RegisterTaskDefinition('"+task+"',$t,6,$null,$null,3);$f.DeleteTask('"+task+"',0);exit 0} catch {@{hresult=$_.Exception.HResult}|ConvertTo-Json -Compress;exit 3}"]);
}else if(route==='services'){
 r=run('sc.exe',['create',svc,'binPath=','cmd.exe /c exit 0']);if(r.status===0)run('sc.exe',['delete',svc]);
}else if(route==='wmi'){
 const child='"C:/clover-tools/node/node.exe" -e "require(\'fs\').writeFileSync(process.argv[1],\'public\')" "'+marker+'"';
 r=run(ps,['-NoProfile','-Command',"$ErrorActionPreference='Stop';try {$r=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='"+child.replaceAll("'","''")+"'};@{return_value=$r.ReturnValue;child_pid=$r.ProcessId}|ConvertTo-Json -Compress;if($r.ReturnValue -ne 0){exit 3}}catch{@{hresult=$_.Exception.HResult}|ConvertTo-Json -Compress;exit 4}"]);
}else if(route==='runas'){
 r=run('runas.exe',['/savecred','/user:Administrator','cmd.exe /c exit 0']);extra.no_saved_credential_fixture=true;
}else if(route==='startup-user'||route==='startup-host'||route==='startup-common'){
 const dir=route==='startup-user'?startupTarget:route==='startup-host'?hostStartupTarget:p.join(process.env.ProgramData,'Microsoft/Windows/Start Menu/Programs/Startup');
 const f=p.join(dir,'clover-review-'+suffix+'.cmd');try{fs.writeFileSync(f,'@exit /b 0');fs.unlinkSync(f);r={status:0}}catch(e){r={status:3};extra.error_code=e.code}
}else if(route==='shell-application'||route==='shell-application-local'){
 const args=[p.join(work,'com-child.cjs'),marker,p.join(control,'secrets.enc')].map(s=>'"'+s+'"').join(' ');
 if(route==='shell-application-local')r=run(p.join(p.dirname(work),'bin/handle-probe.exe'),['local-com','C:/clover-tools/node/node.exe',args,work]);
 else r=run(ps,['-NoProfile','-Command',"$ErrorActionPreference='Stop';try{$s=New-Object -ComObject Shell.Application;$s.ShellExecute('C:/clover-tools/node/node.exe','"+args.replaceAll("'","''")+"','"+work+"','open',0);exit 0}catch{@{hresult=$_.Exception.HResult}|ConvertTo-Json -Compress;exit 3}"]);
}else if(route==='network'||route==='metadata-network'){
 r={status:3};await new Promise(resolve=>{const s=net.connect(route==='network'?Number(port):80,route==='network'?'127.0.0.1':'169.254.169.254');s.setTimeout(1500);s.on('connect',()=>{r.status=0;s.destroy();resolve()});s.on('error',()=>resolve());s.on('timeout',()=>{s.destroy();resolve()})});
}
await new Promise(resolve=>setTimeout(resolve,route==='wmi'||route==='shell-application'?1800:0));
console.log(JSON.stringify({route,actor,exit:r?.status??null,timeout:r?.error?.code==='ETIMEDOUT',detail:parse(r?.stdout),marker_observed:fs.existsSync(marker),...extra}));
}main().catch(e=>{console.log(JSON.stringify({route,actor,harness_error:e.code??e.name}));process.exitCode=1});
`);
const sandboxUser='clover-spike-sandbox';
const psOut=c=>(spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',c],{encoding:'utf8'}).stdout||'').trim();
const principalSid=psOut(`(New-Object Security.Principal.NTAccount('${sandboxUser}')).Translate([Security.Principal.SecurityIdentifier]).Value`);
const profileOf=sid=>psOut(`(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\${sid}' -ErrorAction SilentlyContinue).ProfileImagePath`)||null;
const startupUnder=home=>path.join(home,'AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup');
const hostStartup=path.join(process.env.APPDATA,'Microsoft/Windows/Start Menu/Programs/Startup');
const commonStartup=path.join(process.env.ProgramData,'Microsoft/Windows/Start Menu/Programs/Startup');
const configFor=deny=>({filesystem:{allowRead:[work,bin],allowWrite:[work],denyRead:[control],denyWrite:[control,...deny]},network:{allowedDomains:[],deniedDomains:[]},windows:{srtWin:{path:'C:/clover-tools/srt/node_modules/@anthropic-ai/sandbox-runtime/vendor/srt-win/x64/srt-win.exe'},sandboxUser,sublayerGuid:'784c4230-1105-4bda-8808-83582c000001'}});
let config=configFor([]),startupTarget=null;
const server=net.createServer(s=>{s.on('error',()=>{});s.end('public')});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const port=String(server.address().port);const q=s=>"'"+s.replaceAll("'","''")+"'";
async function launch(argv,env=process.env){return await new Promise(resolve=>{const c=spawn(argv[0],argv.slice(1),{env,cwd:work,windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',err='';c.stdout.on('data',b=>out+=b);c.stderr.on('data',b=>err+=b);c.stdout.on('error',()=>{});c.stderr.on('error',()=>{});const t=setTimeout(()=>c.kill(),20000);c.on('close',exit=>{clearTimeout(t);resolve({exit,out,err})});c.on('error',()=>{clearTimeout(t);resolve({exit:-1,out,err:'spawn error'})})})}
function result(r){for(const line of r.out.trim().split(/\r?\n/).reverse()){try{return JSON.parse(line)}catch{}}return {launcher_exit:r.exit,diagnostic:r.err.slice(0,500)}}
async function route(test,actor){const args=[worker,test,actor,work,control,clsid,suffix,port,startupTarget,hostStartup];if(actor==='unfenced')return result(await launch([node,...args]));const command='& '+[node,...args].map(q).join(' ');const {argv,env}=await SandboxManager.wrapWithSandboxArgv(command,'powershell',undefined,undefined,work);return result(await launch(argv,env));}
// The first launch creates a fresh principal's profile; its Startup folder is then resolved by
// SID. Nothing is granted inside the principal's profile by the administrator.
{
 await SandboxManager.initialize(config);
 const {argv,env}=await SandboxManager.wrapWithSandboxArgv('& '+[node,'-e','console.log(process.env.USERPROFILE)'].map(q).join(' '),'powershell',undefined,undefined,work);
 const warm=await launch(argv,env);await SandboxManager.reset();
 const principalProfile=profileOf(principalSid);startupTarget=principalProfile&&startupUnder(principalProfile);
 // Provisioning (elevated, here the administrator) creates the missing Startup folder so the
 // deny can be stamped; nothing is granted inside the principal's profile.
 if(startupTarget&&!fs.existsSync(startupTarget)){fs.mkdirSync(startupTarget,{recursive:true});console.log(JSON.stringify({test:'principal-startup-created-by-provisioning'}))}
 console.log(JSON.stringify({test:'principal-profile',principal_profile:principalProfile,temporary_profile:!principalProfile||warm.out.trim().split(/\r?\n/).pop().trim()!==principalProfile}));
}
// The real user's own Startup folder exists on a desktop logon; materialize it if absent.
const createdHostStartup=!fs.existsSync(hostStartup);if(createdHostStartup)fs.mkdirSync(hostStartup,{recursive:true});
console.log(JSON.stringify({test:'admin-parent-context',host_local_admin:process.env.CLOVER_HOST_ADMIN==='True',session0_alias:true}));
const paired=[];
try{
 const startupDeny=[startupTarget,hostStartup,commonStartup].filter(p=>p&&fs.existsSync(p));
 config=configFor(startupDeny);
 await SandboxManager.initialize(config);
 console.log(JSON.stringify({test:'startup-fixture-prerequisites',principal_startup:startupTarget,principal_startup_exists:!!startupTarget&&fs.existsSync(startupTarget),host_startup_created_here:createdHostStartup,denied_paths:startupDeny}));

 for(const test of ['scheduler-cli','scheduler-com','services','wmi','runas','startup-user','startup-host','startup-common','shell-application','shell-application-local','network','metadata-network']){
  const unfenced=await route(test,'unfenced');const fenced=await route(test,'fenced');
  let classification=unfenced.exit===0?(fenced.exit!==0?'fence_or_principal_denial':'operation_accepted'):'control_failed_not_attributable';
  // A missing folder is a fixture error, never a fence denial.
  if(fenced.error_code==='ENOENT'||unfenced.error_code==='ENOENT')classification='fixture_missing_not_a_denial';
  if(test==='observable-com' && unfenced.exit===0 && fenced.exit===0)classification=fenced.detail?.protected_read_allowed?'fenced_com_read_breach':'observable_fenced_com';
  const receipts={};
  if(test.startsWith('shell-application')){
   await new Promise(r=>setTimeout(r,4500));
   for(const actor of ['unfenced','fenced']){
    const file=path.join(work,'receipt-'+test+'-'+actor+'.json');
    receipts[actor]=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):null;
    receipts[actor+'_late']=fs.existsSync(file+'.late')?JSON.parse(fs.readFileSync(file+'.late')):null;
   }
   classification=unfenced.exit!==0?'control_failed_not_attributable':receipts.fenced?(receipts.fenced.protected_read_allowed?'protected_read_breach':'observable_child_read_denied'):'child_not_observed';
  }
  const row={test,unfenced,fenced,classification,...(test.startsWith('shell-application')?{receipts}:{})};paired.push(row);console.log(JSON.stringify(row));
 }
 const hold=path.join(bin,'handle-probe.exe'),publicFile=path.join(control,'secrets.enc');
 for(const actor of ['unfenced','fenced']){
  const receipt=path.join(work,'handles-'+actor+'.json');
  const childArgs=[hold,'child','@PID@','@FILE@','@PROCESS@',receipt,'public-canary'];let argv,env=process.env;
  if(actor==='unfenced')argv=childArgs;else {const wrapped=await SandboxManager.wrapWithSandboxArgv('& '+childArgs.map(q).join(' '),'powershell',undefined,undefined,work);argv=wrapped.argv;env=wrapped.env;}
  const encoded=path.join(work,'argv-'+actor+'.txt');fs.writeFileSync(encoded,argv.map(x=>Buffer.from(x).toString('base64')).join('\n'));
  const run=await launch([hold,'hold',publicFile,encoded,work],env);
  const observation=fs.existsSync(receipt)?JSON.parse(fs.readFileSync(receipt)):{missing_receipt:true};
  console.log(JSON.stringify({test:'handles',actor,launcher_exit:run.exit,observation}));
 }
 await route('shell-application','fenced-afterfloor');
 await SandboxManager.reset();
 await new Promise(r=>setTimeout(r,4500));
 const late=path.join(work,'receipt-shell-application-fenced-afterfloor.json.late');
 const initial=late.slice(0,-5);
 console.log(JSON.stringify({test:'com-after-floor-release',initial_observed:fs.existsSync(initial),initial:fs.existsSync(initial)?JSON.parse(fs.readFileSync(initial)):null,observed:fs.existsSync(late),receipt:fs.existsSync(late)?JSON.parse(fs.readFileSync(late)):null}));
}catch(e){console.log(JSON.stringify({test:'review-harness-error',code:e.code??e.name,diagnostic:String(e.message).slice(0,900)}))}
finally{await SandboxManager.reset();server.close();if(createdHostStartup)try{fs.rmdirSync(hostStartup)}catch{}}

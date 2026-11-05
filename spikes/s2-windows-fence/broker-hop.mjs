// Can a fenced command reach a broker endpoint running in the real user's context, and what does
// one request cost? A named pipe whose access list names the sandbox user is reachable from the
// fence; one that does not name it is refused. The endpoint replies with a public fixture string:
// no credential, store or key is involved. Each case is paired with the same requests unfenced.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const {SandboxManager}=await import(pathToFileURL('C:/clover-tools/srt/node_modules/@anthropic-ai/sandbox-runtime/dist/index.js'));
const sandboxUser='clover-spike-sandbox',node='C:/clover-tools/node/node.exe',N=25;
const root=fs.mkdtempSync('C:/clover-tools/clover-broker-hop-'),work=path.join(root,'work');fs.mkdirSync(work);
const realName=os.userInfo().username;
const emit=o=>{const s=JSON.stringify(o);console.log(realName?s.split(realName).join('<real-user>'):s)};
const psOut=c=>(spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',c],{encoding:'utf8'}).stdout||'').trim();
const principalSid=psOut(`(New-Object Security.Principal.NTAccount('${sandboxUser}')).Translate([Security.Principal.SecurityIdentifier]).Value`);
const server=path.join(work,'pipe-server.ps1');
fs.writeFileSync(server,String.raw`param([string]$Name,[string]$GrantSid,[int]$Count)
$ErrorActionPreference='Stop'
$sec=New-Object System.IO.Pipes.PipeSecurity
$sec.AddAccessRule((New-Object System.IO.Pipes.PipeAccessRule([Security.Principal.WindowsIdentity]::GetCurrent().User,'FullControl','Allow')))
if($GrantSid -ne 'none'){$sec.AddAccessRule((New-Object System.IO.Pipes.PipeAccessRule((New-Object Security.Principal.SecurityIdentifier($GrantSid)),'ReadWrite','Allow')))}
function New-Instance{New-Object System.IO.Pipes.NamedPipeServerStream($Name,[System.IO.Pipes.PipeDirection]::InOut,2,[System.IO.Pipes.PipeTransmissionMode]::Byte,[System.IO.Pipes.PipeOptions]::None,4096,4096,$sec)}
$next=New-Instance
Write-Output 'ready'
for($i=0;$i -lt $Count;$i++){
 $cur=$next;$cur.WaitForConnection()
 if($i -lt $Count-1){$next=New-Instance}
 $reader=New-Object IO.StreamReader($cur);$writer=New-Object IO.StreamWriter($cur);$writer.AutoFlush=$true
 $request=$reader.ReadLine();$writer.WriteLine('public-fixture-reply '+$request.Length)
 try{$cur.WaitForPipeDrain()}catch{};$cur.Dispose()
}
`);
const client=path.join(work,'pipe-client.cjs');
fs.writeFileSync(client,String.raw`const net=require('net');const [name,count]=process.argv.slice(2);
function once(){return new Promise(resolve=>{const t0=process.hrtime.bigint();const c=net.connect('\\\\.\\pipe\\'+name);let buf='';
 c.on('connect',()=>c.write('get protocol=https host=fixture.invalid\n'));
 c.on('data',d=>{buf+=d;if(buf.includes('\n')){c.destroy();resolve({ok:buf.startsWith('public-fixture-reply'),ms:Number(process.hrtime.bigint()-t0)/1e6})}});
 c.on('error',e=>resolve({ok:false,code:e.code}));})}
(async()=>{const samples=[];let failure=null;for(let i=0;i<Number(count);i++){const r=await once();if(!r.ok){failure=r.code||'bad-reply';break}samples.push(r.ms)}
 samples.sort((a,b)=>a-b);const at=f=>samples.length?+samples[Math.min(samples.length-1,Math.floor(samples.length*f))].toFixed(2):null;
 console.log(JSON.stringify({completed:samples.length,median_ms:at(0.5),p95_ms:at(0.95),...(failure?{failure}:{})}))})();
`);
const q=s=>"'"+String(s).replaceAll("'","''")+"'";
function collect(argv,env){return new Promise(resolve=>{const c=spawn(argv[0],argv.slice(1),{env,cwd:work,windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',err='';c.stdout.on('data',b=>out+=b);c.stderr.on('data',b=>err+=b);const t=setTimeout(()=>c.kill(),60000);c.on('close',code=>{clearTimeout(t);resolve({code,out,err})});c.on('error',()=>{clearTimeout(t);resolve({code:-1,out,err:'spawn error'})})})}
const last=r=>{for(const line of r.out.trim().split(/\r?\n/).reverse()){try{return JSON.parse(line)}catch{}}return {exit:r.code,diagnostic:r.err.slice(0,300)}};
function startServer(grant,count){
 const name='clover-broker-hop-'+crypto.randomBytes(6).toString('hex');
 const p=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',server,'-Name',name,'-GrantSid',grant,'-Count',String(count)],{stdio:['ignore','pipe','pipe'],windowsHide:true});
 return new Promise(resolve=>{const t=setTimeout(()=>resolve({name,p,ready:false}),20000);p.stdout.on('data',d=>{if(String(d).includes('ready')){clearTimeout(t);resolve({name,p,ready:true})}})});
}
const unfenced=async(name,n)=>last(await collect([node,client,name,String(n)],process.env));
async function fenced(name,n){const {argv,env}=await SandboxManager.wrapWithSandboxArgv('& '+[node,client,name,String(n)].map(q).join(' '),'powershell',undefined,undefined,work);return last(await collect(argv,env));}
const config={filesystem:{allowRead:[work],allowWrite:[work],denyRead:[],denyWrite:[]},network:{allowedDomains:[],deniedDomains:[]},
 windows:{srtWin:{path:'C:/clover-tools/srt/node_modules/@anthropic-ai/sandbox-runtime/vendor/srt-win/x64/srt-win.exe'},sandboxUser,sublayerGuid:'784c4230-1105-4bda-8808-83582c000001'}};
try{
 await SandboxManager.initialize(config);
 for(const actor of ['unfenced','fenced']){
  const s=await startServer(principalSid,N);
  emit({test:'broker-hop',actor,pipe_names_sandbox_user:true,server_ready:s.ready,...(actor==='fenced'?await fenced(s.name,N):await unfenced(s.name,N))});
  s.p.kill();
 }
 // The same endpoint without the sandbox user in its access list: the owner connects, the fence does not.
 const s=await startServer('none',2);
 emit({test:'broker-hop',actor:'unfenced',pipe_names_sandbox_user:false,server_ready:s.ready,...await unfenced(s.name,1)});
 emit({test:'broker-hop',actor:'fenced',pipe_names_sandbox_user:false,server_ready:s.ready,...await fenced(s.name,1)});
 s.p.kill();
}catch(e){emit({test:'broker-hop-error',code:e.code??e.name,diagnostic:String(e.message).slice(0,600)})}
finally{try{await SandboxManager.reset()}catch{}fs.rmSync(root,{force:true,recursive:true})}

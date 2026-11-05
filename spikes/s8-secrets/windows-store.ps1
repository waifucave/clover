$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Write-Output 'Clover OS-store test: in-memory values, throwaway credential target'
$source = @'
using System;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
public static class CloverStoreProbe {
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct PROFILE { public int Size,Flags; public string User,ProfilePath,DefaultPath,Server,Policy; public IntPtr Handle; }
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool LogonUser(string user,string domain,string password,int type,int provider,out IntPtr token);
 [DllImport("userenv.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool LoadUserProfile(IntPtr token,ref PROFILE profile);
 [DllImport("userenv.dll",SetLastError=true)] static extern bool UnloadUserProfile(IntPtr token,IntPtr profile);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 public static string PasswordLogon(string user,string domain,string password) {
  IntPtr token; if(!LogonUser(user,domain,password,2,0,out token)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
  PROFILE profile=new PROFILE(); profile.Size=Marshal.SizeOf(typeof(PROFILE)); profile.Flags=1; profile.User=user; bool loaded=false;
  try {
   if(!LoadUserProfile(token,ref profile)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); loaded=true;
   using(var context=System.Security.Principal.WindowsIdentity.Impersonate(token)) { return Test(); }
  } finally { if(loaded) UnloadUserProfile(token,profile.Handle); CloseHandle(token); }
 }
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct CRED {
  public uint Flags,Type; public string Target,Comment; public long LastWritten;
  public uint Size; public IntPtr Blob; public uint Persist,Count; public IntPtr Attributes;
  public string Alias,User;
 }
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CredWrite(ref CRED c,uint flags);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CredRead(string target,uint type,uint flags,out IntPtr c);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode)] static extern bool CredDelete(string target,uint type,uint flags);
 [DllImport("advapi32.dll")] static extern void CredFree(IntPtr c);
 public static string Test() {
  byte[] key=new byte[32]; using(var r=RandomNumberGenerator.Create()) r.GetBytes(key);
  bool dpapi=false,credential=false; int dpapiError=0,credError=0;
  string target="com.waifucave.clover.test."+Guid.NewGuid().ToString("N"); IntPtr blob=Marshal.AllocHGlobal(32),read=IntPtr.Zero;
  try {
   try { byte[] encrypted=ProtectedData.Protect(key,null,DataProtectionScope.CurrentUser); byte[] plain=ProtectedData.Unprotect(encrypted,null,DataProtectionScope.CurrentUser); dpapi=Convert.ToBase64String(plain)==Convert.ToBase64String(key); Array.Clear(plain,0,plain.Length); Array.Clear(encrypted,0,encrypted.Length); } catch(Exception e) { dpapiError=e.HResult; }
   Marshal.Copy(key,0,blob,32); CRED c=new CRED(); c.Type=1; c.Target=target; c.Size=32; c.Blob=blob; c.Persist=1; c.User="clover-test";
   if(CredWrite(ref c,0) && CredRead(target,1,0,out read)) {
    CRED got=(CRED)Marshal.PtrToStructure(read,typeof(CRED)); byte[] plain=new byte[got.Size]; Marshal.Copy(got.Blob,plain,0,plain.Length);
    credential=Convert.ToBase64String(key)==Convert.ToBase64String(plain); Array.Clear(plain,0,plain.Length);
   } else credError=Marshal.GetLastWin32Error();
  } finally { CredDelete(target,1,0); if(read!=IntPtr.Zero) CredFree(read); Array.Clear(key,0,key.Length); Marshal.Copy(key,0,blob,32); Marshal.FreeHGlobal(blob); }
  return "{\"dpapi_roundtrip\":"+dpapi.ToString().ToLower()+",\"dpapi_hresult\":"+dpapiError+",\"credential_roundtrip\":"+credential.ToString().ToLower()+",\"credential_error\":"+credError+"}";
 }
}
'@
Add-Type -TypeDefinition $source -ReferencedAssemblies System.Security
$ssh = [CloverStoreProbe]::Test() | ConvertFrom-Json
$ssh | Add-Member -NotePropertyName logon -NotePropertyValue 'SSH key (network logon)'
$ssh | ConvertTo-Json -Compress
$user = 'clover_t_' + [Guid]::NewGuid().ToString('N').Substring(0,8)
$task = 'com.waifucave.clover.test.' + [Guid]::NewGuid().ToString('N')
$root = Join-Path 'C:\clover-tools' $task
$sid = $null
New-Item -ItemType Directory $root | Out-Null
try {
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    $random = New-Object byte[] 36
    $rng.GetBytes($random)
    $password = [Convert]::ToBase64String($random) + '!aA9'
    [Array]::Clear($random,0,$random.Length)
    $secure = ConvertTo-SecureString $password -AsPlainText -Force
    $account = New-LocalUser -Name $user -Password $secure -AccountNeverExpires
    $sid = $account.SID.Value
    & icacls $root /grant ($user + ':(OI)(CI)M') | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Test-user fixture ACL failed' }
    $batch = [CloverStoreProbe]::PasswordLogon($user,$env:COMPUTERNAME,$password) | ConvertFrom-Json
    $password = $null
    $batch | Add-Member -NotePropertyName logon -NotePropertyValue 'LogonUser type 2 (password interactive), LoadUserProfile, impersonated throwaway local user'
    $batch | ConvertTo-Json -Compress
} finally {
    $password = $null
    Remove-LocalUser -Name $user -ErrorAction SilentlyContinue
    if ($sid) { Get-CimInstance Win32_UserProfile -Filter ("SID='" + $sid + "'") | Remove-CimInstance -ErrorAction SilentlyContinue }
    Remove-Item -Recurse -Force $root
}

$ErrorActionPreference='Stop'
Write-Output 'Controlled token-DACL/default-DACL/private-desktop diagnostics; fixed public commands only'
Add-Type -Path (Join-Path $PSScriptRoot 'windows-probe.cs')
$root=Join-Path C:\clover-tools ('clover-diag-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $root | Out-Null
try {
 & icacls $root /grant '*S-1-5-12:(OI)(CI)M' | Out-Null
 $env:TEMP=$root;$env:TMP=$root
 $tests=@(
  @{name='powershell';exe="$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe";args='-NoProfile -Command "exit 0"'},
  @{name='msys-objects-fork';exe='C:\Program Files\Git\bin\bash.exe';args='--noprofile --norc -c "(true) && test $(printf abc | wc -c) = 3"'},
  @{name='win32-node';exe='C:\clover-tools\node\node.exe';args='-e "process.exit(0)"'}
 )
 foreach($mode in @('privileges','restricted','restricted-fixed','desktop-fixed')) {
  foreach($t in $tests) {
   try {$r=[CloverLaunchProbe]::Run($mode,$t.exe,$t.args,$root,'unused') | ConvertFrom-Json;$r | Add-Member -NotePropertyName check -NotePropertyValue $t.name;$r | ConvertTo-Json -Compress}
   catch {@{mode=$mode;check=$t.name;native_error=$_.Exception.InnerException.NativeErrorCode} | ConvertTo-Json -Compress}
  }
 }
} finally {Remove-Item -Recurse -Force $root}

$ErrorActionPreference='Stop'
$global:ProgressPreference='SilentlyContinue'
Write-Output 'Testing Cursor Windows sandbox-only command with a temporary home and project'
$root=Join-Path C:\clover-tools ('clover-cursor-gates-'+[Guid]::NewGuid().ToString('N'))
$work=Join-Path $root work;$control=Join-Path $root control
New-Item -ItemType Directory $work,$control | Out-Null
Set-Content (Join-Path $control public.txt) 'public fixture'
New-Item -ItemType Directory (Join-Path $work .cursor) | Out-Null
@{permissions=@{allow=@();deny=@('Read('+$control+'/**)','Write('+$control+'/**)')}} | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $work '.cursor\cli.json')
$env:HOME=$root;$env:USERPROFILE=$root;$env:APPDATA=$root;$env:LOCALAPPDATA=$root;$env:DO_NOT_TRACK='1';$env:CI='1'
try {
 Push-Location $work
 foreach($test in @('allowed-write','hidden-read','hidden-write','nested-retry')) {
  $script=Join-Path $work ($test+'.ps1')
  switch($test) {
   'allowed-write' {$code="Set-Content '"+(Join-Path $work ok)+"' public"}
   'hidden-read' {$code="try {Get-Content '"+(Join-Path $control public.txt)+"' -ErrorAction Stop | Out-Null;exit 9} catch {exit 0}"}
   'hidden-write' {$code="try {Set-Content '"+(Join-Path $control bad)+"' public -ErrorAction Stop;exit 9} catch {exit 0}"}
   'nested-retry' {$code="& powershell -NoProfile -Command `"try {Get-Content '"+(Join-Path $control public.txt)+"' -ErrorAction Stop | Out-Null;exit 9} catch {exit 0}`"; exit `$LASTEXITCODE"}
  }
  Set-Content $script $code
  $ErrorActionPreference='Continue'
  $output=& C:\clover-tools\cursor\dist-package\cursor-agent.cmd sandbox run --blocked-patterns ($control+'/**') -- powershell -NoProfile -ExecutionPolicy Bypass -File $script 2>&1
  $exit=$LASTEXITCODE
  $ErrorActionPreference='Stop'
  @{backend='cursor-windows';test=$test;exit=$exit;diagnostic=([string]($output -join "`n")).Replace($root,'<isolated-home>').Substring(0,[Math]::Min(1200,([string]($output -join "`n")).Length))} | ConvertTo-Json -Compress
 }
 @{test='cursor-windows-host-state';allowed_write=(Test-Path (Join-Path $work ok));hidden_write=(Test-Path (Join-Path $control bad))} | ConvertTo-Json -Compress
} finally {Pop-Location;Remove-Item -Recurse -Force $root}

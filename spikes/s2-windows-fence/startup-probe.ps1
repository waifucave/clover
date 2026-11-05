$ErrorActionPreference='Stop'
$env:PATH='C:\clover-tools\node;C:\Program Files\Git\bin;C:\Program Files\Git\usr\bin;'+$env:PATH
Write-Output 'Startup and profile writes: real profile by SID, baseline versus Startup deny versus profile deny, admin control'
Add-Type -Path (Join-Path $PSScriptRoot 'session0-bno.cs')
try {
 Write-Output ([CloverSessionZero]::Open())
 & C:\clover-tools\node\node.exe (Join-Path $PSScriptRoot 'startup-probe.mjs')
} finally {[CloverSessionZero]::Close()}

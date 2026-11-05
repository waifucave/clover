$ErrorActionPreference='Stop'
$env:PATH='C:\clover-tools\node;C:\Program Files\Git\bin;C:\Program Files\Git\usr\bin;' + $env:PATH
Write-Output 'Testing temporary Session 0 namespace alias, diagnostic only'
Add-Type -Path (Join-Path $PSScriptRoot 'session0-bno.cs')
try {
 Write-Output ([CloverSessionZero]::Open())
 & C:\clover-tools\node\node.exe (Join-Path $PSScriptRoot 'candidate.mjs')
} finally {[CloverSessionZero]::Close()}

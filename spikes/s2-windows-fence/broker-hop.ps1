$ErrorActionPreference='Stop'
$env:PATH='C:\clover-tools\node;C:\Program Files\Git\bin;C:\Program Files\Git\usr\bin;'+$env:PATH
Write-Output 'Broker hop: fenced and unfenced requests to a user-context named pipe, public fixture reply only'
Add-Type -Path (Join-Path $PSScriptRoot 'session0-bno.cs')
try {
 Write-Output ([CloverSessionZero]::Open())
 & C:\clover-tools\node\node.exe (Join-Path $PSScriptRoot 'broker-hop.mjs')
} finally {[CloverSessionZero]::Close()}

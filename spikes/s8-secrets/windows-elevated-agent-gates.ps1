$ErrorActionPreference='Stop'
$env:CLOVER_CODEX_BACKEND='elevated'
Write-Output 'Testing elevated native Windows Codex sandbox-only entry point'
Add-Type -Path (Join-Path $PSScriptRoot 'session0-bno.cs')
try {
 Write-Output ([CloverSessionZero]::Open())
 & C:\clover-tools\node\node.exe (Join-Path $PSScriptRoot 'windows-agent-gates.mjs')
} finally {[CloverSessionZero]::Close()}

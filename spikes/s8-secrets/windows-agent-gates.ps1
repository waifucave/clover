$ErrorActionPreference='Stop'
Write-Output 'Testing Codex native Windows sandbox-only entry point with an isolated CODEX_HOME'
& C:\clover-tools\node\node.exe (Join-Path $PSScriptRoot 'windows-agent-gates.mjs')

$ErrorActionPreference='Stop'
Write-Output 'Bounded native Windows Cursor sandbox-only probes'
& C:\clover-tools\node\node.exe (Join-Path $PSScriptRoot 'cursor-bounded.mjs')

$ErrorActionPreference='Stop'
$env:PATH='C:\clover-tools\node;C:\Program Files\Git\bin;C:\Program Files\Git\usr\bin;' + $env:PATH
Write-Output 'Evaluating dedicated-principal WFP candidate and mandatory-floor attempts'
& C:\clover-tools\node\node.exe (Join-Path $PSScriptRoot 'candidate.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Candidate harness failed' }

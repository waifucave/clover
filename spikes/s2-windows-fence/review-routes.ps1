$ErrorActionPreference='Stop'
$env:PATH='C:\clover-tools\node;C:\Program Files\Git\bin;C:\Program Files\Git\usr\bin;'+$env:PATH
$env:CLOVER_HOST_ADMIN=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator).ToString()
$root=Join-Path C:\clover-tools ('clover-review-'+[Guid]::NewGuid().ToString('N'))
$bin=Join-Path $root bin;$work=Join-Path $root work
New-Item -ItemType Directory $bin,$work | Out-Null
Write-Output 'Review controls: local-admin host, dedicated fenced principal, observable COM and handles'
try {
 Add-Type -TypeDefinition (Get-Content (Join-Path $PSScriptRoot 'handle-probe.cs') -Raw) -OutputAssembly (Join-Path $bin handle-probe.exe) -OutputType ConsoleApplication
 Add-Type -Path (Join-Path $PSScriptRoot 'session0-bno.cs')
 Write-Output ([CloverSessionZero]::Open())
 & C:\clover-tools\node\node.exe (Join-Path $PSScriptRoot 'review-routes.mjs') $root
} finally {
 [CloverSessionZero]::Close()
 Remove-Item $root -Recurse -Force -ErrorAction Continue
}

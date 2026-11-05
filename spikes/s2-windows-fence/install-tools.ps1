$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Write-Output 'Installing Node and Bun in the disposable Windows VM'
New-Item -ItemType Directory -Force C:\clover-tools | Out-Null
Invoke-WebRequest 'https://nodejs.org/dist/v22.21.1/node-v22.21.1-win-x64.zip' -OutFile C:\clover-tools\node.zip
Expand-Archive -Force C:\clover-tools\node.zip C:\clover-tools\node-unpack
Move-Item C:\clover-tools\node-unpack\node-v22.21.1-win-x64 C:\clover-tools\node -Force
Invoke-WebRequest 'https://github.com/oven-sh/bun/releases/download/bun-v1.3.1/bun-windows-x64.zip' -OutFile C:\clover-tools\bun.zip
Expand-Archive -Force C:\clover-tools\bun.zip C:\clover-tools\bun-unpack
Move-Item C:\clover-tools\bun-unpack\bun-windows-x64 C:\clover-tools\bun -Force
Remove-Item C:\clover-tools\node.zip,C:\clover-tools\bun.zip
& 'C:\Program Files\Git\bin\git.exe' --version
& C:\clover-tools\node\node.exe --version
& C:\clover-tools\bun\bun.exe --version

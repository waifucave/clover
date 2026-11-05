$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
Write-Output 'Downloading pinned headless Cursor CLI for Windows'
$zip='C:\clover-tools\cursor.zip'
Invoke-WebRequest https://downloads.cursor.com/lab/2026.10.22-27dcf5f/windows/x64/agent-cli-package.zip -OutFile $zip
Expand-Archive -Force $zip C:\clover-tools\cursor
Remove-Item $zip -Force
Get-ChildItem C:\clover-tools\cursor -Recurse -Depth 2 | Where-Object Name -match 'cursor-agent|agent.exe' | Select-Object -First 12 -ExpandProperty FullName

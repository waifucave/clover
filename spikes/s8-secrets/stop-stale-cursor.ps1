$ErrorActionPreference='Stop'
Write-Output 'Stopping only task-owned Cursor and interrupted transport processes'
Get-CimInstance Win32_Process | Where-Object {
 ($_.ExecutablePath -like 'C:\clover-tools\cursor\*') -or
 ($_.ProcessId -ne $PID -and $_.Name -eq 'powershell.exe' -and $_.CommandLine -like '*clover-transport-*')
} | ForEach-Object {Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue}

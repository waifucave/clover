$ErrorActionPreference='Continue'
$ProgressPreference='SilentlyContinue'
Write-Output 'Cleaning only lane C sandbox installations, tasks, users and interrupted fixtures'
Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -like 'C:\clover-tools\*'} | ForEach-Object {Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue}
Get-ScheduledTask | Where-Object {$_.TaskName -like 'com.waifucave.clover.batch.*' -or $_.TaskName -like 'com.waifucave.clover.scheduler-control.*' -or $_.TaskName -eq 'com.waifucave.clover.spike.escape'} | ForEach-Object {
 Stop-ScheduledTask -TaskName $_.TaskName -ErrorAction SilentlyContinue
 Unregister-ScheduledTask -TaskName $_.TaskName -Confirm:$false
}
$env:CODEX_HOME=Join-Path $env:TEMP ('clover-codex-cleanup-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $env:CODEX_HOME | Out-Null
& C:\clover-tools\node\node.exe C:\clover-tools\srt\node_modules\@openai\codex\bin\codex.js sandbox uninstall
Write-Output ('codex_uninstall_exit='+$LASTEXITCODE)
& C:\clover-tools\srt\node_modules\@anthropic-ai\sandbox-runtime\vendor\srt-win\x64\srt-win.exe uninstall --sublayer-guid 784c4230-1105-4bda-8808-83582c000001
Write-Output ('srt_uninstall_exit='+$LASTEXITCODE)
Get-LocalUser | Where-Object {$_.Name -match '^clover_[bt]_'} | ForEach-Object {
 $sid=$_.SID.Value;Remove-LocalUser $_.Name
 Get-CimInstance Win32_UserProfile -Filter ("SID='"+$sid+"'") | Remove-CimInstance -ErrorAction SilentlyContinue
}
$startup=Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
# The paired review fixture created this previously missing leaf. Remove it only
# when empty; never remove another process's Startup entry.
if ((Test-Path $startup) -and !(Get-ChildItem -Force $startup)) {Remove-Item $startup -ErrorAction Continue}
Get-ChildItem C:\clover-tools -Directory | Where-Object {$_.Name -like 'clover-*' -or $_.Name -like 'com.waifucave.clover.*' -or $_.Name -in @('cursor','srt','npm-cache')} | Remove-Item -Recurse -Force -ErrorAction Continue
Remove-Item -Recurse -Force $env:CODEX_HOME
Get-ChildItem $env:TEMP -Filter clover-transport-*.b64 | Remove-Item -Force
Get-ChildItem $env:TEMP -Directory -Filter clover-lane-c-* | Where-Object {$_.FullName -ne $PSScriptRoot} | Remove-Item -Recurse -Force -ErrorAction Continue
Write-Output 'Remaining lane test users:'
Get-LocalUser | Where-Object {$_.Name -like 'clover_*' -or $_.Name -like 'CodexSandbox*'} | Select-Object -ExpandProperty Name

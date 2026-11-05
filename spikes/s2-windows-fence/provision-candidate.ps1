$ErrorActionPreference = 'Stop'
$global:ProgressPreference = 'SilentlyContinue'
$env:PATH = 'C:\clover-tools\node;C:\Program Files\Git\bin;C:\Program Files\Git\usr\bin;' + $env:PATH
$name = 'clover-spike-sandbox'
$srt = 'C:\clover-tools\srt\node_modules\@anthropic-ai\sandbox-runtime\vendor\srt-win\x64\srt-win.exe'
Write-Output 'Provisioning a fresh disposable Clover sandbox principal and WFP fence'
# Removing the account alone leaves its profile behind; a leftover C:\Users\<name> folder then
# makes Windows put the next principal's profile at <name>.<COMPUTERNAME>. Remove both by SID.
$old = Get-LocalUser -Name $name -ErrorAction SilentlyContinue
if ($old) {
  $sid = $old.SID.Value
  Get-CimInstance Win32_UserProfile -Filter ("SID='" + $sid + "'") | Remove-CimInstance -ErrorAction Continue
  Remove-Item ('HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\' + $sid + '.bak') -Recurse -Force -ErrorAction SilentlyContinue
  & $srt uninstall --sublayer-guid 784c4230-1105-4bda-8808-83582c000001
  Write-Output ('previous_principal_uninstall_exit=' + $LASTEXITCODE)
}
Get-ChildItem C:\Users -Directory -Force | Where-Object { $_.Name -eq $name -or $_.Name -like ($name + '.*') } | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction Continue }
& C:\clover-tools\node\node.exe C:\clover-tools\srt\node_modules\@anthropic-ai\sandbox-runtime\dist\cli.js windows-install --sandbox-user $name --skip-profile-grant --sublayer-guid 784c4230-1105-4bda-8808-83582c000001
if ($LASTEXITCODE -ne 0) { throw 'Windows sandbox provisioning failed' }
Write-Output ('leftover_profile_folders=' + @(Get-ChildItem C:\Users -Directory -Force | Where-Object { $_.Name -like ($name + '*') }).Count)
Write-Output 'Provisioning completed'

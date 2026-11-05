$ErrorActionPreference = 'Stop'
$global:ProgressPreference = 'SilentlyContinue'
$env:PATH = 'C:\clover-tools\node;C:\Program Files\Git\bin;C:\Program Files\Git\usr\bin;' + $env:PATH
Write-Output 'Provisioning disposable Clover sandbox principal and WFP fence'
& C:\clover-tools\node\node.exe C:\clover-tools\srt\node_modules\@anthropic-ai\sandbox-runtime\dist\cli.js windows-install --sandbox-user clover-spike-sandbox --skip-profile-grant --sublayer-guid 784c4230-1105-4bda-8808-83582c000001
if ($LASTEXITCODE -ne 0) { throw 'Windows sandbox provisioning failed' }
Write-Output 'Provisioning completed'

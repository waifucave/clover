$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$env:PATH = 'C:\clover-tools\node;C:\Program Files\Git\bin;C:\Program Files\Git\usr\bin;' + $env:PATH
Write-Output 'Installing pinned standalone Windows sandbox candidate'
& C:\clover-tools\node\npm.cmd install --prefix C:\clover-tools\srt --cache C:\clover-tools\npm-cache --ignore-scripts --no-audit --no-fund @anthropic-ai/sandbox-runtime@0.0.81 @openai/codex@0.166.0
if ($LASTEXITCODE -ne 0) { throw 'Candidate package install failed' }
$helper = Get-Item C:\clover-tools\srt\node_modules\@anthropic-ai\sandbox-runtime\vendor\srt-win\x64\srt-win.exe
if (!$helper) { throw 'Bundled Windows helper not found' }
Write-Output ('HELPER ' + $helper.FullName)
& $helper.FullName --help
& C:\clover-tools\node\node.exe C:\clover-tools\srt\node_modules\@anthropic-ai\sandbox-runtime\dist\cli.js windows-install --help

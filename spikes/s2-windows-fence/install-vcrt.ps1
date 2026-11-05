$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
Write-Output 'Installing Microsoft VC++ runtime required by the pinned native helper'
$path='C:\clover-tools\vc_redist.x64.exe'
Invoke-WebRequest https://aka.ms/vs/17/release/vc_redist.x64.exe -OutFile $path
$p=Start-Process $path -ArgumentList '/install /quiet /norestart' -Wait -PassThru
Write-Output ('vcrt_exit=' + $p.ExitCode)
Remove-Item $path -Force
if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010 -and $p.ExitCode -ne 1638) { throw 'VC runtime install failed' }
& C:\clover-tools\srt\node_modules\@anthropic-ai\sandbox-runtime\vendor\srt-win\x64\srt-win.exe --help

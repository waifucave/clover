$ErrorActionPreference='Stop'
Write-Output 'Testing the scheduled-task infrastructure with a disposable SYSTEM control'
$task='com.waifucave.clover.scheduler-control.'+[Guid]::NewGuid().ToString('N')
$root=Join-Path C:\clover-tools $task
New-Item -ItemType Directory $root | Out-Null
try {
 $marker=Join-Path $root 'started.txt'
 $action=New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\cmd.exe" -Argument ('/c echo public-control>"'+$marker+'"')
 Register-ScheduledTask -TaskName $task -Action $action -User SYSTEM -RunLevel Highest | Out-Null
 Start-ScheduledTask -TaskName $task
 for($i=0;$i -lt 10 -and !(Test-Path $marker);$i++){Start-Sleep -Seconds 1}
 $info=Get-ScheduledTaskInfo -TaskName $task
 @{test='system-scheduler-control';started=(Test-Path $marker);last_result=$info.LastTaskResult;last_run=[string]$info.LastRunTime} | ConvertTo-Json -Compress
} finally {
 Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
 Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
 Remove-Item -Recurse -Force $root
}

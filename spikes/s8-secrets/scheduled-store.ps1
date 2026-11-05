$ErrorActionPreference='Stop'
$global:ProgressPreference='SilentlyContinue'
Write-Output 'Testing credential primitives in a password-backed scheduled-task startup context'
$original=Get-Content (Join-Path $PSScriptRoot 'windows-store.ps1') -Raw
$source=[regex]::Match($original,"(?s)\`$source = @'\r?\n(.*?)\r?\n'@").Groups[1].Value
if (!$source) { throw 'Store probe source missing' }
$user='clover_b_'+[Guid]::NewGuid().ToString('N').Substring(0,8)
$task='com.waifucave.clover.batch.'+[Guid]::NewGuid().ToString('N')
$root=Join-Path C:\clover-tools $task
New-Item -ItemType Directory $root | Out-Null
$sid=$null
try {
 $bytes=New-Object byte[] 36
 $rng=[Security.Cryptography.RandomNumberGenerator]::Create();$rng.GetBytes($bytes)
 $password=[Convert]::ToBase64String($bytes)+'!aA9'
 [Array]::Clear($bytes,0,$bytes.Length)
 $account=New-LocalUser -Name $user -Password (ConvertTo-SecureString $password -AsPlainText -Force)
 $sid=$account.SID.Value
 Add-LocalGroupMember -Group ([Security.Principal.SecurityIdentifier]'S-1-5-32-545').Translate([Security.Principal.NTAccount]).Value.Split('\')[-1] -Member $user
 & icacls $root /grant ($user+':(OI)(CI)M') | Out-Null
 $result=Join-Path $root 'result.json';$started=Join-Path $root 'started.txt';$script=Join-Path $root 'batch.ps1'
 $child="`$ErrorActionPreference='Stop'; 'public started marker' | Set-Content '"+$started+"'; try { Add-Type -TypeDefinition @'`n"+$source+"`n'@ -ReferencedAssemblies System.Security`n[CloverStoreProbe]::Test() | Set-Content '"+$result+"' } catch { @{ error_hresult=`$_.Exception.HResult } | ConvertTo-Json -Compress | Set-Content '"+$result+"' }"
 [IO.File]::WriteAllText($script,$child)
 $action=New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$script+'"') -WorkingDirectory $root
 $settings=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 1)
 $trigger=New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(12)
 Register-ScheduledTask -TaskName $task -Action $action -Settings $settings -Trigger $trigger -User ($env:COMPUTERNAME+'\'+$user) -Password $password | Out-Null
 $scheduler=New-Object -ComObject Schedule.Service
 $scheduler.Connect()
 $registered=$scheduler.GetFolder('\').GetTask($task)
 Write-Output ('principal_logon_type='+$registered.Definition.Principal.LogonType+' enabled='+$registered.Enabled+' allow_demand='+$registered.Definition.Settings.AllowDemandStart)
 $running=$registered.RunEx($null,2,0,$null)
 Write-Output ('RunEx_state='+$running.State)
 $password=$null
 Start-ScheduledTask -TaskName $task
 for($i=0;$i -lt 75 -and !(Test-Path $result);$i++) {
  if($i%15 -eq 0){Write-Output ('Waiting for batch startup '+$i+'s')}
  Start-Sleep -Seconds 1
 }
 $info=Get-ScheduledTaskInfo -TaskName $task
 $state=(Get-ScheduledTask -TaskName $task).State
 if(Test-Path $result){$r=Get-Content $result -Raw | ConvertFrom-Json}else{$r=[pscustomobject]@{result_file=$false}}
 $r | Add-Member -NotePropertyName started -NotePropertyValue (Test-Path $started)
 $r | Add-Member -NotePropertyName task_result -NotePropertyValue $info.LastTaskResult
 $r | Add-Member -NotePropertyName task_state -NotePropertyValue ([string]$state)
 $r | Add-Member -NotePropertyName logon -NotePropertyValue 'Scheduled Task password principal, on-demand and timed trigger'
 $r | ConvertTo-Json -Compress
} finally {
 $password=$null
 Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
 Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
 Remove-LocalUser $user -ErrorAction SilentlyContinue
 if($sid){Get-CimInstance Win32_UserProfile -Filter ("SID='"+$sid+"'") | Remove-CimInstance -ErrorAction SilentlyContinue}
 Remove-Item -Recurse -Force $root
}

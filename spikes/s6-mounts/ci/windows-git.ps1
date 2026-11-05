# Windows diagnostic: can Git for Windows (and its bash) work inside the WinFsp tree? Tries the
# DefineDosDevice drive letter (T:) and the Mount Manager form (\\.\T:).
#   windows-git.ps1 <helper.exe> <export dir> <serve.ts>
param([string]$Helper, [string]$Export, [string]$Serve)
$ErrorActionPreference = "Continue"
$svc = Start-Process bun -ArgumentList "`"$Serve`" --root `"$Export`" --port 7400" -PassThru -WindowStyle Hidden
Start-Sleep 3
foreach ($mp in @("T:", "\\.\T:")) {
  Write-Host "== mount point $mp"
  $h = Start-Process $Helper -ArgumentList "--mountpoint $mp --policy plain --remote Desktop1=127.0.0.1:7400 --self Runner=$env:USERPROFILE" -PassThru -WindowStyle Hidden -RedirectStandardError "$env:RUNNER_TEMP\helper-$($mp -replace '[\\.:]','_').log"
  for ($i = 0; $i -lt 50 -and -not (Test-Path "T:\home")); $i++) { Start-Sleep -Milliseconds 200 }
  Write-Host "T:\home exists: $(Test-Path 'T:\home')"
  Get-ChildItem T:\home -ErrorAction Continue | Format-Table Name, Mode, LinkType, Target -AutoSize | Out-String | Write-Host
  Push-Location T:\home\Desktop1\clover
  Write-Host "--- pwd: $((Get-Location).Path)"
  git status --porcelain 2>&1 | Select-Object -First 3 | ForEach-Object { Write-Host "git: $_" }
  Write-Host "git exit $LASTEXITCODE"
  git rev-parse --show-toplevel 2>&1 | ForEach-Object { Write-Host "toplevel: $_" }
  & "C:\Program Files\Git\bin\bash.exe" -lc 'pwd; ls | head -3; git status --porcelain | head -3; echo bash-git-exit $?' 2>&1 | ForEach-Object { Write-Host "bash: $_" }
  Pop-Location
  git -C T:\home\Desktop1\clover status --porcelain 2>&1 | Select-Object -First 2 | ForEach-Object { Write-Host "git -C: $_" }
  Write-Host "git -C exit $LASTEXITCODE"
  Stop-Process -Id $h.Id -Force
  for ($i = 0; $i -lt 50 -and (Test-Path "T:\home")); $i++) { Start-Sleep -Milliseconds 200 }
  Get-Content "$env:RUNNER_TEMP\helper-$($mp -replace '[\\.:]','_').log" -Tail 5 | ForEach-Object { Write-Host "helper: $_" }
}
Stop-Process -Id $svc.Id -Force
exit 0

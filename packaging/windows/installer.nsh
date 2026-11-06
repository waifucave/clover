; Clover's additions to the NSIS installer electron-builder makes (electron-builder.yml, nsis.include): per user, so
; it runs as the user and an update needs no prompt. winget runs this same installer and its uninstaller.
;
; Login start is the daemon's (lane C: clover-core autostart, a Task Scheduler task running clover-core supervise).
; The app turns it on at its first launch (spec §3.1); the uninstaller removes it through the same command, never
; through schtasks, and only on a real uninstall: `autostart remove` stops the daemon, so its files are free to delete,
; and deletes the task. nsExec runs it without a console window and logs its output; a missing exe or a failure is
; logged and the uninstall goes on.
;
; Bash's sandbox principal on Windows (lane C, spec §9.1: a hidden local user, its WFP filters, set up once): the one
; elevated step, the controller's ruling. A first install (not an update) asks once, through Windows' own elevation
; prompt, to set it up; an update never asks, and the principal stays across updates. If the user declines (1223),
; or setup fails, the install still finishes and Bash stays off until the app's "Set up Bash". A real uninstall
; removes it the same way, after login start is removed. `sandbox status` comes first on install, unelevated: 0 means
; the principal and its filters are there and good (an earlier install), and nothing is asked.
;
; Nothing is ever elevated from the install folder, which the user can write: the elevated step is
; packaging/windows/sandbox-elevated.ps1, which copies clover-core.exe from here into %ProgramFiles%\Clover Sandbox\,
; checks the copy's Authenticode digest against the pin the release build compiled in, and runs `sandbox setup` from
; the copy (`remove` runs from the same copy), each user's copy in a folder of its own named by their SID, which must
; be owned by Administrators, SYSTEM or TrustedInstaller and not writable by users. The script is no file: the
; release build puts its text, with the pin, in sandbox.nsh (CLOVER_SANDBOX_PS, base64), and it goes to the elevated
; PowerShell as an encoded command. The source path and the user's SID go in base64 (UTF-16) inside that command, so
; no character of a folder name is parsed as code (PowerShell's curly quotes included). The path reaches the
; unelevated PowerShell through CLOVERINSTALL_SANDBOX_SOURCE, cleared right after, so the app never sees it.
; PowerShell is always Windows' own, by full path and 64-bit: $WINDIR\Sysnative\… from this 32-bit installer, and
; System32's from the 64-bit PowerShell it starts.
; Exit codes: clover-core's (0 done, 1 failed, 2 not elevated, 3 the launcher missing or not pinned), 4 the exe to
; run is missing, 5 the copy is not the pinned one, 6 its folder is not protected, 7 a bad argument, 1223 the user
; declined.
;
; An upgrade stops the old daemon before its files are replaced: `clover-core daemon stop` (lane C's: unelevated,
; no flags; it stops the daemon and waits until its pipe and lock are gone, leaving login start alone). Exit 1 means
; it is still running, so its files can't be replaced: the install stops there, and a later update tries again. The
; app itself is then closed by electron-builder's own check, which this hook runs after.

!include "${PROJECT_DIR}\out\sandbox.nsh"
!ifndef CLOVER_SANDBOX_PS
  !error "sandbox.nsh defines no CLOVER_SANDBOX_PS: build the Windows installer with scripts/release/build.ts"
!endif

!macro cloverSandbox ACTION
  System::Call 'Kernel32::SetEnvironmentVariable(t "CLOVERINSTALL_SANDBOX_SOURCE", t "$INSTDIR\resources\daemon\clover-core.exe")i'
  nsExec::ExecToLog `"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -Command "$$s = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${CLOVER_SANDBOX_PS}')); $$u = [Text.Encoding]::Unicode; $$src = [Convert]::ToBase64String($$u.GetBytes($$env:CLOVERINSTALL_SANDBOX_SOURCE)); $$sid = [Convert]::ToBase64String($$u.GetBytes([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)); $$a = [string][char]39; $$c = '& {' + $$s + '} -Action ${ACTION} -SourceB64 ' + $$a + $$src + $$a + ' -UserB64 ' + $$a + $$sid + $$a; $$ps = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'; try { $$p = Start-Process -FilePath $$ps -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',[Convert]::ToBase64String($$u.GetBytes($$c)) -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $$p.ExitCode } catch { exit 1223 }"`
  Pop $0
  System::Call 'Kernel32::SetEnvironmentVariable(t "CLOVERINSTALL_SANDBOX_SOURCE", p 0)i'
  DetailPrint "Clover: sandbox ${ACTION} exited $0"
!macroend

!macro customCheckAppRunning
  ${if} ${FileExists} "$INSTDIR\resources\daemon\clover-core.exe"
    nsExec::ExecToLog '"$INSTDIR\resources\daemon\clover-core.exe" daemon stop'
    Pop $0
    ${if} $0 == 1
      DetailPrint "Clover: the running daemon didn't stop; its files can't be replaced now"
      SetErrorLevel 1
      Quit
    ${endIf}
    ; An older daemon without `daemon stop` answers with its help and exit 0, so stopped is confirmed from the OS:
    ; any clover-core still running from this install is stopped by Windows itself, and if one is still there after,
    ; the install stops.
    System::Call 'Kernel32::SetEnvironmentVariable(t "CLOVERINSTALL_DAEMON_DIR", t "$INSTDIR\resources\daemon\")i'
    nsExec::ExecToLog `"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -Command "$$d = $$env:CLOVERINSTALL_DAEMON_DIR; function Get-Ours { Get-Process -Name clover-core -ErrorAction SilentlyContinue | Where-Object { $$_.Path -and $$_.Path.StartsWith($$d, [StringComparison]::OrdinalIgnoreCase) } }; $$p = Get-Ours; if ($$p) { $$p | Stop-Process -Force; Start-Sleep -Seconds 2; if (Get-Ours) { exit 1 } }; exit 0"`
    Pop $0
    System::Call 'Kernel32::SetEnvironmentVariable(t "CLOVERINSTALL_DAEMON_DIR", p 0)i'
    ${if} $0 != 0
      DetailPrint "Clover: a daemon from this install is still running; its files can't be replaced now"
      SetErrorLevel 1
      Quit
    ${endIf}
  ${endIf}
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
!macroend

!macro customInstall
  ${ifNot} ${isUpdated}
    nsExec::ExecToLog '"$INSTDIR\resources\daemon\clover-core.exe" sandbox status'
    Pop $0
    ${if} $0 != 0
      !insertmacro cloverSandbox setup
    ${endIf}
  ${endIf}
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    nsExec::ExecToLog '"$INSTDIR\resources\daemon\clover-core.exe" autostart remove'
    Pop $0
    !insertmacro cloverSandbox remove
  ${endIf}
!macroend

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
; prompt, to run `clover-core sandbox setup`; an update never asks, and the principal stays across updates. If the
; user declines, or setup fails, the install still finishes and Bash stays off until the app's "Set up Bash", which
; runs the same command. A real uninstall runs `clover-core sandbox remove` the same way, after login start is
; removed. `sandbox status` comes first on install, unelevated: 0 means the principal and its filters are there and
; good (an earlier install), and nothing is asked; anything else runs setup (3, the launcher missing or not the
; pinned one, makes setup exit 3 too and change nothing, which is logged).
; The command takes no flags: the principal's name, its WFP sublayer and the profile rules are compiled into it.
; Its exit codes: 0 done, 2 not elevated, 3 the launcher missing or not the pinned one, 1 anything else; 1223 here
; means the user declined the prompt. The binary's path goes to PowerShell in the environment, never inside the
; command text, so no character in the user's folder name can change the command.
;
; Open, before E-M1's Windows installer ships: an upgrade runs the old uninstaller with --updated, which skips this and
; so leaves the old daemon running, its exe locked while the new files are written. Stopping it there must not turn
; login start off (`disable` is the user's choice and stays), so it needs a stop without a disable from lane C.

!macro cloverSandbox ACTION
  System::Call 'Kernel32::SetEnvironmentVariable(t "CLOVER_CORE_EXE", t "$INSTDIR\resources\daemon\clover-core.exe")i'
  nsExec::ExecToLog `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -Command "try { $$p = Start-Process -FilePath $$env:CLOVER_CORE_EXE -ArgumentList 'sandbox','${ACTION}' -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $$p.ExitCode } catch { exit 1223 }"`
  Pop $0
  DetailPrint "Clover: sandbox ${ACTION} exited $0"
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

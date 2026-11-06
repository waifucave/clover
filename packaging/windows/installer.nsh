; Clover's additions to the NSIS installer electron-builder makes (electron-builder.yml, nsis.include). The Windows
; installer itself comes with E-M1's app; until then this file is checked by packaging.test.ts but not built.
;
; Login start is the daemon's (lane C: clover-core autostart, a Task Scheduler task running clover-core supervise).
; The app turns it on at its first launch (spec §3.1); the uninstaller removes it through the same command, never
; through schtasks, and only on a real uninstall: `autostart remove` stops the daemon, so its files are free to delete,
; and deletes the task. nsExec runs it without a console window and logs its output; a missing exe or a failure is
; logged and the uninstall goes on.
;
; Open, before E-M1's Windows installer ships: an upgrade runs the old uninstaller with --updated, which skips this and
; so leaves the old daemon running, its exe locked while the new files are written. Stopping it there must not turn
; login start off (`disable` is the user's choice and stays), so it needs a stop without a disable from lane C.

!macro customUnInstall
  ${ifNot} ${isUpdated}
    nsExec::ExecToLog '"$INSTDIR\resources\daemon\clover-core.exe" autostart remove'
    Pop $0
  ${endIf}
!macroend

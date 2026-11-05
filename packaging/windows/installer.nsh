; Clover's additions to the NSIS installer electron-builder makes (electron-builder.yml, nsis.include). The Windows
; installer itself comes with E-M1's app; until then this file is checked by packaging.test.ts but not built.
;
; Login start is the daemon's (lane C: clover-core autostart, a Task Scheduler task running clover-core supervise).
; The app turns it on at its first launch (spec §3.1); the uninstaller turns it off through the same command, never
; through schtasks, and only on a real uninstall: an upgrade runs the old uninstaller with --updated, and keeps it.

!macro customUnInstall
  ${ifNot} ${isUpdated}
    ExecWait '"$INSTDIR\resources\clover-core.exe" autostart disable'
  ${endIf}
!macroend

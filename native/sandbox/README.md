# Clover native sandbox spike

`windows-probe.cs` is a C#/.NET Framework P/Invoke compatibility experiment, loaded by
PowerShell `Add-Type`. It is not wired into Winter, Clover, or the read-only SDK clone.

One command, on the disposable Windows VM from a checkout with the S2 prerequisites:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File spikes/s2-windows-fence/check.ps1
```

Prototype API: `AppSid(name)` creates a unique profile; `Run(mode, absoluteExecutable,
windowsCommandLineArguments, cwd, appName)` returns exit/timeout and launch/elapsed
milliseconds; `RemoveApp(name)` removes that profile. Native errors throw a Win32 exception.
No password, credential or model is accepted. `Run` waits at most 20 seconds for its direct
child. It does not terminate descendant trees and is suitable only for the fixed fixtures.

Measured launch return medians were 2–5 ms (seven samples per posture), excluding C#
compilation and profile/ACL provisioning. These are not production per-launch cost figures.

Before a daemon API exists, replace the raw command-line interface with a versioned,
bounded argv/policy request, create children suspended, enroll them in a kill-on-close job,
whitelist inherited handles, apply canonical path grants and the persistent floor, validate
the effective token, then resume. Every failure must launch nothing. A dedicated native
broker should own this sequence; no shell script may be a security boundary.

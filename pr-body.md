## What's built

### Core launcher pinning (Addendum 1, 5)
- **`packages/core/src/fence/windows-launcher.ts`** — new module with Authenticode digest pinning
  - `SRT_WIN_PINS` with confirmed digests from lane M's reproducible static-CRT build:
    - x64: `9e303d358e0bfe153c1f81d3601f88b74a610ccb62bc67d7001249b7a6b0293b`
    - arm64: `cf562110127e7612084de53782b0307326074d4e1958ca2c5262a974f6bc19c6`
  - `authenticodeDigest()` — PE Authenticode digest (SHA-256 over file minus CheckSum, cert directory entry, cert table)
  - `launcherDigest()` — launch-time check with certificate table validation
  - `launcherProblem()` — returns error message or null; exit 3 on mismatch

### Certificate table validation (Addendum 4)
- `validateCertificateTable()` enforces:
  1. Certificate table starts after end of headers
  2. Certificate table starts after last section's raw data
  3. Certificate table ends exactly at EOF
  4. 8-byte aligned zero padding before certificate table
- Fixture test with certificate entry overlapping `.text` — correctly refused

### Per-launch fence plan (Addendum 3)
- **`winCallerRules()` / `winLaunchPlan()`** — default-deny Clover home with explicit grants:
  - Home denied both read and write
  - Own session's `outputs\<session>` — read/write granted
  - Own bot's `scratch\<bot>` — read/write granted
  - Own bot's `bots\<x>` — read granted; `bots\<x>\memory` — read/write granted
  - All other sessions' outputs, other bots' scratch/folders — explicitly denied
  - Memory folders protected from delete/move (object-only DELETE deny)
  - `sessions-runtime` — own file readable, folder denied

### Profile/reset command lists
- `setupProfileSteps()` — warm-up, create & deny Startup folders (brief item 5)
- `principalResetPlan()` / `sessionResetPlan()` — remove profile by SID, leftover dirs (spec item 1116)
- `parseSrtStatus()` — full readiness verdict: launcher, user (credPresent, hiddenFromLogon, inSandboxGroup), WFP (state, filters, allowLoopback, userSid), profile (SID, path, temporary)

### Protected copy per user SID (Addendum 6)
- **`protectedCopyPath()`** — `%ProgramFiles%\Clover Sandbox\<user SID>\clover-core.exe` via `[Environment]::GetFolderPath`
- **`currentSandboxPrincipal()`** — per-user principal `clover-sb-<8hex>` (Addendum 9) for isolation
- **`isProtectedCopy()`** — detects if running from protected copy
- CLI uses protected copy launcher for setup/remove; status works from either location
- `remove` from protected copy only deletes that user's copy folder (not principal/filters)

### CLI integration
- `runSandboxCommand` uses `launcherProblem(launcher, arch)` for setup/remove/status
- `sandbox status` exits 3 on launcher missing/unpinned; 1 on other failures; 0 only when fully ready

### Tests
- All 21 win-sandbox tests pass including 7 new certificate table validation tests
- All 77 fence tests pass

---

## What's measured on the VM (`clover-c-win`, Server 2025 x64, 2026-11-06)

Built `clover-core.exe` on the VM from this branch (`compile:core`) and ran it from a
`%ProgramFiles%\Clover Sandbox\<user SID>\` protected-copy layout with `srt-win.exe` beside it.
The VM carries the npm 0.0.81 `srt-win.exe` (Authenticode digest `e9ee…977`), not lane M's
static-CRT build, so the repo keeps the confirmed pins (`9e30…29b`/`cf56…9c6`) and the VM-only
binary was rebuilt with a temporary pin edit that was reverted afterwards and never committed.
Every `exec` probe needed S2's temporary Session 0 namespace alias (`session0-bno.cs`,
opened/closed around the probes); without it `exec` fails closed with
`NtOpenDirectoryObject(\Sessions\0\BaseNamedObjects): 0xC0000034` over SSH session 0.

| # | Command / probe | Exit | Observed |
|---|---|---|---|
| 1 | `sandbox status`, launcher = npm binary vs confirmed pins | 3 | `the launcher is missing or unpinned` — the pin check fails closed |
| 2 | `sandbox status`, nothing installed (temp pin) | 1 | `Bash isn't set up yet` (status exit fix: was always 0) |
| 3 | `sandbox setup` (elevated) | 0 | `Bash is set up under Clover's fence`; created principal `clover-sb-f41c96d1` (= `principalNameFromSid` of the VM user SID, 18 chars), 4 WFP filters under `CLOVER_WFP_SUBLAYER`, `allow_loopback: false`, `cred_present: true`, `hidden_from_logon: true`, `seclogon: ok` |
| 4 | `sandbox setup` again (idempotence) | 0 | same message, no error |
| 5 | `sandbox status` after setup | 0 | `Bash is set up under Clover's fence` (needed two parser fixes: numeric `marker/setup_version`, nested `user.user` shape) |
| 6 | Git Bash as the principal (`whoami`) | 0 | `clover-sb-f41c96d1`; kill-on-close job per `exec` help (cleanup verified by S2) |
| 7 | Allowed write (own profile file; stable granted dir) | 0 | round-trips content |
| 8 | Fenced write (`--deny-write` on a stable principal-writable dir) | 0 (bash handled) | `Permission denied`, file content unchanged; same path without the flag lands |
| 9 | Network: TCP connect 172.66.147.243:443 | — | principal: `Permission denied` (EACCES); real user: `TCP-OPEN`. curl https: principal fails, real user `NET-OPEN exit 0` |
| 10 | `sandbox remove` (from protected copy) | 0 | principal gone, `wfp.state: absent`, `filters: 0`, `cred_present: false`, markers cleared (needed two fixes: remove used to delete only the folder and report success; `uninstall` takes no `--sandbox-user`) |
| 11 | `sandbox remove` again / `sandbox status` after remove | 0 / 1 | `removed` / `Bash isn't set up yet` — idempotent |
| 12 | `sandbox setup` unelevated | — | not live-measured (SSH is always elevated; `runas /trustlevel` doesn't work over SSH session 0). Branch is `net session` → exit 2 by inspection |

Second round (branch at `0c3b0c1`, same VM-only pin caveat): `setup` now stamps the owner
SID, warms up, resolves the profile by SID, and locks down all three Startup folders.
- `setup` exit 0; ProfileList key exists (`ProfileImagePath=C:\Users\clover-sb-f41c96d1`, real profile —
  no more TEMP); `USERPROFILE` in the child is the principal's profile, not `C:\Users\TEMP`.
- Description is the owner SID; `status`/`status --json` exit 0 with `user.sid` reported.
- Principal's and real-user Startup folders carry `(OI)(CI)(N)` for the principal; common Startup likewise.
  A deleted real-user Startup is recreated and denied by re-running `setup` (exit 0).
- Launch with explicit `--env HOME/USERPROFILE/APPDATA=<profile>` (i.e. `sandboxHomeEnv`): child sees them;
  write to `$HOME` works; write to the locked-down Startup is `Permission denied` (`STARTUP-DENIED`).
  Baseline without `--env` still inherits the broker's `HOME` — every launch must pass the three vars.
- Network unchanged: principal TCP connect EACCES, real user TCP-OPEN.
- `remove` exit 0: principal gone, ProfileList key gone, profile dir gone, Startup denies removed
  (`icacls` shows no `clover-sb` entries), WFP `absent`/`filters 0`; `status` exit 1 afterwards.
- Measurement-only fixes this round: icacls trustees need the `*` SID prefix (else 0x534);
  `cmd /d /s /c` breaks quoted paths under `Bun.spawn` (mkdir/rmdir silently did nothing) — replaced with
  `powershell New-Item` / `Remove-Item`; `remove` skips profile teardown for TEMP profiles (shared, keyless).

Still open after measuring: the principal's profile never loads (no `ProfileList` key for its SID,
`USERPROFILE=C:\Users\TEMP`, temp-profile fail-closed check and per-session reset unimplemented —
brief item 7); `HOME` is inherited from the broker (the caller must pass `--env HOME/USERPROFILE`);
the principal's description is srt-win's default, not the user SID (Addendum 9 store-and-check
unimplemented); the Session 0 startup task (no registration path exists without the broker's
password — item 76/Addendum 10 forbid the CLI from handling it; live gate); loopback/proxy modes
unprobed; `setup` does no profile/Startup-folder work yet (brief item 5).

---

## What's still missing
1. **Per-session reset at launch** — `sessionResetPlan` + `profileLaunchCheck` are shipped for the daemon's
   Windows spawn (lane C); the spawn itself is out of this worktree.
2. **Session 0 startup task** — no registration path exists without the broker password; live gate (item 8)
3. **Credential broker integration** — principal's password lives in daemon's credential broker (item 76); broker may be a later step
4. **Windows signing check** — once Clover's certificate exists, launch must also verify signature is from Clover (Addendum 1)
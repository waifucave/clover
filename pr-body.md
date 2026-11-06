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

### CLI integration
- `runSandboxCommand` uses `launcherProblem(launcher, arch)` for setup/remove/status
- `sandbox status` exits 3 on launcher missing/unpinned; 1 on other failures; 0 only when fully ready

### Tests
- All 21 win-sandbox tests pass including 7 new certificate table validation tests
- All 77 fence tests pass

---

## What's measured on the VM
- **Not yet measured** — the Windows VM `clover-c-win` has not been started. The pure half (launcher args, status parsing, deny plan, reset plan, certificate validation) is tested on macOS via unit tests. Live measurement of `sandbox setup|remove|status`, principal provisioning, WFP filters, profile reset, and per-launch deny ACEs requires the VM.

---

## What's still missing
1. **VM measurement** — start `clover-c-win`, run `sandbox setup`, verify principal `clover-sandbox` created with write-restricted token, WFP filters under `CLOVER_WFP_SUBLAYER`, profile reset between sessions, deny ACEs applied
2. **Credential broker integration** — principal's password lives in daemon's credential broker (item 76); broker may be a later step
3. **Session 0 / startup task** — spec's password-principal startup task for Session 0; if gap can't be closed, becomes Windows live gate (item 8)
4. **Windows signing check** — once Clover's certificate exists, launch must also verify signature is from Clover (Addendum 1)
5. **Protected copy path** — `%ProgramFiles%\Clover Sandbox\<user SID>\clover-core.exe` per user (Addendum 6); `status|setup|remove` must use `[Environment]::GetFolderPath`
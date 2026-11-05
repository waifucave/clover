# C-M0: S2 Windows fence and S8 hiding secrets

Date: 2026-11-05. Lane C, `lane/c-m0`, spec revision 17; base `a481f7e14`.

**Status after the rerun: the out-of-root Startup write is closed; Windows is still not admitted for
release.** The write that sank the candidate landed in the sandbox principal's own profile: the
launcher lets the principal write there, and the old fixture prepared a different folder. With the
principal's profile resolved by SID and all three Startup folders denied, every Startup route is
refused against a positive unfenced control (`review-controls-v7.txt`), and the full suite passes
**32/32** ordinary checks, **7/7** approved escapes and job cleanup (`final-windows-candidate-v4.txt`).
One of the 32 is not a denial: `declared-limit-profile-write` passes when the principal's write to
its own profile lands, the limit recorded below. Every denial counts only as an access error, and
the Shell.Application check passes on the started child's own receipt. What still blocks admission:
every candidate run needs the Session 0 namespace alias diagnostic (the unmodified launch admits
zero commands); the principal's writable profile is accepted **for M0 only**, and the M1 floor
requires per-session isolation and a reset (controller's ruling, proposed edit 7); and Windows 11 is
a live gate. Nothing here establishes production readiness.

**Decided by the owner:** on Windows, Bash runs as the dedicated sandbox principal. `gh`, git
credential helpers, Docker registry logins and ssh-agent signing reach it only through a Clover
credential broker that never hands over raw keys, as on Linux. Spec §9.1 changes; the controller
edits the spec. What the broker must cover and what it costs are in S2.3–4.

The controller ruled that generated test keys in disposable stores are authorized, and that §8.5's
unattended fallback remains: user-scoped systemd sealing with TPM where available, otherwise an
owner-only plaintext key file, labelled plaintext and hidden by the fence. **Locked persistence is a
rejected alternative:** cloud computers can be main/refresher computers and must work unattended
after reboot; requiring a person to unlock them would break that requirement. No spec or shared
contract was edited. Network, semantic D-Bus, caller-check and backend edits below remain proposals
for the controller after review.

## Method and evidence

The two spike READMEs give one command per check. Evidence is in their `results/` directories.
`final-*` results supersede intermediate `resumed-*` fixture failures; the interrupted v2 Windows
candidate file contains only an upload line and is not a measurement. Windows line endings/NUL
padding and personal temporary paths are normalized; the normaliser keeps the sandbox principal's
profile, a temporary profile and the real user's home apart. The first Windows store artifact
explicitly records recovery from captured successful stdout after an older transport overwrote its
output file. No secret value, password or real account credential is included in any artifact.

| Platform | Actual environment | Scope limit |
| --- | --- | --- |
| Windows | Server 2025 build 26100, SSH session 0; Git 2.51.2.windows.1, Node 22.21.1, Bun 1.3.1; SRT 0.0.81 (srt-win 0.0.1); Codex 0.166.0 | Surrogate for Windows 11, not a desktop logon |
| Ubuntu | 26.04.1; kernel 7.0.0-1014-gcp; bwrap 0.11.1, xdg-dbus-proxy 0.1.7, systemd 259.9 | Cloud VM; vTPM present |
| Fedora | Fedora 45 container, proxy 0.1.9; bwrap package 0.13.1 | Ubuntu kernel; no Fedora SELinux host validation |
| Mac | macOS 26.6.1/25G76 arm64; Codex 0.166.0, SRT 0.0.81; Cursor 2026.10.22-27dcf5f | Below the spec's macOS 27 minimum |

All work stayed in lane-owned paths. Winter source/install/processes, the real Keychain and real
agent homes on this Mac were untouched. The SDK clone was read-only. No `claude` invocation,
agent prompt, model call, account login, GUI, app bundle, signing identity or sub-agent was used.
VM password authentication used generated local test users only, with passwords held in memory.
Cloud operations were limited to starting/stopping/SSH into the two named VMs. After a network
outage on 2026-11-05, direct SSH to both VMs stayed closed from this network while IAP TCP
forwarding worked, so the rerun used the same SSH sessions through IAP (`CLOVER_SPIKE_IAP=1` in
`remote.py`). Both VMs were stopped after testing. `rerun-windows-cleanup.txt` records the
srt-win and Codex sandbox uninstalls (which remove the principal, WFP filters and grants) exiting 0,
and no remaining sandbox profile folder or lane test user; the script also deletes the test
packages. Installed Git/Node/Bun and Linux package prerequisites remain on the stopped VMs.

Results written by an interrupted session before the rerun's fixes (a Startup probe, candidate v2
and controls v5) were dropped: their normalisation merged the principal's profile with the
administrator's home, so they could not show which folder was tested.

## Winter baseline

Read-only references: `docs/claude/tool-surface.md`, `runtime-sdk/mode-options.ts` and `home-fence.ts`;
in the SDK, `sandbox/profile.ts`, `spawn.ts`, `host-child-floor.ts` and `sdk/src/mandatory-floor.ts`.
`selfGrantDenyWrite` supplies self-grant write protection; child configuration adds project/glob rules.
Clover deliberately permits home/temp writes and installed plugin/routine writes, so copying Winter's
arrays unchanged would be wrong. Reads are generally open except protected control/credential state.
`resolveNetworkPosture` denies network for every supported configuration and rejects domain lists.
Approved escapes retain a native read/write/link/ancestor floor; command-text matching alone is not it.

## S2.1 — Bash, PowerShell and token compatibility

**Verdict: works with limits; simple original-user strong-token configurations do not work.**
The original C# P/Invoke probe measured seven checks per posture: PowerShell pipeline, Bash
pipeline/subshell/substitution, git, SSH version, Node, Bun and a minimal Bun build. The last five
were invoked through Bash, so Bash startup failures do not independently establish tool failures.

| Original-user posture | Passing / 7 | Native launch-return median |
| --- | --- | --- |
| Privileges stripped, no restricting SIDs | 7 | 5 ms |
| Same, low integrity | 5 | 2 ms |
| Write-restricting SID | 0 | 2 ms |
| Write-restricting SID + low integrity | 0 | 2 ms |
| AppContainer, no capabilities | 0 | 2 ms |

The privilege-only posture is a compatibility control, **not a filesystem fence**. Low integrity
failed git/build writes and is not an arbitrary read/write policy. Strong-token failures include
PowerShell CLR startup, MSYS token-default-DACL and BaseNamedObjects access, and AppContainer
initialization `0xC0000142`. Removing hidden-console flags was necessary to reach user code under
SSH; earlier DLL-initialization failures with those flags were fixture failures.

Controlled diagnostics compared three direct executables under four postures: privilege-only 3/3;
restricted, token/default-DACL-repaired restricted, and private-desktop/repaired restricted each 1/3
(direct Node works; PowerShell and Bash fail). Repairing token DACLs or adding a private desktop
alone did not resolve MSYS's named-object denial. See `resumed-diagnostics.txt`.

## S2.2 — One complete Windows candidate and every requested route

**Verdict: passes the tested routes with limits; not admitted for release.** Useful commands run
only in the alias-assisted configuration. The candidate uses the pinned upstream SRT native Rust
launcher: dedicated unprivileged principal, write-restricted token, explicit ACL grants/denies, WFP
keyed to that principal, private desktop, handle whitelist, process mitigations and kill-on-close
jobs. Four WFP filters were installed. No broad user-profile read grant was applied. Microsoft's
VC++ runtime was a missing dependency.

It initially failed closed on a pre-existing hardlink to a denied file, and then failed under SSH
because it expected `\Sessions\0\BaseNamedObjects`, whereas this environment uses the global
namespace. The diagnostic `session0-bno.cs` holds a temporary object-manager alias to the real
namespace; handles close afterwards. **This alias is not a production solution.** A production
launcher must resolve Session 0 correctly without modifying the namespace. With that diagnostic,
`final-windows-candidate-v4.txt` contains 32 ordinary checks, all passing, seven approved-escape
checks (7/7) and job cleanup. Every denial counts only as an access error (EPERM/EACCES): a missing
path or any other failure is not evidence. One check is not a denial: `declared-limit-profile-write`
passes when the write to the principal's own profile lands, and its result is tagged
`declared-limit`. The Shell.Application check passes only on the started child's own receipt
(non-admin, protected read refused); it replaced the historical `com-outofproc` assertion, which
always failed. The first rerun (`final-windows-candidate-v3.txt`) counted any exception as a
denial and still carried that assertion.

| Requirement / route | Observed result |
| --- | --- |
| Allowed/ordinary reads, allowed writes, denied settings/outside writes | Passed scoped fixture checks |
| Run folder, encrypted secrets, plaintext key | Host contents unreadable |
| Junction, hardlink creation/read, case/dot path aliases | Denied; pre-existing hardlink configuration also failed closed |
| Ancestor replacement | Rename denied |
| PowerShell, Bash pipeline/subshell, git, SSH version, Node, Bun, bundle | Passed; no authenticated SSH/git or full project build claimed |
| Task Scheduler executable and COM registration | Both attempts rejected |
| Services / Service Control Manager | Service creation rejected |
| WMI process creation | Attempt rejected |
| In-process WScript COM creating a child | Child retained protected-read denial; process creation itself is not an escape |
| Shell.Application | The started child's receipt: non-admin, protected read refused |
| runas / saved-credential attempt | Both fenced and unfenced attempts fail; no attributable fence denial |
| Startup folders: the principal's own, the real user's, all users' | All three refused (EPERM), each with a positive unfenced control |
| The principal's own profile | Writable by construction; recorded M0-only limit, checked in every run (below) |
| Job cleanup | Detached delayed child did not write its marker after parent exit |
| Direct local listener and metadata TCP | Both denied, ordinary and approved-escape sessions |

Approved escape experiments create a separate session with an additional write root, keeping the
same protected denies and WFP identity. Its extra allowed write succeeded; settings/run/secret/key
protection and both network denials held. They are deliberately network-closed escapes; this does
not implement arbitrary approved network access. Per-command write-root overrides are unsupported
by this vendor API and were not silently dropped.

In the final run, ordinary end-to-end checks took 665–3062 ms, median 704 ms; approved-escape
checks 660–708 ms, median 670 ms (earlier runs: medians 706–740 ms and 634–701 ms). These include PowerShell,
Node worker and native broker execution. The earlier 2–5 ms launch-return figures exclude
provisioning/compilation and are not comparable production costs. The Session 0 dependency,
full-home policy, concurrency/crash recovery and Windows 11 remain gaps. No claim is made that
every COM server or token-impersonation technique is closed.

### The out-of-root Startup write: cause and fix

**Cause.** The launcher's `exec --write-restricted-token` builds the child token with the
restricting SIDs `[sandbox user, Everyone, RESTRICTED]`, "so write access held by
`BUILTIN\Users` / `Authenticated Users` no longer reaches the child" (its own help text). Access
granted to the sandbox user itself still reaches it, and Windows gives every user full control of
its own profile. A leftover `C:\Users\clover-spike-sandbox` folder, made by an earlier fixture,
had moved the principal's profile to `clover-spike-sandbox.<COMPUTERNAME>`. The v4 fixture prepared
the leftover folder; the fenced write landed in the real profile.

`startup-probe.mjs` (`final-startup-probe.txt`) resolves the profile by SID and tries the same
create-and-delete in each place. The administrator's unfenced control succeeds everywhere.

| Fenced write to | Baseline (work only) | Deny the three Startup folders | Deny the whole profile |
| --- | --- | --- | --- |
| Allowed `work` | allowed | allowed | allowed |
| The principal's Startup folder | **allowed** | EPERM | EPERM |
| The principal's profile root, Roaming, Temp | **allowed** | **allowed** | EPERM |
| Real user's and common Startup, leftover folder, outside fixture | EPERM | EPERM | EPERM |
| Node, Bash and PowerShell start | yes | yes | yes, on a temporary profile |

A deny on the whole profile is not usable: Windows loaded a temporary profile (`C:\Users\TEMP`) and
changed the principal's ProfileList entry, which breaks the principal for later sessions (it was
re-provisioned afterwards).

**Fix**, in `candidate.mjs`, `review-routes.mjs`, `provision-candidate.ps1` and the cleanup:

1. Resolve the principal's profile by SID from ProfileList after its first launch, never from the
   account name, and stop if the fenced process runs on a temporary profile.
2. A fresh profile made by this non-interactive logon has no Startup folder, and a deny cannot be
   stamped on a missing path. Provisioning (elevated; the administrator in the harness) creates it
   first. Without that step the first rerun's `startup-user` check was not refused.
3. Deny the principal's, the real user's and the common Startup folders. Only EPERM/EACCES count
   as denials; a missing folder is a fixture error, never evidence.
4. Provisioning and cleanup remove an earlier principal's profile by SID and any leftover folder,
   so the redirect does not recur.

The rerun refuses all three Startup writes with EPERM in the suite and in the paired controls.

**Limit, accepted for M0 only (the controller's ruling).** The principal's own profile stays
writable: it is the principal's, never the user's, and holds no Clover or user data.
`declared-limit-profile-write` records in every run that the write lands. Logon-start entries
inside it, its Startup folder and its own registry hive (the hive was not measured), take effect
only when the principal's desktop shell starts, which the launcher never does: children run on a
non-interactive desktop, the account is hidden from logon, and its password is readable only by the
broker (the vendor's state database denies the sandbox group). In M1 the Windows candidate does
not meet the floor until nothing a command writes can carry over to any other command or session
(M1 entry item 2, proposed edit 7).

### Review controls and actual administrator context

`spikes/s2-windows-fence/results/review-controls-v7.txt` is the final paired run; v6 had the same
outcomes before the controls stopped on a temporary profile, v4 found the Startup write, and v1–v3
are earlier fixtures. The real launching user is explicitly verified as an
enabled local administrator. The fenced handle-probe process is explicitly non-admin and
`IsTokenRestricted=true`, while its unfenced control is admin/unrestricted. Therefore these results
include the common case where Clover's real user is an administrator; they do not depend on
treating an admin user's unrestricted token as a safe fence.

Every broker/Startup denial has the same-operation unfenced control:

| Route | Unfenced administrator | Fenced principal | Attribution |
| --- | --- | --- | --- |
| schtasks registration | Succeeds | Rejected | Principal/token policy contributes; not a command-name filter |
| Scheduler COM registration | Succeeds | Rejected | Positive control |
| Service creation | Succeeds | Rejected | Unprivileged principal is an intentional boundary |
| WMI process creation | Return 0, child marker observed | Rejected, no marker | Positive execution control |
| runas /savecred | Fails without a saved-credential fixture | Fails | **Not attributable**; excluded from closure claims |
| The principal's Startup folder (resolved by SID) | Succeeds | Rejected, EPERM | Positive control; deny on the folder provisioning created |
| The real user's Startup folder | Succeeds | Rejected, EPERM | Positive control |
| Common Startup folder | Succeeds | Rejected, EPERM | Positive control |
| Local listener and metadata TCP | Connect | Rejected | Positive network controls; no metadata HTTP request/credential read |

Nothing is granted inside the principal's profile by the administrator; the only fixture step there
is the Startup folder that provisioning creates. A Startup denial proves a refused write, not an
observed logon-time execution.

`Shell.Application.ShellExecute` is observable: both controls create a child receipt with PID,
parent PID, administrator status and actual protected-canary read outcome. The unfenced child is
admin and reads the public canary; the fenced child is non-admin and cannot read it. The fenced
delayed receipt is absent after its parent ends, including the floor-release follow-up whose initial
receipt was observed. This is child/floor evidence, not an inference from method return status.
For an actual out-of-process activation test, the native helper also forces `CLSCTX_LOCAL_SERVER`
for the same class: **both** contexts return `0x80040154` (class not registered for that context),
so that route is unavailable here and is not counted as a blocked out-of-process COM server. The
historical `com-outofproc` name did not prove that its default activation was out of process.

Handle propagation/duplication is tested at the OS boundary, not just through Node's spawn defaults.
A trusted .NET holder opens an inheritable public-canary file and an inheritable handle to itself,
then calls CreateProcess with `bInheritHandles=true` into the first native broker hop. Controls:

| Probe in final child | Unfenced | Fenced |
| --- | --- | --- |
| Read the deliberately inheritable canary handle | true | false |
| Duplicate via deliberately inheritable parent-process handle | true | false (invalid handle, error 6) |
| Open parent with PROCESS_DUP_HANDLE and duplicate canary | true | false (access denied, error 5) |

All controls run while the holder and its source handles remain alive. Existing rights on a leaked
handle would bypass pathname denial; matching the exact public canary prevents an unrelated reused
handle value from being mistaken for a leak. These cases passed with the real user a local admin.
This does not assert closure of every process/token/COM technique; it resolves the previously untested
inherited/duplication cases with positive controls and reports the actual remaining outcomes.

## S2.3–4 — Helper, design and M1 entry

### Decided: Windows Bash runs as the sandbox principal; credentials go through a broker

The only tested posture that both fenced writes and ran Bash uses a different principal, which
cannot use the real user's DPAPI, Credential Manager or Windows OpenSSH agent; original-user
strong-token configurations failed Bash startup. Spec §9.1 had said Windows Bash runs as the user
with the OS store open to `gh`, Docker and git. The owner has decided for the sandbox principal
with a credential broker. Text for §9.1, for the controller to apply:

> On Windows, model-run Bash and PowerShell execute as a dedicated sandbox principal under the
> persistent floor. They do not inherit the user's DPAPI, Credential Manager or ssh-agent access.
> `gh`, git credential helpers, Docker registry logins and ssh-agent signing reach them only through
> a Clover credential broker acting in the user's logon context, as on Linux; it never hands over raw
> keys or stores. Clover's own secrets, approval tokens and device keys are never served to model
> commands. The broker admits only the credential operation allowed for that session, destination
> and identity.

**What the broker must cover** (M1). Windows has no IPC point like Linux's Secret Service where one
semantic filter covers every tool, so each tool gets an adapter:

| Tool | How it reaches the broker | What stays closed |
| --- | --- | --- |
| git | `credential.helper` set to a Clover helper: `get`, and `store`/`erase` only after approval, keyed by protocol, host, path and user | Git Credential Manager over the user's Credential Manager |
| Docker | the registry credential-helper protocol (`get`/`list`) through a Clover `docker-credential-*` helper | the Docker engine pipe, which can start host containers |
| gh | its token for the approved host and account, released for that command only (gh reads it from its environment; on Linux it is a Secret Service lookup) | the user's Credential Manager and gh's stored hosts |
| ssh | an agent endpoint served by the broker: identity listing and signing for allowed keys, with session and destination constraints where supported | private-key export, blanket forwarding, the user's own agent pipe |

A released token is visible to that command's processes, as on Linux; keys never leave the broker.
Git for Windows' MSYS ssh reaches an agent through a loopback socket emulation that the fence's WFP
filters close, so M1 either points git at Windows OpenSSH (`core.sshCommand`) with the broker's
agent pipe, or adds a sanctioned loopback endpoint. Requests must not become arbitrary host command
execution. The user's own stores, agent pipe and engine pipe must stay unreachable: the measured
mechanism is that a pipe whose access list does not name the sandbox user refuses the fence
(below); M1 checks the real pipes' access lists.

**Cost.** Runtime, measured:

| Hop | Through the broker | Direct | Evidence |
| --- | --- | --- | --- |
| Windows: fenced command to a user-context named pipe, one request | 1.31 ms median, p95 4.95 ms (25/25) | 1.43 ms unfenced | `final-broker-hop.txt` |
| Windows: same endpoint without the sandbox user in its access list | refused, EPERM | owner connects | `final-broker-hop.txt` |
| Linux prototype: filtered search / get-secret, in process | 4.25 / 4.63 ms | 0.69 / 0.67 ms | `final-broker-latency.txt` |
| Linux prototype: whole `secret-tool lookup` | 31.97 ms | 19.16 ms | `final-broker-latency.txt` |

The fence adds nothing measurable to the Windows hop; the OS store operation in the user's context
comes on top (DPAPI and Credential Manager roundtrips passed under a real password logon but were
not timed). The Python Linux broker adds about 4 ms per call and 13 ms per tool lookup; a native
broker should do better. All of these are small next to starting a fenced command (about 0.7 s
median end to end). Engineering, for M1–M2: the broker in the daemon's user context; the four
adapters; policy per session, destination and identity with approval cards; secret-safe audit;
rotation and recovery when the user's store changes; the logon lifecycle (DPAPI and Credential
Manager need the user's real logon: SSH/network logons fail with `0x80070005`/1312); packaging with
a static CRT; and tracking the tools' helper protocols. The ssh agent is the largest piece. The
current external-credential fixtures do not prove these Windows integrations.

Rejected alternatives: original-user AppContainer/restricted-token execution (no working
write-fenced Bash), WSL2 or a VM (still needs credential forwarding and changes process and file
semantics), and unfenced original-user commands, which abandon the floor. Copying user tokens or raw
stores would defeat the separation.

**M1 entry:**

1. The broker contract and the four adapters, with the user's stores, agent pipe and engine pipe
   verified closed to the principal.
2. **Nothing carries over** (the controller's M1 floor for Windows). Nothing a command writes may
   carry over to any other command or session, concurrent sessions included:
   - a sandbox principal per running session, or running sessions one at a time;
   - the principal's profile **and its registry hive** reset for each session, with the reset
     measured on every launch and failing closed, as `candidate.mjs` already does for a temporary
     profile;
   - the vendor's persistent grants and any temp folder per session, with HOME and TEMP in the
     session's own temp, as part of the floor.

   Fencing a list of auto-run paths (shell startup files including Git Bash's, PowerShell
   profiles, the Startup folders, Run/RunOnce and other autorun keys, scheduled tasks) is only an
   interim measure; the reset is the M1 exit condition. Until then, provisioning creates the
   principal's Startup folder and the fence denies all three Startup folders, resolved by SID.
3. Session 0 resolved without modifying the namespace.
4. A real **per-command escape API**: the experiment resets/reinitializes an entire vendor session
   to widen roots, not one `dangerouslyDisableSandbox` call. M1 must retain an immutable floor,
   isolate per-launch grants from concurrent ordinary commands, and cover cleanup/crash recovery.
   Session-wide reconfiguration must not ship as a per-command escape.
5. The full fenced-set enumeration below.

### Fenced-set coverage against the concrete source list

The candidate's blanket deny on synthetic `control` covers only `settings.json`, `run/token`,
`secrets.enc` and `plaintext.key`. It does not test registrations for omitted real paths. Against
`selfGrantDenyWrite` (`mode-options.ts:925`) and the additions made by `sandboxConfigFor`:

| Source/spec group | Measured coverage and missing enumeration |
| --- | --- |
| `run`, `runtimes`, `cache` | Synthetic run only; runtimes/cache not individually exercised |
| `plugins` | Not exercised; reconcile with Clover's intentionally writable installed plugin folders |
| `permissions`, `trust.json` | Saved-rule/connector permission/trust registrations not exercised |
| `agents`, `sdk/agents`, `sdk/plugins` | Not exercised; distinguish authority/config from writable installed plugins |
| `sdk/settings.json`, `sdk/.winter.json` | Synthetic settings only, not these concrete paths |
| `computer-use` | Not exercised; legacy entry must be reconciled with opensky scope |
| `permissions.local.json`, `settings.json`, `settings.local.json` | Only synthetic settings.json exercised |
| Active `hostStorageWriteRoots`: participating homes' cowork/runtimes/run and coordination directories | Not exercised; retained-storage/registration/alias cases remain separate |
| Additional protected-home, project and any-depth child rules | Not exercised; these are additional to selfGrantDenyWrite |
| Clover levels, device list, bots' user layers, development folders, plugin data | Not exercised as concrete paths |

M1/M2 must derive the complete canonical list from the approved Clover contract, map every source/
spec row to file/directory/glob fixtures, and test normal/per-command-escape reads, writes, links and
ancestor replacement across OSes. **Full Mac-fence parity is not established by this representative set.**

`native/sandbox/windows-probe.cs` is the C# diagnostic; `session0-bno.cs` is its temporary namespace
control. `AppSid`, `Run` and `RemoveApp` are documented in the native README. Neither is an admitted
launcher. `candidate.mjs` exercises the pinned upstream native account/WFP/token/job implementation.

Recommend the dedicated-principal/restricted-token/WFP design for further engineering, preserving
an independent mandatory floor for escapes. A small native broker should accept versioned bounded
argv/policy requests, canonicalize paths, create suspended, apply explicit handles/token/job policy,
verify effective identity, then resume. Failure launches nothing. Reuse reviewed native primitives;
do not turn the PowerShell experiment into a daemon interface. Static CRT packaging avoids a surprise
VC runtime prerequisite. Principal identity must remain visible to caller checks even if a service
launches a process without `IsTokenRestricted`. M1 starts with these broker and `Fence`/`SecretStore`
contracts, the principal-profile change, Session 0 resolution and the remaining COM investigation,
not production adoption of this test shim. The SDK handoff remains coordinated with lane A.

## S8.1 — Stores, actual startup context and unattended fallback

**Verdict: works with limits.** Generated keys were kept in memory except authorized disposable
OS stores, encrypted files and the explicitly authorized plaintext fallback.

| Check | Result |
| --- | --- |
| Windows SSH key/network logon | DPAPI failed `0x80070005`; Credential Manager failed 1312 |
| Password LogonUser type 2 + loaded profile + impersonation | DPAPI and Credential Manager each 1/1 roundtrip |
| Actual password-principal scheduled-task startup | No started/result marker; result 267011 (not yet run), despite enabled/on-demand/timed/COM RunEx attempts |
| SYSTEM scheduled-task infrastructure control | Started, result 0; therefore password-principal result is not treated as a global scheduler outage |
| Ubuntu private real Secret Service | Key store/retrieve and AES-256-GCM file roundtrip passed; tamper rejected; 64 bytes became 92 bytes |
| TPM inventory | Device nodes and `systemd-analyze has-tpm2` output: `spikes/s8-secrets/results/review-tpm-inventory-v2.txt` |
| `systemd-creds --user`, host+tpm2 / auto | Roundtrip passed; format `ef4ac13679a9480ea7db68897f9f165d` identifies UID-scoped host-plus-TPM wrapping |
| Pure tpm2 with `--user` | Rejected as unavailable in UID-scoped mode; use the combined mechanism |
| System-scope TPM control | Real TPM encryption/decryption passed; nonexistent-device control failed |
| No-TPM private namespace control | UID 0 user scope; TPM devices/sysfs and host credential IPC hidden; roundtrip passed with host-scoped format `55b9ed1d38594d43a8319d2ebb332ac6` |
| Plaintext fallback | Owner-only `0600`, encrypted-file roundtrip passed; explicit `plaintext` label |
| Fence | Masked all six generated store files in the TPM-present test, and the sealed file in the no-TPM control |

The real VM has a vTPM. Absence is simulated by a private namespace, not by changing the VM or
claiming a second physical host. An earlier bad-device argument to user-mode encryption did not
simulate absence: the credential IPC service selected its own device and still produced TPM format.
The format identifiers are public algorithm identifiers, confirmed against
[systemd v259's header](https://github.com/systemd/systemd/blob/v259/src/shared/creds-util.h).
The no-TPM control uses root's user scope to avoid delegating back to the host credential service;
ordinary-user behaviour on a truly TPM-less host is an **explicit live gate**, including unattended
reboot, host-scoped sealing/decryption and fence hiding at that UID. The non-root plaintext
fallback and mask check are independently exercised. No global user-namespace sysctl was relaxed.

The keyring fixture used a private bus and temporary home/config/data/runtime directories. Windows
local users/passwords/credential targets were generated and removed; no password entered a command
line or log. Password API success does not validate the actual daemon startup task. That startup
result remains a negative/unresolved deployment gate, not a DPAPI success inferred from another logon.
M1 must pin authenticated-encryption format/AAD, atomic writes, nonce/rotation/recovery and profile
lifecycle. This spike does not change the controller's fallback ruling.

## S8.2 — Linux mounts, semantic D-Bus broker and credential fixtures

**Verdict: works with limits.** The original Ubuntu filesystem/network/IPC fixture passed 12/12,
including ordinary read, allowed write, denied settings write, hidden run/secrets, denied ancestor
rename, hidden host bus, blocked systemd-run, blocked metadata TCP, pipelines, git and a C build.
The fixture is narrower than the final home/temp policy and does not prove every mount/alias race.

A plain xdg-dbus-proxy root-method allow list forwarded a protected item path in GetSecrets arguments;
this was reproduced inside bubblewrap and Fedora 45 userland. Header-path filtering cannot authorize
paths carried in method bodies. See the
[proxy policy grammar](https://github.com/flatpak/xdg-dbus-proxy/blob/main/xdg-dbus-proxy.xml).

The new read-only `secret-broker.py` separates backend and frontend private buses and exposes only
an xdg-filtered proxy socket inside bubblewrap. It authorizes item attributes, filters searches and
collection listings, validates all bulk items and returned keys, binds sessions to callers, and rejects
unknown/mutating APIs. The real-keyring harness passed **13/13** assertions: hidden search/listing,
direct and mixed bulk denial, three host broker destinations denied, gh/Docker/git lookup fixtures,
real `git credential fill`, and fenced Clover lookup denial. No real account or Docker daemon socket
was exposed. gh/Docker rows are local credential-lookup fixtures, not full vendor login conformance.
The rerun (`final-broker-latency.txt`) passed the same 13/13 and timed the broker (S2.3–4, Cost).

This broker intentionally admits only tagged external fixtures, not arbitrary real keyring items.
It is a semantic proof of concept, not a production Secret Service replacement: write/login/unlock
workflows, reconnect, concurrency, signals, policy ownership and recovery need implementation/review.
Raw host bus, systemd private sockets, portals, Docker and other execution brokers must stay hidden.
A Docker credential helper is not equivalent to the Docker daemon's host-execution socket.

Ubuntu SRT initially failed in nested-userns/seccomp setup. A copied trusted bwrap launcher with a
path-scoped AppArmor `userns` profile fixed startup; PID/network namespaces, fresh proc, seccomp and
host write protection remained. Linux read-deny masks can be writable private tmpfs views; host
unchanged assertions distinguish that from a host write. Fedora still requires a real SELinux host,
package, keyring and namespace check; the container proves userland protocol behaviour only.

## S8.3 — Agent-owned deny lists and no-model retry gates

**Verdict: mixed; protection must be admitted per exact backend/version/configuration.** All runs
used sandbox-only entry points and temporary homes. No `claude`, sign-in or agent/model turn ran.
Nested retry tests mean another subprocess under the same native floor, not a vendor approval turn.

| Backend | Mac | Ubuntu | Native Windows |
| --- | --- | --- | --- |
| Anthropic standalone SRT 0.0.81 | 9/9 deny/alias/link/config/nested-retry gates | 10/10, including nested-userns bypass attempt, after scoped AppArmor setup | Dedicated-principal candidate above; this is not Claude Code integration |
| Codex 0.166.0 | 9/9 | 10/10 | Unelevated refused restricted reads; elevated runner pipe timed out, also with namespace diagnostic; 0/6 admitted commands |
| Cursor CLI 2026.10.22-27dcf5f | Allowed write passed; tested outside-root read/write denies and retry failed; hidden host write observed | Fail-closed unsupported-backend preflight | Fail-closed: helper reports network proxy only, no filesystem isolation; 0/3 commands |
| Claude Code itself | Seatbelt plus file-tool rules documented; standalone runtime tested | bubblewrap plus file-tool rules documented | Official docs say unsandboxed; explicit unsupported-backend OK remains required |
| Devin | CLI help exposes sandbox setup only, no sandbox-only command execution | Docs describe bwrap/seccomp | Docs say unsupported; no model/login test |
| Antigravity CLI | Help exposes sandbox session flag, no sandbox-only executor | Namespace-based sandbox documented | AppContainer/PSE and patch prerequisites documented; no model/login test |

The tested Cursor standalone configuration is not a proof that every possible Cursor policy fails.
Its output retained system read boundary; absolute blocked patterns/tool deny rules did not provide
this floor. It must not be marked protected on that evidence. Codex Windows refusals/timeouts are
startup failures, not demonstrations that hidden reads were denied after command launch.

Sources: [Claude scope/settings](https://code.claude.com/docs/en/sandboxing),
[Codex permission implementation](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/permissions.rs),
[Devin sandbox](https://docs.devin.ai/cli/sandbox),
[Cursor sandbox configuration](https://cursor.com/docs/reference/sandbox),
[Cursor CLI installation](https://cursor.com/docs/cli/installation),
[Antigravity terminal sandbox](https://antigravity.google/docs/sandbox/?tab=cli).
Recorded CLI help establishes available local entry points; docs establish the untested OS mechanisms.
In-process Read/Edit tools, ACP adapters, precedence, vendor retry/exclusion approvals and authentication
remain live gates. Use explicit asking modes, not a vendor classifier silently approving an unfenced retry.
Keep the owner-decided own-sandbox/no-outer-wrapper rule and unsupported-backend OK.

## Proposed spec edits — controller applies after review

1. **[P], §4/§9.1:** explicitly state ordinary Bash/PowerShell network denial on every OS, and the
   mandatory protected-path floor for approved escapes. Define metadata denial for escapes too;
   a path-only Mac floor does not itself implement an IP rule.
2. **[P], §4/S8:** require semantic Secret Service item authorization in request bodies/results,
   not merely a bus-name/interface/header-path allow list. Host execution endpoints remain hidden.
3. **[P], §3.1:** check sandbox principal and trusted execution-generation provenance in addition
   to process ancestry/token flags, including processes launched through services or changed tokens.
4. **[P], §9.3:** mark a backend protected only after its exact configuration protects shell descendants
   and file tools, rejects policy widening and preserves the floor on retries/exclusions. Unsupported
   combinations require the existing explicit OK. No outer sandbox is proposed over the [D] rule.
5. **Rejected alternative, §8.5:** locked persistence/in-memory-only unlock. Controller rejected it
   because unattended main/refresher/cloud computers must survive reboot. The existing fallback stays.
6. **[D], decided by the owner, §9.1:** Windows Bash and PowerShell run as the dedicated sandbox
   principal; `gh`, git credential helpers, Docker registry logins and ssh-agent signing reach them
   only through the Clover credential broker. The controller replaces §9.1's "the OS store itself
   stays open to tools such as `gh`, Docker and git" with the text in S2.3–4. The same edit
   changes §4's Windows Bash cell: "built on AppContainer or a restricted token" becomes "built on
   a dedicated sandbox principal with a write-restricted token, network filters keyed to that
   principal and a kill-on-close job; credentials go through the Clover broker (§9.1)".
7. **[P], §9.1, with the controller's ruling:** one rule for all three OSes.

   > **Nothing a command writes runs later on its own, or carries over.** Bash's writable home and
   > temp folders exclude the places the OS starts programs from at login or on a schedule; they
   > join the fenced set on every OS, escapes included: on macOS `~/Library/LaunchAgents`, login
   > items and shell startup files; on Linux `~/.config/systemd/user`, `~/.config/autostart` and
   > shell startup files; on Windows the Startup folders, the Run and RunOnce keys, PowerShell
   > profiles and Git Bash's startup files. A bot changes them only through a core tool and an
   > approval card. On Windows, where Bash runs as a sandbox principal, nothing the principal
   > writes carries over to another command or session: a principal per running session or one
   > session at a time; its profile and registry hive reset for each session, checked on every
   > launch and failing closed; its grants and temp folder per session.

   For M0 the principal's writable profile is accepted as a recorded limit only. Fencing listed
   auto-run paths stays an interim measure; the reset is the M1 exit condition.

No relaxation of the [D] Windows Bash release blocker is proposed. The Session 0, COM, startup-task
and protected-backend gaps go to the controller; this report does not silently route around them.

## M1, live gates and review

M1 starts with a reviewed native broker, stable floor and secret-store contracts, lifecycle/recovery,
correct Session 0 handling, caller identity and a production semantic credential policy. The failed
or unavailable backend combinations remain explicitly unsupported pending resolution. Broader home
write policy, concurrent sessions, crash cleanup and real credential-helper protocols need coverage.
The credential broker, the no-carry-over floor (a principal per running session or one session at
a time, profile and hive reset per session, per-session grants and temp), the per-command escape
API and full fenced-set enumeration are explicit M1 entry requirements, not features proved by the
spike counts. The
candidate's Startup failure is closed for the tested routes; it remains a test shim, not Windows
release admission.

Owner-batch gates: real Windows 11 install/Bash/island (§10.3), actual Ubuntu/Fedora deb/rpm/SELinux
and desktop keyrings (§10.4), macOS 27 integration (§10.5), authenticated ACP/file-tool/retry checks for
all five agents, and backed-up Winter migration (§10.11). Password-principal scheduled startup and
Codex Windows initialization need resolution before release, not an assumed pass from live gates.

Focused CI repeats mount/network/store/broker checks and Mac/Linux native deny/retry gates, plus
Windows launch measurements and the result-privacy check. Runner OSes are surrogates. Green means
those experiments ran, not that Windows security parity or every vendor integration passed. Its
status at the final head is linked from PR #148; broader repository CI is reported separately.
M0 is ready for the lane reviewer to assess these positive, negative and inconclusive results; only
the controller merges.

## Review disposition (review of da905d5d9)

1. **Credential principal / [D]:** surfaced as a blocking finding with proposed §9.1 text; the owner
   has since decided it (S2.3–4, proposed edit 6).
2. **Repository CI:** controller-owned base-doc residue gate, to clear with C0 #152. No residue
   allowlist, base-doc or cross-lane source changes made by this lane. Focused spike CI is separate.
3. **Unfenced/admin controls:** all listed route denials paired, with local administrator launching
   context verified (`review-controls-v7.txt`). runas has a failed control and is not credited as
   closed. Principal-based denials are labelled as such.
4. **COM / handles:** synchronous child receipts replace the unobserved ShellExecute marker;
   forced local-server activation reports class unavailability in both contexts. Deliberate inherited
   handles and both duplication paths have positive unfenced and negative fenced controls.
5. **Session 0:** the alias is in the headline qualification; unmodified initialization admits zero
   commands. Alias-assisted counts are provisional and cannot admit Windows for release.
6. **Per-command escapes:** named M1 API/concurrency/lifecycle requirement; separate-session
   reinitialization is explicitly not one-call escape support.
7. **Full fenced set:** source/spec mapping above lists every omitted registration group and the
   additional sandboxConfigFor/child rules; full-set parity is not claimed from representative paths.
8. **Non-root, no TPM:** explicit live gate on a genuinely TPM-less host, including reboot and hiding;
   the existing UID-0 namespace control is not substituted for it.
9. **Public metadata:** cloud project id and local gcloud/Homebrew paths scrubbed in a new commit,
   without rewriting history. `normalize-results.py` handles future tracebacks and preserves JSON
   escaping; CI checks idempotent normalization. Raw-byte comparison also catches Windows CRLF.
10. **TPM support claim:** cited committed `review-tpm-inventory-v2.txt` records the command and output.
11. **Workflow:** controller approved the scoped spike workflow; privacy normalization is checked there.
12. **Base-doc context:** no action, as ruled; controller owns C0/rebase/merge sequencing.

## Re-check disposition (re-check of 11aa9ae29)

1. **Normaliser CI regression:** fixed in `94ae95409`. The home-folder name is scrubbed only in path
   contexts, so "runner" in tool diagnostics is left alone; the focused CI went green at that head,
   privacy step included, and the check also passes locally as the CI runner's identity.
2. **Startup write (new failure):** cause found and closed for the tested routes (S2.2); the
   principal's own profile is the remaining, declared limit.
3. **§9.1 [D]:** decided by the owner and recorded.
4. **Repository residue gate:** controller-owned, unchanged.
5. **PR body:** rewritten to match this report.

## Final-round disposition (check of 8080cbadd)

1. **Denial checks:** all nine other denial checks now use the access-error rule of the Startup
   checks (`a944bdf3e`); in the rerun every denial reports EPERM.
2. **Temporary profile:** `review-routes.mjs` stops on a temporary profile, as `candidate.mjs` does.
3. **COM check:** the child-receipt check replaced the old assertion; the suite reaches 32/32
   (`final-windows-candidate-v4.txt`), and the paired controls match (`review-controls-v7.txt`).
4. **Label:** the profile write is `declared-limit-profile-write`, tagged `declared-limit`, and the
   count above says it is not a denial.
5. **Temp-folder paths:** the macOS per-user temp folder is scrubbed from `macos-codex.txt`,
   `final-macos-cursor.txt` and `resumed-macos-cursor-v2.txt`. The normaliser scrubs its path and
   project-key forms, and `--check` fails if any scrub rule stops firing on its sample.
6. **Edit 6:** also changes §4's Windows Bash cell.
7. **Edit 7:** the controller's ruling is written in, with one §9.1 rule for all three OSes; M1
   entry item 2 names the registry hive.
8. **PR body:** refreshed.
9. **Cursor trailer on `94ae95409`:** stays, as the controller decided; no history rewrite.

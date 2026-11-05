# C-M0: S2 Windows fence and S8 hiding secrets

Date: 2026-11-05. Lane C, `lane/c-m0`, spec revision 17; base `a481f7e14`.

**Review revision in progress. Windows is not admitted for release.** The historical **29/30 + 7/7**
figures are provisional, alias-assisted measurements on an artificially modified Session 0 namespace.
The unmodified candidate admitted zero workload checks: initialization failed.
The dedicated-principal candidate runs useful work and passes most focused checks, but requires a
Session 0 compatibility diagnostic and leaves one COM route inconclusive. Supported Windows 11
and authenticated agent integration remain live gates. Nothing here establishes production readiness.

The controller ruled that generated test keys in disposable stores are authorized, and that §8.5's
unattended fallback remains: user-scoped systemd sealing with TPM where available, otherwise an
owner-only plaintext key file, labelled plaintext and hidden by the fence. That fallback ruling is resolved;
the separate-principal conflict with §9.1 **[D]** below is a different, unresolved owner decision.
**Locked persistence is a rejected alternative:** cloud computers can be main/refresher computers and
must work unattended after reboot; requiring a person to unlock them would break that requirement.
No spec or shared contract was edited. Network, semantic D-Bus, caller-check and backend edits below
remain proposals for the controller after review.

## Method and evidence

The two spike READMEs give one command per check. Evidence is in their `results/` directories.
`final-*` results supersede intermediate `resumed-*` fixture failures; the interrupted v2 Windows
candidate file contains only an upload line and is not a measurement. Windows line endings/NUL
padding and personal temporary paths are normalized. The first Windows store artifact explicitly
records recovery from captured successful stdout after an older transport overwrote its output file.
No secret value, password or real account credential is included in any artifact.

| Platform | Actual environment | Scope limit |
| --- | --- | --- |
| Windows | Server 2025 build 26100, SSH session 0; Git 2.51.2.windows.1, Node 22.21.1, Bun 1.3.1; SRT 0.0.81; Codex 0.166.0 | Surrogate for Windows 11, not a desktop logon |
| Ubuntu | 26.04.1; kernel 7.0.0-1014-gcp; bwrap 0.11.1, xdg-dbus-proxy 0.1.7, systemd 259.9 | Cloud VM; vTPM present |
| Fedora | Fedora 45 container, proxy 0.1.9; bwrap package 0.13.1 | Ubuntu kernel; no Fedora SELinux host validation |
| Mac | macOS 26.6.1/25G76 arm64; Codex 0.166.0, SRT 0.0.81; Cursor 2026.10.22-27dcf5f | Below the spec's macOS 27 minimum |

All work stayed in lane-owned paths. Winter source/install/processes, the real Keychain and real
agent homes on this Mac were untouched. The SDK clone was read-only. No `claude` invocation,
agent prompt, model call, account login, GUI, app bundle, signing identity or sub-agent was used.
VM password authentication used generated local test users only, with passwords held in memory.
Cloud operations were limited to starting/stopping/SSH into the two named VMs. Both were stopped
after testing; Windows test accounts, WFP/firewall rules, grants and large downloaded test packages
were removed. Installed Git/Node/Bun and Linux package prerequisites remain on the stopped VMs.

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

**Verdict: works with limits as a spike; does not establish the release floor.**
The candidate uses the pinned upstream SRT native Rust launcher: dedicated unprivileged principal,
write-restricted token, explicit ACL grants/denies, WFP keyed to that principal, private desktop,
handle whitelist, process mitigations and kill-on-close jobs. Four WFP filters were installed.
No broad user-profile read grant was applied. Microsoft's VC++ runtime was a missing dependency.

It initially failed closed on a pre-existing hardlink to a denied file, and then failed under SSH
because it expected `\Sessions\0\BaseNamedObjects`, whereas this environment uses the global
namespace. The diagnostic `session0-bno.cs` holds a temporary object-manager alias to the real
namespace; handles close afterwards. **This alias is not a production solution.** A production
launcher must resolve Session 0 correctly without modifying the namespace. With that diagnostic,
`final-windows-candidate.txt` contains 30 ordinary checks (29 successful assertions), seven approved-
escape checks (7/7), job cleanup and an explicit out-of-process COM observation.

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
| Out-of-process Shell.Application | Call accepted, but no delayed child marker observed: **inconclusive**, not closed |
| runas / saved-credential attempt | Rejected; no saved outside credentials supplied |
| User/common Startup folders | Both writes denied |
| Job cleanup | Detached delayed child did not write its marker after parent exit |
| Direct local listener and metadata TCP | Both denied, ordinary and approved-escape sessions |

Approved escape experiments create a separate session with an additional write root, keeping the
same protected denies and WFP identity. Its extra allowed write succeeded; settings/run/secret/key
protection and both network denials held. They are deliberately network-closed escapes; this does
not implement arbitrary approved network access. Per-command write-root overrides are unsupported
by this vendor API and were not silently dropped.

Ordinary end-to-end checks took 654–2708 ms, median 706 ms; approved-escape checks 625–666 ms,
median 634 ms. These include PowerShell, Node worker and native broker execution. The earlier
2–5 ms launch-return figures exclude provisioning/compilation and are not comparable production costs.
The COM observation, Session 0 dependency, full-home policy, concurrency/crash recovery and Windows 11
remain gaps. No claim is made that every COM server or token-impersonation technique is closed.

## S2.3–4 — Helper, design and M1 entry

### Blocking finding: the candidate changes the [D] Windows credential model

Spec §9.1 says Windows Bash runs as the user and leaves that user's OS store open to `gh`, Docker
and git. The only tested posture that both fenced writes and ran Bash uses a **different principal**.
It cannot transparently use the real user's DPAPI, Credential Manager or Windows OpenSSH agent.
`resumed-provision-v2.txt` records no profile read grant; granting files would not change per-user
DPAPI/Credential Manager identity. Original-user strong-token configurations failed Bash startup.
The candidate **does not implement this [D] decision**. Its recommendation is conditional on an owner
decision. Controller authorization to evaluate it is not adoption of that product change.

Proposed §9.1 text, **[P], touches [D] — owner decides**:

> On Windows, model-run Bash and PowerShell execute as a dedicated sandbox principal under the
> persistent floor. They do not directly inherit the user's DPAPI, Credential Manager or ssh-agent
> access. Approved external-tool credentials are mediated by a Clover credential broker acting in
> the user's authenticated logon context, as credential access is mediated on Linux. Clover's own
> secrets, approval tokens and device keys are never served to model commands. The broker admits
> only the explicitly allowed credential operation for that session, destination and identity.

The broker must cover `gh` host/account token lookup; git credential-helper `get` plus approved
store/erase lifecycle keyed by protocol/host/path/user; Docker's registry credential-helper protocol
(not unrestricted host daemon-pipe access); and ssh-agent identity listing/signing with allowed keys,
session/destination constraints where supported, no private-key export and no blanket forwarding.
Raw host store/agent pipes stay closed. Requests must not become arbitrary host command execution.

Costs: an extra IPC/authorization plus OS-store operation per uncached lookup/sign, per-tool adapters,
rotation/recovery, logon/profile lifecycle, packaging/version compatibility and secret-safe audit.
Caching trades fewer lookups for retained credential material. **Broker latency was not measured**;
the 706/634 ms shell-fixture medians are not broker overhead estimates. Setup also requires account/
WFP provisioning. The current external-credential fixtures do not prove these Windows integrations.

Alternatives: continue original-user AppContainer/restricted-token research (no working write-fenced
Bash proof yet); use WSL2/a VM (still needs credential forwarding and changes process/filesystem
semantics); or explicitly reduce supported credential integrations. Unfenced original-user commands
restore store access by abandoning the required floor and are not an acceptable silent fallback.
Copying user tokens or raw stores defeats the separation. The controller takes this [D] change to
the owner before M1 can adopt the recommendation.

**M1 entry:** resolve that decision and define the Windows credential broker. Separately, implement
a real **per-command escape API**: the experiment resets/reinitializes an entire vendor session to
widen roots, not one `dangerouslyDisableSandbox` call. M1 must retain an immutable floor, isolate
per-launch grants from concurrent ordinary commands, and cover cleanup/crash recovery. Session-wide
reconfiguration must not ship as a per-command escape.

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
contracts, Session 0 resolution and the remaining COM/startup investigation, not production adoption
of this test shim. The SDK handoff remains coordinated with lane A.

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
6. **[P], touches [D], §9.1:** sandbox-principal Windows execution plus the user-context credential
   broker specified in the blocking finding; owner approval is required before M1 adoption.

No relaxation of the [D] Windows Bash release blocker is proposed. The Session 0, COM, startup-task
and protected-backend gaps go to the controller; this report does not silently route around them.

## M1, live gates and review

M1 starts with a reviewed native broker, stable floor and secret-store contracts, lifecycle/recovery,
correct Session 0 handling, caller identity and a production semantic credential policy. The failed
or unavailable backend combinations remain explicitly unsupported pending resolution. Broader home
write policy, concurrent sessions, crash cleanup and real credential-helper protocols need coverage.
The principal/broker [D] decision, per-command escape API and full fenced-set enumeration above are
explicit M1 entry requirements, not features proved by the spike counts.

Owner-batch gates: real Windows 11 install/Bash/island (§10.3), actual Ubuntu/Fedora deb/rpm/SELinux
and desktop keyrings (§10.4), macOS 27 integration (§10.5), authenticated ACP/file-tool/retry checks for
all five agents, and backed-up Winter migration (§10.11). Password-principal scheduled startup and
Codex Windows initialization need resolution before release, not an assumed pass from live gates.

Focused CI repeats mount/network/store/broker checks and Mac/Linux native deny/retry gates, plus
Windows launch measurements. Runner OSes are surrogates. Green means those experiments ran, not that
Windows security parity or every vendor integration passed. The latest focused run at the preceding
checkpoint passed all three jobs; final-head status is linked from PR #148. Broader repository CI is
reported separately. M0 is ready for the lane reviewer to assess these positive, negative and
inconclusive results; only the controller merges.

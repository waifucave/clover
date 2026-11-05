# C-M0: S2 Windows fence and S8 hiding secrets

Date: 2026-11-05. Lane C, `lane/c-m0`, based on `a481f7e14`; spec revision 17.

**Status: stopped for a controller decision; incomplete M0, not security admission.**
Windows remains a release blocker. This draft records reproducible positive and negative
experiments; it does not assert that every requested escape route or agent has been tested.
No Winter source, installation, daemon, real Keychain, real agent home, or SDK source was changed.

The binding stop condition is a written conflict: plan §9 and this lane's brief say secrets
never go on disk, whereas spec §4 and §8.5 explicitly permit a **plaintext** file containing
the encryption key when no keyring/usable sealing is available. The encrypted file and OS-store
experiments were expressly authorized; the plaintext fallback was not exercised. The controller
must reconcile this before the fallback is implemented or tested. Proposed text is below.
The deficient Windows candidates and missing semantic D-Bus filtering are also reported rather
than routed around by silently running unfenced commands.

## Evidence and scope

All evidence is under [`spikes/s2-windows-fence/results`](../../spikes/s2-windows-fence/results/)
and [`spikes/s8-secrets/results`](../../spikes/s8-secrets/results/). Each README gives one command
per experiment. Measurements are single runs, not confidence intervals or load benchmarks.
Evidence normalizes Windows line endings and NUL padding in CLR diagnostics. The Windows
store transcript was recovered from the successfully captured tool output after an older
transport's timeout overwrote its redirected file; its artifact explicitly records that provenance.

| Platform | Observed environment | Limitation |
| --- | --- | --- |
| Windows | Server 2025 Datacenter, 10.0.26100; Git 2.51.2.windows.1; bundled OpenSSH 10.2p1/OpenSSL 3.5.4; Node 22.21.1; Bun 1.3.1 | SSH session 0, not a Windows 11 desktop |
| Ubuntu | 26.04.1 LTS, kernel 7.0.0-1014-gcp; bubblewrap 0.11.1; xdg-dbus-proxy 0.1.7; systemd 259.9 | Cloud VM, no desktop login/keyring assumed |
| Fedora | Fedora 45 container, xdg-dbus-proxy 0.1.9; package availability also checked for bubblewrap 0.13.1 | Ubuntu host kernel; no Fedora SELinux or host namespace validation |
| Mac | macOS 26.6.1 (25G76), arm64; Codex 0.166.0; Anthropic sandbox-runtime 0.0.81 | Below the spec's macOS 27 minimum; runtime-only checks |

Both named VMs were started using the authorized command. SSH connected without needing
the prescribed first-boot retry loop. Both successful stop operations completed before this
report was finalized. No cloud resource was created, resized, deleted, or reconfigured.
The Fedora image, installer download and transient test directories were removed; tool
installations remain on the stopped disposable VMs. No model call, login to an outside account,
desktop interaction, browser, app bundle, or signing identity was used.

## Winter parity baseline, read from source

Reference only: `docs/claude/tool-surface.md`,
`packages/core/src/runtime-sdk/{mode-options,home-fence}.ts`; in the read-only SDK clone,
`packages/runtime/src/sandbox/{profile,spawn,host-child-floor}.ts` and
`packages/sdk/src/mandatory-floor.ts`.

`selfGrantDenyWrite` supplies the daemon's self-grant write fences; `sandboxConfigFor` adds
protected-home/project paths and read denies for run/runtime/control state. Child configuration
adds the runtime's glob spelling and any-depth project rules. Clover's spec intentionally
widens ordinary writes to home/temp and removes installed plugin/routine files from the fenced
set; copying Winter's arrays unchanged would contradict those choices.

`resolveNetworkPosture` returns false for every supported configuration and rejects domain
lists. Ordinary sandboxed Bash therefore has **no network**, not a ready domain-filtering proxy.
An approved override in `spawn.ts` still receives the mandatory native floor. That profile
allows unrelated operations while denying protected reads, writes, links and ancestor mutation.
The static command-text hook is not a substitute for that native floor.

## S2: Windows

### 1. Shell/tool compatibility

Verdict: **works with limits for privilege stripping; doesn't for the tested write-restricting
and AppContainer launch configurations.** This is a verdict on these configurations, not a
proof that AppContainer/MSYS2 or a more complete restricted-token design can never work.

The C# P/Invoke helper measures `CreateRestrictedToken`/`CreateProcessAsUser` and
`PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` AppContainer launches. The latter has no
capabilities. A unique AppContainer profile and low-labelled fixture root are removed afterwards.
Seven checks per posture: PowerShell pipeline, Bash pipeline/subshell/command substitution,
git init/status, `ssh -V`, Node, Bun, and a minimal Bun bundle. No real SSH connection or
authenticated git operation was attempted. This is a build smoke test, not a full project build.

| Token posture | Checks passing | Native launch return min/median/max, ms | Interpretation |
| --- | --- | --- | --- |
| `DISABLE_MAX_PRIVILEGE`, no restricting SIDs | 7/7 | 5 / 5 / 20 | Shell compatibility only; filesystem remains unfenced |
| Same, low integrity | 5/7 | 2 / 2 / 3 | git cannot create its repo; build redirect fails; root cause unresolved |
| `DISABLE_MAX_PRIVILEGE | WRITES_RESTRICTED`, Restricted Code SID | 0/7 | 2 / 2 / 2 | MSYS2 reports token-default-DACL/named-object access denied; PowerShell CLR startup fails |
| Same write restriction, low integrity | 0/7 | 2 / 2 / 2 | Same class of startup failures |
| AppContainer, no capabilities | 0/7 | 2 / 2 / 5 | Exits `0xC0000142` during initialization; no attribution to MSYS2 fork proven |

For the compatible privilege-only posture, total durations were 100–541 ms per command,
including PowerShell 541 ms and bundle 150 ms. There is no production launch-cost claim:
profile creation, ACL preparation, C# compilation, IPC and admission checks are excluded.
Removing `CREATE_NO_WINDOW` was necessary to reach user code in the restricted-token
experiments under SSH session 0. The earlier hidden-console failure was a fixture issue,
not evidence that a desktop launch is impossible. Windows 11 must reproduce the final setup.

### 2. Fence parity and routes to an unfenced process

Verdict: **doesn't — no tested Windows configuration combines useful commands with the
required security floor.** A privilege-stripped token passing commands is not a fence.
Low integrity is not a read fence and does not express an arbitrary home/temp allow set.
The fixture has no network enforcement or persistent escape floor.

| Requirement / route | Measured result or remaining gate |
| --- | --- |
| Allowed writes; fenced writes; hidden run/secrets; ordinary reads | No successful strong-token command to measure these; not established |
| Network, including cloud metadata | Not implemented in Windows prototype; not established |
| Approved command escapes retain native floor | Not implemented; not established |
| `schtasks` and Task Scheduler COM | Not tested from an admitted fence; open |
| Service Control Manager / services | Not tested; open |
| WMI and COM activation / existing COM servers | Not tested; open |
| `runas` / secondary logon | Not tested as an escape; open |
| Per-user and common Startup folders | Not tested; open |
| Process/token duplication, impersonation, inherited handles, host pipes and brokers | Not tested; open |

No escape route is called closed merely because its executable is absent or a PATH stub could
block it. The scheduled-task secrets attempt did not execute and provides no escape evidence.
The direct password-logon store experiment below succeeded by a different method.

Microsoft documents the second restricting-SID access check and the distinct launch/context
requirements. These support investigating the observed initialization failures, not broadening
the grants until the process happens to start. [Restricted tokens](https://learn.microsoft.com/en-us/windows/win32/secauthz/restricted-tokens),
[AppContainer launch](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer).

### 3–4. Helper and recommended next design

The self-contained prototype is [`native/sandbox/windows-probe.cs`](../../native/sandbox/windows-probe.cs).
Its language is C# using built-in .NET Framework and Win32 P/Invoke; API and costs are in its
README. It accepts only fixed experimental commands in this milestone. It has no job-object
tree cleanup and is not safe for untrusted commands.

Recommended design **to evaluate, not adopt as proven**: a dedicated unprivileged sandbox
principal, write-restricted tokens, explicit filesystem grants/denies, and WFP policy tied to
that principal. Keep a persistent floor on approved escapes. A native C++ broker can own
token creation, object namespace, a private noninteractive desktop if needed, bounded launch
requests, suspended creation, handle allow-listing and kill-on-close jobs. Bun talks to this
broker over a versioned private channel; no shell command provisions policy.

This would add installation/provisioning work and needs a full threat review. In particular,
same-user DPAPI/Credential Manager compatibility does not transfer to another principal;
approved external credential access would need a narrow broker. Out-of-process execution
under that principal must never acquire the daemon/app role just because its token is no
longer restricted. Existing sandbox runtimes document dedicated-account/WFP approaches,
but their alpha status and limitations do not discharge Clover's requirements.
[Anthropic sandbox-runtime](https://github.com/anthropics/sandbox-runtime).

M0 does not yet choose a release-ready Windows design. The original-user restricted-token
and AppContainer candidates need controlled object/desktop/ACL diagnostics before either
can be rejected generally. No insecure compatibility fallback was integrated.

## S8: secrets and the Linux fence

### 1. Encrypted file and OS wrapping key

Verdict: **works with limits** for the isolated store primitives; lifecycle, daemon use and
headless fallback remain unresolved.

| Platform / logon | Numbers and result |
| --- | --- |
| Windows SSH public-key/network logon | DPAPI 0/1, HRESULT `0x80070005`; Credential Manager 0/1, error 1312 (no logon session) |
| Windows password logon | DPAPI 1/1 and Credential Manager 1/1, both error codes zero |
| Ubuntu private Secret Service | Store/retrieve key 1/1, AES-256-GCM encrypted-file roundtrip 1/1, modified ciphertext rejected 1/1; 64 plaintext bytes produce a 92-byte nonce+ciphertext+tag file |

Windows generated a local user's random password only in memory, called `LogonUser` type 2
(interactive password authentication), loaded that user's profile, then impersonated its token
for in-memory DPAPI and generic-credential roundtrips. The user, profile and credential targets
were removed. This is a real password logon via API, **not** an RDP/console or scheduled-task
validation. Initial Task Scheduler and `Start-Process` attempts produced no fixture result;
they were not counted as successes. No password was sent through command arguments or logs.

The Linux keyring ran on a private D-Bus session with a temporary home/config/data/runtime
directory and random in-memory unlock password. `secret-tool` received the generated key
through stdin; lookup output was captured and compared in memory. Only encrypted keyring
and AES-GCM contents reached the disposable filesystem. No login keyring was contacted.
No Fedora OS-store roundtrip was run.

For M1, select one authenticated-encryption format with version/AAD, atomic replacement,
permissions, nonce discipline, rotation, backup/recovery and corruption handling. Credential
Manager storing the wrapping key best matches §4's current Windows wording; DPAPI is also
viable for protecting a wrapping-key blob under a valid user profile. These two smoke tests
do not choose recovery semantics or prove availability in Clover's actual login task.

With no unlocked keyring, report a locked store and keep keys in memory only after explicit
unlock until the controller resolves the plaintext fallback. `systemd-creds --user`/TPM
availability and service-logon behaviour have **not** been tested. No claim is made that this
VM has a usable TPM or that per-user sealing provides application identity isolation.

### 2. Hiding paths while preserving external credential lookups

Verdict: **works with limits** for Ubuntu mount isolation; **doesn't** for plain
`xdg-dbus-proxy` providing item-level Secret Service separation.

Ubuntu's 12/12 focused checks passed: writable scratch, ordinary read, denied settings write,
hidden host run contents, hidden host secrets contents, denied ancestor rename, hidden session
bus socket, rejected `systemd-run --user`, denied cloud-metadata TCP connection, Bash
pipeline/subshell, git init/status, and a compiled C smoke build. Durations were 14.78–150.58 ms;
the build took 150.58 ms. This fixture masks `/tmp`, `/run`, `/home`, supplies fresh `/proc` and
`/dev`, unshares namespaces, and mounts the test state read-only with secret/run masks. It
does not implement Clover's final home-wide writable policy or prove all alias/race protections.

The proxy check uses a private fake service returning only a public integer. An allow rule for
`org.freedesktop.Secret.Service.GetSecrets` at `/org/freedesktop/secrets` forwarded a Clover
item path in its `ao` argument despite granting no access to that item's object path. An
unrelated interface was denied. This reproduced both outside and inside bubblewrap. Fedora
45/xdg-dbus-proxy 0.1.9 reproduced the same protocol result in a container. The fake service
is not a real keyring conformance test and does not return real secrets.

The proxy's rule grammar filters destination/interface/member/header path, and replies to
admitted calls pass through. It has no Secret Service argument policy. A name-wide
`--talk=org.freedesktop.secrets` grant is therefore insufficient; a root-method allow list also
does not distinguish the item paths inside a bulk request.
[Proxy policy reference](https://github.com/flatpak/xdg-dbus-proxy/blob/main/xdg-dbus-proxy.xml).

An equivalent **semantic credential broker** would need to validate requested items, collection
and alias resolution, bulk `GetSecrets`, lookup/search results, property access, signals and
mutation/unlock methods, while rejecting Clover's wrapping-key item. Its endpoint must be
the only reachable store path. Independently hide the original bus, runtime sockets,
systemd private sockets, system bus, and any filesystem/abstract-socket alternate route.
`systemd-run` failing in a fixture with no bus is not proof that such a broker is complete.

`gh`, Docker and git working with real OS-store credentials was **not proved**. No outside
login was authorized, and the fixture intentionally exposes no real credential sockets. A next
test should exercise their credential helpers against disposable store items and a local fake
server. Docker's credential helper and its daemon socket are different boundaries: exposing
the raw host daemon can launch host work and cannot be treated as a harmless store lookup.
Likewise, an SSH version check does not establish SSH-agent or network compatibility.

Fedora requires real-host checks of SELinux labels/policy, unprivileged namespaces, bubblewrap,
the desktop's keyring/portal services and packaging. Ubuntu also needs the installed AppArmor
policy and supported helper version checked; no system policy was weakened in this spike.

### 3. Each agent's own sandbox

Verdict: **works with limits** for the tested Codex/standalone Anthropic primitives; **not
established** for complete agent integrations. Tool permission rules and shell containment
must both hide the run/secrets paths. A runtime test does not prove the agent's in-process Read
tool, ACP adapter, settings precedence or approved retry behaviour.

| Backend | macOS | Linux | Native Windows | Clover path configuration / evidence |
| --- | --- | --- | --- | --- |
| Claude Code | Seatbelt | bubblewrap | Official Claude Code docs still say unsandboxed | `sandbox.filesystem.denyRead/denyWrite` for shell commands, plus `Read`/write-tool deny rules. Standalone SRT 0.0.81 passed the Mac read/write fixture; Ubuntu failed before its command in `apply-seccomp` (`setgroups`, CAP_SYS_ADMIN). No weakening/retry was applied. |
| Codex | Seatbelt | Native sandbox backend | Native Windows sandbox documented; not live-tested here | Named `permissions.<name>.filesystem` absolute paths with `deny`, allowed root `write`; sandbox-only fixture passed on Mac and Ubuntu with temp `CODEX_HOME`. Tested broad ordinary read, allowed write, hidden read and denied hidden write. |
| Devin CLI / Desktop backend | OS sandbox documented | bubblewrap/socat documented | Docs explicitly refuse sandbox mode | `Read(absolute-path/**)` / `Write(...)` denies. Docs say read denies hide paths from shell commands and tools have their own rules. No login-free sandbox-only runner identified in the reviewed docs; no live invocation made. |
| Cursor CLI | Seatbelt | Namespaces with Landlock/bubblewrap paths documented | Native installation documented; these sandbox docs do not establish Windows containment | CLI `Read(...)`/`Write(...)` permission denies and `sandbox.json` read boundary. No documented arbitrary hard deny-path list in `sandbox.json` was established; workspace read boundary is narrower but is not equivalent to a non-overridable deny. No live invocation made. |
| Antigravity CLI | Seatbelt | Namespaces | AppContainer in a process security environment; documented patched 24H2 prerequisite | `permissions.deny` with `read_file(...)` / `write_file(...)`, sandbox enabled. Documentation says denied paths are blocked. No live sandbox-only invocation made. |

Primary sources: [Claude sandbox scope](https://code.claude.com/docs/en/sandboxing),
[Codex permission implementation](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/permissions.rs),
[Devin sandbox](https://docs.devin.ai/cli/sandbox),
[Devin tool permissions](https://docs.devin.ai/cli/reference/permissions),
[Cursor CLI permissions](https://cursor.com/docs/cli/reference/permissions),
[Cursor sandbox configuration](https://cursor.com/docs/reference/sandbox),
[Cursor platform/run modes](https://cursor.com/docs/agent/security/run-modes),
[Antigravity terminal sandbox](https://antigravity.google/docs/sandbox/?tab=cli).

Anthropic's standalone runtime separately offers alpha Windows support with a dedicated
account, WFP and ACLs. This is not proof that Claude Code itself exposes it. The table preserves
that distinction. None of these vendor modes establishes Clover's mandatory escape floor:
exclude lists, approvals and automatic retry classifiers must not silently remove it.
Use explicit asking modes, never vendor auto-approval of an unfenced retry, and require an
integration gate before labelling a backend protected. Clover's existing unsandboxed-backend
OK remains necessary wherever this cannot be achieved.

## Concrete proposed spec text — controller applies, no spec file edited

1. **[P], §4 and §9.1, network:** “Ordinary bot Bash and PowerShell have no network access
   on every OS. Networked work goes through the approved core/plugin interfaces or an approved
   escape. An escape retains the mandatory protected-path floor. Cloud-metadata access remains
   forbidden to bot commands.” Controller must specify and test how the last sentence applies
   to approved escapes; current Mac path-floor code alone does not implement an IP rule.
2. **[P], §4/S8 Linux:** “The D-Bus boundary must enforce Secret Service item semantics,
   including object paths carried inside method arguments and results. A name/interface/path
   allow list alone is not sufficient. The host bus and other host execution endpoints are
   unreachable except through reviewed brokers.” `xdg-dbus-proxy` can be one layer, not the
   item-isolation claim itself.
3. **[P], §8.5, recommended conflict resolution:** replace the plaintext fallback with:
   “When no approved key store or sealing mechanism is available, credential persistence stays
   locked. The daemon can run without saved credentials and can accept an explicit in-memory
   unlock. It never silently writes a plaintext wrapping key.” If the owner intends to keep
   the existing plaintext option, the controller must instead explicitly amend plan §9 and
   this lane's secret-handling authorization before testing it. This affects the owner-decided
   encrypted-file/OS-store design and headless experience: **touches [D]; owner decides**.
4. **[P], §3.1, caller checks:** “Sandbox principal identity, mandatory policy provenance and
   execution generation are checked in addition to token flags/process ancestry. Work launched
   through a service or different token does not become an app/user caller.” Needed if the
   dedicated-principal candidate proceeds; no claim of an implemented API.
5. **[P], §9.3:** “A backend is marked protected only after its exact version/configuration
   denies protected paths to both file tools and shell descendants, rejects policy widening,
   and preserves the floor on retries/exclusions. Otherwise the explicit unsupported-backend
   OK applies; settings names alone are not evidence.” Keep the **[D] own-sandbox/no-outer-wrap
   rule**. Any proposal to replace it with another enclosing sandbox needs the owner's decision.

These are proposals, not assumed authorization to change the spec or cross-lane contracts.
No change to the **[D] Windows bash release blocker** is proposed.

## What remains, and where M1 starts

The Windows floor, semantic credential broker, headless fallback, agent integration and
production store format are **incomplete engineering gates**, not work silently deferred to
the owner-only live batch. Resolve the stop condition first, then resume C-M0 on this branch.

The next C-M0 work is controlled Windows object/token/desktop diagnostics with a privilege-only
control, then one complete candidate including every escape route listed above, canonical
paths/aliases/ancestor replacement, job cleanup and normal/approved-escape network tests.
Measure provisioning and warm/cold launch separately. Repeat real-logon secrets tests in the
actual scheduled-task startup context. Build a semantic Secret Service broker and local
credential-helper fixtures, and resolve the Ubuntu standalone-runtime startup failure without
removing required isolation. Complete the three-OS agent deny-list and retry gates.

Only then should M1 begin with the shared `SecretStore`/`Fence` interfaces, fail-closed native
launch broker, store lifecycle/recovery and caller verification; lane A's SDK remains read-only
until the agreed ownership handoff. No production adapter should consume this launch probe.

Owner-batch live gates still include plan §10.3's real Windows 11 installation/Bash fence;
§10.4's Ubuntu/Fedora deb/rpm, real desktop keyrings and host policy; §10.5's macOS 27 integration;
and §10.11's backed-up Winter migration. Claude Code, Codex, Devin, Cursor and Antigravity
end-to-end tool/ACP/retry checks that require an authenticated agent/model belong in the live
batch; no such login or model call was made here. Synthetic OS-store tests should precede it.

## CI and review meaning

[`spike-s2-s8.yml`](../../.github/workflows/spike-s2-s8.yml) repeats the focused Linux fixture,
private store and negative proxy experiment, the Mac runtime primitives, and Windows launch
measurements. It uses runner OS surrogates, not the full supported-OS/live matrix. A green
workflow means those checks ran; it does **not** mean S2/S8 passed. The Windows job admits only
its privilege-only compatibility control and uploads the strong-mode results for inspection.
The known Ubuntu SRT failure is preserved in evidence and is not represented as passing CI.

Open as a **draft** with the requested title; lane reviewer/controller review is pending.
No reviewer was spawned or messaged. The controller must decide how to reconcile the stop
condition and whether to resume the missing C-M0 work; the PR must not be merged as completed M0.

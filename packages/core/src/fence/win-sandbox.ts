// Windows Bash under Clover's fence (lane C, C-M2 part 2; spec §4, §9.1, items 76 and 1116, §14.1 item 2).
//
// Bots' Bash and PowerShell run as the dedicated sandbox principal `clover-sb-<8hex>` through the
// hash-pinned srt-win launcher (Apache-2.0, `anthropics/sandbox-runtime` tag `v0.0.81`, commit
// `c40cf14…`; source in `vendor/srt-win-src`, built with a static CRT by `scripts/build-srt-win.ps1`).
// Never as the user, never AppContainer, and never a network-open or unsandboxed fallback.
// Per Addendum 9: the principal name is `clover-sb-` + first 8 hex chars of SHA-256(user SID), 18 chars total.
// The full SID is stored in the principal's description field and checked on status/remove to prevent collisions.
//
// This module is the pure half: constants, the launcher's argument shapes, its status parsing, the
// per-launch allow/deny plan and the setup/reset command lists. It runs on every OS (the unit tests
// run on macOS); the live half — elevation, the install/remove/status spawns, the profile work and
// the per-session reset — runs on Windows only, driven by `clover-core sandbox setup|remove|status`.
import { win32 } from "node:path";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dlopen, FFIType } from "bun:ffi";
import { callerPlaces } from "./per-caller";
import type { CallerPlaces } from "./per-caller";
import type { SandboxPolicy } from "../contracts/fence";
import type { Caller } from "@waifucave/clover-protocol";
import { fenceContextFor } from "../contracts/fence";
import { SRT_WIN_PINS, launcherDigest, launcherProblem, srtWinArch, srtWinPath, type SrtWinArch } from "./windows-launcher";

/** The protected copy location for elevated sandbox commands, per user SID.
 *  Uses `[Environment]::GetFolderPath("ProgramFiles")` to find Program Files.
 *  Path: `%ProgramFiles%\Clover Sandbox\<user SID>\clover-core.exe` */
export async function protectedCopyPath(): Promise<string> {
  const { execFileSync } = await import("node:child_process");
  const ps = `
    $ProgressPreference = 'SilentlyContinue'
    $pf = [Environment]::GetFolderPath("ProgramFiles")
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    Write-Output "$pf\\Clover Sandbox\\$sid\\clover-core.exe"
  `.trim();
  const out = execFileSync("powershell", ["-NoProfile", "-NoLogo", "-NonInteractive", "-Command", ps], { encoding: "utf8", windowsHide: true });
  return String(out).trim();
}

/** Whether the current process is running from the protected copy location. */
export async function isProtectedCopy(execPath: string = process.execPath): Promise<boolean> {
  const protectedPath = await protectedCopyPath();
  return win32.normalize(execPath).toUpperCase() === win32.normalize(protectedPath).toUpperCase();
}

export { SRT_WIN_PINS, launcherPinned, authenticodeDigest, srtWinArch, srtWinPath, launcherProblem, launcherDigest, type SrtWinArch } from "./windows-launcher";

/** The base prefix for the sandbox principal (Addendum 9). Windows account names are capped at 20
 *  characters, so we use `clover-sb-` (10 chars) + 8 hex chars = 18 chars total. */
export const SANDBOX_PRINCIPAL_PREFIX = "clover-sb-";

/** Compute the per-user principal name from a Windows SID (Addendum 9).
 *  Returns `clover-sb-` + first 8 hex characters of SHA-256(SID).
 *  Kept for single-principal contexts and tests; the pool uses
 *  [`poolPrincipalName`] so concurrent sessions never share a SID. */
export function principalNameFromSid(sid: string): string {
  const hash = createHash("sha256").update(sid).digest("hex");
  return `${SANDBOX_PRINCIPAL_PREFIX}${hash.slice(0, 8)}`;
}

/** Pool size: concurrent sessions per user (controller ruling 2). */
export const SANDBOX_POOL_SIZE = 4;

/** Pool principal `n` (1-based) for an owner SID: `clover-sb-<6hex>-<n>`, 18 chars, leased
 *  exclusively — two bots never share a principal while they run. */
export function poolPrincipalName(ownerSid: string, slot: number): string {
  const hash = createHash("sha256").update(ownerSid).digest("hex").slice(0, 6);
  return `${SANDBOX_PRINCIPAL_PREFIX}${hash}-${slot}`;
}

/** Per-slot WFP sublayer: name-based UUIDv5 (SHA-1) over the compiled sublayer namespace plus
 *  owner SID and principal name (controller ruling 3: the sublayer derives per user; each pool
 *  slot gets its own so one install never replaces another's filters). */
export function poolSublayerGuid(ownerSid: string, principal: string): string {
  const ns = Buffer.from(CLOVER_WFP_SUBLAYER.replace(/-/g, ""), "hex");
  const digest = createHash("sha1").update(ns).update(ownerSid, "utf8").update(principal, "utf8").digest();
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** One leased pool member. */
export interface PoolMember {
  readonly principal: string;
  readonly sublayer: string;
}

/** The pool for an owner: 4 exclusive principals with their sublayers. */
export function sandboxPool(ownerSid: string, size: number = SANDBOX_POOL_SIZE): readonly PoolMember[] {
  return Array.from({ length: size }, (_, i) => {
    const principal = poolPrincipalName(ownerSid, i + 1);
    return { principal, sublayer: poolSublayerGuid(ownerSid, principal) };
  });
}

/** The installer's target user SID, read off our own path (should-fix: never the elevated token or env).
 *  The installer copies us to `%ProgramFiles%\Clover Sandbox\<user SID>\clover-core.exe`, so when we run
 *  from there our path names the user we serve — even when elevation runs as a different account. Null
 *  when we are not running from a protected copy (dev layouts, per-user installs). */
export function installerTargetSid(execPath: string = process.execPath): string | null {
  const m = /Clover Sandbox[\\/](S-1-[0-9-]+)(?:[\\/]|$)/i.exec(execPath);
  return m ? m[1]! : null;
}

/** `powershell -EncodedCommand`: run a script without interpolating it into a `-Command` string.
 *  Paths with `$`, quotes or backticks stay inert (UTF-16LE base64, the only encoding `-EncodedCommand`
 *  takes), so a hostile or odd profile path can never break out of the command. Every script starts with
 *  `$ProgressPreference='SilentlyContinue'`: first-use module notices ("Preparing modules…") arrive as
 *  CLIXML on stderr, and `run()` merges the streams — silence keeps machine output parseable. */
export function psEncodedArgs(script: string): readonly string[] {
  const b64 = Buffer.from(`$ProgressPreference='SilentlyContinue';${script}`, "utf16le").toString("base64");
  return ["powershell", "-NoProfile", "-NoLogo", "-NonInteractive", "-EncodedCommand", b64];
}

/** Clover's WFP sublayer: the launcher's network filters live under this GUID, not its default. */
export const CLOVER_WFP_SUBLAYER = "F6D7C8CF-13C0-4547-8835-F14E27345468";

/** The pinned launcher: tag and commit. The digest itself is `SRT_WIN_PINS` in `windows-launcher.ts`. */
export const SRT_WIN_TAG = "v0.0.81";
export const SRT_WIN_COMMIT = "c40cf14a65d025e3cd27f071f13a73c12b3b1f92";

/** `sandbox setup|remove|status` exit codes (sent to lane M): 0 done (`setup` idempotent, `remove` exits 0
 *  when nothing is left), 2 not elevated, 3 launcher missing or its digest isn't the pinned one. Anything
 *  else is 1. */
export const SANDBOX_EXIT = { OK: 0, FAILED: 1, NOT_ELEVATED: 2, HASH_MISMATCH: 3 } as const;

/** `srt-win install`: one elevated step provisioning the principal and its WFP filters (the launcher
 *  self-elevates via UAC; idempotent — re-running rotates the password and refreshes the filters).
 *  Loopback stays closed (the default): Bash gets no network, as on macOS and Linux.
 *  The principal is required: the bare prefix is not an account. `ownerSid` is recorded on the
 *  install (`--owner-sid`) and gates later use to that owner (admins/SYSTEM excepted). */
export function setupArgs(launcher: string, sublayer: string, principal: string, ownerSid: string): readonly string[] {
  return [launcher, "install", "--sandbox-user", principal, "--sublayer-guid", sublayer, "--owner-sid", ownerSid];
}

/** `srt-win uninstall`: undoes everything (`--keep-user` is never passed: remove removes all of it).
 *  Exits 0 when nothing is left. Takes no `--sandbox-user`: the 0.0.81 uninstall removes whatever account
 *  the install marker names under the sublayer; naming a user is a usage error (exit 2). With the patched
 *  launcher, `--user` scopes the removal to that principal's record, credential and account. */
export function removeArgs(launcher: string, sublayer: string, principal?: string): readonly string[] {
  return principal === undefined
    ? [launcher, "uninstall", "--sublayer-guid", sublayer]
    : [launcher, "uninstall", "--sublayer-guid", sublayer, "--user", principal];
}

/** `srt-win status`: one line of JSON `{user, wfp}`; never elevates. */
export function statusArgs(launcher: string, sublayer: string): readonly string[] {
  return [launcher, "status", "--sublayer-guid", sublayer];
}

/** `srt-win user status`: the principal's provisioning state, one object of JSON; never elevates. */
export const USER_STATUS_ARGS: readonly string[] = ["user", "status"];

/** `srt-win user status --user <principal>`: the per-principal record (patched launcher); without the
 *  flag the machine-global record is reported. */
export function userStatusArgs(launcher: string, principal?: string): readonly string[] {
  return principal === undefined ? [launcher, "user", "status"] : [launcher, "user", "status", "--user", principal];
}

/** `srt-win exec`: launch a command as the principal. `--quiet` keeps broker chatter off the command's
 *  stderr; `--write-restricted-token` is the brief's token; `--deny-read`/`--deny-write` are the per-launch
 *  fence; `--held-by` ties the command to the daemon so it ends with it.
 *  `env` is REQUIRED and complete: srt-win forwards exactly these entries and nothing inherited, so the
 *  caller passes `sandboxHomeEnv` plus proxy/CA entries and the broker's `HOME` (and any tokens in it)
 *  can never leak into the child (should-fix). `writeRoots` names the session's persistent write roots:
 *  each root's capability SID joins the child token's restricting SIDs, which is what lets the child write
 *  there — and only there, among the persistent roots (measured on the VM). */
export function execArgs(o: {
  launcher: string;
  shell: readonly string[];
  denyRead: readonly string[];
  denyWrite: readonly string[];
  env: Readonly<Record<string, string>>;
  writeRoots: readonly string[];
  /** The pool principal to launch as (patched launcher `--user`): the launch names its identity. */
  user: string;
  heldBy?: number;
}): readonly string[] {
  const a: string[] = [o.launcher, "exec", "--quiet", "--user", o.user, "--write-restricted-token"];
  for (const p of o.denyRead) a.push("--deny-read", p);
  for (const p of o.denyWrite) a.push("--deny-write", p);
  for (const r of o.writeRoots) a.push("--write-root", r);
  if (o.heldBy !== undefined) a.push("--held-by", String(o.heldBy));
  for (const [k, v] of Object.entries(o.env)) a.push("--env", `${k}=${v}`);
  a.push("--", ...o.shell);
  return a;
}

/** `srt-win acl grant`: the caller's allowed paths, for the daemon's lifetime (holder PID). stdin carries
 *  `{read, write}`. */
export function aclGrantArgs(o: { launcher: string; sid: string; holderPid: number }): readonly string[] {
  return [o.launcher, "acl", "grant", "--holder-pid", String(o.holderPid), "--sandbox-user-sid", o.sid];
}

/** `srt-win acl revoke`: drop the holder's claim (the ACEs go when the last holder does). */
export function aclRevokeArgs(o: { launcher: string; sid: string; holderPid: number }): readonly string[] {
  return [o.launcher, "acl", "revoke", "--holder-pid", String(o.holderPid), "--sandbox-user-sid", o.sid];
}

/** The stdin document `acl grant` reads. */
export function aclGrantInput(read: readonly string[], write: readonly string[]): string {
  return JSON.stringify({ read: [...read], write: [...write] });
}

/** A launch session's persistent roots (controller ruling 1): `acl grant --persistent` makes each `write`
 *  path a persistent root with its own capability SID (ACEs for the sandbox group + that SID), kept when the
 *  session ends; `denyRead`/`denyWrite` targets under a root are stamped for the group and kept with it.
 *  `exec --write-root` then adds each root's capability SID to the child token, which is what lets the child
 *  write there — and only there (measured on the VM: an Authenticated-Users-writable folder outside the
 *  roots is refused). `acl revoke` does not touch persistent roots; `acl forget` at session end removes them. */
export function sessionGrantArgs(o: { launcher: string; sid: string; holderPid: number }): readonly string[] {
  return [o.launcher, "acl", "grant", "--holder-pid", String(o.holderPid), "--sandbox-user-sid", o.sid, "--persistent"];
}

/** The stdin document a session grant reads: allowed reads and write roots, plus denies under the roots. */
export function sessionGrantInput(o: {
  read: readonly string[];
  write: readonly string[];
  denyRead?: readonly string[];
  denyWrite?: readonly string[];
}): string {
  return JSON.stringify({
    read: [...o.read],
    write: [...o.write],
    ...(o.denyRead !== undefined ? { denyRead: [...o.denyRead] } : {}),
    ...(o.denyWrite !== undefined ? { denyWrite: [...o.denyWrite] } : {}),
  });
}

/** End a launch session: `acl revoke` drops the holder's per-session claims. */
export function sessionRevokeArgs(o: { launcher: string; sid: string; holderPid: number }): readonly string[] {
  return aclRevokeArgs(o);
}

/** Forget a launch session's persistent write roots (runs at session end, after revoke). */
export function sessionForgetArgs(launcher: string): readonly string[] {
  return [launcher, "acl", "forget", "--all"];
}

/** Restore a launch session's per-exec denies (runs at session end, after revoke). */
export function sessionRestoreArgs(launcher: string): readonly string[] {
  return [launcher, "acl", "restore"];
}

/** A warm-up launch: the principal's first logon creates its profile. Nothing is written. */
export function warmUpArgs(o: { launcher: string; systemRoot: string }): readonly string[] {
  return [o.launcher, "exec", "--quiet", "--", win32.join(o.systemRoot, "System32", "cmd.exe"), "/d", "/c", "exit 0"];
}

/** `reg query HKLM\…\ProfileList\<sid> /v ProfileImagePath`: the principal's profile, resolved by SID. */
export function profileQueryArgs(sid: string): readonly string[] {
  return ["reg", "query", `HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\${sid}`, "/v", "ProfileImagePath"];
}

/** `reg query HKLM\…\ProfileList` (no SID): every profile key, for finding an earlier principal's SID by
 *  its `ProfileImagePath`. Used only for cleanup, never to resolve the live profile. */
export const PROFILE_LIST_ARGS: readonly string[] = ["reg", "query", "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList"];

/** The `ProfileImagePath` in `reg query` output, or null when the key or value is absent. */
export function parseProfileImagePath(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s*ProfileImagePath\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/i.exec(line);
    if (m) return m[1]!;
  }
  return null;
}

/** The SID keys under `HKLM\…\ProfileList` in `reg query` output (one `…\ProfileList\S-1-5-21-…` line each). */
export function parseProfileListSids(stdout: string): string[] {
  const out = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const m = /ProfileList\\(S-1-[0-9-]+)\s*$/i.exec(line.trim());
    if (m) out.add(m[1]!);
  }
  return [...out];
}

/** A Windows profile loaded from `C:\Users\TEMP*` is a temporary profile: the launch must fail closed. */
export function isTemporaryProfile(profileRoot: string): boolean {
  const leaf = win32.basename(profileRoot).toUpperCase();
  return leaf === "TEMP" || leaf.startsWith("TEMP.") || leaf.startsWith("TEMP-");
}

/** The per-launch profile verdict (spec item 1116; brief item 7): the principal's profile, resolved by SID,
 *  must exist and must not be temporary. The daemon's Windows spawn runs the session reset first
 *  (`sessionResetPlan`) and then this check; either failure refuses the launch, never a fallback. */
export function profileLaunchCheck(profile: { sid: string; path: string } | null): { ok: true } | { ok: false; reason: string } {
  if (profile === null) return { ok: false, reason: "the principal's profile isn't resolved by its SID" };
  if (isTemporaryProfile(profile.path)) return { ok: false, reason: "the principal is running on a temporary profile" };
  return { ok: true };
}

/** The child environment every Bash launch sets explicitly (controller ruling 2): `HOME`, `USERPROFILE`
 *  and `APPDATA` point at the principal's own profile, resolved by SID. The broker's environment is never
 *  inherited — `execArgs` only forwards the `env` it is given, and the caller passes exactly this plus
 *  proxy/CA entries, so the child's home can never be the real user's. */
export function sandboxHomeEnv(profileRoot: string): { HOME: string; USERPROFILE: string; APPDATA: string } {
  return {
    HOME: profileRoot,
    USERPROFILE: profileRoot,
    APPDATA: win32.join(profileRoot, "AppData", "Roaming"),
  };
}

/** `Set-LocalUser -Description <ownerSid>`: stamp the owning user's full SID on the principal (Addendum 9).
 *  srt-win leaves its own description; setup overwrites it right after provisioning. */
export function setDescriptionArgs(principal: string, ownerSid: string): readonly string[] {
  return psEncodedArgs(`Set-LocalUser -Name "${principal}" -Description "${ownerSid}"`);
}

/** Read the principal's description back (works unelevated). */
export function getDescriptionArgs(principal: string): readonly string[] {
  return psEncodedArgs(`(Get-LocalUser -Name "${principal}").Description`);
}

/** Resolve a known folder without environment variables (should-fix): `System` (System32's parent),
 *  `CommonStartup` (all-users Startup) and `CommonApplicationData` (ProgramData). */
export function knownFolderArgs(kind: "System" | "CommonStartup" | "CommonApplicationData"): readonly string[] {
  return psEncodedArgs(`[Environment]::GetFolderPath("${kind}")`);
}

/** Whether the principal's description names exactly this owner SID. Anything else — srt-win's default,
 *  another user's SID, unreadable output — never touches another user's principal. */
export function descriptionMatches(description: string | null, ownerSid: string): boolean {
  return description !== null && description.trim() === ownerSid;
}

/** The owner SID in `whoami /user /fo csv /nh` output (`"DOMAIN\\user","S-1-5-21-…"`), or null.
 *  Kept as the portable reader; on Windows the CLI prefers core's token-based `currentUserSid`. */
export function parseWhoamiSid(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const m = /"[^"]*","(S-1-[0-9-]+)"/.exec(line.trim());
    if (m) return m[1]!;
  }
  return null;
}

/** The explicit minimal environment every `sandbox` child spawns with (should-fix): a fixed `PATH`
 *  plus the Windows installation variables. Notably absent: `HOME`, proxy variables and anything that
 *  could carry a token — nothing is inherited just because a variable was forgotten. `USERPROFILE` and
 *  `ProgramData` stay because identity-adjacent lookups may read them; the fence never trusts them. */
export function minimalChildEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {
    PATH: "C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem;C:\\Windows\\System32\\WindowsPowerShell\\v1.0",
  };
  for (const k of ["SystemRoot", "windir", "SystemDrive", "TEMP", "TMP", "PATHEXT", "USERPROFILE", "ProgramData", "LOCALAPPDATA"]) {
    const v = env[k];
    if (typeof v === "string" && v !== "") out[k] = v;
  }
  return out;
}

/** The three Startup folders the fence denies the principal: its own, the real user's and all users'. */
export function startupFolders(o: { profileRoot: string; realUserProfile: string; commonStartup: string }): readonly string[] {
  const under = (root: string) => win32.join(root, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
  return [under(o.profileRoot), under(o.realUserProfile), o.commonStartup];
}

/** The install marker: our own per-user record of a completed `setup` (ruling 3). One pool of
 *  principals per owner: `%ProgramData%\Clover Sandbox\markers\<owner SID>.json`, written elevated
 *  by setup, readable by everyone. `setup --force` across owners and `remove` against another
 *  owner's marker are refused off this record — never off the live token alone. */
export interface PoolMemberRecord {
  readonly principal: string;
  readonly principalSid: string | null;
  readonly sublayer: string;
}

export interface InstallMarker {
  readonly version: 2;
  readonly ownerSid: string;
  readonly members: readonly PoolMemberRecord[];
}

/** Where the install marker for this owner lives. */
export function installMarkerPath(programData: string, ownerSid: string): string {
  return win32.join(programData, "Clover Sandbox", "markers", `${ownerSid}.json`);
}

/** Serialize a completed setup's marker. */
export function formatInstallMarker(m: InstallMarker): string {
  return JSON.stringify({
    version: 2,
    ownerSid: m.ownerSid,
    members: m.members.map((x) => ({ principal: x.principal, principalSid: x.principalSid, sublayer: x.sublayer })),
  });
}

/** Parse a marker file back; null when absent or not ours. Version 1 (single principal) reads as a
 *  one-member pool. */
export function parseInstallMarker(text: string | null): InstallMarker | null {
  if (text === null) return null;
  try {
    const o = JSON.parse(text) as Record<string, unknown>;
    if (typeof o.ownerSid !== "string") return null;
    if (o.version === 2 && Array.isArray(o.members)) {
      const members: PoolMemberRecord[] = [];
      for (const e of o.members as Record<string, unknown>[]) {
        if (typeof e !== "object" || e === null || typeof e.principal !== "string" || typeof e.sublayer !== "string" ||
          (e.principalSid !== null && typeof e.principalSid !== "string")) return null;
        members.push({ principal: e.principal, principalSid: e.principalSid, sublayer: e.sublayer });
      }
      return { version: 2, ownerSid: o.ownerSid, members };
    }
    if (o.version === 1 && typeof o.principal === "string" && typeof o.sublayer === "string" &&
      (o.principalSid === null || typeof o.principalSid === "string")) {
      return { version: 2, ownerSid: o.ownerSid, members: [{ principal: o.principal, principalSid: o.principalSid, sublayer: o.sublayer }] };
    }
    return null;
  } catch {
    return null;
  }
}

/** Whether `setup` may proceed: a marker owned by another user refuses, even with `--force` (ruling 3).
 *  A missing or corrupt marker never blocks a fresh setup. */
export function markerAllowsSetup(marker: InstallMarker | null, ownerSid: string): { ok: true } | { ok: false; reason: string } {
  if (marker === null) return { ok: true };
  if (marker.ownerSid !== ownerSid) return { ok: false, reason: "Bash is set up for another user; that user must run `clover-core sandbox remove` first" };
  return { ok: true };
}

/** Whether `remove` may proceed: the marker must belong to this owner (ruling 3). Every pool member
 *  is the caller's own by construction; a missing marker means nothing was set up here. */
export function markerAllowsRemove(marker: InstallMarker | null, ownerSid: string): { ok: true } | { ok: false; reason: string } {
  if (marker === null) return { ok: true };
  if (marker.ownerSid !== ownerSid) {
    return { ok: false, reason: "the install belongs to another user" };
  }
  return { ok: true };
}

/** Where a principal's OS lock lives: `<leases>\<principal>.lock`. One file per pool member.
 *  The file's CONTENT is meaningless (created empty on first lock) — the kernel's byte-range
 *  lock on it is the lease. */
export function poolLockPath(leasesDir: string, principal: string): string {
  return win32.join(leasesDir, `${principal}.lock`);
}

/** Where pool leases live: `<home>\sandbox\leases\`, writable by the daemon's user. */
export function sandboxLeasesDir(cloverHome: string): string {
  return win32.join(cloverHome, "sandbox", "leases");
}

/** An OS lock guard: the open HANDLE whose kernel lock is the lease. `release()` unlocks and
 *  closes; it is idempotent. The caller must hold the guard for the whole launch. */
export interface PoolLockGuard {
  release(): void;
}

/** Storage the lease manager needs; injected so unit tests run without disks or processes.
 *  The production implementation is [`createWindowsLockStore`]; tests use an in-memory fake
 *  with the same semantics (exclusive, fail-immediately, freed on release). */
export interface LeaseStore {
  /** Open (creating) `lockPath` and take its exclusive lock WITHOUT waiting: the guard on
   *  success, `null` when another holder owns it. Never throws for a busy lock. */
  tryLock(lockPath: string): PoolLockGuard | null;
}

/** Acquire one pool principal exclusively (controller ruling 3): the first member whose lock
 *  succeeds wins. The OS frees a dead holder's lock when its handles close, so there is no
 *  staleness, no PID, no start time and no takeover. When every member is locked, waits until
 *  `timeoutMs` and then refuses instead of sharing a principal. The returned `release`
 *  unlocks and closes the HANDLE; call it at launch end (it is idempotent, and process exit
 *  frees the lock either way).
 *
 *  Daemon wiring: no Windows Bash spawn exists in the daemon yet (`execArgs` / `sessionGrantArgs`
 *  are built and unit-tested here but no production caller passes them to a child process), so no
 *  production `LeaseStore` is constructed yet either. The first daemon caller — the lane that
 *  introduces the Windows Bash tool spawn — builds one `createWindowsLockStore` over
 *  `sandboxLeasesDir(cloverHome)`, acquires per launch, and holds `release` for the session.
 *  Until then the lease is measured by unit tests (in-memory fake with OS semantics) plus a
 *  `bun:ffi` kernel32 race on the VM. */
export async function acquirePoolLease(o: {
  store: LeaseStore;
  leasesDir: string;
  pool: readonly { principal: string }[];
  timeoutMs: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{ ok: true; principal: string; release: () => void } | { ok: false; reason: string }> {
  const pollMs = o.pollMs ?? 250;
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + o.timeoutMs;
  for (;;) {
    for (const member of o.pool) {
      let guard: PoolLockGuard | null = null;
      try {
        guard = o.store.tryLock(poolLockPath(o.leasesDir, member.principal));
      } catch {
        guard = null;
      }
      if (guard !== null) {
        const g = guard;
        let released = false;
        return {
          ok: true,
          principal: member.principal,
          release: () => {
            if (released) return;
            released = true;
            try {
              g.release();
            } catch { /* process exit frees the lock either way */ }
          },
        };
      }
    }
    if (now() >= deadline) {
      return { ok: false, reason: "the sandbox pool is busy; all 4 principals are leased" };
    }
    await sleep(pollMs);
  }
}

/** kernel32, loaded lazily so importing this module on any other OS never touches Windows DLLs. */
let kernel32: ReturnType<typeof loadKernel32> | undefined;
function loadKernel32() {
  // HANDLEs cross as u64 (bigints): a `ptr` return is a 53-bit JS number and would corrupt
  // addresses with high bits set (same reason as `keychain-ffi.ts`). `ptr` is kept only for
  // memory this process owns (the path string, the OVERLAPPED region).
  const H = FFIType.u64;
  // Win32 BOOL is a 4-byte int: declared as i32 and tested for nonzero, never as a
  // 1-byte FFI bool (which would misread the ABI).
  const B = FFIType.i32;
  return dlopen("kernel32.dll", {
    CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: H },
    LockFileEx: { args: [H, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr], returns: B },
    UnlockFileEx: { args: [H, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr], returns: B },
    CloseHandle: { args: [H], returns: B },
  }).symbols;
}
function K32(): ReturnType<typeof loadKernel32> {
  if (process.platform !== "win32") throw new Error("the Windows lock store runs on Windows only");
  kernel32 ??= loadKernel32();
  return kernel32;
}

const INVALID_HANDLE_VALUE = 0xffffffffffffffffn;
const GENERIC_READ_WRITE = 0xc0000000;
const FILE_SHARE_READ = 0x1;
const FILE_SHARE_WRITE = 0x2;
/** No FILE_SHARE_DELETE: while any handle is open, the lock file can be neither deleted nor
 *  renamed. With DELETE sharing, a contender could remove the held file and lock a fresh file
 *  at the same path — two holders for one principal. */
const FILE_SHARE_LOCK = FILE_SHARE_READ | FILE_SHARE_WRITE;
const OPEN_ALWAYS = 4;
const FILE_ATTRIBUTE_NORMAL = 0x80;
/** `LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY`. */
const LOCK_EXCLUSIVE_IMMEDIATE = 0x3;

/** Well-known SIDs for the leases-dir check: Administrators and SYSTEM. */
const ADMINISTRATORS_SID = "S-1-5-32-544";
const SYSTEM_SID = "S-1-5-18";

/** A Windows OS-lock store over a leases dir: `tryLock` opens (creating) `<leases>\<principal>.lock`
 *  with read/write sharing (never delete sharing) and takes a 1-byte exclusive, fail-immediate
 *  `LockFileEx` on it. The guard keeps the HANDLE open — the lock IS the open handle — so the
 *  caller must hold it for the whole launch and call `release()` (unlock + close) at the end.
 *  When the holder process dies, the OS closes its handles and the lock frees immediately: no
 *  staleness, no PIDs, no takeover. Any other locker (another process, or another handle in this
 *  one) fails immediately while held.
 *
 *  The leases dir itself must be trustworthy: when it sits outside the user's profile (where the
 *  profile's own ACL no longer protects it), it must carry an owner-only ACL — owned by the user,
 *  Administrators or SYSTEM, with allow entries for nobody else — and the store refuses to open
 *  it otherwise, so a squatted or over-shared directory fails closed instead of handing out
 *  principals nobody owns. */
export function createWindowsLockStore(leasesDir: string): LeaseStore {
  if (process.platform !== "win32") throw new Error("the Windows lock store runs on Windows only");
  mkdirSync(leasesDir, { recursive: true });
  const problem = leasesDirAccessProblem(leasesDir, {
    profileRoot: process.env.USERPROFILE ?? null,
    security: readLeasesDirSecurity(leasesDir),
  });
  if (problem !== null) throw new Error(`refusing untrusted leases dir ${leasesDir}: ${problem}`);
  return {
    tryLock(lockPath: string): PoolLockGuard | null {
      const k = K32();
      const path = Buffer.from(`${lockPath}\0`, "utf16le");
      // `BigInt()` normalises the u64 return either way; INVALID_HANDLE_VALUE never validates.
      const handle = BigInt(k.CreateFileW(path, GENERIC_READ_WRITE, FILE_SHARE_LOCK, null, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, null) as never);
      if (handle === INVALID_HANDLE_VALUE) return null;
      // OVERLAPPED, zeroed: lock 1 byte at offset 0. hEvent NULL + FAIL_IMMEDIATELY never waits.
      const region = new Uint8Array(32);
      let locked = false;
      try {
        locked = (k.LockFileEx(handle, LOCK_EXCLUSIVE_IMMEDIATE, 0, 1, 0, region) as unknown as number) !== 0;
      } catch {
        locked = false;
      }
      if (!locked) {
        try {
          k.CloseHandle(handle);
        } catch { /* ignore */ }
        return null;
      }
      let released = false;
      return {
        release(): void {
          if (released) return;
          released = true;
          try {
            k.UnlockFileEx(handle, 0, 1, 0, new Uint8Array(32));
          } catch { /* ignore */ }
          try {
            k.CloseHandle(handle);
          } catch { /* ignore */ }
        },
      };
    },
  };
}

/** The trust inputs for a leases dir: who runs, who owns it, and whom it lets in. */
export interface LeasesDirSecurity {
  readonly userSid: string;
  readonly ownerSid: string;
  readonly allows: readonly { readonly sid: string; readonly allow: boolean }[];
}

/** Read the trust inputs for `leasesDir` on Windows (current user SID, owner SID, allow ACEs
 *  with identities normalised to SIDs); null when they cannot be read. One PowerShell call. */
export function readLeasesDirSecurity(leasesDir: string): LeasesDirSecurity | null {
  try {
    const script = [
      "$ProgressPreference='SilentlyContinue'",
      `$p='${leasesDir.replace(/'/g, "''")}'`,
      "$user=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
      "$a=Get-Acl -LiteralPath $p",
      "$toSid={param($id) try { (New-Object System.Security.Principal.NTAccount $id).Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { $id } }",
      "$owner=& $toSid $a.Owner",
      "$allows=@($a.Access | ForEach-Object { @{ sid=(& $toSid $_.IdentityReference.Value); allow=($_.AccessControlType.ToString() -eq 'Allow') } })",
      "@{ userSid=$user; ownerSid=$owner; allows=$allows } | ConvertTo-Json -Compress -Depth 4",
    ].join("; ");
    const out = execFileSync("powershell", ["-NoProfile", "-NoLogo", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
    }) as string;
    const o = JSON.parse(out) as { userSid?: unknown; ownerSid?: unknown; allows?: unknown };
    if (typeof o.userSid !== "string" || typeof o.ownerSid !== "string" || !Array.isArray(o.allows)) return null;
    const allows: { sid: string; allow: boolean }[] = [];
    for (const e of o.allows as Record<string, unknown>[]) {
      if (typeof e !== "object" || e === null || typeof e.sid !== "string" || typeof e.allow !== "boolean") return null;
      allows.push({ sid: e.sid, allow: e.allow });
    }
    return { userSid: o.userSid, ownerSid: o.ownerSid, allows };
  } catch {
    return null;
  }
}

/** Whether `child` sits at or under `dir` (Windows casing and separators). */
function isPathUnderDir(child: string, dir: string): boolean {
  const c = win32.normalize(child).toUpperCase();
  const d = win32.normalize(dir).toUpperCase();
  return c === d || c.startsWith(d.endsWith("\\") ? d : `${d}\\`);
}

/** Why `leasesDir` cannot be trusted, or null when it can. Inside the user's profile the profile's
 *  own ACL protects it and nothing is checked. Outside, the dir must be owner-only — owned by the
 *  user, Administrators or SYSTEM, with allow entries for nobody else (inherited or not) — and an
 *  unreadable ACL refuses too, fail closed. Pure: tests inject every input. */
export function leasesDirAccessProblem(
  leasesDir: string,
  o: { profileRoot?: string | null; security?: LeasesDirSecurity | null },
): string | null {
  if (o.profileRoot !== undefined && o.profileRoot !== null && isPathUnderDir(leasesDir, o.profileRoot)) return null;
  const s = o.security ?? null;
  if (s === null) return "its access control could not be read";
  if (s.ownerSid !== s.userSid && s.ownerSid !== ADMINISTRATORS_SID && s.ownerSid !== SYSTEM_SID) {
    return `it is owned by ${s.ownerSid}, not the user, Administrators or SYSTEM`;
  }
  const trusted = new Set([s.ownerSid, ADMINISTRATORS_SID, SYSTEM_SID]);
  const foreign = s.allows.filter((a) => a.allow && !trusted.has(a.sid)).map((a) => a.sid);
  if (foreign.length > 0) return `it grants access to ${[...new Set(foreign)].join(", ")}`;
  return null;
}

/** `icacls <path> /deny *<sid>:(OI)(CI)F`: the principal can't write the Startup folder or its children.
 *  The `*` prefix marks the trustee as a SID: without it icacls reads the SID as an account name and
 *  fails with "no mapping between account names and security IDs" (0x534). */
export function icaclsDenyArgs(path: string, sid: string): readonly string[] {
  return ["icacls", path, "/deny", `*${sid}:(OI)(CI)F`];
}

/** `icacls <path> /deny *<sid>:(D)`: object-only DELETE deny, so the memory folder can't be deleted or moved
 *  (a rename needs DELETE). It leaves the folder's children alone, so the owner's write grant still works. */
export function icaclsDeleteDenyArgs(path: string, sid: string): readonly string[] {
  return ["icacls", path, "/deny", `*${sid}:(D)`];
}

/** `icacls <path> /remove:d *<sid>`: undo a deny `sandbox remove` put there. */
export function icaclsRemoveDenyArgs(path: string, sid: string): readonly string[] {
  return ["icacls", path, "/remove:d", `*${sid}`];
}

/** `powershell New-Item`: create a folder, parents included, succeeding when it already exists. cmd's
 *  `mkdir` is avoided: under `Bun.spawn` its `/c` quoting breaks on spaced paths ("The filename, directory
 *  name, or volume label syntax is incorrect"); the encoded script keeps every path inert. */
export function mkdirArgs(path: string): readonly string[] {
  return psEncodedArgs(`New-Item -ItemType Directory -Force -Path "${path}" | Out-Null`);
}

/** Claim a state dir for admins only (ruling 5: markers folder, as lane M does for the protected
 *  copy). Creates it when missing, then: resolve the owner's SID (locale-proof, never a name match);
 *  anyone besides Administrators, SYSTEM or TrustedInstaller is refused with exit 1 (a squatted
 *  folder owned by a non-admin fails the setup closed); otherwise take ownership for Administrators
 *  and strip inheritance, granting full control to Administrators and SYSTEM only. */
export function claimDirArgs(path: string): readonly string[] {
  const script = [
    "$ErrorActionPreference='Stop'",
    `$p='${path.replace(/'/g, "''")}'`,
    "if (-Not (Test-Path -LiteralPath $p)) { New-Item -ItemType Directory -Force -Path $p | Out-Null }",
    "$own=(Get-Acl -LiteralPath $p).Owner",
    "try { $sid=(New-Object System.Security.Principal.NTAccount $own).Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { $sid='' }",
    "if ($sid -ne 'S-1-5-32-544' -and $sid -ne 'S-1-5-18' -and $sid -ne 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464') { Write-Error ('refusing state dir owned by ' + $own); exit 1 }",
    "& takeown.exe /f $p /a | Out-Null; if ($LASTEXITCODE -ne 0) { exit 1 }",
    "& icacls.exe $p /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' | Out-Null; if ($LASTEXITCODE -ne 0) { exit 1 }",
  ].join("; ");
  return psEncodedArgs(script);
}

/** `powershell Remove-Item`: remove a folder tree. The encoded script keeps the path inert. */
export function removeDirArgs(path: string): readonly string[] {
  return psEncodedArgs(`Remove-Item -Recurse -Force -Path "${path}"`);
}

/** A step of setup/remove: its argv, optional stdin, and whether its failure fails the whole run. */
export interface SandboxStep {
  readonly name: string;
  readonly argv: readonly string[];
  readonly stdin?: string;
  /** When false, a failure is tolerated (a thing that may already be absent). */
  readonly required: boolean;
}

/** Removing the principal's profile and hive (spec item 1116): unload the hive, remove the ProfileList key
 *  and the profile folder, and any leftover `C:\Users\clover-sandbox*` folder. Every step that matters is
 *  Required: anything left behind fails the next launch closed. */
export function principalResetPlan(o: {
  sid: string;
  profileRoot: string;
  usersRoot?: string;
  principalPrefix?: string;
}): readonly SandboxStep[] {
  const profileKey = `HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\${o.sid}`;
  const users = o.usersRoot ?? "C:\\Users";
  // Scoped to the caller's own prefix (ruling 3): never match another user's `clover-sb-*` folder.
  // Callers pass their own `principalNameFromSid(ownerSid)`; the bare prefix is not a valid scope.
  const prefix = o.principalPrefix ?? SANDBOX_PRINCIPAL_PREFIX;
  return [
    { name: "unload-hive", argv: ["reg", "unload", `HKU\\${o.sid}`], required: false },
    { name: "remove-profile-key", argv: ["reg", "delete", profileKey, "/f"], required: true },
    { name: "remove-profile-dir", argv: removeDirArgs(o.profileRoot), required: true },
    { name: "remove-leftover-dirs", argv: psEncodedArgs(
      `Get-ChildItem -Directory -Path "${users}" -Filter "${prefix}*" -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue`), required: false },
  ];
}

/** The per-launch reset: the same removal, run before every command so nothing a command wrote carries over.
 *  A temporary profile fails the launch closed (`isTemporaryProfile`). */
export function sessionResetPlan(o: { sid: string; profileRoot: string; usersRoot?: string }): readonly SandboxStep[] {
  return principalResetPlan(o);
}

/** Setup's profile work, in order (brief item 5): remove an earlier principal's profile by SID and any
 *  leftover folder, install, warm up, resolve the profile by SID, then create and deny the Startup folder. */
export function setupProfileSteps(o: {
  launcher: string;
  sid: string;
  profileRoot: string;
  realUserProfile: string;
  commonStartup: string;
  systemRoot: string;
}): readonly SandboxStep[] {
  const startup = startupFolders({ profileRoot: o.profileRoot, realUserProfile: o.realUserProfile, commonStartup: o.commonStartup });
  return [
    { name: "warm-up", argv: warmUpArgs({ launcher: o.launcher, systemRoot: o.systemRoot }), required: true },
    { name: "create-startup", argv: mkdirArgs(startup[0]!), required: true },
    ...startup.map((path, i) => ({ name: `deny-startup-${i}`, argv: icaclsDenyArgs(path, o.sid), required: true })),
  ];
}

/** The status verdict. `launcher`/`user`/`wfp`/`profile` are what the OS reports; `ready` is the single
 *  answer the installer and the Bash door read. */
export interface SandboxStatus {
  readonly launcher: { present: boolean; pinned: boolean; arch: SrtWinArch };
  readonly user: SrtUserStatus | null;
  readonly wfp: SrtWfpStatus | null;
  readonly profile: { sid: string; path: string; temporary: boolean } | null;
  readonly ready: boolean;
  readonly reason: string | null;
  /** 0 ready; 3 the launcher is missing or isn't the pinned one; 1 anything else. */
  readonly exit: number;
  readonly raw: unknown;
}

/** The sandbox user's provisioning state, as `srt-win user status` / `status` report it. */
export interface SrtUserStatus {
  readonly exists: boolean;
  readonly sid?: string;
  readonly markerVersion?: string | null;
  readonly setupVersion?: string;
  readonly ownerSid?: string | null;
  readonly seclogon?: string;
  readonly credPresent?: boolean;
  readonly hiddenFromLogon?: boolean;
  readonly inBuiltinUsers?: boolean;
  readonly inSandboxGroup?: boolean;
}

/** The WFP filters under Clover's sublayer, as `srt-win status` reports them. */
export interface SrtWfpStatus {
  readonly state: string;
  readonly filters: number;
  readonly allowLoopback: boolean;
  readonly userSid?: string;
}

function stringField(o: Record<string, unknown>, k: string): string | undefined {
  return typeof o[k] === "string" ? (o[k] as string) : undefined;
}

function versionField(o: Record<string, unknown>, k: string): string | undefined {
  const v = o[k];
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return undefined;
}

function parseUser(raw: unknown): SrtUserStatus | null {
  if (raw === null || typeof raw !== "object") return null;
  const u = raw as Record<string, unknown>;
  // The real shape nests the account under `user.user`: the outer object carries the install state
  // (`marker_version`, `setup_version`, `seclogon`, `cred_present`) while the inner one carries the
  // account (`exists`, `sid`, `hidden_from_logon`, `in_builtin_users`, `in_sandbox_group`). Read both.
  const n = u.user !== null && typeof u.user === "object" ? (u.user as Record<string, unknown>) : undefined;
  const pick = (k: string): unknown => (n !== undefined && n[k] !== undefined ? n[k] : u[k]);
  const pickStr = (k: string): string | undefined => {
    const v = pick(k);
    return typeof v === "string" ? v : undefined;
  };
  const pickBool = (k: string): boolean | undefined => {
    const v = pick(k);
    return typeof v === "boolean" ? v : undefined;
  };
  const markerRaw = u.marker_version;
  // `owner_sid` rides top-level on the user-status object (null when
  // absent): an existing principal with no recorded owner is refused
  // by the caller, never adopted.
  const hasOwnerField = Object.prototype.hasOwnProperty.call(u, "owner_sid");
  const ownerSid = hasOwnerField ? (typeof u.owner_sid === "string" ? u.owner_sid : null) : undefined;
  return {
    exists: pick("exists") === true,
    ...(pickStr("sid") !== undefined ? { sid: pickStr("sid") } : {}),
    ...(markerRaw === null || typeof markerRaw === "string" || typeof markerRaw === "number"
      ? { markerVersion: markerRaw === null ? null : String(markerRaw) }
      : {}),
    ...(versionField(u, "setup_version") !== undefined ? { setupVersion: versionField(u, "setup_version") } : {}),
    ...(ownerSid !== undefined ? { ownerSid } : {}),
    ...(pickStr("seclogon") !== undefined ? { seclogon: pickStr("seclogon") } : {}),
    ...(pickBool("cred_present") !== undefined ? { credPresent: pickBool("cred_present") } : {}),
    ...(pickBool("hidden_from_logon") !== undefined ? { hiddenFromLogon: pickBool("hidden_from_logon") } : {}),
    ...(pickBool("in_builtin_users") !== undefined ? { inBuiltinUsers: pickBool("in_builtin_users") } : {}),
    ...(pickBool("in_sandbox_group") !== undefined ? { inSandboxGroup: pickBool("in_sandbox_group") } : {}),
  };
}

function parseWfp(raw: unknown): SrtWfpStatus | null {
  if (raw === null || typeof raw !== "object") return null;
  const w = raw as Record<string, unknown>;
  return {
    state: stringField(w, "state") ?? "unknown",
    filters: typeof w.filters === "number" ? w.filters : 0,
    allowLoopback: w.allow_loopback === true,
    ...(stringField(w, "user_sid") !== undefined ? { userSid: stringField(w, "user_sid") } : {}),
  };
}

/** Parse `srt-win status` stdout (`{user, wfp}`) into a readiness verdict. Defensive: any shape it doesn't
 *  recognize is not ready, never ready. `profile` is the resolved `ProfileList` entry (null when the caller
 *  could not read it); `profileChecked` says whether the caller looked. */
export function parseSrtStatus(
  stdout: string,
  o: {
    launcher: string;
    arch?: SrtWinArch;
    pins?: Readonly<Record<SrtWinArch, string>>;
    profile?: { sid: string; path: string } | null;
    profileChecked?: boolean;
  },
): SandboxStatus {
  const arch = o.arch ?? srtWinArch();
  const problem = launcherProblem(o.launcher, arch, o.pins ?? SRT_WIN_PINS);
  const launcher = { present: launcherDigest(o.launcher).present, pinned: problem === null, arch };
  let raw: unknown = null;
  try { raw = JSON.parse(stdout); } catch { /* not JSON: not ready */ }
  const obj = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  const user = obj ? parseUser(obj.user) : null;
  const wfp = obj ? parseWfp(obj.wfp) : null;
  const profile = o.profile === undefined || o.profile === null
    ? null
    : { sid: o.profile.sid, path: o.profile.path, temporary: isTemporaryProfile(o.profile.path) };
  const base = { launcher, user, wfp, profile, raw };
  const no = (reason: string, exit: number): SandboxStatus => ({ ...base, ready: false, reason, exit });
  if (problem !== null) return no(problem, SANDBOX_EXIT.HASH_MISMATCH);
  if (user === null || !user.exists) return no("Bash isn't set up yet", SANDBOX_EXIT.FAILED);
  if (user.setupVersion === undefined || user.markerVersion !== user.setupVersion)
    return no("the install is from another launcher build; set it up again", SANDBOX_EXIT.FAILED);
  if (typeof user.ownerSid !== "string") return no("the principal has no recorded owner; set it up again", SANDBOX_EXIT.FAILED);
  if (user.credPresent === false) return no("the principal's credential is missing; set it up again", SANDBOX_EXIT.FAILED);
  if (user.hiddenFromLogon === false) return no("the principal is visible at logon; set it up again", SANDBOX_EXIT.FAILED);
  if (user.seclogon !== undefined && user.seclogon !== "ok") return no("Secondary Logon isn't running", SANDBOX_EXIT.FAILED);
  if (wfp === null || wfp.state !== "installed") return no("the network filters aren't installed", SANDBOX_EXIT.FAILED);
  if (wfp.allowLoopback) return no("the network filters open loopback; set it up again", SANDBOX_EXIT.FAILED);
  if (user.sid !== undefined && wfp.userSid !== undefined && wfp.userSid !== user.sid)
    return no("the network filters belong to another principal; set it up again", SANDBOX_EXIT.FAILED);
  if (o.profileChecked === true) {
    if (profile === null) return no("the principal's profile isn't resolved by its SID", SANDBOX_EXIT.FAILED);
    if (profile.temporary) return no("the principal is running on a temporary profile; set it up again", SANDBOX_EXIT.FAILED);
  }
  return { ...base, ready: true, reason: null, exit: SANDBOX_EXIT.OK };
}

/** The refusal when the principal or its filters are missing: Bash never runs without the fence. */
export function setupBashRefusal(reason: string | null): string {
  const why = reason ? `${reason}. ` : "";
  return `${why}Bash isn't set up under Clover's fence on this computer yet. Set up Bash: run \`clover-core sandbox setup\` as administrator.`;
}

/** Whether `net session` (admin-only) succeeded: the elevation check for `setup` and `remove`. */
export function elevatedFromNetSession(ok: boolean): boolean {
  return ok;
}

export const NET_SESSION_PROBE: readonly string[] = ["net", "session"];

/** Map `srt-win install`'s exit to `sandbox setup`'s: 10 UAC cancelled, 13 set up differently (remove first,
 *  unless the caller passes `--force`), 14 provisioning failed. */
export function setupExitMessage(code: number): string | null {
  switch (code) {
    case 0: return null;
    case 10: return "the elevation prompt was cancelled; run `clover-core sandbox setup` as administrator";
    case 13: return "Bash is set up differently (another port range, loopback mode or principal); run `clover-core sandbox remove` first, or pass `--force`";
    case 14: return "the sandbox principal couldn't be provisioned";
    default: return `setup failed (exit ${code})`;
  }
}

/** The caller's own places, under the Clover home, that Addendum 3 opens: `outputs\<session>`,
 *  `scratch\<bot>`, `routines\<bot>` and `plugin-data\<id>` (read and write), the owning bot's
 *  `bots\<x>` (read) and its `bots\<x>\memory` (read and write). Matches `ownFoldersOf` exactly as
 *  the macOS and Linux sandboxes do; the sessions-runtime store stays denied, even the caller's own
 *  file (the core reads it for the session, runners never do). */
export interface WinCallerRules {
  readonly denyRead: string[];
  readonly denyWrite: string[];
  readonly grantRead: string[];
  readonly grantWrite: string[];
  /** The memory folders no caller may delete or move (an object-only DELETE deny). */
  readonly protectDelete: string[];
  readonly ownMemory: string | null;
}

/** What a caller may reach in the Clover home. The home is default-deny for reads and writes (Addendum 3);
 *  the only allows are the caller's own session output, its bot's scratch and routines, its own plugin
 *  data, its bot's folder (read) and its bot's memory (read and write). Every other session's and bot's
 *  folder is denied explicitly, so a grant another session holds can't be read from this one. `entries`
 *  is the disk (tests pass a fake). The grants mirror `ownFoldersOf` exactly, so `policyAllows` over a
 *  policy built from them agrees with the fence's `check` (see the equivalence test). */
export function winCallerRules(o: {
  cloverHome: string;
  caller: Caller;
  bots: readonly string[];
  entries?: (dir: string) => readonly string[];
}): WinCallerRules {
  const ctx = fenceContextFor(o.caller);
  const raw: CallerPlaces = callerPlaces(o.cloverHome, "windows", ctx);
  // `callerPlaces` joins POSIX-style; the Windows fence compares and emits win32 paths.
  const N = (p: string | null): string | null => (p === null ? null : win32.normalize(p));
  const botsDir = win32.normalize(raw.bots);
  const runtimeDir = win32.normalize(raw.runtime);
  const ownBot = N(raw.ownBot);
  const ownMemory = N(raw.ownMemory);
  const ownOutputs = N(raw.ownOutputs);
  const ownScratch = N(raw.ownScratch);
  const ownRoutines = N(raw.ownRoutines);
  const ownPluginData = N(raw.ownPluginData);
  const entries = o.entries ?? (() => []);
  const fold = (s: string) => s.toUpperCase();
  const outputs = win32.join(o.cloverHome, "outputs");
  const scratch = win32.join(o.cloverHome, "scratch");

  // The home itself: default-deny, both ways.
  const denyRead: string[] = [o.cloverHome];
  const denyWrite: string[] = [o.cloverHome];
  const grantRead: string[] = [];
  const grantWrite: string[] = [];
  const protectDelete: string[] = [];

  // Every bot folder: write-denied to all; read-denied to all but its own bot. The memory folder itself is
  // never deletable or movable, by its own bot either.
  for (const x of o.bots) {
    const folder = win32.join(botsDir, x);
    const memory = win32.join(folder, "memory");
    protectDelete.push(memory);
    if (ownBot !== null && fold(folder) === fold(ownBot)) {
      denyWrite.push(folder);
      grantRead.push(folder);
      continue;
    }
    denyRead.push(folder);
    denyWrite.push(folder);
  }
  // Every other session's outputs and every other bot's scratch: denied explicitly, so a grant another
  // session holds can't be read from this one.
  for (const name of entries(outputs)) {
    const p = win32.join(outputs, name);
    if (ownOutputs === null || fold(p) !== fold(ownOutputs)) { denyRead.push(p); denyWrite.push(p); }
  }
  for (const name of entries(scratch)) {
    const p = win32.join(scratch, name);
    if (ownScratch === null || fold(p) !== fold(ownScratch)) { denyRead.push(p); denyWrite.push(p); }
  }
  // The caller's own ways back in (read and write), exactly `ownFoldersOf`: outputs, scratch, routines,
  // its plugin data, and memory. The bot's own folder reads (above); the runtime store stays denied.
  for (const p of [ownOutputs, ownScratch, ownRoutines, ownPluginData, ownMemory]) {
    if (p === null) continue;
    grantRead.push(p);
    grantWrite.push(p);
  }
  // The bot driver's state: hidden from every runner, its own session included.
  denyRead.push(runtimeDir);
  denyWrite.push(runtimeDir);
  return { denyRead, denyWrite, grantRead, grantWrite, protectDelete, ownMemory };
}

/** The full per-launch plan: the fence's set (deny ACEs on every fenced item, so Bash can never write the
 *  fenced set) plus Addendum 3's home default-deny and the caller's own allows. */
export function winLaunchPlan(o: {
  policy: SandboxPolicy;
  cloverHome: string;
  caller: Caller;
  bots: readonly string[];
  entries?: (dir: string) => readonly string[];
}): WinCallerRules {
  const caller = winCallerRules(o);
  const uniq = (paths: readonly string[]) => [...new Set(paths)];
  return {
    ...caller,
    denyRead: uniq([...o.policy.denyRead, ...caller.denyRead]),
    denyWrite: uniq([...o.policy.denyWrite, ...caller.denyWrite]),
  };
}

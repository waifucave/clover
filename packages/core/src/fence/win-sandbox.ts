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
import { callerPlaces } from "./per-caller";
import type { CallerPlaces } from "./per-caller";
import type { SandboxPolicy } from "../contracts/fence";
import type { FenceCaller } from "./per-caller";
import { botSegment } from "../sessions/ids";
import { SRT_WIN_PINS, launcherDigest, launcherProblem, srtWinArch, srtWinPath, type SrtWinArch } from "./windows-launcher";

/** The protected copy location for elevated sandbox commands, per user SID.
 *  Uses `[Environment]::GetFolderPath("ProgramFiles")` to find Program Files.
 *  Path: `%ProgramFiles%\Clover Sandbox\<user SID>\clover-core.exe` */
export async function protectedCopyPath(): Promise<string> {
  const { execSync } = await import("node:child_process");
  const ps = `
    Add-Type -AssemblyName System.Environment
    $pf = [Environment]::GetFolderPath("ProgramFiles")
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    Write-Output "${pf}\\Clover Sandbox\\$sid\\clover-core.exe"
  `.trim();
  const out = execSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" });
  return out.trim();
}

/** Whether the current process is running from the protected copy location. */
export async function isProtectedCopy(execPath: string = process.execPath): Promise<boolean> {
  const protectedPath = await protectedCopyPath();
  return win32.normalize(execPath).toUpperCase() === win32.normalize(protectedPath).toUpperCase();
}

export { SRT_WIN_PINS, launcherPinned, authenticodeDigest, srtWinArch, srtWinPath, launcherProblem, launcherDigest, type SrtWinArch } from "./windows-launcher";

/** The base prefix for the sandbox principal (Addendum 9). Windows account names are capped at 20
 *  characters, so we use `clover-sb-` (9 chars) + 8 hex chars of SHA-256(SID) = 18 chars total. */
export const SANDBOX_PRINCIPAL_PREFIX = "clover-sb-";

/** The dedicated sandbox principal base name (for tests and as a prefix).
 *  The actual per-user principal is `clover-sb-` + first 8 hex chars of SHA-256(user SID). */
export function sandboxPrincipal(): string {
  return SANDBOX_PRINCIPAL_PREFIX;
}

/** Compute the per-user principal name from a Windows SID (Addendum 9).
 *  Returns `clover-sb-` + first 8 hex characters of SHA-256(SID).
 *  This is a pure function for testing; the live version uses the current user's SID. */
export function principalNameFromSid(sid: string): string {
  const { createHash } = require("node:crypto");
  const hash = createHash("sha256").update(sid).digest("hex");
  return `${SANDBOX_PRINCIPAL_PREFIX}${hash.slice(0, 8)}`;
}

/** The full principal name for the current user (Addendum 9).
 *  Uses `clover-sb-` + first 8 hex chars of SHA-256(current user's SID).
 *  The full SID is stored in the principal's description field and verified on status/remove. */
export async function currentSandboxPrincipal(): Promise<string> {
  const { execSync } = await import("node:child_process");
  const ps = `
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($sid)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $hash = $sha.ComputeHash($bytes)
    $hex = [BitConverter]::ToString($hash).Replace("-", "").ToLower()
    $short = $hex.Substring(0, 8)
    Write-Output "clover-sb-$short"
  `.trim();
  const out = execSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" });
  return String(out).trim();
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
 *  Loopback stays closed (the default): Bash gets no network, as on macOS and Linux. */
export function setupArgs(launcher: string, sublayer: string = CLOVER_WFP_SUBLAYER, principal: string = sandboxPrincipal()): readonly string[] {
  return [launcher, "install", "--sandbox-user", principal, "--sublayer-guid", sublayer];
}

/** `srt-win uninstall`: undoes everything (`--keep-user` is never passed: remove removes all of it).
 *  Exits 0 when nothing is left. */
export function removeArgs(launcher: string, sublayer: string = CLOVER_WFP_SUBLAYER, principal: string = sandboxPrincipal()): readonly string[] {
  return [launcher, "uninstall", "--sandbox-user", principal, "--sublayer-guid", sublayer];
}

/** `srt-win status`: one line of JSON `{user, wfp}`; never elevates. */
export function statusArgs(launcher: string, sublayer: string = CLOVER_WFP_SUBLAYER, principal: string = sandboxPrincipal()): readonly string[] {
  return [launcher, "status", "--sublayer-guid", sublayer];
}

/** `srt-win user status`: the principal's provisioning state, one object of JSON; never elevates. */
export const USER_STATUS_ARGS: readonly string[] = ["user", "status"];

/** `srt-win exec`: launch a command as the principal. `--write-restricted-token` is the brief's token;
 *  `--deny-read`/`--deny-write` are the per-launch fence; `--held-by` ties the command to the daemon so
 *  it ends with it. `--quiet` keeps broker chatter off the command's stderr. */
export function execArgs(o: {
  launcher: string;
  shell: readonly string[];
  denyRead: readonly string[];
  denyWrite: readonly string[];
  env?: Readonly<Record<string, string>>;
  heldBy?: number;
}): readonly string[] {
  const a: string[] = [o.launcher, "exec", "--quiet", "--write-restricted-token"];
  for (const p of o.denyRead) a.push("--deny-read", p);
  for (const p of o.denyWrite) a.push("--deny-write", p);
  if (o.heldBy !== undefined) a.push("--held-by", String(o.heldBy));
  for (const [k, v] of Object.entries(o.env ?? {})) a.push("--env", `${k}=${v}`);
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

/** A warm-up launch: the principal's first logon creates its profile. Nothing is written. */
export function warmUpArgs(o: { launcher: string; systemRoot: string }): readonly string[] {
  return [o.launcher, "exec", "--quiet", "--", win32.join(o.systemRoot, "System32", "cmd.exe"), "/d", "/s", "/c", "exit 0"];
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

/** The three Startup folders the fence denies the principal: its own, the real user's and all users'. */
export function startupFolders(o: { profileRoot: string; realUserProfile: string; commonStartup: string }): readonly string[] {
  const under = (root: string) => win32.join(root, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
  return [under(o.profileRoot), under(o.realUserProfile), o.commonStartup];
}

/** `icacls <path> /deny <sid>:(OI)(CI)F`: the principal can't write the Startup folder or its children. */
export function icaclsDenyArgs(path: string, sid: string): readonly string[] {
  return ["icacls", path, "/deny", `${sid}:(OI)(CI)F`];
}

/** `icacls <path> /deny <sid>:(D)`: object-only DELETE deny, so the memory folder can't be deleted or moved
 *  (a rename needs DELETE). It leaves the folder's children alone, so the owner's write grant still works. */
export function icaclsDeleteDenyArgs(path: string, sid: string): readonly string[] {
  return ["icacls", path, "/deny", `${sid}:(D)`];
}

/** `icacls <path> /remove:d <sid>`: undo a deny `sandbox remove` put there. */
export function icaclsRemoveDenyArgs(path: string, sid: string): readonly string[] {
  return ["icacls", path, "/remove:d", sid];
}

/** `mkdir` a folder without a shell (cmd's mkdir is the one Windows always has). */
export function mkdirArgs(path: string): readonly string[] {
  return ["cmd", "/d", "/s", "/c", `mkdir "${path}" 2>nul & exit 0`];
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
  const prefix = o.principalPrefix ?? sandboxPrincipal();
  return [
    { name: "unload-hive", argv: ["reg", "unload", `HKU\\${o.sid}`], required: false },
    { name: "remove-profile-key", argv: ["reg", "delete", profileKey, "/f"], required: true },
    { name: "remove-profile-dir", argv: ["cmd", "/d", "/s", "/c", `rmdir /s /q "${o.profileRoot}"`], required: true },
    { name: "remove-leftover-dirs", argv: ["cmd", "/d", "/s", "/c", `for /d %d in ("${win32.join(users, `${prefix}*`)}") do @rmdir /s /q "%d" 2>nul & exit 0`], required: false },
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

function parseUser(raw: unknown): SrtUserStatus | null {
  if (raw === null || typeof raw !== "object") return null;
  const u = raw as Record<string, unknown>;
  return {
    exists: u.exists === true,
    ...(stringField(u, "sid") !== undefined ? { sid: stringField(u, "sid") } : {}),
    ...(u.marker_version === null || typeof u.marker_version === "string" ? { markerVersion: u.marker_version as string | null } : {}),
    ...(stringField(u, "setup_version") !== undefined ? { setupVersion: stringField(u, "setup_version") } : {}),
    ...(stringField(u, "seclogon") !== undefined ? { seclogon: stringField(u, "seclogon") } : {}),
    ...(typeof u.cred_present === "boolean" ? { credPresent: u.cred_present } : {}),
    ...(typeof u.hidden_from_logon === "boolean" ? { hiddenFromLogon: u.hidden_from_logon } : {}),
    ...(typeof u.in_builtin_users === "boolean" ? { inBuiltinUsers: u.in_builtin_users } : {}),
    ...(typeof u.in_sandbox_group === "boolean" ? { inSandboxGroup: u.in_sandbox_group } : {}),
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
 *  `scratch\<bot>`, the owning bot's `bots\<x>` (read) and its `bots\<x>\memory` (read and write). */
export interface WinCallerRules {
  readonly denyRead: string[];
  readonly denyWrite: string[];
  readonly grantRead: string[];
  readonly grantWrite: string[];
  /** The memory folders no caller may delete or move (an object-only DELETE deny). */
  readonly protectDelete: string[];
  readonly ownMemory: string | null;
  readonly ownRuntime: string | null;
}

/** What a caller may reach in the Clover home. The home is default-deny for reads and writes (Addendum 3);
 *  the only allows are the caller's own session output, its bot's scratch, its bot's folder (read) and its
 *  bot's memory (read and write). Every other session's and bot's folder is denied explicitly, so a grant
 *  another session holds can't be read from this one. `entries` is the disk (tests pass a fake). */
export function winCallerRules(o: {
  cloverHome: string;
  caller: FenceCaller;
  bots: readonly string[];
  entries?: (dir: string) => readonly string[];
}): WinCallerRules {
  const places: CallerPlaces = callerPlaces(o.cloverHome, "windows", {
    ...(o.caller.sessionId !== undefined ? { sessionId: o.caller.sessionId } : {}),
    ...(o.caller.bot !== undefined ? { bot: o.caller.bot } : {}),
    ...(o.caller.botsOwnSession === true ? { botsOwnSession: true as const } : {}),
  });
  const entries = o.entries ?? (() => []);
  const fold = (s: string) => s.toUpperCase();
  const ownBot = places.ownMemory === null ? null : win32.dirname(places.ownMemory);
  const outputs = win32.join(o.cloverHome, "outputs");
  const scratch = win32.join(o.cloverHome, "scratch");
  const ownOutputs = o.caller.sessionId !== undefined ? win32.join(outputs, o.caller.sessionId) : null;
  const ownScratch = o.caller.bot !== undefined ? win32.join(scratch, botSegment(o.caller.bot)) : null;

  // The home itself: default-deny, both ways.
  const denyRead: string[] = [o.cloverHome];
  const denyWrite: string[] = [o.cloverHome];
  const grantRead: string[] = [];
  const grantWrite: string[] = [];
  const protectDelete: string[] = [];

  // Every bot folder: write-denied to all; read-denied to all but its own bot. The memory folder itself is
  // never deletable or movable, by its own bot either.
  for (const x of o.bots) {
    const folder = win32.join(places.bots, x);
    const memory = win32.join(folder, "memory");
    protectDelete.push(memory);
    if (ownBot !== null && fold(folder) === fold(ownBot)) {
      denyWrite.push(folder);
      grantRead.push(folder);
      grantWrite.push(memory);
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
  if (ownOutputs !== null) grantWrite.push(ownOutputs);
  if (ownScratch !== null) grantWrite.push(ownScratch);
  // The bot driver's state: hidden, its own file readable.
  denyRead.push(places.runtime);
  denyWrite.push(places.runtime);
  if (places.ownRuntime !== null) grantRead.push(places.ownRuntime);
  return { denyRead, denyWrite, grantRead, grantWrite, protectDelete, ownMemory: places.ownMemory, ownRuntime: places.ownRuntime };
}

/** The full per-launch plan: the fence's set (deny ACEs on every fenced item, so Bash can never write the
 *  fenced set) plus Addendum 3's home default-deny and the caller's own allows. */
export function winLaunchPlan(o: {
  policy: SandboxPolicy;
  cloverHome: string;
  caller: FenceCaller;
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

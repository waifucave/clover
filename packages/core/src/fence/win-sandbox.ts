// Windows Bash under Clover's fence (lane C, C-M2 part 2; spec §4, §9.1, items 76 and 1116, §14.1 item 2).
//
// Bots' Bash and PowerShell run as the dedicated sandbox principal `clover-sandbox` through the
// hash-pinned srt-win launcher (Apache-2.0, `anthropics/sandbox-runtime` tag `v0.0.81`, commit
// `c40cf14…`; source in `vendor/srt-win-src`, built with a static CRT by `scripts/build-srt-win.ps1`).
// Never as the user, never AppContainer, and never a network-open or unsandboxed fallback.
//
// This module is the pure half: constants, the launcher's argument shapes, its status parsing and
// the per-launch deny plan. It runs on every OS (the unit tests run on macOS); the live half —
// elevation, the install/remove/status spawns and the per-session reset — runs on Windows only,
// driven by `clover-core sandbox setup|remove|status`.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { win32 } from "node:path";
import { callerPlaces } from "./per-caller";
import type { CallerPlaces } from "./per-caller";
import type { SandboxPolicy } from "../contracts/fence";
import type { FenceCaller } from "./per-caller";

/** The dedicated sandbox principal Bash runs as: hidden, local, non-admin, never the user. */
export const SANDBOX_PRINCIPAL = "clover-sandbox";

/** Clover's WFP sublayer: the launcher's network filters live under this GUID, not its default. */
export const CLOVER_WFP_SUBLAYER = "F6D7C8CF-13C0-4547-8835-F14E27345468";

/** The pinned launcher: tag, commit and the SHA-256 of the static-CRT build lane M ships. */
export const SRT_WIN_TAG = "v0.0.81";
export const SRT_WIN_COMMIT = "c40cf14a65d025e3cd27f071f13a73c12b3b1f92";
/** Filled in from the first trusted VM build (`scripts/build-srt-win.ps1` writes it; the build
 *  script and `sandbox setup` both fail closed on a mismatch). Until then launches refuse. */
export const SRT_WIN_SHA256 = "PENDING-FIRST-TRUSTED-BUILD";

/** `sandbox setup|remove` exit codes (sent to lane M): 0 done (`setup` idempotent, `remove` exits 0
 *  when nothing is left), 2 not elevated, 3 launcher hash mismatch. Anything else is 1. */
export const SANDBOX_EXIT = { OK: 0, FAILED: 1, NOT_ELEVATED: 2, HASH_MISMATCH: 3 } as const;

/** Where the launcher lives: beside the running `clover-core` binary (lane M's installer puts it
 *  there), or `CLOVER_SRT_WIN` in dev and tests. */
export function srtWinPath(execPath: string = process.execPath, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CLOVER_SRT_WIN;
  if (override) return override;
  // Always a Windows path, whatever OS renders it (tests on macOS included).
  return win32.join(win32.dirname(execPath), "srt-win.exe");
}

/** The launcher's hash: `{ present, hash }`. Checked at build time and before every launch; a
 *  mismatch fails closed with exit 3. */
export function launcherHash(path: string): { present: boolean; hash: string | null } {
  try {
    if (!existsSync(path)) return { present: false, hash: null };
    return { present: true, hash: createHash("sha256").update(readFileSync(path)).digest("hex") };
  } catch {
    return { present: false, hash: null };
  }
}

/** Whether `path` is the pinned launcher. `true` only on an exact hash match. */
export function launcherPinned(path: string, expected: string = SRT_WIN_SHA256): boolean {
  const { present, hash } = launcherHash(path);
  return present && hash === expected;
}

/** `srt-win install`: one elevated step provisioning the principal and its WFP filters (the
 *  launcher self-elevates via UAC; idempotent — re-running rotates the password and refreshes the
 *  filters). Loopback stays closed (the default): Bash gets no network, as on macOS and Linux. */
export function setupArgs(launcher: string, sublayer: string = CLOVER_WFP_SUBLAYER): readonly string[] {
  return [launcher, "install", "--sandbox-user", SANDBOX_PRINCIPAL, "--sublayer-guid", sublayer];
}

/** `srt-win uninstall`: undoes everything (`--keep-user` is never passed: remove removes all of
 *  it). Exits 0 when nothing is left. */
export function removeArgs(launcher: string, sublayer: string = CLOVER_WFP_SUBLAYER): readonly string[] {
  return [launcher, "uninstall", "--sublayer-guid", sublayer];
}

/** `srt-win status`: one line of JSON `{user, wfp}`; never elevates. */
export function statusArgs(launcher: string, sublayer: string = CLOVER_WFP_SUBLAYER): readonly string[] {
  return [launcher, "status", "--sublayer-guid", sublayer];
}

/** The sandbox user's provisioning state, as `srt-win user status` / `status` report it. */
export interface SrtUserStatus {
  readonly exists: boolean;
  readonly sid?: string;
  readonly markerVersion?: string | null;
  readonly setupVersion?: string;
  readonly seclogon?: string;
}

/** What `sandbox status` reports. */
export interface SandboxStatus {
  readonly launcher: { present: boolean; pinned: boolean };
  readonly user: SrtUserStatus | null;
  /** Usable by this build: the principal is provisioned by it and the launch service is up. */
  readonly ready: boolean;
  readonly reason: string | null;
  readonly raw: unknown;
}

/** Parse `srt-win status` stdout (`{user, wfp}`) into a readiness verdict. Defensive: any shape it
 *  doesn't recognize is not ready, never ready. The exact `wfp` shape is pinned on the VM. */
export function parseSrtStatus(stdout: string, launcher: string, expected: string = SRT_WIN_SHA256): SandboxStatus {
  const present = launcherHash(launcher);
  let raw: unknown = null;
  try { raw = JSON.parse(stdout); } catch { /* not JSON: not ready */ }
  const user = (raw as { user?: Record<string, unknown> } | null)?.user;
  const u: SrtUserStatus | null =
    user !== null && typeof user === "object" && user !== undefined
      ? {
          exists: (user as { exists?: unknown }).exists === true,
          ...(typeof (user as { sid?: unknown }).sid === "string" ? { sid: (user as { sid: string }).sid } : {}),
          ...((user as { marker_version?: unknown }).marker_version === null ||
          typeof (user as { marker_version?: unknown }).marker_version === "string"
            ? { markerVersion: (user as { marker_version: string | null }).marker_version }
            : {}),
          ...(typeof (user as { setup_version?: unknown }).setup_version === "string"
            ? { setupVersion: (user as { setup_version: string }).setup_version }
            : {}),
          ...(typeof (user as { seclogon?: unknown }).seclogon === "string" ? { seclogon: (user as { seclogon: string }).seclogon } : {}),
        }
      : null;
  if (!present.present) return { launcher: { present: false, pinned: false }, user: u, ready: false, reason: "the launcher isn't installed", raw };
  if (!present.hash || present.hash !== expected)
    return { launcher: { present: true, pinned: false }, user: u, ready: false, reason: "the launcher's hash doesn't match the pinned build", raw };
  if (u === null || !u.exists) return { launcher: { present: true, pinned: true }, user: u, ready: false, reason: "Bash isn't set up yet", raw };
  if (u.setupVersion !== undefined && u.markerVersion !== u.setupVersion)
    return { launcher: { present: true, pinned: true }, user: u, ready: false, reason: "the install is from another launcher build; set it up again", raw };
  if (u.seclogon !== undefined && u.seclogon !== "ok")
    return { launcher: { present: true, pinned: true }, user: u, ready: false, reason: "Secondary Logon isn't running", raw };
  return { launcher: { present: true, pinned: true }, user: u, ready: true, reason: null, raw };
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

/** Map `srt-win install`'s exit to `sandbox setup`'s: 10 UAC cancelled, 13 set up differently
 *  (remove first, unless the caller passes `--force`), 14 provisioning failed. */
export function setupExitMessage(code: number): string | null {
  switch (code) {
    case 0: return null;
    case 10: return "the elevation prompt was cancelled; run `clover-core sandbox setup` as administrator";
    case 13: return "Bash is set up differently (another port range, loopback mode or principal); run `clover-core sandbox remove` first, or pass `--force`";
    case 14: return "the sandbox principal couldn't be provisioned";
    default: return `setup failed (exit ${code})`;
  }
}

/** Extra per-launch denies for the caller's memory rules (brief item 9; `per-caller.ts`): every
 *  other runner is denied all of `bots\\*\\memory`, nobody may delete or move the folder, and
 *  `sessions-runtime` shows only the caller's own state. The owning bot's own memory is granted,
 *  not denied (it travels as a session write root). */
export function winCallerDenies(o: {
  cloverHome: string;
  caller: FenceCaller;
  /** The live `bots/` folder names (lane B's `policyAllows` reference replaces this once #197 lands). */
  bots: readonly string[];
}): { denyRead: string[]; denyWrite: string[]; ownMemory: string | null; ownRuntime: string | null } {
  const places: CallerPlaces = callerPlaces(o.cloverHome, "windows", {
    ...(o.caller.sessionId !== undefined ? { sessionId: o.caller.sessionId } : {}),
    ...(o.caller.bot !== undefined ? { bot: o.caller.bot } : {}),
    ...(o.caller.botsOwnSession === true ? { botsOwnSession: true as const } : {}),
  });
  const denyRead: string[] = [];
  const denyWrite: string[] = [places.runtime];
  const fold = (s: string) => s.toUpperCase();
  const ownBase = places.ownMemory === null ? null : fold(places.ownMemory);
  for (const x of o.bots) {
    const folder = win32.join(places.bots, x);
    const memory = win32.join(folder, "memory");
    if (ownBase !== null && fold(memory) === ownBase) {
      // The owning bot's own memory: never denied (its folder itself is still never deletable:
      // the `bots/<x>` write deny below covers a move or delete of it).
      denyWrite.push(folder);
      continue;
    }
    denyRead.push(memory);
    denyWrite.push(memory, folder);
  }
  if (places.ownRuntime !== null) {
    // Only the caller's own state file reads back; every other runner is denied the whole folder.
    denyRead.push(places.runtime);
  } else {
    denyRead.push(places.runtime);
  }
  return { denyRead, denyWrite, ownMemory: places.ownMemory, ownRuntime: places.ownRuntime };
}

/** The full per-launch deny plan: the fence's set (deny ACEs on every fenced item, so Bash can
 *  never write the fenced set) plus the caller's memory rules. Read-denied items deny reads too. */
export function winLaunchDenies(o: { policy: SandboxPolicy; cloverHome: string; caller: FenceCaller; bots: readonly string[] }): {
  denyRead: string[];
  denyWrite: string[];
  ownMemory: string | null;
  ownRuntime: string | null;
} {
  const caller = winCallerDenies(o);
  const deny = (paths: readonly string[]) => [...new Set(paths)];
  return {
    denyRead: deny([...o.policy.denyRead, ...caller.denyRead]),
    denyWrite: deny([...o.policy.denyWrite, ...caller.denyWrite]),
    ownMemory: caller.ownMemory,
    ownRuntime: caller.ownRuntime,
  };
}

/** Resetting the principal between sessions (spec item 1116: nothing carries over). The profile
 *  and hive are removed by SID after a warm-up launch resolves them, the Startup folder is
 *  pre-created and denied, and a leftover principal's profile folder is removed first. Each step
 *  is verified; anything left behind fails the launch closed. The live runner measures this on
 *  the VM; the exact command list is pinned there. */
export interface PrincipalResetStep {
  readonly name: string;
  readonly argv: readonly string[];
  /** When false, the step's failure fails the launch closed (no fallback). */
  readonly required: boolean;
}

export function principalResetPlan(o: { sid: string; profileRoot: string }): readonly PrincipalResetStep[] {
  const profileKey = `HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\${o.sid}`;
  return [
    { name: "unload-hive", argv: ["reg", "unload", `HKU\\${o.sid}`], required: false },
    { name: "remove-profile-key", argv: ["reg", "delete", profileKey, "/f"], required: true },
    { name: "remove-profile-dir", argv: ["cmd", "/d", "/s", "/c", `rmdir /s /q "${o.profileRoot}"`], required: true },
    { name: "remove-leftover-dirs", argv: ["cmd", "/d", "/s", "/c", `rmdir /s /q "C:\\Users\\${SANDBOX_PRINCIPAL}.*" 2>nul & exit 0`], required: false },
  ];
}

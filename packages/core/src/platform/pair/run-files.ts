// The two files the daemon leaves in its run directory for the app (agreed with lane E, E-M1 #168;
// controller ruling R2):
//   <home>/run/app.token       the `app` role's token, minted at each daemon start: owner-only (0600;
//                              on Windows an ACL for the user alone), inside the fenced set, never
//                              logged. A per-run capability, not a user secret. The caller check (§3.1)
//                              is the real guard; the token keeps other users' processes out.
//   <home>/run/app-start.json  { by, safeMode, at }, written just before the daemon starts the app
//                              through the OS, since none of the OS starts (open -a, systemctl --user
//                              start, schtasks /Run) passes arguments reliably. The app reads it once,
//                              deletes it and honours it for 60 s.
// Both are written to a temporary name, locked down, then renamed into place, so the app never reads
// a half-written file and the token is never readable by anyone else, even for a moment.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Runner } from "../login/live";
import type { DaemonPlatform } from "../transport";

export const APP_TOKEN_FILE = "app.token";
export const APP_START_FILE = "app-start.json";

export function appTokenPath(runDir: string): string {
  return join(runDir, APP_TOKEN_FILE);
}

export function appStartPath(runDir: string): string {
  return join(runDir, APP_START_FILE);
}

export interface RunFileDeps {
  readonly os: DaemonPlatform;
  /** Windows: runs icacls. */
  readonly run: Runner;
  /** Windows: the user's SID (`windowsUserSid`), the only account the file's ACL grants. */
  readonly userSid?: string;
}

/** Write a file only its owner can read, atomically. Throws when the OS won't lock it down: a token
 *  that others could read is not written at all. */
async function writeOwnerOnly(path: string, text: string, deps: RunFileDeps): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
    if (deps.os === "win32") {
      if (!deps.userSid) throw new Error("no user SID for the file's ACL");
      // Drop the inherited entries and grant the user alone; the ACL moves with the rename.
      const r = await deps.run(["icacls", tmp, "/inheritance:r", "/grant:r", `*${deps.userSid}:F`]);
      if (!r.ok) throw new Error("icacls refused the ACL");
    } else {
      chmodSync(tmp, 0o600);
    }
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Mint this run's `app` token and write it for the user alone. Returns the token, which the daemon
 *  keeps in memory to check the app's hello and never logs. */
export async function mintAppToken(runDir: string, deps: RunFileDeps): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await writeOwnerOnly(appTokenPath(runDir), token, deps);
  return token;
}

/** Remove the token when the daemon stops (best-effort; the next start replaces it anyway). */
export function removeAppToken(runDir: string): void {
  rmSync(appTokenPath(runDir), { force: true });
}

export interface AppStart {
  /** "login": the daemon's start-up start (it came up at login, or the CLI started it). "daemon": a
   *  restart after a crash, or after the app's own restart did not come back. */
  readonly by: "daemon" | "login";
  readonly safeMode: boolean;
  readonly at: number;
}

/** Write the start file the app reads when it comes up. */
export async function writeAppStart(runDir: string, start: AppStart, deps: RunFileDeps): Promise<void> {
  await writeOwnerOnly(appStartPath(runDir), JSON.stringify(start), deps);
}

/** The daemon's proof that it holds this run's app token, so the app can check who it is talking to
 *  before it sends the token (from E-M1's review): HMAC-SHA256 of the app's nonce under the token,
 *  base64url. Only the daemon that minted the token, or the user's own processes outside the fence,
 *  can read it, so a process squatting the endpoint can't answer. It needs no native code in the app,
 *  and works on every OS. */
export function proveDaemon(appToken: string, nonce: string): string {
  return createHmac("sha256", appToken).update(`clover-daemon-proof\0${nonce}`).digest("base64url");
}

/** The app's check of `proveDaemon`'s answer. The nonce should be at least 16 random bytes. */
export function checkDaemonProof(appToken: string, nonce: string, proof: string): boolean {
  const want = Buffer.from(proveDaemon(appToken, nonce));
  const got = Buffer.from(proof);
  return got.length === want.length && timingSafeEqual(got, want);
}

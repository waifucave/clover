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
// Both are created empty under a temporary name, locked down, then written and renamed into place, so
// the app never reads a half-written file and the token is never readable by anyone else, even for a
// moment (review S6); `lockRunDir` also makes the run folder itself the user's alone.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
    writeFileSync(tmp, "", { mode: 0o600, flag: "wx" }); // empty until it's locked down
    if (deps.os === "win32") {
      if (!deps.userSid) throw new Error("no user SID for the file's ACL");
      // Drop the inherited entries and grant the user alone; the ACL moves with the rename.
      const r = await deps.run(["icacls", tmp, "/inheritance:r", "/grant:r", `*${deps.userSid}:F`]);
      if (!r.ok) throw new Error("icacls refused the ACL");
    } else {
      chmodSync(tmp, 0o600);
    }
    writeFileSync(tmp, text, { flag: "r+" }); // the same file, its ACL kept
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Make the run folder the user's alone (0700; on Windows inheritance off and the user's SID only), before
 *  anything is written in it. Throws when the OS won't. */
export async function lockRunDir(runDir: string, deps: RunFileDeps): Promise<void> {
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  if (deps.os === "win32") {
    if (!deps.userSid) throw new Error("no user SID for the run folder's ACL");
    const r = await deps.run(["icacls", runDir, "/inheritance:r", "/grant:r", `*${deps.userSid}:(OI)(CI)F`]);
    if (!r.ok) throw new Error("icacls refused the run folder's ACL");
  } else {
    chmodSync(runDir, 0o700);
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

/** The daemon's proof that it holds this run's app token, answered to `protocol.prove` before the app's
 *  hello (E-M1's review; review S3): HMAC-SHA256 under the token of `clover-daemon-proof\0<nonce>\0<pid>`,
 *  base64url, where `pid` is the client's pid as the daemon sees it on that connection. Only the daemon
 *  that minted the token, or the user's own processes outside the fence, can read it; and since the pid
 *  is the connection's own, a proof a squatter relays from its own connection to the daemon names the
 *  squatter's pid, which the app refuses. No native code in the app, on every OS. */
export function proveDaemon(appToken: string, nonce: string, pid: number): string {
  return createHmac("sha256", appToken).update(`clover-daemon-proof\0${nonce}\0${pid}`).digest("base64url");
}

/** The app's check of `proveDaemon`'s answer, with its own pid (the main process's, which holds the
 *  connection). The nonce should be at least 16 random bytes. */
export function checkDaemonProof(appToken: string, nonce: string, proof: string, pid: number): boolean {
  const want = Buffer.from(proveDaemon(appToken, nonce, pid));
  const got = Buffer.from(proof);
  return got.length === want.length && timingSafeEqual(got, want);
}

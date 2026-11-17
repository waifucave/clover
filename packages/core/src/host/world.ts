// The engine's real `HostWorld` (spec revision 19, §3.1 "The engine and the host, precisely"; ruling R7; lane HS): who
// holds the host lock, which app carries the newest host, and how the host is started and stopped through the OS.
//
// * The host lock (`HOST_LOCK_FILE`) is an OS lock, never a pid in a file: on macOS the host opens the file with
//   `O_EXLOCK` (flock semantics, held by the open file and let go by the kernel when the process dies, so a reused pid
//   never holds it); the engine probes it with `O_SHLOCK | O_NONBLOCK`, and only while it is held reads the pid the host
//   wrote into it. Windows and Linux have no lock-on-open flag and Bun and Node no `flock`: there `lockHolder` is null,
//   and a second host started over a live one loses the host's own single-instance lock and quits before its hello,
//   while the live one's reconnect says `host.ready` (the second-host refusal keeps the engine at one).
// * The source is the newest app that carries the host. Lane RL's `ReleaseHome.hostSource` owns that; until it lands,
//   `appRecordsSource` reads `<home>/apps/<program>.json` the same way.
// * A start on macOS checks the helper's code signature first (its fixed identifier, Apple's chain, MOSS's team, a
//   Developer ID leaf for dist) and starts it through Launch Services (`open -n -g -a`), never as the engine's child.
//   Windows and Linux start a recorded install only, through the host's task or user unit (`moss-host`), which their
//   packages install (not yet built: say so where it fails).
// * A source checkout (not a dist build) may name its own start (`MOSS_HOST_COMMAND`, a JSON argv), which the engine
//   runs as its child in its own process group, so a run that started the engine ends the host with it.
import { execFileSync, spawn } from "node:child_process";
import { closeSync, constants, existsSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { APP_RECORDS_DIR, AppInstallRecord, HOST_LOCK_FILE, HOST_START_FILE, PROGRAM_IDENTIFIERS, compareReleases, type HostExitReason } from "@waifucave/moss-protocol";
import { DEVELOPER_ID_CLAUSES, MOSS_TEAM_ID } from "../bundled-identities";
import type { HostWorld } from "../contracts/host-supervisor";
import type { Runner } from "../platform/login/live";
import type { DaemonPlatform } from "../platform/transport";
import type { MossProfile } from "../profile";
import type { HostWorldExtras } from "./supervisor";

/** macOS's lock-on-open flags (`<sys/fcntl.h>`): `open(2)` takes a flock-style lock atomically with the open. */
export const DARWIN_O_SHLOCK = 0x10;
export const DARWIN_O_EXLOCK = 0x20;
const DARWIN_O_NONBLOCK = 0x4;

/** The pid holding the host lock under `home`, or null when no live process holds it (macOS); always null elsewhere. */
export function hostLockHolder(home: string, os: DaemonPlatform): number | null {
  if (os !== "darwin") return null;
  const path = join(home, HOST_LOCK_FILE);
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | DARWIN_O_SHLOCK | DARWIN_O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "EAGAIN" && code !== "EWOULDBLOCK") return null;
    // Held: the pid the holder wrote under its lock (an advisory lock: a plain read works). A holder that has not yet
    // written it is still a holder.
    try {
      const pid = Number(readFileSync(path, "utf8").trim().split(/\s+/)[0]);
      return Number.isInteger(pid) && pid > 0 ? pid : 0;
    } catch {
      return 0;
    }
  }
  closeSync(fd);
  return null;
}

/** The newest app record under `home` that carries the host and whose bundle is still on disk (a release tie goes to
 *  the later record): `ReleaseHome.hostSource`'s rule, read straight from the files until lane RL serves it. */
export function appRecordsSource(home: string, exists: (p: string) => boolean = existsSync): AppInstallRecord | undefined {
  const dir = join(home, APP_RECORDS_DIR);
  let names: string[];
  try { names = readdirSync(dir).filter((n) => n.endsWith(".json")); } catch { return undefined; }
  let best: AppInstallRecord | undefined;
  for (const name of names) {
    let rec: AppInstallRecord;
    try {
      const parsed = AppInstallRecord.safeParse(JSON.parse(readFileSync(join(dir, name), "utf8")));
      if (!parsed.success) continue;
      rec = parsed.data;
    } catch { continue; }
    if (!rec.carries.host || !exists(rec.bundlePath)) continue;
    if (best === undefined) { best = rec; continue; }
    const c = compareReleases(rec.release, best.release);
    if (c > 0 || (c === 0 && rec.seenAt > best.seenAt)) best = rec;
  }
  return best;
}

/** The release an app bundle says it is (`CFBundleShortVersionString` in its Info.plist, macOS), or undefined when it
 *  can't be read. A record's own `release` is only its word: the copy counts when the bundle agrees. */
export function bundleRelease(bundlePath: string, read: (path: string) => Buffer = (p) => readFileSync(p)): string | undefined {
  let raw: Buffer;
  try { raw = read(join(bundlePath, "Contents", "Info.plist")); } catch { return undefined; }
  let xml = raw.toString("utf8");
  if (raw.subarray(0, 6).toString("latin1") === "bplist") {
    try { xml = execFileSync("plutil", ["-convert", "xml1", "-o", "-", join(bundlePath, "Contents", "Info.plist")], { encoding: "utf8", timeout: 5_000 }); } catch { return undefined; }
  }
  return /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]*)<\/string>/.exec(xml)?.[1];
}

/** The host helper's product name per profile: the nested app's name inside each app. */
export function hostProductName(profile: MossProfile): string {
  return profile === "dev" ? "MOSS Host Dev" : "MOSS Host";
}

/** Where the host helper sits inside an app (macOS: a nested app in `Contents/Frameworks`, beside Electron's own
 *  helpers, so it uses the app's Electron framework). */
export function hostHelperPath(bundlePath: string, profile: MossProfile): string {
  return posix.join(bundlePath, "Contents", "Frameworks", `${hostProductName(profile)}.app`);
}

/** The code requirement the host helper must meet before the engine starts it (macOS): its fixed identifier for the
 *  profile, Apple's chain, MOSS's team, and a Developer ID Application leaf for dist (as `appRequirement` for the apps). */
export function hostRequirement(profile: MossProfile, team: string = MOSS_TEAM_ID, developerId: boolean = profile === "dist"): string {
  if (!/^[A-Z0-9]{10}$/.test(team)) throw new Error(`not a team identifier: ${team}`);
  return `identifier "${PROGRAM_IDENTIFIERS.host[profile]}" and anchor apple generic${developerId ? ` and ${DEVELOPER_ID_CLAUSES}` : ""} and certificate leaf[subject.OU] = "${team}"`;
}

/** The host's task and unit names on Windows and Linux (installed by the apps' packages beside the app's own). */
export function hostTaskName(profile: MossProfile): string {
  return profile === "dev" ? "\\MOSS\\moss-host-dev" : "\\MOSS\\moss-host";
}
export function hostUnitName(profile: MossProfile): string {
  return profile === "dev" ? "moss-host-dev.service" : "moss-host.service";
}

/** `MOSS_HOST_COMMAND`, a source checkout's own start of the host: a JSON array of strings, the program first. */
export function parseHostCommand(raw: string | undefined): string[] | undefined {
  if (raw === undefined || raw === "") return undefined;
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && x !== "") ? v as string[] : undefined;
  } catch {
    return undefined;
  }
}

export interface EngineHostWorldInput {
  readonly home: string;
  readonly os: DaemonPlatform;
  readonly profile: MossProfile;
  readonly release: string;
  readonly run: Runner;
  /** Whether this is a dist build (`DIST_BUILD`), which ignores `MOSS_HOST_COMMAND`. */
  readonly dist: boolean;
  /** Whether this is a test-marked build, which never starts a host through the OS (it would draw on the screen). */
  readonly testBuild: boolean;
  readonly env: Record<string, string | undefined>;
  /** The newest app carrying the host (lane RL's `hostSource`); default: `appRecordsSource(home)`. */
  source?(): AppInstallRecord | undefined;
  /** Sends the live host `host.stop`; false when no host is connected. */
  stopHost(reason: HostExitReason): boolean;
  /** A start that failed (the signature, the OS): the supervisor counts it as an exit. */
  startFailed(why: string): void;
  log?(line: string): void;
  now?(): number;
  exists?(path: string): boolean;
  /** Test seam: the release a bundle says it is (default: its Info.plist). */
  bundleRelease?(bundlePath: string): string | undefined;
}

/** The engine's real host world. */
export function engineHostWorld(input: EngineHostWorldInput): HostWorld & HostWorldExtras {
  const log = input.log ?? (() => {});
  const now = input.now ?? Date.now;
  const exists = input.exists ?? existsSync;
  const command = input.dist ? undefined : parseHostCommand(input.env.MOSS_HOST_COMMAND);
  if (input.dist && input.env.MOSS_HOST_COMMAND) log("[host] ignoring MOSS_HOST_COMMAND: a release build starts only the host its apps carry");

  const writeStartFile = (safeMode: boolean): void => {
    const path = join(input.home, HOST_START_FILE);
    const tmp = `${path}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ by: "engine", safeMode, at: now() }), { mode: 0o600 });
      renameSync(tmp, path);
    } catch (e) {
      log(`[host] the start file was not written (${(e as Error).message}); the host starts as asked by the person`);
    }
  };

  const startThroughOs = async (bundlePath: string): Promise<void> => {
    if (input.os === "darwin") {
      const helper = hostHelperPath(bundlePath, input.profile);
      if (!exists(helper)) throw new Error(`${bundlePath} carries no host helper`);
      const verify = await input.run(["codesign", "--verify", "--strict", `-R=${hostRequirement(input.profile)}`, helper]);
      if (!verify.ok) throw new Error(`the host helper in ${bundlePath} is not signed as MOSS's host`);
      if (!(await input.run(["open", "-n", "-g", "-a", helper])).ok) throw new Error("Launch Services refused the host");
      return;
    }
    if (input.os === "linux") {
      const env = await input.run(["systemctl", "--user", "show-environment"]);
      if (env.ok && !/^(DISPLAY|WAYLAND_DISPLAY)=\S/m.test(env.out)) throw new Error("no graphical session yet");
      if (!(await input.run(["systemctl", "--user", "start", hostUnitName(input.profile)])).ok) throw new Error(`systemctl refused ${hostUnitName(input.profile)}`);
      return;
    }
    if (!(await input.run(["schtasks", "/Run", "/TN", hostTaskName(input.profile)])).ok) throw new Error(`no task ${hostTaskName(input.profile)}`);
  };

  return {
    lockHolder: () => hostLockHolder(input.home, input.os),
    source: () => {
      if (command !== undefined) {
        return { record: 1, program: "code", bundlePath: command[0]!, release: input.release, carries: { engine: true, host: true }, seenAt: 0 };
      }
      if (input.testBuild) return undefined;
      const rec = (input.source ?? (() => appRecordsSource(input.home, exists)))();
      // An app that carries no helper (an older build) is no source: the engine then runs headless rather than retrying.
      if (rec !== undefined && input.os === "darwin" && !exists(hostHelperPath(rec.bundlePath, input.profile))) return undefined;
      // A record says its release; the bundle must say the same, or it is not this copy (an update half way, a forged record).
      if (rec !== undefined && input.os === "darwin" && (input.bundleRelease ?? bundleRelease)(rec.bundlePath) !== rec.release) {
        log(`[host] ${rec.bundlePath} is not the release its record says (${rec.release}): not this copy`);
        return undefined;
      }
      return rec;
    },
    start(bundlePath, opts) {
      writeStartFile(opts.safeMode);
      if (command !== undefined) {
        log(`[host] starting the host from this checkout${opts.safeMode ? " in safe mode" : ""}`);
        try {
          const child = spawn(command[0]!, [...command.slice(1), ...(opts.safeMode ? ["--safe-mode"] : [])], { stdio: "ignore", env: { ...process.env } });
          child.on("error", (e) => input.startFailed(e.message));
          child.unref();
        } catch (e) {
          queueMicrotask(() => input.startFailed((e as Error).message));
        }
        return;
      }
      log(`[host] starting the host from ${bundlePath}${opts.safeMode ? " in safe mode" : ""}`);
      startThroughOs(bundlePath).catch((e: unknown) => {
        log(`[host] the host did not start: ${(e as Error).message}`);
        input.startFailed((e as Error).message);
      });
    },
    stop(reason) {
      if (!input.stopHost(reason)) log(`[host] no host connected to stop (${reason})`);
    },
    end(pid) {
      // Only the process that holds the host lock right now (the supervisor checked), never by name or pattern.
      if (pid <= 0) return;
      try { process.kill(pid, "SIGKILL"); log(`[host] ended the wedged host (pid ${pid})`); } catch { /* gone already */ }
    },
  };
}

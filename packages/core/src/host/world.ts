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
import { closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
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
/** A record file's text: a regular file, never followed through a link, at most `APP_RECORD_MAX_BYTES`. */
export const APP_RECORD_MAX_BYTES = 64 * 1024;
const APP_RECORDS_MAX = 64;
function readRecordFile(path: string): string | undefined {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); } catch { return undefined; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > APP_RECORD_MAX_BYTES) return undefined;
    const buf = Buffer.alloc(st.size);
    const n = readSync(fd, buf, 0, st.size, 0);
    return buf.subarray(0, n).toString("utf8");
  } catch { return undefined; } finally { closeSync(fd); }
}

/** The newest app record that carries the host (or, with `program`, that program's newest), and whose bundle is there.
 *  Lane RL's `hostSource` replaces it when RL lands. */
export function appRecordsSource(home: string, exists: (p: string) => boolean = existsSync, program?: AppInstallRecord["program"]): AppInstallRecord | undefined {
  const dir = join(home, APP_RECORDS_DIR);
  let names: string[];
  try { names = readdirSync(dir).filter((n) => n.endsWith(".json")).slice(0, APP_RECORDS_MAX); } catch { return undefined; }
  let best: AppInstallRecord | undefined;
  for (const name of names) {
    let rec: AppInstallRecord;
    try {
      const text = readRecordFile(join(dir, name));
      if (text === undefined) continue;
      const parsed = AppInstallRecord.safeParse(JSON.parse(text));
      if (!parsed.success) continue;
      rec = parsed.data;
    } catch { continue; }
    if (program !== undefined && rec.program !== program) continue;
    if ((program === undefined && !rec.carries.host) || !exists(rec.bundlePath)) continue;
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

/** How soon a checkout's host command that ends counts as a start that failed (its exit, not the start watchdog). */
export const HOST_EARLY_EXIT_MS = 5_000;

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

/** Where a host started from a checkout writes its output (under the home). */
export const HOST_SOURCE_LOG = "logs/host.out.log";

/** The `.app` a checkout's program sits in (its Electron.app), or undefined. */
export function sourceBundleOf(program: string): string | undefined {
  const i = program.indexOf(".app/");
  return i >= 0 ? program.slice(0, i + 4) : undefined;
}

/** What the engine hands the host it starts from a checkout through Launch Services, which passes no environment of its
 *  own: the home and profile, the run's test settings (`MOSS_*`), and the user home, temp folder, language and PATH. */
export function hostEnvArgs(env: Record<string, string | undefined>): string[] {
  // `open`'s argv is visible to every process (`ps`): nothing named a token, a secret or a password goes through it (the
  // host reads its app token from the home's run folder).
  const secretish = /TOKEN|SECRET|PASSWORD|PASSPHRASE/i;
  const keep = (k: string) => (k.startsWith("MOSS_") && k !== "MOSS_HOST_COMMAND" && !secretish.test(k)) || ["HOME", "TMPDIR", "LANG", "PATH"].includes(k);
  return Object.entries(env).filter(([k, v]) => v !== undefined && keep(k)).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
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
      // The engine's own home and profile go with it (Launch Services passes no environment of its own); nothing else.
      const env = ["MOSS_HOME", "MOSS_PROFILE"].flatMap((k) => (input.env[k] ? ["--env", `${k}=${input.env[k]}`] : []));
      if (!(await input.run(["open", "-n", "-g", ...env, "-a", helper])).ok) throw new Error("Launch Services refused the host");
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
        const bundle = input.os === "darwin" ? sourceBundleOf(command[0]!) : undefined;
        if (bundle !== undefined) {
          // Through Launch Services, as the real start is: the host is then launchd's child and its own responsible
          // process, never the engine's (whose children the caller check never takes for the app).
          // Its output to the home's logs (a checkout's run only: a release's host has none).
          const out = join(input.home, HOST_SOURCE_LOG);
          try { mkdirSync(dirname(out), { recursive: true }); } catch { /* open says so */ }
          const argv = ["open", "-n", "-g", "--stdout", out, "--stderr", out, "-a", bundle, ...hostEnvArgs(input.env), "--args", ...command.slice(1), ...(opts.safeMode ? ["--safe-mode"] : [])];
          void input.run(argv).then((r) => { if (!r.ok) input.startFailed("Launch Services refused the host"); });
          return;
        }
        try {
          const child = spawn(command[0]!, [...command.slice(1), ...(opts.safeMode ? ["--safe-mode"] : [])], { stdio: "ignore", env: { ...process.env } });
          let told = false;
          const failed = (why: string) => { if (!told) { told = true; input.startFailed(why); } };
          child.on("error", (e) => failed(e.message));
          // A checkout's start that ends at once (a broken build, a wrong command) is a failed start now, not after the
          // 45 s watchdog: a host that came up runs far longer, and its own leaving is heard by its connection's close.
          const at = Date.now();
          child.on("exit", (code) => { if (code !== 0 && Date.now() - at < HOST_EARLY_EXIT_MS) failed(`the host's command ended at once (code ${code ?? "none"})`); });
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
      // Only the process that holds the host lock right now (the supervisor checked), never by name or pattern, and only
      // when its image is a host: the lock file's pid is its holder's own word.
      if (pid <= 0) return;
      const image = processImage(pid);
      if (image === undefined || !isHostImage(image, command?.[0])) { log(`[host] the lock's holder (pid ${pid}) is not a MOSS host by its image: left alone`); return; }
      try { process.kill(pid, "SIGKILL"); log(`[host] ended the wedged host (pid ${pid})`); } catch { /* gone already */ }
    },
  };
}

/** A process's executable path (macOS `ps -o comm=`, the exec path the kernel holds; Linux `/proc/<pid>/exe`). */
export function processImage(pid: number): string | undefined {
  try {
    if (process.platform === "darwin") return execFileSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8", timeout: 5_000 }).trim() || undefined;
    if (process.platform === "linux") return readlinkSync(`/proc/${pid}/exe`);
  } catch { /* gone, or not ours to read */ }
  return undefined;
}

/** Whether an image is MOSS's host: the helper's executable inside an app bundle (`MOSS Host[ Dev].app` in its
 *  Frameworks), or, in a checkout's run, the program `MOSS_HOST_COMMAND` names. */
export function isHostImage(image: string, sourceExe?: string): boolean {
  if (sourceExe !== undefined && image === sourceExe) return true;
  return /\.app\/Contents\/Frameworks\/MOSS Host( Dev)?\.app\/Contents\/MacOS\/[^/]+$/.test(image);
}

/** Opens MOSS or MOSS Code for the host's menu when it isn't running: the newest record of that program, through the OS
 *  (Launch Services on macOS, so the app is its own responsible process). A checkout's run has no records: nothing. */
export async function launchApp(input: { home: string; os: DaemonPlatform; run: Runner; exists?: (p: string) => boolean; log?: (line: string) => void }, program: "moss" | "code"): Promise<void> {
  const rec = appRecordsSource(input.home, input.exists ?? existsSync, program);
  if (rec === undefined) { input.log?.(`[host] no ${program === "moss" ? "MOSS" : "MOSS Code"} on disk to open`); return; }
  const argv = input.os === "darwin" ? ["open", "-a", rec.bundlePath] : [rec.bundlePath];
  if (input.os !== "darwin") {
    try { spawn(rec.bundlePath, [], { detached: true, stdio: "ignore" }).unref(); } catch (e) { input.log?.(`[host] ${rec.bundlePath} did not open: ${(e as Error).message}`); }
    return;
  }
  const r = await input.run(argv);
  if (!r.ok) input.log?.(`[host] Launch Services did not open ${rec.bundlePath}`);
}

// The app's side of installing and starting the daemon (spec §3.1 "The app can install, start and update the
// daemon"; "Each starts the other through the OS"). Lane C's daemon binary owns the login items (what the launchd
// plist, the `systemd --user` unit and the Task Scheduler task say; each runs `moss-core supervise`) and starting
// itself through the OS, so the app never names a launchd label, a unit or a task. It runs lane C's command:
//
//   moss-core autostart status    "autostart: <state> (<unit>) [registered]", or with `--json` (proposed to C)
//                                   { "registered": boolean, "running"?: boolean }
//   moss-core autostart enable    registers the login item for this home (idempotent)
//   moss-core autostart start     starts the daemon through the OS now — `launchctl kickstart`,
//                                   `systemctl --user start`, `schtasks /Run` — never as the app's child
//
// (Whether the endpoint is this user's daemon is no longer a command: lane C's `protocol.prove`, on the connection
// itself before the hello, says so on every OS; pair.ts.)
//
// each with `MOSS_HOME` and `MOSS_PROFILE` set, exit code 0 on success. A fake binary stands in for it in the
// tests until C-M1 lands.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface LoginResult {
  ok: boolean;
  code: number | null;
  /** The command's output, cut short: for the log, never shown with a secret (the command prints none). */
  out: string;
}

export interface DaemonLauncher {
  /** Is the login item registered? `undefined` when the binary can't say. */
  status(): Promise<{ registered: boolean; running?: boolean } | undefined>;
  enable(): Promise<LoginResult>;
  start(): Promise<LoginResult>;
}

export interface LauncherConfig {
  binary: string;
  home: string;
  profile: "dist" | "dev";
  timeoutMs?: number;
  /** Extra environment for the command (the tests' fake binary reads its script from here). */
  env?: Record<string, string>;
}

function run(cfg: LauncherConfig, args: string[]): Promise<LoginResult> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ...cfg.env, MOSS_HOME: cfg.home, MOSS_PROFILE: cfg.profile };
    delete env.ELECTRON_RUN_AS_NODE;
    execFile(cfg.binary, args, { env, timeout: cfg.timeoutMs ?? 15_000, windowsHide: true, encoding: "utf8" }, (err, stdout, stderr) => {
      const code = err === null ? 0 : typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === "number" ? ((err as unknown as { code: number }).code) : null;
      resolve({ ok: err === null, code, out: `${stdout ?? ""}${stderr ?? ""}`.trim().slice(0, 2000) });
    });
  });
}

/** `autostart status`'s answer: JSON when the command gives it, else lane C's line ("… [registered]"). */
export function parseAutostartStatus(out: string): { registered: boolean; running?: boolean } | undefined {
  const json = out.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{")).pop();
  if (json !== undefined) {
    try {
      const parsed = JSON.parse(json) as { registered?: unknown; running?: unknown };
      if (typeof parsed.registered === "boolean") return { registered: parsed.registered, ...(typeof parsed.running === "boolean" ? { running: parsed.running } : {}) };
    } catch {
      /* the text form */
    }
  }
  const line = out.split("\n").find((l) => l.startsWith("autostart:"));
  return line === undefined ? undefined : { registered: line.includes("[registered]") };
}

export function cliLauncher(cfg: LauncherConfig): DaemonLauncher {
  return {
    async status() {
      const r = await run(cfg, ["autostart", "status"]);
      return r.ok ? parseAutostartStatus(r.out) : undefined;
    },
    enable: () => run(cfg, ["autostart", "enable"]),
    start: () => run(cfg, ["autostart", "start"]),
  };
}

export const DAEMON_BINARY_NAME = process.platform === "win32" ? "moss-core.exe" : "moss-core";

/** Where the daemon binary is, in this order: `MOSS_DAEMON_BIN` (the dev scripts and the tests), the packaged
 *  app's resources (`<resources>/daemon/moss-core`, lane M packages it there), or none (the unpackaged dev app,
 *  whose daemon `bun run dev:daemon` runs). On Linux an AppImage's copy is first copied out (below). */
export function locateDaemonBinary(input: { env: NodeJS.ProcessEnv; packaged: boolean; resourcesPath?: string; platform?: NodeJS.Platform; userHome?: string }): string | undefined {
  const fromEnv = input.env.MOSS_DAEMON_BIN;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  if (!input.packaged || input.resourcesPath === undefined) return undefined;
  const bundled = join(input.resourcesPath, "daemon", DAEMON_BINARY_NAME);
  if (!existsSync(bundled)) return undefined;
  if ((input.platform ?? process.platform) === "linux" && input.env.APPIMAGE !== undefined) {
    return copyOutOfAppImage(bundled, input.env, input.userHome ?? homedir());
  }
  return bundled;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** On Linux the app copies the daemon out of the AppImage (§3.1), since the AppImage's mount goes away when the app
 *  quits and the login unit must point at a file that stays: `$XDG_DATA_HOME/moss/bin/moss-core`, replaced
 *  atomically when the AppImage carries a different one. */
export function copyOutOfAppImage(bundled: string, env: NodeJS.ProcessEnv, userHome: string): string {
  const dataHome = env.XDG_DATA_HOME !== undefined && env.XDG_DATA_HOME !== "" ? env.XDG_DATA_HOME : join(userHome, ".local", "share");
  const target = join(dataHome, env.MOSS_PROFILE === "dev" ? "moss-dev" : "moss", "bin", DAEMON_BINARY_NAME);
  const same = existsSync(target) && statSync(target).size === statSync(bundled).size && sha256(target) === sha256(bundled);
  if (!same) {
    mkdirSync(dirname(target), { recursive: true });
    const temp = `${target}.new-${process.pid}`;
    copyFileSync(bundled, temp);
    chmodSync(temp, 0o755);
    renameSync(temp, target);
  }
  return target;
}

/** What `moss-core engine install` printed: the binary every start goes through, whichever app's copy won the lock. */
export function parseEngineInstall(out: string): { installed: boolean; binary: string; release: string; build?: string; unsafe?: true } | undefined {
  const line = out.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{")).pop();
  if (line === undefined) return undefined;
  try {
    const p = JSON.parse(line) as { installed?: unknown; binary?: unknown; release?: unknown; build?: unknown; unsafe?: unknown };
    if (typeof p.installed !== "boolean" || typeof p.binary !== "string" || p.binary === "" || typeof p.release !== "string") return undefined;
    return { installed: p.installed, binary: p.binary, release: p.release, ...(typeof p.build === "string" ? { build: p.build } : {}), ...(p.unsafe === true ? { unsafe: true as const } : {}) };
  } catch {
    return undefined;
  }
}

/**
 * Puts this app's own engine (and its bundled tree) under the home, under the install lock, and says which binary to start
 * the engine from: `<home>/bin/daemon/moss-core`, the NEWEST installed copy, whichever of two apps starting at once won
 * (spec §3.1 "Where the copies are found"). The login item the app then registers (`autostart enable`) names that copy, never
 * this app's own resources. Undefined when it couldn't (the app then starts its own bundled engine, as a single app did).
 */
export async function installEngineCopy(cfg: LauncherConfig & { bundlePath: string; build?: string }): Promise<{ installed: boolean; binary: string; release: string } | undefined> {
  const r = await run(cfg, ["engine", "install", "--app", cfg.bundlePath, ...(cfg.build !== undefined ? ["--build", cfg.build] : [])]);
  const placed = r.ok ? parseEngineInstall(r.out) : undefined;
  // An engine already running from an app's own copy defers the install (nothing is placed under it): no home copy yet, none to start from.
  // A copy the engine's own check says doesn't meet its code requirement (macOS) is never started: the app keeps its bundled engine.
  return placed !== undefined && placed.unsafe !== true && existsSync(placed.binary) ? placed : undefined;
}

export interface AdoptDeps {
  /** `moss-core engine install` (default: `installEngineCopy`). */
  install(): Promise<{ installed: boolean; binary: string; release: string } | undefined>;
  /** A launcher that runs the login commands from `binary` (default: `cliLauncher`). */
  launcherFor(binary: string): DaemonLauncher;
  log(line: string): void;
}

/**
 * The login item points at the engine installed under the home, never into an app's bundle (spec §3.1: removing one app must not
 * break the login start of the other). After `engine install` has placed, or found, the home's engine, a login item that is
 * ALREADY registered is registered again from that copy (`autostart enable`, idempotent, run from `<home>/bin/daemon/moss-core`);
 * one that isn't registered is left to the pair, which asks for it (through the same copy) when no engine answers. The dev
 * profile's own item is left alone. Never throws; returns the installed engine's binary, or undefined when none was placed.
 */
export async function adoptHomeEngine(profile: "dist" | "dev", d: AdoptDeps): Promise<{ binary: string; release: string; reregistered: boolean } | undefined> {
  const placed = await d.install();
  if (placed === undefined) return undefined;
  if (profile === "dev") return { binary: placed.binary, release: placed.release, reregistered: false };
  let reregistered = false;
  try {
    const l = d.launcherFor(placed.binary);
    if ((await l.status())?.registered === true) {
      const r = await l.enable();
      reregistered = r.ok;
      if (!r.ok) d.log(`release: the login item was not re-registered from the home's engine (exit ${r.code})`);
    }
  } catch (err) {
    d.log(`release: the login item was not re-registered from the home's engine: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { binary: placed.binary, release: placed.release, reregistered };
}

/**
 * Starts the engine through the OS for a release switch whose new engine hasn't answered (RL, S2): the same two steps an ordinary
 * launch takes when no engine answers (`Pair.start`, pair.ts): register the login item only when none is INSTALLED, then ask the OS
 * to start the engine (`autostart start`) for this session. `status().registered` is `autostart status --json`'s "installed", so an
 * item the person turned off (`autostart disable`: the parked plist on macOS, a disabled unit, a task with its logon trigger off)
 * counts as registered and stays off; only a missing item (never registered, or `autostart remove`d), or a status the binary
 * couldn't give, is registered, exactly as a launch does. The dev profile's own item is never registered here. Never throws; true
 * when the OS took the start.
 */
export async function startEngineThroughOs(profile: "dist" | "dev", l: DaemonLauncher, log: (line: string) => void): Promise<boolean> {
  try {
    if (profile !== "dev" && (await l.status())?.registered !== true) {
      const r = await l.enable();
      log(`release: the engine has no login item; registered it so the new engine starts under supervise (${r.ok ? "ok" : `failed, ${r.code}`})`);
    }
    const r = await l.start();
    log(`release: asked the OS to start the new engine (${r.ok ? "ok" : `failed, ${r.code}`})`);
    return r.ok;
  } catch (err) {
    log(`release: starting the new engine failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// The app's side of installing and starting the daemon (spec §3.1 "The app can install, start and update the
// daemon"; "Each starts the other through the OS"). Lane C's daemon binary owns the login items (what the launchd
// plist, the `systemd --user` unit and the Task Scheduler task say; each runs `clover-core supervise`) and starting
// itself through the OS, so the app never names a launchd label, a unit or a task. It runs lane C's command:
//
//   clover-core autostart status    "autostart: <state> (<unit>) [registered]", or with `--json` (proposed to C)
//                                   { "registered": boolean, "running"?: boolean }
//   clover-core autostart enable    registers the login item for this home (idempotent)
//   clover-core autostart start     starts the daemon through the OS now — `launchctl kickstart`,
//                                   `systemctl --user start`, `schtasks /Run` — never as the app's child
//
// (Whether the endpoint is this user's daemon is no longer a command: lane C's `protocol.prove`, on the connection
// itself before the hello, says so on every OS; pair.ts.)
//
// each with `CLOVER_HOME` and `CLOVER_PROFILE` set, exit code 0 on success. A fake binary stands in for it in the
// tests until C-M1 lands.
import { execFile, spawn as nodeSpawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

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
  /** Stops what `start` started, if anything is still running (a dev child; the OS owns the rest). */
  stop?(): void;
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
    const env: NodeJS.ProcessEnv = { ...process.env, ...cfg.env, CLOVER_HOME: cfg.home, CLOVER_PROFILE: cfg.profile };
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

export const DAEMON_BINARY_NAME = process.platform === "win32" ? "clover-core.exe" : "clover-core";

/** Where the daemon binary is, in this order: `CLOVER_DAEMON_BIN` (the dev scripts and the tests), the packaged
 *  app's resources (`<resources>/daemon/clover-core`, lane M packages it there), or none (the unpackaged dev app,
 *  whose daemon `bun run dev:daemon` runs). On Linux an AppImage's copy is first copied out (below). */
export function locateDaemonBinary(input: { env: NodeJS.ProcessEnv; packaged: boolean; resourcesPath?: string; platform?: NodeJS.Platform; userHome?: string }): string | undefined {
  const fromEnv = input.env.CLOVER_DAEMON_BIN;
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
 *  quits and the login unit must point at a file that stays: `$XDG_DATA_HOME/clover/bin/clover-core`, replaced
 *  atomically when the AppImage carries a different one. */
export function copyOutOfAppImage(bundled: string, env: NodeJS.ProcessEnv, userHome: string): string {
  const dataHome = env.XDG_DATA_HOME !== undefined && env.XDG_DATA_HOME !== "" ? env.XDG_DATA_HOME : join(userHome, ".local", "share");
  const target = join(dataHome, env.CLOVER_PROFILE === "dev" ? "clover-dev" : "clover", "bin", DAEMON_BINARY_NAME);
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

/** A spawned child process, enough of it for the dev launcher to watch and stop. */
export interface DevChild {
  readonly pid?: number;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "exit" | "error", listener: (err?: Error) => void): void;
}

/** Spawning for the dev launcher; `node:child_process`'s own in production. */
export type DevSpawn = (
  command: string, args: readonly string[], opts: { cwd: string; env: NodeJS.ProcessEnv },
) => DevChild;

export interface DevDaemonConfig {
  /** The repo checkout (`scripts/dev-daemon.ts` and `dist/dev` live under it). */
  root: string;
  home: string;
  log(line: string): void;
  spawn?: DevSpawn;
  /** What runs the dev script: `<root>/scripts/pinned-bun` by default, never `bun` from PATH (a dev
   *  checkout pins its Bun; PATH's may be another project's). */
  bun?: string;
  platform?: NodeJS.Platform;
  /** How a Windows child tree dies; `taskkill /T /F /PID` by default (`child.kill` stops one process). */
  killTree?: (pid: number) => void;
}

/** The checkout holding `dir` (B1): walks up, bounded, for `scripts/dev-daemon.ts`. The built main
 *  process runs at `<root>/apps/desktop/out/main`, three levels down; a wrong fixed depth would land
 *  in `<root>/apps` and never start anything. Undefined when no checkout holds it. */
export function findRepoRoot(fromDir: string, maxUp = 8): string | undefined {
  let dir = resolve(fromDir);
  for (let i = 0; i <= maxUp; i++) {
    if (existsSync(join(dir, "scripts", "dev-daemon.ts"))) return dir;
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
  return undefined;
}

/** Whether the dev launcher may run on this home (S3): never the default dist home (`~/.clover`) and
 *  never Winter's homes (`~/.winter`, which the harness's own daemons use). The dev script alone must
 *  not be the only guard: the app itself refuses. */
export function devDaemonHomeAllowed(home: string, userHome: string = homedir()): boolean {
  const h = resolve(home);
  if (h === resolve(join(userHome, ".clover"))) return false;
  const winter = resolve(join(userHome, ".winter"));
  if (h === winter || h.startsWith(winter + sep)) return false;
  return true;
}

/** The dev daemon, as the dev app's own child: when no daemon answers and no binary is configured, an unpackaged run
 *  starts `bun run dev:daemon --no-build` itself instead of telling the person to start it by hand. No login item
 *  (dev manages its own child); the app stops it on quit. The binary must already be built (`bun run dev:daemon`
 *  once); without it the launcher says how, and starts nothing. */
export function devDaemonLauncher(cfg: DevDaemonConfig): DaemonLauncher {
  const dist = join(cfg.root, "dist", "dev", DAEMON_BINARY_NAME);
  const platform = cfg.platform ?? process.platform;
  const killTree = cfg.killTree ?? ((pid: number) => {
    spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { windowsHide: true });
  });
  const spawn = cfg.spawn ?? ((command: string, args: readonly string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => {
    const child = nodeSpawn(command, [...args], { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "inherit", "inherit"], windowsHide: true });
    return {
      get pid() { return child.pid; },
      get exitCode() { return child.exitCode; },
      get signalCode() { return child.signalCode; },
      kill: (signal?: NodeJS.Signals) => child.kill(signal ?? "SIGTERM"),
      on: (event: "exit" | "error", listener: (err?: Error) => void) => {
        if (event === "exit") void child.on("exit", () => listener());
        else void child.on("error", listener);
      },
    };
  });
  let child: DevChild | undefined;
  // A child that exits at once is logged only once, and after 3 such exits the launcher stops trying:
  // something structural is wrong, and a tight start loop would thrash it (each start says to run it by hand).
  let exits = 0;
  let exitLogged = false;
  const noteExit = (why: string) => {
    child = undefined;
    exits++;
    if (!exitLogged) {
      exitLogged = true;
      cfg.log(`dev: the dev daemon exited at once (${why}); start it by hand if it keeps happening`);
    }
  };
  const alive = () => child !== undefined && child.exitCode === null && child.signalCode === null;
  return {
    status: async () => (alive() ? { registered: true, running: true } : undefined),
    enable: async () => ({ ok: true, code: 0, out: "dev: no login item" }),
    start: async () => {
      if (alive()) return { ok: true, code: 0, out: "dev: already running" };
      if (exits >= 3) return { ok: false, code: null, out: "dev: keeps exiting" };
      if (!existsSync(join(cfg.root, "scripts", "dev-daemon.ts"))) {
        cfg.log(`dev: no repo checkout at ${cfg.root} (no scripts/dev-daemon.ts); start the daemon by hand`);
        return { ok: false, code: null, out: "dev: no repo checkout" };
      }
      if (!existsSync(dist)) {
        cfg.log(`dev: no dev daemon binary at ${dist}; run \`bun run dev:daemon\` once to build it`);
        return { ok: false, code: null, out: "dev: no dev binary" };
      }
      const bun = cfg.bun ?? join(cfg.root, "scripts", "pinned-bun");
      try {
        const c = spawn(bun, ["run", "dev:daemon", "--no-build"], {
          cwd: cfg.root,
          env: { ...process.env, CLOVER_HOME: cfg.home, CLOVER_PROFILE: "dev" },
        });
        child = c;
        // A spawn failure arrives as `error`, never as a throw (which would surface Electron's error
        // dialog — a window on the owner's screen): it is logged, and the launcher stays down.
        c.on("error", (err) => {
          if (child === c) noteExit(err?.message.slice(0, 160) ?? "spawn failed");
        });
        c.on("exit", () => {
          if (child === c) noteExit(`exit ${c.exitCode ?? "?"}${c.signalCode === null ? "" : `/${c.signalCode}`}`);
        });
      } catch (err) {
        cfg.log(`dev: the daemon wouldn't start (${err instanceof Error ? err.message.slice(0, 160) : "refused"})`);
        child = undefined;
        return { ok: false, code: null, out: "dev: spawn failed" };
      }
      cfg.log(`dev: started the dev daemon (pid ${child.pid ?? "?"})`);
      return { ok: true, code: 0, out: "dev: started" };
    },
    stop: () => {
      if (child === undefined) return;
      const c = child;
      child = undefined;
      try {
        // Windows: the whole tree (`bun`'s own child holds the daemon); elsewhere one process.
        if (platform === "win32" && c.pid !== undefined) killTree(c.pid);
        else c.kill("SIGTERM");
      } catch { /* gone */ }
    },
  };
}

// The app's side of installing and starting the daemon (spec §3.1 "The app can install, start and update the
// daemon"; "Each starts the other through the OS"). Lane C's daemon binary owns the login items (what the launchd
// plist, the `systemd --user` unit and the Task Scheduler task say, `clover-core supervise` on Windows) and starting
// itself through the OS; the app never names a launchd label, a unit or a task. It runs one command:
//
//   clover-core login status --json   → { "registered": boolean, "running"?: boolean }
//   clover-core login enable          registers the login item for this home (idempotent)
//   clover-core login start           starts the daemon through the OS now: `launchctl kickstart`,
//                                     `systemctl --user start`, `schtasks /Run` — never as the app's child
//
// each with `CLOVER_HOME` and `CLOVER_PROFILE` set, exit code 0 on success. That is the contract proposed to lane C
// (C-M1); a fake binary stands in for it in the tests.
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
    const env: NodeJS.ProcessEnv = { ...process.env, ...cfg.env, CLOVER_HOME: cfg.home, CLOVER_PROFILE: cfg.profile };
    delete env.ELECTRON_RUN_AS_NODE;
    execFile(cfg.binary, args, { env, timeout: cfg.timeoutMs ?? 15_000, windowsHide: true, encoding: "utf8" }, (err, stdout, stderr) => {
      const code = err === null ? 0 : typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === "number" ? ((err as unknown as { code: number }).code) : null;
      resolve({ ok: err === null, code, out: `${stdout ?? ""}${stderr ?? ""}`.trim().slice(0, 2000) });
    });
  });
}

export function cliLauncher(cfg: LauncherConfig): DaemonLauncher {
  return {
    async status() {
      const r = await run(cfg, ["login", "status", "--json"]);
      if (!r.ok) return undefined;
      try {
        const parsed = JSON.parse(r.out.split("\n").filter((l) => l.trim().startsWith("{")).pop() ?? "") as { registered?: unknown; running?: unknown };
        if (typeof parsed.registered !== "boolean") return undefined;
        return { registered: parsed.registered, ...(typeof parsed.running === "boolean" ? { running: parsed.running } : {}) };
      } catch {
        return undefined;
      }
    },
    enable: () => run(cfg, ["login", "enable"]),
    start: () => run(cfg, ["login", "start"]),
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

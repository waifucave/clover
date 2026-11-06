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
//   clover-core daemon check-server --json [--image <path>]
//                                   exits 0 with `{ ok, pid, userSid, image }` when this user's daemon (that binary)
//                                   serves the endpoint: the app's check before its hello, on Windows, where a pipe's
//                                   name is in a namespace every user shares (lane C, C-M1)
//
// each with `CLOVER_HOME` and `CLOVER_PROFILE` set, exit code 0 on success. A fake binary stands in for it in the
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
  /** Whether this user's daemon serves the endpoint (`daemon check-server`); the reason when it doesn't. */
  checkServer?(): Promise<{ ok: true } | { ok: false; reason: string }>;
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
    async checkServer() {
      const r = await run(cfg, ["daemon", "check-server", "--json", "--image", cfg.binary]);
      return parseServerCheck(r);
    },
  };
}

/** `daemon check-server --json`'s answer: ok only with exit 0 and `{ "ok": true }` on its last JSON line. */
export function parseServerCheck(r: LoginResult): { ok: true } | { ok: false; reason: string } {
  const json = r.out.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{")).pop();
  let parsed: { ok?: unknown; reason?: unknown } | undefined;
  try {
    parsed = json === undefined ? undefined : (JSON.parse(json) as { ok?: unknown; reason?: unknown });
  } catch {
    parsed = undefined;
  }
  if (r.ok && parsed?.ok === true) return { ok: true };
  const reason = typeof parsed?.reason === "string" ? parsed.reason.slice(0, 200) : r.ok ? "it said nothing the app understands" : `it exited with ${r.code ?? "a signal"}`;
  return { ok: false, reason };
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

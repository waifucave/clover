// Starting an agent's process (spec §9.3 "Local placement", spike S5 §7 "Launch", edits 4 and 10).
//
// * One agent process serves one delegation, contained as a group: on macOS and Linux it leads its own process group,
//   so `stop` reaches every child that stayed in it, and every descendant the process table still shows is ended
//   too (a command run under a terminal often starts its own session). On Windows the containment is a job object,
//   which needs lane C's native code; until it lands, `stop` ends the tree with `taskkill /T` (untested here).
// * Its environment comes from an allow-list (edit 4): a small base set every program needs, plus the names the
//   backend's quirks allow and set. Nothing named `CLOVER_*` passes, so no home path or token leaks to the agent; the
//   bridge's token goes only in the bridge entry's `env` at `session/new`.
// * Nothing it runs may open a window: `windowsHide`, and its stdio are pipes. Its stderr goes to the transcript,
//   which redacts the bridge's token.
// * Stop: the caller cancels first (`session/cancel`); then SIGTERM to the group, a grace period, SIGKILL. Both agents
//   S5 measured exited on SIGTERM.
import { spawn, type ChildProcess } from "node:child_process";
import { descendantsOf, readProcessTable, type ProcessTableReader } from "./table";

/** What every program needs to run, on each OS: no secrets, no Clover paths. */
export const BASE_ENV_ALLOW: readonly string[] = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TZ", "TMPDIR", "TERM",
  // Windows
  "SystemRoot", "SystemDrive", "windir", "ComSpec", "PATHEXT", "USERPROFILE", "USERNAME", "USERDOMAIN", "APPDATA", "LOCALAPPDATA",
  "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "CommonProgramFiles", "TEMP", "TMP", "HOMEDRIVE", "HOMEPATH", "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE", "OS",
  // Linux desktops
  "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME",
];

/** Builds an agent's environment from the allow-list (S5 edit 4). `LC_*` passes with the locale. Names Clover owns
 *  (`CLOVER_*`) never pass, whatever a backend's quirks list. */
export function buildAgentEnv(
  allow: readonly string[],
  set: Readonly<Record<string, string>>,
  base: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const names = new Set([...BASE_ENV_ALLOW, ...allow]);
  const lower = new Map([...names].map((n) => [n.toLowerCase(), n]));
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined || /^CLOVER_/i.test(name)) continue;
    // Windows names are case-insensitive (`Path`).
    const allowed = names.has(name) || /^LC_[A-Z_]+$/.test(name) || (process.platform === "win32" && lower.has(name.toLowerCase()));
    if (allowed) env[name] = value;
  }
  for (const [name, value] of Object.entries(set)) if (!/^CLOVER_/i.test(name)) env[name] = value;
  return env;
}

export interface LaunchSpec {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  /** Where the agent's stderr goes (the transcript, which redacts the bridge's token); dropped when unset. */
  onStderr?: (chunk: Uint8Array) => void;
}

export interface LaunchedAgent {
  readonly pid: number;
  readonly child: ChildProcess;
  /** Settles when the process has exited, with its code or signal. */
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  write(line: string): void;
  onData(fn: (chunk: Uint8Array) => void): void;
  /** Ends the group: SIGTERM, then SIGKILL after `graceMs` (and every descendant the table still shows). */
  stop(graceMs?: number): Promise<void>;
}

export const STOP_GRACE_MS = 3_000;

export function launchContained(spec: LaunchSpec, opts: { table?: ProcessTableReader } = {}): LaunchedAgent {
  const posix = process.platform !== "win32";
  const child = spawn(spec.command, [...spec.args], {
    cwd: spec.cwd,
    env: spec.env,
    stdio: ["pipe", "pipe", spec.onStderr ? "pipe" : "ignore"],
    // Its own process group on POSIX, so the group can be ended as one.
    detached: posix,
    windowsHide: true,
  });
  if (spec.onStderr) child.stderr?.on("data", (c: Buffer) => spec.onStderr!(c));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", () => resolve({ code: null, signal: null }));
  });
  if (child.pid === undefined) {
    // spawn failed (no such file): `exited` resolves from the error event; the caller sees pid 0.
  }
  const pid = child.pid ?? 0;
  const table = opts.table ?? readProcessTable;
  let stopping: Promise<void> | undefined;

  const signalGroup = (sig: NodeJS.Signals) => {
    if (!pid) return;
    try {
      if (posix) process.kill(-pid, sig);
      else child.kill(sig);
    } catch {
      // Already gone.
    }
  };

  return {
    pid,
    child,
    exited,
    write(line) {
      if (!child.stdin || child.stdin.destroyed) throw new Error("the agent's stdin is closed");
      child.stdin.write(line);
    },
    onData(fn) {
      child.stdout?.on("data", (c: Buffer) => fn(c));
    },
    stop(graceMs = STOP_GRACE_MS) {
      stopping ??= (async () => {
        if (!pid) return;
        if (!posix) {
          await taskkillTree(pid, false);
          const done = await Promise.race([exited.then(() => true), sleep(graceMs).then(() => false)]);
          if (!done) await taskkillTree(pid, true);
          return;
        }
        // Children that left the group (a terminal's own session) are found by ancestry before the root goes.
        const strays = await table().then((rows) => descendantsOf(rows, pid).map((r) => r.pid), () => [] as number[]);
        signalGroup("SIGTERM");
        for (const p of strays) safeKill(p, "SIGTERM");
        const done = await Promise.race([exited.then(() => true), sleep(graceMs).then(() => false)]);
        signalGroup("SIGKILL");
        for (const p of strays) safeKill(p, "SIGKILL");
        if (!done) await Promise.race([exited, sleep(graceMs)]);
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
      })();
      return stopping;
    },
  };
}

function safeKill(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    // Gone.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function taskkillTree(pid: number, force: boolean): Promise<void> {
  return new Promise((resolve) => {
    const c = spawn("taskkill", ["/pid", String(pid), "/T", ...(force ? ["/F"] : [])], { stdio: "ignore", windowsHide: true });
    c.on("close", () => resolve());
    c.on("error", () => resolve());
  });
}

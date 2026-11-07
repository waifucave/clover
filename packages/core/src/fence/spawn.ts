// The fenced spawn seam (lane C): one door for a process run for a session, a bot or a plugin hook. A-M3's turn loop
// calls `hookSpawner(os)` for a hook's `command` (Claude Code's hook protocol: JSON on stdin, JSON on stdout, exit code
// 2 to deny); bots' Bash goes through the fenced door when it runs under the fence on the three OSes (C-M2).
//
// A hook's command is plugin code, so it is treated as the plugin host is (the controller's ruling; spec §5.2,
// revision 13): fenced on macOS, and run as the user on Windows and Linux, where code the user installs is trusted.
// Until the fenced process lands on macOS that door says it is closed (`available: false`) and refuses every run with
// the reason, so a caller skips the hook and reports it rather than running it outside the fence.
import { existsSync } from "node:fs";
import { win32 } from "node:path";
import { AgentJob } from "../platform/win-job";
import type { Caller, Os } from "@waifucave/clover-protocol";

export interface FencedRun {
  /** A shell command line, run by the platform's shell: `/bin/sh -c` on macOS and Linux; on Windows Git Bash
   *  (`bash -c`) from its standard install, else `cmd.exe /d /s /c` (`windowsHookShell`). */
  readonly command: string;
  readonly cwd: string;
  /** The child's whole environment: nothing is inherited past this. */
  readonly env: Readonly<Record<string, string>>;
  /** Written to the child's stdin, which is then closed. */
  readonly stdin?: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** Whose run it is: the fence's set, the home default-deny's allows, and the network rule are this caller's. */
  readonly who: {
    readonly caller: Caller; readonly hook?: string;
  };
}

/** The shell that ran the command, for the hook's record. */
export type RunShell = "sh" | "git-bash" | "cmd";

export type FencedRunResult =
  | { readonly kind: "exited"; readonly code: number; readonly stdout: string; readonly stderr: string; readonly shell: RunShell }
  | { readonly kind: "timeout"; readonly stdout: string; readonly stderr: string; readonly shell: RunShell }
  | { readonly kind: "refused"; readonly reason: string };

export interface FencedSpawner {
  /** False while no fenced process can be started on this OS: `run` refuses every call. */
  readonly available: boolean;
  run(run: FencedRun): Promise<FencedRunResult>;
}

/** The door until the fenced process lands for this OS (C-M2's Bash under the fence). */
export const FENCED_SPAWN_NOT_YET: FencedSpawner = {
  available: false,
  run: async () => ({ kind: "refused", reason: "a fenced process can't be started on this computer yet (lane C, C-M2)" }),
};

/** Each stream's cap: past it, the rest is dropped. */
const OUTPUT_CAP = 1024 * 1024;

/** Runs a command as the user, with no sandbox: Windows and Linux hooks (plugin code the user installed). Its own
 *  process group (POSIX) or job (Windows), so a timeout ends everything it started. */
export const RUN_AS_USER: FencedSpawner = {
  available: true,
  run: (r) => runAsUser(r),
};

/** The door for a hook's command on `os`: the fenced one on macOS (`fenced`, closed until it lands), the user's
 *  elsewhere. */
export function hookSpawner(os: Os, fenced: FencedSpawner = FENCED_SPAWN_NOT_YET): FencedSpawner {
  return os === "macos" ? fenced : RUN_AS_USER;
}

/** Windows: Git Bash from its two standard installs (for all users, then for this user), for hooks written for
 *  Claude Code; never found through PATH, which a bot's Bash could change. Else `cmd` (the controller's ruling). */
export function windowsHookShell(env: Readonly<Record<string, string | undefined>> = process.env, exists: (path: string) => boolean = existsSync): { shell: RunShell; argv: (command: string) => string[] } {
  const places = [env.ProgramFiles && win32.join(env.ProgramFiles, "Git", "bin", "bash.exe"), env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe")];
  const bash = places.find((p): p is string => typeof p === "string" && exists(p));
  if (bash) return { shell: "git-bash", argv: (command) => [bash, "-c", command] };
  const cmd = env.SystemRoot ? win32.join(env.SystemRoot, "System32", "cmd.exe") : "cmd.exe";
  return { shell: "cmd", argv: (command) => [cmd, "/d", "/s", "/c", `"${command}"`] };
}

function runAsUser(r: FencedRun): Promise<FencedRunResult> {
  const winShell = process.platform === "win32" ? windowsHookShell() : null;
  return runCommand(r, winShell ? { shell: winShell.shell, argv: winShell.argv(r.command) } : { shell: "sh", argv: ["/bin/sh", "-c", r.command] });
}

/** Runs `how.argv` for `r` (a shell, or a sandbox wrapping one): stdin written and closed, both streams capped, its own
 *  process group (POSIX) or job (Windows) ended at its limit and at its end, the shell's exit deciding. */
export async function runCommand(r: FencedRun, how: { shell: RunShell; argv: readonly string[]; extraFds?: readonly number[] }): Promise<FencedRunResult> {
  if (r.signal?.aborted) return { kind: "refused", reason: "cancelled before it started" };
  const win = process.platform === "win32";
  const { shell } = how;
  const argv = [...how.argv];
  let proc: ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">>;
  try {
    proc = Bun.spawn(argv, { cwd: r.cwd, env: { ...r.env }, stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: !win, windowsHide: true,
      ...(how.extraFds?.length ? { stdio: ["pipe", "pipe", "pipe", ...how.extraFds] } : {}),
      ...(shell === "cmd" ? { windowsVerbatimArguments: true } : {}) }) as typeof proc;
  } catch (err) {
    return { kind: "refused", reason: `it couldn't start: ${err instanceof Error ? err.message : String(err)}` };
  }
  const job = win ? AgentJob.create() : null;
  if (job && !job.assign(proc.pid)) { /* gone already, or not ours: the kill below still ends the shell */ }
  let timedOut = false;
  const end = () => {
    if (job) job.terminate(1);
    else try { process.kill(-proc.pid, "SIGKILL"); } catch { /* gone */ }
    try { proc.kill("SIGKILL"); } catch { /* gone */ }
  };
  const timer = setTimeout(() => { timedOut = true; end(); }, r.timeoutMs);
  const onAbort = () => { timedOut = true; end(); };
  r.signal?.addEventListener("abort", onAbort, { once: true });
  try { if (r.stdin !== undefined) proc.stdin.write(r.stdin); await proc.stdin.end(); } catch { /* it closed its stdin */ }
  const got = { stdout: "", stderr: "" };
  const read = async (s: ReadableStream<Uint8Array>, into: "stdout" | "stderr") => {
    const reader = s.getReader();
    const dec = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (got[into].length < OUTPUT_CAP) got[into] += dec.decode(value, { stream: true });
      }
    } catch { /* the pipe failed */ }
  };
  // The shell's exit decides: output still coming through a pipe something it started holds open gets a moment.
  const reading = Promise.all([read(proc.stdout, "stdout"), read(proc.stderr, "stderr")]);
  const code = await proc.exited;
  clearTimeout(timer);
  r.signal?.removeEventListener("abort", onAbort);
  let grace: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([reading, new Promise<void>((res) => { grace = setTimeout(res, 2_000); })]);
  clearTimeout(grace);
  // What the hook left running ends with it, as on a timeout: a hook is one bounded step of a turn.
  if (job) job.close();
  else try { process.kill(-proc.pid, "SIGKILL"); } catch { /* nothing left */ }
  const stdout = got.stdout.slice(0, OUTPUT_CAP), stderr = got.stderr.slice(0, OUTPUT_CAP);
  if (timedOut) return { kind: "timeout", stdout, stderr, shell };
  return { kind: "exited", code, stdout, stderr, shell };
}

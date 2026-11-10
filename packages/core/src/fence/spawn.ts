// The fenced spawn seam (lane C): one door for a process run for a session, a bot or a plugin hook. A-M3's turn loop
// calls `hookSpawner(os)` for a hook's `command` (Claude Code's hook protocol: JSON on stdin, JSON on stdout, exit code
// 2 to deny); bots' Bash goes through the fenced door when it runs under the fence on the three OSes (C-M2).
//
// A hook's command is plugin code, so it is treated as the plugin host is (the controller's ruling; spec §5.2,
// revision 13): fenced on macOS, and run as the user on Windows and Linux, where code the user installs is trusted.
// Until the fenced process lands on macOS that door says it is closed (`available: false`) and refuses every run with
// the reason, so a caller skips the hook and reports it rather than running it outside the fence.
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
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
  /** The second line behind each run's git-key revert (#321's review): the watched git config files the session's
   *  runs touched are looked at again, and a risky key set since the last look is reverted the same way. INT calls it
   *  after EACH Bash or Monitor call ends (PostToolUse) of a session whose commands run elsewhere, and at a turn's and
   *  a session's end. A watched session's writable folders are looked over again first, so a repo made since is
   *  watched as newly appeared. `end` forgets the session. The report line, or null. */
  recheck?(sessionId: string, opts?: { end?: boolean }): string | null;
  /** For a session whose commands don't come through `run` (a bot's Bash in the runtime's own sandbox), at its
   *  start: watch, from now, the git configs of its `cwd`'s repo, the user's global ones, and every repo's in
   *  `writable`, the folders it can write (a bot: every bot's scratch folder and memory, its own outputs and
   *  routines), looked over again at each `recheck`. A file already watched keeps its baseline; a later call adds
   *  folders. */
  watch?(sessionId: string, cwd: string, writable?: readonly string[]): void;
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

/** macOS: how a run's descendants are ended at its end (#321's review: a `set -m` job leaves the process group, so the
 *  group's kill misses it). `holder`: the command runs under the process holder (agent SDK's `native/process-holder.c`,
 *  lane M ships it beside the core), to which everything it starts is responsible, a setsid'd or double-forked process
 *  included; its SIGTERM ends them all. `tree`: without a holder, the process tree is recorded while the run lasts
 *  (every 50 ms, each process by pid and start time) and every process in it is killed at the end; a process that
 *  forks and leaves within one look is out of its sight, which the holder isn't. */
export type DescendantEnd = { readonly kind: "holder"; readonly holder: string } | { readonly kind: "tree" };

/** One look at this computer's processes: pid, parent pid and start time (`ps`'s `lstart`). */
function processTable(): Map<number, { ppid: number; start: string }> {
  const out = new Map<number, { ppid: number; start: string }>();
  const r = Bun.spawnSync(["/bin/ps", "-A", "-o", "pid=,ppid=,lstart="], { stdout: "pipe", stderr: "ignore" });
  for (const line of new TextDecoder().decode(r.stdout).split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (m) out.set(Number(m[1]), { ppid: Number(m[2]), start: m[3]! });
  }
  return out;
}

let getsidFn: ((pid: number) => number) | null | undefined;
/** `getsid(2)` (macOS), or null where it can't be loaded. */
function getsid(): ((pid: number) => number) | null {
  if (getsidFn !== undefined) return getsidFn;
  try {
    const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi");
    const lib = dlopen("/usr/lib/libSystem.B.dylib", { getsid: { args: [FFIType.i32], returns: FFIType.i32 } });
    getsidFn = (pid) => lib.symbols.getsid(pid) as number;
  } catch { getsidFn = null; }
  return getsidFn;
}

/** The descendants of `leader` (a session leader: the spawn is `detached`) while a run lasts: every process still in
 *  its session at the end (a `set -m` job leaves the group, never the session), and the tree recorded every 50 ms (each
 *  by pid and start time, so a pid used again later is never taken for it), which also keeps one that made a session
 *  of its own while it was seen. */
class TreeRecorder {
  readonly #known = new Map<number, string>();
  readonly #leader: number;
  #timer: ReturnType<typeof setInterval> | undefined;
  constructor(leader: number) {
    this.#leader = leader;
    this.look();
    this.#timer = setInterval(() => this.look(), 50);
  }
  /** Adds every process whose parent is the leader or one already known (an orphan stays known after it's reparented). */
  look(): Map<number, { ppid: number; start: string }> {
    const table = processTable();
    let grew = true;
    while (grew) {
      grew = false;
      for (const [pid, p] of table) {
        if (this.#known.has(pid) || pid === this.#leader) continue;
        if (p.ppid === this.#leader || (this.#known.has(p.ppid) && table.get(p.ppid)?.start === this.#known.get(p.ppid))) {
          this.#known.set(pid, p.start);
          grew = true;
        }
      }
    }
    return table;
  }
  stop(): void { if (this.#timer) clearInterval(this.#timer); this.#timer = undefined; }
  /** Kills every process still in the leader's session and every known one still alive as itself, and looks again
   *  until none is left (at most `passes`). */
  async endAll(passes = 20): Promise<void> {
    this.stop();
    const sid = getsid();
    for (let i = 0; i < passes; i++) {
      const table = this.look();
      const alive = new Set([...this.#known].filter(([pid, start]) => table.get(pid)?.start === start).map(([pid]) => pid));
      if (sid !== null) for (const pid of table.keys()) if (pid > 1 && pid !== process.pid && sid(pid) === this.#leader) alive.add(pid);
      if (alive.size === 0) return;
      for (const pid of alive) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
      await Bun.sleep(20);
    }
  }
}

/** Runs `how.argv` for `r` (a shell, or a sandbox wrapping one): stdin written and closed, both streams capped, its own
 *  process group (POSIX) or job (Windows) ended at its limit and at its end, the shell's exit deciding. On macOS with
 *  `descendants`, every process the command started is ended too (`DescendantEnd`), before this returns. */
export async function runCommand(r: FencedRun, how: { shell: RunShell; argv: readonly string[]; extraFds?: readonly number[]; descendants?: DescendantEnd }): Promise<FencedRunResult> {
  if (r.signal?.aborted) return { kind: "refused", reason: "cancelled before it started" };
  const win = process.platform === "win32";
  const { shell } = how;
  const extraFds = [...(how.extraFds ?? [])];
  let argv = [...how.argv];
  // The holder: `<holder> <status-fd> <file> [args...]`; its status (`exit <code> …` or `signal <n> …`) lands in a file
  // only this run uses, the child's next fd.
  let status: { dir: string; file: string; fd: number } | undefined;
  if (how.descendants?.kind === "holder") {
    const dir = mkdtempSync(join(tmpdir(), "clover-holder-"));
    const file = join(dir, "status");
    const fd = openSync(file, "w", 0o600);
    status = { dir, file, fd };
    argv = [how.descendants.holder, String(3 + extraFds.length), ...argv];
    extraFds.push(fd);
  }
  const cleanup = () => {
    if (!status) return;
    try { closeSync(status.fd); } catch { /* closed */ }
    rmSync(status.dir, { recursive: true, force: true });
  };
  let proc: ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">>;
  try {
    proc = Bun.spawn(argv, { cwd: r.cwd, env: { ...r.env }, stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: !win, windowsHide: true,
      ...(extraFds.length ? { stdio: ["pipe", "pipe", "pipe", ...extraFds] } : {}),
      ...(shell === "cmd" ? { windowsVerbatimArguments: true } : {}) }) as typeof proc;
  } catch (err) {
    cleanup();
    return { kind: "refused", reason: `it couldn't start: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (status) { try { closeSync(status.fd); } catch { /* closed */ } }
  const tree = how.descendants?.kind === "tree" ? new TreeRecorder(proc.pid) : undefined;
  const job = win ? AgentJob.create() : null;
  if (job && !job.assign(proc.pid)) { /* gone already, or not ours: the kill below still ends the shell */ }
  let timedOut = false;
  // The holder ends what it holds on SIGTERM (two seconds' grace, then SIGKILL passes) and exits; the host's own
  // SIGKILL to the group follows only once it has, or after a bound.
  const endHolder = async () => {
    try { proc.kill("SIGTERM"); } catch { /* gone */ }
    await Promise.race([proc.exited, Bun.sleep(15_000)]);
  };
  const end = () => {
    if (job) job.terminate(1);
    else if (status) { void endHolder().then(() => { try { process.kill(-proc.pid, "SIGKILL"); } catch { /* gone */ } }); return; }
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
  // The shell's exit decides: output still coming through a pipe something it started holds open gets a moment. Under
  // the holder, the command's exit is the holder's status line (the holder itself stays while anything is left).
  const reading = Promise.all([read(proc.stdout, "stdout"), read(proc.stderr, "stderr")]);
  let code: number;
  if (status) {
    const st = status;
    const commandEnded = async (): Promise<number | null> => {
      for (;;) {
        let text = "";
        try { text = readFileSync(st.file, "utf8"); } catch { /* not yet */ }
        const m = /^(exit|signal) (\d+)/m.exec(text);
        if (m) return m[1] === "exit" ? Number(m[2]) : 128 + Number(m[2]);
        if (proc.exitCode !== null || proc.signalCode !== null) return null;
        await Bun.sleep(25);
      }
    };
    const ended = await commandEnded();
    code = ended ?? (await proc.exited);
  } else {
    code = await proc.exited;
  }
  clearTimeout(timer);
  r.signal?.removeEventListener("abort", onAbort);
  let grace: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([reading, new Promise<void>((res) => { grace = setTimeout(res, 2_000); })]);
  clearTimeout(grace);
  // What the command left running ends with it, as on a timeout: a command is one bounded step of a turn. Every
  // descendant first (the holder's, or the recorded tree), then the group.
  if (status) await endHolder();
  if (tree) await tree.endAll();
  if (job) job.close();
  else try { process.kill(-proc.pid, "SIGKILL"); } catch { /* nothing left */ }
  cleanup();
  const stdout = got.stdout.slice(0, OUTPUT_CAP), stderr = got.stderr.slice(0, OUTPUT_CAP);
  if (timedOut) return { kind: "timeout", stdout, stderr, shell };
  return { kind: "exited", code, stdout, stderr, shell };
}

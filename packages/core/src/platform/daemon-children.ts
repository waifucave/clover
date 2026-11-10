// The daemon claims the processes it starts (review B1), so the caller check can tell them from the user's own.
// "However indirectly" means within the daemon's process tree; what a process asks the OS to start for it (launchd,
// `open`, `systemd-run`, the Task Scheduler) is closed to fenced processes by C-M2's fence.
//   Linux    PR_SET_CHILD_SUBREAPER: a child that double-forks is re-parented to the daemon, not to init, so the
//            daemon stays among its parents
//   Windows  the daemon's own job (win-job.ts): every process it starts runs in it
//   macOS    a double fork is re-parented to launchd, but it keeps its responsible process (the one TCC attributes
//            it to). That is the daemon only when the daemon is its own responsible process, so `supervise` starts
//            the daemon with responsibility disclaimed (`spawnDisclaimed`); a daemon run straight from a terminal
//            would stay the terminal's, so a daemon that finds it isn't its own responsible process re-executes itself in
//            place (same pid) with responsibility disclaimed (`becomeOwnResponsible`) before it starts anything. Then a
//            child that double-forks, calls `setsid` and is reparented to launchd is still the daemon's (A's #416 gap).
// `spawnedByDaemon` (caller-probe.ts) then reads the result.
import { ffiLib, ffiPtr as ptr } from "./ffi";
import { enterDaemonJob } from "./win-job";

const PR_SET_CHILD_SUBREAPER = 36;

/** What the daemon set up: `subreaper` on Linux, `job` on Windows; macOS needs neither. */
export function claimDaemonChildren(): { subreaper: boolean; job: boolean } {
  if (process.platform === "win32") return { subreaper: false, job: enterDaemonJob() };
  if (process.platform !== "linux") return { subreaper: false, job: false };
  const libc = ffiLib("linux-prctl", "libc.so.6", { prctl: { args: ["i32", "u64", "u64", "u64", "u64"], returns: "i32" } });
  const ok = libc?.prctl?.(PR_SET_CHILD_SUBREAPER, 1n, 0n, 0n, 0n) === 0;
  return { subreaper: ok, job: false };
}

function spawnLib() {
  return ffiLib("darwin-spawn", "/usr/lib/libSystem.B.dylib", {
    posix_spawnattr_init: { args: ["ptr"], returns: "i32" },
    posix_spawnattr_setflags: { args: ["ptr", "i16"], returns: "i32" },
    responsibility_get_pid_responsible_for_pid: { args: ["i32"], returns: "i32" },
    posix_spawnattr_destroy: { args: ["ptr"], returns: "i32" },
    responsibility_spawnattrs_setdisclaim: { args: ["ptr", "i32"], returns: "i32" },
    posix_spawn: { args: ["ptr", "ptr", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
    waitpid: { args: ["i32", "ptr", "i32"], returns: "i32" },
  });
}

const POSIX_SPAWN_SETEXEC = 0x40;

/** Set on the one re-exec `becomeOwnResponsible` makes, and taken out of this process's environment at once, so no
 *  child inherits it: a second start that still isn't its own responsible process stops there (#418's review). */
export const REEXEC_SENTINEL = "CLOVER_REEXEC";

/** The argv that runs this process again: the compiled binary with its own arguments, or the runtime with its flags
 *  (`execArgv`: `--smol`, a preload) and its script. */
export function selfArgv(argv: readonly string[] = process.argv, execPath: string = process.execPath, execArgv: readonly string[] = process.execArgv): string[] {
  // A compiled Bun binary reports its embedded entry (`/$bunfs/...`) as argv[1]; the binary itself takes the rest.
  if (argv[1]?.startsWith("/$bunfs/") || argv[1]?.startsWith("B:/~BUN/")) return [execPath, ...argv.slice(2)];
  return [execPath, ...execArgv, ...argv.slice(1)];
}

export interface OwnResponsibilityOptions {
  argv?: readonly string[];
  env?: Record<string, string | undefined>;
  /** Tests only: leave the disclaim out of the re-exec, as if it didn't take. */
  disclaim?: boolean;
}

/** macOS: makes this process its own responsible process, as `supervise` starts the daemon (review B1, A's #416 gap):
 *  when it isn't, it re-executes itself in place (`POSIX_SPAWN_SETEXEC`: the same pid, descriptors and environment,
 *  with `REEXEC_SENTINEL` set) with responsibility disclaimed, and never returns. Once only: a start that finds the
 *  sentinel and still isn't its own (the disclaim didn't take) returns `"failed"`, and the parent chain and the floor
 *  stand as before. `"own"` when it is, `"skipped"` off macOS, `"failed"` when the re-exec was refused or didn't take.
 *  The sentinel is always taken out of this process's environment. Call it before anything else the start does. */
export function becomeOwnResponsible(o: OwnResponsibilityOptions = {}): "own" | "skipped" | "failed" {
  const env = o.env ?? process.env;
  const again = env[REEXEC_SENTINEL] === "1";
  delete env[REEXEC_SENTINEL];
  if (process.platform !== "darwin") return "skipped";
  const lib = spawnLib();
  if (!lib) return "failed";
  if ((lib.responsibility_get_pid_responsible_for_pid!(process.pid) as number) === process.pid) return "own";
  if (again) return "failed"; // re-executed once already, and still not its own: never loop
  const argv = o.argv ?? selfArgv();
  const keep: Buffer[] = [];
  const cstr = (s: string) => { const b = Buffer.from(`${s}\0`, "utf8"); keep.push(b); return BigInt(ptr(b) as number); };
  const array = (items: readonly string[]) => { const a = new BigUint64Array(items.length + 1); items.forEach((s, i) => { a[i] = cstr(s); }); return a; };
  const args = array(argv);
  const envp = array([...Object.entries(env).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`), `${REEXEC_SENTINEL}=1`]);
  const file = Buffer.from(`${argv[0]}\0`, "utf8");
  keep.push(file);
  const attr = new BigUint64Array(1);
  if ((lib.posix_spawnattr_init!(ptr(attr)) as number) !== 0) return "failed";
  try {
    if (o.disclaim !== false && (lib.responsibility_spawnattrs_setdisclaim!(ptr(attr), 1) as number) !== 0) return "failed";
    if ((lib.posix_spawnattr_setflags!(ptr(attr), POSIX_SPAWN_SETEXEC) as number) !== 0) return "failed";
    const pid = new Int32Array(1);
    // On success this doesn't return: the process image is replaced.
    lib.posix_spawn!(ptr(pid), ptr(file), null, ptr(attr), ptr(args), ptr(envp));
    return "failed";
  } finally { lib.posix_spawnattr_destroy!(ptr(attr)); void keep; }
}

/** A process `spawnDisclaimed` started: its pid and how it ended (a signal as 128 + its number). */
export interface DisclaimedProcess { readonly pid: number; readonly exited: Promise<number> }

/** macOS: start `argv` (an absolute path first) with responsibility disclaimed, so it is its own responsible process,
 *  as launchd's jobs are; stdio and the environment are this process's. Null off macOS or when it can't. */
export function spawnDisclaimed(argv: readonly string[], env: Record<string, string | undefined> = process.env): DisclaimedProcess | null {
  if (process.platform !== "darwin") return null;
  const lib = spawnLib();
  if (!lib) return null;
  const keep: Buffer[] = [];
  const cstr = (s: string) => { const b = Buffer.from(`${s}\0`, "utf8"); keep.push(b); return BigInt(ptr(b) as number); };
  const array = (items: readonly string[]) => { const a = new BigUint64Array(items.length + 1); items.forEach((s, i) => { a[i] = cstr(s); }); return a; };
  const args = array(argv);
  const envp = array(Object.entries(env).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`));
  const attr = new BigUint64Array(1);
  if ((lib.posix_spawnattr_init!(ptr(attr)) as number) !== 0) return null;
  try {
    if ((lib.responsibility_spawnattrs_setdisclaim!(ptr(attr), 1) as number) !== 0) return null;
    const pid = new Int32Array(1);
    const file = Buffer.from(`${argv[0]}\0`, "utf8");
    keep.push(file);
    if ((lib.posix_spawn!(ptr(pid), ptr(file), null, ptr(attr), ptr(args), ptr(envp)) as number) !== 0) return null;
    const child = pid[0]!;
    const exited = new Promise<number>((resolve) => {
      const status = new Int32Array(1);
      // Reaps the child if it has exited; its code (a signal as 128 + its number), or null while it runs.
      const reap = (): number | null => {
        const r = lib.waitpid!(child, ptr(status), 1 /* WNOHANG */) as number;
        if (r === 0) return null;
        const st = status[0]!;
        return r < 0 ? 1 : (st & 0x7f) === 0 ? (st >> 8) & 0xff : 128 + (st & 0x7f);
      };
      // Told of the exit by libdispatch (a DISPATCH_SOURCE_TYPE_PROC source for DISPATCH_PROC_EXIT), not by polling;
      // the poll is only the fallback when the source can't be made.
      // The exit can be told a moment before waitpid can reap it (#205's minor): the reap is retried briefly then,
      // never taken for a code of 1 at once.
      const reapSoon = (tries: number) => {
        const code = reap();
        if (code !== null) resolve(code);
        else if (tries > 0) setTimeout(() => reapSoon(tries - 1), 10);
        else resolve(1);
      };
      if (watchExit(child, () => reapSoon(200))) {
        // A child that exited before the source was armed: reaped here (resolving twice is a no-op).
        setTimeout(() => { const code = reap(); if (code !== null) resolve(code); }, 0);
      } else {
        const timer = setInterval(() => { const code = reap(); if (code !== null) { clearInterval(timer); resolve(code); } }, 100);
      }
    });
    return { pid: child, exited };
  } finally {
    lib.posix_spawnattr_destroy!(ptr(attr));
    void keep;
  }
}

const DISPATCH_PROC_EXIT = 0x80000000;

function dispatchLib() {
  return ffiLib("darwin-dispatch", "/usr/lib/libSystem.B.dylib", {
    dlopen: { args: ["ptr", "i32"], returns: "ptr" },
    dlsym: { args: ["ptr", "ptr"], returns: "ptr" },
    dispatch_get_global_queue: { args: ["i64", "u64"], returns: "ptr" },
    dispatch_source_create: { args: ["ptr", "u64", "u64", "ptr"], returns: "ptr" },
    dispatch_source_set_event_handler_f: { args: ["ptr", "ptr"], returns: "void" },
    dispatch_source_cancel: { args: ["ptr"], returns: "void" },
    dispatch_resume: { args: ["ptr"], returns: "void" },
    dispatch_release: { args: ["ptr"], returns: "void" },
  });
}

/** Calls `onExit` once, on this thread, when process `pid` exits. False when libdispatch's source can't be made. */
function watchExit(pid: number, onExit: () => void): boolean {
  const d = dispatchLib();
  if (!d) return false;
  try {
    const { JSCallback } = require("bun:ffi") as typeof import("bun:ffi");
    const self = d.dlopen!(null, 2 /* RTLD_NOW */);
    const type = self ? d.dlsym!(self, ptr(Buffer.from("_dispatch_source_type_proc\0"))) : null;
    if (!type) return false;
    const source = d.dispatch_source_create!(type, BigInt(pid), BigInt(DISPATCH_PROC_EXIT), d.dispatch_get_global_queue!(0n, 0n));
    if (!source) return false;
    let fired = false;
    // Threadsafe: libdispatch runs the handler on one of its threads; Bun queues the call onto this one.
    const cb = new JSCallback(() => {
      if (fired) return;
      fired = true;
      d.dispatch_source_cancel!(source);
      d.dispatch_release!(source);
      setTimeout(() => cb.close(), 0);
      onExit();
    }, { args: ["ptr"], returns: "void", threadsafe: true });
    d.dispatch_source_set_event_handler_f!(source, cb.ptr);
    d.dispatch_resume!(source);
    return true;
  } catch {
    return false;
  }
}

// What a test may ask of a process, and a process-wide state a test may set: both for the Linux fact that
// `kill(pid, 0)` succeeds on a ZOMBIE (a process that has ended and is not yet waited for).
//
// Why it matters. `startDaemon` makes its process a child subreaper (PR_SET_CHILD_SUBREAPER,
// platform/daemon-children.ts), and nothing undoes it, so every test file that runs after a daemon test in the same
// `bun test` process runs in that state. There an orphaned process (a server's own child, left behind when the
// server is stopped) is re-parented to the test process instead of init. Bun never waits for a process it didn't
// start itself, so once killed it stays a zombie for the rest of the run: gone as far as anything is concerned, and
// still "alive" to `process.kill(pid, 0)`. A test that waits on `kill(pid, 0)` for such a process to disappear then
// passes or fails by which files ran before it, which is what moved `stdio-mcp-stops` from CI's shard 1 to shard 3.
import { readFileSync } from "node:fs";
import { ffiLib, ffiPtr } from "../../src/platform/ffi";

/** Whether `pid` is a process that still runs. Not a zombie: on Linux `/proc/<pid>/stat` says `Z` for one that has
 *  ended and awaits its parent's wait, `X` for one being removed. Elsewhere `kill(pid, 0)` is the whole answer (macOS
 *  re-parents an orphan to launchd, which reaps it, and a zombie there is not a state a test sees for long). */
export function running(pid: number): boolean {
  try { process.kill(pid, 0); } catch (err) { return (err as NodeJS.ErrnoException).code === "EPERM"; }
  if (process.platform !== "linux") return true;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // "pid (comm) S …": comm may hold spaces and parentheses, so the state is the first field after the LAST ")".
    const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
    return state !== "Z" && state !== "X";
  } catch {
    return false; // it ended between the signal and the read
  }
}

const PR_SET_CHILD_SUBREAPER = 36;
const PR_GET_CHILD_SUBREAPER = 37;

function prctl() {
  return ffiLib("linux-prctl", "libc.so.6", { prctl: { args: ["i32", "u64", "u64", "u64", "u64"], returns: "i32" } })?.prctl;
}

/** Linux: whether this process is a child subreaper. `undefined` where it can't be asked (not Linux, or no libc). */
export function isSubreaper(): boolean | undefined {
  const call = prctl();
  if (process.platform !== "linux" || !call) return undefined;
  const flag = new Int32Array(1);
  return call(PR_GET_CHILD_SUBREAPER, BigInt(ffiPtr(flag) as number), 0n, 0n, 0n) === 0 ? flag[0] === 1 : undefined;
}

/** Makes this process a child subreaper, as a daemon test leaves it, and returns what undoes that (back to what it
 *  was). A no-op off Linux. A test that depends on the state, or on being free of it, sets it and undoes it itself,
 *  so what it sees never depends on the files that ran before it. */
export function becomeSubreaper(on = true): () => void {
  const was = isSubreaper();
  const call = prctl();
  if (was === undefined || !call) return () => {};
  call(PR_SET_CHILD_SUBREAPER, on ? 1n : 0n, 0n, 0n, 0n);
  return () => { call(PR_SET_CHILD_SUBREAPER, was ? 1n : 0n, 0n, 0n, 0n); };
}

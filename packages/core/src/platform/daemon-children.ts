// The daemon claims the processes it starts (review B1), so the caller check can tell them from the user's own:
//   Linux    PR_SET_CHILD_SUBREAPER: a child that double-forks is re-parented to the daemon, not to init, so the
//            daemon stays among its parents
//   Windows  the daemon's own job (win-job.ts): every process it starts runs in it
//   macOS    nothing to set: the responsible process stays the daemon's through a double fork (caller-probe.ts)
// `spawnedByDaemon` (caller-probe.ts) then reads the result.
import { ffiLib } from "./ffi";
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

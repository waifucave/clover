// The Linux sandbox's supervisor worker: installs the user-notification filter on its own thread, spawns the
// sandboxed command under it, and reports back. The main thread never installs the filter, so spawning never
// deadlocks against it; both threads share the fd table, so no fd passing is needed and the listener applies
// process-wide. Runs via `new Worker` from the sandbox shim; talks to it only through the shared flag word.
import { buildUserNotifFilter, installUserNotifFilter, openSupervisorLib } from "./linux-supervisor";

export interface SupervisorRequest {
  /** bwrap and its arguments, run with stdio ["inherit","inherit","inherit",seccompFd]. */
  readonly argv: readonly string[];
  /** Environment for the command. */
  readonly env: Record<string, string>;
  /** bwrap's `--seccomp` fd number in this process (3, passed through from runCommand). */
  readonly seccompFd: number;
  /** Shared flag word: [state, exitCode, listener]. The listener fd is process-wide, so no fd passing is needed. */
  readonly shared: SharedArrayBuffer;
}

/** States in shared[0]: waiting, the filter is on and the command runs, the supervisor is unavailable, done.
 *  shared[1] carries the command's exit code, shared[2] the listener fd. */
export const SupervisorState = { Waiting: 0, Running: 1, Unsupported: 2, Done: 3 } as const;

declare const self: {
  onmessage: ((e: { data: SupervisorRequest }) => void) | null;
};

self.onmessage = (e: { data: SupervisorRequest }) => {
  void run(e.data).catch(() => {
    try {
      const flag = new Int32Array(e.data.shared);
      Atomics.store(flag, 0, SupervisorState.Unsupported);
      Atomics.notify(flag, 0);
    } catch { /* main falls back to belt-only */ }
  });
};

async function run(r: SupervisorRequest): Promise<void> {
  const flag = new Int32Array(r.shared);
  const fail = () => {
    Atomics.store(flag, 0, SupervisorState.Unsupported);
    Atomics.notify(flag, 0);
  };
  const lib = openSupervisorLib();
  if (lib === null) return fail();
  const filter = buildUserNotifFilter();
  if (filter === null) return fail();
  const listener = installUserNotifFilter(lib, filter);
  if (listener === null) return fail();
  // The filter is on this thread from here: publish the listener (process-wide fd, no passing needed), signal,
  // and spawn bwrap under it. Our own spawn-time traps are answered by the supervisor; nothing here needs disk.
  Atomics.store(flag, 2, listener);
  Atomics.store(flag, 0, SupervisorState.Running);
  Atomics.notify(flag, 0);
  const child = Bun.spawn(r.argv as string[], { stdio: ["inherit", "inherit", "inherit", r.seccompFd], env: r.env });
  const code = await child.exited;
  Atomics.store(flag, 1, typeof code === "number" ? code : 128);
  Atomics.store(flag, 0, SupervisorState.Done);
  Atomics.notify(flag, 0);
}

// The Linux sandbox's pre-exec shim: runs the command under bwrap, supervised by user-notify. A worker thread
// installs the filter and spawns bwrap under it (a single thread can never install-then-spawn: its own spawn
// would trap with nobody to answer); this thread never installs it, so spawning it is safe, and supervises every
// trapped call. Both threads share the fd table, so the listener the worker's install returns is usable here with
// no fd passing.
//
// Fail closed: if the supervisor can't start (no library, no filter for this arch, no worker, the 10 s install
// timeout, a refused install), the sandbox never runs the command. The shim exits 127 with a `(closed)` marker;
// the fenced process maps that to a refusal. A command that prints the marker and exits 127 only refuses itself.
// Usage: `shim <bwrap> <bwrap args...>`, with the supervised folders as JSON in `CLOVER_SUPERVISED_FILES` and
// bwrap's seccomp filter on fd 3.
import { openSupervisorLib, supervise } from "./linux-supervisor";
import { SupervisorState, type SupervisorRequest } from "./linux-supervisor-worker";

/** The shim's closed marker (stderr) and exit code: the fenced process refuses the run on both together. */
export const SUPERVISOR_CLOSED_MARKER = "clover: no user-notification supervisor here (closed)";
const CLOSED_CODE = 127;

async function main(): Promise<number> {
  const [, , bwrap, ...args] = process.argv;
  if (bwrap === undefined) {
    console.error("clover: the sandbox shim needs bwrap's path and arguments");
    return 127;
  }
  const unsafe: string[] = JSON.parse(process.env.CLOVER_SUPERVISED_FILES ?? "[]") as string[];
  const closed = (why: string): number => {
    console.error(`${SUPERVISOR_CLOSED_MARKER}: ${why}`);
    return CLOSED_CODE;
  };
  const lib = openSupervisorLib();
  if (lib === null) return closed("no ffi or libc");
  // The worker installs the filter and spawns under it; this thread supervises. Fds 0-2 are runCommand's pipes
  // and fd 3 bwrap's seccomp filter: this thread never touches a trapped call, so spawning it is safe.
  let worker: Worker | null = null;
  try {
    worker = new Worker(new URL("./linux-supervisor-worker.ts", import.meta.url).href);
  } catch {
    worker = null;
  }
  if (worker === null) return closed("no worker thread");
  const shared = new SharedArrayBuffer(16);
  const flag = new Int32Array(shared);
  const req: SupervisorRequest = { argv: [bwrap, ...args], env: { ...process.env } as Record<string, string>, seccompFd: 3, shared };
  worker.postMessage(req);
  // Wait for the worker to install (or give up): it signals before spawning anything that could trap.
  const started = Date.now();
  while (Atomics.load(flag, 0) === SupervisorState.Waiting && Date.now() - started < 10_000) await Bun.sleep(10);
  const state = Atomics.load(flag, 0);
  if (state === SupervisorState.Unsupported || state === SupervisorState.Waiting) {
    try { worker.terminate(); } catch { /* gone */ }
    return closed(state === SupervisorState.Waiting ? "the 10 s install wait ran out" : "the filter install was refused");
  }
  const listener = Atomics.load(flag, 2);
  try {
    await supervise(lib, listener, unsafe, () => Atomics.load(flag, 0) === SupervisorState.Done);
  } finally {
    try { worker!.terminate(); } catch { /* gone */ }
  }
  return Atomics.load(flag, 1);
}

process.exit(await main());

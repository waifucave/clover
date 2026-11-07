// The Linux sandbox's pre-exec shim: runs the command under bwrap, supervised where user-notify is available.
// A worker thread installs the filter and spawns bwrap under it (a single thread can never install-then-spawn:
// its own spawn would trap with nobody to answer); this thread never installs it, so spawning it is safe, and
// supervises every trapped call. Both threads share the fd table, so the listener the worker's install returns is
// usable here with no fd passing. Without a supervisor the sandbox still runs, unsupervised: the post-command belt
// quarantines anything planted (and says so on stderr).
// Usage: `shim <bwrap> <bwrap args...>`, with the supervised folders as JSON in `CLOVER_SUPERVISED_FILES` and
// bwrap's seccomp filter on fd 3.
import { hostProcIo, openSupervisorLib, supervise } from "./linux-supervisor";
import { SupervisorState, type SupervisorRequest } from "./linux-supervisor-worker";

async function main(): Promise<number> {
  const [, , bwrap, ...args] = process.argv;
  if (bwrap === undefined) {
    console.error("clover: the sandbox shim needs bwrap's path and arguments");
    return 127;
  }
  const unsafe: string[] = JSON.parse(process.env.CLOVER_SUPERVISED_FILES ?? "[]") as string[];
  const runPlain = async (): Promise<number> => {
    const child = Bun.spawn([bwrap, ...args], { stdio: ["inherit", "inherit", "inherit", 3], env: process.env });
    return (await child.exited) ?? 128;
  };
  const lib = openSupervisorLib();
  if (lib === null) {
    console.error("clover: no user-notification supervisor here (belt only)");
    return runPlain();
  }
  // The worker installs the filter and spawns under it; this thread supervises. Fds 0-2 are runCommand's pipes
  // and fd 3 bwrap's seccomp filter: this thread never touches a trapped call, so spawning it is safe.
  let worker: Worker | null = null;
  try {
    worker = new Worker(new URL("./linux-supervisor-worker.ts", import.meta.url).href);
  } catch {
    worker = null;
  }
  if (worker === null) {
    console.error("clover: no user-notification supervisor here (belt only)");
    return runPlain();
  }
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
    console.error("clover: no user-notification supervisor here (belt only)");
    return runPlain();
  }
  const listener = Atomics.load(flag, 2);
  const io = hostProcIo(lib);
  try {
    await supervise(lib, listener, unsafe, io, () => Atomics.load(flag, 0) === SupervisorState.Done);
  } finally {
    try { worker!.terminate(); } catch { /* gone */ }
  }
  return Atomics.load(flag, 1);
}

process.exit(await main());

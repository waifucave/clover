// Keeping a computer awake while it works (spec §6.4 "Sleep": "a computer running bots stays awake while a turn, an
// agent or a routine runs"). Whoever starts such work holds the keeper (`hold(reason)`) and lets go when it ends; while
// anything holds it, the OS doesn't sleep the machine for being idle.
//
// * macOS: `caffeinate -i -w <daemon pid>` (no window, no focus), so it also ends if the daemon dies.
// * Linux: `systemd-inhibit --what=idle:sleep --mode=block`, where logind is there; otherwise nothing.
// * Windows: `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` over bun:ffi, cleared when let go.
//
// What it can't do: keep a laptop awake with its lid closed (the OS sleeps it anyway), so a laptop main hands its bots
// over before it sleeps (`main.handOver` from the app's suspend notice, lane E). And waking the machine for the next
// routine takes the OS's own scheduler, which needs administrator rights on macOS and Linux; that stays with lane D's
// routine engine (D-M3).
import { dlopen, FFIType } from "bun:ffi";

export interface PowerKeeper {
  /** Keeps the machine awake until the returned function is called. */
  hold(reason: string): () => void;
  /** How many holds are open. */
  readonly held: number;
}

export interface PowerProcess {
  kill(): void;
}

export interface OsPowerKeeperOptions {
  platform?: NodeJS.Platform;
  /** Starts the helper that keeps the machine awake (tests pass a fake). */
  spawn?(argv: readonly string[]): PowerProcess | undefined;
  /** Windows: sets the thread's execution state (tests pass a fake). */
  setExecutionState?(flags: number): void;
  log?(line: string): void;
}

const ES_CONTINUOUS = 0x80000000;
const ES_SYSTEM_REQUIRED = 0x00000001;

function defaultSpawn(argv: readonly string[]): PowerProcess | undefined {
  try {
    const p = Bun.spawn([...argv], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    return { kill: () => p.kill() };
  } catch {
    return undefined;
  }
}

let kernel32: { SetThreadExecutionState(flags: number): number } | undefined;
function windowsExecutionState(flags: number): void {
  kernel32 ??= dlopen("kernel32.dll", { SetThreadExecutionState: { args: [FFIType.u32], returns: FFIType.u32 } }).symbols as unknown as { SetThreadExecutionState(flags: number): number };
  kernel32.SetThreadExecutionState(flags >>> 0);
}

/** The keeper for this OS. */
export function osPowerKeeper(o: OsPowerKeeperOptions = {}): PowerKeeper {
  const platform = o.platform ?? process.platform;
  const spawn = o.spawn ?? defaultSpawn;
  const reasons = new Map<number, string>();
  let next = 1;
  let proc: PowerProcess | undefined;
  const on = () => {
    try {
      if (platform === "darwin") proc = spawn(["/usr/bin/caffeinate", "-i", "-w", String(process.pid)]);
      else if (platform === "linux") proc = spawn(["systemd-inhibit", "--what=idle:sleep", "--who=Clover", `--why=${[...reasons.values()][0] ?? "working"}`, "--mode=block", "sleep", "infinity"]);
      else if (platform === "win32") (o.setExecutionState ?? windowsExecutionState)(ES_CONTINUOUS | ES_SYSTEM_REQUIRED);
    } catch (err) {
      o.log?.(`[power] keeping the machine awake failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const off = () => {
    try {
      proc?.kill();
      proc = undefined;
      if (platform === "win32") (o.setExecutionState ?? windowsExecutionState)(ES_CONTINUOUS);
    } catch {
      // gone already
    }
  };
  return {
    hold(reason) {
      const id = next++;
      reasons.set(id, reason);
      if (reasons.size === 1) on();
      let done = false;
      return () => {
        if (done) return;
        done = true;
        reasons.delete(id);
        if (reasons.size === 0) off();
      };
    },
    get held() {
      return reasons.size;
    },
  };
}

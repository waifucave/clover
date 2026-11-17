// Contract: HostSupervisor (spec revision 19, §3.1 "The engine and the host, precisely", §5.8 safe mode; items 98, 109,
// 112, 116; ruling R7). Owner: lane HS (the background host).
//
// The engine starts and keeps alive one background host per home, from the newest installed app that carries it
// (`ReleaseHome.hostSource`), through the OS. The host holds its own lock (`HOST_LOCK_FILE`).
//
// What the contract promises:
// * `boot` (the engine's start): a host already holding the lock is adopted, never a second started; else one is started
//   from the newest app that carries it; with no such app the engine runs headless (`absent`) and never retries forever.
// * `ready` moves a starting host to `running` (or `safe-mode` when it started so).
// * An exit the host announced (`exiting`) or the engine asked for (`stop`) is no crash and starts nothing. Any other exit
//   is a crash: the engine restarts it after `HOST_RESTART_DELAYS_MS` (growing, the last repeated); after
//   `HOST_CRASH_LIMIT` crashes inside `HOST_CRASH_WINDOW_MS`, the next start is in safe mode (its UI parts only: the
//   engine's tools keep running). Crashes older than the window don't count.
// * Quitting an app never stops the host; only `stop` (an update, "quit everything", no app left) does.
import type { AppInstallRecord, HostExitReason, HostState } from "@waifucave/moss-protocol";
import type { Unsubscribe } from "./common";

export interface HostStatus {
  state: HostState;
  /** Crashes inside the current window. */
  crashes: number;
  safeMode: boolean;
  pid?: number;
  bundlePath?: string;
  release?: string;
  /** The supervisor stopped trying: `HOST_START_ATTEMPTS` starts in a row never said ready. */
  gaveUp?: boolean;
}

/** What the supervisor asks the OS to do, and what it reads of it: the drivers a test or the real engine gives it. */
export interface HostWorld {
  /** The pid holding the host's lock, if any. */
  lockHolder(): number | null;
  /** The newest app that carries the host, if any is left on disk. */
  source(): AppInstallRecord | undefined;
  /** Starts the host from `bundlePath` through the OS (Launch Services, the scheduled task, `systemctl --user`). */
  start(bundlePath: string, opts: { safeMode: boolean }): void;
  /** Asks the running host to stop (`host.stop`). */
  stop(reason: HostExitReason): void;
}

export interface HostSupervisor {
  status(): HostStatus;
  boot(): Promise<"adopted" | "started" | "absent">;
  /** The host's `host.ready`. */
  ready(info: { pid: number; release: string; bundlePath: string; safeMode: boolean }): void;
  /** The host's `host.exiting`: its next exit is on purpose. */
  exiting(reason: HostExitReason): void;
  /** The host's process ended (its connection and process are gone). */
  exited(): void;
  /** The engine stops it: before an update, to quit everything, or with no app left. */
  stop(reason: HostExitReason): void;
  watch(fn: (status: HostStatus) => void): Unsubscribe;
}

// The engine's supervisor of the background host (spec revision 19, §3.1 "The engine and the host, precisely", §5.8 safe
// mode; items 98, 109, 112, 116; ruling R7): the `HostSupervisor` contract, over a `HostWorld` (`world.ts` on a real
// computer, `FakeHostWorld` in the conformance suite) and a clock.
//
// The rules (pinned by `runHostSupervisorConformance`):
// * `boot`: a host already holding the host lock is adopted, and must say `host.ready` within `HOST_START_TIMEOUT_MS`;
//   else one is started from the newest app that carries it; with none on disk the engine runs headless (`absent`).
// * A start is watched: no `host.ready` within the timeout (it never connected, or died before its hello) is a crash.
// * An exit announced (`host.exiting`) or asked for (`stop`) is no crash and starts nothing, except the `safe-mode`
//   reason, which starts it again at once in safe mode. Any other exit (the connection closed, the heartbeat ended it) is
//   a crash: restarted after `HOST_RESTART_DELAYS_MS`, and after `HOST_CRASH_LIMIT` crashes inside `HOST_CRASH_WINDOW_MS`
//   the next start is in safe mode, which covers the host's UI parts only.
// * No app carrying a host is "absent" at once, but a record can be missing for a moment (an app update replacing its
//   bundle): the engine looks again every `HOST_SOURCE_RECHECK_MS` for `HOST_SOURCE_GRACE_MS`, and when a window
//   connects (`poke`), and only then runs headless for good.
// * Quitting an app never stops the host: nothing here hears an app's windows at all.
import { HOST_CRASH_LIMIT, HOST_CRASH_WINDOW_MS, HOST_RESTART_DELAYS_MS, HOST_START_ATTEMPTS, HOST_SOURCE_GRACE_MS, HOST_SOURCE_RECHECK_MS, HOST_START_TIMEOUT_MS, type HostExitReason } from "@waifucave/moss-protocol";
import type { Clock, TimerHandle } from "../contracts/clock";
import { Listeners, type Unsubscribe } from "../contracts/common";
import type { HostStatus, HostSupervisor, HostWorld } from "../contracts/host-supervisor";

/** What a real world may do besides the contract's: end a host that holds the lock but never connected (wedged), so the
 *  next start isn't turned away by its single-instance lock. */
export interface HostWorldExtras {
  end?(pid: number): void;
}

export interface EngineHostSupervisorOptions {
  clock: Clock;
  world: HostWorld & HostWorldExtras;
  startTimeoutMs?: number;
  log?(line: string): void;
}

export class EngineHostSupervisor implements HostSupervisor {
  readonly #clock: Clock;
  readonly #world: HostWorld & HostWorldExtras;
  readonly #startTimeoutMs: number;
  readonly #log: (line: string) => void;
  readonly #listeners = new Listeners<HostStatus>();
  #status: HostStatus = { state: "stopped", crashes: 0, safeMode: false };
  #crashTimes: number[] = [];
  #onPurpose: HostExitReason | undefined;
  #restart: TimerHandle | undefined;
  #watchdog: TimerHandle | undefined;
  #recheck: TimerHandle | undefined;
  #absentSince: number | undefined;
  /** Whether the host should run at all (false once the engine stopped it on purpose). */
  #wanted = false;
  /** Starts in a row whose host never said ready (a start the OS refused, a host that died or hung before its ready). */
  #failedStarts = 0;
  /** Whether the host of the current start (or the adopted one) has said ready. */
  #saidReady = false;

  constructor(opts: EngineHostSupervisorOptions) {
    this.#clock = opts.clock;
    this.#world = opts.world;
    this.#startTimeoutMs = opts.startTimeoutMs ?? HOST_START_TIMEOUT_MS;
    this.#log = opts.log ?? (() => {});
  }

  status(): HostStatus {
    return { ...this.#status };
  }

  watch(fn: (status: HostStatus) => void): Unsubscribe {
    return this.#listeners.add(fn);
  }

  async boot(): Promise<"adopted" | "started" | "absent"> {
    this.#wanted = true;
    const pid = this.#world.lockHolder();
    if (pid !== null) {
      this.#log(`[host] a host holds the lock (pid ${pid}): adopted, waiting for it to say it is ready`);
      this.#saidReady = false;
      this.#set({ state: "running", pid });
      this.#arm(pid);
      return "adopted";
    }
    return this.#start(false);
  }

  ready(info: { pid: number; release: string; bundlePath: string; safeMode: boolean }): void {
    this.#wanted = true;
    this.#disarm();
    this.#cancelRecheck();
    this.#cancelRestart();
    this.#saidReady = true;
    this.#failedStarts = 0;
    this.#set({ state: info.safeMode ? "safe-mode" : "running", pid: info.pid, release: info.release, bundlePath: info.bundlePath, safeMode: info.safeMode }, ["gaveUp"]);
  }

  exiting(reason: HostExitReason): void {
    this.#onPurpose = reason;
  }

  exited(): void {
    this.#disarm();
    const reason = this.#onPurpose;
    this.#onPurpose = undefined;
    if (reason === "safe-mode") {
      this.#log("[host] the host left for safe mode: starting it again in safe mode");
      this.#start(true);
      return;
    }
    if (reason !== undefined) {
      this.#wanted = false;
      this.#log(`[host] the host left on purpose (${reason})`);
      this.#set({ state: "stopped" }, ["pid"]);
      return;
    }
    const now = this.#clock.monotonic();
    this.#crashTimes = [...this.#crashTimes.filter((t) => now - t < HOST_CRASH_WINDOW_MS), now];
    const n = this.#crashTimes.length;
    this.#failedStarts = this.#saidReady ? 0 : this.#failedStarts + 1;
    this.#saidReady = false;
    if (this.#failedStarts >= HOST_START_ATTEMPTS) {
      // No endless "restarting": the windows have the screen again, and say so once.
      this.#cancelRestart();
      this.#log(`[host] the host did not start ${this.#failedStarts} times in a row: the engine stops trying until it starts again (the windows draw the cards)`);
      this.#set({ state: "absent", crashes: n, gaveUp: true }, ["pid"]);
      return;
    }
    const delay = HOST_RESTART_DELAYS_MS[Math.min(n - 1, HOST_RESTART_DELAYS_MS.length - 1)]!;
    this.#log(`[host] the host crashed (${n} in the window): restarting in ${delay} ms${n >= HOST_CRASH_LIMIT ? ", in safe mode" : ""}`);
    this.#set({ state: "restarting", crashes: n }, ["pid"]);
    this.#cancelRestart();
    this.#restart = this.#clock.setTimeout(() => {
      this.#restart = undefined;
      this.#start(false);
    }, delay);
  }

  stop(reason: HostExitReason): void {
    this.#cancelRestart();
    this.#disarm();
    this.#cancelRecheck();
    if (reason !== "safe-mode") this.#wanted = false;
    this.#world.stop(reason);
    if (this.#status.state === "restarting" || this.#status.state === "absent" || this.#status.state === "stopped") {
      this.#onPurpose = undefined;
      this.#set({ state: "stopped" }, ["pid"]);
      return;
    }
    this.#onPurpose = reason;
  }

  /** A window connected: with no host running for want of an app, look for one again now. */
  poke(): void {
    if (this.#wanted && this.#status.state === "absent" && this.#status.gaveUp !== true) this.#start(false);
  }

  /** Stops the timers (the engine is stopping); the host itself is the caller's to stop. */
  dispose(): void {
    this.#cancelRestart();
    this.#disarm();
    this.#cancelRecheck();
  }

  #set(patch: Partial<HostStatus>, drop: (keyof HostStatus)[] = []): void {
    const next = { ...this.#status, ...patch };
    for (const k of drop) delete next[k];
    this.#status = next;
    this.#listeners.emit({ ...next });
  }

  #start(forceSafe: boolean): "started" | "absent" {
    const app = this.#world.source();
    if (!app) {
      const now = this.#clock.monotonic();
      this.#absentSince ??= now;
      if (this.#status.state !== "absent") this.#log("[host] no app that carries the host is on disk now: the engine runs headless, and looks again for a while");
      this.#set({ state: "absent" }, ["pid"]);
      this.#cancelRecheck();
      if (now - this.#absentSince < HOST_SOURCE_GRACE_MS) {
        this.#recheck = this.#clock.setTimeout(() => { this.#recheck = undefined; if (this.#wanted) this.#start(forceSafe); }, HOST_SOURCE_RECHECK_MS);
      }
      return "absent";
    }
    this.#absentSince = undefined;
    this.#cancelRecheck();
    const now = this.#clock.monotonic();
    this.#crashTimes = this.#crashTimes.filter((t) => now - t < HOST_CRASH_WINDOW_MS);
    const safeMode = forceSafe || this.#crashTimes.length >= HOST_CRASH_LIMIT;
    this.#onPurpose = undefined;
    this.#saidReady = false;
    this.#set({ state: "starting", safeMode, crashes: this.#crashTimes.length, bundlePath: app.bundlePath, release: app.release }, ["pid", "gaveUp"]);
    this.#arm();
    this.#world.start(app.bundlePath, { safeMode });
    return "started";
  }

  #arm(adoptedPid?: number): void {
    this.#disarm();
    this.#watchdog = this.#clock.setTimeout(() => {
      this.#watchdog = undefined;
      this.#log(`[host] the host did not say it was ready within ${this.#startTimeoutMs} ms: counted as a crash`);
      // A host found by its lock that never connected is wedged: ended, so the next start takes the lock.
      if (adoptedPid !== undefined && this.#world.lockHolder() === adoptedPid) this.#world.end?.(adoptedPid);
      this.#onPurpose = undefined;
      this.exited();
    }, this.#startTimeoutMs);
  }

  #disarm(): void {
    if (this.#watchdog) this.#clock.clearTimeout(this.#watchdog);
    this.#watchdog = undefined;
  }

  #cancelRecheck(): void {
    if (this.#recheck) this.#clock.clearTimeout(this.#recheck);
    this.#recheck = undefined;
  }

  #cancelRestart(): void {
    if (this.#restart) this.#clock.clearTimeout(this.#restart);
    this.#restart = undefined;
  }
}

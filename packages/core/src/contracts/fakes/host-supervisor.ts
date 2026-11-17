// FakeHostSupervisor over a FakeHostWorld: the supervision rules on a clock, so a test drives restarts and the crash
// window with `advance`. The world records each start and stop, and a test sets who holds the lock and which app is left.
import { HOST_CRASH_LIMIT, HOST_CRASH_WINDOW_MS, HOST_RESTART_DELAYS_MS, HOST_START_TIMEOUT_MS, type AppInstallRecord, type HostExitReason } from "@waifucave/moss-protocol";
import type { Clock, TimerHandle } from "../clock";
import { Listeners, type Unsubscribe } from "../common";
import type { HostStatus, HostSupervisor, HostWorld } from "../host-supervisor";

export class FakeHostWorld implements HostWorld {
  holder: number | null = null;
  app: AppInstallRecord | undefined;
  readonly starts: { bundlePath: string; safeMode: boolean }[] = [];
  readonly stops: HostExitReason[] = [];
  lockHolder(): number | null { return this.holder; }
  source(): AppInstallRecord | undefined { return this.app; }
  start(bundlePath: string, opts: { safeMode: boolean }): void { this.starts.push({ bundlePath, safeMode: opts.safeMode }); }
  stop(reason: HostExitReason): void { this.stops.push(reason); }
}

export class FakeHostSupervisor implements HostSupervisor {
  readonly #clock: Clock;
  readonly #world: HostWorld;
  readonly #listeners = new Listeners<HostStatus>();
  #status: HostStatus = { state: "stopped", crashes: 0, safeMode: false };
  #crashTimes: number[] = [];
  /** The reason of the exit the host announced or the engine asked for, until that exit comes. */
  #onPurpose: HostExitReason | undefined;
  #timer: TimerHandle | undefined;
  /** The start watchdog: armed at each start and adoption, cleared by `ready` or an exit. */
  #watchdog: TimerHandle | undefined;

  constructor(opts: { clock: Clock; world: HostWorld }) {
    this.#clock = opts.clock;
    this.#world = opts.world;
  }

  #set(patch: Partial<HostStatus>, drop: (keyof HostStatus)[] = []): void {
    const next = { ...this.#status, ...patch };
    for (const k of drop) delete next[k];
    this.#status = next;
    this.#listeners.emit({ ...next });
  }

  status(): HostStatus {
    return { ...this.#status };
  }

  #arm(): void {
    if (this.#watchdog) this.#clock.clearTimeout(this.#watchdog);
    this.#watchdog = this.#clock.setTimeout(() => {
      this.#watchdog = undefined;
      this.#onPurpose = undefined;
      this.exited();
    }, HOST_START_TIMEOUT_MS);
  }

  #disarm(): void {
    if (this.#watchdog) this.#clock.clearTimeout(this.#watchdog);
    this.#watchdog = undefined;
  }

  #start(forceSafe = false): "started" | "absent" {
    const app = this.#world.source();
    if (!app) {
      this.#set({ state: "absent" }, ["pid"]);
      return "absent";
    }
    const now = this.#clock.monotonic();
    this.#crashTimes = this.#crashTimes.filter((t) => now - t < HOST_CRASH_WINDOW_MS);
    const safeMode = forceSafe || this.#crashTimes.length >= HOST_CRASH_LIMIT;
    this.#onPurpose = undefined;
    this.#world.start(app.bundlePath, { safeMode });
    this.#set({ state: "starting", safeMode, crashes: this.#crashTimes.length, bundlePath: app.bundlePath, release: app.release }, ["pid"]);
    this.#arm();
    return "started";
  }

  async boot(): Promise<"adopted" | "started" | "absent"> {
    const pid = this.#world.lockHolder();
    if (pid !== null) {
      this.#set({ state: "running", pid });
      this.#arm();
      return "adopted";
    }
    return this.#start();
  }

  ready(info: { pid: number; release: string; bundlePath: string; safeMode: boolean }): void {
    this.#disarm();
    if (this.#timer) this.#clock.clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#set({ state: info.safeMode ? "safe-mode" : "running", pid: info.pid, release: info.release, bundlePath: info.bundlePath, safeMode: info.safeMode });
  }

  exiting(reason: HostExitReason): void {
    this.#onPurpose = reason;
  }

  exited(): void {
    this.#disarm();
    const reason = this.#onPurpose;
    this.#onPurpose = undefined;
    if (reason === "safe-mode") {
      // On purpose, and the one reason that starts it again: at once, in safe mode, with no crash counted.
      this.#start(true);
      return;
    }
    if (reason !== undefined) {
      this.#set({ state: "stopped" }, ["pid"]);
      return;
    }
    const now = this.#clock.monotonic();
    this.#crashTimes = [...this.#crashTimes.filter((t) => now - t < HOST_CRASH_WINDOW_MS), now];
    const n = this.#crashTimes.length;
    const delay = HOST_RESTART_DELAYS_MS[Math.min(n - 1, HOST_RESTART_DELAYS_MS.length - 1)]!;
    this.#set({ state: "restarting", crashes: n }, ["pid"]);
    if (this.#timer) this.#clock.clearTimeout(this.#timer);
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = undefined;
      this.#start();
    }, delay);
  }

  stop(reason: HostExitReason): void {
    if (this.#timer) this.#clock.clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#disarm();
    this.#world.stop(reason);
    // Nothing runs while it waits to restart: stopped at once, with no exit to wait for.
    if (this.#status.state === "restarting") {
      this.#onPurpose = undefined;
      this.#set({ state: "stopped" }, ["pid"]);
      return;
    }
    this.#onPurpose = reason;
  }

  watch(fn: (status: HostStatus) => void): Unsubscribe {
    return this.#listeners.add(fn);
  }
}

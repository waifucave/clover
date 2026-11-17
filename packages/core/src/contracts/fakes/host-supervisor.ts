// FakeHostSupervisor over a FakeHostWorld: the supervision rules on a clock, so a test drives restarts and the crash
// window with `advance`. The world records each start and stop, and a test sets who holds the lock and which app is left.
import { HOST_CRASH_LIMIT, HOST_CRASH_WINDOW_MS, HOST_RESTART_DELAYS_MS, type AppInstallRecord, type HostExitReason } from "@waifucave/moss-protocol";
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
  #onPurpose = false;
  #timer: TimerHandle | undefined;

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

  #start(): "started" | "absent" {
    const app = this.#world.source();
    if (!app) {
      this.#set({ state: "absent" }, ["pid"]);
      return "absent";
    }
    const now = this.#clock.monotonic();
    this.#crashTimes = this.#crashTimes.filter((t) => now - t < HOST_CRASH_WINDOW_MS);
    const safeMode = this.#crashTimes.length >= HOST_CRASH_LIMIT;
    this.#onPurpose = false;
    this.#world.start(app.bundlePath, { safeMode });
    this.#set({ state: "starting", safeMode, crashes: this.#crashTimes.length, bundlePath: app.bundlePath, release: app.release }, ["pid"]);
    return "started";
  }

  async boot(): Promise<"adopted" | "started" | "absent"> {
    const pid = this.#world.lockHolder();
    if (pid !== null) {
      this.#set({ state: "running", pid });
      return "adopted";
    }
    return this.#start();
  }

  ready(info: { pid: number; release: string; bundlePath: string; safeMode: boolean }): void {
    this.#set({ state: info.safeMode ? "safe-mode" : "running", pid: info.pid, release: info.release, bundlePath: info.bundlePath, safeMode: info.safeMode });
  }

  exiting(_reason: HostExitReason): void {
    this.#onPurpose = true;
  }

  exited(): void {
    if (this.#onPurpose) {
      this.#onPurpose = false;
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
    this.#onPurpose = true;
    this.#world.stop(reason);
  }

  watch(fn: (status: HostStatus) => void): Unsubscribe {
    return this.#listeners.add(fn);
  }
}

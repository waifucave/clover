// The main computer on this daemon, put together (plan §4 H, M2): the main choice, the lease over the handshake's
// record for this device's scope, the coordinator that renews, takes over and hands back, and the core's own wake
// watch. Lane C's daemon builds one beside the links (`startDeviceLinks` does it), and lane D's bot side reads it
// through its `LeaseMainComputer` (`lease` and `computerOf`), handing its `BotService.handBack` back with
// `setHandBack`.
import type { Clock } from "../contracts/clock";
import type { Unsubscribe } from "../contracts/common";
import type { DeviceRecord } from "../contracts/device-registry";
import type { LinkTransport } from "../contracts/link-transport";
import { machineClocks, watchSleep } from "./boot-clock";
import { LeaseCoordinator, type LeaseCoordinatorOptions } from "./coordinator";
import { MainLease, type MainLeaseOptions } from "./lease";
import { MainChoice } from "./main-choice";
import { osPowerKeeper, type PowerKeeper } from "./power";
import type { LeaseScope } from "./scope";

export interface MainComputerOptions {
  home: string;
  self: string;
  registry: { list(): DeviceRecord[]; get(id: string): DeviceRecord | undefined };
  transport: LeaseCoordinatorOptions["transport"];
  clock: Clock;
  /** Where the lease is held now (the account's, or the group's); undefined with neither. */
  scope(): LeaseScope | undefined;
  /** The sleep-counting monotonic clock; the machine's boot clock by default. */
  monotonic?: () => number;
  /** Whether the core watches for wakes itself (the boot clock against the awake clock); on by default. */
  watchSleep?: boolean;
  userActive?: () => boolean;
  /** What keeps the machine awake while work runs; the OS's by default. */
  power?: PowerKeeper;
  log?: (line: string) => void;
  timings?: Pick<MainLeaseOptions, "ttlMs" | "marginMs" | "ttlSec"> &
    Pick<LeaseCoordinatorOptions, "renewEveryMs" | "readEveryMs" | "takeoverDelayMs" | "nudgeWaitMs" | "reachTimeoutMs" | "retryMs">;
}

export interface MainComputerHandle {
  lease: MainLease;
  choice: MainChoice;
  coordinator: LeaseCoordinator;
  /** A device's tree name (`DeviceRecord.computer`), for lane D's `LeaseMainComputer.computerOf`. */
  computerOf(device: string): string | undefined;
  /** Holds the machine awake while a turn, an agent or a routine runs (lanes D and K call `hold`, §6.4 "Sleep"). */
  power: PowerKeeper;
  /** Lane D's `BotService.handBack`, once the bot service exists. */
  setHandBack(fn: (() => Promise<void>) | undefined): void;
  /** The scope changed (signed in or out, a group made or merged). */
  scopeChanged(): void;
  close(): void;
}

export function startMainComputer(o: MainComputerOptions): MainComputerHandle {
  const choice = new MainChoice({ home: o.home, self: o.self, devices: () => o.registry.list() });
  let coordinator: LeaseCoordinator | undefined;
  const monotonic = o.monotonic ?? (() => machineClocks().boot());
  const lease = new MainLease({
    self: o.self, scope: o.scope, clock: o.clock, monotonic, main: () => choice.current(),
    mayOutlast: (deadline) => coordinator?.mayOutlast(deadline) ?? false,
    ...(o.timings?.ttlMs === undefined ? {} : { ttlMs: o.timings.ttlMs }),
    ...(o.timings?.marginMs === undefined ? {} : { marginMs: o.timings.marginMs }),
    ...(o.timings?.ttlSec === undefined ? {} : { ttlSec: o.timings.ttlSec }),
  });
  // The coordinator's own timers run on the clock it's given; durations it measures use the same sleep-counting clock.
  const clock: Clock = {
    now: () => o.clock.now(), monotonic, setTimeout: (fn, ms) => o.clock.setTimeout(fn, ms), clearTimeout: (h) => o.clock.clearTimeout(h), status: () => o.clock.status(),
  };
  coordinator = new LeaseCoordinator({
    self: o.self, lease, choice, registry: o.registry, transport: o.transport, clock,
    ...(o.userActive ? { userActive: o.userActive } : {}),
    ...(o.log ? { log: o.log } : {}),
    ...pick(o.timings ?? {}, ["renewEveryMs", "readEveryMs", "takeoverDelayMs", "nudgeWaitMs", "reachTimeoutMs", "retryMs"]),
  });
  const offs: Unsubscribe[] = [];
  if (o.watchSleep !== false) {
    offs.push(watchSleep((ms) => {
      o.log?.(`[lease] the machine slept for ${Math.round(ms / 1000)} s`);
      coordinator!.wake();
    }));
  }
  coordinator.start();
  const c = coordinator;
  return {
    lease, choice, coordinator: c, power: o.power ?? osPowerKeeper(o.log ? { log: o.log } : {}),
    computerOf: (device) => {
      const d = o.registry.get(device);
      return d && d.revokedAt === undefined ? d.computer : undefined;
    },
    setHandBack: (fn) => c.setHandBack(fn),
    scopeChanged: () => {
      lease.scopeChanged();
      c.wake();
    },
    close() {
      for (const off of offs.splice(0)) off();
      c.close();
    },
  };
}

function pick<T extends object, K extends keyof T>(o: T, keys: readonly K[]): Partial<Pick<T, K>> {
  const out: Partial<Pick<T, K>> = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

/** The link-side transport the main computer needs. */
export type MainComputerTransport = Pick<LinkTransport, "connect" | "links" | "watch" | "handle" | "onNotify" | "networkChanged">;

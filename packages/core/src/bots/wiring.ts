// The daemon's bot side, put together (plan §4 D): the gate over the main computer and the pause switch, the durable
// session host asking that gate before each turn and stamping each record with the lease epoch, cache-timed compaction
// over the host, and the bot service. Owner: lane D. Lane C's daemon builds it once; the tests build one per home.
import type { SessionView } from "@waifucave/clover-protocol";
import type { Clock } from "../contracts/clock";
import type { PluginRegistry } from "../contracts/plugin-registry";
import { CacheTimedCompaction, type CompactionPolicy } from "../sessions/compaction";
import { DurableSessionHost, type DurableSessionHostOptions } from "../sessions/durable-host";
import { BotGate } from "./gate";
import { soleComputer, type MainComputer } from "./main-computer";
import { BotService, type BotRelay, type BotServiceOptions, type DriverFactory } from "./service";

export interface BotSideOptions {
  home: string;
  /** This computer's name in the folder tree. */
  computer: string;
  clock: Clock;
  registry: PluginRegistry;
  drivers: DriverFactory;
  /** Lane H's lease, as main-computer.ts reads it; without it this computer always runs its bots. */
  main?: MainComputer;
  relay?: BotRelay;
  reattach?: BotServiceOptions["reattach"];
  approvals?: DurableSessionHostOptions["approvals"];
  /** The compaction numbers for a session (the model's cache life and the settings); the spec's defaults otherwise. */
  compaction?: (view: SessionView) => CompactionPolicy | undefined;
  defaultModel: BotServiceOptions["defaultModel"];
  hasKeyFor?: BotServiceOptions["hasKeyFor"];
  assetUrl?: BotServiceOptions["assetUrl"];
  warn?: (message: string) => void;
}

export interface BotSide {
  gate: BotGate;
  host: DurableSessionHost;
  compaction: CacheTimedCompaction;
  bots: BotService;
  /** Starts the bots (`BotService.start`). */
  start(): Promise<void>;
  /** Detaches everything, leaving it dormant on disk (a shutdown). */
  close(): Promise<void>;
}

export function createBotSide(o: BotSideOptions): BotSide {
  const main = o.main ?? soleComputer(o.computer);
  const gate = new BotGate({ home: o.home, main });
  const host = new DurableSessionHost({
    home: o.home, clock: o.clock, computer: o.computer, epoch: () => main.epoch(), mayStart: (view) => gate.mayStart(view),
    ...(o.approvals === undefined ? {} : { approvals: o.approvals }), ...(o.warn === undefined ? {} : { warn: o.warn }),
  });
  const compaction = new CacheTimedCompaction({
    host, clock: o.clock, ...(o.compaction === undefined ? {} : { policy: o.compaction }), ...(o.warn === undefined ? {} : { warn: o.warn }),
  });
  const bots = new BotService({
    home: o.home, computer: o.computer, registry: o.registry, host, gate, drivers: o.drivers, clock: o.clock,
    defaultModel: o.defaultModel, cacheCold: (id) => compaction.cacheCold(id),
    ...(o.relay === undefined ? {} : { relay: o.relay }),
    ...(o.reattach === undefined ? {} : { reattach: o.reattach }),
    ...(o.hasKeyFor === undefined ? {} : { hasKeyFor: o.hasKeyFor }),
    ...(o.assetUrl === undefined ? {} : { assetUrl: o.assetUrl }),
    ...(o.warn === undefined ? {} : { warn: o.warn }),
  });
  return {
    gate, host, compaction, bots,
    start: () => bots.start(),
    close: async () => {
      await bots.stop();
      compaction.close();
      await host.close();
    },
  };
}

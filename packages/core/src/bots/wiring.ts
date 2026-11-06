// The daemon's bot side, put together (plan §4 D): the gate over the main computer and the pause switch, the durable
// session host asking that gate before each turn and stamping each record with the lease epoch, cache-timed compaction
// over the host, the bot service, and lane K's agents over the same host. Owner: lane D. Lane C's daemon builds it
// once; the tests build one per home.
//
// Lane K's agents (`createAgents`) come in as a factory that gets the host and each computer's level (`levelOf`; an
// agent that acts without asking starts read-only when its computer's level is unknown). Their hooks (K's
// `AgentManager.sessionHooks()`) feed `ListAgents`' agent rows, `session.setModel` for agents and coding sessions,
// and the reattaching of a restart's dormant sessions; `close` ends their processes when the daemon shuts down.
import type { Level, SessionView } from "@waifucave/clover-protocol";
import type { Clock } from "../contracts/clock";
import type { PluginRegistry } from "../contracts/plugin-registry";
import { CacheTimedCompaction, type CompactionPolicy } from "../sessions/compaction";
import { DurableSessionHost, type DurableSessionHostOptions } from "../sessions/durable-host";
import { BotGate } from "./gate";
import { soleComputer, type MainComputer } from "./main-computer";
import { sessionsMethods, type MethodHandler, type SessionsMethodsDeps } from "./rpc";
import { BotService, type BotRelay, type BotServiceOptions, type DriverFactory } from "./service";
import { botToolDefs, type AgentRows, type CoreToolDef } from "./tools";

/** Lane K's side of the bot side's hooks (`AgentManager.sessionHooks()`). */
export interface AgentHooks {
  /** The agents `ListAgents` lists. */
  agents: AgentRows;
  /** `session.setModel` on an agent or coding session. */
  setAgentModel(id: string, model: string, effort?: string): Promise<void>;
  /** A restart's dormant agent and coding sessions, reattached. */
  reattach(views: readonly SessionView[]): void | Promise<void>;
}

/** Lane K's agents, as `createAgents` makes them. */
export interface AgentsHandle {
  sessionHooks(): AgentHooks;
  /** Ends every agent's process and revokes its token; the sessions stay, to be reattached by the next daemon. */
  close(): Promise<void>;
}

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
  /** Lane K's agents over this side's host (the daemon passes `(d) => createAgents({ ...its options, host: d.host,
   *  levelOf: d.levelOf })` with its `manager.sessionHooks()`). Their hooks win over `reattach`. */
  agents?: (deps: { host: DurableSessionHost; levelOf: (computer: string) => Level | undefined }) => AgentsHandle;
  /** Each computer's approval level (lane J's computer registry), for lane K's agents. */
  levelOf?: (computer: string) => Level | undefined;
  userHome?: string;
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
  /** Lane K's agents, when the daemon gave them. */
  agents?: AgentsHandle;
  /** `SendMessage` and `ListAgents` for one bot's session (or an agent's, through the bridge), with K's agent rows. */
  tools(sessionId: string): CoreToolDef[];
  /** Lane D's sessions methods, with K's `setAgentModel`. */
  methods(deps: Pick<SessionsMethodsDeps, "localDevice"> & Partial<Pick<SessionsMethodsDeps, "clock">>): Record<string, MethodHandler>;
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
  const levelOf = o.levelOf ?? (() => undefined);
  const agents = o.agents?.({ host, levelOf });
  const hooks = agents?.sessionHooks();
  const compaction = new CacheTimedCompaction({
    host, clock: o.clock, ...(o.compaction === undefined ? {} : { policy: o.compaction }), ...(o.warn === undefined ? {} : { warn: o.warn }),
  });
  const bots = new BotService({
    home: o.home, computer: o.computer, registry: o.registry, host, gate, drivers: o.drivers, clock: o.clock,
    defaultModel: o.defaultModel, cacheCold: (id) => compaction.cacheCold(id),
    ...(o.relay === undefined ? {} : { relay: o.relay }),
    ...(hooks !== undefined ? { reattach: (views: SessionView[]) => hooks.reattach(views) } : o.reattach === undefined ? {} : { reattach: o.reattach }),
    ...(o.userHome === undefined ? {} : { userHome: o.userHome }),
    ...(o.hasKeyFor === undefined ? {} : { hasKeyFor: o.hasKeyFor }),
    ...(o.assetUrl === undefined ? {} : { assetUrl: o.assetUrl }),
    ...(o.warn === undefined ? {} : { warn: o.warn }),
  });
  return {
    gate, host, compaction, bots,
    ...(agents === undefined ? {} : { agents }),
    tools: (sessionId) => botToolDefs({ host, bots, ...(hooks === undefined ? {} : { agents: hooks.agents }) }, sessionId),
    methods: (deps) => sessionsMethods({
      home: o.home, bots, host, clock: deps.clock ?? o.clock, localDevice: deps.localDevice,
      ...(hooks === undefined ? {} : { setAgentModel: (id: string, model: string, effort?: string) => hooks.setAgentModel(id, model, effort) }),
    }),
    start: () => bots.start(),
    close: async () => {
      await bots.stop();
      // The agents' processes end before the host lets go of their sessions, which stay for the next daemon.
      if (agents !== undefined) {
        try {
          await agents.close();
        } catch (err) {
          o.warn?.(`closing the agents failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      compaction.close();
      await host.close();
    },
  };
}

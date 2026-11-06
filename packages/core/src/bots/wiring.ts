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
import type { ApprovalBroker } from "../contracts/approval-broker";
import type { Clock } from "../contracts/clock";
import { ContractError } from "../contracts/common";
import type { DeliveredInput } from "../contracts/session-host";
import type { PluginRegistry } from "../contracts/plugin-registry";
import { CacheTimedCompaction, type CompactionPolicy } from "../sessions/compaction";
import { DurableSessionHost, type DurableSessionHostOptions } from "../sessions/durable-host";
import { BotGate } from "./gate";
import { soleComputer, type MainComputer } from "./main-computer";
import { sessionsMethods, type MethodHandler, type SessionsMethodsDeps } from "./rpc";
import { BotService, type BotRelay, type BotServiceOptions, type DriverFactory } from "./service";
import { botToolDefs, SendLimiter, type AgentRows, type CoreToolDef } from "./tools";
import { RoutineEngine, type RoutineEngineOptions } from "../routines/engine";
import { routineMethods } from "../routines/rpc";
import { routineToolDef, type RoutineToolDeps } from "../routines/tool";
import { WebhookIngress, type WebhookIngressOptions } from "../routines/webhooks";
import { voicesMethods } from "../voices/rpc";
import { VoiceService, type VoiceServiceOptions } from "../voices/service";

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
  /** Each computer's approval level (lane J's computer registry), for lane K's agents and the routines. */
  levelOf?: (computer: string) => Level | undefined;
  /** This computer's routines (§7): the engine runs when given. */
  routines?: Pick<RoutineEngineOptions, "userTimeZone" | "secrets" | "webhookBase" | "pluginTriggers" | "watchFiles"> & Partial<Pick<RoutineToolDeps, "computers" | "writeRemote">> & {
    /** The `webhook.ingress` entries and the plugin host that runs them (lane I's forwarder): webhooks.ts. */
    ingress?: Pick<WebhookIngressOptions, "registry" | "host"> & { poll?: boolean };
  };
  /** A session ended (stopped or failed): lane J's `TerminalRouter.closeSession` closes its shells. */
  onSessionEnded?: (id: string) => void;
  /** Bots' voices on this device (§6.6): the `voices` entries, the plugin host that streams them, and `voice.play`
   *  to the app. Each bot's voice is its effective one (its user layer's, else its plugin's). */
  voices?: Pick<VoiceServiceOptions, "registry" | "host" | "play" | "listenIdleMs">;
  userHome?: string;
  approvals?: DurableSessionHostOptions["approvals"] & Partial<Pick<ApprovalBroker, "request">>;
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
  /** This computer's routine engine, when routines were given. */
  routines?: RoutineEngine;
  /** Its webhooks' way in, when an ingress was given. */
  ingress?: WebhookIngress;
  /** Bots' voices here, when voices were given. */
  voices?: VoiceService;
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
  const gate = new BotGate({ home: o.home, main, ...(o.warn === undefined ? {} : { warn: o.warn }) });
  const relay = o.relay;
  const host = new DurableSessionHost({
    home: o.home, clock: o.clock, computer: o.computer, epoch: () => main.epoch(), mayStart: (view) => gate.mayStart(view),
    // A bot's conversation lives on the runner: what arrives here for it goes there (review S1).
    runsHere: () => main.runsHere(),
    ...(relay === undefined ? {} : {
      forward: (view: SessionView, input: DeliveredInput) => {
        const runner = main.runner();
        if (runner === undefined || runner === o.computer) throw new ContractError("bot_asleep", `no computer runs ${view.bot ?? view.id}'s conversation now`);
        return relay.deliver(runner, view.id, input);
      },
    }),
    ...(o.approvals === undefined ? {} : { approvals: o.approvals }), ...(o.warn === undefined ? {} : { warn: o.warn }),
  });
  const levelOf = o.levelOf ?? (() => undefined);
  const limiter = new SendLimiter(() => o.clock.now());
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
  const computerLevel = (): Level => levelOf(o.computer) ?? "ask-risky";
  let ingress: WebhookIngress | undefined;
  const routines: RoutineEngine | undefined = o.routines === undefined ? undefined : new RoutineEngine({
    home: o.home, computer: o.computer, clock: o.clock, bots, computerLevel,
    ...(o.approvals?.request === undefined ? {} : { approvals: { request: o.approvals.request.bind(o.approvals) } }),
    ...(o.routines.userTimeZone === undefined ? {} : { userTimeZone: o.routines.userTimeZone }),
    ...(o.routines.secrets === undefined ? {} : { secrets: o.routines.secrets }),
    ...(o.routines.webhookBase === undefined ? {} : { webhookBase: o.routines.webhookBase }),
    ...(o.routines.pluginTriggers === undefined ? {} : { pluginTriggers: o.routines.pluginTriggers }),
    ...(o.routines.watchFiles === undefined ? {} : { watchFiles: o.routines.watchFiles }),
    ...(o.routines.ingress === undefined ? {} : { registerWebhook: (id: string, key: string): Promise<string> => ingress!.register(id, key) }),
    ...(o.warn === undefined ? {} : { warn: o.warn }),
  });
  ingress = routines === undefined || o.routines?.ingress === undefined ? undefined : new WebhookIngress({
    registry: o.routines.ingress.registry, host: o.routines.ingress.host, engine: routines, clock: o.clock, ...(o.warn === undefined ? {} : { warn: o.warn }),
  });
  const voices = o.voices === undefined ? undefined : new VoiceService({
    ...o.voices,
    voiceOf: (bot) => (bots.has(bot) ? bots.effective(bot).voice : undefined),
    ...(o.warn === undefined ? {} : { warn: o.warn }),
  });
  const routineTool = routines === undefined || o.routines === undefined ? undefined : {
    home: o.home, computer: o.computer, routines,
    computers: o.routines.computers ?? (() => [{ name: o.computer, level: computerLevel() }]),
    ...(o.routines.writeRemote === undefined ? {} : { writeRemote: o.routines.writeRemote }),
  };
  // Lane J's terminals close with their session.
  const ended = new Set<string>();
  const offEnded = o.onSessionEnded === undefined ? undefined : host.watch((view) => {
    if ((view.status !== "stopped" && view.status !== "failed") || ended.has(view.id)) return;
    ended.add(view.id);
    try {
      o.onSessionEnded!(view.id);
    } catch (err) {
      o.warn?.(`closing ${view.id}'s terminals failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  return {
    gate, host, compaction, bots,
    ...(agents === undefined ? {} : { agents }),
    ...(routines === undefined ? {} : { routines }),
    ...(ingress === undefined ? {} : { ingress }),
    ...(voices === undefined ? {} : { voices }),
    tools: (sessionId) => {
      const defs = botToolDefs({ host, bots, limiter, ...(hooks === undefined ? {} : { agents: hooks.agents }) }, sessionId);
      const bot = host.callerOf(sessionId).bot;
      if (routineTool !== undefined && bot !== undefined && host.get(sessionId)?.kind !== "agent") defs.push(routineToolDef(routineTool, { bot }));
      return defs;
    },
    methods: (deps) => ({
      ...sessionsMethods({
        home: o.home, bots, host, clock: deps.clock ?? o.clock, localDevice: deps.localDevice,
        ...(hooks === undefined ? {} : { setAgentModel: (id: string, model: string, effort?: string) => hooks.setAgentModel(id, model, effort) }),
      }),
      ...(routines === undefined ? {} : routineMethods({ routines })),
      ...(voices === undefined ? {} : voicesMethods({ voices })),
    }),
    start: async () => {
      await bots.start();
      await routines?.start();
      if (o.routines?.ingress?.poll !== false) ingress?.start();
    },
    close: async () => {
      ingress?.stop();
      routines?.stop();
      offEnded?.();
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
      gate.close();
    },
  };
}

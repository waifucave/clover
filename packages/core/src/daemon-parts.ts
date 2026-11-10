// The Clover parts the daemon runs over this device's links (the daemon integration lane; plan §4 C, H, J and D): lane
// J's computer node and lane D's bot side, started once the links are up and closed in reverse order before them.
//
// * **The computer node** (J, `startComputerNode`) takes its transport, devices, name, `memoryChanged` (H's memory
//   sync) and `lease` from `computerNodeLinks`. Its bots and their placement come from the bot side.
// * **The main computer** is the lease's, never a setting (§6.4): the computer running the bots is the lease's holder
//   while it may act, otherwise the main the user chose (lane D's `LeaseMainComputer`). The computer registry's
//   `isMain` follows it, on this computer and on the others, so whatever runs on the main computer alone (lane J's
//   cloud computers, §9.2) runs on one computer only. A lone computer with no lease is its own main.
// * **The bot side** (D, `createBotSide`) runs over the same main computer, closes its own gate when this computer
//   stops running the bots, and hands them back to a returning main (`MainComputerHandle.setHandBack`). Its methods
//   join the Clover server's handlers.
// * **The update gate** (lane M's `RunningDaemon.updateGate`): the links renew the lease just before an update's
//   restart (`startDaemonLinks`), and the bot side takes the gate itself (lane D's #246): its running turns are the
//   gate's `bot-turns` source, so an update never restarts the daemon in the middle of one, and no turn starts while
//   an update closes the gate. Each turn is counted once, there.
// * **The agents** (K, `createAgents`) run over the bot side's host, on this computer's node: K's manager, Clover's own
//   coding agent (`clover-code`) and lane A's in-process subagents on the embedded runtime, held by the bot side's pause
//   switch. Their approvals go through lane C's broker (#267) and their folders through this computer's fence. The
//   Clover server reaches them through `lateAgentDoors`: `clover-core code-agent` (`codeAgent.*`, K's #291) and the
//   bridge role, both refused until the agents are up and after they stop.
// * **The sessions' records** (H's `SessionRecordSync` into D's host, #279): the sessions this computer runs are
//   copied live to the user's other computers, and theirs land here, so a computer that takes the bots over finds their
//   open turns at once. What comes in goes through `hostForSync`: a grant copied from another computer never grants
//   here (D's reviewer's rule), so a session that moves here asks again on this computer's own card. The lease fences
//   it: a record from an earlier lease is taken as late.
import type { CanUseTool, Options, SpawnClaudeCodeProcess } from "@waifucave/clover-agent-sdk";
import type { AgentDefView } from "@waifucave/clover-protocol";
import { createAgents, type AgentPauseGate, type AgentsOptions } from "./agents";
import { pluginAgentDefinitions } from "./agents/rpc";
import { CloverApprovalBroker } from "./approvals/broker";
import { fileRuleStore } from "./approvals/rule-store";
import { deviceProofVerifier } from "./contracts/approval-broker";
import { ContractError, Listeners } from "./contracts/common";
import { CloverFence } from "./fence/fence";
import { approvalCoreEvents } from "./approvals/core-events";
import type { CoreEventInput, CoreEventOptions } from "./ipc/core-events";
import { CloverRpcError, type BridgeGate, type CodeAgentDoor } from "./ipc/clover";
import { embeddedSessionOptions } from "./runtime-sdk/turn-loop/embedded-session";
import { ERR } from "@waifucave/clover-protocol";
import type { BotSide, BotSideOptions } from "./bots/wiring";
import { createBotSide } from "./bots/wiring";
import { LeaseMainComputer, soleComputer, type MainComputer } from "./bots/main-computer";
import type { DriverFactory } from "./bots/service";
import type { Clock } from "./contracts/clock";
import type { PluginRegistry } from "./contracts/plugin-registry";
import { startComputerNode, type ComputerNode, type ComputerNodeOptions } from "./computers/node";
import { computerMethods } from "./computers/rpc";
import { nodeParts, type SafetyReviewer } from "./computers/node-parts";
import { appTerminals } from "./computers/app-terminals";
import type { ApprovalBroker } from "./contracts/approval-broker";
import type { FencedSpawner } from "./fence/spawn";
import { laneMethodHandlers, type CloverHandler } from "./ipc/clover";
import { CloverUsageCounter } from "./usage/counter";
import { cloverUsageDbPath, UsageLedger } from "./usage/ledger";
import { usageMethods } from "./usage/rpc";
import { computerNodeLinks, type DeviceLinks } from "./links/node";
import { botDeliveryCheck, linkBotRelay, mountSessionDelivery } from "./links/bot-relay";
import { peerSessionMethods } from "./bots/rpc";
import { isContractError } from "./contracts/common";
import type { DeliveredInput, Disposition } from "./contracts/session-host";
import { hostForSync } from "./daemon-session-sync";
import { SessionRecordSync } from "./sync/session-records";

/** What the bot side needs that the daemon builds: where the bots come from and what drives their sessions. */
export interface DaemonBotsInput {
  /** The plugin registry the bots come from (`openPluginRegistry` in the daemon). */
  registry: PluginRegistry;
  /** Each session's driver, given the bot side (for its core tools, read at each build) and the computer node. */
  /** The bots' drivers, given the daemon's one approval broker (when the node runs): a bot's calls that ask raise a card
   *  on it (lane C's `botApprovalCheck`). */
  drivers(parts: { side(): BotSide | undefined; node: ComputerNode | undefined; main: MainComputer; broker: CloverApprovalBroker | undefined; fence: CloverFence }): DriverFactory;
  defaultModel: BotSideOptions["defaultModel"];
  hasKeyFor?: BotSideOptions["hasKeyFor"];
  /** What Clover's own bundled plugin chose for a bot, from its verified staged bytes (a loaded tag equal to it asks
   *  nothing). */
  bundledChoice?: BotSideOptions["bundledChoice"];
  // Lane D's bot-side inputs: what the daemon holds that the bot side's options are built from (`botSideOptions`).
  /** The URL the app loads a plugin's file from (a bot's portrait). */
  assetUrl?: BotSideOptions["assetUrl"];
  /** A bot conversation's compaction numbers (the model's cache life, the settings); the spec's defaults without it. */
  compaction?: BotSideOptions["compaction"];
  /** The routines' secrets (a webhook's key), and the user's time zone their schedules run in. */
  routines?: { secrets?: NonNullable<BotSideOptions["routines"]>["secrets"]; userTimeZone?(): string; webhookBase?: string };
  /** Lane B's plugin host (#277): when given, the bots' voices, the webhook ingress and the plugin triggers run on it. */
  pluginHost?: BotPluginHost;
  /** Sends `voice.play` to the app (with `pluginHost`). */
  voicePlay?: NonNullable<BotSideOptions["voices"]>["play"];
  /** The relay plugin's mailbox (#277): where a message goes when the computer running its bot can't be reached. */
  relayMailbox?: BotRelayMailbox;
  /** The plugin host that runs `pill.target` entries' handlers (#323's `pill.send`). */
  pillTargets?: BotSideOptions["pillTargets"];
}

/** Lane B's plugin host, as the bot side's voices, webhooks and triggers use it (#277). */
export type BotPluginHost = NonNullable<BotSideOptions["voices"]>["host"] & NonNullable<NonNullable<BotSideOptions["routines"]>["ingress"]>["host"] & {
  /** The plugin triggers' arm and disarm (lane B's `triggers` point). */
  triggers?: NonNullable<NonNullable<BotSideOptions["routines"]>["pluginTriggers"]>;
};

/** The relay plugin's mailbox (#277): it keeps a message for the computer running a bot until that computer is back. */
export interface BotRelayMailbox {
  deliver(computer: string, session: string, input: DeliveredInput): Promise<{ disposition: Disposition; seq: number }>;
}

export interface DaemonPartsInput {
  /** The Clover home. */
  cloverHome: string;
  /** The user's home folder: `home/<this computer>/` in the tree. */
  userHome: string;
  clock: Clock;
  /** This device's links (local-only when there's no sidecar: no other device on them); null only when a test starts
   *  none (`links: false`): no computer node then, and the bot side runs as
   *  the only computer. */
  links: DeviceLinks | null;
  /** The Clover server's lane handlers: the bot side's methods join them. */
  handlers: Record<string, CloverHandler>;
  /** The computer node's options the daemon decides (its tree folder, Bash, the fence…); false for no node. */
  node?: false | Partial<Pick<ComputerNodeOptions, "treeRoot" | "executor" | "fence" | "reviewer" | "askUser" | "terminals" | "answers" | "mcp">>;
  /** The bot side; false for none. */
  bots?: false | DaemonBotsInput;
  /** The daemon's safety reviewer (`BashReviewer`, on the internal-jobs model): the computer node judges another
   *  computer's calls with it at "ask for risky actions", and fails closed without it (lane J's `nodeParts`). */
  reviewer?: SafetyReviewer;
  /** TEST SEAM: an approval broker for the node's cards (a paste of several lines) and its own record of a card a
   *  level raise hands over (`get`, the registry's `cardRecord`). The daemon's own broker is bound here once it
   *  exists (`lateBroker`, INT #353); without either, such a paste is refused with a reason, never dropped silently, and
   *  no card raises a level. The broker's cards go out through `coreEvent` too. */
  approvals?: Pick<ApprovalBroker, "request" | "get">;
  /** The Clover server's `core.event` sender: the terminal panel's output (`terminal_output`) goes to the connection
   *  that opened each terminal. Without it, the app's `terminal.*` methods aren't served. */
  coreEvent?: (event: CoreEventInput, opts?: CoreEventOptions) => number;
  /** Lane C's fenced process on this computer (`fencedSpawner({ fence })` over the daemon's one CloverFence): the
   *  computer node's Bash runs through it (`fencedExecutor`, lane J). Without it the node has no executor and Bash on
   *  its tree is refused; it never runs unsandboxed. A test's own `node.executor` wins. */
  spawner?: FencedSpawner;
  /** The daemon's update gate: the bot side's running turns keep an update waiting. */
  updateGate?: BotSideOptions["updateGate"];
  /** Lane K's agents over the bot side's host; false for none. They need the node (the folder tree) and the bot side. */
  agents?: false | DaemonAgentsInput;
  log?(line: string): void;
}

export interface DaemonParts {
  node?: ComputerNode;
  bots?: BotSide;
  /** Lane K's agents, when they run here. */
  agents?: DaemonAgents;
  /** The agent presets the bots' plugins contribute (`agents` point), for `agent.definitions`. */
  agentDefinitions?: () => AgentDefView[];
  /** Lane C's approval broker for the agents (#267). */
  broker?: CloverApprovalBroker;
  /** Who runs the bots (the lease's holder, or the main), as lane D reads it. */
  main?: MainComputer;
  /** Closes the bot side, then the node: the reverse of their start. The links close after, with their owner. */
  close(): Promise<void>;
}

/** What the agents need that the daemon has. */
export interface DaemonAgentsInput {
  /** The daemon's own endpoint, where the bridge and `clover-core code-agent` say hello. */
  socketPath: string;
  /** The embedded runtime's spawn hook (`createEmbeddedSessionHost().spawn`). */
  spawn: SpawnClaudeCodeProcess;
  /** The user's default model, when a delegation or a client names none. */
  defaultModel(): string;
  /** The daemon's provider fill for a real model (lane A's `fillProvider`). */
  fillProvider?: (model: string, options: Options) => void | Promise<void>;
  /** The Clover server's doors to the agents (`lateAgentDoors`), set once they're up. */
  doors?: LateAgentDoors;
  /** Tests: the backends in place of the registry's and the core's. */
  backends?: AgentsOptions["backends"];
}

export type DaemonAgents = ReturnType<typeof createAgents>;

/** The Clover server's doors to lane K's agents, made before them (the server starts at once; the agents with the
 *  bot side, once the links are up): `codeAgent` (`clover-core code-agent`) and the bridge role's gate and handlers.
 *  Until `set`, and after it is cleared, a code-agent client is told to try again and a bridge hello is refused. */
export interface LateAgentDoors {
  readonly codeAgent: CodeAgentDoor;
  readonly bridge: { gate: BridgeGate; sessionInfo(sessionId: string): { bot?: string } | undefined };
  set(agents: DaemonAgents | undefined): void;
}

export function lateAgentDoors(handlers: Record<string, CloverHandler>): LateAgentDoors {
  let agents: DaemonAgents | undefined;
  let mounted: string[] = [];
  let offRevoke: (() => void) | undefined;
  const revoked = new Listeners<{ sessionId: string; connection?: number }>();
  const notUp = () => new CloverRpcError(ERR.RETRY, "Clover's coding agent isn't running on this computer yet: try again in a moment");
  return {
    codeAgent: {
      open: async (conn, p) => {
        if (!agents) throw notUp();
        return agents.codeAgent.open(conn, p);
      },
      input: (connId, line) => {
        if (!agents) throw notUp();
        agents.codeAgent.input(connId, line);
      },
      close: (connId) => agents?.codeAgent.close(connId),
    },
    bridge: {
      gate: {
        accept: async (token, sessionId, pid) => (agents ? agents.clover.bridge.gate.accept(token, sessionId, pid) : { ok: false, reason: "no agents are running on this computer" }),
        release: (sessionId, connection) => agents?.clover.bridge.gate.release(sessionId, connection),
        onRevoke: (fn) => revoked.add(fn),
      },
      sessionInfo: (id) => agents?.clover.bridge.sessionInfo(id),
    },
    set(next) {
      for (const name of mounted) delete handlers[name];
      mounted = [];
      agents = next;
      // Cleared at the stop, the agents' revocations still reach the server while they close (their tokens are revoked
      // after the doors close): the old listener goes only when new agents take its place.
      if (!next) return;
      offRevoke?.();
      offRevoke = next.clover.bridge.gate.onRevoke?.((e) => revoked.emit(e));
      Object.assign(handlers, next.clover.handlers);
      mounted = Object.keys(next.clover.handlers);
    },
  };
}

/** A bot's tool call that would need the user's answer is refused until lane C's approval broker (C-M3) raises its
 *  card: no call ever runs unasked. */
export const refuseUntilApprovals: CanUseTool = async () => ({
  behavior: "deny",
  message: "This computer can't ask you about this call yet (approval cards aren't wired here), so it was refused.",
});

export async function startDaemonParts(input: DaemonPartsInput): Promise<DaemonParts> {
  const log = input.log ?? (() => {});
  const links = input.links;
  const closers: Array<() => void | Promise<void>> = [];
  const close = async () => {
    for (const c of closers.splice(0).reverse()) {
      try {
        await c();
      } catch (err) {
        log(`[parts] closing failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
  try {
    let side: BotSide | undefined;
    const nodeLinks = links ? computerNodeLinks(links) : undefined;
    const computer = nodeLinks?.self.name;
    // The lease's main computer, as lane D reads it; a lone computer (no links, or no lease here) is its own.
    let main: MainComputer | undefined;
    if (links?.main && computer !== undefined) {
      const m = new LeaseMainComputer({ lease: links.main.lease, self: computer, computerOf: (d) => links.main!.computerOf(d) });
      closers.push(() => m.close());
      main = m;
    }
    // This computer's name, one for the node's broker, the bot side and the agents.
    const here = main?.self ?? computer ?? "this-computer";

    let node: ComputerNode | undefined;
    // The one CloverFence and the one approval broker on this computer: the node (its folder tree, its terminals' paste
    // card), the agents and the bot side all go through these, never a copy of their own.
    const fence = new CloverFence({ home: input.userHome, cloverHome: input.cloverHome });
    let broker: CloverApprovalBroker | undefined;
    const lateApprovals = lateBroker(() => broker);
    if (links && nodeLinks && input.node !== false) {
      // ── The computer node's own parts (lane J, `computers/node-parts.ts`) ──
      // Its terminals' card for a paste of several lines (through the approval broker, once there is one; until then
      // such a paste is refused with a reason), the broker's own record of a card a level raise hands over
      // (`cardRecord: (id) => approvals?.get(id)`; no broker, no card raises), and its safety reviewer for another computer's calls at "ask for risky
      // actions" (the daemon's `BashReviewer`; it fails closed), and its Bash on lane C's fenced process when the daemon
      // hands over its spawner (`input.spawner`; none, no executor). The fence, MCP and askUser/answers are not here: the node options below carry what the daemon passes. A test's own node options win.
      const own = nodeParts({
        computer: () => node?.registry.self().name ?? nodeLinks.self.name,
        // The broker below, bound late: it needs the node's own registry for each computer's level.
        approvals: input.approvals ?? lateApprovals,
        ...(input.reviewer ? { reviewer: input.reviewer } : {}),
        ...(input.spawner ? { bash: { spawner: input.spawner, home: input.userHome } } : {}),
        log: (line) => log(`[computers] ${line}`),
      });
      const n = startComputerNode({
        ...nodeLinks,
        fence,
        ...own,
        ...(input.node ?? {}),
        // A test's own shell launcher keeps the paste card.
        terminals: { ...own.terminals, ...(input.node ? input.node.terminals ?? {} : {}) },
        clock: input.clock,
        home: input.userHome,
        cloverHome: input.cloverHome,
        bots: () => side?.bots.botsRunHere() ?? [],
        botPlacement: (bot) => side?.bots.computerFor(bot),
        log: (line) => log(`[computers] ${line}`),
      });
      closers.push(() => n.close());
      // The terminal panel's methods for this computer's app (lane J's `appTerminals`): the node's terminals, the paste
      // card with them, the output to the connection that opened each one.
      if (input.coreEvent) {
        const panel = appTerminals({ terminals: n.terminals, coreEvent: input.coreEvent, log: (line) => log(`[computers] ${line}`) });
        Object.assign(input.handlers, panel.handlers);
        closers.push(() => panel.close());
      }
      node = n;
      if (main) closers.push(followMain(n, main, links));
      // Lane J's computers methods for the app (`computer.*`, `hold.list`), over the node's registry.
      Object.assign(input.handlers, laneMethodHandlers(computerMethods({ registry: n.registry })));
      broker = new CloverApprovalBroker({
        clock: input.clock,
        // A computer the registry doesn't know is judged at read-only, failing closed as the agents' manager does.
        levels: (c) => n.registry.get(c)?.level ?? "read-only", fence: (c) => (c === here ? fence : undefined),
        verify: deviceProofVerifier(links.registry), rules: fileRuleStore(input.cloverHome), localComputer: here,
        log: (line) => log(`[approvals] ${line}`),
      });
      // Its cards as core events (lane C's `approvalCoreEvents`), stamped with the shared clock, from before the bot
      // side starts, so a card raised while it starts is heard too.
      if (input.coreEvent) {
        const send = input.coreEvent;
        closers.push(approvalCoreEvents(broker, (e) => send(e), () => links.clock.now()));
      }
    }

    let agents: DaemonAgents | undefined;
    if (input.bots) {
      const b = input.bots;
      const runner = main ?? soleComputer(here);
      // Lane K's agents over the bot side's host: they need the node's folder tree. The pause is the bot side's switch,
      // read through `side` once it exists (closed until then: no agent acts before the side is up).
      const a = input.agents;
      const pauseChanged = new Listeners<void>();
      const pause: AgentPauseGate = { mayAct: () => side?.gate.mayAct({ kind: "agent" }) ?? false, watch: (fn) => pauseChanged.add(fn) };
      let agentsFactory: BotSideOptions["agents"];
      if (a && node && links && broker) {
        const n = node;
        const approvals = broker;
        agentsFactory = (d) => {
          const made = createAgents({
            home: input.cloverHome, computer: here, socketPath: a.socketPath, host: d.host, approvals, tree: n.tree, fence, clock: input.clock,
            registry: b.registry, levelOf: d.levelOf, pause, userHome: input.userHome,
            // A computer's level changing (the user lowers it, or it goes off) reaches every running agent's mode floor.
            watchLevels: (fn) => n.registry.watch(() => fn()),
            cloverCode: {
              baseOptions: (s) => embeddedSessionOptions({ home: input.cloverHome, spawn: a.spawn }, s),
              defaultModel: a.defaultModel, ...(a.fillProvider ? { fillProvider: a.fillProvider } : {}),
            },
            inProcess: { home: input.cloverHome, spawn: a.spawn, defaultModel: a.defaultModel, ...(a.fillProvider ? { provider: a.fillProvider } : {}) },
            ...(a.backends ? { backends: a.backends } : {}),
            log: (line) => log(`[agents] ${line}`),
          });
          agents = made;
          return { sessionHooks: () => made.manager.sessionHooks(), close: () => made.close() };
        };
      } else if (a) {
        log("[agents] not started: they need this computer's node (its links), and the bot side");
      }
      const s = createBotSide({
        home: input.cloverHome, computer: runner.self, clock: input.clock, registry: b.registry, main: runner,
        drivers: b.drivers({ side: () => side, node, main: runner, broker, fence }),
        defaultModel: b.defaultModel,
        // Lane C's broker (#267): the bot side's one SessionGrants asks through it (the browser's person's partition).
        ...(broker ? { approvals: broker } : {}),
        ...(b.hasKeyFor ? { hasKeyFor: b.hasKeyFor } : {}),
        ...(b.bundledChoice ? { bundledChoice: b.bundledChoice } : {}),
        ...(b.pillTargets ? { pillTargets: b.pillTargets } : {}),
        userHome: input.userHome,
        ...(node ? { levelOf: (c: string) => node!.registry.get(c)?.level, onSessionEnded: (id: string) => void node!.terminals.closeSession(id) } : {}),
        // Lane M's gate (lane D's #246): the bot side's turns are its `bot-turns` source, and none starts while it's closed.
        ...(input.updateGate ? { updateGate: input.updateGate } : {}),
        ...(agentsFactory ? { agents: agentsFactory } : {}),
        // Lane D's bot-side options: the relay to the computer running a bot, routines, voices, compaction, assets.
        ...botSideOptions({ b, links, node, computer: runner.self }),
        warn: (line) => log(`[bots] ${line}`),
      });
      side = s;
      closers.push(() => s.close());
      closers.push(s.gate.watch(() => pauseChanged.emit()));
      // The server's doors open once the agents are up, and close before the bot side (and the agents with it) stop.
      if (agents && a && a.doors) {
        const doors = a.doors;
        doors.set(agents);
        closers.push(() => doors.set(undefined));
      }
      // Lane D's bot-side options, the receiving half: other computers' messages to the bots this computer runs.
      if (links) {
        // Only a bot's own sessions take another computer's message, and a bot's message only from the computer running
        // that bot (#313's review): never an agent's or a coding session, never a sender the peer doesn't run.
        const offDelivery = mountSessionDelivery(links.transport, links.registry, (session, input) => s.host.deliver(session, input), {
          ...(links.main ? { isStale: (epoch: number, scope?: string) => links.main!.lease.isStale(epoch, scope) } : {}),
          check: botDeliveryCheck({ host: s.host, bots: s.bots, ...(s.routines ? { routines: s.routines } : {}) }),
        });
        closers.push(offDelivery);
        Object.assign(input.handlers, laneMethodHandlers(peerSessionMethods({
          bots: s.bots, host: s.host, clock: input.clock, devices: links.registry, ...(s.routines ? { routines: s.routines } : {}),
          ...(input.updateGate ? { updateGate: input.updateGate } : {}),
          ...(links.main ? { computerOf: (device: string) => links.main!.computerOf(device) } : {}),
        })));
      }
      if (links?.main) {
        const handle = links.main;
        handle.setHandBack(() => s.bots.handBack());
        closers.push(() => handle.setHandBack(undefined));
      }
      if (links) {
        const lease = links.main?.lease;
        const sync = new SessionRecordSync({
          self: links.key.id,
          computer: () => runner.self,
          transport: links.transport,
          registry: links.registry,
          host: hostForSync(s.host),
          ...(lease ? { holder: () => lease.state().holder, isStale: (epoch: number, scope?: string) => lease.isStale(epoch, scope), scope: () => lease.scopeId() } : {}),
          log: (line) => log(`[sessions sync] ${line}`),
        });
        closers.push(() => sync.close());
      }
      await s.start();
      Object.assign(input.handlers, laneMethodHandlers(s.methods({ localDevice: links?.key.id ?? "local" })));
      // Lane D's usage rows (`usage.rows`, `usage.summary`): its ledger, counting the bot side's sessions as they run.
      const ledger = new UsageLedger({ path: cloverUsageDbPath(input.cloverHome), computer: runner.self });
      const counter = new CloverUsageCounter({ ledger, host: s.host, warn: (line) => log(`[usage] ${line}`) });
      counter.start();
      closers.push(() => {
        counter.stop();
        ledger.close();
      });
      Object.assign(input.handlers, laneMethodHandlers(usageMethods({ ledger })));
    }
    // The broker closes first at the stop (closers run in reverse): its open cards are cancelled and no new one is
    // raised, so nothing the bot side or the agents wait on is left hanging while they stop.
    if (broker) {
      const b = broker;
      closers.push(() => b.close());
    }
    const registry = input.bots ? input.bots.registry : undefined;
    return { ...(node ? { node } : {}), ...(side ? { bots: side } : {}), ...(agents ? { agents } : {}), ...(agents && registry ? { agentDefinitions: () => pluginAgentDefinitions(registry) } : {}), ...(broker ? { broker } : {}), ...(main ? { main } : {}), close };
  } catch (err) {
    await close();
    throw err;
  }
}

/** Lane D's bot-side options: what `createBotSide` takes from the daemon beyond the bots themselves.
 *
 * * **The relay** (§6.4): a message for a bot another computer runs goes there over the link (`linkBotRelay`, stamped
 *   with this computer's lease token); when that computer can't be reached, to the relay plugin's mailbox when there
 *   is one (#277), else the sender is told the bot is asleep.
 * * **Routines** (§7) run on this computer's engine: their secrets and the user's time zone from the daemon, the
 *   computers a routine may go to and their levels from the computer node, a routine made for another computer written
 *   there through the folder tree, and the plugins' triggers from the registry. The webhook ingress and the plugin
 *   triggers' arming run on the plugin host, once there is one (#277).
 * * **Voices** (§6.6) run on the plugin host too, with `voice.play` to the app.
 * * **Compaction** takes the daemon's numbers; **assets**, the app's URL for a plugin's file. */
export function botSideOptions(o: { b: DaemonBotsInput; links: DeviceLinks | null; node: ComputerNode | undefined; computer: string }): Partial<BotSideOptions> {
  const { b, links, node } = o;
  const host = b.pluginHost;
  const relay = links === null ? undefined : withMailbox(linkBotRelay({
    transport: links.transport, registry: links.registry, self: () => o.computer, ...(links.main ? { fence: () => links.main!.lease.fence() } : {}),
  }), b.relayMailbox);
  const routines: NonNullable<BotSideOptions["routines"]> = {
    ...(b.routines?.secrets ? { secrets: b.routines.secrets } : {}),
    ...(b.routines?.userTimeZone ? { userTimeZone: b.routines.userTimeZone } : {}),
    ...(b.routines?.webhookBase !== undefined ? { webhookBase: b.routines.webhookBase } : {}),
    triggers: b.registry,
    ...(node ? {
      computers: () => node.registry.list().map((c) => ({ name: c.name, level: c.level })),
      // The tree path names the computer (`home/<computer>/…`), so the tree reaches it from the path alone. It writes as
      // the core: the routine tool (the bot's level, its card for a raised one) is the gate (#313 review Q).
      writeRemote: (_computer: string, treePath: string, text: string) => node.tree.write(treePath, { encoding: "utf8", text }, { as: { kind: "core" } }),
    } : {}),
    ...(host ? { ingress: { registry: b.registry, host }, ...(host.triggers ? { pluginTriggers: host.triggers } : {}) } : {}),
  };
  return {
    ...(relay ? { relay } : {}),
    routines,
    ...(host && b.voicePlay ? { voices: { registry: b.registry, host, play: b.voicePlay } } : {}),
    ...(b.compaction ? { compaction: b.compaction } : {}),
    ...(b.assetUrl ? { assetUrl: b.assetUrl } : {}),
  };
}

/** The relay, falling back to the mailbox when the computer running the bot can't be reached (a session's message
 *  only: the user's own message is kept as a draft, §6.4). */
function withMailbox(relay: NonNullable<BotSideOptions["relay"]>, mailbox: BotRelayMailbox | undefined): NonNullable<BotSideOptions["relay"]> {
  if (mailbox === undefined) return relay;
  return {
    sendUser: (computer, session, p) => relay.sendUser(computer, session, p),
    deliver: async (computer, session, input) => {
      try {
        return await relay.deliver(computer, session, input);
      } catch (err) {
        if (isContractError(err, "bot_asleep")) return mailbox.deliver(computer, session, input);
        throw err;
      }
    },
  };
}

/** Keeps the computer registry's `isMain` on the lease's main computer: this computer while it runs the bots, and of
 *  the others the one the lease names (its holder, else the chosen main). Returns its removal. */
function followMain(node: ComputerNode, main: MainComputer, links: DeviceLinks): () => void {
  const reg = node.registry;
  const apply = () => {
    const here = main.runsHere();
    if (reg.self().isMain !== here) reg.updateSelf({ isMain: here });
    const runner = here ? undefined : main.runner();
    for (const c of reg.list()) {
      if (c.device === links.key.id) continue;
      const isMain = runner !== undefined && c.name === runner;
      if (c.isMain !== isMain) reg.update(c.name, { isMain });
    }
  };
  apply();
  const offLease = main.watch(apply);
  // A computer that says hello, or is renamed, gets its mark too (`update` changes nothing when it's already right).
  const offReg = reg.watch((change) => {
    if (change.type === "computer" && change.computer.device !== links.key.id) apply();
  });
  return () => {
    offLease();
    offReg();
  };
}

/** The ticks of this computer's MCP servers, as the computer node keeps them (lane J's `mcpTicks`, J-M2). Read off the
 *  node structurally, so the daemon's line works on a node that has them and waits on one that doesn't yet. */
interface OkTickTarget {
  mcpTicks?: { installed(pluginId: string): void };
}

/** Lane J's side of B's `onOkApproved` (#376): the user's yes to a plugin's OK card on this computer ticks the plugin's
 *  local MCP servers here (`mcpTicks.installed`; the controller's ruling: each computer keeps its own ticks, and a copy
 *  that arrives by sync isn't ticked). An OK answered before the computer node is up, or on a node without ticks yet,
 *  waits (each plugin once) and is ticked by `flush` once the node is there; a tick that fails is logged, never thrown
 *  into the OK. */
export function pluginOkTicks(node: () => object | undefined, log: (line: string) => void): { approved(pluginId: string): void; flush(): void; readonly waiting: number } {
  const waiting = new Set<string>();
  const tick = (id: string): boolean => {
    const ticks = (node() as OkTickTarget | undefined)?.mcpTicks;
    if (ticks === undefined) return false;
    try {
      ticks.installed(id);
    } catch (err) {
      log(`[parts] ${id}'s MCP servers couldn't be ticked on this computer: ${err instanceof Error ? err.message : String(err)}`);
    }
    return true;
  };
  return {
    approved(id) {
      if (!tick(id)) waiting.add(id);
    },
    flush() {
      for (const id of [...waiting]) if (tick(id)) waiting.delete(id);
    },
    get waiting() {
      return waiting.size;
    },
  };
}

/** The broker, bound late (the node needs it before it exists: it is made from the node's own registry). Its `request`
 *  refuses until then, and its `get` finds nothing; once bound, both are the broker's own. A level raise's card is
 *  read back through `get` (J's #342, which fails closed without it), so both must always forward. */
export function lateBroker(current: () => CloverApprovalBroker | undefined): Pick<CloverApprovalBroker, "request" | "get"> {
  return {
    request: async (r, o) => {
      const b = current();
      if (!b) throw new ContractError("refused", "the approval cards aren't up on this computer yet");
      return b.request(r, o);
    },
    get: (id) => current()?.get(id),
  };
}

/** How long a request waits for the parts' broker before its caller is told to try again. */
export const LATE_BROKER_WAIT_MS = 45_000;

/** The daemon's broker for what starts before it (the plugin registry's OK cards, the app's development-folder card):
 *  a request waits until the parts have started and then asks on the broker, or is refused when they started without
 *  one (no links, or the node didn't start). `get` and `watch` see the broker once it's there. */
export function lateApprovalBroker(ready: Promise<CloverApprovalBroker | undefined>, opts: { waitMs?: number } = {}): Pick<ApprovalBroker, "request" | "get" | "watch"> {
  let current: CloverApprovalBroker | undefined;
  let settled = false;
  void ready.then((b) => { current = b; settled = true; }, () => { settled = true; });
  const waitMs = opts.waitMs ?? LATE_BROKER_WAIT_MS;
  // The wait is bounded and follows the caller's signal (#397's review): the parts can take long, or never end on a
  // hung wire, and an RPC mustn't stay open meanwhile. The caller is told to try again.
  const brokerSoon = (signal: AbortSignal | undefined): Promise<CloverApprovalBroker | undefined> => {
    if (current !== undefined || settled) return Promise.resolve(current);
    return new Promise((resolve, reject) => {
      const done = (f: () => void) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", aborted);
        f();
      };
      const timer = setTimeout(() => done(() => reject(new ContractError("busy", "approvals aren't running on this computer yet; try again in a moment"))), waitMs);
      timer.unref?.();
      const aborted = () => done(() => reject(signal?.reason ?? new ContractError("cancelled", "the request was cancelled")));
      if (signal?.aborted) return aborted();
      signal?.addEventListener("abort", aborted, { once: true });
      ready.then((b) => done(() => resolve(b)), () => done(() => resolve(undefined)));
    });
  };
  return {
    request: async (r, o) => {
      const b = await brokerSoon(o?.signal);
      if (!b) throw new ContractError("refused", "the approval cards aren't up on this computer");
      return b.request(r, o);
    },
    get: (id) => current?.get(id),
    // A watcher attaches to the broker once it's there; before, it hears nothing (there are no cards to hear).
    watch: (fn) => {
      let off: (() => void) | undefined;
      let stopped = false;
      void ready.then((b) => { if (b && !stopped) off = b.watch(fn); }, () => undefined);
      return () => {
        stopped = true;
        off?.();
      };
    },
  };
}

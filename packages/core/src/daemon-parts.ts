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
import { createAgents, type AgentPauseGate, type AgentsOptions } from "./agents";
import { CloverApprovalBroker } from "./approvals/broker";
import { fileRuleStore } from "./approvals/rule-store";
import { deviceProofVerifier } from "./contracts/approval-broker";
import { ContractError, Listeners } from "./contracts/common";
import { CloverFence } from "./fence/fence";
import { fencedSpawner } from "./fence/fenced-process";
import { hookSpawner, type FencedSpawner } from "./fence/spawn";
import { hostOs } from "./tree/names";
import type { SessionHost } from "./contracts/session-host";
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
import { nodeParts, type SafetyReviewer } from "./computers/node-parts";
import type { ApprovalBroker } from "./contracts/approval-broker";
import { laneMethodHandlers, type CloverHandler } from "./ipc/clover";
import { computerNodeLinks, type DeviceLinks } from "./links/node";
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
  node?: false | Partial<Pick<ComputerNodeOptions, "treeRoot" | "executor" | "fence" | "reviewer" | "askUser" | "terminals" | "answers">>;
  /** The bot side; false for none. */
  bots?: false | DaemonBotsInput;
  /** The daemon's safety reviewer (`BashReviewer`, on the internal-jobs model): the computer node judges another
   *  computer's calls with it at "ask for risky actions", and fails closed without it (lane J's `nodeParts`). */
  reviewer?: SafetyReviewer;
  /** TEST SEAM: an approval broker for the node's cards (a paste of several lines). The daemon's own broker is bound
   *  here once it exists; without either, such a paste is refused with a reason, never dropped silently. */
  /** The Clover server's `coreEvent` (its own signature, shared with lane J's terminals in #335): the broker's cards go
   *  out through it as core events. */
  coreEvent?: (event: CoreEventInput, opts?: CoreEventOptions) => number;
  approvals?: Pick<ApprovalBroker, "request">;
  /** TEST SEAM: the fenced process in place of `fencedSpawner({ fence })` (C-M2 part 2, #321). */
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
  /** Lane C's approval broker for the agents (#267). */
  broker?: CloverApprovalBroker;
  /** Lane C's fenced process (#321) over this computer's one fence. Its `recheck` runs at each of the bot side's turn
   *  ends and session ends (`recheckAtTurnEnds`). */
  spawner?: FencedSpawner;
  /** The door for a hook's command (`hookSpawner(os, spawner)`): fenced on macOS and Linux (refusing with the reason
   *  where Linux has no bwrap), the user's on Windows. Lane A's turn
   *  loop runs `command` hooks through it (`PluginHooksOptions.commandSpawner`, bound late in daemon.ts). */
  hookSpawner?: FencedSpawner;
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
    // C-M2 part 2 (#321): the fenced process over the same fence, and hooks' commands through `hookSpawner`.
    const spawner = input.spawner ?? fencedSpawner({ fence, os: hostOs() });
    const hooksSpawner = hookSpawner(hostOs(), spawner);
    // What a first run would do (Linux: the bwrap probe), done now and off the event loop (#369's review).
    void spawner.warm?.().catch(() => undefined);
    let broker: CloverApprovalBroker | undefined;
    const lateApprovals = lateBroker(() => broker);
    if (links && nodeLinks && input.node !== false) {
      // ── The computer node's own parts (lane J, `computers/node-parts.ts`) ──
      // Its terminals' card for a paste of several lines (through the approval broker, once there is one; until then
      // such a paste is refused with a reason), and its safety reviewer for another computer's calls at "ask for risky
      // actions" (the daemon's `BashReviewer`; it fails closed). The fence, MCP, the executor and askUser/answers are
      // not here: the node options below carry what the daemon passes. A test's own node options win.
      const own = nodeParts({
        computer: () => node?.registry.self().name ?? nodeLinks.self.name,
        // The broker below, bound late: it needs the node's own registry for each computer's level.
        approvals: input.approvals ?? lateApprovals,
        ...(input.reviewer ? { reviewer: input.reviewer } : {}),
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
      node = n;
      if (main) closers.push(followMain(n, main, links));
      broker = new CloverApprovalBroker({
        clock: input.clock, // A computer the registry doesn't know is judged at read-only, failing closed as the agents' manager does.
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
      // The fence's recheck over the bot side's host (below), bound late: its end pass runs inside the side's close.
      let fenceRecheck: ReturnType<typeof recheckAtTurnEnds> | undefined;
      const s = createBotSide({
        // #321's recheck with `end` for every session still open, after the stop cancelled the turns and before the
        // host lets go of the sessions, so its notes are recorded.
        beforeRelease: () => fenceRecheck?.endPass(),
        home: input.cloverHome, computer: runner.self, clock: input.clock, registry: b.registry, main: runner,
        drivers: b.drivers({ side: () => side, node, main: runner, broker, fence }),
        defaultModel: b.defaultModel,
        // Lane C's broker (#267): the bot side's one SessionGrants asks through it (the browser's person's partition).
        ...(broker ? { approvals: broker } : {}),
        ...(b.hasKeyFor ? { hasKeyFor: b.hasKeyFor } : {}),
        userHome: input.userHome,
        ...(node ? { levelOf: (c: string) => node!.registry.get(c)?.level, onSessionEnded: (id: string) => void node!.terminals.closeSession(id) } : {}),
        // Lane M's gate (lane D's #246): the bot side's turns are its `bot-turns` source, and none starts while it's closed.
        ...(input.updateGate ? { updateGate: input.updateGate } : {}),
        ...(agentsFactory ? { agents: agentsFactory } : {}),
        warn: (line) => log(`[bots] ${line}`),
      });
      side = s;
      fenceRecheck = recheckAtTurnEnds(s.host, spawner, (line) => log(`[fence] ${line}`));
      // #321's second line behind each run's git-key revert: at each turn's end, and with `end` at the session's. Its end
      // pass runs inside the bot side's close (`beforeRelease`), and its watch goes after that close (pushed before it;
      // closers run in reverse), so the sessions the stop cancels are seen ending.
      closers.push(() => fenceRecheck?.close());
      closers.push(() => s.close());
      closers.push(s.gate.watch(() => pauseChanged.emit()));
      // The server's doors open once the agents are up, and close before the bot side (and the agents with it) stop.
      if (agents && a && a.doors) {
        const doors = a.doors;
        doors.set(agents);
        closers.push(() => doors.set(undefined));
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
    }
    // The broker closes first at the stop (closers run in reverse): its open cards are cancelled and no new one is
    // raised, so nothing the bot side or the agents wait on is left hanging while they stop.
    if (broker) {
      const b = broker;
      closers.push(() => b.close());
    }
    return { ...(node ? { node } : {}), ...(side ? { bots: side } : {}), ...(agents ? { agents } : {}), ...(broker ? { broker } : {}), spawner, hookSpawner: hooksSpawner, ...(main ? { main } : {}), close };
  } catch (err) {
    await close();
    throw err;
  }
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

/** How long the stop's end pass waits on its notes. */
const END_PASS_NOTES_MS = 4_000;

/** The most stopped sessions the recheck remembers as ended (a resumed one leaves the set; the oldest go first). */
const RECHECK_ENDED_MAX = 4096;

/** Calls the fenced process's `recheck` (#321) for each session of `host` when its turn ends (a running session going
 *  back to `idle` or `ready`), and with `end: true` once when it stops or fails. A session that starts again (the same
 *  id, resumed) is watched again. A revert or a recheck that fails goes to `log` and to the session's own record, as a
 *  core note. `endPass` rechecks, with `end`, every session still open: the daemon runs it in the bot side's close after
 *  the turns were cancelled and before the host lets go of the sessions (`BotSideOptions.beforeRelease`), so its notes
 *  are recorded (#365's review). `close` only stops watching, after the bot side's close. */
export function recheckAtTurnEnds(host: Pick<SessionHost, "watch" | "deliver">, spawner: Pick<FencedSpawner, "recheck">, log: (line: string) => void): { endPass(): Promise<void>; close(): void } {
  const running = new Set<string>();
  const open = new Set<string>();
  const ended = new Set<string>();
  const pending: Array<Promise<unknown>> = [];
  const note = (id: string, text: string) => {
    pending.push(host.deliver(id, { from: "note", label: "Fence", text, by: { kind: "core" } }).catch((err: unknown) => {
      log(`${id}: the note wasn't recorded: ${err instanceof Error ? err.message : String(err)}`);
    }));
  };
  const recheck = (id: string, end: boolean) => {
    try {
      const line = spawner.recheck?.(id, end ? { end: true } : {});
      if (line) {
        log(`${id}: ${line}`);
        note(id, `Clover undid a git setting this session's commands changed: ${line}`);
      }
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      log(`${id}: the recheck failed: ${why}`);
      note(id, `Clover couldn't look again at the git settings this session's commands may have changed: ${why}`);
    }
  };
  const off = host.watch((view) => {
    const id = view.id;
    if (view.status === "starting" || view.status === "ready" || view.status === "prompting") {
      ended.delete(id); // resumed: watched again
      open.add(id);
    }
    if (ended.has(id)) return;
    if (view.status === "prompting" || view.status === "cancelling") {
      running.add(id);
    } else if (view.status === "idle" || view.status === "ready") {
      open.add(id);
      if (running.delete(id)) recheck(id, false);
    } else if (view.status === "stopped" || view.status === "failed") {
      running.delete(id);
      open.delete(id);
      ended.add(id);
      if (ended.size > RECHECK_ENDED_MAX) ended.delete(ended.values().next().value!);
      recheck(id, true);
    }
  });
  return {
    async endPass() {
      for (const id of [...open]) recheck(id, true);
      open.clear();
      running.clear();
      // Bounded: a note for a session another computer runs can wait on a link that's down (#369's review).
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<"late">((r) => { timer = setTimeout(() => r("late"), END_PASS_NOTES_MS); });
      if ((await Promise.race([Promise.all(pending.splice(0)).then(() => "done" as const), late])) === "late") {
        log(`the stop's recheck notes weren't all recorded within ${END_PASS_NOTES_MS / 1000} s`);
      }
      clearTimeout(timer);
    },
    close() {
      off();
      for (const id of [...open]) recheck(id, true); // only what the end pass didn't see (no bot side, say)
      open.clear();
      running.clear();
      ended.clear();
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

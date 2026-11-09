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
// * **The sessions' records** (H's `SessionRecordSync` into D's host, #279): the sessions this computer runs are
//   copied live to the user's other computers, and theirs land here, so a computer that takes the bots over finds their
//   open turns at once. What comes in goes through `hostForSync`: a grant copied from another computer never grants
//   here (D's reviewer's rule), so a session that moves here asks again on this computer's own card. The lease fences
//   it: a record from an earlier lease is taken as late.
import type { CanUseTool } from "@waifucave/clover-agent-sdk";
import type { BotSide, BotSideOptions } from "./bots/wiring";
import { createBotSide } from "./bots/wiring";
import { LeaseMainComputer, soleComputer, type MainComputer } from "./bots/main-computer";
import type { DriverFactory } from "./bots/service";
import type { Clock } from "./contracts/clock";
import type { PluginRegistry } from "./contracts/plugin-registry";
import { startComputerNode, type ComputerNode, type ComputerNodeOptions } from "./computers/node";
import { nodeParts, type SafetyReviewer } from "./computers/node-parts";
import type { ApprovalBroker } from "./contracts/approval-broker";
import type { FencedSpawner } from "./fence/spawn";
import { laneMethodHandlers, type CloverHandler } from "./ipc/clover";
import { computerNodeLinks, type DeviceLinks } from "./links/node";
import { hostForSync } from "./daemon-session-sync";
import { SessionRecordSync } from "./sync/session-records";

/** What the bot side needs that the daemon builds: where the bots come from and what drives their sessions. */
export interface DaemonBotsInput {
  /** The plugin registry the bots come from (`openPluginRegistry` in the daemon). */
  registry: PluginRegistry;
  /** Each session's driver, given the bot side (for its core tools, read at each build) and the computer node. */
  drivers(parts: { side(): BotSide | undefined; node: ComputerNode | undefined; main: MainComputer }): DriverFactory;
  defaultModel: BotSideOptions["defaultModel"];
  hasKeyFor?: BotSideOptions["hasKeyFor"];
  /** The plugin host that runs `pill.target` entries' handlers (#323's `pill.send`). */
  pillTargets?: BotSideOptions["pillTargets"];
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
  /** TEST SEAM: an approval broker for the node's cards (a paste of several lines) and its own record of a card a
   *  level raise hands over (`get`, the registry's `cardRecord`). The daemon's own broker is bound here once it
   *  exists; without either, such a paste is refused with a reason, never dropped silently, and no card raises a level. */
  approvals?: Pick<ApprovalBroker, "request" | "get">;
  /** Lane C's fenced process on this computer (`fencedSpawner({ fence })` over the daemon's one CloverFence): the
   *  computer node's Bash runs through it (`fencedExecutor`, lane J). Without it the node has no executor and Bash on
   *  its tree is refused; it never runs unsandboxed. A test's own `node.executor` wins. */
  spawner?: FencedSpawner;
  /** The daemon's update gate: the bot side's running turns keep an update waiting. */
  updateGate?: BotSideOptions["updateGate"];
  log?(line: string): void;
}

export interface DaemonParts {
  node?: ComputerNode;
  bots?: BotSide;
  /** Who runs the bots (the lease's holder, or the main), as lane D reads it. */
  main?: MainComputer;
  /** Closes the bot side, then the node: the reverse of their start. The links close after, with their owner. */
  close(): Promise<void>;
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

    let node: ComputerNode | undefined;
    if (links && nodeLinks && input.node !== false) {
      // ── The computer node's own parts (lane J, `computers/node-parts.ts`) ──
      // Its terminals' card for a paste of several lines (through the approval broker, once there is one; until then
      // such a paste is refused with a reason), the broker's own record of a card a level raise hands over
      // (`cardRecord: (id) => approvals?.get(id)`; no broker, no card raises), and its safety reviewer for another computer's calls at "ask for risky
      // actions" (the daemon's `BashReviewer`; it fails closed), and its Bash on lane C's fenced process when the daemon
      // hands over its spawner (`input.spawner`; none, no executor). The fence, MCP and askUser/answers are not here: the node options below carry what the daemon passes. A test's own node options win.
      const own = nodeParts({
        computer: () => node?.registry.self().name ?? nodeLinks.self.name,
        ...(input.approvals ? { approvals: input.approvals } : {}),
        ...(input.reviewer ? { reviewer: input.reviewer } : {}),
        ...(input.spawner ? { bash: { spawner: input.spawner, home: input.userHome } } : {}),
        answers: { devices: nodeLinks.devices, cloverHome: input.cloverHome, clock: input.clock },
        log: (line) => log(`[computers] ${line}`),
      });
      const n = startComputerNode({
        ...nodeLinks,
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
    }

    if (input.bots) {
      const b = input.bots;
      const runner = main ?? soleComputer(computer ?? "this-computer");
      const s = createBotSide({
        home: input.cloverHome, computer: runner.self, clock: input.clock, registry: b.registry, main: runner,
        drivers: b.drivers({ side: () => side, node, main: runner }),
        defaultModel: b.defaultModel,
        ...(b.hasKeyFor ? { hasKeyFor: b.hasKeyFor } : {}),
        ...(b.pillTargets ? { pillTargets: b.pillTargets } : {}),
        userHome: input.userHome,
        ...(node ? { levelOf: (c: string) => node!.registry.get(c)?.level, onSessionEnded: (id: string) => void node!.terminals.closeSession(id) } : {}),
        // Lane M's gate (lane D's #246): the bot side's turns are its `bot-turns` source, and none starts while it's closed.
        ...(input.updateGate ? { updateGate: input.updateGate } : {}),
        warn: (line) => log(`[bots] ${line}`),
      });
      side = s;
      closers.push(() => s.close());
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
    return { ...(node ? { node } : {}), ...(side ? { bots: side } : {}), ...(main ? { main } : {}), close };
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

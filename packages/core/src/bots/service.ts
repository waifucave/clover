// The bots on this computer (spec §6): every plugin's `bot` entry, the user layer over it, and each bot's one
// conversation and its side threads, hosted by the durable session host. Owner: lane D.
//
// * **A bot is a plugin's `bot` entry** (plugin-bot.ts), read from the plugin registry (lane B; its fake until B-M1)
//   and followed live: a bot whose plugin appears, changes, goes off or goes away is added, updated or removed.
// * **One continuous conversation per bot** (§6.3): the bot's main session, `b_<bot>` (sessions/ids.ts), opened when
//   the bot appears and released, never stopped, when it goes, so it continues where it was when the bot returns,
//   after a restart too. A new conversation opens with the bot's greeting, once.
// * **Side threads** (§6.4, §7): a routine's run gets a session of its own under the bot, with the same instructions
//   and memory, on the computer that holds the routine; its short result posts into the main conversation and the
//   side thread ends. A run a crash cut off says it was interrupted when its bot loads again, and ends. The routine
//   engine that decides when runs happen is M3's; `runSideThread` is its door.
// * **A bot that breaks its own files** (§6.1 lets it edit its plugin folder) keeps running on its last good version,
//   so it can still fix them; the reason is logged.
// * **The user layer** (user-layer.ts) wins field by field over the plugin; model and effort apply at the next turn,
//   instructions at the next compaction (§5.6, §6.3), since drivers read the bot through `current()`.
// * **The model**: the user layer's, else the plugin's default when the user has a key for it, else the user's
//   default model (§6.1).
// * **State** (`BotView.state`): `paused` while the pause switch is on, `thinking` while the main conversation runs a
//   turn, `asleep` with no connection to the computer running it (§6.4), otherwise `idle`.
// * **The computer running the bots** (§6.4, main-computer.ts): every bot's main conversation runs on the runner, the
//   lease's holder. The gate (gate.ts) starts its turns only there; elsewhere what the user and other sessions send it
//   is relayed to the runner (`deliverTo`, `sendUserTo`; lane H's link). This computer:
//   * **taking the bots over** catches each conversation up: a turn the old runner never ended is ended interrupted,
//     its unfinished calls recorded as maybe having run there, never run again (`DurableSessionHost.catchUp`);
//   * **losing them** (its lease lapsed or went to another computer) interrupts what runs, since it may no longer act;
//   * **handing them back** to a returning main (`handBack`) starts no new turn, waits for each bot's running turn to
//     end, then gives the lease up: a bot moves between turns, never in the middle of one;
//   * **writes memory** only while it runs the bots (the starter memories, §6.5): the others get copies (lane H).
// * **The pause switch** (§9.2, `bots.pause`; the owner's decision of November 6, it pauses everything): the user's
//   alone. On, no new turn starts for a bot, a side thread or a background agent (messages wait), routines don't start
//   (`runSideThread` refuses), and what runs is held at its next tool call (`mayAct`, `whenMayAct`), delegated agents
//   included. Off, the held work goes on and what waited runs. The user's own coding sessions aren't paused.
// * **J's placement** (`botsRunHere`, `placement`, `computerFor`): which bots this computer runs and where each runs,
//   for the folder tree; and a session's scratch folder as a tree path (`scratchFor`), for J's MCP router.
//
// The driver of each session comes from `DriverFactory`: lane A's embedded runtime once A-M1 merges; tests use the
// contracts' FakeSessionDriver.
import {
  CLOVER_ERR, type BotView, type Caller, type ChangeResult, type Level, type RoutineRunView, type SessionView, type Text, type UserMessageInput,
} from "@waifucave/clover-protocol";
import type { Clock } from "../contracts/clock";
import { ContractError, Listeners, type Unsubscribe } from "../contracts/common";
import type { PluginRegistry } from "../contracts/plugin-registry";
import type { DeliveredInput, Disposition, SessionDriver, TurnEnd, UserInput } from "../contracts/session-host";
import type { DurableSessionHost } from "../sessions/durable-host";
import type { BotGate } from "./gate";
import { memoryBlock } from "./prompt";
import { mainSessionIdFor, mintSessionId } from "../sessions/ids";
import { readJson, writeJsonAtomic } from "../sessions/atomic-file";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { seedMemory } from "./memory";
import { botPaths, botStateFile, homeTreePath, sessionScratchDir, type BotPaths } from "./paths";
import { botEntries, loadPluginBot, type PluginBot } from "./plugin-bot";
import { parseUserLayerPatch, userLayerFields, UserLayerStore, type UserLayer, type UserLayerField } from "./user-layer";

/** A bot as it stands now: its plugin's entry under the user layer. */
export interface EffectiveBot {
  id: string;
  name: Text;
  /** The `<bot-instructions>` text (§6.1). */
  instructions: string;
  model: string;
  effort?: string;
  voice?: { provider: string; voice: string; model?: string };
  avatar?: { file: string; format: string; portrait?: string };
  theme?: string;
  layout?: string;
  greeting?: string;
  /** The bot's browser tabs may reach the LAN: the person's setting, from the user layer only (never the plugin's). */
  lan?: boolean;
  /** The fields the user layer sets. */
  userLayer: UserLayerField[];
}

/** What a session's driver knows about the bot it runs. */
export interface BotSessionContext {
  readonly botId: string;
  readonly sessionId: string;
  readonly kind: "bot" | "side-thread";
  /** The computer running the session (§6.4). */
  readonly computer: string;
  /** The bot's memory, agents' transcripts and scratch, which the system prompt names (§6.5). */
  readonly paths: BotPaths;
  /** A side thread's level (its routine's, once its card was answered, §7); undefined: the computer's. */
  readonly level?: Level;
  /** Who the session is when it calls anything, its bot named (§5.4; the controller's L-M1 answer): the runtime binds
   *  each tool call's caller from this, never from what a plugin says (R7). */
  readonly caller: Extract<Caller, { kind: "session" }>;
  /** The bot now: a driver reads the model and effort at each turn and the instructions at each compaction. */
  current(): EffectiveBot;
  /** The memory block of the system prompt (§6.5), read fresh each time the driver builds or rebuilds its prompt. */
  memoryBlock(): string;
  /** Whether the session may start a tool call or a memory write now (§6.4 "Fencing the old main", §9.2): false once
   *  this computer stops running the bots or the pause switch goes on. The driver checks it before each call. */
  mayAct(): boolean;
  /** Resolves once `mayAct` says yes: a turn the pause switch holds waits here at its next tool call, and goes on
   *  when the user resumes (the owner's decision of November 6). Rejects when `signal` aborts. */
  whenMayAct(signal?: AbortSignal): Promise<void>;
  /** Whether a turn may start now (the durable host's `mayStart`): no while paused, and for a bot's conversation while
   *  this computer isn't the runner or is handing its bots back. A driver asks it of a turn its runtime starts on its
   *  own (a background task's notification), which no host turn covers; without it, `mayAct` stands in. */
  mayStart?(): boolean;
  /** Resolves once `mayStart` says yes; rejects when `signal` aborts. */
  whenMayStart?(signal?: AbortSignal): Promise<void>;
  /** Whether the cached prompt has expired: the turn starting now rebuilds the harness blocks (the MCP block, the
   *  devices block, the `computer` lists) without compacting (§6.1). */
  cacheCold(): boolean;
  /** A background task of the session's runtime finished, failed or was stopped (lane A's ask): the driver hands its
   *  notification here instead of starting a turn itself. The host records it and folds it into the running turn, or
   *  starts a turn for it (`origin: "task-notification"`) once the pause, the lease and the update gate let one start;
   *  the driver then runs that turn through `turn()` like any other. Optional (lane A's ask): a driver whose context
   *  has none keeps holding such a turn until the session may start one. One wake per notification.
   *  A storm of `event` wakes (a monitor that keeps reporting) never piles up: while a turn runs or one is queued for
   *  the session (behind the pause, the lease or the update gate too), further events merge into one pending wake per
   *  task, with that task's latest text and how many came, delivered as that turn ends (the first starts a turn, the
   *  rest fold into it); it answers `queued` meanwhile. */
  wake?(input: Omit<Extract<DeliveredInput, { from: "task" }>, "from">): Promise<{ disposition: Disposition; seq: number }>;
}

/** How a message reaches a bot's conversation on another computer (lane H's link: `peer.session.send`, and a bot's
 *  or a routine's message to the session there). */
export interface BotRelay {
  /** `peer.session.send`: the message as its device sent it (its signature too, which the runner checks), the device,
   *  and this computer's stamp. */
  sendUser(computer: string, session: string, p: { message: UserMessageInput; device: string; sentAt: number }): Promise<{ seq: number }>;
  deliver(computer: string, session: string, input: DeliveredInput): Promise<{ disposition: Disposition; seq: number }>;
}

export type DriverFactory = (ctx: BotSessionContext) => SessionDriver;

export type BotServiceEvent =
  | { type: "bot_changed"; ts: number; bot: BotView }
  | { type: "bot_removed"; ts: number; id: string }
  | { type: "session_changed"; ts: number; session: SessionView }
  | { type: "bots_paused"; ts: number; paused: boolean };

export interface BotServiceOptions {
  home: string;
  /** This computer's name in the folder tree (§9.1). */
  computer: string;
  registry: PluginRegistry;
  /** Built with this gate's `mayStart` and its main computer's `epoch` (wiring.ts does both). */
  host: DurableSessionHost;
  /** When bots may think here: the runner (lane H's lease) and the pause switch. */
  gate: BotGate;
  /** Reaches a bot's conversation on the computer running it, when that isn't this one; without it, such a message is
   *  refused `bot_asleep`. */
  relay?: BotRelay;
  /** Whether a session's cached prompt has expired (compaction.ts); without it, always. */
  cacheCold?(sessionId: string): boolean;
  /** The user's home folder, which the folder tree names `home/<this computer>/` (§9.1); the OS's by default. */
  userHome?: string;
  /** Background agents and coding sessions a restart left dormant, handed over at start to be reattached (lane K's
   *  `AgentManager.reattach`, which gives each its driver again). */
  reattach?(sessions: SessionView[]): Promise<void> | void;
  drivers: DriverFactory;
  clock: Clock;
  /** The user's default model and effort (§6.1). */
  defaultModel(): { model: string; effort?: string };
  /** Whether the user has a key for a model; default: for every model. */
  hasKeyFor?(model: string): boolean;
  /** The URL the app loads a plugin's file from (a bot's portrait); none until the core serves plugin assets. */
  assetUrl?(pluginId: string, path: string): string | undefined;
  warn?(message: string): void;
}

/** A routine's run, as the routine engine (M3) hands it over. */
export interface SideThreadRun {
  /** The routine's id (its file's `id`, §7). */
  routine: string;
  name: string;
  /** The routine's instructions, which start the run. */
  text: string;
  /** The computer that holds the routine; default this one. */
  computer?: string;
  /** The level the run gets: the routine's own, once its card was answered, else its computer's (§7). */
  level?: Level;
  /** Told the side thread's id as the run starts (`routine.runNow` answers with it). */
  onSession?(id: string): void;
}

/** How long a hand-back waits for the bots' running turns to end before it gives up (they stay here). */
export const HAND_BACK_MAX_MS = 10 * 60_000;

/** The longest result a side thread posts into the main conversation (`RoutineRunView.summary`'s cap). */
export const SIDE_THREAD_RESULT_MAX_CHARS = 4_000;

type WakeInput = Omit<Extract<DeliveredInput, { from: "task" }>, "from">;

/** A session's merged `event` wakes, one per task, waiting for its turn to end. */
interface PendingWakes {
  tasks: Map<string, { text: string; count: number }>;
  off: () => void;
}

interface Live {
  plugin: PluginBot;
  mainSession: string;
  /** The last view `bot_changed` carried, to tell a real change. */
  lastView?: string;
}

interface BotState {
  bot: string;
  firstSeen: number;
  seededMemory: boolean;
}

export function plainText(text: Text): string {
  return typeof text === "string" ? text : text.en;
}

export class BotService {
  readonly #o: BotServiceOptions;
  readonly #layers: UserLayerStore;
  readonly #bots = new Map<string, Live>();
  /** Each session's merged `event` wakes, waiting for its turn to end. */
  readonly #wakes = new Map<string, PendingWakes>();
  readonly #events = new Listeners<BotServiceEvent>();
  readonly #warn: (message: string) => void;
  #offs: Unsubscribe[] = [];
  #sync: Promise<void> = Promise.resolve();
  #started = false;
  /** What this computer last knew: whether it ran the bots, and which computer did. */
  #ranHere = false;
  #lastRunner: string | undefined;

  constructor(opts: BotServiceOptions) {
    this.#o = opts;
    this.#layers = new UserLayerStore(opts.home);
    this.#warn = opts.warn ?? (() => {});
  }

  /** Loads every bot, opens (or reattaches) each one's conversation, and follows the registry from then on. */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    this.#ranHere = this.#o.gate.main.runsHere();
    this.#lastRunner = this.#runner();
    this.#offs.push(this.#o.host.watch((view) => this.#onSession(view)));
    this.#offs.push(this.#o.registry.watch(() => void this.#queueSync()));
    this.#offs.push(this.#o.gate.main.watch(() => void this.#queueSync(() => this.#onRunnerChanged())));
    await this.#queueSync();
    // Runs a crash cut off whose bot is no longer installed: ended too, with the result posted for when it returns.
    const host = this.#o.host;
    const orphans = new Set(host.list({ kind: "side-thread" }).filter((s) => s.bot !== undefined && !this.#bots.has(s.bot)).map((s) => s.bot!));
    for (const bot of orphans) await this.#endCutOffRuns(bot, mainSessionIdFor(bot));
    const dormant = [...host.list({ kind: "agent" }), ...host.list({ kind: "coding" })]
      .filter((v) => !host.isAttached(v.id) && v.status !== "stopped" && v.status !== "failed");
    if (dormant.length > 0 && this.#o.reattach) {
      try {
        await this.#o.reattach(dormant);
      } catch (err) {
        this.#warn(`reattaching ${dormant.length} agent session(s) failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Detaches every bot's sessions, leaving them dormant on disk (a shutdown). */
  async stop(): Promise<void> {
    for (const off of this.#offs.splice(0)) off();
    for (const w of this.#wakes.values()) w.off();
    this.#wakes.clear();
    await this.#sync;
    for (const live of this.#bots.values()) {
      await this.#o.host.release(live.mainSession);
      for (const s of this.#o.host.list({ bot: live.plugin.id, kind: "side-thread" })) await this.#o.host.release(s.id);
    }
    this.#bots.clear();
    this.#started = false;
  }

  /** Waits for the registry's changes so far to be applied. */
  async settled(): Promise<void> {
    await this.#sync;
  }

  list(): BotView[] {
    return [...this.#bots.values()].map((live) => this.#view(live));
  }

  get(id: string): BotView | undefined {
    const live = this.#bots.get(id);
    return live ? this.#view(live) : undefined;
  }

  has(id: string): boolean {
    return this.#bots.has(id);
  }

  effective(id: string): EffectiveBot {
    return this.#effective(this.#must(id));
  }

  /** The bot's one conversation. */
  mainSession(id: string): string {
    return this.#must(id).mainSession;
  }

  paths(id: string): BotPaths {
    this.#must(id);
    return botPaths(this.#o.home, id);
  }

  onEvent(fn: (event: BotServiceEvent) => void): Unsubscribe {
    return this.#events.add(fn);
  }

  /** The bots whose conversations this computer runs now (lane J's `bots()` for the folder tree). */
  botsRunHere(): string[] {
    return this.#o.gate.main.runsHere() ? [...this.#bots.keys()] : [];
  }

  /** Each bot and the computer running its conversation (§6.4). */
  placement(): { bot: string; computer: string }[] {
    const computer = this.#runner();
    return [...this.#bots.keys()].map((bot) => ({ bot, computer }));
  }

  /** The computer running a bot's conversation, or undefined for a bot that isn't installed (lane J's `botPlacement`). */
  computerFor(bot: string): string | undefined {
    return this.#bots.has(bot) ? this.#runner() : undefined;
  }

  /** A session's scratch folder here, made if missing, as a folder-tree path (§6.5; lane J's MCP router saves a
   *  call's files there when it names no `saveTo`). Refused for a Clover home outside the user's home. */
  scratchFor(sessionId: string): string {
    const view = this.#o.host.get(sessionId);
    if (!view) throw new ContractError("not_found", `no session ${sessionId}`);
    const bot = this.#o.host.callerOf(sessionId).bot;
    const dir = sessionScratchDir(this.#o.home, { id: sessionId, ...(bot === undefined ? {} : { bot }) });
    const tree = homeTreePath({ userHome: this.#o.userHome ?? homedir(), computer: this.#o.computer, dir });
    if (tree === undefined) throw new ContractError("invalid", `the scratch folder ${dir} isn't inside the user's home, so the folder tree can't name it`);
    mkdirSync(dir, { recursive: true });
    return tree;
  }

  get paused(): boolean {
    return this.#o.gate.paused;
  }

  /** `bots.pause`: the user's switch for every bot and routine at once (§9.2). */
  async setPaused(paused: boolean, caller: Caller): Promise<void> {
    if (caller.kind !== "user") throw new ContractError("refused", "only the user pauses or resumes the bots", { rpc: CLOVER_ERR.NOT_THE_USER });
    if (!this.#o.gate.setPaused(paused, this.#o.clock.now())) return;
    this.#events.emit({ type: "bots_paused", ts: this.#o.clock.now(), paused });
    // Paused, what runs is held at its next tool call (the drivers read `mayAct`); resumed, it goes on, and what
    // waited starts.
    if (!paused) this.#o.host.resume();
    for (const live of this.#bots.values()) this.#emitBot(live);
  }

  /** The user's message to a bot's conversation, wherever it runs (§6.4): here, or relayed to the runner with the
   *  message as its device sent it (`message`, signature and all). */
  async sendUserTo(id: string, input: Omit<UserInput, "from">, message: UserMessageInput): Promise<{ seq: number }> {
    const live = this.#must(id);
    const runner = this.#remoteRunner();
    if (runner === undefined) return this.#o.host.sendUser(live.mainSession, input);
    if (!this.#o.relay) throw new ContractError("bot_asleep", `can't reach ${runner}, the computer running ${id}; the draft is kept`);
    return this.#o.relay.sendUser(runner, live.mainSession, { message: { ...message, sentAt: input.sentAt }, device: input.device, sentAt: input.sentAt });
  }

  /** Another session's message to a bot's conversation, wherever it runs: the host forwards it to the runner when that
   *  is another computer (`DurableSessionHostOptions.forward`). */
  async deliverTo(id: string, input: DeliveredInput): Promise<{ disposition: Disposition; seq: number }> {
    return this.#o.host.deliver(this.#must(id).mainSession, input);
  }

  /** Hands the bots back to the main, which is back (§6.4 "When the main returns"): no new turn starts here, each
   *  bot's running turn ends where it is, and then the lease goes, so the main takes each bot between its turns. */
  async handBack(): Promise<void> {
    const gate = this.#o.gate;
    const main = gate.main.main();
    if (!gate.main.runsHere() || main === undefined || main === gate.main.self || gate.handingBack) return;
    gate.setHandingBack(true);
    try {
      const idle = await Promise.race([
        this.#allIdle().then(() => true),
        new Promise<false>((resolve) => this.#o.clock.setTimeout(() => resolve(false), HAND_BACK_MAX_MS)),
      ]);
      if (!idle) {
        // A turn still runs: the bots stay here rather than move mid-turn, and the next hand-back tries again.
        this.#warn(`handing the bots back to ${main} gave up after ${HAND_BACK_MAX_MS / 60_000} minutes: a turn still runs here`);
        return;
      }
      await gate.main.release();
    } catch (err) {
      this.#warn(`handing the bots back to ${main} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      gate.setHandingBack(false);
      await this.#queueSync(() => this.#onRunnerChanged());
    }
  }

  /** `bot.setUserLayer`: only the user changes a bot's user layer (§6.1, §9.1). A change from a plugin's layer reaches
   *  this as the user only once the user approved its sealed card (lane C's `change: "core"` routing, §5.5). */
  async setUserLayer(id: string, patch: unknown, caller: Caller): Promise<ChangeResult> {
    if (caller.kind === "session") throw new ContractError("refused", "a bot or an agent can't change a bot's user layer: it edits its plugin folder instead", { rpc: CLOVER_ERR.NOT_THE_USER });
    if (caller.kind === "plugin") throw new ContractError("refused", "only the user changes a bot's user layer; a plugin's change goes to the user as a sealed card", { rpc: CLOVER_ERR.NOT_THE_USER });
    if (caller.kind !== "user") throw new ContractError("refused", "only the user changes a bot's user layer", { rpc: CLOVER_ERR.NOT_THE_USER });
    const live = this.#must(id);
    this.#layers.set(id, parseUserLayerPatch(patch));
    this.#syncMainSession(live);
    this.#emitBot(live);
    return { applied: true };
  }

  /** The bots whose LAN setting is on (lane L's `lanBots`, the core's `BrowserNetworkConfig`): the person's alone. */
  lanBots(): string[] {
    return [...this.#bots.values()].filter((live) => this.#layers.get(live.plugin.id).lan === true).map((live) => live.plugin.id);
  }

  userLayer(id: string): UserLayer {
    this.#must(id);
    return this.#layers.get(id);
  }

  /** Runs a routine in a side thread of its bot (§6.4, §7) and posts its short result into the bot's conversation.
   *  Resolves when the run has ended and its result is posted. */
  async runSideThread(id: string, run: SideThreadRun): Promise<RoutineRunView> {
    const live = this.#must(id);
    if (this.#o.gate.paused) throw new ContractError("refused", "the bots are paused; routines don't run until the user resumes them");
    const host = this.#o.host;
    const session = mintSessionId("side-thread");
    const computer = run.computer ?? this.#o.computer;
    const eff = this.#effective(live);
    const startedAt = this.#o.clock.now();
    host.open({
      id: session, kind: "side-thread", bot: id, parent: live.mainSession, computer, title: run.name, routine: run.routine,
      model: eff.model, ...(eff.effort === undefined ? {} : { effort: eff.effort }),
    }, this.#o.drivers(this.#context(live, session, "side-thread", computer, run.level)));
    run.onSession?.(session);
    const ended = new Promise<TurnEnd>((resolve) => {
      const off = host.subscribe(session, (r) => {
        if (r.type === "turn_ended") {
          off();
          resolve(r.end);
        } else if (r.type === "status" && (r.status === "stopped" || r.status === "failed")) {
          off();
          resolve({ reason: r.status === "stopped" ? "stopped" : "failed", ...(r.failure === undefined ? {} : { failure: r.failure }) });
        }
      });
    });
    await host.deliver(session, { from: "routine", routine: run.routine, name: run.name, sideThread: session, text: run.text });
    const end = await ended;
    const summary = sideThreadResult(end);
    // Only a turn that ended on its own went well; a refusal, a failure (a timeout among them), a stop or a cut-off
    // didn't (lane G's routineFailed).
    const failed = end.reason !== "end_turn";
    const main = host.get(live.mainSession);
    if (main !== undefined && main.status !== "stopped" && main.status !== "failed") {
      // To the computer running the bot, wherever that is (the host forwards it, review S1).
      try {
        await host.deliver(live.mainSession, { from: "routine", routine: run.routine, name: run.name, sideThread: session, text: summary, failed });
      } catch (err) {
        this.#warn(`the side thread ${session}'s result didn't reach ${live.mainSession}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await host.stop(session, "the run ended");
    return {
      routine: run.routine, session, startedAt, endedAt: this.#o.clock.now(),
      outcome: failed ? "failed" : "done", summary,
    };
  }

  // -----------------------------------------------------------------------------------------------

  #must(id: string): Live {
    const live = this.#bots.get(id);
    if (!live) throw new ContractError("not_found", `no bot ${id}`);
    return live;
  }

  /** Runs the registry's sync, or `job`, after whatever is under way, one at a time. */
  #queueSync(job: () => Promise<void> | void = () => this.#syncNow()): Promise<void> {
    this.#sync = this.#sync.then(job).catch((err: unknown) => this.#warn(`updating bots failed: ${err instanceof Error ? err.message : String(err)}`));
    return this.#sync;
  }

  /** The computer running the bots' conversations; this one while none is known. */
  #runner(): string {
    return this.#o.gate.main.runner() ?? this.#o.computer;
  }

  /** The runner when it is another computer. */
  #remoteRunner(): string | undefined {
    if (this.#o.gate.main.runsHere()) return undefined;
    const runner = this.#o.gate.main.runner();
    return runner === undefined || runner === this.#o.computer ? undefined : runner;
  }

  /** The lease moved, lapsed or came back. */
  async #onRunnerChanged(): Promise<void> {
    const host = this.#o.host;
    // Whether this computer holds the lease and may act, whatever a hand-back under way holds back: a lease event
    // during a hand-back (a renewal) must not cut the running turn short.
    const runsNow = this.#o.gate.main.runsHere();
    const runner = this.#runner();
    const before = this.#lastRunner;
    if (runner !== before) for (const live of this.#bots.values()) if (host.get(live.mainSession)) host.update(live.mainSession, { computer: runner });
    if (runsNow && !this.#ranHere) {
      for (const live of this.#bots.values()) {
        // Took over: a turn the computer before never finished is recorded so, and nothing is run again.
        try {
          const marked = host.catchUp(live.mainSession);
          if (marked > 0) this.#warn(`took ${live.plugin.id} over from ${before ?? "another computer"}: ${marked} call(s) it never finished are recorded as maybe having run there`);
        } catch (err) {
          this.#warn(`catching ${live.mainSession} up failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        this.#seed(live.plugin);
      }
      host.resume();
    } else if (!runsNow && this.#ranHere) {
      // This computer may no longer act for the bots: what runs stops.
      for (const live of this.#bots.values()) {
        const view = host.get(live.mainSession);
        if (view && (view.status === "prompting" || view.status === "cancelling")) {
          try {
            await host.interrupt(live.mainSession);
          } catch (err) {
            this.#warn(`stopping ${live.mainSession} after the lease went: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    }
    this.#ranHere = runsNow;
    this.#lastRunner = runner;
    for (const live of this.#bots.values()) this.#emitBot(live);
  }

  /** Resolves once no bot's conversation runs a turn or a compaction. */
  #allIdle(): Promise<void> {
    const host = this.#o.host;
    const busy = () => [...this.#bots.values()].some((live) => {
      const status = host.get(live.mainSession)?.status;
      return status === "prompting" || status === "cancelling" || status === "starting" || host.isCompacting(live.mainSession);
    });
    if (!busy()) return Promise.resolve();
    return new Promise((resolve) => {
      const off = host.watch(() => {
        if (busy()) return;
        off();
        resolve();
      });
    });
  }

  async #syncNow(): Promise<void> {
    const found = new Map<string, PluginBot>();
    for (const { record, contribution } of botEntries(this.#o.registry)) {
      const load = loadPluginBot(record, contribution.value);
      if (!load.ok) {
        // A bot that broke its own files (§6.1 lets it edit them) keeps running on its last good version, so it can
        // still fix them; one that never loaded isn't loaded.
        const live = this.#bots.get(load.id);
        if (live) {
          this.#warn(`the bot ${load.id} keeps its last good version: ${load.reason}`);
          found.set(load.id, live.plugin);
        } else this.#warn(`the bot ${load.id} isn't loaded: ${load.reason}`);
        continue;
      }
      found.set(load.bot.id, load.bot);
    }
    for (const [id, live] of [...this.#bots]) if (!found.has(id)) await this.#remove(id, live);
    for (const [id, bot] of found) {
      const live = this.#bots.get(id);
      if (live) this.#update(live, bot);
      else await this.#add(bot);
    }
  }

  async #add(bot: PluginBot): Promise<void> {
    const live: Live = { plugin: bot, mainSession: mainSessionIdFor(bot.id) };
    this.#folders(bot);
    // Only the computer running the bot writes its memory (§6.5); the others get copies.
    if (this.#o.gate.main.runsHere()) this.#seed(bot);
    const host = this.#o.host;
    const eff = this.#effective(live);
    const runner = this.#runner();
    try {
      host.open({
        id: live.mainSession, kind: "bot", bot: bot.id, computer: runner, title: plainText(eff.name).slice(0, 200), model: eff.model,
        ...(eff.effort === undefined ? {} : { effort: eff.effort }),
      }, this.#o.drivers(this.#context(live, live.mainSession, "bot", runner)));
    } catch (err) {
      this.#warn(`the bot ${bot.id}'s conversation didn't open: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    this.#bots.set(bot.id, live);
    // A conversation that holds nothing yet but its opening: the greeting goes first, once (a log picked up again
    // after its meta was lost holds more, and gets none).
    if (host.length(live.mainSession) <= 1 && bot.greeting !== undefined) {
      host.recordCore(live.mainSession, { type: "assistant_message", threadId: live.mainSession, text: bot.greeting, greeting: true });
    }
    await this.#endCutOffRuns(bot.id, live.mainSession);
    this.#emitBot(live);
  }

  /** Side threads a crash cut off: restored dormant with their run interrupted, and nothing left to finish them. Each
   *  posts that it was interrupted, as a run cut off by a shutdown does, and ends. Whether it runs again is the routine
   *  engine's missed-run rule (M3). */
  async #endCutOffRuns(botId: string, mainSession: string): Promise<void> {
    const host = this.#o.host;
    for (const s of host.list({ bot: botId, kind: "side-thread" })) {
      if (host.isAttached(s.id) || s.status === "stopped" || s.status === "failed") continue;
      try {
        const main = host.get(mainSession);
        if (s.routine !== undefined && main !== undefined && main.status !== "stopped" && main.status !== "failed") {
          await host.deliver(mainSession, { from: "routine", routine: s.routine, name: s.title ?? s.routine, sideThread: s.id, text: sideThreadResult({ reason: "interrupted" }), failed: true });
        }
        await host.stop(s.id, "the daemon restarted");
      } catch (err) {
        this.#warn(`the side thread ${s.id} wasn't ended: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  #update(live: Live, bot: PluginBot): void {
    live.plugin = bot;
    this.#syncMainSession(live);
    this.#emitBot(live);
  }

  async #remove(id: string, live: Live): Promise<void> {
    this.#bots.delete(id);
    const host = this.#o.host;
    await host.release(live.mainSession);
    for (const s of host.list({ bot: id, kind: "side-thread" })) {
      if (s.status !== "stopped" && s.status !== "failed") await host.stop(s.id, "its bot was removed");
    }
    this.#events.emit({ type: "bot_removed", ts: this.#o.clock.now(), id });
  }

  /** The bot's memory, agents' and scratch folders (§6.5), which the system prompt names. */
  #folders(bot: PluginBot): void {
    const paths = botPaths(this.#o.home, bot.id);
    for (const dir of [paths.memory, paths.agents, paths.scratch]) {
      try {
        mkdirSync(dir, { recursive: true });
      } catch (err) {
        this.#warn(`the bot ${bot.id}'s folder ${dir} wasn't made: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Copies the plugin's starter memories into the bot's memory folder, the first time this computer sees the bot. */
  #seed(bot: PluginBot): void {
    const file = botStateFile(this.#o.home, bot.id);
    const state = (readJson(file) as Partial<BotState> | undefined) ?? {};
    if (state.seededMemory === true) return;
    if (bot.memorySeed !== undefined) {
      try {
        seedMemory(bot.memorySeed, botPaths(this.#o.home, bot.id).memory, { base: this.#o.home, warn: this.#warn });
      } catch (err) {
        this.#warn(`the bot ${bot.id}'s starter memories weren't copied: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }
    writeJsonAtomic(file, { bot: bot.id, firstSeen: state.firstSeen ?? this.#o.clock.now(), seededMemory: true } satisfies BotState);
  }

  #effective(live: Live): EffectiveBot {
    const { entry } = live.plugin;
    const layer = this.#layers.get(live.plugin.id);
    const hasKey = this.#o.hasKeyFor ?? (() => true);
    let model: string;
    let effort: string | undefined;
    if (layer.model !== undefined) {
      model = layer.model;
      effort = layer.effort;
    } else if (entry.model !== undefined && hasKey(entry.model.default)) {
      model = entry.model.default;
      effort = layer.effort ?? entry.model.effort;
    } else {
      const fallback = this.#o.defaultModel();
      model = fallback.model;
      effort = layer.effort ?? fallback.effort;
    }
    const voice = layer.voice ?? (entry.voice === undefined ? undefined : { provider: entry.voice.provider, voice: entry.voice.voice, ...(entry.voice.model === undefined ? {} : { model: entry.voice.model }) });
    const avatar = layer.avatar ?? entry.avatar;
    const theme = layer.theme ?? entry.theme;
    const layout = layer.layout ?? entry.layout;
    return {
      id: live.plugin.id,
      name: layer.name ?? entry.name,
      instructions: layer.instructions ?? live.plugin.instructions,
      model,
      ...(effort === undefined ? {} : { effort }),
      ...(voice === undefined ? {} : { voice }),
      ...(avatar === undefined ? {} : { avatar: structuredClone(avatar) }),
      ...(theme === undefined ? {} : { theme }),
      ...(layout === undefined ? {} : { layout }),
      ...(live.plugin.greeting === undefined ? {} : { greeting: live.plugin.greeting }),
      ...(layer.lan === true ? { lan: true } : {}),
      userLayer: userLayerFields(layer),
    };
  }

  #context(live: Live, sessionId: string, kind: "bot" | "side-thread", computer: string, level?: Level): BotSessionContext {
    const paths = botPaths(this.#o.home, live.plugin.id);
    const gate = this.#o.gate;
    return {
      ...(level === undefined ? {} : { level }),
      botId: live.plugin.id,
      sessionId,
      kind,
      computer,
      paths,
      caller: { kind: "session", sessionId, sessionKind: kind, bot: live.plugin.id },
      current: () => this.#effective(live),
      memoryBlock: () => memoryBlock({ paths, computer: kind === "bot" ? this.#runner() : computer }),
      mayAct: () => gate.mayAct({ kind }),
      whenMayAct: (signal) => gate.whenMayAct({ kind }, signal),
      mayStart: () => gate.mayStart({ kind }),
      whenMayStart: (signal) => gate.whenMayStart({ kind }, signal),
      cacheCold: () => this.#o.cacheCold?.(sessionId) ?? true,
      wake: (input) => this.#wake(sessionId, input),
    };
  }

  /** A runtime's background-task wake (`BotSessionContext.wake`): an end goes straight to the host; an `event` merges
   *  into one pending wake while the session is busy (a turn runs or one waits). */
  async #wake(id: string, input: WakeInput): Promise<{ disposition: Disposition; seq: number }> {
    const host = this.#o.host;
    const busy = host.turnOrigin(id) !== undefined || host.waiting(id) > 0;
    if (input.status !== "event" || !busy) return host.deliver(id, { from: "task", ...input });
    let w = this.#wakes.get(id);
    if (w === undefined) {
      const fresh: PendingWakes = { tasks: new Map(), off: () => {} };
      // As the running (or next) turn ends, each task's merged wake goes in: the first starts a turn and the rest
      // fold into it (a driver that can't fold queues them), so at most one more turn per task, usually one in all.
      fresh.off = host.subscribe(id, (r) => {
        if (r.type !== "turn_ended" && !(r.type === "status" && (r.status === "stopped" || r.status === "failed"))) return;
        const p = this.#wakes.get(id);
        if (p === undefined) return;
        this.#wakes.delete(id);
        p.off();
        if (r.type === "status") return;
        // After the host has finished ending the turn (the record comes first), so it starts a turn, not a fold.
        queueMicrotask(() => {
          void (async () => {
            for (const [task, e] of p.tasks) {
              const text = e.count > 1 ? `${e.text}\n\n(${e.count} events from this task came while you were busy; the latest is shown.)` : e.text;
              await host.deliver(id, { from: "task", task, status: "event", text }).catch((err: unknown) => {
                this.#warn(`${id}'s merged events of ${task} weren't delivered: ${err instanceof Error ? err.message : String(err)}`);
              });
            }
          })();
        });
      });
      w = fresh;
      this.#wakes.set(id, w);
    }
    // One pending wake per task: its latest text and how many came.
    const e = w.tasks.get(input.task);
    w.tasks.set(input.task, { text: input.text, count: (e?.count ?? 0) + 1 });
    return { disposition: "queued", seq: host.length(id) };
  }

  /** The main session's view follows the bot's name, model and effort. */
  #syncMainSession(live: Live): void {
    const eff = this.#effective(live);
    if (this.#o.host.get(live.mainSession) === undefined) return;
    this.#o.host.update(live.mainSession, { title: plainText(eff.name).slice(0, 200), model: eff.model, effort: eff.effort ?? null });
  }

  #state(live: Live): BotView["state"] {
    const host = this.#o.host;
    if (this.#o.gate.paused) return "paused";
    if (host.isAsleep(live.mainSession)) return "asleep";
    const status = host.get(live.mainSession)?.status;
    return status === "prompting" || status === "cancelling" || status === "starting" ? "thinking" : "idle";
  }

  #view(live: Live): BotView {
    const eff = this.#effective(live);
    const portraitPath = eff.userLayer.includes("avatar") ? undefined : live.plugin.entry.avatar?.portrait;
    const portrait = eff.userLayer.includes("avatar")
      ? eff.avatar?.portrait
      : portraitPath === undefined ? undefined : this.#o.assetUrl?.(live.plugin.id, portraitPath);
    return {
      id: live.plugin.id,
      name: eff.name,
      ...(portrait === undefined ? {} : { portrait }),
      model: eff.model,
      ...(eff.effort === undefined ? {} : { effort: eff.effort }),
      ...(eff.voice === undefined ? {} : { voice: eff.voice }),
      ...(eff.theme === undefined ? {} : { theme: eff.theme }),
      ...(eff.lan === true ? { lan: true } : {}),
      userLayer: eff.userLayer,
      state: this.#state(live),
      computer: this.#runner(),
      mainSession: live.mainSession,
    };
  }

  #emitBot(live: Live): void {
    if (!this.#bots.has(live.plugin.id)) return;
    const view = this.#view(live);
    const json = JSON.stringify(view);
    if (json === live.lastView) return;
    live.lastView = json;
    this.#events.emit({ type: "bot_changed", ts: this.#o.clock.now(), bot: view });
  }

  #onSession(view: SessionView): void {
    this.#events.emit({ type: "session_changed", ts: this.#o.clock.now(), session: view });
    if (view.kind !== "bot" || view.bot === undefined) return;
    const live = this.#bots.get(view.bot);
    if (live && live.mainSession === view.id) this.#emitBot(live);
  }
}

/** A side thread's short result: its final text, or what stopped it. */
export function sideThreadResult(end: TurnEnd): string {
  const text = end.text?.trim() ?? "";
  const capped = (s: string) => (s.length <= SIDE_THREAD_RESULT_MAX_CHARS ? s : `${s.slice(0, SIDE_THREAD_RESULT_MAX_CHARS - 1)}…`);
  switch (end.reason) {
    case "end_turn":
    case "refusal":
      return capped(text === "" ? "The run ended without a result." : text);
    case "failed":
      return capped(`The run failed (${end.failure ?? "error"})${text === "" ? "." : `: ${text}`}`);
    default:
      return `The run was ${end.reason}.`;
  }
}

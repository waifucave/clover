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
// * **State** (`BotView.state`): `thinking` while the main conversation runs a turn, `asleep` with no connection to
//   the computer running it (§6.4), otherwise `idle`. The pause switch (`paused`) is M2's.
//
// The driver of each session comes from `DriverFactory`: lane A's embedded runtime once A-M1 merges; tests use the
// contracts' FakeSessionDriver.
import {
  CLOVER_ERR, type BotView, type Caller, type ChangeResult, type RoutineRunView, type SessionView, type Text,
} from "@waifucave/clover-protocol";
import type { Clock } from "../contracts/clock";
import { ContractError, Listeners, type Unsubscribe } from "../contracts/common";
import type { PluginRegistry } from "../contracts/plugin-registry";
import type { SessionDriver, TurnEnd } from "../contracts/session-host";
import type { DurableSessionHost } from "../sessions/durable-host";
import { mainSessionIdFor, mintSessionId } from "../sessions/ids";
import { readJson, writeJsonAtomic } from "../sessions/atomic-file";
import { seedMemory } from "./memory";
import { botPaths, botStateFile, type BotPaths } from "./paths";
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
  /** The bot now: a driver reads the model and effort at each turn and the instructions at each compaction. */
  current(): EffectiveBot;
}

export type DriverFactory = (ctx: BotSessionContext) => SessionDriver;

export type BotServiceEvent =
  | { type: "bot_changed"; ts: number; bot: BotView }
  | { type: "bot_removed"; ts: number; id: string }
  | { type: "session_changed"; ts: number; session: SessionView };

export interface BotServiceOptions {
  home: string;
  /** This computer's name in the folder tree (§9.1): the computer running its bots' conversations until H-M2's main
   *  computer exists. */
  computer: string;
  registry: PluginRegistry;
  host: DurableSessionHost;
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
}

/** The longest result a side thread posts into the main conversation (`RoutineRunView.summary`'s cap). */
export const SIDE_THREAD_RESULT_MAX_CHARS = 4_000;

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
  readonly #events = new Listeners<BotServiceEvent>();
  readonly #warn: (message: string) => void;
  #offs: Unsubscribe[] = [];
  #sync: Promise<void> = Promise.resolve();
  #started = false;

  constructor(opts: BotServiceOptions) {
    this.#o = opts;
    this.#layers = new UserLayerStore(opts.home);
    this.#warn = opts.warn ?? (() => {});
  }

  /** Loads every bot, opens (or reattaches) each one's conversation, and follows the registry from then on. */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    this.#offs.push(this.#o.host.watch((view) => this.#onSession(view)));
    this.#offs.push(this.#o.registry.watch(() => void this.#queueSync()));
    await this.#queueSync();
    // Runs a crash cut off whose bot is no longer installed: ended too, with the result posted for when it returns.
    const host = this.#o.host;
    const orphans = new Set(host.list({ kind: "side-thread" }).filter((s) => s.bot !== undefined && !this.#bots.has(s.bot)).map((s) => s.bot!));
    for (const bot of orphans) await this.#endCutOffRuns(bot, mainSessionIdFor(bot));
  }

  /** Detaches every bot's sessions, leaving them dormant on disk (a shutdown). */
  async stop(): Promise<void> {
    for (const off of this.#offs.splice(0)) off();
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

  userLayer(id: string): UserLayer {
    this.#must(id);
    return this.#layers.get(id);
  }

  /** Runs a routine in a side thread of its bot (§6.4, §7) and posts its short result into the bot's conversation.
   *  Resolves when the run has ended and its result is posted. */
  async runSideThread(id: string, run: SideThreadRun): Promise<RoutineRunView> {
    const live = this.#must(id);
    const host = this.#o.host;
    const session = mintSessionId("side-thread");
    const computer = run.computer ?? this.#o.computer;
    const eff = this.#effective(live);
    const startedAt = this.#o.clock.now();
    host.open({
      id: session, kind: "side-thread", bot: id, parent: live.mainSession, computer, title: run.name, routine: run.routine,
      model: eff.model, ...(eff.effort === undefined ? {} : { effort: eff.effort }),
    }, this.#o.drivers(this.#context(live, session, "side-thread", computer)));
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
    const main = host.get(live.mainSession);
    if (main !== undefined && main.status !== "stopped" && main.status !== "failed") {
      await host.deliver(live.mainSession, { from: "routine", routine: run.routine, name: run.name, sideThread: session, text: summary });
    }
    await host.stop(session, "the run ended");
    return {
      routine: run.routine, session, startedAt, endedAt: this.#o.clock.now(),
      outcome: end.reason === "end_turn" || end.reason === "refusal" ? "done" : "failed", summary,
    };
  }

  // -----------------------------------------------------------------------------------------------

  #must(id: string): Live {
    const live = this.#bots.get(id);
    if (!live) throw new ContractError("not_found", `no bot ${id}`);
    return live;
  }

  #queueSync(): Promise<void> {
    this.#sync = this.#sync.then(() => this.#syncNow()).catch((err: unknown) => this.#warn(`loading bots failed: ${err instanceof Error ? err.message : String(err)}`));
    return this.#sync;
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
    this.#seed(bot);
    const host = this.#o.host;
    const eff = this.#effective(live);
    try {
      host.open({
        id: live.mainSession, kind: "bot", bot: bot.id, computer: this.#o.computer, title: plainText(eff.name).slice(0, 200), model: eff.model,
        ...(eff.effort === undefined ? {} : { effort: eff.effort }),
      }, this.#o.drivers(this.#context(live, live.mainSession, "bot", this.#o.computer)));
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
          await host.deliver(mainSession, { from: "routine", routine: s.routine, name: s.title ?? s.routine, sideThread: s.id, text: sideThreadResult({ reason: "interrupted" }) });
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
      userLayer: userLayerFields(layer),
    };
  }

  #context(live: Live, sessionId: string, kind: "bot" | "side-thread", computer: string): BotSessionContext {
    return {
      botId: live.plugin.id,
      sessionId,
      kind,
      computer,
      paths: botPaths(this.#o.home, live.plugin.id),
      current: () => this.#effective(live),
    };
  }

  /** The main session's view follows the bot's name, model and effort. */
  #syncMainSession(live: Live): void {
    const eff = this.#effective(live);
    if (this.#o.host.get(live.mainSession) === undefined) return;
    this.#o.host.update(live.mainSession, { title: plainText(eff.name).slice(0, 200), model: eff.model, effort: eff.effort ?? null });
  }

  #state(live: Live): BotView["state"] {
    const host = this.#o.host;
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
      userLayer: eff.userLayer,
      state: this.#state(live),
      computer: this.#o.computer,
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

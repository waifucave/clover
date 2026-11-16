// A bot plugin's figure (`avatar.cue`, `avatar.catalogue`, `avatar.box`, `avatar.watch`) and the stage's side of it
// (`avatar.report`). The renderer lives in the app; the core is where the two meet, so the one rule set is here:
//
// * the stage (the plugin that holds `avatar.report`, the bundled character part or another; components only) tells the core which
//   renderer drew a bot's figure, what its model has and where the figure stands. What it says is read through the SDK's
//   `clean*` functions and capped; `undefined` says nothing is drawn.
// * a bot plugin acts only for its own bot: the bot whose id is the plugin's top-level id (§6.1). A cue is judged here
//   against what the renderer said it does and the names its model has, and answered plainly when it can't be played
//   (`no-renderer`, `unsupported`, `unknown-name`), never dropped; one that can goes on to the stage as `plugin_ui_message`
//   (event `moss.avatar.cue`, for the stage's own layer only), which hands it to the renderer. A plugin that holds
//   `avatar.control.all` may name another bot (`opts.bot`), the one rule; speech is a cue of its own kind (`{ type:
//   "speech" }`: mouth levels stamped in epoch milliseconds, sent in batches ahead of the clock), which the stage keeps
//   by time and hands the renderer as the speech feed.
// * a bot plugin's frames hear the catalogue and the box change as `plugin_ui_message` (`moss.avatar.changed`, for the
//   plugin's own layer only); its host half through `avatar.watch`.
import { SPEECH_AHEAD_MAX_MS, SPEECH_CUES_PER_SECOND, SPEECH_FRAMES_PER_SECOND, boxOrDefault, cleanAvatarCue, cleanAvatarReport, cleanSpeechCue, judgeCue, judgeSpeech, type AvatarApi, type AvatarCatalogue, type AvatarChange, type AvatarCueResult, type AvatarReport } from "@waifucave/moss-plugin-sdk";
import { topPluginIdOf } from "@waifucave/moss-protocol";
import { ContractError, Listeners, type Unsubscribe } from "../../contracts/common";
import { listenerArg, type ApiHandlers } from "./router";

/** The message names the app's layers hear (`host.on`). */
export const AVATAR_CUE_EVENT = "moss.avatar.cue";
export const AVATAR_CHANGED_EVENT = "moss.avatar.changed";
/** Cues a plugin may send a second. */
export const AVATAR_CUES_PER_SECOND = 20;
/** The capability that lets a plugin cue a bot that is not its own (`avatar.cue`'s `opts.bot`). */
export const AVATAR_ALL = "avatar.control.all";
/** Watches a plugin's host half may hold. */
const WATCHES_MAX = 8;

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export class AvatarService {
  /** What each stage last said about each bot's figure: per bot, a map by stage plugin, kept in the order the stages last
   *  spoke. The live one is the stage that spoke last and still holds its report: it is what the core answers for the
   *  bot and where its cues go. A stage that says nothing, stops, goes off or is removed loses its report (`endStage`),
   *  so no stale word from a stage that left is ever the answer, and two stages never overwrite each other. */
  readonly #reports = new Map<string, Map<string, AvatarReport>>();
  readonly #changes = new Listeners<{ bot: string; change: AvatarChange }>();
  readonly #windows = new Map<string, { start: number; n: number }>();
  /** The speech cues' own window per plugin: cues and the mouth levels in them, in the second that began at `start`. */
  readonly #speechWindows = new Map<string, { start: number; cues: number; frames: number }>();
  readonly #watching = new Map<string, number>();

  constructor(
    private readonly emit: (event: { type: string; [key: string]: unknown }) => void,
    private readonly now: () => number = Date.now,
    /** Who may draw: `fills(plugin)` says whether the plugin has an active entry filling `bot.stage` now, `botExists(bot)`
     *  whether the bot is installed. Without it every reporter may (a test's). */
    private readonly gate?: { fills(pluginId: string): boolean; botExists(bot: string): boolean },
  ) {}

  /** The stage that is drawing `bot` now, and what it said. */
  #live(bot: string): { report: AvatarReport; stage: string } | undefined {
    const held = this.#reports.get(bot);
    if (held === undefined) return undefined;
    let live: { report: AvatarReport; stage: string } | undefined;
    // Only a plugin that fills `bot.stage` now can be the one drawing; others' reports are kept, not live.
    for (const [stage, report] of held) if (this.gate === undefined || this.gate.fills(stage)) live = { report, stage };
    return live;
  }

  /** The figure of `bot` as its plugin reads it. */
  catalogue(bot: string): AvatarCatalogue | undefined {
    const r = this.#live(bot)?.report;
    if (r === undefined) return undefined;
    return { format: r.format, renderer: r.renderer, capabilities: r.capabilities, expressions: r.names?.expressions ?? [], motions: r.names?.motions ?? [], outfits: r.names?.outfits ?? [] };
  }

  box(bot: string) {
    return boxOrDefault(this.#live(bot)?.report.box);
  }

  /** The stage's word about a bot's figure (`undefined`: this stage draws nothing for it now). */
  report(stage: string, bot: string, raw: unknown): void {
    const report = raw === undefined || raw === null ? undefined : cleanAvatarReport(raw);
    if (raw !== undefined && raw !== null && report === undefined) throw new ContractError("invalid", "avatar.report takes a renderer's report or nothing");
    this.#change(bot, () => {
      const held = this.#reports.get(bot) ?? new Map<string, AvatarReport>();
      held.delete(stage);
      if (report !== undefined) held.set(stage, report);
      if (held.size === 0) this.#reports.delete(bot);
      else this.#reports.set(bot, held);
    });
  }

  /** A stage's plugin stopped, went off, or was removed (or its document went): every report it held is dropped, and
   *  each bot it was drawing goes to the stage that still draws it, or to nothing. */
  endStage(stage: string): void {
    for (const bot of [...this.#reports.keys()]) {
      if (this.#reports.get(bot)?.has(stage) !== true) continue;
      this.#change(bot, () => {
        const held = this.#reports.get(bot)!;
        held.delete(stage);
        if (held.size === 0) this.#reports.delete(bot);
      });
    }
  }

  /** Runs `edit` and tells the bot's plugin what changed in the figure it now reads. */
  #change(bot: string, edit: () => void): void {
    const oldCatalogue = this.catalogue(bot);
    const oldBox = this.box(bot);
    edit();
    const catalogue = this.catalogue(bot);
    const box = this.box(bot);
    if (!sameJson(oldCatalogue, catalogue)) this.#tell(bot, { kind: "catalogue", catalogue });
    if (!sameJson(oldBox, box)) this.#tell(bot, { kind: "box", box });
  }

  #tell(bot: string, change: AvatarChange): void {
    this.#changes.emit({ bot, change });
    this.emit({ type: "plugin_ui_message", pluginId: bot, event: AVATAR_CHANGED_EVENT, value: change });
  }

  /** Judges a cue for `bot` (default: `pluginId`'s own) and sends it on to the stage when it can be played. The rule: a
   *  plugin cues its own bot with `avatar.control` (the router's gate), and any other bot only when `all` (it holds
   *  `avatar.control.all`); otherwise it is refused, saying why. Speech (`{ type: "speech" }`) is a cue like the rest, with
   *  a window of its own. */
  cue(pluginId: string, raw: unknown, bot: string = topPluginIdOf(pluginId), all = false): AvatarCueResult {
    if (bot !== topPluginIdOf(pluginId) && !all) throw new ContractError("refused", `${pluginId} may move only its own bot's figure (${topPluginIdOf(pluginId)}); moving another bot's needs the capability ${AVATAR_ALL}`);
    const t = this.now();
    if ((raw as { type?: unknown } | null)?.type === "speech") return this.#speech(pluginId, bot, raw, t);
    const cue = cleanAvatarCue(raw);
    if (cue === undefined) return { ok: false, reason: "invalid", message: "a cue is an expression, a motion, an outfit part with on or off, the pace, a point to look at, or speech's mouth levels" };
    const w = this.#windows.get(pluginId);
    if (w === undefined || t - w.start >= 1000) this.#windows.set(pluginId, { start: t, n: 1 });
    else if (++w.n > AVATAR_CUES_PER_SECOND) throw new ContractError("refused", `${pluginId} sent more than ${AVATAR_CUES_PER_SECOND} cues this second`);
    const held = this.#live(bot);
    const no = judgeCue(held?.report, cue);
    if (no !== undefined || held === undefined) return no ?? { ok: false, reason: "no-renderer", message: "nothing is drawing this bot's figure right now" };
    this.emit({ type: "plugin_ui_message", pluginId: held.stage, event: AVATAR_CUE_EVENT, value: { bot, cue } });
    return { ok: true };
  }

  #speech(pluginId: string, bot: string, raw: unknown, t: number): AvatarCueResult {
    const clean = cleanSpeechCue(raw);
    if ("why" in clean) return { ok: false, reason: "invalid", message: clean.why };
    const cue = clean.cue;
    const last = cue.frames.at(-1);
    if (last !== undefined && last.t - t > SPEECH_AHEAD_MAX_MS) return { ok: false, reason: "invalid", message: `a level is stamped more than ${SPEECH_AHEAD_MAX_MS / 1000} s ahead of the clock; send speech in batches as it comes due` };
    const w = this.#speechWindows.get(pluginId);
    if (w === undefined || t - w.start >= 1000) this.#speechWindows.set(pluginId, { start: t, cues: 1, frames: cue.frames.length });
    else {
      w.cues += 1;
      w.frames += cue.frames.length;
      if (w.cues > SPEECH_CUES_PER_SECOND || w.frames > SPEECH_FRAMES_PER_SECOND) throw new ContractError("refused", `${pluginId} sent more than ${SPEECH_CUES_PER_SECOND} speech cues or ${SPEECH_FRAMES_PER_SECOND} mouth levels this second`);
    }
    const held = this.#live(bot);
    const no = judgeSpeech(held?.report);
    if (no !== undefined || held === undefined) return no ?? { ok: false, reason: "no-renderer", message: "nothing is drawing this bot's figure right now" };
    // `from`: the sending plugin, so the stage's `cut` drops only that sender's own levels.
    this.emit({ type: "plugin_ui_message", pluginId: held.stage, event: AVATAR_CUE_EVENT, value: { bot, cue, from: pluginId } });
    return { ok: true };
  }

  handlers(): ApiHandlers {
    const own = (pluginId: string) => topPluginIdOf(pluginId);
    return {
      "avatar.cue": (ctx, args) => {
        const opts = args[1];
        if (opts !== undefined && opts !== null && (typeof opts !== "object" || Array.isArray(opts))) throw new ContractError("invalid", "avatar.cue's second argument is { bot? }");
        const bot = (opts as { bot?: unknown } | null | undefined)?.bot;
        if (bot !== undefined && (typeof bot !== "string" || bot === "" || bot.length > 128)) throw new ContractError("invalid", "avatar.cue's bot is a bot's id");
        return this.cue(ctx.pluginId, args[0], bot, ctx.record.granted.includes(AVATAR_ALL));
      },
      "avatar.catalogue": (ctx) => this.catalogue(own(ctx.pluginId)),
      "avatar.box": (ctx) => this.box(own(ctx.pluginId)),
      "avatar.watch": (ctx, args): Unsubscribe => {
        const listener = listenerArg<AvatarChange>(args, 0);
        const bot = own(ctx.pluginId);
        const n = this.#watching.get(ctx.pluginId) ?? 0;
        if (n >= WATCHES_MAX) throw new ContractError("refused", `${ctx.pluginId} has ${WATCHES_MAX} watches open; close one first`);
        this.#watching.set(ctx.pluginId, n + 1);
        const off = this.#changes.add((c) => { if (c.bot === bot) listener(c.change); });
        let done = false;
        return () => {
          if (done) return;
          done = true;
          off();
          const left = (this.#watching.get(ctx.pluginId) ?? 1) - 1;
          if (left <= 0) this.#watching.delete(ctx.pluginId);
          else this.#watching.set(ctx.pluginId, left);
        };
      },
      "avatar.report": (ctx, args) => {
        const bot = args[0];
        if (typeof bot !== "string" || bot === "" || bot.length > 128) throw new ContractError("invalid", "avatar.report takes the bot's id first");
        if (this.gate !== undefined && args[1] !== undefined && args[1] !== null) {
          if (!this.gate.fills(ctx.pluginId)) throw new ContractError("refused", `${ctx.pluginId} has no active entry filling bot.stage, so it is not drawing any bot's figure`);
          if (!this.gate.botExists(bot)) throw new ContractError("refused", `there is no bot ${bot}`);
        }
        this.report(ctx.pluginId, bot, args[1]);
      },
    };
  }
}

/** `AvatarApi`'s members, for a test to hold the handlers to the SDK's type. */
export type AvatarHandlerNames = keyof AvatarApi | "report";

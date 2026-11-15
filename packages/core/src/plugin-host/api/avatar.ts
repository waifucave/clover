// A bot plugin's figure (`avatar.cue`, `avatar.catalogue`, `avatar.box`, `avatar.watch`) and the stage's side of it
// (`avatar.report`). The renderer lives in the app; the core is where the two meet, so the one rule set is here:
//
// * the stage (the bundled `clover` tree's character part, components only: `avatar.report`) tells the core which
//   renderer drew a bot's figure, what its model has and where the figure stands. What it says is read through the SDK's
//   `clean*` functions and capped; `undefined` says nothing is drawn.
// * a bot plugin acts only for its own bot: the bot whose id is the plugin's top-level id (§6.1). A cue is judged here
//   against what the renderer said it does and the names its model has, and answered plainly when it can't be played
//   (`no-renderer`, `unsupported`, `unknown-name`), never dropped; one that can goes on to the stage as `plugin_ui_message`
//   (event `clover.avatar.cue`, for the stage's own layer only), which hands it to the renderer.
// * a bot plugin's frames hear the catalogue and the box change as `plugin_ui_message` (`clover.avatar.changed`, for the
//   plugin's own layer only); its host half through `avatar.watch`.
import { boxOrDefault, cleanAvatarCue, cleanAvatarReport, judgeCue, type AvatarApi, type AvatarCatalogue, type AvatarChange, type AvatarCueResult, type AvatarReport } from "@waifucave/clover-plugin-sdk";
import { topPluginIdOf } from "@waifucave/clover-protocol";
import { ContractError, Listeners, type Unsubscribe } from "../../contracts/common";
import { listenerArg, type ApiHandlers } from "./router";

/** The message names the app's layers hear (`host.on`). */
export const AVATAR_CUE_EVENT = "clover.avatar.cue";
export const AVATAR_CHANGED_EVENT = "clover.avatar.changed";
/** Cues a plugin may send a second. */
export const AVATAR_CUES_PER_SECOND = 20;
/** Watches a plugin's host half may hold. */
const WATCHES_MAX = 8;

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export class AvatarService {
  /** What the stage last said about each bot's figure, and which plugin said it (the cue goes back to that one). */
  readonly #reports = new Map<string, { report: AvatarReport; stage: string }>();
  readonly #changes = new Listeners<{ bot: string; change: AvatarChange }>();
  readonly #windows = new Map<string, { start: number; n: number }>();
  readonly #watching = new Map<string, number>();

  constructor(private readonly emit: (event: { type: string; [key: string]: unknown }) => void, private readonly now: () => number = Date.now) {}

  /** The figure of `bot` as its plugin reads it. */
  catalogue(bot: string): AvatarCatalogue | undefined {
    const r = this.#reports.get(bot)?.report;
    if (r === undefined) return undefined;
    return { format: r.format, renderer: r.renderer, capabilities: r.capabilities, expressions: r.names?.expressions ?? [], motions: r.names?.motions ?? [], outfits: r.names?.outfits ?? [] };
  }

  box(bot: string) {
    return boxOrDefault(this.#reports.get(bot)?.report.box);
  }

  /** The stage's word about a bot's figure (`undefined`: nothing drawn now). */
  report(stage: string, bot: string, raw: unknown): void {
    const report = raw === undefined || raw === null ? undefined : cleanAvatarReport(raw);
    if (raw !== undefined && raw !== null && report === undefined) throw new ContractError("invalid", "avatar.report takes a renderer's report or nothing");
    const oldCatalogue = this.catalogue(bot);
    const oldBox = this.box(bot);
    if (report === undefined) this.#reports.delete(bot);
    else this.#reports.set(bot, { report, stage });
    const catalogue = this.catalogue(bot);
    const box = this.box(bot);
    if (!sameJson(oldCatalogue, catalogue)) this.#tell(bot, { kind: "catalogue", catalogue });
    if (!sameJson(oldBox, box)) this.#tell(bot, { kind: "box", box });
  }

  #tell(bot: string, change: AvatarChange): void {
    this.#changes.emit({ bot, change });
    this.emit({ type: "plugin_ui_message", pluginId: bot, event: AVATAR_CHANGED_EVENT, value: change });
  }

  /** Judges a cue for `pluginId`'s own bot and sends it on to the stage when it can be played. */
  cue(pluginId: string, raw: unknown): AvatarCueResult {
    const bot = topPluginIdOf(pluginId);
    const cue = cleanAvatarCue(raw);
    if (cue === undefined) return { ok: false, reason: "invalid", message: "a cue is an expression, a motion, an outfit part with on or off, the pace, or a point to look at" };
    const t = this.now();
    const w = this.#windows.get(pluginId);
    if (w === undefined || t - w.start >= 1000) this.#windows.set(pluginId, { start: t, n: 1 });
    else if (++w.n > AVATAR_CUES_PER_SECOND) throw new ContractError("refused", `${pluginId} sent more than ${AVATAR_CUES_PER_SECOND} cues this second`);
    const held = this.#reports.get(bot);
    const no = judgeCue(held?.report, cue);
    if (no !== undefined || held === undefined) return no ?? { ok: false, reason: "no-renderer", message: "nothing is drawing this bot's figure right now" };
    this.emit({ type: "plugin_ui_message", pluginId: held.stage, event: AVATAR_CUE_EVENT, value: { bot, cue } });
    return { ok: true };
  }

  handlers(): ApiHandlers {
    const own = (pluginId: string) => topPluginIdOf(pluginId);
    return {
      "avatar.cue": (ctx, args) => this.cue(ctx.pluginId, args[0]),
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
        this.report(ctx.pluginId, bot, args[1]);
      },
    };
  }
}

/** `AvatarApi`'s members, for a test to hold the handlers to the SDK's type. */
export type AvatarHandlerNames = keyof AvatarApi | "report";

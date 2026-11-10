// What the `composer` spot hands whichever entry the core mounted in it (spec §5.5): the user's send, the models the
// session can switch to, a model switch, and interrupt and stop. Any plugin's composer gets them, the bundled one or a
// third party's that the user picked: the core decides from the mount IT made (which entry sits in which spot, for which
// session) and from the key press or click it saw, never from anything the frame says.
//
//   models      a read.
//   setModel    on a bot's main conversation it changes a user layer, which only the `clover` layer does directly: the
//               bundled entry's goes on the app's own connection, any other plugin's goes on its own `layer` connection,
//               where the core turns it into the sealed card it raises for a user-layer change. On any other session it is
//               `session.setModel`, a session's own, with the gesture.
//   interrupt   `session.interrupt`, stop: `session.stop`: the spot and the gesture.
// Every acting call spends one key press or click the main process saw come to the window (the SendGate).

export const COMPOSER_OPS = ["models", "setModel", "interrupt", "stop"] as const;
export type ComposerOp = (typeof COMPOSER_OPS)[number];

/** The composer mount the core made: where it is, which session and bot it was handed, whose it is. */
export interface ComposerMount {
  windowId: number;
  pluginId: string;
  /** The session the composer was mounted for (from the props the declaring document gave the core). */
  session: string;
  bot?: string;
  /** The entry is a part of the bundled `clover` tree, in the `clover` layer. */
  tree: boolean;
}

export interface ComposerRoute {
  composer: ComposerMount | undefined;
  op: unknown;
  args: unknown;
  takeGesture(windowId: number): boolean;
  /** On the app's own connection (the `clover` layer's right). */
  asApp(method: string, params: unknown): Promise<unknown>;
  /** On the entry's own plugin connection: the `layer` role's door. */
  asLayer(pluginId: string, method: string, params: unknown): Promise<unknown>;
  log(line: string): void;
  refuse(why: string): Error;
}

const short = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined);

/** Whether `session` is the main conversation of the bot the composer was mounted for: the daemon's own record (`bot.list`'s
 *  `mainSession`), never the id's shape. */
async function isBotMain(r: ComposerRoute, session: string, bot: string | undefined): Promise<boolean> {
  if (bot === undefined) return false;
  const list = (await r.asApp("bot.list", {})) as { bots?: { id?: unknown; mainSession?: unknown }[] } | undefined;
  return list?.bots?.some((b) => b.id === bot && b.mainSession === session) === true;
}

export async function routeComposer(r: ComposerRoute): Promise<unknown> {
  const out = await routeComposerOp(r);
  // One line for each acting call that went through (a model switch's result says whether a card was raised).
  if (r.composer !== undefined && r.op !== "models") r.log(`composer: ${r.composer.pluginId}: ${String(r.op)} for ${r.composer.session}: ${JSON.stringify(out ?? null).slice(0, 160)}`);
  return out;
}

async function routeComposerOp(r: ComposerRoute): Promise<unknown> {
  const c = r.composer;
  if (c === undefined) {
    r.log(`composer: ${String(r.op)} refused (not the entry the core mounted in the composer spot, for a session)`);
    throw r.refuse("this isn't the entry the core mounted in the composer spot");
  }
  const op = COMPOSER_OPS.find((o) => o === r.op);
  if (op === undefined) throw r.refuse("not something the composer spot offers");
  const refuse = (why: string): never => {
    r.log(`composer: ${c.pluginId}: ${op} refused (${why})`);
    throw r.refuse(why);
  };
  if (op === "models") return r.asApp("models.list", { session: c.session });
  if (!r.takeGesture(c.windowId)) return refuse(`${op} goes only right after the user's own key press or click`);
  if (op === "interrupt") return r.asApp("session.interrupt", { id: c.session });
  if (op === "stop") return r.asApp("session.stop", { id: c.session });
  const a = (r.args ?? {}) as { model?: unknown; effort?: unknown };
  const model = short(a.model, 200);
  const effort = a.effort === undefined ? undefined : short(a.effort, 32);
  if (model === undefined || (a.effort !== undefined && effort === undefined)) return refuse("not a model");
  if (await isBotMain(r, c.session, c.bot)) {
    const params = { id: c.bot, patch: { model, ...(effort !== undefined ? { effort } : {}) } };
    return c.tree ? r.asApp("bot.setUserLayer", params) : r.asLayer(c.pluginId, "bot.setUserLayer", params);
  }
  return r.asApp("session.setModel", { id: c.session, model, ...(effort !== undefined ? { effort } : {}) });
}

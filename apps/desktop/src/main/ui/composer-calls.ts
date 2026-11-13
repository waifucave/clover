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
//   commands    a read for the slash menu: `command.list` joined with `plugin.list`, only the commands of plugins that
//               are on, OK'd and running, each with its plugin's name and scope, the bot's own plugin's first.
//   runCommand  `command.run` on the app's own connection: the user asking that plugin, so its handler is told the user
//               called and acts with exactly the plugin's own powers (a carded action still raises its card). Only a
//               command `commands` lists now, with the gesture; the args go to that command's plugin alone.
//   listenStatus  a read: `voice.status` for the composer's bot, whether its voice listens now (the hold-to-talk control shows only then).
//   listenStart   the user's press: the app's shell records (listen.ts). The bot is the one the core mounted the composer for, never
//                 the page's word; one press covers one recording (the gesture), and the recording ends when the user lets go.
//   listenStop    the release: the shell stops, and the answer is what was heard as text for the box, or a note saying why not.
//   `commands`, `runCommand` and the three listen ops are the bundled entry's only: the user's own door to every plugin's commands is the
//   app's, and a third party's composer the user picked doesn't get it (it would run any plugin's command as the user
//   on any key press).
// Every acting call spends one key press or click the main process saw come to the window (the SendGate).

import type { ListenHolds } from "./listen";

export const COMPOSER_OPS = ["models", "setModel", "interrupt", "stop", "commands", "runCommand", "listenStatus", "listenStart", "listenStop"] as const;
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
  /** The window's push-to-talk holds (listen.ts); without it the listen ops are refused. */
  listens?: Pick<ListenHolds, "start" | "stop">;
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

/** A command the slash menu lists: its full name (`<namespace>.<name>`), its plugin, what it says it does, its args
 *  schema, and the plugin's name and scope (which sessions it serves). `own`: the bot's own plugin's. */
export interface ComposerCommand {
  name: string;
  pluginId: string;
  pluginName: string;
  description: string;
  args?: Record<string, unknown>;
  scope?: "bots" | "agents" | "both";
  own: boolean;
}

/** At most this much JSON rides one command's args (the rest of the line, as the composer shaped it). */
export const MAX_COMMAND_ARGS = 100_000;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The commands of plugins that are on, OK'd and running (a plugin is `running` only after its OK), the bot's own
 *  plugin's first (a bot's id is its plugin's, §6.1), then the rest in the registry's order. */
async function commandsFor(r: ComposerRoute, c: ComposerMount): Promise<ComposerCommand[]> {
  const out: ComposerCommand[] = [];
  for (const { cmd, plugin, top } of await liveCommands(r.asApp)) {
    const scope = plugin.scope === "bots" || plugin.scope === "agents" || plugin.scope === "both" ? plugin.scope : undefined;
    out.push({
      name: cmd.name as string,
      pluginId: cmd.pluginId as string,
      pluginName: typeof plugin.name === "string" ? plugin.name : (cmd.pluginId as string),
      description: typeof cmd.description === "string" ? cmd.description : "",
      ...(isObject(cmd.args) ? { args: cmd.args } : {}),
      ...(scope !== undefined ? { scope } : {}),
      own: c.bot !== undefined && top === c.bot,
    });
  }
  return [...out.filter((x) => x.own), ...out.filter((x) => !x.own)];
}

/** The commands whose plugin is on, OK'd and running (and its top-level plugin too, for a child): the registry's
 *  `command.list` rows with their plugin's `plugin.list` row. The slash menu and a command's key both ask this. */
export async function liveCommands(asApp: (method: string, params: unknown) => Promise<unknown>): Promise<{ cmd: Record<string, unknown>; plugin: Record<string, unknown>; top: string }[]> {
  const [listed, plugins] = await Promise.all([asApp("command.list", {}), asApp("plugin.list", {})]);
  const live = new Map<string, Record<string, unknown>>();
  for (const p of (isObject(plugins) && Array.isArray(plugins.plugins) ? plugins.plugins : []) as unknown[]) {
    if (isObject(p) && typeof p.id === "string" && p.enabled === true && p.state === "running") live.set(p.id, p);
  }
  const out: { cmd: Record<string, unknown>; plugin: Record<string, unknown>; top: string }[] = [];
  for (const cmd of (isObject(listed) && Array.isArray(listed.commands) ? listed.commands : []) as unknown[]) {
    if (!isObject(cmd) || typeof cmd.name !== "string" || typeof cmd.pluginId !== "string") continue;
    const plugin = live.get(cmd.pluginId);
    const top = cmd.pluginId.split("/")[0]!;
    // A child runs only while its top-level plugin does.
    if (plugin === undefined || (top !== cmd.pluginId && !live.has(top))) continue;
    out.push({ cmd, plugin, top });
  }
  return out;
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
  // One line for each acting call that went through: the method and the outcome, never what it carried or returned.
  if (r.composer !== undefined && r.op !== "models" && r.op !== "commands" && r.op !== "listenStatus") r.log(`composer: ${r.composer.pluginId}: ${String(r.op)} went through`);
  return out;
}

async function routeComposerOp(r: ComposerRoute): Promise<unknown> {
  const c = r.composer;
  if (c === undefined) {
    r.log(`composer: ${String(r.op)} refused (not the entry the core mounted in the composer spot, for a session of the clover tree's)`);
    throw r.refuse("this isn't the entry the core mounted in the composer spot");
  }
  const op = COMPOSER_OPS.find((o) => o === r.op);
  if (op === undefined) throw r.refuse("not something the composer spot offers");
  const refuse = (why: string): never => {
    r.log(`composer: ${c.pluginId}: ${op} refused (${why})`);
    throw r.refuse(why);
  };
  if (op === "models") return r.asApp("models.list", { session: c.session });
  if (op === "listenStatus" || op === "listenStart" || op === "listenStop") {
    // The bundled composer's only: a third party's composer the user picked never gets the microphone's door.
    if (!c.tree) return refuse("only Clover's own composer records for you");
    if (c.bot === undefined) return refuse("this conversation has no bot to talk to");
    if (op === "listenStatus") return r.asApp("voice.status", { bot: c.bot });
    if (r.listens === undefined) return refuse("this app can't record");
    if (op === "listenStop") return r.listens.stop(c.windowId);
    // Only a press of the user's own starts a recording, and one press covers one.
    if (!r.takeGesture(c.windowId)) return refuse("recording starts only right after your own key press or click");
    return r.listens.start(c.windowId, c.bot);
  }
  if (op === "commands" || op === "runCommand") {
    if (!c.tree) return refuse("only Clover's own composer runs plugin commands as you");
    if (op === "commands") return { commands: await commandsFor(r, c) };
    const a = isObject(r.args) ? r.args : {};
    const name = short(a.name, 128);
    if (name === undefined) return refuse("not a command");
    let size = 0;
    try {
      size = a.args === undefined ? 0 : JSON.stringify(a.args).length;
    } catch {
      return refuse("a command's args are data");
    }
    if (size > MAX_COMMAND_ARGS) return refuse("too much for one command");
    // Only a command the menu would list now: on, OK'd and running.
    if (!(await commandsFor(r, c)).some((x) => x.name === name)) return refuse(`no command ${name} is running here`);
    if (!r.takeGesture(c.windowId)) return refuse("a command runs only right after your own key press or click");
    return r.asApp("command.run", { name, ...(a.args === undefined ? {} : { args: a.args }) });
  }
  const a = (r.args ?? {}) as { model?: unknown; effort?: unknown };
  const model = op === "setModel" ? short(a.model, 200) : undefined;
  const effort = a.effort === undefined ? undefined : short(a.effort, 32);
  // A call that is refused for what it says spends nobody's gesture: validate first, take the gesture last.
  if (op === "setModel" && (model === undefined || (a.effort !== undefined && effort === undefined))) return refuse("not a model");
  const main = op === "setModel" ? await isBotMain(r, c.session, c.bot) : false;
  if (!r.takeGesture(c.windowId)) return refuse(`${op} goes only right after the user's own key press or click`);
  if (op === "interrupt") return r.asApp("session.interrupt", { id: c.session });
  if (op === "stop") return r.asApp("session.stop", { id: c.session });
  if (main) {
    const params = { id: c.bot, patch: { model, ...(effort !== undefined ? { effort } : {}) } };
    return c.tree ? r.asApp("bot.setUserLayer", params) : r.asLayer(c.pluginId, "bot.setUserLayer", params);
  }
  return r.asApp("session.setModel", { id: c.session, model, ...(effort !== undefined ? { effort } : {}) });
}

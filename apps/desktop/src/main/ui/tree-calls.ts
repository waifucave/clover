// The bundled `clover` tree's calls to the core (spec §5.5: "Only the `clover` layer changes the core's settings and the
// user layers directly"). A part reaches the daemon on its plugin's `layer` connection, which refuses these; they go on
// the app's own connection instead, and only these: an explicit table, per method and per part, default refuse. Who
// qualifies is decided here from facts the page can't forge (`treePart`: bundled, in the `clover` layer, top-level
// `clover`), never from an id or flag the page sends. Every other layer is untouched.
//
// This door is deliberately small. Everything a replaceable part does (read and follow a conversation, send as the user,
// pick a model, interrupt) goes through what ANY plugin gets: the plugin API under its capabilities, and the spot's
// own host callbacks (composer-calls.ts). What is left here is:
//   class 1  the core's settings and the user layers, from the clover layer (ui.settings, ui.set, bot.setUserLayer from the
//            bot editor, a plugin's own settings from the settings part);
//   class 2  the clover shell's own pages, which the spec gives no capability and no replacement path today:
//            plugin.list/get/ui, plugin.index.*, plugin.setEnabled (with the user's click), account.status,
//            archive.list/history, and the model catalog for the bot editor.
// Dispositions:
//   read      a read; `part` limits it to a part, none: any tree part.
//   settings  a write of the user's own preference: only the named part.
//   gesture   a call that counts only inside the user's own key press or click (the SendGate).
//   card      trust-changing (levels, devices, the main computer): never on this route.
//   unserved  the daemon has no such method.
// `card.answer` and `card.confirm` are on no list: a card is answered only on the sealed path.

export type Disposition = "read" | "settings" | "gesture" | "card" | "unserved";

export interface TreeCall {
  disposition: Disposition;
  /** The only part whose frame may make the call (a `settings` call always names one). */
  part?: string | readonly string[];
  /** Also only inside the user's own key press or click: what it changes is what code runs. */
  gesture?: boolean;
}

const READ: Disposition = "read";

export const TREE_CALLS: Readonly<Record<string, TreeCall>> = {
  // Class 1: the core's settings and the user layers.
  "ui.settings": { disposition: READ },
  "ui.set": { disposition: "settings", part: "clover/settings" },
  "plugin.settings.get": { disposition: READ, part: "clover/settings" },
  "plugin.settings.set": { disposition: "settings", part: "clover/settings" },
  // A bot's user layer from the bot editor, with the user's click (the layer door would raise a card).
  "bot.setUserLayer": { disposition: "gesture", part: "clover/bot-editor" },
  // Class 2: the clover shell's own pages.
  "account.status": { disposition: READ },
  "archive.history": { disposition: READ },
  "archive.list": { disposition: READ },
  "plugin.list": { disposition: READ },
  "plugin.get": { disposition: READ },
  "plugin.ui": { disposition: READ },
  "plugin.index.list": { disposition: READ },
  "plugin.index.search": { disposition: READ },
  "models.list": { disposition: READ, part: "clover/bot-editor" },
  // Switching a plugin on or off changes what code runs: the user's click too.
  "plugin.setEnabled": { disposition: "settings", part: "clover/settings", gesture: true },
  // Needs a card (spec §5.5: sensitive changes are a sealed card from every layer).
  "computer.setLevel": { disposition: "card" },
  "device.revoke": { disposition: "card" },
  "main.set": { disposition: "card" },
  // Not served by the daemon.
  "models.catalog": { disposition: "unserved" },
  "session.changes": { disposition: "unserved" },
  "session.connectors": { disposition: "unserved" },
  "session.context": { disposition: "unserved" },
  "session.createPr": { disposition: "unserved" },
  "session.diff": { disposition: "unserved" },
  "session.outputs": { disposition: "unserved" },
  // Session control isn't the tree's: it goes through the composer spot's callbacks (composer-calls.ts).
  "session.setModel": { disposition: "unserved" },
  "session.interrupt": { disposition: "unserved" },
  "session.stop": { disposition: "unserved" },
};

/** Sent only by the user's gesture, through `useUserSend`'s door (`pill.send`); never a bare call. */
export const SEND_ONLY = new Set(["session.send"]);

/** Never on this route, whoever asks. */
export const NEVER = new Set(["card.answer", "card.confirm"]);

export type TreeVerdict =
  | { ok: true; call: TreeCall }
  | { ok: false; why: string; /** The method is the table's to refuse (not a fall-through to the layer door). */ owned: boolean };

/** What the table says to a call from the tree part `partId`. Methods the table doesn't name aren't its business
 *  (`owned: false`): they go to the layer door as before, which refuses all but the `layer` role's methods. */
export function treeVerdict(partId: string, method: string): TreeVerdict {
  if (NEVER.has(method)) return { ok: false, owned: true, why: `${method} is answered only on the sealed path` };
  if (SEND_ONLY.has(method)) return { ok: false, owned: true, why: "the user's words go only through the user's own send" };
  const call = TREE_CALLS[method];
  if (call === undefined) return { ok: false, owned: false, why: `${method} isn't one the app makes for its own parts` };
  switch (call.disposition) {
    case "card": return { ok: false, owned: true, why: `${method} changes what the app may do: it needs a card` };
    case "unserved": return { ok: false, owned: true, why: `${method} isn't served by the core` };
    default:
      if (call.part !== undefined && ![call.part].flat().includes(partId)) return { ok: false, owned: true, why: `${method} is made only from ${[call.part].flat().join(" or ")}` };
      return { ok: true, call };
  }
}

export interface TreeRoute {
  /** The part's window and plugin, from `runtime.treePart`: undefined for any part that isn't the bundled tree's. */
  tree: { windowId: number; pluginId: string } | undefined;
  method: string;
  params: unknown;
  /** One key press or click the main process saw come to the window, spent (the SendGate). */
  takeGesture(windowId: number): boolean;
  /** The call on the app's own connection. */
  request(method: string, params: unknown): Promise<unknown>;
  /** What every part gets, the tree's included, for a method the table doesn't name: the `layer` door. */
  layer(): Promise<unknown>;
  log(line: string): void;
  /** How a refusal is thrown. */
  refuse(why: string): Error;
}

/** One call from a part, routed: the bundled tree's through the table, any other part's through the layer door. */
export async function routeCall(r: TreeRoute): Promise<unknown> {
  if (r.tree === undefined) return r.layer();
  const verdict = treeVerdict(r.tree.pluginId, r.method);
  if (!verdict.ok) {
    if (!verdict.owned) return r.layer();
    r.log(`tree: ${r.tree.pluginId}: ${r.method} refused (${verdict.why})`);
    throw r.refuse(verdict.why);
  }
  // A part's plugin settings are its own: several bundled plugins keep where a request (and so a key) goes in theirs
  // (a cloud project, a region, an account, an origin), and the id here comes from the page.
  if (r.method === "plugin.settings.get" || r.method === "plugin.settings.set") {
    const id = (r.params as { id?: unknown } | null | undefined)?.id;
    if (id !== r.tree.pluginId) {
      r.log(`tree: ${r.tree.pluginId}: ${r.method} refused (not its own settings)`);
      throw r.refuse("a part reads and writes its own plugin's settings only");
    }
  }
  if ((verdict.call.disposition === "gesture" || verdict.call.gesture === true) && !r.takeGesture(r.tree.windowId)) {
    r.log(`tree: ${r.tree.pluginId}: ${r.method} refused (no key press or click of the user's just before)`);
    throw r.refuse(`${r.method} goes only right after the user's own key press or click`);
  }
  return r.request(r.method, r.params);
}

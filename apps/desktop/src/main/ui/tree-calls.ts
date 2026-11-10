// The bundled `clover` tree's calls to the core (the try-6 ruling). The tree's parts were written against the app
// role's core (spec §5.5: only the `clover` layer changes core settings and user layers directly), but a part reaches
// the daemon on its plugin's `layer` connection, which refuses most of what they call. These calls go on the app's own
// connection instead, and only these: an explicit table, per method and per part, and the default is refuse.
//
// Who qualifies is decided here from facts the page can't forge (`treePart`: the mount's plugin is bundled, in the
// `clover` layer, top-level `clover`), never from an id or flag the page sends. Every other layer is untouched.
//
// Dispositions:
//   read      any tree part may read it.
//   settings  the user's own preference: only the named part writes it.
//   gesture   session control: only inside the user's own key press or click (the SendGate), one call per gesture.
//   card      trust-changing (permission levels, devices, the main bot): never on this route. The daemon's sealed
//             cards are the one way; the call is refused here and the refusal is logged.
//   unserved  the daemon has no such method: the caller is fixed to a served one or hides the control.
// `card.answer` and `card.confirm` are on no list: a card is answered only on the sealed path.

export type Disposition = "read" | "settings" | "gesture" | "card" | "unserved";

export interface TreeCall {
  disposition: Disposition;
  /** The only part whose frame may make the call (a `settings` call always names one). */
  part?: string;
  /** Also only inside the user's own key press or click: what it changes is what code runs. */
  gesture?: boolean;
}

const READ: Disposition = "read";

export const TREE_CALLS: Readonly<Record<string, TreeCall>> = {
  // Reads (session.history/list/get/attach stay on the part's own `layer` connection, where the daemon checks its
  // `conversation.read`)
  "archive.history": { disposition: READ },
  "archive.list": { disposition: READ },
  "models.list": { disposition: READ },
  "plugin.list": { disposition: READ },
  "plugin.get": { disposition: READ },
  "plugin.ui": { disposition: READ },
  "plugin.index.list": { disposition: READ },
  "plugin.index.search": { disposition: READ },
  "ui.settings": { disposition: READ },
  "account.status": { disposition: READ },
  // A plugin's own settings may hold what it keeps private: the settings part reads them, no other.
  "plugin.settings.get": { disposition: READ, part: "clover/settings" },
  // The user's own preferences: the settings part only.
  "ui.set": { disposition: "settings", part: "clover/settings" },
  // Switching a plugin on or off changes what code runs: the user's click too, like the session controls.
  "plugin.setEnabled": { disposition: "settings", part: "clover/settings", gesture: true },
  "plugin.settings.set": { disposition: "settings", part: "clover/settings" },
  // Session control: with the user's gesture.
  "session.setModel": { disposition: "gesture" },
  "session.interrupt": { disposition: "gesture" },
  "session.stop": { disposition: "gesture" },
  // Needs a card.
  "computer.setLevel": { disposition: "card" },
  "device.pair.begin": { disposition: "card" },
  "device.pair.cancel": { disposition: "card" },
  "device.pair.confirm": { disposition: "card" },
  "device.pair.join": { disposition: "card" },
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
      if (call.part !== undefined && call.part !== partId) return { ok: false, owned: true, why: `${method} is made only from ${call.part}` };
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
  if ((verdict.call.disposition === "gesture" || verdict.call.gesture === true) && !r.takeGesture(r.tree.windowId)) {
    r.log(`tree: ${r.tree.pluginId}: ${r.method} refused (no key press or click of the user's just before)`);
    throw r.refuse(`${r.method} goes only right after the user's own key press or click`);
  }
  return r.request(r.method, r.params);
}

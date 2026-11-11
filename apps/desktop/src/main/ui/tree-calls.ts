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
//            archive.list/history, and the model catalog for the bot editor;
//   class 3  the Plugins page (`PLUGINS_PART`, the controller's ruling of 2026-11-11): what the user does to plugins,
//            each by the user's own key press or click in that frame, one call per gesture, with the same user-only
//            methods and sealed cards the terminal and the app use. A folder never comes from the page as a path: the
//            page asks main to pick one (`ui.pick`) and gets a one-use token, which main swaps back for the path it
//            chose (`PickTokens`). `plugin.remove` from the page always asks on a sealed card (main sets `card`). A
//            plugin's settings may be any plugin's here, and the core cards a change that moves a plugin's host.
// Dispositions:
//   read      a read; `part` limits it to a part, none: any tree part.
//   settings  a write of the user's own preference: only the named part.
//   gesture   a call that counts only inside the user's own key press or click (the SendGate).
//   card      trust-changing (levels, devices, the main computer): never on this route.
//   unserved  the daemon has no such method.
// `card.answer` and `card.confirm` are on no list: a card is answered only on the sealed path.
import { TopPluginId } from "@waifucave/clover-protocol";
/** The bundled tree whose notices are the app's own: never muted. */
const CLOVER_TREE = "clover";

export type Disposition = "read" | "settings" | "gesture" | "card" | "unserved";

export interface TreeCall {
  disposition: Disposition;
  /** The only part whose frame may make the call (a `settings` call always names one). */
  part?: string | readonly string[];
  /** Also only inside the user's own key press or click: what it changes is what code runs. A list: only for those
   *  parts. */
  gesture?: boolean | readonly string[];
  /** The parts that may name any plugin's id (`plugin.settings.*`); every other part is held to its own. */
  anyId?: readonly string[];
}

const READ: Disposition = "read";

/** The Plugins page: the bundled plugin-index plugin's part. */
export const PLUGINS_PART = "clover/plugin-index";
const SETTINGS_PART = "clover/settings";
/** What only the Plugins page does, each with the user's key press or click. */
const PAGE = { disposition: "gesture", part: PLUGINS_PART } as const satisfies TreeCall;
/** The bot editor: the bundled bot-editor plugin's part. */
export const BOT_EDITOR_PART = "clover/bot-editor";

export const TREE_CALLS: Readonly<Record<string, TreeCall>> = {
  // Class 1: the core's settings and the user layers.
  "ui.settings": { disposition: READ },
  // The Settings page's own choices, each by the user's click or key press (one call per gesture), and only the keys its
  // controls write (`settingsParams`): the light / dark / system choice, the theme plugin, the language.
  "ui.set": { disposition: "settings", part: "clover/settings", gesture: ["clover/settings"] },
  "plugin.settings.get": { disposition: READ, part: [SETTINGS_PART, PLUGINS_PART], anyId: [PLUGINS_PART] },
  "plugin.settings.set": { disposition: "settings", part: [SETTINGS_PART, PLUGINS_PART], gesture: [PLUGINS_PART], anyId: [PLUGINS_PART] },
  // A bot's user layer from the bot editor, with the user's click (the layer door would raise a card).
  "bot.setUserLayer": { disposition: "gesture", part: "clover/bot-editor" },
  // A model the user picked in main's own dialog, copied into the user's avatars for a bot and made its avatar. Only a
  // pick token of that use, only an existing bot's id, only the bot editor, one call per click (`botImport`).
  "bot.importAvatar": { disposition: "gesture", part: BOT_EDITOR_PART },
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
  "plugin.setEnabled": { disposition: "settings", part: [SETTINGS_PART, PLUGINS_PART], gesture: true },
  // Class 3: the Plugins page.
  "plugin.logs": { disposition: READ, part: [SETTINGS_PART, PLUGINS_PART] },
  "plugin.auth.list": { disposition: READ, part: PLUGINS_PART },
  "plugin.dev.list": { disposition: READ, part: PLUGINS_PART },
  // Lane D's notification mutes, per plugin: the list is a read; muting or unmuting one is the user's click.
  "notify.mutes": { disposition: READ, part: PLUGINS_PART },
  // main's own dialog, for the use the page names: the Plugins page's folders (an install, a development folder) and the
  // bot editor's avatar (`bot.importAvatar`). The token it issues is redeemable by that one use only (`PICK_USES`).
  "ui.pick": { disposition: "gesture", part: [PLUGINS_PART, BOT_EDITOR_PART] },
  // Opens the app's own key dialog (a core page) for one plugin's one secret setting: the value never passes the part.
  "ui.secret": PAGE,
  "plugin.install": PAGE,
  "plugin.remove": PAGE,
  "plugin.update": PAGE,
  "plugin.pin": PAGE,
  "plugin.restart": PAGE,
  "plugin.index.add": PAGE,
  "plugin.index.remove": PAGE,
  "plugin.auth.signIn": PAGE,
  "plugin.auth.signOut": PAGE,
  "plugin.dev.add": PAGE,
  "plugin.dev.remove": PAGE,
  "plugin.dev.renew": PAGE,
  "notify.setMuted": PAGE,
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

/** How long a picked folder's token may be redeemed. */
export const PICK_TOKEN_MS = 5 * 60_000;

/** The one call a pick's token may be redeemed by: `plugin.install`'s folder and wrapped-folder sources,
 *  `plugin.dev.add`, or the bot editor's `bot.importAvatar`. The page names its use when it asks for the pick and main
 *  issues the token for that use alone: no token works for two. */
export type PickUse = "plugin.install" | "plugin.dev.add" | "bot.importAvatar";

/** The uses each part may ask a pick for. */
const PICK_USES: Readonly<Record<string, readonly PickUse[]>> = {
  [PLUGINS_PART]: ["plugin.install", "plugin.dev.add"],
  [BOT_EDITOR_PART]: ["bot.importAvatar"],
};

/** A folder or file the user chose in main's native dialog, as a token the page holds: one use, bound to the part that
 *  asked and to the calls that may redeem it, gone after `PICK_TOKEN_MS`. The path never reaches a page. */
export class PickTokens {
  readonly #held = new Map<string, { part: string; path: string; use: PickUse; until: number }>();

  constructor(private readonly now: () => number = Date.now, private readonly makeId: () => string = () => crypto.randomUUID()) {}

  issue(part: string, path: string, use: PickUse): string {
    for (const [t, h] of this.#held) if (h.until <= this.now()) this.#held.delete(t);
    const token = `pick-${this.makeId()}`;
    this.#held.set(token, { part, path, use, until: this.now() + PICK_TOKEN_MS });
    return token;
  }

  /** The path for a token this part holds, for this use, once; undefined otherwise (and a token used wrongly is spent). */
  redeem(token: unknown, part: string, use: PickUse): string | undefined {
    if (typeof token !== "string") return undefined;
    const h = this.#held.get(token);
    this.#held.delete(token);
    if (h === undefined || h.part !== part || h.use !== use || h.until <= this.now()) return undefined;
    return h.path;
  }
}

/** The `ui.set` keys the Settings page's controls write, each with the check on its value: nothing else of the core's
 *  UiSettings (picks, lists, the base theme, overrides with their CSS, the text size, packs) comes from this page. */
const SETTINGS_PATCH: Readonly<Record<string, (v: unknown) => boolean>> = {
  appearance: (v) => v === "light" || v === "dark" || v === "system",
  globalTheme: (v) => typeof v === "string" && v.length <= 200 && /^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)?#[A-Za-z0-9._-]+$/.test(v),
  language: (v) => typeof v === "string" && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/.test(v),
};

/** The Settings page's `ui.set` as main sends it, or a refusal: only `patch`, only the keys above (any other key is
 *  dropped), a bad value refused, and at least one key left. */
export function settingsParams(params: unknown): { params: { patch: Record<string, unknown> } } | { why: string } {
  const patch = params !== null && typeof params === "object" && !Array.isArray(params) ? (params as { patch?: unknown }).patch : undefined;
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return { why: "what should change?" };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    const check = Object.hasOwn(SETTINGS_PATCH, k) ? SETTINGS_PATCH[k] : undefined;
    if (check === undefined) continue;
    if (!check(v)) return { why: `${k} isn't a value the Settings page sets` };
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? { params: { patch: out } } : { why: "nothing here is a choice the Settings page makes" };
}

/** The wrap kinds whose value is a folder or file (a token from `ui.pick`); the others' value is the pasted text. */
const PATH_WRAPS = new Set(["claude-plugin", "skill-folder", "agent-file"]);
const TEXT_WRAPS = new Set(["mcp-config", "mcp-url"]);

/** A top-level plugin's id (no `/`: a part of a plugin isn't muted on its own). */

/** Keys a page never sets on a call: who is calling is the connection's (main's own app connection), never the page's. */
const CALLER_KEYS = new Set(["client", "caller", "role", "origin", "by"]);

/** The Plugins page's params as main sends them, or a refusal: a picked path swapped in for its token (an install's
 *  folder, a development folder); `card` on a removal, a sign-out, an index's removal and an update (the core asks on a
 *  sealed card where it must); `noSecret` on a setting (a key is entered only in the app's own key dialog); an update
 *  applied only by id; and nothing that names the caller. */
export function pageParams(method: string, params: unknown, part: string, tokens: PickTokens): { params: unknown } | { why: string } {
  const raw = (params !== null && typeof params === "object" && !Array.isArray(params) ? params : {}) as Record<string, unknown>;
  const p = Object.fromEntries(Object.entries(raw).filter(([k]) => !CALLER_KEYS.has(k)));
  if (method === "plugin.remove") return typeof p.id === "string" ? { params: { id: p.id, card: true } } : { why: "which plugin?" };
  if (method === "plugin.update") {
    if (p.list === true) return { params: { ...(typeof p.id === "string" ? { id: p.id } : {}), list: true } };
    return typeof p.id === "string" ? { params: { id: p.id, card: true } } : { why: "an update is applied one plugin at a time, the one the user picked" };
  }
  // A plugin's notifications muted or not: a top-level plugin, any but Clover's own tree (the app's notices; its parts
  // aren't top-level, so they're refused too). A bundled bot (`alpha`) is muted like any plugin. A boolean; nothing else.
  if (method === "notify.setMuted") {
    const id = p.pluginId;
    if (typeof id !== "string" || !TopPluginId.safeParse(id).success) return { why: "which plugin?" };
    if (id === CLOVER_TREE) return { why: "Clover's own notices aren't muted here" };
    if (typeof p.muted !== "boolean") return { why: "mute it or not?" };
    return { params: { pluginId: id, muted: p.muted } };
  }
  // A sign-in's key never comes from the page: an `api-key` entry is signed into in Clover's own key dialog (`ui.secret`).
  if (method === "plugin.auth.signIn") {
    if (p.key !== undefined) return { why: "a key is entered only in Clover's own key dialog" };
    return typeof p.id === "string" && typeof p.index === "number" ? { params: { id: p.id, index: p.index } } : { why: "which sign-in?" };
  }
  if (method === "plugin.auth.signOut") return typeof p.id === "string" && typeof p.index === "number" ? { params: { id: p.id, index: p.index, card: true } } : { why: "which sign-in?" };
  if (method === "plugin.index.remove") return typeof p.url === "string" ? { params: { url: p.url, card: true } } : { why: "which index?" };
  // A setting: which plugin, which key, the value (null: back to its default); never a bot (the page edits a plugin's
  // own values), never the page's `card` or `noSecret` (main sets `noSecret`; the core cards what feeds a host).
  if (method === "plugin.settings.set") {
    if (typeof p.id !== "string" || typeof p.key !== "string") return { why: "which setting?" };
    if (!Object.hasOwn(p, "value")) return { why: "set it to what?" };
    return { params: { id: p.id, key: p.key, value: p.value, noSecret: true } };
  }
  // Another 24 hours of code that reloads asks on the same card as adding it.
  if (method === "plugin.dev.renew") return typeof p.path === "string" ? { params: { path: p.path, card: true } } : { why: "which development folder?" };
  if (method === "plugin.dev.add") {
    const path = tokens.redeem(p.path, part, "plugin.dev.add");
    return path === undefined ? { why: "a folder comes from the folder picker (ui.pick), not from the page" } : { params: { path } };
  }
  if (method !== "plugin.install") return { params: p };
  const src = (p.source ?? {}) as Record<string, unknown>;
  switch (src.from) {
    case "index":
    case "npm":
      return { params: { source: src } };
    case "folder": {
      const path = tokens.redeem(src.path, part, "plugin.install");
      return path === undefined ? { why: "a folder comes from the folder picker (ui.pick), not from the page" } : { params: { source: { from: "folder", path } } };
    }
    case "wrap": {
      if (typeof src.kind === "string" && TEXT_WRAPS.has(src.kind)) return { params: { source: src } };
      if (typeof src.kind === "string" && PATH_WRAPS.has(src.kind)) {
        const path = tokens.redeem(src.value, part, "plugin.install");
        return path === undefined ? { why: "a folder comes from the folder picker (ui.pick), not from the page" } : { params: { source: { from: "wrap", kind: src.kind, value: path } } };
      }
      return { why: "not a kind of item Clover wraps" };
    }
    default:
      return { why: "a plugin installs from an index, npm, a picked folder or a pasted MCP config" };
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
  /** The picked folders' tokens (the Plugins page's); absent, `ui.pick` and a picked install are refused. */
  tokens?: PickTokens;
  /** Main's native folder or file dialog over the window: the path chosen, or undefined when the user cancels. */
  pick?(windowId: number, kind: "folder" | "file", filters: readonly { name: string; extensions: string[] }[] | undefined, use: PickUse): Promise<string | undefined>;
  /** Opens the app's own key dialog (the core page "key") for a plugin's secret setting or `api-key` sign-in, checked
   *  as one here. */
  openKey?(target: KeyTarget): Promise<boolean>;
}

/** What the app's key dialog is for: one plugin's secret setting, or one of its `api-key` sign-ins. */
export type KeyTarget = { id: string; key: string } | { id: string; index: number };

const PLUGIN_ID_RE = /^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)?$/;
const SETTING_KEY_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/** A field's kind from the plugin's manifest as the registry holds it (`plugin.get` on the app's connection), never
 *  from the page. */
/** A setting's field as the plugin's manifest has it (main reads it from the core's record, never from the page). */
interface PageSettingField {
  type?: unknown;
  options?: unknown;
  min?: unknown;
  max?: unknown;
  scope?: unknown;
}

async function settingField(r: TreeRoute, id: string, key: string): Promise<PageSettingField | undefined> {
  const got = (await r.request("plugin.get", { id })) as { plugin?: { manifest?: { settings?: Record<string, PageSettingField> } } };
  const settings = got.plugin?.manifest?.settings;
  const f = settings !== undefined && Object.hasOwn(settings, key) ? settings[key] : undefined;
  return f !== null && typeof f === "object" ? f : undefined;
}

/** Why a value from the Plugins page doesn't fit its field's kind, or undefined: a string for text, a number in its
 *  bounds, true or false for a switch, one of an enum's choices, `#rrggbb` for a color; null puts the default back.
 *  The core checks again (`checkSettingValue`); main refuses first so a wrong value never reaches a card. */
export function pageSettingWhy(key: string, field: PageSettingField, value: unknown): string | undefined {
  if (field.scope === "bot") return `${key} has one value per bot: it is set in that bot's settings`;
  if (value === null) return undefined;
  switch (field.type) {
    case "string":
      return typeof value === "string" && value.length <= 8192 ? undefined : `${key} takes text of up to 8,192 characters`;
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return `${key} takes a number`;
      if (typeof field.min === "number" && value < field.min) return `${key} is at least ${field.min}`;
      if (typeof field.max === "number" && value > field.max) return `${key} is at most ${field.max}`;
      return undefined;
    }
    case "boolean":
      return typeof value === "boolean" ? undefined : `${key} is on or off`;
    case "enum": {
      const options = (Array.isArray(field.options) ? field.options : []).map((o) => (typeof o === "string" ? o : (o as { value?: unknown } | null)?.value));
      return typeof value === "string" && options.includes(value) ? undefined : `${key} is one of its choices`;
    }
    case "color":
      return typeof value === "string" && /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value) ? undefined : `${key} takes a color, #rrggbb`;
    default:
      return `${key} isn't a setting the page can change`;
  }
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
  const part = r.tree.pluginId;
  // A part's plugin settings are its own: several bundled plugins keep where a request (and so a key) goes in theirs
  // (a cloud project, a region, an account, an origin), and the id here comes from the page. The Plugins page may name
  // any plugin's (the core cards a change that moves a plugin's host).
  if ((r.method === "plugin.settings.get" || r.method === "plugin.settings.set") && !(verdict.call.anyId ?? []).includes(part)) {
    const id = (r.params as { id?: unknown } | null | undefined)?.id;
    if (id !== part) {
      r.log(`tree: ${part}: ${r.method} refused (not its own settings)`);
      throw r.refuse("a part reads and writes its own plugin's settings only");
    }
  }
  // Only listing what is newer is a read; applying one is the user's click.
  const listing = r.method === "plugin.update" && (r.params as { list?: unknown } | null | undefined)?.list === true;
  if (needsGesture(verdict.call, part) && !listing && !r.takeGesture(r.tree.windowId)) {
    r.log(`tree: ${part}: ${r.method} refused (no key press or click of the user's just before)`);
    throw r.refuse(`${r.method} goes only right after the user's own key press or click`);
  }
  if (r.method === "ui.set" && part === SETTINGS_PART) {
    const shaped = settingsParams(r.params);
    if ("why" in shaped) {
      r.log(`tree: ${part}: ui.set refused (${shaped.why})`);
      throw r.refuse(shaped.why);
    }
    return r.request("ui.set", shaped.params);
  }
  if (r.method === "ui.pick") return pick(r, part);
  if (r.method === "bot.importAvatar") return botImport(r, part);
  if (r.method === "ui.secret") return secret(r, part);
  if (part === PLUGINS_PART) {
    const shaped = pageParams(r.method, r.params, part, r.tokens ?? new PickTokens());
    if ("why" in shaped) {
      r.log(`tree: ${part}: ${r.method} refused (${shaped.why})`);
      throw r.refuse(shaped.why);
    }
    // A key never passes through the page: main looks the field's kind up itself (the core refuses it too, `noSecret`).
    // Its value must fit the field's kind, as the manifest has it (main looks it up; the core checks again).
    if (r.method === "plugin.settings.set") {
      const s = shaped.params as { id: string; key: string; value: unknown };
      const field = await settingField(r, s.id, s.key);
      if (field?.type === "secret") {
        r.log(`tree: ${part}: plugin.settings.set refused (a key, from a page)`);
        throw r.refuse(`${s.key} is a key: it is entered, replaced or removed only in Clover's own key dialog`);
      }
      const why = field === undefined ? `${s.key} isn't one of that plugin's settings` : pageSettingWhy(s.key, field, s.value);
      if (why !== undefined) {
        r.log(`tree: ${part}: plugin.settings.set refused (${why})`);
        throw r.refuse(why);
      }
    }
    return r.request(r.method, logsCapped(r.method, shaped.params));
  }
  // Who calls is the connection's, never a part's word for it.
  const params = r.params !== null && typeof r.params === "object" && !Array.isArray(r.params) && Object.keys(r.params).some((k) => CALLER_KEYS.has(k))
    ? Object.fromEntries(Object.entries(r.params).filter(([k]) => !CALLER_KEYS.has(k)))
    : r.params;
  return r.request(r.method, logsCapped(r.method, params));
}

/** The most log lines a part asks for at once. */
export const PART_LOG_LINES_MAX = 2_000;

function logsCapped(method: string, params: unknown): unknown {
  if (method !== "plugin.logs" || params === null || typeof params !== "object") return params;
  const p = params as { lines?: unknown };
  if (p.lines === undefined) return params;
  const n = typeof p.lines === "number" && Number.isFinite(p.lines) ? Math.max(1, Math.min(PART_LOG_LINES_MAX, Math.floor(p.lines))) : 200;
  return { ...p, lines: n };
}

function needsGesture(call: TreeCall, part: string): boolean {
  if (call.disposition === "gesture") return true;
  return call.gesture === true || (Array.isArray(call.gesture) && call.gesture.includes(part));
}

/** `ui.secret`: the app's own key dialog for one plugin's secret setting (`{id, key}`) or `api-key` sign-in
 *  (`{id, index}`); the page gets only that it opened (it reads the settings or sign-ins again for whether a key is set). */
async function secret(r: TreeRoute, part: string): Promise<{ opened: true }> {
  if (r.openKey === undefined) throw r.refuse("this app has no key dialog for a part");
  const p = (r.params ?? {}) as { id?: unknown; key?: unknown; index?: unknown };
  if (typeof p.id !== "string" || !PLUGIN_ID_RE.test(p.id)) throw r.refuse("which plugin's key?");
  let target: KeyTarget;
  if (typeof p.key === "string" && SETTING_KEY_RE.test(p.key) && p.index === undefined) {
    if ((await settingField(r, p.id, p.key))?.type !== "secret") {
      r.log(`tree: ${part}: ui.secret refused (not a key)`);
      throw r.refuse("that isn't one of the plugin's keys");
    }
    target = { id: p.id, key: p.key };
  } else if (typeof p.index === "number" && Number.isInteger(p.index) && p.index >= 0 && p.index < 32 && p.key === undefined) {
    const { auth } = (await r.request("plugin.auth.list", { id: p.id })) as { auth?: { index: number; method: string }[] };
    if (auth?.find((a) => a.index === p.index)?.method !== "api-key") {
      r.log(`tree: ${part}: ui.secret refused (not a key sign-in)`);
      throw r.refuse("that sign-in doesn't take a key");
    }
    target = { id: p.id, index: p.index };
  } else {
    throw r.refuse("which plugin's key?");
  }
  // One key dialog at a time: while one is open, another is refused (the user closes it first), so what it shows and
  // what it saves are always the same plugin's.
  if (!(await r.openKey(target))) {
    r.log(`tree: ${part}: ui.secret refused (a key dialog is open)`);
    throw r.refuse("Clover's key dialog is open already: close it first");
  }
  return { opened: true };
}

/** `ui.pick`: main's own dialog; the page gets a token and the chosen item's name, never its path. */
async function pick(r: TreeRoute, part: string): Promise<{ token: string; name: string } | { cancelled: true }> {
  if (r.pick === undefined || r.tokens === undefined) throw r.refuse("this app has no picker for a part");
  const p = (r.params ?? {}) as { kind?: unknown; filters?: unknown; use?: unknown };
  const kind = p.kind === "file" ? "file" : p.kind === "folder" ? "folder" : undefined;
  if (kind === undefined) throw r.refuse("pick a folder or a file");
  const allowed = PICK_USES[part] ?? [];
  const use = allowed.find((u) => u === p.use);
  if (use === undefined) throw r.refuse(`${part} asks for a pick for ${allowed.join(" or ")}, and says which`);
  // An avatar is a folder or a .zip / .vrm file: main sets the dialog's filter, not the page.
  const filters = use === "bot.importAvatar" ? [{ name: "Avatar", extensions: ["zip", "vrm"] }] : Array.isArray(p.filters)
    ? p.filters.slice(0, 8).flatMap((f: unknown) => {
      const x = (f ?? {}) as { name?: unknown; extensions?: unknown };
      const ext = Array.isArray(x.extensions) ? x.extensions.filter((e): e is string => typeof e === "string" && /^[A-Za-z0-9]{1,10}$/.test(e)).slice(0, 16) : [];
      return typeof x.name === "string" && x.name.length <= 64 && ext.length > 0 ? [{ name: x.name, extensions: ext }] : [];
    })
    : undefined;
  const path = await r.pick(r.tree!.windowId, kind, filters, use);
  if (path === undefined) return { cancelled: true };
  return { token: r.tokens.issue(part, path, use), name: pickedName(path) };
}

/** Text a page shows that a file, a model or the core wrote: no control, bidi or invisible characters, a cap. */
export function neutralised(text: string, max: number): string {
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g, " ").replace(/\s+/g, " ").trim();
  const chars = [...clean];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : clean;
}

/** The last part of a picked path, neutralised and capped: the only thing of it a page ever gets. */
function pickedName(path: string): string {
  return neutralised(path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "", 80);
}

/** The most a refusal's reason shows a page. */
const REASON_MAX = 300;

/** `bot.importAvatar` from the bot editor: `{id, path: <token>}`. The id must be a bot main's own listing holds; the
 *  token is the one `ui.pick` issued this part for this use, spent here; the daemon gets only `{id, path}` with the real
 *  path, and the page gets back `{format, files, bytes, credit?}` (the model's own note as plain text, 300 characters): no path, no listing, and a refusal's plain reason with any path
 *  in it cut out. The core's call already makes the imported model the bot's avatar. */
async function botImport(r: TreeRoute, part: string): Promise<{ format: string; files: number; bytes: number; credit?: string }> {
  const raw = (r.params !== null && typeof r.params === "object" && !Array.isArray(r.params) ? r.params : {}) as Record<string, unknown>;
  const id = raw.id;
  const listed = (await r.request("bot.list", {})) as { bots?: { id?: unknown }[] } | undefined;
  if (typeof id !== "string" || !(listed?.bots ?? []).some((b) => b.id === id)) {
    r.log(`tree: ${part}: bot.importAvatar refused (not a bot)`);
    throw r.refuse("which bot?");
  }
  const path = (r.tokens ?? new PickTokens()).redeem(raw.path, part, "bot.importAvatar");
  if (path === undefined) {
    r.log(`tree: ${part}: bot.importAvatar refused (no pick)`);
    throw r.refuse("an avatar comes from the file picker (ui.pick), not from the page");
  }
  let got: unknown;
  try {
    got = await r.request("bot.importAvatar", { id, path });
  } catch (e) {
    const why = (e instanceof Error ? e.message : String(e)).split(path).join(pickedName(path));
    const bare = why.replace(/(^|[\s("'`])(?:[A-Za-z]:)?[\\/][^\s"'`)]*/g, "$1…");
    r.log(`tree: ${part}: bot.importAvatar refused by the core`);
    throw r.refuse(neutralised(bare, REASON_MAX) || "that model couldn't be imported");
  }
  const g = (got ?? {}) as { format?: unknown; files?: unknown; bytes?: unknown; credit?: unknown };
  const count = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0);
  // The model's own note, from a file the page's user picked: plain text again here (no control or bidi characters, 300).
  const credit = typeof g.credit === "string" ? neutralised(g.credit, 300) : "";
  return { format: g.format === "vrm" ? "vrm" : "live2d", files: count(g.files), bytes: count(g.bytes), ...(credit === "" ? {} : { credit }) };
}

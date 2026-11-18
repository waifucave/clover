// The UI spot catalog (spec §5.3 "App core points", §5.5 "UI spots"). The default shell declares the well-known spots;
// a plugin that declares one of these names must use the catalog's declaration, or it is refused (§5.4). A replacement
// for a container should declare the container's own spots, or what fills them waits.
//
// Each spot lists its shape, who declares it, what Bots offers a bot's plugin there (`botsOffer`: the owner's rule of
// November 14, §5.5: a bot's plugin fills only those, on its own tab), the capabilities its props carry data for (`needs`), the keys that can't be hidden (`keep`), the keys it offers
// to `when` (`context`), the fields its entries carry beyond the `ui` entry's own (checked here), and its props.
//
// PROVISIONAL for lanes E (the app runtime, `<Spot>`) and F (the shell that declares them): the names, shapes, keys,
// `needs` and `keep` come from the spec; the props are the least each spot obviously hands over, for E and F to settle
// at E-M1 and F-M2 through the controller.
import { z } from "zod";
import { utf16 } from "@waifucave/moss-protocol";
import { HandlerName, Path, Text } from "../manifest/fields";
import { foldTitle } from "./fold";

export { foldTitle, lookalikeOf } from "./fold";

export interface SpotInfo {
  readonly name: string;
  readonly shape: "single" | "list" | "keyed";
  /** Who declares it: the app's plugin runtime (a core point), or a bundled part of `moss`. */
  readonly declaredBy: "app" | "shell" | "settings" | "session-tab" | "composer" | "conversation" | "file-view" | "island" | "pill";
  /** What Bots offers a bot's own plugin here, on that bot's tab only (§5.5, the owner's rule of November 14): the whole
   *  spot (`true`), only these keys (a keyed spot: `panel`'s Browser and agent panels), or nothing (`false`: a part
   *  beside the bot fills it, `"app": true`). */
  readonly botsOffer: boolean | readonly string[];
  /** For a keyed spot, the keys the spec names (an entry may still use any key, and `*` patterns). */
  readonly keys?: readonly string[];
  readonly keep?: readonly string[];
  readonly needs?: readonly string[];
  /** Props that reach only a plugin holding a capability, by their dotted path in the props: the spot itself needs
   *  none (no spot uses this yet). */
  readonly gates?: Readonly<Record<string, string>>;
  readonly context?: readonly string[];
  /** For a keyed spot: a key no plugin fills shows the declaring part's placeholder, which offers to find a plugin
   *  for it (lane F's request): the plugins page, searched for that spot and key. */
  readonly placeholder?: true;
  /** Entry ids and titles only the bundled `moss` tree may use here (lane G's review: a third-party island tab can't
   *  pose as Needs you). Titles compare folded (`foldTitle`). */
  readonly reserved?: { readonly ids: readonly string[]; readonly titles: readonly string[] };
  /** The spot's own entry fields (title, icon, opens…), beyond the `ui` entry's. */
  readonly fields: z.ZodType;
  /** What the spot hands each component (provisional, see above). */
  readonly props: z.ZodType;
  readonly doc: string;
}

const none = z.object({});
const BotRef = z.object({ id: z.string(), name: Text });
const titled = z.object({ title: Text, icon: Path.optional() });
const titledOpt = z.object({ title: Text.optional(), icon: Path.optional() });
/** A conversation item as the conversation view draws it: its id, its kind and its time on the shared clock, plus the
 *  kind's own fields (lane F's, settled at F-M2). An approval item carries only its card's id, computer and state; the
 *  sealed text never reaches a plugin. Under the `tool` key, the item is a run of consecutive calls (`calls`). */
const item = z.looseObject({ id: z.string(), kind: z.string(), at: z.number() });
/** Data the view hands on, and callbacks the core routes back (open a link or a file, answer a question). */
const ctx = z.record(z.string(), z.unknown());
const inConversation = { bot: BotRef, session: z.string(), item, ctx };

/** The message kinds `conversation.message` is keyed by (§5.5). */
export const MESSAGE_KINDS = ["user", "bot", "tool", "approval", "question", "routine-result", "task-notification", "agent-report", "note"] as const;
/** The routes `main` is keyed by (§5.5). */
export const MAIN_ROUTES = ["agent", "settings", "plugins", "app"] as const;

export const SPOTS: readonly SpotInfo[] = [
  // The app's core points (§5.3).
  { name: "app.root", shape: "single", declaredBy: "app", botsOffer: false, fields: none, props: none,
    doc: "The main window's root: the shell, which declares every other spot." },
  { name: "app.surface", shape: "list", declaredBy: "app", botsOffer: false, context: ["surface", "os"], fields: titledOpt,
    props: z.object({ surface: z.string() }),
    doc: "Top-level floating windows, such as the island and the Dispatch pill; `window` says how they float." },
  { name: "app.background", shape: "list", declaredBy: "app", botsOffer: false, context: ["os"], fields: none,
    props: none,
    doc: "A part with no place in the window: it runs in a hidden window of its own while MOSS is open and the plugin runs, outlives the main window, is never slept or slowed, and may play sound when the plugin holds `audio`. At most two per plugin; in a plugin with a bot it needs \"app\": true." },
  { name: "app.tray", shape: "list", declaredBy: "app", botsOffer: false, needs: ["tray"], fields: titled,
    props: none,
    doc: "A line in the menu-bar (tray) menu, with the `tray` capability: `toggles` names one of the plugin's own `app.surface` entries (the line hides and shows it, and the choice is kept), or `command` names a command of the plugin's own that the line runs." },
  // A bot's tab and its points (`bot.tab`, `bot.header`, `bot.side`, `bot.controls`, the bar, the `chrome.*` parts, the
  // sidebar's bot rows, the bot editor's sections) are retired by spec revision 19 (§5.5, items 99 and 100, G8): a bot has
  // no tab in a plugin window (`catalogs/retired.ts` says where each went).
  // The shell's spots (`app.root`).
  { name: "sidebar", shape: "single", declaredBy: "shell", botsOffer: false, context: ["bot"], fields: none, props: none,
    doc: "The sidebar: the app's own, the same on every tab. A plugin may fill it for the whole app (its own component, in its own frame, reading and acting through `shell.*`); an entry tied to a bot's tab (`when.bot`, or inside a bot's plugin without `app: true`) is refused." },
  { name: "sidebar.app", shape: "list", declaredBy: "shell", botsOffer: false,
    fields: z.object({ title: Text, icon: Path, opens: utf16(128, 1) }), props: none,
    doc: "App buttons in the sidebar; `opens` names the `main` and `panel` key it shows." },
  { name: "main", shape: "keyed", declaredBy: "shell", botsOffer: false, keys: MAIN_ROUTES, fields: none,
    props: z.object({ route: z.string(), params: z.record(z.string(), z.string()) }),
    doc: "The main area, keyed by route: agent, settings, plugins, app." },
  { name: "panel", shape: "keyed", declaredBy: "shell", botsOffer: ["browser", "agent"], context: ["session"], placeholder: true, fields: titledOpt,
    props: z.object({ app: z.string(), session: z.string().optional(), bot: z.string().optional() }),
    doc: "The panel host, keyed by panel: each stock panel (session, terminal, diff, files, browser, agent) is a plugin of its own, and replaceable. An entry whose key is not a stock one ADDS a panel of the plugin's own, with a button of its own beside the stock ones: it needs a `title`, `icon` is optional, and `when.session` (`bot`, `agent`, `coding`) says which tabs show it (all when absent). Inside a bot's plugin it shows on that bot's tab only; beside the bot (`\"app\": true`) or in a plugin with no bot, on every tab of the kinds it names. A panel for some sessions only says so with `when.session` (the code-only panels: `\"coding\"`); a stock key no plugin fills shows the host's placeholder." },
  { name: "panel.view", shape: "keyed", declaredBy: "shell", botsOffer: false, fields: titled,
    props: z.object({ view: z.string(), session: z.string().optional() }),
    doc: "A spot inside each panel view, keyed by the view's id." },
  { name: "settings.section", shape: "list", declaredBy: "settings", botsOffer: false, fields: titled, props: none,
    doc: "A section of the settings screen, which the settings part (`main` key `settings`) declares." },
  { name: "status", shape: "list", declaredBy: "shell", botsOffer: false, fields: titledOpt, props: none,
    doc: "The shell's status bar; the inherited `tile` becomes an entry here (§12)." },
  // A session's tab (the shell's `Tabs.tsx`): the conversation over the composer.
  { name: "conversation", shape: "single", declaredBy: "session-tab", botsOffer: true, context: ["bot"], needs: ["sessions.read"], fields: none,
    props: z.object({ bot: BotRef, session: z.string() }), doc: "The conversation view." },
  { name: "composer", shape: "single", declaredBy: "session-tab", botsOffer: true, context: ["bot"], needs: ["conversation.post"], fields: none,
    props: z.object({ bot: BotRef, session: z.string() }),
    doc: "The composer; a send counts as the user's only on a real key press or click (§5.5). Its entry also gets the host callbacks (`useComposerHost`): the models its session can switch to, a model switch, interrupt and stop; each acting one needs the user's own key press or click, and a model switch on a bot's main conversation is a sealed card unless it is the default composer's. The default composer also lists the running plugins' commands and runs one as the user (its slash menu); another plugin's entry doesn't get those." },
  { name: "composer.action", shape: "keyed", declaredBy: "composer", botsOffer: true, context: ["bot"], fields: titledOpt,
    props: z.object({ bot: BotRef, session: z.string() }),
    doc: "The composer's buttons, keyed by action id: an entry keyed `attach`, `model`, `level`, `send` or `stop` draws that button another way (or hides it); one with any other key adds a button of its own, drawn among the buttons plugins add, in the spot's order (`order`, then plugin and id)." },
  { name: "conversation.message", shape: "keyed", declaredBy: "conversation", botsOffer: true, keys: MESSAGE_KINDS, keep: ["approval"],
    needs: ["sessions.read"], context: ["bot"], fields: none, props: z.object(inConversation),
    doc: "One message, keyed by kind; the `approval` cell can't be hidden. The `tool` cell gets a run of calls." },
  { name: "conversation.message.extra", shape: "list", declaredBy: "conversation", botsOffer: true, needs: ["sessions.read"], context: ["bot"],
    fields: none, props: z.object(inConversation),
    doc: "Add-ons under each message, with a UI of their own. A plugin outside MOSS's own tree draws in its own layer, so each one is a frame under every message: for a button, use `conversation.message.action`." },
  { name: "conversation.message.action", shape: "list", declaredBy: "conversation", botsOffer: true, context: ["bot"],
    fields: z.object({ title: Text, icon: Path.optional(), call: HandlerName, on: z.enum(["assistant", "user", "both"]).optional() }), props: none,
    doc: "A small button the conversation draws itself in a message's row of actions (beside copy and speak), no frame and no component: `title` is its tooltip, `icon` a picture in the plugin's folder, `on` which messages carry it (a finished reply by default). A press runs `call`, a handler in the plugin's own `ui` table, with `{ session, seq }` (the message's place in the session's log) and nothing else; it answers `{ ok: true }`, or `{ note }`, one sentence the conversation shows under the message for a moment." },
  { name: "tool.result", shape: "keyed", declaredBy: "conversation", botsOffer: true, needs: ["sessions.read"], context: ["bot"], fields: none,
    props: z.object({ ...inConversation, tool: z.string() }),
    doc: "A tool's result, keyed by tool name (`mcp__blender__*`); `item` is the one call." },
  { name: "file.preview", shape: "keyed", declaredBy: "file-view", botsOffer: true, fields: none,
    props: z.object({ path: z.string(), mediaType: z.string() }),
    doc: "A file's preview wherever one shows, keyed by media type (`image/*`); in a bot's plugin, only inside its tab." },
  // Surfaces.
  { name: "island.tab", shape: "list", declaredBy: "island", botsOffer: false, context: ["surface"],
    fields: z.object({ title: Text, icon: Path.optional(), size: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).optional(), idle: z.boolean().optional(), attention: z.enum(["never", "badge", "expand"]).optional() }),
    props: z.object({ expanded: z.boolean() }), reserved: { ids: ["needs-you"], titles: ["Needs you"] },
    doc: "A tab of the island, such as Needs you, Devices or Usage. The island labels a third-party tab with its plugin's name, and only the `moss` tree's tabs raise the strip's attention." },
  { name: "pill.target", shape: "list", declaredBy: "pill", botsOffer: false, context: ["surface"], fields: titled.extend({ handler: HandlerName }), props: none,
    doc: "Something the Dispatch pill can message besides the bots: `handler` (a `PillTargetHandler`) gets the user's words. The pill names it with its plugin's name, and leaves out one titled as a bot." },
];

export const SPOT_NAMES: ReadonlySet<string> = new Set(SPOTS.map((s) => s.name));

/** What Bots offers a bot's plugin, on that bot's tab only (§5.5, the owner's rule of November 14), the closed list
 *  every check reads: each spot it offers, with `true` for the whole spot or the keys it offers. Everything inside the
 *  tab, its top bar (`bar`, which it may replace, and the `chrome.*` parts), and the panels that open on the right
 *  (`panel`'s `browser` and `agent`). Never the sidebar, Settings or the bot's Edit page; the rest of the app is a part
 *  beside the bot (`"app": true`). */
export const BOTS_OFFER: ReadonlyMap<string, true | readonly string[]> = new Map(
  SPOTS.flatMap((s) => (s.botsOffer === false ? [] : [[s.name, s.botsOffer === true ? true : s.botsOffer] as const])),
);

/** The stock right panels, each a `panel` entry's key (the session column included): a `panel` entry with one of these
 *  keys replaces that panel; with any other key it adds a panel of its own (§5.5). */
export const STOCK_PANEL_KEYS: readonly string[] = ["session", "terminal", "diff", "browser", "files", "agent"];

/** What an added panel's key looks like: lower-case words and digits with hyphens, as an id in the shell's state. */
export const OWN_PANEL_KEY_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** Whether a `panel` entry with this key adds a panel of its own rather than replacing a stock one. */
export function isOwnPanelKey(key: string | undefined): boolean {
  return isAddedKey("panel", key);
}

/** The composer's own buttons, each a `composer.action` entry's key: an entry with one of these keys draws that button
 *  another way (or hides it); with any other key it adds a button of its own, which the composer draws among the others
 *  plugins add, in the spot's order (an entry's `order`, then plugin and id). */
export const STOCK_COMPOSER_ACTION_KEYS: readonly string[] = ["attach", "model", "level", "send", "stop"];

/** The keyed spots whose declarer draws, beside its own keys, every entry a plugin ADDS under a key of its own, each
 *  spot with its stock keys. A part lists the added entries by asking the spot with `ADDED_KEY`. */
export const STOCK_KEYS: Readonly<Record<string, readonly string[]>> = {
  panel: STOCK_PANEL_KEYS,
  "composer.action": STOCK_COMPOSER_ACTION_KEYS,
};
/** The key a part asks such a spot's entries with to get the added ones (`STOCK_KEYS`), instead of one key's. */
export const ADDED_KEY = "*";

/** Whether an entry of `spot` with this key adds something of its own rather than replacing a stock key's. */
export function isAddedKey(spot: string, key: string | undefined): boolean {
  const stock = STOCK_KEYS[spot];
  return stock !== undefined && key !== undefined && key !== ADDED_KEY && !stock.includes(key);
}

/** Whether Bots offers `spot` (and `key`, in a keyed spot it offers by key) to a bot's plugin. A keyed spot offered by
 *  key takes only an entry naming one of them: one with no key would fill every key. The `panel` spot also takes a key
 *  that isn't a stock panel's: a panel of the bot's own, on its own tab. */
export function botsOffer(spot: string, key?: string): boolean {
  const offer = BOTS_OFFER.get(spot);
  if (offer === undefined) return false;
  if (spot === "panel" && isOwnPanelKey(key)) return true;
  return offer === true || (key !== undefined && offer.includes(key));
}

/** The spots inside a bot's tab: what a bot's layout places (the top bar and the panels are the window's, placed by
 *  the `chrome.*` parts). */
export const BOT_TAB_INSIDE: ReadonlySet<string> = new Set(
  SPOTS.filter((s) => s.botsOffer === true).map((s) => s.name),
);

/** The parts that look the same on every tab (§5.5): no entry tied to a bot's tab (`when.bot`) dresses them, whichever
 *  plugin's it is, and a bot's own plugin never does. */
export const SAME_ON_EVERY_TAB: ReadonlySet<string> = new Set(["sidebar", "sidebar.app", "settings.section"]);
export function spotInfo(name: string): SpotInfo | undefined {
  return SPOTS.find((s) => s.name === name);
}

/** Names only the bundled `moss` tree's plugins may have (lane G's ask): the app's own, beside the titles spots
 *  reserve. */
export const RESERVED_PLUGIN_NAMES: readonly string[] = ["MOSS"];

/** Every title some spot reserves for the `moss` tree, folded. */
export function reservedTitles(): ReadonlySet<string> {
  return new Set(SPOTS.flatMap((s) => s.reserved?.titles ?? []).map(foldTitle));
}

/** Whether a plugin outside the `moss` tree may not be named so: it reads as a reserved title or as MOSS itself. */
export function isReservedPluginName(name: string): boolean {
  const folded = foldTitle(name);
  return reservedTitles().has(folded) || RESERVED_PLUGIN_NAMES.some((n) => foldTitle(n) === folded);
}

/** Whether a keyed spot's entry key covers a key: exact, or a `*` pattern after the exact ones (§5.5). */
export function keyMatches(entryKey: string | undefined, key: string): boolean {
  if (entryKey === undefined) return true;
  if (!entryKey.endsWith("*")) return entryKey === key;
  return key.startsWith(entryKey.slice(0, -1));
}

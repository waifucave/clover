// The UI spot catalog (spec §5.3 "App core points", §5.5 "UI spots"). The default shell declares the well-known spots;
// a plugin that declares one of these names must use the catalog's declaration, or it is refused (§5.4). A replacement
// for a container should declare the container's own spots, or what fills them waits.
//
// Each spot lists its shape, who declares it, whether it sits inside a bot's tab (a bot's plugin fills only those,
// §5.5), the capabilities its props carry data for (`needs`), the keys that can't be hidden (`keep`), the keys it offers
// to `when` (`context`), the fields its entries carry beyond the `ui` entry's own (checked here), and its props.
//
// PROVISIONAL for lanes E (the app runtime, `<Spot>`) and F (the shell that declares them): the names, shapes, keys,
// `needs` and `keep` come from the spec; the props are the least each spot obviously hands over, for E and F to settle
// at E-M1 and F-M2 through the controller.
import { z } from "zod";
import { utf16 } from "@waifucave/clover-protocol";
import { HandlerName, Path, Text } from "../manifest/fields";

export interface SpotInfo {
  readonly name: string;
  readonly shape: "single" | "list" | "keyed";
  /** Who declares it: the app's plugin runtime (a core point), or a bundled part of `clover`. */
  readonly declaredBy: "app" | "shell" | "settings" | "bot-tab" | "bot-stage" | "composer" | "conversation" | "file-view" | "island" | "pill";
  /** Inside a bot's tab, where a bot's own plugin may add UI (§5.5). */
  readonly inBotTab: boolean;
  /** For a keyed spot, the keys the spec names (an entry may still use any key, and `*` patterns). */
  readonly keys?: readonly string[];
  readonly keep?: readonly string[];
  readonly needs?: readonly string[];
  readonly context?: readonly string[];
  /** For a keyed spot: a key no plugin fills shows the declaring part's placeholder, which offers to find a plugin
   *  for it (lane F's request): the plugins page, searched for that spot and key. */
  readonly placeholder?: true;
  /** Entry ids and titles only the bundled `clover` tree may use here (lane G's review: a third-party island tab can't
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
export const MAIN_ROUTES = ["bot", "agent", "settings", "plugins", "app"] as const;

export const SPOTS: readonly SpotInfo[] = [
  // The app's core points (§5.3).
  { name: "app.root", shape: "single", declaredBy: "app", inBotTab: false, fields: none, props: none,
    doc: "The main window's root: the shell, which declares every other spot." },
  { name: "app.surface", shape: "list", declaredBy: "app", inBotTab: false, context: ["surface", "os"], fields: titledOpt,
    props: z.object({ surface: z.string() }),
    doc: "Top-level floating windows, such as the island and the Dispatch pill; `window` says how they float." },
  { name: "bot.tab", shape: "keyed", declaredBy: "app", inBotTab: true, context: ["bot"], fields: none,
    props: z.object({ bot: BotRef }),
    doc: "Each bot's tab, keyed by bot; an entry with no key fills every bot without one of its own, except in a bot's own plugin, where a keyless entry takes that bot's id as its key." },
  // The shell's spots (`app.root`).
  { name: "sidebar", shape: "single", declaredBy: "shell", inBotTab: false, fields: none, props: none, doc: "The sidebar." },
  { name: "sidebar.bot", shape: "keyed", declaredBy: "shell", inBotTab: false, context: ["bot"], fields: none,
    props: z.object({ bot: BotRef, selected: z.boolean(), state: z.string(), needsYou: z.object({ cards: z.number().int(), questions: z.number().int() }) }),
    doc: "A bot's row in the sidebar, keyed by bot: its state and what waits for the user." },
  { name: "sidebar.app", shape: "list", declaredBy: "shell", inBotTab: false,
    fields: z.object({ title: Text, icon: Path, opens: utf16(128, 1) }), props: none,
    doc: "App buttons in the sidebar; `opens` names the `main` and `panel` key it shows." },
  { name: "main", shape: "keyed", declaredBy: "shell", inBotTab: false, keys: MAIN_ROUTES, fields: none,
    props: z.object({ route: z.string(), params: z.record(z.string(), z.string()) }),
    doc: "The main area, keyed by route: bot, agent, settings, plugins, app." },
  { name: "panel", shape: "keyed", declaredBy: "shell", inBotTab: false, context: ["session"], placeholder: true, fields: titledOpt,
    props: z.object({ app: z.string(), session: z.string().optional(), bot: z.string().optional() }),
    doc: "The panel host, keyed by panel: each panel (session, terminal, diff, files, browser) is a plugin of its own, and replaceable. A panel for some sessions only says so with `when.session` (the code-only panels: `\"coding\"`); a key no plugin fills shows the host's placeholder." },
  { name: "panel.view", shape: "keyed", declaredBy: "shell", inBotTab: false, fields: titled,
    props: z.object({ view: z.string(), session: z.string().optional() }),
    doc: "The panel's contents: the browser, and later the diff view, editor, file tree and terminal." },
  { name: "settings.section", shape: "list", declaredBy: "settings", inBotTab: false, fields: titled, props: none,
    doc: "A section of the settings screen, which the settings part (`main` key `settings`) declares." },
  { name: "status", shape: "list", declaredBy: "shell", inBotTab: false, fields: titledOpt, props: none,
    doc: "The shell's status bar; the inherited `tile` becomes an entry here (§12)." },
  // A bot's tab (`bot.tab`).
  { name: "bot.header", shape: "single", declaredBy: "bot-tab", inBotTab: true, context: ["bot"], fields: none,
    props: z.object({ bot: BotRef }), doc: "The tab's header." },
  { name: "bot.header.action", shape: "list", declaredBy: "bot-tab", inBotTab: true, context: ["bot"], fields: titled,
    props: z.object({ bot: BotRef }), doc: "Buttons in the tab's header." },
  { name: "bot.stage", shape: "single", declaredBy: "bot-tab", inBotTab: true, context: ["bot"], fields: none,
    props: z.object({ bot: BotRef }), doc: "The stage, where the avatar stands." },
  { name: "bot.side", shape: "single", declaredBy: "bot-tab", inBotTab: true, context: ["bot"], fields: none,
    props: z.object({ bot: BotRef }), doc: "The tab's side area." },
  { name: "conversation", shape: "single", declaredBy: "bot-tab", inBotTab: true, context: ["bot"], needs: ["conversation.read"], fields: none,
    props: z.object({ bot: BotRef, session: z.string() }), doc: "The conversation view." },
  { name: "composer", shape: "single", declaredBy: "bot-tab", inBotTab: true, context: ["bot"], fields: none,
    props: z.object({ bot: BotRef, session: z.string() }),
    doc: "The composer; a send counts as the user's only on a real key press or click (§5.5)." },
  // Inside the tab's parts.
  { name: "avatar", shape: "keyed", declaredBy: "bot-stage", inBotTab: true, keys: ["vrm", "live2d"], context: ["bot"], fields: none,
    props: z.object({ bot: BotRef, file: z.string(), format: z.string(), speaking: z.boolean(), speech: z.looseObject({}).optional() }),
    doc: "Draws the bot's avatar, keyed by the avatar file's format (`vrm`, `live2d`, or a plugin's own; `AVATAR_FORMATS`), and lip-syncs it from `speech` (a `SpeechFeed`)." },
  { name: "composer.action", shape: "keyed", declaredBy: "composer", inBotTab: true, context: ["bot"], fields: titledOpt,
    props: z.object({ bot: BotRef, session: z.string() }), doc: "The composer's buttons, keyed by action id." },
  { name: "conversation.message", shape: "keyed", declaredBy: "conversation", inBotTab: true, keys: MESSAGE_KINDS, keep: ["approval"],
    needs: ["conversation.read"], context: ["bot"], fields: none, props: z.object(inConversation),
    doc: "One message, keyed by kind; the `approval` cell can't be hidden. The `tool` cell gets a run of calls." },
  { name: "conversation.message.extra", shape: "list", declaredBy: "conversation", inBotTab: true, needs: ["conversation.read"], context: ["bot"],
    fields: none, props: z.object(inConversation), doc: "Add-ons under each message." },
  { name: "tool.result", shape: "keyed", declaredBy: "conversation", inBotTab: true, needs: ["conversation.read"], context: ["bot"], fields: none,
    props: z.object({ ...inConversation, tool: z.string() }),
    doc: "A tool's result, keyed by tool name (`mcp__blender__*`); `item` is the one call." },
  { name: "menu.message", shape: "list", declaredBy: "conversation", inBotTab: true, needs: ["conversation.read"], context: ["bot"], fields: titled,
    props: z.object(inConversation), doc: "Items in a message's menu." },
  { name: "file.preview", shape: "keyed", declaredBy: "file-view", inBotTab: true, fields: none,
    props: z.object({ path: z.string(), mediaType: z.string() }),
    doc: "A file's preview wherever one shows, keyed by media type (`image/*`); in a bot's plugin, only inside its tab." },
  // Surfaces.
  { name: "island.tab", shape: "list", declaredBy: "island", inBotTab: false, context: ["surface"],
    fields: z.object({ title: Text, icon: Path.optional(), size: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).optional(), idle: z.boolean().optional(), attention: z.enum(["never", "badge", "expand"]).optional() }),
    props: z.object({ expanded: z.boolean() }), reserved: { ids: ["needs-you"], titles: ["Needs you"] },
    doc: "A tab of the island, such as Needs you, Devices or Usage. The island labels a third-party tab with its plugin's name, and only the `clover` tree's tabs raise the strip's attention." },
  { name: "pill.target", shape: "list", declaredBy: "pill", inBotTab: false, context: ["surface"], fields: titled.extend({ handler: HandlerName }), props: none,
    doc: "Something the Dispatch pill can message besides the bots: `handler` (a `PillTargetHandler`) gets the user's words. The pill names it with its plugin's name, and leaves out one titled as a bot." },
];

export const SPOT_NAMES: ReadonlySet<string> = new Set(SPOTS.map((s) => s.name));
export function spotInfo(name: string): SpotInfo | undefined {
  return SPOTS.find((s) => s.name === name);
}

/** Letters from other scripts that read as Latin ones (a short table after Unicode's confusables, UTS #39), and the
 *  digits and strokes that read as letters. */
const CONFUSABLES: Readonly<Record<string, string>> = Object.fromEntries([
  // Cyrillic
  ..."АaВbЕeКkМmНhОoРpСcТtХxУyІiЈjЅsҮyҺhӀlԚqԜwаaеeоoрpсcуyхxіiјjѕsԁdһhӏlԛqԝwүyёeїi".match(/../gu)!.map((p) => [...p] as [string, string]),
  // Greek
  ..."ΑaΒbΕeΖzΗhΙiΚkΜmΝnΟoΡpΤtΥyΧxαaβbεeιiκkνvοoρpτtυuχxγyωw".match(/../gu)!.map((p) => [...p] as [string, string]),
  // Latin lookalikes, Armenian, digits and strokes
  ..."ıiɩiɑaɡgʏyℓlǀlօoսuցgհhոn0o1l|l".match(/../gu)!.map((p) => [...p] as [string, string]),
]);
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\p{Cf}]/gu;

/** A title as reserved titles, plugin names that could pose as them, and bot names compare it (#179's review): NFKC
 *  (width folded), invisible characters dropped (zero-width spaces and joiners, bidi marks, variation selectors), each
 *  letter's confusable skeleton (a Cyrillic "о" is "o"), accents dropped, case folded, and every run of anything but
 *  letters and digits one space. Folding too much only reserves more. */
export function foldTitle(title: string): string {
  const visible = title.normalize("NFKC").replace(INVISIBLE, "");
  const skeleton = [...visible].map((ch) => CONFUSABLES[ch] ?? ch).join("");
  return skeleton.normalize("NFD").replace(/\p{M}/gu, "").toUpperCase().toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Names only the bundled `clover` tree's plugins may have (lane G's ask): the app's own, beside the titles spots
 *  reserve. */
export const RESERVED_PLUGIN_NAMES: readonly string[] = ["Clover"];

/** Every title some spot reserves for the `clover` tree, folded. */
export function reservedTitles(): ReadonlySet<string> {
  return new Set(SPOTS.flatMap((s) => s.reserved?.titles ?? []).map(foldTitle));
}

/** Whether a plugin outside the `clover` tree may not be named so: it reads as a reserved title or as Clover itself. */
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

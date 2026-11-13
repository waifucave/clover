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
//            bot editor, the layout patches the user switches off in one bot's tab from the bot editor, a plugin's own
//            settings from the settings part);
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
//   held      a call that counts only while a hold the user's own press opened is live (push-to-talk's `voice.listen`: the
//             composer's `listenStart` took the gesture, listen.ts keeps the hold, and the shell's pieces ride it).
//   card      trust-changing (levels, devices, the main computer): never on this route.
//   unserved  the daemon has no such method.
// `card.answer` and `card.confirm` are on no list: a card is answered only on the sealed path.
import { TopPluginId } from "@waifucave/clover-protocol";
import { displayText } from "@waifucave/clover-plugin-sdk/plain";
import { resend } from "./resend";
import { messageAction } from "./message-action";
import type { ListenHolds } from "./listen";
/** The bundled tree whose notices are the app's own: never muted. */
const CLOVER_TREE = "clover";

export type Disposition = "read" | "settings" | "gesture" | "held" | "card" | "unserved";

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
/** The conversation view: the bundled conversation plugin's part. */
export const CONVERSATION_PART = "clover/conversation";

/** The character stage: the bundled character plugin's part. */
export const CHARACTER_PART = "clover/character";

/** The window's shell: the bundled shell plugin's part, the document that records for push-to-talk. */
export const SHELL_PART = "clover/shell";

/** Clover Voice's part: its Settings › Voice section. */
export const VOICE_PART = "clover/voice";

export const TREE_CALLS: Readonly<Record<string, TreeCall>> = {
  // Class 1: the core's settings and the user layers.
  "ui.settings": { disposition: READ },
  // The Settings page's own choices, each by the user's click or key press (one call per gesture), and only the keys its
  // controls write (`settingsParams`): the light / dark / system choice, the theme plugin, the language.
  // The character stage's mute is the one other write: `voice.speakReplies` only (`voiceMuteParams`), by the user's click;
  // Settings › Voice's "Speak replies" switch (Clover Voice's part) writes the same one key the same way.
  // The bot editor's one write: which plugins' layout patches the user switched off in that bot's tab (`tabPatchParams`),
  // merged by main into the stored lists, the rest kept.
  "ui.set": { disposition: "settings", part: ["clover/settings", CHARACTER_PART, BOT_EDITOR_PART, VOICE_PART], gesture: ["clover/settings", CHARACTER_PART, BOT_EDITOR_PART, VOICE_PART] },
  // The character stage's stop button: the user's click ends that bot's speech (the core ends the utterance).
  "voice.stop": { disposition: "gesture", part: CHARACTER_PART },
  // The shell's pieces of a recording the user is holding (push-to-talk): audio and whether it is the last, nothing else. Main
  // names the bot and the utterance, numbers the pieces and refuses any with no hold open (`ListenHolds.piece`); the hold
  // itself began with the composer's `listenStart`, inside the user's press.
  "voice.listen": { disposition: "held", part: SHELL_PART },
  // The shell's player saying an utterance it was sent ended here (`voicePlayedParams`: the bot and the utterance, nothing
  // else): the core lets the voice mode's queue go on, ignoring one it isn't waiting on; it never starts a sound.
  "voice.played": { disposition: READ, part: SHELL_PART },
  // The speak button under a bot's reply (the conversation view): the user's click asks to hear that one reply. The page
  // names the session and the reply's seq; the core reads the text from the log.
  "voice.speak": { disposition: "gesture", part: CONVERSATION_PART },
  // Settings › Voice (Clover Voice's part) reads and writes its own settings too (which voice is active here), the
  // write by the user's choice in its list.
  "plugin.settings.get": { disposition: READ, part: [SETTINGS_PART, PLUGINS_PART, VOICE_PART], anyId: [PLUGINS_PART] },
  "plugin.settings.set": { disposition: "settings", part: [SETTINGS_PART, PLUGINS_PART, VOICE_PART], gesture: [PLUGINS_PART, VOICE_PART], anyId: [PLUGINS_PART] },
  // A bot's user layer from the bot editor, with the user's click (the layer door would raise a card). The avatar's two
  // fields (`avatar`, `avatarCredit`) are the character plugin's section's alone, and the editor writes none of them
  // (`userLayerWhy`).
  "bot.setUserLayer": { disposition: "gesture", part: [BOT_EDITOR_PART, CHARACTER_PART] },
  // A model the user picked in main's own dialog, copied into the user's avatars for a bot and made its avatar. Only a
  // pick token of that use, only an existing bot's id, only the character plugin's avatar section, one call per click
  // (`botImport`).
  "bot.importAvatar": { disposition: "gesture", part: CHARACTER_PART },
  // "Try again" on a turn that ended in an error: the page names the session and nothing else; main reads that session's
  // log, and sends the user's own message that began the failed turn again, as the user (`resend.ts`). It starts a model
  // turn like the composer's own send, so it is the user's click, one call per click.
  "session.resend": { disposition: "gesture", part: CONVERSATION_PART },
  // A plugin's small button in a message's row (`conversation.message.action`, data the conversation draws): the page names
  // the entry, the session and the message's seq; main finds the active entry and runs its own handler (`message-action.ts`).
  // App-side only: no core method of this name. The user's click, one call per click.
  "conversation.messageAction": { disposition: "gesture", part: CONVERSATION_PART },
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
  // Settings' Tools tab: what each plugin tool may do (always allow, ask, always block) and the card rules saved for one bot.
  // A value decides when a card is raised, so setting one or taking one back is the user's own press, in Settings alone.
  "tool.permissions": { disposition: READ, part: SETTINGS_PART },
  "tool.setPermission": { disposition: "settings", part: SETTINGS_PART, gesture: true },
  "tool.takeBackRule": { disposition: "settings", part: SETTINGS_PART, gesture: true },
  "plugin.auth.list": { disposition: READ, part: PLUGINS_PART },
  "plugin.dev.list": { disposition: READ, part: PLUGINS_PART },
  // The files and folders the user picked for a plugin (its page's "Files it may open"), and the computers the page lists to tick.
  "plugin.grant.list": { disposition: READ, part: PLUGINS_PART },
  // Read by every bundled part that shows where it is or where to send (the shell's and the sidebar's account row, the composer's
  // "where" picker, Settings' and the panel's computers), not only the page that listed it to tick.
  "computer.list": { disposition: READ, part: [PLUGINS_PART, SETTINGS_PART, "clover/shell", "clover/sidebar", "clover/composer", "clover/panel"] },
  // Every command with what became of its default key (bound, or the app's, too bare, or shared): the detail's "Keys" lines.
  "command.list": { disposition: READ, part: PLUGINS_PART },
  // Lane D's notification mutes, per plugin: the list is a read; muting or unmuting one is the user's click.
  "notify.mutes": { disposition: READ, part: PLUGINS_PART },
  // main's own dialog, for the use the page names: the Plugins page's folders (an install, a development folder) and the
  // avatar section of the character plugin (`bot.importAvatar`). The token it issues is redeemable by that one use only (`PICK_USES`).
  "ui.pick": { disposition: "gesture", part: [PLUGINS_PART, CHARACTER_PART] },
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
  // The user's own choices on a plugin's page: take a picked file or folder back, where it works (bots, agents), the computers
  // it runs on, and that they are 18 or older (before an adult plugin is switched on).
  "plugin.grant.remove": PAGE,
  "plugin.setScope": PAGE,
  "plugin.setComputers": PAGE,
  "plugin.confirmAdult": PAGE,
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
 *  `plugin.dev.add`, or the character plugin's `bot.importAvatar`. The page names its use when it asks for the pick and main
 *  issues the token for that use alone: no token works for two. */
export type PickUse = "plugin.install" | "plugin.dev.add" | "bot.importAvatar";

/** The uses each part may ask a pick for. */
const PICK_USES: Readonly<Record<string, readonly PickUse[]>> = {
  [PLUGINS_PART]: ["plugin.install", "plugin.dev.add"],
  [CHARACTER_PART]: ["bot.importAvatar"],
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

/** The shell's `voice.played`: a bot and an utterance, short strings, nothing else. */
export function voicePlayedParams(params: unknown): { params: { bot: string; utterance: string } } | { why: string } {
  const p = (params ?? {}) as { bot?: unknown; utterance?: unknown };
  if (typeof p.bot !== "string" || p.bot === "" || p.bot.length > 128) return { why: "which bot?" };
  if (typeof p.utterance !== "string" || p.utterance === "" || p.utterance.length > 128) return { why: "which utterance?" };
  return { params: { bot: p.bot, utterance: p.utterance } };
}

/** The stage's `ui.set`: `voice.speakReplies` as a boolean and nothing else. */
export function voiceMuteParams(params: unknown): { params: { patch: { voice: { speakReplies: boolean } } } } | { why: string } {
  const patch = params !== null && typeof params === "object" ? (params as { patch?: unknown }).patch : undefined;
  const voice = patch !== null && typeof patch === "object" ? (patch as { voice?: unknown }).voice : undefined;
  const on = voice !== null && typeof voice === "object" ? (voice as { speakReplies?: unknown }).speakReplies : undefined;
  if (typeof on !== "boolean" || Object.keys(patch as object).length !== 1 || Object.keys(voice as object).length !== 1) return { why: "the stage sets only whether replies are spoken" };
  return { params: { patch: { voice: { speakReplies: on } } } };
}

const BOT_ID = /^[a-z][a-z0-9-]{0,80}$/;
const ENTRY_REF = /^[a-z][a-z0-9/-]*(#[A-Za-z0-9._-]+)?$/;

const SPOT_NAME = /^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$/;

/** The bot editor's `ui.set`, one of two shapes and nothing else, for one bot:
 *  * its switched-off layout patches, `{ patch: { lists: [{ spot: "bot.tab", bot, order: [], hidden }] } }`;
 *  * the plugins' hides it switched off in one spot (its "Hidden by plugins"), `{ patch: { lists: [{ spot, bot,
 *    order: [], hidden: [], shown }] } }`: main sets only that list's `shown`, keeping the user's order and hidden.
 *  Main merges either into the stored lists (`mergeTabPatchList`, `mergeShownList`). */
export function editorListParams(params: unknown): { bot: string; spot: string; hidden?: string[]; shown?: string[] } | { why: string } {
  const no = { why: "the bot editor sets only which layout patches and which plugins' hides are off in one bot's tab" };
  const patch = params !== null && typeof params === "object" ? (params as { patch?: unknown }).patch : undefined;
  if (patch === null || typeof patch !== "object" || Object.keys(patch).length !== 1) return no;
  const lists = (patch as { lists?: unknown }).lists;
  if (!Array.isArray(lists) || lists.length !== 1 || lists[0] === null || typeof lists[0] !== "object") return no;
  const l = lists[0] as Record<string, unknown>;
  if (l.spot === "bot.tab") {
    const t = tabPatchParams(params);
    return "why" in t ? t : { bot: t.bot, spot: "bot.tab", hidden: t.hidden };
  }
  if (Object.keys(l).some((k) => !["spot", "bot", "order", "hidden", "shown"].includes(k))) return no;
  if (typeof l.spot !== "string" || l.spot.length > 128 || !SPOT_NAME.test(l.spot)) return no;
  if (typeof l.bot !== "string" || !BOT_ID.test(l.bot)) return { why: "which bot?" };
  if (l.order !== undefined && !(Array.isArray(l.order) && l.order.length === 0)) return no;
  if (l.hidden !== undefined && !(Array.isArray(l.hidden) && l.hidden.length === 0)) return no;
  if (!Array.isArray(l.shown) || l.shown.length > 256 || !l.shown.every((h) => typeof h === "string" && h.length <= 300 && ENTRY_REF.test(h))) return no;
  return { bot: l.bot, spot: l.spot, shown: [...new Set(l.shown as string[])] };
}

/** The stored lists with one bot's list for a spot keeping its order and hidden, its `shown` replaced (the entry goes when
 *  nothing is left in it); every other list kept. */
export function mergeShownList(lists: unknown, spot: string, bot: string, shown: readonly string[]): unknown[] {
  const all = Array.isArray(lists) ? lists : [];
  const mine = (l: unknown) => l !== null && typeof l === "object" && (l as { spot?: unknown }).spot === spot && (l as { bot?: unknown }).bot === bot;
  const was = all.find(mine) as { order?: string[]; hidden?: string[] } | undefined;
  const kept = all.filter((l) => !mine(l));
  const order = was?.order ?? [];
  const hidden = was?.hidden ?? [];
  return order.length === 0 && hidden.length === 0 && shown.length === 0 ? kept : [...kept, { spot, bot, order, hidden, ...(shown.length > 0 ? { shown: [...shown] } : {}) }];
}

/** The `bot.tab` shape of the bot editor's `ui.set` (see `editorListParams`). */
export function tabPatchParams(params: unknown): { bot: string; hidden: string[] } | { why: string } {
  const no = { why: "the bot editor sets only which layout patches and which plugins' hides are off in one bot's tab" };
  const patch = params !== null && typeof params === "object" ? (params as { patch?: unknown }).patch : undefined;
  if (patch === null || typeof patch !== "object" || Object.keys(patch).length !== 1) return no;
  const lists = (patch as { lists?: unknown }).lists;
  if (!Array.isArray(lists) || lists.length !== 1 || lists[0] === null || typeof lists[0] !== "object") return no;
  const l = lists[0] as Record<string, unknown>;
  if (Object.keys(l).some((k) => !["spot", "bot", "order", "hidden"].includes(k)) || l.spot !== "bot.tab") return no;
  if (typeof l.bot !== "string" || !BOT_ID.test(l.bot)) return { why: "which bot?" };
  if (l.order !== undefined && !(Array.isArray(l.order) && l.order.length === 0)) return no;
  if (!Array.isArray(l.hidden) || l.hidden.length > 256 || !l.hidden.every((h) => typeof h === "string" && h.length <= 300 && ENTRY_REF.test(h))) return no;
  return { bot: l.bot, hidden: [...new Set(l.hidden as string[])] };
}

/** The stored lists with one bot's `bot.tab` entry replaced (removed when nothing is off); every other list kept. */
export function mergeTabPatchList(lists: unknown, bot: string, hidden: readonly string[]): unknown[] {
  const kept = (Array.isArray(lists) ? lists : []).filter((l) => !(l !== null && typeof l === "object" && (l as { spot?: unknown }).spot === "bot.tab" && (l as { bot?: unknown }).bot === bot));
  return hidden.length === 0 ? kept : [...kept, { spot: "bot.tab", bot, order: [], hidden: [...hidden] }];
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
  if (method === "plugin.remove") return typeof p.id === "string" ? { params: { id: p.id, card: true, ...(p.deleteData === true ? { deleteData: true } : {}) } } : { why: "which plugin?" };
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
  /** The window's push-to-talk holds (listen.ts): `voice.listen` rides one; without it the call is refused. */
  listens?: Pick<ListenHolds, "piece">;
  /** The picked folders' tokens (the Plugins page's); absent, `ui.pick` and a picked install are refused. */
  tokens?: PickTokens;
  /** Main's native folder or file dialog over the window: the path chosen, or undefined when the user cancels. */
  pick?(windowId: number, kind: "folder" | "file", filters: readonly { name: string; extensions: string[] }[] | undefined, use: PickUse): Promise<string | undefined>;
  /** Opens the app's own key dialog (the core page "key") for a plugin's secret setting or `api-key` sign-in, checked
   *  as one here. */
  openKey?(target: KeyTarget): Promise<boolean>;
  /** The active entries of a spot the calling part declares, as its own `useSpotEntries` resolves them (main's runtime):
   *  where a message action's handler is found. */
  entries?(spot: string): readonly { ref: string; pluginId: string; fields: Readonly<Record<string, unknown>> }[];
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

/** The user-layer fields only the avatar section writes. */
const AVATAR_LAYER_FIELDS: readonly string[] = ["avatar", "avatarCredit"];

/** What a part may put in a `bot.setUserLayer` patch: the character plugin's avatar section writes the avatar's two
 *  fields and nothing else; the bot editor writes every other field and neither of those. */
function userLayerWhy(part: string, params: unknown): string | undefined {
  const patch = (params as { patch?: unknown } | null | undefined)?.patch;
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return "a change to a bot's layer is an object of fields";
  const keys = Object.keys(patch);
  if (keys.length === 0) return "a change to a bot's layer names a field";
  if (part === CHARACTER_PART) return keys.every((k) => AVATAR_LAYER_FIELDS.includes(k)) ? undefined : "the avatar section changes the avatar and its credit note only";
  return keys.some((k) => AVATAR_LAYER_FIELDS.includes(k)) ? "the avatar is set from the avatar section, not from here" : undefined;
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
  if (r.method === "voice.played") {
    const shaped = voicePlayedParams(r.params);
    if ("why" in shaped) throw r.refuse(shaped.why);
    return r.request("voice.played", shaped.params);
  }
  if (r.method === "ui.set" && (part === CHARACTER_PART || part === VOICE_PART)) {
    const shaped = voiceMuteParams(r.params);
    if ("why" in shaped) {
      r.log(`tree: ${part}: ui.set refused (${shaped.why})`);
      throw r.refuse(shaped.why);
    }
    return r.request("ui.set", shaped.params);
  }
  if (r.method === "voice.listen") {
    if (r.listens === undefined) throw r.refuse("this app can't record");
    return r.listens.piece(r.tree.windowId, r.params);
  }
  if (r.method === "voice.stop") {
    const bot = (r.params as { bot?: unknown } | null | undefined)?.bot;
    if (typeof bot !== "string" || bot === "" || bot.length > 128) throw r.refuse("which bot?");
    return r.request("voice.stop", { bot });
  }
  if (r.method === "ui.set" && part === BOT_EDITOR_PART) {
    const shaped = editorListParams(r.params);
    if ("why" in shaped) {
      r.log(`tree: ${part}: ui.set refused (${shaped.why})`);
      throw r.refuse(shaped.why);
    }
    const now = (await r.request("ui.settings", {})) as { lists?: unknown } | undefined;
    const lists = shaped.spot === "bot.tab" ? mergeTabPatchList(now?.lists, shaped.bot, shaped.hidden ?? []) : mergeShownList(now?.lists, shaped.spot, shaped.bot, shaped.shown ?? []);
    return r.request("ui.set", { patch: { lists } });
  }
  if (r.method === "bot.setUserLayer") {
    const why = userLayerWhy(part, r.params);
    if (why !== undefined) {
      r.log(`tree: ${part}: bot.setUserLayer refused (${why})`);
      throw r.refuse(why);
    }
  }
  if (r.method === "voice.speak") {
    const p = r.params as { session?: unknown; seq?: unknown } | null | undefined;
    if (typeof p?.session !== "string" || p.session === "" || p.session.length > 128 || !Number.isSafeInteger(p.seq) || (p.seq as number) < 0) throw r.refuse("which reply?");
    return r.request("voice.speak", { session: p.session, seq: p.seq });
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
  if (r.method === "session.resend") return resend(r, part);
  if (r.method === "conversation.messageAction") return messageAction(r, part);
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

/** The avatar pick's filter: a .zip when a format imports one, and each single file a format imports, from the core's
 *  `bot.avatarFormats`. None (any file) when the core doesn't say; the import itself refuses what isn't a model. */
async function avatarFilters(r: TreeRoute): Promise<{ name: string; extensions: string[] }[] | undefined> {
  const got = (await r.request("bot.avatarFormats", {}).catch(() => undefined)) as { formats?: { accepts?: unknown; files?: unknown }[] } | undefined;
  const exts: string[] = [];
  const add = (e: string) => { if (/^[A-Za-z0-9]{1,10}$/.test(e) && !exts.includes(e)) exts.push(e); };
  const formats = Array.isArray(got?.formats) ? got!.formats : [];
  if (formats.some((f) => Array.isArray(f.accepts) && f.accepts.includes("zip"))) add("zip");
  // A dialog filters by the last part of a name: `.model3.json` is `json`.
  for (const f of formats) for (const e of Array.isArray(f.files) ? f.files : []) if (typeof e === "string") add(e.split(".").pop() ?? "");
  return exts.length === 0 ? undefined : [{ name: "Avatar", extensions: exts.slice(0, 16) }];
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
  // An avatar is what the installed renderers import (the core's `bot.avatarFormats`): main sets the dialog's filter,
  // not the page.
  const filters = use === "bot.importAvatar" ? await avatarFilters(r) : Array.isArray(p.filters)
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

/** Text a page shows that a file, a model or the core wrote: the shared cleaner (`@waifucave/clover-plugin-sdk/plain`),
 *  capped; empty when nothing is left. */
export const neutralised = (text: string, max: number): string => displayText(text, max) ?? "";

/** The last part of a picked path, neutralised and capped: the only thing of it a page ever gets. */
function pickedName(path: string): string {
  return neutralised(path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "", 80);
}

/** The most a refusal's reason shows a page. */
const REASON_MAX = 300;

/** `bot.importAvatar` from the character plugin's avatar section: `{id, path: <token>}`. The id must be a bot main's own listing holds; the
 *  token is the one `ui.pick` issued this part for this use, spent here; the daemon gets only `{id, path}` with the real
 *  path, and the page gets back `{format, files, bytes, credit?}` (the model's own note as plain text, 300 characters): no path, no listing, and a refusal's plain reason with any path
 *  in it cut out. The core's call already makes the imported model the bot's avatar. */
async function botImport(r: TreeRoute, part: string): Promise<{ format: string; name?: string; files: number; bytes: number; credit?: string }> {
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
  const g = (got ?? {}) as { format?: unknown; name?: unknown; files?: unknown; bytes?: unknown; credit?: unknown };
  const count = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0);
  // The model's own note, from a file the page's user picked: plain text again here (no control or bidi characters, 300).
  const credit = typeof g.credit === "string" ? neutralised(g.credit, 300) : "";
  // The format is the renderer's own id (`avatar.formats`) and its name in English: plain text either way.
  const format = typeof g.format === "string" && /^[a-z0-9-]{1,32}$/.test(g.format) ? g.format : "live2d";
  const name = typeof g.name === "string" ? neutralised(g.name, 200) : "";
  return { format, ...(name === "" ? {} : { name }), files: count(g.files), bytes: count(g.bytes), ...(credit === "" ? {} : { credit }) };
}

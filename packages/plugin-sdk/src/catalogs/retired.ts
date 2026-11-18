// Names the platform had and no longer has, each with what took its place, so a manifest that still asks for one fails
// closed with a message that says where to go (spec revision 19, §5.4 "There is no avatar in the platform", G7). The
// avatar left the platform for the bundled avatar plugin (`moss/character`), which declares its own points.

/** A retired name and what replaced it, in a sentence a plugin's author reads. */
export interface RetiredName {
  readonly name: string;
  readonly replacedBy: string;
}

const PACKS = "the avatar plugin's own point `moss.character.packs` (an entry: a model file, its format and a portrait)";
const RENDERERS = "the avatar plugin's own UI spot `moss.character.renderer` (keyed by format) and its point `moss.character.formats`";
const FIGURE = "the avatar plugin's own point `moss.character.figure`: an entry in it, named on your OK card, sends cues with `points.send` and hears the figure's names with `points.onMessage`";
const SPEECH = "MOSS Voice's point `moss.voice.speech`: an entry in it, named on your OK card, hears the mouth's levels with `points.onMessage`";

/** What replaced a point of a bot's tab, in MOSS Code's window: `instead`. */
const NO_BOT_TAB_FOR = (instead: string): string => `${instead}; bots have no tab in MOSS Code's window (MOSS draws them in its own)`;

/** Capabilities that are gone. */
export const RETIRED_CAPABILITIES: readonly RetiredName[] = [
  { name: "avatar.read", replacedBy: FIGURE },
  { name: "avatar.control", replacedBy: FIGURE },
  { name: "avatar.control.all", replacedBy: `${FIGURE}; for speech, ${SPEECH}` },
  { name: "avatar.report", replacedBy: RENDERERS },
  { name: "avatar.watch", replacedBy: FIGURE },
  { name: "avatar.cue", replacedBy: FIGURE },
  { name: "bots.avatar", replacedBy: `${PACKS}; the figure is picked in the avatar plugin's own Settings section` },
];

/** Points, spots and manifest fields that are gone. */
export const RETIRED_POINTS: readonly RetiredName[] = [
  { name: "avatar.formats", replacedBy: "the avatar plugin's own point `moss.character.formats`" },
  { name: "avatar.packs", replacedBy: PACKS },
  { name: "avatar", replacedBy: RENDERERS },
  { name: "bot.stage", replacedBy: "the avatar plugin, which shows the figure in a panel of MOSS Code's window and, when turned on, on the screen" },
  { name: "bot.stage.action", replacedBy: "a control of your own plugin's parts; the avatar plugin's figure takes no other plugin's controls" },
  // A bot's tab and everything placed in it (spec revision 19, §5.5, items 99 and 100, G8): a bot has no tab in a plugin
  // window. MOSS draws its bots in a window of its own; MOSS Code's window shows sessions.
  { name: "bot.tab", replacedBy: NO_BOT_TAB_FOR("a session's tab: `conversation`, `composer`, `composer.action`, `conversation.message.*` and `tool.result`") },
  { name: "bot.header", replacedBy: NO_BOT_TAB_FOR("a panel of your own (`panel` with a key of your own)") },
  { name: "bot.header.action", replacedBy: NO_BOT_TAB_FOR("`composer.action` with a key of your own, or a panel of your own") },
  { name: "bot.side", replacedBy: NO_BOT_TAB_FOR("a panel of your own (`panel` with a key of your own)") },
  { name: "bot.controls", replacedBy: NO_BOT_TAB_FOR("a panel of your own (`panel` with a key of your own)") },
  { name: "bar", replacedBy: NO_BOT_TAB_FOR("the window's own title bar, which the shell draws; a theme's `shell` tokens dress it") },
  { name: "chrome.title", replacedBy: NO_BOT_TAB_FOR("the window's own title bar, which the shell draws") },
  { name: "chrome.action", replacedBy: NO_BOT_TAB_FOR("the window's own title bar, which the shell draws") },
  { name: "chrome.actions", replacedBy: NO_BOT_TAB_FOR("the window's own title bar, which the shell draws") },
  { name: "chrome.sidebar", replacedBy: NO_BOT_TAB_FOR("the window's own title bar, which the shell draws") },
  { name: "chrome.drag", replacedBy: NO_BOT_TAB_FOR("the window's own title bar, which the shell draws") },
  { name: "chrome.panels", replacedBy: NO_BOT_TAB_FOR("the panels the shell places") },
  { name: "sidebar.bot", replacedBy: NO_BOT_TAB_FOR("`sidebar.app` (a button of your own in the sidebar)") },
  { name: "bot.editor.section", replacedBy: NO_BOT_TAB_FOR("`settings.section` (a section of Settings)") },
];

/** A bot's own figure in its manifest (`contributes.bot.avatar`). */
export const RETIRED_BOT_AVATAR: RetiredName = { name: "contributes.bot.avatar", replacedBy: PACKS };

/** A layout for bots' tabs: a bot's own (`contributes.bot.layout`) or a patch (a `ui` entry's `layout`). */
export const RETIRED_TAB_LAYOUT: RetiredName = { name: "layout", replacedBy: NO_BOT_TAB_FOR("a theme (its `shell` tokens dress the window) or a panel of your own") };

export function retiredCapability(name: string): RetiredName | undefined {
  return RETIRED_CAPABILITIES.find((r) => r.name === name);
}

export function retiredPoint(name: string): RetiredName | undefined {
  return RETIRED_POINTS.find((r) => r.name === name);
}

/** The refusal's words for a retired name. */
export function retiredMessage(r: RetiredName): string {
  return `\`${r.name}\` is retired: use ${r.replacedBy}`;
}

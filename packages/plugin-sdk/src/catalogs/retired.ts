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
];

/** A bot's own figure in its manifest (`contributes.bot.avatar`). */
export const RETIRED_BOT_AVATAR: RetiredName = { name: "contributes.bot.avatar", replacedBy: PACKS };

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

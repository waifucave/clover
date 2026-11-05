// The tokens Clover's base theme sets (spec §5.5). Lane B's catalog in `packages/plugin-sdk`
// (`src/catalogs/tokens.ts`) is the source of truth: these are its names, its grammar and its CSS
// property mapping, mirrored here until the parts import the SDK. The base theme must give every token
// a value in both appearances.
//
// Names: dot-separated segments of lowercase letters and digits, each starting with a letter
// (`color.text.muted`). A token is a CSS custom property inside the part a theme dresses: `--clover-`
// and the name with its dots as hyphens (`--clover-color-text-muted`). A plugin's own tokens live under
// the reserved group `plugin`: `plugin.<top-level id>.<name>`; the hyphens an id may hold become
// underscores (`plugin.mcp-blender.glow` → `--clover-plugin-mcp_blender-glow`), so the map stays one to
// one and no plugin can ever name a catalog token.
//
// `card.*` is the set sealed approval frames take (spec §5.5); keep it self-contained: a card value
// never derives from another token, so restyling the accent never silently restyles approval cards.

export type TokenType =
  | "color"
  | "dimension"
  | "fontFamily"
  | "fontWeight"
  | "number"
  | "duration"
  | "easing"
  | "shadow"
  /** A CSS background: a colour or a gradient. */
  | "paint";

export interface TokenSpec {
  readonly name: string;
  readonly type: TokenType;
  readonly doc: string;
}

const t = (name: string, type: TokenType, doc: string): TokenSpec => ({ name, type, doc });

export const TOKENS: readonly TokenSpec[] = [
  // Planes.
  t("color.canvas", "color", "The base plane: the sidebar and the app's background."),
  t("color.surface", "color", "The content plane: the conversation and settings pages."),
  t("color.raised", "color", "One step above the content: tool output, inner cards, code blocks."),
  t("color.control", "color", "Small controls: chips, toggle tracks, icon circles."),
  t("color.float", "color", "Anything floating above content: menus, popovers, palettes."),
  t("color.hairline", "color", "Dividers and rims on the canvas and the content plane."),
  t("color.hairline.raised", "color", "The same rule drawn on raised and control surfaces."),
  t("color.hover", "color", "A row's fill under the pointer."),
  t("color.selected", "color", "A selected row's fill. Navigation stays neutral: never the accent."),
  // Text.
  t("color.text", "color", "Body text."),
  t("color.text.secondary", "color", "Sidebar and secondary text."),
  t("color.text.muted", "color", "Quiet meta: timestamps, labels, trailing words."),
  t("color.text.placeholder", "color", "A field's placeholder."),
  t("color.text.inverse", "color", "Text on a text-coloured fill."),
  // Accent and meaning.
  t("color.accent", "color", "The brand accent: primary actions, focus, the send button."),
  t("color.accent.text", "color", "The accent carrying text, at 4.5:1 or more on the content plane."),
  t("color.accent.soft", "color", "A wash of the accent: a chosen chip, a highlighted mention."),
  t("color.accent.contrast", "color", "Text and glyphs on an accent fill."),
  t("color.attention", "color", "Needs you: a waiting card, a question for the user."),
  t("color.attention.text", "color", "Attention carrying text."),
  t("color.danger", "color", "Errors and actions that destroy something."),
  t("color.success", "color", "Done, connected, running."),
  t("color.diff.added", "color", "Lines a diff adds."),
  t("color.diff.removed", "color", "Lines a diff removes."),
  t("color.focus", "color", "The keyboard focus ring."),
  // Messages.
  t("bubble.user.background", "color", "The user's own message."),
  t("bubble.user.text", "color", "Text in the user's message."),
  t("bubble.bot.background", "color", "The bot's message. Clear by default: replies sit on the content plane."),
  t("bubble.bot.rim", "color", "The bot's message rim."),
  t("bubble.bot.text", "color", "Text in the bot's message."),
  t("bubble.radius", "dimension", "A message bubble's corner."),
  // The composer.
  t("composer.background", "color", "The composer's face."),
  t("composer.rim", "color", "The composer's hairline."),
  t("composer.text", "color", "What the user types."),
  t("composer.placeholder", "color", "The composer's placeholder."),
  t("composer.radius", "dimension", "The composer's corner."),
  // Sealed approval cards: the only tokens their frames take.
  t("card.background", "color", "An approval card's face."),
  t("card.text", "color", "What the card asks."),
  t("card.muted", "color", "The card's meta: the computer, the tool."),
  t("card.rim", "color", "The card's rim."),
  t("card.radius", "dimension", "The card's corner."),
  t("card.padding", "dimension", "The card's inset."),
  t("card.approve.background", "color", "The approve button."),
  t("card.approve.text", "color", "The approve button's label."),
  t("card.deny.background", "color", "The deny button."),
  t("card.deny.text", "color", "The deny button's label."),
  t("card.button.radius", "dimension", "The approve and deny buttons' corner."),
  t("card.font.family", "fontFamily", "The card's face."),
  t("card.font.size", "dimension", "The card's text size."),
  // Type.
  t("font.sans", "fontFamily", "The interface and body face: each OS's own."),
  t("font.serif", "fontFamily", "The serif accent."),
  t("font.mono", "fontFamily", "Code, paths and ids."),
  t("font.display", "fontFamily", "Bot names, greetings and the wordmark."),
  t("font.size.tiny", "dimension", "Timestamps and micro-labels."),
  t("font.size.caption", "dimension", "Small meta."),
  t("font.size.label", "dimension", "Labels."),
  t("font.size.control", "dimension", "Sidebar rows and controls."),
  t("font.size.body", "dimension", "Body text and typing."),
  t("font.size.code", "dimension", "Code, commands and paths in running text."),
  t("font.size.large", "dimension", "Large controls."),
  t("font.size.heading", "dimension", "Headings in a pane."),
  t("font.size.title", "dimension", "A page's title."),
  t("font.size.display", "dimension", "A greeting."),
  t("font.weight.regular", "fontWeight", "Regular."),
  t("font.weight.medium", "fontWeight", "Medium."),
  t("font.weight.semibold", "fontWeight", "Semibold."),
  t("font.weight.bold", "fontWeight", "Bold."),
  t("font.line.body", "number", "Body line height."),
  t("font.line.tight", "number", "Line height for one-line labels and headings."),
  // Shape and space.
  t("radius.small", "dimension", "Small corners: chips, rows."),
  t("radius.medium", "dimension", "Medium corners: buttons, fields."),
  t("radius.large", "dimension", "Large corners: panels, inner cards."),
  t("radius.huge", "dimension", "The largest corners: sheets, the stage."),
  t("radius.round", "dimension", "A capsule's end."),
  t("space.xs", "dimension", "4 on the grid."),
  t("space.s", "dimension", "8 on the grid."),
  t("space.m", "dimension", "12 on the grid."),
  t("space.l", "dimension", "16 on the grid."),
  t("space.xl", "dimension", "24 on the grid."),
  t("space.xxl", "dimension", "32 on the grid."),
  t("shadow.raised", "shadow", "A raised block's shadow."),
  t("shadow.float", "shadow", "Something floating: a menu, a popover."),
  // Motion.
  t("motion.fast", "duration", "A hover, a press."),
  t("motion.medium", "duration", "A state change."),
  t("motion.slow", "duration", "A part arriving."),
  t("motion.easing", "easing", "The default ease."),
  t("motion.spring.response", "number", "The surfaces' spring: seconds per oscillation."),
  t("motion.spring.damping", "number", "The surfaces' spring: damping fraction."),
  // The island and the Dispatch pill: black liquid shells over any desktop, dark whatever the
  // appearance (docs/claude/island.md, the Swift reference).
  t("island.surface", "color", "The island's black."),
  t("island.rim", "color", "A floating island card's hairline rim."),
  t("island.text", "color", "The island's words."),
  t("island.muted", "color", "The island's quiet words."),
  t("island.faint", "color", "The island's faintest words: positions, hints."),
  t("island.attention", "color", "Waiting for you: the hand and its count."),
  t("island.accept", "color", "The ✓ circle."),
  t("island.accept.text", "color", "The ✓ glyph."),
  t("island.refuse", "color", "The ✕ circle."),
  t("island.refuse.text", "color", "The ✕ glyph."),
  t("island.working", "color", "The working bolt."),
  t("island.success", "color", "A status that is well: running, connected."),
  t("island.danger", "color", "A status that is not: an error, a force quit."),
  t("island.option", "color", "An option row's fill."),
  t("island.option.hover", "color", "An option row's fill under the pointer."),
  t("island.card", "color", "An inner card inside the open island: a Needs-you request."),
  t("island.card.rim", "color", "That inner card's rim."),
  t("island.shadow", "shadow", "A floating island card's shadow."),
  t("pill.surface", "color", "The Dispatch pill's black."),
  t("pill.rim", "color", "The pill's hairline rim."),
  t("pill.text", "color", "What the user types into the pill."),
  t("pill.muted", "color", "The pill's quiet words."),
  t("pill.placeholder", "color", "The compact pill's placeholder."),
  t("pill.placeholder.typing", "color", "The typing pill's placeholder."),
  t("pill.send", "color", "The send and stop circle."),
  t("pill.send.glyph", "color", "The send and stop glyph."),
  t("pill.accessory", "color", "The ↗ and ⋯ circles."),
  t("pill.attention", "color", "A card's kind glyph; a child that needs you."),
  t("pill.accept", "color", "The ✓ circle on a pill card."),
  t("pill.success", "color", "A child agent that finished."),
  t("pill.danger", "color", "A child agent that failed."),
  t("pill.option", "color", "A question option's fill on a pill card."),
  t("pill.option.hover", "color", "A question option's fill under the pointer."),
  t("pill.shadow", "shadow", "The pill's shadow."),
  t("pill.plume.tail", "color", "The working plume where it cools."),
  t("pill.plume.body", "color", "The working plume's body."),
  t("pill.plume.hot", "color", "The working plume at the nozzle."),
  // The bot's stage and its avatar.
  t("stage.background", "paint", "The stage behind the avatar."),
  t("stage.floor", "color", "The soft pool of shadow under the avatar."),
  t("stage.glow", "color", "The light behind the avatar."),
  t("stage.text", "color", "Credits and notes on the stage."),
  t("avatar.light.key", "color", "The avatar's key light."),
  t("avatar.light.fill", "color", "The avatar's fill light."),
  t("avatar.light.rim", "color", "The avatar's rim light."),
  t("avatar.exposure", "number", "The avatar's exposure: 1 is neutral."),
];

const NAME = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$/;

/** A catalog token's name. */
export function isTokenName(name: string): boolean {
  return name.length <= 128 && NAME.test(name);
}

/** The reserved group a plugin's own tokens live under (lane B). */
export const PLUGIN_TOKEN_GROUP = "plugin";

/** Any plugin's own token name: `plugin.<top-level id>.<name>`, the id with single hyphens. */
export const PLUGIN_TOKEN_NAME_RE = /^plugin\.[a-z][a-z0-9]*(-[a-z0-9]+)*(\.[a-z][a-z0-9]*)+$/;

/** A plugin's own token name, for one plugin: `pluginTokenName("luna", "glow.soft")` → `plugin.luna.glow.soft`. */
export function pluginTokenName(pluginTopId: string, name: string): string {
  return `${PLUGIN_TOKEN_GROUP}.${pluginTopId}.${name}`;
}

/** Whether `name` is one of this plugin's own tokens (`plugin.<its top-level id>.…`). */
export function isPluginTokenName(name: string, pluginTopId: string): boolean {
  return name.length <= 128 && name.startsWith(`${PLUGIN_TOKEN_GROUP}.${pluginTopId}.`) && PLUGIN_TOKEN_NAME_RE.test(name);
}

/** The CSS custom property a token sets: `color.text.muted` → `--clover-color-text-muted`. Dots become
 *  hyphens; the hyphens a plugin id may hold become underscores, so the map is one to one. */
export function cssProperty(name: string): string {
  if (name.length > 128 || !(NAME.test(name) || PLUGIN_TOKEN_NAME_RE.test(name))) throw new Error(`not a token name: ${name}`);
  return `--clover-${name.replace(/-/g, "_").replace(/\./g, "-")}`;
}

/** `var(--clover-color-text-muted)`, for component styles. */
export function cssVar(name: string): string {
  return `var(${cssProperty(name)})`;
}

export const TOKEN_NAMES: ReadonlySet<string> = new Set(TOKENS.map((spec) => spec.name));

export function tokenSpec(name: string): TokenSpec | undefined {
  return TOKENS.find((spec) => spec.name === name);
}

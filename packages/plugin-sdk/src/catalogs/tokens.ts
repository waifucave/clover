// The design-token catalog (spec §5.5 "Themes use design tokens first"): each token's name, type and default, with
// `card.*` the set sealed approval frames take. The defaults are layer 1 of the theme stack, the look a part has with
// no theme at all; they are the base theme's values (lane G), so the `clover` plugin's theme and a part with none
// agree. Tokens flow down: a plugin that dresses a smaller part uses the colours around it unless it sets its own.
// Lane E's theme engine sets each as a CSS custom property inside the part a theme dresses (`cssProperty`).
//
// Names: dot-separated segments of lowercase letters and digits, each starting with a letter (`color.text.muted`).
// The property is `--clover-` and the name with its dots as hyphens (`--clover-color-text-muted`); with no hyphen or
// capital inside a segment, two names never map to one property. `card.*` stays self-contained: a card value never
// derives from another token, so restyling the accent never silently restyles approval cards.
//
// A plugin's own tokens live under the reserved group `plugin`: `plugin.<top-level id>.<name>` (`plugin.luna.glow`,
// `plugin.mcp-blender.glow`), so no plugin id, however it is spelled, can name a catalog token, `card.*` included, and
// no group the catalog adds later can meet one. The id may hold hyphens; they become underscores in the property
// (`--clover-plugin-mcp_blender-glow`), so the name-to-property map stays one to one.
//
// Every value, a catalog token's or a plugin's own, passes `isSafeTokenValue` before it reaches CSS.
//
// The OS accent colour (the owner's ask, as refined by lanes G and F): controls follow it, as the reference desktop
// app does. An accent token (`SYSTEM_ACCENT_TOKENS`: the accent, the focus ring, the approve button, the island's and
// the pill's ✓ circles) may be `"system"`, and is by default (`follows`). Lane E's theme engine reads the OS accent
// (`systemPreferences.getAccentColor()` on macOS and Windows, `systemAccentFromOs`), again whenever the OS says it
// changed; with no reading (Linux) the token keeps the theme's accent, the value the theme stack gives without
// `"system"`, which is fixed and which G's contrast floors cover.
// * Every filled accent control (`SYSTEM_LABEL_FILLS`) is the accent darkened in its own hue until white text reaches
//   4.5:1 on it (`fillForWhiteLabel`), so its label is always white, as the reference app draws it: `color.accent.fill`
//   for primary actions, the send button and a toggle's on state (it follows `color.accent` as resolved, the theme's
//   or the OS's), and `card.approve.background`, which follows the OS itself, since `card.*` never derives from
//   another token. `color.accent` stays the OS accent as given, for focus, marks and small controls.
// * An ink on an accent (`AUTO_INKS`) may be `"auto"`, and is by default, which the core resolves in the current
//   appearance against the accent as painted, any alpha flattened onto the control's background. A label ink (4.5:1)
//   is white when white reaches 4.5:1, otherwise black (`LABEL_INK`). A glyph ink on a glyph-only control (✓, ↑, ✕;
//   WCAG 1.4.11) is white at 3:1 or more, otherwise the theme's dark ink (`color.accent.ink`, `#111111` by default),
//   or black where that ink misses 3:1 too; so the OSes' default blues get white glyphs and a yellow accent never
//   gets white.
// Sealed frames take the resolved values like any token, and since no plugin changed anything, a new OS accent needs
// no new OK. `resolveTokens` (formats/theme.ts) does all of this.
//
// The frame's variables (`FRAME_VARIABLES`) are set by the shell and lane E's window, never by a theme: the room the
// title bar and the window's own controls take, for what sits under them.

export const TOKEN_TYPES = ["color", "dimension", "fontFamily", "fontWeight", "number", "duration", "easing", "shadow", "paint"] as const;
/** `paint` is a CSS background: a colour or a gradient. */
export type TokenType = (typeof TOKEN_TYPES)[number];

/** A token's value: a string, or a plain number for `number` and `fontWeight` tokens (a theme file may write
 *  `"font.weight.bold": 700`). */
export type TokenValue = string | number;

export interface TokenInfo {
  readonly name: string;
  readonly type: TokenType;
  readonly default: TokenValue;
  /** The dark appearance's default, where it differs. */
  readonly dark?: TokenValue;
  /** The catalog's own value is `"system"` (it follows the OS accent) or `"auto"` (an ink resolved against its
   *  accent); `default` and `dark` are then what it takes where there is nothing to follow. */
  readonly follows?: typeof SYSTEM_ACCENT | typeof AUTO_INK;
  readonly doc: string;
}

const t = (name: string, type: TokenType, def: TokenValue, dark: TokenValue | undefined, doc: string, follows?: "system" | "auto"): TokenInfo => ({
  name, type, default: def, ...(dark === undefined ? {} : { dark }), ...(follows === undefined ? {} : { follows }), doc,
});

export const TOKENS: readonly TokenInfo[] = [
  // Planes.
  t("color.canvas", "color", "#F5F5F5", "#202020", "The base plane: the sidebar and the app's background."),
  t("color.surface", "color", "#FFFFFF", "#191919", "The content plane: the conversation and settings pages."),
  t("color.raised", "color", "#F7F7F7", "#242424", "One step above the content: tool output, inner cards, code blocks."),
  t("color.control", "color", "#F0F0F0", "#2A2A2A", "Small controls: chips, toggle tracks, icon circles."),
  t("color.float", "color", "#FFFFFF", "#1F1F1F", "Anything floating above content: menus, popovers, palettes."),
  t("color.hairline", "color", "#E8E8E8", "#2B2B2B", "Dividers and rims on the canvas and the content plane."),
  t("color.hairline.raised", "color", "#DCDCDC", "#373737", "The same rule drawn on raised and control surfaces."),
  t("color.hover", "color", "#EFEFEF", "#2A2A2A", "A row's fill under the pointer."),
  t("color.selected", "color", "#DFDFDF", "#3D3D3D", "A selected row's fill. Navigation stays neutral: never the accent."),
  // The window's chrome over its material (macOS vibrancy, Windows 11 acrylic; lane E sets the material).
  t("sidebar.tint", "color", "#F5F5F5B3", "#202020B3", "The sidebar over the window's material."),
  t("sidebar.solid", "color", "#F5F5F5", "#202020", "The sidebar where the window has no material (Linux)."),
  t("titlebar.tint", "color", "#FFFFFFC7", "#191919C7", "The title bar over what scrolls under it."),
  t("titlebar.blur", "dimension", "16px", undefined, "The title bar's backdrop blur."),
  t("titlebar.height", "dimension", "45px", undefined, "The title bar's height, its rule included."),
  // Text.
  t("color.text", "color", "#1F1F1F", "#F2F2F2", "Body text."),
  t("color.text.secondary", "color", "#3A3A3A", "#D0D0D0", "Sidebar and secondary text."),
  t("color.text.muted", "color", "#6B6B6B", "#9E9E9E", "Quiet meta: timestamps, labels, trailing words."),
  t("color.text.placeholder", "color", "#6D6D6D", "#9A9A9A", "A field's placeholder."),
  t("color.text.inverse", "color", "#FFFFFF", "#191919", "Text on a text-coloured fill."),
  // Accent and meaning.
  t("color.accent", "color", "#2F6FDF", "#4180E3", "The accent as the OS gives it: focus, marks, a checkbox, small controls. Filled controls take `color.accent.fill`.", "system"),
  t("color.accent.fill", "color", "#2F6FDF", "#3570D8", "Filled controls: primary actions, the send button, a toggle's on state. The accent darkened in its own hue until white text reads at 4.5:1.", "system"),
  t("color.accent.text", "color", "#1F5FCC", "#A7C4E6", "The accent carrying text, at 4.5:1 or more on the content plane."),
  t("color.accent.soft", "color", "#E8F0FC", "#1F2633", "A wash of the accent: a chosen chip, a highlighted mention."),
  t("color.accent.contrast", "color", "#FFFFFF", undefined, "Labels and glyphs on `color.accent.fill`, at 4.5:1 or more (`auto` resolves it: white on the darkened fill).", "auto"),
  t("color.accent.glyph", "color", "#FFFFFF", undefined, "Glyphs on the raw `color.accent` (✓, a dot), at 3:1 or more (`auto` resolves it).", "auto"),
  t("color.accent.ink", "color", "#111111", undefined, "The theme's dark ink for glyphs on an accent, where white falls short of 3:1."),
  t("color.attention", "color", "#C27C00", "#ECD575", "Needs you: a waiting card, a question for the user."),
  t("color.attention.text", "color", "#8A5A00", "#ECD575", "Attention carrying text."),
  t("color.danger", "color", "#C93C3C", "#D7706A", "Errors and actions that destroy something."),
  t("color.success", "color", "#1E7F47", "#8CC283", "Done, connected, running."),
  t("color.diff.added", "color", "#1A7F37", "#8CC283", "Lines a diff adds."),
  t("color.diff.removed", "color", "#C2364F", "#DA6F80", "Lines a diff removes."),
  t("color.diff.added.soft", "color", "#1A7F371A", "#8CC28324", "The tint behind a line a diff adds."),
  t("color.diff.removed.soft", "color", "#C2364F17", "#DA6F8024", "The tint behind a line a diff removes."),
  t("color.branch", "color", "#6F52C4", "#B19EDE", "A session's branch badge."),
  t("color.unread", "color", "#8A8A8A", "#848484", "The unread dot: a neutral grey."),
  t("color.brand", "color", "#C2387A", "#FF7AB6", "Clover's mark: the one place the brand pink shows, since the accent follows the OS."),
  t("color.scrim", "color", "#00000033", "#00000080", "Behind a dialog."),
  t("color.focus", "color", "#2F6FDF", "#4180E3", "The keyboard focus ring.", "system"),
  // Messages.
  t("bubble.user.background", "color", "#F0F0F0", "#2A2A2A", "The user's own message."),
  t("bubble.user.text", "color", "#1F1F1F", "#F2F2F2", "Text in the user's message."),
  t("bubble.bot.background", "color", "#FFFFFF00", "#19191900", "The bot's message. Clear by default: replies sit on the content plane."),
  t("bubble.bot.rim", "color", "#FFFFFF00", "#19191900", "The bot's message rim."),
  t("bubble.bot.text", "color", "#1F1F1F", "#F2F2F2", "Text in the bot's message."),
  t("bubble.radius", "dimension", "16px", undefined, "A message bubble's corner."),
  // The composer.
  t("composer.background", "color", "#FFFFFF", "#303030", "The composer's face."),
  t("composer.rim", "color", "#D9D9D9", "#3F3F3F", "The composer's hairline."),
  t("composer.text", "color", "#1F1F1F", "#F2F2F2", "What the user types."),
  t("composer.placeholder", "color", "#737373", "#9A9A9A", "The composer's placeholder."),
  t("composer.radius", "dimension", "12px", undefined, "The composer's corner."),
  // Sealed approval cards: the only tokens their frames take.
  t("card.background", "color", "#FFFFFF", "#202020", "An approval card's face."),
  t("card.text", "color", "#1F1F1F", "#F2F2F2", "What the card asks."),
  t("card.muted", "color", "#6B6B6B", "#9E9E9E", "The card's meta: the computer, the tool."),
  t("card.rim", "color", "#D9D9D9", "#3F3F3F", "The card's rim."),
  t("card.radius", "dimension", "12px", undefined, "The card's corner."),
  t("card.padding", "dimension", "16px", undefined, "The card's inset."),
  t("card.approve.background", "color", "#2F6FDF", "#3570D8", "The approve button.", "system"),
  t("card.approve.text", "color", "#FFFFFF", undefined, "The approve button's label and glyph (`auto` resolves it at 4.5:1).", "auto"),
  t("card.deny.background", "color", "#EDEDED", "#3B3B3B", "The deny button."),
  t("card.deny.text", "color", "#1F1F1F", "#F2F2F2", "The deny button's label."),
  t("card.button.radius", "dimension", "10px", undefined, "The approve and deny buttons' corner."),
  t("card.font.family", "fontFamily", "system-ui, -apple-system, \"Segoe UI Variable Text\", \"Segoe UI\", \"Noto Sans\", Ubuntu, Cantarell, sans-serif", undefined, "The card's face."),
  t("card.font.size", "dimension", "14px", undefined, "The card's text size."),
  // Type.
  t("font.sans", "fontFamily", "system-ui, -apple-system, \"Segoe UI Variable Text\", \"Segoe UI\", \"Noto Sans\", Ubuntu, Cantarell, sans-serif", undefined, "The interface and body face: each OS's own."),
  t("font.serif", "fontFamily", "ui-serif, \"New York\", \"Iowan Old Style\", \"Noto Serif\", Georgia, serif", undefined, "The serif accent."),
  t("font.mono", "fontFamily", "ui-monospace, \"SF Mono\", \"Cascadia Mono\", \"JetBrains Mono\", \"DejaVu Sans Mono\", Menlo, Consolas, monospace", undefined, "Code, paths and ids."),
  t("font.display", "fontFamily", "system-ui, -apple-system, \"Segoe UI Variable Text\", \"Segoe UI\", \"Noto Sans\", Ubuntu, Cantarell, sans-serif", undefined, "Bot names, greetings and the wordmark."),
  t("font.size.tiny", "dimension", "10px", undefined, "Timestamps and micro-labels."),
  t("font.size.caption", "dimension", "12px", undefined, "Small meta."),
  t("font.size.label", "dimension", "13px", undefined, "Labels."),
  t("font.size.control", "dimension", "14px", undefined, "Sidebar rows and controls."),
  t("font.size.body", "dimension", "15px", undefined, "Body text and typing."),
  t("font.size.code", "dimension", "13px", undefined, "Code, commands and paths in running text."),
  t("font.size.large", "dimension", "15px", undefined, "Large controls."),
  t("font.size.heading", "dimension", "16px", undefined, "Headings in a pane."),
  t("font.size.title", "dimension", "20px", undefined, "A page's title."),
  t("font.size.display", "dimension", "28px", undefined, "A greeting."),
  t("font.weight.regular", "fontWeight", 400, undefined, "Regular."),
  t("font.weight.medium", "fontWeight", 500, undefined, "Medium."),
  t("font.weight.semibold", "fontWeight", 600, undefined, "Semibold."),
  t("font.weight.bold", "fontWeight", 700, undefined, "Bold."),
  t("font.line.body", "number", 1.4, undefined, "Body line height."),
  t("font.line.tight", "number", 1.25, undefined, "Line height for one-line labels and headings."),
  t("font.line.code", "number", 1.4, undefined, "Line height for code and tool output."),
  // Shape and space.
  t("radius.small", "dimension", "6px", undefined, "Small corners: chips, rows."),
  t("radius.medium", "dimension", "8px", undefined, "Medium corners: buttons, fields."),
  t("radius.large", "dimension", "12px", undefined, "Large corners: panels, inner cards."),
  t("radius.huge", "dimension", "24px", undefined, "The largest corners: sheets, the stage."),
  t("radius.round", "dimension", "999px", undefined, "A capsule's end."),
  t("space.xs", "dimension", "4px", undefined, "4 on the grid."),
  t("space.s", "dimension", "8px", undefined, "8 on the grid."),
  t("space.m", "dimension", "12px", undefined, "12 on the grid."),
  t("space.l", "dimension", "16px", undefined, "16 on the grid."),
  t("space.xl", "dimension", "24px", undefined, "24 on the grid."),
  t("space.xxl", "dimension", "32px", undefined, "32 on the grid."),
  t("shadow.raised", "shadow", "0 1px 2px #1C1B2214, 0 2px 8px #1C1B220F", "0 1px 2px #00000066, 0 2px 8px #0000004D", "A raised block's shadow."),
  t("shadow.float", "shadow", "0 10px 30px #1C1B2224, 0 2px 8px #1C1B2214", "0 12px 36px #00000099, 0 2px 8px #00000066", "Something floating: a menu, a popover."),
  // Motion.
  t("motion.fast", "duration", "150ms", undefined, "A hover, a press."),
  t("motion.medium", "duration", "250ms", undefined, "A state change."),
  t("motion.slow", "duration", "400ms", undefined, "A part arriving."),
  t("motion.easing", "easing", "cubic-bezier(0.2, 0, 0, 1)", undefined, "The default ease."),
  t("motion.spring.response", "number", 0.3, undefined, "The surfaces' spring: seconds per oscillation."),
  t("motion.spring.damping", "number", 0.7, undefined, "The surfaces' spring: damping fraction."),
  // The island and the Dispatch pill: black liquid shells over any desktop, dark whatever the
  // appearance (docs/claude/island.md, the Swift reference).
  t("island.surface", "color", "#000000", undefined, "The island's black."),
  t("island.rim", "color", "#FFFFFF17", undefined, "A floating island card's hairline rim."),
  t("island.text", "color", "#FFFFFF", undefined, "The island's words."),
  t("island.muted", "color", "#8B8B8B", undefined, "The island's quiet words."),
  t("island.faint", "color", "#FFFFFF59", undefined, "The island's faintest words: positions, hints."),
  t("island.attention", "color", "#FFC747", undefined, "Waiting for you: the hand and its count."),
  t("island.accept", "color", "#4180E3", undefined, "The ✓ circle.", "system"),
  t("island.accept.text", "color", "#FFFFFF", undefined, "The ✓ glyph.", "auto"),
  t("island.refuse", "color", "#FFFFFF", undefined, "The ✕ circle."),
  t("island.refuse.text", "color", "#000000", undefined, "The ✕ glyph."),
  t("island.working", "color", "#4180E3", undefined, "The working bolt."),
  t("island.success", "color", "#4CC38A", undefined, "A status that is well: running, connected."),
  t("island.danger", "color", "#FF6B70", undefined, "A status that is not: an error, a force quit."),
  t("island.option", "color", "#FFFFFF1F", undefined, "An option row's fill."),
  t("island.option.hover", "color", "#FFFFFF2E", undefined, "An option row's fill under the pointer."),
  t("island.card", "color", "#181818", undefined, "An inner card inside the open island: a Needs-you request."),
  t("island.card.rim", "color", "#3C3C3C", undefined, "That inner card's rim."),
  t("island.shadow", "shadow", "0 4px 24px #00000073", undefined, "A floating island card's shadow."),
  t("pill.surface", "color", "#000000", undefined, "The Dispatch pill's black."),
  t("pill.rim", "color", "#FFFFFF17", undefined, "The pill's hairline rim."),
  t("pill.text", "color", "#FFFFFF", undefined, "What the user types into the pill."),
  t("pill.muted", "color", "#8B8B8B", undefined, "The pill's quiet words."),
  t("pill.placeholder", "color", "#7A7A7A", undefined, "The compact pill's placeholder."),
  t("pill.placeholder.typing", "color", "#FFFFFF80", undefined, "The typing pill's placeholder."),
  t("pill.send", "color", "#FFFFFF", undefined, "The send and stop circle."),
  t("pill.send.glyph", "color", "#000000", undefined, "The send and stop glyph."),
  t("pill.accessory", "color", "#FFFFFF1F", undefined, "The ↗ and ⋯ circles."),
  t("pill.attention", "color", "#FFC747", undefined, "A card's kind glyph; a child that needs you."),
  t("pill.accept", "color", "#4180E3", undefined, "The ✓ circle on a pill card.", "system"),
  t("pill.accept.text", "color", "#FFFFFF", undefined, "The ✓ glyph on a pill card.", "auto"),
  t("pill.success", "color", "#4CC38A", undefined, "A child agent that finished."),
  t("pill.danger", "color", "#FF6B70", undefined, "A child agent that failed."),
  t("pill.option", "color", "#FFFFFF14", undefined, "A question option's fill on a pill card."),
  t("pill.option.hover", "color", "#FFFFFF29", undefined, "A question option's fill under the pointer."),
  t("pill.shadow", "shadow", "0 4px 24px #00000073", undefined, "The pill's shadow."),
  t("pill.plume.tail", "color", "#0D54FF", undefined, "The working plume where it cools."),
  t("pill.plume.body", "color", "#298CFF", undefined, "The working plume's body."),
  t("pill.plume.hot", "color", "#CCEDFF", undefined, "The working plume at the nozzle."),
  // The bot's stage and its avatar.
  t("stage.background", "paint", "linear-gradient(180deg, #FFFFFF 0%, #F4F2F8 100%)", "linear-gradient(180deg, #1D1D23 0%, #151519 100%)", "The stage behind the avatar."),
  t("stage.floor", "color", "#1C1B221F", "#0000008C", "The soft pool of shadow under the avatar."),
  t("stage.glow", "color", "#2F6FDF1F", "#4180E31F", "The light behind the avatar."),
  t("stage.text", "color", "#676674", "#9B9AA8", "Credits and notes on the stage."),
  t("avatar.light.key", "color", "#FFFFFF", "#F2EEFF", "The avatar's key light."),
  t("avatar.light.fill", "color", "#F2F6FF", "#C9D8F2", "The avatar's fill light."),
  t("avatar.light.rim", "color", "#FFFFFF", "#DCE6F7", "The avatar's rim light."),
  t("avatar.exposure", "number", 1, 0.95, "The avatar's exposure: 1 is neutral."),
];

export const TOKEN_NAMES: ReadonlySet<string> = new Set(TOKENS.map((x) => x.name));
/** The tokens sealed frames take (§5.5). */
export const CARD_TOKENS: readonly TokenInfo[] = TOKENS.filter((x) => x.name.startsWith("card."));
/** The catalog's first segments (`color`, `card`, …, and `frame` for the frame's variables); `plugin` is never one. */
export const TOKEN_GROUPS: ReadonlySet<string> = new Set([...TOKENS.map((x) => x.name.split(".")[0]!), "frame"]);
/** The group a plugin's own tokens live under: `plugin.<top-level id>.<name>`. */
export const PLUGIN_TOKEN_GROUP = "plugin";

export function tokenInfo(name: string): TokenInfo | undefined {
  return TOKENS.find((x) => x.name === name);
}

/** A catalog token's name: dot-separated segments of lowercase letters and digits, each starting with a letter. */
export const TOKEN_NAME_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$/;
export function isTokenName(name: string): boolean {
  return name.length <= 128 && TOKEN_NAME_RE.test(name);
}

/** Any plugin's own token name: `plugin.<top-level id>.<name>`, the id with single hyphens, the rest the catalog's
 *  grammar. */
export const PLUGIN_TOKEN_NAME_RE = /^plugin\.[a-z][a-z0-9]*(-[a-z0-9]+)*(\.[a-z][a-z0-9]*)+$/;

/** A plugin's own token name, for one plugin: `pluginTokenName("luna", "glow.soft")` → `plugin.luna.glow.soft`. */
export function pluginTokenName(pluginTopId: string, name: string): string {
  return `${PLUGIN_TOKEN_GROUP}.${pluginTopId}.${name}`;
}

/** Whether `name` is one of this plugin's own tokens (`plugin.<its top-level id>.…`); they apply only where its own CSS
 *  reads them, and only the plugin itself sets them. */
export function isPluginTokenName(name: string, pluginTopId: string): boolean {
  return name.length <= 128 && name.startsWith(`${PLUGIN_TOKEN_GROUP}.${pluginTopId}.`) && PLUGIN_TOKEN_NAME_RE.test(name);
}

/** The CSS custom property a token sets: `color.text.muted` → `--clover-color-text-muted`. Dots become hyphens, and the
 *  hyphens a plugin id may hold become underscores (`plugin.mcp-blender.glow` → `--clover-plugin-mcp_blender-glow`), so
 *  the map is one to one. Throws for anything that is neither a catalog-grammar name nor a plugin token name. */
export function cssProperty(name: string): string {
  if (name.length > 128 || !(TOKEN_NAME_RE.test(name) || PLUGIN_TOKEN_NAME_RE.test(name))) throw new Error(`not a token name: ${name}`);
  return `--clover-${name.replace(/-/g, "_").replace(/\./g, "-")}`;
}

/** `var(--clover-color-text-muted)`, for component styles. */
export function cssVar(name: string): string {
  return `var(${cssProperty(name)})`;
}

// A token's value goes into a CSS custom property, so it may never break out of it: no `;`, braces, `url(`, `@`,
// backslashes or comments, whatever its type.
const UNSAFE = /[;{}\\@<>\n\r\f\0]|\/\*|url\s*\(|src\s*\(|expression\s*\(|image-set|image\s*\(|element\s*\(|cross-fade|!\s*important/i;
const DIMENSION = /^-?(\d+(\.\d+)?|\.\d+)(px|rem|em|%|vh|vw|vmin|vmax|ch|ex|pt)$|^0$/;
const COLOR = /^(#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8}|(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\([^()]*\)|transparent|currentcolor|[a-z]{3,20})$/i;
/** A gradient whose arguments may hold one level of brackets: `linear-gradient(180deg, rgb(0 0 0 / 50%) 0%, …)`. */
const GRADIENT = /^(repeating-)?(linear|radial|conic)-gradient\(([^()]|\([^()]*\))*\)$/i;
const DURATION = /^(\d+(\.\d+)?|\.\d+)(ms|s)$/;
const NUMBER = /^-?(\d+(\.\d+)?|\.\d+)$/;
const WEIGHT = /^([1-9]\d{0,2}|1000|normal|bold|lighter|bolder)$/;
const EASING = /^(linear|ease|ease-in|ease-out|ease-in-out|step-start|step-end|(cubic-bezier|steps|linear)\([^()]*\))$/;
const FAMILY = /^[A-Za-z0-9 ,"'_-]{1,200}$/;
const SHADOW = /^[A-Za-z0-9 ,.#()%/-]{1,300}$/;

/** Whether every quoted string in a value closes, read as CSS reads it: a quote opens a string that only the same
 *  quote closes, so `'"'"` leaves a `"` open (counting quotes would pass it; review S6). Backslashes never reach here. */
function quotesClose(value: string): boolean {
  let open: string | undefined;
  for (const c of value) {
    if (open === undefined) {
      if (c === '"' || c === "'") open = c;
    } else if (c === open) open = undefined;
  }
  return open === undefined;
}

/** Whether a value can go into a CSS custom property at all: a finite number, or a string of at most 300 characters
 *  on one line with no `;`, braces, angle brackets, `@`, backslash, comment, `!important`, `url(` or other resource
 *  function. Quoted strings are allowed only in a `fontFamily` value, and every one must close (review S6), so a
 *  string can't carry a URL into `image-set()` or run on past the value. The theme engine (lane E) applies it to every
 *  value it sets with the token's type (`isTokenValue`), and to a plugin's own tokens through `isAnyTokenValue`. */
export function isSafeTokenValue(value: unknown, type?: TokenType): value is TokenValue {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "string" || value.length > 300 || UNSAFE.test(value)) return false;
  if (!value.includes('"') && !value.includes("'")) return true;
  return type === "fontFamily" && quotesClose(value);
}

/** Whether a value fits a token type, and is safe to put in a CSS custom property. A number fits only `number` and
 *  `fontWeight` (1 to 1000). */
export function isTokenValue(type: TokenType, value: TokenValue): boolean {
  if (!isSafeTokenValue(value, type)) return false;
  if (typeof value === "number") return type === "number" || (type === "fontWeight" && value >= 1 && value <= 1000);
  const v = value.trim();
  switch (type) {
    case "color": return v.toLowerCase() !== SYSTEM_ACCENT && v.toLowerCase() !== AUTO_INK && COLOR.test(v);
    case "dimension": return DIMENSION.test(v);
    case "number": return NUMBER.test(v);
    case "fontFamily": return FAMILY.test(value);
    case "fontWeight": return WEIGHT.test(v);
    case "duration": return DURATION.test(v);
    case "easing": return EASING.test(v);
    case "shadow": return SHADOW.test(value);
    case "paint": return COLOR.test(v) || GRADIENT.test(v);
  }
}

/** Whether a value fits some token type: the check for a plugin's own tokens, which have none of their own. */
export function isAnyTokenValue(value: unknown): value is TokenValue {
  return (typeof value === "string" || typeof value === "number") && TOKEN_TYPES.some((type) => isTokenValue(type, value));
}

/** Whether a value may be set for a token by name: the catalog token's own type, or any type for a plugin's own;
 *  `"system"` only for an accent token, `"auto"` only for an ink on one; never a frame variable. */
export function isValueForToken(name: string, value: unknown): value is TokenValue {
  if (name.startsWith("frame.")) return false;
  if (value === SYSTEM_ACCENT) return SYSTEM_ACCENT_TOKENS.includes(name);
  if (value === AUTO_INK) return Object.hasOwn(AUTO_INKS, name);
  const type = TOKENS.find((t) => t.name === name)?.type;
  if (type === undefined) return isAnyTokenValue(value);
  return (typeof value === "string" || typeof value === "number") && isTokenValue(type, value);
}

/** The value an accent token takes to follow the OS accent colour. */
export const SYSTEM_ACCENT = "system";
/** The value an ink on an accent takes to be resolved by the core. */
export const AUTO_INK = "auto";

/** The tokens that may be `"system"`. */
export const SYSTEM_ACCENT_TOKENS: readonly string[] = ["color.accent", "color.accent.fill", "color.focus", "card.approve.background", "island.accept", "pill.accept"];

/** Filled accent controls: `"system"` there is the accent darkened in its own hue until white text reaches 4.5:1
 *  (`fillForWhiteLabel`), so the label is always white. With the background it sits on, and `from`, the token whose
 *  resolved value it darkens (the OS accent when absent). */
export const SYSTEM_LABEL_FILLS: Readonly<Record<string, { background: string; from?: string }>> = {
  "color.accent.fill": { background: "color.surface", from: "color.accent" },
  "card.approve.background": { background: "card.background" },
};

/** What a label ink is where white falls short of 4.5:1. */
export const LABEL_INK = "#000000";

export interface AutoInk {
  /** The accent it is drawn on. */
  readonly accent: string;
  /** What the control sits on, which an accent with alpha is flattened onto. */
  readonly background: string;
  /** 3 for glyph-only controls (WCAG 1.4.11), 4.5 for text labels. */
  readonly floor: 3 | 4.5;
  /** A glyph ink's dark ink where white falls short, a token; a label ink takes `LABEL_INK`. */
  readonly darkInk?: string;
}

/** The inks that may be `"auto"`. A sealed card's approve button holds a label or a glyph, so its ink takes the
 *  text floor; `card.*` resolves from `card.*` alone. */
export const AUTO_INKS: Readonly<Record<string, AutoInk>> = {
  "color.accent.contrast": { accent: "color.accent.fill", background: "color.surface", floor: 4.5 },
  "color.accent.glyph": { accent: "color.accent", background: "color.surface", floor: 3, darkInk: "color.accent.ink" },
  "card.approve.text": { accent: "card.approve.background", background: "card.background", floor: 4.5 },
  "island.accept.text": { accent: "island.accept", background: "island.surface", floor: 3, darkInk: "color.accent.ink" },
  "pill.accept.text": { accent: "pill.accept", background: "pill.surface", floor: 3, darkInk: "color.accent.ink" },
};

/** Variables the frame sets for what sits inside it (lane F's request), never a theme: CSS custom properties named as
 *  tokens are (`--clover-frame-inset-top`), each a CSS length. */
export const FRAME_VARIABLES: readonly { readonly name: string; readonly doc: string }[] = [
  { name: "frame.inset.top", doc: "The title bar's height: what `main`'s content keeps clear of at its top." },
  { name: "frame.window.controls", doc: "The room the window's own controls take at the title bar's start (80px on macOS by default; lane E sets it from `titlebar-area-x`)." },
];

/** Electron's `systemPreferences.getAccentColor()` (`RRGGBBAA`) as a token value (`#RRGGBB`), or undefined when it
 *  isn't one. */
export function systemAccentFromOs(raw: string): string | undefined {
  const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(raw.trim());
  return m ? `#${m[1]!.toUpperCase()}` : undefined;
}

/** A `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa` colour as `[r, g, b, a]`, channels 0–1; undefined otherwise. */
export function parseHexColor(color: string): [number, number, number, number] | undefined {
  let hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(color.trim())?.[1];
  if (hex === undefined) return undefined;
  if (hex.length <= 4) hex = [...hex].map((c) => c + c).join("");
  const ch = (i: number) => Number.parseInt(hex!.slice(i, i + 2), 16) / 255;
  return [ch(0), ch(2), ch(4), hex.length === 8 ? ch(6) : 1];
}

const toHex = (rgb: readonly number[]) => `#${rgb.map((c) => Math.round(c * 255).toString(16).padStart(2, "0")).join("").toUpperCase()}`;

/** A colour as painted over another: alpha flattened (both hex). The background's own alpha is dropped. */
export function flattenColor(color: string, background: string): string | undefined {
  const c = parseHexColor(color);
  const b = parseHexColor(background);
  if (c === undefined || b === undefined) return undefined;
  return toHex([0, 1, 2].map((i) => c[i]! * c[3] + b[i]! * (1 - c[3])));
}

function luminance(color: string): number | undefined {
  const c = parseHexColor(color);
  if (c === undefined) return undefined;
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
}

/** The WCAG contrast ratio of two hex colours (alpha ignored), from 1 to 21; undefined when either isn't hex. */
export function contrastRatio(a: string, b: string): number | undefined {
  const la = luminance(a);
  const lb = luminance(b);
  if (la === undefined || lb === undefined) return undefined;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** An `auto` ink: white when white reaches `floor` against the accent as painted (its alpha flattened onto
 *  `background`), otherwise `darkInk`, or black where `darkInk` misses the floor too (or isn't hex); undefined when
 *  the accent or background isn't hex. */
export function resolveAutoInk(accent: string, opts: { background: string; darkInk: string; floor: number }): string | undefined {
  const painted = flattenColor(accent, opts.background);
  if (painted === undefined) return undefined;
  if (contrastRatio("#FFFFFF", painted)! >= opts.floor) return "#FFFFFF";
  return (contrastRatio(opts.darkInk, painted) ?? 0) >= opts.floor ? opts.darkInk : "#000000";
}

function toHsl([r, g, b]: readonly number[]): [number, number, number] {
  const max = Math.max(r!, g!, b!);
  const min = Math.min(r!, g!, b!);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g! - b!) / d + (g! < b! ? 6 : 0) : max === g ? (b! - r!) / d + 2 : (r! - g!) / d + 4;
  return [h / 6, s, l];
}

function fromHsl(h: number, s: number, l: number): number[] {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t: number) => {
    const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (u < 1 / 6) return p + (q - p) * 6 * u;
    if (u < 1 / 2) return q;
    if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
    return p;
  };
  return [hue(h + 1 / 3), hue(h), hue(h - 1 / 3)];
}

/** A filled button's colour for a white text label: the accent as painted on `background`, darkened in its own hue
 *  (its HSL lightness lowered, hue and saturation kept) until white reaches 4.5:1 on it; unchanged where it already
 *  does. Undefined when either isn't hex. */
export function fillForWhiteLabel(accent: string, background: string): string | undefined {
  const painted = flattenColor(accent, background);
  if (painted === undefined) return undefined;
  if (contrastRatio("#FFFFFF", painted)! >= 4.5) return painted;
  const [h, s, l] = toHsl(parseHexColor(painted)!);
  for (let step = Math.floor(l * 1000); step >= 0; step--) {
    const candidate = toHex(fromHsl(h, s, step / 1000));
    if (contrastRatio("#FFFFFF", candidate)! >= 4.5) return candidate;
  }
  return "#000000";
}

/** The text a value takes in CSS. */
export function tokenCss(value: TokenValue): string {
  return typeof value === "number" ? String(value) : value;
}

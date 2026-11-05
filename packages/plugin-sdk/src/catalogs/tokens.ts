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
  readonly doc: string;
}

const t = (name: string, type: TokenType, def: TokenValue, dark: TokenValue | undefined, doc: string): TokenInfo =>
  dark === undefined ? { name, type, default: def, doc } : { name, type, default: def, dark, doc };

export const TOKENS: readonly TokenInfo[] = [
  // Planes.
  t("color.canvas", "color", "#F6F6F8", "#212126", "The base plane: the sidebar and the app's background."),
  t("color.surface", "color", "#FFFFFF", "#18181C", "The content plane: the conversation and settings pages."),
  t("color.raised", "color", "#F3F3F6", "#232329", "One step above the content: tool output, inner cards, code blocks."),
  t("color.control", "color", "#EDEDF1", "#2D2D34", "Small controls: chips, toggle tracks, icon circles."),
  t("color.float", "color", "#FFFFFF", "#2B2B31", "Anything floating above content: menus, popovers, palettes."),
  t("color.hairline", "color", "#E4E4EA", "#303037", "Dividers and rims on the canvas and the content plane."),
  t("color.hairline.raised", "color", "#D6D6DE", "#3B3B44", "The same rule drawn on raised and control surfaces."),
  t("color.hover", "color", "#EFEFF3", "#2A2A30", "A row's fill under the pointer."),
  t("color.selected", "color", "#E7E7EE", "#34343C", "A selected row's fill. Navigation stays neutral: never the accent."),
  // Text.
  t("color.text", "color", "#1C1B22", "#F4F3F8", "Body text."),
  t("color.text.secondary", "color", "#3B3A45", "#DCDBE3", "Sidebar and secondary text."),
  t("color.text.muted", "color", "#676674", "#9B9AA8", "Quiet meta: timestamps, labels, trailing words."),
  t("color.text.placeholder", "color", "#9C9BA6", "#66656F", "A field's placeholder."),
  t("color.text.inverse", "color", "#FFFFFF", "#18181C", "Text on a text-coloured fill."),
  // Accent and meaning.
  t("color.accent", "color", "#C2387A", "#FF7AB6", "The brand accent: primary actions, focus, the send button."),
  t("color.accent.text", "color", "#B12F6E", "#FF8CC1", "The accent carrying text, at 4.5:1 or more on the content plane."),
  t("color.accent.soft", "color", "#FBEAF2", "#3A2130", "A wash of the accent: a chosen chip, a highlighted mention."),
  t("color.accent.contrast", "color", "#FFFFFF", "#2A0F1C", "Text and glyphs on an accent fill."),
  t("color.attention", "color", "#E09A00", "#FFC747", "Needs you: a waiting card, a question for the user."),
  t("color.attention.text", "color", "#8A5A00", "#FFD27A", "Attention carrying text."),
  t("color.danger", "color", "#C2302E", "#FF6B70", "Errors and actions that destroy something."),
  t("color.success", "color", "#1E7F47", "#4CC38A", "Done, connected, running."),
  t("color.diff.added", "color", "#1E7F47", "#4CC38A", "Lines a diff adds."),
  t("color.diff.removed", "color", "#C2302E", "#FF6B70", "Lines a diff removes."),
  t("color.focus", "color", "#C2387A", "#FF7AB6", "The keyboard focus ring."),
  // Messages.
  t("bubble.user.background", "color", "#FBE8F1", "#3A2433", "The user's own message."),
  t("bubble.user.text", "color", "#1C1B22", "#F4F3F8", "Text in the user's message."),
  t("bubble.bot.background", "color", "#FFFFFF00", "#18181C00", "The bot's message. Clear by default: replies sit on the content plane."),
  t("bubble.bot.rim", "color", "#FFFFFF00", "#18181C00", "The bot's message rim."),
  t("bubble.bot.text", "color", "#1C1B22", "#F4F3F8", "Text in the bot's message."),
  t("bubble.radius", "dimension", "18px", undefined, "A message bubble's corner."),
  // The composer.
  t("composer.background", "color", "#FFFFFF", "#2E2E35", "The composer's face."),
  t("composer.rim", "color", "#E1E1E7", "#3E3E47", "The composer's hairline."),
  t("composer.text", "color", "#1C1B22", "#F4F3F8", "What the user types."),
  t("composer.placeholder", "color", "#9C9BA6", "#77767F", "The composer's placeholder."),
  t("composer.radius", "dimension", "24px", undefined, "The composer's corner."),
  // Sealed approval cards: the only tokens their frames take.
  t("card.background", "color", "#F3F3F6", "#232329", "An approval card's face."),
  t("card.text", "color", "#1C1B22", "#F4F3F8", "What the card asks."),
  t("card.muted", "color", "#676674", "#9B9AA8", "The card's meta: the computer, the tool."),
  t("card.rim", "color", "#D6D6DE", "#3B3B44", "The card's rim."),
  t("card.radius", "dimension", "20px", undefined, "The card's corner."),
  t("card.padding", "dimension", "16px", undefined, "The card's inset."),
  t("card.approve.background", "color", "#C2387A", "#FF7AB6", "The approve button."),
  t("card.approve.text", "color", "#FFFFFF", "#2A0F1C", "The approve button's label."),
  t("card.deny.background", "color", "#E6E6EC", "#34343C", "The deny button."),
  t("card.deny.text", "color", "#1C1B22", "#F4F3F8", "The deny button's label."),
  t("card.button.radius", "dimension", "10px", undefined, "The approve and deny buttons' corner."),
  t("card.font.family", "fontFamily", "system-ui, -apple-system, \"Segoe UI Variable Text\", \"Segoe UI\", \"Noto Sans\", Ubuntu, Cantarell, sans-serif", undefined, "The card's face."),
  t("card.font.size", "dimension", "14px", undefined, "The card's text size."),
  // Type.
  t("font.sans", "fontFamily", "system-ui, -apple-system, \"Segoe UI Variable Text\", \"Segoe UI\", \"Noto Sans\", Ubuntu, Cantarell, sans-serif", undefined, "The interface and body face: each OS's own."),
  t("font.serif", "fontFamily", "ui-serif, \"New York\", \"Iowan Old Style\", \"Noto Serif\", Georgia, serif", undefined, "The serif accent."),
  t("font.mono", "fontFamily", "ui-monospace, \"SF Mono\", \"Cascadia Mono\", \"JetBrains Mono\", \"DejaVu Sans Mono\", Menlo, Consolas, monospace", undefined, "Code, paths and ids."),
  t("font.display", "fontFamily", "ui-serif, \"New York\", \"Iowan Old Style\", \"Noto Serif\", Georgia, serif", undefined, "Bot names, greetings and the wordmark."),
  t("font.size.tiny", "dimension", "10px", undefined, "Timestamps and micro-labels."),
  t("font.size.caption", "dimension", "11px", undefined, "Small meta."),
  t("font.size.label", "dimension", "12px", undefined, "Labels."),
  t("font.size.control", "dimension", "13px", undefined, "Sidebar rows and controls."),
  t("font.size.body", "dimension", "14px", undefined, "Body text and typing."),
  t("font.size.code", "dimension", "13px", undefined, "Code, commands and paths in running text."),
  t("font.size.large", "dimension", "15px", undefined, "Large controls."),
  t("font.size.heading", "dimension", "16px", undefined, "Headings in a pane."),
  t("font.size.title", "dimension", "20px", undefined, "A page's title."),
  t("font.size.display", "dimension", "28px", undefined, "A greeting."),
  t("font.weight.regular", "fontWeight", 400, undefined, "Regular."),
  t("font.weight.medium", "fontWeight", 500, undefined, "Medium."),
  t("font.weight.semibold", "fontWeight", 600, undefined, "Semibold."),
  t("font.weight.bold", "fontWeight", 700, undefined, "Bold."),
  t("font.line.body", "number", 1.62, undefined, "Body line height."),
  t("font.line.tight", "number", 1.25, undefined, "Line height for one-line labels and headings."),
  // Shape and space.
  t("radius.small", "dimension", "6px", undefined, "Small corners: chips, rows."),
  t("radius.medium", "dimension", "10px", undefined, "Medium corners: buttons, fields."),
  t("radius.large", "dimension", "16px", undefined, "Large corners: panels, inner cards."),
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
  t("island.accept", "color", "#0A85FF", undefined, "The ✓ circle."),
  t("island.accept.text", "color", "#FFFFFF", undefined, "The ✓ glyph."),
  t("island.refuse", "color", "#FFFFFF", undefined, "The ✕ circle."),
  t("island.refuse.text", "color", "#000000", undefined, "The ✕ glyph."),
  t("island.working", "color", "#FF7AB6", undefined, "The working bolt."),
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
  t("pill.placeholder", "color", "#686868", undefined, "The compact pill's placeholder."),
  t("pill.placeholder.typing", "color", "#FFFFFF80", undefined, "The typing pill's placeholder."),
  t("pill.send", "color", "#FFFFFF", undefined, "The send and stop circle."),
  t("pill.send.glyph", "color", "#000000", undefined, "The send and stop glyph."),
  t("pill.accessory", "color", "#FFFFFF1F", undefined, "The ↗ and ⋯ circles."),
  t("pill.attention", "color", "#FFC747", undefined, "A card's kind glyph; a child that needs you."),
  t("pill.accept", "color", "#0A85FF", undefined, "The ✓ circle on a pill card."),
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
  t("stage.glow", "color", "#C2387A1F", "#FF7AB61F", "The light behind the avatar."),
  t("stage.text", "color", "#676674", "#9B9AA8", "Credits and notes on the stage."),
  t("avatar.light.key", "color", "#FFFFFF", "#F2EEFF", "The avatar's key light."),
  t("avatar.light.fill", "color", "#FFF1F8", "#B9A8FF", "The avatar's fill light."),
  t("avatar.light.rim", "color", "#FFFFFF", "#FF9CC9", "The avatar's rim light."),
  t("avatar.exposure", "number", 1, 0.95, "The avatar's exposure: 1 is neutral."),
];

export const TOKEN_NAMES: ReadonlySet<string> = new Set(TOKENS.map((x) => x.name));
/** The tokens sealed frames take (§5.5). */
export const CARD_TOKENS: readonly TokenInfo[] = TOKENS.filter((x) => x.name.startsWith("card."));
/** The catalog's first segments (`color`, `card`, …); `plugin` is never one of them. */
export const TOKEN_GROUPS: ReadonlySet<string> = new Set(TOKENS.map((x) => x.name.split(".")[0]!));
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
    case "color": return COLOR.test(v);
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

/** Whether a value may be set for a token by name: the catalog token's own type, or any type for a plugin's own. */
export function isValueForToken(name: string, value: unknown): value is TokenValue {
  const type = TOKENS.find((t) => t.name === name)?.type;
  if (type === undefined) return isAnyTokenValue(value);
  return (typeof value === "string" || typeof value === "number") && isTokenValue(type, value);
}

/** The text a value takes in CSS. */
export function tokenCss(value: TokenValue): string {
  return typeof value === "number" ? String(value) : value;
}

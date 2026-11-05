// The design-token catalog (spec §5.5 "Themes use design tokens first"). Each token has a name, a type and the core's
// default (layer 1 of the theme stack); `clover`'s base theme (lane G) sets its own values above these. Tokens flow
// down: a plugin that dresses a smaller part uses the colours around it unless it sets its own. Sealed approval frames
// take only the `card.*` set (§5.5). Lane E's theme engine applies them as CSS custom properties (`cssVar`).
//
// Provisional for lanes E (the theme engine) and G (the base theme): the names and types are the contract; the
// defaults here are a neutral light and dark pair so a plugin always has a value to fall back on.

export const TOKEN_TYPES = ["color", "length", "number", "font-family", "font-weight", "duration", "easing", "shadow"] as const;
export type TokenType = (typeof TOKEN_TYPES)[number];

export interface TokenInfo {
  readonly name: string;
  readonly type: TokenType;
  readonly default: string;
  /** The dark appearance's default, where it differs. */
  readonly dark?: string;
  readonly doc: string;
}

const t = (name: string, type: TokenType, def: string, dark: string | undefined, doc: string): TokenInfo =>
  dark === undefined ? { name, type, default: def, doc } : { name, type, default: def, dark, doc };

export const TOKENS: readonly TokenInfo[] = [
  // Colour.
  t("color.bg", "color", "#ffffff", "#16161a", "The part's background."),
  t("color.bg.raised", "color", "#f6f6f8", "#1f1f25", "Panels, menus and cards above the background."),
  t("color.bg.sunken", "color", "#ececf0", "#0f0f12", "Inputs and wells below the background."),
  t("color.fg", "color", "#16161a", "#ececf0", "Text."),
  t("color.fg.muted", "color", "#55555f", "#a6a6b3", "Secondary text."),
  t("color.fg.subtle", "color", "#8a8a96", "#73737f", "Hints and placeholders."),
  t("color.border", "color", "#dedee4", "#2c2c34", "Hairlines between parts."),
  t("color.border.strong", "color", "#b9b9c4", "#454551", "Borders that must show."),
  t("color.accent", "color", "#5b5bd6", "#8b8bf0", "The accent: links, the selected item, primary buttons."),
  t("color.accent.fg", "color", "#ffffff", "#0f0f12", "Text on the accent."),
  t("color.danger", "color", "#d6455b", "#f07a8b", "Destructive actions and errors."),
  t("color.danger.fg", "color", "#ffffff", "#0f0f12", "Text on danger."),
  t("color.warning", "color", "#c98a14", "#f0b84d", "Warnings."),
  t("color.success", "color", "#2f9e5f", "#5ccc8c", "Success."),
  t("color.focus", "color", "#5b5bd6", "#8b8bf0", "The keyboard focus ring."),
  t("color.selection", "color", "#d9d9fb", "#34345f", "Selected text."),
  t("color.bubble.user.bg", "color", "#5b5bd6", "#3c3c99", "The user's message bubble."),
  t("color.bubble.user.fg", "color", "#ffffff", "#ffffff", "Text in the user's bubble."),
  t("color.bubble.bot.bg", "color", "#f0f0f4", "#24242b", "The bot's message bubble."),
  t("color.bubble.bot.fg", "color", "#16161a", "#ececf0", "Text in the bot's bubble."),
  // Type.
  t("font.body", "font-family", "system-ui, sans-serif", undefined, "Body text."),
  t("font.display", "font-family", "system-ui, sans-serif", undefined, "Titles and the bot's name."),
  t("font.mono", "font-family", "ui-monospace, monospace", undefined, "Code and commands."),
  t("font.size.small", "length", "12px", undefined, "Small text."),
  t("font.size.body", "length", "14px", undefined, "Body text."),
  t("font.size.large", "length", "17px", undefined, "Large text."),
  t("font.size.title", "length", "22px", undefined, "Titles."),
  t("font.weight.body", "font-weight", "400", undefined, "Body text's weight."),
  t("font.weight.strong", "font-weight", "600", undefined, "Strong text's weight."),
  t("font.lineHeight", "number", "1.5", undefined, "Body text's line height."),
  // Space and shape.
  t("space.xs", "length", "4px", undefined, "The smallest gap."),
  t("space.sm", "length", "8px", undefined, "A small gap."),
  t("space.md", "length", "12px", undefined, "The usual gap."),
  t("space.lg", "length", "16px", undefined, "A large gap."),
  t("space.xl", "length", "24px", undefined, "The largest gap."),
  t("radius.sm", "length", "6px", undefined, "Small corners: chips, inputs."),
  t("radius.md", "length", "10px", undefined, "Corners of cards and bubbles."),
  t("radius.lg", "length", "16px", undefined, "Corners of windows and sheets."),
  t("shadow.raised", "shadow", "0 1px 2px rgba(0,0,0,0.08)", "0 1px 2px rgba(0,0,0,0.4)", "Raised parts."),
  t("shadow.overlay", "shadow", "0 8px 24px rgba(0,0,0,0.16)", "0 8px 24px rgba(0,0,0,0.5)", "Menus and popovers."),
  t("motion.fast", "duration", "120ms", undefined, "Small transitions."),
  t("motion.normal", "duration", "220ms", undefined, "Most transitions."),
  t("motion.easing", "easing", "cubic-bezier(0.2, 0, 0, 1)", undefined, "The usual easing."),
  t("layout.sidebar.width", "length", "264px", undefined, "The sidebar's width."),
  t("layout.panel.width", "length", "420px", undefined, "The panel's width."),
  // Sealed approval frames take only these (§5.5).
  t("card.bg", "color", "#ffffff", "#1f1f25", "A card's background."),
  t("card.fg", "color", "#16161a", "#ececf0", "A card's text."),
  t("card.fg.muted", "color", "#55555f", "#a6a6b3", "A card's secondary text."),
  t("card.border", "color", "#dedee4", "#2c2c34", "A card's border."),
  t("card.radius", "length", "10px", undefined, "A card's corners."),
  t("card.padding", "length", "12px", undefined, "Space inside a card."),
  t("card.font", "font-family", "system-ui, sans-serif", undefined, "A card's text font."),
  t("card.font.size", "length", "14px", undefined, "A card's text size."),
  t("card.code.bg", "color", "#ececf0", "#0f0f12", "Behind a command on a card."),
  t("card.code.fg", "color", "#16161a", "#ececf0", "A command's text on a card."),
  t("card.code.font", "font-family", "ui-monospace, monospace", undefined, "A command's font on a card."),
  t("card.approve.bg", "color", "#5b5bd6", "#8b8bf0", "The approve button."),
  t("card.approve.fg", "color", "#ffffff", "#0f0f12", "The approve button's text."),
  t("card.deny.bg", "color", "#ececf0", "#2c2c34", "The deny button."),
  t("card.deny.fg", "color", "#16161a", "#ececf0", "The deny button's text."),
  t("card.button.radius", "length", "8px", undefined, "A card button's corners."),
];

export const TOKEN_NAMES: ReadonlySet<string> = new Set(TOKENS.map((x) => x.name));
/** The tokens sealed frames take. */
export const CARD_TOKENS: readonly TokenInfo[] = TOKENS.filter((x) => x.name.startsWith("card."));

/** The CSS custom property a token sets: `color.bg.raised` → `--clover-color-bg-raised`. */
export function cssVar(name: string): string {
  return `--clover-${name.replace(/[.]/g, "-")}`;
}

// A token's value goes into a CSS custom property, so it may never break out of it: no `;`, braces, `url(`, `@`,
// backslashes or comments, whatever its type.
const UNSAFE = /[;{}\\@<>]|\/\*|url\s*\(|expression\s*\(|image-set|image\s*\(|element\s*\(/i;
const LENGTH = /^-?(\d+(\.\d+)?|\.\d+)(px|rem|em|%|vh|vw|vmin|vmax|ch|ex|pt)$|^0$/;
const COLOR = /^(#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8}|(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\([^()]*\)|transparent|currentcolor|[a-z]{3,20})$/i;
const DURATION = /^(\d+(\.\d+)?|\.\d+)(ms|s)$/;
const NUMBER = /^-?(\d+(\.\d+)?|\.\d+)$/;
const WEIGHT = /^([1-9]00|normal|bold|lighter|bolder)$/;
const EASING = /^(linear|ease|ease-in|ease-out|ease-in-out|step-start|step-end|(cubic-bezier|steps|linear)\([^()]*\))$/;
const FAMILY = /^[A-Za-z0-9 ,"'_-]{1,200}$/;
const SHADOW = /^[A-Za-z0-9 ,.#()%-]{1,300}$/;

/** Whether a value fits a token type, and is safe to put in a CSS custom property. */
export function isTokenValue(type: TokenType, value: string): boolean {
  if (value.length > 300 || UNSAFE.test(value)) return false;
  switch (type) {
    case "color": return COLOR.test(value.trim());
    case "length": return LENGTH.test(value.trim());
    case "number": return NUMBER.test(value.trim());
    case "font-family": return FAMILY.test(value);
    case "font-weight": return WEIGHT.test(value.trim());
    case "duration": return DURATION.test(value.trim());
    case "easing": return EASING.test(value.trim());
    case "shadow": return SHADOW.test(value);
  }
}

/** A plugin's own tokens are allowed too, named `<plugin-id>.…`; they apply only where its CSS reads them. */
export function isPluginTokenName(name: string, pluginTopId: string): boolean {
  return name.startsWith(`${pluginTopId}.`) && /^[a-z0-9.-]+$/.test(name);
}

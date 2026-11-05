// Clover's base theme (spec §5.5): `theme.json` and `theme.css` are the plugin, as data. This module is
// for the parts we ship and their tests: the token catalog the theme sets, the theme reader and stack,
// and the checks our theme files keep.

import baseTheme from "../theme.json" with { type: "json" };
import { readTheme, type ThemeFile } from "./theme";

export * from "./catalog";
export * from "./contrast";
export * from "./theme";
export { checkThemeCss, hidesFrames, drawsOver, lifts, styleRules, hidingKeyframes, ALLOWED_AT_RULES, type CssCheckOptions, type Declaration } from "./css-check";
export { checkLayout, BOT_TAB_SPOTS, type LayoutCheck } from "./layout-check";

/** The base theme, read and checked. Its own tokens are `plugin.clover.*` (lane F's, until lane B's catalog has them). */
export const BASE_THEME: ThemeFile = readTheme(baseTheme, { strict: true, plugin: "clover" });

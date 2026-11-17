// MOSS's base theme (spec §5.5): `theme.json` and `theme.css` are the plugin, as data. This module is
// for the parts we ship and their tests: the token catalog the theme sets and the theme reader and stack. The CSS and sealed-frame lint is the SDK's (`@waifucave/moss-plugin-sdk/ui/testing`).

import baseTheme from "../theme.json" with { type: "json" };
import { readTheme, type ThemeFile } from "./theme";

export * from "./catalog";
export * from "./contrast";
export * from "./theme";

/** The base theme, read and checked. Its own tokens are `plugin.moss.*` (lane F's, until lane B's catalog has them). */
export const BASE_THEME: ThemeFile = readTheme(baseTheme, { strict: true, plugin: "moss" });

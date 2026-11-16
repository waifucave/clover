// A general theme lint, for any plugin's tests (exported from `@waifucave/moss-plugin-sdk/ui/testing`): the theme
// and part CSS rules of spec §5.5 (`checkThemeCss`), a rendered part's sealed frames left visible (`sealedProblems`),
// and a stylesheet's tokens and fallbacks against the catalog (`tokenFallbackProblems`).
export { checkThemeCss, hidesFrames, drawsOver, lifts, pullsOver, styleRules, hidingKeyframes, animatesAny, ALLOWED_AT_RULES, type CssCheckOptions, type Declaration } from "./css";
export { sealedProblems } from "./sealed";
export { tokenFallbackProblems, tokenUses, catalogValues, type TokenFallbackOptions } from "./tokens";

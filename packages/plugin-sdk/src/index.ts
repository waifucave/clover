// `@waifucave/clover-plugin-sdk` (spec §5.6): JSON Schemas and TypeScript types for the manifest, theme, layout,
// locale and index formats; the catalogs of spots, points, tokens, hooks and capabilities; the plugin API (§5.4) and
// the UI API (§5.5) as declarations; and the validation `clover plugin validate` runs. One source: the zod schemas in
// `manifest/` and `formats/` give the types, the validation and the JSON Schemas in `generated/`.
//
// `src/ui/` is lane E's: the UI API's implementation. Winter's Tier-2 API (`createPlugin`) stays exported until the
// plugin host replaces it (B-M2).

export * from "./version";
export * from "./jsonc";
export * from "./semver";

export * from "./manifest/fields";
export * from "./manifest/schema";
export type * from "./manifest/types";
export * from "./manifest/interpolation";
export * from "./manifest/names";
export * from "./manifest/validate";
export * from "./manifest/tree";

export * from "./formats/theme";
export * from "./formats/layout";
export * from "./formats/locale";
export * from "./formats/index-file";
export * from "./formats/tree-hash";

export * from "./catalogs/index";

export type * from "./api/plugin-api";
export { API_CALL_MAX_TIMEOUT_MS, API_CALL_TIMEOUT_MS, CONFIRM_TIMEOUT_MS, SYNCED_STORE_LIMIT_BYTES } from "./api/plugin-api";
export type * from "./api/ui-api";

export * from "./legacy-tier2";

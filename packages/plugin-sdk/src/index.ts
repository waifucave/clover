// `@waifucave/clover-plugin-sdk` (spec §5.6): JSON Schemas and TypeScript types for the manifest, theme, layout,
// locale and index formats; the catalogs of spots, points, tokens, hooks and capabilities; the plugin API (§5.4) and
// the UI API (§5.5) as declarations; and the validation `clover plugin validate` runs. One source: the zod schemas in
// `manifest/` and `formats/` give the types, the validation and the JSON Schemas in `generated/`.
//
// `src/ui/` is lane E's: the UI API's implementation. The inherited Tier-2 API (`createPlugin`) stays exported until
// the plugin host replaces it (B-M2).

export * from "./version";
export * from "./jsonc";
export * from "./semver";

export * from "./manifest/fields";
export * from "./manifest/keys";
export * from "./manifest/schema";
export type * from "./manifest/types";
export * from "./manifest/interpolation";
export * from "./manifest/names";
export * from "./manifest/validate";
export * from "./manifest/tree";
export * from "./manifest/args";

export * from "./formats/theme";
export * from "./formats/css-url";
export * from "./formats/layout";
export * from "./formats/locale";
export * from "./formats/index-file";
export * from "./formats/tree-hash";
export * from "./formats/upgrade";

export * from "./catalogs/index";

export * from "./api/keyed-fetch";
export type * from "./api/plugin-api";
export {
  API_CALL_MAX_TIMEOUT_MS, API_CALL_TIMEOUT_MS, CONFIRM_TIMEOUT_MS, KEY_NAME_RE, KEYED_FETCH_ERROR_CODES, KEYS_PER_PLUGIN_MAX,
  SYNCED_STORE_LIMIT_BYTES, WAIFUCAVE_AUTH, WAIFUCAVE_DOMAIN, WEBHOOK_BODY_MAX_BYTES, WEBHOOK_NEXT_GRACE_MS, WEBHOOK_NEXT_MAX,
  WEBHOOK_NEXT_MAX_BYTES, WEBHOOK_NEXT_WAIT_MAX_MS, WEBHOOK_ROUTINE_ID_RE, mayUseWaifucaveAuth, webhookKeyHash,
} from "./api/plugin-api";
export type * from "./api/ui-api";
export { isSealedLookAllowed } from "./api/ui-api";

export * from "./legacy-tier2";

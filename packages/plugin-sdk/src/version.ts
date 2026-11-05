// The plugin API's version and the file formats this SDK reads (spec §5.1 "Formats", §5.6).
//
// A plugin whose `engines.clover` range leaves out `PLUGIN_API_VERSION` is invalid, with the version it needs. A new
// core point is a minor version of the plugin API (§5.3); a breaking change is a major one, with one major version of
// deprecation notice (§14.2 item 22). Each format below is read in every version the app has shipped, and a newer one
// is refused with "needs a newer Clover".

/** The plugin API this SDK describes. */
export const PLUGIN_API_VERSION = "1.0.0";

/** The newest version of each file format this SDK reads. */
export const FORMATS = {
  manifest: 1,
  theme: 1,
  layout: 1,
  locale: 1,
  index: 1,
  revocations: 1,
} as const;
export type FormatName = keyof typeof FORMATS;

/** The catalogs' own version: it rises with the plugin API's minor version when a spot, point, token, hook event or
 *  capability is added. */
export const CATALOG_VERSION = 1;

/** The manifest's file name in a plugin folder (§5.1). */
export const MANIFEST_FILE = "clover.json";

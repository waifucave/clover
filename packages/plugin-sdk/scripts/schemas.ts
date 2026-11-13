// The plugin SDK's generated files (spec §5.6): a JSON Schema per format and the catalogs as JSON, under `generated/`.
// `generate.ts` writes them; `test/generated.test.ts` checks the committed copies are current.
import { z } from "zod";
import { catalogJson } from "../src/catalogs/index";
import { IndexSchema } from "../src/formats/index-file";
import { LayoutContributionSchema, LayoutFileSchema } from "../src/formats/layout";
import { LocaleSchema } from "../src/formats/locale";
import { ThemeSchema } from "../src/formats/theme";
import { DOTTED_POINT_NAME_RE } from "../src/manifest/fields";
import { ManifestSchema } from "../src/manifest/schema";

type Json = Record<string, unknown>;

function toSchema(s: z.ZodType, title: string, description: string): Json {
  const out = z.toJSONSchema(s, { target: "draft-2020-12", io: "input", unrepresentable: "any", reused: "ref" }) as Json;
  return { $schema: out.$schema, title, description, ...out };
}

/** `contributes` takes the core points by name and any dotted name for a point another plugin declares (§5.9). */
function manifestSchema(): Json {
  const s = toSchema(ManifestSchema, "clover.json", "A Clover plugin's manifest, format 1 (spec §5.9).");
  const props = s.properties as Json;
  const contributes = props.contributes as Json;
  const pluginPoint = contributes.additionalProperties;
  delete contributes.additionalProperties;
  contributes.patternProperties = { [DOTTED_POINT_NAME_RE.source]: pluginPoint };
  contributes.additionalProperties = false;
  return s;
}

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

/** File name (under `generated/`) → content. */
export function buildSdkArtifacts(): Map<string, string> {
  return new Map([
    ["clover.schema.json", json(manifestSchema())],
    ["theme.schema.json", json(toSchema(ThemeSchema, "Clover theme", "Theme format 1: design tokens, fonts, icons and cleaned CSS (spec §5.5)."))],
    ["layout.schema.json", json(toSchema(LayoutFileSchema, "Clover layout", "Layout format 1: how a bot's tab arranges its parts (spec §5.5): a whole layout, or a patch that extends the stock tab and states only its changes."))],
    ["layout-patch.schema.json", json(toSchema(LayoutContributionSchema, "Clover tab patch", "A patch any plugin adds to bots' tabs (a `ui` entry on `bot.tab` with `layout`, spec §5.5): changes only, made on the tab as it stands at its turn, and its own CSS."))],
    ["locale.schema.json", json(toSchema(LocaleSchema, "Clover locale", "Locale format 1: a string table for one language (spec §5.5)."))],
    ["index.schema.json", json(toSchema(IndexSchema, "Clover plugin index", "Index format 1: a plain list of plugins, each version with its tree hash and download URL (spec §5.1)."))],
    ["catalog.json", json(catalogJson())],
  ]);
}

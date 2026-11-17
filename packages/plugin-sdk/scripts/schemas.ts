// The plugin SDK's generated files (spec §5.6): a JSON Schema per format and the catalogs as JSON, under `generated/`.
// `generate.ts` writes them; `test/generated.test.ts` checks the committed copies are current.
import { z } from "zod";
import { catalogJson } from "../src/catalogs/index";
import { IndexSchema } from "../src/formats/index-file";
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
  const s = toSchema(ManifestSchema, "moss.json", "A MOSS plugin's manifest, format 1 (spec §5.9).");
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
    ["moss.schema.json", json(manifestSchema())],
    ["theme.schema.json", json(toSchema(ThemeSchema, "MOSS theme", "Theme format 1: design tokens, fonts, icons and cleaned CSS (spec §5.5)."))],
    ["locale.schema.json", json(toSchema(LocaleSchema, "MOSS locale", "Locale format 1: a string table for one language (spec §5.5)."))],
    ["index.schema.json", json(toSchema(IndexSchema, "MOSS plugin index", "Index format 1: a plain list of plugins, each version with its tree hash and download URL (spec §5.1)."))],
    ["catalog.json", json(catalogJson())],
  ]);
}

// The catalogs as one JSON document (spec §5.6: "The docs are generated from the same catalogs"), written to
// `generated/catalog.json` by `scripts/generate.ts`.
import { z } from "zod";
import { CATALOG_VERSION, PLUGIN_API_VERSION } from "../version";
import { API_CALLS } from "./api-calls";
import { CAPABILITIES } from "./capabilities";
import { CLAUDE_HOOK_EVENTS, HOOK_DEFAULT_TIMEOUT_MS, HOOK_EVENTS, HOOK_RETURNS } from "./hooks";
import type { PointDecl } from "../manifest/types";
import { CORE_POINTS, DATA_POINTS, WELL_KNOWN_POINT_NAMES, dataPointInfo } from "./points";
import { SPOTS, spotInfo } from "./spots";
import { TOKENS } from "./tokens";

export * from "./api-calls";
export * from "./api-signatures";
export * from "./avatars";
export * from "./capabilities";
export * from "./hooks";
export * from "./points";
export * from "./spots";
export * from "./tokens";

const schema = (s: z.ZodType) => z.toJSONSchema(s, { target: "draft-2020-12", io: "input", unrepresentable: "any" });

/** The catalog's own declaration of a well-known name (§5.4), as a manifest would write it: what the registry records
 *  for that point whoever declares it, so its `keep` and `needs` hold whatever the declarer wrote (review S2). A plugin
 *  that declares a well-known name declares only its shape and whether it is a spot (`{ shape, props: {} }` is
 *  enough); the rest is the catalog's. Undefined for any other name, the core's own points included. */
export function catalogPointDecl(name: string): PointDecl | undefined {
  if (!WELL_KNOWN_POINT_NAMES.has(name)) return undefined;
  const s = spotInfo(name);
  if (s) {
    return {
      shape: s.shape, fields: schema(s.fields), props: schema(s.props),
      ...(s.needs ? { needs: [...s.needs] } : {}), ...(s.keep ? { keep: [...s.keep] } : {}), ...(s.gates ? { gates: { ...s.gates } } : {}),
      ...(s.context ? { context: [...s.context] } : {}), doc: s.doc,
    };
  }
  const p = dataPointInfo(name)!;
  return { shape: p.shape, fields: schema(p.entry), doc: p.doc };
}

export function catalogJson() {
  return {
    catalog: CATALOG_VERSION,
    pluginApi: PLUGIN_API_VERSION,
    capabilities: CAPABILITIES,
    hooks: {
      events: HOOK_EVENTS,
      returns: HOOK_RETURNS,
      claudeEvents: CLAUDE_HOOK_EVENTS,
      defaultTimeoutMs: HOOK_DEFAULT_TIMEOUT_MS,
    },
    corePoints: CORE_POINTS,
    dataPoints: DATA_POINTS.map((p) => ({ name: p.name, shape: p.shape, declaredBy: p.declaredBy, kind: p.kind, doc: p.doc, fields: schema(p.entry) })),
    spots: SPOTS.map((s) => ({
      name: s.name, shape: s.shape, declaredBy: s.declaredBy, inBotTab: s.inBotTab,
      ...(s.keys ? { keys: s.keys } : {}), ...(s.keep ? { keep: s.keep } : {}), ...(s.needs ? { needs: s.needs } : {}), ...(s.gates ? { gates: s.gates } : {}),
      ...(s.context ? { context: s.context } : {}), doc: s.doc, fields: schema(s.fields), props: schema(s.props),
    })),
    tokens: TOKENS,
    apiCalls: API_CALLS,
  };
}

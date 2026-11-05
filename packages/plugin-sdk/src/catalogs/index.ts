// The catalogs as one JSON document (spec §5.6: "The docs are generated from the same catalogs"), written to
// `generated/catalog.json` by `scripts/generate.ts`.
import { z } from "zod";
import { CATALOG_VERSION, PLUGIN_API_VERSION } from "../version";
import { API_CALLS } from "./api-calls";
import { CAPABILITIES } from "./capabilities";
import { CLAUDE_HOOK_EVENTS, HOOK_DEFAULT_TIMEOUT_MS, HOOK_EVENTS, HOOK_RETURNS } from "./hooks";
import { CORE_POINTS, DATA_POINTS } from "./points";
import { SPOTS } from "./spots";
import { TOKENS } from "./tokens";

export * from "./api-calls";
export * from "./capabilities";
export * from "./hooks";
export * from "./points";
export * from "./spots";
export * from "./tokens";

const schema = (s: z.ZodType) => z.toJSONSchema(s, { target: "draft-2020-12", io: "input", unrepresentable: "any" });

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
      ...(s.keys ? { keys: s.keys } : {}), ...(s.keep ? { keep: s.keep } : {}), ...(s.needs ? { needs: s.needs } : {}),
      ...(s.context ? { context: s.context } : {}), doc: s.doc, fields: schema(s.fields), props: schema(s.props),
    })),
    tokens: TOKENS,
    apiCalls: API_CALLS,
  };
}

// `models.list` (lane A): built from the model plugins' catalog, every key inside the protocol's limits, blocked rows
// and blocked providers left out, signed-in state per provider, a session's own list.
import { describe, expect, test } from "bun:test";
import { ERR } from "@waifucave/clover-protocol";
import { loadCatalog, type WinterCatalog } from "@waifucave/clover-provider-catalog";
import { catalogModelListings, listModels, MODELS_LIST, ModelListing, modelsMethods } from "../../src/runtime-sdk/models-list";
import { modelPluginId } from "../../src/runtime-sdk/model-plugins/bundled";
import { toolsRefusedFor } from "../../src/runtime-sdk/provider-selection";

const catalog = loadCatalog();
const everyProvider = new Set(catalog.providers.map((p) => p.id));

describe("models.list", () => {
  test("every model of the catalog fits the protocol's limits, none dropped", async () => {
    const result = await listModels({ signedIn: () => everyProvider, catalog: () => catalog }, {});
    // The method's own result schema takes the whole answer.
    expect(MODELS_LIST.result.safeParse(result).success).toBe(true);
    for (const m of result.models) {
      const parsed = ModelListing.safeParse(m);
      if (!parsed.success) throw new Error(`${m.id}: ${parsed.error.message}`);
    }
    // Every servable row is there: nothing was cut to fit.
    const blockedProviders = new Set(catalog.providers.filter((p) => p.risk.class === "blocked" || p.scope !== "llm").map((p) => p.id));
    const servable = catalog.models.filter((r) => !blockedProviders.has(r.providerId) && r.status !== "blocked" && r.status !== "deprecated" && !toolsRefusedFor(r));
    expect(result.models.map((m) => m.id).sort()).toEqual(servable.map((r) => r.key).sort());
    expect(result.models.length).toBeGreaterThan(100);
    // Each row's efforts are the catalog's own, whole.
    for (const r of servable) {
      const listed = result.models.find((m) => m.id === r.key)!;
      const vocab = r.reasoning?.supported.value === false ? [] : (r.reasoning?.efforts ?? []);
      expect(listed.efforts).toEqual(vocab);
    }
  });

  test("blocked rows and blocked providers are never offered; signedIn follows the credentials", () => {
    const base = loadCatalog();
    const [a, b] = base.providers.filter((p) => p.scope === "llm" && p.risk.class !== "blocked" && base.models.some((m) => m.providerId === p.id && m.status !== "blocked" && !toolsRefusedFor(m)));
    const rowsOf = (id: string) => base.models.filter((m) => m.providerId === id && m.status !== "blocked" && m.status !== "deprecated" && !toolsRefusedFor(m));
    const blockedRow = rowsOf(a!.id)[0]!;
    const cat: WinterCatalog = {
      ...base,
      providers: [a!, { ...b!, risk: { class: "blocked", reasons: ["test"] } }],
      models: [...rowsOf(a!.id).map((m) => (m.key === blockedRow.key ? { ...m, status: "blocked" as const } : m)), ...rowsOf(b!.id)],
    };
    const listed = catalogModelListings(cat, new Set([a!.id]));
    expect(listed.some((m) => m.id === blockedRow.key)).toBe(false);
    expect(listed.some((m) => m.provider === b!.id)).toBe(false);
    expect(listed.length).toBe(rowsOf(a!.id).length - 1);
    expect(listed.every((m) => m.signedIn && m.plugin === modelPluginId(a!.id) && m.providerName === a!.displayName)).toBe(true);
    expect(catalogModelListings(cat, new Set()).every((m) => !m.signedIn)).toBe(true);
  });

  test("the default model rides along; a session's runtime decides its list", async () => {
    const own = [{ id: "cursor/auto", name: "Auto", provider: "cursor", providerName: "Cursor", plugin: "clover/agent-cursor", efforts: [], images: false, signedIn: true }];
    const deps = {
      signedIn: () => new Set<string>(),
      catalog: () => catalog,
      defaultModel: () => "anthropic/claude-opus-5-5",
      sessionModels: (id: string) => (id === "s_agent" ? { kind: "own" as const, models: own } : id === "b_alpha" ? { kind: "catalog" as const } : undefined),
    };
    const agent = await listModels(deps, { session: "s_agent" });
    expect(agent).toEqual({ models: own, default: "anthropic/claude-opus-5-5" });
    const bot = await listModels(deps, { session: "b_alpha" });
    expect(bot.models.length).toBeGreaterThan(100);
    const methods = modelsMethods(deps);
    const call = methods["models.list"]!;
    await expect(call({ session: "s_nope" }, { caller: { kind: "user", client: "app" } as never })).rejects.toMatchObject({ code: ERR.NOT_FOUND });
    await expect(call({ session: 5 }, { caller: { kind: "user", client: "app" } as never })).rejects.toMatchObject({ code: ERR.INVALID_PARAMS });
    const all = (await call({}, { caller: { kind: "user", client: "app" } as never })) as { models: unknown[]; default?: string };
    expect(all.default).toBe("anthropic/claude-opus-5-5");
    expect(MODELS_LIST.result.safeParse(all).success).toBe(true);
  });
});

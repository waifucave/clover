// The startup race (the model plugins come up a few seconds after the daemon): what a session or an internal job was
// given before they were up, or before they changed, is replaced. The listeners fire on an install and on a rebuild
// that moves the key, once per move; a coding session's child opened on another key is evicted, at once when idle and
// at its idle boundary when mid-turn (re-checked there); the internal jobs' provider is built again on a new catalog.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCatalog } from "@waifucave/clover-provider-catalog";
import { FileSecretStore } from "../../../src/auth/secret-store";
import { writeCredentialMaterial } from "../../../src/auth/credential-material";
import { createInternalProviderView } from "../../../src/providers/internal-view";
import { createInternalRouter, isInternalRefusal } from "../../../src/providers/internal-router";
import { Settings } from "../../../src/settings";
import { evictSessionsForModelCatalog } from "../../../src/runtime-sdk/credentials";
import { installModelPlugins, modelCatalogMaybeChanged, onModelCatalogChange } from "../../../src/runtime-sdk/model-plugins";
import { setActiveCatalogSource } from "../../../src/runtime-sdk/model-plugins/catalog-source";
import { compiledProviderKey, providerKeyIn, type ModelPlugins } from "../../../src/runtime-sdk/model-plugins/service";

afterEach(() => {
  installModelPlugins(undefined);
  setActiveCatalogSource(undefined);
});

test("the listeners hear an install, a rebuild that moves the key and a removal, once per move, with the plugins whose served adapter changed", () => {
  const heard: { key: string; plugins: string[] }[] = [];
  const off = onModelCatalogChange((c) => heard.push(c));
  try {
    let key = "sha-1:plugin.a";
    let served = new Map([["plugin.a", { pluginId: "a", description: { version: "1" } }]]);
    const plugins = { sessionKey: () => key, catalog: undefined, providerAdapterFor: () => undefined, get snapshot() { return { served }; } } as unknown as ModelPlugins;
    installModelPlugins(plugins);
    modelCatalogMaybeChanged();
    expect(heard).toEqual([{ key: "sha-1:plugin.a", plugins: ["a"] }]);
    key = "sha-2:plugin.a,plugin.b";
    served = new Map([...served, ["plugin.b", { pluginId: "b", description: { version: "1" } }]]);
    modelCatalogMaybeChanged();
    modelCatalogMaybeChanged();
    expect(heard.at(-1)).toEqual({ key: "sha-2:plugin.a,plugin.b", plugins: ["b"] });
    expect(heard).toHaveLength(2);
    installModelPlugins(undefined);
    expect(heard.at(-1)).toEqual({ key: "compiled", plugins: ["a", "b"] });
  } finally {
    off();
  }
});

test("a provider's key moves only with its own rows or how its adapter is served; another provider's change leaves it", () => {
  const catalog = loadCatalog();
  const google = catalog.providers.find((p) => p.id === "google")!;
  const none = new Map<string, { provider: string; description: { version: string } }>();
  const base = providerKeyIn(catalog, "google", none);
  expect(base).toStartWith("compiled:");
  expect(compiledProviderKey("google")).toBe(base);
  expect(providerKeyIn(catalog, "no-such-provider", none)).toBe("absent");
  // Another provider's rows change, and another plugin's adapter is served: google's key stays.
  const groqRow = catalog.models.find((m) => m.providerId === "groq")!;
  const other = { ...catalog, models: [...catalog.models, { ...groqRow, key: "groq/extra", upstreamId: "extra" }] };
  expect(providerKeyIn(other, "google", new Map([["plugin.acme.adapter", { provider: "acme", description: { version: "1" } }]]))).toBe(base);
  // Its own adapter served by its plugin, then a new version of it, then a row of its own changed: each moves it.
  const hosted = providerKeyIn(catalog, "google", new Map([[google.adapterId, { provider: "google", description: { version: "1.0.0" } }]]));
  expect(hosted).toStartWith(`host:${google.adapterId}@1.0.0:`);
  expect(hosted).not.toBe(base);
  expect(providerKeyIn(catalog, "google", new Map([[google.adapterId, { provider: "google", description: { version: "1.0.1" } }]]))).not.toBe(hosted);
  const gRow = catalog.models.find((m) => m.providerId === "google")!;
  const changed = { ...catalog, models: catalog.models.map((m) => (m === gRow ? { ...m, displayName: `${m.displayName} (new)` } : m)) };
  expect(providerKeyIn(changed, "google", none)).not.toBe(base);
});

type Leg = { sessionId: string; turnRunning: boolean; idle(): Promise<void>; backgroundRunning?: boolean; backgroundDone?(): Promise<void> };

test("a coding session is replaced only when its own provider changed: another plugin's change leaves it; its own provider coming up replaces it once; idle at once, mid-turn at its boundary", async () => {
  const keys = new Map<string, string>([["google", "compiled:g:1"], ["acme", "absent"], ["openai", "generic:o:1"]]);
  const recorded = new Map<string, { provider: string; key: string }>([
    ["s_google", { provider: "google", key: "compiled:g:1" }],
    ["s_acme", { provider: "acme", key: "absent" }],
    ["s_busy", { provider: "acme", key: "absent" }],
    ["s_openai", { provider: "openai", key: "generic:o:1" }],
  ]);
  const evicted: string[] = [];
  const lines: string[] = [];
  let finishBusy!: () => void;
  const busyDone = new Promise<void>((r) => { finishBusy = r; });
  const busy: Leg = { sessionId: "s_busy", turnRunning: true, idle: () => busyDone };
  const sessions: Leg[] = [
    { sessionId: "s_google", turnRunning: false, idle: async () => {} },
    { sessionId: "s_acme", turnRunning: false, idle: async () => {} },
    busy,
    { sessionId: "s_openai", turnRunning: false, idle: async () => {} },
  ];
  const deps = {
    list: () => sessions, modelProviderKeyOf: (id: string) => recorded.get(id), currentKey: (p: string) => keys.get(p) ?? "absent",
    evict: async (id: string) => { evicted.push(id); recorded.delete(id); }, log: (l: string) => lines.push(l),
  };
  // An unrelated plugin (another provider) changed: nobody is replaced.
  keys.set("zeta", "host:z@1:abc");
  expect(await evictSessionsForModelCatalog(deps, ["zeta-models"])).toEqual([]);
  expect(evicted).toEqual([]);
  // acme's plugin comes up: the acme sessions only; the idle one at once, the busy one at its turn's end.
  keys.set("acme", "host:plugin.acme.adapter@1:abc");
  expect(await evictSessionsForModelCatalog(deps, ["acme-models"])).toEqual(["s_acme", "s_busy"]);
  expect(evicted).toEqual(["s_acme"]);
  expect(lines.at(-1)).toBe("model plugins: replacing s_acme's child: its provider acme changed (acme-models changed)");
  (busy as { turnRunning: boolean }).turnRunning = false;
  finishBusy();
  await Bun.sleep(10);
  expect(evicted).toEqual(["s_acme", "s_busy"]);
  // Once, not again: the same key again acts on nothing.
  expect(await evictSessionsForModelCatalog(deps, ["acme-models"])).toEqual([]);
});

test("an idle session running background work is left until it ends, unless its provider became unusable", async () => {
  const keys = new Map<string, string>([["acme", "host:a@2:x"], ["gone", "absent"]]);
  const recorded = new Map<string, { provider: string; key: string }>([
    ["s_bg", { provider: "acme", key: "host:a@1:x" }],
    ["s_gone", { provider: "gone", key: "host:g@1:x" }],
  ]);
  const evicted: string[] = [];
  let endWork!: () => void;
  const work = new Promise<void>((r) => { endWork = r; });
  const bg: Leg = { sessionId: "s_bg", turnRunning: false, idle: async () => {}, backgroundRunning: true, backgroundDone: () => work };
  const gone: Leg = { sessionId: "s_gone", turnRunning: false, idle: async () => {}, backgroundRunning: true, backgroundDone: () => new Promise<void>(() => {}) };
  const lines: string[] = [];
  const acted = await evictSessionsForModelCatalog({
    list: () => [bg, gone], modelProviderKeyOf: (id) => recorded.get(id), currentKey: (p) => keys.get(p) ?? "absent",
    evict: async (id) => { evicted.push(id); recorded.delete(id); }, log: (l) => lines.push(l),
  }, ["acme-models"]);
  expect(acted).toEqual(["s_bg", "s_gone"]);
  // Its provider gone: replaced at once, background work or not. The other waits for its work.
  expect(evicted).toEqual(["s_gone"]);
  expect(lines).toContain("model plugins: s_bg's provider acme changed (acme-models changed); its child is replaced once its background work ends");
  (bg as { backgroundRunning: boolean }).backgroundRunning = false;
  endWork();
  await Bun.sleep(10);
  expect(evicted).toEqual(["s_gone", "s_bg"]);
});

test("the internal jobs' provider is built again when what the model plugins give ITS provider moves (their coming up, its own plugin changing), and kept on another provider's change", async () => {
  const secrets = new FileSecretStore(mkdtempSync(join(tmpdir(), "clover-a-catalog-change-")));
  await writeCredentialMaterial(secrets, "deepseek:default", { kind: "api-key", key: "sk-deepseek" });
  const view = createInternalProviderView({ secrets, log: () => {} });
  await view.refresh();
  const router = createInternalRouter({ view, secrets });
  const settings = Settings.parse({ schemaVersion: 3, provider: { model: "deepseek/deepseek-flash" } });
  const providerOf = () => {
    const call = router.resolve("titles.model", settings);
    if (isInternalRefusal(call)) throw new Error(`refused: ${JSON.stringify(call)}`);
    return call.provider;
  };
  const first = providerOf();
  expect(providerOf()).toBe(first);
  // The model plugins come up, giving deepseek something else: built again on it.
  const keys: Record<string, string> = { deepseek: "generic:d:plugins-1", acme: "absent" };
  installModelPlugins({ catalog: undefined, sessionKey: () => "s", providerKey: (p: string) => keys[p] ?? "absent", providerAdapterFor: () => undefined } as unknown as ModelPlugins);
  const second = providerOf();
  expect(second).not.toBe(first);
  expect(providerOf()).toBe(second);
  // Another provider's plugin changes: kept.
  keys.acme = "host:acme@1:x";
  expect(providerOf()).toBe(second);
  // Its own changes: built again.
  keys.deepseek = "generic:d:plugins-2";
  expect(providerOf()).not.toBe(second);
});

test("modelOffer: offered as the picker lists it; starting while the model plugins settle and a plugin that is on contributes its provider; else absent", async () => {
  const { modelOffer, contributedProviders, catalogModelListings } = await import("../../../src/runtime-sdk/models-list");
  const catalog = loadCatalog();
  const listed = catalogModelListings(catalog, new Set())[0]!.id;
  const records = [{ enabled: true, manifest: { contributes: { models: [{ provider: "acme" }] } } }, { enabled: false, manifest: { contributes: { models: [{ provider: "off" }] } } }, { manifest: undefined }];
  expect(contributedProviders(records)).toEqual(["acme"]);
  const o = (settling: boolean) => ({ catalog, settling, contributed: () => contributedProviders(records) });
  expect(modelOffer(listed, o(false))).toBe("offered");
  expect(modelOffer(listed, o(true))).toBe("offered");
  expect(modelOffer("acme/fast", o(true))).toBe("starting");
  expect(modelOffer("acme/fast", o(false))).toBe("absent");
  expect(modelOffer("off/fast", o(true))).toBe("absent");
  expect(modelOffer("nobody/fast", o(true))).toBe("absent");
  // A provider the user pointed at an endpoint of their own takes its own model names (a local server's), while that
  // provider is on; a provider that isn't, or one with no endpoint of the user's, doesn't.
  const provider = catalog.providers[0]!.id;
  const own = (p: string) => p === provider || p === "nowhere";
  expect(modelOffer(`${provider}/my-local-finetune`, { ...o(false), userEndpoint: own })).toBe("offered");
  expect(modelOffer(`${provider}/my-local-finetune`, o(false))).toBe("absent");
  expect(modelOffer("nowhere/my-model", { ...o(false), userEndpoint: own })).toBe("absent");
  // A deprecated row the picker leaves out isn't offered either.
  const deprecated = catalog.models.find((m) => m.status === "deprecated");
  if (deprecated !== undefined) expect(modelOffer(deprecated.key, o(false))).toBe("absent");
});

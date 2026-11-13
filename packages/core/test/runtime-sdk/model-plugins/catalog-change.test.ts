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
import type { ModelPlugins } from "../../../src/runtime-sdk/model-plugins/service";

afterEach(() => {
  installModelPlugins(undefined);
  setActiveCatalogSource(undefined);
});

test("the listeners hear an install, a rebuild that moves the key and a removal, once per move", () => {
  const heard: string[] = [];
  const off = onModelCatalogChange((k) => heard.push(k));
  try {
    let key = "sha-1:plugin.a";
    const plugins = { sessionKey: () => key, catalog: undefined, providerAdapterFor: () => undefined } as unknown as ModelPlugins;
    installModelPlugins(plugins);
    modelCatalogMaybeChanged();
    expect(heard).toEqual(["sha-1:plugin.a"]);
    key = "sha-2:plugin.a,plugin.b";
    modelCatalogMaybeChanged();
    modelCatalogMaybeChanged();
    expect(heard).toEqual(["sha-1:plugin.a", "sha-2:plugin.a,plugin.b"]);
    installModelPlugins(undefined);
    expect(heard.at(-1)).toBe("compiled");
  } finally {
    off();
  }
  installModelPlugins({ sessionKey: () => "after-off" } as unknown as ModelPlugins);
  expect(heard.at(-1)).toBe("compiled");
});

test("a coding session's child opened on another key is replaced: at once when idle, at its idle boundary when mid-turn, and not when it moved meanwhile", async () => {
  const keys = new Map<string, string | undefined>([["s_idle", "compiled"], ["s_busy", "compiled"], ["s_same", "sha-1:x"], ["s_gone", undefined], ["s_moved", "compiled"]]);
  const evicted: string[] = [];
  let finishBusy!: () => void;
  let finishMoved!: () => void;
  const busy = new Promise<void>((r) => { finishBusy = r; });
  const moved = new Promise<void>((r) => { finishMoved = r; });
  const sessions = [
    { sessionId: "s_idle", turnRunning: false, idle: async () => {} },
    { sessionId: "s_busy", turnRunning: true, idle: () => busy },
    { sessionId: "s_same", turnRunning: false, idle: async () => {} },
    { sessionId: "s_gone", turnRunning: false, idle: async () => {} },
    { sessionId: "s_moved", turnRunning: true, idle: () => moved },
  ];
  const acted = await evictSessionsForModelCatalog({
    list: () => sessions, modelCatalogKeyOf: (id) => keys.get(id), evict: async (id) => { evicted.push(id); },
  }, "sha-1:x");
  expect(acted).toEqual(["s_idle", "s_busy", "s_moved"]);
  expect(evicted).toEqual(["s_idle"]);
  // s_moved reopened on the new key during its turn (another eviction, a model switch): left alone at its boundary.
  keys.set("s_moved", "sha-1:x");
  finishMoved();
  finishBusy();
  await Bun.sleep(10);
  expect(evicted).toEqual(["s_idle", "s_busy"]);
});

test("the internal jobs' provider is built again when the catalog moves (the model plugins coming up), and kept while it doesn't", async () => {
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
  // The model plugins' catalog (another catalog object): built again on it.
  const plugins = { ...loadCatalog() };
  setActiveCatalogSource(() => plugins);
  const second = providerOf();
  expect(second).not.toBe(first);
  expect(providerOf()).toBe(second);
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
  // A deprecated row the picker leaves out isn't offered either.
  const deprecated = catalog.models.find((m) => m.status === "deprecated");
  if (deprecated !== undefined) expect(modelOffer(deprecated.key, o(false))).toBe("absent");
});

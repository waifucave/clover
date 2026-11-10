// #302's review B1: the model plugins' `net.fetch` and `secrets.get` are handlers in B's router (`createApiRouter`),
// never a router of their own. B's gate runs first (an un-OK'd plugin never reaches them), every other call of the
// plugin API keeps its own handler, and until B's 2f/2g a third-party plugin is refused with the reason.
import { describe, expect, test } from "bun:test";
import { catalogPointDecl } from "../../../../plugin-sdk/src/catalogs/index";
import { FakePluginRegistry, type FakePluginInput } from "../../../src/contracts/fakes/plugin-registry";
import { createApiRouter, type ApiHandlers } from "../../../src/plugin-host/api/router";
import { modelPluginApiHandlers } from "../../../src/runtime-sdk/model-plugins/plugin-api";

const manifest = (id: string) => ({ manifest: 1, id, name: id, capabilities: ["network:api.example.com", "storage"], contributes: { models: [{ provider: `${id.replace(/\W/g, "-")}-p`, name: "P", catalog: [], auth: [{ method: "api-key", secret: "api-key" }], endpoint: { protocol: "openai-chat", baseUrl: "https://api.example.com/v1" } }] } }) as never;

function world(inputs: FakePluginInput[]) {
  const registry = new FakePluginRegistry({ catalog: catalogPointDecl, plugins: inputs });
  const fetched: string[] = [];
  const model = modelPluginApiHandlers({
    registry,
    tokens: () => ({ current: async () => ({ value: "k", generation: 1 }), newer: async () => null }),
    secret: async () => "the-secret",
    fetch: async (url) => { fetched.push(url); return new Response("ok"); },
  });
  const other: ApiHandlers = { "settings.get": async () => "stored" };
  const router = createApiRouter({ registry, handlers: [other, model], allowNetwork: () => true });
  const call = (pluginId: string, path: string, args: unknown[] = []) => router({ pluginId, process: "shared", path, args, caller: { kind: "plugin", pluginId } as never });
  return { call, fetched };
}

describe("the model plugins' calls behind B's gate", () => {
  test("a third-party plugin is refused a keyed fetch with the reason; its other calls still work", async () => {
    const w = world([{ id: "acme", manifest: manifest("acme"), source: "local" }]);
    await expect(w.call("acme", "net.fetch", ["https://api.example.com/v1/models"])).rejects.toThrow(/bundled plugins only/);
    expect(w.fetched).toEqual([]);
    expect(await w.call("acme", "settings.get", ["x"])).toBe("stored");
  });

  test("an un-OK'd plugin never reaches the handler: B's gate refuses it first", async () => {
    const w = world([{ id: "found", manifest: manifest("found"), source: "local", approved: false }]);
    await expect(w.call("found", "net.fetch", ["https://api.example.com/v1/models"])).rejects.toThrow();
    await expect(w.call("found", "net.fetch", ["https://api.example.com/v1/models"])).rejects.not.toThrow(/bundled plugins only/);
    expect(w.fetched).toEqual([]);
  });
});

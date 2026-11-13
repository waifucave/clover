// #302's review B1: the model plugins' `net.fetch` and `secrets.get` are handlers in B's router (`createApiRouter`),
// never a router of their own. B's gate runs first (an un-OK'd plugin never reaches them) and every other call of the
// plugin API keeps its own handler. Row 1.91: a third-party plugin's keyed fetch reaches its own declared hosts with
// its own stored key (never a provider slot, never another plugin's), `secrets.get` reads only its own entries' secrets
// in a process of its own, and neither the account token nor the keyless public path is a third party's.
import { describe, expect, test } from "bun:test";
import { catalogPointDecl } from "../../../../plugin-sdk/src/catalogs/index";
import type { SecretStore as DaemonSecretStore } from "../../../src/auth/secret-store";
import { FakePluginRegistry, type FakePluginInput } from "../../../src/contracts/fakes/plugin-registry";
import { MemorySecretStore } from "../../../src/contracts/fakes/secret-store";
import { guardApiRouter, hostProcessFor } from "../../../src/contracts/plugin-host";
import { createApiRouter, type ApiHandlers } from "../../../src/plugin-host/api/router";
import { pluginNetworkAllowed } from "../../../src/plugin-host/daemon-host";
import { keychainModelPluginCredentials } from "../../../src/runtime-sdk/model-plugins/keychain-tokens";
import { modelPluginApiHandlers, secretStoreCredentials } from "../../../src/runtime-sdk/model-plugins/plugin-api";

const manifest = (id: string, o: { capabilities?: string[]; auth?: unknown[]; process?: "own"; provider?: string } = {}) => ({
  manifest: 1, id, name: id, capabilities: o.capabilities ?? ["network:api.example.com", "storage"],
  ...(o.process ? { host: { entry: "host/index.js", process: o.process } } : {}),
  contributes: { models: [{ provider: o.provider ?? `${id.replace(/\W/g, "-")}-p`, name: "P", catalog: [], auth: o.auth ?? [{ method: "api-key", secret: "api-key" }], adapter: "adapter" }] },
}) as never;

class DaemonStore implements DaemonSecretStore {
  readonly values = new Map<string, string>();
  async get(name: string): Promise<string | null> { return this.values.get(name) ?? null; }
  async set(name: string, value: string): Promise<void> { this.values.set(name, value); }
  async delete(name: string): Promise<boolean> { return this.values.delete(name); }
}

async function world(inputs: FakePluginInput[]) {
  const registry = new FakePluginRegistry({ catalog: catalogPointDecl, plugins: inputs });
  // The daemon's provider slots hold keys too: none of them is a third party's.
  const slots = new DaemonStore();
  slots.values.set("openai:default", JSON.stringify({ kind: "api-key", key: "SLOT-KEY-openai" }));
  // Each third party's own items, as the user stored them through its sign-in.
  const items = new MemorySecretStore();
  await items.set({ owner: { kind: "plugin", pluginId: "acme" }, name: "api-key" }, "ACME-OWN-KEY");
  await items.set({ owner: { kind: "plugin", pluginId: "beta" }, name: "api-key" }, "BETA-OWN-KEY");
  await items.set({ owner: { kind: "plugin", pluginId: "signer" }, name: "sa" }, "SIGNER-SECRET");
  const creds = keychainModelPluginCredentials({ registry, secrets: slots, fallback: secretStoreCredentials(items) });
  const sent: { url: string; headers: Record<string, string> }[] = [];
  const model = modelPluginApiHandlers({
    registry, tokens: creds.tokens, secret: creds.secret,
    fetch: async (url, init) => { const h: Record<string, string> = {}; new Headers(init.headers).forEach((v, k) => { h[k] = v; }); sent.push({ url, headers: h }); return new Response("ok"); },
  });
  const other: ApiHandlers = { "settings.get": async () => "stored" };
  const gate = createApiRouter({ registry, handlers: [other, model], allowNetwork: pluginNetworkAllowed });
  const router = guardApiRouter(gate, (id) => {
    const r = registry.get(id);
    return r === undefined ? undefined : { id: r.id, source: r.source, ...(r.manifest?.host?.process === "own" ? { process: "own" as const } : {}) };
  });
  const call = (pluginId: string, path: string, args: unknown[] = [], process?: string) => {
    const r = registry.get(pluginId);
    const p = process ?? (r === undefined ? "shared" : hostProcessFor({ id: r.id, source: r.source, ...(r.manifest?.host?.process === "own" ? { process: "own" as const } : {}) }));
    return router({ pluginId, process: p as never, path, args, caller: { kind: "plugin", pluginId } as never });
  };
  return { call, sent };
}

describe("the model plugins' calls behind B's gate", () => {
  test("a third-party plugin's keyed fetch reaches its declared host with its own stored key; another's key, a provider slot, an undeclared host: never", async () => {
    const w = await world([
      { id: "acme", manifest: manifest("acme"), source: "local" },
      { id: "beta", manifest: manifest("beta", { auth: [{ method: "api-key", secret: "api-key", placement: { header: "x-api-key" } }] }), source: "local" },
    ]);
    expect(await (await w.call("acme", "net.fetch", ["https://api.example.com/v1/models"]) as Response).text()).toBe("ok");
    expect(await (await w.call("beta", "net.fetch", ["https://api.example.com/v1/models"]) as Response).text()).toBe("ok");
    expect(w.sent.map((s) => [s.headers.authorization ?? null, s.headers["x-api-key"] ?? null])).toEqual([["Bearer ACME-OWN-KEY", null], [null, "BETA-OWN-KEY"]]);
    expect(JSON.stringify(w.sent)).not.toContain("SLOT-KEY");
    // A host its OK doesn't list: B's gate refuses it before any handler.
    await expect(w.call("acme", "net.fetch", ["https://evil.example.net/"])).rejects.toThrow(/network:evil\.example\.net/);
    // It sets its key's header itself: refused, its key never sent there by the core.
    await expect(w.call("acme", "net.fetch", ["https://api.example.com/v1/models", { headers: { authorization: "Bearer mine" } }])).rejects.toThrow();
    expect(w.sent).toHaveLength(2);
    expect(await w.call("acme", "settings.get", ["x"])).toBe("stored");
  });

  test("neither the account token nor the keyless public path is a third party's", async () => {
    const w = await world([{ id: "acme", manifest: manifest("acme", { capabilities: ["network:api.example.com", "network:public"] }), source: "local" }]);
    // The account token: the clover process only (guardApiRouter's `cloverProcessOnly`).
    await expect(w.call("acme", "net.fetch", ["https://api.example.com/", {}, { auth: "waifucave" }])).rejects.toThrow();
    // `network:public` is bundled-only: even granted, a third party's undeclared host stays undeclared.
    await expect(w.call("acme", "net.fetch", ["https://news.example.org/"])).rejects.toThrow();
    expect(w.sent).toEqual([]);
  });

  test("secrets.get: a third party's own entry's secret, in a process of its own only; another name, or a worker, is refused", async () => {
    const w = await world([
      { id: "signer", manifest: manifest("signer", { process: "own", auth: [{ method: "api-key", secret: "sa" }] }), source: "local" },
      { id: "acme", manifest: manifest("acme"), source: "local" },
    ]);
    expect(await w.call("signer", "secrets.get", ["sa"])).toBe("SIGNER-SECRET");
    await expect(w.call("signer", "secrets.get", ["api-key"])).rejects.toThrow(/no secret/);
    await expect(w.call("acme", "secrets.get", ["api-key"])).rejects.toThrow();
  });

  test("an un-OK'd plugin never reaches the handler: B's gate refuses it first", async () => {
    const w = await world([{ id: "found", manifest: manifest("found"), source: "local", approved: false }]);
    await expect(w.call("found", "net.fetch", ["https://api.example.com/v1/models"])).rejects.toThrow();
    expect(w.sent).toEqual([]);
  });
});

// A host on this computer in a plugin's keyed fetch (the coordinator's ruling for third-party model plugins: a model
// server such as Ollama on 127.0.0.1:11434): a plugin whose OK names `localhost:<port>` or `127.x.x.x:<port>` reaches
// it, plain http included, with or without a key; a loopback host without a port, a LAN address and any undeclared
// loopback port stay refused. Through B's real gate and the real pinned fetch (no seam); loopback servers only.
import { afterAll, expect, test } from "bun:test";
import { catalogPointDecl } from "../../../../plugin-sdk/src/catalogs/index";
import { FakePluginRegistry } from "../../../src/contracts/fakes/plugin-registry";
import { MemorySecretStore } from "../../../src/contracts/fakes/secret-store";
import { createApiRouter } from "../../../src/plugin-host/api/router";
import { pluginNetworkAllowed } from "../../../src/plugin-host/daemon-host";
import { modelPluginApiHandlers, secretStoreCredentials } from "../../../src/runtime-sdk/model-plugins/plugin-api";

const seen: { port: number; key: string | null }[] = [];
const serve = () => { const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (r) => { seen.push({ port: s.port!, key: r.headers.get("x-api-key") }); return new Response("from this computer"); } }); return s; };
const ollama = serve();
const other = serve();
afterAll(() => { ollama.stop(true); other.stop(true); });

const manifest = (id: string, hosts: string[], keyed: boolean) => ({
  manifest: 1, id, name: id, capabilities: hosts.map((h) => `network:${h}`),
  contributes: { models: [{ provider: id, name: id, catalog: [], auth: keyed ? [{ method: "api-key", secret: "api-key", placement: { header: "x-api-key" } }] : [], adapter: "adapter" }] },
}) as never;

async function world() {
  const registry = new FakePluginRegistry({ catalog: catalogPointDecl, plugins: [
    { id: "keyed", manifest: manifest("keyed", [`127.0.0.1:${ollama.port}`], true), source: "local" },
    { id: "keyless", manifest: manifest("keyless", [`localhost:${ollama.port}`], false), source: "local" },
    { id: "portless", manifest: manifest("portless", ["127.0.0.1", "localhost"], false), source: "local" },
    { id: "lan", manifest: manifest("lan", [`192.168.77.5:${ollama.port}`], false), source: "local" },
  ] });
  const items = new MemorySecretStore();
  await items.set({ owner: { kind: "plugin", pluginId: "keyed" }, name: "api-key" }, "LOCAL-KEY");
  // No `fetch`: the production pinned fetch, which refuses every private address unless the rule lets one through.
  const model = modelPluginApiHandlers({ registry, ...secretStoreCredentials(items) });
  const router = createApiRouter({ registry, handlers: [model], allowNetwork: pluginNetworkAllowed });
  return async (pluginId: string, url: string, auth?: string): Promise<string> => {
    try {
      const r = (await router({ pluginId, process: "shared", path: "net.fetch", args: [url, {}, auth === undefined ? {} : { auth }], caller: { kind: "plugin", pluginId } as never })) as Response;
      return `${r.status} ${await r.text()}`;
    } catch (err) {
      return `refused ${(err as { code?: string }).code ?? ""}: ${(err as Error).message}`;
    }
  };
}

test("a declared host on this computer with its port is reached, plain http, with its key or keyless", async () => {
  const fetch = await world();
  seen.length = 0;
  expect(await fetch("keyed", `http://127.0.0.1:${ollama.port}/api/chat`, "api-key")).toBe("200 from this computer");
  expect(await fetch("keyless", `http://localhost:${ollama.port}/api/chat`)).toBe("200 from this computer");
  expect(seen).toEqual([{ port: ollama.port!, key: "LOCAL-KEY" }, { port: ollama.port!, key: null }]);
});

test("another port, a loopback host named without a port, and a LAN address stay refused", async () => {
  const fetch = await world();
  seen.length = 0;
  expect(await fetch("keyless", `http://localhost:${other.port}/api/chat`)).toStartWith("refused");
  expect(await fetch("portless", `http://127.0.0.1:${ollama.port}/api/chat`)).toStartWith("refused");
  expect(await fetch("portless", "http://localhost/api/chat")).toStartWith("refused");
  expect(await fetch("lan", `http://192.168.77.5:${ollama.port}/api/chat`)).toStartWith("refused");
  expect(await fetch("lan", `https://192.168.77.5:${ollama.port}/api/chat`)).toStartWith("refused");
  expect(seen).toEqual([]);
});

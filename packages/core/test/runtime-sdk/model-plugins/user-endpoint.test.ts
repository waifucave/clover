// The user's own endpoint for a bundled model plugin's provider (the coordinator's ruling, plugin-host/pinned-fetch.ts;
// model-plugins/user-endpoint.ts): with `providers.<id>.baseUrl` set, that provider's plugin reaches exactly that origin
// (a loopback address included) with its own key, through B's real gate and the real pinned fetch, beside its declared
// hosts: not another origin, not a redirect off it, and not plain http to the local network. A provider without the setting is unchanged, and
// the setting is read at each call. Loopback servers only; nothing leaves this computer.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { catalogPointDecl } from "../../../../plugin-sdk/src/catalogs/index";
import { pluginFromFolder } from "../../../src/bots/tests/fixtures";
import { FakePluginRegistry } from "../../../src/contracts/fakes/plugin-registry";
import { createApiRouter } from "../../../src/plugin-host/api/router";
import { pluginNetworkAllowed } from "../../../src/plugin-host/daemon-host";
import { BUNDLED_CHILDREN_DIR, modelPluginId } from "../../../src/runtime-sdk/model-plugins/bundled";
import { modelPluginApiHandlers } from "../../../src/runtime-sdk/model-plugins/plugin-api";
import { userEndpointOf } from "../../../src/runtime-sdk/model-plugins/user-endpoint";
import type { Settings } from "../../../src/settings";

const KEY = "AIza-userendpoint-0123456789abcdef";
const GOOGLE = modelPluginId("google");
const XAI = modelPluginId("xai-oauth");

interface Seen { path: string; headers: Record<string, string> }
function server(answer: (req: Request) => Response) {
  const seen: Seen[] = [];
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => { const h: Record<string, string> = {}; req.headers.forEach((v, k) => { h[k] = v; }); seen.push({ path: new URL(req.url).pathname, headers: h }); return answer(req); } });
  return { origin: `http://127.0.0.1:${s.port}`, seen, stop: () => s.stop(true) };
}

let registry: FakePluginRegistry;
const other = server(() => new Response("the other origin"));
const user = server((req) => new URL(req.url).pathname === "/away" ? new Response(null, { status: 302, headers: { location: `${other.origin}/stolen` } }) : new Response("from the user's endpoint"));
afterAll(() => { user.stop(); other.stop(); });
beforeAll(async () => {
  registry = new FakePluginRegistry({ catalog: catalogPointDecl, plugins: (await pluginFromFolder(join(BUNDLED_CHILDREN_DIR, ".."), { bundled: true })).inputs });
});

function world() {
  let settings: Settings | null = { providers: { google: { baseUrl: `${user.origin}/v1beta` } } } as unknown as Settings;
  const declared: string[] = [];
  const userEndpoint = (id: string) => userEndpointOf(registry.get(id), settings);
  const model = modelPluginApiHandlers({
    registry,
    tokens: () => ({ current: async () => ({ value: KEY, generation: 1 }), newer: async () => null }),
    secret: async () => undefined,
    // The platform fetch for the declared hosts: recorded, never sent.
    fetch: async (url) => { declared.push(url); return new Response("declared host"); },
    userEndpoint,
  });
  const router = createApiRouter({ registry, handlers: [model], allowNetwork: pluginNetworkAllowed, userEndpoint });
  const fetch = async (pluginId: string, url: string): Promise<{ status: number; text: string } | { error: string }> => {
    try {
      const r = (await router({ pluginId, process: "clover", path: "net.fetch", args: [url, {}, {}], caller: { kind: "plugin", pluginId } as never })) as Response;
      return { status: r.status, text: await r.text() };
    } catch (err) {
      return { error: `${(err as { code?: string }).code ?? ""}: ${(err as Error).message}` };
    }
  };
  return { fetch, declared, set: (s: Settings | null) => { settings = s; } };
}

describe("a provider pointed at the user's own endpoint", () => {
  test("its plugin reaches that origin, a loopback address, with its own key in its placement", async () => {
    const w = world();
    user.seen.length = 0;
    expect(await w.fetch(GOOGLE, `${user.origin}/v1beta/models`)).toEqual({ status: 200, text: "from the user's endpoint" });
    expect(user.seen.map((s) => [s.path, s.headers["x-goog-api-key"]])).toEqual([["/v1beta/models", KEY]]);
  });

  test("its declared host still goes through; any other origin, and a redirect off the user's origin, is refused", async () => {
    const w = world();
    other.seen.length = 0;
    expect(await w.fetch(GOOGLE, "https://generativelanguage.googleapis.com/v1beta/models")).toEqual({ status: 200, text: "declared host" });
    expect(await w.fetch(GOOGLE, `${other.origin}/x`)).toEqual({ error: expect.stringMatching(/^refused: /) });
    expect(await w.fetch(GOOGLE, `${user.origin.replace("http:", "https:")}/v1beta/models`)).toEqual({ error: expect.stringMatching(/^refused: /) });
    const away = await w.fetch(GOOGLE, `${user.origin}/away`);
    expect("error" in away).toBe(true);
    expect(other.seen).toEqual([]);
    expect(w.declared).toEqual(["https://generativelanguage.googleapis.com/v1beta/models"]);
  });

  test("plain http to a local-network address is refused in words: it needs https, or http on this computer only", async () => {
    const w = world();
    w.set({ providers: { google: { baseUrl: "http://192.168.77.5:8080/v1beta" } } } as unknown as Settings);
    expect(await w.fetch(GOOGLE, "http://192.168.77.5:8080/v1beta/models")).toEqual({ error: expect.stringContaining("an endpoint on the local network needs https; plain http reaches only this computer") });
  });

  test("another provider's plugin doesn't reach it, and a provider without the setting is unchanged; the setting is read at each call", async () => {
    const w = world();
    user.seen.length = 0;
    expect(await w.fetch(XAI, `${user.origin}/v1/models`)).toEqual({ error: expect.stringMatching(/^refused: /) });
    w.set(null);
    expect(await w.fetch(GOOGLE, `${user.origin}/v1beta/models`)).toEqual({ error: expect.stringMatching(/^refused: /) });
    expect(await w.fetch(GOOGLE, "https://generativelanguage.googleapis.com/v1beta/models")).toEqual({ status: 200, text: "declared host" });
    expect(user.seen).toEqual([]);
  });

  test("only a bundled model plugin's provider has one: a third party's plugin, or a setting that isn't an http(s) URL, has none", () => {
    const settings = { providers: { google: { baseUrl: "ftp://127.0.0.1/" }, acme: { baseUrl: "http://127.0.0.1:1/" } } } as unknown as Settings;
    expect(userEndpointOf(registry.get(GOOGLE), settings)).toBeUndefined();
    expect(userEndpointOf({ id: "acme", source: "local", manifest: { contributes: { models: [{ provider: "acme" }] } } } as never, settings)).toBeUndefined();
    expect(userEndpointOf(registry.get(GOOGLE), { providers: { google: { baseUrl: "HTTP://LocalHost:8080/v1" } } } as unknown as Settings)).toBe("http://localhost:8080");
  });
});

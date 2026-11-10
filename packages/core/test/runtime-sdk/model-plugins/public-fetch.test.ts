// `network:public` (public-fetch.ts): B's gate as the daemon builds it (`pluginNetworkAllowed`) and the model plugins'
// net.fetch handler. A bundled plugin with the capability GRANTED reaches a public host outside its list, keyless,
// through the web safeguards; without it, the gate refuses. The pinned fetch's seam stands in for DNS and the network.
import { describe, expect, test } from "bun:test";
import { catalogPointDecl } from "../../../../plugin-sdk/src/catalogs/index";
import { FakePluginRegistry } from "../../../src/contracts/fakes/plugin-registry";
import { createApiRouter } from "../../../src/plugin-host/api/router";
import { pluginNetworkAllowed } from "../../../src/plugin-host/daemon-host";
import { pinnedFetch } from "../../../src/plugin-host/pinned-fetch";
import { modelPluginApiHandlers } from "../../../src/runtime-sdk/model-plugins/plugin-api";
import { PUBLIC_BODY_MAX_BYTES, publicFetch } from "../../../src/runtime-sdk/model-plugins/public-fetch";

const KEY = "sk-public-test-0123456789abcdef";

/** A world: `clover/webby` (bundled) with the capabilities given, its OK granting them; a fake internet by Host. */
function world(capabilities: string[]) {
  const registry = new FakePluginRegistry({
    catalog: catalogPointDecl,
    plugins: [
      { id: "clover", manifest: { manifest: 1, id: "clover", name: "Clover" } as never, source: "bundled" },
      { id: "clover/webby", manifest: { manifest: 1, name: "Webby", capabilities, contributes: { models: [{ provider: "webby", name: "Webby", catalog: [], auth: [{ method: "api-key", secret: "api-key" }], endpoint: { protocol: "openai-chat", baseUrl: "https://api.webby.example/v1" } }] } } as never, source: "bundled" },
    ],
  });
  const seen: { host: string; url: string; headers: Headers }[] = [];
  const audit: Record<string, unknown>[] = [];
  const log: string[] = [];
  const pages: Record<string, (path: string) => Response> = {
    "news.example.com": (path) => (path.startsWith("/moved") ? new Response(null, { status: 302, headers: { location: "https://intranet.example.com/secret" } }) : path.startsWith("/to-http") ? new Response(null, { status: 301, headers: { location: "http://news.example.com/plain" } }) : path.startsWith("/huge") ? new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(1024 * 1024)); } })) : new Response(`the article at ${path}`)),
    "api.webby.example": () => new Response("keyed"),
  };
  const fetch = pinnedFetch({
    resolve: async (host) => (host === "intranet.example.com" ? ["10.0.0.5"] : ["93.184.216.34"]),
    fetch: async (url, init) => {
      const host = new Headers(init.headers).get("host") ?? new URL(url).host;
      seen.push({ host, url, headers: new Headers(init.headers) });
      const page = pages[host];
      if (page === undefined) throw new Error(`no such site ${host}`);
      return page(new URL(url).pathname + new URL(url).search);
    },
  });
  const handlers = modelPluginApiHandlers({
    registry,
    tokens: () => ({ current: async () => ({ value: KEY, generation: 1 }), newer: async () => null }),
    secret: async () => undefined,
    fetch,
    audit: (l) => void audit.push(l),
    dangerousAdded: () => ["blocked-by-user.example"],
    log: (l) => void log.push(l),
  });
  const router = createApiRouter({ registry, handlers: [handlers], allowNetwork: pluginNetworkAllowed });
  const call = (url: string, init: RequestInit = {}, options: Record<string, unknown> = {}) =>
    router({ pluginId: "clover/webby", process: "clover", path: "net.fetch", args: [url, init, options], caller: { kind: "plugin", pluginId: "clover/webby" } as never }) as Promise<Response>;
  return { call, seen, audit, log };
}

const refusal = (p: Promise<unknown>) => p.then(() => "sent", (e: unknown) => (e as Error).message);

describe("network:public", () => {
  test("the gate both ways: with network:public granted a public host outside the list is reached; without it, refused", async () => {
    const yes = world(["network:api.webby.example", "network:public"]);
    expect(await (await yes.call("https://news.example.com/story")).text()).toBe("the article at /story");
    const no = world(["network:api.webby.example"]);
    expect(await refusal(no.call("https://news.example.com/story"))).toContain("network:news.example.com");
    expect(no.seen).toEqual([]);
  });

  test("the model's URL is hostile: https only, no user info, the default port only, a length cap, the dangerous-domain list", async () => {
    const w = world(["network:public"]);
    expect(await refusal(w.call("http://news.example.com/story"))).toContain("https only");
    expect(await refusal(w.call("https://user:pw@news.example.com/story"))).toContain("user name or password");
    expect(await refusal(w.call("https://news.example.com:8443/story"))).toContain("network:news.example.com");
    expect(await refusal(w.call(`https://news.example.com/${"a".repeat(5000)}`))).toContain("at most 4096 characters");
    expect(await refusal(w.call("https://pastebin.com/raw/x"))).toContain("never fetches");
    expect(await refusal(w.call("https://blocked-by-user.example/x"))).toContain("never fetches");
    expect(w.seen).toEqual([]);
  });

  test("a redirect from a public page to a private address is refused; one to plain http too", async () => {
    const w = world(["network:public"]);
    const msg = await refusal(w.call("https://news.example.com/moved"));
    // The model reads only that the name resolves to a private address; the address goes to the daemon's log.
    expect(msg).toContain("intranet.example.com resolves to a private address");
    expect(msg).toContain("asking first isn't available");
    expect(msg).not.toContain("10.0.0.5");
    expect(w.log.join("\n")).toContain("10.0.0.5");
    expect(w.seen.map((s) => s.host)).toEqual(["news.example.com"]);
    expect(await refusal(w.call("https://news.example.com/to-http"))).toContain("https only");
  });

  test("no key on a public-host request: an auth entry is refused, and headers that could carry one are dropped", async () => {
    const w = world(["network:api.webby.example", "network:public"]);
    expect(await refusal(w.call("https://news.example.com/story", {}, { auth: "api-key" }))).toContain("no key goes to a host outside");
    await w.call("https://news.example.com/story", { headers: { authorization: "Bearer mine", "x-api-key": "k", cookie: "s=1", "proxy-authorization": "p", "x-fine": "yes" } });
    const sent = w.seen.at(-1)!.headers;
    for (const h of ["authorization", "x-api-key", "cookie", "proxy-authorization", "api-key", "x-goog-api-key"]) expect(sent.get(h)).toBeNull();
    expect(sent.get("x-fine")).toBe("yes");
    // The plugin's declared host still gets its key, through the keyed fetch.
    await w.call("https://api.webby.example/v1/models", {}, { auth: "api-key" });
    expect(w.seen.at(-1)!.headers.get("authorization")).toBe(`Bearer ${KEY}`);
  });

  test("the audit line: the plugin, the host, the path's length and the outcome; never the path, query or fragment", async () => {
    const w = world(["network:public"]);
    await w.call("https://news.example.com/story/123?token=abc-secret#frag");
    await refusal(w.call("http://news.example.com/x?q=private"));
    expect(w.audit[0]).toMatchObject({ kind: "network", tool: "net.fetch", via: "network:public", plugin: "clover/webby", host: "news.example.com", pathLength: "/story/123".length, outcome: "ok", status: 200 });
    expect(w.audit[1]).toMatchObject({ host: "news.example.com", outcome: "refused" });
    const text = JSON.stringify(w.audit);
    for (const s of ["abc-secret", "frag", "/story", "private"]) expect(text).not.toContain(s);
  });

  test("a body past the cap is cut with an error", async () => {
    const w = world(["network:public"]);
    const r = await w.call("https://news.example.com/huge");
    expect(await r.arrayBuffer().then(() => "read", (e: unknown) => (e as Error).message)).toContain(`${PUBLIC_BODY_MAX_BYTES} bytes`);
  });

  test("an overall deadline: a page that drips just inside the idle limit still ends at the total", async () => {
    const drip = publicFetch({
      fetch: async () => new Response(new ReadableStream({ async pull(c) { await Bun.sleep(40); c.enqueue(new Uint8Array(1)); } })),
      limits: { idleMs: 200, totalMs: 400 },
    });
    const t0 = Date.now();
    const r = await drip("clover/webby", "https://slow.example.com/", {}, undefined);
    expect(await r.arrayBuffer().then(() => "read", (e: unknown) => (e as Error).message)).toContain("took more than 0.4 s");
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});

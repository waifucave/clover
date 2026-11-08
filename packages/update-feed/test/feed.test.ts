// The update feed's signature with a throwaway key: a good file under its own name passes, and anything else is
// refused, without a throw.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { coreBinaryFile, coreFeedFile, CORE_TARGETS, FEED_NAME, formatCoreFeed, generateFeedKey, parseCoreFeed, publicKeyFromRaw, publicKeyOf, rawPublicKey, signedMessage, signFeed, UPDATE_FEED_PUBLIC_KEY, verifyFeed } from "../src/index";

const feed = new TextEncoder().encode("version: 1.2.3\nfiles:\n  - url: Clover-1.2.3-mac.zip\n    sha512: abc\n");

describe("the update feed's signature", () => {
  test("signs and checks an update file under its name", () => {
    const key = generateFeedKey();
    expect(publicKeyOf(key.privateKey)).toBe(key.publicKey);
    expect(rawPublicKey(publicKeyFromRaw(key.publicKey))).toBe(key.publicKey);
    const sig = signFeed("latest-mac.yml", feed, key.privateKey);
    expect(verifyFeed("latest-mac.yml", feed, sig, key.publicKey)).toEqual({ ok: true });
    expect(verifyFeed("latest-mac.yml", feed, `${sig}\n`, key.publicKey)).toEqual({ ok: true });
    expect(signedMessage("beta.yml", feed).toString("utf8")).toMatch(/^clover-update-feed-v1\0beta\.yml\0[0-9a-f]{128}\0$/);
  });

  test("a file signed under one name is refused under another: a beta file as latest, one OS's as another's", () => {
    const key = generateFeedKey();
    const sig = signFeed("beta-mac.yml", feed, key.privateKey);
    expect(verifyFeed("latest-mac.yml", feed, sig, key.publicKey)).toEqual({ ok: false, reason: "bad signature" });
    expect(verifyFeed("beta-linux.yml", feed, sig, key.publicKey)).toEqual({ ok: false, reason: "bad signature" });
    expect(verifyFeed("beta-mac.yml", feed, sig, key.publicKey)).toEqual({ ok: true });
    expect(verifyFeed("../beta-mac.yml", feed, sig, key.publicKey)).toEqual({ ok: false, reason: "bad name" });
    expect(() => signFeed("notes.txt", feed, key.privateKey)).toThrow(/not an update file's name/);
  });

  test("refuses a changed file, another key's signature, a missing or malformed one, a bad key, and any file without a key", () => {
    const key = generateFeedKey();
    const other = generateFeedKey();
    const sig = signFeed("latest.yml", feed, key.privateKey);
    const changed = new Uint8Array(feed);
    changed[changed.length - 2] = changed[changed.length - 2]! ^ 1;
    expect(verifyFeed("latest.yml", changed, sig, key.publicKey)).toEqual({ ok: false, reason: "bad signature" });
    expect(verifyFeed("latest.yml", feed, signFeed("latest.yml", feed, other.privateKey), key.publicKey)).toEqual({ ok: false, reason: "bad signature" });
    expect(verifyFeed("latest.yml", feed, undefined, key.publicKey)).toEqual({ ok: false, reason: "no signature" });
    expect(verifyFeed("latest.yml", feed, "not base64!", key.publicKey)).toEqual({ ok: false, reason: "malformed signature" });
    expect(verifyFeed("latest.yml", feed, sig, null)).toEqual({ ok: false, reason: "no key" });
    expect(verifyFeed("latest.yml", feed, sig, "AAAA")).toEqual({ ok: false, reason: "bad key" });
    expect(() => publicKeyFromRaw("AAAA")).toThrow(/32 bytes/);
  });

  test("the embedded key is a public key or none, and the package holds no private key", () => {
    if (UPDATE_FEED_PUBLIC_KEY !== null) expect(() => publicKeyFromRaw(UPDATE_FEED_PUBLIC_KEY!)).not.toThrow();
    const src = readFileSync(join(import.meta.dir, "..", "src", "key.ts"), "utf8");
    expect(src).not.toMatch(/PRIVATE KEY|MC4CAQAwBQYDK2Vw/);
  });

  test("the names a signature covers: the app's update files, the daemon's, and the daemon's binaries", () => {
    for (const ok of ["latest.yml", "beta-mac.yml", "latest-linux-arm64.yml", ...CORE_TARGETS.flatMap((t) => [coreFeedFile("latest", t), coreFeedFile("beta", t), coreBinaryFile("1.2.3", t), coreBinaryFile("1.3.0-beta.2", t)])]) {
      expect(`${ok} ${FEED_NAME.test(ok)}`).toBe(`${ok} true`);
    }
    expect(coreBinaryFile("1.2.3", "windows-x64")).toBe("clover-core-1.2.3-windows-x64.exe");
    expect(coreBinaryFile("1.2.3", "linux-x64")).toBe("clover-core-1.2.3-linux-x64");
    for (const bad of ["latest-core-freebsd-x64.yml", "clover-core-1.2.3-linux-x64.exe", "clover-core-1.2.3-windows-x64", "clover-core-latest-linux-x64", "../clover-core-1.2.3-linux-x64", "clover-core-1.2.3-linux-x64.sig", "latest-core.yml"]) {
      expect(`${bad} ${FEED_NAME.test(bad)}`).toBe(`${bad} false`);
    }
    // A binary's signature holds for that binary under that name only.
    const key = generateFeedKey();
    const bin = new TextEncoder().encode("\x7fELF…");
    const sig = signFeed("clover-core-1.2.3-linux-x64", bin, key.privateKey);
    expect(verifyFeed("clover-core-1.2.3-linux-x64", bin, sig, key.publicKey)).toEqual({ ok: true });
    expect(verifyFeed("clover-core-1.2.3-linux-arm64", bin, sig, key.publicKey)).toEqual({ ok: false, reason: "bad signature" });
    expect(verifyFeed("clover-core-1.2.4-linux-x64", bin, sig, key.publicKey)).toEqual({ ok: false, reason: "bad signature" });
  });

  test("the daemon's update file: written and read back, and anything else refused", () => {
    const sha512 = createHash("sha512").update("x").digest("base64");
    const feed = { version: "1.2.3", file: "clover-core-1.2.3-linux-x64", sha512, size: 1234 };
    expect(parseCoreFeed(formatCoreFeed(feed))).toEqual(feed);
    const text = formatCoreFeed(feed);
    expect(() => parseCoreFeed(`${text}url: https://elsewhere\n`)).toThrow();
    expect(() => parseCoreFeed(text.replace("1.2.3\n", "latest\n"))).toThrow(/version/);
    expect(() => parseCoreFeed(text.replace("clover-core-1.2.3-linux-x64", "../x"))).toThrow(/binary/);
    expect(() => parseCoreFeed(text.replace("clover-core-1.2.3-linux-x64", "latest.yml"))).toThrow(/binary/);
    expect(() => parseCoreFeed(text.replace(sha512, "abc"))).toThrow(/sha512/);
    expect(() => parseCoreFeed(text.replace("1234", "-1"))).toThrow(/size/);
    expect(() => parseCoreFeed(`${text}version: 9.9.9\n`)).toThrow();
  });
});

test("plain Bun for plugins has its own signed update file and binary, named by its Bun version", async () => {
  const { pluginBunFeedFile, pluginBunBinaryFile, parsePluginBunFeed, parseCoreFeed, FEED_NAME } = await import("../src/index");
  expect(pluginBunFeedFile("latest", "linux-x64")).toBe("latest-plugin-bun-linux-x64.yml");
  expect(pluginBunBinaryFile("1.4.4", "windows-x64")).toBe("clover-plugin-bun-1.4.4-windows-x64.exe");
  expect(pluginBunBinaryFile("1.4.4", "darwin-arm64")).toBe("clover-plugin-bun-1.4.4-darwin-arm64");
  for (const n of ["beta-plugin-bun-darwin-arm64.yml", "clover-plugin-bun-1.4.4-linux-arm64", "clover-plugin-bun-1.4.4-windows-x64.exe"]) expect(FEED_NAME.test(n)).toBe(true);
  for (const n of ["clover-plugin-bun-1.4.4-windows-x64", "latest-plugin-bun.yml", "clover-plugin-bun-x-linux-x64"]) expect(FEED_NAME.test(n)).toBe(false);
  const sha512 = Buffer.alloc(64, 1).toString("base64");
  const feed = `version: 1.4.4\nfile: clover-plugin-bun-1.4.4-linux-x64\nsha512: ${sha512}\nsize: 100\n`;
  expect(parsePluginBunFeed(feed)).toEqual({ version: "1.4.4", file: "clover-plugin-bun-1.4.4-linux-x64", sha512, size: 100 });
  // Neither file passes for the other: a plugin Bun feed never names a daemon, nor the other way round.
  expect(() => parseCoreFeed(feed)).toThrow("names a clover-core binary");
  expect(() => parsePluginBunFeed(feed.replace(/clover-plugin-bun/, "clover-core"))).toThrow("names a clover-plugin-bun binary");
});

test("the bundled plugins' names: a per-target tarball and its update file, which a signature may cover", async () => {
  const { pluginsFeedFile, pluginsTarballFile, parsePluginsFeed, FEED_NAME } = await import("../src/index");
  expect(pluginsFeedFile("beta", "darwin-arm64")).toBe("beta-plugins-darwin-arm64.yml");
  expect(pluginsTarballFile("1.2.3", "windows-x64")).toBe("clover-plugins-1.2.3-windows-x64.tar.gz");
  for (const n of ["latest-plugins-linux-x64.yml", "clover-plugins-1.2.3-linux-arm64.tar.gz", "clover-plugins-1.3.0-beta.1-darwin-arm64.tar.gz"]) expect(FEED_NAME.test(n)).toBe(true);
  for (const n of ["clover-plugins-1.2.3.tar.gz", "clover-plugins-1.2.3-linux-x64.tar", "latest-plugins.yml", "clover-plugins-x-linux-x64.tar.gz"]) expect(FEED_NAME.test(n)).toBe(false);
  const sha512 = Buffer.alloc(64, 1).toString("base64");
  expect(parsePluginsFeed(`version: 1.2.3\nfile: clover-plugins-1.2.3-linux-x64.tar.gz\nsha512: ${sha512}\nsize: 10\n`).file).toBe("clover-plugins-1.2.3-linux-x64.tar.gz");
  expect(() => parsePluginsFeed(`version: 1.2.3\nfile: clover-core-1.2.3-linux-x64\nsha512: ${sha512}\nsize: 10\n`)).toThrow("bundled plugins");
});

test("the tarball: packed the same way every time, read back strictly", async () => {
  const { packTarball, unpackTarball } = await import("../src/index");
  const { gzipSync } = await import("node:zlib");
  const enc = (s: string) => new TextEncoder().encode(s);
  const long = `a/${"x".repeat(120)}/b.js`;
  const files = [{ path: "z/clover.json", bytes: enc("{}"), executable: false }, { path: long, bytes: new Uint8Array(1000).fill(7), executable: true }];
  const gz = packTarball(files);
  expect(Buffer.from(packTarball([...files].reverse())).equals(Buffer.from(gz))).toBe(true);
  expect(unpackTarball(gz).map((f) => [f.path, f.bytes.length, f.executable])).toEqual([[long, 1000, true], ["z/clover.json", 2, false]]);
  for (const bad of ["../x", "/etc/passwd", "a//b", "a\\b"]) expect(() => packTarball([{ path: bad, bytes: enc(""), executable: false }])).toThrow("plain relative path");
  expect(() => packTarball([files[0]!, files[0]!])).toThrow("twice");
  // A hand-made archive: a symlink entry, a traversal path, a bad checksum, a truncated body: each refused.
  const header = (name: string, type: string, size: number, fix = true) => {
    const h = new Uint8Array(512);
    const put = (at: number, t: string) => h.set(enc(t), at);
    put(0, name); put(100, "0000644\0"); put(108, "0000000\0"); put(116, "0000000\0"); put(124, `${size.toString(8).padStart(11, "0")}\0`); put(136, "00000000000\0");
    put(148, "        "); put(156, type); put(257, "ustar\0"); put(263, "00");
    let sum = 0;
    for (const b of h) sum += b;
    put(148, `${(fix ? sum : sum + 1).toString(8).padStart(6, "0")}\0 `);
    return h;
  };
  const tar = (...parts: Uint8Array[]) => new Uint8Array(gzipSync(Buffer.concat([...parts.map((p) => Buffer.from(p)), Buffer.alloc(1024)])));
  expect(() => unpackTarball(tar(header("a/link", "2", 0)))).toThrow("only regular files");
  expect(() => unpackTarball(tar(header("../evil", "0", 0)))).toThrow("plain relative path");
  expect(() => unpackTarball(tar(header("a/x", "0", 0, false)))).toThrow("checksum");
  expect(() => unpackTarball(new Uint8Array(gzipSync(Buffer.concat([Buffer.from(header("a/x", "0", 4096)), Buffer.alloc(512)]))))).toThrow();
  expect(() => unpackTarball(enc("not gzip"))).toThrow("not a gzip stream");
});

test("a tarball path every OS can hold: no Windows device name, no trailing dot or space", async () => {
  const { plainRelativePath, packTarball } = await import("../src/index");
  for (const p of ["a/CON", "a/nul.txt", "COM1/x", "a/lpt9.js", "a/x.", "a/x ", "a/com¹"]) expect(plainRelativePath(p)).toBe(false);
  for (const p of ["a/console.js", "a/null.js", "a/com10", "a/.env.example", "clover/clover.json"]) expect(plainRelativePath(p)).toBe(true);
  expect(() => packTarball([{ path: "a/AUX.json", bytes: new Uint8Array(), executable: false }])).toThrow("plain relative path");
});

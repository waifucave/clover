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

// The update feed's signature with a throwaway key: a good file passes, and anything else is refused.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generateFeedKey, publicKeyFromRaw, publicKeyOf, rawPublicKey, signFeed, UPDATE_FEED_PUBLIC_KEY, verifyFeed } from "../src/index";

const feed = new TextEncoder().encode("version: 1.2.3\nfiles:\n  - url: Clover-1.2.3-mac.zip\n    sha512: abc\n");

describe("the update feed's signature", () => {
  test("signs and checks an update file's exact bytes", () => {
    const key = generateFeedKey();
    expect(publicKeyOf(key.privateKey)).toBe(key.publicKey);
    expect(rawPublicKey(publicKeyFromRaw(key.publicKey))).toBe(key.publicKey);
    const sig = signFeed(feed, key.privateKey);
    expect(verifyFeed(feed, sig, key.publicKey)).toEqual({ ok: true });
    expect(verifyFeed(feed, `${sig}\n`, key.publicKey)).toEqual({ ok: true });
  });

  test("refuses a changed file, another key's signature, a missing or malformed one, and any file without a key", () => {
    const key = generateFeedKey();
    const other = generateFeedKey();
    const sig = signFeed(feed, key.privateKey);
    const changed = new Uint8Array(feed);
    changed[changed.length - 2] = changed[changed.length - 2]! ^ 1;
    expect(verifyFeed(changed, sig, key.publicKey)).toEqual({ ok: false, reason: "bad signature" });
    expect(verifyFeed(feed, signFeed(feed, other.privateKey), key.publicKey)).toEqual({ ok: false, reason: "bad signature" });
    expect(verifyFeed(feed, undefined, key.publicKey)).toEqual({ ok: false, reason: "no signature" });
    expect(verifyFeed(feed, "not base64!", key.publicKey)).toEqual({ ok: false, reason: "malformed signature" });
    expect(verifyFeed(feed, sig, null)).toEqual({ ok: false, reason: "no key" });
    expect(() => publicKeyFromRaw("AAAA")).toThrow(/32 bytes/);
  });

  test("the embedded key is a public key or none, and the package holds no private key", () => {
    if (UPDATE_FEED_PUBLIC_KEY !== null) expect(() => publicKeyFromRaw(UPDATE_FEED_PUBLIC_KEY!)).not.toThrow();
    const src = readFileSync(join(import.meta.dir, "..", "src", "key.ts"), "utf8");
    expect(src).not.toMatch(/PRIVATE KEY|MC4CAQAwBQYDK2Vw/);
  });
});

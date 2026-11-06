// The update feed's signature with a throwaway key: a good file under its own name passes, and anything else is
// refused, without a throw.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generateFeedKey, publicKeyFromRaw, publicKeyOf, rawPublicKey, signedMessage, signFeed, UPDATE_FEED_PUBLIC_KEY, verifyFeed } from "../src/index";

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
});

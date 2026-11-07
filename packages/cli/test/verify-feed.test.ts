// `clover-core __verify-feed`: the update feed's check in the daemon's binary, with a throwaway key.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateFeedKey, signFeed } from "@waifucave/clover-update-feed";
import { runVerifyFeed } from "../src/verify-feed";

describe("__verify-feed", () => {
  test("passes a file signed by the feed key, and refuses a changed one, an unsigned one or any without a key", () => {
    const dir = mkdtempSync(join(tmpdir(), "clover-verify-feed-"));
    const key = generateFeedKey();
    const file = join(dir, "latest-linux.yml");
    const bytes = new TextEncoder().encode("version: 1.2.3\nfiles: []\n");
    writeFileSync(file, bytes);
    expect(runVerifyFeed(file, key.publicKey)).toEqual({ code: 1, line: "feed: refused (no signature)" });
    writeFileSync(`${file}.sig`, signFeed(bytes, key.privateKey));
    expect(runVerifyFeed(file, key.publicKey)).toEqual({ code: 0, line: "feed: ok" });
    expect(runVerifyFeed(file, null)).toEqual({ code: 1, line: "feed: refused (no key)" });
    writeFileSync(file, "version: 9.9.9\nfiles: []\n");
    expect(runVerifyFeed(file, key.publicKey)).toEqual({ code: 1, line: "feed: refused (bad signature)" });
    expect(runVerifyFeed(join(dir, "nope.yml"), key.publicKey).code).toBe(2);
    expect(runVerifyFeed(undefined, key.publicKey).code).toBe(2);
  });
});

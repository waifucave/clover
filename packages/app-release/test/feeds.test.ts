// The two apps' updaters read the same release, each its OWN update files (lane PK; spec item 120): MOSS Code's as
// electron-builder names them, MOSS's with `moss-` in front. Fixtures only: a fake executor stands in for GitHub, with a
// throwaway key; nothing here reaches the network.
import { describe, expect, test } from "bun:test";
import type { RequestOptions } from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { generateFeedKey, MOSS_APP_FEED_PREFIX, signFeed } from "@waifucave/moss-update-feed";
import { FeedRefused, feedFileOf, unknownReleaseYml, VerifiedGitHubProvider, VerifiedMossGitHubProvider, verifyingExecutor } from "../src/updater";

const feed = (app: "MOSS-Code" | "MOSS") => `version: 1.2.3\nfiles:\n  - url: ${app}-1.2.3-mac.zip\n    sha512: abc\n    size: 10\npath: ${app}-1.2.3-mac.zip\nsha512: abc\nreleaseDate: '2026-11-18T00:00:00.000Z'\n`;
const DL = "/waifucave/moss/releases/download/v1.2.3";
const ATOM = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><id>1</id><link rel="alternate" type="text/html" href="https://github.com/waifucave/moss/releases/tag/v1.2.3"/><title>v1.2.3</title><content>notes</content></entry></feed>';

function fakeExecutor(files: Record<string, string>) {
  const asked: string[] = [];
  return {
    asked,
    async request(options: RequestOptions, _token?: unknown): Promise<string> {
      const path = options.path ?? "";
      asked.push(path);
      if (!(path in files)) throw Object.assign(new Error(`404 ${path}`), { statusCode: 404 });
      return files[path]!;
    },
  };
}

/** One release holding both apps' update files, each signed under its own name with `key`. */
function release(key: string): Record<string, string> {
  const enc = (t: string) => new TextEncoder().encode(t);
  return {
    "/waifucave/moss/releases.atom": ATOM,
    "/waifucave/moss/releases/latest": JSON.stringify({ tag_name: "v1.2.3" }),
    [`${DL}/latest-mac.yml`]: feed("MOSS-Code"),
    [`${DL}/latest-mac.yml.sig`]: signFeed("latest-mac.yml", enc(feed("MOSS-Code")), key),
    [`${DL}/moss-latest-mac.yml`]: feed("MOSS"),
    [`${DL}/moss-latest-mac.yml.sig`]: signFeed("moss-latest-mac.yml", enc(feed("MOSS")), key),
  };
}

function provider(cls: typeof VerifiedGitHubProvider | typeof VerifiedMossGitHubProvider, files: Record<string, string>, publicKey: string, prefix: "" | "moss-") {
  const ex = fakeExecutor(files);
  const p = new cls(
    { provider: "github", owner: "waifucave", repo: "moss" } as never,
    { channel: null, allowPrerelease: false, currentVersion: "1.0.0", fullChangelog: false } as never,
    { executor: ex, platform: "darwin", isUseMultipleRangeRequest: false } as never,
  );
  (p as unknown as { executor: unknown }).executor = verifyingExecutor(ex, publicKey, prefix);
  return { ex, p };
}

describe("one release, two apps' feeds", () => {
  test("MOSS's updater reads moss-latest-mac.yml of the release and its own artifact; MOSS Code's reads latest-mac.yml", async () => {
    const key = generateFeedKey();
    const moss = provider(VerifiedMossGitHubProvider, release(key.privateKey), key.publicKey, MOSS_APP_FEED_PREFIX);
    const info = await moss.p.getLatestVersion();
    expect(info.version).toBe("1.2.3");
    expect(info.path).toBe("MOSS-1.2.3-mac.zip");
    expect(moss.ex.asked).toContain(`${DL}/moss-latest-mac.yml.sig`);
    expect(moss.ex.asked).not.toContain(`${DL}/latest-mac.yml`);
    const code = provider(VerifiedGitHubProvider, release(key.privateKey), key.publicKey, "");
    expect((await code.p.getLatestVersion()).path).toBe("MOSS-Code-1.2.3-mac.zip");
    expect(code.ex.asked).not.toContain(`${DL}/moss-latest-mac.yml`);
  });

  test("MOSS's updater refuses MOSS Code's update file, and MOSS Code's refuses MOSS's", async () => {
    const key = generateFeedKey();
    // MOSS Code's file and signature served under MOSS's name: the signature is over the name, so it never verifies.
    const swapped = release(key.privateKey);
    swapped[`${DL}/moss-latest-mac.yml`] = swapped[`${DL}/latest-mac.yml`]!;
    swapped[`${DL}/moss-latest-mac.yml.sig`] = swapped[`${DL}/latest-mac.yml.sig`]!;
    await expect(provider(VerifiedMossGitHubProvider, swapped, key.publicKey, MOSS_APP_FEED_PREFIX).p.getLatestVersion()).rejects.toThrow(/refused: bad signature/);
    const back = release(key.privateKey);
    back[`${DL}/latest-mac.yml`] = back[`${DL}/moss-latest-mac.yml`]!;
    back[`${DL}/latest-mac.yml.sig`] = back[`${DL}/moss-latest-mac.yml.sig`]!;
    await expect(provider(VerifiedGitHubProvider, back, key.publicKey, "").p.getLatestVersion()).rejects.toThrow(/refused: bad signature/);
    // Asked by name, the other app's file is not one of this updater's: refused before it is fetched.
    for (const [prefix, other] of [["moss-", "latest-mac.yml"], ["", "moss-latest-mac.yml"]] as const) {
      expect(unknownReleaseYml(`${DL}/${other}`, prefix)).toBe(other);
      const ex = fakeExecutor(release(key.privateKey));
      const err = await verifyingExecutor(ex, key.publicKey, prefix).request({ path: `${DL}/${other}` }, undefined).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FeedRefused);
      expect(ex.asked).toEqual([]);
    }
    expect(feedFileOf(`${DL}/moss-beta-mac.yml`, "moss-")).toBe("moss-beta-mac.yml");
    expect(feedFileOf(`${DL}/moss-beta-mac.yml`, "")).toBeUndefined();
    expect(feedFileOf(`${DL}/beta-mac.yml`, "moss-")).toBeUndefined();
  });

  test("a beta MOSS reads moss-beta-mac.yml", async () => {
    const key = generateFeedKey();
    const files = release(key.privateKey);
    files[`${DL}/moss-beta-mac.yml`] = feed("MOSS");
    files[`${DL}/moss-beta-mac.yml.sig`] = signFeed("moss-beta-mac.yml", new TextEncoder().encode(feed("MOSS")), key.privateKey);
    const ex = fakeExecutor(files);
    const p = new VerifiedMossGitHubProvider(
      { provider: "github", owner: "waifucave", repo: "moss" } as never,
      { channel: "beta", allowPrerelease: true, currentVersion: "1.0.0", fullChangelog: false } as never,
      { executor: ex, platform: "darwin", isUseMultipleRangeRequest: false } as never,
    );
    (p as unknown as { executor: unknown }).executor = verifyingExecutor(ex, key.publicKey, MOSS_APP_FEED_PREFIX);
    expect((await p.getLatestVersion()).path).toBe("MOSS-1.2.3-mac.zip");
    expect(ex.asked).toContain(`${DL}/moss-beta-mac.yml`);
  });
});

describe("the shared code runs in Electron's Node", () => {
  test("no Bun API in the package's sources (both apps' main processes run them)", () => {
    const dir = join(import.meta.dir, "..", "src");
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
      const src = readFileSync(join(dir, f), "utf8");
      expect(`${f}: ${/\bBun\.|from "bun(:[a-z]+)?"/.test(src)}`).toBe(`${f}: false`);
      // Never the engine's code: the apps import the protocol, the update feed and this package only.
      const imports = src.split("\n").filter((l) => /^import |^export .* from /.test(l)).join("\n");
      expect(`${f}: ${/@waifucave\/moss-core|packages\/core/.test(imports)}`).toBe(`${f}: false`);
    }
  });
});

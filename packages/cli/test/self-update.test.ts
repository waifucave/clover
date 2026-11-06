// A server's daemon updating itself (src/self-update.ts), against a fake release served from memory with a throwaway
// key, on a temp home with shell scripts for binaries: a bad signature, a bad hash, a binary failing `--version`, a
// binary crashing twice (rolled back), and a good swap. Nothing reaches the network or a real home.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coreBinaryFile, coreFeedFile, formatCoreFeed, generateFeedKey, signFeed } from "@waifucave/clover-update-feed";
import { UpdateGate, UPDATE_RESTART_EXIT_CODE } from "@waifucave/clover-core";
import { beginUpdatedBoot, bootWasGood, coreTargetOf, isNewer, rolledBack, runVersion, SelfUpdater, type Fetcher } from "../src/self-update";

const posix = test.if(process.platform !== "win32");
const enc = (s: string) => new TextEncoder().encode(s);
const TARGET = "linux-x64" as const;
const RELEASES = "https://api.github.com/repos/waifucave/clover/releases?per_page=30";

/** A binary as a shell script: `--version` prints `clover <version>` (or whatever `say` makes it do). */
const script = (body: string) => `#!/bin/sh\n${body}\n`;
const versionScript = (version: string) => script(`[ -z "$HOME$CLOVER_HOME" ] || exit 3\necho "clover ${version}"`);

interface Release {
  version: string;
  binary: string;
  prerelease?: boolean;
  /** Breaks one thing: the update file's signature, or the hash the update file carries. */
  spoil?: "feed signature" | "hash";
}

/** The releases as GitHub serves them, every file signed with `key`, and the URLs asked for. */
function github(key: { privateKey: string }, releases: Release[]) {
  const files = new Map<string, Uint8Array>();
  const asked: string[] = [];
  const list = releases.map((r) => {
    const tag = `v${r.version}`;
    const url = (name: string) => `https://github.com/waifucave/clover/releases/download/${tag}/${name}`;
    const binName = coreBinaryFile(r.version, TARGET);
    const bin = enc(r.binary);
    const sha512 = r.spoil === "hash" ? createHash("sha512").update("something else").digest("base64") : createHash("sha512").update(bin).digest("base64");
    const feed = enc(formatCoreFeed({ version: r.version, file: binName, sha512, size: bin.length }));
    const assets: Array<{ name: string; browser_download_url: string }> = [];
    const put = (name: string, bytes: Uint8Array) => { files.set(url(name), bytes); assets.push({ name, browser_download_url: url(name) }); };
    for (const ch of r.prerelease ? (["beta"] as const) : (["latest", "beta"] as const)) {
      const name = coreFeedFile(ch, TARGET);
      put(name, feed);
      put(`${name}.sig`, enc(signFeed(name, r.spoil === "feed signature" ? enc("another file") : feed, key.privateKey)));
    }
    put(binName, bin);
    put(`${binName}.sig`, enc(signFeed(binName, bin, key.privateKey)));
    return { tag_name: tag, draft: false, prerelease: r.prerelease ?? false, assets };
  });
  files.set(RELEASES, enc(JSON.stringify(list)));
  const fetch: Fetcher = async (u) => { asked.push(u); return files.get(u); };
  return { fetch, asked };
}

function server(opts: { version?: string; channel?: "latest" | "beta"; releases: Release[]; busy?: () => number }) {
  const home = mkdtempSync(join(tmpdir(), "clover-self-update-"));
  mkdirSync(join(home, "bin"));
  const bin = join(home, "bin", "clover-core");
  writeFileSync(bin, versionScript(opts.version ?? "1.2.3"), { mode: 0o755 });
  const key = generateFeedKey();
  const gh = github(key, opts.releases);
  const gate = new UpdateGate();
  if (opts.busy) gate.register({ name: "turns", count: opts.busy });
  const did: string[] = [];
  gate.beforeRestart(() => { did.push("lease renewed"); });
  const exited: number[] = [];
  const lines: string[] = [];
  const updater = new SelfUpdater({
    home, bin, version: opts.version ?? "1.2.3", target: TARGET, channel: opts.channel ?? "latest", publicKey: key.publicKey,
    fetch: gh.fetch, gate, restartCode: UPDATE_RESTART_EXIT_CODE, idlePollMs: 1,
    drain: async () => { did.push("drained"); },
    exit: (code) => { exited.push(code); },
    log: (l) => lines.push(l),
  });
  return { home, bin, updater, did, exited, lines, asked: gh.asked };
}

describe("a server's daemon updating itself", () => {
  test("targets and versions", () => {
    expect(coreTargetOf("linux", "arm64")).toBe("linux-arm64");
    expect(coreTargetOf("win32", "x64")).toBe("windows-x64");
    expect(coreTargetOf("darwin", "x64")).toBeUndefined();
    expect(isNewer("1.2.4", "1.2.3")).toBe(true);
    expect(isNewer("1.10.0", "1.9.9")).toBe(true);
    expect(isNewer("1.2.3", "1.2.3")).toBe(false);
    expect(isNewer("1.2.2", "1.2.3")).toBe(false);
    expect(isNewer("1.3.0-beta.2", "1.3.0-beta.1")).toBe(true);
    expect(isNewer("1.3.0", "1.3.0-beta.9")).toBe(true);
    expect(isNewer("1.3.0-beta.9", "1.3.0")).toBe(false);
    expect(isNewer("1.3.0-beta.10", "1.3.0-beta.9")).toBe(true);
    expect(isNewer("latest", "1.0.0")).toBe(false);
  });

  posix("--version runs with nothing in its environment but PATH, and for at most its time", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clover-version-check-"));
    const ok = join(dir, "ok"), env = join(dir, "env"), hang = join(dir, "hang");
    writeFileSync(ok, versionScript("1.3.0"), { mode: 0o755 });
    writeFileSync(env, script('[ -n "$PATH" ] && [ -z "$HOME$USER$CLOVER_HOME" ] && echo clean'), { mode: 0o755 });
    writeFileSync(hang, script("sleep 30"), { mode: 0o755 });
    expect(await runVersion(ok)).toBe("clover 1.3.0");
    expect(await runVersion(env)).toBe("clean");
    const started = Date.now();
    expect(await runVersion(hang, 300)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await runVersion(join(dir, "missing"))).toBeUndefined();
  });

  test("an older or equal release, a beta on latest, or no release at all: nothing to do", async () => {
    expect((await server({ releases: [{ version: "1.2.3", binary: versionScript("1.2.3") }] }).updater.check()).kind).toBe("up to date");
    expect((await server({ releases: [{ version: "1.2.2", binary: versionScript("1.2.2") }] }).updater.check()).kind).toBe("up to date");
    expect((await server({ releases: [{ version: "1.3.0-beta.1", binary: versionScript("1.3.0-beta.1"), prerelease: true }] }).updater.check()).kind).toBe("up to date");
    expect((await server({ releases: [] }).updater.check()).kind).toBe("up to date");
  });

  test("a bad signature on the update file: refused before it is read, and the binary is never fetched", async () => {
    const s = server({ releases: [{ version: "1.3.0", binary: versionScript("1.3.0"), spoil: "feed signature" }] });
    expect(await s.updater.check()).toEqual({ kind: "refused", why: "latest-core-linux-x64.yml: bad signature" });
    expect(s.asked.some((u) => u.endsWith("/clover-core-1.3.0-linux-x64"))).toBe(false);
    expect(existsSync(`${s.bin}.new`)).toBe(false);
    expect(s.updater.ready()).toBe(false);
  });

  test("a bad hash: the binary is signed but isn't the one the update file names, so it never runs", async () => {
    const s = server({ releases: [{ version: "1.3.0", binary: versionScript("1.3.0"), spoil: "hash" }] });
    expect(await s.updater.check()).toEqual({ kind: "refused", why: "clover-core-1.3.0-linux-x64's sha512 or size doesn't match latest-core-linux-x64.yml" });
    expect(existsSync(`${s.bin}.new`)).toBe(false);
    expect(readFileSync(s.bin, "utf8")).toBe(versionScript("1.2.3"));
  });

  posix("a binary failing --version (an error, or another version) is removed and never installed", async () => {
    const failing = server({ releases: [{ version: "1.3.0", binary: script("exit 1") }] });
    expect(await failing.updater.check()).toMatchObject({ kind: "refused", why: expect.stringContaining("--version said nothing") });
    expect(existsSync(`${failing.bin}.new`)).toBe(false);
    const lying = server({ releases: [{ version: "1.3.0", binary: versionScript("1.2.3") }] });
    expect(await lying.updater.check()).toMatchObject({ kind: "refused", why: expect.stringContaining('"clover 1.2.3", not clover 1.3.0') });
    lying.updater.apply();
    await Bun.sleep(10);
    expect(lying.exited).toEqual([]);
    expect(readFileSync(lying.bin, "utf8")).toBe(versionScript("1.2.3"));
  });

  posix("a good swap: waits for idle, renews the lease, drains, swaps and exits to be started again", async () => {
    let busy = 1;
    const s = server({ releases: [{ version: "1.3.0", binary: versionScript("1.3.0") }], busy: () => busy });
    expect(await s.updater.check()).toEqual({ kind: "ready", version: "1.3.0" });
    expect(s.updater.available()).toBe("1.3.0");
    expect(s.updater.ready()).toBe(true);
    s.updater.apply();
    await Bun.sleep(20);
    expect(s.did).toEqual([]); // a turn runs: nothing stops
    busy = 0;
    for (let i = 0; i < 50 && s.exited.length === 0; i++) await Bun.sleep(10);
    expect(s.did).toEqual(["lease renewed", "drained"]);
    expect(s.exited).toEqual([UPDATE_RESTART_EXIT_CODE]);
    expect(readFileSync(s.bin, "utf8")).toBe(versionScript("1.3.0"));
    expect(readFileSync(`${s.bin}.old`, "utf8")).toBe(versionScript("1.2.3"));
    expect(existsSync(`${s.bin}.new`)).toBe(false);
    // The new version's first start is watched; once it ran long enough, the old binary goes.
    expect(beginUpdatedBoot(s.home, s.bin)).toBe("watching");
    bootWasGood(s.home, s.bin);
    expect(existsSync(`${s.bin}.old`)).toBe(false);
    expect(beginUpdatedBoot(s.home, s.bin)).toBe("normal");
  });

  posix("a binary crashing twice is rolled back to the old one, and that version is never taken again", async () => {
    const s = server({ releases: [{ version: "1.3.0", binary: versionScript("1.3.0") }] });
    await s.updater.check();
    await s.updater.swap();
    expect(s.exited).toEqual([UPDATE_RESTART_EXIT_CODE]);
    // Start 1 crashes, start 2 crashes; start 3 puts the old binary back.
    expect(beginUpdatedBoot(s.home, s.bin)).toBe("watching");
    expect(beginUpdatedBoot(s.home, s.bin)).toBe("watching");
    expect(beginUpdatedBoot(s.home, s.bin)).toBe("rolled-back");
    expect(readFileSync(s.bin, "utf8")).toBe(versionScript("1.2.3"));
    expect(existsSync(`${s.bin}.old`)).toBe(false);
    expect(rolledBack(s.home)).toEqual(["1.3.0"]);
    expect(beginUpdatedBoot(s.home, s.bin)).toBe("normal");
    // The old version, running again, doesn't take 1.3.0 a second time.
    const again = new SelfUpdater({ ...(s.updater as unknown as { d: ConstructorParameters<typeof SelfUpdater>[0] }).d });
    expect(await again.check()).toEqual({ kind: "refused", why: "1.3.0 was rolled back here" });
  });

  test("the boot check never throws, and does nothing without a swap behind it", () => {
    const home = mkdtempSync(join(tmpdir(), "clover-boot-"));
    expect(beginUpdatedBoot(home, join(home, "bin", "clover-core"))).toBe("normal");
    mkdirSync(join(home, "update"));
    writeFileSync(join(home, "update", "boot.json"), "{not json");
    expect(beginUpdatedBoot(home, join(home, "bin", "clover-core"))).toBe("normal");
    expect(() => bootWasGood(home, join(home, "nowhere", "clover-core"))).not.toThrow();
  });
});

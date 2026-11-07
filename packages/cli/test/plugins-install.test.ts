// The bundled plugins on a server (src/plugins-install.ts), against a fake release served from memory with a throwaway
// key, on a temp home: the install of exactly the tree the core's manifest names, then left in place; a tarball that
// isn't that tree, a tampered tarball or update file, a tarball another version names, the wrong tag or channel, and a
// core with no manifest, each refused with the folder untouched; a swap keeping `.old`; the start's local recovery from
// `.new` or `.old`; the back-off; one lock, and no swap once the gate committed. Nothing reaches the network or a
// real home.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatBundledManifest } from "@waifucave/clover-core";
import { formatCoreFeed, generateFeedKey, packTarball, pluginsFeedFile, pluginsTarballFile, signFeed, type TarballFile } from "@waifucave/clover-update-feed";
import { ensureServerPlugins, fetchBackoffFile, manifestSha256, PluginsLock, recoverServerPlugins, serverPluginsDir, stageServerPlugins, swapPluginsIn, treeManifestSha256 } from "../src/plugins-install";
import type { Fetcher } from "../src/self-update";

const enc = (s: string) => new TextEncoder().encode(s);
const TARGET = "linux-x64" as const;
const tagUrl = (version: string) => `https://api.github.com/repos/waifucave/clover/releases/tags/v${version}`;

const TREE: TarballFile[] = [
  { path: "clover/clover.json", bytes: enc(`{"id":"clover"}`), executable: false },
  { path: "clover/bin/run.sh", bytes: enc("#!/bin/sh\necho hi\n"), executable: true },
  { path: "alpha/clover.json", bytes: enc(`{"id":"alpha"}`), executable: false },
];

/** The SHA-256 of the manifest text a core built with `files` carries. */
function coreManifestSha(files: readonly TarballFile[]): string {
  const m: Record<string, { sha256: string; size: number }> = {};
  for (const f of files) m[f.path] = { sha256: createHash("sha256").update(f.bytes).digest("hex"), size: f.bytes.length };
  return createHash("sha256").update(formatBundledManifest({ files: m })).digest("hex");
}

interface Release { tag: string; version: string; tree?: TarballFile[]; spoil?: "tarball" | "feed signature"; names?: string; prerelease?: boolean; tagName?: string }

function github(key: { privateKey: string }, releases: Release[]) {
  const files = new Map<string, Uint8Array>();
  const list = releases.map((r) => {
    const url = (name: string) => `https://github.com/waifucave/clover/releases/download/${r.tag}/${name}`;
    const tarName = pluginsTarballFile(r.version, TARGET);
    const signed = packTarball(r.tree ?? TREE);
    const served = r.spoil === "tarball" ? (() => { const b = new Uint8Array(signed); b[b.length - 9]! ^= 1; return b; })() : signed;
    const feed = enc(formatCoreFeed({ version: r.version, file: r.names ?? tarName, sha512: createHash("sha512").update(signed).digest("base64"), size: signed.length }));
    const assets: Array<{ name: string; browser_download_url: string }> = [];
    const put = (name: string, bytes: Uint8Array) => { files.set(url(name), bytes); assets.push({ name, browser_download_url: url(name) }); };
    for (const ch of ["latest", "beta"] as const) {
      const name = pluginsFeedFile(ch, TARGET);
      put(name, feed);
      put(`${name}.sig`, enc(signFeed(name, r.spoil === "feed signature" ? enc("another file") : feed, key.privateKey)));
    }
    put(tarName, served);
    put(`${tarName}.sig`, enc(signFeed(tarName, signed, key.privateKey)));
    const release = { tag_name: r.tagName ?? r.tag, draft: false, prerelease: r.prerelease ?? false, assets };
    files.set(tagUrl(r.tag.slice(1)), enc(JSON.stringify(release)));
    return release;
  });
  void list;
  const asked: string[] = [];
  const fetch: Fetcher = async (u, opts) => {
    asked.push(u);
    const b = files.get(u);
    return b !== undefined && b.length <= opts.maxBytes ? b : undefined;
  };
  return { fetch, asked };
}

function server(releases: Release[]) {
  const home = mkdtempSync(join(tmpdir(), "clover-plugins-install-"));
  const key = generateFeedKey();
  const gh = github(key, releases);
  const lines: string[] = [];
  const dir = serverPluginsDir(home);
  let committed = false;
  let now = 1_000_000;
  const deps = (version: string, sha: string | undefined) => ({
    dir, home, version, manifestSha256: sha, target: TARGET, channel: "latest" as const, publicKey: key.publicKey, fetch: gh.fetch,
    committed: () => committed, now: () => now, log: (l: string) => lines.push(l),
  });
  return { home, dir, deps, gh, lines, commit: () => { committed = true; }, advance: (ms: number) => { now += ms; } };
}

describe("the bundled plugins on a server", () => {
  test("install: fetched, checked against the core's manifest and swapped in whole; then left in place", async () => {
    const s = server([{ tag: "v1.2.3", version: "1.2.3" }]);
    expect(s.dir).toBe(join(s.home, "bin", "plugins"));
    expect(await ensureServerPlugins(s.deps("1.2.3", coreManifestSha(TREE)))).toEqual({ kind: "installed", version: "1.2.3", files: 3 });
    expect(readFileSync(join(s.dir, "clover", "clover.json"), "utf8")).toBe(`{"id":"clover"}`);
    if (process.platform !== "win32") {
      expect(statSync(join(s.dir, "clover", "bin", "run.sh")).mode & 0o777).toBe(0o755);
      expect(statSync(join(s.dir, "alpha", "clover.json")).mode & 0o777).toBe(0o644);
    }
    expect(treeManifestSha256(s.dir)).toBe(coreManifestSha(TREE));
    expect(existsSync(`${s.dir}.new`)).toBe(false);
    const asked = s.gh.asked.length;
    expect(await ensureServerPlugins(s.deps("1.2.3", coreManifestSha(TREE)))).toEqual({ kind: "in place" });
    expect(s.gh.asked.length).toBe(asked);
  });

  test("a folder changed since (a file edited, one added) is fetched again", async () => {
    const s = server([{ tag: "v1.2.3", version: "1.2.3" }]);
    await ensureServerPlugins(s.deps("1.2.3", coreManifestSha(TREE)));
    writeFileSync(join(s.dir, "alpha", "extra.js"), "globalThis.x = 1;");
    expect((await ensureServerPlugins(s.deps("1.2.3", coreManifestSha(TREE)))).kind).toBe("installed");
    expect(existsSync(join(s.dir, "alpha", "extra.js"))).toBe(false);
    expect(existsSync(`${s.dir}.old`)).toBe(false);
  });

  test("a tarball that isn't the tree the core's manifest names is refused, and the folder stays as it was", async () => {
    const other = [...TREE.slice(0, 2), { path: "alpha/clover.json", bytes: enc(`{"id":"alphA"}`), executable: false }];
    const s = server([{ tag: "v1.2.3", version: "1.2.3", tree: other }]);
    mkdirSync(join(s.dir, "keep"), { recursive: true });
    writeFileSync(join(s.dir, "keep", "x"), "x");
    const r = await ensureServerPlugins(s.deps("1.2.3", coreManifestSha(TREE)));
    expect(r).toEqual({ kind: "refused", why: "clover-plugins-1.2.3-linux-x64.tar.gz isn't the tree this core's manifest names" });
    expect(readFileSync(join(s.dir, "keep", "x"), "utf8")).toBe("x");
    expect(existsSync(`${s.dir}.new`)).toBe(false);
  });

  test("a tampered tarball, a tampered update file, an update file naming another file, or no release: refused", async () => {
    const sha = coreManifestSha(TREE);
    const tampered = server([{ tag: "v1.2.3", version: "1.2.3", spoil: "tarball" }]);
    expect(await ensureServerPlugins(tampered.deps("1.2.3", sha))).toEqual({ kind: "refused", why: "clover-plugins-1.2.3-linux-x64.tar.gz: bad signature" });
    const feed = server([{ tag: "v1.2.3", version: "1.2.3", spoil: "feed signature" }]);
    expect(await ensureServerPlugins(feed.deps("1.2.3", sha))).toEqual({ kind: "refused", why: "latest-plugins-linux-x64.yml: bad signature" });
    expect(feed.gh.asked.some((u) => u.endsWith(".tar.gz"))).toBe(false);
    const names = server([{ tag: "v1.2.3", version: "1.2.3", names: "clover-plugins-1.2.2-linux-x64.tar.gz" }]);
    expect((await ensureServerPlugins(names.deps("1.2.3", sha))).kind).toBe("refused");
    const none = server([{ tag: "v1.2.2", version: "1.2.2" }]);
    expect(await ensureServerPlugins(none.deps("1.2.3", sha))).toEqual({ kind: "refused", why: "release v1.2.3 could not be read" });
    for (const s of [tampered, feed, names, none]) expect(existsSync(s.dir)).toBe(false);
  });

  test("a core with no manifest installs nothing", async () => {
    const s = server([{ tag: "v1.2.3", version: "1.2.3" }]);
    expect(await ensureServerPlugins(s.deps("1.2.3", undefined))).toEqual({ kind: "refused", why: "this core carries no bundled-plugins manifest" });
    expect(s.gh.asked).toEqual([]);
  });

  test("staged as .new, then swapped keeping .old (a self-update's swap); a rollback finds it", async () => {
    const s = server([{ tag: "v1.2.4", version: "1.2.4", tree: [...TREE, { path: "alpha/new.js", bytes: enc("1"), executable: false }] }, { tag: "v1.2.3", version: "1.2.3" }]);
    await ensureServerPlugins(s.deps("1.2.3", coreManifestSha(TREE)));
    const next = [...TREE, { path: "alpha/new.js", bytes: enc("1"), executable: false }];
    expect(await stageServerPlugins(s.deps("1.2.4", coreManifestSha(next)))).toEqual({ files: 4 });
    expect(treeManifestSha256(`${s.dir}.new`)).toBe(coreManifestSha(next));
    swapPluginsIn(s.dir, true);
    expect(treeManifestSha256(s.dir)).toBe(coreManifestSha(next));
    expect(treeManifestSha256(`${s.dir}.old`)).toBe(coreManifestSha(TREE));
    expect(existsSync(`${s.dir}.new`)).toBe(false);
  });

  test("manifestSha256 is the hash of the manifest's one text form", () => {
    const m = { files: { "a/b": { sha256: "0".repeat(64), size: 1 } } };
    expect(manifestSha256(m)).toBe(createHash("sha256").update(formatBundledManifest(m)).digest("hex"));
  });
});

describe("the release is the core's own tag, on its channel", () => {
  test("only releases/tags/v<version> is asked, and a beta or a mislabelled tag is refused on latest", async () => {
    const sha = coreManifestSha(TREE);
    const ok = server([{ tag: "v1.2.3", version: "1.2.3" }]);
    expect((await ensureServerPlugins(ok.deps("1.2.3", sha))).kind).toBe("installed");
    expect(ok.gh.asked[0]).toBe(tagUrl("1.2.3"));
    expect(ok.gh.asked.some((u) => u.includes("per_page"))).toBe(false);
    const beta = server([{ tag: "v1.2.3", version: "1.2.3", prerelease: true }]);
    expect(await ensureServerPlugins(beta.deps("1.2.3", sha))).toEqual({ kind: "refused", why: "release v1.2.3 is a beta, and this server takes latest" });
    const other = server([{ tag: "v1.2.3", version: "1.2.3", tagName: "v1.2.4" }]);
    expect(await ensureServerPlugins(other.deps("1.2.3", sha))).toEqual({ kind: "refused", why: "release v1.2.3 is not a published release of that tag" });
  });
});

describe("the start: local copies first, a back-off, one lock", () => {
  /** A folder at `path` holding `files`. */
  const write = (path: string, files: readonly TarballFile[]) => {
    for (const f of files) { mkdirSync(join(path, f.path, ".."), { recursive: true }); writeFileSync(join(path, f.path), f.bytes); }
  };
  const OLD_TREE = [{ path: "clover/clover.json", bytes: enc(`{"id":"clover","old":true}`), executable: false }];

  test("a power cut mid-swap: .new (the update's) or .old (a rollback's) that measures to the manifest is taken back, no download", () => {
    const s = server([]);
    write(`${s.dir}.new`, TREE);
    expect(recoverServerPlugins({ dir: s.dir, manifestSha256: coreManifestSha(TREE), watching: true, log: () => {} })).toEqual({ kind: "recovered", from: ".new" });
    expect(treeManifestSha256(s.dir)).toBe(coreManifestSha(TREE));
    const r = server([]);
    write(r.dir, TREE);
    write(`${r.dir}.old`, OLD_TREE);
    expect(recoverServerPlugins({ dir: r.dir, manifestSha256: coreManifestSha(OLD_TREE), watching: false, log: () => {} })).toEqual({ kind: "recovered", from: ".old" });
    expect(treeManifestSha256(r.dir)).toBe(coreManifestSha(OLD_TREE));
    expect(r.gh.asked).toEqual([]);
  });

  test("while an update is watched, .old (the rollback's copy) is never taken or removed; nothing matching: nothing done", () => {
    const s = server([]);
    write(s.dir, OLD_TREE);
    write(`${s.dir}.old`, TREE);
    expect(recoverServerPlugins({ dir: s.dir, manifestSha256: coreManifestSha(TREE), watching: true, log: () => {} })).toBeUndefined();
    expect(treeManifestSha256(`${s.dir}.old`)).toBe(coreManifestSha(TREE));
    expect(recoverServerPlugins({ dir: s.dir, manifestSha256: coreManifestSha([]), watching: false, log: () => {} })).toBeUndefined();
  });

  test("a failing refetch backs off (kept in a marker), doubling, and a success clears it", async () => {
    const s = server([{ tag: "v1.2.3", version: "1.2.3", spoil: "tarball" }]);
    const sha = coreManifestSha(TREE);
    expect((await ensureServerPlugins(s.deps("1.2.3", sha))).kind).toBe("refused");
    const first = JSON.parse(readFileSync(fetchBackoffFile(s.home), "utf8"));
    expect(first.failures).toBe(1);
    const asked = s.gh.asked.length;
    const waiting = await ensureServerPlugins(s.deps("1.2.3", sha));
    expect(waiting.kind === "refused" && waiting.why).toContain("tried again after");
    expect(s.gh.asked.length).toBe(asked);
    s.advance(first.until - 1_000_000 + 1);
    await ensureServerPlugins(s.deps("1.2.3", sha));
    expect(JSON.parse(readFileSync(fetchBackoffFile(s.home), "utf8")).failures).toBe(2);
    write(s.dir, TREE);
    expect(await ensureServerPlugins(s.deps("1.2.3", sha))).toEqual({ kind: "in place" });
    expect(existsSync(fetchBackoffFile(s.home))).toBe(false);
  });

  test("the refetch stages in .fetch, never a self-update's .new, and never swaps once the gate committed", async () => {
    const s = server([{ tag: "v1.2.3", version: "1.2.3" }]);
    write(`${s.dir}.new`, OLD_TREE);
    s.commit();
    expect(await ensureServerPlugins(s.deps("1.2.3", coreManifestSha(TREE)))).toEqual({ kind: "refused", why: "an update's restart is under way; the folder is left to it" });
    expect(existsSync(s.dir)).toBe(false);
    expect(existsSync(`${s.dir}.fetch`)).toBe(false);
    expect(treeManifestSha256(`${s.dir}.new`)).toBe(coreManifestSha(OLD_TREE));
  });

  test("one lock: what runs in it runs one at a time, in order, and a failure doesn't stop the next", async () => {
    const lock = new PluginsLock();
    const seen: string[] = [];
    const a = lock.run(async () => { seen.push("a start"); await Bun.sleep(20); seen.push("a end"); });
    const b = lock.run(async () => { seen.push("b"); throw new Error("b failed"); });
    const c = lock.run(() => { seen.push("c"); return 3; });
    await a;
    await expect(b).rejects.toThrow("b failed");
    expect(await c).toBe(3);
    expect(seen).toEqual(["a start", "a end", "b", "c"]);
  });
});

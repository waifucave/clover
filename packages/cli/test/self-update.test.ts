// A server's daemon updating itself (src/self-update.ts), against a fake release served from memory with a throwaway
// key, on a temp home with shell scripts for binaries: a bad signature, a bad hash, a binary failing `--version`, a
// binary crashing twice (rolled back), and a good swap. Nothing reaches the network or a real home.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coreBinaryFile, coreFeedFile, formatCoreFeed, generateFeedKey, signFeed } from "@waifucave/clover-update-feed";
import { UpdateGate, UPDATE_RESTART_EXIT_CODE } from "@waifucave/clover-core";
import { badBinary, beginUpdatedBoot, replaceBinary, bootWasGood, coreTargetOf, healFromOld, isNewer, MAX_FEED_BYTES, oldBinary, pluginsDirOf, superviseTarget, readCapped, rolledBack, runBundledManifest, runVersion, SelfUpdater, SWAP_BACKOFF_MS, versionEnv, type Fetcher } from "../src/self-update";
import { recoverServerPlugins, treeManifestSha256 } from "../src/plugins-install";
import { realOps, type DurableOps } from "../src/durable";

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
  const fetch: Fetcher = async (u, opts) => {
    asked.push(u);
    const b = files.get(u);
    return b !== undefined && b.length <= opts.maxBytes ? b : undefined;
  };
  return { fetch, asked, files };
}

/** A plugins tree for `version` written at `dir`, and the SHA-256 of the manifest it measures to. */
function pluginsTree(dir: string, version: string): string {
  mkdirSync(join(dir, "clover"), { recursive: true });
  writeFileSync(join(dir, "clover", "clover.json"), `{"id":"clover","v":"${version}"}`);
  return treeManifestSha256(dir)!;
}

/** The server's bundled plugins (the `<home>/bin/daemon` layout): what the new binary says it carries, and how a
 *  version's tree is staged (or refused). */
interface PluginsOpt { says?: string | "none" | undefined; refuse?: string }

function server(opts: { version?: string; channel?: "latest" | "beta"; releases: Release[]; busy?: () => number; onRenew?: () => void; drainMs?: number; reopenAfterMs?: number; plugins?: PluginsOpt; ops?: DurableOps }) {
  const home = mkdtempSync(join(tmpdir(), "clover-self-update-"));
  const binDir = opts.plugins === undefined ? join(home, "bin") : join(home, "bin", "daemon");
  mkdirSync(binDir, { recursive: true });
  const bin = join(binDir, "clover-core");
  const pluginsDir = join(home, "bin", "plugins");
  const staged: string[] = [];
  const nextSha = pluginsTree(join(mkdtempSync(join(tmpdir(), "clover-self-update-tree-")), "p"), "1.3.0");
  if (opts.plugins !== undefined) pluginsTree(pluginsDir, opts.version ?? "1.2.3");
  writeFileSync(bin, versionScript(opts.version ?? "1.2.3"), { mode: 0o755 });
  const key = generateFeedKey();
  const gh = github(key, opts.releases);
  const gate = new UpdateGate();
  if (opts.busy) gate.register({ name: "turns", count: opts.busy });
  const did: string[] = [];
  gate.beforeRestart(() => { did.push("lease renewed"); opts.onRenew?.(); });
  let now = 1_000_000;
  const exited: number[] = [];
  const lines: string[] = [];
  const updater = new SelfUpdater({
    home, bin, version: opts.version ?? "1.2.3", target: TARGET, channel: opts.channel ?? "latest", publicKey: key.publicKey,
    fetch: gh.fetch, gate, restartCode: UPDATE_RESTART_EXIT_CODE, idlePollMs: 1, now: () => now,
    drain: async () => {
      did.push("drained");
      if (opts.drainMs !== undefined) {
        await Bun.sleep(opts.drainMs);
        did.push(`still closed after the drain: ${gate.closed}`);
      }
    },
    ...(opts.reopenAfterMs !== undefined ? { reopenAfterMs: opts.reopenAfterMs } : {}),
    exit: (code) => { exited.push(code); },
    log: (l) => lines.push(l),
    ...(opts.ops === undefined ? {} : { ops: opts.ops }),
    ...(opts.plugins === undefined ? {} : {
      runManifest: async () => ("says" in opts.plugins! ? opts.plugins!.says : nextSha),
      plugins: {
        dir: pluginsDir,
        stage: async (version: string, sha: string) => {
          staged.push(`${version} ${sha === nextSha ? "the new manifest" : sha}`);
          if (opts.plugins!.refuse !== undefined) return { why: opts.plugins!.refuse };
          rmSync(`${pluginsDir}.new`, { recursive: true, force: true });
          pluginsTree(`${pluginsDir}.new`, version);
          return { files: 1 };
        },
      },
    }),
  });
  return { home, bin, pluginsDir, staged, nextSha, updater, did, exited, lines, asked: gh.asked, files: gh.files, gate, advance: (ms: number) => { now += ms; } };
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

  test("downloads are bounded: an update file over 64 KiB, or a binary over its signed size, is refused", async () => {
    const big = server({ releases: [{ version: "1.3.0", binary: versionScript("1.3.0") }] });
    const feedUrl = [...big.files.keys()].find((u) => u.endsWith("/latest-core-linux-x64.yml"))!;
    big.files.set(feedUrl, new Uint8Array(MAX_FEED_BYTES + 1));
    expect(await big.updater.check()).toMatchObject({ kind: "refused", why: expect.stringContaining("over 65536 bytes") });
    const long = server({ releases: [{ version: "1.3.0", binary: versionScript("1.3.0") }] });
    const binUrl = [...long.files.keys()].find((u) => u.endsWith("/clover-core-1.3.0-linux-x64"))!;
    long.files.set(binUrl, enc(`${versionScript("1.3.0")}# and more`));
    expect(await long.updater.check()).toMatchObject({ kind: "refused", why: expect.stringContaining("over its") });
    // The reader itself stops at the limit.
    const stream = (chunks: string[]) => new ReadableStream<Uint8Array>({ start(c) { for (const x of chunks) c.enqueue(enc(x)); c.close(); } });
    expect(await readCapped(stream(["abc", "def"]), 6)).toEqual(enc("abcdef"));
    expect(await readCapped(stream(["abc", "defg"]), 6)).toBeUndefined();
    expect(await readCapped(null, 6)).toEqual(new Uint8Array());
  });

  test("--version's environment: PATH alone, and on Windows SystemRoot and windir too", () => {
    const env = { PATH: "/bin", HOME: "/h", SystemRoot: "C:\\Windows", windir: "C:\\Windows", CLOVER_HOME: "/c" };
    expect(versionEnv(env, "linux")).toEqual({ PATH: "/bin" });
    expect(versionEnv(env, "darwin")).toEqual({ PATH: "/bin" });
    expect(versionEnv(env, "win32")).toEqual({ PATH: "/bin", SystemRoot: "C:\\Windows", windir: "C:\\Windows" });
    expect(versionEnv({ Path: "C:\\x", SYSTEMROOT: "C:\\W", WINDIR: "C:\\W" }, "win32")).toEqual({ PATH: "C:\\x", SystemRoot: "C:\\W", windir: "C:\\W" });
  });

  posix("a .new changed while it waited is refused just before the rename: the daemon keeps running, the gate reopens, the version backs off", async () => {
    const s = server({ releases: [{ version: "1.3.0", binary: versionScript("1.3.0") }] });
    expect((await s.updater.check()).kind).toBe("ready");
    writeFileSync(`${s.bin}.new`, versionScript("6.6.6"), { mode: 0o755 });
    s.updater.apply();
    for (let i = 0; i < 50 && !s.lines.some((l) => l.includes("failed")); i++) await Bun.sleep(5);
    expect(s.exited).toEqual([]);
    expect(s.did).toEqual(["lease renewed"]);
    expect(s.gate.closed).toBe(false);
    expect(readFileSync(s.bin, "utf8")).toBe(versionScript("1.2.3"));
    expect(existsSync(`${s.bin}.new`)).toBe(false);
    expect(s.lines.some((l) => l.includes("no longer the checked 1.3.0"))).toBe(true);
    expect(s.updater.ready()).toBe(false);
    // The same version waits out its back-off, then is taken again.
    expect(await s.updater.check()).toMatchObject({ kind: "refused", why: expect.stringContaining("tried again later") });
    s.advance(SWAP_BACKOFF_MS + 1);
    expect((await s.updater.check()).kind).toBe("ready");
  });

  posix("a swap that fails before the drain never exits: no restart loop", async () => {
    const s = server({ releases: [{ version: "1.3.0", binary: versionScript("1.3.0") }] });
    await s.updater.check();
    // The binaries' folder refuses the renames (as a Windows file in use would).
    chmodSync(join(s.home, "bin"), 0o555);
    try {
      await s.updater.swap();
    } finally {
      chmodSync(join(s.home, "bin"), 0o755);
    }
    expect(s.exited).toEqual([]);
    expect(s.did).toEqual([]);
    expect(readFileSync(s.bin, "utf8")).toBe(versionScript("1.2.3"));
    expect(s.lines.some((l) => l.includes("installing 1.3.0 failed, the daemon keeps running"))).toBe(true);
    // The boot count written before the renames went with the failure.
    expect(existsSync(join(s.home, "update", "boot.json"))).toBe(false);
  });

  posix("a turn that starts during the steps before the restart sends the swap back to waiting", async () => {
    let busy = 0;
    const s = server({ releases: [{ version: "1.3.0", binary: versionScript("1.3.0") }], busy: () => busy, onRenew: () => { if (busy === 0 && !started) { started = true; busy = 1; } } });
    let started = false;
    await s.updater.check();
    s.updater.apply();
    await Bun.sleep(30);
    // The turn that slipped in during the renew: nothing drained, nothing swapped, the gate open for it.
    expect(s.did).toEqual(["lease renewed"]);
    expect(s.exited).toEqual([]);
    expect(s.gate.closed).toBe(false);
    busy = 0;
    for (let i = 0; i < 50 && s.exited.length === 0; i++) await Bun.sleep(10);
    expect(s.did).toEqual(["lease renewed", "lease renewed", "drained"]);
    expect(s.exited).toEqual([UPDATE_RESTART_EXIT_CODE]);
  });

  posix("a good boot removes the old, the rolled-back and the moved-aside binaries", () => {
    const home = mkdtempSync(join(tmpdir(), "clover-good-boot-"));
    const bin = join(home, "clover-core");
    for (const f of [bin, `${bin}.old`, `${bin}.bad`, `${bin}.old-1700000000000`, `${bin}.new`]) writeFileSync(f, "x");
    bootWasGood(home, bin);
    expect(existsSync(bin)).toBe(true);
    expect(existsSync(`${bin}.new`)).toBe(true);
    for (const f of [`${bin}.old`, `${bin}.bad`, `${bin}.old-1700000000000`]) expect(existsSync(f)).toBe(false);
  });

  posix("committed once the binaries are swapped: a drain longer than the gate's reopen time still lets no turn start", async () => {
    const s = server({ releases: [{ version: "1.3.0", binary: versionScript("1.3.0") }], drainMs: 80, reopenAfterMs: 10 });
    await s.updater.check();
    s.updater.apply();
    for (let i = 0; i < 100 && s.exited.length === 0; i++) await Bun.sleep(10);
    expect(s.did).toEqual(["lease renewed", "drained", "still closed after the drain: true"]);
    expect(s.gate.committed).toBe(true);
    expect(s.exited).toEqual([UPDATE_RESTART_EXIT_CODE]);
  });

  test("a swap with nothing checked fails like any other: gate reopened, no exit", async () => {
    const s = server({ releases: [] });
    s.gate.close();
    await s.updater.swap();
    expect(s.exited).toEqual([]);
    expect(s.gate.closed).toBe(false);
    expect(s.lines.some((l) => l.includes("installing the update failed") && l.includes("no checked update"))).toBe(true);
  });

  posix("the bundled plugins update with the daemon: staged against the new binary's manifest, swapped with it, kept as .old until a good boot", async () => {
    const s = server({ releases: [{ version: "1.3.0", binary: versionScript("1.3.0") }], plugins: {} });
    const before = treeManifestSha256(s.pluginsDir);
    expect(await s.updater.check()).toEqual({ kind: "ready", version: "1.3.0" });
    expect(s.staged).toEqual(["1.3.0 the new manifest"]);
    s.updater.apply();
    for (let i = 0; i < 50 && s.exited.length === 0; i++) await Bun.sleep(10);
    expect(s.exited).toEqual([UPDATE_RESTART_EXIT_CODE]);
    expect(readFileSync(s.bin, "utf8")).toBe(versionScript("1.3.0"));
    expect(treeManifestSha256(s.pluginsDir)).toBe(s.nextSha);
    expect(treeManifestSha256(`${s.pluginsDir}.old`)).toBe(before);
    expect(existsSync(`${s.pluginsDir}.new`)).toBe(false);
    expect(pluginsDirOf(s.bin)).toBe(s.pluginsDir);
    expect(beginUpdatedBoot(s.home, s.bin)).toBe("watching");
    bootWasGood(s.home, s.bin);
    expect(existsSync(`${s.pluginsDir}.old`)).toBe(false);
  });

  posix("a rollback puts the old plugins back with the old binary", async () => {
    const s = server({ releases: [{ version: "1.3.0", binary: versionScript("1.3.0") }], plugins: {} });
    const before = treeManifestSha256(s.pluginsDir);
    await s.updater.check();
    s.updater.apply();
    for (let i = 0; i < 50 && s.exited.length === 0; i++) await Bun.sleep(10);
    expect(beginUpdatedBoot(s.home, s.bin)).toBe("watching");
    expect(beginUpdatedBoot(s.home, s.bin)).toBe("watching");
    expect(beginUpdatedBoot(s.home, s.bin)).toBe("rolled-back");
    expect(readFileSync(s.bin, "utf8")).toBe(versionScript("1.2.3"));
    expect(treeManifestSha256(s.pluginsDir)).toBe(before);
    expect(treeManifestSha256(`${s.pluginsDir}.bad`)).toBe(s.nextSha);
    bootWasGood(s.home, s.bin);
    expect(existsSync(`${s.pluginsDir}.bad`)).toBe(false);
  });

  posix("a new binary with no manifest, or plugins that can't be had, refuse the update: nothing waits", async () => {
    const none = server({ releases: [{ version: "1.3.0", binary: versionScript("1.3.0") }], plugins: { says: "none" } });
    expect(await none.updater.check()).toEqual({ kind: "refused", why: "clover-core-1.3.0-linux-x64 carries no bundled-plugins manifest" });
    expect(existsSync(`${none.bin}.new`)).toBe(false);
    const silent = server({ releases: [{ version: "1.3.0", binary: versionScript("1.3.0") }], plugins: { says: undefined } });
    expect((await silent.updater.check()).kind).toBe("refused");
    const refused = server({ releases: [{ version: "1.3.0", binary: versionScript("1.3.0") }], plugins: { refuse: "clover-plugins-1.3.0-linux-x64.tar.gz: bad signature" } });
    expect(await refused.updater.check()).toEqual({ kind: "refused", why: "the bundled plugins for 1.3.0: clover-plugins-1.3.0-linux-x64.tar.gz: bad signature" });
    expect(existsSync(`${refused.bin}.new`)).toBe(false);
    expect(refused.updater.ready()).toBe(false);
  });

  posix("plugins.new changed while it waited: refused at the swap, the daemon keeps running on both old ones", async () => {
    const s = server({ releases: [{ version: "1.3.0", binary: versionScript("1.3.0") }], plugins: {} });
    const before = treeManifestSha256(s.pluginsDir);
    await s.updater.check();
    writeFileSync(join(`${s.pluginsDir}.new`, "clover", "planted.js"), "globalThis.x = 1;");
    await s.gate.closeForRestart({ timeoutMs: 1_000 });
    await s.updater.swap();
    expect(s.exited).toEqual([]);
    expect(s.gate.closed).toBe(false);
    expect(readFileSync(s.bin, "utf8")).toBe(versionScript("1.2.3"));
    expect(treeManifestSha256(s.pluginsDir)).toBe(before);
    expect(existsSync(`${s.pluginsDir}.new`)).toBe(false);
    expect(s.lines.at(-1)).toContain("is no longer the checked plugins for 1.3.0");
  });

  posix("__bundled-manifest is asked like --version: PATH alone, its SHA-256 or none, and nothing else counts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clover-manifest-check-"));
    const sha = "a".repeat(64);
    const answer = (name: string, body: string) => { writeFileSync(join(dir, name), script(body), { mode: 0o755 }); return join(dir, name); };
    expect(await runBundledManifest(answer("one", `[ "$1" = __bundled-manifest ] && [ -z "$HOME" ] && echo "bundled-manifest: 996 files, sha256 ${sha}"`))).toBe(sha);
    expect(await runBundledManifest(answer("none", 'echo "bundled-manifest: 0 files, sha256 none"'))).toBe("none");
    expect(await runBundledManifest(answer("odd", 'echo "bundled-manifest: refused (two)"; exit 1'))).toBeUndefined();
    expect(await runBundledManifest(answer("hang", "sleep 30"), 300)).toBeUndefined();
  });

  /** Every step a swap takes, with `look` run before each one and once after the last: a power cut can fall between
   *  any two steps (each one atomic on its own), so what `look` sees is what a restart after a cut would find. */
  const watched = (look: (step: string) => void): { ops: DurableOps; steps: string[] } => {
    const steps: string[] = [];
    const wrap = <A extends unknown[]>(name: string, fn: (...a: A) => void) => (...a: A) => { look(`before ${name}`); steps.push(name); fn(...a); };
    return { steps, ops: { rename: wrap("rename", realOps.rename), link: wrap("link", realOps.link), rm: wrap("rm", realOps.rm), syncFile: realOps.syncFile, syncDir: wrap("syncDir", realOps.syncDir) } };
  };

  posix("a power cut at any step of the swap leaves a whole binary at bin, and plugins a start can recover", async () => {
    const seen: string[] = [];
    let s!: ReturnType<typeof server>;
    let oldSha = "";
    const look = (step: string) => {
      const bin = existsSync(s.bin) ? readFileSync(s.bin, "utf8") : "missing";
      seen.push(`${step}: bin ${bin === versionScript("1.2.3") ? "old" : bin === versionScript("1.3.0") ? "new" : bin}`);
      const tree = treeManifestSha256(s.pluginsDir);
      const recoverable = tree === oldSha || tree === s.nextSha || treeManifestSha256(`${s.pluginsDir}.new`) === s.nextSha || treeManifestSha256(`${s.pluginsDir}.old`) === oldSha;
      if (!recoverable) seen.push(`${step}: plugins unrecoverable`);
    };
    const w = watched(look);
    s = server({ releases: [{ version: "1.3.0", binary: versionScript("1.3.0") }], plugins: {}, ops: w.ops });
    oldSha = treeManifestSha256(s.pluginsDir)!;
    await s.updater.check();
    s.updater.apply();
    for (let i = 0; i < 50 && s.exited.length === 0; i++) await Bun.sleep(10);
    look("after the last step");
    expect(s.exited).toEqual([UPDATE_RESTART_EXIT_CODE]);
    expect(w.steps).toEqual(["rm", "link", "syncDir", "rename", "syncDir", "rm", "rename", "rename", "syncDir"]);
    expect(seen.filter((l) => !/: bin (old|new)$/.test(l))).toEqual([]);
    // A cut between the plugins' two renames: the folder is gone, `.new` is the new tree, and the start's recovery
    // (an update watched: `.new` only) takes it back.
    rmSync(s.pluginsDir, { recursive: true, force: true });
    rmSync(`${s.pluginsDir}.new`, { recursive: true, force: true });
    pluginsTree(`${s.pluginsDir}.new`, "1.3.0");
    expect(recoverServerPlugins({ dir: s.pluginsDir, manifestSha256: s.nextSha, watching: true, log: () => {} })).toEqual({ kind: "recovered", from: ".new" });
    expect(treeManifestSha256(s.pluginsDir)).toBe(s.nextSha);
  });

  posix("a power cut at any step of a rollback leaves a whole binary, and the version is recorded before the first", async () => {
    const s = server({ releases: [{ version: "1.3.0", binary: versionScript("1.3.0") }], plugins: {} });
    await s.updater.check();
    s.updater.apply();
    for (let i = 0; i < 50 && s.exited.length === 0; i++) await Bun.sleep(10);
    expect(beginUpdatedBoot(s.home, s.bin)).toBe("watching");
    expect(beginUpdatedBoot(s.home, s.bin)).toBe("watching");
    const seen: string[] = [];
    const w = watched((step) => {
      const bin = existsSync(s.bin) ? readFileSync(s.bin, "utf8") : "missing";
      if (bin !== versionScript("1.2.3") && bin !== versionScript("1.3.0")) seen.push(`${step}: bin ${bin}`);
      if (!rolledBack(s.home).includes("1.3.0")) seen.push(`${step}: not yet recorded`);
    });
    expect(beginUpdatedBoot(s.home, s.bin, () => {}, w.ops)).toBe("rolled-back");
    expect(seen).toEqual([]);
    expect(w.steps.slice(0, 4)).toEqual(["rm", "link", "syncDir", "rename"]);
    expect(readFileSync(s.bin, "utf8")).toBe(versionScript("1.2.3"));
  });

  posix("a swap step that fails puts everything back: the old binary at bin, the old plugins, no restart", async () => {
    let renames = 0;
    const failing: DurableOps = { ...realOps, rename: (a, b) => { renames++; if (renames === 3) throw new Error("injected: the disk refused"); realOps.rename(a, b); } };
    const s = server({ releases: [{ version: "1.3.0", binary: versionScript("1.3.0") }], plugins: {}, ops: failing });
    const before = treeManifestSha256(s.pluginsDir);
    await s.updater.check();
    await s.gate.closeForRestart({ timeoutMs: 1_000 });
    await s.updater.swap();
    expect(s.exited).toEqual([]);
    expect(readFileSync(s.bin, "utf8")).toBe(versionScript("1.2.3"));
    expect(treeManifestSha256(s.pluginsDir)).toBe(before);
    expect(s.lines.at(-1)).toContain("injected: the disk refused");
  });

  test("restartWhenIdle: at the next idle moment the gate closes and commits, the daemon drains and exits to restart", async () => {
    let busy = 1;
    const s = server({ releases: [], busy: () => busy });
    s.updater.restartWhenIdle("the bundled plugins were fetched again");
    await Bun.sleep(20);
    expect(s.exited).toEqual([]);
    busy = 0;
    for (let i = 0; i < 50 && s.exited.length === 0; i++) await Bun.sleep(10);
    expect(s.gate.committed).toBe(true);
    expect(s.did).toContain("drained");
    expect(s.exited).toEqual([UPDATE_RESTART_EXIT_CODE]);
    expect(s.lines.at(-1)).toContain("the bundled plugins were fetched again");
  });

  test("Windows names: the rollback copies end in .exe, so cmd.exe and the logon task can start them", () => {
    expect(oldBinary("C:\\h\\bin\\daemon\\clover-core.exe")).toBe("C:\\h\\bin\\daemon\\clover-core.old.exe");
    expect(badBinary("C:\\h\\bin\\daemon\\clover-core.exe")).toBe("C:\\h\\bin\\daemon\\clover-core.bad.exe");
    expect(oldBinary("/h/bin/daemon/clover-core")).toBe("/h/bin/daemon/clover-core.old");
  });

  test("supervise started as the .old copy takes the binary once it is back, and only a server's", () => {
    const have = (set: string[]) => (p: string) => set.includes(p);
    expect(superviseTarget("/h/bin/daemon/clover-core.old", have(["/h/bin/daemon/clover-core"]))).toBe("/h/bin/daemon/clover-core");
    expect(superviseTarget("/h/bin/daemon/clover-core.old", have([]))).toBe("/h/bin/daemon/clover-core.old");
    expect(superviseTarget("C:/h/bin/daemon/clover-core.old.exe", have(["C:/h/bin/daemon/clover-core.exe"]))).toBe("C:/h/bin/daemon/clover-core.exe");
    expect(superviseTarget("/h/bin/daemon/clover-core", have([]))).toBe("/h/bin/daemon/clover-core");
    expect(superviseTarget("/elsewhere/x.old", have(["/elsewhere/x"]))).toBe("/elsewhere/x.old");
  });

  posix("a daemon started as .old with the binary missing finishes the swap from .new when it hashes to the recorded SHA-512", async () => {
    const s = server({ releases: [{ version: "1.3.0", binary: versionScript("1.3.0") }] });
    await s.updater.check();
    await s.gate.closeForRestart({ timeoutMs: 1_000 });
    await s.updater.swap();
    // A cut between Windows' two renames: the binary is gone, the new one still `.new`.
    const { renameSync } = await import("node:fs");
    renameSync(s.bin, `${s.bin}.new`);
    expect(healFromOld(s.home, s.bin, oldBinary(s.bin))).toEqual({ kind: "finished the swap" });
    expect(readFileSync(s.bin, "utf8")).toBe(versionScript("1.3.0"));
    expect(beginUpdatedBoot(s.home, s.bin)).toBe("watching");
  });

  posix("... and else copies itself back durably and drops the boot record; with the binary there, nothing to do", async () => {
    const s = server({ releases: [{ version: "1.3.0", binary: versionScript("1.3.0") }] });
    await s.updater.check();
    await s.gate.closeForRestart({ timeoutMs: 1_000 });
    await s.updater.swap();
    expect(healFromOld(s.home, s.bin, oldBinary(s.bin))).toEqual({ kind: "not needed" });
    rmSync(s.bin);
    writeFileSync(`${s.bin}.new`, "not the checked binary");
    expect(healFromOld(s.home, s.bin, oldBinary(s.bin))).toEqual({ kind: "restored", from: oldBinary(s.bin) });
    expect(readFileSync(s.bin, "utf8")).toBe(versionScript("1.2.3"));
    expect(beginUpdatedBoot(s.home, s.bin)).toBe("normal");
    // A daemon that isn't the .old copy never heals anything.
    rmSync(s.bin);
    expect(healFromOld(s.home, s.bin, join(s.home, "elsewhere"))).toEqual({ kind: "not needed" });
  });

  posix("a folder flush that fails after the rename is reported as swapped, never undone", async () => {
    let syncs = 0;
    const flaky: DurableOps = { ...realOps, syncDir: (p) => { syncs++; if (syncs === 2) throw new Error("injected: flush failed"); realOps.syncDir(p); } };
    const s = server({ releases: [{ version: "1.3.0", binary: versionScript("1.3.0") }], ops: flaky });
    await s.updater.check();
    s.updater.apply();
    for (let i = 0; i < 50 && s.exited.length === 0; i++) await Bun.sleep(10);
    expect(s.exited).toEqual([UPDATE_RESTART_EXIT_CODE]);
    expect(readFileSync(s.bin, "utf8")).toBe(versionScript("1.3.0"));
    expect(s.lines.some((l) => l.includes("is swapped in, but flushing its folder failed: injected: flush failed"))).toBe(true);
  });

  test("replaceBinary on this OS (links on macOS and Linux, renames on Windows): the new one in place, the old one aside, a failure undone", () => {
    const dir = mkdtempSync(join(tmpdir(), "clover-replace-"));
    const bin = join(dir, process.platform === "win32" ? "clover-core.exe" : "clover-core");
    writeFileSync(bin, "old");
    writeFileSync(`${bin}.new`, "new");
    expect(replaceBinary(bin, `${bin}.new`, oldBinary(bin))).toBeUndefined();
    expect(readFileSync(bin, "utf8")).toBe("new");
    expect(readFileSync(oldBinary(bin), "utf8")).toBe("old");
    expect(existsSync(`${bin}.new`)).toBe(false);
    const refusing: DurableOps = { ...realOps, rename: (a, b) => { if (a.endsWith(".missing")) throw new Error("injected"); realOps.rename(a, b); } };
    expect(() => replaceBinary(bin, `${bin}.missing`, oldBinary(bin), refusing)).toThrow("injected");
    expect(readFileSync(bin, "utf8")).toBe("new");
  });
});

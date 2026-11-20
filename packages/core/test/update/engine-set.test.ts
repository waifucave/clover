// The engine copy places the SET the engine runs with (update/engine-copy.ts): the engine, every file beside it
// (`engineSidecars`: plugin Bun, link sidecar, on macOS the process holder) and the bundled tree, staged, checked and swapped
// so a half-placed set is never what runs. Temp homes and stand-in files only; no engine is started.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FakeClock } from "../../src/contracts/fakes/clock";
import { engineSidecars } from "../../src/bundled-identities";
import { compareBuilds, engineBinaryPath, engineVersionEnv, engineSidecarPaths, installedSetProblem, isNewerCopy, isSameCopy, locateEngineIn, placeEngine, readEngineMarker, verifyBundleEngine, verifyStagedEngine, verifyStagedSidecar, type CopyPolicy } from "../../src/update/engine-copy";
import { EngineReleaseHome } from "../../src/update/release-home";
import { writeSidecars } from "./fixtures/sidecars";

const root = mkdtempSync(join(tmpdir(), "moss-ei-set-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

/** An app bundle of `platform`'s layout whose engine says it is `release` and whose every file's content names `tag`. */
function bundle(release: string, tag: string, platform: NodeJS.Platform = "linux", without: string[] = []): string {
  const dir = join(root, `app${n++}`);
  const src = locateEngineIn(dir, platform)!;
  mkdirSync(dirname(src.binary), { recursive: true });
  mkdirSync(join(src.tree, "x"), { recursive: true });
  writeFileSync(src.binary, `#!/bin/sh\necho "moss ${release}"\n# ${tag}\n`);
  chmodSync(src.binary, 0o755);
  writeSidecars(dirname(src.binary), tag);
  for (const f of without) rmSync(join(dirname(src.binary), f), { force: true });
  writeFileSync(join(src.tree, "x", "a.txt"), tag);
  return dir;
}

const homeOf = (): string => join(root, `home${n++}`);
const place = (home: string, dir: string, copy: { release: string; build?: string }, platform: NodeJS.Platform = "linux", verify?: { engine?: (s: string) => void; sidecar?: (s: string, f: string) => void }): void => {
  const src = locateEngineIn(dir, platform)!;
  placeEngine(home, { ...src, root: dir }, { ...copy, from: dir }, platform, verify?.engine, verify?.sidecar);
};
const read = (p: string): string => readFileSync(p, "utf8");
/** Every file of the placed set, by name, as `[name, content]`: the engine, each sidecar and the tree's one file. */
const setOf = (home: string, platform: NodeJS.Platform = "linux"): [string, string][] => [
  ["moss-core", read(engineBinaryPath(home, platform))],
  ...engineSidecars(platform).map((s): [string, string] => [s.file, read(join(dirname(engineBinaryPath(home, platform)), s.file))]),
  ["plugins/x/a.txt", read(join(home, "bin", "plugins", "x", "a.txt"))],
];
const tagsOf = (home: string, platform: NodeJS.Platform = "linux"): string[] => setOf(home, platform).map(([, c]) => c.trim().split(/\s+/).at(-1)!);
const ls = (dir: string): string[] => { try { return readdirSync(dir); } catch { return []; } };
const leftovers = (home: string): string[] => [...ls(join(home, "bin", "daemon")), ...ls(join(home, "bin"))].filter((f) => f.endsWith(".new") || f.startsWith(".verify-"));

describe("the set a copy places", () => {
  test("the engine, every sidecar of the OS and the tree land under bin/, runnable, with the marker written", () => {
    for (const platform of ["linux", "darwin", "win32"] as const) {
      const home = homeOf();
      place(home, bundle("1.0.0", "a", platform), { release: "1.0.0", build: "20261120100000" }, platform);
      expect(engineSidecars(platform).map((s) => s.file)).toEqual(platform === "darwin" ? ["moss-plugin-bun", "moss-link", "moss-process-holder"] : platform === "win32" ? ["moss-plugin-bun.exe", "moss-link.exe"] : ["moss-plugin-bun", "moss-link"]);
      expect(tagsOf(home, platform)).toEqual(Array(engineSidecars(platform).length + 2).fill("a"));
      for (const p of [engineBinaryPath(home, platform), ...engineSidecarPaths(home, platform)]) expect(lstatSync(p).mode & 0o111).not.toBe(0);
      expect(readEngineMarker(home)).toMatchObject({ release: "1.0.0", build: "20261120100000" });
      expect(leftovers(home)).toEqual([]);
    }
  });

  test("only the files engineSidecars names are placed: a stranger in the bundle's folder is not", () => {
    const home = homeOf();
    const dir = bundle("1.0.0", "a");
    writeFileSync(join(dirname(locateEngineIn(dir, "linux")!.binary), "evil"), "x");
    place(home, dir, { release: "1.0.0" });
    expect(existsSync(join(home, "bin", "daemon", "evil"))).toBe(false);
    // Linux has no process holder: it isn't placed there either, even when the bundle holds one.
    expect(existsSync(join(home, "bin", "daemon", "moss-process-holder"))).toBe(false);
  });

  test("a second copy swaps the whole set and keeps each old file aside as .old", () => {
    const home = homeOf();
    place(home, bundle("1.0.0", "a"), { release: "1.0.0", build: "1" });
    place(home, bundle("1.0.1", "b"), { release: "1.0.1", build: "1" });
    expect(tagsOf(home)).toEqual(["b", "b", "b", "b"]);
    for (const f of ["moss-core", "moss-plugin-bun", "moss-link"]) expect(read(join(home, "bin", "daemon", `${f}.old`))).toContain(f === "moss-core" ? "# a" : " a");
    expect(read(join(home, "bin", "plugins.old", "x", "a.txt"))).toBe("a");
    expect(readEngineMarker(home)).toMatchObject({ release: "1.0.1" });
    expect(leftovers(home)).toEqual([]);
  });
});

describe("a copy that can't be placed whole leaves the old set running", () => {
  const before = (home: string, platform: NodeJS.Platform = "linux") => ({ set: setOf(home, platform), marker: readEngineMarker(home) });

  test("a sidecar missing from the bundle is a refusal that names it; the installed set, tree and marker are as they were", () => {
    for (const [platform, missing] of [["linux", "moss-plugin-bun"], ["linux", "moss-link"], ["darwin", "moss-process-holder"]] as const) {
      const home = homeOf();
      place(home, bundle("1.0.0", "old", platform), { release: "1.0.0" }, platform);
      const was = before(home, platform);
      expect(() => place(home, bundle("1.1.0", "new", platform, [missing]), { release: "1.1.0" }, platform)).toThrow(`${missing} is missing from the bundle`);
      expect(before(home, platform)).toEqual(was);
      expect(leftovers(home)).toEqual([]);
    }
  });

  test("a sidecar whose staged bytes fail their check is refused before any rename; the engine's own failing check is too", () => {
    const home = homeOf();
    place(home, bundle("1.0.0", "old"), { release: "1.0.0" });
    const was = before(home);
    expect(() => place(home, bundle("1.1.0", "new"), { release: "1.1.0" }, "linux", { sidecar: (_s, f) => { if (f === "moss-link") throw new Error("moss-link's code signature isn't MOSS's"); } })).toThrow("moss-link's code signature");
    expect(before(home)).toEqual(was);
    expect(() => place(home, bundle("1.1.0", "new"), { release: "1.1.0" }, "linux", { engine: () => { throw new Error("the engine copy's code signature isn't MOSS's"); } })).toThrow("the engine copy's code signature");
    expect(before(home)).toEqual(was);
    expect(leftovers(home)).toEqual([]);
  });

  test("a sidecar that is a link out of the bundle, or to another file of it, names nothing", () => {
    const home = homeOf();
    place(home, bundle("1.0.0", "old"), { release: "1.0.0" });
    const was = before(home);
    const elsewhere = join(root, `outside${n++}`);
    writeFileSync(elsewhere, "planted");
    const out = bundle("1.1.0", "new");
    const folder = dirname(locateEngineIn(out, "linux")!.binary);
    rmSync(join(folder, "moss-link"));
    symlinkSync(elsewhere, join(folder, "moss-link"));
    expect(() => place(home, out, { release: "1.1.0" })).toThrow(/leads outside|isn't a file beside the engine/);
    // Inside the bundle, but another file of it: the core's own bytes under the link sidecar's name.
    const inside = bundle("1.1.0", "new");
    const folder2 = dirname(locateEngineIn(inside, "linux")!.binary);
    rmSync(join(folder2, "moss-link"));
    symlinkSync(join(folder2, "moss-core"), join(folder2, "moss-link"));
    expect(() => place(home, inside, { release: "1.1.0" })).toThrow("isn't a file beside the engine");
    // The same two with no root (the app's own `engine install`, which has none): still refused.
    const src = locateEngineIn(inside, "linux")!;
    expect(() => placeEngine(home, src, { release: "1.1.0", from: inside }, "linux")).toThrow("isn't a file beside the engine");
    expect(before(home)).toEqual(was);
  });

  test("a rename that fails part-way is undone: every file, the tree and the marker are the old ones", () => {
    const home = homeOf();
    place(home, bundle("1.0.0", "old"), { release: "1.0.0", build: "1" });
    const was = before(home);
    // The marker is written after every rename: a folder where its temp file goes makes that write fail with the set swapped.
    mkdirSync(join(home, "bin", `engine.json.${process.pid}.tmp`));
    expect(() => place(home, bundle("1.1.0", "new"), { release: "1.1.0", build: "2" })).toThrow();
    expect(before(home)).toEqual(was);
    expect(tagsOf(home)).toEqual(["old", "old", "old", "old"]);
    expect(leftovers(home)).toEqual([]);
    rmSync(join(home, "bin", `engine.json.${process.pid}.tmp`), { recursive: true });
    // And the next install, with the obstacle gone, places the set.
    place(home, bundle("1.1.0", "new"), { release: "1.1.0", build: "2" });
    expect(tagsOf(home)).toEqual(["new", "new", "new", "new"]);
  });

  test("a first install that fails leaves nothing under bin/daemon", () => {
    const home = homeOf();
    expect(() => place(home, bundle("1.0.0", "a", "linux", ["moss-link"]), { release: "1.0.0" })).toThrow();
    expect(existsSync(engineBinaryPath(home))).toBe(false);
    expect(readEngineMarker(home)).toBeUndefined();
    expect(ls(join(home, "bin", "daemon"))).toEqual([]);
  });
});

/** A policy whose `check` is told what each requirement is asked of which path (macOS). */
function policy(over: Partial<CopyPolicy> = {}): CopyPolicy {
  return { platform: "darwin", profile: "dist", developerId: true, records: () => [], check: () => true, ...over };
}

describe("the checks cover the set", () => {
  test("each staged sidecar is asked its own identifier's requirement; the engine its own", () => {
    const asked: string[] = [];
    const p = policy({ check: (path, req) => { asked.push(`${path.split("/").at(-1)}|${/identifier "([^"]+)"/.exec(req)![1]}`); return true; } });
    verifyStagedSidecar("/x/moss-plugin-bun.new", "moss-plugin-bun", p);
    verifyStagedSidecar("/x/moss-link.new", "moss-link", p);
    verifyStagedSidecar("/x/moss-process-holder.new", "moss-process-holder", p);
    expect(asked).toEqual(["moss-plugin-bun.new|com.waifucave.moss.core.plugin-bun", "moss-link.new|com.waifucave.moss.core.link", "moss-process-holder.new|com.waifucave.moss.core.process-holder"]);
    asked.length = 0;
    verifyStagedSidecar("/x/moss-link.new", "moss-link", policy({ profile: "dev", developerId: false, check: (path, req) => { asked.push(req); return true; } }));
    expect(asked[0]).toContain('identifier "com.waifucave.moss.core.link.dev"');
    expect(asked[0]).not.toContain("1.2.840.113635.100.6.1.13");
    expect(() => verifyStagedSidecar("/x/stranger", "stranger", policy())).toThrow("isn't one of the files");
    // A requirement that fails refuses, naming the file.
    expect(() => verifyStagedSidecar("/x/moss-link.new", "moss-link", policy({ check: () => false }))).toThrow("moss-link's code signature isn't MOSS's");
    // Not macOS: no signature to ask, so no check is made.
    verifyStagedSidecar("/x/moss-link.new", "moss-link", policy({ platform: "linux", check: () => { throw new Error("asked"); } }));
  });

  test("verifyBundleEngine stages and checks every file of the set before release.bring waits; a missing or failing one refuses it, and the scratch is gone", () => {
    const home = homeOf();
    mkdirSync(join(home, "bin"), { recursive: true });
    const seen: string[] = [];
    const ok = policy({ versionOf: () => "moss 1.1.0", check: (path) => { seen.push(path.split("/").at(-1)!); return true; } });
    verifyBundleEngine(home, bundle("1.1.0", "n", "darwin"), "1.1.0", ok);
    expect(seen.sort()).toEqual(["moss-core", "moss-link", "moss-plugin-bun", "moss-process-holder"]);
    expect(() => verifyBundleEngine(home, bundle("1.1.0", "n", "darwin", ["moss-process-holder"]), "1.1.0", ok)).toThrow("moss-process-holder is missing from the bundle");
    expect(() => verifyBundleEngine(home, bundle("1.1.0", "n", "darwin"), "1.1.0", policy({ versionOf: () => "moss 1.1.0", check: (path) => !path.endsWith("moss-link") }))).toThrow("moss-link's code signature isn't MOSS's");
    expect(() => verifyBundleEngine(home, bundle("1.1.0", "n", "darwin"), "1.1.0", policy({ versionOf: () => "moss 1.1.0", check: (path) => !path.endsWith("moss-core") }))).toThrow("the engine copy's code signature");
    expect(leftovers(home)).toEqual([]);
  });

  test("installedSetProblem: whole, a file missing, a link, a file failing its requirement", () => {
    const home = homeOf();
    place(home, bundle("1.0.0", "a", "darwin"), { release: "1.0.0" }, "darwin");
    expect(installedSetProblem(home, policy())).toBeUndefined();
    expect(installedSetProblem(home, policy({ check: (path) => !path.endsWith("moss-plugin-bun") }))).toBe("moss-plugin-bun's code signature isn't MOSS's");
    const link = join(home, "bin", "daemon", "moss-link");
    rmSync(link);
    expect(installedSetProblem(home, policy())).toContain("moss-link is missing");
    symlinkSync(join(home, "bin", "daemon", "moss-core"), link);
    expect(installedSetProblem(home, policy())).toContain("moss-link is missing");
    expect(installedSetProblem(homeOf(), policy())).toContain("moss-core is missing");
  });
});

describe("the environment a staged engine's --version runs in", () => {
  const source = { PATH: "/usr/bin", HOME: "/tmp/h", MOSS_TEST_KEYCHAIN: "/tmp/k", MOSS_HOME: "/tmp/m", ANTHROPIC_API_KEY: "dummy123", SystemRoot: "C:\\Windows" };
  test("a release's is PATH alone; a test-marked build's adds its keychain file and HOME, nothing else", () => {
    expect(engineVersionEnv(source, false, "darwin")).toEqual({ PATH: "/usr/bin" });
    expect(engineVersionEnv(source, true, "darwin")).toEqual({ PATH: "/usr/bin", HOME: "/tmp/h", MOSS_TEST_KEYCHAIN: "/tmp/k" });
    expect(engineVersionEnv({ PATH: "/usr/bin", MOSS_TEST_KEYCHAIN: "" }, true, "linux")).toEqual({ PATH: "/usr/bin" });
    expect(engineVersionEnv(source, false, "win32")).toEqual({ PATH: "/usr/bin", SystemRoot: "C:\\Windows" });
    // A checkout, a unit test and every real build here are not test-marked: the default carries nothing.
    expect(engineVersionEnv(source, undefined, "darwin")).toEqual({ PATH: "/usr/bin" });
    expect(Object.keys(engineVersionEnv(source, false, "linux"))).not.toContain("ANTHROPIC_API_KEY");
  });
});

describe("which copy replaces which", () => {
  const copy = (release: string, build?: string) => ({ release, from: "/x", ...(build === undefined ? {} : { build }) });
  const A = "20261120100000", B = "20261120100001", C = "20261121000000";

  test("same release: a later build replaces; an earlier or equal one doesn't; a stamped build beats an unstamped copy; an unstamped one beats nothing", () => {
    expect(isNewerCopy(copy("0.124.0", B), copy("0.124.0", A))).toBe(true);
    expect(isNewerCopy(copy("0.124.0", C), copy("0.124.0", B))).toBe(true);
    expect(isNewerCopy(copy("0.124.0", A), copy("0.124.0", B))).toBe(false);
    expect(isNewerCopy(copy("0.124.0", A), copy("0.124.0", A))).toBe(false);
    // The owner's marker has no build; a stamped copy of the same release is newer.
    expect(isNewerCopy(copy("0.124.0", A), copy("0.124.0"))).toBe(true);
    expect(isNewerCopy(copy("0.124.0"), copy("0.124.0", A))).toBe(false);
    expect(isNewerCopy(copy("0.124.0"), copy("0.124.0"))).toBe(false);
    // A newer release wins whatever the builds; an older one never does.
    expect(isNewerCopy(copy("0.125.0", A), copy("0.124.0", C))).toBe(true);
    expect(isNewerCopy(copy("0.124.0", C), copy("0.125.0", A))).toBe(false);
    expect(isNewerCopy(copy("0.124.0"), undefined)).toBe(true);
    expect(isSameCopy(copy("0.124.0", A), copy("0.124.0", A))).toBe(true);
    expect(isSameCopy(copy("0.124.0"), copy("0.124.0"))).toBe(true);
    expect(isSameCopy(copy("0.124.0", A), copy("0.124.0"))).toBe(false);
    expect(isSameCopy(copy("0.124.0", A), copy("0.124.1", A))).toBe(false);
  });

  test("builds order as numbers: by length first, not as text", () => {
    expect(compareBuilds("9", "10")).toBeLessThan(0);
    expect(compareBuilds("007", "7")).toBe(0);
    expect(compareBuilds("20261120100000", "20261120095959")).toBeGreaterThan(0);
    expect(compareBuilds("a2", "a10")).toBeLessThan(0);
  });

  /** A home whose installs place the real set from stand-in bundles, one per copy. */
  function installing(platform: NodeJS.Platform = "linux", checked = true) {
    const home = homeOf();
    const bundles = new Map<string, string>();
    const p = policy({ platform, versionOf: (staged) => /echo "(moss [^"]+)"/.exec(readFileSync(staged, "utf8"))?.[1] });
    const h = new EngineReleaseHome({
      home, engine: "0.124.0", clock: new FakeClock(),
      place: (c) => {
        const src = locateEngineIn(c.from, platform)!;
        placeEngine(home, { ...src, root: c.from }, c, platform, (s) => verifyStagedEngine(s, c.release, p), (s, f) => verifyStagedSidecar(s, f, p));
      },
      ...(checked ? { intact: () => installedSetProblem(home, p) === undefined } : {}),
    });
    const install = (release: string, build: string | undefined, tag: string, without: string[] = []) => {
      const key = `${release}/${build}/${tag}/${without.join(",")}`;
      if (!bundles.has(key)) bundles.set(key, bundle(release, tag, platform, without));
      return h.install({ release, from: bundles.get(key)!, ...(build === undefined ? {} : { build }) });
    };
    return { home, h, install, p };
  }

  test("a later build of the same release replaces the installed set, an older or equal one only connects", async () => {
    const t = installing();
    expect((await t.install("0.124.0", "20261120100000", "first")).installed).toBe(true);
    expect((await t.install("0.124.0", "20261120100000", "equal")).installed).toBe(false);
    expect(tagsOf(t.home)).toEqual(["first", "first", "first", "first"]);
    expect((await t.install("0.124.0", "20261120110000", "second")).installed).toBe(true);
    expect(tagsOf(t.home)).toEqual(["second", "second", "second", "second"]);
    expect((await t.install("0.124.0", "20261120090000", "older")).installed).toBe(false);
    expect(tagsOf(t.home)).toEqual(["second", "second", "second", "second"]);
    expect(readEngineMarker(t.home)).toMatchObject({ release: "0.124.0", build: "20261120110000" });
  });

  test("the owner's case: a marker with no build is replaced by a stamped build of its release", async () => {
    const t = installing();
    expect((await t.install("0.124.0", undefined, "unstamped")).installed).toBe(true);
    expect(readEngineMarker(t.home)?.build).toBeUndefined();
    expect((await t.install("0.124.0", undefined, "unstamped-again")).installed).toBe(false);
    expect((await t.install("0.124.0", "20261120100000", "stamped")).installed).toBe(true);
    expect(tagsOf(t.home)).toEqual(["stamped", "stamped", "stamped", "stamped"]);
  });

  test("repair: the same release and build with a sidecar gone, or failing its check, is placed again; whole, it isn't", async () => {
    const t = installing();
    await t.install("0.124.0", "20261120100000", "x");
    expect((await t.install("0.124.0", "20261120100000", "x")).installed).toBe(false);
    for (const gone of ["moss-plugin-bun", "moss-link"]) {
      rmSync(join(t.home, "bin", "daemon", gone));
      const r = await t.install("0.124.0", "20261120100000", "x");
      expect(r.installed).toBe(true);
      expect(tagsOf(t.home)).toEqual(["x", "x", "x", "x"]);
    }
    // The engine itself gone, with the marker standing.
    rmSync(engineBinaryPath(t.home));
    expect((await t.install("0.124.0", "20261120100000", "x")).installed).toBe(true);
    expect(existsSync(engineBinaryPath(t.home))).toBe(true);
    // A link in a sidecar's place isn't a file placed by an install.
    rmSync(join(t.home, "bin", "daemon", "moss-link"));
    symlinkSync(engineBinaryPath(t.home), join(t.home, "bin", "daemon", "moss-link"));
    expect((await t.install("0.124.0", "20261120100000", "x")).installed).toBe(true);
    expect(lstatSync(join(t.home, "bin", "daemon", "moss-link")).isSymbolicLink()).toBe(false);
  });

  test("repair on macOS: a sidecar that fails its code requirement as it sits is placed again; the repair is itself checked", async () => {
    let tampered = false;
    const t = installing("darwin");
    const bad = policy({ check: (path) => !(tampered && path.endsWith("/bin/daemon/moss-link")) });
    const h = new EngineReleaseHome({
      home: t.home, engine: "0.124.0", clock: new FakeClock(),
      place: (c) => { const src = locateEngineIn(c.from, "darwin")!; placeEngine(t.home, { ...src, root: c.from }, c, "darwin", (s) => verifyStagedEngine(s, c.release, { ...bad, versionOf: t.p.versionOf }), (s, f) => verifyStagedSidecar(s, f, bad)); },
      intact: () => installedSetProblem(t.home, bad) === undefined,
    });
    const dir = bundle("0.124.0", "x", "darwin");
    expect((await h.install({ release: "0.124.0", build: "1", from: dir })).installed).toBe(true);
    expect((await h.install({ release: "0.124.0", build: "1", from: dir })).installed).toBe(false);
    tampered = true;
    // The installed link sidecar now fails its requirement: the repair places the bundle's, whose staged copy (`.new`) passes.
    const r = await h.install({ release: "0.124.0", build: "1", from: dir });
    expect(r.installed).toBe(true);
    expect(tagsOf(t.home, "darwin")).toEqual(["x", "x", "x", "x", "x"]);
  });

  test("an installed copy that is NEWER is never replaced to repair it by an older one", async () => {
    const t = installing();
    await t.install("0.124.0", "20261120110000", "new");
    rmSync(join(t.home, "bin", "daemon", "moss-link"));
    expect((await t.install("0.124.0", "20261120100000", "old")).installed).toBe(false);
    expect((await t.install("0.123.0", "20261120120000", "older-release")).installed).toBe(false);
    expect(existsSync(join(t.home, "bin", "daemon", "moss-link"))).toBe(false);
  });

  test("generated installs: whatever order copies arrive in, the set that ends up is the newest one's, whole", async () => {
    // A seeded generator (no flake): 25 sequences of 6 copies drawn from releases and builds, some unstamped.
    let seed = 20261120;
    const rand = (k: number): number => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed % k; };
    const releases = ["0.123.0", "0.124.0", "0.125.0"];
    const builds: (string | undefined)[] = [undefined, "20261120090000", "20261120100000", "20261120110000"];
    for (let run = 0; run < 25; run++) {
      const t = installing();
      let best: { release: string; build: string | undefined; tag: string } | undefined;
      for (let i = 0; i < 6; i++) {
        const c = { release: releases[rand(releases.length)]!, build: builds[rand(builds.length)], tag: `r${run}c${i}` };
        const r = await t.install(c.release, c.build, c.tag);
        const newer = best === undefined || isNewerCopy({ release: c.release, ...(c.build ? { build: c.build } : {}), from: "" }, { release: best.release, ...(best.build ? { build: best.build } : {}), from: "" });
        expect(r.installed).toBe(newer);
        if (newer) best = c;
        // Whole after every step: all files of the one copy, none of another's.
        expect(tagsOf(t.home)).toEqual(Array(4).fill(best!.tag));
        expect(readEngineMarker(t.home)).toMatchObject({ release: best!.release, ...(best!.build ? { build: best!.build } : {}) });
      }
    }
  });
});

// `moss-core engine install` (src/update/engine-install-command.ts) against a temp home and a stand-in engine (a script that
// says which release it is): it places the running engine and its tree, only when newer, and says which binary to start.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runEngineInstall, runEngineReset } from "../../src/update/engine-install-command";
import { appRecordPath } from "../../src/update/release-home";
import { engineBinaryPath } from "../../src/update/engine-copy";
import { writeSidecars } from "./fixtures/sidecars";

const root = mkdtempSync(join(tmpdir(), "moss-rl-eic-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
let running = false;

function app(release: string): { exec: string; bundle: string } {
  const bundle = join(root, `app${n++}`);
  const resources = join(bundle, "resources");
  mkdirSync(join(resources, "daemon"), { recursive: true });
  mkdirSync(join(resources, "plugins", "p"), { recursive: true });
  const exec = join(resources, "daemon", "moss-core");
  writeFileSync(exec, `#!/bin/sh\necho "moss ${release}"\n`);
  chmodSync(exec, 0o755);
  writeSidecars(join(resources, "daemon"), release);
  writeFileSync(join(resources, "plugins", "p", "f"), release);
  return { exec, bundle };
}
async function run(home: string, a: { exec: string; bundle: string }, release: string, extra: string[] = [], over: { platform?: NodeJS.Platform; check?: (p: string, r: string) => boolean } = {}) {
  const out: string[] = [], err: string[] = [];
  const code = await runEngineInstall(["--app", a.bundle, ...extra], { home, execPath: a.exec, release, platform: over.platform ?? "linux", ...(over.check ? { check: over.check } : {}), engineRunning: async () => running, out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.map((l) => JSON.parse(l)), err };
}

describe("engine install", () => {
  test("places the running engine and its tree, and names the binary to start", async () => {
    const home = join(root, "h1");
    const a = app("1.0.0");
    const r = await run(home, a, "1.0.0", ["--build", "7"]);
    expect(r.code).toBe(0);
    expect(r.out[0]).toEqual({ installed: true, binary: engineBinaryPath(home), release: "1.0.0", build: "7" });
    expect(readFileSync(join(home, "bin", "plugins", "p", "f"), "utf8")).toBe("1.0.0");
  });

  test("a second app on the same release and build doesn't replace it; a newer one does; an older one only connects", async () => {
    const home = join(root, "h2");
    expect((await run(home, app("1.0.0"), "1.0.0", ["--build", "7"])).out[0].installed).toBe(true);
    expect((await run(home, app("1.0.0"), "1.0.0", ["--build", "7"])).out[0]).toMatchObject({ installed: false, release: "1.0.0", build: "7" });
    expect((await run(home, app("1.0.0"), "1.0.0", ["--build", "12"])).out[0]).toMatchObject({ installed: true, build: "12" });
    expect((await run(home, app("1.1.0"), "1.1.0")).out[0]).toMatchObject({ installed: true, release: "1.1.0" });
    expect((await run(home, app("1.0.0"), "1.0.0", ["--build", "99"])).out[0]).toMatchObject({ installed: false, release: "1.1.0" });
    expect(readFileSync(engineBinaryPath(home), "utf8")).toContain("moss 1.1.0");
  });

  test("the sidecars come with the engine; a bundle missing one is refused and places nothing; a same-build copy with one gone is placed again", async () => {
    const home = join(root, "h10");
    const a = app("1.0.0");
    expect((await run(home, a, "1.0.0", ["--build", "7"])).out[0]).toMatchObject({ installed: true });
    for (const f of ["moss-plugin-bun", "moss-link"]) expect(readFileSync(join(home, "bin", "daemon", f), "utf8")).toBe(`${f} 1.0.0\n`);
    expect((await run(home, a, "1.0.0", ["--build", "7"])).out[0]).toMatchObject({ installed: false });
    rmSync(join(home, "bin", "daemon", "moss-link"));
    expect((await run(home, a, "1.0.0", ["--build", "7"])).out[0]).toMatchObject({ installed: true, build: "7" });
    expect(readFileSync(join(home, "bin", "daemon", "moss-link"), "utf8")).toBe("moss-link 1.0.0\n");
    // A newer bundle that lacks one: refused (exit 1), and the installed set is as it was.
    const b = app("1.0.0");
    rmSync(join(dirname(b.exec), "moss-plugin-bun"));
    const r = await run(home, b, "1.0.0", ["--build", "8"]);
    expect(r.code).toBe(1);
    expect(r.err[0]).toContain("moss-plugin-bun is missing from the bundle");
    expect(readFileSync(join(home, "bin", "daemon", "moss-plugin-bun"), "utf8")).toBe("moss-plugin-bun 1.0.0\n");
    expect(JSON.parse(readFileSync(join(home, "bin", "engine.json"), "utf8")).build).toBe("7");
  });

  test("an engine that is already running is never swapped under: nothing is placed, and it says it was deferred", async () => {
    const home = join(root, "h5");
    await run(home, app("1.0.0"), "1.0.0");
    running = true;
    try {
      const r = await run(home, app("2.0.0"), "2.0.0");
      expect(r.out[0]).toMatchObject({ installed: false, deferred: true, release: "1.0.0" });
      expect(readFileSync(engineBinaryPath(home), "utf8")).toContain("moss 1.0.0");
      expect(readFileSync(join(home, "bin", "plugins", "p", "f"), "utf8")).toBe("1.0.0");
    } finally { running = false; }
  });

  test("an engine that doesn't say it is its release is never placed", async () => {
    const home = join(root, "h3");
    const a = app("1.0.0");
    const r = await run(home, a, "2.0.0");
    expect(r.code).toBe(1);
    expect(r.err[0]).toContain("not release 2.0.0");
    expect(existsSync(engineBinaryPath(home))).toBe(false);
  });

  test("running from the home's own copy installs nothing; bad arguments are refused", async () => {
    const home = join(root, "h4");
    await run(home, app("1.0.0"), "1.0.0");
    const own = { exec: engineBinaryPath(home), bundle: join(root, "x") };
    expect((await run(home, own, "1.0.0")).out[0]).toMatchObject({ installed: false });
    const out: string[] = [], err: string[] = [];
    expect(await runEngineInstall(["--app", "relative"], { home, out: (l) => out.push(l), err: (l) => err.push(l) })).toBe(2);
    expect(await runEngineInstall([], { home, out: (l) => out.push(l), err: (l) => err.push(l) })).toBe(2);
  });
});

describe("the home's engine is checked before the app starts it, and engine reset", () => {
  test("macOS: a home copy that doesn't meet the engine's code requirement is reported unsafe (the app starts its own), on a placement and on a deferred install", async () => {
    const asked: string[] = [];
    const home = join(root, "h6");
    const r = await run(home, app("1.0.0"), "1.0.0", [], { platform: "darwin", check: (p, req) => { asked.push(`${p}|${req}`); return false; } });
    // The staged check (before the swap) refused the unsigned copy, so nothing was placed at all.
    expect(r.code).toBe(1);
    // A copy that passes at staging but fails when the app is about to start it.
    const home2 = join(root, "h7");
    // (Staged files end in `.new`: the engine's and each sidecar's; the placed engine, which the app is about to start, doesn't.)
    const r2 = await run(home2, app("1.0.0"), "1.0.0", [], { platform: "darwin", check: (p) => p.endsWith(".new") });
    expect(r2.out[0]).toMatchObject({ installed: true, unsafe: true });
    running = true;
    try {
      const r3 = await run(home2, app("2.0.0"), "2.0.0", [], { platform: "darwin", check: () => false });
      expect(r3.out[0]).toMatchObject({ deferred: true, unsafe: true });
    } finally { running = false; }
    const r4 = await run(join(root, "h8"), app("1.0.0"), "1.0.0", [], { platform: "darwin", check: () => true });
    expect(r4.out[0].unsafe).toBeUndefined();
    expect(asked[0]).toContain("identifier");
  });

  test("engine reset takes out the engine, its sidecars, tree, marker and records, refuses while an engine answers, and touches nothing else", async () => {
    const home = join(root, "h9");
    await run(home, app("1.0.0"), "1.0.0");
    mkdirSync(join(home, "apps"), { recursive: true });
    writeFileSync(appRecordPath(home, "code"), "{}");
    mkdirSync(join(home, "conversations"), { recursive: true });
    writeFileSync(join(home, "conversations", "keep.txt"), "mine");
    mkdirSync(join(home, "bin", "daemon"), { recursive: true });
    writeFileSync(join(home, "bin", "daemon", "stranger"), "mine too");
    const out: string[] = [], err: string[] = [];
    expect(await runEngineReset({ home, platform: "linux", engineRunning: async () => true, out: (l) => out.push(l), err: (l) => err.push(l) })).toBe(1);
    expect(existsSync(engineBinaryPath(home))).toBe(true);
    expect(err[0]).toContain("MOSS is running");
    expect(await runEngineReset({ home, platform: "linux", engineRunning: async () => false, out: (l) => out.push(l), err: (l) => err.push(l) })).toBe(0);
    expect(existsSync(engineBinaryPath(home))).toBe(false);
    expect(existsSync(join(home, "bin", "plugins"))).toBe(false);
    expect(existsSync(join(home, "bin", "engine.json"))).toBe(false);
    expect(existsSync(appRecordPath(home, "code"))).toBe(false);
    expect(readFileSync(join(home, "conversations", "keep.txt"), "utf8")).toBe("mine");
    // The files an install places beside the engine go with it (`engineSidecars`); a file of the home's own stays.
    for (const f of ["moss-plugin-bun", "moss-link"]) expect(existsSync(join(home, "bin", "daemon", f))).toBe(false);
    expect(readFileSync(join(home, "bin", "daemon", "stranger"), "utf8")).toBe("mine too");
    expect(JSON.parse(out[0]!).reset).toBe(true);
    // The next app start installs its own.
    expect((await run(home, app("1.0.0"), "1.0.0")).out[0]).toMatchObject({ installed: true });
  });
});

describe("a build is digits only", () => {
  test("a marker whose build is not digits reads as a copy with no build, so a stamped copy replaces it", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { readEngineMarker, isNewerCopy } = await import("../../src/update/engine-copy");
    const home = mkdtempSync(join(tmpdir(), "moss-build-digits-"));
    mkdirSync(join(home, "bin"), { recursive: true });
    writeFileSync(join(home, "bin", "engine.json"), JSON.stringify({ release: "1.2.3", build: "dev", from: "/Applications/MOSS.app" }));
    const marker = readEngineMarker(home);
    expect(marker).toEqual({ release: "1.2.3", from: "/Applications/MOSS.app" });
    expect(isNewerCopy({ release: "1.2.3", build: "20261121000000", from: "/x" }, marker)).toBe(true);
  });
});

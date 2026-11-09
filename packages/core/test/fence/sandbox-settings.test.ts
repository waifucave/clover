// `sandboxSettingsOf`: the fence's policy as the agent runtime's own sandbox settings, under the controller's ruling
// that a deny always wins over an allow: the runner's own folders are carved out of the home's deny by listing the
// home's entries minus the way to them, never by an allow inside a deny; and no allow re-opens a fenced kind
// (sessions/, the secrets, run/) inside an allowed folder.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMandatoryFloorProfile } from "@waifucave/clover-agent-sdk";
import { CloverFence } from "../../src/fence/fence";
import { KEPT_FOLDER_PIN, sandboxSettingsOf } from "../../src/fence/sandbox-settings";
import { darwinDescribe } from "../helpers/darwin-only";

const HOME = "/home/me";
const CLOVER = `${HOME}/.clover`;
const BOT = { sessionId: "s1", memoryOf: "luna" };

/** A fake disk: each folder's entries. */
const disk: Record<string, string[]> = {
  [HOME]: [".clover", "project", ".zshrc"],
  [CLOVER]: ["bots", "scratch", "outputs", "routines", "sessions", "transcripts", "run", "secrets.enc", "secrets.key", "settings.json", "plugins", "credentials", "sessions-runtime"],
  [`${CLOVER}/bots`]: ["luna", "sol"],
  [`${CLOVER}/bots/luna`]: ["memory", "agents"],
  [`${CLOVER}/bots/sol`]: ["memory", "agents"],
  [`${CLOVER}/scratch`]: ["luna", "sol"],
  [`${CLOVER}/outputs`]: ["s1", "s2", "c1"],
  [`${CLOVER}/routines`]: ["luna", "sol"],
};
const list = (dir: string) => disk[dir] ?? [];
const policyFor = (ctx: object) => new CloverFence({ os: "linux", home: HOME, cloverHome: CLOVER, temp: "/tmp", canonical: (p) => p }).policy(ctx);
const under = (p: string, root: string) => p === root || p.startsWith(`${root}/`);

/** Writable under the runtime's rules: inside an allowed root and under no deny (a deny always wins; globs as the
 *  runtime renders them, `*` one name and `**` any depth). */
const globRx = (g: string) => new RegExp(`^${g.split("/").map((s) => (s === "**" ? "(?:.*)" : s.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, "[^/]*"))).join("/").replace("/(?:.*)/", "/(?:.*/)?")}(/.*)?$`);
const covered = (path: string, d: string) => (d.includes("*") ? globRx(d).test(path) : under(path, d));
const writable = (fs: { allowWrite?: string[]; denyWrite?: string[] }, path: string) =>
  fs.allowWrite!.some((a) => under(path, a)) && !fs.denyWrite!.some((d) => covered(path, d));
const readable = (fs: { denyRead?: string[] }, path: string) => !fs.denyRead!.some((d) => covered(path, d));
/** The settings' denies as the SDK's Seatbelt floor takes them: plain paths and globs apart. */
const floorOf = (fs: { denyRead?: string[]; denyWrite?: string[] }) => ({
  denyReadPaths: fs.denyRead!.filter((d) => !d.includes("*")), denyReadGlobs: fs.denyRead!.filter((d) => d.includes("*")),
  denyWritePaths: fs.denyWrite!.filter((d) => !d.includes("*")), denyWriteGlobs: fs.denyWrite!.filter((d) => d.includes("*")),
});

describe("sandboxSettingsOf", () => {
  test("a bot: the home reads but what escalates; every bot's scratch and memory write; never an allow inside a deny", () => {
    const fs = sandboxSettingsOf(policyFor(BOT), CLOVER, { list }).filesystem!;
    // Reads: no home deny; the escalation by name, there or not.
    expect(fs.denyRead).not.toContain(CLOVER);
    for (const d of ["run", "secrets.enc", "secrets.key", "secrets.key.cred", "credentials", "plugin-data", "runtimes", "cache/runs", "sdk/.clover.json", "sdk/settings.json", "browser"]) {
      expect([d, fs.denyRead!.includes(`${CLOVER}/${d}`)]).toEqual([d, true]);
    }
    expect(readable(fs, `${CLOVER}/sessions-runtime/s1.json`)).toBe(true);
    // The provider-state sidecars by glob; the transcript beside one stays readable.
    for (const f of [`${CLOVER}/projects/k/s1.provider-state.jsonl`, `${CLOVER}/sdk/projects/k/s1.provider-state.jsonl`]) expect([f, readable(fs, f)]).toEqual([f, false]);
    expect(readable(fs, `${CLOVER}/projects/k/s1.jsonl`)).toBe(true);
    expect(readable(fs, `${CLOVER}/browser/profiles/p1/Default/Cookies`)).toBe(false);
    // Writes: the home is out of the allow list; what the bot keeps is in it by name.
    expect(fs.denyWrite).not.toContain(CLOVER);
    expect(fs.allowWrite).not.toContain(HOME);
    for (const d of ["sessions/s1.json", "transcripts/luna/s1.ndjson", "run/app.token", "secrets.enc", "settings.json", "plugins/x", "bots/luna/agents/t.json", "bots/sol/agents/t.json", "outputs/s2/r.md", "outputs/c1/r.md", "routines/sol/r.md", "credentials/x", "browser/x"]) {
      expect([d, writable(fs, `${CLOVER}/${d}`)]).toEqual([d, false]);
    }
    for (const k of ["scratch/luna", "scratch/sol", "bots/luna/memory", "bots/sol/memory", "outputs/s1", "routines/luna"]) {
      expect([k, writable(fs, `${CLOVER}/${k}/n.md`)]).toEqual([k, true]);
      expect(fs.allowWrite).toContain(`${CLOVER}/${k}`);
    }
    // The user's home outside the Clover home stays writable, its own entries listed (one level, never the sessions).
    expect(writable(fs, `${HOME}/project/a.txt`)).toBe(true);
    // The ruling: no allow sits inside a deny.
    for (const a of fs.allowWrite!) expect([a, fs.denyWrite!.some((d) => !d.includes("*") && under(a, d) && a !== d)]).toEqual([a, false]);
  });

  test("the named fenced items are denied when they aren't on the disk yet", () => {
    const fs = sandboxSettingsOf(policyFor(BOT), CLOVER, { list: () => [] }).filesystem!;
    for (const d of ["credentials", "runtimes", "sdk/.clover.json", "sdk/settings.json", "cache/runs", "secrets.enc", "secrets.key", "secrets.key.cred", "browser", "plugin-data", "run"]) {
      expect([d, fs.denyRead!.includes(`${CLOVER}/${d}`), fs.denyWrite!.includes(`${CLOVER}/${d}`)]).toEqual([d, true, true]);
    }
    const coding = sandboxSettingsOf(policyFor({ sessionId: "c1" }), CLOVER, { list: () => [] }).filesystem!;
    for (const d of ["credentials", "secrets.enc", "browser", "plugin-data"]) expect([d, coding.denyWrite!.includes(`${CLOVER}/${d}`)]).toEqual([d, true]);
  });

  test("the settings stay small at 10k sessions: other sessions' outputs are never listed (#356's review)", () => {
    const many: Record<string, string[]> = { ...disk, [`${CLOVER}/outputs`]: Array.from({ length: 10_000 }, (_, i) => `s${i}`) };
    const fs = sandboxSettingsOf(policyFor(BOT), CLOVER, { list: (d) => many[d] ?? [] }).filesystem!;
    const all = [...fs.allowWrite!, ...fs.denyWrite!, ...fs.denyRead!];
    expect(all.filter((x) => x.startsWith(`${CLOVER}/outputs/`) && !x.startsWith(`${CLOVER}/outputs/s1/`) && x !== `${CLOVER}/outputs/s1`)).toEqual([]);
    expect(writable(fs, `${CLOVER}/outputs/s9999/r.md`)).toBe(false);
    expect(writable(fs, `${CLOVER}/outputs/s1/r.md`)).toBe(true);
    expect(JSON.stringify(fs).length).toBeLessThan(8_000);
    // And as a Seatbelt profile (what goes through sandbox-exec's argv, 1 MB at most): the same size as with 3 sessions.
    const small = buildMandatoryFloorProfile(floorOf(sandboxSettingsOf(policyFor(BOT), CLOVER, { list }).filesystem!)).length;
    const big = buildMandatoryFloorProfile(floorOf(fs)).length;
    expect(big).toBeLessThan(64_000);
    expect(Math.abs(big - small)).toBeLessThan(200);
    // The same for a runner that isn't a bot: its reads deny outputs/ whole.
    const coding = sandboxSettingsOf(policyFor({ sessionId: "s1" }), CLOVER, { list: (d) => many[d] ?? [] }).filesystem!;
    expect(JSON.stringify(coding).length).toBeLessThan(8_000);
    expect(coding.denyRead).toContain(`${CLOVER}/outputs`);
  });

  test("a kept folder's own entry is held: a write-deny inside it, so the runtime's ancestor fence denies removing or replacing it", () => {
    const fs = sandboxSettingsOf(policyFor(BOT), CLOVER, { list }).filesystem!;
    for (const k of ["scratch/luna", "scratch/sol", "bots/luna/memory", "bots/sol/memory", "outputs/s1", "routines/luna"]) {
      expect([k, fs.denyWrite!.includes(`${CLOVER}/${k}/${KEPT_FOLDER_PIN}`)]).toEqual([k, true]);
    }
  });

  test("no .git/hooks anywhere under a write root, nor a bare repo's", () => {
    const fs = sandboxSettingsOf(policyFor(BOT), CLOVER, { list }).filesystem!;
    for (const f of [`${HOME}/project/.git/hooks/pre-commit`, `${HOME}/.git/hooks/x`, `${HOME}/a/b/repo.git/hooks/x`, `${CLOVER}/scratch/sol/r/.git/hooks/post-checkout`, "/tmp/r/.git/hooks/x"]) {
      expect([f, writable(fs, f)]).toEqual([f, false]);
    }
    expect(writable(fs, `${HOME}/project/.git/config.bak`)).toBe(true);
    expect(writable(fs, `${CLOVER}/scratch/sol/r/hooks/x`)).toBe(true);
  });

  test("an allow can't re-open a fenced kind: an allowed folder holding sessions/, the secrets and run/ keeps them denied", () => {
    // A runner's own folder widened to the whole Clover home on purpose.
    const fs = sandboxSettingsOf({ ...policyFor(BOT), ownScratch: CLOVER }, CLOVER, { list }).filesystem!;
    expect(fs.allowWrite).toContain(CLOVER);
    for (const d of ["sessions", "transcripts", "run", "secrets.enc", "secrets.key", "settings.json", "credentials", "browser"]) expect([d, writable(fs, `${CLOVER}/${d}/x`)]).toEqual([d, false]);
    for (const d of ["run", "secrets.enc", "secrets.key"]) expect(fs.denyRead).toContain(`${CLOVER}/${d}`);
  });

  test("a coding session: the home's deny written out but for its own outputs; another bot's or session's folders denied", () => {
    const fs = sandboxSettingsOf(policyFor({ sessionId: "c1" }), CLOVER, { list }).filesystem!;
    expect(fs.denyWrite).not.toContain(CLOVER);
    expect(writable(fs, `${CLOVER}/outputs/c1/r.md`)).toBe(true);
    for (const d of ["outputs/s1", "outputs/s2", "bots", "scratch", "sessions", "run", "settings.json"]) {
      expect([d, writable(fs, `${CLOVER}/${d}/x`), readable(fs, `${CLOVER}/${d}/x`)]).toEqual([d, false, false]);
    }
    // The memory pattern stays for a runner that isn't a bot.
    expect(fs.denyRead).toContain(`${CLOVER}/bots/*/memory`);
  });

  test("an agent keeps nothing: the whole home denied as one entry", () => {
    const fs = sandboxSettingsOf(policyFor({}), CLOVER, { list }).filesystem!;
    expect(fs.denyRead).toContain(CLOVER);
    expect(fs.denyWrite).toContain(CLOVER);
  });
});

// The settings rendered by the agent SDK's own Seatbelt builder, run for real: a deny wins.
darwinDescribe("sandboxSettingsOf, live under the agent SDK's Seatbelt profile", () => {
  test("a bot writes any bot's scratch and memory; sessions/ and run/ stay denied, inside an allowed home too", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "lane-c-ss-")));
    const clover = join(home, ".clover");
    for (const d of ["bots/luna/memory", "bots/sol/memory", "bots/sol/agents", "scratch/luna", "scratch/sol", "sessions", "run"]) mkdirSync(join(clover, d), { recursive: true });
    writeFileSync(join(clover, "run", "app.token"), "tok");
    const policy = new CloverFence({ os: "macos", home, cloverHome: clover, temp: join(home, "tmp") }).policy(BOT);
    for (const p of [policy, { ...policy, ownScratch: clover }]) {
      const fs = sandboxSettingsOf(p, clover).filesystem!;
      const profile = buildMandatoryFloorProfile(floorOf(fs));
      const sh = (script: string, ...args: string[]) => spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/sh", "-c", script, "sh", ...args], { encoding: "utf8" });
      expect(sh('printf x > "$1"', join(clover, "scratch", "sol", "n.md")).status).toBe(0);
      expect(sh('printf x > "$1"', join(clover, "bots", "sol", "memory", "n.md")).status).toBe(0);
      // Another bot's folder outside its memory is the home's deny, which the widened folder (the second pass) lifts.
      if (p === policy) expect(sh('printf x > "$1"', join(clover, "bots", "sol", "agents", "n.json")).status).not.toBe(0);
      expect(sh('printf x > "$1"', join(clover, "sessions", "forged.json")).status).not.toBe(0);
      expect(existsSync(join(clover, "sessions", "forged.json"))).toBe(false);
      expect(sh('cat "$1"', join(clover, "run", "app.token")).stdout).not.toContain("tok");
      expect(readFileSync(join(clover, "scratch", "sol", "n.md"), "utf8")).toBe("x");
      // A kept folder's own entry is held: it can't be removed or moved away and replaced.
      if (p === policy) {
        expect(sh('mv "$1" "$2"', join(clover, "scratch", "sol"), join(clover, "scratch", "sol2")).status).not.toBe(0);
        expect(sh('rm -rf "$1"', join(clover, "bots", "sol", "memory")).status).not.toBe(0);
        expect(existsSync(join(clover, "scratch", "sol"))).toBe(true);
        expect(existsSync(join(clover, "bots", "sol", "memory"))).toBe(true);
      }
      // (The `.git/hooks` glob isn't run here: the SDK's floor renders `**` as `(?:.*/)?`, which Seatbelt never matches.
      // The runtime's own settings path renders it `(.*/)?`; the unit cases above check what the settings say.)
    }
  });
});

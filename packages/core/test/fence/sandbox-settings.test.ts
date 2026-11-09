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
import { sandboxSettingsOf } from "../../src/fence/sandbox-settings";
import { darwinDescribe } from "../helpers/darwin-only";

const HOME = "/home/me";
const CLOVER = `${HOME}/.clover`;
const BOT = { sessionId: "s1", memoryOf: "luna" };

/** A fake disk: each folder's entries. */
const disk: Record<string, string[]> = {
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

describe("sandboxSettingsOf", () => {
  test("a bot: the home reads but what escalates; every bot's scratch and memory write; never an allow inside a deny", () => {
    const fs = sandboxSettingsOf(policyFor(BOT), CLOVER, { list }).filesystem!;
    // Reads: no home deny; the escalation by name.
    expect(fs.denyRead).not.toContain(CLOVER);
    for (const d of ["run", "secrets.enc", "secrets.key", "credentials", "plugin-data", "runtimes", "cache/runs", "sdk/.clover.json"]) expect(fs.denyRead).toContain(`${CLOVER}/${d}`);
    expect(fs.denyRead).not.toContain(`${CLOVER}/sessions-runtime`);
    // Writes: the home written out entry by entry, the way to every bot's scratch and memory left open.
    expect(fs.denyWrite).not.toContain(CLOVER);
    for (const d of ["sessions", "transcripts", "run", "secrets.enc", "settings.json", "plugins", "bots/luna/agents", "bots/sol/agents", "outputs/s2", "outputs/c1", "routines/sol"]) {
      expect([d, fs.denyWrite!.includes(`${CLOVER}/${d}`)]).toEqual([d, true]);
    }
    for (const k of ["scratch/luna", "scratch/sol", "bots/luna/memory", "bots/sol/memory", "outputs/s1", "routines/luna"]) {
      expect([k, fs.denyWrite!.some((d) => under(`${CLOVER}/${k}`, d))]).toEqual([k, false]);
      expect(fs.allowWrite).toContain(`${CLOVER}/${k}`);
    }
    // No glob that would cover a kept memory.
    expect(fs.denyWrite!.some((d) => d.includes("*"))).toBe(false);
    // The ruling: no allow sits inside a deny.
    for (const a of fs.allowWrite!) expect([a, fs.denyWrite!.some((d) => under(a, d) && a !== d)]).toEqual([a, false]);
  });

  test("an allow can't re-open a fenced kind: an allowed folder holding sessions/, the secrets and run/ keeps them denied", () => {
    // A runner's own folder widened to the whole Clover home on purpose.
    const fs = sandboxSettingsOf({ ...policyFor(BOT), ownScratch: CLOVER }, CLOVER, { list }).filesystem!;
    expect(fs.allowWrite).toContain(CLOVER);
    for (const d of ["sessions", "transcripts", "run", "secrets.enc", "secrets.key", "settings.json"]) expect(fs.denyWrite).toContain(`${CLOVER}/${d}`);
    for (const d of ["run", "secrets.enc", "secrets.key"]) expect(fs.denyRead).toContain(`${CLOVER}/${d}`);
  });

  test("a coding session: the home's deny written out but for its own outputs; another bot's or session's folders denied", () => {
    const fs = sandboxSettingsOf(policyFor({ sessionId: "c1" }), CLOVER, { list }).filesystem!;
    for (const deny of [fs.denyRead!, fs.denyWrite!]) {
      expect(deny).not.toContain(CLOVER);
      expect(deny.some((d) => under(`${CLOVER}/outputs/c1`, d))).toBe(false);
      for (const d of ["outputs/s1", "outputs/s2", "bots", "scratch", "sessions", "run", "settings.json"]) expect([d, deny.includes(`${CLOVER}/${d}`)]).toEqual([d, true]);
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
      const profile = buildMandatoryFloorProfile({ denyReadPaths: fs.denyRead ?? [], denyWritePaths: fs.denyWrite ?? [] });
      const sh = (script: string, ...args: string[]) => spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/sh", "-c", script, "sh", ...args], { encoding: "utf8" });
      expect(sh('printf x > "$1"', join(clover, "scratch", "sol", "n.md")).status).toBe(0);
      expect(sh('printf x > "$1"', join(clover, "bots", "sol", "memory", "n.md")).status).toBe(0);
      // Another bot's folder outside its memory is the home's deny, which the widened folder (the second pass) lifts.
      if (p === policy) expect(sh('printf x > "$1"', join(clover, "bots", "sol", "agents", "n.json")).status).not.toBe(0);
      expect(sh('printf x > "$1"', join(clover, "sessions", "forged.json")).status).not.toBe(0);
      expect(existsSync(join(clover, "sessions", "forged.json"))).toBe(false);
      expect(sh('cat "$1"', join(clover, "run", "app.token")).stdout).not.toContain("tok");
      expect(readFileSync(join(clover, "scratch", "sol", "n.md"), "utf8")).toBe("x");
    }
  });
});

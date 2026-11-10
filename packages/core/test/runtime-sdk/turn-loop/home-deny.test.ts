// The Clover home's read denial for a runner's Bash (`homeDenyRead`): every name in a folder on the way to a kept one,
// but the kept names, denied by pattern (bounded, and live for names made later), plus the names that matter.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_COPY_FILES, homeDenyRead, homeNamedDenials, LITERAL_MAX, namesOtherThan, patternsOtherThan } from "../../../src/runtime-sdk/turn-loop/home-deny";
import { RUN_FOLDER_CONFIG_FILES } from "../../../src/runtime-sdk/mode-options";
import { deniedBy } from "../../helpers/sandbox-glob";

const temps: string[] = [];
afterAll(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });
const temp = (prefix: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(d);
  return d;
};

describe("namesOtherThan: every name in a folder but the kept ones, listed as they are at each build", () => {
  for (const platform of ["linux", "darwin"] as const) {
    test(`on ${platform}: the kept name and what is in it are readable; every other name there is denied; one made later at the next build`, () => {
      const dir = temp("clover-names-");
      const there = ["s_ab12", "s_ab13", "s_ab1", "s_a", "s", "s_ab12x", "s_ab12.bak", "t_ab12", "0", "Z", "_x", ".hidden", "-dash", "s_ab12-1", "x", "☃snow"];
      for (const n of there) mkdirSync(join(dir, n));
      const list = namesOtherThan(dir, ["s_ab12"], platform);
      const denied = (name: string, l = list) => deniedBy(l, join(dir, name), platform);
      for (const name of ["s_ab12", "s_ab12/inner/x.md"]) expect([name, denied(name)]).toEqual([name, false]);
      for (const name of there.filter((n) => n !== "s_ab12")) expect([name, denied(name)]).toEqual([name, true]);
      expect(denied("s_ab12-1/x")).toBe(true);
      // Literal paths only: no glob for the runtime to turn into a Seatbelt regex (#347's merge-queue slowness).
      expect(list.filter((e) => /[*?[]/.test(e.slice(dir.length)))).toEqual([]);
      // A name made after the build is readable until the next build, which denies it.
      mkdirSync(join(dir, "s_later"));
      expect(denied("s_later")).toBe(false);
      expect(denied("s_later", namesOtherThan(dir, ["s_ab12"], platform))).toBe(true);
    });
  }

  test("names fold on a Mac: another case of the kept name is the kept name there, and another name on Linux", () => {
    const dir = temp("clover-names-case-");
    mkdirSync(join(dir, "S_AB12"));
    expect(namesOtherThan(dir, ["s_ab12"], "darwin")).toEqual([]);
    expect(namesOtherThan(dir, ["s_ab12"], "linux")).toEqual([join(dir, "S_AB12")]);
  });

  test("bounded: past LITERAL_MAX names a folder falls back to the pattern form, bounded by the kept names", () => {
    const dir = temp("clover-names-many-");
    for (let i = 0; i < 500; i++) mkdirSync(join(dir, `s_${i.toString(16).padStart(12, "0")}`));
    expect(namesOtherThan(dir, ["s_0123456789ab"], "linux")).toHaveLength(500);
    expect(LITERAL_MAX).toBeGreaterThanOrEqual(1000);
    const fallback = namesOtherThan(dir, ["s_0123456789ab"], "linux", 100);
    expect(fallback).toEqual(patternsOtherThan(dir, ["s_0123456789ab"], "linux"));
    expect(fallback.length).toBeLessThan(4 * "s_0123456789ab".length + 5);
    for (const n of ["s_000000000001", "s_later"]) expect([n, deniedBy(fallback, join(dir, n), "linux")]).toEqual([n, true]);
    expect(deniedBy(fallback, join(dir, "s_0123456789ab", "x"), "linux")).toBe(false);
  });

  test("the pattern form lists a name that leaves the kept ones at a letter no pattern spells", () => {
    const dir = temp("clover-names-odd-");
    for (const n of ["☃snow", "s_a☃", "s_ab12☃", "plain"]) mkdirSync(join(dir, n));
    const list = patternsOtherThan(dir, ["s_ab12"], "linux");
    expect(list).toContain(join(dir, "☃snow"));
    expect(list).toContain(join(dir, "s_a☃"));
    expect(list).not.toContain(join(dir, "s_ab12☃"));
    expect(list).not.toContain(join(dir, "plain"));
    for (const n of ["☃snow", "s_a☃", "s_ab12☃", "plain"]) expect([n, deniedBy(list, join(dir, n), "linux")]).toEqual([n, true]);
  });
});

describe("homeDenyRead", () => {
  test("kept folders, the way to them walked name by name, an `only` folder inside a kept one, extra denies", () => {
    const h = temp("clover-home-deny-");
    for (const d of ["sessions", "outputs/s_1", "outputs/s_2", "sdk/projects/-p/memory", "sdk/projects/-q", "bots/a/memory", "sdk/skills/a"]) mkdirSync(join(h, d), { recursive: true });
    const list = homeDenyRead({
      home: h, platform: "linux",
      keep: [join(h, "sdk"), join(h, "outputs", "s_1")],
      only: [{ parent: join(h, "sdk", "projects"), names: ["-p"] }],
      deny: [`${h}/sdk/x.json`],
    });
    const denied = (p: string) => deniedBy(list, join(h, p), "linux");
    for (const p of ["sdk/skills/a", "sdk/projects/-p/memory/M.md", "outputs/s_1/r.md"]) expect([p, denied(p)]).toEqual([p, false]);
    for (const p of ["sessions/x", "secrets.enc", "secrets.key.cred", "run/core.sock", "outputs/s_2", "sdk/projects/-q/t.jsonl", "sdk/x.json", "bots/a/memory"]) {
      expect([p, denied(p)]).toEqual([p, true]);
    }
  });

  test("the names that matter are the fenced set's on this OS, and the secret store's files on every OS", () => {
    const h = temp("clover-home-named-");
    for (const p of [...homeNamedDenials(h, "macos"), ...homeNamedDenials(h, "linux")]) expect(p.startsWith(`${h}/`)).toBe(true);
    for (const os of ["macos", "linux"] as const) {
      for (const n of ["sessions", "sessions-runtime", "run", "credentials", "secrets.enc", "secrets.key", "secrets.key.cred"]) expect(homeNamedDenials(h, os)).toContain(join(h, n));
    }
  });

  test("the config copies' names are the run folders' (one list)", () => {
    expect([...RUN_FOLDER_CONFIG_FILES]).toEqual([...CONFIG_COPY_FILES]);
  });
});

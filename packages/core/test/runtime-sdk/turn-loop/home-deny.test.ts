// The Clover home's read denial for a runner's Bash (`homeDenyRead`): every name in a folder on the way to a kept one,
// but the kept names, denied by pattern (bounded, and live for names made later), plus the names that matter.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { botPaths } from "../../../src/bots/paths";
import { botHomeSandbox } from "../../../src/runtime-sdk/turn-loop/driver";
import { CONFIG_COPY_FILES, homeDenyRead, homeNamedDenials, namesOtherThan } from "../../../src/runtime-sdk/turn-loop/home-deny";
import { RUN_FOLDER_CONFIG_FILES } from "../../../src/runtime-sdk/mode-options";
import type { BotSessionContext } from "../../../src/bots/service";
import { deniedBy } from "../../helpers/sandbox-glob";

const temps: string[] = [];
afterAll(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });
const temp = (prefix: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(d);
  return d;
};

describe("namesOtherThan: every name in a folder but the kept ones, by pattern", () => {
  for (const platform of ["linux", "darwin"] as const) {
    test(`on ${platform}: the kept name and what is in it are readable; every other name is denied, made before or after`, () => {
      const dir = temp("clover-names-");
      const list = namesOtherThan(dir, ["s_ab12"], platform);
      const denied = (name: string) => deniedBy(list, join(dir, name), platform);
      for (const name of ["s_ab12", "s_ab12/inner/x.md"]) expect([name, denied(name)]).toEqual([name, false]);
      for (const name of ["s_ab13", "s_ab1", "s_a", "s", "s_ab12x", "s_ab12.bak", "t_ab12", "0", "Z", "_x", ".hidden", "-dash", "s_ab12-1/x", "x/y"]) {
        expect([name, denied(name)]).toEqual([name, true]);
      }
      // Another case: a different folder on Linux; the same one on a Mac, where names fold.
      expect(denied("S_AB12")).toBe(platform === "linux");
    });
  }

  test("bounded by the kept names, whatever the folder holds", () => {
    const dir = temp("clover-names-many-");
    const before = namesOtherThan(dir, ["s_0123456789ab"], "linux").length;
    for (let i = 0; i < 500; i++) mkdirSync(join(dir, `s_${i.toString(16).padStart(12, "0")}`));
    expect(namesOtherThan(dir, ["s_0123456789ab"], "linux").length).toBe(before);
    expect(before).toBeLessThan(4 * "s_0123456789ab".length + 5);
  });

  test("a name that leaves the kept ones at a letter no pattern spells is listed as it is", () => {
    const dir = temp("clover-names-odd-");
    for (const n of ["☃snow", "s_a☃", "s_ab12☃", "plain"]) mkdirSync(join(dir, n));
    const list = namesOtherThan(dir, ["s_ab12"], "linux");
    expect(list).toContain(join(dir, "☃snow"));
    expect(list).toContain(join(dir, "s_a☃"));
    // Covered by a pattern already: past a kept name (`s_ab12?*`), or in the alphabet.
    expect(list).not.toContain(join(dir, "s_ab12☃"));
    expect(list).not.toContain(join(dir, "plain"));
    for (const n of ["☃snow", "s_a☃", "s_ab12☃", "plain"]) expect([n, deniedBy(list, join(dir, n), "linux")]).toEqual([n, true]);
  });
});

describe("homeDenyRead", () => {
  test("kept folders, the way to them walked by pattern, an `only` folder inside a kept one, extra denies", () => {
    const h = temp("clover-home-deny-");
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

describe("a bot's Bash (botHomeSandbox, what the daemon passes): the owner's ruling of November 9, amended", () => {
  const ctx = (h: string, bot = "pack/luna") => ({
    paths: botPaths(h, bot),
    caller: { kind: "session", sessionId: "b_luna", sessionKind: "bot", bot },
  }) as unknown as BotSessionContext;
  const sandbox = (h: string) => {
    const fs = botHomeSandbox(h)(ctx(h)).filesystem!;
    return {
      reads: (p: string) => !deniedBy(fs.denyRead ?? [], join(h, p)),
      writes: (p: string) => deniedBy(fs.allowWrite ?? [], join(h, p)) && !deniedBy(fs.denyWrite ?? [], join(h, p)),
      fs,
    };
  };

  test("it reads the whole Clover home: every bot's memory, scratch and conversations, the coding sessions' too", () => {
    const h = temp("clover-bot-read-");
    const { reads } = sandbox(h);
    for (const p of ["bots/pack--mira/memory/MEMORY.md", "bots/pack--mira/agents/a_1/acp.ndjson", "scratch/pack--mira/x", "transcripts/pack--mira/b_mira.ndjson",
      "transcripts/_/s_1.ndjson", "sessions/s_1.jsonl", "outputs/s_1/r.md", "sdk/projects/-p/t.jsonl", "routines/pack--mira/r.md", "settings.json", "plugins/x/clover.json", "cache/views/v/SKILL.md", "sdk/skills/a/SKILL.md"]) {
      expect([p, reads(p)]).toEqual([p, true]);
    }
  });

  test("never the escalation list: secrets, the run folder, the config copies that carry keys, the credential index, plugin data", () => {
    const h = temp("clover-bot-escalation-");
    const { reads } = sandbox(h);
    for (const p of ["secrets.enc", "secrets.key", "secrets.key.cred", "run/app.token", "run/core.sock", "cache/runs/r1/.clover.json", "cache/runs/r1/.claude.json",
      "cache/runs/r1/.credentials.json", "cache/runs/r1/backups/.claude.json.backup.1", "cache/runs/r1/settings.json", "sdk/.clover.json", "credentials/index.json",
      "plugin-data/tarot/token.json", "runtimes/bin/winter", "sessions-runtime/b_luna.json", "bots/pack--mira/memory/.clover.json"]) {
      expect([p, reads(p)]).toEqual([p, false]);
    }
    const fs = botHomeSandbox(h)(ctx(h)).filesystem!;
    expect(deniedBy(fs.denyRead ?? [], join(tmpdir(), "claude-resume-1234", ".credentials.json"))).toBe(true);
    expect(deniedBy(fs.denyRead ?? [], join(tmpdir(), "claude-resume-1234", "projects", "k", "s", "tool-results", "1.txt"))).toBe(false);
  });

  test("it writes any bot's scratch and memory, its own routines and outputs; never a permission, trust, settings or plugin file", () => {
    const h = temp("clover-bot-write-");
    const { writes } = sandbox(h);
    for (const p of ["scratch/pack--luna/x", "scratch/pack--mira/x", "bots/pack--mira/memory/note.md", "bots/pack--luna/memory/MEMORY.md", "routines/pack--luna/r.md", "outputs/b_luna/r.md"]) {
      expect([p, writes(p)]).toEqual([p, true]);
    }
    for (const p of ["settings.json", "settings/x.json", "sdk/settings.json", "trust.json", "trust/x", "rules/x.json", "levels/x", "connectors/x", "plugins/x/clover.json",
      "plugins-state/oks/x", "plugins-state/installed.json", "run/app.token", "secrets.enc", "bots/pack--mira/agents/a_1/acp.ndjson", "bots/pack--mira/bot.json",
      "routines/pack--mira/r.md", "outputs/s_9/r.md", "transcripts/pack--mira/b.ndjson", "user-layers/pack--luna.json", "sdk/plugins/x", "cache/runs/r1/x"]) {
      expect([p, writes(p)]).toEqual([p, false]);
    }
  });
});

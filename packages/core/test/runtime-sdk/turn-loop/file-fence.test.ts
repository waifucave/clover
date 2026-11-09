// A bot's own file tools against the Clover home (`fileToolFenceRefusal` over lane C's fence, `botFileFence`). The
// fence decides what a bot reaches in the home; these tests hold only what every ruling keeps: its own folders are
// its own, files that carry keys are never read by any path, and settings, trust and plugin files are never written.
// Every path is judged as it really is, links and `..` included.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloverFence } from "../../../src/fence/fence";
import { botPaths } from "../../../src/bots/paths";
import { botFileFence } from "../../../src/runtime-sdk/turn-loop/driver";
import * as fenceContract from "../../../src/contracts/fence";
import { BOT_KEY_PATHS, fenceSearchOutput, fileToolFenceRefusal } from "../../../src/runtime-sdk/turn-loop/file-fence";
import type { BotSessionContext } from "../../../src/bots/service";

const temps: string[] = [];
afterAll(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });

function setup() {
  const user = realpathSync(mkdtempSync(join(tmpdir(), "clover-file-fence-")));
  temps.push(user);
  const home = join(user, ".clover");
  const paths = botPaths(home, "pack/luna");
  for (const d of [paths.memory, paths.scratch, join(home, "routines", "pack--luna"), join(home, "outputs", "b_luna"), join(home, "cache", "runs", "r1", "backups"), join(home, "run")]) {
    mkdirSync(d, { recursive: true });
  }
  writeFileSync(join(home, "secrets.enc"), "x");
  writeFileSync(join(home, "cache", "runs", "r1", ".clover.json"), "{}");
  // Links from the bot's own folders to files that carry keys.
  symlinkSync(join(home, "secrets.enc"), join(paths.scratch, "keys"));
  symlinkSync(join(home, "run"), join(paths.root, "run-link"));
  symlinkSync(join(home, "cache", "runs", "r1"), join(paths.scratch, "run-folder"));
  const ctx = { paths, caller: { kind: "session", sessionId: "b_luna", sessionKind: "bot", bot: "pack/luna" } } as unknown as BotSessionContext;
  const fence = botFileFence(new CloverFence({ home: user, cloverHome: home, temp: join(user, "tmp") }), home)(ctx);
  const refused = (name: string, input: Record<string, unknown>) => fileToolFenceRefusal(name, input, fence, paths.scratch);
  return { home, paths, refused };
}

describe("a bot's file tools meet the Clover home through lane C's fence", () => {
  test("its own memory, scratch, routines and outputs are its own", () => {
    const { home, paths, refused } = setup();
    for (const f of [join(paths.memory, "MEMORY.md"), join(paths.scratch, "x"), join(home, "routines", "pack--luna", "r.md"), join(home, "outputs", "b_luna", "r.md"), "./x"]) {
      expect([f, refused("Read", { file_path: f })]).toEqual([f, undefined]);
      expect([f, refused("Write", { file_path: f, content: "x" })]).toEqual([f, undefined]);
    }
    expect(refused("Grep", { pattern: "x", path: paths.scratch })).toBeUndefined();
    expect(refused("Glob", { pattern: `${paths.memory}/**/*.md` })).toBeUndefined();
  });

  test("never a file that carries keys, by any path: written out, relative, or through a link in its own folder", () => {
    const { home, paths, refused } = setup();
    for (const f of [join(home, "secrets.enc"), join(home, "secrets.key.cred"), join(home, "run", "app.token"), join(home, "cache", "runs", "r1", ".clover.json"),
      join(home, "cache", "runs", "r1", "backups", "b.json"), join(home, "sdk", ".clover.json"), join(home, "credentials", "index.json"),
      join(paths.scratch, "keys"), join(paths.root, "run-link", "app.token"), join(paths.scratch, "run-folder", ".clover.json"), "../../secrets.enc"]) {
      expect([f, refused("Read", { file_path: f }) !== undefined]).toEqual([f, true]);
    }
    expect(refused("Grep", { pattern: "x", path: join(home, "run") })).toBeDefined();
    expect(refused("Glob", { pattern: `${home}/run/*` })).toBeDefined();
    expect(refused("Glob", { pattern: "../../run/*" })).toBeDefined();
  });

  test("never a settings, trust, rules or plugin file written", () => {
    const { home, refused } = setup();
    for (const f of [join(home, "settings.json"), join(home, "sdk", "settings.json"), join(home, "trust.json"), join(home, "rules", "r.json"), join(home, "plugins", "p", "clover.json"),
      join(home, "plugins-state", "oks", "x"), join(home, "run", "x"), join(home, "routines", "pack--mira", "r.md"), "../../settings.json"]) {
      expect([f, refused("Edit", { file_path: f, old_string: "a", new_string: "b" }) !== undefined]).toEqual([f, true]);
    }
  });

  test("a pattern's `..` is judged like a path's, and one past a wildcard is refused", () => {
    const { refused } = setup();
    expect(refused("Glob", { pattern: "../../secrets.enc" })).toBeDefined();
    expect(refused("Grep", { pattern: "x", glob: "../../run/**" })).toBeDefined();
    expect(refused("Glob", { pattern: "*/../../../run/*" })).toContain("after a wildcard");
    expect(refused("Grep", { pattern: "x", glob: "**/../../run/*" })).toContain("after a wildcard");
    expect(refused("Glob", { pattern: "./**/*.md" })).toBeUndefined();
  });

  test("other tools aren't judged here", () => {
    const { home, refused } = setup();
    expect(refused("Bash", { command: `cat ${home}/secrets.enc` })).toBeUndefined();
  });
});

describe("files that carry keys are refused even where the fence lets a read through", () => {
  const open = (home: string) => ({ check: () => ({ allowed: true }) as never, home });
  test("the secrets files, the run folder, the credential index and the config copies, in the home and a staging root", () => {
    const home = "/u/.clover";
    for (const f of [`${home}/secrets.enc`, `${home}/run/core.sock`, `${home}/credentials/i.json`, `${home}/cache/runs/r/.claude.json`, `${home}/x/y/.credentials.json`,
      join(tmpdir(), "claude-resume-1/.clover.json"), join(tmpdir(), "claude-resume-1/backups/b")]) {
      expect([f, fileToolFenceRefusal("Read", { file_path: f }, open(home), "/")]).toEqual([f, expect.stringContaining("holds secrets or keys")]);
    }
    for (const f of [`${home}/runtimes/console/x`, `${home}/plugin-data/tarot/t.json`, `${home}/cache/runs/r/settings.json`, `${home}/browser/profile/Cookies`,
      `${home}/sdk/projects/-p/s.provider-state.jsonl`, `${home}/projects/-p/sub/s.provider-state.jsonl`]) {
      expect([f, fileToolFenceRefusal("Read", { file_path: f }, open(home), "/")]).toEqual([f, expect.stringContaining("holds secrets or keys")]);
    }
    for (const f of [`${home}/settings.json`, `${home}/bots/a/memory/M.md`, `${home}/sdk/projects/-p/s.jsonl`, `${home}/scratch/b/x.provider-state.jsonl`, `${home}/cache/views/v/SKILL.md`,
      join(tmpdir(), "claude-resume-1/projects/k/s.jsonl")]) {
      expect([f, fileToolFenceRefusal("Read", { file_path: f }, open(home), "/")]).toEqual([f, undefined]);
    }
  });
});

describe("the bots' key list (BOT_KEY_PATHS) is lane C's BOT_READ_DENIED", () => {
  test("equal to the fence's list once contracts/fence.ts exports it; till then, the list as #355 has it with browser/", () => {
    const sorted = (l: readonly (readonly string[])[]) => l.map((r) => r.join("/")).sort();
    const theirs = (fenceContract as Record<string, unknown>)["BOT_READ_DENIED"] as readonly (readonly string[])[] | undefined;
    expect(sorted(BOT_KEY_PATHS)).toEqual(theirs !== undefined ? sorted(theirs) : ["browser", "cache/runs", "credentials", "plugin-data", "runtimes", "sdk/.clover.json"]);
  });
});

describe("a search's hits through a link out of the bot's folders are dropped (fenceSearchOutput)", () => {
  function linked() {
    const user = realpathSync(mkdtempSync(join(tmpdir(), "clover-file-fence-hits-")));
    temps.push(user);
    const home = join(user, ".clover");
    const scratch = join(home, "scratch", "pack--luna");
    mkdirSync(scratch, { recursive: true });
    mkdirSync(join(home, "run"), { recursive: true });
    writeFileSync(join(home, "run", "app.token"), "SECRET");
    writeFileSync(join(scratch, "notes.txt"), "mine");
    symlinkSync(join(home, "run", "app.token"), join(scratch, "tok"));
    symlinkSync(join(home, "run"), join(scratch, "rundir"));
    // A fence that lets everything through: the hits are dropped by what they really are.
    return { home, scratch, fence: { check: () => ({ allowed: true }) as never, home } };
  }

  test("Glob: a link to a file in run/ and a path through a link to run/ are dropped; the bot's own file stays", () => {
    const { scratch, fence } = linked();
    const out = [join(scratch, "notes.txt"), join(scratch, "tok"), join(scratch, "rundir", "app.token"), "", "[Truncated to 100 of 103 total matches]"].join("\n");
    expect(fenceSearchOutput("Glob", out, fence, scratch)).toBe([join(scratch, "notes.txt"), "", "[Truncated to 100 of 103 total matches]"].join("\n"));
    expect(fenceSearchOutput("Glob", join(scratch, "notes.txt"), fence, scratch)).toBeUndefined();
  });

  test("Grep: files, counts and content rows through the links are dropped", () => {
    const { scratch, fence } = linked();
    const tok = join(scratch, "tok");
    const viaDir = join(scratch, "rundir", "app.token");
    const own = join(scratch, "notes.txt");
    const files = JSON.parse(fenceSearchOutput("Grep", JSON.stringify({ mode: "files_with_matches", files: [own, tok, viaDir], truncated: false }), fence, scratch)!);
    expect(files.files).toEqual([own]);
    const counts = JSON.parse(fenceSearchOutput("Grep", JSON.stringify({ mode: "count", counts: { [own]: 1, [tok]: 1, [viaDir]: 2 } }), fence, scratch)!);
    expect(counts.counts).toEqual({ [own]: 1 });
    const content = fenceSearchOutput("Grep", JSON.stringify({ mode: "content", content: [{ file: own, text: "mine" }, { file: tok, text: "SECRET" }, { file: viaDir, text: "SECRET" }] }), fence, scratch)!;
    expect(content).not.toContain("SECRET");
    expect(JSON.parse(content).content).toEqual([{ file: own, text: "mine" }]);
    expect(fenceSearchOutput("Grep", JSON.stringify({ mode: "files_with_matches", files: [own] }), fence, scratch)).toBeUndefined();
  });

  test("a hit the fence refuses is dropped too, and other tools' output is left alone", () => {
    const { home, scratch } = linked();
    const fence = { check: (op: { path: string }) => ({ allowed: !op.path.includes("notes") }) as never, home };
    expect(fenceSearchOutput("Glob", join(scratch, "notes.txt"), fence, scratch)).toBe("");
    expect(fenceSearchOutput("Read", "SECRET", fence, scratch)).toBeUndefined();
  });
});

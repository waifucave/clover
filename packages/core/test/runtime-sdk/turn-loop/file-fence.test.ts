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
import { fileToolFenceRefusal } from "../../../src/runtime-sdk/turn-loop/file-fence";
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
    for (const f of [`${home}/settings.json`, `${home}/bots/a/memory/M.md`, join(tmpdir(), "claude-resume-1/projects/k/s.jsonl")]) {
      expect([f, fileToolFenceRefusal("Read", { file_path: f }, open(home), "/")]).toEqual([f, undefined]);
    }
  });
});

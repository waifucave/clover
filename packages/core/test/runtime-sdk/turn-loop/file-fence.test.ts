// A bot's own file tools against the Clover home (`fileToolFenceRefusal` over lane C's fence, `botFileFence`), by the
// owner's ruling of November 9, amended: a bot reads the whole home but the escalation list, writes any bot's scratch
// and memory and its own routines and outputs, and never a permission, trust, settings or plugin file. Every path is
// judged as it really is, links and `..` included.
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
  for (const d of [paths.memory, paths.scratch, join(home, "sessions"), join(home, "transcripts", "_"), join(home, "transcripts", "pack--mira"), join(home, "bots", "pack--mira", "memory"),
    join(home, "scratch", "pack--mira"), join(home, "routines", "pack--luna"), join(home, "outputs", "s_1"), join(home, "cache", "runs", "r1", "backups"), join(home, "run"), join(user, "project")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(home, "sessions", "s_1.jsonl"), "{}\n");
  writeFileSync(join(home, "secrets.enc"), "x");
  writeFileSync(join(home, "cache", "runs", "r1", ".clover.json"), "{}");
  // Links from the bot's own folders into the home: to a session's log (readable) and to the secrets file (not).
  symlinkSync(join(home, "sessions", "s_1.jsonl"), join(paths.scratch, "log.jsonl"));
  symlinkSync(join(home, "secrets.enc"), join(paths.scratch, "keys"));
  symlinkSync(join(home, "run"), join(paths.root, "run-link"));
  const ctx = { paths, caller: { kind: "session", sessionId: "b_luna", sessionKind: "bot", bot: "pack/luna" } } as unknown as BotSessionContext;
  const fence = botFileFence(new CloverFence({ home: user, cloverHome: home, temp: join(user, "tmp") }), home)(ctx);
  const refused = (name: string, input: Record<string, unknown>) => fileToolFenceRefusal(name, input, fence, paths.scratch);
  return { user, home, paths, refused };
}

describe("a bot's file tools meet the Clover home as the owner's ruling sets it", () => {
  test("it reads the whole home: another bot's memory, scratch and conversations, the coding sessions' logs and outputs", () => {
    const { home, paths, refused } = setup();
    for (const f of [join(home, "bots", "pack--mira", "memory", "MEMORY.md"), join(home, "scratch", "pack--mira", "x"), join(home, "transcripts", "pack--mira", "b.ndjson"),
      join(home, "transcripts", "_", "s_1.ndjson"), join(home, "sessions", "s_1.jsonl"), join(home, "outputs", "s_1", "r.md"), join(home, "settings.json"), join(paths.scratch, "log.jsonl")]) {
      expect([f, refused("Read", { file_path: f })]).toEqual([f, undefined]);
    }
    expect(refused("Grep", { pattern: "x", path: home })).toBeUndefined();
    expect(refused("Glob", { pattern: `${home}/bots/**/*.md` })).toBeUndefined();
    expect(refused("Read", { file_path: "../../sessions/s_1.jsonl" })).toBeUndefined();
  });

  test("never the escalation list: the secrets file, the run folder, the config copies that carry keys, by any path", () => {
    const { home, paths, refused } = setup();
    for (const f of [join(home, "secrets.enc"), join(home, "secrets.key.cred"), join(home, "run", "app.token"), join(home, "cache", "runs", "r1", ".clover.json"),
      join(home, "cache", "runs", "r1", "backups", "b.json"), join(home, "sdk", ".clover.json"), join(home, "credentials", "index.json"), join(home, "plugin-data", "tarot", "t.json"),
      join(paths.scratch, "keys"), join(paths.root, "run-link", "app.token"), "../../secrets.enc",
      join(home, "cache", "runs", "r1", "settings.json"), join(home, "runtimes", "bin", "winter"), join(home, "sessions-runtime", "b_luna.json")]) {
      expect([f, refused("Read", { file_path: f }) !== undefined]).toEqual([f, true]);
    }
    expect(refused("Grep", { pattern: "x", path: join(home, "run") })).toBeDefined();
    expect(refused("Glob", { pattern: `${home}/run/*` })).toBeDefined();
    expect(refused("Glob", { pattern: "../../run/*" })).toBeDefined();
  });

  test("it writes any bot's scratch and memory and its own routines and outputs; never a permission, trust, settings or plugin file", () => {
    const { home, paths, refused } = setup();
    for (const f of [join(home, "bots", "pack--mira", "memory", "note.md"), join(paths.memory, "MEMORY.md"), join(home, "scratch", "pack--mira", "x"), join(paths.scratch, "x"),
      join(home, "routines", "pack--luna", "r.md"), join(home, "outputs", "b_luna", "r.md")]) {
      expect([f, refused("Write", { file_path: f, content: "x" })]).toEqual([f, undefined]);
    }
    for (const f of [join(home, "settings.json"), join(home, "sdk", "settings.json"), join(home, "trust.json"), join(home, "rules", "r.json"), join(home, "plugins", "p", "clover.json"),
      join(home, "plugins-state", "oks", "x"), join(home, "run", "x"), join(home, "bots", "pack--mira", "agents", "a.json"), join(home, "routines", "pack--mira", "r.md"),
      join(home, "transcripts", "pack--mira", "b.ndjson"), "../../settings.json"]) {
      expect([f, refused("Edit", { file_path: f, old_string: "a", new_string: "b" }) !== undefined]).toEqual([f, true]);
    }
  });

  test("a pattern's `..` is judged like a path's, and one past a wildcard is refused", () => {
    const { refused } = setup();
    expect(refused("Glob", { pattern: "../../secrets.enc" })).toBeDefined();
    expect(refused("Grep", { pattern: "x", glob: "../../run/**" })).toBeDefined();
    expect(refused("Glob", { pattern: "*/../../../run/*" })).toContain("after a wildcard");
    expect(refused("Grep", { pattern: "x", glob: "**/../../run/*" })).toContain("after a wildcard");
    expect(refused("Glob", { pattern: "../pack--mira/*.md" })).toBeUndefined(); // another bot's scratch: readable
  });

  test("other tools aren't judged here", () => {
    const { home, refused } = setup();
    expect(refused("Bash", { command: `cat ${home}/secrets.enc` })).toBeUndefined();
  });
});

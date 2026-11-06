// Carrying Winter's routines and its `_assistant` memories over to Alpha (spec §12): each routine a paused file for
// review, the memories copied, Winter's own files untouched, and only once.
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { botPaths } from "../../bots/paths";
import { ALPHA_FOLDER, boot, pluginFromFolder, removeTemps, tempDir } from "../../bots/tests/fixtures";
import { migrateWinter } from "../migrate-winter";

afterEach(() => removeTemps());

describe("Winter's routines and memories, carried over", () => {
  function winterHome(): string {
    const home = tempDir();
    const db = new Database(join(home, "routines.db"));
    db.run(`CREATE TABLE routines (id TEXT PRIMARY KEY, spec TEXT NOT NULL, prompt TEXT NOT NULL, policy TEXT NOT NULL, cwd TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1, lastRunAt INTEGER, nextRunAt INTEGER NOT NULL, createdAt INTEGER NOT NULL, lastResult TEXT, deferAttempts INTEGER NOT NULL DEFAULT 0)`);
    const add = db.prepare("INSERT INTO routines (id, spec, prompt, policy, cwd, enabled, nextRunAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, 0, ?)");
    add.run("rt_1", "0 9 * * 1-5", "Check my email\nand summarize it.", "ask", "/Users/someone/work", 1, 1);
    add.run("rt_2", "every 30m", "Watch the build.", "bypass", "/Users/someone/app", 0, 2);
    add.run("rt_3", "not a schedule", "Broken.", "ask", "/", 1, 3);
    db.close();
    const mem = join(home, "sdk", "projects", "_assistant", "memory");
    mkdirSync(mem, { recursive: true });
    writeFileSync(join(mem, "MEMORY.md"), "- [likes tea](likes-tea.md)\n");
    writeFileSync(join(mem, "likes-tea.md"), "The user likes green tea.\n");
    return home;
  }
  const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

  test("each routine becomes a paused file for review; memories are copied into Alpha's; Winter's files are untouched; once only", async () => {
    const winter = winterHome();
    const before = hash(join(winter, "routines.db"));
    const clover = tempDir();
    const result = migrateWinter({ winterHome: winter, cloverHome: clover });
    expect(result.routines.map((r) => r.winterId)).toEqual(["rt_1", "rt_2"]);
    expect(result.skipped).toMatchObject([{ winterId: "rt_3" }]);
    expect(result.memories).toBe(2);
    const files = readdirSync(join(clover, "routines", "alpha")).sort();
    expect(files).toEqual(["winter-check-my-email.md", "winter-watch-the-build.md"]);
    const first = readFileSync(join(clover, "routines", "alpha", "winter-check-my-email.md"), "utf8");
    expect(first).toContain("paused: true");
    expect(first).toContain("schedule: \"0 9 * * 1-5\"");
    expect(first).toContain("level: ask");
    expect(first).toContain("Carried over from Winter (its routine rt_1). It ran in `/Users/someone/work`.");
    expect(readFileSync(join(clover, "routines", "alpha", "winter-watch-the-build.md"), "utf8")).toContain("which was switched off there");
    expect(readFileSync(join(botPaths(clover, "alpha").memory, "likes-tea.md"), "utf8")).toBe("The user likes green tea.\n");
    expect(hash(join(winter, "routines.db"))).toBe(before);
    // Again: nothing new, nothing written twice, no memory overwritten.
    writeFileSync(join(botPaths(clover, "alpha").memory, "likes-tea.md"), "Edited by Alpha.\n");
    const again = migrateWinter({ winterHome: winter, cloverHome: clover });
    expect(again.routines).toEqual([]);
    expect(readFileSync(join(botPaths(clover, "alpha").memory, "likes-tea.md"), "utf8")).toBe("Edited by Alpha.\n");
    // The engine loads them paused.
    const b = await boot({ home: clover, plugins: (await pluginFromFolder(ALPHA_FOLDER, { bundled: true })).inputs, routines: { watchFiles: false } });
    expect(b.side.routines!.list().map((v) => v.state)).toEqual(["paused", "paused"]);
    await b.shutdown();
  });

  test("a Winter home with neither routines nor memories carries nothing", () => {
    const result = migrateWinter({ winterHome: tempDir(), cloverHome: tempDir() });
    expect(result).toEqual({ routines: [], skipped: [], memories: 0 });
    expect(existsSync(join(tempDir(), "routines"))).toBe(false);
  });
});

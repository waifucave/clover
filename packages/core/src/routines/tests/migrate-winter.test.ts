// Carrying Winter's routines and its `_assistant` memories over to Alpha (spec §12): each routine a paused file for
// review, the memories copied, Winter's own files untouched, and only once.
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { botPaths } from "../../bots/paths";
import { ALPHA_FOLDER, boot, pluginFromFolder, removeTemps, tempDir } from "../../bots/tests/fixtures";
import { migrateWinter } from "../migrate-winter";

afterEach(() => removeTemps());

describe("Winter's routines and memories, carried over", () => {
  function winterHome(): string {
    const home = tempDir();
    const db = new Database(join(home, "routines.db"));
    // Winter's RoutineStore keeps its database in WAL mode.
    db.exec("PRAGMA journal_mode = WAL");
    db.run(`CREATE TABLE routines (id TEXT PRIMARY KEY, spec TEXT NOT NULL, prompt TEXT NOT NULL, policy TEXT NOT NULL, cwd TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1, lastRunAt INTEGER, nextRunAt INTEGER NOT NULL, createdAt INTEGER NOT NULL, lastResult TEXT, deferAttempts INTEGER NOT NULL DEFAULT 0)`);
    const add = db.prepare("INSERT INTO routines (id, spec, prompt, policy, cwd, enabled, nextRunAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, 0, ?)");
    add.run("rt_1", "0 9 * * 1-5", "Check my email\nand summarize it.", "ask", "/Users/someone/work", 1, 1);
    add.run("rt_2", "every 30m", "Watch the build.", "bypass", "/Users/someone/app", 0, 2);
    add.run("rt_3", "not a schedule", "Broken.", "ask", "/", 1, 3);
    add.finalize();
    db.close(true);
    // Closed and checkpointed. macOS's SQLite keeps an empty -wal and the -shm after a close; with them removed, the
    // test sees that the migration creates neither.
    for (const f of ["routines.db-wal", "routines.db-shm"]) rmSync(join(home, f), { force: true });
    const mem = join(home, "sdk", "projects", "_assistant", "memory");
    mkdirSync(mem, { recursive: true });
    writeFileSync(join(mem, "MEMORY.md"), "- [likes tea](likes-tea.md)\n");
    writeFileSync(join(mem, "likes-tea.md"), "The user likes green tea.\n");
    return home;
  }
  const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  /** Every file under Winter's home: its name, size, modified time and hash. */
  const snapshot = (root: string): string[] => {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir).sort()) {
        const full = join(dir, name);
        const st = lstatSync(full);
        if (st.isDirectory()) walk(full);
        else out.push(`${relative(root, full)} ${st.size} ${st.mtimeMs} ${hash(full)}`);
      }
    };
    walk(root);
    return out;
  };

  test("each routine becomes a paused file for review; memories are copied into Alpha's; Winter's files are untouched; once only", async () => {
    const winter = winterHome();
    const before = snapshot(winter);
    expect(before.some((f) => /-(shm|wal) /.test(f))).toBe(false);
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
    // Not one byte, time or name in Winter's home changed, and SQLite left no -shm or -wal there.
    expect(snapshot(winter)).toEqual(before);
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

  test("a routine only in Winter's -wal is carried over, and Winter's -wal and -shm are left exactly as they were", async () => {
    const winter = winterHome();
    // Winter running: its connection open, a routine written to the -wal and not yet checkpointed.
    const live = new Database(join(winter, "routines.db"));
    live.exec("PRAGMA wal_autocheckpoint = 0");
    live.run("INSERT INTO routines (id, spec, prompt, policy, cwd, enabled, nextRunAt, createdAt) VALUES ('rt_9', 'every 1h', 'Only in the log.', 'ask', '/', 1, 0, 9)");
    try {
      const before = snapshot(winter);
      expect(before.some((f) => f.startsWith("routines.db-wal "))).toBe(true);
      const result = migrateWinter({ winterHome: winter, cloverHome: tempDir(), memories: false });
      expect(result.routines.map((r) => r.winterId)).toContain("rt_9");
      expect(snapshot(winter)).toEqual(before);
    } finally {
      live.close();
    }
  });

  test("a Winter home with neither routines nor memories carries nothing", () => {
    const result = migrateWinter({ winterHome: tempDir(), cloverHome: tempDir() });
    expect(result).toEqual({ routines: [], skipped: [], memories: 0 });
    expect(existsSync(join(tempDir(), "routines"))).toBe(false);
  });
});

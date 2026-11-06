// The fence review: a bot's runner can leave a link in its own folders pointing at another bot's data. The core reads
// a bot's memory index, its routine files and starter memories without ever following one.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeClock, flush } from "../../contracts/fakes/clock";
import { RoutineEngine, routineFilePath } from "../../routines/engine";
import { seedMemory } from "../memory";
import { readOwnFile } from "../own-file";
import { botPaths } from "../paths";
import { memoryBlock, readMemoryIndex } from "../prompt";
import { removeTemps, tempDir } from "./fixtures";

afterEach(() => removeTemps());

const SECRET = "Luna's secret: the vault code is 4711.";

function twoBots() {
  const home = tempDir();
  const alpha = botPaths(home, "alpha");
  const luna = botPaths(home, "luna");
  for (const p of [alpha, luna]) mkdirSync(p.memory, { recursive: true });
  writeFileSync(join(luna.memory, "MEMORY.md"), `${SECRET}\n`);
  return { home, alpha, luna };
}

describe("links a bot planted are never followed", () => {
  test("a link at alpha's MEMORY.md to luna's: alpha's prompt never shows it", () => {
    const { alpha, luna } = twoBots();
    symlinkSync(join(luna.memory, "MEMORY.md"), join(alpha.memory, "MEMORY.md"));
    expect(readMemoryIndex(alpha)).toBeUndefined();
    const block = memoryBlock({ paths: alpha, computer: "Studio" });
    expect(block).not.toContain("4711");
    expect(block).toContain("MEMORY.md is empty so far.");
  });

  test("alpha's memory folder swapped for a link to luna's: still nothing of luna's", () => {
    const { alpha, luna } = twoBots();
    renameSync(alpha.memory, `${alpha.memory}-old`);
    symlinkSync(luna.memory, alpha.memory);
    expect(readMemoryIndex(alpha)).toBeUndefined();
    expect(memoryBlock({ paths: alpha, computer: "Studio" })).not.toContain("4711");
    // Luna's own index reads as it should.
    expect(readMemoryIndex(luna)?.text).toBe(`${SECRET}\n`);
  });

  test("readOwnFile refuses a link at the name, a link on the way, and a second name", () => {
    const { home, alpha, luna } = twoBots();
    const target = join(luna.memory, "MEMORY.md");
    symlinkSync(target, join(alpha.memory, "link.md"));
    expect(readOwnFile(home, join(alpha.memory, "link.md"), { maxBytes: 1000 })).toEqual({ ok: false, why: "link" });
    symlinkSync(luna.memory, join(alpha.memory, "folder"));
    expect(readOwnFile(home, join(alpha.memory, "folder", "MEMORY.md"), { maxBytes: 1000 })).toEqual({ ok: false, why: "link" });
    expect(readOwnFile(home, target, { maxBytes: 1000 })).toMatchObject({ ok: true });
    expect(readOwnFile(home, "/etc/hosts", { maxBytes: 1000 })).toEqual({ ok: false, why: "moved" });
  });

  test("a routine file, or alpha's routines folder, linked to luna's is never loaded as alpha's", async () => {
    const { home } = twoBots();
    const lunaRoutine = routineFilePath(home, "luna", "vault");
    mkdirSync(join(lunaRoutine, ".."), { recursive: true });
    writeFileSync(lunaRoutine, `---\nid: r_vault001\ntriggers: []\n---\n${SECRET}\n`);
    const alphaDir = join(lunaRoutine, "..", "..", "alpha");
    mkdirSync(alphaDir, { recursive: true });
    symlinkSync(lunaRoutine, join(alphaDir, "stolen.md"));
    const warnings: string[] = [];
    const engine = new RoutineEngine({
      home, computer: "Studio", clock: new FakeClock(), computerLevel: () => "ask-risky", watchFiles: false, userTimeZone: () => "UTC",
      bots: { has: () => true, runSideThread: async () => { throw new Error("no runs here"); } },
      warn: (m) => warnings.push(m),
    });
    await engine.start();
    await flush();
    expect(engine.list("alpha")).toEqual([]);
    expect(engine.list("luna").map((v) => v.id)).toEqual(["r_vault001"]);
    engine.stop();
  });

  test("starter memories (Winter's _assistant ones included) never copy a link to another bot's memory", () => {
    const { home, alpha, luna } = twoBots();
    const from = join(tempDir(), "winter-memory");
    mkdirSync(from, { recursive: true });
    writeFileSync(join(from, "likes-tea.md"), "Green tea.\n");
    symlinkSync(join(luna.memory, "MEMORY.md"), join(from, "MEMORY.md"));
    symlinkSync(luna.memory, join(from, "luna"));
    const copied = seedMemory(from, alpha.memory, { base: home });
    expect(copied).toBe(1);
    expect(readFileSync(join(alpha.memory, "likes-tea.md"), "utf8")).toBe("Green tea.\n");
    expect(() => readFileSync(join(alpha.memory, "MEMORY.md"), "utf8")).toThrow();
    expect(() => readFileSync(join(alpha.memory, "luna", "MEMORY.md"), "utf8")).toThrow();
  });
});

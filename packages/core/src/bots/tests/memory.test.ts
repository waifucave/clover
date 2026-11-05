// A bot's starter memories (../memory.ts): the core copies them outside the fence, so it must never write through a
// link the bot planted in its memory, whether a link to a file not there yet or a linked folder.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listMemory, readMemory, seedMemory } from "../memory";
import { removeTemps, tempDir } from "./fixtures";

afterEach(removeTemps);

function setup() {
  const home = tempDir();
  const seed = join(home, "plugins", "alpha", "bot", "memory");
  mkdirSync(join(seed, "people"), { recursive: true });
  // The bot edited its own plugin's seed (§6.1 allows it): it holds a user layer now.
  writeFileSync(join(seed, "notes.md"), JSON.stringify({ userLayer: 1, bot: "alpha", fields: { model: "attacker/model" } }));
  writeFileSync(join(seed, "people", "sam.md"), "Sam likes trains.");
  const memory = join(home, "bots", "alpha", "memory");
  const fenced = join(home, "user-layers");
  mkdirSync(fenced, { recursive: true });
  return { home, seed, memory, fenced };
}

describe("seeding a bot's memory", () => {
  test("copies its files once, and never over the bot's own", () => {
    const { home, seed, memory } = setup();
    expect(seedMemory(seed, memory, { base: home })).toBe(2);
    writeFileSync(join(memory, "notes.md"), "mine now");
    expect(seedMemory(seed, memory, { base: home })).toBe(0);
    expect(readFileSync(join(memory, "notes.md"), "utf8")).toBe("mine now");
    expect(listMemory(memory).map((e) => e.path)).toEqual(["notes.md", "people/sam.md"]);
  });

  test("never writes through a link to a file that isn't there yet", () => {
    const { home, seed, memory, fenced } = setup();
    mkdirSync(memory, { recursive: true });
    const target = join(fenced, "alpha.json");
    symlinkSync(target, join(memory, "notes.md"));
    const warnings: string[] = [];
    expect(seedMemory(seed, memory, { base: home, warn: (m) => warnings.push(m) })).toBe(1);
    expect(existsSync(target)).toBe(false);
  });

  test("never enters a linked folder, in the memory or on the way to it", () => {
    const { home, seed, memory, fenced } = setup();
    mkdirSync(memory, { recursive: true });
    symlinkSync(fenced, join(memory, "people"));
    const warnings: string[] = [];
    expect(seedMemory(seed, memory, { base: home, warn: (m) => warnings.push(m) })).toBe(1);
    expect(existsSync(join(fenced, "sam.md"))).toBe(false);
    expect(warnings.join("\n")).toContain("is a link or not a folder");

    // The bot's whole folder swapped for a link: nothing is copied.
    const other = setup();
    mkdirSync(join(other.home, "bots"), { recursive: true });
    symlinkSync(other.fenced, join(other.home, "bots", "alpha"));
    const said: string[] = [];
    expect(seedMemory(other.seed, other.memory, { base: other.home, warn: (m) => said.push(m) })).toBe(0);
    expect(existsSync(join(other.fenced, "memory"))).toBe(false);
    expect(said.join("\n")).toContain("weren't copied");
  });

  test("reads only inside the memory folder", () => {
    const { home, seed, memory, fenced } = setup();
    seedMemory(seed, memory, { base: home });
    writeFileSync(join(fenced, "alpha.json"), "{}");
    symlinkSync(join(fenced, "alpha.json"), join(memory, "escape.md"));
    expect(() => readMemory(memory, "../../../user-layers/alpha.json")).toThrow("isn't a path inside");
    expect(() => readMemory(memory, "escape.md")).toThrow("leads out of");
    expect(readMemory(memory, "people/sam.md")).toBe("Sam likes trains.");
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { EMPTY_STAGE, readStage } from "../../client/stage-doc";

describe("the stage document her components read", () => {
  test("a version 1 document is taken as it is, trimmed to the shape the stage writes", () => {
    const s = readStage({
      v: 1, scene: "starry", mood: "joy", outfit: { hat: true }, expression: "blush", nonce: 4,
      pinned: [{ id: "a", text: "tram 28" }, { id: 3 }, "no"], activity: { kind: "tool", label: "Read notes.md" }, tally: { turns: 2, tools: 5, day: "2026-11-11" },
    });
    expect(s).toEqual({
      v: 1, expression: "blush", scene: "starry", mood: "joy", outfit: { hat: true }, activity: { kind: "tool", label: "Read notes.md" },
      pinned: [{ id: "a", text: "tram 28" }], tally: { turns: 2, tools: 5, day: "2026-11-11" }, nonce: 4, celebrations: 0,
    });
  });

  test("the celebrations count: a whole number from the document, else 0", () => {
    const at = (celebrations: unknown) => readStage({ v: 1, scene: "meadow", nonce: 1, celebrations })!.celebrations;
    expect(at(3)).toBe(3);
    for (const bad of [undefined, -1, 1.5, "3", Number.MAX_SAFE_INTEGER + 2, null]) expect(at(bad)).toBe(0);
  });

  test("anything else is refused: another version, a missing scene, not an object; an unknown mood is calm", () => {
    expect(readStage(null)).toBeUndefined();
    expect(readStage({ v: 2, scene: "meadow" })).toBeUndefined();
    expect(readStage({ v: 1 })).toBeUndefined();
    expect(readStage({ v: 1, scene: "meadow", mood: "furious" })?.mood).toBe("calm");
    expect(EMPTY_STAGE.pinned).toEqual([]);
  });
});

describe("the backdrop", () => {
  test("it has no private channel to the figure: the stage reaches it through the public avatar calls, from her server", () => {
    const src = readFileSync(join(import.meta.dir, "../../client/backdrop.tsx"), "utf8");
    expect(src).not.toContain("clover.avatar");
    expect(src).not.toContain("postMessage");
    expect(src).not.toContain("ancestorOrigins");
    expect(src).not.toContain('"*"');
  });
});

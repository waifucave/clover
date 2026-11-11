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
      pinned: [{ id: "a", text: "tram 28" }], tally: { turns: 2, tools: 5, day: "2026-11-11" }, nonce: 4,
    });
  });

  test("anything else is refused: another version, a missing scene, not an object; an unknown mood is calm", () => {
    expect(readStage(null)).toBeUndefined();
    expect(readStage({ v: 2, scene: "meadow" })).toBeUndefined();
    expect(readStage({ v: 1 })).toBeUndefined();
    expect(readStage({ v: 1, scene: "meadow", mood: "furious" })?.mood).toBe("calm");
    expect(EMPTY_STAGE.pinned).toEqual([]);
  });
});

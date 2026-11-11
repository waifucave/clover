// The one cleaner for text a page shows that a file, a plugin or a model wrote: what it drops, and that its call sites
// (the core's tool display and avatar credit note, the desktop door, the bot editor) share it instead of copying it.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { displayText, MARKS_MAX } from "../src/plain-text";

const REPO = join(import.meta.dir, "..", "..", "..");

describe("displayText", () => {
  test("drops control, bidi, zero-width, variation-selector and tag characters; collapses space; keeps at most MARKS_MAX marks", () => {
    expect(displayText("a‮b​c️d\u{e0041}e\u0007 f\n\n g", 100)).toBe("abcde f g");
    const stack = "e" + "́".repeat(20);
    expect(displayText(stack, 100)).toBe("e" + "́".repeat(MARKS_MAX));
    expect(displayText("x".repeat(500), 300)?.length).toBe(300);
    expect(displayText("‮​", 10)).toBeUndefined();
    expect(displayText(5, 10)).toBeUndefined();
  });
});

describe("its call sites share it", () => {
  const sites = [
    "packages/core/src/runtime-sdk/tool-display.ts",
    "packages/core/src/bots/user-layer.ts",
    "apps/desktop/src/main/ui/tree-calls.ts",
    "plugins/clover/plugins/bot-editor/client/entry.tsx",
    // A spot entry's title, as the sidebar, the title bar and Settings show it (`fieldText`, their one door).
    "plugins/clover/plugins/shell/runtime/views.ts",
  ];
  test("each imports the cleaner from the SDK's plain subpath and carries no copy of its character classes", () => {
    for (const site of sites) {
      const text = readFileSync(join(REPO, site), "utf8");
      expect([site, /from "@waifucave\/clover-plugin-sdk\/plain"/.test(text)]).toEqual([site, true]);
      expect([site, /\\u200b-\\u200f|\\u202a-\\u202e|\\ufff9/.test(text)]).toEqual([site, false]);
    }
  });
});

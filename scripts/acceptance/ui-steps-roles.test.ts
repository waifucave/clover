// The window steps' own calls to the core (ui-steps.ts) go on the run's connection, which is the app's role from source
// and the CLI's on a packaged core (run.ts `appDriver`). A call the CLI's role may not make is refused there before
// dispatch, so a step that waits on one passes from source and fails packaged (row 29's `plugin.ui` wait did). Each call
// must be one the CLI may make, or a best-effort one listed here, caught, whose refusal changes nothing the step checks.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CLOVER_METHODS, allowedMethods } from "../../packages/protocol/src/index";

/** Best-effort calls: refused on a packaged core, and the step goes on without them. */
const BEST_EFFORT: Readonly<Record<string, string>> = {
  "card.get": "the island row reads the card's resolved path only to name it in its result",
  "ui.settings": "the change-one-thing row reads the user's lists to put them back after it (packaged: they stay, for bots it removes)",
  "ui.set": "the change-one-thing row puts the user's lists back (packaged: they stay, for bots it removes); the third-party UI row sets the app's language to read its page's translated line (packaged: the line must be one of its two)",
  "conversation.list": "lane E's chrome row looks for a coding session (no such method: always none)",
};

describe("the window steps' calls on a packaged core", () => {
  test("each is one the CLI's role may make, or a caught best-effort one", () => {
    const text = readFileSync(new URL("./ui-steps.ts", import.meta.url), "utf8");
    const cli = allowedMethods("cli");
    const wrong: string[] = [];
    text.split("\n").forEach((line, i) => {
      for (const m of line.matchAll(/rpc\.request(?:<[^>]*>)?\("([a-z][\w.]*)"/g)) {
        const method = m[1]!;
        if (cli.has(method)) continue;
        if (BEST_EFFORT[method] !== undefined && line.includes(".catch(")) continue;
        wrong.push(`ui-steps.ts:${i + 1} ${method} (${CLOVER_METHODS.get(method)?.roles.join(", ") ?? "no such method"})`);
      }
    });
    expect(wrong).toEqual([]);
  });
});
